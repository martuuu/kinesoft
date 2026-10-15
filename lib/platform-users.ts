"use server";

/**
 * /plataforma usuarios y reparaciones (BO2-C, plan §19.5 fila «C usuarios y reparación»; absorbe la «4d» de IAM).
 * Las lecturas viven en `lib/platform-users-read.ts` y `lib/platform-health-read.ts`; la lógica pura y los tipos,
 * en `lib/platform-health-logic.ts` (un archivo "use server" solo exporta funciones async).
 *
 * Cada export: `requirePlatformAdmin(<clave>)` PRIMERO (canal service, BYPASSRLS: es la única barrera; además
 * aplica el rate limit de la clave) → zod `.strict()` → tx de `prismaService` con `auditPlatformGlobalInTx` (o
 * `auditPlatformInTx` cuando la reparación cae en un consultorio) → después del commit, Auth y revalidación.
 *
 * Por qué cada acción (§19.1, «cuentas muertas»):
 *  - Link de activación/recuperación: el invitado que quedó sin contraseña, el que perdió el mail. El superadmin NO
 *    ve el link si el mail salió (es una credencial de un clic de otra persona); solo si no salió se lo devolvemos
 *    para copiar y mandarlo por otro canal.
 *  - Deshabilitar/habilitar: `UserProfile.disabledAt` es lo que corta el acceso en la app (`getSessionBlock`,
 *    `requirePlatformAdmin`); el ban de Auth además impide renovar el token y loguearse. Base primero (es la verdad
 *    de la app) y Auth después: si Auth falla, el resultado lo dice (`authSynced: false`) y reintentar es seguro.
 *  - Dar/quitar superadmin: con confirmación tipeada del email hasta que BO4 traiga MFA.
 *  - «Nunca el último superadmin»: las filas de superadmins se bloquean (`FOR UPDATE`) antes de contar, así dos
 *    superadmins que se deshabilitan mutuamente a la vez no dejan la plataforma sin nadie (el segundo espera y ve 1).
 *  - Reparaciones: crear el `Practitioner` + agenda que falta (bucle `missing_practitioner`), borrar un usuario de
 *    Auth huérfano SOLO si `canSafelyDeleteAuthUser` (borrar de más es irreversible), sincronizar el email del
 *    perfil con Auth (Auth es con lo que la persona entra).
 *
 * Registro: payloads sin PHI ni textos libres (el motivo de deshabilitar queda en `UserProfile.disabledReason`, en
 * el registro solo si se dio uno); ni emails ni links.
 */
import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { requirePlatformAdmin, type PlatformActor } from "@/lib/platform-actor";
import { auditPlatformGlobalInTx, auditPlatformInTx, type PlatformActorRef } from "@/lib/audit";
import { authAdmin } from "@/lib/identity/auth-admin";
import { issueAccessLink } from "@/lib/identity/access-link";
import { sendEmail } from "@/lib/email";
import { platformAccessLinkEmail } from "@/lib/email/templates";
import "@/lib/email/log";
import { canSafelyDeleteAuthUser } from "@/lib/access-logic";
import { emailEqualsFilter, normalizeEmail } from "@/lib/email-match";
import { isClinicalRole } from "@/lib/roles";
import { provisionPractitionerAgenda } from "@/lib/agenda-defaults";
import { tags } from "@/lib/cache-tags";
import { logger } from "@/lib/logger";
import {
  PLATFORM_BAN_DURATION,
  accessLinkPurpose,
  confirmEmailMatches,
  disableBlockReason,
  emailsDiffer,
  revokeAdminBlockReason,
  type EmailDeliveryStatus,
  type PlatformAccessLinkResult,
  type PlatformUserToggleResult,
} from "@/lib/platform-health-logic";
import type { ActionResult } from "@/lib/validation";

const Id = z.string().trim().min(1).max(128);
const INVALID = { ok: false as const, error: "Datos inválidos" };
const NOT_FOUND = "No encontramos ese usuario. Puede que lo hayan borrado: recargá la lista.";

