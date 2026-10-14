/**
 * Catálogo de planes SaaS del consultorio (BO1-C, contrato C-BO7; plan §19.10
 * BO-D1 y BO-D7).
 *
 * Puro y client-safe (solo `import type` de Prisma): lo usan el server (alta
 * desde Plataforma con su trial, núcleos de equipo de BO2-B que frenan la
 * invitación cuando no hay lugar) y la UI (Configuración → Equipo y /plataforma
 * muestran «3 de 10 lugares»). Antes de BO el plan solo decidía módulos
 * (`lib/tenant-modules.ts`); cupos y trial no existían en ningún lado.
 *
 * Qué NO hace este módulo: no escribe nada. `plan`, `trialEndsAt` y
 * `seatLimitOverride` los escribe solo el escritor único de entitlements
 * (`lib/tenant-entitlements-internal.ts`).
 */
import type { Role, TenantPlan } from "@prisma/client";
import { isClinicalRole } from "./roles";
import { PLAN_LABEL } from "./tenant-modules";

export type PlanCatalogEntry = {
  label: string;
  /** Profesionales (roles clínicos) que entran. null = sin límite (Enterprise, a medida). */
  seats: number | null;
  /** Días de prueba al dar de alta con este plan. 0 = sin trial. */
  trialDays: number;
};

/**
 * BO-D7: Free 1 · Base 3 · PRO 10 · Enterprise a medida (el número real se
 * pacta y se carga como `seatLimitOverride`; mientras no haya, no se limita).
 * BO-D1: el trial es de 14 días con PRO (las altas web arrancan en PRO para
 * probar todo); los demás planes no tienen trial — Free es gratis y Base o
 * Enterprise se dan de alta ya acordados.
 */
export const PLAN_CATALOG: Record<TenantPlan, PlanCatalogEntry> = {
  FREE: { label: PLAN_LABEL.FREE, seats: 1, trialDays: 0 },
  STARTER: { label: PLAN_LABEL.STARTER, seats: 3, trialDays: 0 },
  PRO: { label: PLAN_LABEL.PRO, seats: 10, trialDays: 14 },
  ENTERPRISE: { label: PLAN_LABEL.ENTERPRISE, seats: null, trialDays: 0 },
};

/**
 * Cupo efectivo de profesionales. El override de Plataforma gana siempre (para
 * arriba o para abajo, y también en Enterprise, que es donde se usa); la base
 * tiene un CHECK de que es NULL o ≥ 1. null = sin límite.
 */
export function seatLimitFor(t: { plan: TenantPlan; seatLimitOverride: number | null }): number | null {
  if (t.seatLimitOverride != null) return t.seatLimitOverride;
  return PLAN_CATALOG[t.plan].seats;
}

/**
 * Ocupan lugar los que atienden: los roles clínicos (`lib/roles.ts`), los
 * mismos que tienen `Practitioner` y son reservables. Secretaria y Facturación
 * no ocupan (BO-D7): si ocuparan, un Free no podría sumar a la Secretaria.
 */
export function consumesSeat(role: Role): boolean {
  return isClinicalRole(role);
}

export type SeatUsage = {
  used: number;
  limit: number | null;
  /** null cuando no hay límite. Nunca negativo. */
  remaining: number | null;
  full: boolean;
};

/**
 * Lugares usados = miembros clínicos + invitaciones clínicas pendientes (una
 * invitación reserva el lugar: si no, se podían mandar 10 invitaciones en un
 * Free y aceptarlas todas). El caller cuenta solo miembros activos y roles que
 * `consumesSeat`.
 *
 * Bajar de plan no saca a nadie (BO-D7): `used` puede quedar por encima de
 * `limit`; en ese caso `remaining` es 0 y `full` true — no se puede invitar a
 * otro profesional, pero los que están siguen.
 */
export function seatUsage(
  counts: { clinicalMembers: number; pendingClinicalInvites: number },
  limit: number | null,
): SeatUsage {
  const used = counts.clinicalMembers + counts.pendingClinicalInvites;
  if (limit == null) return { used, limit: null, remaining: null, full: false };
  return { used, limit, remaining: Math.max(0, limit - used), full: used >= limit };
}
