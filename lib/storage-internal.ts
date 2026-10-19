import "server-only";

/**
 * Supabase Storage por SERVICE ROLE (S02m, fuga E0 de la verificación del 03-oct).
 *
 * Por qué existe:
 *  - Antes `lib/files.ts` y `lib/exercise-media.ts` subían, firmaban y borraban
 *    con `getSupabaseServerClient()`, o sea con el JWT del usuario. Eso deja la
 *    seguridad del bucket en manos de las policies de `storage.objects`, que en
 *    prod no se pudieron verificar (precheck 17): si hay una policy abierta para
 *    `authenticated`, cualquier usuario logueado lee/borra objetos de otros
 *    tenants pegándole directo a la API de Storage con su JWT.
 *  - Con service role, la ÚNICA puerta a los objetos es el código del server
 *    (gates de `lib/files.ts`, plan-gating del lector), igual que la base en prod
 *    (BYPASSRLS + `where: { tenantId }` a mano). Los buckets quedan privados y
 *    sin policies para anon/authenticated (se sacan en el mismo deploy).
 *
 * Contrato:
 *  - Este módulo NO decide quién puede qué: recibe una clave que el caller ya
 *    cargó de SU fila en la base (PatientFile.storageKey, ExerciseMedia.url).
 *    **Nunca** se le pasa una clave que mande el cliente.
 *  - Falla cerrado: sin `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
 *    el admin client es null y toda operación devuelve `unconfigured`. No hay
 *    fallback al client del usuario.
 *  - supabase-js no tira excepción: cada `{ error }` se chequea y se devuelve
 *    como `{ ok: false, reason: "storage" }`. Un throw de red (fetch) se atrapa
 *    y se trata igual, así ningún caller ve una excepción cruda.
 */
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";

/**
 * PL-2b: `billing-receipts` = comprobantes de pago de la suscripción (PL-D22). Bucket PRIVADO que Martin crea en
 * Supabase (EXTERNAL-CONFIG); clave `<tenantId>/<paymentId>.<ext>` armada por `lib/saas-receipts-internal.ts`.
 */
export type StorageBucket =
  | "patient-files"
  | "exercise-media"
  | "billing-receipts"
  /**
   * FC (M14, §24.5): PDF congelado de cada ficha compartida con el paciente. Clave
   * `{tenantId}/{patientId}/{documentId}.pdf` (la arma `lib/patient-documents-internal.ts`). PRIVADO: el portal lo
   * baja proxeado por el server con el sha256 verificado, nunca con una URL firmada al paciente.
   */
  | "patient-documents"
  /**
   * FC (C-FC9): logo del consultorio y firmas escaneadas de los profesionales. Claves `{tenant}/logo/{nonce}.{ext}` y
   * `{tenant}/signature/{practitionerId}/{nonce}.{ext}`. PRIVADO: se embeben en el PDF desde el server.
   */
  | "practice-assets";

export type StorageResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: "unconfigured" | "storage"; message: string };

/** TTL máximo de una URL firmada. Más largo no tiene caso de uso hoy. */
const MAX_TTL_SECONDS = 3600;
const MIN_TTL_SECONDS = 60;

/**
 * ¿Hay Storage real en este entorno? Se deriva del MISMO admin client que usan
 * las operaciones (no de leer la env por separado): si dijera "sí" y el client
 * fuera null, el caller creería que subió y no subió nada. En los tests de
 * integración el admin client está mockeado a null → modo stub (nunca Storage
 * real, aunque el `.env` traiga la key de un proyecto real).
 */
export function isStorageConfigured(): boolean {
  return getSupabaseAdminClient() !== null;
}

function unconfigured<T>(): StorageResult<T> {
  return { ok: false, reason: "unconfigured", message: "Storage no configurado." };
}

function failed<T>(op: string, bucket: StorageBucket, err: unknown): StorageResult<T> {
  const message =
    err && typeof err === "object" && "message" in err
      ? String((err as { message: unknown }).message)
      : String(err);
  // Se loguea operación + bucket + mensaje de Supabase; NO la clave (lleva
  // tenantId/patientId) ni el contenido.
  logger.error("storage.failed", { op, bucket, err: message });
  return { ok: false, reason: "storage", message };
}

