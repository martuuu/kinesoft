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
import { addDays, dowOfDayKey, isDayKey } from "@/lib/availability/day";
import type { DayKey, DayLockState } from "@/lib/availability/types";
import { canManageBlocksFor, CAPABILITIES, type Capability } from "@/lib/capabilities";
import type { AgendaMode } from "@/lib/preferences-constants";
import { receptionState, waitingMinutes, type ReceptionBooking } from "@/lib/reception-state";

// ─────────────────────────────────────────────────────────────────────────────
// Vista
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Vista de la agenda (parámetro `view` de la URL).
 * - `timeline` (Día), `week` (Semana), `list` (Lista): las de siempre.
 * - `practitioner`: Día por profesional (columnas). Es el "modo" Por
 *   profesional de `agendaPrefs.mode`, que solo aplica al Día.
 * - `reception`: Recepción del día (lista operativa de todos).
 */
export type AgendaView = "timeline" | "week" | "list" | "practitioner" | "reception";
export const AGENDA_VIEWS: ReadonlyArray<AgendaView> = ["timeline", "week", "list", "practitioner", "reception"];

export type ViewContext = {
  /** `agendaPrefs.mode` del usuario (cómo prefiere ver el Día). */
  mode: AgendaMode;
  /** Profesionales del consultorio (no los filtrados). */
  practitionerCount: number;
  /** `agenda.reception`. */
  canReception: boolean;
};

/** ¿El consultorio tiene más de un profesional? Con uno, la agenda se ve como siempre. */
export function isMultiPractitioner(practitionerCount: number): boolean {
  return practitionerCount > 1;
}

/** El "Día" que corresponde al modo guardado. Con un solo profesional, siempre el de siempre. */
export function dayViewFor(mode: AgendaMode, practitionerCount: number): "timeline" | "practitioner" {
  return mode === "practitioner" && isMultiPractitioner(practitionerCount) ? "practitioner" : "timeline";
}

/**
 * Vista efectiva a partir del `?view=` de la URL. Sin parámetro (o uno
 * desconocido) → el Día del modo guardado. Una vista que no aplica (Por
 * profesional con un solo profesional, Recepción sin la capability) cae al
 * Día de siempre: un link viejo o compartido nunca deja la pantalla vacía.
 */
export function resolveAgendaView(raw: string | null | undefined, ctx: ViewContext): AgendaView {
  const fallback = dayViewFor(ctx.mode, ctx.practitionerCount);
  if (!raw || !(AGENDA_VIEWS as ReadonlyArray<string>).includes(raw)) return fallback;
  const v = raw as AgendaView;
  if (v === "practitioner" && !isMultiPractitioner(ctx.practitionerCount)) return "timeline";
  if (v === "reception" && !ctx.canReception) return fallback;
  return v;
}

/** Vistas de UN día (el título y el candado del día hablan de ese día). */
export function isDayScoped(v: AgendaView): boolean {
  return v !== "week";
}

/** Segmento activo del selector Día / Semana / Lista / Recepción. */
export type ViewSegment = "day" | "week" | "list" | "reception";
export function segmentOf(v: AgendaView): ViewSegment {
  if (v === "timeline" || v === "practitioner") return "day";
  return v;
}

/** Vista a la que lleva un segmento: "Día" respeta el modo guardado. */
export function viewForSegment(seg: ViewSegment, ctx: Pick<ViewContext, "mode" | "practitionerCount">): AgendaView {
  if (seg === "day") return dayViewFor(ctx.mode, ctx.practitionerCount);
  return seg;
}

/** El toggle Por día ↔ Por profesional solo tiene sentido en el Día y con varios profesionales. */
export function showModeToggle(v: AgendaView, practitionerCount: number): boolean {
  return segmentOf(v) === "day" && isMultiPractitioner(practitionerCount);
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

/**
 * URL de la agenda. `pros` solo si hay selección (vacía = todos). El filtro de
 * profesionales viaja en la URL para que un refresh o un link conserven la
 * vista de la secretaria; la sede vive en `agendaPrefs`.
 */
export function agendaHref(p: { view: AgendaView; dayKey: DayKey; selectedIds?: ReadonlyArray<string> }): string {
  const sp = new URLSearchParams({ view: p.view, date: p.dayKey });
  if (p.selectedIds && p.selectedIds.length > 0) sp.set("pros", p.selectedIds.join(","));
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
// ─────────────────────────────────────────────────────────────────────────────

/** Lo mínimo del turno que miran los filtros (lo cumple `BookingDTO`). */
export type AgendaFilterable = { practitionerId: string; locationId?: string | null };
type Filterable = AgendaFilterable;

/** Filtros que sacan turnos de la agenda. Vacío/null en cada clave = sin filtrar. */
export type AgendaFilters = {
  /** Profesionales elegidos (`?pros=`); vacío = todos. */
  practitionerIds: ReadonlyArray<string>;
  /** Sede (`agendaPrefs.locationId`); null = todas. */
  locationId: string | null;
};

export type AgendaFilterKey = keyof AgendaFilters;

export const EMPTY_AGENDA_FILTERS: AgendaFilters = { practitionerIds: [], locationId: null };

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
    return o ? normalize(o) : b;
  });
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
export function receptionCardBadge(b: ReceptionBooking, now: Date): { kind: "en-sala" | "en-atencion"; label: string } | null {
  const state = receptionState(b, now);
  if (state === "en-sala") {
    const w = waitingMinutes(b, now);
    // Una llegada olvidada de otro día no puede decir "En sala 1440′".
    return { kind: "en-sala", label: w == null || w >= WAIT_LABEL_MAX_MIN ? "En sala" : `En sala ${w}′` };
  }
  if (state === "en-atencion") return { kind: "en-atencion", label: "En atención" };
  return null;
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
