/**
 * Estado puro de la pantalla de agenda (B4.3 AG-integrate, B-pre).
 *
 * Todo lo que `components/agenda/agenda-client.tsx` decide y se puede probar
 * sin React: qué vista se muestra, cómo se navega entre días/semanas, qué
 * turnos entran por filtro de profesional y de sede, el candado agregado de un
 * día, el alcance por defecto del diálogo de candado y los badges de las
 * cards. Client-safe: sin Prisma, sin `server-only`, sin reloj propio (el
 * `now` lo pasa el caller).
 *
 * Fechas: todo sobre `DayKey` AR ("YYYY-MM-DD") con `lib/availability/day.ts`.
 * Antes `navigate()` hacía `setDate(getDate() + n)` sobre un `Date` del host
 * (hallazgo de B1.5b): en un host UTC el instante "medianoche AR" es 03:00 UTC
 * y funcionaba de casualidad; cualquier cambio de ancla (p. ej. un ancla a
 * las 22:00 AR = 01:00 UTC del día siguiente) corría el día. Con DayKeys la
 * aritmética es de calendario y no depende de la TZ del host.
 */
import { addDays, dayKeyDiff, dayKeyOf, dayWindow, dowOfDayKey, isDayKey } from "@/lib/availability/day";
import type { DayKey, DayLockState } from "@/lib/availability/types";
import { canManageBlocksFor, CAPABILITIES, type Capability } from "@/lib/capabilities";
import type { AgendaMode } from "@/lib/preferences-constants";
import { receptionState, waitingMinutes, type ReceptionBooking } from "@/lib/reception-state";
import type { RoomOption } from "@/lib/rooms-types";
import type { RealtimeAgendaMessage } from "@/lib/realtime-events";

// ─────────────────────────────────────────────────────────────────────────────
// Vista
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Vista de la agenda (parámetro `view` de la URL).
 * - `timeline` (Día), `week` (Semana), `list` (Lista): las de siempre.
 * - `practitioner`: Día por profesional (columnas). Es el "modo" Por
 *   profesional de `agendaPrefs.mode`, que solo aplica al Día.
 * - `reception`: Recepción del día (lista operativa de todos).
 * - `room` (SR-U3): Día por sala (columnas = salas de la sede). Es el modo
 *   "Por sala"; solo existe si hay al menos una sala activa en el alcance.
 * - `month` (CF2, D-CF2-7): Mes v1, grilla lunes-domingo con cantidad de turnos y
 *   estado del día por celda (clic → Día). No depende del modo ni de la cantidad
 *   de profesionales: con uno solo también tiene sentido.
 */
export type AgendaView = "timeline" | "week" | "list" | "practitioner" | "reception" | "room" | "month";
export const AGENDA_VIEWS: ReadonlyArray<AgendaView> = [
  "timeline",
  "week",
  "list",
  "practitioner",
  "reception",
  "room",
  "month",
];

export type ViewContext = {
  /** `agendaPrefs.mode` del usuario (cómo prefiere ver el Día). */
  mode: AgendaMode;
  /** Profesionales del consultorio (no los filtrados). */
  practitionerCount: number;
  /** `agenda.reception`. */
  canReception: boolean;
  /**
   * Salas activas en el alcance (`roomsInScope(...).length`). "room" es válido
   * solo con ≥1. Opcional a propósito: ausente = 0 = la agenda de antes de SR
   * (los callers que todavía no lo pasan no cambian de comportamiento).
   */
  roomCount?: number;
};

/** ¿El consultorio tiene más de un profesional? Con uno, la agenda se ve como siempre. */
export function isMultiPractitioner(practitionerCount: number): boolean {
  return practitionerCount > 1;
}

/** ¿Hay salas para armar el Día "Por sala"? (SR-U3) */
export function hasRooms(roomCount: number | undefined): boolean {
  return (roomCount ?? 0) >= 1;
}

/**
 * El "Día" que corresponde al modo guardado. Con un solo profesional, siempre
 * el de siempre; "Por sala" sin salas en el alcance (las archivaron, o se
 * cambió a una sede sin salas), también.
 */
export function dayViewFor(
  mode: AgendaMode,
  practitionerCount: number,
  roomCount = 0
): "timeline" | "practitioner" | "room" {
  if (mode === "room") return hasRooms(roomCount) ? "room" : "timeline";
  return mode === "practitioner" && isMultiPractitioner(practitionerCount) ? "practitioner" : "timeline";
}

/**
 * Modos que ofrece el toggle, en orden: "Por día" siempre; "Por profesional"
 * con varios profesionales; "Por sala" con ≥1 sala en el alcance. Con uno solo
 * no hay toggle.
 */
export function availableAgendaModes(practitionerCount: number, roomCount = 0): AgendaMode[] {
  const out: AgendaMode[] = ["day"];
  if (isMultiPractitioner(practitionerCount)) out.push("practitioner");
  if (hasRooms(roomCount)) out.push("room");
  return out;
}

/**
 * Vista efectiva a partir del `?view=` de la URL. Sin parámetro (o uno
 * desconocido) → el Día del modo guardado. Una vista que no aplica (Por
 * profesional con un solo profesional, Recepción sin la capability) cae al
 * Día de siempre: un link viejo o compartido nunca deja la pantalla vacía.
 */
export function resolveAgendaView(raw: string | null | undefined, ctx: ViewContext): AgendaView {
  const fallback = dayViewFor(ctx.mode, ctx.practitionerCount, ctx.roomCount);
  if (!raw || !(AGENDA_VIEWS as ReadonlyArray<string>).includes(raw)) return fallback;
  const v = raw as AgendaView;
  if (v === "practitioner" && !isMultiPractitioner(ctx.practitionerCount)) return "timeline";
  if (v === "room" && !hasRooms(ctx.roomCount)) return "timeline";
  if (v === "reception" && !ctx.canReception) return fallback;
  return v;
}

/** Vistas de UN día (el título y el candado del día hablan de ese día). Semana y Mes no. */
export function isDayScoped(v: AgendaView): boolean {
  return v !== "week" && v !== "month";
}

/** Segmento activo del selector Día / Semana / Mes / Lista / Recepción. */
export type ViewSegment = "day" | "week" | "month" | "list" | "reception";
export function segmentOf(v: AgendaView): ViewSegment {
  if (v === "timeline" || v === "practitioner" || v === "room") return "day";
  return v;
}

