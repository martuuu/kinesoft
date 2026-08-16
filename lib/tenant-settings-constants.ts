/**
 * Constants extracted from `lib/tenant-settings.ts` because that file
 * is `"use server"` — and Next.js only allows async function exports
 * from server-action modules. Pure values live here so the UI can
 * import them without dragging in the server bundle.
 */

export const BUSINESS_HOUR_MIN = 6;
export const BUSINESS_HOUR_MAX = 23;

/**
 * Agenda row granularity (minutes per row). Only these two are supported:
 * 60 keeps the classic one-row-per-hour agenda; 30 gives half-hour rows so a
 * 13:30 turno gets its own labelled row.
 */
export const AGENDA_SLOT_OPTIONS = [60, 30] as const;
export type AgendaSlotMinutes = (typeof AGENDA_SLOT_OPTIONS)[number];
export const DEFAULT_AGENDA_SLOT_MINUTES: AgendaSlotMinutes = 60;

export function isAgendaSlotMinutes(v: unknown): v is AgendaSlotMinutes {
  return v === 30 || v === 60;
}
