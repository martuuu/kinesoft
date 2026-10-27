"use server";

/**
 * Patient files — Archivos tab on the EHR.
 *
 * Storage strategy:
 *  - **Supabase Storage** when `NEXT_PUBLIC_SUPABASE_URL` is configured.
 *    Files land in the `patient-files` bucket under `<tenantId>/<patientId>/<fileId>`.
 *  - **Local stub** otherwise — only metadata is persisted. Download/view
 *    is disabled, but the table flow (list / add metadata / delete) is
 *    exercised end-to-end so the UI can be developed without S3.
 *
 * The DB row is the source of truth for visibility; deleting the row
 * also removes the underlying object.
 *
 * Acceso (A2b-S-vis, 30-sep): los archivos son HC (estudios, derivaciones,
 * consentimientos). Antes solo se chequeaba el tenant, así que un profesional
 * con acceso BÁSICO al paciente (no asignado ni compartido) listaba, subía,
 * borraba y DESCARGABA los estudios de pacientes ajenos. Ahora las cuatro
 * acciones exigen `patientAccessFor === "full"` (OWNER/ADMIN siempre lo
 * tienen). Decisión del dueño: acceso básico = solo ver nombre/hora/servicio.
 *
 * Storage por service role (S02m, fuga E0): antes se subía, firmaba y borraba
 * con el JWT del usuario (`getSupabaseServerClient`), o sea que la barrera real
 * del bucket eran las policies de `storage.objects`, no verificadas en prod. Con
 * una policy abierta a `authenticated`, cualquier usuario bajaba estudios de
 * otro tenant directo contra la API de Storage salteando estos gates. Ahora
 * todo pasa por `lib/storage-internal.ts` (service role) y la ÚNICA puerta son
 * los gates de acá (intactos); los buckets quedan privados y sin policies.
 * Las claves siempre salen de la fila `PatientFile`, nunca del cliente.
 */
import { revalidatePath } from "next/cache";
import { randomBytes } from "node:crypto";
import { PatientFileCategory } from "@prisma/client";
import { runWithRls } from "@/lib/rls";
import { getActor, writableError } from "@/lib/session";
import { auditInTx, auditSecurityEvent } from "@/lib/audit";
import { reportError } from "@/lib/error-report";
import type { ActionResult } from "@/lib/validation";
import {
  isStorageConfigured,
  storageCreateSignedUpload,
  storageMove,
  storageReadHead,
  storageRemove,
  storageSign,
  storageStat,
  storageUpload,
} from "@/lib/storage-internal";
import { patientAccessFor } from "@/lib/visibility";
import { headMatchesMime } from "@/lib/file-sniff";
import { rateLimit } from "@/lib/rate-limit";
import { makePatientFileUploadToken, readPatientFileUploadToken } from "@/lib/patient-file-upload-token";
import {
  PATIENT_FILE_MAX_BYTES,
  PATIENT_FILE_UPLOAD_TTL_S,
  type PatientFileUploadClaims,
  type PatientFileUploadTicket,
} from "@/lib/files-types";
import type { DbClient } from "@/lib/rls";
import type { Actor } from "@/lib/session";

const BUCKET = "patient-files";

/**
 * Allow-list of MIME types we accept on the Archivos tab. Anything outside
 * this list is rejected at upload time so the signed download URL can never
 * render arbitrary HTML / SVG / JS in the browser tab.
 *
 * T4 FC-2f: la lista no cambia, pero el MIME ya no se cree: los primeros bytes tienen que ser de una familia que ese
 * MIME acepta (`PATIENT_FILE_MIME_FAMILIES` de `lib/file-sniff.ts`, que tiene exactamente estas claves). Antes un HTML
 * con `type: "application/pdf"` pasaba.
 */
