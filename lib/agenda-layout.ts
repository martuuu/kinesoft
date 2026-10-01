/**
 * Layout de la agenda multi-profesional — B3.6 AG-layout (puro: sin DB, sin
 * React, sin reloj propio). Lo consumen las vistas de B4.2-B4.5 ("Día por
 * profesional", semana, línea de "ahora") y se testea en unit con TZ=UTC y
 * TZ=AR (`tests/unit/agenda-layout.test.ts`).
 *
 * Por qué existe (plan §11.3 "La agenda de la Secretaria es CRÍTICA"): la
 * secretaria mira varios profesionales a la vez, con el gimnasio de kinesio
 * (cupo null, varios pacientes por franja) al lado del osteópata (cupo 1). Toda
 * la matemática de celdas, cupo y carriles vive acá para que la UI solo dibuje.
 *
 * Convenciones (las del motor, `lib/availability/types.ts`):
 *   • Minutos de pared AR 0..1440 del `dayKey`, rangos semiabiertos
 *     [inicio, fin). El puente instante ↔ minuto es `minuteInDay` de
 *     `lib/availability/day.ts` (nunca `getHours` del host: Vercel es UTC).
 *   • `scheduledFor`/`createdAt`/`startsAt` llegan como `Date` (server) o ISO
 *     string (DTO del cliente): se aceptan los dos.
 *   • Los turnos se devuelven por REFERENCIA (genérico `T`): la UI recibe su
 *     propio DTO, no una copia recortada.
 *
 * Reglas que fija este archivo (no estaban en el contrato):
 *
 *   1. CUPO DE LA CELDA (`used`/`cap`/`label`). Una celda puede tener turnos de
 *      varios servicios, cada uno con su cupo (profesional + servicio,
 *      decisión 5). Por servicio se calcula el PICO de simultaneidad dentro de
 *      la celda (no la cantidad de turnos que la tocan: con zoom 60, dos osteo
 *      de 30' consecutivos son 1/1, no 2/1). La celda muestra el servicio
 *      "dominante" = el de mayor ocupación relativa `used/cap` entre los de
 *      cupo finito; un servicio ilimitado cuenta como ocupación 0 (nunca se
 *      llena). Desempates: más `used`, después `serviceId`. Así el "1/1" del
 *      osteo no queda tapado por el "4/∞" del gimnasio; el detalle completo
 *      viaja en `byService` (mismo orden) y `total` = turnos distintos que
 *      sostienen cupo y tocan la celda.
 *   2. QUÉ OCUPA CUPO. Lo mismo que el servidor (`isHoldingCapacity`, AUDIT
 *      §5.18), con lo que llega al cliente: CANCELLED no ocupa; una reserva
 *      pública impaga vencida a los 30 min tampoco (`paymentHoldState` de
 *      `lib/agenda-filters.ts`, que usa las dos mitades de
 *      `isHoldingCapacity`). NO_SHOW y COMPLETED sí ocupan (el server tampoco
 *      los descuenta). Los cancelados que el caller decidió mostrar se dibujan
 *      (y ocupan carril) pero no suman cupo.
 *   3. ESTADO DE LA CELDA, en este orden de precedencia:
 *        bloqueado > fuera-de-horario > sobreturno > lleno > parcial > libre.
 *      • bloqueado: la celda pisa (aunque sea en parte) un TimeBlock del
 *        profesional o de todos. Un bloqueo de UNA sede no marca la celda si
 *        el profesional tiene en esa celda una franja de OTRA sede.
 *      • fuera-de-horario: la celda no toca ninguna franja (`ranges`). Con
 *        tocar parte alcanza para estar "en horario" (zoom 60 con una franja
 *        que arranca 8:30 → la fila de las 8 es trabajable).
 *      • sobreturno: algún servicio supera su cupo, o algún turno que sostiene
 *        cupo y toca la celda tiene `isOverbooked` (el staff lo forzó).
 *      • lleno: el dominante está justo en su cupo. parcial: hay uso.
 *      Los flags `blocked`/`outOfHours`/`overbooked` se informan aunque gane
 *      otro estado (la UI pone el badge de sobreturno sobre un fondo rayado).
 *   4. `ranges` por profesional = franjas del día YA resueltas por el motor
 *      (`workingRanges`, con fallback del tenant, excepciones y bloqueos
 *      restados); también sirven las de plantilla sin restar, porque
 *      "bloqueado" gana igual. Profesional sin entrada en `ranges` = no
 *      trabaja ese día (todo fuera de horario): el fallback es del loader.
 *   5. CARRILES: asignación greedy por profesional y día. Turnos ordenados por
 *      inicio, el más largo primero, después id; cada uno va al primer carril
 *      libre (cuyo último turno terminó a esa hora o antes) o abre uno nuevo.
 *      `laneCount` = carriles del grupo de turnos que se solapan entre sí
 *      (transitivamente): el ancho de cada card es 1/laneCount de la columna.
 */
