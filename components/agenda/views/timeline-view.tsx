"use client";

import { useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { localToARIso, toARMinutes } from "@/lib/datetime-ar";
import {
  buildSlots,
  slotLabel,
  slotOf,
  coveredSlots,
  type BookingDTO,
} from "../agenda-utils";
import type { AgendaHighlight } from "@/lib/agenda-highlight";
import { BookingCard, type BookingCardSizing } from "../grid/booking-card";
import { BLOCKED_STRIPES, LockIcon } from "../grid/unavailable-overlay";
import { denseOverflow, overflowButtonText } from "../grid/slot-cell";

/** Iniciales por profesional (solo con más de uno en pantalla; ver `BookingCard`). */
export type PractitionerInitialsMap = Readonly<Record<string, { initials: string; name: string }>>;

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
 *
 * B4.3: filas bloqueadas (candado / bloqueo de horario) con fondo rayado,
 * candado y motivo, igual que la vista Por profesional. Como el Día mezcla a
 * todos los profesionales visibles, una fila se raya solo si está bloqueada
 * para TODOS (`blockedRows` de `lib/agenda-client-state`); `dayLocked` raya el
 * día entero. El click en una fila rayada igual abre el alta: el modal avisa y
 * pide confirmarlo como sobreturno (decisión 1 de B-pre), como hacía antes.
 *
 * S19e (Planes, ES3): el chip y "Fuera de plan" son de la card (S19a). Acá,
 * con resaltado activo (servicio, plan o suelto) las cards que coinciden van
 * primero en la fila y el "+N más" dice cuántas resaltadas o "Fuera de plan"
 * esconde (`denseOverflow` de `grid/slot-cell`, compartido con Por
 * profesional): con 10+ turnos en una franja del gimnasio, lo resaltado no
 * puede quedar oculto. Sin resaltado el orden sigue siendo por hora.
 */
const MAX_PER_ROW = 5;
const CARD_MIN = 186;
const CARD_MAX = 280;
const CARD_GAP = 8;
/** Cards shown per slot before the "+N" reveal (2 full rows). */
const COLLAPSED_LIMIT = MAX_PER_ROW * 2;
/** Up to 5 per row, but never wider than CARD_MAX — a lone turno keeps a sane
 *  width instead of stretching across the whole agenda. */
const timelineCardSizing: BookingCardSizing = {
  flexBasis: `calc((100% - ${(MAX_PER_ROW - 1) * CARD_GAP}px) / ${MAX_PER_ROW})`,
  flexGrow: 0,
  flexShrink: 1,
  minWidth: CARD_MIN,
  maxWidth: CARD_MAX,
};

export function TimelineView({
  bookings,
  dayKey,
  onCreate,
  onEdit,
  density,
  businessHours,
  highlight,
  practitionerById = null,
  now,
  blockedRows = null,
  dayLocked = null,
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
  /** Resaltado de la leyenda (`lib/agenda-highlight.ts`): las cards que coinciden se levantan, el resto se atenúa. */
  highlight: AgendaHighlight | null;
  /** B4.3: iniciales en las cards (null = un solo profesional en pantalla). */
  practitionerById?: PractitionerInitialsMap | null;
  /** B4.3: reloj de la agenda (se refresca cada minuto). */
  now?: Date;
  /** B4.3: minuto de inicio de fila → motivo, para las filas bloqueadas para todos. */
  blockedRows?: ReadonlyMap<number, string | null> | null;
  /** B4.3: día entero bloqueado (motivo en `detail`). */
  dayLocked?: { detail: string | null } | null;
}) {
  const { start, end, slotMinutes } = businessHours;
  const cardExtras = { practitionerById, now };
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
          <OutOfRangeRow label="Antes del horario" items={before} onEdit={onEdit} highlight={highlight} compact={density === "compact"} {...cardExtras} />
        )}

        {slots.map((slot, i) => {
          const blocked = !!dayLocked || (blockedRows?.has(slot) ?? false);
          const prevBlocked = i > 0 && (!!dayLocked || (blockedRows?.has(slots[i - 1]) ?? false));
          return (
          <SlotRow
            key={slot}
            slot={slot}
            blocked={blocked}
            blockLabel={
              blocked && !prevBlocked
                ? (dayLocked ? dayLocked.detail : blockedRows?.get(slot) ?? null) || "Bloqueado"
                : null
            }
            {...cardExtras}
            items={bySlot.get(slot) ?? []}
            ongoingNames={ongoing.get(slot) ?? []}
            dayKey={dayKey}
            onCreate={onCreate}
            onEdit={onEdit}
            highlight={highlight}
            compact={density === "compact"}
            rowMin={ROW_MIN}
            half={half}
          />
          );
        })}

        {after.length > 0 && (
          <OutOfRangeRow label="Después del horario" items={after} onEdit={onEdit} highlight={highlight} compact={density === "compact"} {...cardExtras} />
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
  highlight,
  compact,
  rowMin,
  half,
  blocked = false,
  blockLabel = null,
  practitionerById = null,
  now,
}: {
  slot: number;
  items: BookingDTO[];
  ongoingNames: string[];
  dayKey: string;
  onCreate: (iso: string) => void;
  onEdit: (b: BookingDTO) => void;
  highlight: AgendaHighlight | null;
  compact: boolean;
  rowMin: number;
  half: boolean;
  blocked?: boolean;
  /** Texto del motivo, solo en la primera fila de un tramo bloqueado. */
  blockLabel?: string | null;
  practitionerById?: PractitionerInitialsMap | null;
  now?: Date;
}) {
  const [expanded, setExpanded] = useState(false);
  const label = slotLabel(slot);
  const createIso = localToARIso(`${dayKey}T${label}`);
  const create = () => onCreate(createIso);

  const overflow = denseOverflow(items, COLLAPSED_LIMIT, expanded, highlight);
  const { shown, hidden } = overflow;
  const more = overflowButtonText(overflow, highlight != null, `a las ${label}`);
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
        background: blocked ? BLOCKED_STRIPES : undefined,
      }}
      data-blocked={blocked || undefined}
      title={blocked ? `Bloqueado${blockLabel && blockLabel !== "Bloqueado" ? `: ${blockLabel}` : ""}` : undefined}
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
          {blockLabel && <BlockedHint label={blockLabel} />}
          {ongoingNames.length > 0 && <OngoingHint names={ongoingNames} />}
        </button>
      ) : (
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexWrap: "wrap", gap: CARD_GAP, alignItems: "flex-start" }}>
          {blockLabel && <BlockedHint label={blockLabel} />}
          {shown.map((b) => (
            <BookingCard
              key={b.id}
              b={b}
              onEdit={onEdit}
              highlight={highlight}
              compact={compact}
              sizing={timelineCardSizing}
              practitioner={practitionerById?.[b.practitionerId] ?? null}
              now={now}
            />
          ))}

          {hidden > 0 && (
            <button
              onClick={() => setExpanded(true)}
              aria-label={more.ariaLabel}
              data-overflow-matches={overflow.hiddenMatches > 0 ? overflow.hiddenMatches : undefined}
              data-overflow-out-of-plan={overflow.hiddenOutOfPlan > 0 ? overflow.hiddenOutOfPlan : undefined}
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
              {more.text}
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

/** Candado + motivo al inicio de un tramo bloqueado. */
function BlockedHint({ label }: { label: string }) {
  return (
    <span
      style={{
        alignSelf: "center",
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: 10.5,
        fontWeight: 600,
        color: "var(--navy-500)",
        background: "rgba(255,255,255,0.85)",
        borderRadius: 6,
        padding: "1px 6px",
        whiteSpace: "nowrap",
        maxWidth: 220,
        overflow: "hidden",
        textOverflow: "ellipsis",
        pointerEvents: "none",
      }}
    >
      <LockIcon locked size={10} />
      {label}
    </span>
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
  highlight,
  compact,
  practitionerById = null,
  now,
}: {
  label: string;
  items: BookingDTO[];
  onEdit: (b: BookingDTO) => void;
  highlight: AgendaHighlight | null;
  compact: boolean;
  practitionerById?: PractitionerInitialsMap | null;
  now?: Date;
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
            highlight={highlight}
            compact={compact}
            sizing={timelineCardSizing}
            practitioner={practitionerById?.[b.practitionerId] ?? null}
            now={now}
          />
        ))}
      </div>
    </div>
  );
}