const ALLOWED_MIME = new Set<string>([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "video/mp4",
  "video/quicktime",
  "audio/mpeg",
  "text/plain",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const SAFE_EXT_RE = /^[a-z0-9]{1,8}$/;

const ALLOWED_CATEGORIES = new Set<string>([
  "REPORT",
  "DERIVATION",
  "CONSENT",
  "IMAGE",
  "RECEIPT",
  "OTHER",
]);

import type { PatientFileRow } from "@/lib/files-types";

// Mismo admin client que usan las operaciones (ver `isStorageConfigured`).
function storageEnabled() {
  return isStorageConfigured();
}

/** `patientAccessFor` devuelve "none" para ids de otro tenant o inexistentes. */
async function hasFullAccess(actor: Actor, patientId: string, tx: DbClient) {
  return (await patientAccessFor(actor, patientId, tx)) === "full";
}

const NO_ACCESS = "No tenés acceso completo a este paciente.";
const TOO_BIG = "El archivo no puede superar 25 MB.";
const BAD_TYPE = "Tipo de archivo no permitido.";
// T4-Z (revisor b): «no es lo que dice ser» no le decía al profesional qué pasó ni si se subió algo.
const FAKE_FILE = "El contenido del archivo no coincide con su tipo (por ejemplo, un programa renombrado como PDF). No se subió.";

function safeExt(fileName: string): string {
  // Sanitise extension — only short alphanumerics, no traversal characters.
  const raw = (fileName.split(".").pop() ?? "bin").toLowerCase();
  return SAFE_EXT_RE.test(raw) ? raw : "bin";
}

export async function listPatientFiles(patientId: string): Promise<PatientFileRow[]> {
  const actor = await getActor();
  const rows = await runWithRls(actor.tenantId, async (tx) => {
    // Básico/ajeno → lista vacía (mismo contrato que las otras lecturas de
    // HC con acceso insuficiente): ni siquiera nombres de archivo.
    if (!(await hasFullAccess(actor, patientId, tx))) return [];
    return tx.patientFile.findMany({
      where: { patientId, tenantId: actor.tenantId },
      orderBy: { createdAt: "desc" },
    });
  });
  const haveStorage = storageEnabled();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    mime: r.mime,
    sizeBytes: r.sizeBytes,
    category: r.category,
    description: r.description,
    createdAt: r.createdAt,
    hasDownload: haveStorage && !r.storageKey.startsWith("stub:"),
  }));
}

/**
 * Upload accepts a FormData with `file` (a Blob) + metadata. Server
 * action so it streams through `next-server` without an extra round
 * trip.
 */
