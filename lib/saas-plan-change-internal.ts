import "server-only";
/**
 * Cambio de plan SaaS con cupos por tipo (PL-1c, contrato C-PL4, plan §20.5.3; decisión 5 de Martin).
 *
 * Por qué existe: con planes que limitan usuarios (Individual 1 · Consultorio 5 · Clínica 10 · Libre a medida, con
 * topes por tipo solo si Plataforma los arma; §20.17), bajar de plan puede dejar gente de más. Martin (15-oct): **quien cambia el
 * plan elige quiénes pierden el acceso**; se deshabilitan (`disabledAt` + `disabledReason = 'PLAN_DOWNGRADE'`), nunca
 * se borran, y sus turnos NO se cancelan (la agenda los sigue mostrando para reasignarlos). Al subir se pueden
 * reactivar (solo los `PLAN_DOWNGRADE`: una suspensión a mano no se deshace sola por pagar más).
 *
 * Lo comparten el consultorio (`lib/saas-billing.ts`, PL-2c: `requireAccountBilling` + step-up, via "tenant",
 * source `billing` del escritor) y Plataforma (`lib/platform-billing.ts`, via "platform", source `platform`). La tx
 * la abre el caller con `runTeamTx(ctx, …)`: `runWithRls` para el consultorio, el canal service para Plataforma
 * (su audit es SERVICE_ONLY).
 *
 * Orden en `applyPlanChangeInTx` (una sola tx, todo o nada):
 *   1. `FOR UPDATE` del Tenant + CAS contra `expectedUpdatedAt` → `stale` sin escribir nada.
 *   2. `FOR UPDATE` de las membresías del consultorio (una suspensión o un cambio de rol en paralelo no cambia el
 *      recuento entre la validación y la escritura).
 *   3. Recuento con los elegidos excluidos y los reactivados sumados → validación (`does_not_fit`, Titular, uno mismo).
 *   4. Escritor único de entitlements (`applyTenantEntitlementsInTx`, `saasPlan`; espeja el legado y audita).
 *   5. Deshabilitar elegidos y anular sus invitaciones vivas → anular las invitaciones que ya no entran → reactivar
 *      elegidos (con `Practitioner` + agenda si atienden) → audit `tenant.plan.change`.
 * Desvío del contrato (escritor primero): la validación va ANTES del escritor porque el caller comitea lo que la
 * función haya escrito aunque devuelva `{ ok: false }`; validar después obligaría a tirar para revertir. El lock y el
 * CAS siguen siendo lo primero, así que el efecto es el mismo.
 */
import type { Role, SaasPlan } from "@prisma/client";
import type { DbClient } from "@/lib/rls";
import { applyTenantEntitlementsInTx } from "@/lib/tenant-entitlements-internal";
import { modulesFor, TENANT_MODULES, type TenantModule } from "@/lib/tenant-modules";
import {
  invitesThatFit,
  mustDisableFor,
  seatKindOf,
  seatUsageByKind,
  type SeatKind,
} from "@/lib/plan-catalog";
import { PLAN_DEFAULTS, hasCustomLimits } from "@/lib/saas-plans-logic";
import { liveProgramWhere } from "@/lib/plan-predicates";
import { displayUserName } from "@/lib/display-name";
import { normalizeEmail } from "@/lib/email-match";
import { isClinicalMember } from "@/lib/roles";
import {
  ensureClinicalPractitionerInTx,
  invitationSeatKind,
  planLimitsInTx,
  teamAuditInTx,
  type TeamActorCtx,
} from "@/lib/team-internal";
import type {
  ApplyPlanChangeResult,
  PlanChangeCandidate,
  PlanChangePreview,
} from "@/lib/saas-plan-change-types";

export type {
  ApplyPlanChangeReason,
  ApplyPlanChangeResult,
  PlanChangeCandidate,
  PlanChangePreview,
} from "@/lib/saas-plan-change-types";

