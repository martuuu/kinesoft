"use client";

import { useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { localToARIso, toARHour } from "@/lib/datetime-ar";
import { billingLine, fmtHour, layoutBookings, type BookingDTO } from "../agenda-utils";

/** Max bookings shown per overlap group before a "+N more" pill appears.
 *  Kinesiología atiende varios pacientes en paralelo en una misma franja,
 *  así que mostramos una cantidad generosa a ancho completo antes de paginar. */
const TIMELINE_PAGE = 8;

export function TimelineView({
  bookings,
  dayKey,
  onCreate,
  onEdit,
  density,
  businessHours,
}: {
  bookings: BookingDTO[];
  // AR date key ("YYYY-MM-DD") of the day this timeline is showing. Used to
  // build the create-slot instant in AR wall-clock, so clicking an empty
  // hour opens the modal on the *viewed* day at the *viewed* hour — never
  // "today" (the old `bookings[0] ?? new Date()` fallback) nor host-tz-shifted.
  dayKey: string;
  onCreate: (iso: string) => void;
  onEdit: (b: BookingDTO) => void;
  density: "comfortable" | "compact";
  businessHours: { start: number; end: number };
}) {
  const HOURS = Array.from(
    { length: Math.max(1, businessHours.end - businessHours.start) },
    (_, i) => i + businessHours.start
  );
  const ROW = density === "compact" ? 40 : 56;

  // expanded[groupKey] = how many extra pages are showing (0 = only first page)
  const [expanded, setExpanded] = useState<Record<string, number>>({});

  const laid = useMemo(() => layoutBookings(bookings), [bookings]);

  // Group laid items by groupKey to track pagination per group
  const groupCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of laid) m.set(l.groupKey, (m.get(l.groupKey) ?? 0) + 1);
    return m;
  }, [laid]);

  return (
    <Card style={{ padding: 14, height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ flex: 1, overflow: "auto", position: "relative" }}>
        <div style={{ position: "relative", height: HOURS.length * ROW }}>
          {HOURS.map((h, i) => {
            // AR wall-clock instant for this slot on the viewed day.
            const baseIso = localToARIso(`${dayKey}T${String(h).padStart(2, "0")}:00`);
            return (
              <div
                key={h}
                onClick={() => onCreate(baseIso)}
                style={{
                  position: "absolute",
                  top: i * ROW,
                  left: 0,
                  right: 0,
                  height: ROW,
                  borderTop: "1px solid rgba(15,30,51,0.06)",
                  display: "flex",
                  alignItems: "flex-start",
                  cursor: "pointer",
                }}
              >
                <div
                  className="k-mono"
                  style={{ width: 56, paddingTop: 4, fontSize: 11, color: "var(--navy-300)" }}
                >
                  {String(h).padStart(2, "0")}:00
                </div>
              </div>
            );
          })}

          {laid.map((b) => {
            const date = new Date(b.scheduledFor);
            const h = toARHour(date);
            // 3 px top gap so cards don't kiss the hour-line border
            const CARD_GAP = 3;
            // Clamp to the visible range so turnos that fall outside the
            // configured business hours (an early guest booking, or a late
            // 21:30 turno when the window ends at 19:00) still render at the
            // edge instead of off-screen above *or below* the scroll area.
            const rawTop = (h - HOURS[0]) * ROW + CARD_GAP;
            const maxTop = Math.max(CARD_GAP, HOURS.length * ROW - ROW);
            const top = Math.min(maxTop, Math.max(CARD_GAP, rawTop));
            const height = (b.durationMin / 60) * ROW - CARD_GAP - 4;
            const isCancelled = b.status === "CANCELLED";
            const isDone = b.status === "COMPLETED";
            const isNoShow = b.status === "NO_SHOW";

            const totalInGroup = groupCounts.get(b.groupKey) ?? 1;
            const visiblePages = 1 + (expanded[b.groupKey] ?? 0);
            const visibleCols = Math.min(totalInGroup, visiblePages * TIMELINE_PAGE);
            const hiddenCount = totalInGroup - visibleCols;

            if (b.col >= visibleCols) return null;

            // The booking strip starts at 64 px (after the hour label) and uses
            // the FULL remaining width. Overlapping patients split it evenly, so
            // 6-7 turnos en paralelo (kinesiología) llenan toda la cuadrilla en
            // vez de apretarse en la mitad izquierda (el viejo cap de 520 px).
            const STRIP_LEFT = 64;
            const STRIP_GAP = 8;
            const trackW = `calc(100% - ${STRIP_LEFT + STRIP_GAP}px)`;
            const colWidth = `calc((${trackW}) / ${visibleCols})`;
            const colLeft = `calc(${STRIP_LEFT}px + (${trackW}) / ${visibleCols} * ${b.col})`;

            const isLastVisible = b.col === visibleCols - 1 && hiddenCount > 0;

            return (
              <div
                key={b.id}
                style={{
                  position: "absolute",
                  top,
                  left: colLeft,
                  width: colWidth,
                  height,
                  padding: "0 2px",
                  boxSizing: "border-box",
                }}
              >
                <button
                  onClick={() => onEdit(b)}
                  style={{
                    width: "100%",
                    height: "100%",
                    borderRadius: 12,
                    padding: "8px 10px",
                    background: isCancelled
                      ? "rgba(228,70,70,0.1)"
                      : isNoShow
                        ? "rgba(255,176,32,0.14)"
                        : isDone
                          ? "rgba(54,179,126,0.1)"
                          : "rgba(255,255,255,0.85)",
                    border:
                      "1px solid " +
                      (isCancelled
                        ? "rgba(228,70,70,0.3)"
                        : isNoShow
                          ? "rgba(255,176,32,0.45)"
                          : isDone
                            ? "rgba(54,179,126,0.35)"
                            : "rgba(31,79,190,0.12)"),
                    boxShadow: "0 2px 6px rgba(15,30,51,0.04)",
                    color: "var(--navy-900)",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    opacity: isCancelled ? 0.6 : isDone ? 0.85 : 1,
                    cursor: "pointer",
                    textDecoration: isCancelled ? "line-through" : "none",
                    textAlign: "left",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      width: 3,
                      alignSelf: "stretch",
                      borderRadius: 2,
                      background: isCancelled
                        ? "#9F1F1F"
                        : isNoShow
                          ? "#D98200"
                          : isDone
                            ? "#36B37E"
                            : "var(--sky-500)",
                      flexShrink: 0,
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "nowrap" }}>
                      <span className="k-mono" style={{ fontSize: 10, color: "var(--sky-700)", fontWeight: 600, flexShrink: 0 }}>
                        {fmtHour(date)}
                      </span>
                      <span style={{ fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {b.patientName}
                      </span>
                    </div>
                    <div style={{ fontSize: 10, color: "var(--navy-500)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {billingLine(b)}
                    </div>
                  </div>
                </button>

                {isLastVisible && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setExpanded((prev) => ({ ...prev, [b.groupKey]: (prev[b.groupKey] ?? 0) + 1 }));
                    }}
                    title={`Mostrar ${Math.min(hiddenCount, TIMELINE_PAGE)} más`}
                    style={{
                      position: "absolute",
                      bottom: 6,
                      right: 6,
                      background: "var(--sky-700)",
                      color: "#fff",
                      border: "none",
                      borderRadius: 8,
                      fontSize: 10,
                      fontWeight: 700,
                      padding: "2px 6px",
                      cursor: "pointer",
                      lineHeight: 1.4,
                    }}
                  >
                    +{hiddenCount}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}
