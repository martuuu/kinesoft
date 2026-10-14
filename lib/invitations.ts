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
import { randomBytes } from "node:crypto";
import { Role } from "@prisma/client";
import { z } from "zod";
import { runWithRls, type DbClient } from "@/lib/rls";
import { capabilitiesFor } from "@/lib/capabilities";
import { liveProgramWhere } from "@/lib/plan-predicates";
import { getActor, ForbiddenError, type Actor } from "@/lib/session";
import { getMembershipRole } from "@/lib/authz";
import { audit, auditInTx } from "@/lib/audit";
import { env } from "@/lib/env";
import { hashInviteToken } from "@/lib/invitations-tokens";
import { INVITE_TTL_MS, appendPriorToken, reassignBeforeRoleChangeCopy } from "@/lib/invitations-constants";
import { emailEqualsFilter, normalizeEmail } from "@/lib/email-match";
import { invitationStatus } from "@/lib/access-logic";
import { isClinicalRole, roleLabel } from "@/lib/roles";
import { provisionPractitionerAgenda } from "@/lib/agenda-defaults";
import { issueAccessLink } from "@/lib/identity/access-link";
import { logger } from "@/lib/logger";
import { sendEmail } from "@/lib/email";
// Registra el sink de EmailLog (handoff de IAM-1): sin este import el envío no
// deja fila y la UI no puede mostrar si el mail salió.
import "@/lib/email/log";
import { adminPasswordResetEmail, staffInviteEmail } from "@/lib/email/templates";
import { tags } from "@/lib/cache-tags";
import { hashKeyPart, rateLimitAll, rateLimitedMessage } from "@/lib/rate-limit";
import type { ActionResult } from "@/lib/validation";
import type {
  InvitationEmailStatus,
  InvitationRow,
  InvitationSendResult,
  MemberPasswordResetResult,
  SuspendMemberResult,
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
  const role = await getMembershipRole(actor);
  if (role !== "OWNER" && role !== "ADMIN") {
    throw new ForbiddenError("Solo el dueño o un administrador del consultorio pueden gestionar el equipo.");
  }
  return { actor, role };
}

/**
 * S13g (I7): planes ACTIVE vivos de los que el usuario es responsable
 * (`TreatmentProgram.practitionerId`, D17) en este consultorio.
 *
 * `practitionerId` es RESTRICT desde M1, pero ni quitar a alguien (borra la
 * Membership; el Practitioner queda por historial) ni cambiarle el rol tocan
 * esa fila, así que la FK no frena nada: el plan quedaba a cargo de alguien
 * que ya no entra o que ya no puede gestionarlo. Solo ACTIVE: un plan cerrado
 * conserva su responsable como historia. `practitioner.userId` + `tenantId`
 * a mano: el Practitioner es por tenant y en prod (BYPASSRLS) el filtro
 * explícito es la única barrera.
 */
function countActivePlansAsResponsible(tx: DbClient, tenantId: string, userId: string) {
  return tx.treatmentProgram.count({
    where: {
      tenantId,
      practitioner: { userId, tenantId },
      ...liveProgramWhere,
      status: "ACTIVE",
    },
  });
}

function activePlansCopy(n: number) {
  return `es responsable de ${n} plan${n === 1 ? "" : "es"} activo${n === 1 ? "" : "s"}`;
}

function inviteUrl(token: string) {
  return `${env.NEXT_PUBLIC_APP_URL}/invite/${token}`;
}

function newRawToken() {
  return randomBytes(24).toString("base64url");
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
      hasAgenda: isClinicalRole(m.role) && m.user.practitioners.length > 0,
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
});

const IdInput = z.string().min(1).max(64);