export async function uploadPatientFile(
  patientId: string,
  formData: FormData
): Promise<ActionResult<{ id: string }>> {
  const actor = await getActor();
  // BO-Z (A1): el corte de solo lectura va ANTES de Storage. `runWithRls` frena el INSERT de la fila, pero la
  // subida al bucket va por service role fuera de la tx: sin este corte un consultorio en solo lectura (enforce)
  // o una sesión de soporte dejaba el objeto subido y lo borraba recién en el catch.
  const readOnly = writableError(actor);
  if (readOnly) return { ok: false, error: readOnly };
  const access = await runWithRls(actor.tenantId, (tx) => patientAccessFor(actor, patientId, tx));
  if (access === "none") return { ok: false, error: "Paciente no encontrado." };
  if (access !== "full") return { ok: false, error: NO_ACCESS };

  const file = formData.get("file");
  const rawCategory = String(formData.get("category") ?? "OTHER");
  const category: PatientFileCategory = (ALLOWED_CATEGORIES.has(rawCategory)
    ? rawCategory
    : "OTHER") as PatientFileCategory;
  // PV · HD-3: Next expone todo export de un "use server" como RPC; `formData.get` puede devolver un File (el cast
  // `as string` lo dejaba pasar a Prisma) o un string de megas (límite de body 4.5mb). Solo string, trim, ≤500.
  const rawDescription = formData.get("description");
  const description =
    typeof rawDescription === "string" ? rawDescription.trim().slice(0, 500) || undefined : undefined;
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "Adjuntá un archivo." };
  }
  if (file.size > PATIENT_FILE_MAX_BYTES) {
    return { ok: false, error: TOO_BIG };
  }
  // MIME allow-list — protects the signed download URL from rendering
  // arbitrary HTML / SVG. Browsers honour the stored Content-Type when
  // serving a Supabase Storage signed URL inline.
  const mime = (file.type || "application/octet-stream").toLowerCase();
  if (!ALLOWED_MIME.has(mime)) {
    return { ok: false, error: BAD_TYPE };
  }
  // FC-2f: magic bytes ANTES de subir (también en modo stub, así dev se porta igual que prod).
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  if (!headMatchesMime(mime, head)) {
    return { ok: false, error: FAKE_FILE };
  }

  const id = randomBytes(12).toString("hex");
  let storageKey = `stub:${id}`;

  let uploaded = false;
  if (storageEnabled()) {
    storageKey = `${actor.tenantId}/${patientId}/${id}.${safeExt(file.name)}`;
    const buf = new Uint8Array(await file.arrayBuffer());
    const up = await storageUpload(BUCKET, storageKey, buf, mime);
    if (!up.ok) return { ok: false, error: "No pudimos subir el archivo." };
    uploaded = true;
  }

  let row;
  try {
    row = await runWithRls(actor.tenantId, (tx) => tx.patientFile.create({
      data: {
        tenantId: actor.tenantId,
        patientId,
        uploaderId: actor.userId ?? undefined,
        // HD-3: el nombre lo elige el cliente; se guarda acotado (la extensión de la clave sale de `safeExt`).
        name: file.name.slice(0, 255),
        mime,
        sizeBytes: file.size,
        storageKey,
        category,
        description,
      },
    }));
  } catch (e) {
    // Si el INSERT falla (paciente borrado en el medio, pool caído) el objeto
    // ya subido quedaría huérfano: PHI en el bucket sin fila que lo referencie
    // ni forma de encontrarlo. Best-effort: un fallo del remove queda logueado.
    if (uploaded) await storageRemove(BUCKET, [storageKey]);
    throw e;
  }

  revalidatePath(`/pacientes/${patientId}`);
  return { ok: true, data: { id: row.id } };
}

export async function deletePatientFile(id: string): Promise<ActionResult> {
  const actor = await getActor();
  // BO-Z (A1): sin este corte, en solo lectura (enforce) se borraba el objeto de Storage (service role, fuera de
  // la tx) y DESPUÉS la tx del `deleteMany` fallaba por read-only: la fila quedaba apuntando a un estudio que ya
  // no existe. Pérdida de datos clínicos. El corte va antes de tocar Storage.
  const readOnly = writableError(actor);
  if (readOnly) return { ok: false, error: readOnly };
  const found = await runWithRls(actor.tenantId, async (tx) => {
    const row = await tx.patientFile.findFirst({
      where: { id, tenantId: actor.tenantId },
    });
    if (!row) return { kind: "notfound" as const };
    if (!(await hasFullAccess(actor, row.patientId, tx))) return { kind: "basic" as const };
    return { kind: "ok" as const, row };
  });
  if (found.kind === "notfound") return { ok: false, error: "Archivo no encontrado." };
  if (found.kind === "basic") return { ok: false, error: NO_ACCESS };
  const row = found.row;

  if (storageEnabled() && !row.storageKey.startsWith("stub:")) {
    // supabase-js no tira: antes el error se ignoraba y se borraba la fila,
    // dejando el objeto (PHI) huérfano en el bucket sin forma de encontrarlo.
    // Si el storage falla, no se toca la fila y el usuario reintenta.
    const rm = await storageRemove(BUCKET, [row.storageKey]);
    if (!rm.ok) return { ok: false, error: "No pudimos borrar el archivo. Probá de nuevo." };
  }

  // PL-A (seguridad): borrar un adjunto (PHI) se audita en la tx del delete de la fila.
  await runWithRls(actor.tenantId, async (tx) => {
    await tx.patientFile.deleteMany({ where: { id, tenantId: actor.tenantId } });
    await auditInTx(tx, {
      tenantId: actor.tenantId,
      actorId: actor.userId ?? undefined,
      action: "patientFile.delete",
      entity: "PatientFile",
      entityId: id,
      payload: { name: row.name, patientId: row.patientId },
    });
  });
  revalidatePath(`/pacientes/${row.patientId}`);
  return { ok: true, data: undefined };
}

