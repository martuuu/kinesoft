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
import { isStorageConfigured, storageRemove, storageSign, storageUpload } from "@/lib/storage-internal";
import { patientAccessFor } from "@/lib/visibility";
import type { DbClient } from "@/lib/rls";
import type { Actor } from "@/lib/session";

const BUCKET = "patient-files";

/**
 * Allow-list of MIME types we accept on the Archivos tab. Anything outside
 * this list is rejected at upload time so the signed download URL can never
 * render arbitrary HTML / SVG / JS in the browser tab.
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
  const description = (formData.get("description") as string | null) || undefined;
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "Adjuntá un archivo." };
  }
  if (file.size > 25 * 1024 * 1024) {
    return { ok: false, error: "El archivo no puede superar 25 MB." };
  }
  // MIME allow-list — protects the signed download URL from rendering
  // arbitrary HTML / SVG. Browsers honour the stored Content-Type when
  // serving a Supabase Storage signed URL inline.
  const mime = (file.type || "application/octet-stream").toLowerCase();
  if (!ALLOWED_MIME.has(mime)) {
    return { ok: false, error: "Tipo de archivo no permitido." };
  }

  const id = randomBytes(12).toString("hex");
  let storageKey = `stub:${id}`;

  let uploaded = false;
  if (storageEnabled()) {
    // Sanitise extension — only short alphanumerics, no traversal characters.
    const raw = (file.name.split(".").pop() ?? "bin").toLowerCase();
    const ext = SAFE_EXT_RE.test(raw) ? raw : "bin";
    storageKey = `${actor.tenantId}/${patientId}/${id}.${ext}`;
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
        name: file.name,
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
