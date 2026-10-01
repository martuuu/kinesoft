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
  agendaVisibilityStorageKey,
  applyAgendaVisibility,
  countHidden,
  hasTickingPaymentHold,
  hiddenCountLabel,
  parseAgendaVisibility,
  type AgendaVisibility,
} from "@/lib/agenda-filters";
import {
  buildPractitionerColumns,
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
  type AgendaBootstrapProps,
} from "@/lib/availability-actions-types";
import { getAgendaAvailability } from "@/lib/availability-actions";
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
  availabilityMatches,
  blockedRows,
  canOpenDayLock,
  capabilitySet,
  countByPractitioner,
  dayLockInitialScope,
  filterAgendaBookings,
  isDayScoped,
  segmentOf,
  shiftDayKey,
  showModeToggle,
  showPractitionerInitials,
  viewForSegment,
  visiblePractitioners,
  weekDayKeys,
  type AgendaView,
  type AggregatedDayLock,
  type ViewSegment,
} from "@/lib/agenda-client-state";
import type { DayLockState } from "@/lib/availability/types";
import type { BookingDTO } from "./agenda-utils";
import { AgendaToolbar } from "./agenda-toolbar";
import { ModeToggle } from "./mode-toggle";
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
 * de `listAgendaBookings`): chips de profesionales (`?pros=`, vacío = todos),
 * sede (`agendaPrefs.locationId`) y los toggles de cancelados/ausentes
 * (localStorage, como siempre).
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
/** Reloj fijo para cálculos sin turnos (filas bloqueadas): el "ahora" solo
 *  importa para la reserva pública vencida, y ahí no hay turnos. */
const NO_CLOCK = new Date(0);

