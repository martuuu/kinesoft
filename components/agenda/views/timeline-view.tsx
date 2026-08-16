"use client";

import { useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { localToARIso, toARMinutes } from "@/lib/datetime-ar";
import { SERVICE_COLOR_FALLBACK } from "@/lib/service-colors";
import {
  fmtHour,
  buildSlots,
  slotLabel,
  slotOf,
  coveredSlots,
  type BookingDTO,
} from "../agenda-utils";

/**
 * Day timeline — one row per SLOT (60 or 30 minutes, per `Tenant.agendaSlotMinutes`),
 * cards laid out IN FLOW.
 *
 * Turnos are bucketed into the slot they start in and rendered in a wrapping
 * flex row, so the row grows to fit them instead of cards being absolutely
 * positioned by time (that positioning made cards from adjacent slots overlap
 * and bleed across the gridlines). At 30-minute granularity a 13:30 turno gets
 * its own labelled row instead of being folded into 13:00.
 *
 * Width: up to MAX_PER_ROW across, each capped at CARD_MAX so one or two
 * turnos don't stretch into unreadable banners; text truncates instead.
 */
const MAX_PER_ROW = 5;
const CARD_MIN = 186;
const CARD_MAX = 280;
const CARD_GAP = 8;
/** Cards shown per slot before the "+N" reveal (2 full rows). */
const COLLAPSED_LIMIT = MAX_PER_ROW * 2;

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
  // slot opens the modal on the *viewed* day at the *viewed* time.
  dayKey: string;
  onCreate: (iso: string) => void;
  onEdit: (b: BookingDTO) => void;
  density: "comfortable" | "compact";
  businessHours: { start: number; end: number; slotMinutes: number };
  /** When set, cards of this service lift above the rest (legend "filter"). */
  highlightedServiceId: string | null;
}) {
  const { start, end, slotMinutes } = businessHours;
  const half = slotMinutes === 30;
  // Half-hour rows double the row count, so they get a shorter minimum height
  // to keep the day scannable without doubling the page length.
  const ROW_MIN = density === "compact" ? (half ? 34 : 44) : half ? 44 : 58;

  const { slots, bySlot, before, after, ongoing } = useMemo(() => {
    const slots = buildSlots(start, end, slotMinutes);
    const bySlot = new Map<number, BookingDTO[]>();
    const before: BookingDTO[] = [];
    const after: BookingDTO[] = [];
    /** slot → names of turnos that started earlier and still run through it. */
    const ongoing = new Map<number, string[]>();

    for (const b of bookings) {
      const mins = toARMinutes(b.scheduledFor);
      const { slot, outOfRange } = slotOf(mins, slots, slotMinutes);
      if (outOfRange === "before") before.push(b);
      else if (outOfRange === "after") after.push(b);
      else {
        const list = bySlot.get(slot);
        if (list) list.push(b);
        else bySlot.set(slot, [b]);
        // Mark the rows this turno keeps occupying, so they don't read as free.
        for (const s of coveredSlots(mins, b.durationMin, slots, slotMinutes)) {
          ongoing.set(s, [...(ongoing.get(s) ?? []), b.patientName]);
        }
      }
    }
    const byTime = (a: BookingDTO, z: BookingDTO) => a.scheduledFor.localeCompare(z.scheduledFor);
    for (const list of bySlot.values()) list.sort(byTime);
    before.sort(byTime);
    after.sort(byTime);
    return { slots, bySlot, before, after, ongoing };
  }, [bookings, start, end, slotMinutes]);

  return (
    <Card style={{ padding: 14, height: "100%", display: "flex", flexDirection: "column" }}>
      <div className="k-scroll" style={{ flex: 1, overflowY: "auto" }}>
        {before.length > 0 && (
          <OutOfRangeRow label="Antes del horario" items={before} onEdit={onEdit} highlightedServiceId={highlightedServiceId} compact={density === "compact"} />
        )}

        {slots.map((slot) => (
          <SlotRow
            key={slot}
            slot={slot}
            items={bySlot.get(slot) ?? []}
            ongoingNames={ongoing.get(slot) ?? []}
            dayKey={dayKey}
            onCreate={onCreate}
            onEdit={onEdit}
            highlightedServiceId={highlightedServiceId}
            compact={density === "compact"}
            rowMin={ROW_MIN}
            half={half}
          />
        ))}

        {after.length > 0 && (
          <OutOfRangeRow label="Después del horario" items={after} onEdit={onEdit} highlightedServiceId={highlightedServiceId} compact={density === "compact"} />
        )}
      </div>
    </Card>
  );
}

