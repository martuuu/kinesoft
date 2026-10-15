"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { SubscriptionStatus, TenantVertical } from "@prisma/client";
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { Button } from "@/components/ui/button";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { formatARS } from "@/lib/format";
import type { TenantModule } from "@/lib/tenant-modules";
import type { BillingOverview } from "@/lib/saas-billing-types";
import type { PlanUsageTone, TenantPlanUsageView } from "@/lib/tenant-plan-usage-logic";
import { READ_ONLY_PLAN_COPY, moduleLabels, planSeatsLabel, planStatusView } from "@/lib/saas-billing-view";
import { PlanChangeDrawer, type PlanChoice } from "./plan-change-drawer";
import type { SupportDraft } from "./support-messages-panel";

/**
 * Configuración → «Plan y uso» (BO3-F; PL-1d cupos; PL-3a: cambiar de plan desde acá). Para quien tiene
 * `account.billing` (Titular o «Planes y pagos» delegado).
 *
 * Muestra el plan (`planLabel` de `SaasPlanConfig`), lo que se cobra por mes, el estado (prueba con los días que
 * quedan en AR, al día, pago pendiente, modo lectura), los cupos como los dice el plan (`planSeatsLabel`: Individual
 * «1 de 1», Consultorio/Clínica «Total X de N», Libre a medida), los módulos que incluye y «Cambiar de plan» (drawer
 * con step-up). El copy de estado sale de `subscriptionSummary` (server, testeado en TZ=UTC y TZ=AR) pasado por
 * `planStatusView`: acá no se calculan fechas.
 *
 * `usage` puede venir null solo si la lectura de cupos (`getTenantPlanUsage`, que acepta `tenant.admin` o
 * `account.billing`) falló: se muestra el plan y el estado desde Facturación, sin el desglose de cupos.
 */

const TONE_STYLE: Record<PlanUsageTone, { background: string; color: string }> = {
  ok: { background: "rgba(200,245,100,0.18)", color: "var(--navy-900)" },
  info: { background: "var(--sky-100)", color: "var(--sky-800)" },
  warn: { background: "var(--st-noshow-bg)", color: "var(--st-noshow-fg)" },
};

function Row({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: 16,
        flexWrap: "wrap",
        padding: "12px 0",
        borderTop: "1px solid rgba(15,30,51,0.06)",
      }}
    >
      <div style={{ flex: "1 1 220px", minWidth: 0, maxWidth: 560 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--navy-900)" }}>{label}</div>
        {hint && <div style={{ fontSize: 12.5, color: "var(--navy-500)", marginTop: 2, lineHeight: 1.45 }}>{hint}</div>}
      </div>
      <div style={{ flexShrink: 0, maxWidth: "100%" }}>{value}</div>
    </div>
  );
}

function Pill({ children, tone = "ok" }: { children: ReactNode; tone?: PlanUsageTone }) {
  return (
    <span
      style={{
        display: "inline-block",
        fontSize: 13,
        fontWeight: 600,
        padding: "6px 12px",
        borderRadius: 999,
        whiteSpace: "nowrap",
        ...TONE_STYLE[tone],
      }}
    >
      {children}
    </span>
  );
}

const FALLBACK_STATUS: Record<SubscriptionStatus, { label: string; tone: PlanUsageTone }> = {
  ACTIVE: { label: "Activa", tone: "ok" },
  TRIALING: { label: "En prueba", tone: "info" },
  PAST_DUE: { label: "Pago pendiente", tone: "warn" },
  CANCELLED: { label: "Cancelada", tone: "warn" },
};