function refOf(actor: PlatformActor): PlatformActorRef {
  return { userId: actor.userId, email: actor.email, homeTenantId: actor.homeTenantId };
}

/** Error de negocio dentro de la tx: aborta (rollback del audit) y vuelve como copy al usuario. */
class PlatformUserError extends Error {
  constructor(public copy: string) {
    super(copy);
    this.name = "PlatformUserError";
  }
}

async function failAsResult<T>(fn: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PlatformUserError) return { ok: false, error: e.copy };
    throw e;
  }
}

/**
 * Bloquea las filas de superadmins (y la del usuario afectado) y devuelve cuántos superadmins ACTIVOS hay. Con
 * READ COMMITTED, el segundo de dos pedidos concurrentes espera el commit del primero y recién ahí cuenta.
 */
async function lockAdminsAndTarget(tx: Prisma.TransactionClient, userId: string): Promise<number> {
  await tx.$queryRaw`SELECT "id" FROM "UserProfile" WHERE "isPlatformAdmin" = true OR "id" = ${userId} ORDER BY "id" FOR UPDATE`;
  return tx.userProfile.count({ where: { isPlatformAdmin: true, disabledAt: null } });
}

// ── Link de activación / recuperación ─────────────────────────────────────────

const AccessLinkInput = z.object({ userId: Id }).strict();

export async function sendPlatformAccessLink(raw: unknown): Promise<ActionResult<PlatformAccessLinkResult>> {
  const actor = await requirePlatformAdmin("user.access_link");
  const parsed = AccessLinkInput.safeParse(raw);
  if (!parsed.success) return INVALID;
  const { userId } = parsed.data;

  const profile = await prismaService.userProfile.findUnique({ where: { id: userId }, select: { email: true, disabledAt: true } });
  if (!profile) return { ok: false, error: NOT_FOUND };
  if (profile.disabledAt) return { ok: false, error: "Está deshabilitado: habilitalo antes de mandarle un link para entrar." };

  const auth = await authAdmin().getUser(userId);
  if (!auth.ok) {
    if (auth.code === "not_found") {
      return { ok: false, error: "Esta persona no tiene cuenta para ingresar (se borró del servicio de acceso). Revisalo en Salud." };
    }
    return { ok: false, error: "No pudimos consultar la cuenta. Probá de nuevo en unos minutos." };
  }
  // El link se emite por EMAIL (GoTrue no acepta id): si el perfil y Auth no coinciden, el mail iría a otra
  // dirección que la que ve el superadmin. Primero se sincroniza.
  if (!auth.data.email || emailsDiffer(profile.email, auth.data.email)) {
    return { ok: false, error: "El email del perfil no coincide con el de la cuenta. Sincronizalo desde Salud y volvé a probar." };
  }
  const email = normalizeEmail(auth.data.email);
  const purpose = accessLinkPurpose(auth.data);

  // Recovery sirve para los dos casos: lleva a /reset, donde elige contraseña (el invitado que nunca la tuvo
  // también). Es el único type con el que /auth/confirm deja cambiar la clave sin la actual.
  const link = await issueAccessLink({ email, kind: "recovery", next: "/reset" });
  if (!link.ok) {
    if (link.code === "rate_limited") return { ok: false, error: "El servicio de acceso está limitando los pedidos. Probá de nuevo en unos minutos." };
    return { ok: false, error: "No pudimos generar el link. Probá de nuevo en unos minutos." };
  }
  if (link.userId && link.userId !== userId) {
    logger.warn("platform.user.access_link.user_mismatch", { userId });
    return { ok: false, error: "El link salió para otra cuenta con ese email. Revisalo en Salud antes de reintentar." };
  }

  const r = await sendEmail({
    ...platformAccessLinkEmail({ url: link.url, purpose }),
    kind: "platform_access_link",
    to: email,
    tenantId: null,
    entity: "UserProfile",
    entityId: userId,
    actorId: actor.userId,
  });
  const emailStatus: EmailDeliveryStatus = r.ok ? "sent" : r.transport === "blocked" ? "blocked" : r.skipped ? "skipped" : "failed";
  // `blocked` = Production con un link a localhost: el link no sirve, no se muestra (es un error de config).
  // BO-Z (B2): y SOLO para una cuenta que nunca se activó (sin email confirmado ni ingreso). Antes, con el mail caído,
  // el superadmin recibía el link de recuperación de CUALQUIER cuenta, también la de un titular activo: un clic y
  // entraba como esa persona (que puede ser miembro de otros consultorios). Para una cuenta activa el link solo va
  // por mail a su casilla.
  const neverActivated = auth.data.emailConfirmedAt === null && auth.data.lastSignInAt === null;
  const copyUrl = r.ok || emailStatus === "blocked" || !neverActivated ? null : link.url;

  await prismaService.$transaction((tx) =>
    auditPlatformGlobalInTx(tx, {
      actor: refOf(actor),
      action: "platform.user.access_link",
      entity: "UserProfile",
      entityId: userId,
      targetUserId: userId,
      // Sin el link ni el email: para qué, si salió y si el superadmin lo vio.
      payload: { purpose, emailStatus, transport: r.transport, linkShown: copyUrl !== null },
    })
  );
  if (!r.ok && emailStatus !== "blocked" && !neverActivated) {
    // Mensaje claro en vez de un «copiá el link» que no llega: la cuenta ya está activa y el link no se muestra.
    return {
      ok: false,
      error:
        "El mail no salió y, como la cuenta ya está activa, no mostramos el link. Reintentá en unos minutos o pedile que use «¿Olvidaste tu contraseña?» al entrar.",
    };
  }
  return { ok: true, data: { purpose, emailSent: r.ok, emailStatus, copyUrl } };
}

