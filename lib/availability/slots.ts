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
 *     `cupo-completo`;
 *   • `used` = turnos que sostienen cupo (`isHoldingCapacity`: una reserva
 *     pública impaga de más de 30 min ya no cuenta) y solapan el slot;
 *     `cap` null = ilimitado; lleno = `overlapBlocks(used, cap)`. Las dos
 *     funciones son las de `lib/booking-capacity.ts` sin cambios (AUDIT
 *     §5.18). El caller ya filtró profesional + servicio (decisión 5).
 *
 * Con la plantilla de fallback, paso 45 y anticipación 60 reproduce
 * `buildPublicSlots` (paridad en `tests/unit/availability-slots.test.ts`):
 * mismo instante, misma "HH:MM", mismo `available`. `buildPublicSlots` se
 * convierte en un envoltorio de esto en B3.2.
 */
import { isHoldingCapacity, overlapBlocks } from "@/lib/booking-capacity";
import { formatWallTime, instantAt } from "@/lib/availability/day";
import type { BuildSlotsInput, SlotResult, SlotUnavailableReason } from "@/lib/availability/types";

const MIN_MS = 60_000;
const DAY_MS = 24 * 60 * MIN_MS;

export function buildSlots(input: BuildSlotsInput): SlotResult[] {
  const { dayKey, stepMin, durationMin, lead, now, cap } = input;
  // Sin esto un paso 0 (config rota) cuelga el request.
  if (!(stepMin > 0) || !(durationMin > 0)) return [];

  const holding = input.bookings
    .filter((b) => isHoldingCapacity(b, now))
    .map((b) => ({ start: b.scheduledFor.getTime(), end: b.scheduledFor.getTime() + b.durationMin * MIN_MS }));
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
      out.push({
        at,
        iso: new Date(at).toISOString(),
        time: formatWallTime(m),
        available: reason == null,
        reason,
        used,
        cap,
      });
    }
  }
  return out.sort((a, b) => a.at - b.at).map(({ at: _at, ...slot }) => slot);
}
