"use client";

import { motion } from "framer-motion";
import { DUR, EASE_OUT } from "@/lib/motion";
import { Button } from "@/components/ui/button";
import { IconChevL, IconChevR, IconPlus } from "@/components/ui/icons";
import type { AgendaVisibility } from "@/lib/agenda-filters";
import type { ViewSegment } from "@/lib/agenda-client-state";
import type { AgendaViewZoom } from "@/lib/preferences-constants";
import { ViewOptionsMenu } from "./view-options-menu";

export type { AgendaView } from "@/lib/agenda-client-state";
export type AgendaDensity = "comfortable" | "compact";

const SEGMENT_LABEL: Record<ViewSegment, string> = {
  day: "Día",
  week: "Semana",
  list: "Lista",
  reception: "Recepción",
};

/**
 * Encabezado de la agenda (B1.5b: sale de `agenda-client.tsx`): título con la
 * fecha, aviso de turnos ocultos, navegación por semana, selector Día / Semana /
 * Lista, filtro de profesional, opciones de vista (densidad + toggles de
 * cancelados / ausentes), export .ics y "Nuevo turno".
 *
 * Contrato: presentacional. No toca el router ni localStorage: cada control
 * avisa por callback y `agenda-client` decide (navegar, persistir). Para sumar
 * controles (B4: chips de profesional, sede, modo recepción) se agregan props
 * opcionales acá y se cablean en `agenda-client`; no se mete estado propio.
 *
 * - `anchor`: el día ancla (título).
 * - `hiddenLabel`: texto "N turnos ocultos" o `null`; `onShowAll` lo resetea.
 * - `onNavigateWeeks(delta)`: ±7 días desde el ancla; `onToday`: hoy.
 * - `practitioners` / `practitionerFilterId` / `onPractitionerFilterChange(id | "")`:
 *   el select solo aparece con más de un profesional; `""` = todos.
 * - `exportFromKey`: AR date key ("YYYY-MM-DD") del lunes de la semana para el .ics.
 *
 * B4.3 (agenda multi-profesional):
 * - `segment` / `segments` / `onSegmentChange`: selector Día / Semana / Lista
 *   (+ Recepción con `agenda.reception`). "Día" agrupa la línea de tiempo y la
 *   vista Por profesional; cuál se ve lo decide el `modeToggle`.
 * - `modeToggle`: el `<ModeToggle>` de B4.2 (Por día ↔ Por profesional), solo
 *   en el Día y con más de un profesional; lo arma `agenda-client`.
 * - `practitionerChips`: los `<PractitionerChips>` (multi-select + favoritos)
 *   en una segunda fila a todo el ancho. Si vienen, reemplazan al select
 *   "Todos los profesionales" de siempre.
 * - `locationFilter`: el `<LocationFilter>` (no dibuja nada con una sede).
 * - `dayLock`: el candado del día (Día/Lista) junto al título.
 * - `zoom`/`onZoomChange`: franja 15/30/60 en el menú Vista (solo Por profesional).
 */
