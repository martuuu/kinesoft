"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { AnimatePresence, motion } from "framer-motion";
import { DUR, EASE_OUT } from "@/lib/motion";
import { useTweaks } from "@/components/layout/tweaks-context";
import { useToast } from "@/components/ui/toast";
import { localToARIso, toARDateKey } from "@/lib/datetime-ar";
import { dayWindow, instantAt } from "@/lib/availability/day";
import {
  DEFAULT_AGENDA_VISIBILITY,
  agendaPlanScopeStorageKey,
  agendaVisibilityStorageKey,
  applyAgendaVisibility,
  countHidden,
  countPlanScope,
  hasTickingPaymentHold,
  hiddenCountLabel,
  parseAgendaPlanScope,
  parseAgendaVisibility,
  planScopeHighlight,
  planScopeOf,
  serializeAgendaPlanScope,
  type AgendaPlanScope,
  type AgendaVisibility,
} from "@/lib/agenda-filters";
import {
  buildPractitionerColumns,
  OTHERS_COLUMN_ID,
  practitionerInitials,
  practitionerOrder,
  type LayoutRange,
  type MinuteWindow,
} from "@/lib/agenda-layout";
import {
  capOfFromAvailability,
  layoutBlocks,
  rangesForDay,
  type AgendaAvailability,
  type AgendaBlockView,
  type AgendaBootstrapProps,
} from "@/lib/availability-actions-types";
import { getAgendaAvailability } from "@/lib/availability-actions";
import { listAgendaBookings } from "@/lib/bookings";
import { useRealtime } from "@/components/providers/realtime-provider";
import { LiveIndicator } from "@/components/realtime/live-indicator";
import { BookingFlashContext } from "./grid/booking-card";
import { updateAgendaViewPrefs } from "@/lib/preferences";
import {
  DEFAULT_AGENDA_VIEW_PREFS,
  toggleFavoritePractitioner,
  type AgendaMode,
  type AgendaViewPrefs,
} from "@/lib/preferences-constants";
import {
  agendaHref,
  aggregateDayLock,
  applyAgendaFilters,
  availableAgendaModes,
  availabilityMatches,
  blockedRows,
  canOpenDayLock,
  capabilitySet,
  changedBookingIds,
  createRefetchCoalescer,
  FLASH_MS,
  messagesTouchRange,
  OWN_ACTION_QUIET_MS,
  pruneBookingOverrides,
  remoteFlashIds,
  weekFetchRange,
  countByPractitioner,
  countByRoom,
  dayLockInitialScope,
  dayViewFor,
  effectiveRoomFilter,
  isDayScoped,
  mergeBookingOverrides,
  roomsInScope,
  segmentOf,
  shiftDayKey,
  showModeToggle,
  showPractitionerInitials,
  showRoomOnCards,
  viewForSegment,
  visiblePractitioners,
  weekDayKeys,
  type AgendaFilterContext,
  type AgendaFilters,
  type AgendaView,
  type AggregatedDayLock,
  type ViewSegment,
} from "@/lib/agenda-client-state";
import type { DayLockState } from "@/lib/availability/types";
import { sameHighlight, toggleHighlight, type AgendaHighlight } from "@/lib/agenda-highlight";
import type { Discipline } from "@/lib/plans-constants";
import { expandPlanFields, serviceDisciplineMap, toBookingDTO, withArchivedRooms, type BookingDTO } from "./agenda-utils";
import { useTenantModules } from "@/components/layout/tenant-modules-context";
import { AgendaToolbar } from "./agenda-toolbar";
import { PlanLegend } from "./plan-legend";
import { AGENDA_MODE_OPTIONS, ModeToggle } from "./mode-toggle";
import { PractitionerChips } from "./practitioner-chips";
import { LocationFilter } from "./location-filter";
import { DayLockButton } from "./day-lock/day-lock-button";
import { WeekStrip } from "./views/week-strip";
import { TimelineView } from "./views/timeline-view";
import { WeekGridView } from "./views/week-grid-view";
import { ListView } from "./views/list-view";

// ── Bundle de /agenda (handoff de B4.3, integrador final de B-pre) ─────────
// Con B4/B5 el first load de /agenda pasó de 183,8 a 238 kB gz (presupuesto
// 180). Lo que NO está en el camino inicial va en chunks aparte:
//   • modal de turno (y con él SlotPicker, SessionsMode, BlockMode), drawer de
//     edición y diálogo del candado: solo se abren con un click → `ssr: false`
//     y se precargan en idle (`prefetchAgendaChunks`) para que el primer
//     click no espere la red;
//   • vistas Recepción y Por profesional: son un modo entre cinco. Con SSR
//     (default) la vista inicial igual llega renderizada y su chunk se precarga
//     desde el HTML; las demás vistas no pagan su JS.
// Medido con `npm run perf:bundle` (ver reporte del integrador final).
const BookingModal = dynamic(() => import("./booking-modal").then((m) => m.BookingModal), { ssr: false });
const BookingDrawer = dynamic(() => import("./booking-drawer").then((m) => m.BookingDrawer), { ssr: false });
const DayLockDialog = dynamic(() => import("./day-lock/day-lock-dialog").then((m) => m.DayLockDialog), {
  ssr: false,
});
const ReceptionView = dynamic(() => import("./reception/reception-view").then((m) => m.ReceptionView));
const PractitionerDayView = dynamic(() =>
  import("./views/practitioner-day-view").then((m) => m.PractitionerDayView<BookingDTO>)
);
// SR-U6: la vista "Por sala" (con su layout) y el filtro de sala solo existen
// en consultorios con salas (el cliente vivo no tiene): fuera del first load,
// como Recepción y Por profesional. Con SSR (default) la vista inicial igual
// llega renderizada.
const RoomDayPanel = dynamic(() => import("./views/room-day-panel").then((m) => m.RoomDayPanel));
const RoomFilter = dynamic(() => import("./room-filter").then((m) => m.RoomFilter));
/** Precarga en idle de los chunks que se abren con un click. Idempotente: el
 *  bundler cachea el `import()`. */
function prefetchAgendaChunks() {
  void import("./booking-modal");
  void import("./booking-drawer");
  void import("./day-lock/day-lock-dialog");
}

