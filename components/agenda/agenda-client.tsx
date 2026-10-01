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
import {
  DEFAULT_AGENDA_VISIBILITY,
  agendaVisibilityStorageKey,
  applyAgendaVisibility,
  countHidden,
  hasTickingPaymentHold,
  hiddenCountLabel,
  parseAgendaVisibility,
  type AgendaVisibility,
} from "@/lib/agenda-filters";
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
  /**
   * Quién mira la agenda (A2b-S-ui). `userId` separa los toggles de
   * visibilidad guardados en localStorage por usuario (PC compartida de
   * recepción); `practitionerId` es el profesional por defecto del modal de
   * turno nuevo cuando no hay filtro de profesional. Opcional: sin él, la
   * clave es común y el modal cae al primer profesional de la lista.
   */
  viewer?: { userId: string; practitionerId: string } | null;
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

  // Toggles "Mostrar cancelados" / "Mostrar ausentes" (A2b-S-ui ítem 4).
  // Primer render con los defaults (= conducta de siempre, todo visible) para
  // no romper la hidratación; lo guardado se lee después de montar. Todo acceso
  // a localStorage va en try/catch: modo privado / storage bloqueado → defaults.
  const storageKey = agendaVisibilityStorageKey(props.viewer?.userId);
  const [visibility, setVisibilityState] = useState<AgendaVisibility>(DEFAULT_AGENDA_VISIBILITY);
  useEffect(() => {
    try {
      setVisibilityState(parseAgendaVisibility(window.localStorage.getItem(storageKey)));
    } catch {
      /* storage no disponible: quedan los defaults */
    }
  }, [storageKey]);
  const setVisibility = (v: AgendaVisibility) => {
    setVisibilityState(v);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(v));
    } catch {
      /* no persiste, pero el toggle funciona en esta pestaña */
    }
  };

  // Reserva pública impaga: vence a los 30 min del alta. Si hay alguna todavía
  // "pendiente" en pantalla, re-render cada minuto para que la etiqueta pase a
  // "vencida" sin recargar (las vistas calculan con `new Date()` al render).
  // Mismo predicado que las vistas y el server (revisión A2: antes miraba solo
  // UNPAID, sin FAILED ni el discriminante de reserva pública).
  const hasUnpaidPending = hasTickingPaymentHold(props.bookings, new Date());
  const [, setClockTick] = useState(0);
  useEffect(() => {
    if (!hasUnpaidPending) return;
    const id = window.setInterval(() => setClockTick((t) => t + 1), 60_000);
    return () => window.clearInterval(id);
  }, [hasUnpaidPending]);

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

  const visibleBookings = useMemo(
    () => applyAgendaVisibility(props.bookings, visibility),
    [props.bookings, visibility]
  );

  const bookingsByDay = useMemo(() => {
    const map = new Map<string, BookingDTO[]>();
    for (const b of visibleBookings) {
      const k = toARDateKey(b.scheduledFor);
      map.set(k, [...(map.get(k) ?? []), b]);
    }
    return map;
  }, [visibleBookings]);

  const todayKey = toARDateKey(anchor);
  const todayList = (bookingsByDay.get(todayKey) ?? []).sort(
    (a, b) => +new Date(a.scheduledFor) - +new Date(b.scheduledFor)
  );

  // Conteo de ocultos en el header, sobre lo que abarca la vista actual (el día
  // en Día/Lista, la semana en Semana): un turno filtrado nunca tiene que
  // parecer un hueco libre.
  const hiddenLabel = useMemo(() => {
    const scope =
      props.view === "week"
        ? props.bookings
        : props.bookings.filter((b) => toARDateKey(b.scheduledFor) === todayKey);
    return hiddenCountLabel(countHidden(scope, visibility));
  }, [props.bookings, props.view, todayKey, visibility]);

  // Profesional por defecto del turno nuevo: el del filtro de la agenda, si no
  // el del usuario (si atiende), si no el primero de la lista.
  const defaultPractitionerId =
    props.practitionerFilterId ?? props.viewer?.practitionerId ?? null;

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
          {hiddenLabel && (
            <div
              role="status"
              style={{
                marginTop: 4,
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 12,
                color: "var(--navy-500)",
              }}
            >
              <span>{hiddenLabel}</span>
              <button
                type="button"
                onClick={() => setVisibility(DEFAULT_AGENDA_VISIBILITY)}
                style={{
                  border: "none",
                  background: "transparent",
                  padding: 0,
                  fontSize: 12,
                  fontWeight: 600,
                  color: "var(--sky-700)",
                  cursor: "pointer",
                }}
              >
                Mostrar todos
              </button>
            </div>
          )}
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

          <ViewOptionsMenu
            density={density}
            setDensity={setDensity}
            visibility={visibility}
            setVisibility={setVisibility}
          />

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
                bookings={visibleBookings}
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
            defaultISO={creating.defaultISO ?? defaultCreateISO}
            defaultPatientId={creating.defaultPatientId ?? null}
            defaultPractitionerId={defaultPractitionerId}
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