export async function storageUpload(
  bucket: StorageBucket,
  key: string,
  body: Uint8Array,
  contentType: string,
): Promise<StorageResult<void>> {
  const admin = getSupabaseAdminClient();
  if (!admin) return unconfigured();
  try {
    // upsert: false → una clave repetida es error, nunca pisa el objeto de otro.
    const { error } = await admin.storage.from(bucket).upload(key, body, { contentType, upsert: false });
    if (error) return failed("upload", bucket, error);
    return { ok: true, data: undefined };
  } catch (e) {
    return failed("upload", bucket, e);
  }
}

export async function storageSign(
  bucket: StorageBucket,
  key: string,
  ttlSeconds: number,
): Promise<StorageResult<string>> {
  const admin = getSupabaseAdminClient();
  if (!admin) return unconfigured();
  const ttl = Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, Math.floor(ttlSeconds)));
  try {
    const { data, error } = await admin.storage.from(bucket).createSignedUrl(key, ttl);
    if (error) return failed("sign", bucket, error);
    if (!data?.signedUrl) return failed("sign", bucket, "respuesta sin signedUrl");
    return { ok: true, data: data.signedUrl };
  } catch (e) {
    return failed("sign", bucket, e);
  }
}

export async function storageRemove(
  bucket: StorageBucket,
  keys: string[],
): Promise<StorageResult<void>> {
  if (keys.length === 0) return { ok: true, data: undefined };
  const admin = getSupabaseAdminClient();
  if (!admin) return unconfigured();
  try {
    const { error } = await admin.storage.from(bucket).remove(keys);
    if (error) return failed("remove", bucket, error);
    return { ok: true, data: undefined };
  } catch (e) {
    return failed("remove", bucket, e);
  }
}

/*
 * ─── C-FC10 (FC-2f): subida firmada, metadatos, cabeza, descarga acotada y mover ──────────────────────────────────
 * FC-1b3 publicó las firmas; FC-2f las implementa. Mismo contrato que el resto del módulo: nunca tiran, sin admin
 * client → `unconfigured`, cada `{ error }` de supabase-js (y cada throw de red) → `{ ok: false, reason: "storage" }`.
 * Las claves las arma el caller desde la base o desde un token firmado (`lib/patient-file-upload-token.ts`).
 */

/** Respuesta de `createSignedUploadUrl` de supabase-js: la URL a la que el cliente hace el PUT y su token. */
export type StorageSignedUpload = { signedUrl: string; token: string };
/** Metadatos del objeto ya subido; `null` = no existe (el caller lo trata como «no se subió»). */
export type StorageObjectStat = { sizeBytes: number; contentType: string | null } | null;

/** Cuántos bytes lee `storageReadHead` (Range 0-63): alcanza para los magic bytes de `lib/file-sniff.ts`. */
export const STORAGE_HEAD_BYTES = 64;

/** TTL de la URL firmada que usa `storageReadHead` (C-FC10: 60 s; se usa una vez y en el acto). */
const HEAD_URL_TTL_SECONDS = 60;
/** La lectura de la cabeza es un GET chico: si Storage no contesta en 10 s, falla y el caller limpia. */
const HEAD_TIMEOUT_MS = 10_000;

/**
 * URL firmada de SUBIDA (PUT directo del navegador a Storage, sin pasar los bytes por la función de Vercel: el body de
 * una server action corta en 4,5 MB). `upsert: false`: la clave (`pending/{tenant}/{fileId}`, id aleatorio) no se pisa.
 * Ojo: Supabase la hace valer 2 h y no deja acortarla; el vencimiento de 15 min lo impone el token de confirmación.
 */
export async function storageCreateSignedUpload(
  bucket: StorageBucket,
  key: string,
): Promise<StorageResult<StorageSignedUpload>> {
  const admin = getSupabaseAdminClient();
  if (!admin) return unconfigured();
  try {
    const { data, error } = await admin.storage.from(bucket).createSignedUploadUrl(key, { upsert: false });
    if (error) return failed("createSignedUpload", bucket, error);
    if (!data?.signedUrl || !data.token) return failed("createSignedUpload", bucket, "respuesta sin signedUrl/token");
    return { ok: true, data: { signedUrl: data.signedUrl, token: data.token } };
  } catch (e) {
    return failed("createSignedUpload", bucket, e);
  }
}

