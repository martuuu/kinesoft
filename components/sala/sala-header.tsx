"use client";

import { useEffect, useRef } from "react";
import { AnimatePresence, m } from "framer-motion";
import { DUR, EASE_IN_OUT, EASE_OUT, countBump, springSoft } from "@/lib/motion";
import { IconSearch, IconX } from "@/components/ui/icons";
import { LiveIndicator } from "@/components/realtime/live-indicator";
import { SALA_COPY, SALA_COUNTERS, type SalaCounters } from "@/lib/sala-board-state";
import type { SalaGroupBy } from "@/lib/preferences-constants";
// TV-2w2: «Pantallas» (solo con `agenda.operateAll`, vía `DisplaysContext`); el drawer va diferido adentro.
import { DisplaysButton } from "@/components/sala/displays/displays-button";
// CF2 (D-CF2-5, handoff A-SL): sede (solo con ≥2) y «¿Otro día?» por contexto, sin props nuevas.
import { SalaLocationSelect, SalaOtherDayLink } from "./sala-location";
import { porCobrarLabel } from "@/lib/copago-owed";

/**
 * [CF2-SB] «Por cobrar · N · $ X» del Tablero: los que deben y el viewer cobra, y lo que FALTA (`cashEntries`; desde
 * [CF2-ZF1] también los que llegaron y no terminaron, el criterio del tag de la card). null =
 * el viewer no cobra (sin botón). `onIntent` precarga el chunk del drawer (hover/foco), así abrirlo no espera red.
 */
export type SalaHeaderCash = { count: number; totalCents: number; onOpen: () => void; onIntent?: () => void; open?: boolean };

/**
 * Texto del botón (puro para el test): «Por cobrar · 3 · $ 15.000»; sin nada, «Por cobrar · 0». [CF2-ZF1] (ZB-7) Es
 * `porCobrarLabel`, el mismo rótulo del chip de Recepción de la agenda.
 */
export function salaCashLabel(count: number, totalCents: number): string {
  return porCobrarLabel(count, totalCents);
}

/**
 * Header sticky de /sala (SV10a, plan §18.5): título + fecha de hoy AR,
 * `LiveIndicator`, contadores, «Por profesional | Por sala» y el buscador.
 *
 * Contadores: el número es un `m.span` (C-PF1, PF1.1-sala) con `key={valor}`, así cada cambio
 * lo remonta y corre `countBump` una vez. En el primer render NO late (si no,
 * al abrir la página latirían los cuatro): `mounted` arranca en false y pasa a
 * true después del primer effect. Con reduced motion no se mueve (es scale).
 *
 * `status` (FX2a · A2): «Nadie en la sala por ahora» va en un hueco del header
 * que existe SIEMPRE con su alto reservado (`.sala-status`), y aparece con un
 * fade de opacidad: antes era un párrafo en el flujo, arriba del tablero, y al
 * aparecer o irse empujaba todas las columnas.
 *
 * El thumb del segmentado se desliza con `springSoft` (el de la casa para
 * controles chicos), no con el default de framer.
 */
