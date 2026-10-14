/**
 * Lógica pura del directorio global de usuarios y de la salud de Plataforma (BO2-C, plan §19.5 fila «C usuarios y
 * reparación»; absorbe la «4d» de IAM).
 *
 * El problema que ataca (§19.1, «cuentas muertas»): invitados sin contraseña, contraseña descartada por `signUp`,
 * usuarios de Auth huérfanos al revocar o vencer (el email queda «tomado»), borrar un usuario desde el dashboard de
 * Supabase choca con `UserProfile.email` único, membresías clínicas sin `Practitioner` (bucle de acceso), altas
 * abandonadas. Hasta BO2 nada de eso se veía sin entrar a la base: `/plataforma/salud` lo detecta y lo repara.
 *
 * Puro (sin DB, sin `next/*`, sin `server-only`) a propósito: lo consumen `lib/platform-users*.ts`,
 * `lib/platform-health-read.ts` y su unit test, y los TIPOS de los DTOs viven acá para que la UI de BO3-D (client
 * components) los importe sin arrastrar el canal service. Un archivo `"use server"` no puede exportar tipos.
 *
 * Fechas: todo es aritmética de instantes (ms), nunca reloj del host; mismo resultado en TZ=UTC y TZ=AR.
 */
import type { Role, TenantStatus } from "@prisma/client";
import { normalizeEmail } from "@/lib/email-match";

// ── Constantes ────────────────────────────────────────────────────────────────

/** Alta trabada: consultorio con más de esto sin `onboardingCompletedAt` (plan §19.5, «altas trabadas»). */
export const STALLED_ONBOARDING_DAYS = 14;
/** Lista corta de cada detector: el conteo es el total, la lista es para actuar sobre los primeros. */
export const HEALTH_SAMPLE_LIMIT = 10;
/** Página del directorio de usuarios. */
export const PLATFORM_USERS_PAGE_SIZE = 25;

/**
 * `ban_duration` de GoTrue al deshabilitar. GoTrue no tiene «para siempre»: acepta una duración de Go y calcula
 * `banned_until = now + d`. 100 años alcanza. Lo que corta el acceso a la app es `UserProfile.disabledAt`
 * (`getSessionBlock`); el ban además impide renovar el token y loguearse con contraseña o magic link.
 */
export const PLATFORM_BAN_DURATION = "876000h";

const DAY_MS = 86_400_000;

// ── Tipos de los DTOs (lista cerrada de campos: lo que no está acá no sale) ───

export type PlatformUserKind = "team" | "portal" | "orphan";
export type PlatformUserKindFilter = PlatformUserKind | "all";

/**
 * Fila del directorio. Para la parte de PORTAL solo hay un conteo: ser paciente en tal consultorio es dato de salud
 * (Ley 26.529), y el superadmin no es equipo clínico de nadie. Nunca se nombran los consultorios de las fichas.
 */
export type PlatformUserRow = {
  id: string;
  email: string;
  fullName: string | null;
  kind: PlatformUserKind;
  isPlatformAdmin: boolean;
  disabled: boolean;
  membershipCount: number;
  portalLinkCount: number;
  createdAt: string;
};

/** Usuario que existe en Auth pero no tiene `UserProfile` (aparece al buscar por email exacto). */
export type PlatformAuthOnlyHit = {
  authUserId: string;
  email: string | null;
  emailConfirmed: boolean;
  lastSignInAt: string | null;
  createdAt: string;
  /** `canSafelyDeleteAuthUser`: nunca confirmó, nunca entró, sin perfil, sin membresías ni fichas. */
  canDelete: boolean;
};

export type PlatformUserPage = {
  rows: PlatformUserRow[];
  total: number;
  page: number;
  pageSize: number;
  /** Solo si la búsqueda es un email exacto sin perfil y Auth lo conoce. */
  authOnly: PlatformAuthOnlyHit | null;
};

export type PlatformUserMembership = {
  membershipId: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  tenantStatus: TenantStatus;
  role: Role;
  accepted: boolean;
  acceptedAt: string | null;
  suspended: boolean;
  hasPractitioner: boolean;
};

export type PlatformUserAuthState =
  | {
      status: "ok";
      email: string | null;
      emailConfirmed: boolean;
      lastSignInAt: string | null;
      banned: boolean;
      /** El email de Auth difiere del de `UserProfile` (reparable con «sincronizar email»). */
      emailMismatch: boolean;
    }
  /** El perfil existe pero Auth no lo conoce (borrado desde el dashboard de Supabase). */
  | { status: "missing" }
  /** Auth no respondió o no está configurado en este entorno. */
  | { status: "unavailable" };