/** Server-side signed download URL — short-lived (10 min). */
export async function getDownloadUrl(id: string): Promise<ActionResult<{ url: string }>> {
  const actor = await getActor();
  const found = await runWithRls(actor.tenantId, async (tx) => {
    const row = await tx.patientFile.findFirst({
      where: { id, tenantId: actor.tenantId },
    });
    if (!row) return { kind: "notfound" as const };
    if (!(await hasFullAccess(actor, row.patientId, tx))) return { kind: "basic" as const };
    return { kind: "ok" as const, row };
  });
  if (found.kind === "notfound") return { ok: false, error: "Archivo no encontrado." };
  if (found.kind === "basic") return { ok: false, error: NO_ACCESS };
  const row = found.row;
  if (!storageEnabled() || row.storageKey.startsWith("stub:")) {
    return { ok: false, error: "Storage no configurado en este entorno." };
  }
  // A2b-S-vis: el audit va ANTES de firmar. Antes se escribía después de
  // obtener la URL: si la función moría entre los dos pasos (timeout de
  // Vercel, audit perdido) quedaba una URL válida por 10 min sin rastro.
  // Registramos el INTENTO; si la firma falla queda un evento de más, nunca
  // uno de menos. PL-A (PL-D13): `auditSecurityEvent` (canal service, anda en
  // solo lectura) y falla CERRADO: sin audit no hay URL.
  try {
    await auditSecurityEvent({
      tenantId: actor.tenantId,
      actorId: actor.userId ?? undefined,
      action: "patientFile.download",
      entity: "PatientFile",
      entityId: id,
      payload: { name: row.name, patientId: row.patientId },
    });
  } catch (err) {
    reportError("patient_file.download_audit_failed", err, { fileId: id });
    return { ok: false, error: "No pudimos generar el link." };
  }
  const signed = await storageSign(BUCKET, row.storageKey, 600);
  if (!signed.ok) return { ok: false, error: "No pudimos generar el link." };
  return { ok: true, data: { url: signed.data } };
}

/*
 * ─── Subida firmada (T4 FC-2f, C-FC10; brief §24.8) ─────────────────────────────────────────────────────────────────
 * El tope de 25 MB de `uploadPatientFile` era inalcanzable: el body de una server action corta en 4,5 MB
 * (`next.config.mjs`). Ahora:
 *   1. `requestPatientFileUpload` valida tamaño, MIME y acceso ANTES de firmar, y firma un PUT a
 *      `pending/{tenant}/{fileId}` (fileId aleatorio del server) + un token HMAC con todo lo declarado.
 *   2. El navegador sube directo a Storage (XHR PUT con progreso; FC-4b), sin supabase-js en el bundle.
 *   3. `confirmPatientFileUpload`: token → re-gate (mismo usuario y consultorio, escribible, acceso completo) → replay
 *      (la fila ya existe con el id del token) → `storageStat` (tamaño y Content-Type contra el token) → 64 bytes con
 *      Range → magic bytes contra la allow-list → `move` a la clave final → INSERT. Si algo falla se borra el objeto y
 *      no queda fila: nunca hay PHI en el bucket sin una fila que la referencie (salvo lo que el cron barre en
 *      `pending/` a las 24 h: subidas abandonadas o confirmaciones que cayeron antes de limpiar).
 *
 * Interruptor `PATIENT_FILES_SIGNED_UPLOAD` (default prendido; `0`/`false`/`off` lo apaga): la API firmada de Storage
 * (CORS, `info()`, Range, `move`) recién se puede probar contra un Supabase real al final de T4. Apagado (o sin
 * Storage), `requestPatientFileUpload` devuelve `{ mode: "stub" }` y la UI vuelve a `uploadPatientFile` (≤4 MB).
 * `confirm` sigue andando con el interruptor apagado: lo ya subido con un token vigente se puede confirmar.
 */

