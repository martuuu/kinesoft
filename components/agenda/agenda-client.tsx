"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { DUR, EASE_OUT } from "@/lib/motion";
import { BookingDrawer } from "@/components/agenda/booking-drawer";
import { useTweaks } from "@/components/layout/tweaks-context";
import { Button } from "@/components/ui/button";
import {
  IconChevL,
  IconChevR,
  IconPlus,
} from "@/components/ui/icons";
import { localToARIso, toARDateKey } from "@/lib/datetime-ar";
import type { BookingDTO } from "./agenda-utils";
import { BookingModal } from "./booking-modal";
import { ViewOptionsMenu } from "./view-options-menu";
import { WeekStrip } from "./views/week-strip";
import { TimelineView } from "./views/timeline-view";
import { WeekGridView } from "./views/week-grid-view";
import { ListView } from "./views/list-view";

export type Props = {
  view: "timeline" | "week" | "list";
  anchorISO: string;
  weekStartISO: string;
  autoCreate?: boolean;
  autoCreatePatientId?: string | null;
  practitionerFilterId?: string | null;
  bookings: BookingDTO[];
  services: { id: string; name: string; durationMin: number; priceCents: number; color: string | null }[];
  practitioners: { id: string; name: string }[];
  patients: { id: string; name: string }[];
  /** Active tenant insurers (Obras Sociales) for the inline new-patient coverage select. */
  insurers: { id: string; name: string }[];
  /**
   * Business-hours window + row granularity from `Tenant`
   * (businessHoursStart/End + agendaSlotMinutes). Controls the row range and
   * how often a row is drawn in the day/week views. `AGENDA_HOURS_FALLBACK`
   * covers the case where the server forgets to pass them.
   */
  businessHours?: AgendaHours;
};

type AgendaHours = { start: number; end: number; slotMinutes: number };

/** Single source of truth for the fallback window (was duplicated inline). */
const AGENDA_HOURS_FALLBACK: AgendaHours = { start: 8, end: 19, slotMinutes: 60 };

