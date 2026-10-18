"use server";

/**
 * Logo del consultorio y firma escaneada de cada profesional (T4 FC-2f, contrato C-FC9; brief §24.4 «Matrícula y
 * firma», decisión 2 del 19-oct: «membrete, imagen de firma y logo; que salga todo»). Los embebe el render del PDF y
 * del Word desde el server (`lib/hc-assets-internal.ts`, FC-2e); este archivo solo los sube, los borra y da una vista
 * previa.
 *
 * Reglas:
 *  - Logo: `tenant.sensitive` (datos del consultorio, como el resto de lo delicado de Configuración). Firma: SOLO la
 *    propia (`actor.practitionerId`); nadie carga ni borra la firma de otro, ni el Titular: una firma es de quien firma.
 *  - PNG o JPEG con magic bytes y tope de dimensiones (`checkPracticeAsset`, `lib/file-sniff.ts`). WEBP, GIF, HEIC y SVG
 *    se rechazan SIN subir: react-pdf y docx no los embeben sin convertir, y el SVG es markup.
 *  - Orden (C-FC9): escribible → chequeo → upload → tx con CAS sobre `*UpdatedAt` + audit → DESPUÉS del commit se borra
 *    el viejo. Así nunca queda la fila apuntando a un objeto borrado: si la tx falla se borra el NUEVO, y si el remove
 *    del viejo falla queda un huérfano en un bucket privado (inofensivo, logueado).
 *  - Claves armadas acá con un nonce del server: `{tenant}/logo/{nonce}.{ext}` y
 *    `{tenant}/signature/{practitionerId}/{nonce}.{ext}`. Clave nueva en cada subida (nunca se pisa un objeto): un PDF
 *    que se está generando con el logo viejo no ve el cambio a mitad de camino.
 *  - Bucket privado `practice-assets` (1 MB, png/jpeg; lo crea Martin en la consola, EXTERNAL-CONFIG).
 *  - Sin Storage configurado (dev/CI) no hay dónde guardar la imagen: se responde error, no se inventa un `stub:`.
 *
 * Exporta solo funciones async (`"use server"`): `readImageInfo`, `PRACTICE_ASSET_LIMITS` y la validación viven en
 * `lib/file-sniff.ts` (puro).
 */
import { revalidatePath } from "next/cache";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { runWithRls } from "@/lib/rls";
import { ForbiddenError, getActor, writableError } from "@/lib/session";
import { requireTenantSensitive } from "@/lib/authz";
import { auditInTx } from "@/lib/audit";
import { withReadOnlyResult } from "@/lib/read-only-result";
import type { ActionResult } from "@/lib/validation";
import { isStorageConfigured, storageRemove, storageSign, storageUpload } from "@/lib/storage-internal";
import { PRACTICE_ASSET_COPY, PRACTICE_ASSET_LIMITS, checkPracticeAsset, type PracticeAssetKind } from "@/lib/file-sniff";

const BUCKET = "practice-assets";
const PREVIEW_TTL_S = 60;
const NO_STORAGE = "Las imágenes no se pueden guardar en este entorno.";
const SAVE_FAILED = "No pudimos guardar la imagen. Probá de nuevo.";
const CONFLICT = "La imagen cambió mientras la subías. Recargá y probá de nuevo.";
const NOT_PRACTITIONER = "La firma es solo para profesionales que atienden en el consultorio.";

type Target =
  | { kind: "logo"; tenantId: string }
  | { kind: "signature"; tenantId: string; practitionerId: string };

function newKey(t: Target, ext: string): string {
  const nonce = randomBytes(12).toString("hex");
  return t.kind === "logo"
    ? `${t.tenantId}/logo/${nonce}.${ext}`
    : `${t.tenantId}/signature/${t.practitionerId}/${nonce}.${ext}`;
}

function forbidden(e: unknown): { ok: false; error: string } | null {
  return e instanceof ForbiddenError ? { ok: false, error: e.message } : null;
}

