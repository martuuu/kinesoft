/**
 * Lógica pura de /plataforma consultorios (PL-1d, plan §20.5.3). Client-safe y sin I/O: la usa la action
 * `updatePlatformTenant` (guard de cupos) y la prueban los unit tests sin base.
 */
import type { PlanLimits } from "@/lib/saas-plans-types";

/** Usuarios que hoy ocupan lugar (miembros habilitados + invitaciones pendientes, PL-D3), por tipo. */
export type SeatCounts = { total: number; professional: number; staff: number };

const DIMENSIONS = [
  { key: "maxUsers", count: "total", noun: ["usuario", "usuarios"] },
  { key: "maxProfessionals", count: "professional", noun: ["profesional", "profesionales"] },
  { key: "maxStaff", count: "staff", noun: ["persona no clínica", "personas no clínicas"] },
] as const satisfies readonly { key: keyof PlanLimits; count: keyof SeatCounts; noun: readonly [string, string] }[];

/** null = sin límite. */
function isLower(after: number | null, before: number | null): boolean {
  if (after === null) return false;
  return before === null || after < before;
}

/**
 * ¿El cambio de `before` a `after` ACHICA algún límite por debajo de lo que ya se usa? Devuelve el copy del primer
 * tipo que no entra, o null si el cambio se puede aplicar sin dejar a nadie afuera.
 *
 * Por qué solo «achica»: después de M8 puede haber consultorios ya pasados de cupo (un FREE viejo con tres
 * profesionales quedó INDIVIDUAL, 1 usuario). Rechazar todo lo que no entra le impediría a Plataforma justamente
 * subirles el plan o el cupo; lo que no se deja es empeorar el desfasaje desde un Drawer que no elige quiénes
 * pierden el acceso (eso es «Cambiar de plan», `applyPlanChangeInTx`).
 */
export function limitsShrinkBelowUsage(used: SeatCounts, before: PlanLimits, after: PlanLimits): string | null {
  for (const d of DIMENSIONS) {
    const limit = after[d.key];
    const n = used[d.count];
    if (limit !== null && n > limit && isLower(limit, before[d.key])) {
      const [one, many] = d.noun;
      return `Con ese cambio el límite es de ${limit} ${limit === 1 ? one : many} y hoy hay ${n} (contando invitaciones pendientes).`;
    }
  }
  return null;
}