/** Algo cambió debajo del lock (no debería pasar con los `FOR UPDATE`): tirar revierte la tx entera. */
export class PlanChangeRaceError extends Error {
  constructor() {
    super("plan_change_race");
    this.name = "PlanChangeRaceError";
  }
}

type TenantPlanRow = {
  saasPlan: SaasPlan;
  vertical: "GENERAL" | "KINESIOLOGY";
  publicBookingEnabled: boolean;
  maxUsersOverride: number | null;
  maxProfessionalsOverride: number | null;
  maxStaffOverride: number | null;
  updatedAt: Date;
};

async function readTenantInTx(tx: DbClient, tenantId: string, lock: boolean): Promise<TenantPlanRow | null> {
  if (lock) {
    // Mismo orden que el escritor de entitlements y los cupos: Tenant primero.
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Tenant" WHERE "id" = ${tenantId} FOR UPDATE`;
    if (rows.length === 0) return null;
  }
  // Lectura tipada con el ORM: `updatedAt` sale con el mismo mapeo que el que vuelve como `expectedUpdatedAt`.
  return tx.tenant.findUnique({
    where: { id: tenantId },
    select: {
      saasPlan: true,
      vertical: true,
      publicBookingEnabled: true,
      maxUsersOverride: true,
      maxProfessionalsOverride: true,
      maxStaffOverride: true,
      updatedAt: true,
    },
  });
}

function loadMembersInTx(tx: DbClient, tenantId: string) {
  return tx.membership.findMany({
    where: { tenantId },
    select: {
      id: true,
      userId: true,
      role: true,
      clinical: true,
      disabledAt: true,
      disabledReason: true,
      user: { select: { email: true, fullName: true } },
    },
    orderBy: { invitedAt: "asc" },
  });
}
type MemberRow = Awaited<ReturnType<typeof loadMembersInTx>>[number];

