"use client";

import { sameHighlight, type AgendaHighlight } from "@/lib/agenda-highlight";
import { AGENDA_PLAN_SCOPE_LABEL, planScopeHighlight, type PlanScopeCounts } from "@/lib/agenda-filters";

/**
 * Leyenda "Turnos: De plan · Sueltos" de la agenda (S19b, ES3 · plan §3.4).
 *
 * Reusa el resaltado de la leyenda de servicios: click = levantar esos turnos
 * y atenuar el resto (no oculta nada); el mismo ítem activo lo apaga (= Todos).
 * Selección única compartida con la leyenda de servicios: elegir un servicio
 * reemplaza a "De plan" y viceversa (`toggleHighlight`).
 *
 * Canal NO cromático (AGENTS §5: el color de la agenda es del servicio y del
 * estado): cada ítem lleva un glifo de forma, no de color. "De plan" = una
 * pastilla `n/N` como el chip de sesión de las cards; "Sueltos" = un círculo
 * punteado (sin plan). El texto dice qué es.
 *
 * Presentacional: el gate de módulo (`has('planes')`) y la persistencia los
 * decide `agenda-client`. No recibe títulos de plan ni datos clínicos: solo
 * cuenta turnos con `programId` (la Secretaria lo ve igual que el chip).
 */
export function PlanLegend({
  highlight,
  onToggle,
  counts,
}: {
  highlight: AgendaHighlight | null;
  onToggle: (h: AgendaHighlight) => void;
  /** Conteo del alcance de la vista (día o semana), sin cancelados. */
  counts?: PlanScopeCounts | null;
}) {
  const items = (["plan", "loose"] as const).map((scope) => ({
    scope,
    own: planScopeHighlight(scope) as AgendaHighlight,
    count: counts ? counts[scope] : null,
  }));
  return (
    <div
      role="group"
      aria-label="Resaltar turnos de plan o sueltos"
      style={{
        display: "inline-flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 8,
      }}
    >
      <span style={groupLabel}>Turnos</span>
      {items.map(({ scope, own, count }) => {
        const active = sameHighlight(highlight, own);
        const label = AGENDA_PLAN_SCOPE_LABEL[scope];
        return (
          <button
            key={scope}
            type="button"
            data-plan-scope={scope}
            aria-pressed={active}
            // P3.Z (F3a): el conteo se anuncia con el nombre del botón. Antes iba
            // en un `aria-label` de un <span> sin role, que los lectores ignoran.
            aria-label={count != null ? planLegendAriaLabel(label, count) : undefined}
            onClick={() => onToggle(own)}
            title={
              active
                ? "Quitar resaltado"
                : scope === "plan"
                  ? "Resaltar los turnos que son sesiones de un plan"
                  : "Resaltar los turnos sueltos (sin plan)"
            }
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "4px 10px",
              borderRadius: 999,
              border: "1px solid " + (active ? "var(--navy-900)" : "rgba(15,30,51,0.12)"),
              background: active ? "rgba(15,30,51,0.06)" : "transparent",
              fontSize: 11.5,
              fontWeight: 600,
              color: "var(--navy-700)",
              cursor: "pointer",
            }}
          >
            {scope === "plan" ? <PlanGlyph /> : <LooseGlyph />}
            {label}
            {count != null && <span style={{ color: "var(--navy-500)", fontWeight: 600 }}>{count}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** "De plan, 5 turnos" / "Sueltos, 1 turno". */
export function planLegendAriaLabel(label: string, count: number): string {
  return `${label}, ${count} ${count === 1 ? "turno" : "turnos"}`;
}

/** Pastilla `n/N`: la forma del chip de sesión de las cards, en neutro. */
function PlanGlyph() {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "0 4px",
        borderRadius: 999,
        border: "1px solid var(--navy-500)",
        fontSize: 9,
        fontWeight: 700,
        lineHeight: 1.3,
        color: "var(--navy-700)",
        background: "#fff",
      }}
    >
      n/N
    </span>
  );
}

/** Círculo punteado: turno sin plan. */
function LooseGlyph() {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 10,
        height: 10,
        borderRadius: 999,
        border: "1.5px dashed var(--navy-500)",
        flexShrink: 0,
        boxSizing: "border-box",
      }}
    />
  );
}

const groupLabel: React.CSSProperties = {
  fontSize: 10.5,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--navy-300)",
  marginRight: 4,
};
