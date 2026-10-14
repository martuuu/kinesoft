/**
 * Estado de la VISTA de Recepción — B4.5 AG-reception (puro: sin React, sin
 * DB, sin reloj propio). Lo que `components/agenda/reception/*` necesita
 * encima de `lib/reception-state.ts` (B3.6), separado para poder testearlo
 * sin montar el componente (AGENTS §3: la lógica pura va fuera de la UI).
 *
 * - Filtros rápidos (Todos / Por llegar / En sala / Atendidos) y contadores.
 * - Qué acciones se MUESTRAN (las de `allowedTransitions`, menos "Llegó",
 *   "Llamar" y "En atención" fuera del día de hoy: el server igual las rechaza con
 *   "Solo se marca la llegada de turnos de hoy." y no tiene sentido ofrecer
 *   un botón que siempre falla).
 * - El parche optimista y su rollback: la fila cambia al click, con el mismo
 *   `applyReceptionAction` que valida el server (B4.1), y vuelve a lo que
 *   era si la action devuelve error. Los overrides viven en un mapa por id
 *   aparte de las `bookings` del padre, así un refetch del padre no pisa un
 *   click en vuelo y, una vez que el padre trae la versión nueva (mismo o
 *   mayor `updatedAt`), el override se descarta solo.
 */
import type { BookingDTO } from "@/components/agenda/agenda-utils";
import type { ReceptionActionResult } from "@/lib/bookings-types";
import { dayKeyOf } from "@/lib/availability/day";
import {
  RECEPTION_STATE_LABEL,
  applyReceptionAction,
  receptionState,
  sortForReception,
  undoTarget,
  type ReceptionBooking,
  type ReceptionAction,
  type ReceptionEntry,
  type ReceptionState,
} from "@/lib/reception-state";

// ── Filtros y contadores ─────────────────────────────────────────────────────

export type ReceptionFilter = "todos" | "por-llegar" | "en-sala" | "atendidos";

export const RECEPTION_FILTERS: ReadonlyArray<{ id: ReceptionFilter; label: string }> = [
  { id: "todos", label: "Todos" },
  { id: "por-llegar", label: "Por llegar" },
  { id: "en-sala", label: "En sala" },
  { id: "atendidos", label: "Atendidos" },
];

/**
 * Qué estados entran en cada filtro. "Por llegar" incluye a los demorados
 * (todavía no llegaron: son a los que hay que llamar). "En sala" incluye a los
 * que están en atención: la pregunta de la secretaria es "quién está en el
 * consultorio ahora", y el que pasó al box sigue adentro. Ausentes y
 * cancelados solo se ven en "Todos". El LLAMADO (SV) entra en "En sala": sigue
 * en la sala de espera hasta que el profesional lo marca en atención.
 */
const FILTER_STATES: Record<Exclude<ReceptionFilter, "todos">, ReadonlyArray<ReceptionState>> = {
  "por-llegar": ["por-llegar", "demorado"],
  "en-sala": ["en-sala", "llamado", "en-atencion"],
  atendidos: ["atendido"],
};

export function matchesFilter(state: ReceptionState, filter: ReceptionFilter): boolean {
  return filter === "todos" || FILTER_STATES[filter].includes(state);
}

export function filterEntries<T extends { state: ReceptionState }>(entries: ReadonlyArray<T>, filter: ReceptionFilter): T[] {
  return entries.filter((e) => matchesFilter(e.state, filter));
}

export type ReceptionCounters = {
  /**
   * En sala de espera ahora (no cuenta a los que ya están en atención). SV:
   * incluye a los llamados — todavía no entraron al box, y el contador «En sala
   * ahora» no tiene que bajar y volver a subir por un llamado de segundos.
   */
  enSala: number;
  /** SV: llamados que todavía no pasaron a atención (subconjunto de `enSala`). */
  llamados: number;
  enAtencion: number;
  demorados: number;
  atendidos: number;
  /** Turnos del día que no están cancelados (base de "atendidos / total"). */
  total: number;
  /** Cuántas filas muestra cada filtro (para el número en el chip). */
  byFilter: Record<ReceptionFilter, number>;
};

export function receptionCounters(entries: ReadonlyArray<{ state: ReceptionState }>): ReceptionCounters {
  const n = (s: ReceptionState) => entries.filter((e) => e.state === s).length;
  const byFilter = Object.fromEntries(
    RECEPTION_FILTERS.map((f) => [f.id, filterEntries(entries, f.id).length])
  ) as Record<ReceptionFilter, number>;
  return {
    enSala: n("en-sala") + n("llamado"),
    llamados: n("llamado"),
    enAtencion: n("en-atencion"),
    demorados: n("demorado"),
    atendidos: n("atendido"),
    total: entries.length - n("cancelado"),
    byFilter,
  };
}

