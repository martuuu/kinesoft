/**
 * CF-NAV (§28, decisión 7 de Martin, 30-oct): las pantallas clínicas del menú (Diagnóstico, Planes, Ejercicios,
 * Seguimiento y Terapia manual) son solo para quien tiene `clinical.read`. La Secretaria, Facturación, el Titular que
 * no atiende y el soporte de Plataforma («ve lo que ve la Secretaria») no las ven en el nav (`lib/nav.ts`) y, si llegan
 * por URL, el `layout.tsx` del segmento los manda a /dashboard.
 *
 * Igual que `moduleWall` (`lib/module-wall.ts`), es UX y no barrera: cada action sigue con su chequeo. Y como Next
 * renderiza layout y página EN PARALELO, cada `page.tsx` corta con
 * `if (!(await clinicalSurfaceAllowed())) return null;` justo después del corte de `moduleWall` (VX-Z B1), para no
 * correr queries de una pantalla que el layout no va a mostrar.
 *
 * Sin actor → `true` (no-op): de la sesión se ocupan el middleware y el layout de `(app)`; redirigir acá haría un doble
 * redirect. `capabilitiesForActor` resuelve con `actor.membership` (PL-1e): cero queries en el camino común.
 */
import "server-only";
import { capabilitiesForActor } from "@/lib/authz";
import { tryGetActor } from "@/lib/session";

export async function clinicalSurfaceAllowed(): Promise<boolean> {
  const actor = await tryGetActor();
  if (!actor) return true;
  return (await capabilitiesForActor(actor)).has("clinical.read");
}