// ── Deshabilitar / habilitar ──────────────────────────────────────────────────

const DisableInput = z
  .object({ userId: Id, disabled: z.boolean(), reason: z.string().trim().max(500).optional() })
  .strict();

export async function setPlatformUserDisabled(raw: unknown): Promise<ActionResult<PlatformUserToggleResult>> {
  const actor = await requirePlatformAdmin("user.disable");
  const parsed = DisableInput.safeParse(raw);
  if (!parsed.success) return INVALID;
  const { userId, disabled } = parsed.data;
  const reason = parsed.data.reason ? parsed.data.reason : null;
  if (disabled && userId === actor.userId) return { ok: false, error: "No podés deshabilitarte a vos mismo." };

  const res = await failAsResult(async () => {
    const changed = await prismaService.$transaction(async (tx) => {
      const activeAdmins = await lockAdminsAndTarget(tx, userId);
      const target = await tx.userProfile.findUnique({ where: { id: userId }, select: { isPlatformAdmin: true, disabledAt: true } });
      if (!target) throw new PlatformUserError(NOT_FOUND);
      if (disabled) {
        const block = disableBlockReason({
          actorId: actor.userId,
          targetId: userId,
          targetIsActiveAdmin: target.isPlatformAdmin && !target.disabledAt,
          activeAdminCount: activeAdmins,
        });
        if (block === "self") throw new PlatformUserError("No podés deshabilitarte a vos mismo.");
        if (block === "last_admin") throw new PlatformUserError("Es el último superadmin activo: no se puede deshabilitar.");
      }
      if (disabled === (target.disabledAt !== null)) return false;
      await tx.userProfile.update({
        where: { id: userId },
        data: disabled ? { disabledAt: new Date(), disabledReason: reason } : { disabledAt: null, disabledReason: null },
      });
      await auditPlatformGlobalInTx(tx, {
        actor: refOf(actor),
        action: disabled ? "platform.user.disable" : "platform.user.enable",
        entity: "UserProfile",
        entityId: userId,
        targetUserId: userId,
        payload: { reasonGiven: disabled ? reason !== null : undefined },
      });
      return true;
    });
    return { ok: true, data: changed };
  });
  if (!res.ok) return res;

  // Siempre, aunque la base ya estuviera así: es el camino del reintento cuando Auth falló la vez anterior.
  const ban = await authAdmin().updateUserById(userId, { banDuration: disabled ? PLATFORM_BAN_DURATION : "none" });
  // Sin usuario de Auth no hay nada que banear (la base ya corta el acceso a la app).
  const authSynced = ban.ok || ban.code === "not_found";
  if (!authSynced) logger.warn("platform.user.ban_sync_failed", { userId, disabled, code: ban.code });

  revalidatePath("/plataforma", "layout");
  return { ok: true, data: { changed: res.data, authSynced } };
}

