/**
 * CF2 (§29 D-CF2-7, brief A.4) — vista Mes de la agenda: tipos del resumen que devuelve `getAgendaMonthSummary`
 * (`lib/agenda-month.ts`). Client-safe: sin zod ni Prisma (lo importan la vista y `agenda-client-state`).
 *
 * Por qué un cable propio y no `listAgendaBookings` + `getAgendaAvailability` de 6 semanas: el mes de la Secretaria
 * (6 profesionales, ~1.000 turnos) eran ~600 kB de filas para pintar un número por celda. Acá viaja, por día y por
 * profesional, cuántos turnos hay (sin cancelados), cuántos de esos son ausentes y el candado del día. Nada de
 * pacientes (D-CF2-7: sin nombres en Mes) ni de bloqueos accionables (el candado no se abre desde Mes).
 *
 * Forma compacta a propósito (presupuesto ≤ 24 kB, A.5): claves de una letra y lo «normal» AUSENTE — un día sin turnos
 * no trae `c`, un profesional abierto no aparece en `l`, sin texto de bloqueo no hay `d`.
 */
import type { DayKey } from "@/lib/availability/types";

/** Tope de días del pedido: 6 semanas de lunes a domingo (`monthGridRange` nunca pide más). */
export const AGENDA_MONTH_MAX_DAYS = 42;

/**
 * Candado del día de un profesional, del `DayLockState` del motor:
 *   `p` = parcial (un bloqueo recorta parte de sus franjas);
 *   `l` = día completo cerrado (bloqueos que tapan todo o excepción CLOSED);
 *   `x` = sin franjas ese día (no atiende: `aggregateDayLock` no lo cuenta).
 * Ausente = abierto.
 */
export type MonthLockCode = "p" | "l" | "x";

export type AgendaMonthDay = {
  k: DayKey;
  /** Por profesional: `[turnos no cancelados (ausentes incluidos), de esos, ausentes]`. Ausente = 0 turnos. */
  c?: Record<string, readonly [active: number, noShow: number]>;
  /** Por profesional que NO está abierto ese día. */
  l?: Record<string, MonthLockCode>;
  /** Texto del bloqueo / excepción que explica un `p` o `l` (p. ej. «Vacaciones»), si tiene. */
  d?: Record<string, string>;
};

export type AgendaMonthSummary = {
  from: DayKey;
  to: DayKey;
  /** La sede pedida (null = todas). */
  locationId: string | null;
  /** Un elemento por día de `from` a `to`, en orden. */
  days: AgendaMonthDay[];
};

export type AgendaMonthQueryInput = { from: string; to: string; locationId?: string | null };