import { minuteInDay, dayKeyOf, dayWindow, formatWallTime } from "@/lib/availability/day";
import { resolvePractitionerService } from "@/lib/availability/next-free";
import {
  FALLBACK_TENANT_HOURS,
  MINUTES_PER_DAY,
  type DayKey,
  type PractitionerServiceRule,
  type ServiceInfo,
} from "@/lib/availability/types";
import { paymentHoldState } from "@/lib/agenda-filters";

// ─────────────────────────────────────────────────────────────────────────────
// Tipos
// ─────────────────────────────────────────────────────────────────────────────

/** Granularidad de la grilla (preferencia por usuario, `agendaPrefs.zoom`). */
export type AgendaZoom = 15 | 30 | 60;
export const AGENDA_ZOOMS: ReadonlyArray<AgendaZoom> = [15, 30, 60];
export const DEFAULT_AGENDA_ZOOM: AgendaZoom = 30;

/** Ventana de minutos de pared [startMin, endMin). */
export type MinuteWindow = { startMin: number; endMin: number };

/** Lo mínimo que el layout lee de un turno (BookingDTO / BookingRow lo cumplen). */
export type LayoutBooking = {
  id: string;
  scheduledFor: Date | string;
  durationMin: number;
  status: string;
  serviceId: string;
  practitionerId: string;
  /** Sobreturno forzado por el staff (Booking.isOverbooked). */
  isOverbooked?: boolean;
  /** Para la reserva pública vencida (opcionales: sin ellos, ocupa). */
  paymentStatus?: string | null;
  createdAt?: Date | string | null;
  publicReservation?: boolean;
};

/** Franja de un día (forma de `ScheduleRange`; `locationId` opcional). */
export type LayoutRange = { startMin: number; endMin: number; locationId?: string };

/** Bloqueo (forma de `TimeBlockInput`, serializable). */
export type LayoutBlock = {
  id: string;
  /** null = todos los profesionales. */
  practitionerId: string | null;
  /** null/undefined = todas las sedes. */
  locationId?: string | null;
  startsAt: Date | string;
  endsAt: Date | string;
  allDay?: boolean;
  reason?: string | null;
};

export type SlotState = "libre" | "parcial" | "lleno" | "sobreturno" | "fuera-de-horario" | "bloqueado";

export type ServiceUsage = { serviceId: string; used: number; cap: number | null };

export type SlotCell<T extends LayoutBooking = LayoutBooking> = {
  startMin: number;
  endMin: number;
  /** "HH:MM" de pared AR. */
  time: string;
  /** Turnos que ARRANCAN en la celda (las cards), por carril y hora. */
  bookings: T[];
  /** Turnos que arrancaron antes y siguen en la celda ("continúa…"). */
  continuing: T[];
  /** Pico de simultaneidad del servicio dominante (regla 1). */
  used: number;
  /** Cupo del dominante; null = ilimitado (o celda sin uso). */
  cap: number | null;
  /** "2/3" | "4/∞"; null si la celda no tiene uso. */
  label: string | null;
  state: SlotState;
  /** Uso por servicio, dominante primero. */
  byService: ServiceUsage[];
  /** Turnos distintos que sostienen cupo y tocan la celda. */
  total: number;
  overbooked: boolean;
  outOfHours: boolean;
  blocked: boolean;
  blockIds: string[];
  /** Motivo del primer bloqueo con texto ("Feriado", "Congreso"). */
  blockReason: string | null;
};

export type LaneAssignment = { lane: number; laneCount: number };