/** `expectedUpdatedAt` opcional del form: si viene y no coincide con la fila, es conflicto (otra pestaña cambió). */
function readExpected(formData: FormData): string | null | undefined {
  const raw = formData.get("expectedUpdatedAt");
  if (raw === null) return undefined;
  const s = String(raw).trim();
  return s === "" ? null : s;
}

/** Lo común a logo y firma: chequeo → upload → tx con CAS + audit → borrar el viejo después del commit. */
async function replaceAsset(
  actor: { tenantId: string; userId: string },
  target: Target,
  formData: FormData,
): Promise<ActionResult<{ updatedAt: string }>> {
  const file = formData.get("file");
  const kind: PracticeAssetKind = target.kind;
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Adjuntá una imagen." };
  // Tope de bytes antes de leer el archivo a memoria (el chequeo lo repite sobre los bytes reales).
  if (file.size > PRACTICE_ASSET_LIMITS[kind].maxBytes) {
    return { ok: false, error: kind === "logo" ? PRACTICE_ASSET_COPY.logoFormat : PRACTICE_ASSET_COPY.signatureFormat };
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const checked = checkPracticeAsset(kind, bytes, file.type);
  if (!checked.ok) return checked;
  if (!isStorageConfigured()) return { ok: false, error: NO_STORAGE };

  const key = newKey(target, checked.ext);
  const up = await storageUpload(BUCKET, key, bytes, checked.mime);
  if (!up.ok) return { ok: false, error: SAVE_FAILED };

  const expected = readExpected(formData);
  let result: { kind: "ok"; oldKey: string | null; updatedAt: Date } | { kind: "conflict" } | { kind: "notfound" };
  try {
    result = await runWithRls(actor.tenantId, async (tx) => {
      const now = new Date();
      if (target.kind === "logo") {
        const row = await tx.tenant.findFirst({
          where: { id: target.tenantId },
          select: { logoStorageKey: true, logoUpdatedAt: true },
        });
        if (!row) return { kind: "notfound" as const };
        if (expected !== undefined && (row.logoUpdatedAt?.toISOString() ?? null) !== expected) {
          return { kind: "conflict" as const };
        }
        // CAS: si otra subida commiteó entre la lectura y acá, no se pisa (y el viejo que se borra es el que se leyó).
        const n = await tx.tenant.updateMany({
          where: { id: target.tenantId, logoUpdatedAt: row.logoUpdatedAt },
          data: { logoStorageKey: key, logoUpdatedAt: now },
        });
        if (n.count !== 1) return { kind: "conflict" as const };
        await auditInTx(tx, {
          tenantId: actor.tenantId,
          actorId: actor.userId,
          action: "tenant.logo.update",
          entity: "Tenant",
          entityId: target.tenantId,
          payload: { mime: checked.mime, sizeBytes: bytes.length, width: checked.width, height: checked.height },
        });
        return { kind: "ok" as const, oldKey: row.logoStorageKey, updatedAt: now };
      }
      const row = await tx.practitioner.findFirst({
        where: { id: target.practitionerId, tenantId: target.tenantId },
        select: { signatureStorageKey: true, signatureUpdatedAt: true },
      });
      if (!row) return { kind: "notfound" as const };
      if (expected !== undefined && (row.signatureUpdatedAt?.toISOString() ?? null) !== expected) {
        return { kind: "conflict" as const };
      }
      const n = await tx.practitioner.updateMany({
        where: { id: target.practitionerId, tenantId: target.tenantId, signatureUpdatedAt: row.signatureUpdatedAt },
        data: { signatureStorageKey: key, signatureUpdatedAt: now },
      });
      if (n.count !== 1) return { kind: "conflict" as const };
      await auditInTx(tx, {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "practitioner.signature.update",
        entity: "Practitioner",
        entityId: target.practitionerId,
        payload: { mime: checked.mime, sizeBytes: bytes.length, width: checked.width, height: checked.height },
      });
      return { kind: "ok" as const, oldKey: row.signatureStorageKey, updatedAt: now };
    });
  } catch (e) {
    // La fila no cambió: el objeto nuevo no lo referencia nadie.
    await storageRemove(BUCKET, [key]);
    throw e;
  }
  if (result.kind !== "ok") {
    await storageRemove(BUCKET, [key]);
    return { ok: false, error: result.kind === "conflict" ? CONFLICT : NOT_PRACTITIONER };
  }
  // Después del commit: el viejo ya no lo referencia ninguna fila. Si falla, queda un huérfano privado (logueado).
  if (result.oldKey) await storageRemove(BUCKET, [result.oldKey]);
  revalidatePath("/configuracion");
  return { ok: true, data: { updatedAt: result.updatedAt.toISOString() } };
}

async function clearAsset(actor: { tenantId: string; userId: string }, target: Target): Promise<ActionResult> {
  const result = await runWithRls(actor.tenantId, async (tx) => {
    if (target.kind === "logo") {
      const row = await tx.tenant.findFirst({ where: { id: target.tenantId }, select: { logoStorageKey: true } });
      if (!row?.logoStorageKey) return { oldKey: null };
      await tx.tenant.updateMany({
        where: { id: target.tenantId, logoStorageKey: row.logoStorageKey },
        data: { logoStorageKey: null, logoUpdatedAt: null },
      });
      await auditInTx(tx, {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "tenant.logo.remove",
        entity: "Tenant",
        entityId: target.tenantId,
      });
      return { oldKey: row.logoStorageKey };
    }
    const row = await tx.practitioner.findFirst({
      where: { id: target.practitionerId, tenantId: target.tenantId },
      select: { signatureStorageKey: true },
    });
    if (!row?.signatureStorageKey) return { oldKey: null };
    await tx.practitioner.updateMany({
      where: { id: target.practitionerId, tenantId: target.tenantId, signatureStorageKey: row.signatureStorageKey },
      data: { signatureStorageKey: null, signatureUpdatedAt: null },
    });
    await auditInTx(tx, {
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: "practitioner.signature.remove",
      entity: "Practitioner",
      entityId: target.practitionerId,
    });
    return { oldKey: row.signatureStorageKey };
  });
  if (result.oldKey && isStorageConfigured()) await storageRemove(BUCKET, [result.oldKey]);
  revalidatePath("/configuracion");
  return { ok: true, data: undefined };
}

export async function uploadTenantLogo(formData: FormData): Promise<ActionResult<{ updatedAt: string }>> {
  return withReadOnlyResult(async () => {
    let actor;
    try {
      actor = await requireTenantSensitive();
    } catch (e) {
      const f = forbidden(e);
      if (f) return f;
      throw e;
    }
    // Antes de Storage (BO-Z A1): la subida va por service role fuera de la tx.
    const readOnly = writableError(actor);
    if (readOnly) return { ok: false as const, error: readOnly };
    return replaceAsset(actor, { kind: "logo", tenantId: actor.tenantId }, formData);
  });
}

export async function removeTenantLogo(): Promise<ActionResult> {
  return withReadOnlyResult(async () => {
    let actor;
    try {
      actor = await requireTenantSensitive();
    } catch (e) {
      const f = forbidden(e);
      if (f) return f;
      throw e;
    }
    const readOnly = writableError(actor);
    if (readOnly) return { ok: false as const, error: readOnly };
    return clearAsset(actor, { kind: "logo", tenantId: actor.tenantId });
  });
}

export async function uploadOwnSignature(formData: FormData): Promise<ActionResult<{ updatedAt: string }>> {
  return withReadOnlyResult(async () => {
    const actor = await getActor();
    const readOnly = writableError(actor);
    if (readOnly) return { ok: false as const, error: readOnly };
    // Solo la propia: el id sale del Actor, nunca del form. Se narrowea a una variable (guard IAM-4a: nunca
    // `practitionerId: actor.practitionerId` crudo, que con null compilaría a IS NULL).
    const practitionerId = actor.practitionerId;
    if (!practitionerId) return { ok: false as const, error: NOT_PRACTITIONER };
    return replaceAsset(actor, { kind: "signature", tenantId: actor.tenantId, practitionerId }, formData);
  });
}

export async function removeOwnSignature(): Promise<ActionResult> {
  return withReadOnlyResult(async () => {
    const actor = await getActor();
    const readOnly = writableError(actor);
    if (readOnly) return { ok: false as const, error: readOnly };
    const practitionerId = actor.practitionerId;
    if (!practitionerId) return { ok: false as const, error: NOT_PRACTITIONER };
    return clearAsset(actor, { kind: "signature", tenantId: actor.tenantId, practitionerId });
  });
}

// `licenseNumber` es texto libre histórico (`formatLicense` lo normaliza al imprimir): se recorta, sin controles, ≤60
// (el mismo tope que `formatLicense`). Vacío → null.
const SignatureInfoSchema = z.object({
  honorific: z.enum(["LIC", "KLGO", "KLGA", "DR", "DRA"]).nullable(),
  licenseNumber: z
    .string()
    .trim()
    .max(60, "La matrícula es demasiado larga.")
    // eslint-disable-next-line no-control-regex
    .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), "La matrícula tiene caracteres inválidos.")
    .nullable(),
});

