import "server-only";
import { notFound, redirect } from "next/navigation";
import { requirePlatformAdmin, type PlatformActor } from "@/lib/platform-actor";
import { readPlatformAssurance } from "@/lib/platform-mfa";
import { mfaStatusOf, platformNextOrDefault } from "@/lib/platform-mfa-logic";
import { safeNext } from "@/lib/safe-next";
import { ForbiddenError, UnauthenticatedError } from "@/lib/session";

/**
 * Puerta de las pantallas de `/plataforma-mfa` (BO4). Están FUERA de `app/(platform)` a propósito: ese layout exige
 * AAL2 y mandaría acá; si estas pantallas colgaran de él, el bucle sería inmediato.
 *
 * Mismo trato que el layout de `(platform)`: sin sesión → login con `next`; no superadmin (o deshabilitado) →
 * `notFound()` (no se revela que la sección existe). `requirePlatformAdmin(…, { mfaStep: true })` NO exige AAL2: es
 * la puerta para llegar a AAL2. Funcionan con el flag en `off` (así Martin se enrola en prod antes de prender
 * `enforce`).
 */
export async function mfaPageContext(
  selfPath: string,
  rawNext: string | string[] | undefined
): Promise<{ actor: PlatformActor; next: string; status: "verified" | "pending" | "none" | "unavailable" }> {
  const next = platformNextOrDefault(safeNext(typeof rawNext === "string" ? rawNext : undefined, "/plataforma"));
  let actor: PlatformActor;
  try {
    actor = await requirePlatformAdmin(undefined, { mfaStep: true });
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      redirect(`/login?next=${encodeURIComponent(`${selfPath}?next=${encodeURIComponent(next)}`)}`);
    }
    if (err instanceof ForbiddenError) notFound();
    throw err;
  }
  const assurance = await readPlatformAssurance();
  return { actor, next, status: assurance ? mfaStatusOf(assurance) : "unavailable" };
}
