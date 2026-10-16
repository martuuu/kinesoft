/**
 * P4-C (ES4, brief §3.5; §20.8 y PLANES §12 enmiendas EV0/SV): secciones del portal por módulos del consultorio. Una sola
 * fuente para las pages (gate server-side) y para el nav, así no se desincronizan (antes de ES4 cada page miraba su
 * módulo por su cuenta).
 *
 *   plan       ⇐ planes
 *   checkin    ⇐ planes ∧ evaluaciones
 *   ejercicios ⇐ planes ∧ ejercicios
 *   reservar   ⇐ turneroPublico
 *   cuenta     siempre (los turnos sueltos existen también en General)
 *   inicio     siempre
 *
 * NUNCA hay sección de historia clínica en el portal (EV2-D5): no está en el enum a propósito.
 *
 * Puro (solo `import type`): lo pueden importar las superficies del portal sin sumar bundle.
 */
import type { TenantModule } from "./tenant-modules";

export const PORTAL_SECTIONS = ["inicio", "plan", "cuenta", "ejercicios", "checkin", "reservar"] as const;
export type PortalSection = (typeof PORTAL_SECTIONS)[number];

// `modulesFor` devuelve sets memoizados: con un WeakMap el mismo set de módulos da el mismo set de secciones (identidad
// estable para props y deps de hooks) sin armarlo por request.
const memo = new WeakMap<ReadonlySet<TenantModule>, ReadonlySet<PortalSection>>();

export function portalSectionsFor(modules: ReadonlySet<TenantModule>): ReadonlySet<PortalSection> {
  const hit = memo.get(modules);
  if (hit) return hit;
  const out = new Set<PortalSection>(["inicio", "cuenta"]);
  if (modules.has("planes")) {
    out.add("plan");
    if (modules.has("evaluaciones")) out.add("checkin");
    if (modules.has("ejercicios")) out.add("ejercicios");
  }
  if (modules.has("turneroPublico")) out.add("reservar");
  memo.set(modules, out);
  return out;
}
