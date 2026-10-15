import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { SupportContact } from "@/components/ui/support-contact";
import type { PlanUsageTone, TenantPlanUsageView } from "@/lib/tenant-plan-usage-logic";

/**
 * Configuración → «Plan y uso» (BO3-F; PL-1d: plan SaaS y cupos por tipo). Solo informa: plan, estado de la
 * suscripción y la prueba, usuarios por tipo (profesionales / no clínicos / total, `seats.lines` de PL-1c) y turnero.
 * Desde PL-1c la Secretaria, Facturación y el Titular que no atiende SÍ ocupan lugar (PL-D3): se sacó la fila «no
 * ocupan lugar». El cambio de plan y Facturación los suma PL-3a. Sin billing: cambiar de plan lo hace el equipo de KineSoft desde Plataforma, así que el
 * llamado es «escribinos» con el canal real (`SupportContact`, BO-Z B4: antes no decía a dónde). El copy sale armado de `planUsageView` (lib/tenant-plan-usage-logic.ts, puro y testeado
 * en TZ=UTC y TZ=AR); acá no se calcula nada.
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
        {hint && (
          <div style={{ fontSize: 12.5, color: "var(--navy-500)", marginTop: 2, lineHeight: 1.45 }}>{hint}</div>
        )}
      </div>
      <div style={{ flexShrink: 0 }}>{value}</div>
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

export function PlanUsagePanel({
  usage,
  supportEmail,
}: {
  usage: TenantPlanUsageView;
  /** Solo para el render test; si no, `NEXT_PUBLIC_SUPPORT_EMAIL`. */
  supportEmail?: string | null;
}) {
  const { subscription, seats } = usage;
  return (
    <Card style={{ padding: 20 }}>
      <EyebrowLabel>Plan y uso</EyebrowLabel>
      <div style={{ marginTop: 8 }}>
        <Row label="Plan" value={<Pill>{usage.planLabel}</Pill>} />
        <Row
          label="Suscripción"
          hint={
            subscription.detail || subscription.contact ? (
              <>
                {subscription.detail}
                {subscription.contact && (
                  <>
                    {subscription.detail ? " " : ""}
                    <SupportContact capital email={supportEmail} subject="Plan del consultorio" /> {subscription.contact}.
                  </>
                )}
              </>
            ) : null
          }
          value={
            <span data-subscription-tone={subscription.tone}>
              <Pill tone={subscription.tone}>{subscription.label}</Pill>
            </span>
          }
        />
        <Row
          label="Usuarios del plan"
          hint={
            <>
              {seats.custom && "Tu consultorio tiene cupos a medida. "}
              {seats.detail}
            </>
          }
          value={
            <span data-seats={seats.value} style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "flex-end" }}>
              {seats.lines.map((l) => (
                <span key={l.kind} data-seat-kind={l.kind}>
                  <Pill tone={l.full ? "warn" : "ok"}>{l.value}</Pill>
                </span>
              ))}
            </span>
          }
        />
        <Row
          label="Turnos online"
          hint="Se prende y se apaga en General → Funciones del consultorio."
          value={<Tag tone={usage.publicBookingEnabled ? "lime" : "soft"}>{usage.publicBookingEnabled ? "Activos" : "Apagados"}</Tag>}
        />
      </div>
      <p
        style={{
          margin: "12px 0 0",
          padding: 12,
          borderRadius: "var(--r-sm)",
          background: "rgba(15,30,51,0.04)",
          fontSize: 13,
          color: "var(--navy-700)",
          lineHeight: 1.45,
        }}
      >
        Para cambiar de plan o ampliar los cupos, <SupportContact email={supportEmail} subject="Plan del consultorio" />: lo
        hacemos por vos.
      </p>
    </Card>
  );
}
