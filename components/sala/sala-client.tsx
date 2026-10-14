"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { DUR, EASE_IN_OUT, EASE_OUT } from "@/lib/motion";
import { useToast } from "@/components/ui/toast";
import { IconBell } from "@/components/ui/icons";
import { useRealtime } from "@/components/providers/realtime-provider";
import { markReceptionAction } from "@/lib/bookings";
import { listSalaBookings } from "@/lib/sala-bookings";
import { updateAgendaViewPrefs } from "@/lib/preferences";
import { dayKeyOf, dayWindow } from "@/lib/availability/day";
import { RECEPTION_ACTION_LABEL, sortForReception, type ReceptionAction } from "@/lib/reception-state";
import {
  beginReceptionAction,
  commitReceptionAction,
  isStaleError,
  mergeReceptionOverrides,
  rollbackReceptionAction,
  stateTagText,
  type ReceptionOverrides,
} from "@/lib/reception-view-state";
import {
  SALA_COPY,
  batchTouchesDay,
  boardCounters,
  buildBoard,
  callAnnouncement,
  diffSala,
  filterByQuery,
  fromSalaWire,
  salaSnapshot,
  shortPatientName,
  startSalaOffPolling,
  toSalaRow,
  type SalaEntry,
  type SalaPollingEnv,
  type SalaWireRow,
  type SalaPractitioner,
  type SalaRoom,
  type SalaSnapshot,
  type SalaViewer,
} from "@/lib/sala-board-state";
import type { SalaGroupBy } from "@/lib/preferences-constants";
import type { BookingDTO } from "@/components/agenda/agenda-utils";
import { SalaHeader } from "./sala-header";
import { SalaBoard } from "./sala-board";
import { SALA_CSS } from "./sala-css";
import { noteLocalReception } from "@/lib/arrival-local-notes";

/** Cada cuánto avanza el reloj de las esperas (§18.5: tictac de 30 s). */
const CLOCK_TICK_MS = 30_000;
/** Cuánto queda visible el anuncio «Pase …» (§18.5). */
const CALL_BANNER_MS = 8_000;
/** Lo que dura el anillo de llegada (2 × `DUR.pulse`) con margen: después se limpia. */
const PULSE_CLEAR_MS = 1_600;

/**
 * Cliente de /sala (SV10a, plan §18.5). Dueño de las filas de HOY:
 *
 * - **Optimista** con el patrón de Recepción (`begin/commit/rollback` de
 *   `lib/reception-view-state.ts`): la card cambia al click y se desliza a su
 *   banda; si el server dice que no, vuelve. «El turno cambió en otra sesión»
 *   → toast + re-pedido.
 * - **En vivo**: `useRealtime().subscribe` → si el lote toca hoy, re-pide
 *   `listSalaBookings(hoy)` (PD-13 proyectado en el server); `onResync`
 *   (reconexión, pestaña que vuelve, polling de 60 s del provider sin canal)
 *   igual. Con el provider en `off` (`REALTIME_DRIVER=off`, default de prod)
 *   el provider no pollea: /sala pollea sola cada 60 s y al volver a verse
 *   (`startSalaOffPolling`, FX2a · A1). El payload nunca se muestra: es un
 *   «tocá acá» (§18.2). Re-pedido COALESCIDO: si ya hay uno en vuelo, se marca
 *   «sucio» y se repite UNA vez al terminar; nunca N en paralelo (con 20
 *   lotes seguidos serían 20 requests y respuestas desordenadas).
 * - **Reloj** cada 30 s para las esperas; si cambia el día AR (pasó la
 *   medianoche con la pestaña abierta) re-pide el día nuevo.
 * - **Diff entre renders** (`diffSala`): llegadas nuevas → anillo una vez;
 *   llamados nuevos (propios o remotos) → banda «Pase …» 8 s, flotando sobre
 *   el tablero (no lo empuja); cantidad de cambios → `rowTransition(n)` (lote
 *   grande = un fade).
 * - **Foco**: después de una acción, el botón primario nuevo de esa card (o
 *   la card): el botón clickeado suele desaparecer con el cambio de estado y
 *   el foco del teclado caía al `<body>`.
 * - **Agrupación** desde `agendaPrefs.salaGroupBy`, guardada con
 *   `updateAgendaViewPrefs` (optimista: si falla, vuelve y avisa).
 */
