"use server";

/**
 * Invitaciones de equipo — las gestionan el OWNER y el ADMIN (IAM-D3).
 *
 * Flujo (IAM-2a, desde el hallazgo del 14-oct, §19.1 puntos 3 y 4):
 *   1. En Configuración → Usuarios se carga email + nombre + apellido + rol.
 *   2. `createInvitation` guarda la `Invitation` con el HASH de un token al azar
 *      (7 días) y manda el mail `staff_invite` con NUESTRO link
 *      `${APP_URL}/invite/<token>` por `sendEmail` (Resend en prod).
 *   3. El invitado abre `/invite/<token>`: crea su cuenta ahí (IAM-2b) o, si ya
 *      tiene, entra y acepta.
 *
 * Por qué ya no se usa Supabase acá: el mail salía con la invitación de Auth
 * de Supabase (flujo implícito con los tokens en `#`, que el server nunca ve;
 * GoTrue reemplazaba el `redirectTo` por la Site URL = localhost; plantilla
 * genérica sin marca; SMTP default que no entrega a externos) y además CREABA
 * el usuario de Auth en el momento de invitar: si después se revocaba o vencía,
 * quedaba una cuenta muerta con el email «tomado», y el `signUp` posterior del
 * invitado no mandaba nada (§19.1 punto 4). ADR del bloque IAM: la app manda
 * todos los mails; Supabase solo emite tokens, y una invitación de equipo ni
 * siquiera necesita token de Supabase: el token es nuestro.
 *
 * Reglas de tokens (C-IAM5):
 *   - «Reenviar» (`resendInvitation`, y re-invitar el mismo email): token nuevo,
 *     el hash anterior pasa a `priorTokens` y el link del mail anterior SIGUE
 *     valiendo. Antes rotaba y el primer link daba 404.
 *   - «Generar link nuevo» (`regenerateInvitationUrl`): token nuevo y
 *     `priorTokens = []`: anula todos los links anteriores (para cuando un link
 *     se compartió donde no debía).
 *   - «Anular» (`revokeInvitation`): `revokedAt` + `revokedById`; la fila queda
 *     como historia y el link deja de valer (`findInvitationByRawToken` la
 *     devuelve con status "revoked").
 * Cada envío deja `lastSentAt`/`sendCount` en la fila y una fila en `EmailLog`
 * (sink de `@/lib/email/log`), que es lo que la UI muestra como «estado».
 */
import { revalidatePath, revalidateTag } from "next/cache";
import type { Role } from "@prisma/client";
import { z } from "zod";
import { runWithRls } from "@/lib/rls";
import { getActor, ForbiddenError, writableError, type Actor } from "@/lib/session";
import { getMembershipRole } from "@/lib/authz";
import { withSupportWritable } from "@/lib/support-writable";
import { withReadOnlyResult } from "@/lib/read-only-result";
import { invitationStatus } from "@/lib/access-logic";
import { isClinicalMember } from "@/lib/roles";
import { tags } from "@/lib/cache-tags";
import {
  ROLE_CHANGE_RACE_MESSAGE,
  RoleChangeRaceError,
  changeMemberRoleInTx,
  reactivateMemberInTx,
  removeMemberInTx,
  revokeInvitationInTx,
  runTeamTx,
  suspendMemberInTx,
  teamCreateInvitation,
  teamReissueInvitation,
  teamSendMemberPasswordReset,
} from "@/lib/team-internal";
import type { ActionResult } from "@/lib/validation";
import type {
  InvitationEmailStatus,
  InvitationRow,
  InvitationSendResult,
  MemberPasswordResetResult,
  SuspendMemberResult,
  TeamActorCtx,
  TeamMemberRow,
} from "@/lib/invitations-types";
import type { EmailTransportName } from "@/lib/email/types";

/**
 * Quién gestiona el equipo: OWNER y ADMIN (IAM-D3, default de §19.10). Antes
 * era solo el OWNER y el ADMIN, que «configura el consultorio», no podía sumar
 * a la Secretaria. Límites del ADMIN (los aplica cada action): no toca la
 * membresía del OWNER, no asigna ni transfiere el OWNER y no recibe la URL de
 * la invitación (es una credencial: le alcanza con «Reenviar»).
 */