const PENDING_PREFIX = "pending";
const MAX_FILE_NAME = 255;
const MAX_DESCRIPTION = 500;
const UPLOAD_EXPIRED = "La subida venció o no es válida. Volvé a subir el archivo.";
const UPLOAD_MISMATCH = "El archivo que llegó no coincide con el que elegiste. Volvé a subirlo.";
const UPLOAD_EMPTY = "El archivo llegó vacío. Volvé a subirlo.";
const UPLOAD_MISSING = "No encontramos el archivo subido. Volvé a subirlo.";
const UPLOAD_FAILED = "No pudimos guardar el archivo. Probá de nuevo.";
const UPLOAD_RATE_LIMITED = "Subiste muchos archivos seguidos. Esperá unos minutos y probá de nuevo.";
/**
 * T4Z-B2: subidas firmadas por usuario. Cada firma es un PUT de hasta 25 MB directo al bucket que, sin confirmar, queda
 * 24 h en `pending/` hasta que lo barre el cron: sin tope, una sesión robada (o un script) llenaba Storage de basura que
 * pagamos. 60 / 10 min cubre cargar todos los estudios de un paciente de una vez.
 */
const UPLOAD_RATE_LIMIT = { limit: 60, windowMs: 10 * 60_000 } as const;

function signedUploadSwitchOn(): boolean {
  const v = (process.env.PATIENT_FILES_SIGNED_UPLOAD ?? "").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off");
}

/** Clave de la subida en curso. Solo la arma el server, con ids del server o del token firmado. */
function pendingKey(c: Pick<PatientFileUploadClaims, "tenantId" | "fileId">): string {
  return `${PENDING_PREFIX}/${c.tenantId}/${c.fileId}`;
}

function finalKey(c: Pick<PatientFileUploadClaims, "tenantId" | "patientId" | "fileId" | "fileName">): string {
  return `${c.tenantId}/${c.patientId}/${c.fileId}.${safeExt(c.fileName)}`;
}

/** `Content-Type` del objeto sin parámetros (`text/plain;charset=UTF-8` → `text/plain`). */
function baseMime(ct: string | null): string | null {
  return ct ? ct.split(";")[0].trim().toLowerCase() || null : null;
}

/** Best-effort: si el remove falla queda logueado en `storage-internal` y lo barre el cron de `pending/`. */
async function discardObject(key: string): Promise<void> {
  await storageRemove(BUCKET, [key]);
}

