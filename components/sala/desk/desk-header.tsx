"use client";

import type { RefObject } from "react";
import { IconPlus, IconSearch, IconSettings, IconX } from "@/components/ui/icons";
import { LiveIndicator } from "@/components/realtime/live-indicator";
import { fmtHour } from "@/components/agenda/agenda-utils";
import type { DeskKpis } from "@/lib/reception-desk-state";
import { salaDayLabel } from "@/components/sala/sala-day-label";
import { preloadSalaFaces } from "@/components/sala/sala-faces";
import { DESK_COMPACT_MAX } from "./desk-css";
// TV-2w2: «Pantallas» (solo con `agenda.operateAll`, vía `DisplaysContext`); el drawer va diferido adentro.
import { DisplaysButton } from "@/components/sala/displays/displays-button";
// [CF2 · D-CF2-5] Sede (solo con ≥2 sedes, vía `SalaLocationContext` que provee `SalaClient`) y «¿Otro día?».
import { SalaLocationSelect, SalaOtherDayLink } from "@/components/sala/sala-location";

/**
 * Header del escritorio de Recepción (RX-1b, prototipo `.top`): «Recepción», fecha, «En vivo», KPIs, buscador con
 * `/`, «Nuevo turno» con `N`, reloj y «Vista».
 *
 * - KPIs (`deskKpis`, sobre TODAS las filas, no las filtradas): En sala (incluye llamados), Llamados (CF2: cuántos
 *   de «En sala» ya van camino al box), En atención, Demorados (ámbar si hay) y Terminados n/N. En compacto se esconden
 *   (también la fecha); en una columna van de a dos.
 * - Sede y «¿Otro día? → Recepción de la agenda» (CF2, D-CF2-5) antes de «Pantallas»: el selector solo aparece con el
 *   provider de `SalaClient` (≥2 sedes); el link siempre (/sala es solo de hoy). Su CSS va acá (`DESK_HEADER_CSS`) y
 *   no en `desk-css.ts` porque solo lo usa este header; en compacto el link se esconde (la fila no entra).
 * - «Nuevo turno» navega a `/agenda?new=1`, que abre el modal de alta de la agenda (RX-D3: el drawer «primer hueco
 *   libre» del prototipo va a backlog). Lo hace el shell; acá solo el botón.
 * - Fecha: `salaDayLabel`, la misma del Tablero («Jueves, 15 de octubre»).
 * - Reloj HH:MM AR del reloj único del hook (tick de 30 s): no tiene timer propio.
 * - «Vista» abre Apariencia (donde se elige la cara de /sala). Solo se dibuja si hay a dónde ir (`onOpenView`): sin
 *   el provider de Apariencia (tests, demo), no hay botón que no haga nada. Con hover o foco precarga las tres caras
 *   (PF1.1-sala, C-PF2: cada cara es un chunk aparte y el cambio en Apariencia no espera red).
 */
export function DeskHeader({
  dayKey,
  clock,
  kpis,
  query,
  onQuery,
  searchRef,
  onNewBooking,
  onOpenView,
}: {
  dayKey: string;
  clock: Date;
  kpis: DeskKpis;
  query: string;
  onQuery: (q: string) => void;
  searchRef: RefObject<HTMLInputElement>;
  onNewBooking: () => void;
  onOpenView: (() => void) | null;
}) {
  const time = fmtHour(clock);
  const items: ReadonlyArray<{ key: string; label: string; value: string; warn?: boolean }> = [
    { key: "en-sala", label: "En sala", value: String(kpis.enSala) },
    { key: "llamados", label: "Llamados", value: String(kpis.llamados) },
    { key: "en-atencion", label: "En atención", value: String(kpis.enAtencion) },
    { key: "demorados", label: "Demorados", value: String(kpis.demorados), warn: kpis.demorados > 0 },
    { key: "terminados", label: "Terminados", value: `${kpis.terminados}/${kpis.total}` },
  ];

  return (
    <header className="desk-head">
      <style>{DESK_HEADER_CSS}</style>
      <div className="desk-title">
        <h1 className="desk-h1">Recepción</h1>
        <span className="desk-date">{salaDayLabel(dayKey)}</span>
        <LiveIndicator />
      </div>

      <dl className="desk-kpis" aria-label="Resumen de hoy">
        {items.map((k) => (
          <div key={k.key} className="desk-kpi" data-kpi={k.key} data-warn={k.warn ? "true" : undefined}>
            <dt>{k.label}</dt>
            <dd className="desk-mono">{k.value}</dd>
          </div>
        ))}
      </dl>

      <div className="desk-search" role="search">
        <span className="desk-search-ico" aria-hidden="true">
          <IconSearch size={18} />
        </span>
        <label className="desk-sr" htmlFor="desk-q">
          Buscar paciente en los turnos de hoy
        </label>
        <input
          ref={searchRef}
          id="desk-q"
          type="search"
          value={query}
          placeholder="Buscar paciente"
          onChange={(e) => onQuery(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          aria-keyshortcuts="/"
        />
        {query ? (
          <button type="button" className="desk-search-clear" aria-label="Borrar la búsqueda" onClick={() => onQuery("")}>
            <IconX size={14} />
          </button>
        ) : (
          <kbd aria-hidden="true">/</kbd>
        )}
      </div>

      <button type="button" className="k-btn k-btn-primary desk-new" onClick={onNewBooking} aria-keyshortcuts="n">
        <IconPlus size={18} />
        <span className="desk-lbl-long">Nuevo turno</span>
        <span className="desk-lbl-short">Nuevo</span>
        <kbd aria-hidden="true">N</kbd>
      </button>

      <time className="desk-clock desk-mono" dateTime={clock.toISOString()} aria-label={`Hora actual ${time}`}>
        {time}
      </time>

      <SalaLocationSelect className="desk-loc" />
      <SalaOtherDayLink className="desk-otherday" />

      <DisplaysButton />

      {onOpenView && (
        <button
          type="button"
          className="desk-view"
          aria-label="Cambiar vista (Apariencia)"
          title="Cambiar vista"
          onClick={onOpenView}
          onPointerEnter={preloadSalaFaces}
          onFocus={preloadSalaFaces}
        >
          <IconSettings size={18} />
        </button>
      )}
    </header>
  );
}

/**
 * CSS de la sede y del link «¿Otro día?» (CF2). Mismo patrón que `DESK_CSS`: tokens, sin `<`, `>`, comillas ni `&`
 * (React los escapa adentro de un <style> del server). El corte es el compacto del escritorio (`DESK_COMPACT_MAX`).
 */
export const DESK_HEADER_CSS = `
.desk-loc { flex-shrink: 0; }
.desk-otherday { flex-shrink: 0; font-size: 13px; font-weight: 600; color: var(--sky-700); white-space: nowrap; text-decoration: none; }
.desk-otherday:hover { text-decoration: underline; }
@container desk (max-width: ${DESK_COMPACT_MAX}px) { .desk-otherday, .desk-loc .sala-loc-label { display: none; } }
`;