// ── Dar / quitar superadmin ───────────────────────────────────────────────────

const SuperadminInput = z.object({ userId: Id, grant: z.boolean(), confirmEmail: z.string().max(320) }).strict();

export async function setPlatformSuperadmin(raw: unknown): Promise<ActionResult<{ changed: boolean }>> {
  const actor = await requirePlatformAdmin("user.superadmin.update");
  const parsed = SuperadminInput.safeParse(raw);
  if (!parsed.success) return INVALID;
  const { userId, grant, confirmEmail } = parsed.data;

  const res = await failAsResult(async () => {
    const changed = await prismaService.$transaction(async (tx) => {
      const activeAdmins = await lockAdminsAndTarget(tx, userId);
      const target = await tx.userProfile.findUnique({
        where: { id: userId },
        select: { email: true, isPlatformAdmin: true, disabledAt: true },
      });
      if (!target) throw new PlatformUserError(NOT_FOUND);
      // TODO(BO4): con MFA, la re-verificación TOTP reemplaza a esta confirmación tipeada.
      if (!confirmEmailMatches(confirmEmail, target.email)) {
        throw new PlatformUserError("Para confirmar, escribí exactamente el email de la persona.");
      }
      if (grant === target.isPlatformAdmin) return false;
      if (grant && target.disabledAt) throw new PlatformUserError("Está deshabilitado: habilitalo antes de darle acceso a Plataforma.");
      if (!grant) {
        const block = revokeAdminBlockReason({ targetIsActiveAdmin: !target.disabledAt, activeAdminCount: activeAdmins });
        if (block) throw new PlatformUserError("Es el último superadmin activo: no se le puede quitar el acceso.");
      }
      await tx.userProfile.update({ where: { id: userId }, data: { isPlatformAdmin: grant } });
      await auditPlatformGlobalInTx(tx, {
        actor: refOf(actor),
        action: grant ? "platform.superadmin.grant" : "platform.superadmin.revoke",
        entity: "UserProfile",
        entityId: userId,
        targetUserId: userId,
        payload: { via: "plataforma", self: userId === actor.userId },
      });
      return true;
    });
    return { ok: true, data: { changed } };
  });
  if (res.ok && res.data.changed) revalidatePath("/plataforma", "layout");
  return res;
}

// ── Reparaciones ──────────────────────────────────────────────────────────────

const PractitionerRepairInput = z.object({ tenantId: Id, userId: Id }).strict();

/**
 * Miembro clínico sin `Practitioner` en ese consultorio: su membresía no es usable (`missing_practitioner`) y el
 * acceso entra en bucle o en «sin acceso» (§19.1). Se crea el profesional + la agenda por defecto, como
 * `ensureClinicalPractitionerInTx` de `lib/invitations.ts` (que no es exportable: vive en un "use server" ajeno).
 * Idempotente: si ya existe, no crea ni audita.
 */