export type PlatformUserDetail = {
  id: string;
  email: string;
  fullName: string | null;
  kind: PlatformUserKind;
  isPlatformAdmin: boolean;
  disabled: boolean;
  disabledAt: string | null;
  disabledReason: string | null;
  createdAt: string;
  memberships: PlatformUserMembership[];
  /** Solo el conteo de fichas de paciente vinculadas: nunca de qué consultorios (ver `PlatformUserRow`). */
  portalLinkCount: number;
  auth: PlatformUserAuthState;
};

export type EmailDeliveryStatus = "sent" | "skipped" | "failed" | "blocked";

export type PlatformAccessLinkResult = {
  purpose: "activation" | "recovery";
  emailSent: boolean;
  emailStatus: EmailDeliveryStatus;
  /**
   * El link para copiar, SOLO si el mail no salió (entorno sin Resend, rebote). Con el mail enviado es null: el
   * superadmin no necesita ver una credencial de un clic de otra persona.
   */
  copyUrl: string | null;
};

export type PlatformUserToggleResult = {
  changed: boolean;
  /** false = la base quedó bien pero Auth no se actualizó (ban/desban): reintentar es seguro. */
  authSynced: boolean;
};

// Detectores de salud.

export type HealthDetector<T> =
  | { available: true; count: number; sample: T[] }
  /** El puerto de Auth no permite listar usuarios: el detector no corre (ver handoff de BO2-C). */
  | { available: false; count: null; sample: [] };

export type AuthOrphanRow = { authUserId: string; email: string | null; createdAt: string; canDelete: boolean };
export type ProfileOrphanRow = { userId: string; email: string; createdAt: string };
export type MissingPractitionerRow = { tenantId: string; tenantName: string; userId: string; email: string; role: Role };
export type PractitionerWithoutMembershipRow = { practitionerId: string; tenantId: string; tenantName: string; userId: string; email: string };
export type TenantWithoutOwnerRow = { tenantId: string; name: string; slug: string; status: TenantStatus };
export type ExpiredInvitationRow = { invitationId: string; tenantId: string; tenantName: string; email: string; role: Role; expiresAt: string };
export type StalledOnboardingRow = { tenantId: string; name: string; slug: string; createdAt: string };
export type EmailMismatchRow = { userId: string; profileEmail: string; authEmail: string };

export type PlatformHealthReport = {
  generatedAt: string;
  authOrphans: HealthDetector<AuthOrphanRow>;
  profilesWithoutAccess: HealthDetector<ProfileOrphanRow>;
  clinicalWithoutPractitioner: HealthDetector<MissingPractitionerRow>;
  practitionersWithoutMembership: HealthDetector<PractitionerWithoutMembershipRow>;
  tenantsWithoutOwner: HealthDetector<TenantWithoutOwnerRow>;
  expiredInvitations: HealthDetector<ExpiredInvitationRow>;
  stalledOnboarding: HealthDetector<StalledOnboardingRow>;
  emailMismatches: HealthDetector<EmailMismatchRow>;
};

// ── Lógica ───────────────────────────────────────────────────────────────────

/**
 * Equipo si tiene alguna membresía (o es superadmin: equipo de la plataforma aunque no tenga consultorio); paciente
 * de portal si solo tiene fichas vinculadas; huérfano si no tiene nada (perfil que no lleva a ningún lado).
 */
export function classifyPlatformUser(u: { membershipCount: number; portalLinkCount: number; isPlatformAdmin: boolean }): PlatformUserKind {
  if (u.membershipCount > 0 || u.isPlatformAdmin) return "team";
  if (u.portalLinkCount > 0) return "portal";
  return "orphan";
}

/** Estrictamente más de `STALLED_ONBOARDING_DAYS` desde el alta, sin terminarla. */
export function isStalledOnboarding(t: { createdAt: Date; onboardingCompletedAt: Date | null }, now: Date): boolean {
  if (t.onboardingCompletedAt) return false;
  return now.getTime() - t.createdAt.getTime() > STALLED_ONBOARDING_DAYS * DAY_MS;
}

/** Instante de corte para la query de altas trabadas (`createdAt < cutoff`), coherente con `isStalledOnboarding`. */
export function stalledOnboardingCutoff(now: Date): Date {
  return new Date(now.getTime() - STALLED_ONBOARDING_DAYS * DAY_MS);
}