export async function createInvitation(
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
  const { actor, role: actorRole } = await requireTeamManager();
  const emailLc = parsed.data.email.toLowerCase();

  const rl = await inviteRateLimit(actor.userId, emailLc);
  if (!rl.ok) return { ok: false, error: rateLimitedMessage(rl.retryAfterMs) };

  // Refuse if a user with this email is already a member of the tenant.
  const existing = await runWithRls(actor.tenantId, (tx) => tx.membership.findFirst({
    where: { tenantId: actor.tenantId, user: { email: emailLc } },
    select: { id: true, disabledAt: true },
  }));
  if (existing) {
    // IAM-4c: a un suspendido no se lo re-invita (cambiaría el rol por la puerta de atrás): se lo reactiva.
    return {
      ok: false,
      error: existing.disabledAt
        ? "Ese email es de un miembro suspendido. Usá «Reactivar» en la lista del equipo."
        : "Ese email ya es miembro del consultorio.",
    };
  }

  // Staff ≠ paciente (A3b-S-auth): no se invita al equipo un email que en
  // ESTE consultorio es un paciente con acceso al portal. Solo se mira el
  // propio tenant (canal RLS): mirar "cualquier tenant" acá le daría a
  // cualquier OWNER un oráculo de "¿este email es paciente en algún lado?".
  // El chequeo entre tenants lo hace `acceptInvite`, donde quien pregunta es
  // el dueño de la identidad.
  const portalPatient = await runWithRls(actor.tenantId, (tx) => tx.patient.findFirst({
    where: {
      tenantId: actor.tenantId,
      // IAM-0a: escapado. Pelado en el ILIKE, invitar a `ana_@x.com` se
      // rechazaba por la ficha con portal de `anax@x.com`.
      email: emailEqualsFilter(emailLc),
      userId: { not: null },
    },
    select: { id: true },
  }));
  if (portalPatient) {
    return {
      ok: false,
      error: "Ese email es de un paciente con acceso al portal. Para el equipo usá otro email.",
    };
  }

  const next = {
    firstName: parsed.data.firstName,
    lastName: parsed.data.lastName,
    role: parsed.data.role as Role,
    specialty: parsed.data.specialty || null,
  };
  const rawToken = newRawToken();
  const now = new Date();

  // Invitación viva para el mismo email (sin aceptar, sin anular, sin vencer):
  // se reusa la fila como un «Reenviar» con los datos nuevos.
  //
  // A3b-S-auth: re-invitar ACTUALIZA rol y datos. Antes se ignoraba lo que
  // el OWNER cargó la segunda vez: invitaba como PRACTITIONER, se daba
  // cuenta, re-invitaba como ADMIN… y el invitado entraba como PRACTITIONER.
  // IAM-2a: y el link del primer mail sigue valiendo (antes rotaba → 404).
  const written = await runWithRls(actor.tenantId, async (tx) => {
    const live = await tx.invitation.findFirst({
      where: {
        tenantId: actor.tenantId,
        email: emailLc,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
    });
    if (live) {
      // CAS sobre el token vigente: dos reenvíos simultáneos no pueden perder
      // un hash de `priorTokens` (el link de uno de los dos mails daría 404).
      const upd = await tx.invitation.updateMany({
        where: { id: live.id, tenantId: actor.tenantId, token: live.token, acceptedAt: null, revokedAt: null },
        data: {
          ...next,
          token: hashInviteToken(rawToken),
          priorTokens: appendPriorToken(live.priorTokens, live.token),
          expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
          lastSentAt: now,
          sendCount: { increment: 1 },
        },
      });
      if (upd.count !== 1) return null;
      const changed: Record<string, { from: unknown; to: unknown }> = {};
      for (const k of ["firstName", "lastName", "role", "specialty"] as const) {
        if (live[k] !== next[k]) changed[k] = { from: live[k], to: next[k] };
      }
      await auditInTx(tx, {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "invitation.reinvite",
        entity: "Invitation",
        entityId: live.id,
        payload: { email: emailLc, changed },
      });
      return { id: live.id, email: live.email, role: next.role, expiresAt: new Date(now.getTime() + INVITE_TTL_MS) };
    }
    const row = await tx.invitation.create({
      data: {
        tenantId: actor.tenantId,
        email: emailLc,
        ...next,
        token: hashInviteToken(rawToken),
        invitedById: actor.userId,
        expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
        lastSentAt: now,
        sendCount: 1,
      },
      select: { id: true, email: true, role: true, expiresAt: true },
    });
    await auditInTx(tx, {
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: "invitation.create",
      entity: "Invitation",
      entityId: row.id,
      payload: { email: emailLc, role: parsed.data.role },
    });
    return row;
  });
  if (!written) return { ok: false, error: "La invitación cambió mientras la reenviabas. Probá de nuevo." };

  revalidatePath("/configuracion");
  // El mail sale DESPUÉS del commit: si saliera antes y la tx se revirtiera, el
  // invitado tendría un link que nunca existió.
  const mail = await sendInvitationEmail(actor, { ...written, rawToken });
  return { ok: true, data: sendResult(written.id, rawToken, actorRole, mail) };
}

/**
 * A3a-S-rl: crear, reenviar y generar link nuevo mandan un mail por llamada y
 * no tenían límite — quien gestiona el equipo (o una sesión robada) podía usar
 * el consultorio como cañón de spam y quemar la cuota de envío. 10/h por actor
 * + 1 cada 10 min por destinatario (hash del email: nunca en claro en la
 * clave). Comparten el bucket del destinatario, así "crear + reenviar"
 * seguidos también cuenta.
 */
async function inviteRateLimit(actorId: string, email: string) {
  return rateLimitAll([
    { key: `invite:actor:${actorId}`, limit: 10, windowMs: 3_600_000 },
    { key: `invite:to:${hashKeyPart(email)}`, limit: 1, windowMs: 600_000 },
  ]);
}

type MailOutcome = { emailSent: boolean; transport: EmailTransportName; emailStatus: InvitationEmailStatus; emailReason: string | null };

/**
 * Manda el mail `staff_invite` por `sendEmail` (que nunca tira y registra en
 * EmailLog). Remitente «<Consultorio> vía KineSoft», Reply-To = el email
 * público del consultorio si lo cargó (el invitado responde al consultorio, no
 * a no-reply). Ni el token ni la URL se loguean acá: `sendEmail` solo guarda
 * el host del link.
 */
async function sendInvitationEmail(
  actor: Actor,
  inv: { id: string; email: string; role: Role; expiresAt: Date; rawToken: string }
): Promise<MailOutcome> {
  const ctx = await runWithRls(actor.tenantId, async (tx) => {
    const [tenant, inviter] = await Promise.all([
      tx.tenant.findUnique({ where: { id: actor.tenantId }, select: { name: true, publicEmail: true } }),
      tx.userProfile.findUnique({ where: { id: actor.userId }, select: { fullName: true } }),
    ]);
    return { tenant, inviter };
  });
  const tenantName = ctx.tenant?.name ?? actor.tenantName;
  const rendered = staffInviteEmail({
    tenantName,
    inviterName: ctx.inviter?.fullName?.trim() || null,
    roleLabel: roleLabel(inv.role, actor.entitlements.vertical),
    url: inviteUrl(inv.rawToken),
    expiresAt: inv.expiresAt,
  });
  const r = await sendEmail({
    ...rendered,
    kind: "staff_invite",
    to: inv.email,
    tenantId: actor.tenantId,
    entity: "Invitation",
    entityId: inv.id,
    fromName: tenantName,
    replyTo: ctx.tenant?.publicEmail || null,
    actorId: actor.userId,
  });
  if (r.ok) return { emailSent: true, transport: r.transport, emailStatus: "sent", emailReason: null };
  return {
    emailSent: false,
    transport: r.transport,
    emailStatus: r.transport === "blocked" ? "blocked" : r.skipped ? "skipped" : "failed",
    emailReason: r.reason,
  };
}

function sendResult(id: string, rawToken: string, actorRole: "OWNER" | "ADMIN", mail: MailOutcome): InvitationSendResult {
  return { id, url: actorRole === "OWNER" ? inviteUrl(rawToken) : null, ...mail };
}

/**
 * «Reenviar» y «Generar link nuevo»: token nuevo + TTL extendido + otro mail.
 * Lo único que cambia es qué pasa con los links anteriores (ver cabecera):
 *  - resend:     el vigente pasa a `priorTokens` (siguen valiendo).
 *  - regenerate: `priorTokens = []` (se anulan todos).
 * Sirve también para una invitación vencida (sin aceptar ni anular): reenviarla
 * la vuelve a abrir por 7 días.
 */
async function reissue(id: unknown, mode: "resend" | "regenerate"): Promise<ActionResult<InvitationSendResult>> {
  const { actor, role: actorRole } = await requireTeamManager();
  const parsedId = IdInput.safeParse(id);
  if (!parsedId.success) return { ok: false, error: "Invitación no encontrada." };
  const row = await runWithRls(actor.tenantId, (tx) => tx.invitation.findFirst({
    where: { id: parsedId.data, tenantId: actor.tenantId, acceptedAt: null, revokedAt: null },
    select: { id: true, email: true, role: true, token: true, priorTokens: true },
  }));
  if (!row) return { ok: false, error: "Invitación no encontrada, ya aceptada o anulada." };
  const rl = await inviteRateLimit(actor.userId, row.email);
  if (!rl.ok) return { ok: false, error: rateLimitedMessage(rl.retryAfterMs) };

  const rawToken = newRawToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
  const ok = await runWithRls(actor.tenantId, async (tx) => {
    // CAS sobre el token leído y el estado: si en el medio se aceptó, se anuló
    // u otro reenvío ganó, no se pisa nada.
    const upd = await tx.invitation.updateMany({
      where: { id: row.id, tenantId: actor.tenantId, token: row.token, acceptedAt: null, revokedAt: null },
      data: {
        token: hashInviteToken(rawToken),
        priorTokens: mode === "resend" ? appendPriorToken(row.priorTokens, row.token) : [],
        expiresAt,
        lastSentAt: now,
        sendCount: { increment: 1 },
      },
    });
    if (upd.count !== 1) return false;
    // `regenerate` no auditaba: «quién anuló los links y cuándo» es justo lo
    // que se busca después de un link filtrado.
    await auditInTx(tx, {
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: mode === "resend" ? "invitation.resend" : "invitation.regenerate",
      entity: "Invitation",
      entityId: row.id,
      payload: mode === "regenerate" ? { revokedPriorLinks: row.priorTokens.length + 1 } : {},
    });
    return true;
  });
  if (!ok) return { ok: false, error: "La invitación cambió mientras tanto. Recargá y probá de nuevo." };
  revalidatePath("/configuracion");
  const mail = await sendInvitationEmail(actor, { id: row.id, email: row.email, role: row.role, expiresAt, rawToken });
  return { ok: true, data: sendResult(row.id, rawToken, actorRole, mail) };
}

/** «Reenviar»: otro mail con un link nuevo; el link del mail anterior sigue valiendo. */
export async function resendInvitation(id: string): Promise<ActionResult<InvitationSendResult>> {
  return reissue(id, "resend");
}

/** «Generar link nuevo»: anula todos los links anteriores y manda el nuevo. */
export async function regenerateInvitationUrl(id: string): Promise<ActionResult<InvitationSendResult>> {
  return reissue(id, "regenerate");
}

/**
 * «Anular»: marca `revokedAt`/`revokedById` y NO borra la fila (antes se
 * borraba: se perdía la historia y el EmailLog quedaba apuntando a nada). El
 * link deja de valer porque `findInvitationByRawToken` la devuelve "revoked".
 * Re-invitar el mismo email después crea una invitación nueva.
 */
export async function revokeInvitation(id: string): Promise<ActionResult> {
  const { actor } = await requireTeamManager();
  const parsedId = IdInput.safeParse(id);
  if (!parsedId.success) return { ok: false, error: "Invitación no encontrada." };
  const result = await runWithRls(actor.tenantId, async (tx) => {
    const row = await tx.invitation.findFirst({
      where: { id: parsedId.data, tenantId: actor.tenantId },
      select: { id: true, acceptedAt: true, revokedAt: true },
    });
    if (!row) return "not_found" as const;
    if (row.acceptedAt) return "accepted" as const;
    if (row.revokedAt) return "ok" as const; // idempotente
    const upd = await tx.invitation.updateMany({
      where: { id: row.id, tenantId: actor.tenantId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date(), revokedById: actor.userId },
    });
    if (upd.count !== 1) return "accepted" as const;
    await auditInTx(tx, {
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: "invitation.revoke",
      entity: "Invitation",
      entityId: row.id,
    });
    return "ok" as const;
  });
  if (result === "not_found") return { ok: false, error: "Invitación no encontrada." };
  if (result === "accepted") return { ok: false, error: "Esa invitación ya fue aceptada." };
  revalidatePath("/configuracion");
  return { ok: true, data: undefined };
}

/** Otro cambio de rol ganó entre la lectura y el update (CAS sobre el rol leído). */
class RoleChangeRaceError extends Error {
  constructor() {
    super("role_change_race");
    this.name = "RoleChangeRaceError";
  }
}

const RoleInput = z.enum(["OWNER", "ADMIN", "PRACTITIONER", "ASSISTANT", "BILLING"]);

/**
 * Turnos futuros activos y pacientes asignados (sin archivar) del profesional en este consultorio: lo que queda
 * colgado si deja de atender (quitar, pasar a un rol no clínico). `tenantId` a mano en cada conteo.
 */
async function countPractitionerLoad(tx: DbClient, tenantId: string, practitionerId: string) {
  const [futureBookings, assignedPatients] = await Promise.all([
    tx.booking.count({
      where: {
        tenantId,
        practitionerId,
        scheduledFor: { gte: new Date() },
        status: { in: ["PENDING", "CONFIRMED"] },
      },
    }),
    tx.patient.count({ where: { tenantId, assignedPractitionerId: practitionerId, archivedAt: null } }),
  ]);
  return { futureBookings, assignedPatients };
}

/**
 * IAM-4c: un rol clínico necesita su `Practitioner` en ESTE consultorio (sin él la membresía no es usable:
 * `missing_practitioner`, `lib/access-logic.ts`). Desde IAM-4a la Secretaria y Facturación entran sin profesional,
 * así que ascenderlas (o reactivar a alguien así) sin crearlo las dejaba afuera. Upsert por la clave compuesta de
 * M6 (no pisa la especialidad de una fila vieja) y agenda por defecto SOLO si no tenía ninguna franja: una fila
 * vieja con agenda cargada no se toca (`provisionPractitionerAgenda` igual es idempotente). Corre en la tx del
 * caller, con `runWithRls` (todas las filas llevan el `tenantId` del actor).
 */
async function ensureClinicalPractitionerInTx(tx: DbClient, tenantId: string, userId: string) {
  const prac = await tx.practitioner.upsert({
    where: { tenantId_userId: { tenantId, userId } },
    create: { userId, tenantId, specialty: null },
    update: {},
    select: { id: true },
  });
  const hasSchedule = await tx.practitionerSchedule.findFirst({
    where: { tenantId, practitionerId: prac.id },
    select: { id: true },
  });
  if (!hasSchedule) await provisionPractitionerAgenda(tx, { tenantId, practitionerId: prac.id });
  return { practitionerId: prac.id, provisioned: !hasSchedule };
}

/**
 * Cambio de rol. IAM-4c: el rol decide si la persona ATIENDE (tiene `Practitioner` y agenda) o no:
 *  - a un rol clínico (OWNER, ADMIN, PRACTITIONER): en la misma tx se crea el `Practitioner` si falta y su agenda
 *    por defecto si no tenía (antes solo cambiaba `Membership.role`, y una Secretaria ascendida quedaba sin acceso);
 *  - a un rol no clínico (ASSISTANT, BILLING): se FRENA si tiene turnos futuros o pacientes asignados, como
 *    `removeMember` (dejarían de verse en la agenda por profesional / quedarían a cargo de nadie). Si no tiene
 *    nada, la fila `Practitioner` queda: no es reservable (`bookablePractitionerWhere` mira el rol) y el actor no
 *    clínico tiene `practitionerId` null, así que es inofensiva y guarda la historia.
 * Conteos, update y audit van en UNA tx (antes: conteo de planes en una, update en otra, audit fuera).
 */
export async function changeMemberRole(
  membershipId: string,
  role: "OWNER" | "ADMIN" | "PRACTITIONER" | "ASSISTANT" | "BILLING"
): Promise<ActionResult> {
  const { actor, role: actorRole } = await requireTeamManager();
  const parsedId = IdInput.safeParse(membershipId);
  const parsedRole = RoleInput.safeParse(role);
  if (!parsedId.success) return { ok: false, error: "Miembro no encontrado." };
  if (!parsedRole.success) return { ok: false, error: "Rol inválido." };
  const nextRole: Role = parsedRole.data;
  const m = await runWithRls(actor.tenantId, (tx) => tx.membership.findFirst({
    where: { id: parsedId.data, tenantId: actor.tenantId },
    select: { id: true, userId: true, role: true, acceptedAt: true, disabledAt: true },
  }));
  if (!m) return { ok: false, error: "Miembro no encontrado." };
  // IAM-D3: el ADMIN gestiona el equipo, pero el OWNER es intocable para él
  // (si no, un ADMIN se degradaba al dueño o se quedaba con el consultorio).
  if (actorRole !== "OWNER" && (m.role === "OWNER" || nextRole === "OWNER")) {
    return { ok: false, error: "Solo el dueño puede cambiar o transferir el rol de dueño." };
  }
  if (m.userId === actor.userId && nextRole !== m.role) {
    return {
      ok: false,
      error: actorRole === "OWNER" ? "No podés cambiar tu propio rol de dueño." : "No podés cambiar tu propio rol.",
    };
  }
  if (m.role === nextRole) return { ok: true, data: undefined };
  const transfer = nextRole === "OWNER" && m.userId !== actor.userId;
  if (transfer) {
    // El OWNER no se transfiere a una membresía que nunca se aceptó ni a una
    // suspendida: el consultorio quedaría sin nadie que pueda entrar como dueño.
    if (!m.acceptedAt) {
      return { ok: false, error: "Solo podés transferir el OWNER a alguien que ya aceptó la invitación." };
    }
    if (m.disabledAt) {
      return { ok: false, error: "No podés transferir la titularidad a alguien suspendido. Reactivalo primero." };
    }
  }

  let outcome: { blocked: string | null };
  try {
    outcome = await runWithRls(actor.tenantId, async (tx) => {
      let practitionerCreated = false;
      if (isClinicalRole(nextRole)) {
        practitionerCreated = (await ensureClinicalPractitionerInTx(tx, actor.tenantId, m.userId)).provisioned;
      } else {
        const prac = await tx.practitioner.findFirst({
          where: { tenantId: actor.tenantId, userId: m.userId },
          select: { id: true },
        });
        if (prac) {
          const load = await countPractitionerLoad(tx, actor.tenantId, prac.id);
          const copy = reassignBeforeRoleChangeCopy(load.futureBookings, load.assignedPatients);
          if (copy) return { blocked: copy };
        }
      }
      // S13g: el responsable de un plan tiene que poder gestionarlo
      // (`plans.manage`); ASSISTANT y BILLING no. Pasar a alguien a esos roles
      // con planes ACTIVE a cargo dejaba planes que nadie del lado clínico "posee".
      if (!capabilitiesFor(nextRole).has("plans.manage")) {
        const activePlans = await countActivePlansAsResponsible(tx, actor.tenantId, m.userId);
        if (activePlans > 0) {
          return {
            blocked: `No se puede cambiar el rol: ${activePlansCopy(activePlans)}. Cambiá el responsable de esos planes primero.`,
          };
        }
      }
      // CAS sobre el rol leído: si otro cambio ganó en el medio, no se pisa.
      const upd = await tx.membership.updateMany({
        where: { id: m.id, tenantId: actor.tenantId, role: m.role },
        data: { role: nextRole },
      });
      // Tirar (no devolver) revierte el Practitioner/agenda que se haya creado arriba en esta misma tx.
      if (upd.count !== 1) throw new RoleChangeRaceError();
      if (transfer) {
        // Transferir el OWNER: quien transfiere queda como ADMIN.
        await tx.membership.updateMany({
          where: { tenantId: actor.tenantId, userId: actor.userId },
          data: { role: "ADMIN" },
        });
      }
      await auditInTx(tx, {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "membership.role.change",
        entity: "Membership",
        entityId: m.id,
        payload: { from: m.role, role: nextRole, ...(practitionerCreated ? { agendaProvisioned: true } : {}) },
      });
      return { blocked: null };
    });
  } catch (err) {
    if (err instanceof RoleChangeRaceError) {
      return { ok: false, error: "El rol cambió mientras tanto. Recargá y probá de nuevo." };
    }
    throw err;
  }
  if (outcome.blocked) return { ok: false, error: outcome.blocked };

  revalidatePath("/configuracion");
  // A2b-S-cfg: la lista de profesionales de la agenda está cacheada por tag;
  // sin esto un cambio de equipo tardaba hasta el TTL en verse.
  revalidateTag(tags.practitioners(actor.tenantId));
  return { ok: true, data: undefined };
}

/** Membresía del consultorio del actor, con lo que necesitan suspender / reactivar / mandar link. */
function findMemberForAdmin(tenantId: string, membershipId: string) {
  return runWithRls(tenantId, (tx) => tx.membership.findFirst({
    where: { id: membershipId, tenantId },
    select: {
      id: true,
      userId: true,
      role: true,
      acceptedAt: true,
      disabledAt: true,
      user: { select: { email: true } },
    },
  }));
}

/**
 * «Suspender acceso» (IAM-4c, IAM-D7: suspender ≠ quitar). Marca `Membership.disabledAt`/`disabledById` y no borra
 * nada: la persona no entra a ESTE consultorio (`isUsableMembership`: cae a otro consultorio usable o a
 * `/sin-acceso`) y no es reservable (`bookablePractitionerWhere` con `includeDisabledFilter`, IAM-2e), pero sus
 * turnos, pacientes y planes quedan como están y «Reactivar» le devuelve todo. Para irse del todo está «Quitar».
 *
 * Reglas: nadie se suspende a sí mismo (te quedarías afuera sin vuelta) y nadie suspende al dueño (el consultorio
 * quedaría sin quien lo gestione; el ADMIN tampoco puede tocarlo, IAM-D3). Antes no existía la suspensión: la única
 * forma de cortar el acceso era quitar, que exige reasignar todo primero.
 *
 * Además anula las invitaciones pendientes a ese email en este consultorio: aceptar una invitación reactiva la
 * membresía (`joinTenantInTx`), así que una vieja que quedara viva sería una puerta de vuelta sin que nadie la abra.
 * Devuelve cuántos turnos futuros activos le quedan, para que la UI avise que NO se cancelan.
 */
export async function suspendMember(membershipId: string): Promise<ActionResult<SuspendMemberResult>> {
  const { actor } = await requireTeamManager();
  const parsedId = IdInput.safeParse(membershipId);
  if (!parsedId.success) return { ok: false, error: "Miembro no encontrado." };
  const m = await findMemberForAdmin(actor.tenantId, parsedId.data);
  if (!m) return { ok: false, error: "Miembro no encontrado." };
  if (m.userId === actor.userId) return { ok: false, error: "No podés suspenderte a vos mismo." };
  if (m.role === "OWNER") return { ok: false, error: "No se puede suspender al dueño del consultorio." };

  const now = new Date();
  const result = await runWithRls(actor.tenantId, async (tx) => {
    const upd = await tx.membership.updateMany({
      where: { id: m.id, tenantId: actor.tenantId, disabledAt: null, role: { not: "OWNER" } },
      data: { disabledAt: now, disabledById: actor.userId },
    });
    const prac = await tx.practitioner.findFirst({
      where: { tenantId: actor.tenantId, userId: m.userId },
      select: { id: true },
    });
    const futureBookings = prac ? (await countPractitionerLoad(tx, actor.tenantId, prac.id)).futureBookings : 0;
    if (upd.count !== 1) return { changed: false, futureBookings }; // ya estaba suspendido: idempotente
    const revoked = await tx.invitation.updateMany({
      where: { tenantId: actor.tenantId, email: normalizeEmail(m.user.email), acceptedAt: null, revokedAt: null },
      data: { revokedAt: now, revokedById: actor.userId },
    });
    await auditInTx(tx, {
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: "membership.suspend",
      entity: "Membership",
      entityId: m.id,
      payload: { userId: m.userId, role: m.role, futureBookings, revokedInvitations: revoked.count },
    });
    return { changed: true, futureBookings };
  });
  if (result.changed) {
    revalidatePath("/configuracion");
    revalidateTag(tags.practitioners(actor.tenantId));
  }
  return { ok: true, data: { futureBookings: result.futureBookings } };
}

/**
 * «Reactivar» (IAM-4c): limpia `disabledAt`/`disabledById` y la persona vuelve a entrar con el rol que tenía. Si
 * es un rol clínico sin `Practitioner` (membresía rota de antes) se le crea en la misma tx: reactivar tiene que
 * devolver el acceso, no dejarla en `missing_practitioner`.
 */
export async function reactivateMember(membershipId: string): Promise<ActionResult> {
  const { actor, role: actorRole } = await requireTeamManager();
  const parsedId = IdInput.safeParse(membershipId);
  if (!parsedId.success) return { ok: false, error: "Miembro no encontrado." };
  const m = await findMemberForAdmin(actor.tenantId, parsedId.data);
  if (!m) return { ok: false, error: "Miembro no encontrado." };
  if (m.role === "OWNER" && actorRole !== "OWNER") {
    return { ok: false, error: "Solo el dueño puede tocar la membresía del dueño." };
  }
  if (!m.disabledAt) return { ok: true, data: undefined }; // idempotente

  await runWithRls(actor.tenantId, async (tx) => {
    const upd = await tx.membership.updateMany({
      where: { id: m.id, tenantId: actor.tenantId, disabledAt: { not: null } },
      data: { disabledAt: null, disabledById: null },
    });
    if (upd.count !== 1) return;
    if (isClinicalRole(m.role)) await ensureClinicalPractitionerInTx(tx, actor.tenantId, m.userId);
    await auditInTx(tx, {
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: "membership.reactivate",
      entity: "Membership",
      entityId: m.id,
      payload: { userId: m.userId, role: m.role, suspendedAt: m.disabledAt!.toISOString() },
    });
  });
  revalidatePath("/configuracion");
  revalidateTag(tags.practitioners(actor.tenantId));
  return { ok: true, data: undefined };
}

/**
 * Límite de «Mandar link para nueva contraseña»: cada pedido es un mail con una llave de la cuenta. 10/h por actor
 * (quien gestiona el equipo, o una sesión robada, no usa el consultorio como cañón de mails) + 1 cada 10 min por
 * destinatario (hash del email, nunca en claro): con un link vivo alcanza, y el de recovery de GoTrue además
 * invalida el anterior.
 */
async function memberResetRateLimit(actorId: string, email: string) {
  return rateLimitAll([
    { key: `member-reset:actor:${actorId}`, limit: 10, windowMs: 3_600_000 },
    { key: `member-reset:to:${hashKeyPart(email)}`, limit: 1, windowMs: 600_000 },
  ]);
}

/**
 * «Mandar link para nueva contraseña» (IAM-4c). Para el miembro que no puede entrar (se olvidó la clave, nunca la
 * eligió): `issueAccessLink({ kind: "recovery", next: "/reset" })` (C-IAM3: Supabase solo emite el token) + mail
 * `adminPasswordResetEmail` con el nombre del consultorio, por `sendEmail` (EmailLog con entity Membership).
 *
 * Quien lo pide NUNCA ve el link: ni en el resultado (`{ emailSent, transport, emailStatus, emailReason }`), ni en
 * el audit, ni en los logs (`issueAccessLink` y `sendEmail` solo registran el host). Es un clic que entra a la
 * cuenta de otra persona y le cambia la clave: con verlo, el OWNER o el ADMIN podrían tomar esa cuenta (que puede
 * ser miembro de otros consultorios). A diferencia de la invitación, acá no hay «copiar link».
 *
 * No se manda: al dueño si lo pide un ADMIN (IAM-D3), a un suspendido (primero se reactiva: si no, el link le
 * devuelve una sesión a alguien que no debería entrar), ni si el usuario de Auth que resuelve GoTrue no es el de
 * la membresía (email cambiado / desincronizado: se corta antes de mandar una llave a otra cuenta).
 */
export async function sendMemberPasswordReset(membershipId: string): Promise<ActionResult<MemberPasswordResetResult>> {
  const { actor, role: actorRole } = await requireTeamManager();
  const parsedId = IdInput.safeParse(membershipId);
  if (!parsedId.success) return { ok: false, error: "Miembro no encontrado." };
  const m = await findMemberForAdmin(actor.tenantId, parsedId.data);
  if (!m) return { ok: false, error: "Miembro no encontrado." };
  if (m.role === "OWNER" && actorRole !== "OWNER") {
    return { ok: false, error: "Solo el dueño puede pedir un link de contraseña para el dueño." };
  }
  if (m.disabledAt) {
    return { ok: false, error: "Está suspendido: reactivalo antes de mandarle un link para entrar." };
  }
  const email = normalizeEmail(m.user.email);
  const rl = await memberResetRateLimit(actor.userId, email);
  if (!rl.ok) return { ok: false, error: rateLimitedMessage(rl.retryAfterMs) };

  const link = await issueAccessLink({ email, kind: "recovery", next: "/reset" });
  if (!link.ok) {
    if (link.code === "not_found") {
      return { ok: false, error: "Esa persona todavía no tiene cuenta para ingresar. Si tiene una invitación pendiente, reenviásela." };
    }
    if (link.code === "rate_limited") {
      return { ok: false, error: "El servicio de acceso está limitando los pedidos. Probá de nuevo en unos minutos." };
    }
    return { ok: false, error: "No pudimos generar el link. Probá de nuevo en unos minutos." };
  }
  if (link.userId && link.userId !== m.userId) {
    logger.warn("membership.password_reset.user_mismatch", { tenantId: actor.tenantId, membershipId: m.id });
    return { ok: false, error: "No pudimos generar el link para esta cuenta. Avisale a soporte." };
  }

  const tenant = await runWithRls(actor.tenantId, (tx) =>
    tx.tenant.findUnique({ where: { id: actor.tenantId }, select: { name: true, publicEmail: true } })
  );
  const tenantName = tenant?.name ?? actor.tenantName;
  const r = await sendEmail({
    ...adminPasswordResetEmail({ tenantName, url: link.url }),
    kind: "admin_password_reset",
    to: email,
    tenantId: actor.tenantId,
    entity: "Membership",
    entityId: m.id,
    fromName: tenantName,
    replyTo: tenant?.publicEmail || null,
    actorId: actor.userId,
  });
  const outcome: MemberPasswordResetResult = r.ok
    ? { emailSent: true, transport: r.transport, emailStatus: "sent", emailReason: null }
    : {
        emailSent: false,
        transport: r.transport,
        emailStatus: r.transport === "blocked" ? "blocked" : r.skipped ? "skipped" : "failed",
        emailReason: r.reason,
      };
  // Sin el link ni el email: quién lo pidió, para quién (userId) y si salió.
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    action: "membership.password_reset.send",
    entity: "Membership",
    entityId: m.id,
    payload: { userId: m.userId, emailStatus: outcome.emailStatus, transport: outcome.transport },
  });
  revalidatePath("/configuracion");
  return { ok: true, data: outcome };
}

