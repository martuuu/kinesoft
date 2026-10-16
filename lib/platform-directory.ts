"use server";

/**
 * /plataforma · moderación del directorio público (DIR-2c, plan §20.10; contrato C-DIR8, fila «Ocultar/mostrar
 * consultorio, ocultar perfil, verificar matrícula»).
 *
 * Seis actions con el mismo orden que el ciclo de vida (`lib/platform-tenant-lifecycle.ts`):
 * `requirePlatformAdmin("directory.moderate")` (C-BO2: la ÚNICA barrera, todo corre por el canal service, BYPASSRLS)
 * → zod `.strict()` → `prismaService.$transaction` con la fila bloqueada (FOR UPDATE) → audit doble `platform.*` en la
 * MISMA tx → revalidar el directorio después del commit y solo si algo cambió.
 *
 *   - ocultar / mostrar un consultorio: `Tenant.directoryHidden{At,Reason,ById}`. Ocultar pisa el opt-in del Titular
 *     sin tocarlo (el switch sigue como él lo dejó): al mostrar, vuelve a aparecer si seguía publicado.
 *   - ocultar / mostrar un perfil: `ProfessionalPublicProfile.hidden{At,Reason,ById}`. Tampoco toca `listed` ni el
 *     consentimiento (son de la persona, C-DIR8: solo `lib/public-profile.ts` los escribe).
 *   - verificar / quitar la verificación de la matrícula: `licenseVerified{At,ById}`. Sin matrícula cargada no hay
 *     nada que verificar (CHECK `_verified_check` en la base; acá se rechaza antes con un mensaje claro). Si la
 *     persona después cambia la matrícula, el trigger de M11 borra la verificación (DIR-D10).
 *
 * Escritor único (guard `tests/unit/directory-writers.test.ts`, DIR-2b): este archivo es el ÚNICO que escribe
 * `directoryHidden*`, `hiddenAt/Reason/ById` y `licenseVerified*` (DIR-D24: la UPDATE policy de tenant de `Tenant`
 * dejaría a la app escribirlas; no hay ningún otro camino que lo haga).
 *
 * Audit (C-DIR8 «doble»):
 *   - consultorio: `auditPlatformInTx` = `PlatformAuditEvent` + `AuditEvent` del consultorio (lo ve su OWNER).
 *   - perfil: es POR PERSONA (sin tenantId). Una fila global (`auditPlatformGlobalInTx`, `targetUserId` = la persona)
 *     y un `AuditEvent` en CADA consultorio donde la persona atiende (tiene `Practitioner`), enlazado con el
 *     `platformEventId`: el Titular de cada consultorio ve que Plataforma ocultó a alguien de su equipo. Una sola fila
 *     global y no una por consultorio: es UNA acción, el visor de Plataforma la cuenta una vez.
 *   - payload SIN el texto del motivo (mismo criterio que `statusReason` en el ciclo de vida, handoff BO1-B): el
 *     registro es solo inserción y el motivo es texto libre; queda en la fila (el Titular lo ve en la banda de
 *     Configuración, C-DIR9) mientras dure la moderación. Solo claves cambiadas, booleanos e ids.
 *
 * Sin PHI: solo `Tenant`, `ProfessionalPublicProfile` y `Practitioner.tenantId` (para saber dónde auditar).
 */
import { revalidatePath, revalidateTag } from "next/cache";
import { z, type ZodError } from "zod";
import type { Prisma } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { requirePlatformAdmin, type PlatformActor } from "@/lib/platform-actor";
import { auditInTx, auditPlatformGlobalInTx, auditPlatformInTx } from "@/lib/audit";
import type { PlatformActorRef, PlatformAuditAction } from "@/lib/platform-audit-types";
import { getRequestContext } from "@/lib/request-context";
import { tags } from "@/lib/cache-tags";
import type { ActionResult } from "@/lib/validation";

type Result = ActionResult<{ changed: boolean }>;

const TENANT_NOT_FOUND = "No encontramos ese consultorio. Volvé a la lista.";
const PROFILE_NOT_FOUND = "No encontramos ese perfil. Volvé a la lista.";

