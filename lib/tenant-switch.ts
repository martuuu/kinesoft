"use server";

/**
 * Selector de consultorio del sidebar (IAM-3b). Decisión 6 de Martin (14-oct): **un mismo usuario puede trabajar en
 * varios consultorios**; al entrar elige en `/elegir-consultorio` (IAM-3a) y después cambia desde acá sin salir.
 *
 * Por qué una action propia y no el form de `/elegir-consultorio`: el selector es cliente y tiene que saber si salió
 * bien ANTES de navegar (la navegación es dura, `window.location.assign`, para que el realtime, los avisos de llegada
 * y todo el estado cliente arranquen de cero en el consultorio nuevo; un `redirect` de server action haría una
 * navegación blanda que conserva el AppShell montado con el canal del consultorio anterior).
 *
 * Sin `getActor()`: lo que se cambia es justamente a qué consultorio apunta el Actor. La barrera es
 * `setActiveTenant` (C-IAM7): usuario verificado + membresía USABLE leída en el momento; nunca se confía en el id
 * que manda el cliente. La respuesta no dice nada de otros consultorios (ni si existe el id pedido): un solo
 * mensaje para ajeno, suspendido o basura.
 */
import type { ActionResult } from "@/lib/validation";
import { ForbiddenError, UnauthenticatedError } from "@/lib/session";
import { setActiveTenant } from "@/lib/tenant-choice";
import { logger } from "@/lib/logger";

export async function switchTenant(tenantId: string): Promise<ActionResult> {
  try {
    // `setActiveTenant` valida la forma con zod (string 1..64) y tira ForbiddenError si no es string.
    await setActiveTenant(typeof tenantId === "string" ? tenantId : "");
    return { ok: true, data: undefined };
  } catch (err) {
    if (err instanceof UnauthenticatedError) return { ok: false, error: "Tu sesión venció. Volvé a iniciar sesión." };
    if (err instanceof ForbiddenError) {
      // Suspendido entre que se pintó el sidebar y el click, o un id adulterado.
      return { ok: false, error: "Ese consultorio ya no está disponible para tu usuario. Recargá la página y elegí otro." };
    }
    logger.error("session.tenant.switch.failed", { message: err instanceof Error ? err.message : "unknown" });
    return { ok: false, error: "No pudimos cambiar de consultorio. Probá de nuevo." };
  }
}