export async function updateOwnSignatureInfo(input: {
  honorific: "LIC" | "KLGO" | "KLGA" | "DR" | "DRA" | null;
  licenseNumber: string | null;
}): Promise<ActionResult> {
  return withReadOnlyResult(async () => {
    const actor = await getActor();
    const readOnly = writableError(actor);
    if (readOnly) return { ok: false as const, error: readOnly };
    if (!actor.practitionerId) return { ok: false as const, error: NOT_PRACTITIONER };
    const parsed = SignatureInfoSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false as const, error: parsed.error.issues[0]?.message ?? "Revisá los datos." };
    }
    const honorific = parsed.data.honorific;
    const licenseNumber = parsed.data.licenseNumber || null;
    const practitionerId = actor.practitionerId;
    const n = await runWithRls(actor.tenantId, async (tx) => {
      const r = await tx.practitioner.updateMany({
        where: { id: practitionerId, tenantId: actor.tenantId },
        data: { honorific, licenseNumber },
      });
      if (r.count === 1) {
        await auditInTx(tx, {
          tenantId: actor.tenantId,
          actorId: actor.userId,
          action: "practitioner.signature_info.update",
          entity: "Practitioner",
          entityId: practitionerId,
          payload: { honorific, licenseNumber },
        });
      }
      return r.count;
    });
    if (n !== 1) return { ok: false as const, error: NOT_PRACTITIONER };
    revalidatePath("/configuracion");
    return { ok: true as const, data: undefined };
  });
}