/**
 * Pantalla de agenda (B4.3 AG-integrate: agenda multi-profesional, plan §11.3).
 *
 * Vistas (`?view=`, resuelta en el server con `resolveAgendaView`):
 *   Día (`timeline`) · Por profesional (`practitioner`, columnas) · Semana ·
 *   Lista · Recepción. "Día" del selector abre el modo guardado
 *   (`agendaPrefs.mode`, toggle Por día ↔ Por profesional).
 *
 * Filtros, todos del lado del cliente (los turnos de la semana vienen enteros
 * de `listAgendaBookings`): un objeto `AgendaFilters` extensible (S19b:
 * profesionales en `?pros=`, vacío = todos; sede en `agendaPrefs.locationId`;
 * sala en `agendaPrefs.roomId`, SR-U6) y los toggles de cancelados/ausentes
 * (localStorage, como siempre). En "Por sala" el filtro de profesionales no
 * aplica (SRZ M2): la ocupación de la sala es de todos.
 *
 * Resaltado (no oculta, atenúa): leyenda de servicios y, con el módulo
 * `planes`, leyenda "Turnos: De plan · Sueltos" (S19b). El alcance de plan se
 * recuerda por usuario en localStorage; el de servicio, no (como siempre).
 *
 * Preferencias de agenda (`agendaPrefs`: modo, zoom, densidad, favoritos,
 * sede) se aplican al instante y se guardan con `updateAgendaViewPrefs`
 * (optimista; si falla, vuelve atrás SOLO el campo tocado y avisa).
 *
 * Disponibilidad (`AgendaAvailability`, B3.3): la de la semana visible llega
 * del server; al cambiar de sede (o si la del server no es la de la sede
 * guardada) se pide de nuevo con `getAgendaAvailability`. Sin disponibilidad
 * (falló la carga) la agenda funciona como antes: sin franjas ni candado.
 *
 * Consultorio de UN profesional (el cliente vivo tiene 1-2): sin chips, sin
 * toggle de modo y sin iniciales en las cards; Día/Semana/Lista se ven y se
 * comportan como antes de B-pre (no-regresión visual pedida para B4.3).
 */
export type Props = {
  view: AgendaView;
  /** Día ancla, DayKey AR "YYYY-MM-DD". */
  dayKey: string;
  /** Lunes AR de la semana del ancla. */
  weekStartKey: string;
  autoCreate?: boolean;
  autoCreatePatientId?: string | null;
  /** Chips elegidos al cargar (`?pros=` o el `?practitioner=` viejo); vacío = todos. */
  initialSelectedIds?: string[];
  bookings: BookingDTO[];
  /**
   * `discipline` (P3-C, C9): la disciplina del servicio. Con ella el cliente
   * resuelve `serviceDiscipline` de cada turno (`expandPlanFields`), que ya no
   * viaja por turno (DTO compacto). Opcional: sin ella "Fuera de plan" no se
   * muestra (falla hacia no avisar).
   */
  services: {
    id: string;
    name: string;
    durationMin: number;
    priceCents: number;
    color: string | null;
    discipline?: Discipline | null;
  }[];
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
   * IAM-4a: `practitionerId` null = el usuario no atiende (Secretaria,
   * Facturación): sin agenda propia ni profesional por defecto.
   */
  viewer?: { userId: string; practitionerId: string | null } | null;
  /** Capabilities del actor (`getCapabilities()` como ARRAY: cruza server→client). */
  capabilities?: string[] | null;
} & Partial<AgendaBootstrapProps>;

type AgendaHours = { start: number; end: number; slotMinutes: number };

/** Single source of truth for the fallback window (was duplicated inline). */
const AGENDA_HOURS_FALLBACK: AgendaHours = { start: 8, end: 19, slotMinutes: 60 };

/**
 * Reloj de la agenda: un `Date` que se renueva al cambiar el minuto (línea de
 * "ahora", "En sala 12′", reserva pública que vence a los 30 min). Antes solo
 * corría si había una reserva impaga en pantalla; con Recepción, siempre.
 */
function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let interval: number | undefined;
    const tick = () => setNow(new Date());
    const timeout = window.setTimeout(() => {
      tick();
      interval = window.setInterval(tick, 60_000);
    }, 60_000 - (Date.now() % 60_000));
    return () => {
      window.clearTimeout(timeout);
      if (interval !== undefined) window.clearInterval(interval);
    };
  }, []);
  return now;
}

const EMPTY: never[] = [];

/** Alta desde una celda de "Por sala" (SR-U4 → SR-U5c): la sala de la columna;
 *  "Sin sala" (`"none"`) abre el modal sin sala. */
export function roomSlotCreating(roomId: string, iso: string): { defaultISO: string; defaultRoomId: string | null } {
  return { defaultISO: iso, defaultRoomId: roomId === "none" ? null : roomId };
}

/** Bloqueo existente del día para el candado (`DayLockDialog.existingBlocks`). */
export type DayLockExistingBlock = Pick<
  AgendaBlockView,
  "id" | "groupId" | "practitionerId" | "startsAt" | "endsAt" | "allDay" | "reason"
> & { roomId?: string };

/**
 * Bloqueos que tocan el día del candado. SR-BU (§17.5): los de SALA viajan
 * aparte (`availability.roomBlocks`, el loader los separa de `blocks`); sin
 * sumarlos acá no se listaban ni se podían desbloquear. Van con
 * `practitionerId: null` + `roomId` y el diálogo los rotula con la sala (nunca
 * "Todo el equipo"). Sin salas el resultado es el de siempre (sin `roomId`).
 */
export function dayLockExistingBlocks(availability: AgendaAvailability, dayKey: string): DayLockExistingBlock[] {
  const { start, end } = dayWindow(dayKey);
  const touches = (b: { startsAt: string; endsAt: string }) => new Date(b.startsAt) < end && new Date(b.endsAt) > start;
  const people = availability.blocks.filter(touches).map((b) => ({
    id: b.id,
    groupId: b.groupId,
    practitionerId: b.practitionerId,
    startsAt: b.startsAt,
    endsAt: b.endsAt,
    allDay: b.allDay,
    reason: b.reason,
  }));
  // `AgendaRoomBlockView` = { id, roomId, startsAt, endsAt, reason }; `allDay`
  // false: el rótulo detecta "Todo el día" por la ventana.
  const rooms = (availability.roomBlocks ?? [])
    .filter(touches)
    .map((b) => ({ ...b, groupId: null, practitionerId: null, allDay: false }));
  return [...people, ...rooms];
}
/** Reloj fijo para cálculos sin turnos (filas bloqueadas): el "ahora" solo
 *  importa para la reserva pública vencida, y ahí no hay turnos. */
const NO_CLOCK = new Date(0);

