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
import { localToARIso, isoToARLocalInput } from "@/lib/datetime-ar";

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
      const k = new Date(b.scheduledFor).toISOString().slice(0, 10);
      map.set(k, [...(map.get(k) ?? []), b]);
    }
    return map;
  }, [props.bookings]);

  const todayKey = anchor.toISOString().slice(0, 10);
  const todayList = (bookingsByDay.get(todayKey) ?? []).sort(
    (a, b) => +new Date(a.scheduledFor) - +new Date(b.scheduledFor)
  );

  const navigate = (deltaDays: number) => {
    const d = new Date(anchor);
    d.setDate(d.getDate() + deltaDays);
    const next = d.toISOString().slice(0, 10);
    router.push(`/agenda?view=${props.view}&date=${next}`);
  };

  const setView = (v: Props["view"]) => {
    const next = anchor.toISOString().slice(0, 10);
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
                  `/agenda?view=${props.view}&date=${new Date().toISOString().slice(0, 10)}`
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
            href={`/api/agenda/export?from=${weekStart.toISOString().slice(0, 10)}`}
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
          onPick={(d) => router.push(`/agenda?view=${props.view}&date=${d.toISOString().slice(0, 10)}`)}
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
        const key = day.toISOString().slice(0, 10);
        const count = bookingsByDay.get(key)?.length ?? 0;
        const on = day.toDateString() === anchor.toDateString();
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
              {day.getDate()}
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
  // Build the visible hour range from the tenant's business window.
  // `end` is exclusive: businessHoursEnd=19 means the last row is 18:00.
  const HOURS = Array.from(
    { length: Math.max(1, businessHours.end - businessHours.start) },
    (_, i) => i + businessHours.start
  );
  const ROW = density === "compact" ? 40 : 56;

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
                  style={{
                    width: 56,
                    paddingTop: 4,
                    fontSize: 11,
                    color: "var(--navy-300)",
                  }}
                >
                  {String(h).padStart(2, "0")}:00
                </div>
              </div>
            );
          })}

          {bookings.map((b) => {
            const date = new Date(b.scheduledFor);
            const h = date.getHours() + date.getMinutes() / 60;
            const top = (h - HOURS[0]) * ROW;
            const height = (b.durationMin / 60) * ROW - 4;
            const isCancelled = b.status === "CANCELLED";
            const isDone = b.status === "COMPLETED";
            return (
              <button
                key={b.id}
                onClick={() => onEdit(b)}
                style={{
                  position: "absolute",
                  left: 64,
                  right: 8,
                  top,
                  height,
                  borderRadius: 12,
                  padding: "8px 12px",
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
                  gap: 10,
                  opacity: isCancelled ? 0.6 : isDone ? 0.7 : 1,
                  cursor: "pointer",
                  textDecoration: isCancelled ? "line-through" : "none",
                  textAlign: "left",
                }}
              >
                <div
                  style={{
                    width: 3,
                    alignSelf: "stretch",
                    borderRadius: 2,
                    background: isCancelled ? "#9F1F1F" : isDone ? "var(--navy-100)" : "var(--sky-500)",
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="k-mono" style={{ fontSize: 11, color: "var(--sky-700)", fontWeight: 600 }}>
                      {fmtHour(date)}
                    </span>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{b.patientName}</span>
                    {isDone && <Tag tone="soft"><IconCheck size={10} stroke={3} /> Hecho</Tag>}
                    {b.status === "PENDING" && <Tag tone="soft">Pendiente</Tag>}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--navy-500)" }}>
                    {b.serviceName} · {b.durationMin} min
                  </div>
                </div>
                <Avatar name={b.patientName} size={28} tone="sky" />
              </button>
            );
          })}
        </div>
      </div>
    </Card>
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
  // `end` exclusive — matches the row semantics in TimelineView so
  // both views render the same slots.
  const HOURS = Array.from(
    { length: Math.max(1, businessHours.end - businessHours.start) },
    (_, i) => i + businessHours.start
  );
  const ROW = 50;
  return (
    <Card style={{ padding: 14, height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ display: "grid", gridTemplateColumns: "52px repeat(7, 1fr)", gap: 6, marginBottom: 6 }}>
        <div />
        {DAYS.map((d, i) => {
          const day = new Date(weekStart);
          day.setDate(day.getDate() + i);
          return (
            <div
              key={i}
              style={{
                textAlign: "center",
                fontSize: 11,
                fontWeight: 600,
                color: "var(--navy-500)",
                padding: "6px 0",
              }}
            >
              {d} {day.getDate()}
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
          position: "relative",
          overflow: "auto",
        }}
      >
        {HOURS.map((h, i) => (
          <div
            key={"h" + h}
            className="k-mono"
            style={{
              gridColumn: 1,
              gridRow: i + 1,
              fontSize: 10,
              color: "var(--navy-300)",
              paddingTop: 4,
            }}
          >
            {String(h).padStart(2, "0")}:00
          </div>
        ))}
        {HOURS.map((_, i) =>
          DAYS.map((_, j) => (
            <div
              key={`cell${i}-${j}`}
              style={{
                gridColumn: j + 2,
                gridRow: i + 1,
                background: "rgba(255,255,255,0.5)",
                borderRadius: 8,
                border: "1px solid rgba(15,30,51,0.04)",
              }}
            />
          ))
        )}
        {bookings.map((b) => {
          const date = new Date(b.scheduledFor);
          const dayCol = (date.getDay() + 6) % 7; // Monday = 0
          const h = date.getHours() + date.getMinutes() / 60;
          const rowStart = Math.max(1, Math.round(h - HOURS[0]) + 1);
          const span = Math.max(1, Math.round(b.durationMin / 60));
          return (
            <button
              key={b.id}
              onClick={() => onEdit(b)}
              style={{
                gridColumn: dayCol + 2,
                gridRow: `${rowStart} / span ${span}`,
                background: "var(--sky-700)",
                color: "#fff",
                padding: "6px 8px",
                borderRadius: 8,
                fontSize: 11,
                fontWeight: 600,
                border: "none",
                cursor: "pointer",
                textAlign: "left",
                opacity: b.status === "CANCELLED" ? 0.4 : 1,
              }}
            >
              <div className="k-mono" style={{ fontSize: 10, opacity: 0.85 }}>{fmtHour(date)}</div>
              <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {b.patientName}
              </div>
            </button>
          );
        })}
      </div>
    </Card>
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

        const repeatWeeks = Math.max(1, Number(formData.get("repeatWeeks")) || 1);
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
          const result = await createBookingSeries({ ...payload, repeatWeeks });
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
            <PatientPicker
              name="patientId"
              initialPatientId={defaultPatientId ?? null}
              initialPatients={patients}
            />

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
                  defaultValue={1}
                />
              )}
            </div>

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

            {!planMode && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                <FormField label="Nombre (guest)" name="guestName" />
                <FormField label="Email (guest)" name="guestEmail" type="email" />
                <FormField label="Tel (guest)" name="guestPhone" />
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