// ids: cuid de Prisma; el tope solo frena basura (el lookup es por PK).
const Id = z.string().trim().min(1).max(64);
// Mismo rango que los CHECK `Tenant_directoryHidden_check` / `ProfessionalPublicProfile_hidden_check` (btrim 3..500):
// la base lo vuelve a exigir, pero acá el superadmin ve el error en el campo y no un 500.
const Reason = z
  .string()
  .trim()
  .min(3, "Escribí un motivo (mínimo 3 caracteres).")
  .max(500, "El motivo puede tener hasta 500 caracteres.");

const HideTenant = z.object({ tenantId: Id, reason: Reason }).strict();
const TenantRef = z.object({ tenantId: Id }).strict();
const HideProfile = z.object({ profileId: Id, reason: Reason }).strict();
const ProfileRef = z.object({ profileId: Id }).strict();

function invalid(err: ZodError): Result {
  const fieldErrors: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(err.flatten().fieldErrors)) if (v) fieldErrors[k] = v as string[];
  return { ok: false, error: "Datos inválidos", fieldErrors };
}

function ref(actor: PlatformActor): PlatformActorRef {
  return { userId: actor.userId, email: actor.email, homeTenantId: actor.homeTenantId };
}

/**
 * Después del commit (adentro de la tx, un rollback dejaría el caché invalidado contra datos viejos y otro request lo
 * volvería a llenar con el estado previo). `tags.directory()` purga el snapshot y el ISR de las 3 rutas públicas.
 */
function revalidateDirectory(): void {
  revalidateTag(tags.directory());
  revalidatePath("/plataforma/directorio");
  // Configuración → «Directorio» muestra la banda «Plataforma ocultó el consultorio» y el estado de cada profesional.
  revalidatePath("/configuracion");
}

// ──────────────────────────────────────────────────────────────────────
// Consultorio: ocultar · mostrar
// ──────────────────────────────────────────────────────────────────────

async function lockTenant(tx: Prisma.TransactionClient, tenantId: string) {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Tenant" WHERE "id" = ${tenantId} FOR UPDATE`;
  if (locked.length === 0) return null;
  return tx.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { id: true, directoryHiddenAt: true, directoryHiddenReason: true },
  });
}

/**
 * Saca el consultorio del directorio (aunque el Titular lo tenga publicado). Ya oculto = actualiza el motivo (el
 * superadmin lo corrige sin tener que mostrar y volver a ocultar, que dejaría una ventana pública).
 */
export async function hideDirectoryTenant(raw: unknown): Promise<Result> {
  const actor = await requirePlatformAdmin("directory.moderate");
  const parsed = HideTenant.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);
  const { tenantId, reason } = parsed.data;

  const res = await prismaService.$transaction(async (tx) => {
    const cur = await lockTenant(tx, tenantId);
    if (!cur) return null;
    const wasHidden = cur.directoryHiddenAt !== null;
    if (wasHidden && cur.directoryHiddenReason === reason) return { changed: false };
    await tx.tenant.update({
      where: { id: tenantId },
      data: {
        // Se conserva la fecha original si ya estaba oculto: «oculto desde» es cuándo dejó de verse.
        directoryHiddenAt: cur.directoryHiddenAt ?? new Date(),
        directoryHiddenReason: reason,
        directoryHiddenById: actor.userId,
      },
    });
    await auditPlatformInTx(tx, {
      actor: ref(actor),
      affectedTenantId: tenantId,
      action: "platform.directory.tenant_hide",
      entity: "Tenant",
      entityId: tenantId,
      payload: wasHidden
        ? { changed: ["directoryHiddenReason"], before: { hidden: true }, after: { hidden: true } }
        : {
            changed: ["directoryHiddenAt", "directoryHiddenReason", "directoryHiddenById"],
            before: { hidden: false },
            after: { hidden: true },
          },
    });
    return { changed: true };
  });
  if (!res) return { ok: false, error: TENANT_NOT_FOUND };
  if (res.changed) revalidateDirectory();
  return { ok: true, data: res };
}