/** ¿El error de Storage es «no existe»? (`info()` de un objeto ausente contesta 400/404 según la versión de la API.) */
function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: unknown; statusCode?: unknown; message?: unknown };
  if (e.status === 404 || e.statusCode === "404") return true;
  return typeof e.message === "string" && /not.?found|no existe/i.test(e.message);
}

/** Tamaño y tipo del objeto (`info()`), para confirmar una subida firmada contra lo que dice el token. */
export async function storageStat(bucket: StorageBucket, key: string): Promise<StorageResult<StorageObjectStat>> {
  const admin = getSupabaseAdminClient();
  if (!admin) return unconfigured();
  try {
    const { data, error } = await admin.storage.from(bucket).info(key);
    if (error) {
      if (isNotFound(error)) return { ok: true, data: null };
      return failed("stat", bucket, error);
    }
    if (!data) return { ok: true, data: null };
    const size = (data as { size?: unknown }).size;
    // Sin tamaño no se puede confirmar nada contra el token: es error, no «0 bytes».
    if (typeof size !== "number" || !Number.isFinite(size) || size < 0) return failed("stat", bucket, "respuesta sin size");
    const ct = (data as { contentType?: unknown }).contentType;
    return { ok: true, data: { sizeBytes: size, contentType: typeof ct === "string" && ct ? ct : null } };
  } catch (e) {
    return failed("stat", bucket, e);
  }
}

/**
 * Los primeros `STORAGE_HEAD_BYTES` bytes (URL firmada de 60 s + `Range: bytes=0-63`). Bajar el objeto entero para
 * mirar 64 bytes serían hasta 25 MB por confirmación en la memoria de la función. Si el server ignora el Range
 * (200 en vez de 206) se lee el stream hasta juntar 64 bytes y se corta, así igual no baja todo.
 */
export async function storageReadHead(bucket: StorageBucket, key: string): Promise<StorageResult<Uint8Array>> {
  const signed = await storageSign(bucket, key, HEAD_URL_TTL_SECONDS);
  if (!signed.ok) return signed;
  try {
    const res = await fetch(signed.data, {
      headers: { Range: `bytes=0-${STORAGE_HEAD_BYTES - 1}` },
      cache: "no-store",
      signal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
    });
    if (res.status !== 200 && res.status !== 206) {
      await res.body?.cancel().catch(() => undefined);
      return failed("readHead", bucket, `HTTP ${res.status}`);
    }
    const head = new Uint8Array(STORAGE_HEAD_BYTES);
    let got = 0;
    if (res.body) {
      const reader = res.body.getReader();
      while (got < STORAGE_HEAD_BYTES) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        const take = Math.min(value.length, STORAGE_HEAD_BYTES - got);
        head.set(value.subarray(0, take), got);
        got += take;
      }
      await reader.cancel().catch(() => undefined);
    }
    return { ok: true, data: head.slice(0, got) };
  } catch (e) {
    return failed("readHead", bucket, e);
  }
}

/**
 * El objeto entero, con tope: si pesa más que `maxBytes` es error (no se carga a memoria algo arbitrario). El Blob que
 * devuelve supabase-js ya está en memoria, así que el techo real lo dan los límites de cada bucket (practice-assets
 * 1 MB, patient-documents 10 MB, EXTERNAL-CONFIG); el tope de acá es la segunda barrera y el contrato con el caller
 * (nunca recibe más de lo que pidió).
 */
export async function storageDownload(
  bucket: StorageBucket,
  key: string,
  maxBytes: number,
): Promise<StorageResult<Uint8Array>> {
  const admin = getSupabaseAdminClient();
  if (!admin) return unconfigured();
  try {
    const { data, error } = await admin.storage.from(bucket).download(key);
    if (error) return failed("download", bucket, error);
    if (!data) return failed("download", bucket, "respuesta sin datos");
    if (data.size > maxBytes) return failed("download", bucket, `objeto de ${data.size} bytes > tope ${maxBytes}`);
    const bytes = new Uint8Array(await data.arrayBuffer());
    if (bytes.length > maxBytes) return failed("download", bucket, `objeto de ${bytes.length} bytes > tope ${maxBytes}`);
    return { ok: true, data: bytes };
  } catch (e) {
    return failed("download", bucket, e);
  }
}