export async function repairCreatePractitioner(raw: unknown): Promise<ActionResult<{ practitionerId: string; created: boolean }>> {
  const actor = await requirePlatformAdmin("repair.run");
  const parsed = PractitionerRepairInput.safeParse(raw);
  if (!parsed.success) return INVALID;
  const { tenantId, userId } = parsed.data;

  const res = await failAsResult(async () => {
    const out = await prismaService.$transaction(async (tx) => {
      const m = await tx.membership.findUnique({
        where: { userId_tenantId: { userId, tenantId } },
        select: { role: true, acceptedAt: true, disabledAt: true, tenant: { select: { status: true } } },
      });
      if (!m) throw new PlatformUserError("Esa persona no es miembro de ese consultorio.");
      if (m.tenant.status === "CLOSED") throw new PlatformUserError("El consultorio está dado de baja.");
      if (!m.acceptedAt) throw new PlatformUserError("La invitación todavía no fue aceptada.");
      if (m.disabledAt) throw new PlatformUserError("Está suspendido en ese consultorio: reactivalo primero desde el equipo.");
      if (!isClinicalRole(m.role)) {
        throw new PlatformUserError("Su rol no atiende pacientes: no necesita profesional (entra sin agenda propia).");
      }
      // ON CONFLICT DO NOTHING sobre (tenantId, userId): dos reparaciones simultáneas no tiran P2002 en la tx.
      const ins = await tx.practitioner.createMany({ data: [{ tenantId, userId, specialty: null }], skipDuplicates: true });
      const prac = await tx.practitioner.findUniqueOrThrow({
        where: { tenantId_userId: { tenantId, userId } },
        select: { id: true },
      });
      if (ins.count === 0) return { practitionerId: prac.id, created: false };
      const agenda = await provisionPractitionerAgenda(tx, { tenantId, practitionerId: prac.id });
      await auditPlatformInTx(tx, {
        actor: refOf(actor),
        affectedTenantId: tenantId,
        action: "platform.repair.practitioner",
        entity: "Practitioner",
        entityId: prac.id,
        payload: { userId, role: m.role, schedules: agenda.schedules, services: agenda.services, payers: agenda.payers },
      });
      return { practitionerId: prac.id, created: true };
    });
    return { ok: true, data: out };
  });
  if (res.ok && res.data.created) {
    revalidateTag(tags.practitioners(tenantId));
    revalidatePath("/plataforma", "layout");
  }
  return res;
}

const AuthOrphanInput = z.object({ authUserId: Id }).strict();

/** Sentinela para deshacer el audit si GoTrue no borró. */
class AuthDeleteFailed extends Error {
  constructor(public code: string) {
    super(code);
    this.name = "AuthDeleteFailed";
  }
}

/**
 * Usuario de Auth huérfano (el invitado revocado de antes de IAM-2, el alta abandonada): deja el email «tomado».
 * Se borra SOLO si `canSafelyDeleteAuthUser` (nunca confirmó, nunca entró, sin perfil, sin membresías ni fichas),
 * con los conteos releídos acá. El audit va en la misma tx y se deshace si GoTrue no borra.
 */
