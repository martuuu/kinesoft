"use client";

import { useState } from "react";
import { m } from "framer-motion";
import { DUR, EASE_OUT } from "@/lib/motion";
import { Button, buttonClassName } from "@/components/ui/button";
import { IconChevL, IconChevR, IconPlus } from "@/components/ui/icons";
import type { AgendaPlanScope, AgendaVisibility } from "@/lib/agenda-filters";
import type { ViewSegment } from "@/lib/agenda-client-state";
import type { AgendaViewZoom } from "@/lib/preferences-constants";
import { ViewOptionsMenu } from "./view-options-menu";
import styles from "./agenda-toolbar.module.css";

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
 *
 * PF1.1-agenda-a:
 * - C-PF1: sin `motion.button` (el `whileTap` es CSS `:active`) y la pastilla del
 *   selector es `m.span` con clase (S5). Estilos en `agenda-toolbar.module.css`.
 * - G9: < 480 px «.ics» y «Vista» quedan detrás de «⋯» y «Nuevo turno» se ve
 *   siempre. ≥ 480 no cambia nada.
 * - «.ics» era un `<a>` con un `<button>` adentro (interactivo anidado): ahora
 *   es el link con el look de botón (`buttonClassName`).
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
  planScope,
  onPlanScopeChange,
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
  /** S19b: alcance De plan / Sueltos (null = sin módulo planes). */
  planScope?: AgendaPlanScope | null;
  onPlanScopeChange?: (s: AgendaPlanScope) => void;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  return (
    <header className={styles.header}>
      <div className={styles.topRow}>
        <div className={styles.titleBlock}>
          <div className={styles.eyebrow}>Agenda</div>
          <div className={styles.titleRow}>
            <h1 className={`k-display ${styles.title}`}>
              {anchor.toLocaleDateString("es-AR", { weekday: "long", day: "2-digit", month: "long", timeZone: "America/Argentina/Buenos_Aires" })}
            </h1>
            {dayLock}
          </div>
          {hiddenLabel && (
            <div role="status" className={styles.hidden}>
              <span>{hiddenLabel}</span>
              <button type="button" onClick={onShowAll} className={styles.linkBtn}>
                Mostrar todos
              </button>
            </div>
          )}
        </div>
        <div className={styles.actions}>
          {/* Navegación de semana: los tres controles a 36 px de alto. */}
          <div className={`k-glass ${styles.pillGroup}`}>
            <button type="button" onClick={() => onNavigateWeeks(-1)} aria-label="Semana anterior" className={styles.navBtn}>
              <IconChevL size={14} />
            </button>
            <button type="button" onClick={onToday} className={`${styles.navBtn} ${styles.navBtnText}`}>
              Hoy
            </button>
            <button type="button" onClick={() => onNavigateWeeks(1)} aria-label="Semana siguiente" className={styles.navBtn}>
              <IconChevR size={14} />
            </button>
          </div>

          {/* Selector de vista */}
          <div className={`k-glass ${styles.pillGroup}`} role="group" aria-label="Vista de la agenda">
            {segments.map((v) => {
              const on = segment === v;
              return (
                <button
                  key={v}
                  type="button"
                  aria-pressed={on}
                  onClick={() => onSegmentChange(v)}
                  className={styles.segBtn}
                >
                  {on && (
                    <m.span
                      layoutId="agenda-view-pill"
                      transition={{ duration: DUR.base, ease: EASE_OUT }}
                      className={styles.segPill}
                    />
                  )}
                  <span className={styles.segLabel}>{SEGMENT_LABEL[v]}</span>
                </button>
              );
            })}
          </div>

          {modeToggle}

          {!practitionerChips && practitioners.length > 1 && (
            <select
              value={practitionerFilterId ?? ""}
              onChange={(e) => onPractitionerFilterChange(e.target.value)}
              aria-label="Filtrar por profesional"
              className={styles.select}
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

          <button
            type="button"
            className={styles.moreBtn}
            aria-expanded={moreOpen}
            aria-controls="agenda-toolbar-more"
            aria-label={moreOpen ? "Ocultar opciones de vista y exportar" : "Más opciones: vista y exportar"}
            onClick={() => setMoreOpen((v) => !v)}
          >
            <span aria-hidden="true">⋯</span>
          </button>

          <Button variant="primary" onClick={onCreate} className={styles.createBtn}>
            <IconPlus size={14} /> Nuevo turno
          </Button>

          <div id="agenda-toolbar-more" className={moreOpen ? `${styles.secondary} ${styles.secondaryOpen}` : styles.secondary}>
            <ViewOptionsMenu
              density={density}
              setDensity={onDensityChange}
              visibility={visibility}
              setVisibility={onVisibilityChange}
              zoom={zoom}
              setZoom={onZoomChange}
              planScope={planScope}
              setPlanScope={onPlanScopeChange}
            />
            <a
              href={`/api/agenda/export?from=${exportFromKey}`}
              target="_blank"
              rel="noopener noreferrer"
              title="Exportar la semana a tu calendario (.ics)"
              className={buttonClassName({ variant: "ghost", className: styles.icsLink })}
            >
              .ics
            </a>
          </div>
        </div>
      </div>
      {practitionerChips}
    </header>
  );
}