export async function requestPatientFileUpload(input: {
  patientId: string;
  fileName: string;
  mime: string;
  sizeBytes: number;
  category?: PatientFileCategory;
}): Promise<ActionResult<PatientFileUploadTicket>> {
  const actor = await getActor();
  // Mismo corte que `uploadPatientFile` (BO-Z A1): en solo lectura ni siquiera se firma una subida.
  const readOnly = writableError(actor);
  if (readOnly) return { ok: false, error: readOnly };

  const patientId = typeof input?.patientId === "string" ? input.patientId : "";
  const fileName = typeof input?.fileName === "string" ? input.fileName.trim() : "";
  const mime = typeof input?.mime === "string" ? input.mime.trim().toLowerCase() : "";
  const sizeBytes = input?.sizeBytes;
  const category: PatientFileCategory = (typeof input?.category === "string" && ALLOWED_CATEGORIES.has(input.category)
    ? input.category
    : "OTHER") as PatientFileCategory;
  // Tope y MIME antes de firmar (y antes de tocar la base): no se firma nada que después no se podría confirmar.
  if (!fileName || fileName.length > MAX_FILE_NAME) return { ok: false, error: "El nombre del archivo no es válido." };
  if (typeof sizeBytes !== "number" || !Number.isInteger(sizeBytes) || sizeBytes <= 0) {
    return { ok: false, error: "Adjuntá un archivo." };
  }
  if (sizeBytes > PATIENT_FILE_MAX_BYTES) return { ok: false, error: TOO_BIG };
  if (!ALLOWED_MIME.has(mime)) return { ok: false, error: BAD_TYPE };
  if (!patientId) return { ok: false, error: "Paciente no encontrado." };

  const access = await runWithRls(actor.tenantId, (tx) => patientAccessFor(actor, patientId, tx));
  if (access === "none") return { ok: false, error: "Paciente no encontrado." };
  if (access !== "full") return { ok: false, error: NO_ACCESS };

  if (!signedUploadSwitchOn() || !storageEnabled()) return { ok: true, data: { mode: "stub" } };

  // Después de validar y del gate (un pedido inválido o sin acceso no gasta cupo) y antes de firmar.
  const rl = await rateLimit(`patient-file:upload:user:${actor.userId}`, UPLOAD_RATE_LIMIT);
  if (!rl.ok) return { ok: false, error: UPLOAD_RATE_LIMITED };

  const fileId = randomBytes(12).toString("hex");
  const claims = {
    tenantId: actor.tenantId,
    patientId,
    fileId,
    mime,
    sizeBytes,
    category,
    fileName,
    userId: actor.userId,
  };
  let confirmToken: string;
  try {
    confirmToken = makePatientFileUploadToken(claims);
  } catch {
    // Solo pasa con ids o nombres fuera de formato (p. ej. un nombre multibyte que no entra en 2048 caracteres).
    return { ok: false, error: "El nombre del archivo no es válido." };
  }
  const signed = await storageCreateSignedUpload(BUCKET, pendingKey(claims));
  if (!signed.ok) return { ok: false, error: "No pudimos preparar la subida. Probá de nuevo." };
  const expiresAt = new Date(Date.now() + PATIENT_FILE_UPLOAD_TTL_S * 1000).toISOString();
  return { ok: true, data: { mode: "signed", uploadUrl: signed.data.signedUrl, confirmToken, expiresAt } };
}

