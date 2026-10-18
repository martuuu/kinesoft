/**
 * Tope de turnos por intervalo del profesional (T3, decisión 6 del 19-oct; contrato C-AS3). Puro: sin DB, sin
 * reloj propio (`now` lo pasa el caller) y sin `Date#getHours/getDay` del host.
 *
 * La regla (plan §23.7): «N turnos cada X minutos», X ∈ {15, 30, 60}. Cuentan los turnos que RETIENEN cupo
 * (`isHoldingCapacity`, AUDIT §5.18), de CUALQUIER servicio, del profesional, que EMPIEZAN en el mismo intervalo
 * AR. Los intervalos están alineados a la hora de pared AR (10:00, 10:15, 10:30…; con 60, 10:00-11:00), no al
 * inicio de la franja ni al del turno: así el modal, el motor, el turnero y la Ocupación dicen lo mismo de «a las
 * 10:00», y la hora (`arHourKeyOf`) siempre contiene entero a cualquier intervalo de 15/30/60, que es lo que deja
 * que el lock `kinesoft:phour:…` no dependa de la configuración (`lib/booking-cap-lock.ts`).
 *
 * Por qué «empiezan en» y no «solapan»: es el tope de la decisión 6 («el 2.º turno de las 10:00 avisa»), no un
 * cupo de concurrencia; el cupo por servicio (`overlapBlocks` + `Service.maxConcurrent`) sigue intacto al lado.
 *
 * El reloj de pared sale de `lib/datetime-ar.ts` (una llamada a `Intl` por ventana, no por turno): el conteo
 * compara instantes contra `[start, end)` ya calculado, así un barrido de N turnos no paga N `Intl`.
 */
import { isHoldingCapacity } from "@/lib/booking-capacity";
import { toARDateKey, toARMinutes } from "@/lib/datetime-ar";
import { formatWallTime } from "@/lib/availability/day";

/** Los intervalos admitidos (CHECK `Tenant_bookingCap_check` / `Practitioner_bookingCap_check` de M12). */
export const INTERVAL_CAP_MINUTES = [15, 30, 60] as const;
export type IntervalCapMinutes = (typeof INTERVAL_CAP_MINUTES)[number];
/** Rango de N (mismo CHECK: 1..60). */
export const INTERVAL_CAP_COUNT_MIN = 1;
export const INTERVAL_CAP_COUNT_MAX = 60;

/** Tope efectivo de un profesional: como mucho `count` turnos que empiezan en cada intervalo de `intervalMin`. */
export type IntervalCap = { count: number; intervalMin: IntervalCapMinutes };

/** Espejo del enum `BookingCapMode` de Prisma (sin importar `@prisma/client` en el motor). */
export type BookingCapMode = "INHERIT" | "NONE" | "CUSTOM";

export function isIntervalCapMinutes(v: unknown): v is IntervalCapMinutes {
  return (INTERVAL_CAP_MINUTES as readonly unknown[]).includes(v);
}

/** Par (count, intervalMin) válido según el CHECK de M12, o null. */
function capOf(count: number | null | undefined, intervalMin: number | null | undefined): IntervalCap | null {
  if (
    typeof count !== "number" ||
    !Number.isInteger(count) ||
    count < INTERVAL_CAP_COUNT_MIN ||
    count > INTERVAL_CAP_COUNT_MAX ||
    !isIntervalCapMinutes(intervalMin)
  ) {
    return null;
  }
  return { count, intervalMin };
}

/**
 * Tope que rige para el profesional: INHERIT → el del consultorio; NONE → sin tope; CUSTOM → el propio.
 *
 * Un par inválido (que el CHECK de M12 no deja escribir, pero llega de un fixture o de una fila a medio migrar)
 * se lee como «sin tope» y NO cae al del consultorio: un CUSTOM roto que heredara el tope del tenant cambiaría el
 * comportamiento de alguien que eligió el suyo. Sin tope = la agenda de siempre (nunca bloquea de más). Un modo
 * desconocido (enum nuevo sin actualizar esto) también es «sin tope».
 */
export function effectiveIntervalCap(
  prac: { mode: BookingCapMode | string; count: number | null; intervalMin: number | null },
  tenant: { count: number | null; intervalMin: number | null }
): IntervalCap | null {
  switch (prac.mode) {
    case "INHERIT":
      return capOf(tenant.count, tenant.intervalMin);
    case "CUSTOM":
      return capOf(prac.count, prac.intervalMin);
    default:
      return null;
  }
}

const MIN_MS = 60_000;

/**
 * `[start, end)` del intervalo AR alineado a la hora que contiene a `d`. Con 15: 10:07 → [10:00, 10:15). Los
 * segundos y milisegundos de `d` se descartan (`getTime() % 60 000` es independiente del huso: todo offset real
 * es de minutos enteros). Un intervalo de 60 que arranca a las 23:00 AR termina a las 00:00 AR del día siguiente.
 */
export function arIntervalWindow(d: Date, intervalMin: IntervalCapMinutes): { start: Date; end: Date } {
  const intoInterval = (toARMinutes(d) % intervalMin) * MIN_MS + (((d.getTime() % MIN_MS) + MIN_MS) % MIN_MS);
  const start = new Date(d.getTime() - intoInterval);
  return { start, end: new Date(start.getTime() + intervalMin * MIN_MS) };
}

