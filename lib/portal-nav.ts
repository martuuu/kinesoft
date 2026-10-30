/**
 * P4-C (ES4, brief §3.5; §20.8 y PLANES §12 enmiendas EV0/SV): secciones del portal por módulos del consultorio. Una sola
 * fuente para las pages (gate server-side) y para el nav, así no se desincronizan (antes de ES4 cada page miraba su
 * módulo por su cuenta).
 *
 *   plan       ⇐ planes
 *   ejercicios ⇐ planes ∧ ejercicios
 *   reservar   ⇐ turneroPublico
 *   cuenta     siempre (los turnos sueltos existen también en General)
 *   inicio     siempre
 *   documentos siempre (T4, C-FC8: la historia clínica es CORE en todas las verticales y planes; sin nada compartido
 *              la página muestra el vacío)
 *
 * NUNCA hay sección de historia clínica en el portal (EV2-D5, enmendada en T4): «documentos» es SOLO lo que el
 * profesional compartió con el paciente (la foto ya impresa de una ficha, `PatientDocument`), nunca la HC ni sus notas.
 * Por eso no hay ni habrá una sección «evoluciones» en el enum (lo fija `tests/unit/portal-nav.test.ts`).
 *
 * CF (30-oct, decisión de Martin §28.1 punto 4): se fue la sección `checkin` (⇐ planes ∧ evaluaciones). Era una EVA
 * 0..10 + notas que el paciente mandaba antes de la sesión; la EVA salió de toda la app. Las `EvaScore` con `source`
 * «checkin-…» que ya existen quedan en la base y en el export; el portal no las lee ni escribe más.
 *
 * Puro (solo `import type`): lo pueden importar las superficies del portal sin sumar bundle.
 */
import type { TenantModule } from "./tenant-modules";

export const PORTAL_SECTIONS = ["inicio", "plan", "cuenta", "documentos", "ejercicios", "reservar"] as const;
export type PortalSection = (typeof PORTAL_SECTIONS)[number];

// `modulesFor` devuelve sets memoizados: con un WeakMap el mismo set de módulos da el mismo set de secciones (identidad
// estable para props y deps de hooks) sin armarlo por request.
const memo = new WeakMap<ReadonlySet<TenantModule>, ReadonlySet<PortalSection>>();

export function portalSectionsFor(modules: ReadonlySet<TenantModule>): ReadonlySet<PortalSection> {
  const hit = memo.get(modules);
  if (hit) return hit;
  const out = new Set<PortalSection>(["inicio", "cuenta", "documentos"]);
  if (modules.has("planes")) {
    out.add("plan");
    if (modules.has("ejercicios")) out.add("ejercicios");
  }
  if (modules.has("turneroPublico")) out.add("reservar");
  memo.set(modules, out);
  return out;
}

/**
 * FC-4i (handoff de FC-4a): `?n=<sección>` en `/portal?c=<slug>` = a qué sección volver después de entrar. El mail
 * «Tenés un documento nuevo» lleva a `/portal/c/{slug}/documentos`; sin sesión esa página manda a `/portal?c=<slug>` y,
 * sin esto, después del login el paciente caía en el inicio del consultorio y tenía que buscar «Documentos».
 * Allow-list cerrada (hoy solo «documentos»): nunca un path libre en la URL (open redirect) ni un id.
 */
export const PORTAL_RETURN_SECTIONS = ["documentos"] as const;
export type PortalReturnSection = (typeof PORTAL_RETURN_SECTIONS)[number];

export function portalReturnSection(raw: unknown): PortalReturnSection | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === "string" && (PORTAL_RETURN_SECTIONS as readonly string[]).includes(v)
    ? (v as PortalReturnSection)
    : null;
}

/** Destino después del login: el consultorio (y su sección, si vino una válida) o el portal general. */
export function portalReturnPath(slug: string | null, section: PortalReturnSection | null): string {
  if (!slug) return "/portal";
  return section ? `/portal/c/${slug}/${section}` : `/portal/c/${slug}`;
}
