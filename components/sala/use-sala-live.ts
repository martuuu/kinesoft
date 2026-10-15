"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "@/components/ui/toast";
import { useRealtime } from "@/components/providers/realtime-provider";
import { markReceptionAction } from "@/lib/bookings";
import { listSalaBookings } from "@/lib/sala-bookings";
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
  callAnnouncement,
  diffSala,
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
} from "@/lib/sala-board-state";
import { deskEntries, type DeskViewer } from "@/lib/reception-desk-state";
import type { BookingDTO } from "@/components/agenda/agenda-utils";
import { noteLocalReception } from "@/lib/arrival-local-notes";
import type { SalaLive } from "./sala-live-types";

/** Cada cuánto avanza el reloj de las esperas (§18.5: tictac de 30 s). */
const CLOCK_TICK_MS = 30_000;
/** Cuánto queda visible el anuncio «Pase …» (§18.5). */
const CALL_BANNER_MS = 8_000;
/** Lo que dura el anillo de llegada (2 × `DUR.pulse`) con margen: después se limpia. */
const PULSE_CLEAR_MS = 1_600;

export type SalaLiveInput = {
  dayKey: string;
  initialNow: string;
  /** Ya proyectadas en el server (`listSalaBookings`): sin claves clínicas. */
  initialRows: ReadonlyArray<SalaWireRow>;
  practitioners: SalaPractitioner[];
  rooms: SalaRoom[];
  viewer: DeskViewer;
  /**
   * EV2-3c: se llama con la fila CONFIRMADA por el server después de cada acción OK (Tablero y escritorio). Lo usa
   * `SalaClient` para el toast «Cargar evolución» al marcar «Atendido» (`useAttendedNoteToast`). Se lee de un ref:
   * cambiarlo no recrea `act`/`onBoardAction` (las cards son `memo`).
   */
  onCommitted?: (action: ReceptionAction, saved: BookingDTO) => void;
};

/**
 * Lo que el hook da además del contrato C-RX4, solo para el Tablero (SV10a): sus cards memoizadas comparan
 * `pulses[id]` (el `arrivedAt` que disparó el anillo, para re-latir si vuelve a llegar) y `changes` (tamaño del
 * lote → `rowTransition`), y su `onAction` recibe la `SalaEntry` de la card. El escritorio usa solo `SalaLive`.
 */
export type SalaLiveWithBoard = SalaLive & {
  pulses: Readonly<Record<string, string>>;
  changes: number;
  onBoardAction: (entry: SalaEntry, action: ReceptionAction) => Promise<void>;
};

/**
 * RX-1a: los datos vivos de /sala, extraídos de `SalaClient` (SV10a, plan §18.5) SIN cambio de comportamiento.
 * Lo comparten el Tablero y el escritorio de Recepción (A «Lista y panel», B «Flujo»).
 *
 * - **Optimista** con el patrón de Recepción (`begin/commit/rollback` de `lib/reception-view-state.ts`): la fila
 *   cambia al click; si el server dice que no, vuelve. «El turno cambió en otra sesión» → toast + re-pedido.
 * - **En vivo**: `useRealtime().subscribe` → si el lote toca hoy, re-pide `listSalaBookings(hoy)` (PD-13
 *   proyectado en el server); `onResync` (reconexión, pestaña que vuelve, polling de 60 s del provider sin canal)
 *   igual. Con el provider en `off` (`REALTIME_DRIVER=off`, default de prod) el provider no pollea: /sala pollea
 *   sola cada 60 s y al volver a verse (`startSalaOffPolling`, FX2a · A1). El payload nunca se muestra: es un
 *   «tocá acá» (§18.2). Re-pedido COALESCIDO: si ya hay uno en vuelo, se marca «sucio» y se repite UNA vez al
 *   terminar; nunca N en paralelo (con 20 lotes seguidos serían 20 requests y respuestas desordenadas).
 * - **Reloj** cada 30 s para las esperas; si cambia el día AR (pasó la medianoche con la pestaña abierta) re-pide
 *   el día nuevo.
 * - **Diff entre renders** (`diffSala`): llegadas nuevas → anillo una vez; llamados nuevos (propios o remotos) →
 *   banda «Pase …» 8 s; cantidad de cambios → `rowTransition(n)` (lote grande = un fade).
 * - **Foco**: después de una acción, el botón primario nuevo de esa card del Tablero (o la card): el botón
 *   clickeado suele desaparecer con el cambio de estado y el foco del teclado caía al `<body>`. En el escritorio
 *   no hay `.sala-card` y no hace nada: cada cara maneja su foco.
 */
