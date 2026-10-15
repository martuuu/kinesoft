"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { DUR, EASE_IN_OUT, EASE_OUT } from "@/lib/motion";
import { useToast } from "@/components/ui/toast";
import { IconBell, IconCal, IconPlus } from "@/components/ui/icons";
import { useTweaksOptional } from "@/components/layout/tweaks-context";
import { updateAgendaViewPrefs } from "@/lib/preferences";
import {
  SALA_COPY,
  boardCounters,
  buildBoard,
  filterByQuery,
  type SalaWireRow,
  type SalaPractitioner,
  type SalaRoom,
  type SalaViewer,
} from "@/lib/sala-board-state";
import type { DeskViewer } from "@/lib/reception-desk-state";
import type { ReceptionLayout, SalaGroupBy } from "@/lib/preferences-constants";
import { SalaHeader } from "./sala-header";
import { SalaBoard } from "./sala-board";
import { SALA_CSS } from "./sala-css";
import { useSalaLive, type SalaLiveWithBoard } from "./use-sala-live";
import { ReceptionDesk } from "@/components/sala/desk/reception-desk";
import { salaDayLabel } from "./sala-day-label";
import { useAttendedNoteToast } from "@/components/agenda/reception/use-attended-note-toast";

/**
 * Cliente de /sala. Los datos vivos (filas de HOY, optimista con rollback,
 * realtime + polling en off, reloj, diff de llegadas y llamados, banda «Pase …»)
 * viven en `useSalaLive` (RX-1a, extraído de acá sin cambio de comportamiento);
 * este componente solo elige la cara:
 *
 * - `board` → el Tablero por columnas (SV10a, plan §18.5), como siempre;
 * - `list` / `flow` → el escritorio de Recepción (A «Lista y panel», B «Flujo»).
 *
 * La cara sale de Apariencia (`useTweaksOptional()?.receptionLayout`, optimista
 * y sin recargar); sin provider (tests, demo) de `initialLayout` que lee la page
 * de las prefs del server; sin nada, el Tablero. El hook vive ACÁ y no en cada
 * cara: cambiar de cara no re-pide ni pierde overrides en vuelo.
 *
 * EV2-3c: `canReadClinical` (`caps.has("clinical.read")`, de la page) + el
 * `practitionerId` del viewer → al marcar «Atendido» en un turno propio, toast
 * «Cargar evolución» en las tres caras (`useAttendedNoteToast`, vía
 * `onCommitted` del hook). PD-13 intacto: el toast solo usa ids, estado y el
 * nombre que ya viajan en la fila; ningún texto clínico entra a /sala.
 */
export function SalaClient({
  dayKey,
  initialNow,
  initialRows,
  practitioners,
  rooms,
  viewer: viewerProp,
  initialGroupBy,
  initialLayout,
  canReadClinical = false,
}: {
  dayKey: string;
  initialNow: string;
  /** Ya proyectadas en el server (`listSalaBookings`): sin claves clínicas. */
  initialRows: ReadonlyArray<SalaWireRow>;
  practitioners: SalaPractitioner[];
  rooms: SalaRoom[];
  /** `deskViewer(...)` de la page; un `SalaViewer` pelado (tests del Tablero) se toma como «no cobra». */
  viewer: SalaViewer & { canCollect?: boolean };
  initialGroupBy: SalaGroupBy;
  /** `agendaPrefs.receptionLayout` del server (la page). */
  initialLayout?: ReceptionLayout;
  /** EV2-3c: `caps.has("clinical.read")`. Sin la prop, sin toast «Cargar evolución». */
  canReadClinical?: boolean;
}) {
  const { practitionerId, canReception, canOperateAll, canCollect = false } = viewerProp;
  // Identidad estable por valor: `viewer` es dep de `buildBoard`/`deskEntries` en cada render.
  const viewer = useMemo<DeskViewer>(
    () => ({ practitionerId, canReception, canOperateAll, canCollect }),
    [practitionerId, canReception, canOperateAll, canCollect]
  );
  const onCommitted = useAttendedNoteToast({ practitionerId, canReadClinical });
  const live = useSalaLive({ dayKey, initialNow, initialRows, practitioners, rooms, viewer, onCommitted });
  const layout: ReceptionLayout = useTweaksOptional()?.receptionLayout ?? initialLayout ?? "board";

  if (layout === "board") return <SalaBoardFace live={live} initialGroupBy={initialGroupBy} />;
  return <ReceptionDesk live={live} layout={layout} viewer={viewer} />;
}

/**
 * La cara «Tablero» (SV10a): header con contadores, agrupación y buscador,
 * banda «Pase …» flotante y columnas.
 *
 * - **Agrupación** desde `agendaPrefs.salaGroupBy`, guardada con
 *   `updateAgendaViewPrefs` (optimista: si falla, vuelve y avisa).
 * - La banda «Pase …» flota sobre el tablero (no lo empuja) y la card que
 *   cambia de estado se desliza a su banda (`changes` → `rowTransition`).
 */
