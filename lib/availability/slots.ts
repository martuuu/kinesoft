/**
 * Grilla de slots de un día — B2.1a del motor de disponibilidad (puro).
 *
 * `buildSlots` recibe las franjas YA efectivas (`workingRanges`: plantilla,
 * excepción y bloqueos aplicados) y arma la grilla:
 *   • anclada al inicio de CADA franja (un bloqueo 10:00-10:20 hace que la
 *     franja siguiente arranque su grilla a las 10:20, no a las 10:45);
 *   • un slot existe solo si `[t, t + duración)` cabe entero en su franja: lo
 *     que no entra no se emite (por eso no hay motivo "fuera de franja" en la
 *     salida; ese veredicto es de `classifyInstant`);
 *   • `available=false` con `reason`, en este orden: `pasado` (t < now) >
 *     `anticipacion-minima` (t < now + minLead) > `fuera-de-horizonte`
 *     (t > now + maxDays · 24 h; justo en el tope todavía entra) >
 *     `cupo-completo` > `tope-intervalo` (T3, C-AS3: con `intervalCap`, el
 *     intervalo AR del slot ya tiene `cap.count` turnos del profesional que
 *     retienen cupo, de cualquier servicio; va último porque con el cupo del
 *     servicio también lleno el motivo de siempre gana);
 *   • `used` = turnos que sostienen cupo (`isHoldingCapacity`: una reserva
 *     pública impaga de más de 30 min ya no cuenta) y solapan el slot;
 *     `cap` null = ilimitado; lleno = `overlapBlocks(used, cap)`. Las dos
 *     funciones son las de `lib/booking-capacity.ts` sin cambios (AUDIT
 *     §5.18). El caller ya filtró profesional + servicio (decisión 5).
 *
 * Sin `intervalCap` (ausente o null) la salida es la de antes de T3, sin la
 * clave `intervalCapUse`: la paridad de abajo no cambia.
 *
 * CF (M20, decisiones 1 y 2): con `exclusive` (profesional que no atiende
 * servicios distintos a la vez) un slot que pisa un turno de OTRO servicio
 * (otro paciente) queda `available=false` con razón `otro-servicio`, entre
 * `cupo-completo` y `tope-intervalo` (misma precedencia que `InstantClass`).
 * El turnero lo toma duro; el selector del staff lo deja elegir y forzar. Los
 * intervalos que chocan se arman UNA vez por grilla con el predicado único
 * (`isOtherServiceConflict` contra una ventana sin bordes: decide servicio,
 * paciente y retención; el solape semiabierto con cada slot se mide abajo,
 * igual que el del cupo). Sin `exclusive` (ausente o null) no se arma nada y la
 * salida es la de antes, sin claves nuevas.
 *
 * Con la plantilla de fallback, paso 45 y anticipación 60 reproduce
 * `buildPublicSlots` (paridad en `tests/unit/availability-slots.test.ts`):
 * mismo instante, misma "HH:MM", mismo `available`. `buildPublicSlots` se
 * convierte en un envoltorio de esto en B3.2.
 */
import { isHoldingCapacity, overlapBlocks } from "@/lib/booking-capacity";
import { formatWallTime, instantAt } from "@/lib/availability/day";
import { intervalCapState, intervalStartsUsed } from "@/lib/availability/interval-cap";
import { isOtherServiceConflict } from "@/lib/availability/exclusive-service";
import type { BuildSlotsInput, SlotResult, SlotUnavailableReason } from "@/lib/availability/types";

const MIN_MS = 60_000;
const DAY_MS = 24 * 60 * MIN_MS;
/** Ventana sin bordes (los límites de `Date`): con ella `isOtherServiceConflict` solo decide servicio, paciente y
 *  retención, y el solape con cada slot se mide con los intervalos ya armados. */
const ALL_TIME = { start: new Date(-8.64e15), end: new Date(8.64e15) };

export function buildSlots(input: BuildSlotsInput): SlotResult[] {
  const { dayKey, stepMin, durationMin, lead, now, cap } = input;
  const ic = input.intervalCap ?? null;
  // Sin esto un paso 0 (config rota) cuelga el request.
  if (!(stepMin > 0) || !(durationMin > 0)) return [];

  const holding = input.bookings
    .filter((b) => isHoldingCapacity(b, now))
    .map((b) => ({ start: b.scheduledFor.getTime(), end: b.scheduledFor.getTime() + b.durationMin * MIN_MS }));
  const ex = input.exclusive ?? null;
  const otherBusy = ex
    ? ex.bookings
        .filter((b) => isOtherServiceConflict(b, { serviceId: ex.serviceId, patientId: ex.patientId, now, ...ALL_TIME }))
        .map((b) => ({ start: b.scheduledFor.getTime(), end: b.scheduledFor.getTime() + b.durationMin * MIN_MS }))
    : [];
  const nowMs = now.getTime();
  const earliest = nowMs + lead.minMinutes * MIN_MS;
  const latest = lead.maxDays == null ? Infinity : nowMs + lead.maxDays * DAY_MS;

  const ranges = [...input.ranges].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  const seen = new Set<number>();
  const out: Array<SlotResult & { at: number }> = [];
  for (const range of ranges) {
    for (let m = range.startMin; m + durationMin <= range.endMin; m += stepMin) {
      const at = instantAt(dayKey, m).getTime();
      // Dos franjas que se pisan (dos sedes mal cargadas) no duplican el instante.
      if (seen.has(at)) continue;
      seen.add(at);
      const end = at + durationMin * MIN_MS;
      const used = holding.filter((b) => b.start < end && b.end > at).length;
      let reason: SlotUnavailableReason | null = null;
      if (at < nowMs) reason = "pasado";
      else if (at < earliest) reason = "anticipacion-minima";
      else if (at > latest) reason = "fuera-de-horizonte";
      else if (overlapBlocks(used, cap)) reason = "cupo-completo";
      else if (otherBusy.some((b) => b.start < end && b.end > at)) reason = "otro-servicio";
      // T3 (C-AS3): `m` ya es el reloj de pared AR del slot (minutos desde la medianoche de `dayKey`), así el
      // bucket sale sin un `Intl` por slot. Se cuenta contra `ic.bookings` (todos los del profesional), no contra
      // `input.bookings` (ya filtrados al servicio).
      const used2 = ic
        ? intervalStartsUsed(ic.bookings, {
            practitionerId: ic.practitionerId,
            when: new Date(at),
            intervalMin: ic.cap.intervalMin,
            now,
            wallMin: m,
          })
        : 0;
      if (reason == null && ic && intervalCapState(used2, ic.cap) === "full") reason = "tope-intervalo";
      out.push({
        at,
        iso: new Date(at).toISOString(),
        time: formatWallTime(m),
        available: reason == null,
        reason,
        used,
        cap,
        ...(ic ? { intervalCapUse: { used: used2, cap: ic.cap } } : {}),
      });
    }
  }
  return out.sort((a, b) => a.at - b.at).map(({ at: _at, ...slot }) => slot);
}
