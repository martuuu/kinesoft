"use client";

import { memo } from "react";
import { AnimatePresence, LayoutGroup, motion } from "framer-motion";
import { rowTransition, rowVariants } from "@/lib/motion";
import type { ReceptionAction } from "@/lib/reception-state";
import {
  SALA_BAND_LABEL,
  SALA_COPY,
  salaEntryKey,
  type SalaBand,
  type SalaColumn as SalaColumnModel,
  type SalaEntry,
} from "@/lib/sala-board-state";
import { PractitionerBadge } from "@/components/agenda/grid/practitioner-badge";
import { SalaCard, type SalaCardContext } from "./sala-card";

type SalaColumnProps = {
  column: SalaColumnModel;
  now: Date;
  groupBy: "practitioner" | "room";
  practitionerById: ReadonlyMap<string, { name: string; initials: string }>;
  roomNameById: ReadonlyMap<string, string>;
  pendingIds: ReadonlySet<string>;
  pulses: Readonly<Record<string, string>>;
  changes: number;
  laterOpen: boolean;
  onToggleLater: (columnId: string) => void;
  onAction: (entry: SalaEntry, action: ReceptionAction) => void;
};

/**
 * Una columna del tablero (SV10a, plan §18.5 «Tablero»).
 *
 * Por qué UNA sola `<ul>` plana con separadores de banda y no una lista por
 * banda: con `layout`, framer anima el cambio de posición de un elemento que
 * sigue montado. Si cada banda fuera su propia lista, «Llamar» desmontaría la
 * card de En sala y montaría otra en Llamado (un fade, sin relación visual);
 * con una lista sola, la MISMA card se desliza a su banda nueva, que es lo que
 * le explica a la Secretaria qué pasó. Los separadores también son `motion.li`
 * con `layout`, así acompañan el movimiento en vez de saltar; van `aria-hidden`
 * (la banda está en el `aria-label` de cada card) para que el lector no los
 * cuente como ítems.
 *
 * - `LayoutGroup` por columna: las animaciones de layout de una columna no
 *   miden ni mueven a las de al lado.
 * - `AnimatePresence mode="popLayout"`: la card que se va sale del flujo al
 *   instante (framer la posiciona `absolute` contra su offsetParent: por eso
 *   `.sala-list` es `position: relative`, si no se iba contra la columna o la
 *   página) y las demás suben con el spring. El cuerpo de la columna
 *   (`overflow-y: auto`) la recorta mientras se desvanece.
 *   `initial={false}`: al abrir la página nada «entra» animado.
 * - `transition={rowTransition(changes)}`: con más de 5 cambios en el lote
 *   (batch, candado) un solo fade en vez de 20 springs.
 * - El scroll vertical es de la lista (`layoutScroll`), no de la página: así
 *   el encabezado de la columna queda siempre visible y framer mide bien las
 *   posiciones con la lista scrolleada.
 * - Con reduced motion el `MotionConfig reducedMotion="user"` anula transform
 *   y layout: las cards aparecen directo en su lugar.
 * - `memo` con `sameColumn` (FX2a · M5): ver `SalaBoard`.
 */
function SalaColumnImpl({
  column,
  now,
  groupBy,
  practitionerById,
  roomNameById,
  pendingIds,
  pulses,
  changes,
  laterOpen,
  onToggleLater,
  onAction,
}: SalaColumnProps) {
  const listId = `sala-col-${column.id}`;
  const headingId = `${listId}-h`;
  const shown = laterOpen ? [...column.entries, ...column.later] : column.entries;
  const transition = rowTransition(changes);
  const waiting = column.entries.filter((e) => e.band === "waiting" || e.band === "called").length;

  return (
    <section className="sala-col" aria-labelledby={headingId} data-kind={column.kind}>
      <header className="sala-col-head">
        {column.kind === "practitioner" ? (
          <PractitionerBadge initials={column.initials ?? "?"} name={column.title} size={30} decorative />
        ) : null}
        <h2 id={headingId} className="sala-col-title">
          {column.title}
        </h2>
        {column.kind === "room" && column.capacity != null ? (
          <span
            className="sala-col-occ k-mono"
            data-full={column.occupied >= column.capacity || undefined}
            aria-label={`${column.occupied} de ${column.capacity} ${column.capacity === 1 ? "lugar ocupado" : "lugares ocupados"}`}
          >
            {column.occupied}/{column.capacity}
          </span>
        ) : waiting > 0 ? (
          <span className="sala-col-occ k-mono" aria-label={`${waiting} en sala`}>
            {waiting}
          </span>
        ) : null}
      </header>

      <motion.div className="sala-col-body" layoutScroll>
        {shown.length === 0 ? <p className="sala-col-empty">{SALA_COPY.columnEmpty}</p> : null}
        <LayoutGroup id={listId}>
          <ul id={listId} className="sala-list" aria-labelledby={headingId}>
            <AnimatePresence mode="popLayout" initial={false}>
              {flatten(shown).map((item) =>
                item.kind === "sep" ? (
                  <motion.li
                    key={`sep:${item.band}`}
                    layout="position"
                    className="sala-sep"
                    data-band={item.band}
                    aria-hidden="true"
                    variants={rowVariants}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                    transition={transition}
                  >
                    <span>{SALA_BAND_LABEL[item.band]}</span>
                    <span className="sala-sep-n k-mono">{item.count}</span>
                  </motion.li>
                ) : (
                  <motion.li
                    key={item.entry.row.id}
                    layout
                    className="sala-item"
                    variants={rowVariants}
                    initial="initial"
                    animate="animate"
                    exit="exit"
                    transition={transition}
                  >
                    <SalaCard
                      entry={item.entry}
                      now={now}
                      context={contextOf(item.entry, groupBy, practitionerById, roomNameById)}
                      pending={pendingIds.has(item.entry.row.id)}
                      pulseKey={pulses[item.entry.row.id] ?? null}
                      onAction={onAction}
                    />
                  </motion.li>
                )
              )}
            </AnimatePresence>
          </ul>
        </LayoutGroup>
      </motion.div>

      {column.later.length > 0 && (
        <button
          type="button"
          className="sala-later"
          aria-expanded={laterOpen}
          aria-controls={listId}
          onClick={() => onToggleLater(column.id)}
        >
          {laterOpen ? "Ocultar los de más tarde" : `${column.later.length} más tarde`}
        </button>
      )}
    </section>
  );
}