export function AgendaClient(props: Props) {
  const router = useRouter();
  const toast = useToast();
  const now = useMinuteClock();
  const { view, dayKey, weekStartKey } = props;
  const [creating, setCreating] = useState<null | {
    defaultISO?: string;
    defaultPatientId?: string | null;
    /** Alta rápida desde una columna: ese profesional. */
    practitionerId?: string | null;
  }>(null);
  const [editing, setEditing] = useState<BookingDTO | null>(null);
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
  const [highlightedServiceId, setHighlightedServiceId] = useState<string | null>(null);
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

  // ── Turnos: recepción optimista + filtros ──────────────────────────────────
  // `ReceptionView` avisa cada cambio con la fila nueva (o la vieja si "cambió
  // en otra sesión"); se pisa acá al instante y `router.refresh()` re-lista.
  const [overrides, setOverrides] = useState<Record<string, BookingDTO>>({});
  useEffect(() => setOverrides({}), [props.bookings]);
  const allBookings = useMemo(
    () => (Object.keys(overrides).length ? props.bookings.map((b) => overrides[b.id] ?? b) : props.bookings),
    [props.bookings, overrides]
  );
  const locBookings = useMemo(
    () => filterAgendaBookings(allBookings, { selectedIds: EMPTY, locationId, primaryLocationId }),
    [allBookings, locationId, primaryLocationId]
  );
  const filteredBookings = useMemo(
    () => filterAgendaBookings(locBookings, { selectedIds, locationId: null, primaryLocationId }),
    [locBookings, selectedIds, primaryLocationId]
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

  // Conteo de los chips: el día (o la semana en Semana), en la sede elegida.
  const chipCounts = useMemo(() => {
    const scope = isDayScoped(view) ? locBookings.filter((b) => toARDateKey(b.scheduledFor) === dayKey) : locBookings;
    return countByPractitioner(scope);
  }, [locBookings, view, dayKey]);

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
  const lockDialogBlocks = useMemo(() => {
    if (!lockDialog || !availability) return [];
    const { start, end } = dayWindow(lockDialog.dayKey);
    return availability.blocks
      .filter((b) => new Date(b.startsAt) < end && new Date(b.endsAt) > start)
      .map((b) => ({
        id: b.id,
        groupId: b.groupId,
        practitionerId: b.practitionerId,
        startsAt: b.startsAt,
        endsAt: b.endsAt,
        allDay: b.allDay,
        reason: b.reason,
      }));
  }, [lockDialog, availability]);

  // ── Turno nuevo ────────────────────────────────────────────────────────────
  // Profesional por defecto: el de la columna clickeada; si no, el único chip
  // elegido; si no, el del usuario (si está entre los elegidos o no hay
  // filtro); si no, el primero elegido.
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
    go({ view: mode === "practitioner" ? "practitioner" : "timeline" });
  };
  const onLocationChange = (id: string | null) => {
    persistPrefs({ locationId: id });
  };

  const anchorDate = useMemo(() => instantAt(dayKey, 12 * 60), [dayKey]);
  const multi = practitionerCount > 1;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, minHeight: "calc(100vh - 60px)" }}>
      <AgendaToolbar
        anchor={anchorDate}
        segment={segment}
        segments={segments}
        onSegmentChange={(s) => go({ view: viewForSegment(s, { mode: prefs.mode, practitionerCount }) })}
        hiddenLabel={hiddenLabel}
        onShowAll={() => setVisibility(DEFAULT_AGENDA_VISIBILITY)}
        onNavigateWeeks={(w) => go({ dayKey: shiftDayKey(dayKey, w * 7) })}
        onToday={() => go({ dayKey: toARDateKey(new Date()) })}
        practitioners={props.practitioners}
        practitionerFilterId={selectedIds.length === 1 ? selectedIds[0] : null}
        onPractitionerFilterChange={(val) => setSelectedIds(val ? [val] : [])}
        density={prefs.density}
        onDensityChange={(density) => persistPrefs({ density })}
        visibility={visibility}
        onVisibilityChange={setVisibility}
        exportFromKey={weekStartKey}
        onCreate={() => setCreating({})}
        modeToggle={
          showModeToggle(view, practitionerCount) ? (
            <ModeToggle mode={view === "practitioner" ? "practitioner" : "day"} onChange={onModeChange} />
          ) : null
        }
        practitionerChips={
          multi ? (
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
          <LocationFilter locations={props.locations ?? EMPTY} value={locationId} onChange={onLocationChange} />
        }
        dayLock={
          view === "timeline" || view === "list" || view === "practitioner"
            ? renderDayLock(dayKey, todayLock, false)
            : null
        }
        zoom={view === "practitioner" ? prefs.zoom : null}
        onZoomChange={(zoom) => persistPrefs({ zoom })}
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
                highlightedServiceId={highlightedServiceId}
                practitionerById={initialsById}
                now={now}
                blockedRows={todayBlocked}
                dayLocked={todayLock?.status === "locked" ? { detail: todayLock.detail } : null}
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
                onSlotClick={(practitionerId, iso) => setCreating({ defaultISO: iso, practitionerId })}
                onBookingClick={setEditing}
                highlightServiceId={highlightedServiceId}
                lockStateByPractitioner={availability ? lockStatesOf(dayKey) : undefined}
                onDayLockClick={canLockAny && availability ? (pid) => openDayLock(dayKey, pid) : undefined}
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
                highlightedServiceId={highlightedServiceId}
                practitioners={initialsById ? visiblePracs : null}
                dayLocks={weekLocks}
                blockedByDay={weekBlocked}
                renderDayLock={(k) => renderDayLock(k, weekLocks[k] ?? null, true)}
              />
            )}
            {view === "list" && (
              <ListView
                bookings={todayList}
                onEdit={setEditing}
                highlightedServiceId={highlightedServiceId}
                practitionerById={initialsById}
                now={now}
              />
            )}
            {view === "reception" && (
              <ReceptionView
                dayKey={dayKey}
                bookings={todayList}
                practitioners={visiblePracs}
                now={now}
                canOperate={canReception}
                onOpenBooking={setEditing}
                onChanged={(b) => {
                  setOverrides((o) => ({ ...o, [b.id]: b }));
                  router.refresh();
                }}
              />
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
          onClose={() => setLockDialog(null)}
          onDone={() => {
            setLockDialog(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
