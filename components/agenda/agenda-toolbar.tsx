"use client";

import { useState } from "react";
import { m } from "framer-motion";
import { DUR, EASE_OUT } from "@/lib/motion";
import { Button, buttonClassName } from "@/components/ui/button";
import { IconChevL, IconChevR, IconPlus } from "@/components/ui/icons";
import type { AgendaPlanScope, AgendaVisibility } from "@/lib/agenda-filters";
import type { ScopeHeading, ViewSegment } from "@/lib/agenda-client-state";
import { dayKeyOf, instantAt } from "@/lib/availability/day";
import type { AgendaViewZoom } from "@/lib/preferences-constants";
import { ViewOptionsMenu } from "./view-options-menu";
import { AgendaScopeHeading } from "./agenda-scope-heading";
import styles from "./agenda-toolbar.module.css";

export type { AgendaView } from "@/lib/agenda-client-state";
export type AgendaDensity = "comfortable" | "compact";

const SEGMENT_LABEL: Record<ViewSegment, string> = {
  day: "Día",
  week: "Semana",
  month: "Mes",
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
 * - `zoom`/`onZoomChange`: franja 15/30/60 en el menú Vista (todos los modos; en Día/Semana la del consultorio hasta que el usuario elige, AS-2g).
 * - `insurerFilter` (AS-2o): el `<InsurerFilter>` diferido (select de obra social), junto a la sede.
 *   `insurerHiddenLabel`: «N turnos no se muestran con este filtro: no tenés acceso a su cobertura.» o null; va abajo del
 *   título como el aviso de ocultos, sin «Mostrar todos» (no es la visibilidad: se resuelve sacando el filtro).
 *
 * PF1.1-agenda-a:
 * - C-PF1: sin `motion.button` (el `whileTap` es CSS `:active`) y la pastilla del
 *   selector es `m.span` con clase (S5). Estilos en `agenda-toolbar.module.css`.
 * - G9: < 480 px «.ics» y «Vista» quedan detrás de «⋯» y «Nuevo turno» se ve
 *   siempre. ≥ 480 no cambia nada.
 * - «.ics» era un `<a>` con un `<button>` adentro (interactivo anidado): ahora
 *   es el link con el look de botón (`buttonClassName`).
 *
 * MB-1a (C-MB3 / C-MB4):
 * - < 768: «Nuevo turno» pasa al FAB; «.ics» y «Vista» detrás de «⋯» (antes < 480) para que la barra quede en
 *   2 filas (navegación · vista + «⋯»); controles a 44 px (target táctil).
 * - Monitores bajos (≥ 768 y ≤ 760 px de alto): sin el rótulo «Agenda» y título más chico, para que la grilla
 *   muestre ≥ 6 h a 1366×625.
 *
 * CF2 (D-CF2-2, brief A.1 y A.4):
 * - `scopeHeading`: con varios profesionales el h1 es el título de alcance (`AgendaScopeHeading`) y la fecha baja a
 *   subtítulo con el `dayLock` («En vivo» incluido). Los `practitionerChips` suben debajo del título con la etiqueta
 *   «Profesionales» (en el DOM antes de las acciones: < 768 se ven ahí; ≥ 768 el CSS los pasa a la fila de abajo a
 *   todo el ancho, como antes). Sin slot (o `null`: un solo profesional) el markup es el de siempre, byte a byte.
 * - `segment === "month"`: «Mes anterior»/«Mes siguiente» llaman a `onNavigateMonths` (si no viene, a
 *   `onNavigateWeeks`, para no romper mientras no se cablea) y la fecha es el mes («noviembre de 2026»).
 */
export function AgendaToolbar({
  anchor,
  segment,
  segments,
  onSegmentChange,
  hiddenLabel,
  onShowAll,
  onNavigateWeeks,
  onNavigateMonths,
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
  insurerFilter,
  insurerHiddenLabel,
  scopeHeading,
}: {
  anchor: Date;
  segment: ViewSegment;
  segments: ReadonlyArray<ViewSegment>;
  onSegmentChange: (s: ViewSegment) => void;
  hiddenLabel: string | null;
  onShowAll: () => void;
  onNavigateWeeks: (deltaWeeks: -1 | 1) => void;
  /** CF2 (A.4): ±1 mes en la vista Mes. Opcional: sin él, Mes navega con `onNavigateWeeks`. */
  onNavigateMonths?: (deltaMonths: -1 | 1) => void;
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
  insurerFilter?: React.ReactNode;
  insurerHiddenLabel?: string | null;
  /** CF2 (D-CF2-2): título de alcance; `null`/ausente = un solo profesional, el encabezado de siempre. */
  scopeHeading?: ScopeHeading | null;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const dateLabel =
    segment === "month"
      ? agendaMonthTitle(anchor)
      : anchor.toLocaleDateString("es-AR", { weekday: "long", day: "2-digit", month: "long", timeZone: "America/Argentina/Buenos_Aires" });
  const scoped = !!scopeHeading;
  return (
    <header className={styles.header}>
      <div className={scoped ? `${styles.topRow} ${styles.topRowScoped}` : styles.topRow}>
        <div className={styles.titleBlock}>
          {/* ZB-9: con título de alcance («Agenda de Laura Pérez», «Todos los profesionales (5)») el eyebrow «Agenda»
              repetía lo que el h1 ya dice; solo queda arriba de la fecha cuando ella es el título. */}
          {!scoped && <div className={styles.eyebrow}>Agenda</div>}
          {scopeHeading ? (
            <>
              <AgendaScopeHeading heading={scopeHeading} />
              <div className={styles.subtitleRow}>
                <span className={styles.subtitle}>{dateLabel}</span>
                {dayLock}
              </div>
            </>
          ) : (
            <div className={styles.titleRow}>
              <h1 className={`k-display ${styles.title}`}>{dateLabel}</h1>
              {dayLock}
            </div>
          )}
          {hiddenLabel && (
            <div role="status" className={styles.hidden}>
              <span>{hiddenLabel}</span>
              <button type="button" onClick={onShowAll} className={styles.linkBtn}>
                Mostrar todos
              </button>
            </div>
          )}
          {insurerHiddenLabel && (
            <div role="status" className={styles.hidden}>
              <span>{insurerHiddenLabel}</span>
            </div>
          )}
        </div>
        {scoped && practitionerChips && (
          <div className={styles.scopeChips}>
            {/* Rótulo visible; el grupo de chips ya tiene su nombre accesible («Profesionales a mostrar»). */}
            <span className={styles.scopeChipsLabel} aria-hidden="true">
              Profesionales
            </span>
            <div className={styles.scopeChipsScroll}>{practitionerChips}</div>
          </div>
        )}
        <div className={styles.actions}>
          <AgendaNavGroup segment={segment} onNavigateWeeks={onNavigateWeeks} onNavigateMonths={onNavigateMonths} onToday={onToday} />

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

          {insurerFilter}

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

          {/* MB-1a (C-MB3): < 768 «Nuevo turno» es el FAB (`.k-fab`, sobre la barra inferior) y el botón de arriba se
              oculta; ≥ 768 al revés. Abre el mismo modal (`onCreate`). Va antes de las secundarias en el DOM: `fixed`
              no depende de dónde esté, y así queda fuera del menú «⋯». */}
          <button type="button" onClick={onCreate} aria-label="Nuevo turno" title="Nuevo turno" className={`k-fab ${styles.fab}`}>
            <IconPlus size={24} />
          </button>

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
      {!scoped && practitionerChips}
    </header>
  );
}

/**
 * Título del Mes («noviembre de 2026»). Del día 15 al mediodía AR del mes del ancla: lejos de cualquier borde de mes
 * en cualquier zona del host (en Vercel el host es UTC; el 31 a la noche AR ya es el 1 del mes siguiente en UTC).
 */
export function agendaMonthTitle(anchor: Date): string {
  const mid = instantAt(`${dayKeyOf(anchor).slice(0, 7)}-15`, 12 * 60);
  return mid.toLocaleDateString("es-AR", { month: "long", year: "numeric", timeZone: "America/Argentina/Buenos_Aires" });
}

/**
 * Navegación ‹ Hoy › (los tres controles a 36 px de alto). Sin hooks: se exporta para probar el click en el árbol
 * real sin jsdom. En Mes son ±1 mes (CF2, A.4); en el resto, ±1 semana como siempre (mismo markup).
 */
export function AgendaNavGroup({
  segment,
  onNavigateWeeks,
  onNavigateMonths,
  onToday,
}: {
  segment: ViewSegment;
  onNavigateWeeks: (deltaWeeks: -1 | 1) => void;
  onNavigateMonths?: (deltaMonths: -1 | 1) => void;
  onToday: () => void;
}) {
  const month = segment === "month";
  const nav = month && onNavigateMonths ? onNavigateMonths : onNavigateWeeks;
  return (
    <div className={`k-glass ${styles.pillGroup}`}>
      <button type="button" onClick={() => nav(-1)} aria-label={month ? "Mes anterior" : "Semana anterior"} className={styles.navBtn}>
        <IconChevL size={14} />
      </button>
      <button type="button" onClick={onToday} className={`${styles.navBtn} ${styles.navBtnText}`}>
        Hoy
      </button>
      <button type="button" onClick={() => nav(1)} aria-label={month ? "Mes siguiente" : "Semana siguiente"} className={styles.navBtn}>
        <IconChevR size={14} />
      </button>
    </div>
  );
}