export async function repairDeleteAuthOrphan(raw: unknown): Promise<ActionResult<{ deleted: true }>> {
  const actor = await requirePlatformAdmin("repair.run");
  const parsed = AuthOrphanInput.safeParse(raw);
  if (!parsed.success) return INVALID;
  const { authUserId } = parsed.data;

  const got = await authAdmin().getUser(authUserId);
  if (!got.ok) {
    if (got.code === "not_found") return { ok: false, error: "Esa cuenta ya no existe." };
    return { ok: false, error: "No pudimos consultar la cuenta. Probá de nuevo en unos minutos." };
  }
  const a = got.data;

  try {
    return await failAsResult(async () => {
      await prismaService.$transaction(async (tx) => {
        const [hasProfile, membershipCount, patientLinks] = await Promise.all([
          tx.userProfile.count({ where: { id: authUserId } }),
          tx.membership.count({ where: { userId: authUserId } }),
          tx.patient.count({ where: { userId: authUserId } }),
        ]);
        const safe = canSafelyDeleteAuthUser({
          emailConfirmedAt: a.emailConfirmedAt,
          lastSignInAt: a.lastSignInAt,
          hasProfile: hasProfile > 0,
          membershipCount,
          patientLinks,
        });
        if (!safe) {
          throw new PlatformUserError(
            "No se puede borrar: la cuenta se usó (confirmó el email o entró) o tiene perfil, membresías o fichas. Revisala en el directorio."
          );
        }
        await auditPlatformGlobalInTx(tx, {
          actor: refOf(actor),
          action: "platform.repair.auth_orphan_delete",
          entity: "AuthUser",
          entityId: authUserId,
          targetUserId: authUserId,
          payload: { authCreatedAt: a.createdAt },
        });
        const del = await authAdmin().deleteUser(authUserId);
        if (!del.ok && del.code !== "not_found") throw new AuthDeleteFailed(del.code);
      });
      revalidatePath("/plataforma", "layout");
      return { ok: true, data: { deleted: true as const } };
    });
  } catch (e) {
    if (e instanceof AuthDeleteFailed) {
      logger.warn("platform.repair.auth_orphan_delete_failed", { code: e.code });
      return { ok: false, error: "El servicio de acceso no pudo borrar la cuenta. Probá de nuevo en unos minutos." };
    }
    throw e;
  }
}

const EmailSyncInput = z.object({ userId: Id }).strict();

/**
 * El email del perfil quedó distinto del de Auth (se cambió desde el dashboard de Supabase). Auth es con lo que la
 * persona entra; el perfil es lo que ven el equipo y los mails. Se copia Auth → perfil, salvo que otro perfil ya
 * use ese email (`UserProfile.email` es único): eso lo decide una persona, no la reparación.
 */
export async function repairSyncProfileEmail(raw: unknown): Promise<ActionResult<{ changed: boolean }>> {
  const actor = await requirePlatformAdmin("repair.run");
  const parsed = EmailSyncInput.safeParse(raw);
  if (!parsed.success) return INVALID;
  const { userId } = parsed.data;

  const got = await authAdmin().getUser(userId);
  if (!got.ok) {
    if (got.code === "not_found") return { ok: false, error: "Esta persona no tiene cuenta en el servicio de acceso: no hay email con qué sincronizar." };
    return { ok: false, error: "No pudimos consultar la cuenta. Probá de nuevo en unos minutos." };
  }
  if (!got.data.email) return { ok: false, error: "La cuenta no tiene email: no hay con qué sincronizar." };
  const authEmail = normalizeEmail(got.data.email);
  const TAKEN = "Otro usuario ya usa ese email. Revisá los dos en el directorio antes de sincronizar.";

  try {
    const res = await failAsResult(async () => {
      const changed = await prismaService.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "UserProfile" WHERE "id" = ${userId} FOR UPDATE`;
        const profile = await tx.userProfile.findUnique({ where: { id: userId }, select: { email: true } });
        if (!profile) throw new PlatformUserError(NOT_FOUND);
        if (!emailsDiffer(profile.email, authEmail)) return false;
        const other = await tx.userProfile.findFirst({
          where: { email: emailEqualsFilter(authEmail), NOT: { id: userId } },
          select: { id: true },
        });
        if (other) throw new PlatformUserError(TAKEN);
        await tx.userProfile.update({ where: { id: userId }, data: { email: authEmail } });
        await auditPlatformGlobalInTx(tx, {
          actor: refOf(actor),
          action: "platform.repair.email_sync",
          entity: "UserProfile",
          entityId: userId,
          targetUserId: userId,
          payload: { changed: ["email"] },
        });
        return true;
      });
      return { ok: true, data: { changed } };
    });
    if (res.ok && res.data.changed) revalidatePath("/plataforma", "layout");
    return res;
  } catch (e) {
    // Carrera con otro alta que tomó el email entre el chequeo y el UPDATE.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { ok: false, error: TAKEN };
    throw e;
  }
}