// ── Lista del día ────────────────────────────────────────────────────────────

/** Los turnos del día AR `dayKey` (el padre puede mandar la semana entera). */
export function bookingsOfDay<T extends { scheduledFor: string }>(bookings: ReadonlyArray<T>, dayKey: string): T[] {
  return bookings.filter((b) => dayKeyOf(new Date(b.scheduledFor)) === dayKey);
}

/** Las que el server rechaza fuera de hoy (`TODAY_ONLY` de reception-state). */
const TODAY_ONLY_ACTIONS: ReadonlyArray<ReceptionAction> = ["llego", "llamar", "en-atencion"];

/**
 * Acciones a mostrar en la fila: `allowedTransitions` del estado, sin "Llegó",
 * "Llamar" ni "En atención" si el día mostrado no es hoy (ver cabecera).
 */
export function visibleActions(actions: ReadonlyArray<ReceptionAction>, isToday: boolean): ReceptionAction[] {
  return isToday ? [...actions] : actions.filter((a) => !TODAY_ONLY_ACTIONS.includes(a));
}

/**
 * Hint del botón "Deshacer" (aria-label: «Deshacer (vuelve a En sala): …»),
 * derivado de `undoTarget` para no repetir la regla de §18.4 en la UI:
 * llamado → En sala; en atención → Llamado si hubo llamado, si no En sala;
 * en sala → Por llegar (aunque el turno ya esté demorado: es la misma fila de
 * "Por llegar"); atendido/ausente → "el estado anterior" (depende de los
 * timestamps y el label exacto confunde más de lo que ayuda). null = no hay
 * deshacer.
 */
export function undoHint(row: ReceptionBooking, now: Date): string | null {
  const from = receptionState(row, now);
  const to = undoTarget(row, now);
  if (to == null) return null;
  if (from === "atendido" || from === "ausente") return "vuelve al estado anterior";
  const label: Partial<Record<ReceptionState, string>> = {
    "por-llegar": "Por llegar",
    demorado: "Por llegar",
    "en-sala": "En sala",
    llamado: "Llamado",
    "en-atencion": "En atención",
  };
  return `vuelve a ${label[to] ?? RECEPTION_STATE_LABEL[to]}`;
}

/** Minutos para leer de un vistazo: 8' · 1 h 05'. */
export function fmtMinutes(min: number): string {
  if (min < 60) return `${min}'`;
  const h = Math.floor(min / 60);
  return `${h} h ${String(min % 60).padStart(2, "0")}'`;
}

/**
 * Texto del tag de estado. Con minutos donde importan ("Demorado 12'",
 * "En sala 8'", "Llamado 3'"); el resto, el label de `RECEPTION_STATE_LABEL`. "En sala" en
 * corto porque el tag va en una columna angosta; el label largo ("En sala de
 * espera") queda para el `title`.
 */
export function stateTagText(
  // `calledMinutes` opcional: los callers que pasan un Pick viejo (sin el
  // campo, p. ej. `ReceptionStateTag`) siguen compilando; sin el dato se lee
  // "Llamado" a secas.
  entry: Pick<ReceptionEntry<never>, "state" | "waitingMinutes" | "lateMinutes" | "calledMinutes">
): string {
  if (entry.state === "demorado" && entry.lateMinutes != null) return `Demorado ${fmtMinutes(entry.lateMinutes)}`;
  if (entry.state === "llamado") {
    return entry.calledMinutes != null ? `Llamado ${fmtMinutes(entry.calledMinutes)}` : "Llamado";
  }
  if (entry.state === "en-sala") {
    return entry.waitingMinutes != null ? `En sala ${fmtMinutes(entry.waitingMinutes)}` : "En sala";
  }
  return RECEPTION_STATE_LABEL[entry.state];
}

const MIN_MS = 60_000;

/**
 * Columna "Espera": cuánto lleva en sala (en-sala y llamado: el llamado
 * sigue esperando hasta entrar al box, el reloj no se corta) o cuánto esperó hasta
 * pasar a atención (en-atención / atendido, si están los dos timestamps).
 * null = no aplica (se muestra "—").
 */
export function waitText(
  b: Pick<BookingDTO, "arrivedAt" | "attendingAt">,
  state: ReceptionState,
  now: Date
): string | null {
  if (!b.arrivedAt) return null;
  const arrived = new Date(b.arrivedAt).getTime();
  if (state === "en-sala" || state === "llamado") return fmtMinutes(Math.max(0, Math.floor((now.getTime() - arrived) / MIN_MS)));
  if ((state === "en-atencion" || state === "atendido") && b.attendingAt) {
    const waited = Math.max(0, Math.floor((new Date(b.attendingAt).getTime() - arrived) / MIN_MS));
    return `esperó ${fmtMinutes(waited)}`;
  }
  return null;
}