export type LayoutPractitioner = {
  id: string;
  name: string;
  firstName?: string | null;
  lastName?: string | null;
};

export type PractitionerColumn<T extends LayoutBooking = LayoutBooking> = {
  practitionerId: string;
  name: string;
  initials: string;
  slots: SlotCell<T>[];
  /** Carril de cada turno del día, por id. */
  lanes: Record<string, LaneAssignment>;
  /** Máximo `laneCount` del día (ancho mínimo de la columna). */
  maxLanes: number;
  /** Turnos del día no cancelados (conteo del chip/filtro). */
  bookingCount: number;
};

export type AgendaRow = { startMin: number; endMin: number; time: string };

export type AgendaDayLayout<T extends LayoutBooking = LayoutBooking> = {
  window: MinuteWindow;
  /** Filas de la grilla (time-gutter), comunes a todas las columnas. */
  rows: AgendaRow[];
  columns: PractitionerColumn<T>[];
};

/** Cupo efectivo de profesional + servicio; null = ilimitado. */
export type CapOf = (practitionerId: string, serviceId: string) => number | null;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers internos
// ─────────────────────────────────────────────────────────────────────────────

const toDate = (d: Date | string): Date => (d instanceof Date ? d : new Date(d));

function normalizeZoom(zoom: number | undefined): AgendaZoom {
  return AGENDA_ZOOMS.includes(zoom as AgendaZoom) ? (zoom as AgendaZoom) : DEFAULT_AGENDA_ZOOM;
}

/** [inicio, fin) del turno en minutos del día (puede salirse de 0..1440). */
function bookingSpan(dayKey: DayKey, b: { scheduledFor: Date | string; durationMin: number }) {
  const start = minuteInDay(dayKey, toDate(b.scheduledFor));
  // Duración 0 (dato roto) igual ocupa un minuto: si no, el turno no se ve.
  return { start, end: start + Math.max(1, b.durationMin) };
}

/** ¿El turno toca el día AR? */
function touchesDay(dayKey: DayKey, b: { scheduledFor: Date | string; durationMin: number }): boolean {
  const { start, end } = bookingSpan(dayKey, b);
  return start < MINUTES_PER_DAY && end > 0;
}

/** Regla 2: ¿sostiene cupo con lo que llega al cliente? */
function holdsCapacity(b: LayoutBooking, now: Date): boolean {
  if (b.status === "CANCELLED") return false;
  return paymentHoldState(b, now) !== "vencida";
}

/** Bloqueo en minutos del día (mismo redondeo HACIA AFUERA y allDay que `ranges.ts`). */
function blockSpan(dayKey: DayKey, b: LayoutBlock): { start: number; end: number } {
  const rawStart = toDate(b.startsAt);
  const rawEnd = toDate(b.endsAt);
  let startsAt = rawStart;
  let endsAt = rawEnd;
  if (b.allDay) {
    // Días AR completos que toca (fin semiabierto: el último ms pertenece al bloqueo).
    startsAt = dayWindow(dayKeyOf(rawStart)).start;
    endsAt = dayWindow(dayKeyOf(new Date(Math.max(rawStart.getTime(), rawEnd.getTime() - 1)))).end;
  }
  return {
    start: Math.max(0, Math.floor(minuteInDay(dayKey, startsAt))),
    end: Math.min(MINUTES_PER_DAY, Math.ceil(minuteInDay(dayKey, endsAt))),
  };
}

/** Pico de simultaneidad de intervalos recortados a [from, to). */
function peakConcurrency(spans: ReadonlyArray<{ start: number; end: number }>, from: number, to: number): number {
  const clipped = spans
    .map((s) => ({ start: Math.max(s.start, from), end: Math.min(s.end, to) }))
    .filter((s) => s.start < s.end);
  let peak = 0;
  for (const p of clipped) {
    const n = clipped.filter((s) => s.start <= p.start && p.start < s.end).length;
    if (n > peak) peak = n;
  }
  return peak;
}

/** Ocupación relativa para elegir el dominante (ilimitado = 0). */
const ratio = (u: ServiceUsage) => (u.cap == null ? 0 : u.cap === 0 ? Infinity : u.used / u.cap);

function compareUsage(a: ServiceUsage, b: ServiceUsage): number {
  return ratio(b) - ratio(a) || b.used - a.used || a.serviceId.localeCompare(b.serviceId);
}