/** Levanta la moderación. Vuelve a aparecer solo si el Titular lo sigue publicando y cumple el resto (C-DIR4). */
export async function showDirectoryTenant(raw: unknown): Promise<Result> {
  const actor = await requirePlatformAdmin("directory.moderate");
  const parsed = TenantRef.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);
  const { tenantId } = parsed.data;

  const res = await prismaService.$transaction(async (tx) => {
    const cur = await lockTenant(tx, tenantId);
    if (!cur) return null;
    if (cur.directoryHiddenAt === null) return { changed: false };
    await tx.tenant.update({
      where: { id: tenantId },
      data: { directoryHiddenAt: null, directoryHiddenReason: null, directoryHiddenById: null },
    });
    await auditPlatformInTx(tx, {
      actor: ref(actor),
      affectedTenantId: tenantId,
      action: "platform.directory.tenant_show",
      entity: "Tenant",
      entityId: tenantId,
      payload: {
        changed: ["directoryHiddenAt", "directoryHiddenReason", "directoryHiddenById"],
        before: { hidden: true },
        after: { hidden: false },
      },
    });
    return { changed: true };
  });
  if (!res) return { ok: false, error: TENANT_NOT_FOUND };
  if (res.changed) revalidateDirectory();
  return { ok: true, data: res };
}

// ──────────────────────────────────────────────────────────────────────
// Perfil por persona: ocultar · mostrar · verificar matrícula
// ──────────────────────────────────────────────────────────────────────

type LockedProfile = {
  id: string;
  userId: string;
  hiddenAt: Date | null;
  hiddenReason: string | null;
  licenseNumber: string | null;
  licenseVerifiedAt: Date | null;
};

async function lockProfile(tx: Prisma.TransactionClient, profileId: string): Promise<LockedProfile | null> {
  // FOR UPDATE: dos superadmins (o el superadmin y la persona editando su matrícula, que dispara el trigger) no se
  // pisan; la decisión se toma contra la fila bloqueada.
  const rows = await tx.$queryRaw<LockedProfile[]>`
    SELECT "id", "userId", "hiddenAt", "hiddenReason", "licenseNumber", "licenseVerifiedAt"
    FROM "ProfessionalPublicProfile" WHERE "id" = ${profileId} FOR UPDATE`;
  return rows[0] ?? null;
}

/**
 * Audit del perfil: una fila global + un `AuditEvent` en cada consultorio donde la persona atiende (ver cabecera).
 * `tenantId` a mano: el canal service saltea RLS.
 */
async function auditProfileInTx(
  tx: Prisma.TransactionClient,
  actor: PlatformActor,
  p: { action: PlatformAuditAction; profile: LockedProfile; payload: Record<string, unknown> }
): Promise<void> {
  const tenants = await tx.practitioner.findMany({
    where: { userId: p.profile.userId },
    select: { tenantId: true },
    distinct: ["tenantId"],
  });
  const global = await auditPlatformGlobalInTx(tx, {
    actor: ref(actor),
    action: p.action,
    entity: "ProfessionalPublicProfile",
    entityId: p.profile.id,
    targetUserId: p.profile.userId,
    payload: { ...p.payload, tenantIds: tenants.map((t) => t.tenantId) },
  });
  // Sin idempotencyKey siempre inserta; el guard es por si alguien se la suma: sin fila global no hay locales.
  if (!global.inserted) return;
  const ctx = getRequestContext();
  for (const { tenantId } of tenants) {
    await auditInTx(tx, {
      tenantId,
      actorId: actor.userId,
      action: p.action,
      entity: "ProfessionalPublicProfile",
      entityId: p.profile.id,
      ip: ctx?.ip,
      userAgent: ctx?.userAgent,
      payload: {
        ...p.payload,
        platform: { actorHomeTenantId: actor.homeTenantId, platformEventId: global.platformEventId },
      },
    });
  }
}

/** Saca el perfil del directorio sin tocar su consentimiento. Ya oculto = actualiza el motivo. */
export async function hideDirectoryProfile(raw: unknown): Promise<Result> {
  const actor = await requirePlatformAdmin("directory.moderate");
  const parsed = HideProfile.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);
  const { profileId, reason } = parsed.data;

  const res = await prismaService.$transaction(async (tx) => {
    const cur = await lockProfile(tx, profileId);
    if (!cur) return null;
    const wasHidden = cur.hiddenAt !== null;
    if (wasHidden && cur.hiddenReason === reason) return { changed: false };
    await tx.professionalPublicProfile.update({
      where: { id: profileId },
      data: { hiddenAt: cur.hiddenAt ?? new Date(), hiddenReason: reason, hiddenById: actor.userId },
    });
    await auditProfileInTx(tx, actor, {
      action: "platform.directory.profile_hide",
      profile: cur,
      payload: wasHidden
        ? { changed: ["hiddenReason"], before: { hidden: true }, after: { hidden: true } }
        : { changed: ["hiddenAt", "hiddenReason", "hiddenById"], before: { hidden: false }, after: { hidden: true } },
    });
    return { changed: true };
  });
  if (!res) return { ok: false, error: PROFILE_NOT_FOUND };
  if (res.changed) revalidateDirectory();
  return { ok: true, data: res };
}

