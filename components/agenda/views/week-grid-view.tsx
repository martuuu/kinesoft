"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { Avatar } from "@/components/ui/avatar";
import { Modal } from "@/components/ui/modal";
import { toARDateKey, toARMinutes } from "@/lib/datetime-ar";
import { animatedPulseIds, splitCountByPractitioner, waitingPulse, type AggregatedDayLock } from "@/lib/agenda-client-state";
import { SERVICE_COLOR_FALLBACK } from "@/lib/service-colors";
import { fmtHour, fmtMoney, osLabel, buildSlots, roomNameOf, slotLabel, slotOf, type BookingDTO } from "../agenda-utils";
import { StatusTag } from "@/components/ui/status-tag";
import { paymentHoldState } from "@/lib/agenda-filters";
import { anyHighlightMatch, type AgendaHighlight } from "@/lib/agenda-highlight";
import { PractitionerBadge } from "../grid/practitioner-badge";
import { MoneyBadge, PlanMarks, WaitingDot, bookingStatusTone, planLooseSplit, planLooseSplitText, waitingHostProps } from "../grid/booking-card";
import { BLOCKED_STRIPES } from "../grid/unavailable-overlay";
import { normalizeSlotMinutes, type AgendaSlotMinutes } from "@/lib/tenant-settings-constants";
import { WeekStrip } from "./week-strip";
import styles from "./views.module.css";

/**
 * [AS-2g] Alto de fila de la Semana por minutos de fila (plan §23.8). 60/30 son los de antes de T3. T3-Z (A1): 15 era
 * 24 y el alto útil (24 − 2·`WEEK_CELL_PAD` = 20) no llegaba a una línea compacta (`WEEK_LINE_H` 22): el turno solo
 * se dibujaba cortado. Con 26 entra justo una línea; el agregado de esa fila va en una sola línea (ver abajo).
 */
export const WEEK_ROW_PX: Readonly<Record<AgendaSlotMinutes, number>> = { 60: 50, 30: 34, 15: 26 };

/** Profesional visible con sus iniciales (orden de columnas/chips). */
type WeekPractitioner = { id: string; initials: string; name: string };

/**
 * Lista de una celda de la Semana (click en el agregado «N turnos»). PF1.1: va sobre el `Modal` de `components/ui`
 * (portal, foco atrapado, Esc, botón de cierre con nombre). Antes era un `div` propio con `backdrop-filter: blur`,
 * sin Esc ni trampa de foco y con una «X» sin `aria-label`.
 */
function WeekSlotModal({
  bookings,
  label,
  onEdit,
  onClose,
  practitionerById,
  roomById,
}: {
  bookings: BookingDTO[];
  label: string;
  onEdit: (b: BookingDTO) => void;
  onClose: () => void;
  practitionerById: ReadonlyMap<string, WeekPractitioner> | null;
  roomById: Readonly<Record<string, { name: string }>> | null;
}) {
  return (
    <Modal onClose={onClose} title={label} width={560}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {bookings.map((b) => {
          const date = new Date(b.scheduledFor);
          const isCancelled = b.status === "CANCELLED";
          const prac = practitionerById?.get(b.practitionerId) ?? null;
          const roomName = roomNameOf(roomById, b);
          return (
            <button
              key={b.id}
              type="button"
              onClick={() => { onEdit(b); onClose(); }}
              style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "10px 12px", borderRadius: 12, border: "none",
                background: isCancelled ? "var(--danger-bg)" : "rgba(255,255,255,0.7)",
                cursor: "pointer", textAlign: "left", width: "100%",
                opacity: isCancelled ? 0.6 : 1,
              }}
            >
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 999,
                  background: b.serviceColor ?? SERVICE_COLOR_FALLBACK,
                  flexShrink: 0,
                }}
              />
              <Avatar name={b.patientName} size={32} tone="sky" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--navy-900)", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  {b.patientName}
                  {b.isOverbooked && (
                    <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", color: "var(--warn-fg)", background: "var(--warn-bg-strong)", borderRadius: 999, padding: "0 6px" }}>
                      Sobreturno
                    </span>
                  )}
                  <PlanMarks b={b} />
                  <MoneyBadge b={b} />
                </div>
                <div style={{ fontSize: 11, color: "var(--navy-500)" }}>
                  {fmtHour(date)} · {b.serviceName} · {b.durationMin} min
                  {roomName && <span data-room> · {roomName}</span>}
                </div>
                <div style={{ fontSize: 11, color: "var(--navy-400)", marginTop: 1 }}>
                  {[osLabel(b.obraSocial), fmtMoney(b.copagoCents)].filter(Boolean).join(" · ")}
                </div>
              </div>
              {prac && <PractitionerBadge initials={prac.initials} name={prac.name} size={24} />}
              <StatusTag s={b.status} hold={paymentHoldState(b, new Date())} />
            </button>
          );
        })}
      </div>
    </Modal>
  );
}