export async function confirmPatientFileUpload(input: {
  confirmToken: string;
  description?: string | null;
}): Promise<ActionResult<{ id: string; replayed: boolean }>> {
  // 1. Token. Adulterado, vencido o de otra etiqueta → rechazo SIN tocar Storage: sin un token válido no hay clave
  //    en la que confiar (y borrar «lo que dice» un token falso sería borrar a ciegas).
  const claims = readPatientFileUploadToken(input?.confirmToken);
  if (!claims) return { ok: false, error: UPLOAD_EXPIRED };

  // 2. Re-gate. El token es de un usuario y un consultorio: otro usuario (o la misma persona en otro consultorio
  //    activo) no lo puede usar, tampoco sin tocar Storage.
  const actor = await getActor();
  if (claims.tenantId !== actor.tenantId || claims.userId !== actor.userId) return { ok: false, error: UPLOAD_EXPIRED };
  // Solo lectura (o soporte): se corta antes de Storage como en el resto del archivo (BO-Z A1); el objeto pendiente
  // lo barre el cron.
  const readOnly = writableError(actor);
  if (readOnly) return { ok: false, error: readOnly };

  const description =
    typeof input?.description === "string" && input.description.trim()
      ? input.description.trim().slice(0, MAX_DESCRIPTION)
      : null;
  const pending = pendingKey(claims);

  // El acceso se re-chequea (pudo cambiar en los 15 min) y en la misma lectura se mira el replay.
  const gate = await runWithRls(actor.tenantId, async (tx) => {
    const access = await patientAccessFor(actor, claims.patientId, tx);
    if (access !== "full") return { kind: access === "none" ? ("notfound" as const) : ("basic" as const) };
    const existing = await tx.patientFile.findFirst({
      where: { id: claims.fileId, tenantId: actor.tenantId, patientId: claims.patientId },
      select: { id: true },
    });
    return existing ? { kind: "replay" as const } : { kind: "ok" as const };
  });
  if (gate.kind === "notfound" || gate.kind === "basic") {
    // Solo se borra lo pendiente: si ya se había confirmado, la clave final es de la fila y no se toca.
    await discardObject(pending);
    return { ok: false, error: gate.kind === "notfound" ? "Paciente no encontrado." : NO_ACCESS };
  }
  // 3. Replay: doble click, reintento después de un timeout. Mismo resultado, sin volver a tocar Storage.
  if (gate.kind === "replay") return { ok: true, data: { id: claims.fileId, replayed: true } };

  /** Falló algo después del replay: si otra confirmación ganó en paralelo, es un replay; si no, se limpia. */
  const failWith = async (error: string, keyToDiscard: string): Promise<ActionResult<{ id: string; replayed: boolean }>> => {
    if (await rowExists(actor.tenantId, claims)) return { ok: true, data: { id: claims.fileId, replayed: true } };
    await discardObject(keyToDiscard);
    return { ok: false, error };
  };

  // 4. Tamaño y Content-Type contra el token. El Content-Type importa tanto como los bytes: es con el que Storage
  //    sirve la URL firmada, y lo pone el PUT del cliente (podría decir `text/html` aunque el token diga PDF).
  const stat = await storageStat(BUCKET, pending);
  if (!stat.ok) return failWith(UPLOAD_FAILED, pending);
  if (!stat.data) {
    if (await rowExists(actor.tenantId, claims)) return { ok: true, data: { id: claims.fileId, replayed: true } };
    return { ok: false, error: UPLOAD_MISSING };
  }
  if (stat.data.sizeBytes === 0) return failWith(UPLOAD_EMPTY, pending);
  if (stat.data.sizeBytes !== claims.sizeBytes || stat.data.sizeBytes > PATIENT_FILE_MAX_BYTES) {
    return failWith(UPLOAD_MISMATCH, pending);
  }
  if (baseMime(stat.data.contentType) !== claims.mime) return failWith(UPLOAD_MISMATCH, pending);

  // 5. Magic bytes de los primeros 64 bytes contra lo que acepta el MIME declarado.
  const head = await storageReadHead(BUCKET, pending);
  if (!head.ok) return failWith(UPLOAD_FAILED, pending);
  if (head.data.length === 0) return failWith(UPLOAD_EMPTY, pending);
  if (!headMatchesMime(claims.mime, head.data)) return failWith(FAKE_FILE, pending);

  // 6. A la clave final. Si el move falla y otra confirmación ya movió, `failWith` lo resuelve como replay.
  const storageKey = finalKey(claims);
  const moved = await storageMove(BUCKET, pending, storageKey);
  if (!moved.ok) return failWith(UPLOAD_FAILED, pending);

  // 7. INSERT con el id del token (así el replay es una lectura por PK).
  try {
    await runWithRls(actor.tenantId, (tx) =>
      tx.patientFile.create({
        data: {
          id: claims.fileId,
          tenantId: actor.tenantId,
          patientId: claims.patientId,
          uploaderId: actor.userId ?? undefined,
          name: claims.fileName,
          mime: claims.mime,
          sizeBytes: claims.sizeBytes,
          storageKey,
          category: claims.category,
          description,
        },
      }),
    );
  } catch (e) {
    // Si la fila existe (otra confirmación la escribió) la clave final es suya y NO se borra. Si no, el objeto ya
    // movido quedaría huérfano: PHI sin fila. Se borra y se reporta.
    if (await rowExists(actor.tenantId, claims)) return { ok: true, data: { id: claims.fileId, replayed: true } };
    await discardObject(storageKey);
    reportError("patient_file.confirm_insert_failed", e, { fileId: claims.fileId });
    return { ok: false, error: UPLOAD_FAILED };
  }

  revalidatePath(`/pacientes/${claims.patientId}`);
  return { ok: true, data: { id: claims.fileId, replayed: false } };
}

async function rowExists(tenantId: string, c: PatientFileUploadClaims): Promise<boolean> {
  const n = await runWithRls(tenantId, (tx) =>
    tx.patientFile.count({ where: { id: c.fileId, tenantId, patientId: c.patientId } }),
  );
  return n > 0;
}