/**
 * `arIntervalWindow` con el reloj de pared AR YA calculado (`wallMin` = minutos AR desde la medianoche, pueden ser
 * fraccionarios: es el `ArWall.startMin` de `classifyInstantAt`). Para barridos (`nextFreeSlot`: paso 15 × 14 días
 * × N profesionales) donde un `Intl` por paso dominaba el costo (lo midió B2.1b). `wallMin` TIENE que corresponder
 * a `d` (no se verifica). El `Math.round` es a propósito: con minutos fraccionarios el producto puede dar
 * 29 999,999… ms y correr el inicio una fracción de ms, y un turno que arranca JUSTO en el borde quedaba afuera.
 */
export function arIntervalWindowAt(
  d: Date,
  intervalMin: IntervalCapMinutes,
  wallMin: number
): { start: Date; end: Date } {
  const intoInterval = Math.round((((wallMin % intervalMin) + intervalMin) % intervalMin) * MIN_MS);
  const start = new Date(d.getTime() - intoInterval);
  return { start, end: new Date(start.getTime() + intervalMin * MIN_MS) };
}

/**
 * Clave del intervalo AR de `d`: "YYYY-MM-DDTHH:MM" del INICIO del intervalo en pared AR ("2026-10-20T10:15").
 * Sirve para agrupar (Ocupación, el «x/tope» del lote) con un `intervalMin` fijo; no lleva el intervalo adentro.
 */
export function arIntervalKeyOf(d: Date, intervalMin: IntervalCapMinutes): string {
  const { start } = arIntervalWindow(d, intervalMin);
  return `${toARDateKey(start)}T${formatWallTime(toARMinutes(start))}`;
}

/** Clave de la hora AR de `d`: "YYYY-MM-DDTHH" (la del lock `kinesoft:phour:…`). 23:30 AR → "…T23"; 00:30 AR → el
 *  día siguiente "…T00". */
export function arHourKeyOf(d: Date): string {
  const hh = String(Math.floor(toARMinutes(d) / 60)).padStart(2, "0");
  return `${toARDateKey(d)}T${hh}`;
}

/** "HH:MM" de pared AR del inicio y del fin del intervalo (copy «entre las 10:00 y las 10:15»). El fin de un
 *  intervalo que cierra a medianoche sale "00:00". */
export function arIntervalLabels(d: Date, intervalMin: IntervalCapMinutes): { from: string; to: string } {
  const { start, end } = arIntervalWindow(d, intervalMin);
  return { from: formatWallTime(toARMinutes(start)), to: formatWallTime(toARMinutes(end)) };
}

/** Lo mínimo de un turno para el conteo: `isHoldingCapacity` + profesional + inicio (+ id para excluirse). */
export type IntervalCapBooking = {
  id?: string;
  practitionerId: string | null;
  scheduledFor: Date;
  status: string;
  paymentStatus: string;
  createdAt: Date;
  patientId: string | null;
  idempotencyKey: string;
};

/**
 * Cuántos turnos del profesional que retienen cupo EMPIEZAN en el intervalo AR de `when` (cualquier servicio).
 * `excludeId` = el turno que se está editando (no cuenta contra sí mismo). Un CANCELLED que llegara igual no
 * cuenta: el filtro es del caller según §5.18, y esto ES un caller (el loader y las queries ya lo excluyen).
 */
export function intervalStartsUsed(
  bookings: ReadonlyArray<IntervalCapBooking>,
  o: {
    practitionerId: string;
    when: Date;
    intervalMin: IntervalCapMinutes;
    now: Date;
    excludeId?: string | null;
    /** Minutos de pared AR de `when` ya calculados (barridos; ver `arIntervalWindowAt`). */
    wallMin?: number;
  }
): number {
  const { start, end } =
    o.wallMin == null ? arIntervalWindow(o.when, o.intervalMin) : arIntervalWindowAt(o.when, o.intervalMin, o.wallMin);
  const s = start.getTime();
  const e = end.getTime();
  let n = 0;
  for (const b of bookings) {
    if (b.practitionerId !== o.practitionerId) continue;
    if (o.excludeId != null && b.id === o.excludeId) continue;
    if (b.status === "CANCELLED") continue;
    const at = b.scheduledFor.getTime();
    if (at < s || at >= e) continue;
    if (!isHoldingCapacity(b, o.now)) continue;
    n++;
  }
  return n;
}

/** Estado del intervalo para un turno NUEVO, dados los que ya empiezan ahí. */
export type IntervalCapState = "free" | "notice" | "full";

/**
 * - `free`: no hay ninguno (o no hay tope);
 * - `notice`: ya hay ≥ 1 y todavía no se llegó al tope → aviso informativo del 2.º turno, sin confirmar
 *   («Ya hay 1 turno de Ana a las 10:00.»);
 * - `full`: `used ≥ count` → el nuevo pasaría el tope: confirmación de sobreturno (staff, queda `isOverbooked`);
 *   el turnero no lo ofrece; Planes avisa sin bloquear.
 * Con tope 1 no hay `notice`: el 2.º ya es `full`. Sin tope (`null`) siempre `free`: el aviso es parte del tope.
 */
export function intervalCapState(used: number, cap: IntervalCap | null): IntervalCapState {
  if (cap == null) return "free";
  if (used >= cap.count) return "full";
  return used >= 1 ? "notice" : "free";
}