function SlotRow({
  slot,
  items,
  ongoingNames,
  dayKey,
  onCreate,
  onEdit,
  highlightedServiceId,
  compact,
  rowMin,
  half,
}: {
  slot: number;
  items: BookingDTO[];
  ongoingNames: string[];
  dayKey: string;
  onCreate: (iso: string) => void;
  onEdit: (b: BookingDTO) => void;
  highlightedServiceId: string | null;
  compact: boolean;
  rowMin: number;
  half: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const label = slotLabel(slot);
  const createIso = localToARIso(`${dayKey}T${label}`);
  const create = () => onCreate(createIso);

  const shown = expanded ? items : items.slice(0, COLLAPSED_LIMIT);
  const hidden = items.length - shown.length;
  // Half-hour rows: the :30 label is muted so the hour still reads as the anchor.
  const isHalfLabel = half && slot % 60 !== 0;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "stretch",
        gap: 8,
        minHeight: rowMin,
        borderTop: isHalfLabel ? "1px dashed rgba(15,30,51,0.05)" : "1px solid rgba(15,30,51,0.07)",
        padding: "5px 0",
      }}
    >
      {/* The label itself creates at this slot — it used to be a dead strip. */}
      <button
        onClick={create}
        aria-label={`Nuevo turno ${label}`}
        className="k-mono"
        style={{
          width: 48,
          flexShrink: 0,
          alignSelf: "flex-start",
          paddingTop: 3,
          border: "none",
          background: "transparent",
          textAlign: "left",
          cursor: "pointer",
          fontSize: 11,
          color: isHalfLabel ? "rgba(15,30,51,0.28)" : "var(--navy-300)",
        }}
      >
        {label}
      </button>

      {items.length === 0 ? (
        <button
          onClick={create}
          aria-label={`Nuevo turno ${label}`}
          style={{
            flex: 1,
            border: "none",
            background: "transparent",
            borderRadius: 10,
            cursor: "pointer",
            minHeight: rowMin - 10,
            display: "flex",
            alignItems: "center",
            paddingLeft: 4,
          }}
        >
          {ongoingNames.length > 0 && <OngoingHint names={ongoingNames} />}
        </button>
      ) : (
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexWrap: "wrap", gap: CARD_GAP, alignItems: "flex-start" }}>
          {shown.map((b) => (
            <BookingCard
              key={b.id}
              b={b}
              onEdit={onEdit}
              highlightedServiceId={highlightedServiceId}
              compact={compact}
            />
          ))}

          {hidden > 0 && (
            <button
              onClick={() => setExpanded(true)}
              style={{
                alignSelf: "center",
                border: "1px solid rgba(31,79,190,0.25)",
                background: "rgba(31,79,190,0.06)",
                color: "var(--sky-700)",
                borderRadius: 10,
                padding: "6px 12px",
                fontSize: 11.5,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              +{hidden} más
            </button>
          )}
          {expanded && items.length > COLLAPSED_LIMIT && (
            <button
              onClick={() => setExpanded(false)}
              style={{
                alignSelf: "center",
                border: "none",
                background: "transparent",
                color: "var(--navy-400)",
                fontSize: 11.5,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Ver menos
            </button>
          )}

          {ongoingNames.length > 0 && <OngoingHint names={ongoingNames} />}

          {/* Leftover space still creates a turno here. Capped so it can't wrap
              into a full-width invisible strip under the cards. */}
          <button
            onClick={create}
            aria-label={`Nuevo turno ${label}`}
            style={{
              flex: `1 1 40px`,
              maxWidth: CARD_MAX,
              minHeight: 26,
              border: "none",
              background: "transparent",
              borderRadius: 10,
              cursor: "pointer",
            }}
          />
        </div>
      )}
    </div>
  );
}

/** Turnos that started in an earlier slot and still run through this one. */
function OngoingHint({ names }: { names: string[] }) {
  const label =
    names.length === 1 ? `continúa ${names[0]}` : `continúan ${names.length} turnos`;
  return (
    <span
      title={names.join(" · ")}
      style={{
        alignSelf: "center",
        fontSize: 10.5,
        color: "var(--navy-300)",
        fontStyle: "italic",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        maxWidth: 200,
        pointerEvents: "none",
      }}
    >
      · {label}
    </span>
  );
}