/** G2: alto de una línea compacta de la Semana (hora + paciente + barra de servicio) y separación entre líneas. */
export const WEEK_LINE_H = 22;
const WEEK_LINE_GAP = 2;
export const WEEK_CELL_PAD = 2;
/** T3-Z (A1): bajo este alto de fila el agregado «N turnos» va en una línea (número + palabra) y sin reparto. */
const WEEK_AGG_ONE_LINE_BELOW = 30;

/**
 * Cuántas líneas compactas entran en una celda de `cellPx` de alto (G2). Pura y exportada para el test: si TODOS los
 * turnos entran se dibujan uno por uno; si no, la celda es el agregado «N turnos» (tono suave) que abre la lista.
 */
export function weekCellLineCapacity(cellPx: number): number {
  return Math.max(1, Math.floor((cellPx - 2 * WEEK_CELL_PAD + WEEK_LINE_GAP) / (WEEK_LINE_H + WEEK_LINE_GAP)));
}

/**
 * Línea compacta de un turno en la Semana (G2, VX0-b clase A). Regla de color de la agenda (AGENTS §5): la barra
 * lateral es el servicio, el fondo es el estado (`bookingStatusTone`, el mismo de la card del Día) y la opacidad es el
 * resaltado. El profesional va con iniciales (canal no cromático), solo con más de uno en pantalla.
 */
