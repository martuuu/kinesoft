"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Drawer } from "@/components/ui/drawer";
import { BookingDrawer } from "@/components/agenda/booking-drawer";
import { ModalCloseButton } from "@/components/ui/modal-close";
import { FormField } from "@/components/ui/form-field";
import type { BookingStatus } from "@prisma/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/avatar";
import { Tag } from "@/components/ui/tag";
import {
  IconArrow,
  IconChevL,
  IconChevR,
  IconCheck,
  IconPlus,
  IconX,
} from "@/components/ui/icons";
import {
  createBooking,
  createBookingSeries,
  createBookingPlan,
  deleteBooking,
  setBookingStatus,
} from "@/lib/bookings";
import { PatientPicker } from "@/components/patients/patient-picker";
import { localToARIso, isoToARLocalInput, toARDateKey, toARHour, toARDow } from "@/lib/datetime-ar";

type BookingDTO = {
  id: string;
  scheduledFor: string;
  durationMin: number;
  status: BookingStatus;
  serviceName: string;
  practitionerId: string;
  patientId: string | null;
  patientName: string;
  patientCondition: string | null;
  notes: string | null;
  /**
   * Sprint 16: tells the agenda whether to expose the link-to-HC + the
   * diagnosis chip. `"basic"` shows the booking + name only; `"none"`
   * is a guest booking (no patient row yet).
   */
  patientAccess: "full" | "basic" | "none";
};

type Props = {
  view: "timeline" | "week" | "list";
  anchorISO: string;
  weekStartISO: string;
  autoCreate?: boolean;
  autoCreatePatientId?: string | null;
  practitionerFilterId?: string | null;
  bookings: BookingDTO[];
  services: { id: string; name: string; durationMin: number; priceCents: number }[];
  practitioners: { id: string; name: string }[];
  patients: { id: string; name: string }[];
  /**
   * Business-hours window from `Tenant.businessHoursStart/End`
   * (Sprint 17). Controls the row range in TimelineView, the
   * preset list in BookingModal time picker, and the slot grid.
   * Default fallback 8..19 matches the pre-Sprint 17 hardcoded
   * constants in case the server forgets to pass them.
   */
  businessHours?: { start: number; end: number };
};

const DAYS = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"];

function fmtHour(d: Date) {
  return d.toLocaleTimeString("es-AR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Argentina/Buenos_Aires",
  });
}

// `isoToLocalInput` removed — use the AR-zoned `isoToARLocalInput`
// helper from `lib/datetime-ar.ts` (also handles the form-side
// AR-offset tagging via `localToARIso`).

const DOW_LABELS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];

