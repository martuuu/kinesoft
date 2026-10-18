import {
  FORCE_PROMPT_ORDER,
  forcePromptConfirm,
  intervalCapNoticeFromServer,
  nextForcePrompt,
  withForce,
  type ForceAction,
  type ForceFlags,
  type ForceableResult,
} from "@/lib/booking-force-flags";
import type { BookingIntervalCapNotice } from "@/lib/bookings-types";

/**
 * T3e-2u2 (C-AS3): helpers puros de los callers de `updateBooking` /
 * `setBookingStatus` que muestran los avisos forzables (drawer, vista Turnos del
 * paciente). Sin dependencias de server: se importan desde componentes cliente.
 */

/**
 * Texto informativo de un `ok: true`: el `notice` del plan (S12/C4) y el aviso del
 * 2.º turno del intervalo (`intervalCapNotice`, «Ya hay 1 turno de Ana a las
 * 10:00.»), que NO se confirma ni manda flag. null si no hay nada que decir.
 */
export function successInfoText(r: {
  notice?: string | null;
  intervalCapNotice?: BookingIntervalCapNotice | null;
}): string | null {
  const parts: string[] = [];
  if (r.notice) parts.push(r.notice);
  if (r.intervalCapNotice) parts.push(intervalCapNoticeFromServer(r.intervalCapNotice));
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * Tope de llamadas de un reintento con confirmaciones: una por cada clase de
 * aviso forzable + la final. Por qué: la vista Turnos tenía un `for` fijo de 5
 * intentos (pensado para 4 avisos, B5.7); con la sala (SR) y el tope por
 * intervalo (T3) hay 6 clases, y si el usuario aceptaba el 5.º aviso el loop
 * salía sin la última llamada y revertía la fila en silencio. Atado al orden del
 * server, sumar una clase nueva ya no lo rompe.
 */
export const MAX_FORCE_ATTEMPTS = FORCE_PROMPT_ORDER.length + 1;

export type ForceRetryOutcome<R> =
  | { kind: "ok"; result: R }
  | { kind: "cancelled" }
  | { kind: "error"; error: string };

/**
 * Llama, y mientras el resultado traiga un aviso forzable nuevo (`nextForcePrompt`),
 * lo confirma con `ask` (copy de `forcePromptConfirm`: «Cargar como sobreturno»,
 * «Reactivar como sobreturno»…) y re-llama ACUMULANDO los flags. Un aviso cuyo
 * flag ya se mandó que vuelve es error real (sin loop).
 */
export async function retryWithForce<R extends ({ ok: true } | ({ ok: false; error: string } & ForceableResult))>(
  call: (force: ForceFlags) => Promise<R>,
  ask: (opts: ReturnType<typeof forcePromptConfirm>) => Promise<boolean>,
  action: ForceAction
): Promise<ForceRetryOutcome<Extract<R, { ok: true }>>> {
  let force: ForceFlags = {};
  for (let attempt = 0; attempt < MAX_FORCE_ATTEMPTS; attempt++) {
    const r = await call(force);
    if (r.ok) return { kind: "ok", result: r as Extract<R, { ok: true }> };
    const failed = r as Extract<R, { ok: false }>;
    const prompt = nextForcePrompt(failed, force);
    if (!prompt) return { kind: "error", error: failed.error };
    if (!(await ask(forcePromptConfirm(prompt, action)))) return { kind: "cancelled" };
    force = withForce(force, prompt);
  }
  return { kind: "error", error: "No pudimos actualizar el turno" };
}