function pendingInvitesInTx(tx: DbClient, tenantId: string, now: Date) {
  return tx.invitation.findMany({
    where: { tenantId, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
    select: { id: true, email: true, role: true },
    // Las más viejas primero: conservan su lugar (`invitesThatFit`).
    orderBy: [{ invitedAt: "asc" }, { id: "asc" }],
  });
}

function tally(rows: readonly { role: Role; clinical: boolean }[]) {
  const c = { professional: 0, staff: 0 };
  for (const r of rows) c[seatKindOf(r)]++;
  return c;
}

/**
 * Turnos futuros activos, pacientes asignados sin archivar y planes ACTIVE a cargo, por usuario (solo conteos, sin
 * PHI): lo que queda colgado si esa persona pierde el acceso. Tres `groupBy` (no N+1). `tenantId` a mano.
 */
async function loadsByUserInTx(tx: DbClient, tenantId: string, userIds: string[], now: Date) {
  const out = new Map<string, { futureBookings: number; assignedPatients: number; activePlans: number }>();
  for (const u of userIds) out.set(u, { futureBookings: 0, assignedPatients: 0, activePlans: 0 });
  if (userIds.length === 0) return out;
  const pracs = await tx.practitioner.findMany({
    where: { tenantId, userId: { in: userIds } },
    select: { id: true, userId: true },
  });
  if (pracs.length === 0) return out;
  const userOf = new Map(pracs.map((p) => [p.id, p.userId]));
  const ids = pracs.map((p) => p.id);
  const [bookings, patients, programs] = await Promise.all([
    tx.booking.groupBy({
      by: ["practitionerId"],
      where: { tenantId, practitionerId: { in: ids }, scheduledFor: { gte: now }, status: { in: ["PENDING", "CONFIRMED"] } },
      _count: { _all: true },
    }),
    tx.patient.groupBy({
      by: ["assignedPractitionerId"],
      where: { tenantId, assignedPractitionerId: { in: ids }, archivedAt: null },
      _count: { _all: true },
    }),
    tx.treatmentProgram.groupBy({
      by: ["practitionerId"],
      where: { tenantId, practitionerId: { in: ids }, ...liveProgramWhere, status: "ACTIVE" },
      _count: { _all: true },
    }),
  ]);
  const add = (pracId: string | null, k: "futureBookings" | "assignedPatients" | "activePlans", n: number) => {
    const u = pracId ? userOf.get(pracId) : undefined;
    if (u) out.get(u)![k] += n;
  };
  for (const b of bookings) add(b.practitionerId, "futureBookings", b._count._all);
  for (const p of patients) add(p.assignedPractitionerId, "assignedPatients", p._count._all);
  for (const p of programs) add(p.practitionerId, "activePlans", p._count._all);
  return out;
}

function modulesDiff(t: TenantPlanRow, to: SaasPlan): { lost: TenantModule[]; gained: TenantModule[] } {
  const before = modulesFor({ vertical: t.vertical, plan: t.saasPlan, publicBookingEnabled: t.publicBookingEnabled });
  const after = modulesFor({ vertical: t.vertical, plan: to, publicBookingEnabled: t.publicBookingEnabled });
  // En el orden de `TENANT_MODULES` (estable para la UI y los tests).
  return {
    lost: TENANT_MODULES.filter((m) => before.has(m) && !after.has(m)),
    gained: TENANT_MODULES.filter((m) => !before.has(m) && after.has(m)),
  };
}

/**
 * Lo que pasaría al cambiar a `to` (para el drawer): límites, uso, mínimo a deshabilitar, candidatos con su carga,
 * invitaciones que se anularían (si se deshabilita el mínimo), reactivables, módulos y precio. Solo lectura, sin lock.
 * null = el consultorio no existe.
 */
export async function previewPlanChangeInTx(
  tx: DbClient,
  p: { tenantId: string; to: SaasPlan; now: Date; actorUserId?: string }
): Promise<PlanChangePreview | null> {
  const t = await readTenantInTx(tx, p.tenantId, false);
  if (!t) return null;
  const [limits, members, invites, cfg] = await Promise.all([
    planLimitsInTx(tx, p.to, t),
    loadMembersInTx(tx, p.tenantId),
    pendingInvitesInTx(tx, p.tenantId, p.now),
    tx.saasPlanConfig.findUnique({ where: { plan: p.to }, select: { priceCents: true } }),
  ]);
  const active = members.filter((m) => !m.disabledAt);
  const m = tally(active);
  const inviteKinds = invites.map((i) => ({ kind: invitationSeatKind(i.role) }));
  const i = { professional: 0, staff: 0 };
  for (const k of inviteKinds) i[k.kind]++;
  const must = mustDisableFor(m, limits);
  const fits = invitesThatFit(
    { professional: m.professional - must.professional, staff: m.staff - must.staff, total: m.professional + m.staff - must.total },
    limits,
    inviteKinds
  );
  const loads = await loadsByUserInTx(tx, p.tenantId, active.map((a) => a.userId), p.now);
  const candidates: PlanChangeCandidate[] = active.map((a) => ({
    membershipId: a.id,
    userId: a.userId,
    name: displayUserName(a.user.fullName),
    role: a.role,
    clinical: isClinicalMember(a),
    kind: seatKindOf(a),
    isOwner: a.role === "OWNER",
    isSelf: p.actorUserId != null && a.userId === p.actorUserId,
    ...loads.get(a.userId)!,
  }));
  const diff = modulesDiff(t, p.to);
  return {
    from: t.saasPlan,
    to: p.to,
    limits,
    usage: seatUsageByKind({ professional: m.professional + i.professional, staff: m.staff + i.staff }, limits),
    mustDisable: must,
    candidates,
    invitesToRevoke: invites
      .filter((_, idx) => !fits[idx])
      .map((inv) => ({ invitationId: inv.id, email: inv.email, role: inv.role })),
    reactivatable: members
      .filter((r) => r.disabledAt && r.disabledReason === "PLAN_DOWNGRADE")
      .map((r) => ({
        membershipId: r.id,
        name: displayUserName(r.user.fullName),
        role: r.role,
        clinical: isClinicalMember(r),
        disabledAt: r.disabledAt!.toISOString(),
      })),
    modulesLost: diff.lost,
    modulesGained: diff.gained,
    priceCents: cfg ? cfg.priceCents : PLAN_DEFAULTS[p.to].priceCents,
    tenantUpdatedAt: t.updatedAt.toISOString(),
  };
}

const fail = (reason: Exclude<ApplyPlanChangeResult, { ok: true }>["reason"], detail?: string): ApplyPlanChangeResult =>
  detail ? { ok: false, reason, detail } : { ok: false, reason };

/** Ver la cabecera. `disableMembershipIds`/`reactivateMembershipIds` = lo que eligió quien cambia el plan. */
export async function applyPlanChangeInTx(
  tx: DbClient,
  p: {
    tenantId: string;
    to: SaasPlan;
    disableMembershipIds: string[];
    reactivateMembershipIds: string[];
    expectedUpdatedAt: Date;
    ctx: TeamActorCtx;
    now: Date;
  }
): Promise<ApplyPlanChangeResult> {
  const { tenantId, ctx, now } = p;
  if (ctx.tenantId !== tenantId) throw new Error("[saas-plan-change] ctx de otro consultorio");
  // Libre es a medida: lo arma Plataforma después de hablar (el consultorio ve «Consultanos» → soporte).
  if (p.to === "LIBRE" && ctx.via !== "platform") return fail("libre_platform_only");

  // 1. Lock + CAS.
  const t = await readTenantInTx(tx, tenantId, true);
  if (!t) return fail("not_found");
  if (t.updatedAt.getTime() !== p.expectedUpdatedAt.getTime()) return fail("stale");
  if (t.saasPlan === p.to) return fail("invalid_selection", "same_plan");
  // PL-Z a3#1: un consultorio con cupos a medida (Libre con overrides) no cambia de plan solo: los overrides valen
  // solo en Libre, así que el cambio le haría perder (o arrastrar) lo que se pactó. Lo hace Plataforma después de
  // hablar. Overrides inertes en otro plan (legado de M8) no traban: ahí ya rige el plan.
  if (ctx.via !== "platform" && hasCustomLimits(t.saasPlan, t)) return fail("invalid_selection", "custom_limits");

  // 2. Lock de las membresías del consultorio (orden: Tenant → Membership, como el resto del equipo).
  await tx.$queryRaw`SELECT "id" FROM "Membership" WHERE "tenantId" = ${tenantId} FOR UPDATE`;
  const members = await loadMembersInTx(tx, tenantId);
  const byId = new Map(members.map((m) => [m.id, m]));

  // 3. Validación de la elección.
  const disableIds = p.disableMembershipIds;
  const reactivateIds = p.reactivateMembershipIds;
  if (new Set(disableIds).size !== disableIds.length || new Set(reactivateIds).size !== reactivateIds.length) {
    return fail("invalid_selection", "duplicated");
  }
  const toDisable: MemberRow[] = [];
  for (const id of disableIds) {
    const m = byId.get(id);
    if (!m || m.disabledAt) return fail("invalid_selection", "disable_not_active");
    if (m.role === "OWNER") return fail("owner_selected");
    if (m.userId === ctx.actorUserId) return fail("self_selected");
    toDisable.push(m);
  }
  const disableSet = new Set(disableIds);
  const toReactivate: MemberRow[] = [];
  for (const id of reactivateIds) {
    const m = byId.get(id);
    if (!m || !m.disabledAt || m.disabledReason !== "PLAN_DOWNGRADE" || disableSet.has(id)) {
      return fail("invalid_selection", "reactivate_not_downgraded");
    }
    toReactivate.push(m);
  }
  const limits = await planLimitsInTx(tx, p.to, t);
  const finalMembers = [
    ...members.filter((m) => !m.disabledAt && !disableSet.has(m.id)),
    ...toReactivate,
  ];
  const finalCount = tally(finalMembers);
  const short = mustDisableFor(finalCount, limits);
  if (short.total > 0) {
    // Cuántos más hay que sacar, para que la UI lo diga sin recalcular.
    return fail("does_not_fit", `professional:${short.professional},staff:${short.staff},total:${short.total}`);
  }

  // 4. Escritor único (CAS de nuevo: con el lock de arriba no puede fallar, pero si falla no se escribió nada).
  const w =
    ctx.via === "platform"
      ? await applyTenantEntitlementsInTx(tx, {
          tenantId,
          source: "platform",
          patch: { saasPlan: p.to },
          expectedUpdatedAt: p.expectedUpdatedAt,
          actor: ctx.actorRef ?? { userId: ctx.actorUserId, email: null, homeTenantId: null },
        })
      : await applyTenantEntitlementsInTx(tx, {
          tenantId,
          source: "billing",
          patch: { saasPlan: p.to },
          expectedUpdatedAt: p.expectedUpdatedAt,
          actor: { userId: ctx.actorUserId, homeTenantId: tenantId },
        });
  if (!w.ok) return fail(w.reason === "stale" ? "stale" : "not_found");

  // 5a. Deshabilitar (nunca el OWNER, también en el predicado) y anular sus invitaciones vivas: aceptar una
  //     invitación reactiva la membresía (`joinTenantInTx`), así que una viva sería la puerta de vuelta.
  let revokedInvites = 0;
  if (toDisable.length) {
    const upd = await tx.membership.updateMany({
      where: { id: { in: disableIds }, tenantId, disabledAt: null, role: { not: "OWNER" } },
      data: { disabledAt: now, disabledById: ctx.actorUserId, disabledReason: "PLAN_DOWNGRADE" },
    });
    if (upd.count !== toDisable.length) throw new PlanChangeRaceError();
    const emails = toDisable.map((m) => normalizeEmail(m.user.email));
    revokedInvites += (
      await tx.invitation.updateMany({
        where: { tenantId, email: { in: emails }, acceptedAt: null, revokedAt: null },
        data: { revokedAt: now, revokedById: ctx.actorUserId },
      })
    ).count;
  }

  // 5b. Invitaciones pendientes que ya no entran con los miembros finales (las más viejas conservan su lugar).
  const invites = await pendingInvitesInTx(tx, tenantId, now);
  const fits = invitesThatFit(
    { ...finalCount, total: finalCount.professional + finalCount.staff },
    limits,
    invites.map((i) => ({ kind: invitationSeatKind(i.role) as SeatKind }))
  );
  const surplus = invites.filter((_, idx) => !fits[idx]).map((i) => i.id);
  if (surplus.length) {
    revokedInvites += (
      await tx.invitation.updateMany({
        where: { id: { in: surplus }, tenantId, acceptedAt: null, revokedAt: null },
        data: { revokedAt: now, revokedById: ctx.actorUserId },
      })
    ).count;
  }

  // 5c. Reactivar (con `Practitioner` y agenda si atiende, como `reactivateMemberInTx`).
  if (toReactivate.length) {
    const upd = await tx.membership.updateMany({
      where: { id: { in: reactivateIds }, tenantId, disabledAt: { not: null }, disabledReason: "PLAN_DOWNGRADE" },
      data: { disabledAt: null, disabledById: null, disabledReason: null },
    });
    if (upd.count !== toReactivate.length) throw new PlanChangeRaceError();
    for (const m of toReactivate) {
      if (isClinicalMember(m)) await ensureClinicalPractitionerInTx(tx, tenantId, m.userId);
    }
  }

  // 5d. Audit en la misma tx (ids y conteos; sin emails ni nombres: el registro de plataforma es solo inserción).
  await teamAuditInTx(tx, ctx, {
    action: "tenant.plan.change",
    entity: "Tenant",
    entityId: tenantId,
    payload: {
      from: t.saasPlan,
      to: p.to,
      disabled: disableIds,
      reactivated: reactivateIds,
      revokedInvites,
    },
  });
  return { ok: true, disabled: toDisable.length, reactivated: toReactivate.length, revokedInvites };
}
