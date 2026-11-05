/**
 * Tipos del catálogo de planes SaaS (PL, plan §20.5; contrato C-PL3). Puro y client-safe: lo comparten el escritor
 * de entitlements, los cupos, el cambio de plan, Configuración, Plataforma y la landing.
 */
import type { Role, SaasPlan } from "@prisma/client";

/** Límites de usuarios de un plan. `null` = sin límite (Libre o override). */
export type PlanLimits = { maxUsers: number | null; maxProfessionals: number | null; maxStaff: number | null };

export type SaasPlanConfigRow = {
  plan: SaasPlan;
  label: string;
  priceCents: number | null;
  limits: PlanLimits;
  trialDays: number;
  isPublic: boolean;
  sortOrder: number;
};

/** Overrides por consultorio (Libre y excepciones), columnas de `Tenant`. */
export type PlanLimitOverrides = {
  maxUsersOverride: number | null;
  maxProfessionalsOverride: number | null;
  maxStaffOverride: number | null;
};

/**
 * Acceso de un miembro (C-PL5). Vive acá (y no en `lib/roles.ts`) para que cupos, capacidades y sesión lo compartan
 * sin depender entre sí en la misma ola. `clinical` solo significa algo en OWNER/ADMIN: PRACTITIONER siempre atiende,
 * ASSISTANT/BILLING nunca.
 *
 * CT-K1 (CF3b, M23): `grantCoOwner` = «Co-titular» (`Membership.grantCoOwner`, solo PRACTITIONER por CHECK). Opcional
 * a propósito: ausente vale `false`, que es MENOS permiso (falla cerrado), y así los ~40 fixtures que arman un
 * MemberAccess a mano siguen compilando. Las lecturas reales lo traen siempre: `MEMBER_ACCESS_SELECT`
 * (lib/capabilities.ts), la foto de `loadAccessMemberships` (lib/session.ts) y `getMemberAccess` (lib/authz.ts); un
 * select a mano sin él lo frena `tests/unit/pl-ownership-guard.test.ts` [CT-K1-6].
 */
export type MemberAccess = { role: Role; clinical: boolean; grantSettings: boolean; grantBilling: boolean; grantCoOwner?: boolean };
