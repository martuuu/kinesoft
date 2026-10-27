/**
 * Notification fan-out — internal helpers. NOT "use server".
 *
 * `notify()` and `notifyTenantOwners()` accept arbitrary `tenantId` +
 * `userId` arguments and trust them; exposing them as RPC endpoints (as
 * happens to every async export in a `"use server"` file) lets any client
 * spam any practitioner's bell with attacker-chosen content + phishing
 * links. Keep them here and import them from domain mutations.
 */
import "server-only";
import { NotificationKind } from "@prisma/client";
import { runWithRls } from "@/lib/rls";
import { logger } from "@/lib/logger";
import { captureException } from "@/lib/observability";
import { capabilitiesForMember, MEMBER_ACCESS_SELECT } from "@/lib/capabilities";

/**
 * Fire-and-forget enqueue helper called by domain mutations. Never throws
 * — notifications are nice-to-have.
 */
export async function notify(p: {
  tenantId: string;
  userId: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  link?: string;
}) {
  try {
    await runWithRls(p.tenantId, (tx) => tx.notification.create({
      data: {
        tenantId: p.tenantId,
        userId: p.userId,
        kind: p.kind,
        title: p.title,
        body: p.body,
        link: p.link,
      },
    }));
  } catch (err) {
    // Fire-and-forget: never block the caller — but leave a trace.
    logger.warn("notify: insert failed", {
      tenantId: p.tenantId,
      userId: p.userId,
      kind: p.kind,
      error: err instanceof Error ? err.message : String(err),
    });
    captureException(err, { scope: "notify", tenantId: p.tenantId, userId: p.userId, kind: p.kind });
  }
}

/**
 * Enqueue a notification for every member of a tenant that can plausibly
 * act on it. Used when a webhook (no actor context) needs to reach the
 * right practitioner — we notify the booking's practitioner + every
 * OWNER / ADMIN of the tenant.
 *
 * HD-12 (PV): solo miembros ACTIVOS. Antes el rol era el único filtro de
 * titulares, así que una membresía suspendida (`Membership.disabledAt`), una
 * invitación sin aceptar (`acceptedAt` null) o un usuario deshabilitado en
 * Plataforma (`UserProfile.disabledAt`, BO0) seguían recibiendo avisos con montos
 * y nombres de pacientes de un consultorio al que ya no entran; y
 * `alsoPractitionerId` iba por `findUnique` sin tenant ni estado. `ACTIVE_MEMBER`
 * es el mismo criterio en los cuatro caminos; son filtros de las mismas
 * sentencias (0 nuevas: el webhook de MP y el turnero tienen techo).
 */
export async function notifyTenantOwners(p: {
  tenantId: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  link?: string;
  alsoPractitionerId?: string;
  /**
   * ES4-Z (b7, decisión con default): avisar también a quien opera la agenda de todos (`agenda.operateAll`: hoy la
   * Secretaria). El pedido de «Mis datos» del portal lo aprueba ella (PD-13) y antes no le llegaba. Solo membresías
   * activas (las suspendidas no entran).
   */
  alsoAgendaOperators?: boolean;
  /**
   * T5 (C-TP7): avisar también a ESTE usuario (el que generó el link de pago: un profesional sin rol de titular que
   * mandó el link quiere saber que se pagó). Solo si sigue siendo miembro activo del consultorio: el id viene de
   * `OnlineCharge.createdByUserId`, que no tiene FK y puede ser de alguien que ya se fue.
   */
  alsoUserId?: string;
}) {
  try {
    const recipients = new Set<string>();
    // Membresía usable: no suspendida en el consultorio, invitación aceptada y usuario no deshabilitado en Plataforma.
    const ACTIVE_MEMBER = { disabledAt: null, acceptedAt: { not: null }, user: { disabledAt: null } } as const;
    if (p.alsoPractitionerId) {
      // `findFirst` con `tenantId`: el id viene de un turno/cobro, pero las FK saltean RLS (AGENTS.md §4) y en prod la
      // conexión tiene BYPASSRLS; sin el tenant, un id ajeno avisaba a un profesional de otro consultorio.
      const prac = await runWithRls(p.tenantId, (tx) => tx.practitioner.findFirst({
        where: {
          id: p.alsoPractitionerId,
          tenantId: p.tenantId,
          user: { disabledAt: null, memberships: { some: { tenantId: p.tenantId, disabledAt: null, acceptedAt: { not: null } } } },
        },
        select: { userId: true },
      }));
      if (prac?.userId) recipients.add(prac.userId);
    }
    const memberships = await runWithRls(p.tenantId, (tx) => tx.membership.findMany({
      where: { tenantId: p.tenantId, role: { in: ["OWNER", "ADMIN"] }, ...ACTIVE_MEMBER },
      select: { userId: true },
    }));
    for (const m of memberships) recipients.add(m.userId);
    if (p.alsoAgendaOperators) {
      const operators = await runWithRls(p.tenantId, (tx) => tx.membership.findMany({
        where: { tenantId: p.tenantId, role: { notIn: ["OWNER", "ADMIN"] }, ...ACTIVE_MEMBER },
        select: { userId: true, ...MEMBER_ACCESS_SELECT },
      }));
      for (const m of operators) if (capabilitiesForMember(m).has("agenda.operateAll")) recipients.add(m.userId);
    }
    if (p.alsoUserId && !recipients.has(p.alsoUserId)) {
      const member = await runWithRls(p.tenantId, (tx) => tx.membership.findFirst({
        where: { tenantId: p.tenantId, userId: p.alsoUserId, ...ACTIVE_MEMBER },
        select: { userId: true },
      }));
      if (member) recipients.add(member.userId);
    }

    if (recipients.size === 0) return;
    await runWithRls(p.tenantId, (tx) => tx.notification.createMany({
      data: Array.from(recipients).map((userId) => ({
        tenantId: p.tenantId,
        userId,
        kind: p.kind,
        title: p.title,
        body: p.body,
        link: p.link,
      })),
    }));
  } catch (err) {
    // Fire-and-forget: never block the caller — but leave a trace.
    logger.warn("notifyTenantOwners: insert failed", {
      tenantId: p.tenantId,
      kind: p.kind,
      error: err instanceof Error ? err.message : String(err),
    });
    captureException(err, { scope: "notifyTenantOwners", tenantId: p.tenantId, kind: p.kind });
  }
}