export function AgendaClient(props: Props) {
  const router = useRouter();
  const [creating, setCreating] = useState<null | {
    defaultISO?: string;
    defaultPatientId?: string | null;
  }>(null);
  const [editing, setEditing] = useState<BookingDTO | null>(null);
  const [density, setDensity] = useState<"comfortable" | "compact">("comfortable");
  // Color legend "filter": clicking a service highlights (lifts) all its cards.
  // Single-select; clicking the active one clears. Purely visual (no filtering).
  const [highlightedServiceId, setHighlightedServiceId] = useState<string | null>(null);
  // Server-backed per-user agenda preferences, controlled from the Tweaks
  // panel + /configuracion. `agendaShowWeekHeader` drives the day-header
  // chrome — the day strip (every view) AND the week-grid header row.
  const { agenda } = useTweaks();
  const showDayHeader = agenda.agendaShowWeekHeader;

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

  // Default datetime for the "Nuevo turno" button (no slot clicked):
  // the anchor day at the start of business hours, in AR wall-clock.
  // Previously this fell back to `anchor.toISOString()` (local midnight),
  // which dropped new turnos at 00:00 — off-screen above the timeline and
  // outside the visible hour range. See item: "Externos no se ven".
  const defaultCreateISO = useMemo(() => {
    const startHour = props.businessHours?.start ?? AGENDA_HOURS_FALLBACK.start;
    const hh = String(startHour).padStart(2, "0");
    return localToARIso(`${todayKey}T${hh}:00`);
  }, [todayKey, props.businessHours?.start]);

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
            {anchor.toLocaleDateString("es-AR", { weekday: "long", day: "2-digit", month: "long", timeZone: "America/Argentina/Buenos_Aires" })}
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
            <motion.button
              whileTap={{ scale: 0.9 }}
              onClick={() => navigate(-7)}
              aria-label="Semana anterior"
              style={navPillBtn}
            >
              <IconChevL size={14} />
            </motion.button>
            <motion.button
              whileTap={{ scale: 0.94 }}
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
            </motion.button>
            <motion.button
              whileTap={{ scale: 0.9 }}
              onClick={() => navigate(7)}
              aria-label="Semana siguiente"
              style={navPillBtn}
            >
              <IconChevR size={14} />
            </motion.button>
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
                <motion.button
                  key={v}
                  whileTap={{ scale: 0.95 }}
                  onClick={() => setView(v)}
                  style={{
                    position: "relative",
                    height: 30,
                    padding: "0 14px",
                    borderRadius: 999,
                    border: "none",
                    fontSize: 12.5,
                    fontWeight: 600,
                    background: "transparent",
                    color: on ? "#fff" : "var(--navy-500)",
                    cursor: "pointer",
                  }}
                >
                  {on && (
                    <motion.span
                      layoutId="agenda-view-pill"
                      transition={{ duration: DUR.base, ease: EASE_OUT }}
                      style={{
                        position: "absolute",
                        inset: 0,
                        borderRadius: 999,
                        background: "var(--navy-900)",
                        zIndex: 0,
                      }}
                    />
                  )}
                  <span style={{ position: "relative", zIndex: 1 }}>{label}</span>
                </motion.button>
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

          <ViewOptionsMenu density={density} setDensity={setDensity} />

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

      {showDayHeader && (
        <WeekStrip
          weekStart={weekStart}
          anchor={anchor}
          bookingsByDay={bookingsByDay}
          showSaturday={agenda.agendaShowSaturday}
          showSunday={agenda.agendaShowSunday}
          onPick={(d) => router.push(`/agenda?view=${props.view}&date=${toARDateKey(d)}`)}
        />
      )}

      <div style={{ flex: 1, minHeight: 0 }}>
        <AnimatePresence mode="wait">
          <motion.div
            key={`${props.view}-${todayKey}`}
            initial={{ opacity: 0, y: 6, scale: 0.995 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.995 }}
            transition={{ duration: DUR.base, ease: EASE_OUT }}
            style={{ height: "100%" }}
          >
            {props.view === "timeline" && (
              <TimelineView
                bookings={todayList}
                dayKey={todayKey}
                onCreate={(iso) => setCreating({ defaultISO: iso })}
                onEdit={setEditing}
                density={density}
                businessHours={props.businessHours ?? AGENDA_HOURS_FALLBACK}
                highlightedServiceId={highlightedServiceId}
              />
            )}
            {props.view === "week" && (
              <WeekGridView
                weekStart={weekStart}
                bookings={props.bookings}
                onEdit={setEditing}
                businessHours={props.businessHours ?? AGENDA_HOURS_FALLBACK}
                showHeader={agenda.agendaShowWeekHeader}
                showSaturday={agenda.agendaShowSaturday}
                showSunday={agenda.agendaShowSunday}
                highlightedServiceId={highlightedServiceId}
              />
            )}
            {props.view === "list" && (
              <ListView bookings={todayList} onEdit={setEditing} highlightedServiceId={highlightedServiceId} />
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      {props.services.some((s) => s.color) && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            padding: "10px 4px 2px",
            alignItems: "center",
          }}
        >
          <span
            style={{
              fontSize: 10.5,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: "var(--navy-300)",
              marginRight: 4,
            }}
          >
            Servicios
          </span>
          {props.services
            .filter((s) => s.color)
            .map((s) => {
              const active = highlightedServiceId === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() =>
                    setHighlightedServiceId((prev) => (prev === s.id ? null : s.id))
                  }
                  title={active ? "Quitar resaltado" : "Resaltar estos turnos"}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "4px 10px",
                    borderRadius: 999,
                    border:
                      "1px solid " + (active ? "var(--navy-900)" : "rgba(15,30,51,0.12)"),
                    background: active ? "rgba(15,30,51,0.06)" : "transparent",
                    fontSize: 11.5,
                    fontWeight: 600,
                    color: "var(--navy-700)",
                    cursor: "pointer",
                  }}
                >
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 999,
                      background: s.color ?? "rgba(15,30,51,0.2)",
                      flexShrink: 0,
                    }}
                  />
                  {s.name}
                </button>
              );
            })}
        </div>
      )}

      <AnimatePresence>
        {creating && (
          <BookingModal
            key="booking-create"
            mode="create"
            defaultISO={creating.defaultISO ?? defaultCreateISO}
            defaultPatientId={creating.defaultPatientId ?? null}
            services={props.services}
            practitioners={props.practitioners}
            patients={props.patients}
            insurers={props.insurers}
            onClose={() => setCreating(null)}
            onSaved={() => {
              setCreating(null);
              router.refresh();
            }}
          />
        )}
      </AnimatePresence>

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