/**
 * Mueve dentro del mismo bucket (de `pending/` a la clave definitiva al confirmar). Storage no pisa un destino que
 * existe: si dos confirmaciones corren a la vez, solo una mueve y la otra recibe error (el caller resuelve el replay).
 */
export async function storageMove(
  bucket: StorageBucket,
  fromKey: string,
  toKey: string,
): Promise<StorageResult<void>> {
  const admin = getSupabaseAdminClient();
  if (!admin) return unconfigured();
  try {
    const { error } = await admin.storage.from(bucket).move(fromKey, toKey);
    if (error) return failed("move", bucket, error);
    return { ok: true, data: undefined };
  } catch (e) {
    return failed("move", bucket, e);
  }
}

/**
 * Objetos de `pending/` (subida firmada sin confirmar) más viejos que `olderThanMs` (C-FC10: el cron diario barre los
 * de más de 24 h). Lista `pending/` → cada carpeta de consultorio → borra en tandas. Best-effort: un error en un
 * consultorio no corta el resto; devuelve cuántos borró y cuántos errores hubo para el resumen del cron.
 * La etapa del cron (`runStoragePendingSweep` en lib/cron-jobs-internal.ts, FC-2i) pasa `deadlineAtMs`: el cron diario
 * tiene 45 s de presupuesto para TODAS sus etapas y un barrido grande (hasta 100 tandas de borrado) podría pasarse. Al
 * llegar al plazo corta con `truncated: true`; lo que quedó lo barre la corrida de mañana (borrar es idempotente).
 */
const PENDING_PREFIX = "pending";
const LIST_PAGE = 1000;
const REMOVE_BATCH = 100;
const MAX_PENDING_SWEEP = 10_000;

export async function storageSweepPending(
  bucket: StorageBucket,
  olderThanMs: number,
  nowMs = Date.now(),
  deadlineAtMs = Number.POSITIVE_INFINITY,
): Promise<StorageResult<{ removed: number; errors: number; truncated: boolean }>> {
  const admin = getSupabaseAdminClient();
  if (!admin) return unconfigured();
  const cutoff = nowMs - olderThanMs;
  let removed = 0;
  let errors = 0;
  let truncated = false;
  // Reloj REAL (no `nowMs`, que es el «ahora» lógico del corte de antigüedad y en los tests está fijo).
  const pastDeadline = () => Date.now() >= deadlineAtMs;
  try {
    const api = admin.storage.from(bucket);
    const { data: folders, error } = await api.list(PENDING_PREFIX, { limit: LIST_PAGE });
    if (error) return failed("sweepPending", bucket, error);
    for (const folder of folders ?? []) {
      // Las «carpetas» de Storage vienen sin id; los objetos sueltos en `pending/` (no debería haber) se ignoran.
      if (folder.id || !folder.name) continue;
      if (pastDeadline()) {
        truncated = true;
        break;
      }
      const prefix = `${PENDING_PREFIX}/${folder.name}`;
      const { data: objects, error: listErr } = await api.list(prefix, { limit: LIST_PAGE });
      if (listErr) {
        failed("sweepPending.list", bucket, listErr);
        errors++;
        continue;
      }
      const stale = (objects ?? [])
        .filter((o) => {
          if (!o.id || !o.name) return false;
          const at = Date.parse(o.created_at ?? o.updated_at ?? "");
          return Number.isFinite(at) && at < cutoff;
        })
        .map((o) => `${prefix}/${o.name}`);
      for (let i = 0; i < stale.length && removed < MAX_PENDING_SWEEP; i += REMOVE_BATCH) {
        if (pastDeadline()) {
          truncated = true;
          break;
        }
        const batch = stale.slice(i, i + REMOVE_BATCH);
        const rm = await storageRemove(bucket, batch);
        if (rm.ok) removed += batch.length;
        else errors++;
      }
    }
    return { ok: true, data: { removed, errors, truncated } };
  } catch (e) {
    return failed("sweepPending", bucket, e);
  }
}
