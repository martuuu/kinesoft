"use client";

import { useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Avatar } from "@/components/ui/avatar";
import { IconX } from "@/components/ui/icons";
import { toARDateKey, toARDow, toARMinutes } from "@/lib/datetime-ar";
import { SERVICE_COLOR_FALLBACK } from "@/lib/service-colors";
import { DAYS, fmtHour, fmtMoney, osLabel, buildSlots, slotLabel, slotOf, type BookingDTO } from "../agenda-utils";
import { StatusTag } from "./list-view";

/** Slot overflow modal — shows when user clicks "+N más" in the week grid. */
function WeekSlotModal({
  bookings,
  label,
  onEdit,
  onClose,
}: {
  bookings: BookingDTO[];
  label: string;
  onEdit: (b: BookingDTO) => void;
  onClose: () => void;
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
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--navy-900)" }}>{b.patientName}</div>
                  <div style={{ fontSize: 11, color: "var(--navy-500)" }}>
                    {fmtHour(date)} · {b.serviceName} · {b.durationMin} min
                  </div>
                  <div style={{ fontSize: 11, color: "var(--navy-400)", marginTop: 1 }}>
                    {[osLabel(b.obraSocial), fmtMoney(b.copagoCents)].filter(Boolean).join(" · ")}
                  </div>
                </div>
                <StatusTag s={b.status} />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function WeekGridView({
  weekStart,
  bookings,
  onEdit,
  businessHours,
  showHeader,
  showSaturday,
  showSunday,
  highlightedServiceId,
}: {
  weekStart: Date;
  bookings: BookingDTO[];
  onEdit: (b: BookingDTO) => void;
  businessHours: { start: number; end: number; slotMinutes: number };
  showHeader: boolean;
  showSaturday: boolean;
  showSunday: boolean;
  /** When set, cells containing this service lift; the rest dim. */
  highlightedServiceId: string | null;
}) {
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
    for (const b of bookings) {
      const date = new Date(b.scheduledFor);
      const dayCol = (toARDow(date) + 6) % 7;
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
  }, [bookings, SLOTS, slotMinutes]);

  return (
    <>
      <Card style={{ padding: 14, height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
        {showHeader && (
          <div style={{ display: "grid", gridTemplateColumns: gridCols, gap: 6, marginBottom: 6 }}>
            <div />
            {visibleDays.map((dayIdx) => {
              const day = new Date(weekStart);
              day.setDate(day.getDate() + dayIdx);
              const arKey = toARDateKey(day);
              // Derive the weekday label from the column's actual AR date so
              // the name and the number can never disagree (defends against
              // any future weekStart drift). With a correct AR Monday this
              // equals DAYS[dayIdx].
              const label = DAYS[(toARDow(day) + 6) % 7];
              return (
                <div key={dayIdx} style={{ textAlign: "center", fontSize: 11, fontWeight: 600, color: "var(--navy-500)", padding: "6px 0" }}>
                  {label} {Number(arKey.slice(8, 10))}
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
          {SLOTS.map((_, i) =>
            visibleDays.map((__, j) => (
              <div
                key={`cell${i}-${j}`}
                style={{
                  gridColumn: j + 2, gridRow: i + 1,
                  background: "rgba(255,255,255,0.5)", borderRadius: 8,
                  border: "1px solid rgba(15,30,51,0.04)",
                }}
              />
            ))
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
            // Legend "filter": lift cells that contain the highlighted service,
            // dim the rest.
            const hasMatch =
              highlightedServiceId != null &&
              cellBookings.some((b) => b.serviceId === highlightedServiceId);
            const dimmed = highlightedServiceId != null && !hasMatch;

            return (
              <button
                key={cellKey}
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
                <span style={{ fontSize: 9, opacity: 0.85, fontWeight: 600 }}>
                  {count === 1 ? "turno" : "turnos"}
                </span>
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
        />
      )}
    </>
  );
}
