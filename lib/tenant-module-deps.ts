/**
 * T3c-1p (plan §23.6, regla 4 del brief): dependencias entre módulos para los overrides de Plataforma.
 *
 * Por qué existe: con `moduleRevokes` (M12) Plataforma puede sacarle a un consultorio un módulo que otro necesita para
 * tener pantalla. Sin `planes`, «Sesiones» (el seguimiento cuelga de un plan) y «Plantillas de plan» quedan
 * habilitados pero sin dónde usarse; sin `ejercicios`, «Favoritos» y el catálogo de la plataforma viven en /biblioteca,
 * cuyo layout exige `ejercicios` (`app/(app)/biblioteca/layout.tsx`). Un consultorio en ese estado ve chips y menús
 * que rebotan contra el muro. La matriz del plan nunca arma ese estado (`baseModules` siempre trae juntos a un módulo
 * y a lo que necesita), así que solo lo puede producir un override: el escritor único lo rechaza contra el estado
 * FINAL (`lib/tenant-entitlements-internal.ts`) y la UI de Plataforma ofrece sacar los dependientes juntos.
 *
 * Puro (sin DB ni `server-only`): lo importan el escritor, la action y el Drawer de Plataforma.
 */
import { modulesFor, type TenantEntitlements, type TenantModule } from "@/lib/tenant-modules";

/** Módulo → el que necesita para funcionar. Uno solo por módulo (hoy no hay cadenas ni dependencias múltiples). */
export const MODULE_REQUIRES: Readonly<Partial<Record<TenantModule, TenantModule>>> = Object.freeze({
  sesiones: "planes",
  plantillas: "planes",
  favoritos: "ejercicios",
  ejerciciosGlobales: "ejercicios",
});

/** Los módulos que necesitan a `m` (en el orden de `MODULE_REQUIRES`). */
export function dependentsOf(m: TenantModule): TenantModule[] {
  return (Object.entries(MODULE_REQUIRES) as [TenantModule, TenantModule][])
    .filter(([, req]) => req === m)
    .map(([dep]) => dep);
}

/** Un módulo apagado del que dependen módulos que siguen prendidos. */
export type ModuleDependencyViolation = { module: TenantModule; dependents: TenantModule[] };

/**
 * Sobre el set EFECTIVO (`modulesFor`, ya con grants y revokes): cada módulo que no está y del que depende alguno que
 * sí está. Vacío = consistente. Se evalúa el estado final y no el patch, así tanto «saco Planes y dejo Sesiones»
 * como «concedo Favoritos con Ejercicios sacado» caen acá.
 */
export function moduleDependencyViolations(e: TenantEntitlements): ModuleDependencyViolation[] {
  const effective = modulesFor(e);
  const byRequired = new Map<TenantModule, TenantModule[]>();
  for (const [dep, req] of Object.entries(MODULE_REQUIRES) as [TenantModule, TenantModule][]) {
    if (!effective.has(dep) || effective.has(req)) continue;
    byRequired.set(req, [...(byRequired.get(req) ?? []), dep]);
  }
  return [...byRequired].map(([module, dependents]) => ({ module, dependents }));
}

/** «A», «A y B», «A, B y C». */
function joinY(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`;
}

/** «Para deshabilitar Planes de tratamiento, deshabilitá también Sesiones y Plantillas de plan.» */
export function moduleDependencyCopy(v: ModuleDependencyViolation, label: (m: TenantModule) => string): string {
  return `Para deshabilitar ${label(v.module)}, deshabilitá también ${joinY(v.dependents.map(label))}.`;
}

/**
 * Lo tira el escritor único (`applyTenantEntitlementsInTx`, source `platform`) cuando el patch de módulos deja un
 * dependiente prendido sin lo que necesita. No es un bug del caller (la action no puede saberlo sin la fila bajo
 * lock): la action lo atrapa y lo devuelve como error con `moduleDependencyCopy`. Tirarlo adentro de la tx la aborta
 * antes del UPDATE: no se escribe ni se audita nada.
 */
export class ModuleDependencyError extends Error {
  constructor(public violations: ModuleDependencyViolation[]) {
    super(`[tenant-entitlements] dependencias de módulos: ${violations.map((v) => `${v.module} ← ${v.dependents.join(",")}`).join("; ")}`);
    this.name = "ModuleDependencyError";
  }
}