function DayOfWeekPicker({ value, onChange }: { value: number[]; onChange: (v: number[]) => void }) {
  const toggle = (d: number) => {
    if (value.includes(d)) onChange(value.filter((x) => x !== d));
    else onChange([...value, d].sort((a, b) => a - b));
  };
  return (
    <div style={{ display: "flex", gap: 6 }}>
      {DOW_LABELS.map((label, i) => {
        const on = value.includes(i);
        return (
          <button
            key={i}
            type="button"
            onClick={() => toggle(i)}
            style={{
              flex: 1,
              padding: "8px 0",
              borderRadius: 10,
              border: "1px solid " + (on ? "var(--sky-700)" : "rgba(15,30,51,0.1)"),
              background: on ? "var(--sky-700)" : "rgba(255,255,255,0.7)",
              color: on ? "#fff" : "var(--navy-700)",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

export function AgendaClient(props: Props) {
  const router = useRouter();
  const [creating, setCreating] = useState<null | {
    defaultISO?: string;
    defaultPatientId?: string | null;
  }>(null);
  const [editing, setEditing] = useState<BookingDTO | null>(null);
  const [density, setDensity] = useState<"comfortable" | "compact">("comfortable");
  const [showWeekStrip, setShowWeekStrip] = useState(true);

  // Deep-link from "Nuevo turno" quick action: /agenda?new=1&patient=<id>
  // opens the create modal pre-filled with that patient. We clear the
  // query string after opening so a refresh doesn't re-trigger.
  useEffect(() => {
    if (!props.autoCreate) return;
    setCreating({ defaultPatientId: props.autoCreatePatientId ?? null });
    const next = new URL(window.location.href);
    next.searchParams.delete("new");
    next.searchParams.delete("patient");
    window.history.replaceState(null, "", next.toString());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const anchor = useMemo(() => new Date(props.anchorISO), [props.anchorISO]);
  const weekStart = useMemo(() => new Date(props.weekStartISO), [props.weekStartISO]);

  const bookingsByDay = useMemo(() => {
    const map = new Map<string, BookingDTO[]>();
    for (const b of props.bookings) {
      const k = toARDateKey(b.scheduledFor);
      map.set(k, [...(map.get(k) ?? []), b]);
    }
    return map;
  }, [props.bookings]);

  const todayKey = toARDateKey(anchor);
  const todayList = (bookingsByDay.get(todayKey) ?? []).sort(
    (a, b) => +new Date(a.scheduledFor) - +new Date(b.scheduledFor)
  );

  const navigate = (deltaDays: number) => {
    const d = new Date(anchor);
    d.setDate(d.getDate() + deltaDays);
    const next = toARDateKey(d);
    router.push(`/agenda?view=${props.view}&date=${next}`);
  };

  const setView = (v: Props["view"]) => {
    const next = toARDateKey(anchor);
    router.push(`/agenda?view=${v}&date=${next}`);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, minHeight: "calc(100vh - 60px)" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 12, color: "var(--navy-300)", fontWeight: 500 }}>Agenda</div>
          <h1 className="k-display" style={{ fontSize: 30, margin: "2px 0 0" }}>
            {anchor.toLocaleDateString("es-AR", { weekday: "long", day: "2-digit", month: "long" })}
          </h1>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {/* Week nav cluster — consistent 36 px height for all three controls */}
          <div
            className="k-glass"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 2,
              padding: 3,
              borderRadius: 999,
              height: 36,
            }}
          >
            <button
              onClick={() => navigate(-7)}
              aria-label="Semana anterior"
              style={navPillBtn}
            >
              <IconChevL size={14} />
            </button>
            <button
              onClick={() =>
                router.push(
                  `/agenda?view=${props.view}&date=${toARDateKey(new Date())}`
                )
              }
              style={{
                ...navPillBtn,
                width: "auto",
                padding: "0 14px",
                fontSize: 12.5,
                fontWeight: 600,
              }}
            >
              Hoy
            </button>
            <button
              onClick={() => navigate(7)}
              aria-label="Semana siguiente"
              style={navPillBtn}
            >
              <IconChevR size={14} />
            </button>
          </div>

          {/* View switch */}
          <div
            className="k-glass"
            style={{
              display: "inline-flex",
              alignItems: "center",
              borderRadius: 999,
              padding: 3,
              height: 36,
            }}
          >
            {(["timeline", "week", "list"] as const).map((v) => {
              const on = props.view === v;
              const label = v === "timeline" ? "Día" : v === "week" ? "Semana" : "Lista";
              return (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  style={{
                    height: 30,
                    padding: "0 14px",
                    borderRadius: 999,
                    border: "none",
                    fontSize: 12.5,
                    fontWeight: 600,
                    background: on ? "var(--navy-900)" : "transparent",
                    color: on ? "#fff" : "var(--navy-500)",
                    cursor: "pointer",
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {props.practitioners.length > 1 && (
            <select
              value={props.practitionerFilterId ?? ""}
              onChange={(e) => {
                const val = e.target.value;
                const sp = new URLSearchParams(window.location.search);
                if (val) sp.set("practitioner", val);
                else sp.delete("practitioner");
                router.push(`/agenda?${sp.toString()}`);
              }}
              aria-label="Filtrar por profesional"
              style={{
                height: 36,
                padding: "0 12px",
                borderRadius: 999,
                fontSize: 12.5,
                fontWeight: 600,
                border: "1px solid rgba(15,30,51,0.08)",
                background: "rgba(255,255,255,0.7)",
                color: "var(--navy-700)",
              }}
            >
              <option value="">Todos los profesionales</option>
              {props.practitioners.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}

          <ViewOptionsMenu density={density} setDensity={setDensity} showWeekStrip={showWeekStrip} setShowWeekStrip={setShowWeekStrip} />

          <a
            href={`/api/agenda/export?from=${toARDateKey(weekStart)}`}
            target="_blank"
            rel="noopener noreferrer"
            title="Exportar semana a .ics"
            style={{ textDecoration: "none" }}
          >
            <Button variant="ghost" style={{ height: 36, padding: "0 14px" }}>
              .ics
            </Button>
          </a>
          <Button
            variant="primary"
            onClick={() => setCreating({})}
            style={{ height: 36, padding: "0 18px" }}
          >
            <IconPlus size={14} /> Nuevo turno
          </Button>
        </div>
      </header>

      {showWeekStrip && (
        <WeekStrip
          weekStart={weekStart}
          anchor={anchor}
          bookingsByDay={bookingsByDay}
          onPick={(d) => router.push(`/agenda?view=${props.view}&date=${toARDateKey(d)}`)}
        />
      )}

      <div style={{ flex: 1, minHeight: 0 }}>
        {props.view === "timeline" && (
          <TimelineView
            bookings={todayList}
            onCreate={(iso) => setCreating({ defaultISO: iso })}
            onEdit={setEditing}
            density={density}
            businessHours={props.businessHours ?? { start: 8, end: 19 }}
          />
        )}
        {props.view === "week" && (
          <WeekGridView
            weekStart={weekStart}
            bookings={props.bookings}
            onEdit={setEditing}
            businessHours={props.businessHours ?? { start: 8, end: 19 }}
          />
        )}
        {props.view === "list" && (
          <ListView bookings={todayList} onEdit={setEditing} />
        )}
      </div>

      {creating && (
        <BookingModal
          mode="create"
          defaultISO={creating.defaultISO ?? anchor.toISOString()}
          defaultPatientId={creating.defaultPatientId ?? null}
          services={props.services}
          practitioners={props.practitioners}
          patients={props.patients}
          onClose={() => setCreating(null)}
          onSaved={() => {
            setCreating(null);
            router.refresh();
          }}
        />
      )}

      <BookingDrawer
        booking={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          router.refresh();
        }}
      />
    </div>
  );
}

const navPillBtn: React.CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 999,
  background: "transparent",
  border: "none",
  cursor: "pointer",
  color: "var(--navy-700)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};

function WeekStrip({
  weekStart,
  anchor,
  bookingsByDay,
  onPick,
}: {
  weekStart: Date;
  anchor: Date;
  bookingsByDay: Map<string, BookingDTO[]>;
  onPick: (d: Date) => void;
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 8 }}>
      {DAYS.map((d, i) => {
        const day = new Date(weekStart);
        day.setDate(day.getDate() + i);
        const key = toARDateKey(day);
        const count = bookingsByDay.get(key)?.length ?? 0;
        const on = toARDateKey(day) === toARDateKey(anchor);
        return (
          <button
            key={key}
            onClick={() => onPick(day)}
            className={on ? undefined : "k-glass"}
            style={{
              padding: "10px 6px",
              borderRadius: 14,
              textAlign: "center",
              border: "none",
              cursor: "pointer",
              background: on ? "var(--sky-700)" : undefined,
              color: on ? "#fff" : "var(--navy-500)",
              boxShadow: on ? "0 8px 20px rgba(31,79,190,0.28)" : undefined,
            }}
          >
            <div style={{ fontSize: 10, opacity: 0.7, textTransform: "uppercase", fontWeight: 600 }}>{d}</div>
            <div
              className="k-display"
              style={{ fontSize: 18, fontWeight: 700, color: on ? "#fff" : "var(--navy-900)", margin: "2px 0" }}
            >
              {Number(key.slice(8, 10))}
            </div>
            <div style={{ fontSize: 10, opacity: 0.8 }}>
              {count} {count === 1 ? "turno" : "turnos"}
            </div>
          </button>
        );
      })}
    </div>
  );
}

/** Max bookings shown per overlap group before a "+N more" pill appears. */
const TIMELINE_PAGE = 5;

type BookingLayout = BookingDTO & {
  col: number;   // 0-based column within its collision group
  cols: number;  // total columns in the group
  groupKey: string;
};

/**
 * Assign each booking a (col, cols) pair so overlapping bookings share
 * the available width instead of stacking. Algorithm:
 *   1. Sort by start time.
 *   2. Sweep: build collision groups where any two bookings overlap.
 *   3. Within each group assign columns greedily.
 */
type BItem = { b: BookingDTO; start: number; end: number };

function layoutBookings(bookings: BookingDTO[]): BookingLayout[] {
  if (!bookings.length) return [];

  const items: BItem[] = bookings.map((b) => {
    const start = new Date(b.scheduledFor).getTime();
    const end = start + b.durationMin * 60_000;
    return { b, start, end };
  }).sort((a, b) => a.start - b.start);

  // Build overlap groups via a sweep.
  const groups: BItem[][] = [];
  let current: BItem[] = [items[0]];
  let groupEnd = items[0].end;

  for (let i = 1; i < items.length; i++) {
    if (items[i].start < groupEnd) {
      current.push(items[i]);
      groupEnd = Math.max(groupEnd, items[i].end);
    } else {
      groups.push(current);
      current = [items[i]];
      groupEnd = items[i].end;
    }
  }
  groups.push(current);

  const result: BookingLayout[] = [];
  groups.forEach((group, gi) => {
    const cols = group.length;
    const key = `g${gi}`;
    group.forEach((item, col) => {
      result.push({ ...item.b, col, cols, groupKey: key });
    });
  });
  return result;
}

function TimelineView({
  bookings,
  onCreate,
  onEdit,
  density,
  businessHours,
}: {
  bookings: BookingDTO[];
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
            const baseIso = new Date(
              new Date(bookings[0]?.scheduledFor ?? new Date()).setHours(h, 0, 0, 0)
            ).toISOString();
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
            const top = (h - HOURS[0]) * ROW + CARD_GAP;
            const height = (b.durationMin / 60) * ROW - CARD_GAP - 4;
            const isCancelled = b.status === "CANCELLED";
            const isDone = b.status === "COMPLETED";

            const totalInGroup = groupCounts.get(b.groupKey) ?? 1;
            const visiblePages = 1 + (expanded[b.groupKey] ?? 0);
            const visibleCols = Math.min(totalInGroup, visiblePages * TIMELINE_PAGE);
            const hiddenCount = totalInGroup - visibleCols;

            if (b.col >= visibleCols) return null;

            // The booking strip starts at 64 px (after the hour label).
            // Cap it at 520 px max so cards never stretch across a very wide screen.
            const STRIP_LEFT = 64;
            const STRIP_GAP = 8;
            const STRIP_MAX = 520; // px cap
            // colWidth / colLeft are expressed with calc() so they respect both
            // the max-width cap and the equal-column split.
            const trackW = `min(${STRIP_MAX}px, calc(100% - ${STRIP_LEFT + STRIP_GAP}px))`;
            const colWidth = `calc(${trackW} / ${visibleCols})`;
            const colLeft = `calc(${STRIP_LEFT}px + ${trackW} / ${visibleCols} * ${b.col})`;

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
                      : isDone
                        ? "rgba(246,249,253,0.9)"
                        : "rgba(255,255,255,0.85)",
                    border: "1px solid " + (isCancelled ? "rgba(228,70,70,0.3)" : isDone ? "rgba(15,30,51,0.06)" : "rgba(31,79,190,0.12)"),
                    boxShadow: "0 2px 6px rgba(15,30,51,0.04)",
                    color: "var(--navy-900)",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    opacity: isCancelled ? 0.6 : isDone ? 0.7 : 1,
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
                      background: isCancelled ? "#9F1F1F" : isDone ? "var(--navy-100)" : "var(--sky-500)",
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
                      {b.serviceName}
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
        style={{ width: "min(420px,100%)", borderRadius: 20, padding: 20 }}
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
                <Avatar name={b.patientName} size={32} tone="sky" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--navy-900)" }}>{b.patientName}</div>
                  <div style={{ fontSize: 11, color: "var(--navy-500)" }}>
                    {fmtHour(date)} · {b.serviceName} · {b.durationMin} min
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

function WeekGridView({
  weekStart,
  bookings,
  onEdit,
  businessHours,
}: {
  weekStart: Date;
  bookings: BookingDTO[];
  onEdit: (b: BookingDTO) => void;
  businessHours: { start: number; end: number };
}) {
  const HOURS = Array.from(
    { length: Math.max(1, businessHours.end - businessHours.start) },
    (_, i) => i + businessHours.start
  );
  const ROW = 50;
  const MAX_VISIBLE = 2;

  // overflow modal state: null = closed, otherwise the slot's bookings + label
  const [overflow, setOverflow] = useState<{ bookings: BookingDTO[]; label: string } | null>(null);

  // Index bookings by "dayCol-rowStart" for easy cell lookup
  const cellMap = useMemo(() => {
    const m = new Map<string, BookingDTO[]>();
    for (const b of bookings) {
      const date = new Date(b.scheduledFor);
      const dayCol = (toARDow(date) + 6) % 7;
      const h = toARHour(date);
      const rowStart = Math.max(1, Math.round(h - HOURS[0]) + 1);
      const key = `${dayCol}-${rowStart}`;
      const list = m.get(key) ?? [];
      list.push(b);
      m.set(key, list);
    }
    return m;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookings, HOURS[0]]);

  return (
    <>
      <Card style={{ padding: 14, height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ display: "grid", gridTemplateColumns: "52px repeat(7, 1fr)", gap: 6, marginBottom: 6 }}>
          <div />
          {DAYS.map((d, i) => {
            const day = new Date(weekStart);
            day.setDate(day.getDate() + i);
            const arKey = toARDateKey(day);
            return (
              <div key={i} style={{ textAlign: "center", fontSize: 11, fontWeight: 600, color: "var(--navy-500)", padding: "6px 0" }}>
                {d} {Number(arKey.slice(8, 10))}
              </div>
            );
          })}
        </div>
        <div
          style={{
            flex: 1,
            display: "grid",
            gridTemplateColumns: "52px repeat(7, 1fr)",
            gridTemplateRows: `repeat(${HOURS.length}, ${ROW}px)`,
            gap: 6,
            overflow: "auto",
          }}
        >
          {HOURS.map((h, i) => (
            <div key={"h" + h} className="k-mono" style={{ gridColumn: 1, gridRow: i + 1, fontSize: 10, color: "var(--navy-300)", paddingTop: 4 }}>
              {String(h).padStart(2, "0")}:00
            </div>
          ))}
          {HOURS.map((_, i) =>
            DAYS.map((__, j) => (
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

          {/* Render cells: deduplicated per (dayCol, rowStart) */}
          {Array.from(cellMap.entries()).map(([cellKey, cellBookings]) => {
            const [dayColStr, rowStartStr] = cellKey.split("-");
            const dayCol = Number(dayColStr);
            const rowStart = Number(rowStartStr);
            const first = cellBookings[0];
            const date0 = new Date(first.scheduledFor);
            const span = Math.max(1, Math.round(first.durationMin / 60));
            const visible = cellBookings.slice(0, MAX_VISIBLE);
            const hiddenCount = cellBookings.length - MAX_VISIBLE;

            return (
              <div
                key={cellKey}
                style={{
                  gridColumn: dayCol + 2,
                  gridRow: `${rowStart} / span ${span}`,
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                  padding: 2,
                  overflow: "hidden",
                }}
              >
                {visible.map((b) => (
                  <button
                    key={b.id}
                    onClick={() => onEdit(b)}
                    style={{
                      flex: 1, minHeight: 0,
                      background: b.status === "CANCELLED" ? "rgba(228,70,70,0.18)" : "var(--sky-700)",
                      color: "#fff",
                      padding: "3px 6px", borderRadius: 6, fontSize: 10, fontWeight: 600,
                      border: "none", cursor: "pointer", textAlign: "left",
                      overflow: "hidden",
                      opacity: b.status === "CANCELLED" ? 0.5 : 1,
                    }}
                  >
                    <div className="k-mono" style={{ fontSize: 9, opacity: 0.85 }}>{fmtHour(date0)}</div>
                    <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {b.patientName}
                    </div>
                  </button>
                ))}
                {hiddenCount > 0 && (
                  <button
                    onClick={() =>
                      setOverflow({
                        bookings: cellBookings,
                        label: `${fmtHour(date0)} · ${hiddenCount + MAX_VISIBLE} turnos`,
                      })
                    }
                    style={{
                      background: "rgba(31,79,190,0.12)", color: "var(--sky-700)",
                      border: "1px solid rgba(31,79,190,0.2)", borderRadius: 6,
                      fontSize: 10, fontWeight: 700, padding: "2px 4px",
                      cursor: "pointer", textAlign: "center",
                    }}
                  >
                    +{hiddenCount} más
                  </button>
                )}
              </div>
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

function ListView({
  bookings,
  onEdit,
}: {
  bookings: BookingDTO[];
  onEdit: (b: BookingDTO) => void;
}) {
  if (!bookings.length) {
    return (
      <Card style={{ padding: 28, textAlign: "center", color: "var(--navy-500)" }}>
        No hay turnos para este día.
      </Card>
    );
  }
  return (
    <Card style={{ padding: 0, overflow: "hidden" }}>
      <div
        style={{
          padding: "12px 18px",
          display: "grid",
          gridTemplateColumns: "70px 1fr 1.4fr 1fr 100px 90px",
          gap: 14,
          fontSize: 10,
          fontWeight: 700,
          color: "var(--navy-300)",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          borderBottom: "1px solid rgba(15,30,51,0.06)",
        }}
      >
        <span>Hora</span>
        <span>Paciente</span>
        <span>Servicio</span>
        <span>Notas</span>
        <span>Duración</span>
        <span style={{ textAlign: "right" }}>Estado</span>
      </div>
      {bookings.map((b) => {
        const date = new Date(b.scheduledFor);
        return (
          <button
            key={b.id}
            onClick={() => onEdit(b)}
            style={{
              padding: "14px 18px",
              display: "grid",
              gap: 14,
              gridTemplateColumns: "70px 1fr 1.4fr 1fr 100px 90px",
              alignItems: "center",
              fontSize: 13,
              width: "100%",
              border: "none",
              background: "transparent",
              borderBottom: "1px solid rgba(15,30,51,0.04)",
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            <div className="k-mono" style={{ fontSize: 13, fontWeight: 700, color: "var(--navy-700)" }}>
              {fmtHour(date)}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Avatar name={b.patientName} size={32} tone="sky" />
              <div>
                <div style={{ fontWeight: 600, color: "var(--navy-900)" }}>{b.patientName}</div>
                {b.patientCondition && (
                  <div style={{ fontSize: 11, color: "var(--navy-300)" }}>{b.patientCondition}</div>
                )}
              </div>
            </div>
            <div style={{ color: "var(--navy-700)" }}>{b.serviceName}</div>
            <div style={{ color: "var(--navy-500)", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {b.notes ?? "—"}
            </div>
            <div className="k-mono" style={{ fontSize: 12, color: "var(--navy-500)" }}>
              {b.durationMin} min
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <StatusTag s={b.status} />
            </div>
          </button>
        );
      })}
    </Card>
  );
}

function StatusTag({ s }: { s: BookingStatus }) {
  if (s === "CONFIRMED") return <Tag tone="sky">Confirmado</Tag>;
  if (s === "COMPLETED") return <Tag tone="soft"><IconCheck size={10} stroke={3} /> Hecho</Tag>;
  if (s === "CANCELLED") return <Tag tone="soft">Cancelado</Tag>;
  if (s === "NO_SHOW") return <Tag tone="soft">Ausente</Tag>;
  return <Tag tone="lime">Pendiente</Tag>;
}

// ──────────────────────────────────────────────────────────────────────
// View Options dropdown — small menu next to the day/week/list switch
// ──────────────────────────────────────────────────────────────────────

function ViewOptionsMenu({
  density,
  setDensity,
  showWeekStrip,
  setShowWeekStrip,
}: {
  density: "comfortable" | "compact";
  setDensity: (d: "comfortable" | "compact") => void;
  showWeekStrip: boolean;
  setShowWeekStrip: (v: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="true"
        aria-expanded={open}
        className="k-glass"
        style={{
          height: 36,
          padding: "0 12px",
          borderRadius: 999,
          border: "none",
          fontSize: 12.5,
          fontWeight: 600,
          color: "var(--navy-700)",
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        Vista
        <span style={{ fontSize: 9, color: "var(--navy-300)" }}>▾</span>
      </button>
      {open && (
        <div
          role="menu"
          className="k-glass-strong"
          style={{
            position: "absolute",
            top: 44,
            right: 0,
            width: 240,
            borderRadius: 14,
            padding: 10,
            zIndex: 25,
          }}
        >
          <div style={menuLabel}>Densidad</div>
          <div
            style={{
              display: "flex",
              padding: 3,
              borderRadius: 999,
              background: "rgba(15,30,51,0.04)",
              marginBottom: 10,
            }}
          >
            {(["comfortable", "compact"] as const).map((d) => {
              const on = density === d;
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDensity(d)}
                  style={{
                    flex: 1,
                    padding: "6px 10px",
                    borderRadius: 999,
                    border: "none",
                    fontSize: 11.5,
                    fontWeight: 600,
                    background: on ? "#fff" : "transparent",
                    color: on ? "var(--navy-900)" : "var(--navy-500)",
                    cursor: "pointer",
                  }}
                >
                  {d === "comfortable" ? "Cómoda" : "Compacta"}
                </button>
              );
            })}
          </div>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "6px 4px",
              fontSize: 13,
              color: "var(--navy-700)",
              cursor: "pointer",
            }}
          >
            Mostrar tira de días
            <input
              type="checkbox"
              checked={showWeekStrip}
              onChange={(e) => setShowWeekStrip(e.target.checked)}
            />
          </label>
        </div>
      )}
    </div>
  );
}

const menuLabel: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--navy-300)",
  padding: "0 4px 6px",
};

const miniGhostBtn: React.CSSProperties = {
  background: "transparent",
  border: "1px solid rgba(15,30,51,0.1)",
  borderRadius: 999,
  padding: "5px 12px",
  fontSize: 11.5,
  fontWeight: 600,
  color: "var(--navy-700)",
  cursor: "pointer",
};


function BookingModal({
  mode,
  booking,
  defaultISO,
  defaultPatientId,
  services,
  practitioners,
  patients,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  booking?: BookingDTO;
  defaultISO?: string;
  defaultPatientId?: string | null;
  services: Props["services"];
  practitioners: Props["practitioners"];
  patients: Props["patients"];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{
    practitionerName: string;
    nextFreeISO: string | null;
    payload: Parameters<typeof createBooking>[0];
  } | null>(null);
  // "Crear como plan" toggle — when on, the modal switches the
  // repeat-weeks input for a full plan layout (sessions + days of week).
  const [planMode, setPlanMode] = useState(false);
  const [planSessions, setPlanSessions] = useState(8);
  const [planDows, setPlanDows] = useState<number[]>([0, 2, 4]);
  const [repeatWeeks, setRepeatWeeks] = useState(1);
  const [seriesDows, setSeriesDows] = useState<number[]>([]);
  const [isGuest, setIsGuest] = useState(false);

  const finalizeCreate = async (payload: Parameters<typeof createBooking>[0]) => {
    const result = await createBooking(payload);
    if (!result.ok) {
      if (result.conflict) {
        setConflict({
          practitionerName: result.conflict.practitionerName,
          nextFreeISO: result.conflict.nextFreeISO,
          payload,
        });
        setError(null);
        return;
      }
      setError(result.error);
      return;
    }
    onSaved();
  };

  const submit = (formData: FormData) => {
    setError(null);
    setConflict(null);
    start(async () => {
      if (mode === "create") {
        const patientId = String(formData.get("patientId") ?? "") || undefined;

        if (planMode) {
          if (!patientId) {
            setError("Los planes requieren un paciente registrado.");
            return;
          }
          const r = await createBookingPlan({
            patientId,
            serviceId: String(formData.get("serviceId") ?? ""),
            practitionerId: String(formData.get("practitionerId") ?? ""),
            // AR-tagged so the server doesn't drift the slot 3 hours
            // (see lib/datetime-ar.ts for the why).
            startScheduledFor: localToARIso(String(formData.get("scheduledFor") ?? "")),
            durationMin: Number(formData.get("durationMin")) || 45,
            totalSessions: planSessions,
            daysOfWeek: planDows,
            notes: String(formData.get("notes") ?? "") || undefined,
          });
          if (!r.ok) {
            setError(r.error);
            return;
          }
          onSaved();
          return;
        }

        const payload = {
          patientId,
          serviceId: String(formData.get("serviceId") ?? ""),
          practitionerId: String(formData.get("practitionerId") ?? ""),
          // AR-tagged: prevents the +3h shift to UTC on the server.
          scheduledFor: localToARIso(String(formData.get("scheduledFor") ?? "")),
          durationMin: Number(formData.get("durationMin")) || 45,
          notes: String(formData.get("notes") ?? "") || undefined,
          guestName: String(formData.get("guestName") ?? "") || undefined,
          guestEmail: String(formData.get("guestEmail") ?? "") || undefined,
          guestPhone: String(formData.get("guestPhone") ?? "") || undefined,
        };
        if (repeatWeeks > 1) {
          const result = await createBookingSeries({
            ...payload,
            repeatWeeks,
            daysOfWeek: seriesDows.length > 0 ? seriesDows : undefined,
          });
          if (!result.ok) {
            setError(result.error);
            return;
          }
          onSaved();
          return;
        }
        await finalizeCreate(payload);
        return;
      }
      // edit-only flow: status change handled via the buttons below
      onSaved();
    });
  };

  const useSuggestedSlot = () => {
    if (!conflict || !conflict.nextFreeISO) return;
    start(async () => {
      await finalizeCreate({
        ...conflict.payload,
        scheduledFor: conflict.nextFreeISO!,
      });
      setConflict(null);
    });
  };

  const forceOverbooking = () => {
    if (!conflict) return;
    start(async () => {
      await finalizeCreate({ ...conflict.payload, allowOverbooking: true });
      setConflict(null);
    });
  };

  const setStatus = (status: BookingStatus) => {
    if (!booking) return;
    start(async () => {
      const result = await setBookingStatus(booking.id, status);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onSaved();
    });
  };

  const remove = () => {
    if (!booking) return;
    if (!confirm("¿Eliminar este turno?")) return;
    start(async () => {
      const result = await deleteBooking(booking.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onSaved();
    });
  };

  return (
    <div
      role="dialog"
      aria-modal
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,30,51,0.45)",
        backdropFilter: "blur(4px)",
        zIndex: 40,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div className="k-glass-strong" style={{ width: "min(560px, 100%)", borderRadius: 24, padding: 22 }}>
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 14,
          }}
        >
          <h2 className="k-display" style={{ fontSize: 20, margin: 0, fontWeight: 700 }}>
            {mode === "create" ? "Nuevo turno" : "Turno"}
          </h2>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            style={{
              border: "none",
              background: "rgba(255,255,255,0.7)",
              width: 32,
              height: 32,
              borderRadius: 10,
              cursor: "pointer",
              color: "var(--navy-700)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <IconX size={14} />
          </button>
        </header>

        {mode === "edit" && booking ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Card style={{ padding: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <Avatar name={booking.patientName} size={40} tone="sky" />
                <div>
                  <div style={{ fontWeight: 700 }}>{booking.patientName}</div>
                  <div style={{ fontSize: 12, color: "var(--navy-500)" }}>
                    {new Date(booking.scheduledFor).toLocaleString("es-AR", {
                      weekday: "long",
                      day: "2-digit",
                      month: "long",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                    {" · "}
                    {booking.durationMin} min · {booking.serviceName}
                  </div>
                </div>
              </div>
            </Card>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
              <Button variant="primary" onClick={() => setStatus("CONFIRMED")} disabled={pending}>
                Confirmar
              </Button>
              <Button variant="lime" onClick={() => setStatus("COMPLETED")} disabled={pending}>
                <IconCheck size={12} stroke={3} /> Marcar realizado
              </Button>
              <Button variant="ghost" onClick={() => setStatus("NO_SHOW")} disabled={pending}>
                Ausente
              </Button>
              <Button variant="ghost" onClick={() => setStatus("CANCELLED")} disabled={pending}>
                Cancelar turno
              </Button>
            </div>

            {error && (
              <div
                style={{
                  padding: 10,
                  borderRadius: 10,
                  background: "rgba(228,70,70,0.1)",
                  color: "#9F1F1F",
                  fontSize: 12,
                }}
              >
                {error}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}>
              <button
                onClick={remove}
                disabled={pending}
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#9F1F1F",
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                Eliminar
              </button>
              <Button variant="ghost" onClick={onClose}>
                Cerrar
              </Button>
            </div>
          </div>
        ) : (
          <form action={submit} style={{ display: "grid", gap: 10 }}>
            <Select label="Profesional" name="practitionerId" required>
              {practitioners.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
            <Select label="Servicio" name="serviceId" required defaultValue="">
              <option value="" disabled>— Seleccioná un servicio —</option>
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {s.durationMin}m
                </option>
              ))}
            </Select>
            {/* Patient / Guest selector */}
            <div>
              {/* Single row: "Paciente *" label on the left, toggle on the right */}
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 8,
                  cursor: "pointer",
                  userSelect: "none",
                }}
              >
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--navy-500)" }}>Paciente</span>
                <span
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 12,
                    fontWeight: 600,
                    color: isGuest ? "var(--sky-700)" : "var(--navy-400)",
                  }}
                >
                  Invitado
                  <span
                    onClick={() => setIsGuest((v) => !v)}
                    role="switch"
                    aria-checked={isGuest}
                    tabIndex={0}
                    onKeyDown={(e) => e.key === " " && setIsGuest((v) => !v)}
                    style={{
                      display: "inline-flex",
                      width: 36,
                      height: 20,
                      borderRadius: 10,
                      background: isGuest ? "var(--sky-700)" : "rgba(15,30,51,0.15)",
                      position: "relative",
                      cursor: "pointer",
                      transition: "background 0.15s",
                      flexShrink: 0,
                    }}
                  >
                    <span
                      style={{
                        position: "absolute",
                        top: 2,
                        left: isGuest ? 18 : 2,
                        width: 16,
                        height: 16,
                        borderRadius: "50%",
                        background: "#fff",
                        boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
                        transition: "left 0.15s",
                      }}
                    />
                  </span>
                </span>
              </label>
              {isGuest ? (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                  <FormField label="Nombre" name="guestName" />
                  <FormField label="Email" name="guestEmail" type="email" />
                  <FormField label="Teléfono" name="guestPhone" />
                </div>
              ) : (
                <PatientPicker
                  name="patientId"
                  label={null}
                  initialPatientId={defaultPatientId ?? null}
                  initialPatients={patients}
                />
              )}
            </div>

            {/* Plan-mode toggle */}
            <label
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "10px 12px",
                borderRadius: 12,
                background: planMode ? "rgba(31,79,190,0.06)" : "rgba(15,30,51,0.03)",
                border: "1px solid " + (planMode ? "rgba(31,79,190,0.2)" : "rgba(15,30,51,0.06)"),
                cursor: "pointer",
              }}
            >
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>Convertir en plan</div>
                <div style={{ fontSize: 11, color: "var(--navy-500)" }}>
                  Crea N sesiones consecutivas con sus turnos automáticos. Requiere paciente registrado.
                </div>
              </div>
              <input
                type="checkbox"
                checked={planMode}
                onChange={(e) => setPlanMode(e.target.checked)}
              />
            </label>

            <div style={{ display: "grid", gridTemplateColumns: planMode ? "2fr 1fr" : "2fr 1fr 1fr", gap: 10 }}>
              <FormField
                label={planMode ? "Inicio del plan" : "Fecha y hora"}
                name="scheduledFor"
                type="datetime-local"
                required
                defaultValue={defaultISO ? isoToARLocalInput(defaultISO) : ""}
              />
              <FormField label="Duración (min)" name="durationMin" type="number" min={15} max={240} defaultValue={45} />
              {!planMode && (
                <FormField
                  label="Repetir (semanas)"
                  name="repeatWeeks"
                  type="number"
                  min={1}
                  max={12}
                  value={repeatWeeks}
                  onChange={(v) => setRepeatWeeks(Math.max(1, Math.min(12, Number(v) || 1)))}
                />
              )}
            </div>

            {!planMode && repeatWeeks > 1 && (
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "var(--navy-500)", marginBottom: 6 }}>
                  Días de la semana (opcional)
                </div>
                <DayOfWeekPicker value={seriesDows} onChange={setSeriesDows} />
                <div style={{ fontSize: 11, color: "var(--navy-300)", marginTop: 6 }}>
                  {seriesDows.length > 0
                    ? `${seriesDows.length}×/semana · ${repeatWeeks * seriesDows.length} turnos totales`
                    : "Sin selección: se repite el mismo día de la semana"}
                </div>
              </div>
            )}

            {planMode && (
              <div style={{ display: "grid", gap: 10 }}>
                <FormField
                  label="Cantidad de sesiones"
                  name="planSessions"
                  type="number"
                  min={1}
                  max={64}
                  value={planSessions}
                  onChange={(v) => setPlanSessions(Math.max(1, Math.min(64, Number(v) || 1)))}
                />
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "var(--navy-500)", marginBottom: 6 }}>
                    Días de la semana
                  </div>
                  <DayOfWeekPicker value={planDows} onChange={setPlanDows} />
                  <div style={{ fontSize: 11, color: "var(--navy-300)", marginTop: 6 }}>
                    Frecuencia derivada: {planDows.length}×/semana
                  </div>
                </div>
              </div>
            )}

            <FormField as="textarea" label="Notas" name="notes" />
            {error && (
              <div
                style={{
                  padding: 10,
                  borderRadius: 10,
                  background: "rgba(228,70,70,0.1)",
                  color: "#9F1F1F",
                  fontSize: 12,
                }}
              >
                {error}
              </div>
            )}
            {conflict && (
              <div
                role="alert"
                style={{
                  padding: 14,
                  borderRadius: 12,
                  background: "rgba(255,176,32,0.14)",
                  border: "1px solid rgba(255,176,32,0.45)",
                  display: "grid",
                  gap: 10,
                }}
              >
                <div style={{ fontSize: 13, color: "#7A4A00", fontWeight: 700 }}>
                  ⚠ {conflict.practitionerName} ya tiene un turno en ese horario
                </div>
                <div style={{ fontSize: 12, color: "var(--navy-700)", lineHeight: 1.45 }}>
                  Otros profesionales pueden tener turnos al mismo tiempo (varios kines en
                  paralelo), pero el mismo kine no puede atender dos pacientes en simultáneo.
                  Tenés dos opciones:
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {conflict.nextFreeISO && (
                    <Button
                      type="button"
                      variant="primary"
                      onClick={useSuggestedSlot}
                      disabled={pending}
                    >
                      Usar próximo libre ·{" "}
                      {new Date(conflict.nextFreeISO).toLocaleString("es-AR", {
                        weekday: "short",
                        day: "2-digit",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                        timeZone: "America/Argentina/Buenos_Aires",
                      })}
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={forceOverbooking}
                    disabled={pending}
                    style={{ color: "#7A4A00", borderColor: "rgba(122,74,0,0.3)" }}
                  >
                    Forzar sobreturno
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setConflict(null)}
                    disabled={pending}
                  >
                    Volver atrás
                  </Button>
                </div>
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
                Cancelar
              </Button>
              <Button type="submit" variant="primary" disabled={pending}>
                {pending
                  ? "Creando…"
                  : planMode
                    ? `Crear plan (${planSessions} sesiones)`
                    : "Crear turno"}{" "}
                <IconArrow size={12} />
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function Select({
  label,
  name,
  required,
  defaultValue = "",
  children,
}: {
  label: string;
  name: string;
  required?: boolean;
  defaultValue?: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "block", fontSize: 12 }}>
      <span style={{ fontWeight: 600, color: "var(--navy-500)" }}>
        {label}
        {required && <span style={{ color: "var(--sky-700)" }}> *</span>}
      </span>
      <select name={name} required={required} style={inputStyle} defaultValue={defaultValue}>
        {children}
      </select>
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  marginTop: 6,
  padding: "10px 12px",
  borderRadius: 12,
  background: "rgba(255,255,255,0.7)",
  border: "1px solid rgba(15,30,51,0.08)",
  width: "100%",
  fontSize: 14,
  color: "var(--navy-900)",
  outline: "none",
};