/**
 * ¿Difieren los emails del perfil y de Auth? Normalizado. Sin email en Auth (cuenta solo-teléfono, GoTrue manda
 * `""` → el puerto da null) no hay con qué sincronizar: no se reporta.
 */
export function emailsDiffer(profileEmail: string, authEmail: string | null): boolean {
  if (!authEmail) return false;
  return normalizeEmail(profileEmail) !== normalizeEmail(authEmail);
}

type AuthLike = { id: string; email: string | null; emailConfirmedAt: string | null; lastSignInAt: string | null; createdAt: string; bannedUntil: string | null };

/** Usuarios de Auth sin `UserProfile` con el mismo id. */
export function authOrphansFrom<T extends AuthLike>(authUsers: readonly T[], profileIds: ReadonlySet<string>): T[] {
  return authUsers.filter((u) => !profileIds.has(u.id));
}

/** Perfiles cuyo email difiere del de su usuario de Auth (mismo id). Un perfil sin usuario de Auth no entra acá. */
export function emailMismatchesFrom(
  profiles: ReadonlyArray<{ id: string; email: string }>,
  authUsers: readonly AuthLike[]
): EmailMismatchRow[] {
  const byId = new Map(authUsers.map((u) => [u.id, u]));
  const out: EmailMismatchRow[] = [];
  for (const p of profiles) {
    const a = byId.get(p.id);
    if (a && a.email && emailsDiffer(p.email, a.email)) out.push({ userId: p.id, profileEmail: p.email, authEmail: normalizeEmail(a.email) });
  }
  return out;
}

/** Conteo + lista corta. `total` cuando la lista ya vino recortada por la query (take) y el conteo es aparte. */
export function summarize<T>(rows: readonly T[], total?: number): { available: true; count: number; sample: T[] } {
  return { available: true, count: total ?? rows.length, sample: rows.slice(0, HEALTH_SAMPLE_LIMIT) };
}

export function unavailableDetector<T>(): HealthDetector<T> {
  return { available: false, count: null, sample: [] };
}

/**
 * Por qué no se puede deshabilitar (null = se puede). Uno mismo: un superadmin que se corta el acceso por error no
 * tiene cómo volver. El último superadmin ACTIVO: la plataforma quedaría sin nadie que la administre (y
 * `set-platform-admin.ts` exige acceso a la base de prod).
 */
export function disableBlockReason(p: {
  actorId: string;
  targetId: string;
  targetIsActiveAdmin: boolean;
  activeAdminCount: number;
}): "self" | "last_admin" | null {
  if (p.actorId === p.targetId) return "self";
  if (p.targetIsActiveAdmin && p.activeAdminCount <= 1) return "last_admin";
  return null;
}

/** Quitar superadmin: nunca al último activo. Quitárselo a uno deshabilitado no reduce los activos. */
export function revokeAdminBlockReason(p: { targetIsActiveAdmin: boolean; activeAdminCount: number }): "last_admin" | null {
  if (p.targetIsActiveAdmin && p.activeAdminCount <= 1) return "last_admin";
  return null;
}

/** `bannedUntil` en el futuro. Un valor que no parsea se trata como «no baneado» (es solo informativo). */
export function isAuthBanned(u: { bannedUntil: string | null }, now: Date): boolean {
  if (!u.bannedUntil) return false;
  const t = Date.parse(u.bannedUntil);
  return Number.isFinite(t) && t > now.getTime();
}

/**
 * Activación si nunca confirmó o nunca entró (el invitado que quedó sin contraseña, §19.1); si no, recuperación.
 * El link es el mismo (recovery → /reset, donde elige contraseña); cambia el registro y el copy.
 */
export function accessLinkPurpose(u: { emailConfirmedAt: string | null; lastSignInAt: string | null }): "activation" | "recovery" {
  return !u.emailConfirmedAt || !u.lastSignInAt ? "activation" : "recovery";
}

/**
 * Confirmación extra para dar/quitar superadmin hasta que BO4 traiga MFA: el superadmin tipea el email del usuario.
 * Exacto normalizado; vacío o ausente nunca confirma.
 */
export function confirmEmailMatches(typed: string | null | undefined, email: string): boolean {
  if (typed == null) return false;
  const t = normalizeEmail(typed);
  return t !== "" && t === normalizeEmail(email);
}