/** Vista a la que lleva un segmento: "Día" respeta el modo guardado. */
export function viewForSegment(
  seg: ViewSegment,
  ctx: Pick<ViewContext, "mode" | "practitionerCount" | "roomCount">
): AgendaView {
  if (seg === "day") return dayViewFor(ctx.mode, ctx.practitionerCount, ctx.roomCount);
  return seg;
}

/**
 * El toggle de modo solo tiene sentido en el Día y con más de un modo posible
 * (varios profesionales, o al menos una sala). Sin salas = la regla de B4.2.
 */
export function showModeToggle(v: AgendaView, practitionerCount: number, roomCount = 0): boolean {
  return segmentOf(v) === "day" && availableAgendaModes(practitionerCount, roomCount).length > 1;
}

/**
 * Radiogroup (WAI-ARIA): a qué valor llevan las flechas, con vuelta. Home/End
 * van al primero/último. Si el valor actual no está en la lista (un modo
 * guardado que ya no aplica), adelante = el primero y atrás = el último. Otra
 * tecla → null (el caller no hace nada). Lo usan `ModeToggle` y `RoomFilter`.
 */
export function nextRadioValue<T>(values: ReadonlyArray<T>, current: T, key: string): T | null {
  const n = values.length;
  if (n === 0) return null;
  if (key === "Home") return values[0];
  if (key === "End") return values[n - 1];
  const i = values.indexOf(current);
  if (key === "ArrowRight" || key === "ArrowDown") return values[i < 0 ? 0 : (i + 1) % n];
  if (key === "ArrowLeft" || key === "ArrowUp") return values[i < 0 ? n - 1 : (i - 1 + n) % n];
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Navegación (DayKeys AR, sin `setDate` del host)
// ─────────────────────────────────────────────────────────────────────────────

/** `?date=` válido o el fallback (hoy AR). */
export function parseDayKeyParam(raw: string | null | undefined, fallback: DayKey): DayKey {
  return raw && isDayKey(raw) ? raw : fallback;
}

/** Lunes (AR) de la semana del día. */
export function weekStartKey(dayKey: DayKey): DayKey {
  const sinceMonday = (dowOfDayKey(dayKey) + 6) % 7;
  return addDays(dayKey, -sinceMonday);
}

/** Los 7 días lun-dom de la semana que empieza en `monday`. */
export function weekDayKeys(monday: DayKey): DayKey[] {
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/** Ancla movida `delta` días de calendario. */
export function shiftDayKey(dayKey: DayKey, delta: number): DayKey {
  return addDays(dayKey, delta);
}

// CF2 (D-CF2-7) · Mes. Aritmética de calendario sobre "YYYY-MM-DD" con `Date.UTC` (etiquetas sin hora, como
// `addDays`): no depende de la TZ del host. Lo prueba `tests/unit/cf2-agenda-state.test.ts` en TZ=UTC y AR.

/** Días del mes `m` (1-12) del año `y`. `Date.UTC(y, m, 0)` = el día 0 del mes siguiente = el último de `m`. */
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Grilla del Mes: de lunes a domingo, las semanas que cubren el mes de `dayKey`. Un mes de 28 días que arranca en
 * lunes da 4; uno de 31 que arranca en sábado o domingo, 6 (el máximo = `AGENDA_MONTH_MAX_DAYS` = 42 del server).
 * `monthKey` = "YYYY-MM" (el título y la clave del refetch).
 */
export function monthGridRange(dayKey: DayKey): { monthKey: string; from: DayKey; to: DayKey; weeks: 4 | 5 | 6 } {
  const monthKey = dayKey.slice(0, 7);
  const last = daysInMonth(Number(dayKey.slice(0, 4)), Number(dayKey.slice(5, 7)));
  const from = weekStartKey(`${monthKey}-01`);
  const to = addDays(weekStartKey(`${monthKey}-${pad2(last)}`), 6);
  const weeks = (dayKeyDiff(from, to) + 1) / 7;
  return { monthKey, from, to, weeks: weeks as 4 | 5 | 6 };
}

/**
 * Ancla movida `delta` meses (toolbar «Mes anterior» / «Mes siguiente»). El día se acota al último del mes de
 * destino: 31-ene +1 → 28-feb (29 en bisiesto). Sin el clamp, `Date.UTC(2027, 1, 31)` desborda a 3-mar y el «Mes
 * siguiente» saltearía febrero.
 */
export function shiftMonthDay(dayKey: DayKey, delta: number): DayKey {
  const y = Number(dayKey.slice(0, 4));
  const m0 = Number(dayKey.slice(5, 7)) - 1 + delta;
  const ny = y + Math.floor(m0 / 12);
  const nm = (((m0 % 12) + 12) % 12) + 1;
  const d = Math.min(Number(dayKey.slice(8, 10)), daysInMonth(ny, nm));
  return `${ny}-${pad2(nm)}-${pad2(d)}`;
}

/** Ids del parámetro `?pros=a,b` (o el `?practitioner=` viejo) que existen en el consultorio. */
export function parseSelectedPractitioners(
  params: { pros?: string | null; practitioner?: string | null },
  validIds: ReadonlyArray<string>
): string[] {
  const raw = params.pros ? params.pros.split(",") : params.practitioner ? [params.practitioner] : [];
  const out: string[] = [];
  for (const id of raw.map((s) => s.trim())) {
    if (id && validIds.includes(id) && !out.includes(id)) out.push(id);
  }
  // Todos marcados = "Todos" (mismo criterio que `nextSelection`).
  return out.length === validIds.length ? [] : out;
}

// ─────────────────────────────────────────────────────────────────────────────
// CF2 (D-CF2-1, D-CF2-2) · Selección recordada y título de alcance
// ─────────────────────────────────────────────────────────────────────────────

/** De dónde salió la selección inicial: `agenda-client` agrega `?pros=` una vez si no vino de la URL. */
export type SelectionSource = "url" | "saved" | "default";

/** Ids válidos sin repetir, en el orden dado; los desconocidos (archivados, de otro consultorio) se descartan. */
function validUnique(raw: ReadonlyArray<string>, validIds: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  for (const id of raw.map((s) => s.trim())) {
    if (id && validIds.includes(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Selección de profesionales al abrir la agenda (D-CF2-1). Prioridad:
 * 1. `?pros=` con al menos un id válido; si no, el `?practitioner=` legado (un link compartido manda);
 * 2. la guardada (`agendaPrefs.selectedPractitionerIds`) filtrada a los válidos. `[]` guardado = eligió «Todos» y se
 *    respeta; una guardada con TODOS los ids inválidos (los profesionales ya no están) cuenta como «nunca eligió»;
 * 3. el rol: un profesional en un consultorio con varios ve su agenda (`[own]`); la Secretaria y el resto, Todos.
 * Una selección que cubre a todos colapsa a `[]`, la misma regla que `parseSelectedPractitioners`: así la URL no
 * arrastra la lista completa y un profesional nuevo aparece sin tocar nada.
 */
export function initialPractitionerSelection(p: {
  url: { pros?: string | null; practitioner?: string | null };
  saved: ReadonlyArray<string> | undefined;
  ownPractitionerId: string | null;
  validIds: ReadonlyArray<string>;
}): { ids: string[]; source: SelectionSource } {
  const collapse = (ids: string[]) => (ids.length === p.validIds.length ? [] : ids);
  const fromPros = p.url.pros ? validUnique(p.url.pros.split(","), p.validIds) : [];
  if (fromPros.length > 0) return { ids: collapse(fromPros), source: "url" };
  const fromLegacy = p.url.practitioner ? validUnique([p.url.practitioner], p.validIds) : [];
  if (fromLegacy.length > 0) return { ids: collapse(fromLegacy), source: "url" };
  if (p.saved) {
    if (p.saved.length === 0) return { ids: [], source: "saved" };
    const fromSaved = validUnique(p.saved, p.validIds);
    if (fromSaved.length > 0) return { ids: collapse(fromSaved), source: "saved" };
  }
  const own = p.ownPractitionerId;
  if (own && p.validIds.includes(own) && isMultiPractitioner(p.validIds.length)) {
    return { ids: [own], source: "default" };
  }
  return { ids: [], source: "default" };
}

/** Título de alcance del encabezado (D-CF2-2). `people` = los profesionales en alcance, en el orden de la agenda. */
export type ScopeHeading = {
  kind: "one" | "some" | "all" | "room";
  title: string;
  people: ReadonlyArray<{ id: string; name: string; initials: string }>;
};

/** «Laura P.»: primer nombre + inicial del último apellido. Un nombre de una sola palabra queda como está. */
function shortName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts[0] ?? name;
  return `${parts[0]} ${parts[parts.length - 1].charAt(0).toUpperCase()}.`;
}

/**
 * Qué agenda se está mirando, como título (D-CF2-2): «Tu agenda · Laura Pérez», «Agenda de Laura Pérez», «Agenda de
 * Laura Pérez y Martín Gómez», «3 profesionales: Laura P., Martín G., Ana R.», «Todos los profesionales (5)». «Por
 * sala» ignora la selección (las columnas son salas, se ven todos) sin pisarla. Con un solo profesional devuelve
 * `null`: el encabezado queda como siempre (la fecha como título). Los ids seleccionados que no están en `ordered` se
 * ignoran; si no queda ninguno, es «Todos».
 */
export function scopeHeadingOf(p: {
  view: AgendaView;
  selectedIds: ReadonlyArray<string>;
  ordered: ReadonlyArray<{ id: string; name: string; initials: string }>;
  ownPractitionerId: string | null;
}): ScopeHeading | null {
  const all = p.ordered;
  if (!isMultiPractitioner(all.length)) return null;
  if (p.view === "room") return { kind: "room", title: "Por sala · todos los profesionales", people: all };
  const picked = all.filter((x) => p.selectedIds.includes(x.id));
  if (picked.length === 0 || picked.length === all.length) {
    return { kind: "all", title: `Todos los profesionales (${all.length})`, people: all };
  }
  if (picked.length === 1) {
    const [one] = picked;
    const title = one.id === p.ownPractitionerId ? `Tu agenda · ${one.name}` : `Agenda de ${one.name}`;
    return { kind: "one", title, people: picked };
  }
  if (picked.length === 2) {
    return { kind: "some", title: `Agenda de ${picked[0].name} y ${picked[1].name}`, people: picked };
  }
  return {
    kind: "some",
    title: `${picked.length} profesionales: ${picked.map((x) => shortName(x.name)).join(", ")}`,
    people: picked,
  };
}

/**
 * URL de la agenda. `pros` solo si hay selección (vacía = todos). El filtro de
 * profesionales viaja en la URL para que un refresh o un link conserven la
 * vista de la secretaria; la sede vive en `agendaPrefs`.
 */
export function agendaHref(p: {
  view: AgendaView;
  dayKey: DayKey;
  selectedIds?: ReadonlyArray<string>;
  /** [AS-2o] filtro de obra social ya efectivo (`effectiveInsurerFilter`); null/ausente = sin `?os=`. */
  insurerKey?: string | null;
}): string {
  const sp = new URLSearchParams({ view: p.view, date: p.dayKey });
  if (p.selectedIds && p.selectedIds.length > 0) sp.set("pros", p.selectedIds.join(","));
  // [AS-2o] Como `pros`: el filtro de obra social viaja en la URL para que navegar de día/semana, un refresh o un
  // link lo conserven (antes `go()` armaba la URL de cero y lo perdía).
  if (p.insurerKey) sp.set("os", p.insurerKey);
  return `/agenda?${sp.toString()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Filtros (profesional + sede), del lado del cliente
//
// S19b (ES3, enmienda del 08-oct, plan §16.2): "el modelo de filtros de la
// agenda tiene que ser extensible: un objeto de filtros con profesionales,
// sede y, en el futuro, sala. SR le va a sumar la sala sin rehacerlo."
//
// Antes cada filtro era un argumento suelto y `agenda-client` encadenaba dos
// `filterAgendaBookings` (uno para la sede, otro para los chips). Ahora hay un
// objeto `AgendaFilters` y una tabla de dimensiones: cada dimensión sabe si
// está activa y si un turno pasa. Para sumar la sala, SR agrega
//   1. `roomId: string | null` a `AgendaFilters` (+ `EMPTY_AGENDA_FILTERS`),
//   2. `roomId?: string | null` a `AgendaFilterable`,
//   3. una entrada en `AGENDA_FILTER_DIMENSIONS`,
// y el `satisfies` de abajo no compila hasta que la tabla tenga la clave nueva.
// `applyAgendaFilters`, el conteo de los chips (`except`) y el aviso de "hay
// filtros" (`activeAgendaFilterKeys`) no se tocan.
//
// Estos filtros SACAN turnos. El resaltado (servicio, plan/suelto: leyendas,
// `lib/agenda-highlight.ts`) no es un filtro: atenúa y no oculta, y por eso no
// vive acá. Dónde persiste cada uno: profesionales en la URL (`?pros=`, un
// link conserva la vista de la secretaria), sede en `agendaPrefs.locationId`
// (server, por usuario); la sala decide el suyo en SR.
//
// SR-U3: la sala persiste en `agendaPrefs.roomId` (D2: se limpia al cambiar de
// sede). `roomId` es opcional en `AgendaFilters` para que un objeto armado
// antes de SR (`{ practitionerIds, locationId }`) siga compilando y siga
// significando "todas las salas".
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lo mínimo del turno que miran los filtros (lo cumple `BookingDTO`).
 * `roomId`: undefined = "no sé" (proyección sin sala) → ningún filtro de sala
 * lo esconde; null = sin sala.
 */
export type AgendaFilterable = {
  practitionerId: string;
  locationId?: string | null;
  roomId?: string | null;
  /**
   * [AS-2o] Cobertura (`BookingDTO.insurerKey`): id del catálogo o "particular"; `null` = el actor no la ve (nunca
   * matchea un filtro activo); `undefined` = no se sabe (nunca se esconde).
   */
  insurerKey?: string | null;
};
type Filterable = AgendaFilterable;

/** Filtros que sacan turnos de la agenda. Vacío/null en cada clave = sin filtrar. */
export type AgendaFilters = {
  /** Profesionales elegidos (`?pros=`); vacío = todos. */
  practitionerIds: ReadonlyArray<string>;
  /** Sede (`agendaPrefs.locationId`); null = todas. */
  locationId: string | null;
  /**
   * Sala (`agendaPrefs.roomId`, ya pasada por `effectiveRoomFilter`): un id,
   * `ROOM_FILTER_NONE` (= "Sin sala") o null/ausente = todas.
   */
  roomId?: string | null;
  /**
   * [AS-2o] Obra social (`?os=`, ya pasada por `effectiveInsurerFilter`): un id del catálogo,
   * `INSURER_FILTER_PARTICULAR` o null/ausente = todas. Opcional como `roomId`: un objeto armado antes de T3e sigue
   * significando «todas».
   */
  insurerKey?: string | null;
};

export type AgendaFilterKey = keyof AgendaFilters;

/** Valor del filtro de sala para "Sin sala" (mismo que `AgendaBookingsQuery.roomId`). */
export const ROOM_FILTER_NONE = "none";

/** [AS-2o] Valor del filtro de obra social para «Particular» (mismo literal que `BookingDTO.insurerKey`). */
export const INSURER_FILTER_PARTICULAR = "particular";

export const EMPTY_AGENDA_FILTERS: AgendaFilters = { practitionerIds: [], locationId: null, roomId: null, insurerKey: null };

/** Datos del consultorio que necesitan las dimensiones (no son filtros). */
export type AgendaFilterContext = { primaryLocationId: string | null };

type AgendaFilterDimension<K extends AgendaFilterKey> = {
  isActive: (value: AgendaFilters[K]) => boolean;
  matches: (b: AgendaFilterable, value: AgendaFilters[K], ctx: AgendaFilterContext) => boolean;
};

/**
 * ¿El turno es de la sede filtrada? `locationId` null en el turno = sede
 * principal (contrato de M-agenda). Sin el campo (proyección vieja) no se
 * descarta: no se esconde un turno por no saber dónde es.
 */
export function matchesLocation(
  b: Pick<Filterable, "locationId">,
  locationId: string | null,
  primaryLocationId: string | null
): boolean {
  if (!locationId) return true;
  if (b.locationId === undefined) return true;
  return (b.locationId ?? primaryLocationId) === locationId;
}

/** Una entrada por clave de `AgendaFilters` (el `satisfies` obliga a no olvidarse ninguna). */
export const AGENDA_FILTER_DIMENSIONS = {
  practitionerIds: {
    isActive: (ids) => ids.length > 0,
    matches: (b, ids) => ids.includes(b.practitionerId),
  },
  locationId: {
    isActive: (id) => id != null,
    matches: (b, id, ctx) => matchesLocation(b, id, ctx.primaryLocationId),
  },
  // SR-U3, contrato literal: sin el campo (undefined) no se esconde; "none" = sin sala.
  roomId: {
    isActive: (id) => id != null,
    matches: (b, id) => b.roomId === undefined || (id === ROOM_FILTER_NONE ? b.roomId === null : b.roomId === id),
  },
  // [AS-2o] Regla segura (plan §23.9): `undefined` (el server no la mandó) no se esconde, como la sala y la sede.
  // `null` es «no tenés acceso a la cobertura de este paciente» (acceso `basic`): NUNCA matchea, ni siquiera
  // «Particular» (en la fila basic `obraSocial` dice «Particular» por defecto, y mostrarlo como particular afirmaría
  // algo que el actor no sabe). Con filtro activo esas filas se ocultan y se cuentan (`countInsurerAccessHidden`).
  insurerKey: {
    isActive: (k) => k != null,
    matches: (b, k) => b.insurerKey === undefined || (b.insurerKey !== null && b.insurerKey === k),
  },
} satisfies { [K in AgendaFilterKey]: AgendaFilterDimension<K> };

const FILTER_KEYS = Object.keys(AGENDA_FILTER_DIMENSIONS) as AgendaFilterKey[];

function isFilterActive<K extends AgendaFilterKey>(key: K, filters: AgendaFilters): boolean {
  return (AGENDA_FILTER_DIMENSIONS[key] as AgendaFilterDimension<K>).isActive(filters[key]);
}

function dimensionMatches<K extends AgendaFilterKey>(
  key: K,
  b: AgendaFilterable,
  filters: AgendaFilters,
  ctx: AgendaFilterContext
): boolean {
  return (AGENDA_FILTER_DIMENSIONS[key] as AgendaFilterDimension<K>).matches(b, filters[key], ctx);
}

/** Claves con un filtro puesto. */
export function activeAgendaFilterKeys(filters: AgendaFilters): AgendaFilterKey[] {
  return FILTER_KEYS.filter((k) => isFilterActive(k, filters));
}

/**
 * Turnos que pasan TODOS los filtros activos. `except` saltea dimensiones:
 * los chips de profesionales cuentan con `except: ["practitionerIds"]` (todos
 * los profesionales, en la sede elegida; con sala, también en la sala).
 */
export function applyAgendaFilters<T extends AgendaFilterable>(
  bookings: ReadonlyArray<T>,
  filters: AgendaFilters,
  ctx: AgendaFilterContext,
  opts: { except?: ReadonlyArray<AgendaFilterKey> } = {}
): T[] {
  const keys = activeAgendaFilterKeys(filters).filter((k) => !opts.except?.includes(k));
  if (keys.length === 0) return [...bookings];
  return bookings.filter((b) => keys.every((k) => dimensionMatches(k, b, filters, ctx)));
}

/**
 * Turnos de los profesionales elegidos (vacío = todos) y de la sede elegida
 * (null = todas). Firma de B-pre: se mantiene para los callers y tests de
 * antes; por dentro es `applyAgendaFilters`.
 */
export function filterAgendaBookings<T extends Filterable>(
  bookings: ReadonlyArray<T>,
  f: { selectedIds: ReadonlyArray<string>; locationId: string | null; primaryLocationId: string | null }
): T[] {
  return applyAgendaFilters(
    bookings,
    { practitionerIds: f.selectedIds, locationId: f.locationId },
    { primaryLocationId: f.primaryLocationId }
  );
}

/**
 * Turnos del server con los cambios optimistas encima (Recepción y drawer
 * avisan la fila nueva antes del `router.refresh()`). `normalize` pasa la fila
 * de la action por lo mismo que la del server (`expandPlanFields`): sin eso un
 * turno suelto pierde `programId: null` y "Fuera de plan"/el resaltado de plan
 * se apagan hasta el refresh (handoff de S19a, ES3). Sin overrides devuelve el
 * mismo array (no rompe los `useMemo` de abajo).
 */
export function mergeBookingOverrides<T extends { id: string }, O extends { id: string } = T>(
  server: ReadonlyArray<T>,
  overrides: Readonly<Record<string, O>>,
  normalize: (o: O) => T
): ReadonlyArray<T> {
  if (Object.keys(overrides).length === 0) return server;
  return server.map((b) => {
    const o = overrides[b.id];
    // SV09: con la agenda en vivo, la fila del server puede llegar MÁS NUEVA
    // que el override (otra sesión tocó el turno después de mi acción, o la
    // action devolvió "cambió en otra sesión" con la fila vieja). Ahí manda el
    // server. Misma versión o sin `updatedAt` legible: el override, como antes.
    return o && !isNewerVersion(b, o) ? normalize(o) : b;
  });
}

/** ¿`a` es una versión estrictamente posterior a `b`? (`updatedAt` ISO; ilegible = no). */
function isNewerVersion(a: object, b: object): boolean {
  const ta = Date.parse(String((a as { updatedAt?: unknown }).updatedAt ?? ""));
  const tb = Date.parse(String((b as { updatedAt?: unknown }).updatedAt ?? ""));
  return Number.isFinite(ta) && Number.isFinite(tb) && ta > tb;
}

/**
 * SV09: overrides optimistas que el server ya superó (su `updatedAt` es más
 * nuevo). Sin podar, `overrides` solo se vaciaba al cambiar `props.bookings`;
 * con el refetch en vivo la lista cambia SIN eso y el mapa crecería con filas
 * muertas. Una fila ausente o de la misma versión se queda (el refetch pudo
 * salir antes que mi acción). Sin cambios devuelve EL MISMO objeto: el caller
 * lo usa en un `setState` y una identidad nueva sería un render de más.
 */
export function pruneBookingOverrides<O extends { id: string }>(
  overrides: Readonly<Record<string, O>>,
  rows: ReadonlyArray<{ id: string; updatedAt?: string }>
): Readonly<Record<string, O>> {
  const keys = Object.keys(overrides);
  if (keys.length === 0) return overrides;
  const byId = new Map(rows.map((r) => [r.id, r]));
  let out: Record<string, O> | null = null;
  for (const k of keys) {
    const row = byId.get(k);
    if (row && isNewerVersion(row, overrides[k])) {
      out ??= { ...overrides };
      delete out[k];
    }
  }
  return out ?? overrides;
}

/** Profesionales visibles en orden (vacío = todos). */
export function visiblePractitioners<P extends { id: string }>(
  ordered: ReadonlyArray<P>,
  selectedIds: ReadonlyArray<string>
): P[] {
  if (selectedIds.length === 0) return [...ordered];
  return ordered.filter((p) => selectedIds.includes(p.id));
}

/** Conteo por profesional para los chips (turnos que no están cancelados). */
export function countByPractitioner(
  bookings: ReadonlyArray<{ practitionerId: string; status: string }>
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of bookings) {
    if (b.status === "CANCELLED") continue;
    out[b.practitionerId] = (out[b.practitionerId] ?? 0) + 1;
  }
  return out;
}

/**
 * Conteo por sala para el `RoomFilter` (sin cancelados). `null` → "none" (Sin
 * sala); sin el campo no cuenta (no se sabe dónde es). Pasarle los turnos con
 * `applyAgendaFilters(..., { except: ["roomId"] })`.
 */
export function countByRoom(
  bookings: ReadonlyArray<{ roomId?: string | null; status: string }>
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of bookings) {
    if (b.status === "CANCELLED" || b.roomId === undefined) continue;
    const k = b.roomId ?? ROOM_FILTER_NONE;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Obra social (T3e-2o, plan §23.9)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ¿Se ofrece el filtro de obra social? Con ≥1 obra social que no sea Particular (el catálogo de la página ya viene
 * sin Particular: `loadAgendaBootstrapInTx`; `isParticular` se mira igual por si un caller manda el catálogo entero).
 * Sin obras sociales, filtrar por «Particular» sacaría solo los turnos sin acceso: no aporta.
 */
export function showInsurerFilter(insurers: ReadonlyArray<{ id: string; isParticular?: boolean }>): boolean {
  return insurers.some((i) => !i.isParticular);
}

/** `?os=` → id del catálogo o "particular"; cualquier otra cosa (id ajeno, archivado, vacío) → null. */
export function parseInsurerFilterParam(
  raw: string | null | undefined,
  insurers: ReadonlyArray<{ id: string; isParticular?: boolean }>
): string | null {
  if (!raw) return null;
  if (raw === INSURER_FILTER_PARTICULAR) return raw;
  return insurers.some((i) => i.id === raw && !i.isParticular) ? raw : null;
}

/**
 * Filtro de obra social que efectivamente se aplica: el de la URL si el select se muestra; si no, ninguno (mismo
 * criterio que `effectiveRoomFilter`: nunca se esconde un turno por un filtro que no se ve en pantalla).
 */
export function effectiveInsurerFilter(
  raw: string | null | undefined,
  insurers: ReadonlyArray<{ id: string; isParticular?: boolean }>
): string | null {
  return showInsurerFilter(insurers) ? parseInsurerFilterParam(raw, insurers) : null;
}

/**
 * Turnos que el filtro de obra social oculta porque el actor no ve su cobertura (`insurerKey === null`). Pasarle la
 * base con los demás filtros y la visibilidad («Mostrar cancelados/ausentes») ya aplicados, en el alcance de la
 * vista: así cuenta exactamente lo que se vería sin este filtro (un cancelado oculto por la visibilidad no suma).
 * Sin filtro, 0: un `null` sin filtro se ve como siempre.
 */
export function countInsurerAccessHidden(
  bookings: ReadonlyArray<{ insurerKey?: string | null }>,
  insurerKey: string | null
): number {
  if (insurerKey == null) return 0;
  let n = 0;
  for (const b of bookings) if (b.insurerKey === null) n++;
  return n;
}

/**
 * Copy del aviso (plan §23.9); 0 → null (no se dibuja). T3-Z (B8): «turno sin acceso a la cobertura» se leía
 * como un turno sin cobertura; quien no tiene acceso es el usuario, así que se dice primero qué pasa y después
 * por qué.
 */
export function insurerAccessHiddenLabel(n: number): string | null {
  if (n <= 0) return null;
  return n === 1
    ? "1 turno no se muestra con este filtro: no tenés acceso a su cobertura."
    : `${n} turnos no se muestran con este filtro: no tenés acceso a su cobertura.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Salas (SR-U3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Salas del alcance de la agenda: las de la sede filtrada; con "Todas las
 * sedes", las de la sede principal (D4: la vista "Por sala" usa la principal y
 * lo dice). Sin sede principal conocida, todas. Conserva el orden del catálogo
 * (`listRoomOptions`: por sede y `sortOrder`). `rooms` ya son solo activas.
 */
export function roomsInScope<R extends Pick<RoomOption, "locationId">>(
  rooms: ReadonlyArray<R>,
  locationId: string | null,
  primaryLocationId: string | null
): R[] {
  const scope = locationId ?? primaryLocationId;
  if (!scope) return [...rooms];
  return rooms.filter((r) => r.locationId === scope);
}

/**
 * Filtro de sala que efectivamente se aplica, a partir de `agendaPrefs.roomId`
 * y las salas del alcance (D3: el filtro existe solo con ≥2 salas en la sede).
 * Una sala ajena, archivada o de otra sede → null (= todas): nunca se esconde
 * un turno por un filtro que no se ve en pantalla.
 */
export function effectiveRoomFilter(
  roomId: string | null | undefined,
  scopeRooms: ReadonlyArray<Pick<RoomOption, "id">>
): string | null {
  if (!roomId || scopeRooms.length < 2) return null;
  if (roomId === ROOM_FILTER_NONE) return ROOM_FILTER_NONE;
  return scopeRooms.some((r) => r.id === roomId) ? roomId : null;
}

/**
 * ¿La tarjeta muestra la sala ("· Consultorio 2")? Solo si en pantalla puede
 * haber ≥2 salas distintas y la vista no es "Por sala" (ahí la columna ya lo
 * dice). Filtrado a una sala o a "Sin sala", todas dirían lo mismo: no.
 * `roomCount` = salas que pueden aparecer en pantalla (con "Todas las sedes",
 * las del consultorio; con una sede, las de esa sede). Densidad (riesgo del
 * relevamiento): la agenda de la Secretaria no suma texto que no distingue.
 */
export function showRoomOnCards(p: { view: AgendaView; roomCount: number; roomFilter: string | null }): boolean {
  if (p.view === "room") return false;
  if (p.roomFilter != null) return false;
  return p.roomCount >= 2;
}

/** La disponibilidad cargada, ¿es la de esta semana y esta sede? Si no, hay que pedirla. */
export function availabilityMatches(
  av: { from: string; locationId: string | null } | null | undefined,
  want: { from: DayKey; locationId: string | null }
): boolean {
  return !!av && av.from === want.from && (av.locationId ?? null) === (want.locationId ?? null);
}

// ─────────────────────────────────────────────────────────────────────────────
// Candado del día
// ─────────────────────────────────────────────────────────────────────────────

/** Candado de un día visto por varios profesionales. `off` = nadie atiende ese día. */
export type AggregatedDayLock = {
  status: "open" | "partial" | "locked" | "off";
  detail: string | null;
  blockIds: string[];
};

/**
 * Candado agregado de un día sobre los profesionales visibles (header de Día
 * y de cada día de la Semana). Los que no atienden ese día ("sin-franjas") no
 * cuentan: si un osteópata no trabaja los martes, el martes del kinesiólogo
 * sigue "abierto". Todos los que atienden bloqueados → `locked`; alguno
 * bloqueado o parcial → `partial`; nadie atiende → `off`.
 */
export function aggregateDayLock(states: ReadonlyArray<DayLockState | null | undefined>): AggregatedDayLock {
  const known = states.filter((s): s is DayLockState => !!s);
  const working = known.filter((s) => !(s.status === "locked" && s.reason === "sin-franjas"));
  const blockIds = Array.from(new Set(working.flatMap((s) => [...s.blockIds])));
  const detail = working.find((s) => s.status !== "open" && s.detail)?.detail ?? null;
  if (known.length > 0 && working.length === 0) return { status: "off", detail: null, blockIds: [] };
  if (working.length === 0) return { status: "open", detail: null, blockIds: [] };
  if (working.every((s) => s.status === "locked")) return { status: "locked", detail, blockIds };
  if (working.some((s) => s.status !== "open")) return { status: "partial", detail, blockIds };
  return { status: "open", detail: null, blockIds: [] };
}

/** Capabilities que llegan del server como array de strings → set tipado (ignora desconocidas). */
export function capabilitySet(caps: ReadonlyArray<string> | null | undefined): ReadonlySet<Capability> {
  const known = new Set<string>(CAPABILITIES);
  return new Set((caps ?? []).filter((c): c is Capability => known.has(c)));
}

/**
 * ¿Puede abrir el candado de un día? Con `agenda.manageBlocks` siempre; con
 * `agenda.manageOwnBlocks` solo si el alcance incluye su propia agenda.
 * `targetIds` null = el día entero (todos los visibles).
 */
export function canOpenDayLock(
  caps: ReadonlySet<Capability>,
  ownPractitionerId: string | null | undefined,
  targetIds: ReadonlyArray<string> | null
): boolean {
  if (caps.has("agenda.manageBlocks")) return true;
  if (!ownPractitionerId || !caps.has("agenda.manageOwnBlocks")) return false;
  return targetIds == null || targetIds.includes(ownPractitionerId);
}

/**
 * Alcance inicial del diálogo de candado (plan §11.3: "por defecto el
 * filtrado; la secretaria puede elegir varios o todos").
 * - Columna de un profesional → ese profesional.
 * - Header de día con "Todos" → null (= todos) si puede bloquear a todos;
 *   si solo puede lo propio, su agenda.
 * - Header de día con chips elegidos → esos (recortado a lo propio si no
 *   puede bloquear ajenos).
 */
export function dayLockInitialScope(p: {
  caps: ReadonlySet<Capability>;
  ownPractitionerId: string | null | undefined;
  selectedIds: ReadonlyArray<string>;
  columnPractitionerId?: string | null;
}): string[] | null {
  const own = p.ownPractitionerId ?? null;
  const allowed = (id: string) => canManageBlocksFor(p.caps, own ?? "", id);
  if (p.columnPractitionerId) return [p.columnPractitionerId];
  if (p.selectedIds.length === 0) {
    if (p.caps.has("agenda.manageBlocks")) return null;
    return own && allowed(own) ? [own] : [];
  }
  return p.selectedIds.filter(allowed);
}

/**
 * Filas (minuto de inicio) bloqueadas para TODOS los profesionales visibles,
 * con el motivo. La vista Día mezcla profesionales: una fila se ve rayada
 * solo si nadie puede atender ahí (si uno sí puede, es una fila normal).
 */
export function blockedRows(
  columns: ReadonlyArray<{ slots: ReadonlyArray<{ startMin: number; blocked: boolean; blockReason: string | null }> }>
): Map<number, string | null> {
  const out = new Map<number, string | null>();
  if (columns.length === 0) return out;
  const n = columns[0].slots.length;
  for (let i = 0; i < n; i++) {
    const cells = columns.map((c) => c.slots[i]).filter(Boolean);
    if (cells.length === columns.length && cells.every((s) => s.blocked)) {
      out.set(cells[0].startMin, cells.find((s) => s.blockReason)?.blockReason ?? null);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cards
// ─────────────────────────────────────────────────────────────────────────────

/** Iniciales en la card solo si hay más de un profesional en pantalla (canal no cromático). */
export function showPractitionerInitials(visiblePractitionerCount: number): boolean {
  return visiblePractitionerCount > 1;
}

/** Más de esto esperando ya no es una espera real (llegada no cerrada): sin minutos. */
export const WAIT_LABEL_MAX_MIN = 600;

/**
 * Estado de recepción para la card: "En sala 12'" o "En atención". El resto
 * (por llegar, demorado, atendido…) ya se lee por el fondo/estado de la card
 * o lo muestra la vista Recepción: no se repite en la grilla.
 */
export function receptionCardBadge(
  b: ReceptionBooking,
  now: Date
): { kind: "en-sala" | "llamado" | "en-atencion"; label: string } | null {
  // [HF-2a] (H-LL2): solo turnos de HOY en día AR. Una llegada de ayer que nadie cerró seguía diciendo «En sala» en
  // la Semana y en la Lista de días anteriores: el estado de recepción es del día, no del turno para siempre (las
  // acciones de recepción ya eran solo de hoy, `TODAY_ONLY` de `lib/reception-state.ts`).
  if (!isTodayAR(b.scheduledFor, now)) return null;
  const state = receptionState(b, now);
  // SV09 (§18.4): el llamado se ve en la grilla — el profesional que llamó y la
  // Secretaria tienen que saber que ya se lo llamó (si no, lo llaman dos veces).
  if (state === "llamado") return { kind: "llamado", label: "Llamado" };
  if (state === "en-sala") {
    const w = waitingMinutes(b, now);
    // Una llegada olvidada de otro día no puede decir "En sala 1440′".
    return { kind: "en-sala", label: w == null || w >= WAIT_LABEL_MAX_MIN ? "En sala" : `En sala ${w}′` };
  }
  if (state === "en-atencion") return { kind: "en-atencion", label: "En atención" };
  return null;
}

/**
 * ¿El turno es de HOY en día AR? Por `dayKeyOf` (pared AR), nunca por el día del host: en Vercel (UTC) un turno de
 * las 23:30 AR es del día siguiente y con `toISOString().slice(0,10)` el latido se apagaba a las 21:00 AR.
 */
export function isTodayAR(scheduledFor: Date | string, now: Date): boolean {
  const d = scheduledFor instanceof Date ? scheduledFor : new Date(scheduledFor);
  return Number.isFinite(d.getTime()) && dayKeyOf(d) === dayKeyOf(now);
}

/** D-HF4 (§22.10): desde acá la espera es «larga» (latido más rápido y minutos en negrita). */
export const WAITING_LONG_MIN = 15;
/**
 * D-HF5 (§22.10): como mucho esta cantidad de puntos LATEN a la vez (los de más espera); el resto queda fijo. Un
 * gimnasio con 20 pacientes en sala era una grilla entera titilando: el latido deja de señalar nada y cuesta
 * composición en la PC de recepción.
 */
export const WAITING_PULSE_ANIMATED_MAX = 12;

export type WaitingPulse = {
  /** `long` desde `WAITING_LONG_MIN`. Nunca ámbar: el ámbar ya es «demorado» (no llegó). */
  level: "waiting" | "long";
  minutes: number;
  /** Texto para `aria-label`/`title` del punto: el color no es el único canal (AGENTS §5). */
  aria: string;
};

/**
 * [HF-2a] Latido «Llegó» de la agenda (H-LL2, D-LL1). Solo en sala de espera (`en-sala`: llegó y nadie lo llamó ni
 * lo atiende) y solo HOY AR; al llamarlo o pasarlo a atención se apaga. Puro: el `now` es el reloj de minuto de la
 * agenda, así los minutos avanzan solos.
 */
export function waitingPulse(b: ReceptionBooking, now: Date): WaitingPulse | null {
  if (!isTodayAR(b.scheduledFor, now)) return null;
  const minutes = waitingMinutes(b, now);
  if (minutes == null) return null;
  return {
    level: minutes >= WAITING_LONG_MIN ? "long" : "waiting",
    minutes,
    aria: `En sala de espera · ${minutes} min`,
  };
}

/** Ids cuyo punto late (D-HF5): los `max` que más esperan. El resto de los que esperan se ve con el punto fijo. */
export function animatedPulseIds(
  bookings: ReadonlyArray<ReceptionBooking>,
  now: Date,
  max = WAITING_PULSE_ANIMATED_MAX
): Set<string> {
  const waiting: { id: string; minutes: number }[] = [];
  for (const b of bookings) {
    const p = waitingPulse(b, now);
    if (p) waiting.push({ id: b.id, minutes: p.minutes });
  }
  waiting.sort((a, z) => z.minutes - a.minutes);
  return new Set(waiting.slice(0, max).map((w) => w.id));
}

/** Conteo de una celda de la Semana partido por profesional, en el orden de las columnas. */
export function splitCountByPractitioner<P extends { id: string; initials: string }>(
  bookings: ReadonlyArray<{ practitionerId: string }>,
  ordered: ReadonlyArray<P>
): { id: string; initials: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const b of bookings) counts.set(b.practitionerId, (counts.get(b.practitionerId) ?? 0) + 1);
  const out: { id: string; initials: string; count: number }[] = [];
  for (const p of ordered) {
    const c = counts.get(p.id);
    if (c) out.push({ id: p.id, initials: p.initials, count: c });
  }
  // Un turno de un profesional que no está en la lista (dado de baja) igual se cuenta.
  for (const [id, c] of counts) if (!ordered.some((p) => p.id === id)) out.push({ id, initials: "?", count: c });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// SV09 · Agenda en vivo (plan §18.5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rango con que la página carga la semana visible: lunes 00:00 AR → lunes
 * siguiente 00:00 AR (`app/(app)/agenda/page.tsx`: `dayWindow(monday).start`,
 * `dayWindow(sunday).end`). El refetch en vivo tiene que pedir EXACTAMENTE lo
 * mismo: si pidiera menos, un turno del domingo desaparecería de la Semana
 * hasta el próximo `router.refresh()`. `fromKey`/`toKey` (DayKeys AR, ambos
 * incluidos) son para `messagesTouchRange`.
 */
export function weekFetchRange(weekStartKey: DayKey): { fromKey: DayKey; toKey: DayKey; from: Date; to: Date } {
  const toKey = addDays(weekStartKey, 6);
  return { fromKey: weekStartKey, toKey, from: dayWindow(weekStartKey).start, to: dayWindow(toKey).end };
}

/**
 * ¿Algún mensaje del lote le toca a la semana visible? Decide si se re-pide.
 * - `day` dentro del rango (DayKeys AR, comparables como texto) → sí.
 * - `prev.day` dentro → sí: un turno que se fue a otra semana tiene que
 *   desaparecer de esta.
 * - `day: null` (colapso por profesional/consultorio, SV-D10) → sí: no se sabe
 *   qué días tocó.
 * - `kind: "availability"` → sí siempre: un bloqueo/candado puede cancelar o
 *   mover turnos y además cambia las franjas (el caller hace `router.refresh()`).
 * No filtra por profesional a propósito: la agenda trae la semana de TODOS los
 * profesionales visibles al actor y el server ya recorta lo que no le toca; un
 * refetch de más cuesta una consulta, uno de menos deja la grilla vieja.
 */
export function messagesTouchRange(
  batch: ReadonlyArray<Pick<RealtimeAgendaMessage, "kind" | "day" | "prev">>,
  range: { fromKey: string; toKey: string }
): boolean {
  const inRange = (d: string) => d >= range.fromKey && d <= range.toKey;
  return batch.some(
    (m) => m.kind === "availability" || m.day === null || inRange(m.day) || (m.prev != null && inRange(m.prev.day))
  );
}

/**
 * Ids que cambiaron entre dos listas del server: nuevos o con otro
 * `updatedAt` (todo write de `Booking` pasa por Prisma y lo avanza, recepción
 * y «Llamar» incluidos). Los que desaparecieron no van: no hay card que marcar.
 */
export function changedBookingIds(
  prev: ReadonlyArray<{ id: string; updatedAt: string }>,
  next: ReadonlyArray<{ id: string; updatedAt: string }>
): string[] {
  const before = new Map(prev.map((r) => [r.id, r.updatedAt]));
  return next.filter((r) => before.get(r.id) !== r.updatedAt).map((r) => r.id);
}

/** Cuánto queda marcada una card que cambió por otra sesión (el CSS `k-flash` dura 600 ms). */
export const FLASH_MS = 700;
/** Más cambios que esto en un refetch = un cambio masivo (candado, mover en serie): sin flash, sería ruido. */
export const FLASH_MAX_PER_BATCH = 5;
/** Ventana en que el refetch puede traer el eco de MI acción antes que el `router.refresh()`. */
export const OWN_ACTION_QUIET_MS = 5_000;

/**
 * Acciones propias recientes: `ids` (id → vence, ms epoch) cuando se sabe qué
 * turno se tocó (drawer, Recepción); `quietUntil` cuando no (alta desde el
 * modal, candado: los ids los decide el server).
 */
export type OwnActionMarks = { ids: ReadonlyMap<string, number>; quietUntil: number };

/**
 * Qué cards titilan después de un refetch en vivo. Mi propia acción también
 * publica en el canal, y el refetch que dispara puede llegar ANTES que el
 * `router.refresh()` de la acción: sin esto, la card que acabo de tocar
 * titilaría como si la hubiera cambiado otro. Con más de
 * `FLASH_MAX_PER_BATCH` cambios en el lote no titila nada.
 */
export function remoteFlashIds(changed: ReadonlyArray<string>, own: OwnActionMarks, nowMs: number): string[] {
  if (changed.length === 0 || changed.length > FLASH_MAX_PER_BATCH) return [];
  if (nowMs < own.quietUntil) return [];
  return changed.filter((id) => !((own.ids.get(id) ?? 0) > nowMs));
}

/**
 * Re-pedidos coalescidos: a lo sumo UNO en vuelo y UNO pendiente. Si llegan
 * lotes mientras hay un refetch en vuelo, se corre uno más al terminar (el que
 * estaba en vuelo pudo leer antes del último commit), nunca uno por lote. Un
 * `run` que falla no traba la cola (el próximo lote o el polling reintentan).
 * `dispose` (unmount) descarta el pendiente.
 */
export function createRefetchCoalescer(run: () => Promise<void>): { request(): void; dispose(): void } {
  let inFlight = false;
  let pending = false;
  let disposed = false;
  const loop = async () => {
    inFlight = true;
    try {
      do {
        pending = false;
        try {
          await run();
        } catch {
          // red caída / action rota: queda lo que se ve; el próximo aviso reintenta
        }
      } while (pending && !disposed);
    } finally {
      inFlight = false;
    }
  };
  return {
    request() {
      if (disposed) return;
      if (inFlight) {
        pending = true;
        return;
      }
      void loop();
    },
    dispose() {
      disposed = true;
      pending = false;
    },
  };
}

