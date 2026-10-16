/**
 * Ventana de un bloqueo de horario: tope y 00:00 AR de un día. TS puro, sin zod.
 *
 * PF1-Z (D-PF5): salió de `lib/time-blocks-schemas.ts` (que se re-exporta desde acá) porque el candado de día y el
 * modo bloqueo del modal (`lib/day-lock-state.ts`, `lib/block-mode-state.ts`, cliente) solo necesitan esto, y al
 * importarlo de aquel archivo bajaban zod entero al JS inicial de /agenda.
 */
import { AR_OFFSET } from "@/lib/datetime-ar";

/** Tope de un bloqueo: más largo que esto es una licencia, no un candado. */
export const TIME_BLOCK_MAX_DAYS = 31;

/** 00:00 AR del día `dayKey`, como instante. */
export function arDayStart(dayKey: string): Date {
  return new Date(`${dayKey}T00:00:00${AR_OFFSET}`);
}