export function PlanUsagePanel({
  usage,
  overview,
  modules,
  choices,
  vertical = "KINESIOLOGY",
  readOnly = false,
  onContactSales,
  onGoToBilling,
}: {
  usage: TenantPlanUsageView | null;
  overview: Pick<BillingOverview, "plan" | "planLabel" | "effectivePriceCents" | "subscriptionStatus" | "customPriceCents">;
  /** Módulos del consultorio hoy (`modulesFor(actor.entitlements)`). */
  modules: readonly TenantModule[];
  choices: readonly PlanChoice[];
  vertical?: TenantVertical;
  readOnly?: boolean;
  onContactSales?: (draft: SupportDraft) => void;
  onGoToBilling?: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const plan = usage?.plan ?? overview.plan;
  const planLabel = usage?.planLabel ?? overview.planLabel;
  const status = planStatusView(
    usage?.subscription ?? { ...FALLBACK_STATUS[overview.subscriptionStatus], detail: null, contact: null },
    readOnly
  );
  const included = moduleLabels(modules);
  const total = usage?.seats.byKind.total ?? null;
  return (
    <Card style={{ padding: 20 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <EyebrowLabel>Plan y uso</EyebrowLabel>
        <Button type="button" onClick={() => setOpen(true)} data-plan-change>
          Cambiar de plan
        </Button>
      </div>
      <div style={{ marginTop: 8 }}>
        <Row
          label="Plan"
          hint={
            overview.effectivePriceCents != null
              ? `${formatARS(overview.effectivePriceCents)} por mes${overview.customPriceCents != null ? " (precio acordado para tu consultorio)" : ""}.`
              : "Precio a confirmar: te lo contamos antes del primer cargo."
          }
          value={<Pill>{planLabel}</Pill>}
        />
        <Row
          label="Estado"
          hint={
            status.detail || status.cta || status.readOnly ? (
              <>
                {status.detail}
                {status.cta && (
                  <>
                    {status.detail ? " " : ""}
                    {status.cta}
                  </>
                )}
                {status.readOnly && <span style={{ display: "block", marginTop: 4 }}>{READ_ONLY_PLAN_COPY}</span>}
              </>
            ) : null
          }
          value={
            <span data-plan-status={status.label} style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
              <Pill tone={status.tone}>{status.label}</Pill>
              {status.readOnly && <Pill tone="warn">Solo lectura</Pill>}
            </span>
          }
        />
        <Row
          label="Usuarios del plan"
          hint={
            usage ? (
              <>
                {usage.seats.custom && "Tu consultorio tiene cupos a medida. "}
                {usage.seats.lines
                  .filter((l) => l.kind !== "total")
                  .map((l) => `${l.label}: ${l.used}`)
                  .join(" · ")}
                {usage.seats.detail ? `. ${usage.seats.detail}` : ""}
              </>
            ) : (
              "No pudimos cargar el detalle de usuarios. Recargá la página."
            )
          }
          value={
            total ? (
              <span data-seats={planSeatsLabel(plan, total)}>
                <Pill tone={usage?.seats.full ? "warn" : "ok"}>{planSeatsLabel(plan, total)}</Pill>
              </span>
            ) : null
          }
        />
        <Row
          label="Incluye"
          value={null}
          hint={
            <span data-modules style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
              {included.map((m) => (
                <Tag key={m} tone="soft">
                  {m}
                </Tag>
              ))}
            </span>
          }
        />
        {usage && (
          <Row
            label="Turnos online"
            hint="Se prenden y se apagan en General → Funciones del consultorio."
            value={<Tag tone={usage.publicBookingEnabled ? "lime" : "soft"}>{usage.publicBookingEnabled ? "Activos" : "Apagados"}</Tag>}
          />
        )}
      </div>
      {onGoToBilling && (
        <p style={{ margin: "12px 0 0", fontSize: 13, color: "var(--navy-700)", lineHeight: 1.45 }}>
          Cargos, pagos y comprobantes están en{" "}
          <button
            type="button"
            onClick={onGoToBilling}
            style={{ border: "none", background: "none", padding: 0, font: "inherit", color: "var(--sky-700)", fontWeight: 600, cursor: "pointer" }}
          >
            Facturación
          </button>
          .
        </p>
      )}
      <PlanChangeDrawer
        open={open}
        onClose={() => setOpen(false)}
        currentPlan={plan}
        choices={choices}
        vertical={vertical}
        trialing={overview.subscriptionStatus === "TRIALING"}
        usersNow={total?.used ?? null}
        onContactSales={(d) => onContactSales?.(d)}
        // refresh-ok: el plan cambia los módulos del shell (nav, salas, sala de espera); el `revalidatePath` de la
        // action trae la página pero no re-renderiza el layout `(app)`.
        onChanged={() => router.refresh()}
      />
    </Card>
  );
}
