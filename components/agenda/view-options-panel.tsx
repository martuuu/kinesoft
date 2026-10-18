"use client";

import dynamic from "next/dynamic";
import { AGENDA_PLAN_SCOPES, AGENDA_PLAN_SCOPE_LABEL, type AgendaPlanScope, type AgendaVisibility } from "@/lib/agenda-filters";
import type { AgendaViewZoom } from "@/lib/preferences-constants";
import { useAlertPrefs } from "@/components/providers/arrival-alerts";
import { SOUND_BLOCKED_NOTE } from "@/components/providers/arrival-alerts-constants";

/**
 * [AS-0z] T3a-0z3 · Contenido del menú «Vista» de la agenda (densidad, franja, turnos de plan, mostrar, avisos).
 *
 * Por qué es un archivo aparte: solo se ve con el menú abierto (después de un click), así que no tiene por qué estar en
 * el first load de /agenda (178,1/180 kB gz al arrancar T3; meta de T3a ≤ 173,1). `ViewOptionsMenu` deja en el first
 * load el botón «Vista» y el punto de «filtros activos» (se ven al cargar y se dibujan en el server), y este panel baja
 * con `import()` precargado en hover/foco del botón. Comportamiento y markup: los de antes, tal cual (el historial de
 * cada sección sigue en el comentario de `view-options-menu.tsx`).
 */

// PF1-Z (C-PF2): el control de avisos es lo único con un chunk propio adentro del panel (lo comparte con Configuración
// → General). Se sigue precargando en hover/foco del botón «Vista» (`preloadAlertControls`, lo llama el menú cuando
// llega este módulo). El esqueleto tiene el alto del control compacto (segmentado + «Probar sonido») para que el menú
// no salte.
const loadAlertControls = () => import("@/components/realtime/alert-prefs-controls");
export const preloadAlertControls = () => void loadAlertControls();
const AlertModeControl = dynamic(() => loadAlertControls().then((m) => m.AlertModeControl), {
  ssr: false,
  loading: () => <div aria-hidden className="k-skel" style={{ height: 68, borderRadius: 8 }} />,
});

const ZOOMS: ReadonlyArray<AgendaViewZoom> = [15, 30, 60];

export type ViewOptionsPanelProps = {
  density: "comfortable" | "compact";
  setDensity: (d: "comfortable" | "compact") => void;
  visibility: AgendaVisibility;
  setVisibility: (v: AgendaVisibility) => void;
  zoom?: AgendaViewZoom | null;
  setZoom?: (z: AgendaViewZoom) => void;
  planScope?: AgendaPlanScope | null;
  setPlanScope?: (s: AgendaPlanScope) => void;
};