export function AgendaClient(props: Props) {
  const router = useRouter();
  const toast = useToast();
  const now = useMinuteClock();
  const { dayKey, weekStartKey } = props;
  // SR-U6: "Por sala" sin catálogo de salas (se archivaron todas con la página
  // abierta, o un link viejo) es el Día de siempre. El server ya lo resuelve
  // así (`resolveAgendaView` con `roomCount`); esto cubre lo que llega igual.
  const view: AgendaView = props.view === "room" && !props.rooms?.length ? "timeline" : props.view;
  const [creating, setCreating] = useState<null | {
    defaultISO?: string;
    defaultPatientId?: string | null;
    /** Alta rápida desde una columna: ese profesional. */
    practitionerId?: string | null;
    /** SR-U5c: alta desde una columna de "Por sala": esa sala (null = "Sin sala"). */
    defaultRoomId?: string | null;
  }>(null);
  // SV09: el drawer guarda QUÉ turno abrió (id + la versión que vio) y el turno
  // se deriva de la lista viva (abajo, `editingBooking`). Antes guardaba una
  // copia fija: con la agenda en vivo, un turno movido por otra sesión seguía
  // mostrando la hora vieja.
  const [editing, setEditingState] = useState<{ id: string; updatedAt: string } | null>(null);
  const setEditing = useCallback(
    (b: BookingDTO | null) => setEditingState(b ? { id: b.id, updatedAt: b.updatedAt } : null),
    []
  );
  // Chunks diferidos (modal/drawer/candado): precarga cuando el navegador
  // está ocioso. Safari no tiene requestIdleCallback → setTimeout.
  useEffect(() => {
    const w = window as Window & { requestIdleCallback?: (cb: () => void) => number; cancelIdleCallback?: (id: number) => void };
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(prefetchAgendaChunks);
      return () => w.cancelIdleCallback?.(id);
    }
    const t = window.setTimeout(prefetchAgendaChunks, 1500);
    return () => window.clearTimeout(t);
  }, []);
  // Color legend "filter": clicking a service highlights (lifts) all its cards.
  // Single-select; clicking the active one clears. Purely visual (no filtering).
  // P3-C: `AgendaHighlight` (servicio, plan o suelto; `lib/agenda-highlight.ts`).
  const [highlight, setHighlightState] = useState<AgendaHighlight | null>(null);
  // S19b: leyenda/filtro de plan solo con el módulo `planes` (VERTICALES §5).
  const plansEnabled = useTenantModules().has("planes");
  // El alcance De plan / Sueltos se recuerda por usuario (como los toggles de
  // cancelados/ausentes): primer render sin resaltado (hidratación) y lo
  // guardado se aplica después de montar. Sin el módulo no se lee.
  const planScopeKey = agendaPlanScopeStorageKey(props.viewer?.userId);
  useEffect(() => {
    if (!plansEnabled) return;
    try {
      const stored = planScopeHighlight(parseAgendaPlanScope(window.localStorage.getItem(planScopeKey)));
      if (stored) setHighlightState((prev) => prev ?? stored);
    } catch {
      /* storage no disponible: sin resaltado */
    }
  }, [plansEnabled, planScopeKey]);
  const setHighlight = (next: AgendaHighlight | null) => {
    setHighlightState(next);
    if (!plansEnabled) return;
    // Se guarda el alcance de plan que queda (elegir un servicio = "Todos").
    try {
      const v = serializeAgendaPlanScope(planScopeOf(next));
      if (v == null) window.localStorage.removeItem(planScopeKey);
      else window.localStorage.setItem(planScopeKey, v);
    } catch {
      /* no persiste, pero el resaltado funciona en esta pestaña */
    }
  };
  const toggleLegend = (own: AgendaHighlight) => setHighlight(toggleHighlight(highlight, own));
  const planScope: AgendaPlanScope | null = plansEnabled ? planScopeOf(highlight) : null;
  const setPlanScope = (scope: AgendaPlanScope) => setHighlight(planScopeHighlight(scope));
  // Server-backed per-user agenda preferences, controlled from the Tweaks
  // panel + /configuracion. `agendaShowWeekHeader` drives the day-header
  // chrome — the day strip (every view) AND the week-grid header row.
  const { agenda } = useTweaks();
  const showDayHeader = agenda.agendaShowWeekHeader;

  // ── Preferencias de agenda (B4.2), optimistas ──────────────────────────────
  const [prefs, setPrefs] = useState<AgendaViewPrefs>(props.agendaPrefs ?? DEFAULT_AGENDA_VIEW_PREFS);
  const persistPrefs = useCallback(
    (patch: Partial<AgendaViewPrefs>) => {
      const before = Object.fromEntries(
        Object.keys(patch).map((k) => [k, prefs[k as keyof AgendaViewPrefs]])
      ) as Partial<AgendaViewPrefs>;
      setPrefs((p) => ({ ...p, ...patch }));
      // Si falla, vuelve atrás SOLO lo tocado (otro toggle pudo cambiar el resto).
      const rollback = () => {
        setPrefs((p) => ({ ...p, ...before }));
        toast.error("No se pudo guardar la preferencia de la agenda.");
      };
      updateAgendaViewPrefs(patch).then((r) => (r.ok ? undefined : rollback()), rollback);
    },
    [prefs, toast]
  );

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

  // ── Capabilities y profesionales ───────────────────────────────────────────
  const caps = useMemo(() => capabilitySet(props.capabilities), [props.capabilities]);
  const ownPractitionerId = props.viewer?.practitionerId ?? null;
  const canReception = caps.has("agenda.reception");
  const canLockAny = caps.has("agenda.manageBlocks") || caps.has("agenda.manageOwnBlocks");
  // Quién puede cargar salas (Configuración › Sedes): copy del vacío de "Por sala" (SRZ B3).
  const canConfigureRooms = caps.has("tenant.admin") || caps.has("schedule.configure");
  const practitionerCount = props.practitioners.length;

  const badges = useMemo(
    () =>
      props.practitionerBadges ??
      props.practitioners.map((p) => ({ id: p.id, name: p.name, initials: practitionerInitials(p.name) })),
    [props.practitionerBadges, props.practitioners]
  );
  // Favoritos primero, en vivo (la estrella reordena sin recargar).
  const ordered = useMemo(() => practitionerOrder(badges, prefs), [badges, prefs]);

  const [selectedIds, setSelectedIdsState] = useState<string[]>(props.initialSelectedIds ?? []);
  const setSelectedIds = (ids: string[]) => {
    setSelectedIdsState(ids);
    // En la URL (sin navegar): un refresh o un link conserva la selección.
    try {
      window.history.replaceState(null, "", agendaHref({ view, dayKey, selectedIds: ids }));
    } catch {
      /* sin history: la selección vale para esta pestaña */
    }
  };
  const visiblePracs = useMemo(() => visiblePractitioners(ordered, selectedIds), [ordered, selectedIds]);
  const initialsById = useMemo(
    () =>
      showPractitionerInitials(visiblePracs.length)
        ? Object.fromEntries(visiblePracs.map((p) => [p.id, { initials: p.initials, name: p.name }]))
        : null,
    [visiblePracs]
  );
  // "Por sala" (SRZ M1): iniciales de TODOS los profesionales. `initialsById`
  // es null con un solo profesional visible y trae solo los elegidos, así que
  // el header decía "Asignada: ? 14–18" para la sala de otro profesional.
  const roomPractitionerById = useMemo(
    () => Object.fromEntries(ordered.map((p) => [p.id, { initials: p.initials, name: p.name }])),
    [ordered]
  );

  // ── Disponibilidad (franjas, candado, bloqueos) ────────────────────────────
  const [availability, setAvailability] = useState<AgendaAvailability | null>(props.initialAvailability ?? null);
  const requested = useRef<string | null>(null);
  useEffect(() => {
    // Datos nuevos del server (cambio de semana, router.refresh): mandan.
    setAvailability(props.initialAvailability ?? null);
    requested.current = null;
  }, [props.initialAvailability]);
  const locationId = prefs.locationId;
  useEffect(() => {
    const want = { from: weekStartKey, locationId };
    if (availabilityMatches(availability, want)) return;
    const key = `${weekStartKey}|${locationId ?? ""}`;
    // Un pedido por combinación: si falló, no se reintenta en loop.
    if (requested.current === key) return;
    requested.current = key;
    let cancelled = false;
    getAgendaAvailability({ from: weekStartKey, to: shiftDayKey(weekStartKey, 6), locationId })
      .then((res) => {
        if (cancelled) return;
        if (res.ok) setAvailability(res.data);
        else setAvailability(null);
      })
      .catch(() => {
        if (!cancelled) setAvailability(null);
      });
    return () => {
      cancelled = true;
      // Si este efecto se descarta antes de responder, el próximo puede volver a pedir.
      if (requested.current === key) requested.current = null;
    };
  }, [availability, weekStartKey, locationId]);

  const primaryLocationId =
    availability?.primaryLocationId ?? props.locations?.find((l) => l.isPrimary)?.id ?? null;

  // ── Salas (SR) ─────────────────────────────────────────────────────────────
  // Catálogo del bootstrap (activas de sedes activas); el nombre de `roomId` se
  // resuelve acá, no viaja por turno (C9 compacto). Sin salas: todo lo de abajo
  // da vacío/null y la agenda es la de antes de SR.
  const rooms = props.rooms ?? EMPTY;
  // D4: con "Todas las sedes", las salas de la sede principal.
  const scopeRooms = useMemo(
    () => roomsInScope(rooms, locationId, primaryLocationId),
    [rooms, locationId, primaryLocationId]
  );
  const roomCount = scopeRooms.length;
  // SRZ B4: parado en "Por sala" en una sede sin salas (se cambió de sede con
  // la página abierta), el toggle igual ofrece "Por sala" marcado y la salida
  // a "Por día"; si no, quedaban opciones sin marcar (o ningún toggle con un
  // solo profesional). Al elegir "Por día", `dayViewFor` lleva al Día.
  const toggleRoomCount = view === "room" ? Math.max(roomCount, 1) : roomCount;
  // D3: sala ajena/archivada/de otra sede, o menos de 2 salas → todas.
  const roomId = effectiveRoomFilter(prefs.roomId, scopeRooms);
  const roomCatalog = useMemo(
    () => Object.fromEntries(rooms.map((r) => [r.id, { name: r.name }])) as Record<string, { name: string }>,
    [rooms]
  );

  // ── Turnos: recepción optimista + filtros ──────────────────────────────────
  // `ReceptionView` avisa cada cambio con la fila nueva (o la vieja si "cambió
  // en otra sesión"); se pisa acá al instante y `router.refresh()` re-lista.
  const [overrides, setOverrides] = useState<Readonly<Record<string, BookingDTO>>>({});
  useEffect(() => setOverrides({}), [props.bookings]);

  // ── Agenda en vivo (SV09, plan §18.5) ──────────────────────────────────────
  // Un lote del canal que toca la semana visible → se re-pide la semana con
  // `listAgendaBookings` DIRECTO, no con `router.refresh()`: el refresh
  // re-ejecuta la página entera (`listPatients()` de todo el consultorio,
  // servicios, obras sociales, settings, disponibilidad) para cambiar una
  // fila, y con varias recepciones operando eso es un refresh cada pocos
  // segundos por pestaña. `listAgendaBookings` no está cacheado: trae filas
  // frescas sin invalidar nada. Mismos parámetros que la página
  // (`weekFetchRange`: la semana entera, todos los profesionales y sedes; los
  // filtros son del cliente) para que la lista viva sea intercambiable con
  // `props.bookings`.
  // `liveBookings` reemplaza a `props.bookings` SOLO mientras `props.bookings`
  // sea el mismo array con que salió el refetch: una navegación o un
  // `router.refresh()` (acción propia) traen datos del server más nuevos y la
  // lista viva se descarta sola, sin un effect (que dejaría un render con la
  // lista vieja de otra semana).
  const rt = useRealtime();
  const [live, setLive] = useState<{ base: BookingDTO[]; weekStartKey: string; rows: BookingDTO[] } | null>(null);
  const rawBookings =
    live && live.base === props.bookings && live.weekStartKey === weekStartKey ? live.rows : props.bookings;
  // Lo último visto, para los callbacks del canal (se registran una vez).
  const liveRef = useRef({ bookings: props.bookings, weekStartKey, shown: rawBookings });
  useEffect(() => {
    liveRef.current = { bookings: props.bookings, weekStartKey, shown: rawBookings };
  });
  // Acciones propias recientes: su eco en el canal no titila (`remoteFlashIds`).
  const ownRef = useRef<{ ids: Map<string, number>; quietUntil: number }>({ ids: new Map(), quietUntil: 0 });
  const markOwn = useCallback((id: string | null, opts: { quiet?: boolean } = {}) => {
    const until = Date.now() + OWN_ACTION_QUIET_MS;
    const own = ownRef.current;
    for (const [k, exp] of own.ids) if (exp <= Date.now()) own.ids.delete(k);
    if (id) own.ids.set(id, until);
    if (opts.quiet) own.quietUntil = until;
  }, []);
  // Cards que cambiaron por otra sesión (`BookingFlashContext` → `k-flash`).
  // Los ids se SUMAN y se limpian juntos `FLASH_MS` después del último lote:
  // sacar la clase a mitad de la animación cortaría el fade (un salto de color).
  const [flashIds, setFlashIds] = useState<ReadonlySet<string> | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);
  const refetchLive = useCallback(async () => {
    const { bookings: base, weekStartKey: wk } = liveRef.current;
    const range = weekFetchRange(wk);
    const rows = await listAgendaBookings({ from: range.from, to: range.to });
    const cur = liveRef.current;
    // Mientras volaba, el usuario navegó o llegó un `router.refresh()`: lo del
    // server manda y esta respuesta ya no corresponde.
    if (cur.bookings !== base || cur.weekStartKey !== wk) return;
    const next = rows.map(toBookingDTO);
    const changed = changedBookingIds(cur.shown, next);
    setLive({ base, weekStartKey: wk, rows: next });
    // Los overrides optimistas que el server ya superó, afuera (si no, el mapa
    // solo se vaciaba al cambiar `props.bookings`).
    setOverrides((o) => pruneBookingOverrides(o, next));
    const lit = remoteFlashIds(changed, ownRef.current, Date.now());
    if (lit.length > 0) {
      setFlashIds((prev) => new Set([...(prev ?? []), ...lit]));
      window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setFlashIds(null), FLASH_MS);
    }
  }, []);
  const { subscribe, onResync } = rt;
  useEffect(() => {
    // A lo sumo un refetch en vuelo y uno pendiente, por más lotes que lleguen.
    const coalescer = createRefetchCoalescer(refetchLive);
    const offBatch = subscribe((batch) => {
      if (!messagesTouchRange(batch, weekFetchRange(liveRef.current.weekStartKey))) return;
      // Candado / bloqueos: cambian franjas y bloqueos, que vienen del server
      // component (`initialAvailability`), no de `listAgendaBookings`. Ahí sí
      // `router.refresh()`; trae también los turnos, así que no se re-pide aparte.
      if (batch.some((m) => m.kind === "availability")) router.refresh();
      else coalescer.request();
    });
    // Reconexión, pestaña que vuelve, red que vuelve o polling de 60 s: se
    // pudieron perder mensajes → la semana entera otra vez.
    const offResync = onResync(() => coalescer.request());
    return () => {
      offBatch();
      offResync();
      coalescer.dispose();
    };
  }, [subscribe, onResync, refetchLive, router]);
  // C9 compacto en el cable (`toBookingDTO`): acá vuelven los neutros y la
  // disciplina del servicio, así las vistas y el drawer leen `programId: null`
  // (suelto) y no `undefined` ("esta proyección no trae C9").
  const disciplineByService = useMemo(() => serviceDisciplineMap(props.services), [props.services]);
  const serverBookings = useMemo(
    () => rawBookings.map((b) => expandPlanFields(b, disciplineByService)),
    [rawBookings, disciplineByService]
  );
  // Handoff de S19a: la fila que devuelve la action (Recepción, drawer) viene
  // SIN expandir; pisarla tal cual hacía que un suelto perdiera `programId:
  // null`/`serviceDiscipline` hasta el `router.refresh()` y se apagara "Fuera
  // de plan" (y el resaltado De plan / Sueltos). Se expande igual que lo del server.
  const allBookings = useMemo(
    () => mergeBookingOverrides(serverBookings, overrides, (b) => expandPlanFields(b, disciplineByService)),
    [serverBookings, overrides, disciplineByService]
  );
  // SV09: el turno del drawer sale de la lista viva (hora, sala, estado
  // nuevos), pero con el `updatedAt` que el usuario VIO al abrirlo: guardar
  // sobre datos viejos tiene que seguir dando "cambió en otra sesión" (CAS),
  // como antes de la agenda en vivo. Pasarle la versión nueva haría que el
  // form (que se inicializó con los valores viejos) pise el cambio del otro.
  const editingRow = useMemo(
    () => (editing ? (allBookings.find((b) => b.id === editing.id) ?? null) : null),
    [editing, allBookings]
  );
  const editingBooking = useMemo(
    () =>
      editing && editingRow
        ? editingRow.updatedAt === editing.updatedAt
          ? editingRow
          : { ...editingRow, updatedAt: editing.updatedAt }
        : null,
    [editing, editingRow]
  );
  // El turno abierto desapareció de la semana (se movió a otra o se borró en
  // otra sesión): el drawer no puede seguir operando sobre algo que no se ve.
  useEffect(() => {
    if (editing && !editingRow) {
      setEditingState(null);
      toast.info("El turno cambió en otra sesión");
    }
  }, [editing, editingRow, toast]);
  // S19b: un solo objeto de filtros. SR-U6: la sala se filtra en el CLIENTE,
  // igual que la sede: `listAgendaBookings` trae la semana entera (todas las
  // sedes y salas) y cambiar de sala no vuelve al server; los conteos del
  // filtro (`except: ["roomId"]`) salen de lo mismo. `listAgendaBookings`
  // acepta `roomId`, pero usarlo acá sumaría un viaje por cambio de chip.
  const filters: AgendaFilters = useMemo(
    () => ({ practitionerIds: selectedIds, locationId, roomId }),
    [selectedIds, locationId, roomId]
  );
  const filterCtx: AgendaFilterContext = useMemo(() => ({ primaryLocationId }), [primaryLocationId]);
  // Base de los chips de profesionales: todos los filtros menos el de profesionales.
  const locBookings = useMemo(
    () => applyAgendaFilters(allBookings, filters, filterCtx, { except: ["practitionerIds"] }),
    [allBookings, filters, filterCtx]
  );
  // SRZ M2 (decisión del orquestador): en "Por sala" la base es la de los
  // chips (todos los profesionales): la ocupación de una sala no puede
  // depender de qué chips están puestos. Por eso ahí no se muestran los chips
  // (no hay "resaltado" por profesional) y el conteo de ocultos y la leyenda
  // cuentan lo mismo que se ve. Sin salas la vista "room" no existe.
  const filteredBookings = useMemo(
    () => (view === "room" ? locBookings : applyAgendaFilters(allBookings, filters, filterCtx)),
    [view, locBookings, allBookings, filters, filterCtx]
  );
  // Sala archivada (SRZ B5): el `roomId` de un turno que no está en el
  // catálogo se rotula "Sala archivada" en tarjetas, Lista y Recepción (antes,
  // nada o "—", igual que un turno sin sala). Sin salas, el catálogo vacío de
  // siempre (y Recepción/tarjetas no lo reciben).
  const roomById = useMemo(
    () => (rooms.length > 0 ? withArchivedRooms(roomCatalog, allBookings) : roomCatalog),
    [rooms.length, roomCatalog, allBookings]
  );
  const visibleBookings = useMemo(
    () => applyAgendaVisibility(filteredBookings, visibility),
    [filteredBookings, visibility]
  );

  // Reloj de la GRILLA (B4.6): el tick de cada minuto no recalcula columnas.
  // Solo avanza si hay una reserva pública impaga que puede vencer (cambia
  // qué ocupa cupo) o cuando llegan turnos nuevos. La línea de "ahora" y
  // "En sala 12′" usan `now` directo (barato).
  const holdTicking = useMemo(() => hasTickingPaymentHold(allBookings, now), [allBookings, now]);
  const [layoutNow, setLayoutNow] = useState(now);
  useEffect(() => {
    if (holdTicking) setLayoutNow(now);
  }, [holdTicking, now]);
  useEffect(() => setLayoutNow(new Date()), [allBookings]);

  const bookingsByDay = useMemo(() => {
    const map = new Map<string, BookingDTO[]>();
    for (const b of visibleBookings) {
      const k = toARDateKey(b.scheduledFor);
      map.set(k, [...(map.get(k) ?? []), b]);
    }
    return map;
  }, [visibleBookings]);

  const todayList = useMemo(
    () => [...(bookingsByDay.get(dayKey) ?? [])].sort((a, b) => +new Date(a.scheduledFor) - +new Date(b.scheduledFor)),
    [bookingsByDay, dayKey]
  );

  // Conteo de ocultos en el header, sobre lo que abarca la vista actual (el día
  // en Día/Lista, la semana en Semana): un turno filtrado nunca tiene que
  // parecer un hueco libre.
  const hiddenLabel = useMemo(() => {
    const scope = isDayScoped(view)
      ? filteredBookings.filter((b) => toARDateKey(b.scheduledFor) === dayKey)
      : filteredBookings;
    return hiddenCountLabel(countHidden(scope, visibility));
  }, [filteredBookings, view, dayKey, visibility]);

  // Conteo de la leyenda "Turnos" (S19b): lo que se ve en la vista (el día, o
  // la semana en Semana), sin cancelados.
  const planCounts = useMemo(() => {
    if (!plansEnabled) return null;
    const scope = isDayScoped(view)
      ? visibleBookings.filter((b) => toARDateKey(b.scheduledFor) === dayKey)
      : visibleBookings;
    return countPlanScope(scope);
  }, [plansEnabled, visibleBookings, view, dayKey]);

  // Conteo de los chips: el día (o la semana en Semana), en la sede elegida.
  const chipCounts = useMemo(() => {
    const scope = isDayScoped(view) ? locBookings.filter((b) => toARDateKey(b.scheduledFor) === dayKey) : locBookings;
    return countByPractitioner(scope);
  }, [locBookings, view, dayKey]);
  // Conteos del filtro de sala: todos los filtros menos el de sala, con el
  // mismo alcance que los chips (el día, o la semana en Semana).
  // B1 (SRZ): "Todas las salas" = los no cancelados de esa base, no la suma
  // de las opciones (con "Todas las sedes" hay turnos en salas de otra sede).
  const roomCounts = useMemo(() => {
    if (roomCount < 2) return null;
    const base = applyAgendaFilters(allBookings, filters, filterCtx, { except: ["roomId"] });
    const scoped = isDayScoped(view) ? base.filter((b) => toARDateKey(b.scheduledFor) === dayKey) : base;
    return { counts: countByRoom(scoped), total: scoped.filter((b) => b.status !== "CANCELLED").length };
  }, [roomCount, allBookings, filters, filterCtx, view, dayKey]);
  // Sala en las tarjetas: solo si aporta (2+ salas visibles, fuera de "Por
  // sala" y sin filtro de sala). Con "Todas las sedes" se ven turnos de todas.
  const cardRooms = showRoomOnCards({
    view,
    roomCount: locationId == null ? rooms.length : roomCount,
    roomFilter: roomId,
  })
    ? roomById
    : null;

  // ── Grilla: ventana, franjas y bloqueos ────────────────────────────────────
  const hours = props.businessHours ?? AGENDA_HOURS_FALLBACK;
  const rowStep = hours.slotMinutes === 30 ? 30 : 60;
  const tenantWindow: MinuteWindow = useMemo(
    () => availability?.tenantHours ?? { startMin: hours.start * 60, endMin: hours.end * 60 },
    [availability?.tenantHours, hours.start, hours.end]
  );
  const blocks = useMemo(() => (availability ? layoutBlocks(availability) : []), [availability]);
  const capOf = useMemo(() => (availability ? capOfFromAvailability(availability) : () => null), [availability]);
  const rangesOf = useCallback(
    (key: string): Record<string, LayoutRange[]> => {
      if (availability) return rangesForDay(availability, key, "working");
      // Sin disponibilidad: el horario del consultorio para todos (como antes).
      return Object.fromEntries(visiblePracs.map((p) => [p.id, [{ ...tenantWindow }]]));
    },
    [availability, visiblePracs, tenantWindow]
  );
  const lockStatesOf = useCallback(
    (key: string): Record<string, DayLockState | undefined> => {
      const day = availability?.days.find((d) => d.dayKey === key);
      return Object.fromEntries(visiblePracs.map((p) => [p.id, day?.byPractitioner[p.id]?.dayLockState]));
    },
    [availability, visiblePracs]
  );
  const dayLockOf = useCallback(
    (key: string): AggregatedDayLock | null => {
      if (!availability) return null;
      return aggregateDayLock(Object.values(lockStatesOf(key)));
    },
    [availability, lockStatesOf]
  );
  /** Filas bloqueadas para todos los visibles (vista Día/Semana, filas del tenant). */
  const blockedRowsOf = useCallback(
    (key: string): Map<number, string | null> | null => {
      if (!availability || blocks.length === 0) return null;
      const { start, end } = dayWindow(key);
      const touching = blocks.filter((b) => new Date(b.startsAt) < end && new Date(b.endsAt) > start);
      if (touching.length === 0 || hours.end <= hours.start) return null;
      const layout = buildPractitionerColumns(
        visiblePracs.map((p) => ({ id: p.id, name: p.name })),
        EMPTY,
        {
          dayKey: key,
          zoom: rowStep,
          ranges: rangesOf(key),
          blocks: touching,
          capOf,
          now: NO_CLOCK,
          window: { startMin: hours.start * 60, endMin: hours.end * 60 },
          locationId,
        }
      );
      return blockedRows(layout.columns);
    },
    [availability, blocks, hours.start, hours.end, visiblePracs, rowStep, rangesOf, capOf, locationId]
  );

  const weekDays = useMemo(() => weekDayKeys(weekStartKey), [weekStartKey]);
  const weekLocks = useMemo(
    () => (view === "week" ? Object.fromEntries(weekDays.map((k) => [k, dayLockOf(k) ?? undefined])) : {}),
    [view, weekDays, dayLockOf]
  );
  const weekBlocked = useMemo(
    () => (view === "week" ? Object.fromEntries(weekDays.map((k) => [k, blockedRowsOf(k) ?? undefined])) : {}),
    [view, weekDays, blockedRowsOf]
  );
  const todayLock = useMemo(() => (isDayScoped(view) ? dayLockOf(dayKey) : null), [view, dayKey, dayLockOf]);
  const todayBlocked = useMemo(
    () => (view === "timeline" ? blockedRowsOf(dayKey) : null),
    [view, dayKey, blockedRowsOf]
  );

  const practitionerLayout = useMemo(() => {
    if (view !== "practitioner") return null;
    return buildPractitionerColumns(
      visiblePracs.map((p) => ({ id: p.id, name: p.name })),
      visibleBookings,
      {
        dayKey,
        zoom: prefs.zoom,
        ranges: rangesOf(dayKey),
        blocks,
        capOf,
        now: layoutNow,
        fallback: tenantWindow,
        locationId,
        // IAM-4b: los turnos de quien no tiene columna (turnos viejos de la
        // Secretaria, profesional suspendido) van a «Otros» en vez de
        // desaparecer de la vista. Con chips elegidos no llegan acá (los
        // filtra `applyAgendaFilters`).
        othersColumn: true,
      }
    );
  }, [view, visiblePracs, visibleBookings, dayKey, prefs.zoom, rangesOf, blocks, capOf, layoutNow, tenantWindow, locationId]);

  // ── Candado del día (B4.4) ─────────────────────────────────────────────────
  const [lockDialog, setLockDialog] = useState<null | { dayKey: string; initial: string[] | null }>(null);
  const dayScopeIds = selectedIds.length > 0 ? selectedIds : null;
  const openDayLock = (key: string, columnPractitionerId?: string) => {
    const target = columnPractitionerId ? [columnPractitionerId] : dayScopeIds;
    if (!canOpenDayLock(caps, ownPractitionerId, target)) {
      toast.info("Solo podés bloquear tu propia agenda.");
      return;
    }
    setLockDialog({
      dayKey: key,
      initial: dayLockInitialScope({ caps, ownPractitionerId, selectedIds, columnPractitionerId }),
    });
  };
  /** Botón de candado de un día (header de Día/Lista/Por profesional y de cada día de la Semana). */
  const renderDayLock = (key: string, lock: AggregatedDayLock | null, compact: boolean) => {
    if (!lock || lock.status === "off") return null;
    const allowed = canLockAny && canOpenDayLock(caps, ownPractitionerId, dayScopeIds);
    // Sin permiso y abierto: no hay nada que decir.
    if (!allowed && lock.status === "open") return null;
    return (
      <DayLockButton
        state={lock.status}
        reason={lock.detail}
        onClick={() => openDayLock(key)}
        disabled={!allowed}
        compact={compact}
      />
    );
  };
  const lockDialogBlocks = useMemo(
    () => (lockDialog && availability ? dayLockExistingBlocks(availability, lockDialog.dayKey) : []),
    [lockDialog, availability]
  );

  // ── Turno nuevo ────────────────────────────────────────────────────────────
  // Profesional por defecto: el de la columna clickeada; si no, el único chip
  // elegido; si no, el del usuario (si está entre los elegidos o no hay
  // filtro); si no, el primero elegido.
  // IAM-4a/4b: el usuario que no atiende (Secretaria, Facturación) no tiene
  // `ownPractitionerId`: sin filtro queda null y el modal OBLIGA a elegir
  // (`initialPractitionerId`), en vez de caer en silencio al primero.
  const defaultPractitionerId =
    selectedIds.length === 1
      ? selectedIds[0]
      : selectedIds.length > 1
        ? ownPractitionerId && selectedIds.includes(ownPractitionerId)
          ? ownPractitionerId
          : selectedIds[0]
        : ownPractitionerId;

  // Default datetime for the "Nuevo turno" button (no slot clicked):
  // the anchor day at the start of business hours, in AR wall-clock.
  // Previously this fell back to `anchor.toISOString()` (local midnight),
  // which dropped new turnos at 00:00 — off-screen above the timeline and
  // outside the visible hour range. See item: "Externos no se ven".
  const defaultCreateISO = useMemo(() => {
    const hh = String(hours.start).padStart(2, "0");
    return localToARIso(`${dayKey}T${hh}:00`);
  }, [dayKey, hours.start]);

  // ── Navegación (DayKeys AR, `lib/agenda-client-state`) ─────────────────────
  const go = (next: { view?: AgendaView; dayKey?: string }) =>
    router.push(agendaHref({ view: next.view ?? view, dayKey: next.dayKey ?? dayKey, selectedIds }));
  const segment = segmentOf(view);
  const segments: ViewSegment[] = canReception ? ["day", "week", "list", "reception"] : ["day", "week", "list"];
  const onModeChange = (mode: AgendaMode) => {
    if (mode !== prefs.mode) persistPrefs({ mode });
    go({ view: dayViewFor(mode, practitionerCount, roomCount) });
  };
  const onLocationChange = (id: string | null) => {
    // D2: el server limpia la sala al cambiar de sede; acá también, para el
    // estado optimista. Sin sala guardada el patch es el de siempre.
    persistPrefs(prefs.roomId != null ? { locationId: id, roomId: null } : { locationId: id });
  };

  // «En vivo» completo en desktop y solo el punto en mobile (el texto largo de
  // «Sin conexión en vivo · se actualiza cada 60 s» rompía la fila del
  // título). Reusa el par `diag-desktop`/`diag-mobile` de globals.css (1023 px)
  // en vez de sumar CSS; el que no se ve tiene `display: none` y los lectores
  // de pantalla no lo anuncian dos veces.
  const liveIndicator =
    rt.state === "off" ? null : (
      <>
        <span className="diag-desktop">
          <LiveIndicator state={rt.state} />
        </span>
        <span className="diag-mobile">
          <LiveIndicator state={rt.state} compact />
        </span>
      </>
    );

  const hasServiceLegend = props.services.some((s) => s.color);
  const anchorDate = useMemo(() => instantAt(dayKey, 12 * 60), [dayKey]);
  const multi = practitionerCount > 1;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, minHeight: "calc(100vh - 60px)" }}>
      <AgendaToolbar
        anchor={anchorDate}
        segment={segment}
        segments={segments}
        onSegmentChange={(s) => go({ view: viewForSegment(s, { mode: prefs.mode, practitionerCount, roomCount }) })}
        hiddenLabel={hiddenLabel}
        onShowAll={() => setVisibility(DEFAULT_AGENDA_VISIBILITY)}
        onNavigateWeeks={(w) => go({ dayKey: shiftDayKey(dayKey, w * 7) })}
        onToday={() => go({ dayKey: toARDateKey(new Date()) })}
        // SRZ M2: en "Por sala" ni chips ni el select de respaldo (filtrarían
        // lo que la sala tiene que mostrar entero).
        practitioners={view === "room" ? EMPTY : props.practitioners}
        practitionerFilterId={selectedIds.length === 1 ? selectedIds[0] : null}
        onPractitionerFilterChange={(val) => setSelectedIds(val ? [val] : [])}
        density={prefs.density}
        onDensityChange={(density) => persistPrefs({ density })}
        visibility={visibility}
        onVisibilityChange={setVisibility}
        exportFromKey={weekStartKey}
        onCreate={() => setCreating({})}
        modeToggle={
          showModeToggle(view, practitionerCount, toggleRoomCount) ? (
            <ModeToggle
              mode={view === "room" ? "room" : view === "practitioner" ? "practitioner" : "day"}
              // Sin salas: las 2 opciones de siempre (markup idéntico).
              options={
                toggleRoomCount > 0
                  ? availableAgendaModes(practitionerCount, toggleRoomCount).map((m) => AGENDA_MODE_OPTIONS[m])
                  : undefined
              }
              onChange={onModeChange}
            />
          ) : null
        }
        practitionerChips={
          multi && view !== "room" ? (
            <PractitionerChips
              practitioners={ordered.map((p) => ({ ...p, count: chipCounts[p.id] ?? 0 }))}
              selectedIds={selectedIds}
              onChange={setSelectedIds}
              favoriteIds={prefs.favoritePractitionerIds}
              onToggleFavorite={(id) =>
                persistPrefs({ favoritePractitionerIds: toggleFavoritePractitioner(prefs.favoritePractitionerIds, id) })
              }
            />
          ) : null
        }
        locationFilter={
          <>
            <LocationFilter locations={props.locations ?? EMPTY} value={locationId} onChange={onLocationChange} />
            {roomCount >= 2 && (
              <RoomFilter
                rooms={scopeRooms}
                value={roomId}
                onChange={(id) => persistPrefs({ roomId: id })}
                counts={roomCounts?.counts}
                total={roomCounts?.total}
              />
            )}
          </>
        }
        // `dayLock` es el slot junto al título: ahí va también el «En vivo»
        // (SV09). Con realtime `off` el indicador no dibuja nada y el header
        // es el de SR byte a byte (golden en el render test).
        dayLock={
          <>
            {view === "timeline" || view === "list" || view === "practitioner" || view === "room"
              ? renderDayLock(dayKey, todayLock, false)
              : null}
            {liveIndicator}
          </>
        }
        zoom={view === "practitioner" || view === "room" ? prefs.zoom : null}
        onZoomChange={(zoom) => persistPrefs({ zoom })}
        planScope={planScope}
        onPlanScopeChange={setPlanScope}
      />

      {showDayHeader && (
        <WeekStrip
          weekDays={weekDays}
          dayKey={dayKey}
          bookingsByDay={bookingsByDay}
          showSaturday={agenda.agendaShowSaturday}
          showSunday={agenda.agendaShowSunday}
          onPick={(k) => go({ dayKey: k })}
        />
      )}

      <div style={{ flex: 1, minHeight: 0 }}>
        {/* SV09: las cards leen el flash del contexto (no se pasa por cada vista). */}
        <BookingFlashContext.Provider value={flashIds}>
          <AnimatePresence mode="wait">
            <motion.div
              key={`${view}-${dayKey}`}
              initial={{ opacity: 0, y: 6, scale: 0.995 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.995 }}
              transition={{ duration: DUR.base, ease: EASE_OUT }}
              style={{ height: "100%" }}
            >
              {view === "timeline" && (
                <TimelineView
                  bookings={todayList}
                  dayKey={dayKey}
                  onCreate={(iso) => setCreating({ defaultISO: iso })}
                  onEdit={setEditing}
                  density={prefs.density}
                  businessHours={hours}
                  highlight={highlight}
                  practitionerById={initialsById}
                  now={now}
                  blockedRows={todayBlocked}
                  dayLocked={todayLock?.status === "locked" ? { detail: todayLock.detail } : null}
                  roomById={cardRooms}
                />
              )}
              {view === "practitioner" && practitionerLayout && (
                <PractitionerDayView
                  dayKey={dayKey}
                  layout={practitionerLayout}
                  practitioners={visiblePracs}
                  zoom={prefs.zoom}
                  density={prefs.density}
                  now={now}
                  // IAM-4b: la columna «Otros» no es un profesional: el turno nuevo
                  // sale sin profesional de columna (cae al default o hay que elegir).
                  onSlotClick={(practitionerId, iso) =>
                    setCreating(
                      practitionerId === OTHERS_COLUMN_ID ? { defaultISO: iso } : { defaultISO: iso, practitionerId }
                    )
                  }
                  onBookingClick={setEditing}
                  highlight={highlight}
                  lockStateByPractitioner={availability ? lockStatesOf(dayKey) : undefined}
                  onDayLockClick={
                    canLockAny && availability
                      ? (pid) =>
                          pid === OTHERS_COLUMN_ID
                            ? toast.info("«Otros» junta turnos de quien no tiene agenda: no se bloquea.")
                            : openDayLock(dayKey, pid)
                      : undefined
                  }
                  roomById={cardRooms}
                />
              )}
              {view === "room" && (
                <RoomDayPanel
                  dayKey={dayKey}
                  scopeRooms={scopeRooms}
                  roomId={roomId}
                  bookings={visibleBookings}
                  availability={availability}
                  blocks={blocks}
                  locationId={locationId}
                  primaryLocationId={primaryLocationId}
                  zoom={prefs.zoom}
                  density={prefs.density}
                  now={now}
                  layoutNow={layoutNow}
                  fallback={tenantWindow}
                  onSlotClick={(id, iso) => setCreating(roomSlotCreating(id, iso))}
                  onBookingClick={setEditing}
                  highlight={highlight}
                  practitionerById={roomPractitionerById}
                  canConfigureRooms={canConfigureRooms}
                  fallbackLocationName={
                    locationId == null ? (props.locations?.find((l) => l.id === primaryLocationId)?.name ?? null) : null
                  }
                />
              )}
              {view === "week" && (
                <WeekGridView
                  weekDays={weekDays}
                  bookings={visibleBookings}
                  onEdit={setEditing}
                  businessHours={hours}
                  showHeader={agenda.agendaShowWeekHeader}
                  showSaturday={agenda.agendaShowSaturday}
                  showSunday={agenda.agendaShowSunday}
                  highlight={highlight}
                  practitioners={initialsById ? visiblePracs : null}
                  dayLocks={weekLocks}
                  blockedByDay={weekBlocked}
                  renderDayLock={(k) => renderDayLock(k, weekLocks[k] ?? null, true)}
                  roomById={cardRooms}
                />
              )}
              {view === "list" && (
                <ListView
                  bookings={todayList}
                  onEdit={setEditing}
                  highlight={highlight}
                  practitionerById={initialsById}
                  now={now}
                  roomById={cardRooms}
                />
              )}
              {view === "reception" && (
                <ReceptionView
                  dayKey={dayKey}
                  bookings={todayList}
                  practitioners={visiblePracs}
                  now={now}
                  canOperate={canReception}
                  // La columna "Sala" depende solo de que haya salas (la Secretaria
                  // deriva al paciente aunque haya un solo consultorio).
                  roomById={rooms.length > 0 ? roomById : null}
                  onOpenBooking={setEditing}
                  onChanged={(b) => {
                    markOwn(b.id);
                    setOverrides((o) => ({ ...o, [b.id]: b }));
                    router.refresh();
                  }}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </BookingFlashContext.Provider>
      </div>

      {(hasServiceLegend || plansEnabled) && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            padding: "10px 4px 2px",
            alignItems: "center",
          }}
        >
          {hasServiceLegend && (
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
          )}
          {props.services
            .filter((s) => s.color)
            .map((s) => {
              const own: AgendaHighlight = { kind: "service", serviceId: s.id };
              const active = sameHighlight(highlight, own);
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => toggleLegend(own)}
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
          {plansEnabled && (
            <>
              {hasServiceLegend && (
                <span
                  aria-hidden="true"
                  style={{ width: 1, height: 16, background: "rgba(15,30,51,0.12)", margin: "0 4px" }}
                />
              )}
              <PlanLegend highlight={highlight} onToggle={toggleLegend} counts={planCounts} />
            </>
          )}
        </div>
      )}

      <AnimatePresence>
        {creating && (
          <BookingModal
            key="booking-create"
            defaultISO={creating.defaultISO ?? defaultCreateISO}
            defaultPatientId={creating.defaultPatientId ?? null}
            defaultPractitionerId={creating.practitionerId ?? defaultPractitionerId}
            services={props.services}
            practitioners={props.practitioners}
            patients={props.patients}
            insurers={props.insurers}
            enabledServiceIds={availability?.enabledServiceIds ?? null}
            locations={props.locations ?? null}
            capabilities={props.capabilities ?? null}
            viewerPractitionerId={ownPractitionerId}
            defaultLocationId={locationId}
            rooms={props.rooms ?? null}
            defaultRoomId={creating.defaultRoomId}
            onClose={() => setCreating(null)}
            onSaved={() => {
              // El id del alta lo decide el server: silencio general unos segundos.
              markOwn(null, { quiet: true });
              setCreating(null);
              router.refresh();
            }}
          />
        )}
      </AnimatePresence>

      <BookingDrawer
        booking={editingBooking}
        capabilities={props.capabilities ?? null}
        rooms={rooms}
        primaryLocationId={primaryLocationId}
        onClose={() => setEditing(null)}
        onSaved={() => {
          // Mover en serie / re-planificar tocan otros turnos del plan: silencio general.
          markOwn(editing?.id ?? null, { quiet: true });
          setEditing(null);
          router.refresh();
        }}
      />

      {lockDialog && (
        <DayLockDialog
          open
          dayKey={lockDialog.dayKey}
          practitioners={ordered.map((p) => ({ id: p.id, name: p.name }))}
          initialPractitionerIds={lockDialog.initial}
          locations={(props.locations ?? EMPTY).map((l) => ({ id: l.id, name: l.name }))}
          canBlockAll={caps.has("agenda.manageBlocks")}
          ownPractitionerId={ownPractitionerId}
          existingBlocks={lockDialogBlocks}
          rooms={props.rooms}
          onClose={() => setLockDialog(null)}
          onDone={() => {
            markOwn(null, { quiet: true });
            setLockDialog(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
