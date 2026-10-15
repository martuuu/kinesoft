/**
 * Lógica pura de los planes SaaS (PL, plan §20.5; decisiones PL-D1/D2/D3). Client-safe.
 *
 * - `LEGACY_PLAN_OF`: el escritor único espeja `Tenant.plan` (enum viejo) desde `Tenant.saasPlan`, así un rollback
 *   del deploy deja datos coherentes (PL-D1: enum y columna nuevos, no renombre).
 * - `PLAN_DEFAULTS`: respaldo si falta la fila de `SaasPlanConfig` (la migración M8 las siembra con estos valores).
 */
import type { SaasPlan, TenantPlan } from "@prisma/client";
import type { PlanLimitOverrides, PlanLimits, SaasPlanConfigRow } from "@/lib/saas-plans-types";

export const SAAS_PLANS: readonly SaasPlan[] = ["INDIVIDUAL", "CONSULTORIO", "CLINICA", "LIBRE"] as const;

export const LEGACY_PLAN_OF: Record<SaasPlan, TenantPlan> = {
  INDIVIDUAL: "FREE",
  CONSULTORIO: "STARTER",
  CLINICA: "PRO",
  LIBRE: "ENTERPRISE",
};

export const SAAS_PLAN_OF_LEGACY: Record<TenantPlan, SaasPlan> = {
  FREE: "INDIVIDUAL",
  STARTER: "CONSULTORIO",
  PRO: "CLINICA",
  ENTERPRISE: "LIBRE",
};

export const PLAN_DEFAULTS: Record<SaasPlan, Omit<SaasPlanConfigRow, "plan">> = {
  INDIVIDUAL: { label: "Individual", priceCents: null, limits: { maxUsers: 1, maxProfessionals: 1, maxStaff: 1 }, trialDays: 14, isPublic: true, sortOrder: 1 },
  CONSULTORIO: { label: "Consultorio", priceCents: null, limits: { maxUsers: 5, maxProfessionals: 4, maxStaff: 1 }, trialDays: 0, isPublic: true, sortOrder: 2 },
  CLINICA: { label: "Clínica", priceCents: null, limits: { maxUsers: 10, maxProfessionals: null, maxStaff: null }, trialDays: 0, isPublic: true, sortOrder: 3 },
  LIBRE: { label: "Libre", priceCents: null, limits: { maxUsers: null, maxProfessionals: null, maxStaff: null }, trialDays: 0, isPublic: true, sortOrder: 4 },
};

/** Límites efectivos: cada override no nulo pisa el del plan. */
export function effectiveLimits(cfg: PlanLimits, o: PlanLimitOverrides): PlanLimits {
  return {
    maxUsers: o.maxUsersOverride ?? cfg.maxUsers,
    maxProfessionals: o.maxProfessionalsOverride ?? cfg.maxProfessionals,
    maxStaff: o.maxStaffOverride ?? cfg.maxStaff,
  };
}
