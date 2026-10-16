/**
 * Muro de módulo (VX2-b2, D-VX20): qué hace el `layout.tsx` de un segmento cuando el consultorio no tiene el módulo.
 *
 * Antes (EV0) `guardModuleSegment` (`lib/authz.ts`) redirigía siempre a /dashboard: un consultorio Kine Individual que
 * entraba a /sala rebotaba sin saber por qué, aunque el plan Clínica se la abría. D-VX20 separa los dos casos:
 *  - el módulo lo trae un plan **mayor** en su vertical → muro con upsell (`{ plan, canBuy }`);
 *  - el módulo **no existe en la vertical** (`minimumPlanFor` = null, p. ej. Diagnóstico en General) → redirect a
 *    /dashboard como hoy: no se le vende Kine a un General.
 *
 * El muro es UX, nunca barrera: no abre nada. Cada action del módulo sigue con `assertModule`/`requireModule`, y el
 * layout no se re-ejecuta en cada navegación suave (ver la regla en `lib/authz.ts`). Además Next renderiza el layout y
 * la página EN PARALELO: sin el módulo la página igual correría sus queries (y `assertModule` tiraría `ForbiddenError`
 * al log en cada visita al muro), así que cada `page.tsx` de un segmento con muro corta al inicio con
 * `if ((await moduleWall("<módulo>")) !== "ok") return null;` (VX-Z B1; lo exige `tests/unit/module-wall-page-cut.test.ts`).
 *
 * El tenant sale del actor de la sesión (`actor.entitlements`, misma fila de Tenant que `buildActor` ya trae): ningún
 * input del cliente decide el muro.
 */
import "server-only";
import type { SaasPlan } from "@prisma/client";
import { capabilitiesForActor } from "@/lib/authz";
import { tryGetActor } from "@/lib/session";
import type { Capability } from "@/lib/capabilities";
import { minimumPlanFor, modulesFor, planRank, type TenantEntitlements, type TenantModule } from "@/lib/tenant-modules";

/** `canBuy` = el actor puede cambiar el plan (`account.billing`: Titular o «Planes y pagos»). */
export type ModuleWallBlock = { plan: SaasPlan; canBuy: boolean };
export type ModuleWallResult = "ok" | "redirect" | ModuleWallBlock;

/**
 * Decisión pura (testeable sin sesión). Upsell solo si un plan superior lo desbloquea: si el plan mínimo no es mayor
 * que el actual (p. ej. `turneroPublico`, que es un switch y no depende del plan) no hay plan que vender → redirect.
 */
export function moduleWallFor(
  e: TenantEntitlements,
  m: TenantModule,
  caps: ReadonlySet<Capability>,
): ModuleWallResult {
  if (modulesFor(e).has(m)) return "ok";
  const plan = minimumPlanFor(m, e.vertical);
  if (plan === null) return "redirect";
  // `planRank` (orden de `lib/tenant-modules.ts`): plan desconocido = el más chico (falla cerrado).
  if (planRank(plan) <= planRank(e.plan)) return "redirect";
  return { plan, canBuy: caps.has("account.billing") };
}

/**
 * Para el `layout.tsx` de un segmento de módulo. Sin actor → "ok" (no-op, como `guardModuleSegment`): de la sesión se
 * ocupan el middleware y el layout de `(app)`, y redirigir acá haría un doble redirect.
 */
export async function moduleWall(m: TenantModule): Promise<ModuleWallResult> {
  const actor = await tryGetActor();
  if (!actor) return "ok";
  if (modulesFor(actor.entitlements).has(m)) return "ok";
  // Las capacidades solo hacen falta para el muro (cero queries en el camino feliz; con `actor.membership` tampoco acá).
  return moduleWallFor(actor.entitlements, m, await capabilitiesForActor(actor));
}