export function AgendaToolbar({
  anchor,
  segment,
  segments,
  onSegmentChange,
  hiddenLabel,
  onShowAll,
  onNavigateWeeks,
  onToday,
  practitioners,
  practitionerFilterId,
  onPractitionerFilterChange,
  density,
  onDensityChange,
  visibility,
  onVisibilityChange,
  exportFromKey,
  onCreate,
  modeToggle,
  practitionerChips,
  locationFilter,
  dayLock,
  zoom,
  onZoomChange,
}: {
  anchor: Date;
  segment: ViewSegment;
  segments: ReadonlyArray<ViewSegment>;
  onSegmentChange: (s: ViewSegment) => void;
  hiddenLabel: string | null;
  onShowAll: () => void;
  onNavigateWeeks: (deltaWeeks: -1 | 1) => void;
  onToday: () => void;
  practitioners: { id: string; name: string }[];
  practitionerFilterId: string | null;
  onPractitionerFilterChange: (practitionerId: string) => void;
  density: AgendaDensity;
  onDensityChange: (d: AgendaDensity) => void;
  visibility: AgendaVisibility;
  onVisibilityChange: (v: AgendaVisibility) => void;
  exportFromKey: string;
  onCreate: () => void;
  modeToggle?: React.ReactNode;
  practitionerChips?: React.ReactNode;
  locationFilter?: React.ReactNode;
  dayLock?: React.ReactNode;
  zoom?: AgendaViewZoom | null;
  onZoomChange?: (z: AgendaViewZoom) => void;
}) {
  return (
    <header style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 12, color: "var(--navy-300)", fontWeight: 500 }}>Agenda</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <h1 className="k-display" style={{ fontSize: 30, margin: "2px 0 0" }}>
              {anchor.toLocaleDateString("es-AR", { weekday: "long", day: "2-digit", month: "long", timeZone: "America/Argentina/Buenos_Aires" })}
            </h1>
            {dayLock}
          </div>
          {hiddenLabel && (
            <div
              role="status"
              style={{
                marginTop: 4,
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 12,
                color: "var(--navy-500)",
              }}
            >
              <span>{hiddenLabel}</span>
              <button
                type="button"
                onClick={onShowAll}
                style={{
                  border: "none",
                  background: "transparent",
                  padding: 0,
                  fontSize: 12,
                  fontWeight: 600,
                  color: "var(--sky-700)",
                  cursor: "pointer",
                }}
              >
                Mostrar todos
              </button>
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {/* Week nav cluster — consistent 36 px height for all three controls */}
          <div
            className="k-glass"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 2,
              padding: 3,
              borderRadius: 999,
              height: 36,
            }}
          >
            <motion.button
              whileTap={{ scale: 0.9 }}
              onClick={() => onNavigateWeeks(-1)}
              aria-label="Semana anterior"
              style={navPillBtn}
            >
              <IconChevL size={14} />
            </motion.button>
            <motion.button
              whileTap={{ scale: 0.94 }}
              onClick={onToday}
              style={{
                ...navPillBtn,
                width: "auto",
                padding: "0 14px",
                fontSize: 12.5,
                fontWeight: 600,
              }}
            >
              Hoy
            </motion.button>
            <motion.button
              whileTap={{ scale: 0.9 }}
              onClick={() => onNavigateWeeks(1)}
              aria-label="Semana siguiente"
              style={navPillBtn}
            >
              <IconChevR size={14} />
            </motion.button>
          </div>

          {/* View switch */}
          <div
            className="k-glass"
            style={{
              display: "inline-flex",
              alignItems: "center",
              borderRadius: 999,
              padding: 3,
              height: 36,
            }}
          >
            {segments.map((v) => {
              const on = segment === v;
              const label = SEGMENT_LABEL[v];
              return (
                <motion.button
                  key={v}
                  whileTap={{ scale: 0.95 }}
                  aria-pressed={on}
                  onClick={() => onSegmentChange(v)}
                  style={{
                    position: "relative",
                    height: 30,
                    padding: "0 14px",
                    borderRadius: 999,
                    border: "none",
                    fontSize: 12.5,
                    fontWeight: 600,
                    background: "transparent",
                    color: on ? "#fff" : "var(--navy-500)",
                    cursor: "pointer",
                  }}
                >
                  {on && (
                    <motion.span
                      layoutId="agenda-view-pill"
                      transition={{ duration: DUR.base, ease: EASE_OUT }}
                      style={{
                        position: "absolute",
                        inset: 0,
                        borderRadius: 999,
                        background: "var(--navy-900)",
                        zIndex: 0,
                      }}
                    />
                  )}
                  <span style={{ position: "relative", zIndex: 1 }}>{label}</span>
                </motion.button>
              );
            })}
          </div>

          {modeToggle}

          {!practitionerChips && practitioners.length > 1 && (
            <select
              value={practitionerFilterId ?? ""}
              onChange={(e) => onPractitionerFilterChange(e.target.value)}
              aria-label="Filtrar por profesional"
              style={{
                height: 36,
                padding: "0 12px",
                borderRadius: 999,
                fontSize: 12.5,
                fontWeight: 600,
                border: "1px solid rgba(15,30,51,0.08)",
                background: "rgba(255,255,255,0.7)",
                color: "var(--navy-700)",
              }}
            >
              <option value="">Todos los profesionales</option>
              {practitioners.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}

          {locationFilter}

          <ViewOptionsMenu
            density={density}
            setDensity={onDensityChange}
            visibility={visibility}
            setVisibility={onVisibilityChange}
            zoom={zoom}
            setZoom={onZoomChange}
          />

          <a
            href={`/api/agenda/export?from=${exportFromKey}`}
            target="_blank"
            rel="noopener noreferrer"
            title="Exportar semana a .ics"
            style={{ textDecoration: "none" }}
          >
            <Button variant="ghost" style={{ height: 36, padding: "0 14px" }}>
              .ics
            </Button>
          </a>
          <Button
            variant="primary"
            onClick={onCreate}
            style={{ height: 36, padding: "0 18px" }}
          >
            <IconPlus size={14} /> Nuevo turno
          </Button>
        </div>
      </div>
      {practitionerChips}
    </header>
  );
}

const navPillBtn: React.CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 999,
  background: "transparent",
  border: "none",
  cursor: "pointer",
  color: "var(--navy-700)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};