/**
 * URL firmada de 60 s para la vista previa en Configuración. El logo lo ve cualquier miembro (sale impreso en cada
 * PDF del consultorio); la firma, solo la propia. Sin imagen o sin Storage → `{ url: null }`.
 */
export async function getPracticeAssetPreviewUrl(kind: "logo" | "signature"): Promise<ActionResult<{ url: string | null }>> {
  const actor = await getActor();
  if (kind !== "logo" && kind !== "signature") return { ok: false, error: "Pedido inválido." };
  if (kind === "signature" && !actor.practitionerId) return { ok: true, data: { url: null } };
  const practitionerId = actor.practitionerId;
  const key = await runWithRls(actor.tenantId, async (tx) => {
    if (kind === "logo") {
      const row = await tx.tenant.findFirst({ where: { id: actor.tenantId }, select: { logoStorageKey: true } });
      return row?.logoStorageKey ?? null;
    }
    const row = await tx.practitioner.findFirst({
      where: { id: practitionerId!, tenantId: actor.tenantId },
      select: { signatureStorageKey: true },
    });
    return row?.signatureStorageKey ?? null;
  });
  if (!key || !isStorageConfigured()) return { ok: true, data: { url: null } };
  const signed = await storageSign(BUCKET, key, PREVIEW_TTL_S);
  if (!signed.ok) return { ok: false, error: "No pudimos cargar la vista previa." };
  return { ok: true, data: { url: signed.data } };
}