/** Levanta la moderación del perfil. Vuelve a verse solo si la persona lo sigue publicando con consentimiento. */
export async function showDirectoryProfile(raw: unknown): Promise<Result> {
  const actor = await requirePlatformAdmin("directory.moderate");
  const parsed = ProfileRef.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);
  const { profileId } = parsed.data;

  const res = await prismaService.$transaction(async (tx) => {
    const cur = await lockProfile(tx, profileId);
    if (!cur) return null;
    if (cur.hiddenAt === null) return { changed: false };
    await tx.professionalPublicProfile.update({
      where: { id: profileId },
      data: { hiddenAt: null, hiddenReason: null, hiddenById: null },
    });
    await auditProfileInTx(tx, actor, {
      action: "platform.directory.profile_show",
      profile: cur,
      payload: { changed: ["hiddenAt", "hiddenReason", "hiddenById"], before: { hidden: true }, after: { hidden: false } },
    });
    return { changed: true };
  });
  if (!res) return { ok: false, error: PROFILE_NOT_FOUND };
  if (res.changed) revalidateDirectory();
  return { ok: true, data: res };
}

const NO_LICENSE = "Ese perfil no tiene matrícula cargada: no hay nada que verificar.";

/**
 * Marca la matrícula como verificada (DIR-D10: el badge «verificada» sale solo de acá). El superadmin la cotejó por
 * fuera (padrón del colegio/ministerio); acá queda quién y cuándo. Ya verificada = no-op.
 */
export async function verifyDirectoryLicense(raw: unknown): Promise<Result> {
  const actor = await requirePlatformAdmin("directory.moderate");
  const parsed = ProfileRef.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);
  const { profileId } = parsed.data;

  const res = await prismaService.$transaction(async (tx): Promise<{ error: string } | { changed: boolean }> => {
    const cur = await lockProfile(tx, profileId);
    if (!cur) return { error: PROFILE_NOT_FOUND };
    if (cur.licenseNumber === null) return { error: NO_LICENSE };
    if (cur.licenseVerifiedAt !== null) return { changed: false };
    await tx.professionalPublicProfile.update({
      where: { id: profileId },
      // El trigger de M11 solo borra la verificación si cambia la matrícula; acá no cambia, así que queda.
      data: { licenseVerifiedAt: new Date(), licenseVerifiedById: actor.userId },
    });
    await auditProfileInTx(tx, actor, {
      action: "platform.directory.license_verify",
      profile: cur,
      payload: { changed: ["licenseVerifiedAt", "licenseVerifiedById"], before: { verified: false }, after: { verified: true } },
    });
    return { changed: true };
  });
  if ("error" in res) return { ok: false, error: res.error };
  if (res.changed) revalidateDirectory();
  return { ok: true, data: { changed: res.changed } };
}

/** Quita la verificación (se verificó por error, o la matrícula dejó de estar vigente). Sin verificar = no-op. */
export async function unverifyDirectoryLicense(raw: unknown): Promise<Result> {
  const actor = await requirePlatformAdmin("directory.moderate");
  const parsed = ProfileRef.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);
  const { profileId } = parsed.data;

  const res = await prismaService.$transaction(async (tx) => {
    const cur = await lockProfile(tx, profileId);
    if (!cur) return null;
    if (cur.licenseVerifiedAt === null) return { changed: false };
    await tx.professionalPublicProfile.update({
      where: { id: profileId },
      data: { licenseVerifiedAt: null, licenseVerifiedById: null },
    });
    await auditProfileInTx(tx, actor, {
      action: "platform.directory.license_unverify",
      profile: cur,
      payload: { changed: ["licenseVerifiedAt", "licenseVerifiedById"], before: { verified: true }, after: { verified: false } },
    });
    return { changed: true };
  });
  if (!res) return { ok: false, error: PROFILE_NOT_FOUND };
  if (res.changed) revalidateDirectory();
  return { ok: true, data: res };
}