export function SalaHeader({
  dayLabel,
  counters,
  groupBy,
  canGroupByRoom,
  onGroupBy,
  query,
  onQuery,
  status,
  cash = null,
}: {
  dayLabel: string;
  counters: SalaCounters;
  groupBy: SalaGroupBy;
  /** SV-D13: «Por sala» solo con ≥ 1 sala activa; sin salas no hay control. */
  canGroupByRoom: boolean;
  onGroupBy: (g: SalaGroupBy) => void;
  query: string;
  onQuery: (q: string) => void;
  /** Aviso del tablero que no debe mover el layout (ver arriba); null = nada. */
  status: "no-one-waiting" | null;
  /** CF2: «Por cobrar» para quien cobra (ver `SalaHeaderCash`); null/ausente = sin botón. */
  cash?: SalaHeaderCash | null;
}) {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);

  return (
    <header className="sala-head">
      <div className="sala-head-row">
        <div className="sala-head-title">
          <div className="sala-eyebrow">{dayLabel}</div>
          <div className="sala-h1-row">
            <h1 className="k-display sala-h1">{SALA_COPY.title}</h1>
            <LiveIndicator />
          </div>
        </div>
        <dl className="sala-counters" aria-label="Resumen de hoy">
          {/* Primer render sin framer (C-PF1.2): `initial="rest"` es `scale: 1`, el estado final; el latido solo corre
              en un cambio posterior, con las features de `LazyMotion` ya cargadas. */}
          {SALA_COUNTERS.map((c) => (
            <div key={c.key} className="sala-counter" data-counter={c.key} data-active={counters[c.key] > 0 ? "" : undefined}>
              <dt>{c.label}</dt>
              <dd>
                <m.span
                  key={counters[c.key]}
                  className="sala-counter-n k-mono"
                  variants={countBump}
                  initial="rest"
                  animate={mounted.current ? "bump" : "rest"}
                >
                  {counters[c.key]}
                </m.span>
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="sala-head-row sala-tools">
        {canGroupByRoom && (
          <div className="sala-seg" role="group" aria-label="Agrupar el tablero">
            {(
              [
                ["practitioner", SALA_COPY.byPractitioner],
                ["room", SALA_COPY.byRoom],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className="sala-seg-btn"
                aria-pressed={groupBy === id}
                onClick={() => groupBy !== id && onGroupBy(id)}
              >
                {groupBy === id && (
                  <m.span
                    layoutId="sala-seg-thumb"
                    className="sala-seg-thumb"
                    aria-hidden="true"
                    transition={springSoft}
                  />
                )}
                <span className="sala-seg-label">{label}</span>
              </button>
            ))}
          </div>
        )}
        <label className="sala-search">
          <IconSearch size={16} />
          <span className="sala-sr">{SALA_COPY.search}</span>
          <input
            type="search"
            value={query}
            placeholder={SALA_COPY.search}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.preventDefault();
                onQuery("");
              }
            }}
            autoComplete="off"
            spellCheck={false}
          />
          {query && (
            <button type="button" className="sala-search-clear" aria-label="Borrar la búsqueda" onClick={() => onQuery("")}>
              <IconX size={14} />
            </button>
          )}
        </label>
        {cash && (
          // Siempre visible para quien cobra (con 0 también): que aparezca y desaparezca movería la fila de
          // herramientas cada vez que alguien paga. Con 0 queda deshabilitado (no hay nada que abrir).
          <button
            type="button"
            className="k-btn k-btn-ghost k-btn-sm sala-cash"
            data-sala-cash=""
            aria-haspopup="dialog"
            aria-expanded={cash.open ?? false}
            disabled={cash.count === 0}
            onClick={cash.onOpen}
            onPointerEnter={cash.onIntent}
            onFocus={cash.onIntent}
            style={{ flexShrink: 0 }}
          >
            <span className="k-mono">{salaCashLabel(cash.count, cash.totalCents)}</span>
          </button>
        )}
        <SalaLocationSelect />
        <SalaOtherDayLink />
        {/* [CF2-ZF1] Envuelto para darle `order` en el header de una fila (≤ 800 de alto) sin tocar el `k-btn`
            genérico; sin permiso queda vacío y `.sala-displays:empty` lo saca del flujo (no suma un gap). */}
        <span className="sala-displays">
          <DisplaysButton />
        </span>
        <div className="sala-status">
          <AnimatePresence initial={false}>
            {status === "no-one-waiting" && (
              <m.p
                key="no-one-waiting"
                className="sala-status-msg"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: { duration: DUR.base, ease: EASE_OUT } }}
                exit={{ opacity: 0, transition: { duration: DUR.fast, ease: EASE_IN_OUT } }}
              >
                <span className="sala-status-dot" aria-hidden="true" />
                <strong>{SALA_COPY.noOneWaiting}</strong>
                <span>· Estos son los próximos turnos del día.</span>
              </m.p>
            )}
          </AnimatePresence>
        </div>
      </div>
    </header>
  );
}