export function SalaClient({
  dayKey: initialDayKey,
  initialNow,
  initialRows,
  practitioners,
  rooms,
  viewer,
  initialGroupBy,
}: {
  dayKey: string;
  initialNow: string;
  /** Ya proyectadas en el server (`listSalaBookings`): sin claves clínicas. */
  initialRows: ReadonlyArray<SalaWireRow>;
  practitioners: SalaPractitioner[];
  rooms: SalaRoom[];
  viewer: SalaViewer;
  initialGroupBy: SalaGroupBy;
}) {
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const realtime = useRealtime();

  const [rows, setRows] = useState<BookingDTO[]>(() => initialRows.map(fromSalaWire));
  const [clock, setClock] = useState(() => new Date(initialNow));
  const [groupBy, setGroupBy] = useState<SalaGroupBy>(initialGroupBy);
  const [query, setQuery] = useState("");
  const [laterOpen, setLaterOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [srAnnounce, setSrAnnounce] = useState("");
  // Día nuevo pedido y todavía sin respuesta (medianoche con la pestaña
  // abierta): mientras tanto NO se dice «Hoy no hay turnos», que sería falso.
  const [loading, setLoading] = useState(false);

  // ── Overrides optimistas (ref = copia sincrónica para el doble click) ──
  const [overrides, setOverridesState] = useState<ReceptionOverrides>({});
  const overridesRef = useRef<ReceptionOverrides>(overrides);
  const setOverrides = useCallback((next: ReceptionOverrides) => {
    overridesRef.current = next;
    setOverridesState(next);
  }, []);

  const merged = useMemo(() => mergeReceptionOverrides(rows, overrides), [rows, overrides]);
  useEffect(() => {
    if (merged.overrides !== overridesRef.current) setOverrides(merged.overrides);
  }, [merged.overrides, setOverrides]);

  // ── Día y reloj ──
  const dayKey = dayKeyOf(clock);
  // Arranca en el día que pidió el server: si el reloj del browser ya está en
  // otro (pestaña abierta justo a medianoche), el effect de abajo re-pide.
  const dayRef = useRef(initialDayKey);
  useEffect(() => {
    const id = window.setInterval(() => setClock(new Date()), CLOCK_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  // ── Re-pedido coalescido ──
  const fetching = useRef(false);
  const dirty = useRef(false);
  const refetch = useCallback(async () => {
    if (fetching.current) {
      dirty.current = true;
      return;
    }
    fetching.current = true;
    try {
      do {
        dirty.current = false;
        const day = dayRef.current;
        const { start, end } = dayWindow(day);
        const fresh = await listSalaBookings({ from: start, to: end });
        // Si mientras tanto cambió el día, esta respuesta es vieja: la próxima vuelta pide el nuevo.
        if (dayRef.current === day) {
          setRows(fresh.map(fromSalaWire));
          setLoading(false);
        } else dirty.current = true;
      } while (dirty.current);
    } catch {
      // Sin red o server caído: queda lo que había; el próximo lote, el
      // resync o el polling de 60 s lo vuelven a intentar.
    } finally {
      fetching.current = false;
    }
  }, []);

  useEffect(() => {
    if (dayRef.current === dayKey) return;
    dayRef.current = dayKey;
    setRows([]);
    setLoading(true);
    void refetch();
  }, [dayKey, refetch]);

  useEffect(() => {
    const offBatch = realtime.subscribe((batch) => {
      if (batchTouchesDay(batch, dayRef.current)) void refetch();
    });
    const offResync = realtime.onResync(() => void refetch());
    return () => {
      offBatch();
      offResync();
    };
  }, [realtime, refetch]);

  // A1: sin canal (`off`) el provider no pollea; /sala sí (60 s + al volver visible).
  const realtimeOff = realtime.state === "off";
  useEffect(() => {
    if (!realtimeOff) return;
    return startSalaOffPolling(() => void refetch(), browserPollingEnv());
  }, [realtimeOff, refetch]);

  // ── Diff entre renders: llegadas, llamados y tamaño del lote ──
  const roomNameById = useMemo(() => new Map(rooms.map((r) => [r.id, r.name])), [rooms]);
  const practitionerById = useMemo(() => new Map(practitioners.map((p) => [p.id, p])), [practitioners]);
  const snapshot = useRef<SalaSnapshot | null>(null);
  const [pulses, setPulses] = useState<Readonly<Record<string, string>>>({});
  // Tamaño del lote, calculado EN el render que mueve las filas (contra la
  // foto del render anterior, que el effect actualiza después del commit): la
  // transición de layout se lee de las props de ese mismo render, así que si
  // se calculara en un effect llegaría un render tarde y el lote de 20
  // animaría con springs.
  const changes = useMemo(() => diffSala(snapshot.current, merged.rows).changes, [merged.rows]);
  const [call, setCall] = useState<{ id: string; key: string; text: string } | null>(null);

  useEffect(() => {
    const d = diffSala(snapshot.current, merged.rows);
    snapshot.current = salaSnapshot(merged.rows);
    if (d.arrivals.length > 0) {
      setPulses((prev) => {
        const next = { ...prev };
        for (const a of d.arrivals) next[a.id] = a.arrivedAt;
        return next;
      });
      const ids = d.arrivals.map((a) => a.id);
      window.setTimeout(() => {
        setPulses((prev) => {
          const next = { ...prev };
          for (const id of ids) delete next[id];
          return next;
        });
      }, PULSE_CLEAR_MS);
    }
    const last = d.calls.at(-1);
    if (last) {
      const room = typeof last.roomId === "string" ? roomNameById.get(last.roomId) ?? null : null;
      const pro = practitionerById.get(last.practitionerId)?.name ?? null;
      setCall({ id: last.id, key: `${last.id}:${last.calledAt}`, text: callAnnouncement(last, room, pro) });
    }
  }, [merged.rows, roomNameById, practitionerById]);

  useEffect(() => {
    if (!call) return;
    const id = window.setTimeout(() => setCall(null), CALL_BANNER_MS);
    return () => window.clearTimeout(id);
  }, [call]);

  // ── Tablero ──
  const canGroupByRoom = rooms.length > 0;
  const effectiveGroupBy: SalaGroupBy = canGroupByRoom ? groupBy : "practitioner";
  const counters = useMemo(() => boardCounters(merged.rows, clock), [merged.rows, clock]);
  const fullBoard = useMemo(
    () => buildBoard(merged.rows, { groupBy: effectiveGroupBy, practitioners, rooms, now: clock, viewer }),
    [merged.rows, effectiveGroupBy, practitioners, rooms, clock, viewer]
  );
  const filteredRows = useMemo(() => filterByQuery(merged.rows, query), [merged.rows, query]);
  const board = useMemo(
    () =>
      query.trim()
        ? buildBoard(filteredRows, { groupBy: effectiveGroupBy, practitioners, rooms, now: clock, viewer })
        : fullBoard,
    [query, filteredRows, effectiveGroupBy, practitioners, rooms, clock, viewer, fullBoard]
  );
  const pendingIds = useMemo(
    () => new Set(Object.entries(overrides).filter(([, o]) => o.pending).map(([id]) => id)),
    [overrides]
  );

  const dayLabel = new Date(`${dayKey}T12:00:00-03:00`).toLocaleDateString("es-AR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "America/Argentina/Buenos_Aires",
  });

  // ── Foco después de una acción (M1) ──
  const [focusReq, setFocusReq] = useState<{ id: string; n: number } | null>(null);
  useEffect(() => {
    if (focusReq) focusCardAfterAction(focusReq.id);
  }, [focusReq]);

  // ── Acciones ──
  // Estable (M5): las cards son `memo` y comparan `onAction` por identidad; lo
  // que cambia entre renders (filas vigentes) se lee de refs.
  const rowsRef = useRef(merged.rows);
  rowsRef.current = merged.rows;
  const handleAction = useCallback(
    async (entry: SalaEntry, action: ReceptionAction) => {
      if (!entry.salaActions.includes(action)) return;
      // La fila VIGENTE (la card memoizada puede tener una entry de un render
      // anterior con la misma firma; el `updatedAt` es el de ahora).
      const b = rowsRef.current.find((r) => r.id === entry.row.id) ?? entry.row;
      const begun = beginReceptionAction(overridesRef.current, b, action, new Date());
      if (!begun.ok) {
        toastRef.current.error(begun.error);
        return;
      }
      setOverrides(begun.overrides);
      // M2: el llamado ya lo anuncia la banda «Pase …» (role=status); dos
      // regiones vivas diciendo lo mismo se pisan en el lector.
      if (action !== "llamar") {
        const after = sortForReception([begun.optimistic], new Date())[0];
        setSrAnnounce(`${shortPatientName(b.patientName)}: ${after ? stateTagText(after) : RECEPTION_ACTION_LABEL[action]}`);
      }

      let res: Awaited<ReturnType<typeof markReceptionAction>>;
      try {
        res = await markReceptionAction(b.id, action, b.updatedAt);
      } catch {
        res = { ok: false, error: "No pudimos guardar el cambio. Revisá la conexión y reintentá." };
      }

      if (res.ok) {
        // SV11b: esta pestaña hizo la acción; los avisos no se la repiten.
        noteLocalReception(b.id, res.data);
        const done = commitReceptionAction(overridesRef.current, b.id, res.data);
        setOverrides(done.overrides);
        const saved = done.booking;
        if (saved) setRows((prev) => prev.map((r) => (r.id === saved.id ? toSalaRow(saved) : r)));
        setFocusReq((f) => ({ id: b.id, n: (f?.n ?? 0) + 1 }));
        return;
      }
      const back = rollbackReceptionAction(overridesRef.current, b.id);
      setOverrides(back.overrides);
      setFocusReq((f) => ({ id: b.id, n: (f?.n ?? 0) + 1 }));
      // Un «Pase …» de un llamado que no se guardó no puede quedar en pantalla.
      setCall((c) => (c && c.id === b.id ? null : c));
      setSrAnnounce(`${shortPatientName(b.patientName)}: no se guardó el cambio.`);
      if (isStaleError(res.error)) {
        toastRef.current.warning(SALA_COPY.stale, {
          description: `Actualizamos la sala con lo último de ${shortPatientName(b.patientName)}. Revisalo y reintentá.`,
        });
        void refetch();
      } else {
        toastRef.current.error(res.error);
      }
    },
    [setOverrides, refetch]
  );

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
  const waitingForDay = loading && merged.rows.length === 0;

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
        {srAnnounce}
      </div>

      {waitingForDay ? (
        <div className="sala-empty" aria-busy="true">
          <strong>Cargando los turnos de hoy…</strong>
        </div>
      ) : fullBoard.empty === "no-bookings" ? (
        <div className="sala-empty">
          <strong>{SALA_COPY.noBookings}</strong>
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
              pendingIds={pendingIds}
              pulses={pulses}
              changes={changes}
              laterOpen={laterOpen}
              onToggleLater={toggleLater}
              onAction={handleAction}
            />
          </motion.div>
        </AnimatePresence>
      )}
    </div>
  );
}

/** El browser real para `startSalaOffPolling` (el test usa uno fake). */
function browserPollingEnv(): SalaPollingEnv {
  return {
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (id) => window.clearInterval(id as number),
    isVisible: () => document.visibilityState === "visible",
    onVisibilityChange: (fn) => {
      document.addEventListener("visibilitychange", fn);
      return () => document.removeEventListener("visibilitychange", fn);
    },
  };
}

/**
 * Enfoca el botón primario nuevo de la card (o la card si no le quedan
 * acciones), solo si el foco no se fue a otro lado mientras volvía la action:
 * el botón clickeado quedó deshabilitado o desmontado y el foco cayó al
 * `<body>`, pero si la Secretaria ya está tipeando en el buscador, no se lo
 * robamos. Si la card ya no está (Atendido la saca del tablero), nada.
 */
function focusCardAfterAction(bookingId: string) {
  const cards = document.querySelectorAll<HTMLElement>(".sala-card[data-booking-id]");
  let card: HTMLElement | null = null;
  for (const c of Array.from(cards)) if (c.dataset.bookingId === bookingId) card = c;
  if (!card) return;
  const active = document.activeElement;
  if (active && active !== document.body && !card.contains(active)) return;
  const target =
    card.querySelector<HTMLElement>('.sala-btn[data-kind="primary"]:not(:disabled)') ??
    card.querySelector<HTMLElement>(".sala-btn:not(:disabled)") ??
    card;
  target.focus();
}
