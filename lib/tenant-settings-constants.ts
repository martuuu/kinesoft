/**
 * Constants extracted from `lib/tenant-settings.ts` because that file
 * is `"use server"` — and Next.js only allows async function exports
 * from server-action modules. Pure values live here so the UI can
 * import them without dragging in the server bundle.
 */

export const BUSINESS_HOUR_MIN = 6;
export const BUSINESS_HOUR_MAX = 23;

/**
 * Agenda row granularity (minutes per row). 60 keeps the classic one-row-per-hour agenda; 30 gives half-hour rows
 * so a 13:30 turno gets its own labelled row; 15 (T3, plan §23.8) gives quarter-hour rows for consultorios que dan
 * turnos de 15'. Sin CHECK en la base a propósito: el código de antes de T3 lee un 15 como 60 (no rompe), y un
 * valor desconocido se normaliza a 60 (`normalizeSlotMinutes`).
 */
export const AGENDA_SLOT_OPTIONS = [60, 30, 15] as const;
export type AgendaSlotMinutes = (typeof AGENDA_SLOT_OPTIONS)[number];
export const DEFAULT_AGENDA_SLOT_MINUTES: AgendaSlotMinutes = 60;

export function isAgendaSlotMinutes(v: unknown): v is AgendaSlotMinutes {
  return (AGENDA_SLOT_OPTIONS as readonly unknown[]).includes(v);
}

/**
 * `Tenant.agendaSlotMinutes` (Int sin CHECK) → una de las opciones. Desconocido = 60 (la grilla clásica): es lo
 * que hacía el `=== 30 ? 30 : 60` que esto reemplaza en Día/Semana (`agenda-utils.ts`, `agenda-client.tsx`,
 * `week-grid-view.tsx`), salvo que ahora 15 se respeta en vez de volverse 60 sin error.
 */
export function normalizeSlotMinutes(v: unknown): AgendaSlotMinutes {
  return isAgendaSlotMinutes(v) ? v : DEFAULT_AGENDA_SLOT_MINUTES;
}

/**
 * Minutos por fila de Día/Semana para un usuario (plan §23.8): su zoom SOLO si lo eligió (`zoomSet`), si no, la
 * granularidad del consultorio. Por qué `zoomSet` y no el zoom a secas: el default del zoom por usuario es 30
 * (`DEFAULT_AGENDA_VIEW_PREFS`), y si Día/Semana lo siguieran sin más, el deploy le cambiaba la grilla a todo
 * consultorio en 60 sin que nadie lo eligiera. Un zoom inválido (pref vieja o rota) cae al del consultorio.
 */
export function effectiveRowMinutes(
  prefs: { zoom: number; zoomSet?: boolean },
  tenantSlot: unknown
): AgendaSlotMinutes {
  if (prefs.zoomSet === true && isAgendaSlotMinutes(prefs.zoom)) return prefs.zoom;
  return normalizeSlotMinutes(tenantSlot);
}