// ── Optimista + rollback ─────────────────────────────────────────────────────

/**
 * Override local de una fila. `pending`: la action está en vuelo (la fila
 * muestra el estado optimista y los botones quedan deshabilitados).
 * `previous`: lo que había antes del click, para el rollback.
 */
export type ReceptionOverride = { booking: BookingDTO; previous: BookingDTO; pending: boolean };
export type ReceptionOverrides = Readonly<Record<string, ReceptionOverride>>;

/**
 * Click en una acción. Valida con `applyReceptionAction` (el mismo validador
 * que el server) y devuelve la fila optimista. Si la fila ya tiene una action
 * en vuelo, la rechaza (doble click): el server la rechazaría igual por el
 * `expectedUpdatedAt`, pero así no se dispara la segunda request.
 */
export function beginReceptionAction(
  overrides: ReceptionOverrides,
  current: BookingDTO,
  action: ReceptionAction,
  now: Date
): { ok: true; overrides: ReceptionOverrides; optimistic: BookingDTO } | { ok: false; error: string } {
  if (overrides[current.id]?.pending) return { ok: false, error: "Ya se está guardando un cambio en este turno." };
  const t = applyReceptionAction(current, action, now);
  if (!t.ok) return { ok: false, error: t.error };
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  const optimistic: BookingDTO = {
    ...current,
    ...(t.patch.status ? { status: t.patch.status } : {}),
    ...("arrivedAt" in t.patch ? { arrivedAt: iso(t.patch.arrivedAt ?? null) } : {}),
    ...("calledAt" in t.patch ? { calledAt: iso(t.patch.calledAt ?? null) } : {}),
    ...("attendingAt" in t.patch ? { attendingAt: iso(t.patch.attendingAt ?? null) } : {}),
  };
  return {
    ok: true,
    optimistic,
    overrides: { ...overrides, [current.id]: { booking: optimistic, previous: current, pending: true } },
  };
}

/**
 * La action respondió OK: la fila queda con lo que dice el server (que manda
 * sobre el optimista: su reloj, su `updatedAt` para el próximo click).
 */
export function commitReceptionAction(
  overrides: ReceptionOverrides,
  id: string,
  result: ReceptionActionResult
): { overrides: ReceptionOverrides; booking: BookingDTO | null } {
  const o = overrides[id];
  if (!o) return { overrides, booking: null };
  const booking: BookingDTO = {
    ...o.booking,
    status: result.status,
    arrivedAt: result.arrivedAt,
    // SV05: el server siempre devuelve `calledAt` (null = sin llamado): manda
    // sobre el optimista, igual que `arrivedAt`.
    calledAt: result.calledAt,
    attendingAt: result.attendingAt,
    updatedAt: result.updatedAt,
  };
  return { overrides: { ...overrides, [id]: { booking, previous: o.previous, pending: false } }, booking };
}

/** La action falló: se descarta el override y la fila vuelve a la del padre. */
export function rollbackReceptionAction(
  overrides: ReceptionOverrides,
  id: string
): { overrides: ReceptionOverrides; previous: BookingDTO | null } {
  const o = overrides[id];
  if (!o) return { overrides, previous: null };
  const next = { ...overrides };
  delete next[id];
  return { overrides: next, previous: o.previous };
}

/**
 * Las bookings del padre con los overrides encima. Un override confirmado se
 * descarta cuando el padre ya trae una versión igual o más nueva de la fila
 * (refetch después de `onChanged`); uno en vuelo gana siempre. Devuelve
 * también el mapa podado para guardarlo (o el mismo objeto si no cambió).
 */
export function mergeReceptionOverrides(
  bookings: ReadonlyArray<BookingDTO>,
  overrides: ReceptionOverrides
): { rows: BookingDTO[]; overrides: ReceptionOverrides } {
  let pruned: Record<string, ReceptionOverride> | null = null;
  const rows = bookings.map((b) => {
    const o = overrides[b.id];
    if (!o) return b;
    if (!o.pending && new Date(b.updatedAt).getTime() >= new Date(o.booking.updatedAt).getTime()) {
      pruned ??= { ...overrides };
      delete pruned[b.id];
      return b;
    }
    return o.booking;
  });
  return { rows, overrides: pruned ?? overrides };
}

/** Error de concurrencia de B4.1 (`STALE_ERROR`): la fila hay que refrescarla. */
export function isStaleError(error: string): boolean {
  return /cambió en otra sesión/i.test(error);
}
