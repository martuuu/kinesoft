import "server-only";
/**
 * PF2-d (C-PF8): lecturas del equipo (Configuración → Usuarios) sobre una `tx` ya abierta. Las usan
 * `listTeamMembers` / `listPendingInvitations` (lib/invitations.ts: `requireTeamManager` y su `runWithRls`) y el
 * loader de `/configuracion` (mismo criterio de acceso antes de abrir su tx única). Fuera del `"use server"`: reciben
 * `tx`/`tenantId` del llamador y no pueden ser endpoints RPC; la autorización es del llamador.
 * `where: { tenantId }` a mano en cada consulta, también en los includes (prod BYPASSRLS).
 */
import type { DbClient } from "@/lib/rls";
import { invitationStatus } from "@/lib/access-logic";
import { isClinicalMember } from "@/lib/roles";
import type { InvitationEmailStatus, InvitationRow, TeamMemberRow } from "@/lib/invitations-types";
import type { EmailTransportName } from "@/lib/email/types";

export async function listTeamMembersInTx(
  tx: DbClient,
  tenantId: string,
  actorUserId: string
): Promise<TeamMemberRow[]> {
  const rows = await tx.membership.findMany({
    where: { tenantId },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          fullName: true,
          // IAM-1 (M6): un usuario puede ser profesional en varios
          // consultorios; la especialidad es la de ESTE (tenantId a mano: en
          // prod la conexión es BYPASSRLS).
          practitioners: {
            where: { tenantId },
            select: { id: true, specialty: true, publicBookingEnabled: true },
            take: 1,
          },
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
          tenantId,
          entity: "Membership",
          kind: "admin_password_reset",
          entityId: { in: rows.map((r) => r.id) },
        },
        orderBy: { createdAt: "desc" },
        select: { entityId: true, status: true, transport: true, reason: true, createdAt: true },
      })
    : [];
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
      isYou: m.userId === actorUserId,
      disabledAt: m.disabledAt,
      hasAgenda: isClinicalMember(m) && m.user.practitioners.length > 0,
      clinical: isClinicalMember(m),
      grantSettings: m.grantSettings,
      grantBilling: m.grantBilling,
      disabledReason: m.disabledReason,
      // PL-3b: solo quien atiende tiene ficha de profesional que mostrar (un Titular que dejó de atender conserva su
      // `Practitioner` por historia, pero no aparece en el turnero: `publicPractitionerWhere` exige que atienda).
      practitionerId: isClinicalMember(m) ? (m.user.practitioners[0]?.id ?? null) : null,
      publicBookingEnabled: isClinicalMember(m) ? (m.user.practitioners[0]?.publicBookingEnabled ?? false) : false,
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
 * último intento de `EmailLog` (IAM-2a).
 */
export async function listPendingInvitationsInTx(
  tx: DbClient,
  tenantId: string,
  now: Date = new Date()
): Promise<InvitationRow[]> {
  const rows = await tx.invitation.findMany({
    where: { tenantId, acceptedAt: null, revokedAt: null },
    orderBy: { invitedAt: "desc" },
  });
  const logs = rows.length
    ? await tx.emailLog.findMany({
        where: { tenantId, entity: "Invitation", entityId: { in: rows.map((r) => r.id) } },
        orderBy: { createdAt: "desc" },
        select: { entityId: true, status: true, transport: true, reason: true, createdAt: true },
      })
    : [];
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