async function requireTeamManager(): Promise<{ actor: Actor; role: "OWNER" | "ADMIN" }> {
  const actor = await getActor();
  // BO2-E (decisión 3): soporte gestiona usuarios/equipo desde Configuración con los límites del ADMIN (no toca al
  // OWNER, no lo transfiere, no recibe la URL de la invitación). `getMembershipRole` le daría ASSISTANT (su nivel de
  // lectura clínica), que acá lo dejaría afuera. La escritura igual exige `withSupportWritable` en cada action.
  if (actor.support) return { actor, role: "ADMIN" as const };
  const role = await getMembershipRole(actor);
  if (role !== "OWNER" && role !== "ADMIN") {
    throw new ForbiddenError("Solo el dueño o un administrador del consultorio pueden gestionar el equipo.");
  }
  return { actor, role };
}

/** C-BO8: el contexto de los núcleos de `lib/team-internal.ts` para quien gestiona desde Configuración. */
function tenantCtx(actor: Actor, role: "OWNER" | "ADMIN"): TeamActorCtx {
  return {
    via: "tenant",
    tenantId: actor.tenantId,
    actorUserId: actor.userId,
    actorRole: role,
    actorRef: null,
    ...(actor.support ? { support: true } : {}),
  };
}

function fallbackTenant(actor: Actor) {
  return { name: actor.tenantName, vertical: actor.entitlements.vertical };
}

/**
 * Después de cambiar el equipo: la pantalla de Configuración y la lista de profesionales de la agenda (cacheada por
 * tag; A2b-S-cfg: sin esto un cambio de equipo tardaba hasta el TTL en verse).
 */
function revalidateTeam(tenantId: string, practitioners: boolean) {
  revalidatePath("/configuracion");
  if (practitioners) revalidateTag(tags.practitioners(tenantId));
}

export async function listTeamMembers(): Promise<TeamMemberRow[]> {
  const { actor } = await requireTeamManager();
  const { rows, logs } = await runWithRls(actor.tenantId, async (tx) => {
    const rows = await tx.membership.findMany({
      where: { tenantId: actor.tenantId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            fullName: true,
            // IAM-1 (M6): un usuario puede ser profesional en varios
            // consultorios; la especialidad es la de ESTE (tenantId a mano: en
            // prod la conexión es BYPASSRLS).
            practitioners: { where: { tenantId: actor.tenantId }, select: { specialty: true }, take: 1 },
          },
        },
      },
      orderBy: { invitedAt: "asc" },
    });
    // IAM-4c: último «link para nueva contraseña» por miembro (EmailLog, entity Membership), para que la UI diga
    // si salió sin que nadie abra Vercel. Más nuevo primero: el primero por membresía es el último intento.
    const logs = rows.length
      ? await tx.emailLog.findMany({
          where: {
            tenantId: actor.tenantId,
            entity: "Membership",
            kind: "admin_password_reset",
            entityId: { in: rows.map((r) => r.id) },
          },
          orderBy: { createdAt: "desc" },
          select: { entityId: true, status: true, transport: true, reason: true, createdAt: true },
        })
      : [];
    return { rows, logs };
  });
  const lastByMember = new Map<string, (typeof logs)[number]>();
  for (const l of logs) if (l.entityId && !lastByMember.has(l.entityId)) lastByMember.set(l.entityId, l);
  return rows.map((m) => {
    const l = lastByMember.get(m.id);
    return {
      membershipId: m.id,
      userId: m.userId,
      email: m.user.email,
      fullName: m.user.fullName,
      role: m.role,
      specialty: m.user.practitioners[0]?.specialty ?? null,
      joinedAt: m.acceptedAt,
      isYou: m.userId === actor.userId,
      disabledAt: m.disabledAt,
      hasAgenda: isClinicalMember(m) && m.user.practitioners.length > 0,
      clinical: isClinicalMember(m),
      grantSettings: m.grantSettings,
      grantBilling: m.grantBilling,
      disabledReason: m.disabledReason,
      lastPasswordResetEmail: l
        ? {
            status: l.status as InvitationEmailStatus,
            transport: l.transport as EmailTransportName,
            reason: l.reason,
            at: l.createdAt,
          }
        : null,
    };
  });
}

/**
 * Invitaciones sin aceptar ni anular (vigentes y vencidas: una vencida se
 * puede reenviar), con el estado de envío real: `lastSentAt`, `sendCount` y el
 * último intento de `EmailLog` (IAM-2a). Antes la lista solo decía «pendiente»
 * y el OWNER no tenía forma de saber si el mail había salido.
 */
