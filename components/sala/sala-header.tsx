"use client";

import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { DUR, EASE_IN_OUT, EASE_OUT, countBump, springSoft } from "@/lib/motion";
import { IconSearch, IconX } from "@/components/ui/icons";
import { LiveIndicator } from "@/components/realtime/live-indicator";
import { SALA_COPY, SALA_COUNTERS, type SalaCounters } from "@/lib/sala-board-state";
import type { SalaGroupBy } from "@/lib/preferences-constants";


/**
 * Header sticky de /sala (SV10a, plan §18.5): título + fecha de hoy AR,
 * `LiveIndicator`, contadores, «Por profesional | Por sala» y el buscador.
 *
 * Contadores: el número es un `motion.span` con `key={valor}`, así cada cambio
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
          {SALA_COUNTERS.map((c) => (
            <div key={c.key} className="sala-counter" data-counter={c.key} data-active={counters[c.key] > 0 ? "" : undefined}>
              <dt>{c.label}</dt>
              <dd>
                <motion.span
                  key={counters[c.key]}
                  className="sala-counter-n k-mono"
                  variants={countBump}
                  initial="rest"
                  animate={mounted.current ? "bump" : "rest"}
                >
                  {counters[c.key]}
                </motion.span>
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
                  <motion.span
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
        <div className="sala-status">
          <AnimatePresence initial={false}>
            {status === "no-one-waiting" && (
              <motion.p
                key="no-one-waiting"
                className="sala-status-msg"
                style={{ margin: 0 }}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: { duration: DUR.base, ease: EASE_OUT } }}
                exit={{ opacity: 0, transition: { duration: DUR.fast, ease: EASE_IN_OUT } }}
              >
                <span className="sala-status-dot" aria-hidden="true" />
                <strong>{SALA_COPY.noOneWaiting}</strong>
                <span>· Estos son los próximos turnos del día.</span>
              </motion.p>
            )}
          </AnimatePresence>
        </div>
      </div>
    </header>
  );
}
