"use client";

import { useEffect, useRef, useState } from "react";
import {
  AGENDA_PLAN_SCOPES,
  AGENDA_PLAN_SCOPE_LABEL,
  type AgendaPlanScope,
  type AgendaVisibility,
} from "@/lib/agenda-filters";
import type { AgendaViewZoom } from "@/lib/preferences-constants";
import { useAlertPrefs } from "@/components/providers/arrival-alerts";
import { AlertModeControl, SOUND_BLOCKED_NOTE } from "@/components/realtime/alert-prefs-controls";

const ZOOMS: ReadonlyArray<AgendaViewZoom> = [15, 30, 60];

// ──────────────────────────────────────────────────────────────────────
// View Options dropdown — small menu next to the day/week/list switch
//
// B4.3: la densidad ahora se guarda por usuario (`agendaPrefs.density`) y se
// suma el ZOOM de franja 15/30/60 (`agendaPrefs.zoom`, plan §11.3 punto 6).
// El zoom solo se ofrece donde aplica (`zoom` presente = vista Por
// profesional): Día y Semana siguen con `Tenant.agendaSlotMinutes` para no
// cambiarle la grilla a quien no eligió nada.
//
// S19b (ES3): "Turnos: Todos / De plan / Sueltos". Es el mismo resaltado que
// la leyenda "Turnos" de abajo de la agenda (no oculta: atenúa). Solo aparece
// si `agenda-client` pasa `planScope` (módulo `planes`).
//
// SV11b: sección «Avisos» con el mismo control que Configuración → General
// («Avisos de la sala de espera»). Lee y escribe por `useAlertPrefs()` (el
// provider de `AppShell`), así no suma props que `agenda-client` (SV09) tenga
// que pasar, y los dos controles comparten estado.
// ──────────────────────────────────────────────────────────────────────

export function ViewOptionsMenu({
  density,
  setDensity,
  visibility,
  setVisibility,
  zoom,
  setZoom,
  planScope,
  setPlanScope,
}: {
  density: "comfortable" | "compact";
  setDensity: (d: "comfortable" | "compact") => void;
  /** A2b-S-ui: "Mostrar cancelados" / "Mostrar ausentes" (por defecto prendidos). */
  visibility: AgendaVisibility;
  setVisibility: (v: AgendaVisibility) => void;
  /** Franja de la grilla en minutos; sin valor no se muestra el control. */
  zoom?: AgendaViewZoom | null;
  setZoom?: (z: AgendaViewZoom) => void;
  /** S19b: resaltado de plan/sueltos; sin valor (sin módulo `planes`) no se muestra. */
  planScope?: AgendaPlanScope | null;
  setPlanScope?: (s: AgendaPlanScope) => void;
}) {
  // El punto avisa que la agenda no se ve "entera": turnos ocultos o un
  // resaltado de plan que atenúa al resto (se recuerda entre recargas).
  const filtering = isViewFiltered(visibility, planScope);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="true"
        aria-expanded={open}
        className="k-glass"
        style={{
          height: 36,
          padding: "0 12px",
          borderRadius: 999,
          border: "none",
          fontSize: 12.5,
          fontWeight: 600,
          color: "var(--navy-700)",
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        Vista
        {/* Punto = hay turnos filtrados: que el filtro no quede "olvidado". */}
        {filtering && (
          <span
            aria-label="Hay filtros activos"
            style={{ width: 6, height: 6, borderRadius: 999, background: "var(--sky-700)" }}
          />
        )}
        <span style={{ fontSize: 9, color: "var(--navy-300)" }}>▾</span>
      </button>
      {open && (
        <div
          role="menu"
          className="k-glass-strong"
          style={{
            position: "absolute",
            top: 44,
            right: 0,
            // SV11b: 264 (antes 240) para que «Visual y sonido» entre en el segmentado de Avisos.
            width: 264,
            maxHeight: "min(75vh, 620px)",
            overflowY: "auto",
            borderRadius: 14,
            padding: 10,
            zIndex: 25,
          }}
        >
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
                  style={{
                    flex: 1,
                    padding: "6px 10px",
                    borderRadius: 999,
                    border: "none",
                    fontSize: 11.5,
                    fontWeight: 600,
                    background: on ? "#fff" : "transparent",
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
                      style={{
                        flex: 1,
                        padding: "6px 10px",
                        borderRadius: 999,
                        border: "none",
                        fontSize: 11.5,
                        fontWeight: 600,
                        background: on ? "#fff" : "transparent",
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
                      style={{
                        flex: 1,
                        padding: "6px 8px",
                        borderRadius: 999,
                        border: "none",
                        fontSize: 11.5,
                        fontWeight: 600,
                        background: on ? "#fff" : "transparent",
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
        </div>
      )}
    </div>
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

/** ¿Hay algo que cambia lo que se ve? (punto del botón "Vista"). */
export function isViewFiltered(visibility: AgendaVisibility, planScope?: AgendaPlanScope | null): boolean {
  return !visibility.showCancelled || !visibility.showNoShow || (planScope != null && planScope !== "all");
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