/** Lo que la columna no dice: el profesional (vista Por sala) o la sala (Por profesional). */
function contextOf(
  e: SalaEntry,
  groupBy: "practitioner" | "room",
  practitionerById: SalaColumnProps["practitionerById"],
  roomNameById: SalaColumnProps["roomNameById"]
): SalaCardContext {
  if (groupBy === "room") {
    const p = practitionerById.get(e.row.practitionerId);
    return p ? { kind: "practitioner", name: p.name, initials: p.initials } : null;
  }
  const room = typeof e.row.roomId === "string" ? roomNameById.get(e.row.roomId) : undefined;
  return room ? { kind: "room", name: room } : null;
}

function sameEntries(
  a: ReadonlyArray<SalaEntry>,
  b: ReadonlyArray<SalaEntry>,
  prev: SalaColumnProps,
  next: SalaColumnProps
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    const id = y.row.id;
    if (x.row.id !== id) return false;
    if (prev.pendingIds.has(id) !== next.pendingIds.has(id)) return false;
    if ((prev.pulses[id] ?? null) !== (next.pulses[id] ?? null)) return false;
    if (salaEntryKey(x, prev.now) !== salaEntryKey(y, next.now)) return false;
  }
  return true;
}

/**
 * Re-render solo si cambió algo que la columna pinta. `buildBoard` arma objetos
 * nuevos en cada tictac (30 s) y en cada lote, así que la identidad no sirve:
 * se compara por firma de cada entry (`salaEntryKey`, que ya incluye los
 * minutos de espera), el pendiente y el pulso de SUS filas, y el TIPO de
 * transición del lote (`rowTransition` devuelve una de dos constantes).
 */
function sameColumn(prev: SalaColumnProps, next: SalaColumnProps): boolean {
  const a = prev.column;
  const b = next.column;
  if (
    prev.groupBy !== next.groupBy ||
    prev.laterOpen !== next.laterOpen ||
    prev.practitionerById !== next.practitionerById ||
    prev.roomNameById !== next.roomNameById ||
    prev.onAction !== next.onAction ||
    prev.onToggleLater !== next.onToggleLater ||
    rowTransition(prev.changes) !== rowTransition(next.changes)
  ) {
    return false;
  }
  if (
    a.id !== b.id ||
    a.kind !== b.kind ||
    a.title !== b.title ||
    a.initials !== b.initials ||
    a.capacity !== b.capacity ||
    a.occupied !== b.occupied
  ) {
    return false;
  }
  if (!sameEntries(a.entries, b.entries, prev, next)) return false;
  // «N más tarde»: cerrado solo importa cuántos; abierto, cada card.
  if (next.laterOpen) return sameEntries(a.later, b.later, prev, next);
  return a.later.length === b.later.length;
}

export const SalaColumn = memo(SalaColumnImpl, sameColumn);

type FlatItem = { kind: "sep"; band: SalaBand; count: number } | { kind: "row"; entry: SalaEntry };

/**
 * Entries (ya ordenadas por banda) → lista plana con un separador antes de
 * cada banda. El separador tiene key por banda (`sep:waiting`), no por
 * posición: cuando una banda se vacía, SU separador sale, y los demás se
 * deslizan en vez de remontarse.
 */
function flatten(entries: ReadonlyArray<SalaEntry>): FlatItem[] {
  const out: FlatItem[] = [];
  let sep: { kind: "sep"; band: SalaBand; count: number } | null = null;
  for (const e of entries) {
    if (!sep || sep.band !== e.band) {
      sep = { kind: "sep", band: e.band, count: 0 };
      out.push(sep);
    }
    sep.count += 1;
    out.push({ kind: "row", entry: e });
  }
  return out;
}