const capLabel = (used: number, cap: number | null) => `${used}/${cap == null ? "∞" : cap}`;

/** Carriles greedy (regla 5). */
function assignLanes(dayKey: DayKey, bookings: ReadonlyArray<LayoutBooking>): Record<string, LaneAssignment> {
  const items = bookings
    .map((b) => ({ id: b.id, ...bookingSpan(dayKey, b) }))
    .sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start) || a.id.localeCompare(b.id));
  const out: Record<string, LaneAssignment> = {};
  let laneEnds: number[] = [];
  let group: string[] = [];
  let groupEnd = -Infinity;
  const closeGroup = () => {
    for (const id of group) out[id].laneCount = laneEnds.length;
    laneEnds = [];
    group = [];
  };
  for (const it of items) {
    if (it.start >= groupEnd && group.length > 0) closeGroup();
    let lane = laneEnds.findIndex((end) => end <= it.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(it.end);
    } else {
      laneEnds[lane] = it.end;
    }
    out[it.id] = { lane, laneCount: 0 };
    group.push(it.id);
    groupEnd = Math.max(groupEnd, it.end);
  }
  closeGroup();
  return out;
}

function rowsOf(window: MinuteWindow, zoom: AgendaZoom): AgendaRow[] {
  const rows: AgendaRow[] = [];
  for (let m = window.startMin; m < window.endMin; m += zoom) {
    rows.push({ startMin: m, endMin: m + zoom, time: formatWallTime(m) });
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ventana visible del día: unión (mín. inicio, máx. fin) de las franjas de
 * todos los profesionales en pantalla, redondeada HACIA AFUERA a la grilla
 * (`zoom`). Sin ninguna franja → `fallback` (horario del tenant). Si se pasan
 * `dayKey` + `bookings`, se estira para que ningún turno del día quede
 * invisible (un turno a las 7:00 con horario 8-19 abre la fila de las 7).
 * Recortada a [0, 1440] y nunca vacía (mínimo una fila).
 */
export function visibleWindow(
  rangesByPractitioner: Readonly<Record<string, ReadonlyArray<LayoutRange>>>,
  fallback: MinuteWindow,
  opts: {
    zoom?: AgendaZoom;
    dayKey?: DayKey;
    bookings?: ReadonlyArray<{ scheduledFor: Date | string; durationMin: number }>;
  } = {}
): MinuteWindow {
  const zoom = normalizeZoom(opts.zoom);
  let start = Infinity;
  let end = -Infinity;
  for (const ranges of Object.values(rangesByPractitioner)) {
    for (const r of ranges) {
      if (!(r.startMin < r.endMin)) continue;
      start = Math.min(start, r.startMin);
      end = Math.max(end, r.endMin);
    }
  }
  if (!Number.isFinite(start)) {
    const fb = fallback.startMin < fallback.endMin ? fallback : FALLBACK_TENANT_HOURS;
    start = fb.startMin;
    end = fb.endMin;
  }
  if (opts.dayKey && opts.bookings) {
    for (const b of opts.bookings) {
      if (!touchesDay(opts.dayKey, b)) continue;
      const span = bookingSpan(opts.dayKey, b);
      start = Math.min(start, span.start);
      end = Math.max(end, span.end);
    }
  }
  start = Math.max(0, Math.floor(start / zoom) * zoom);
  end = Math.min(MINUTES_PER_DAY, Math.ceil(end / zoom) * zoom);
  if (end <= start) end = Math.min(MINUTES_PER_DAY, start + zoom);
  return { startMin: start, endMin: end };
}

/**
 * Columnas de la vista "Día por profesional" (y de la vista por día con un
 * solo profesional). Ver reglas 1-5 en la cabecera. `window` omitida → se
 * calcula con `visibleWindow` (franjas de estos profesionales, `fallback` o el
 * horario por defecto del tenant, y los turnos del día).
 */
export function buildPractitionerColumns<T extends LayoutBooking>(
  practitioners: ReadonlyArray<LayoutPractitioner>,
  bookings: ReadonlyArray<T>,
  opts: {
    dayKey: DayKey;
    zoom: AgendaZoom;
    /** Franjas del día por profesional (regla 4). */
    ranges: Readonly<Record<string, ReadonlyArray<LayoutRange>>>;
    blocks?: ReadonlyArray<LayoutBlock>;
    /** Cupo efectivo (ver `capResolver`). */
    capOf: CapOf;
    /** Para la reserva pública vencida (regla 2). */
    now: Date;
    window?: MinuteWindow;
    fallback?: MinuteWindow;
    /** Filtro de sede: ignora bloqueos de otras sedes. */
    locationId?: string | null;
  }
): AgendaDayLayout<T> {
  const { dayKey, now, capOf } = opts;
  const zoom = normalizeZoom(opts.zoom);
  const ids = new Set(practitioners.map((p) => p.id));
  const dayBookings = bookings.filter((b) => ids.has(b.practitionerId) && touchesDay(dayKey, b));

  const window =
    opts.window ??
    visibleWindow(
      Object.fromEntries(practitioners.map((p) => [p.id, opts.ranges[p.id] ?? []])),
      opts.fallback ?? FALLBACK_TENANT_HOURS,
      { zoom, dayKey, bookings: dayBookings }
    );
  const rows = rowsOf(window, zoom);
  const loc = opts.locationId ?? null;

  const columns = practitioners.map((p): PractitionerColumn<T> => {
    const mine = dayBookings.filter((b) => b.practitionerId === p.id);
    const lanes = assignLanes(dayKey, mine);
    const ranges = (opts.ranges[p.id] ?? []).filter((r) => r.startMin < r.endMin);
    const blocks = (opts.blocks ?? [])
      .filter(
        (b) =>
          (b.practitionerId == null || b.practitionerId === p.id) &&
          (loc == null || b.locationId == null || b.locationId === loc)
      )
      .map((b) => ({ block: b, ...blockSpan(dayKey, b) }))
      .filter((b) => b.start < b.end);
    const spans = mine.map((b) => ({ b, ...bookingSpan(dayKey, b), holds: holdsCapacity(b, now) }));

    const slots = rows.map(({ startMin, endMin, time }): SlotCell<T> => {
      const touching = spans.filter((s) => s.start < endMin && s.end > startMin);
      const starting = touching
        .filter((s) => s.start >= startMin)
        .sort((a, b) => lanes[a.b.id].lane - lanes[b.b.id].lane || a.start - b.start)
        .map((s) => s.b);
      const continuing = touching.filter((s) => s.start < startMin).map((s) => s.b);

      const holding = touching.filter((s) => s.holds);
      const byServiceMap = new Map<string, Array<{ start: number; end: number }>>();
      for (const s of holding) {
        const list = byServiceMap.get(s.b.serviceId) ?? [];
        list.push(s);
        byServiceMap.set(s.b.serviceId, list);
      }
      const byService: ServiceUsage[] = Array.from(byServiceMap, ([serviceId, list]) => ({
        serviceId,
        used: peakConcurrency(list, startMin, endMin),
        cap: capOf(p.id, serviceId),
      })).sort(compareUsage);
      const dominant = byService[0] ?? null;
      const used = dominant?.used ?? 0;
      const cap = dominant?.cap ?? null;

      const overCap = byService.some((u) => u.cap != null && u.used > u.cap);
      const overbooked = overCap || holding.some((s) => s.b.isOverbooked === true);

      const rangesHere = ranges.filter((r) => r.startMin < endMin && r.endMin > startMin);
      const outOfHours = rangesHere.length === 0;
      const hits = blocks.filter(
        (x) =>
          x.start < endMin &&
          x.end > startMin &&
          // Un bloqueo de una sede no tapa la franja de otra sede en la misma celda.
          (x.block.locationId == null ||
            !rangesHere.some((r) => r.locationId != null && r.locationId !== x.block.locationId))
      );
      const blocked = hits.length > 0;

      let state: SlotState;
      if (blocked) state = "bloqueado";
      else if (outOfHours) state = "fuera-de-horario";
      else if (overbooked) state = "sobreturno";
      else if (cap != null && used >= cap && used > 0) state = "lleno";
      else if (used > 0) state = "parcial";
      else state = "libre";

      return {
        startMin,
        endMin,
        time,
        bookings: starting,
        continuing,
        used,
        cap,
        label: dominant && used > 0 ? capLabel(used, cap) : null,
        state,
        byService,
        total: holding.length,
        overbooked,
        outOfHours,
        blocked,
        blockIds: hits.map((x) => x.block.id),
        blockReason: hits.find((x) => x.block.reason)?.block.reason ?? null,
      };
    });

    return {
      practitionerId: p.id,
      name: p.name,
      initials: practitionerInitials(
        p.firstName != null || p.lastName != null ? { firstName: p.firstName, lastName: p.lastName } : p.name
      ),
      slots,
      lanes,
      maxLanes: Object.values(lanes).reduce((n, l) => Math.max(n, l.laneCount), 0),
      bookingCount: mine.filter((b) => b.status !== "CANCELLED").length,
    };
  });

  return { window, rows, columns };
}

/**
 * `capOf` a partir de lo que trae el loader (`AvailabilityInput.services` +
 * `practitionerServices`), con la misma regla que el motor
 * (`resolvePractitionerService`: cupo del servicio salvo `concurrencyOverride`;
 * override + null = ilimitado). Servicio desconocido → ilimitado (no inventa
 * un "lleno").
 */
export function capResolver(
  services: ReadonlyArray<ServiceInfo>,
  practitionerServices: ReadonlyArray<PractitionerServiceRule>
): CapOf {
  const svc = new Map(services.map((s) => [s.id, s]));
  const rules = new Map(practitionerServices.map((r) => [`${r.practitionerId}|${r.serviceId}`, r]));
  return (practitionerId, serviceId) => {
    const service = svc.get(serviceId);
    if (!service) return null;
    return resolvePractitionerService(rules.get(`${practitionerId}|${serviceId}`), service).cap;
  };
}

// ── Iniciales y orden ────────────────────────────────────────────────────────

/** Partículas de apellido que no dan inicial ("de la Fuente" → F). */
const PARTICLES = new Set(["de", "del", "la", "las", "los", "y", "e", "da", "das", "do", "dos", "di", "van", "von", "der"]);
/** Títulos que a veces vienen pegados al nombre. */
const TITLES = new Set(["lic", "lic.", "dr", "dr.", "dra", "dra.", "klgo", "klgo.", "klga", "klga.", "prof", "prof."]);

function words(s: string | null | undefined): string[] {
  return (s ?? "")
    .normalize("NFC")
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{M}.'-]/gu, ""))
    .filter((w) => w.length > 0 && !TITLES.has(w.toLocaleLowerCase("es")) && !w.endsWith("."))
    .filter((w) => !PARTICLES.has(w.toLocaleLowerCase("es")))
    .map((w) => w.replace(/^[^\p{L}]+/u, ""))
    .filter((w) => w.length > 0);
}

const firstLetter = (w: string) => Array.from(w)[0].toLocaleUpperCase("es");

/**
 * Dos letras para el avatar del profesional (identidad no cromática, §11.3
 * punto 2). Robusto con tildes (normaliza NFC: "Á" → "Á"), espacios de
 * más, títulos ("Lic.", "Dra.") y partículas ("de la Fuente" → F).
 *   • `{firstName, lastName}` → primera del nombre + primera del apellido.
 *   • String (hoy `UserProfile` guarda un solo nombre): 1 palabra → sus dos
 *     primeras letras; 2-3 palabras → primera + segunda ("José Luis Martínez"
 *     → JL: con 3 palabras no se sabe si la segunda es nombre o apellido); 4+
 *     → primera + anteúltima, asumiendo dos nombres y dos apellidos
 *     ("María José Pérez García" → MP). Vacío → "?".
 */
export function practitionerInitials(
  name: string | { firstName?: string | null; lastName?: string | null }
): string {
  if (typeof name !== "string") {
    const f = words(name.firstName);
    const l = words(name.lastName);
    if (f.length > 0 && l.length > 0) return firstLetter(f[0]) + firstLetter(l[0]);
    return practitionerInitials([name.firstName, name.lastName].filter(Boolean).join(" "));
  }
  const w = words(name);
  if (w.length === 0) return "?";
  if (w.length === 1) {
    const letters = Array.from(w[0]).filter((c) => /\p{L}/u.test(c));
    return letters.slice(0, 2).join("").toLocaleUpperCase("es") || "?";
  }
  if (w.length <= 3) return firstLetter(w[0]) + firstLetter(w[1]);
  return firstLetter(w[0]) + firstLetter(w[w.length - 2]);
}

/**
 * Orden de las columnas/chips: favoritos primero (en el orden de
 * `agendaPrefs.favoritePractitionerIds`), después el resto en el orden de
 * entrada (el server ya ordena). Ids favoritos que no están en la lista se
 * ignoran; duplicados, una sola vez. No muta la entrada.
 */
export function practitionerOrder<P extends { id: string }>(
  practitioners: ReadonlyArray<P>,
  prefs: { favoritePractitionerIds?: ReadonlyArray<string> | null } | null | undefined
): P[] {
  const byId = new Map(practitioners.map((p) => [p.id, p]));
  const out: P[] = [];
  const seen = new Set<string>();
  for (const id of prefs?.favoritePractitionerIds ?? []) {
    const p = byId.get(id);
    if (p && !seen.has(id)) {
      out.push(p);
      seen.add(id);
    }
  }
  for (const p of practitioners) if (!seen.has(p.id)) out.push(p);
  return out;
}

// ── Semana ───────────────────────────────────────────────────────────────────

export type OccupancySlot = { startMin: number; total: number; byPractitioner: Record<string, number> };
export type DayOccupancy = {
  dayKey: DayKey;
  /** Turnos del día que sostienen cupo (distintos). */
  total: number;
  byPractitioner: Record<string, number>;
  slots: OccupancySlot[];
};

/**
 * Ocupación de la vista Semana: por día y por fila de la grilla, cuántos
 * turnos que sostienen cupo (regla 2) TOCAN la celda, por profesional y en
 * total. A diferencia de `used` de la celda (pico de simultaneidad) es un
 * conteo: en la semana interesa "cuántos turnos hay a esta hora", no el cupo.
 * Todos los ids pedidos aparecen, con 0 si no tienen turnos.
 */
export function weekOccupancy(input: {
  days: ReadonlyArray<DayKey>;
  practitionerIds: ReadonlyArray<string>;
  bookings: ReadonlyArray<LayoutBooking>;
  zoom: AgendaZoom;
  window: MinuteWindow;
  now: Date;
}): DayOccupancy[] {
  const zoom = normalizeZoom(input.zoom);
  const ids = new Set(input.practitionerIds);
  const zeros = () => Object.fromEntries(input.practitionerIds.map((id) => [id, 0])) as Record<string, number>;
  const rows = rowsOf(input.window, zoom);
  const holding = input.bookings.filter((b) => ids.has(b.practitionerId) && holdsCapacity(b, input.now));

  return input.days.map((dayKey) => {
    const spans = holding
      .filter((b) => touchesDay(dayKey, b))
      .map((b) => ({ pid: b.practitionerId, ...bookingSpan(dayKey, b) }));
    const byPractitioner = zeros();
    for (const s of spans) byPractitioner[s.pid] += 1;
    const slots = rows.map(({ startMin, endMin }) => {
      const per = zeros();
      let total = 0;
      for (const s of spans) {
        if (s.start < endMin && s.end > startMin) {
          per[s.pid] += 1;
          total += 1;
        }
      }
      return { startMin, total, byPractitioner: per };
    });
    return { dayKey, total: spans.length, byPractitioner, slots };
  });
}

// ── Línea de "ahora" ─────────────────────────────────────────────────────────

/**
 * Posición de la línea de "ahora": null si `now` no es del día AR `dayKey` o
 * cae fuera de la ventana. `minute` = minuto de pared AR (entero), `offsetMin`
 * desde el inicio de la ventana y `ratio` 0..1 para posicionar en %.
 */
export function nowOffset(
  dayKey: DayKey,
  now: Date,
  window: MinuteWindow
): { minute: number; offsetMin: number; ratio: number } | null {
  if (dayKeyOf(now) !== dayKey) return null;
  const minute = Math.floor(minuteInDay(dayKey, now));
  if (minute < window.startMin || minute > window.endMin) return null;
  const span = window.endMin - window.startMin;
  const offsetMin = minute - window.startMin;
  return { minute, offsetMin, ratio: span > 0 ? offsetMin / span : 0 };
}
