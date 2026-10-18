/**
 * Candado de día (B4.4 AG-lock, plan §11.3) — lógica PURA del BOTÓN: estado,
 * motivo, tooltip y rótulo corto.
 *
 * T3a-0z2 (19-oct, §23.2 «Bundle /agenda 178,1/180»): todo lo del diálogo
 * (estado del formulario, validación, payload, copy del resultado, qué se
 * puede quitar) se mudó a `lib/day-lock-form.ts`. El botón va en el chunk
 * inicial de /agenda y webpack arrastra el módulo ENTERO: con el copy del
 * diálogo acá, ~2 kB de strings viajaban en cada carga aunque el diálogo es
 * `next/dynamic`. Este archivo solo lo importa el botón; no re-exportar acá
 * nada del form (volvería a meterlo en el first-load).
 *
 * Sin React, sin DB, sin reloj propio. Lo cubre `tests/unit/day-lock-state.test.ts`.
 */
import type { DayLockState, DayLockStatus } from "@/lib/availability/types";

// ─────────────────────────────────────────────────────────────────────────────
// Botón
// ─────────────────────────────────────────────────────────────────────────────

/** El botón acepta el `DayLockState` del motor o el estado ya resuelto. */
export function lockStatusOf(state: DayLockState | DayLockStatus): DayLockStatus {
  return typeof state === "string" ? state : state.status;
}

/**
 * Motivo legible: el `reason` explícito gana; si no, el `detail` del motor
 * (texto del bloqueo/excepción) o una frase por el tipo de cierre.
 */
export function lockReasonOf(state: DayLockState | DayLockStatus, reason?: string | null): string | null {
  if (reason && reason.trim()) return reason.trim();
  if (typeof state === "string" || state.status === "open") return null;
  if (state.detail) return state.detail;
  if (state.reason === "sin-franjas") return "No hay atención ese día";
  if (state.reason === "excepcion-cerrado") return "Cerrado";
  return null;
}

/** Tooltip / aria-label del candado. `canAct` = abre el diálogo. */
export function dayLockTooltip(status: DayLockStatus, reason: string | null, canAct = true): string {
  const why = reason ? `: ${reason}` : "";
  if (status === "locked") return `Día bloqueado${why}.${canAct ? " Tocá para ver o desbloquear." : ""}`;
  if (status === "partial") return `Día bloqueado en parte${why}.${canAct ? " Tocá para ver o cambiar." : ""}`;
  return canAct ? "Bloquear el día" : "Día abierto";
}

export function dayLockShortLabel(status: DayLockStatus): string {
  return status === "locked" ? "Bloqueado" : status === "partial" ? "En parte" : "Bloquear";
}
