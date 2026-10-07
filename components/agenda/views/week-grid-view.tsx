"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { Avatar } from "@/components/ui/avatar";
import { IconX } from "@/components/ui/icons";
import { toARDateKey, toARMinutes } from "@/lib/datetime-ar";
import { dowOfDayKey } from "@/lib/availability/day";
import { splitCountByPractitioner, type AggregatedDayLock } from "@/lib/agenda-client-state";
import { SERVICE_COLOR_FALLBACK } from "@/lib/service-colors";
import { DAYS, fmtHour, fmtMoney, osLabel, buildSlots, slotLabel, slotOf, type BookingDTO } from "../agenda-utils";
import { StatusTag } from "@/components/ui/status-tag";
import { paymentHoldState } from "@/lib/agenda-filters";
import { anyHighlightMatch, type AgendaHighlight } from "@/lib/agenda-highlight";
import { PractitionerBadge } from "../grid/practitioner-badge";
import { PlanMarks, planLooseSplit, planLooseSplitText } from "../grid/booking-card";
import { BLOCKED_STRIPES } from "../grid/unavailable-overlay";

/** Profesional visible con sus iniciales (orden de columnas/chips). */
type WeekPractitioner = { id: string; initials: string; name: string };

/** Slot overflow modal — shows when user clicks "+N más" in the week grid. */
function WeekSlotModal({
  bookings,
  label,
  onEdit,
  onClose,
  practitionerById,
}: {
  bookings: BookingDTO[];
  label: string;
  onEdit: (b: BookingDTO) => void;
  onClose: () => void;
  practitionerById: ReadonlyMap<string, WeekPractitioner> | null;
}) {
  return (
    <div
      role="dialog"
      aria-modal
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,30,51,0.45)",
        backdropFilter: "blur(4px)",
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        className="k-glass-strong"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(560px,100%)", borderRadius: 20, padding: 20 }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--navy-700)" }}>{label}</span>
          <button
            onClick={onClose}
            style={{
              border: "none", background: "rgba(255,255,255,0.7)", width: 30, height: 30,
              borderRadius: 8, cursor: "pointer", color: "var(--navy-700)",
              display: "inline-flex", alignItems: "center", justifyContent: "center",
            }}
          >
            <IconX size={13} />
          </button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {bookings.map((b) => {
            const date = new Date(b.scheduledFor);
            const isCancelled = b.status === "CANCELLED";
            const isDone = b.status === "COMPLETED";
            const prac = practitionerById?.get(b.practitionerId) ?? null;
            return (
              <button
                key={b.id}
                onClick={() => { onEdit(b); onClose(); }}
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "10px 12px", borderRadius: 12, border: "none",
                  background: isCancelled ? "rgba(228,70,70,0.08)" : "rgba(255,255,255,0.7)",
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
                      <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", color: "#9A5B00", background: "rgba(255,176,32,0.22)", borderRadius: 999, padding: "0 6px" }}>
                        Sobreturno
                      </span>
                    )}
                    <PlanMarks b={b} />
                  </div>
                  <div style={{ fontSize: 11, color: "var(--navy-500)" }}>
                    {fmtHour(date)} · {b.serviceName} · {b.durationMin} min
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
      </div>
    </div>
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
 */
export function WeekGridView({
  weekDays,
  bookings,
  onEdit,
  businessHours,
  showHeader,
  showSaturday,
  showSunday,
  highlight,
  practitioners = null,
  dayLocks,
  blockedByDay,
  renderDayLock,
}: {
  weekDays: ReadonlyArray<string>;
  bookings: BookingDTO[];
  onEdit: (b: BookingDTO) => void;
  businessHours: { start: number; end: number; slotMinutes: number };
  showHeader: boolean;
  showSaturday: boolean;
  showSunday: boolean;
  /** Resaltado de la leyenda: las celdas con algún turno que coincide se levantan; el resto se atenúa. */
  highlight: AgendaHighlight | null;
  practitioners?: ReadonlyArray<WeekPractitioner> | null;
  dayLocks?: Readonly<Record<string, AggregatedDayLock | undefined>>;
  blockedByDay?: Readonly<Record<string, ReadonlyMap<number, string | null> | undefined>>;
  renderDayLock?: (dayKey: string) => ReactNode;
}) {
  const practitionerById = useMemo(
    () => (practitioners && practitioners.length > 1 ? new Map(practitioners.map((p) => [p.id, p])) : null),
    [practitioners]
  );
  // Same slot grid as the day view (60 or 30 minutes per row). Half-hour rows
  // double the row count, so they get a shorter height to keep the week from
  // growing twice as tall.
  const slotMinutes = businessHours.slotMinutes === 30 ? 30 : 60;
  const SLOTS = useMemo(
    () => buildSlots(businessHours.start, businessHours.end, slotMinutes),
    [businessHours.start, businessHours.end, slotMinutes]
  );
  const ROW = slotMinutes === 30 ? 34 : 50;

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
  const gridCols = `52px repeat(${visibleDays.length}, 1fr)`;

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
      <Card style={{ padding: 14, height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
        {showHeader && (
          <div style={{ display: "grid", gridTemplateColumns: gridCols, gap: 6, marginBottom: 6 }}>
            <div />
            {visibleDays.map((dayIdx) => {
              const arKey = weekDays[dayIdx];
              // Derive the weekday label from the column's actual AR date so
              // the name and the number can never disagree. With a correct AR
              // Monday this equals DAYS[dayIdx].
              const label = DAYS[(dowOfDayKey(arKey) + 6) % 7];
              const lock = dayLocks?.[arKey];
              return (
                <div
                  key={dayIdx}
                  data-day-status={lock?.status}
                  title={lock && lock.status !== "open" && lock.detail ? lock.detail : undefined}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 6,
                    fontSize: 11,
                    fontWeight: 600,
                    color: "var(--navy-500)",
                    padding: "6px 0",
                    minWidth: 0,
                  }}
                >
                  <span>
                    {label} {Number(arKey.slice(8, 10))}
                  </span>
                  {renderDayLock?.(arKey)}
                </div>
              );
            })}
          </div>
        )}
        <div
          style={{
            flex: 1,
            display: "grid",
            gridTemplateColumns: gridCols,
            gridTemplateRows: `repeat(${SLOTS.length}, ${ROW}px)`,
            gap: 6,
            overflow: "auto",
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
                // The :30 labels are muted so the hour still anchors the eye.
                color: s % 60 === 0 ? "var(--navy-300)" : "rgba(15,30,51,0.28)",
                paddingTop: 4,
              }}
            >
              {slotLabel(s)}
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

          {/* One chip per cell showing total count — click opens the list modal */}
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

            return (
              <button
                key={cellKey}
                title={planSplitText ? `${count} ${count === 1 ? "turno" : "turnos"} · ${planSplitText}` : undefined}
                onClick={() =>
                  setOverflow({
                    bookings: cellBookings,
                    label: `${fmtHour(date0)} · ${count} ${count === 1 ? "turno" : "turnos"}`,
                  })
                }
                style={{
                  gridColumn: colPos + 2,
                  gridRow: `${rowStart} / span ${span}`,
                  background: "var(--sky-700)",
                  color: "#fff",
                  border: "none",
                  borderRadius: 8,
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 2,
                  padding: "4px 6px",
                  overflow: "hidden",
                  position: "relative",
                  zIndex: hasMatch ? 5 : undefined,
                  transform: hasMatch ? "translateY(-2px)" : undefined,
                  boxShadow: hasMatch ? "var(--shadow-card-lg)" : undefined,
                  opacity: dimmed ? 0.45 : 1,
                  transition: "transform 0.12s ease, box-shadow 0.12s ease, opacity 0.12s ease",
                }}
              >
                <span className="k-mono" style={{ fontSize: 18, fontWeight: 700, lineHeight: 1 }}>
                  {count}
                </span>
                {split && multiSplit ? (
                  <span
                    aria-label={split.map((x) => `${practitionerById?.get(x.id)?.name ?? x.initials}: ${x.count}`).join(", ")}
                    style={{ fontSize: 9, opacity: 0.9, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" }}
                  >
                    {split.map((x) => `${x.initials} ${x.count}`).join(" · ")}
                  </span>
                ) : planSplitText ? null : split && split.length === 1 ? (
                  <span style={{ fontSize: 9, opacity: 0.9, fontWeight: 600 }}>
                    {split[0].initials} · {count === 1 ? "turno" : "turnos"}
                  </span>
                ) : (
                  <span style={{ fontSize: 9, opacity: 0.85, fontWeight: 600 }}>
                    {count === 1 ? "turno" : "turnos"}
                  </span>
                )}
                {planSplitText && (
                  <span
                    data-plan-split
                    style={{ fontSize: 9, opacity: 0.95, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" }}
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
      </Card>

      {overflow && (
        <WeekSlotModal
          bookings={overflow.bookings}
          label={overflow.label}
          onEdit={onEdit}
          onClose={() => setOverflow(null)}
          practitionerById={practitionerById}
        />
      )}
    </>
  );
}