export async function listPendingInvitations(): Promise<InvitationRow[]> {
  const { actor } = await requireTeamManager();
  const now = new Date();
  const { rows, logs } = await runWithRls(actor.tenantId, async (tx) => {
    const rows = await tx.invitation.findMany({
      where: { tenantId: actor.tenantId, acceptedAt: null, revokedAt: null },
      orderBy: { invitedAt: "desc" },
    });
    const logs = rows.length
      ? await tx.emailLog.findMany({
          where: { tenantId: actor.tenantId, entity: "Invitation", entityId: { in: rows.map((r) => r.id) } },
          orderBy: { createdAt: "desc" },
          select: { entityId: true, status: true, transport: true, reason: true, createdAt: true },
        })
      : [];
    return { rows, logs };
  });
  // Más nuevo primero: el primero que aparece por invitación es su último intento.
  const lastByInvitation = new Map<string, (typeof logs)[number]>();
  for (const l of logs) if (l.entityId && !lastByInvitation.has(l.entityId)) lastByInvitation.set(l.entityId, l);
  return rows.map((i) => {
    const l = lastByInvitation.get(i.id);
    return {
      id: i.id,
      email: i.email,
      firstName: i.firstName,
      lastName: i.lastName,
      role: i.role,
      specialty: i.specialty,
      invitedAt: i.invitedAt,
      expiresAt: i.expiresAt,
      acceptedAt: i.acceptedAt,
      // El token se guarda hasheado: la URL no se puede reconstruir. Para
      // volver a mandarla están «Reenviar» y «Generar link nuevo».
      url: null,
      status: invitationStatus(i, now),
      lastSentAt: i.lastSentAt,
      sendCount: i.sendCount,
      lastEmail: l
        ? {
            status: l.status as InvitationEmailStatus,
            transport: l.transport as EmailTransportName,
            reason: l.reason,
            at: l.createdAt,
          }
        : null,
    };
  });
}

const InviteInput = z.object({
  email: z.string().email("Email inválido").max(120),
  firstName: z.string().trim().min(1, "Nombre requerido").max(80),
  lastName: z.string().trim().min(1, "Apellido requerido").max(80),
  role: z.enum(["PRACTITIONER", "ADMIN", "ASSISTANT", "BILLING"]).default("PRACTITIONER"),
  specialty: z.string().trim().max(80).optional().or(z.literal("")),
  // «¿Atiende?»: lo fija el rol (§20.17; el Administrador/a nunca atiende). Ver `InviteCoreInput.clinical` en lib/team-internal.ts.
  clinical: z.boolean().optional(),
});

const IdInput = z.string().min(1).max(64);

const RoleInput = z.enum(["OWNER", "ADMIN", "PRACTITIONER", "ASSISTANT", "BILLING"]);

/*
 * BO2-B (C-BO8): de acá para abajo, wrappers delgados. Las reglas (quién puede qué, CAS, cupos, audit, mail)
 * viven en `lib/team-internal.ts` y las comparte /plataforma (`lib/platform-team.ts`). Acá queda la barrera
 * (`requireTeamManager`), el zod y la revalidación. API pública sin cambios.
 */

/**
 * Invitar (o re-invitar el mismo email: actualiza rol y datos y el link anterior sigue valiendo). PL-1c: toda
 * invitación pide un lugar libre del plan de su tipo (profesional o no clínico) y del total.
 */
export async function createInvitation(...args: Parameters<typeof createInvitationImpl>): ReturnType<typeof createInvitationImpl> {
  return withReadOnlyResult(() => withSupportWritable("lib/invitations.ts#createInvitation", () => createInvitationImpl(...args)));
}

async function createInvitationImpl(
  raw: z.input<typeof InviteInput>
): Promise<ActionResult<InvitationSendResult>> {
  const parsed = InviteInput.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Datos inválidos",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const { actor, role } = await requireTeamManager();
  const r = await teamCreateInvitation(
    tenantCtx(actor, role),
    {
      email: parsed.data.email,
      firstName: parsed.data.firstName,
      lastName: parsed.data.lastName,
      role: parsed.data.role as Role,
      specialty: parsed.data.specialty || null,
      clinical: parsed.data.clinical,
    },
    fallbackTenant(actor)
  );
  // Se revalida aunque el mail no salga: la fila ya está escrita. Si la tx no escribió (error), no hay nada que ver.
  if (r.ok) revalidateTeam(actor.tenantId, false);
  return r;
}

