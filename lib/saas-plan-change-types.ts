/**
 * Tipos del cambio de plan SaaS (PL-1c, contrato C-PL4, plan §20.5.3). Client-safe (solo tipos): los comparten el
 * núcleo (`lib/saas-plan-change-internal.ts`), las actions del consultorio y de Plataforma (PL-2c) y el drawer de
 * cambio de plan (PL-3a).
 */
import type { Role, SaasPlan } from "@prisma/client";
import type { SeatKind, SeatUsageByKind } from "@/lib/plan-catalog";
import type { PlanLimits } from "@/lib/saas-plans-types";
import type { TenantModule } from "@/lib/tenant-modules";

/**
 * Un miembro activo, con lo que queda colgado si pierde el acceso (solo conteos, sin PHI). `isOwner`/`isSelf` vienen
 * para que la UI los muestre sin casilla: el Titular nunca es candidato, ni quien está cambiando el plan.
 */
export type PlanChangeCandidate = {
  membershipId: string;
  userId: string;
  /** Nombre visible (nunca el email, decisión 19): «Usuario sin nombre» si no lo cargó. */
  name: string;
  role: Role;
  clinical: boolean;
  kind: SeatKind;
  isOwner: boolean;
  isSelf: boolean;
  futureBookings: number;
  assignedPatients: number;
  activePlans: number;
};

export type PlanChangePreview = {
  from: SaasPlan;
  to: SaasPlan;
  /** Límites efectivos del plan destino (con los overrides del consultorio). */
  limits: PlanLimits;
  /** Uso actual (miembros activos + invitaciones vigentes) medido contra `limits`. */
  usage: SeatUsageByKind;
  /**
   * Mínimo a deshabilitar entre los miembros activos: al menos `professional` profesionales, `staff` no clínicos y
   * `total` personas en total (puede ser más que la suma de los tipos cuando lo que se pasa es el total).
   */
  mustDisable: { professional: number; staff: number; total: number };
  candidates: PlanChangeCandidate[];
  /** Invitaciones que se anulan si se deshabilita el mínimo (las más nuevas primero: entran las más viejas). */
  invitesToRevoke: { invitationId: string; email: string; role: Role }[];
  /** Deshabilitados por una baja de plan anterior (`PLAN_DOWNGRADE`): se pueden reactivar si entran. */
  reactivatable: { membershipId: string; name: string; role: Role; clinical: boolean; disabledAt: string }[];
  modulesLost: TenantModule[];
  modulesGained: TenantModule[];
  /** Precio de lista del plan destino (centavos ARS); null = «Consultá». */
  priceCents: number | null;
  /** `Tenant.updatedAt` leído: vuelve como `expectedUpdatedAt` (CAS). */
  tenantUpdatedAt: string;
};

export type ApplyPlanChangeReason =
  | "stale"
  | "not_found"
  | "does_not_fit"
  | "owner_selected"
  | "self_selected"
  | "invalid_selection"
  | "libre_platform_only";

export type ApplyPlanChangeResult =
  | { ok: true; disabled: number; reactivated: number; revokedInvites: number }
  | { ok: false; reason: ApplyPlanChangeReason; detail?: string };