/** Turnos outside the business-hours window get their own row so they neither
 *  disappear nor compete for a real slot's "+N" budget. */
function OutOfRangeRow({
  label,
  items,
  onEdit,
  highlightedServiceId,
  compact,
}: {
  label: string;
  items: BookingDTO[];
  onEdit: (b: BookingDTO) => void;
  highlightedServiceId: string | null;
  compact: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "stretch",
        gap: 8,
        padding: "6px 0",
        borderTop: "1px solid rgba(15,30,51,0.07)",
        background: "rgba(255,176,32,0.05)",
      }}
    >
      <span
        style={{
          width: 48,
          flexShrink: 0,
          paddingTop: 4,
          fontSize: 9.5,
          fontWeight: 700,
          lineHeight: 1.25,
          color: "#9A5B00",
        }}
      >
        {label}
      </span>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexWrap: "wrap", gap: CARD_GAP }}>
        {items.map((b) => (
          <BookingCard
            key={b.id}
            b={b}
            onEdit={onEdit}
            highlightedServiceId={highlightedServiceId}
            compact={compact}
          />
        ))}
      </div>
    </div>
  );
}

function BookingCard({
  b,
  onEdit,
  highlightedServiceId,
  compact,
}: {
  b: BookingDTO;
  onEdit: (b: BookingDTO) => void;
  highlightedServiceId: string | null;
  compact: boolean;
}) {
  const date = new Date(b.scheduledFor);
  const isCancelled = b.status === "CANCELLED";
  const isDone = b.status === "COMPLETED";
  const isNoShow = b.status === "NO_SHOW";

  // Left bar = the service's colour (identity); state is conveyed by the
  // card's tint / opacity / strike-through.
  const barColor = b.serviceColor ?? SERVICE_COLOR_FALLBACK;
  // Legend "filter": lift this card's service, dim the rest.
  const isHighlighted = highlightedServiceId != null && b.serviceId === highlightedServiceId;
  const dimmed = highlightedServiceId != null && b.serviceId !== highlightedServiceId;
  // Card subtitle: the mini-diagnosis (title), falling back to the longer
  // description — whichever the kine filled. Never the service name.
  const cardLabel = b.title || b.description;

  return (
    <button
      onClick={() => onEdit(b)}
      title={`${fmtHour(date)} · ${b.durationMin} min · ${b.patientName}${cardLabel ? ` · ${cardLabel}` : ""}`}
      style={{
        // Up to 5 per row, but never wider than CARD_MAX — a lone turno keeps
        // a sane width instead of stretching across the whole agenda.
        flexBasis: `calc((100% - ${(MAX_PER_ROW - 1) * CARD_GAP}px) / ${MAX_PER_ROW})`,
        flexGrow: 0,
        flexShrink: 1,
        minWidth: CARD_MIN,
        maxWidth: CARD_MAX,
        borderRadius: 12,
        padding: compact ? "6px 9px" : "8px 10px",
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
        boxShadow: isHighlighted ? "var(--shadow-card-lg)" : "0 2px 6px rgba(15,30,51,0.04)",
        color: "var(--navy-900)",
        display: "flex",
        alignItems: "center",
        gap: 8,
        opacity: isCancelled ? 0.6 : dimmed ? 0.55 : isDone ? 0.85 : 1,
        cursor: "pointer",
        textDecoration: isCancelled ? "line-through" : "none",
        textAlign: "left",
        overflow: "hidden",
        transform: isHighlighted ? "translateY(-2px)" : undefined,
        transition: "transform 0.12s ease, box-shadow 0.12s ease, opacity 0.12s ease",
      }}
    >
      <div
        style={{
          width: 3,
          alignSelf: "stretch",
          minHeight: 26,
          borderRadius: 2,
          background: barColor,
          flexShrink: 0,
        }}
      />
      <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "nowrap" }}>
          <span
            className="k-mono"
            style={{ fontSize: 10, color: "var(--sky-700)", fontWeight: 600, flexShrink: 0 }}
          >
            {fmtHour(date)}
          </span>
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {b.patientName}
          </span>
        </div>
        <div
          style={{
            fontSize: 10,
            color: "var(--navy-500)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            display: "flex",
            gap: 4,
          }}
        >
          {/* Duration FIRST and unshrinkable: card height is no longer
              proportional to it, and putting it last let the ellipsis eat it. */}
          <span className="k-mono" style={{ flexShrink: 0 }}>{b.durationMin}′</span>
          {cardLabel && (
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              · {cardLabel}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}
