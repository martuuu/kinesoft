/**
 * Defaults y copy de los formularios legacy del tab Plan (P0-S02u-plan).
 *
 * Puro y sin "use client": lo importan `plan-view.tsx`,
 * `plan-template-apply.tsx` y su unit test, que corre en TZ=UTC y TZ=AR.
 */
import { toARDateKey } from "@/lib/datetime-ar";
import { PLAN_MAX_SESSIONS } from "@/lib/plans-constants";

/**
 * Valores iniciales y topes del alta de plan. Los topes espejan `ProgramCreate`
 * (S02a: 1..60 sesiones, frecuencia 1..7). Antes el input decía `max=64` y
 * `max=5`: el navegador dejaba cargar 61-64 sesiones que el server rechaza, y
 * no dejaba elegir 6 o 7 veces por semana, que el server sí acepta.
 */
export const PLAN_FORM_DEFAULTS = {
  title: "Plan kinésico",
  totalSessions: 8,
  frequency: 2,
  maxSessions: PLAN_MAX_SESSIONS,
  maxFrequency: 7,
} as const;

/**
 * "Hoy" en Argentina como `YYYY-MM-DD`, para el `defaultValue` de los
 * `<input type="date">` de inicio. El código viejo usaba
 * `new Date().toISOString().slice(0, 10)`, que es el día **UTC**: de 21:00 a
 * 23:59 AR proponía mañana como primera sesión (y `toISOString` es UTC en
 * cualquier host, así que pasaba también en el navegador del kinesiólogo).
 */
export function planFormTodayKey(now: Date = new Date()): string {
  return toARDateKey(now);
}

export type LegacyProgramStatus = "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED";

/**
 * Copy del `useConfirm` del selector de estado. Antes el `<select>` cambiaba el
 * estado al primer click, sin confirmar y tragándose el error del server.
 *
 * El copy describe lo que hace HOY `setProgramStatus` (legacy, hasta P2): solo
 * cambia el estado. No borra sesiones ni toca turnos de la agenda.
 * `cancelLabel` es "Volver" para que "Cancelar" no se confunda con "Cancelar
 * plan".
 */
export function programStatusConfirm(next: LegacyProgramStatus): {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  tone: "default" | "danger";
} {
  switch (next) {
    case "ACTIVE":
      return {
        title: "¿Reactivar el plan?",
        message: "El plan vuelve a figurar como activo.",
        confirmLabel: "Reactivar",
        cancelLabel: "Volver",
        tone: "default",
      };
    case "PAUSED":
      return {
        title: "¿Pausar el plan?",
        message: "Las sesiones cargadas se conservan. Podés reactivarlo cuando quieras.",
        confirmLabel: "Pausar",
        cancelLabel: "Volver",
        tone: "default",
      };
    case "COMPLETED":
      return {
        title: "¿Marcar el plan como completado?",
        message: "Las sesiones que falten quedan sin realizar. Podés volver a activarlo después.",
        confirmLabel: "Completar",
        cancelLabel: "Volver",
        tone: "default",
      };
    case "CANCELLED":
      return {
        title: "¿Cancelar el plan?",
        message:
          "Las sesiones cargadas se conservan. Los turnos de la agenda no se tocan: si había turnos para este plan, cancelalos desde la agenda.",
        confirmLabel: "Cancelar plan",
        cancelLabel: "Volver",
        tone: "danger",
      };
  }
}