async function reissue(id: unknown, mode: "resend" | "regenerate"): Promise<ActionResult<InvitationSendResult>> {
  const { actor, role } = await requireTeamManager();
  const parsedId = IdInput.safeParse(id);
  if (!parsedId.success) return { ok: false, error: "Invitación no encontrada." };
  const r = await teamReissueInvitation(tenantCtx(actor, role), parsedId.data, mode, fallbackTenant(actor));
  if (r.ok) revalidateTeam(actor.tenantId, false);
  return r;
}

/** «Reenviar»: otro mail con un link nuevo; el link del mail anterior sigue valiendo. */
export async function resendInvitation(...args: Parameters<typeof resendInvitationImpl>): ReturnType<typeof resendInvitationImpl> {
  return withReadOnlyResult(() => withSupportWritable("lib/invitations.ts#resendInvitation", () => resendInvitationImpl(...args)));
}

async function resendInvitationImpl(id: string): Promise<ActionResult<InvitationSendResult>> {
  return reissue(id, "resend");
}

/** «Generar link nuevo»: anula todos los links anteriores y manda el nuevo. */
export async function regenerateInvitationUrl(...args: Parameters<typeof regenerateInvitationUrlImpl>): ReturnType<typeof regenerateInvitationUrlImpl> {
  return withReadOnlyResult(() => withSupportWritable("lib/invitations.ts#regenerateInvitationUrl", () => regenerateInvitationUrlImpl(...args)));
}

async function regenerateInvitationUrlImpl(id: string): Promise<ActionResult<InvitationSendResult>> {
  return reissue(id, "regenerate");
}

/** «Anular»: `revokedAt` + `revokedById`; la fila queda como historia y el link deja de valer. Idempotente. */
export async function revokeInvitation(...args: Parameters<typeof revokeInvitationImpl>): ReturnType<typeof revokeInvitationImpl> {
  return withReadOnlyResult(() => withSupportWritable("lib/invitations.ts#revokeInvitation", () => revokeInvitationImpl(...args)));
}

async function revokeInvitationImpl(id: string): Promise<ActionResult> {
  const { actor, role } = await requireTeamManager();
  const parsedId = IdInput.safeParse(id);
  if (!parsedId.success) return { ok: false, error: "Invitación no encontrada." };
  const ctx = tenantCtx(actor, role);
  const result = await runTeamTx(ctx, (tx) => revokeInvitationInTx(tx, ctx, parsedId.data));
  if (result === "not_found") return { ok: false, error: "Invitación no encontrada." };
  if (result === "accepted") return { ok: false, error: "Esa invitación ya fue aceptada." };
  revalidateTeam(actor.tenantId, false);
  return { ok: true, data: undefined };
}

/**
 * Cambio de rol (y transferir el OWNER, solo el OWNER). Reglas en `changeMemberRoleInTx`: crea el `Practitioner`
 * al pasar a un rol clínico, frena el paso a no clínico con turnos/pacientes/planes a cargo, pide lugar del plan
 * al pasar de no clínico a clínico.
 */
export async function changeMemberRole(...args: Parameters<typeof changeMemberRoleImpl>): ReturnType<typeof changeMemberRoleImpl> {
  return withReadOnlyResult(() => withSupportWritable("lib/invitations.ts#changeMemberRole", () => changeMemberRoleImpl(...args)));
}

async function changeMemberRoleImpl(
  membershipId: string,
  role: "OWNER" | "ADMIN" | "PRACTITIONER" | "ASSISTANT" | "BILLING"
): Promise<ActionResult> {
  const { actor, role: actorRole } = await requireTeamManager();
  const parsedId = IdInput.safeParse(membershipId);
  const parsedRole = RoleInput.safeParse(role);
  if (!parsedId.success) return { ok: false, error: "Miembro no encontrado." };
  if (!parsedRole.success) return { ok: false, error: "Rol inválido." };
  const ctx = tenantCtx(actor, actorRole);
  let r: ActionResult;
  try {
    r = await runTeamTx(ctx, (tx) => changeMemberRoleInTx(tx, ctx, { membershipId: parsedId.data, role: parsedRole.data }));
  } catch (err) {
    if (err instanceof RoleChangeRaceError) return { ok: false, error: ROLE_CHANGE_RACE_MESSAGE };
    throw err;
  }
  if (r.ok) revalidateTeam(actor.tenantId, true);
  return r;
}

/**
 * «Suspender acceso» (IAM-4c, IAM-D7: suspender ≠ quitar). No borra nada; anula las invitaciones pendientes a ese
 * email. Devuelve cuántos turnos futuros activos le quedan, para que la UI avise que NO se cancelan.
 */