function SalaBoardFace({ live, initialGroupBy }: { live: SalaLiveWithBoard; initialGroupBy: SalaGroupBy }) {
  const toast = useToast();
  const { dayKey, clock, loading, rows, practitioners, rooms, viewer, call } = live;
  const [groupBy, setGroupBy] = useState<SalaGroupBy>(initialGroupBy);
  const [query, setQuery] = useState("");
  const [laterOpen, setLaterOpen] = useState<ReadonlySet<string>>(() => new Set());

  const canGroupByRoom = rooms.length > 0;
  const effectiveGroupBy: SalaGroupBy = canGroupByRoom ? groupBy : "practitioner";
  const counters = useMemo(() => boardCounters(rows, clock), [rows, clock]);
  const fullBoard = useMemo(
    () => buildBoard(rows, { groupBy: effectiveGroupBy, practitioners, rooms, now: clock, viewer }),
    [rows, effectiveGroupBy, practitioners, rooms, clock, viewer]
  );
  const filteredRows = useMemo(() => filterByQuery(rows, query), [rows, query]);
  const board = useMemo(
    () =>
      query.trim()
        ? buildBoard(filteredRows, { groupBy: effectiveGroupBy, practitioners, rooms, now: clock, viewer })
        : fullBoard,
    [query, filteredRows, effectiveGroupBy, practitioners, rooms, clock, viewer, fullBoard]
  );

  const dayLabel = salaDayLabel(dayKey);

  async function handleGroupBy(next: SalaGroupBy) {
    const prev = groupBy;
    setGroupBy(next);
    try {
      const res = await updateAgendaViewPrefs({ salaGroupBy: next });
      if (res.ok) return;
    } catch {
      // cae al rollback
    }
    setGroupBy(prev);
    toast.error("No pudimos guardar cómo agrupar la sala. Reintentá.");
  }

  const toggleLater = useCallback((columnId: string) => {
    setLaterOpen((prev) => {
      const next = new Set(prev);
      if (next.has(columnId)) next.delete(columnId);
      else next.add(columnId);
      return next;
    });
  }, []);

  const noMatches = query.trim() !== "" && filteredRows.every((r) => r.status === "CANCELLED");
  const waitingForDay = loading && rows.length === 0;

  return (
    <div className="sala">
      <style>{SALA_CSS}</style>

      {/* Bloque sticky: header + banda de llamado colgada como overlay (A2):
          la banda flota sobre el tablero en vez de empujarlo, así las cards
          con `layout` no saltan al aparecer ni a los 8 s al irse. */}
      <div className="sala-top">
        <SalaHeader
          dayLabel={dayLabel}
          counters={counters}
          groupBy={effectiveGroupBy}
          canGroupByRoom={canGroupByRoom}
          onGroupBy={handleGroupBy}
          query={query}
          onQuery={setQuery}
          status={fullBoard.empty === "no-one-waiting" && !query.trim() && !waitingForDay ? "no-one-waiting" : null}
        />

        {/* La región existe siempre (un aria-live que se monta junto con su
            texto no se anuncia en todos los lectores). `mode="wait"`: dos
            llamados seguidos no apilan dos bandas; la vieja sale y entra la
            nueva en el mismo lugar. */}
        <div className="sala-call" role="status" aria-live="polite" aria-atomic="true">
          <AnimatePresence mode="wait" initial={false}>
            {call && (
              <motion.div
                key={call.key}
                className="sala-call-inner"
                initial={{ opacity: 0, y: -8, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: DUR.base, ease: EASE_OUT } }}
                exit={{ opacity: 0, y: -6, scale: 0.98, transition: { duration: DUR.fast, ease: EASE_IN_OUT } }}
              >
                <span className="sala-call-icon" aria-hidden="true">
                  <IconBell size={18} />
                </span>
                <span className="sala-call-text">{call.text}</span>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
      <div className="sala-sr" aria-live="polite">
        {live.announce}
      </div>

      {waitingForDay ? (
        <div className="sala-empty" aria-busy="true">
          <strong>Cargando los turnos de hoy…</strong>
        </div>
      ) : fullBoard.empty === "no-bookings" ? (
        // VX0-b R2: antes era una card de 120 px con el texto solo y el resto
        // de la pantalla vacía. Ahora dice qué hacer: ir a la agenda o cargar
        // un turno (solo quien opera la Recepción; BILLING no carga turnos).
        <div className="sala-empty sala-empty-day">
          <span className="sala-empty-icon" aria-hidden="true">
            <IconCal size={22} />
          </span>
          <strong>{SALA_COPY.noBookings}</strong>
          <p className="sala-empty-text">Cuando se cargue un turno para hoy, aparece acá en vivo.</p>
          <div className="sala-empty-actions">
            <Link href="/agenda" className="k-btn k-btn-ghost sala-empty-btn">
              Ir a la agenda
            </Link>
            {viewer.canReception && (
              <Link href="/agenda?new=1" className="k-btn k-btn-primary sala-empty-btn">
                <IconPlus size={13} /> Nuevo turno
              </Link>
            )}
          </div>
        </div>
      ) : noMatches ? (
        <p className="sala-note">{SALA_COPY.noMatches}</p>
      ) : (
        // «Por profesional | Por sala»: fade corto del tablero entero en vez
        // de un remonte seco (las columnas son otras; deslizarlas no explica
        // nada). `mode="wait"`: nunca se ven los dos tableros a la vez.
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={effectiveGroupBy}
            className="sala-fade"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: DUR.fast, ease: EASE_OUT } }}
            exit={{ opacity: 0, transition: { duration: DUR.fast, ease: EASE_IN_OUT } }}
          >
            <SalaBoard
              columns={board.columns}
              now={clock}
              groupBy={effectiveGroupBy}
              practitioners={practitioners}
              rooms={rooms}
              pendingIds={live.pendingIds}
              pulses={live.pulses}
              changes={live.changes}
              laterOpen={laterOpen}
              onToggleLater={toggleLater}
              onAction={live.onBoardAction}
            />
          </motion.div>
        </AnimatePresence>
      )}
    </div>
  );
}
