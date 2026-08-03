"use client";

import { useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { localToARIso, toARHour } from "@/lib/datetime-ar";
import { SERVICE_COLOR_FALLBACK } from "@/lib/service-colors";
import { fmtHour, layoutBookings, type BookingDTO } from "../agenda-utils";

/** Turnos overlapping the same slot spread across up to MAX_COLS columns at
 *  full width; extras wrap to rows below. DEFAULT_ROWS rows (= MAX_COLS*rows
 *  turnos) show before a "+N" pill reveals more, expanding the hour block. */
const MAX_COLS = 5;
const DEFAULT_ROWS = 2;

export function TimelineView({
  bookings,
  dayKey,
  onCreate,
  onEdit,
  density,
  businessHours,
  highlightedServiceId,
}: {
  bookings: BookingDTO[];
  // AR date key ("YYYY-MM-DD") of the day this timeline is showing. Used to
  // build the create-slot instant in AR wall-clock, so clicking an empty
  // hour opens the modal on the *viewed* day at the *viewed* hour.
  dayKey: string;
  onCreate: (iso: string) => void;
  onEdit: (b: BookingDTO) => void;
  density: "comfortable" | "compact";
  businessHours: { start: number; end: number };
  /** When set, cards of this service lift above the rest (legend "filter"). */
  highlightedServiceId: string | null;
}) {
  const HOURS = Array.from(
    { length: Math.max(1, businessHours.end - businessHours.start) },
    (_, i) => i + businessHours.start
  );
  const ROW = density === "compact" ? 40 : 56;

  // expanded[groupKey] = how many extra pages of rows are showing (0 = default)
  const [expanded, setExpanded] = useState<Record<string, number>>({});

  const laid = useMemo(() => layoutBookings(bookings), [bookings]);

  // Per-group metadata: total columns + the earliest hour-row the group starts.
  const groupMeta = useMemo(() => {
    const m = new Map<string, { cols: number; firstIdx: number }>();
    for (const b of laid) {
      const idx = Math.max(
        0,
        Math.min(HOURS.length - 1, Math.floor(toARHour(new Date(b.scheduledFor)) - HOURS[0]))
      );
      const cur = m.get(b.groupKey);
      if (!cur) m.set(b.groupKey, { cols: b.cols, firstIdx: idx });
      else cur.firstIdx = Math.min(cur.firstIdx, idx);
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laid, HOURS.length, HOURS[0]]);

  const visibleRowsOf = (key: string, cols: number) => {
    const totalRows = Math.ceil(cols / MAX_COLS);
    const pages = 1 + (expanded[key] ?? 0);
    return Math.min(totalRows, DEFAULT_ROWS * pages);
  };

  // Wrapped groups add extra rows below their first hour; accumulate a vertical
  // offset so later hours (and their gridlines) push down and nothing overlaps.
  const { offsetBeforeIdx, totalExtra } = useMemo(() => {
    const extra = new Array(HOURS.length).fill(0);
    for (const [key, meta] of groupMeta) {
      const e = Math.max(0, visibleRowsOf(key, meta.cols) - 1);
      if (e > 0) extra[meta.firstIdx] = Math.max(extra[meta.firstIdx], e);
    }
    const off = new Array(HOURS.length + 1).fill(0);
    let acc = 0;
    for (let i = 0; i < HOURS.length; i++) {
      off[i] = acc;
      acc += extra[i] * ROW;
    }
    off[HOURS.length] = acc;
    return { offsetBeforeIdx: off, totalExtra: acc };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupMeta, expanded, HOURS.length, ROW]);

  const canvasHeight = HOURS.length * ROW + totalExtra;

  return (
    <Card style={{ padding: 14, height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ flex: 1, overflow: "auto", position: "relative" }}>
        <div style={{ position: "relative", height: canvasHeight }}>
          {HOURS.map((h, i) => {
            // AR wall-clock instant for this slot on the viewed day.
            const baseIso = localToARIso(`${dayKey}T${String(h).padStart(2, "0")}:00`);
            return (
              <div
                key={h}
                onClick={() => onCreate(baseIso)}
                style={{
                  position: "absolute",
                  top: i * ROW + offsetBeforeIdx[i],
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
            const hourFloat = toARHour(date) - HOURS[0];
            const ownIdx = Math.max(0, Math.min(HOURS.length - 1, Math.floor(hourFloat)));
            const CARD_GAP = 3;

            const cols = b.cols;
            const totalRows = Math.ceil(cols / MAX_COLS);
            const visibleRows = visibleRowsOf(b.groupKey, cols);
            const rowInGroup = Math.floor(b.col / MAX_COLS);
            const colInRow = b.col % MAX_COLS;
            if (rowInGroup >= visibleRows) return null;
            const wrapped = totalRows > 1;

            // Vertical: base by hour + accumulated offset + this card's wrap row.
            const base = hourFloat * ROW + (offsetBeforeIdx[ownIdx] ?? 0);
            const rawTop = base + rowInGroup * ROW + CARD_GAP;
            const maxTop = Math.max(CARD_GAP, canvasHeight - ROW);
            const top = Math.min(maxTop, Math.max(CARD_GAP, rawTop));
            // Wrapped groups use a fixed row height so stacked rows never
            // overlap; single-row turnos keep their duration-proportional height.
            const height = wrapped
              ? ROW - CARD_GAP - 4
              : (b.durationMin / 60) * ROW - CARD_GAP - 4;

            // Horizontal: split the FULL width by the cards in THIS row (the
            // last row may be partial), so up to 5 columns fill the strip.
            const colsInRow = Math.min(MAX_COLS, cols - rowInGroup * MAX_COLS);
            const STRIP_LEFT = 64;
            const STRIP_GAP = 8;
            const trackW = `calc(100% - ${STRIP_LEFT + STRIP_GAP}px)`;
            const colWidth = `calc((${trackW}) / ${colsInRow})`;
            const colLeft = `calc(${STRIP_LEFT}px + (${trackW}) / ${colsInRow} * ${colInRow})`;

            const isCancelled = b.status === "CANCELLED";
            const isDone = b.status === "COMPLETED";
            const isNoShow = b.status === "NO_SHOW";

            // Left bar = the service's colour (identity); state is conveyed by
            // the card's tint / opacity / strike-through.
            const barColor = b.serviceColor ?? SERVICE_COLOR_FALLBACK;
            // Legend "filter": lift this card's service, dim the rest.
            const isHighlighted =
              highlightedServiceId != null && b.serviceId === highlightedServiceId;
            const dimmed =
              highlightedServiceId != null && b.serviceId !== highlightedServiceId;
            // Card subtitle: the mini-diagnosis (title), falling back to the
            // longer description — whichever the kine filled. Never the service.
            const cardLabel = b.title || b.description;

            const hiddenCount = cols - visibleRows * MAX_COLS;
            const isLastVisible =
              rowInGroup === visibleRows - 1 &&
              colInRow === colsInRow - 1 &&
              visibleRows < totalRows &&
              hiddenCount > 0;

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
                  zIndex: isHighlighted ? 5 : undefined,
                  transform: isHighlighted ? "translateY(-2px)" : undefined,
                  transition: "transform 0.12s ease",
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
                    boxShadow: isHighlighted
                      ? "var(--shadow-card-lg)"
                      : "0 2px 6px rgba(15,30,51,0.04)",
                    color: "var(--navy-900)",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    opacity: isCancelled ? 0.6 : dimmed ? 0.55 : isDone ? 0.85 : 1,
                    cursor: "pointer",
                    textDecoration: isCancelled ? "line-through" : "none",
                    textAlign: "left",
                    overflow: "hidden",
                    transition: "box-shadow 0.12s ease, opacity 0.12s ease",
                  }}
                >
                  <div
                    style={{
                      width: 3,
                      alignSelf: "stretch",
                      borderRadius: 2,
                      background: barColor,
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
                    {cardLabel ? (
                      <div style={{ fontSize: 10, color: "var(--navy-500)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {cardLabel}
                      </div>
                    ) : null}
                  </div>
                </button>

                {isLastVisible && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setExpanded((prev) => ({ ...prev, [b.groupKey]: (prev[b.groupKey] ?? 0) + 1 }));
                    }}
                    title={`Mostrar ${hiddenCount} más`}
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