export function useSalaLive({
  dayKey: initialDayKey,
  initialNow,
  initialRows,
  practitioners,
  rooms,
  viewer,
  onCommitted,
}: SalaLiveInput): SalaLiveWithBoard {
  const toast = useToast();
  const onCommittedRef = useRef(onCommitted);
  onCommittedRef.current = onCommitted;
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const realtime = useRealtime();

  const [rows, setRows] = useState<BookingDTO[]>(() => initialRows.map(fromSalaWire));
  const [clock, setClock] = useState(() => new Date(initialNow));
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

  const pendingIds = useMemo(
    () => new Set(Object.entries(overrides).filter(([, o]) => o.pending).map(([id]) => id)),
    [overrides]
  );
  const entries = useMemo(() => deskEntries(merged.rows, clock, viewer), [merged.rows, clock, viewer]);
  const pulseIds = useMemo(() => new Set(Object.keys(pulses)), [pulses]);
  const roomById = useMemo(
    () => (rooms.length > 0 ? Object.fromEntries(rooms.map((r) => [r.id, { name: r.name }])) : null),
    [rooms]
  );

  // ── Foco después de una acción (M1) ──
  const [focusReq, setFocusReq] = useState<{ id: string; n: number } | null>(null);
  useEffect(() => {
    if (focusReq) focusCardAfterAction(focusReq.id);
  }, [focusReq]);

  // ── Acciones ──
  // Estables (M5): las cards son `memo` y comparan `onAction` por identidad; lo
  // que cambia entre renders (filas y entries vigentes) se lee de refs.
  const rowsRef = useRef(merged.rows);
  rowsRef.current = merged.rows;
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  /** El cuerpo de la acción, con el permiso ya chequeado por quien llama. */
  const run = useCallback(
    async (row: BookingDTO, action: ReceptionAction) => {
      // La fila VIGENTE (la card memoizada puede tener una entry de un render
      // anterior con la misma firma; el `updatedAt` es el de ahora).
      const b = rowsRef.current.find((r) => r.id === row.id) ?? row;
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
        if (saved) {
          setRows((prev) => prev.map((r) => (r.id === saved.id ? toSalaRow(saved) : r)));
          onCommittedRef.current?.(action, saved);
        }
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

  /** Tablero: la card trae su `SalaEntry` (con las acciones del rol al render). */
  const onBoardAction = useCallback(
    async (entry: SalaEntry, action: ReceptionAction) => {
      if (!entry.salaActions.includes(action)) return;
      await run(entry.row, action);
    },
    [run]
  );

  /** Escritorio: la misma regla de rol, leída de la entry vigente de esa fila. */
  const act = useCallback(
    async (row: BookingDTO, action: ReceptionAction) => {
      const entry = entriesRef.current.find((e) => e.row.id === row.id);
      if (!entry || !entry.salaActions.includes(action)) return;
      await run(row, action);
    },
    [run]
  );

  // Después de `setBookingCopagoPaid` OK: la fila que devolvió el server, proyectada como las del cable (PD-13).
  const replaceRow = useCallback((b: BookingDTO) => {
    const clean = toSalaRow(b);
    setRows((prev) => prev.map((r) => (r.id === clean.id ? clean : r)));
  }, []);
  const dismissCall = useCallback(() => setCall(null), []);

  return {
    dayKey,
    clock,
    loading,
    rows: merged.rows,
    entries,
    pendingIds,
    act,
    replaceRow,
    call: call ? { key: call.key, text: call.text } : null,
    dismissCall,
    pulseIds,
    announce: srAnnounce,
    practitioners,
    rooms,
    roomById,
    viewer,
    pulses,
    changes,
    onBoardAction,
  };
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
