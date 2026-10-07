/**
 * DTOs de /plataforma consultorios (EV0 · EV-P1, plan §15.4). Los consume la UI
 * de EV-P3 (server components + el Drawer "Editar suscripción").
 *
 * CONTRATO PHI: /plataforma cruza tenants sobre el canal service (BYPASSRLS) y
 * el superadmin NO es parte del equipo clínico de ningún consultorio. Estos tipos
 * son el allowlist de lo que sale: datos del consultorio, de su suscripción y
 * conteos. Ningún campo de paciente, turno, sesión, evaluación ni historia
 * clínica (ni nombres, ni notas, ni fechas individuales). Sumar una key acá es
 * sumarla a la lista de `tests/integration/platform-tenants.test.ts`, que la
 * fija a propósito.
 *
 * Fechas como string (ISO o "YYYY-MM-DD" del día AR) para que crucen al cliente
 * sin ambigüedad. Solo `import type` de Prisma: el cliente no carga el runtime.
 */
import type { SubscriptionStatus, TenantPlan, TenantVertical } from "@prisma/client";
import type { TenantModule } from "@/lib/tenant-modules";

export const PLATFORM_TENANTS_PAGE_SIZE = 50;
/** "Trials que vencen pronto" en el resumen: los que vencen en ≤ N días (o ya vencieron y siguen TRIALING). */
export const PLATFORM_TRIAL_WARNING_DAYS = 14;
/** Tope de filas de las listas del resumen (los totales van aparte). */
export const PLATFORM_OVERVIEW_LIST_LIMIT = 20;
/** Últimos eventos `platform.*` que muestra el detalle. */
export const PLATFORM_RECENT_EVENTS = 10;

/** Fila de la lista de consultorios. */
export type PlatformTenantRow = {
  id: string;
  name: string;
  slug: string;
  vertical: TenantVertical;
  plan: TenantPlan;
  subscriptionStatus: SubscriptionStatus;
  /** Día AR en que vence el trial ("YYYY-MM-DD"); null = sin trial. */
  trialEndsOn: string | null;
  publicBookingEnabled: boolean;
  /** `Tenant.onboardingCompletedAt != null`. */
  onboardingCompleted: boolean;
  /** Emails de las cuentas OWNER (staff, no pacientes). */
  ownerEmails: string[];
  /** Pacientes activos (sin archivar). Solo el número. */
  patientCount: number;
  /** Membresías aceptadas. */
  memberCount: number;
  /** ISO. */
  createdAt: string;
  /** Es el consultorio "casa" de algún superadmin (se marca "Plataforma"). */
  isPlatformHome: boolean;
};

export type PlatformTenantPage = {
  rows: PlatformTenantRow[];
  total: number;
  page: number;
  pageSize: number;
};

export type PlatformTenantCounts = {
  members: number;
  pendingInvitations: number;
  practitioners: number;
  patients: number;
  services: number;
  locations: number;
  bookingsTotal: number;
  bookingsLast30Days: number;
  bookingsUpcoming: number;
};

/** Un cambio de entitlement de un evento `platform.*` (enums, booleanos o fecha ISO). */
export type PlatformAuditChange = {
  key: string;
  before: string | boolean | null;
  after: string | boolean | null;
};

export type PlatformAuditEventRow = {
  id: string;
  /** `platform.<acción>`, p. ej. `platform.tenant.entitlements`. */
  action: string;
  /** ISO. */
  createdAt: string;
  /** Email del superadmin que lo hizo (null si la cuenta ya no existe). */
  actorEmail: string | null;
  changes: PlatformAuditChange[];
};

export type PlatformTenantDetail = PlatformTenantRow & {
  phone: string | null;
  whatsapp: string | null;
  publicEmail: string | null;
  /** Solo lectura desde /plataforma (EV-D6). */
  sharedPatientView: boolean;
  /** `modulesFor(vertical, plan, publicBookingEnabled)`, en el orden de `TENANT_MODULES`. */
  modules: TenantModule[];
  counts: PlatformTenantCounts;
  /** ISO de `max(AuditEvent.createdAt)` del consultorio; null = sin actividad registrada. */
  lastActivityAt: string | null;
  /** Últimos eventos `platform.*` del consultorio, del más nuevo al más viejo. */
  recentPlatformEvents: PlatformAuditEventRow[];
  /** Ruta del turnero público (`/c/<slug>/booking`), exista o no el switch. */
  publicBookingPath: string;
  /** ISO de `Tenant.updatedAt`: va como `expectedUpdatedAt` del CAS. */
  updatedAt: string;
};

export type PlatformVerticalPlanCount = {
  vertical: TenantVertical;
  plan: TenantPlan;
  count: number;
};

export type PlatformTrialRow = {
  id: string;
  name: string;
  slug: string;
  vertical: TenantVertical;
  plan: TenantPlan;
  trialEndsOn: string;
  /** Días AR hasta el vencimiento (0 = vence hoy; negativo = ya venció y sigue TRIALING). */
  daysLeft: number;
};

export type PlatformOnboardingRow = {
  id: string;
  name: string;
  slug: string;
  vertical: TenantVertical;
  plan: TenantPlan;
  /** ISO. */
  createdAt: string;
};

export type PlatformOverview = {
  totalTenants: number;
  /** Solo las combinaciones con al menos un consultorio. */
  byVerticalPlan: PlatformVerticalPlanCount[];
  /** TRIALING con vencimiento en ≤ PLATFORM_TRIAL_WARNING_DAYS días AR (incluye vencidos), el más urgente primero. */
  trialsEndingSoon: PlatformTrialRow[];
  trialsEndingSoonCount: number;
  /** Altas sin terminar (`onboardingCompletedAt` null), las más nuevas primero. */
  onboardingPending: PlatformOnboardingRow[];
  onboardingPendingCount: number;
  publicBookingEnabledCount: number;
};
