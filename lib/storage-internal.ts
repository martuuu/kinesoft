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
 * ─── FC-1b3: firmas de C-FC10, SIN implementar todavía ─────────────────────────────────────────────────────────────
 * Las implementa FC-2f (subida firmada de 25 MB, sniff de la cabeza, descarga acotada y mover de `pending/`). Se
 * publican ya para que T4c compile en paralelo (FC-2d/FC-2h/FC-2i testean contra la firma con Storage fake).
 * Mientras tanto devuelven error (nunca tiran): sin admin client → `unconfigured`, igual que el resto del módulo (es
 * lo que ve la integración, donde el admin client está mockeado a null); con admin client → `storage` «no
 * implementado», así nadie cree que subió o leyó algo que no pasó.
 */

/** Respuesta de `createSignedUploadUrl` de supabase-js: la URL a la que el cliente hace el PUT y su token. */
export type StorageSignedUpload = { signedUrl: string; token: string };
/** Metadatos del objeto ya subido; `null` = no existe (el caller lo trata como «no se subió»). */
export type StorageObjectStat = { sizeBytes: number; contentType: string | null } | null;

/** Cuántos bytes lee `storageReadHead` (Range 0-63): alcanza para los magic bytes de `lib/file-sniff.ts`. */
export const STORAGE_HEAD_BYTES = 64;

function notImplemented<T>(op: string): StorageResult<T> {
  if (!getSupabaseAdminClient()) return unconfigured();
  return { ok: false, reason: "storage", message: `${op}: no implementado (FC-2f).` };
}

/** URL firmada de SUBIDA (PUT directo del navegador a Storage, sin pasar los bytes por la función de Vercel). */
export async function storageCreateSignedUpload(
  bucket: StorageBucket,
  key: string,
): Promise<StorageResult<StorageSignedUpload>> {
  void bucket;
  void key;
  return notImplemented("createSignedUpload");
}

/** Tamaño y tipo del objeto, para confirmar una subida firmada contra lo que dice el token. */
export async function storageStat(bucket: StorageBucket, key: string): Promise<StorageResult<StorageObjectStat>> {
  void bucket;
  void key;
  return notImplemented("stat");
}

/** Los primeros `STORAGE_HEAD_BYTES` bytes (URL firmada de 60 s + `Range: bytes=0-63`). */
export async function storageReadHead(bucket: StorageBucket, key: string): Promise<StorageResult<Uint8Array>> {
  void bucket;
  void key;
  return notImplemented("readHead");
}

/** El objeto entero, con tope: si pesa más que `maxBytes` es error (no se carga a memoria algo arbitrario). */
export async function storageDownload(
  bucket: StorageBucket,
  key: string,
  maxBytes: number,
): Promise<StorageResult<Uint8Array>> {
  void bucket;
  void key;
  void maxBytes;
  return notImplemented("download");
}

/** Mueve dentro del mismo bucket (p. ej. de `pending/` a la clave definitiva al confirmar). */
export async function storageMove(
  bucket: StorageBucket,
  fromKey: string,
  toKey: string,
): Promise<StorageResult<void>> {
  void bucket;
  void fromKey;
  void toKey;
  return notImplemented("move");
}
