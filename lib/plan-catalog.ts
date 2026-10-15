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
import type { Role, SaasPlan, TenantPlan } from "@prisma/client";
import { isClinicalMember, isClinicalRole } from "./roles";
import { PLAN_LABEL } from "./tenant-modules";
import { PLAN_DEFAULTS, effectiveLimits } from "./saas-plans-logic";
import type { PlanLimitOverrides, PlanLimits } from "./saas-plans-types";

// ─────────────────────────────────────────────────────────────────────────────
// PL-1c (C-PL3, plan §20.5.3, PL-D3): cupos POR TIPO del plan SaaS nuevo.
//
// Decisión de Martin (§20.17, 15-oct): Individual 1 usuario · Consultorio 5 de cualquier tipo · Clínica 10 de
// cualquier tipo · Libre a medida (topes por tipo y total solo vía overrides de Plataforma, que valen solo en Libre:
// `effectiveLimits`). Antes (BO-D7) solo contaban los roles clínicos y la Secretaria entraba gratis en cualquier
// plan; desde PL-1c todos ocupan lugar. El tipo se sigue contando porque un Libre a medida puede topearlo. El
// Titular cuenta según atienda y las invitaciones pendientes reservan el lugar del tipo de su rol.
// ─────────────────────────────────────────────────────────────────────────────

/** «professional» = atiende (agenda, HC); «staff» = Secretaria, Facturación, o Titular/Admin que no atiende. */
export type SeatKind = "professional" | "staff";

/** El tipo de lugar que ocupa un miembro: la misma regla que «atiende» (`isClinicalMember`, C-PL5). */
export function seatKindOf(m: { role: Role; clinical: boolean }): SeatKind {
  return isClinicalMember(m) ? "professional" : "staff";
}

/** Uso de un tipo de lugar (o del total). `limit`/`remaining` null = sin límite. `remaining` nunca es negativo. */
export type SeatCount = { used: number; limit: number | null; remaining: number | null; full: boolean };

export type SeatUsageByKind = { total: SeatCount; professional: SeatCount; staff: SeatCount };

function seatCount(used: number, limit: number | null): SeatCount {
  if (limit == null) return { used, limit: null, remaining: null, full: false };
  return { used, limit, remaining: Math.max(0, limit - used), full: used >= limit };
}

/**
 * Uso por tipo con los límites efectivos. `c` = miembros ACTIVOS + invitaciones pendientes vigentes de cada tipo (el
 * caller cuenta; ver `getSeatUsageInTx`). Bajar de plan sin elegir a nadie (datos viejos, override achicado) puede
 * dejar `used > limit`: `full` queda true y no entra nadie de ese tipo, pero acá no se saca a nadie.
 */
export function seatUsageByKind(c: { professional: number; staff: number }, l: PlanLimits): SeatUsageByKind {
  return {
    total: seatCount(c.professional + c.staff, l.maxUsers),
    professional: seatCount(c.professional, l.maxProfessionals),
    staff: seatCount(c.staff, l.maxStaff),
  };
}

/** ¿Entra una persona más de este tipo? Tiene que haber lugar en el total Y en su tipo (un Libre a medida con topes por tipo). */
export function canAddSeat(u: SeatUsageByKind, k: SeatKind): boolean {
  return !u.total.full && !u[k].full;
}

/**
 * Límites efectivos de un plan: la fila de `SaasPlanConfig` (la edita Plataforma) o, si falta, `PLAN_DEFAULTS` (los
 * mismos valores que sembró M8), pisados por los overrides del consultorio solo en Libre (PL-Z a3#1).
 */
export function planLimitsFor(
  plan: SaasPlan,
  row: PlanLimits | null | undefined,
  overrides: PlanLimitOverrides
): PlanLimits {
  return effectiveLimits(row ?? PLAN_DEFAULTS[plan].limits, overrides, plan);
}