export async function suspendMember(...args: Parameters<typeof suspendMemberImpl>): ReturnType<typeof suspendMemberImpl> {
  return withReadOnlyResult(() => withSupportWritable("lib/invitations.ts#suspendMember", () => suspendMemberImpl(...args)));
}

async function suspendMemberImpl(membershipId: string): Promise<ActionResult<SuspendMemberResult>> {
  const { actor, role } = await requireTeamManager();
  const parsedId = IdInput.safeParse(membershipId);
  if (!parsedId.success) return { ok: false, error: "Miembro no encontrado." };
  const ctx = tenantCtx(actor, role);
  const r = await runTeamTx(ctx, (tx) => suspendMemberInTx(tx, ctx, { membershipId: parsedId.data, now: new Date() }));
  if (!r.ok) return r;
  if (r.data.changed) revalidateTeam(actor.tenantId, true);
  return { ok: true, data: { futureBookings: r.data.futureBookings } };
}

/** «Reactivar» (IAM-4c): vuelve con el rol que tenía. PL-1c: pide un lugar libre del plan de su tipo. */
export async function reactivateMember(...args: Parameters<typeof reactivateMemberImpl>): ReturnType<typeof reactivateMemberImpl> {
  return withReadOnlyResult(() => withSupportWritable("lib/invitations.ts#reactivateMember", () => reactivateMemberImpl(...args)));
}

async function reactivateMemberImpl(membershipId: string): Promise<ActionResult> {
  const { actor, role } = await requireTeamManager();
  const parsedId = IdInput.safeParse(membershipId);
  if (!parsedId.success) return { ok: false, error: "Miembro no encontrado." };
  const ctx = tenantCtx(actor, role);
  const r = await runTeamTx(ctx, (tx) => reactivateMemberInTx(tx, ctx, { membershipId: parsedId.data }));
  if (!r.ok) return r;
  if (r.data.changed) revalidateTeam(actor.tenantId, true);
  return { ok: true, data: undefined };
}

/**
 * «Mandar link para nueva contraseña» (IAM-4c). Quien lo pide NUNCA ve el link: solo si el mail salió.
 */
export async function sendMemberPasswordReset(...args: Parameters<typeof sendMemberPasswordResetImpl>): ReturnType<typeof sendMemberPasswordResetImpl> {
  return withReadOnlyResult(() => withSupportWritable("lib/invitations.ts#sendMemberPasswordReset", () => sendMemberPasswordResetImpl(...args)));
}

async function sendMemberPasswordResetImpl(membershipId: string): Promise<ActionResult<MemberPasswordResetResult>> {
  const { actor, role } = await requireTeamManager();
  // BO-Z (C1): el link de recuperación y el mail salen ANTES de la única escritura (el audit). En solo lectura
  // (enforce) la persona recibía el mail y la tx del audit fallaba: una llave entregada sin rastro. Corte al inicio.
  const readOnly = writableError(actor);
  if (readOnly) return { ok: false, error: readOnly };
  const parsedId = IdInput.safeParse(membershipId);
  if (!parsedId.success) return { ok: false, error: "Miembro no encontrado." };
  const r = await teamSendMemberPasswordReset(tenantCtx(actor, role), parsedId.data, actor.tenantName);
  if (r.ok) revalidateTeam(actor.tenantId, false);
  return r;
}

/**
 * Quitar a alguien del equipo (A2b-S-cfg). Se rechaza, con conteo, mientras tenga turnos futuros, pacientes
 * asignados o planes ACTIVE a cargo (S13g): hay que reasignarlos primero.
 */
export async function removeMember(...args: Parameters<typeof removeMemberImpl>): ReturnType<typeof removeMemberImpl> {
  return withReadOnlyResult(() => withSupportWritable("lib/invitations.ts#removeMember", () => removeMemberImpl(...args)));
}

async function removeMemberImpl(membershipId: string): Promise<ActionResult> {
  const { actor, role } = await requireTeamManager();
  const parsedId = IdInput.safeParse(membershipId);
  if (!parsedId.success) return { ok: false, error: "Miembro no encontrado." };
  const ctx = tenantCtx(actor, role);
  const r = await runTeamTx(ctx, (tx) => removeMemberInTx(tx, ctx, { membershipId: parsedId.data }));
  if (r.ok) revalidateTeam(actor.tenantId, true);
  return r;
}
