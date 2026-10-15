/**
 * [BO3-B] Pestaña «Suscripción» del detalle: tipo, plan, estado de la suscripción, trial, turnos online, cupo de
 * usuarios por tipo y el acceso que resulta (`tenantAccessFor`, C-BO1). Se edita con el Drawer de EV0
 * (`TenantEditDrawer`), que desde PL-1d cambia el plan SaaS y los cupos a medida por tipo (Libre y excepciones).
 *
 * PL-3c: el plan se cambia con «Cambiar de plan» (`PlatformPlanChangeDrawer`, mismo núcleo que el consultorio: elegir
 * a quiénes deshabilitar, Libre permitido); «Editar suscripción» queda para tipo, estado, prueba, turnos online y
 * cupos a medida. El estado de cuenta vive en la pestaña «Facturación».
 */
import type { PlatformTenantDetail } from "@/lib/platform-tenants-types";
import { SAAS_PLAN_LABEL, VERTICAL_LABEL } from "@/lib/tenant-modules";
import {
  ACCESS_MODE_LABEL,
  SUBSCRIPTION_STATUS_LABEL,
  formatDayKeyAR,
  seatLimitLabel,
} from "@/components/plataforma/tenants/labels";
import { Facts, Section, muted } from "@/components/plataforma/tenants/detail-ui";
import { TenantEditDrawer } from "@/components/plataforma/tenants/tenant-edit-drawer";
import { PlatformPlanChangeDrawer } from "@/components/plataforma/billing/plan-change-drawer";

/** «Acceso completo» / «En gracia · quedan 3 días». Es lo que vive el consultorio, no lo que se cargó. */
export function accessText(d: Pick<PlatformTenantDetail, "access" | "effectiveAccessMode">): string {
  const base = ACCESS_MODE_LABEL[d.access.mode];
  // `daysLeft` cuenta HOY (el último día es 1), de la prueba o de la gracia según el modo.
  const n = d.access.daysLeft;
  const days = n == null ? "" : n <= 1 ? " · último día" : ` · quedan ${n} días`;
  const enforced =
    d.effectiveAccessMode !== d.access.mode ? ` (hoy se aplica: ${ACCESS_MODE_LABEL[d.effectiveAccessMode].toLowerCase()})` : "";
  return `${base}${days}${enforced}`;
}

export function TenantSubscriptionView({ detail: d }: { detail: PlatformTenantDetail }) {
  return (
    <Section
      title="Suscripción"
      description="El acceso lo calcula la app con el estado del consultorio, la suscripción y la prueba. Los cargos y pagos están en la pestaña Facturación."
      action={
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <PlatformPlanChangeDrawer tenantId={d.id} tenantName={d.name} current={d.saasPlan} vertical={d.vertical} />
          <TenantEditDrawer detail={d} />
        </div>
      }
    >
      <Facts
        items={[
          ["Tipo", VERTICAL_LABEL[d.vertical]],
          ["Plan", SAAS_PLAN_LABEL[d.saasPlan]],
          ["Estado de la suscripción", SUBSCRIPTION_STATUS_LABEL[d.subscriptionStatus]],
          ["Prueba", d.trialEndsOn ? `Hasta el ${formatDayKeyAR(d.trialEndsOn)}` : muted("Sin prueba")],
          ["Turnos online", d.publicBookingEnabled ? "Activo" : "Apagado"],
          ["Usuarios del plan", seatLimitLabel(d)],
          ["Acceso del consultorio", accessText(d)],
        ]}
      />
    </Section>
  );
}