/**
 * Quitar a alguien del equipo (A2b-S-cfg).
 *
 * Antes se borraba la membresía sin mirar nada: el profesional seguía en el
 * selector de la agenda (listPractitioners no miraba membresías) y sus turnos
 * futuros y pacientes asignados quedaban colgados de alguien que ya no puede
 * entrar. Ahora se rechaza, con conteo, mientras tenga turnos futuros activos
 * (PENDING/CONFIRMED) o pacientes asignados sin archivar: hay que
 * reasignarlos primero. El conteo y el borrado van en la misma transacción.
 * S13g suma al mismo rechazo los planes ACTIVE de los que es responsable.
 */
export async function removeMember(membershipId: string): Promise<ActionResult> {
  const { actor, role: actorRole } = await requireTeamManager();
  const m = await runWithRls(actor.tenantId, (tx) => tx.membership.findFirst({
    where: { id: membershipId, tenantId: actor.tenantId },
    select: { id: true, userId: true, role: true },
  }));
  if (!m) return { ok: false, error: "Miembro no encontrado." };
  if (m.userId === actor.userId) {
    return { ok: false, error: "No podés quitarte a vos mismo del equipo." };
  }
  // IAM-D3: el ADMIN no quita al dueño.
  if (m.role === "OWNER" && actorRole !== "OWNER") {
    return { ok: false, error: "Solo el dueño puede quitar a otro dueño." };
  }
  const blocked = await runWithRls(actor.tenantId, async (tx) => {
    const prac = await tx.practitioner.findFirst({
      where: { userId: m.userId, tenantId: actor.tenantId },
      select: { id: true },
    });
    if (prac) {
      const [{ futureBookings, assignedPatients }, activePlans] = await Promise.all([
        countPractitionerLoad(tx, actor.tenantId, prac.id),
        // S13g: planes ACTIVE a cargo (ver `countActivePlansAsResponsible`).
        countActivePlansAsResponsible(tx, actor.tenantId, m.userId),
      ]);
      if (futureBookings > 0 || assignedPatients > 0 || activePlans > 0) {
        return { futureBookings, assignedPatients, activePlans };
      }
    }
    // Soft remove: delete the Membership but leave the UserProfile +
    // Practitioner intact (history: past bookings/sessions point at it, and
    // they may be members of other tenants).
    await tx.membership.delete({ where: { id: membershipId } });
    return null;
  });
  if (blocked) {
    const parts: string[] = [];
    if (blocked.futureBookings > 0) {
      parts.push(`${blocked.futureBookings} turno${blocked.futureBookings === 1 ? "" : "s"} futuro${blocked.futureBookings === 1 ? "" : "s"}`);
    }
    if (blocked.assignedPatients > 0) {
      parts.push(`${blocked.assignedPatients} paciente${blocked.assignedPatients === 1 ? "" : "s"} asignado${blocked.assignedPatients === 1 ? "" : "s"}`);
    }
    // "tiene X y Y" (A2b) + "es responsable de N planes activos" (S13g):
    // "No se puede quitar: tiene 1 paciente asignado y es responsable de 2 planes activos."
    const clauses: string[] = [];
    if (parts.length) clauses.push(`tiene ${parts.join(" y ")}`);
    if (blocked.activePlans > 0) clauses.push(activePlansCopy(blocked.activePlans));
    return {
      ok: false,
      error: `No se puede quitar: ${clauses.join(" y ")}. Reasignalos primero.`,
    };
  }
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    action: "membership.remove",
    entity: "Membership",
    entityId: membershipId,
    payload: { userId: m.userId },
  });
  revalidatePath("/configuracion");
  revalidateTag(tags.practitioners(actor.tenantId));
  return { ok: true, data: undefined };
}