/** Lugares ocupados por tipo y total (el total puede no ser la suma cuando se razona sobre «mínimos»). */
export type SeatTally = { professional: number; staff: number; total: number };

function over(used: number, limit: number | null): number {
  return limit == null ? 0 : Math.max(0, used - limit);
}

/**
 * Cuántos miembros activos hay que sacar como mínimo para entrar en `l` (C-PL4, bajar de plan). Por tipo y en total:
 * en Individual (1 usuario) con 1 profesional + 1 Secretaria no sobra ningún tipo (1 ≤ 1 cada uno) pero sobra 1 en
 * el total, así que `total` puede ser mayor que `professional + staff`. Las invitaciones no cuentan acá: se anulan
 * después las que no entren (`invitesThatFit`).
 */
export function mustDisableFor(m: { professional: number; staff: number }, l: PlanLimits): SeatTally {
  const professional = over(m.professional, l.maxProfessionals);
  const staff = over(m.staff, l.maxStaff);
  const total = Math.max(professional + staff, over(m.professional + m.staff, l.maxUsers));
  return { professional, staff, total };
}

/**
 * Qué invitaciones pendientes siguen entrando después de fijar los miembros (`used`), en el orden dado (el caller
 * pasa las más viejas primero: la que se mandó antes conserva su lugar). Devuelve un booleano por invitación.
 */
export function invitesThatFit(used: SeatTally, l: PlanLimits, invites: readonly { kind: SeatKind }[]): boolean[] {
  const u = { ...used };
  const room = (n: number, limit: number | null) => limit == null || n + 1 <= limit;
  return invites.map((i) => {
    const kindLimit = i.kind === "professional" ? l.maxProfessionals : l.maxStaff;
    if (!room(u.total, l.maxUsers) || !room(u[i.kind], kindLimit)) return false;
    u.total++;
    u[i.kind]++;
    return true;
  });
}

/** ¿Los miembros (sin invitaciones) entran en los límites? */
export function membersFit(m: { professional: number; staff: number }, l: PlanLimits): boolean {
  return mustDisableFor(m, l).total === 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// LEGADO (BO1-C / BO-D7) — @deprecated desde PL-1c. Lo siguen leyendo Plataforma (alta y edición de consultorio,
// `components/plataforma/tenants/*`, PL-1d) y sus tests mientras migran al plan SaaS. Lo nuevo usa lo de arriba.
// ─────────────────────────────────────────────────────────────────────────────

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
/** @deprecated PL-1c: usar `PLAN_DEFAULTS` (lib/saas-plans-logic.ts) y `SaasPlanConfig`. */
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
/** @deprecated PL-1c: usar `planLimitsFor` + `seatUsageByKind`. */
export function seatLimitFor(t: { plan: TenantPlan; seatLimitOverride: number | null }): number | null {
  if (t.seatLimitOverride != null) return t.seatLimitOverride;
  return PLAN_CATALOG[t.plan].seats;
}

/**
 * Ocupan lugar los que atienden: los roles clínicos (`lib/roles.ts`), los
 * mismos que tienen `Practitioner` y son reservables. Secretaria y Facturación
 * no ocupan (BO-D7): si ocuparan, un Free no podría sumar a la Secretaria.
 */
/** @deprecated PL-1c: todos ocupan lugar; el tipo lo da `seatKindOf`. */
export function consumesSeat(role: Role): boolean {
  return isClinicalRole(role);
}

/** @deprecated PL-1c: usar `SeatCount` / `SeatUsageByKind`. */
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
/** @deprecated PL-1c: usar `seatUsageByKind`. */
export function seatUsage(
  counts: { clinicalMembers: number; pendingClinicalInvites: number },
  limit: number | null,
): SeatUsage {
  const used = counts.clinicalMembers + counts.pendingClinicalInvites;
  if (limit == null) return { used, limit: null, remaining: null, full: false };
  return { used, limit, remaining: Math.max(0, limit - used), full: used >= limit };
}