function WeekBookingLine({
  b,
  onEdit,
  practitioner,
  dimmed,
  roomName,
  now,
  pulseAnimated,
}: {
  b: BookingDTO;
  onEdit: (b: BookingDTO) => void;
  practitioner: WeekPractitioner | null;
  dimmed: boolean;
  roomName: string | null;
  now: Date;
  /** [HF-2a] Dentro del tope de puntos que laten (D-HF5). */
  pulseAnimated: boolean;
}) {
  const date = new Date(b.scheduledFor);
  const tone = bookingStatusTone(b.status, paymentHoldState(b, now) === "vencida");
  const isCancelled = b.status === "CANCELLED";
  // [HF-2a] (H-LL2): la Semana no mostraba la recepción. En la línea de 22 px entra solo el punto (6 px, en línea);
  // los minutos van en el aria/tooltip.
  const pulse = waitingPulse(b, now);
  const label = [
    `${fmtHour(date)} · ${b.durationMin} min · ${b.patientName}`,
    b.serviceName,
    roomName ? `en ${roomName}` : null,
    practitioner?.name ?? null,
    b.isOverbooked ? "sobreturno" : null,
    pulse?.aria ?? null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <button
      type="button"
      onClick={() => onEdit(b)}
      title={label}
      data-week-line
      className={pulse ? "k-wait-host" : undefined}
      {...waitingHostProps(pulse, pulseAnimated)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 5,
        height: WEEK_LINE_H,
        minWidth: 0,
        width: "100%",
        padding: "0 6px 0 0",
        borderRadius: 6,
        background: tone.background,
        border: tone.border,
        borderLeft: `3px solid ${b.serviceColor ?? SERVICE_COLOR_FALLBACK}`,
        color: "var(--navy-900)",
        cursor: "pointer",
        textAlign: "left",
        overflow: "hidden",
        opacity: isCancelled ? 0.6 : dimmed ? 0.45 : 1,
        textDecoration: isCancelled ? "line-through" : "none",
        flexShrink: 0,
      }}
    >
      <span className="k-mono" style={{ fontSize: 10, fontWeight: 600, color: "var(--sky-700)", paddingLeft: 4, flexShrink: 0 }}>
        {fmtHour(date)}
      </span>
      <span style={{ fontSize: 11, fontWeight: 600, minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {b.patientName}
      </span>
      {/* [TP-3e] La Semana muestra la seña: el badge corto entra en la línea de 22 px (cede el nombre, con elipsis).
          [CF2-MU] `compact`: el tag del copago va como glifo (✓ / $) con el texto entero en el `aria-label`; «Pagado ·
          Transferencia» no entra en 22 px. El modal de la celda (arriba) lo muestra entero. */}
      <MoneyBadge b={b} compact />
      {pulse && <WaitingDot pulse={pulse} animated={pulseAnimated} size="sm" />}
      {practitioner && (
        <span className="k-mono" aria-hidden="true" style={{ fontSize: 9, fontWeight: 700, color: "var(--navy-500)", flexShrink: 0 }}>
          {practitioner.initials}
        </span>
      )}
    </button>
  );
}

/**
 * B4.3:
 * - `weekDays`: los 7 DayKeys AR lun-dom (antes un `Date` + `setDate` del
 *   host para cada columna; hallazgo de B1.5b).
 * - `practitioners`: con más de un profesional en pantalla, el chip de cada
 *   celda parte el conteo por profesional (iniciales, canal no cromático) y
 *   el modal muestra el badge de cada turno. null = uno solo (como siempre).
 * - `dayLocks` / `blockedByDay`: día bloqueado → columna rayada; bloqueo
 *   parcial → solo las filas bloqueadas para todos los visibles.
 * - `renderDayLock(dayKey)`: el candado del header de cada día (lo arma
 *   `agenda-client` con el `DayLockButton` de B4.4 según capability).
 *   [CF2-WS] El header es la tira `WeekStrip variant="columns"` (único
 *   encabezado de la Semana, D-CF2-6): el candado va como hermano del botón
 *   del día, nunca adentro.
 * - `roomById` (SR): catálogo de salas; con él, el modal de la celda suma la
 *   sala como texto ("10:00 · Kinesiología · 45 min · Consultorio 2"). La
 *   celda (solo conteo) no cambia. El caller lo pasa solo cuando la sala
 *   aporta (`showRoomOnCards`).
 *
 * MB-1a (C-MB3, MB-D10): < 768 px esta grilla se oculta (`.weekGrid`) y `agenda-client` muestra `WeekDayList`
 * (la misma semana como lista agrupada por día). Las dos se dibujan y el CSS elige: decidir por JS (matchMedia)
 * daba un primer render con la grilla y un salto a la lista al hidratar (CLS).
 */
export function WeekGridView({
  weekDays,
  bookings,
  onEdit,
  businessHours,
  showSaturday,
  showSunday,
  highlight,
  practitioners = null,
  dayLocks,
  blockedByDay,
  renderDayLock,
  roomById = null,
  now,
  onPickDay,
}: {
  weekDays: ReadonlyArray<string>;
  bookings: BookingDTO[];
  onEdit: (b: BookingDTO) => void;
  businessHours: { start: number; end: number; slotMinutes: number };
  /**
   * @deprecated [CF2-WS] D-CF2-6: en Semana el encabezado siempre está; la pref `agendaShowWeekHeader` solo controla
   * la tira picker de Día/Lista (la decide `agenda-client`). Se acepta y se ignora hasta que el caller deje de pasarla.
   */
  showHeader?: boolean;
  showSaturday: boolean;
  showSunday: boolean;
  /** Resaltado de la leyenda: las celdas con algún turno que coincide se levantan; el resto se atenúa. */
  highlight: AgendaHighlight | null;
  practitioners?: ReadonlyArray<WeekPractitioner> | null;
  dayLocks?: Readonly<Record<string, AggregatedDayLock | undefined>>;
  blockedByDay?: Readonly<Record<string, ReadonlyMap<number, string | null> | undefined>>;
  renderDayLock?: (dayKey: string) => ReactNode;
  roomById?: Readonly<Record<string, { name: string }>> | null;
  /** [HF-2a] Reloj de minuto de la agenda (latido «En sala»). Sin él, `new Date()` al render. */
  now?: Date;
  /** [CF2-WS] Click en un día del encabezado → abrir ese día en Día. Sin él, el día no es un botón. */
  onPickDay?: (dayKey: string) => void;
}) {
  const clock = now ?? new Date();
  // [HF-2a] D-HF5: solo los 12 que más esperan laten; el resto, punto fijo.
  const pulseIds = animatedPulseIds(bookings, clock);
  const practitionerById = useMemo(
    () => (practitioners && practitioners.length > 1 ? new Map(practitioners.map((p) => [p.id, p])) : null),
    [practitioners]
  );
  // Same slot grid as the day view (60, 30 or 15 minutes per row; the caller already resolved the user's row).
  // Sub-hour rows multiply the row count, so they get a shorter height to keep the week from growing 2-4× as tall.
  // [AS-2g] `normalizeSlotMinutes` (desconocido = 60) en vez de `=== 30 ? 30 : 60`, que leía un 15 como 60.
  const slotMinutes = normalizeSlotMinutes(businessHours.slotMinutes);
  const SLOTS = useMemo(
    () => buildSlots(businessHours.start, businessHours.end, slotMinutes),
    [businessHours.start, businessHours.end, slotMinutes]
  );
  const ROW = WEEK_ROW_PX[slotMinutes];

  // Which weekday columns to render (0=Mon … 6=Sun). Mon-Fri always show;
  // Saturday/Sunday are per-user opt-in. `colOf` maps a day index to its
  // visible grid column position so bookings on a hidden weekend day are
  // simply skipped instead of landing in the wrong column.
  const visibleDays = useMemo(() => {
    const days = [0, 1, 2, 3, 4];
    if (showSaturday) days.push(5);
    if (showSunday) days.push(6);
    return days;
  }, [showSaturday, showSunday]);
  const colOf = useMemo(
    () => new Map(visibleDays.map((d, i) => [d, i])),
    [visibleDays]
  );
  // [CF2-WS] `minmax(0, 1fr)` (antes `1fr`): con `1fr` una columna con contenido largo se ensanchaba y el encabezado
  // (otra grilla) ya no quedaba alineado. Es el mismo template que la tira `columns`.
  const gridCols = `52px repeat(${visibleDays.length}, minmax(0, 1fr))`;
  // [CF2-WS] Conteo por día del encabezado: los mismos turnos que dibuja la grilla (el `bookingsByDay` de `agenda-client`
  // también sale de `visibleBookings`), y hoy AR del reloj de la agenda.
  const dayCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const b of bookings) {
      const k = toARDateKey(new Date(b.scheduledFor));
      m[k] = (m[k] ?? 0) + 1;
    }
    return m;
  }, [bookings]);
  const todayKey = toARDateKey(clock);

  // overflow modal state: null = closed, otherwise the slot's bookings + label
  const [overflow, setOverflow] = useState<{ bookings: BookingDTO[]; label: string } | null>(null);

  // Index bookings by "dayCol-rowStart" for easy cell lookup
  const cellMap = useMemo(() => {
    const m = new Map<string, BookingDTO[]>();
    const colOfDay = new Map(weekDays.map((k, i) => [k, i]));
    for (const b of bookings) {
      const date = new Date(b.scheduledFor);
      // Columna por DayKey AR del turno (0=Lun … 6=Dom); fuera de la semana → no va.
      const dayCol = colOfDay.get(toARDateKey(date));
      if (dayCol === undefined) continue;
      // FLOOR to the slot (a 13:30 turno belongs to 13:30 at half-hour rows and
      // to 13:00 at hourly ones) — rounding used to push it into the NEXT row,
      // disagreeing with the day view. `slotOf` also clamps out-of-window turnos
      // into the first/last row so they stay reachable via the overflow modal.
      const { slot } = slotOf(toARMinutes(date), SLOTS, slotMinutes);
      const rowStart = SLOTS.indexOf(slot) + 1;
      const key = `${dayCol}-${rowStart}`;
      const list = m.get(key) ?? [];
      list.push(b);
      m.set(key, list);
    }
    return m;
  }, [bookings, SLOTS, slotMinutes, weekDays]);

  const isBlocked = (dayIdx: number, slot: number): string | null | false => {
    const key = weekDays[dayIdx];
    if (!key) return false;
    const lock = dayLocks?.[key];
    if (lock?.status === "locked") return lock.detail;
    const rows = blockedByDay?.[key];
    return rows?.has(slot) ? rows.get(slot) ?? null : false;
  };

  return (
    <>
      <Card className={styles.weekGrid} style={{ padding: 14, height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
        {/* [CF2-WS] Una sola caja con scroll: el encabezado (sticky) y la grilla scrollean juntos y comparten columnas.
            Antes el scroll era solo de la grilla y el header quedaba afuera: con barra vertical las columnas se corrían. */}
        <div data-week-scroll style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        <WeekStrip
          variant="columns"
          weekDays={weekDays}
          dayKey={todayKey}
          todayKey={todayKey}
          counts={dayCounts}
          showSaturday={showSaturday}
          showSunday={showSunday}
          onPick={onPickDay}
          dayLocks={dayLocks}
          renderDayLock={renderDayLock}
        />
        <div
          data-week-body
          style={{
            display: "grid",
            gridTemplateColumns: gridCols,
            gridTemplateRows: `repeat(${SLOTS.length}, ${ROW}px)`,
            gap: 6,
          }}
        >
          {SLOTS.map((s, i) => (
            <div
              key={"h" + s}
              className="k-mono"
              style={{
                gridColumn: 1,
                gridRow: i + 1,
                fontSize: 10,
                // The :30 labels are muted so the hour still anchors the eye. [AS-2g] A 15' (filas de 24 px) la hora
                // va en negrita y las :15/:45 no llevan etiqueta: cuatro por hora no se leían.
                fontWeight: slotMinutes === 15 && s % 60 === 0 ? 600 : undefined,
                color: s % 60 === 0 ? "var(--navy-300)" : "rgba(15,30,51,0.28)",
                paddingTop: 4,
              }}
            >
              {slotMinutes === 15 && s % 30 !== 0 ? null : slotLabel(s)}
            </div>
          ))}
          {SLOTS.map((slot, i) =>
            visibleDays.map((dayIdx, j) => {
              const blocked = isBlocked(dayIdx, slot);
              return (
                <div
                  key={`cell${i}-${j}`}
                  data-blocked={blocked !== false || undefined}
                  title={blocked !== false ? `Bloqueado${blocked ? `: ${blocked}` : ""}` : undefined}
                  style={{
                    gridColumn: j + 2, gridRow: i + 1,
                    background: blocked !== false ? BLOCKED_STRIPES : "rgba(255,255,255,0.5)", borderRadius: 8,
                    border: "1px solid rgba(15,30,51,0.04)",
                  }}
                />
              );
            })
          )}

          {/* Por celda: líneas compactas si entran; si no, el agregado que abre la lista (G2). */}
          {Array.from(cellMap.entries()).map(([cellKey, cellBookings]) => {
            const [dayColStr, rowStartStr] = cellKey.split("-");
            const dayCol = Number(dayColStr);
            // Skip bookings that fall on a hidden weekend day.
            const colPos = colOf.get(dayCol);
            if (colPos === undefined) return null;
            const rowStart = Number(rowStartStr);
            const first = cellBookings[0];
            const date0 = new Date(first.scheduledFor);
            // Span in SLOTS (not hours), clamped so it neither overflows the
            // grid NOR paints over the next occupied cell in this column — at
            // 30-min granularity a 45/60-min turno spans 2 rows and would
            // otherwise cover (and swallow the clicks of) the :30 chip below.
            const gridRoom = SLOTS.length - rowStart + 1;
            let freeRows = gridRoom;
            for (let r = rowStart + 1; r <= SLOTS.length; r++) {
              if (cellMap.has(`${dayCol}-${r}`)) {
                freeRows = r - rowStart;
                break;
              }
            }
            const span = Math.min(
              Math.max(1, Math.round(first.durationMin / slotMinutes)),
              gridRoom,
              freeRows
            );
            const count = cellBookings.length;
            // Varios profesionales en pantalla: el conteo se parte por iniciales.
            const split = practitionerById ? splitCountByPractitioner(cellBookings, practitioners ?? []) : null;
            // Legend "filter": lift cells that contain a highlighted booking,
            // dim the rest.
            const hasMatch = highlight != null && anyHighlightMatch(highlight, cellBookings);
            const dimmed = highlight != null && !hasMatch;
            // Planes (S19a, plan §3.4 "En Semana, conteo partido"): con algún
            // turno de plan en la celda, "2 de plan · 1 suelto". Sin profesionales
            // partidos reemplaza la palabra "turnos" (la celda de 30 min mide 34 px
            // y no entra una línea más); con el reparto por profesional va como
            // tercera línea y, si no entra, queda en el tooltip y en el modal.
            const planSplit = planLooseSplit(cellBookings);
            const planSplitText = planSplit ? planLooseSplitText(planSplit) : null;
            const multiSplit = split != null && split.length > 1;

            // G2 (VX0-b, clase A): si todos los turnos de la celda entran como líneas compactas, se ven uno por uno
            // (hora + paciente + barra de servicio + fondo de estado) y el click abre el drawer directo. Antes TODA
            // celda era un bloque `--sky-700` sólido «4 turnos» (aun con 1 turno): se perdían servicio, estado,
            // paciente y hora. El agregado queda solo cuando no entran, en tono suave.
            const cellPx = span * ROW + (span - 1) * 6;
            if (count <= weekCellLineCapacity(cellPx)) {
              return (
                <div
                  key={cellKey}
                  data-week-cell="lines"
                  style={{
                    gridColumn: colPos + 2,
                    gridRow: `${rowStart} / span ${span}`,
                    display: "flex",
                    flexDirection: "column",
                    gap: WEEK_LINE_GAP,
                    padding: WEEK_CELL_PAD,
                    minWidth: 0,
                    overflow: "hidden",
                    position: "relative",
                    zIndex: hasMatch ? 5 : undefined,
                  }}
                >
                  {cellBookings.map((b) => (
                    <WeekBookingLine
                      key={b.id}
                      b={b}
                      onEdit={onEdit}
                      practitioner={practitionerById?.get(b.practitionerId) ?? null}
                      dimmed={highlight != null && !anyHighlightMatch(highlight, [b])}
                      roomName={roomNameOf(roomById, b)}
                      now={clock}
                      pulseAnimated={pulseIds.has(b.id)}
                    />
                  ))}
                </div>
              );
            }

            // Barras de los servicios de la celda (hasta 4): el agregado no pierde el canal de servicio.
            const serviceColors = Array.from(new Set(cellBookings.map((b) => b.serviceColor ?? SERVICE_COLOR_FALLBACK))).slice(0, 4);
            // T3-Z (A1): con filas de 15' (26 px) el agregado en columna (número de 15 px + reparto) no entraba y se
            // cortaba. En una fila chica va en una línea, número de 12 px y sin el reparto; lo que no se dibuja queda
            // SIEMPRE en el `title` («3 turnos · AB 2 · CD 1 · 2 de plan · 1 suelto») y en el modal.
            const oneLine = cellPx < WEEK_AGG_ONE_LINE_BELOW;
            const countText = `${count} ${count === 1 ? "turno" : "turnos"}`;
            const cellTitle = [
              countText,
              ...(split && split.length > 0 ? [split.map((x) => `${x.initials} ${x.count}`).join(" · ")] : []),
              ...(planSplitText ? [planSplitText] : []),
            ].join(" · ");

            return (
              <button
                key={cellKey}
                type="button"
                data-week-cell="aggregate"
                title={cellTitle}
                aria-label={`${fmtHour(date0)}: ${count} ${count === 1 ? "turno" : "turnos"}${planSplitText ? ` (${planSplitText})` : ""}. Ver la lista`}
                onClick={() =>
                  setOverflow({
                    bookings: cellBookings,
                    label: `${fmtHour(date0)} · ${count} ${count === 1 ? "turno" : "turnos"}`,
                  })
                }
                style={{
                  gridColumn: colPos + 2,
                  gridRow: `${rowStart} / span ${span}`,
                  background: "var(--sky-50)",
                  color: "var(--navy-900)",
                  border: "1px solid rgba(31,79,190,0.22)",
                  borderRadius: 8,
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: oneLine ? "row" : "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 2,
                  padding: oneLine ? "0 6px 0 10px" : "4px 6px 4px 10px",
                  overflow: "hidden",
                  position: "relative",
                  zIndex: hasMatch ? 5 : undefined,
                  transform: hasMatch ? "translateY(-2px)" : undefined,
                  boxShadow: hasMatch ? "var(--shadow-card-lg)" : undefined,
                  opacity: dimmed ? 0.45 : 1,
                  transition: "transform 0.12s ease, box-shadow 0.12s ease, opacity 0.12s ease",
                }}
              >
                <span aria-hidden="true" style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 4, display: "flex", flexDirection: "column" }}>
                  {serviceColors.map((c) => (
                    <span key={c} style={{ flex: 1, background: c }} />
                  ))}
                </span>
                <span aria-hidden="true" style={{ display: "flex", alignItems: "baseline", gap: 4, lineHeight: 1 }}>
                  <span className="k-mono" style={{ fontSize: oneLine ? 12 : 15, fontWeight: 700, color: "var(--sky-700)" }}>{count}</span>
                  <span style={{ fontSize: 10, fontWeight: 600, color: "var(--navy-500)" }}>{count === 1 ? "turno" : "turnos"}</span>
                </span>
                {oneLine ? null : split && multiSplit ? (
                  <span
                    aria-label={split.map((x) => `${practitionerById?.get(x.id)?.name ?? x.initials}: ${x.count}`).join(", ")}
                    style={{ fontSize: 9, color: "var(--navy-500)", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" }}
                  >
                    {split.map((x) => `${x.initials} ${x.count}`).join(" · ")}
                  </span>
                ) : planSplitText ? null : split && split.length === 1 ? (
                  <span style={{ fontSize: 9, color: "var(--navy-500)", fontWeight: 600 }}>{split[0].initials}</span>
                ) : null}
                {!oneLine && planSplitText && (
                  <span
                    data-plan-split
                    style={{ fontSize: 9, color: "var(--navy-700)", fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" }}
                  >
                    {/* Un solo profesional en la celda: sus iniciales van en la misma línea. */}
                    {!multiSplit && split?.length === 1 ? `${split[0].initials} · ` : ""}
                    {planSplitText}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        </div>
      </Card>

      {overflow && (
        <WeekSlotModal
          bookings={overflow.bookings}
          label={overflow.label}
          onEdit={onEdit}
          onClose={() => setOverflow(null)}
          practitionerById={practitionerById}
          roomById={roomById}
        />
      )}
    </>
  );
}
