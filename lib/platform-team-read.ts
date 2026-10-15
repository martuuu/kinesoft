import "server-only";
/**
 * /plataforma → equipo de un consultorio, lectura (BO2-B, plan §19.5). La consume el panel de BO3-C; no es una
 * server action (sin "use server": no tiene por qué ser invocable con un POST desde el browser).
 *
 * Seguridad (invariantes del gate de BO):
 *  - `requirePlatformAdmin("platform.read")` en CADA export, primero: todo va por el canal service (BYPASSRLS) y
 *    `tenantId` explícito en cada `where` es la única barrera entre consultorios.
 *  - Sin PHI: solo Membership / UserProfile (nombre y email del equipo, no de pacientes) / Invitation / EmailLog
 *    (estado del último envío) y el Tenant. Nada de Patient, Booking, Session ni nada clínico; ni siquiera
 *    `count`, que acá no hace falta.
 *  - DTO con lista cerrada de campos (`PlatformTenantTeam`, `lib/invitations-types.ts`): se arma campo por campo,
 *    nunca con spread de la fila; el test de integración fija las claves con un fixture de PHI en el consultorio.
 *
 * Último login: el puerto de Auth (`lib/identity/auth-admin.ts`) solo trae usuarios de a uno (`getUser`), así que
 * mostrarlo sería un N+1 contra GoTrue por miembro. Se omite (lo puede sumar el directorio de usuarios de BO2-C).
 */
import { prismaService } from "@/lib/db";
import { requirePlatformAdmin } from "@/lib/platform-actor";
import { invitationStatus } from "@/lib/access-logic";
import { isClinicalMember } from "@/lib/roles";
import { getSeatUsageInTx } from "@/lib/team-internal";
import type { InvitationEmailStatus, PlatformTenantTeam } from "@/lib/invitations-types";

/** null = el consultorio no existe (o el id no tiene forma de id). */
export async function getTenantTeamForPlatform(tenantId: string): Promise<PlatformTenantTeam | null> {
  await requirePlatformAdmin("platform.read");
  if (typeof tenantId !== "string" || tenantId.length < 1 || tenantId.length > 64) return null;
  const now = new Date();

  const data = await prismaService.$transaction(async (tx) => {
    const seats = await getSeatUsageInTx(tx, tenantId, { now });
    if (!seats) return null;
    const [members, invitations] = await Promise.all([
      tx.membership.findMany({
        where: { tenantId },
        select: {
          id: true,
          userId: true,
          role: true,
          // PL-1d: un Titular/Admin que no atiende no tiene agenda aunque su rol sea «clínico» (C-PL5).
          clinical: true,
          acceptedAt: true,
          disabledAt: true,
          user: {
            select: {
              email: true,
              fullName: true,
              // M6: el Practitioner es por consultorio; `tenantId` a mano (BYPASSRLS).
              practitioners: { where: { tenantId }, select: { id: true }, take: 1 },
            },
          },
        },
        orderBy: { invitedAt: "asc" },
      }),
      tx.invitation.findMany({
        where: { tenantId, acceptedAt: null, revokedAt: null },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
          invitedAt: true,
          expiresAt: true,
          acceptedAt: true,
          revokedAt: true,
          lastSentAt: true,
          sendCount: true,
        },
        orderBy: { invitedAt: "desc" },
      }),
    ]);
    // Último intento de mail por invitación: más nuevo primero, el primero por invitación gana. Una sola query.
    const logs = invitations.length
      ? await tx.emailLog.findMany({
          where: { tenantId, entity: "Invitation", entityId: { in: invitations.map((i) => i.id) } },
          orderBy: { createdAt: "desc" },
          select: { entityId: true, status: true },
        })
      : [];
    return { seats, members, invitations, logs };
  });
  if (!data) return null;

  const lastStatus = new Map<string, InvitationEmailStatus>();
  for (const l of data.logs) {
    if (l.entityId && !lastStatus.has(l.entityId)) lastStatus.set(l.entityId, l.status as InvitationEmailStatus);
  }

  return {
    tenantId,
    members: data.members.map((m) => ({
      membershipId: m.id,
      userId: m.userId,
      fullName: m.user.fullName,
      email: m.user.email,
      role: m.role,
      joinedAt: m.acceptedAt,
      disabledAt: m.disabledAt,
      hasAgenda: isClinicalMember(m) && m.user.practitioners.length > 0,
    })),
    invitations: data.invitations.map((i) => ({
      id: i.id,
      email: i.email,
      firstName: i.firstName,
      lastName: i.lastName,
      role: i.role,
      status: invitationStatus(i, now),
      invitedAt: i.invitedAt,
      expiresAt: i.expiresAt,
      lastSentAt: i.lastSentAt,
      sendCount: i.sendCount,
      lastEmailStatus: lastStatus.get(i.id) ?? null,
    })),
    // PL-1d: cupos por tipo (C-PL3, `SeatUsageByKind`: total / profesionales / no clínicos), tal cual los cuenta
    // `getSeatUsageInTx` (miembros habilitados + invitaciones pendientes).
    seats: {
      total: { ...data.seats.total },
      professional: { ...data.seats.professional },
      staff: { ...data.seats.staff },
    },
  };
}
