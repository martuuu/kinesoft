import "server-only";
/**
 * Configuración → «Plan y uso» (BO3-F; PL-1c cupos por tipo): lectura del plan, la suscripción, los cupos y el
 * turnero del consultorio ACTIVO. Solo lectura: cambiar de plan va por `lib/saas-billing.ts` (PL-2c) sobre
 * `previewPlanChangeInTx`/`applyPlanChangeInTx` (lib/saas-plan-change-internal.ts).
 *
 * No es `"use server"` a propósito: la llama la página de Configuración (Server Component) y nada del cliente la
 * necesita; así no queda expuesta como endpoint RPC.
 *
 * Orden de AGENTS.md: `requireCapability("tenant.admin")` (Titular, ADMIN o quien tenga «Configuración»; también el
 * soporte) → `runWithRls` con `where: { tenantId }` a mano (en prod la conexión es BYPASSRLS: es la única barrera).
 * Los cupos salen de `getSeatUsageInTx` (lib/team-internal.ts), el mismo cálculo que frena la invitación; el
 * desglose de invitaciones y miembros no clínicos, de `countSeatsInTx` (mismos filtros); el copy, de `planUsageView`.
 */
import { requireCapability } from "@/lib/authz";
import { runWithRls } from "@/lib/rls";
import { countSeatsInTx, getSeatUsageInTx } from "@/lib/team-internal";
import { PLAN_DEFAULTS } from "@/lib/saas-plans-logic";
import { planUsageView, type TenantPlanUsageView } from "@/lib/tenant-plan-usage-logic";

export async function getTenantPlanUsage(now: Date = new Date()): Promise<TenantPlanUsageView> {
  const { actor } = await requireCapability("tenant.admin", "Solo OWNER/ADMIN ven el plan del consultorio.");
  const tenantId = actor.tenantId;
  const r = await runWithRls(tenantId, async (tx) => {
    const [tenant, seats, counts] = await Promise.all([
      tx.tenant.findUnique({
        where: { id: tenantId },
        select: {
          saasPlan: true,
          status: true,
          subscriptionStatus: true,
          trialEndsAt: true,
          subscriptionStatusChangedAt: true,
          publicBookingEnabled: true,
          maxUsersOverride: true,
          maxProfessionalsOverride: true,
          maxStaffOverride: true,
        },
      }),
      getSeatUsageInTx(tx, tenantId, { now }),
      countSeatsInTx(tx, tenantId, { now }),
    ]);
    const cfg = tenant
      ? await tx.saasPlanConfig.findUnique({ where: { plan: tenant.saasPlan }, select: { label: true } })
      : null;
    return { tenant, seats, counts, label: cfg?.label ?? null };
  });
  if (!r.tenant || !r.seats) throw new Error("No encontramos el consultorio.");
  const t = r.tenant;
  return planUsageView(
    {
      plan: t.saasPlan,
      planLabel: r.label ?? PLAN_DEFAULTS[t.saasPlan].label,
      status: t.status,
      subscriptionStatus: t.subscriptionStatus,
      trialEndsAt: t.trialEndsAt,
      subscriptionStatusChangedAt: t.subscriptionStatusChangedAt,
      publicBookingEnabled: t.publicBookingEnabled,
      customLimits: t.maxUsersOverride != null || t.maxProfessionalsOverride != null || t.maxStaffOverride != null,
      seats: r.seats,
      pendingInvites: r.counts.invites,
      nonSeatMembers: r.counts.members.staff,
    },
    now
  );
}