export function ViewOptionsPanel({
  density,
  setDensity,
  visibility,
  setVisibility,
  zoom,
  setZoom,
  planScope,
  setPlanScope,
}: ViewOptionsPanelProps) {
  return (
    <>
      <div style={menuLabel}>Densidad</div>
      <div
        style={{
          display: "flex",
          padding: 3,
          borderRadius: 999,
          background: "rgba(15,30,51,0.04)",
          marginBottom: 10,
        }}
      >
        {(["comfortable", "compact"] as const).map((d) => {
          const on = density === d;
          return (
            <button
              key={d}
              type="button"
              onClick={() => setDensity(d)}
              className="k-tap-m"
              style={{
                flex: 1,
                padding: "6px 10px",
                borderRadius: 999,
                border: "none",
                fontSize: 11.5,
                fontWeight: 600,
                background: on ? "var(--card-bg)" : "transparent",
                color: on ? "var(--navy-900)" : "var(--navy-500)",
                cursor: "pointer",
              }}
            >
              {d === "comfortable" ? "Cómoda" : "Compacta"}
            </button>
          );
        })}
      </div>
      {zoom != null && setZoom && (
        <>
          <div style={menuLabel}>Franja</div>
          <div
            role="radiogroup"
            aria-label="Duración de cada fila"
            style={{
              display: "flex",
              padding: 3,
              borderRadius: 999,
              background: "rgba(15,30,51,0.04)",
              marginBottom: 10,
            }}
          >
            {ZOOMS.map((z) => {
              const on = zoom === z;
              return (
                <button
                  key={z}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setZoom(z)}
                  className="k-tap-m"
                  style={{
                    flex: 1,
                    padding: "6px 10px",
                    borderRadius: 999,
                    border: "none",
                    fontSize: 11.5,
                    fontWeight: 600,
                    background: on ? "var(--card-bg)" : "transparent",
                    color: on ? "var(--navy-900)" : "var(--navy-500)",
                    cursor: "pointer",
                  }}
                >
                  {z} min
                </button>
              );
            })}
          </div>
        </>
      )}
      {planScope != null && setPlanScope && (
        <>
          <div style={menuLabel}>Turnos</div>
          <div
            role="radiogroup"
            aria-label="Resaltar turnos de plan o sueltos"
            style={{
              display: "flex",
              padding: 3,
              borderRadius: 999,
              background: "rgba(15,30,51,0.04)",
              marginBottom: 4,
            }}
          >
            {AGENDA_PLAN_SCOPES.map((sc) => {
              const on = planScope === sc;
              return (
                <button
                  key={sc}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setPlanScope(sc)}
                  className="k-tap-m"
                  style={{
                    flex: 1,
                    padding: "6px 8px",
                    borderRadius: 999,
                    border: "none",
                    fontSize: 11.5,
                    fontWeight: 600,
                    background: on ? "var(--card-bg)" : "transparent",
                    color: on ? "var(--navy-900)" : "var(--navy-500)",
                    cursor: "pointer",
                  }}
                >
                  {AGENDA_PLAN_SCOPE_LABEL[sc]}
                </button>
              );
            })}
          </div>
          <div style={{ fontSize: 11, color: "var(--navy-300)", padding: "0 4px 10px", lineHeight: 1.4 }}>
            Resalta esos turnos y atenúa el resto; no oculta ninguno.
          </div>
        </>
      )}
      <div style={menuLabel}>Mostrar</div>
      <div style={{ display: "grid", gap: 2, marginBottom: 10 }}>
        <ToggleRow
          label="Mostrar cancelados"
          checked={visibility.showCancelled}
          onChange={(v) => setVisibility({ ...visibility, showCancelled: v })}
        />
        <ToggleRow
          label="Mostrar ausentes"
          checked={visibility.showNoShow}
          onChange={(v) => setVisibility({ ...visibility, showNoShow: v })}
        />
      </div>
      <AvisosMenuSection />
      <div style={{ fontSize: 11.5, color: "var(--navy-300)", padding: "2px 4px", lineHeight: 1.4 }}>
        El encabezado de días (tira + grilla) se controla desde Tweaks → «Vista semanal».
      </div>
    </>
  );
}

/**
 * SV11b: «Avisos» del menú. Solo las filas que le aplican al usuario; ninguna
 * (BILLING, fuera del provider) → no se muestra. Sin canal realtime tampoco
 * (FX2b, M4): en el menú de la agenda sería un control que no hace nada; la
 * preferencia se puede dejar elegida en Configuración → General.
 */
export function AvisosMenuSection() {
  const a = useAlertPrefs();
  if (!a.live || (!a.appliesArrival && !a.appliesCall)) return null;
  return (
    <>
      <div style={menuLabel}>Avisos</div>
      <div style={{ display: "grid", gap: 8, marginBottom: 10 }}>
        {a.appliesArrival && (
          <div style={{ display: "grid", gap: 4 }}>
            <div style={menuItemText}>Cuando llega un paciente mío</div>
            <AlertModeControl
              compact
              label="Cuando llega un paciente mío"
              value={a.arrivalAlert}
              onChange={a.setArrivalAlert}
            />
          </div>
        )}
        {a.appliesCall && (
          <div style={{ display: "grid", gap: 4 }}>
            <div style={menuItemText}>Cuando un profesional llama a un paciente</div>
            <AlertModeControl
              compact
              label="Cuando un profesional llama a un paciente"
              value={a.callAlert}
              onChange={a.setCallAlert}
            />
          </div>
        )}
        <div style={{ fontSize: 11, color: "var(--navy-500)", padding: "0 4px", lineHeight: 1.4 }}>
          {SOUND_BLOCKED_NOTE}
        </div>
      </div>
    </>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      role="menuitemcheckbox"
      aria-checked={checked}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        padding: "6px 4px",
        borderRadius: 8,
        fontSize: 12.5,
        fontWeight: 600,
        color: "var(--navy-700)",
        cursor: "pointer",
      }}
    >
      {label}
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

const menuLabel: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--navy-300)",
  padding: "0 4px 6px",
};

const menuItemText: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--navy-700)",
  padding: "0 4px",
};
