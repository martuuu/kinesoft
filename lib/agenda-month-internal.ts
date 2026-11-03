import "server-only";
/**
 * CF2 (§29 D-CF2-7, brief A.4) — resumen del Mes de la agenda, en UNA tx que abre el caller (`getAgendaMonthSummary`
 * o el loader de la página con `view=month`).
 *
 *   1. `loadAvailabilityInputs(…, rangesOnly: true)`: plantillas, excepciones y bloqueos (lo único que lee
 *      `dayLockState`), sin turnos/servicios/coberturas → 6-7 sentencias.
 *   2. `tx.booking.findMany` con 3 columnas: tenant, rango, sin cancelados, sede con la regla de `listAgendaBookings`
 *      (`lib/bookings.ts`: la principal incluye los turnos con `locationId` null; una sede ajena no matchea nada).
 *   3. `aggregateMonthSummary` (puro): cuenta por día AR (`dayKeyOf`, nunca el día del host: en Vercel un turno de
 *      las 23:30 AR cae al día siguiente en UTC) y pone el candado por profesional.
 *
 * Por qué Prisma + JS y no un GROUP BY: con el volumen del fixture de la Secretaria (~1.000 turnos/mes) la query de
 * 3 columnas por el índice (tenantId, scheduledFor) es barata y agrupar en JS es trivial; si en volumen dbMs > 40 ms,
 * se pasa a GROUP BY raw (brief A.4). Lo mide el escenario `g.getAgendaMonthSummary` de agenda-multi.perf.
 */
import type { BookingStatus } from "@prisma/client";
import type { DbClient } from "@/lib/rls";
import type { Actor } from "@/lib/session";
import { loadAvailabilityInputs } from "@/lib/availability-loader";
import { dayKeyOf, dayKeyRange, dayWindow } from "@/lib/availability/day";
import { dayLockState, type RangesInput } from "@/lib/availability/ranges";
import type { DayKey } from "@/lib/availability/types";
import type { AgendaMonthDay, AgendaMonthSummary, MonthLockCode } from "@/lib/agenda-month-types";
import type { AgendaMonthQueryParsed } from "@/lib/agenda-month-schemas";

/** Lo que `aggregateMonthSummary` necesita de cada turno (el select de la query 2). */
export type MonthBookingRow = { practitionerId: string; scheduledFor: Date; status: BookingStatus };

/**
 * Puro. `input` = lo que cargó el loader (solo se leen franjas, excepciones y bloqueos); `bookings` = los turnos del
 * rango (los cancelados se descartan acá también, como red: la query ya los saca).
 *
 * Profesionales = los de `input.templates` (reservables, con franjas o con la red de seguridad) ∪ los que tienen turnos
 * en el rango. Uno con turnos que NO está en `templates` (suspendido, Secretaria con turnos viejos) no tiene franjas:
 * va `x` todos los días, en vez de `dayLockState(pid)` — que para un id fuera de `templates` aplica la red de seguridad
 * lun-sáb y lo pintaría «abierto». Así `aggregateDayLock` lo ignora, igual que la Semana (que no le trae candado).
 */
export function aggregateMonthSummary(
  input: RangesInput,
  bookings: ReadonlyArray<MonthBookingRow>,
  q: AgendaMonthQueryParsed
): AgendaMonthSummary {
  const keys = dayKeyRange(q.from, q.to);
  const counts = new Map<DayKey, Map<string, [number, number]>>();
  for (const k of keys) counts.set(k, new Map());

  const inTemplates = new Set(input.templates.map((t) => t.practitionerId));
  const withBookingsOnly = new Set<string>();
  for (const b of bookings) {
    if (b.status === "CANCELLED") continue;
    // Día AR del instante (`dayKeyOf` → `toARDateKey`), nunca `toISOString().slice(0,10)` del host.
    const perDay = counts.get(dayKeyOf(b.scheduledFor));
    if (!perDay) continue; // fuera del rango pedido
    const c = perDay.get(b.practitionerId) ?? [0, 0];
    c[0]++;
    if (b.status === "NO_SHOW") c[1]++;
    perDay.set(b.practitionerId, c);
    if (!inTemplates.has(b.practitionerId)) withBookingsOnly.add(b.practitionerId);
  }
  // Orden estable: el de `templates` (createdAt del loader) y después los que solo tienen turnos, por id.
  const extra = [...withBookingsOnly].sort();
  const opts = { locationId: q.locationId };

  const days = keys.map((k): AgendaMonthDay => {
    const day: AgendaMonthDay = { k };
    const perDay = counts.get(k)!;
    if (perDay.size > 0) day.c = Object.fromEntries(perDay);
    const l: Record<string, MonthLockCode> = {};
    const d: Record<string, string> = {};
    for (const t of input.templates) {
      const s = dayLockState(t.practitionerId, k, input, opts);
      if (s.status === "open") continue;
      l[t.practitionerId] = s.status === "partial" ? "p" : s.reason === "sin-franjas" ? "x" : "l";
      if (s.detail) d[t.practitionerId] = s.detail;
    }
    for (const pid of extra) l[pid] = "x";
    if (Object.keys(l).length > 0) day.l = l;
    if (Object.keys(d).length > 0) day.d = d;
    return day;
  });
  return { from: q.from, to: q.to, locationId: q.locationId, days };
}

/** Pasos 1-3 de la cabecera, dentro de la tx del caller. `q` ya validado con `AgendaMonthQuery`. */
export async function loadAgendaMonthSummaryInTx(
  tx: DbClient,
  actor: Pick<Actor, "tenantId">,
  q: AgendaMonthQueryParsed
): Promise<AgendaMonthSummary> {
  const tenantId = actor.tenantId;
  const locationId = q.locationId ?? null;
  // 1. Franjas, excepciones y bloqueos (sede ajena → el loader no matchea nada: todo `x`).
  const input = await loadAvailabilityInputs(tx, {
    tenantId,
    from: q.from,
    to: q.to,
    ...(locationId ? { locationId } : {}),
    rangesOnly: true,
  });
  // 2. Turnos del rango, con la regla de sede de `listAgendaBookings`: la principal incluye los `locationId` null;
  //    otra sede, solo la suya (una ajena no matchea: el `tenantId` va a mano). La principal sale del loader
  //    (`primaryLocationId`), sin otra sentencia.
  const locationWhere =
    locationId == null
      ? {}
      : locationId === input.primaryLocationId
        ? { OR: [{ locationId }, { locationId: null }] }
        : { locationId };
  const rows = await tx.booking.findMany({
    where: {
      tenantId,
      scheduledFor: { gte: dayWindow(q.from).start, lt: dayWindow(q.to).end },
      status: { not: "CANCELLED" },
      ...locationWhere,
    },
    select: { practitionerId: true, scheduledFor: true, status: true },
  });
  // 3. Puro.
  return aggregateMonthSummary(input, rows, { from: q.from, to: q.to, locationId });
}
