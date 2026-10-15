import "server-only";
/**
 * Configuración → «Plan y uso» (BO3-F): lectura del plan, la suscripción, los cupos y el turnero del consultorio
 * ACTIVO. Solo lectura (sin billing: cambiar de plan lo hace Plataforma, el consultorio «escribinos»).
 *
 * No es `"use server"` a propósito: la llama la página de Configuración (Server Component) y nada del cliente la
 * necesita; así no queda expuesta como endpoint RPC.
 *
 * Orden de AGENTS.md: `requireCapability("tenant.admin")` (OWNER/ADMIN; también el soporte, que ve Configuración)
 * → `runWithRls` con `where: { tenantId }` a mano (en prod la conexión es BYPASSRLS: es la única barrera). Los
 * cupos salen de `getSeatUsageInTx` (lib/team-internal.ts), el mismo cálculo que frena la invitación; el copy, de
 * `planUsageView` (lib/tenant-plan-usage-logic.ts, puro).
 */
import { requireCapability } from "@/lib/authz";
import { runWithRls } from "@/lib/rls";
import { getSeatUsageInTx } from "@/lib/team-internal";
import { CLINICAL_ROLES } from "@/lib/roles";
import { planUsageView, type TenantPlanUsageView } from "@/lib/tenant-plan-usage-logic";

export async function getTenantPlanUsage(now: Date = new Date()): Promise<TenantPlanUsageView> {
  const { actor } = await requireCapability("tenant.admin", "Solo OWNER/ADMIN ven el plan del consultorio.");
  const tenantId = actor.tenantId;
  const clinical = [...CLINICAL_ROLES];
  const r = await runWithRls(tenantId, async (tx) => {
    const [tenant, seats, pendingClinicalInvites, nonSeatMembers] = await Promise.all([
      tx.tenant.findUnique({
        where: { id: tenantId },
        select: {
          plan: true,
          status: true,
          subscriptionStatus: true,
          trialEndsAt: true,
          subscriptionStatusChangedAt: true,
          publicBookingEnabled: true,
          seatLimitOverride: true,
        },
      }),
      getSeatUsageInTx(tx, tenantId, { now }),
      // Mismo filtro que `getSeatUsageInTx`: solo para poder decir «incluye N invitaciones pendientes».
      tx.invitation.count({
        where: { tenantId, acceptedAt: null, revokedAt: null, expiresAt: { gt: now }, role: { in: clinical } },
      }),
      tx.membership.count({ where: { tenantId, disabledAt: null, role: { notIn: clinical } } }),
    ]);
    return { tenant, seats, pendingClinicalInvites, nonSeatMembers };
  });
  if (!r.tenant || !r.seats) throw new Error("No encontramos el consultorio.");
  return planUsageView(
    {
      ...r.tenant,
      seats: r.seats,
      pendingClinicalInvites: r.pendingClinicalInvites,
      nonSeatMembers: r.nonSeatMembers,
    },
    now
  );
}
