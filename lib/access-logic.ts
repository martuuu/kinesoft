/**
 * Lógica pura de acceso: qué consultorio usa una sesión y, si no hay
 * ninguno, por qué (IAM-0c, C-IAM2).
 *
 * Puro (sin DB, sin `next/*`): lo consumen `buildActor` y `getAccessSnapshot`
 * (`lib/session.ts`) desde IAM-3a; `kine_tenant` se lee como tenantId en
 * `getAccessSnapshot` desde IAM-3a.
 *
 * El bug que lo motiva (§19.1, [A] bucle de redirecciones): `buildActor`
 * toma la membresía aceptada más recientemente INVITADA (`invitedAt desc`) y,
 * si en ese consultorio no hay `Practitioner`, tira `no_membership` aunque el
 * usuario tenga otro consultorio que sí funciona. El layout lo manda a
 * /onboarding, que ve membresías y dice «done» → /dashboard → … Lo dispara un
 * kine de A que acepta B (el `Practitioner` es único global y quedó en A) o un
 * removido que acepta otra invitación. Acá la elección mira SOLO membresías
 * usables, así que una rota nunca tapa a una sana.
 */
import type { Role } from "@prisma/client";
import { isClinicalMember, PRACTITIONER_FOR_ALL_ROLES } from "@/lib/roles";

export type MembershipLite = {
  tenantId: string;
  role: Role;
  acceptedAt: Date | null;
  /** Llega con M6 (IAM-1). Ausente = habilitada. */
  disabledAt?: Date | null;
  /**
   * PL-1b (M8, C-PL5): ¿atiende? Solo cuenta en OWNER/ADMIN (`isClinicalMember`). Ausente = `true`, el default de
   * la columna: así un llamador que todavía no lo lee se comporta como antes de PL-1b (pide `Practitioner`).
   */
  clinical?: boolean;
  hasPractitioner: boolean;
};

type AccessOpts = { practitionerForAllRoles?: boolean };

type TenantPref = { cookieTenantId?: string | null; preferredTenantId?: string | null };

/**
 * Aceptada, sin `disabledAt` y, si hace falta, con `Practitioner`. Hace falta
 * para los miembros que atienden (`isClinicalMember`). Desde IAM-4a
 * `PRACTITIONER_FOR_ALL_ROLES` es `false`: la Secretaria y Facturación son
 * usables sin `Practitioner` (el Actor los admite con `practitionerId: null`).
 * PL-1b: tampoco lo necesita el Titular/Admin que no atiende (decisión 7: el
 * alta puede ser de un Administrador/a sin agenda, `bootstrapTenant({
 * ownerClinical: false })` no le crea profesional). Antes de PL-1b el rol solo
 * lo pedía y ese Titular quedaba en `missing_practitioner`.
 */
export function isUsableMembership(m: MembershipLite, opts?: AccessOpts): boolean {
  if (!m.acceptedAt) return false;
  if (m.disabledAt) return false;
  const forAll = opts?.practitionerForAllRoles ?? PRACTITIONER_FOR_ALL_ROLES;
  const clinical = isClinicalMember({ role: m.role, clinical: m.clinical ?? true });
  if ((forAll || clinical) && !m.hasPractitioner) return false;
  return true;
}

/**
 * Consultorio activo: cookie (si es usable) → preferido guardado (si es
 * usable) → la usable aceptada más recientemente. La cookie no se confía:
 * apunta a un consultorio ajeno o roto = se ignora (lo mismo que hace hoy
 * `buildActor` con el slug, pero sin caer en uno roto).
 *
 * Desempate por `acceptedAt` y no por `invitedAt`: a quien acepta una
 * invitación nueva lo esperamos en el consultorio que acaba de aceptar, no
 * en el que lo invitó último. Empate exacto → `tenantId` (determinístico,
 * no depende del orden de la query).
 */
export function chooseActiveTenant(ms: MembershipLite[], pref: TenantPref, opts?: AccessOpts): string | null {
  const usable = ms.filter((m) => isUsableMembership(m, opts));
  if (usable.length === 0) return null;
  const has = (id: string | null | undefined) => !!id && usable.some((m) => m.tenantId === id);
  if (has(pref.cookieTenantId)) return pref.cookieTenantId as string;
  if (has(pref.preferredTenantId)) return pref.preferredTenantId as string;
  const sorted = [...usable].sort((a, b) => {
    // `usable` ya garantiza acceptedAt != null.
    const diff = (b.acceptedAt as Date).getTime() - (a.acceptedAt as Date).getTime();
    if (diff !== 0) return diff;
    return a.tenantId < b.tenantId ? -1 : a.tenantId > b.tenantId ? 1 : 0;
  });
  return sorted[0].tenantId;
}

export type AccessState =
  | { kind: "ok"; tenantId: string }
  /** Ninguna membresía (aceptada o no). Una `Invitation` sin aceptar no es membresía: /onboarding la ofrece. */
  | { kind: "needs_onboarding" }
  | { kind: "no_access"; reason: "all_disabled" | "missing_practitioner" | "pending_only" };

/**
 * Estado de acceso de una sesión. Nunca devuelve `no_access` si hay una
 * membresía usable (eso es lo que corta el bucle).
 *
 * Sin ninguna usable, la razón:
 * - `missing_practitioner`: hay alguna aceptada y habilitada, pero sin
 *   `Practitioner`. Gana sobre las otras porque es la reparable (un admin o
 *   Plataforma le crea el profesional o le cambia el rol).
 * - `all_disabled`: hay aceptadas, todas deshabilitadas.
 * - `pending_only`: hay membresías pero ninguna aceptada.
 */
export function resolveAccessState(ms: MembershipLite[], pref: TenantPref, opts?: AccessOpts): AccessState {
  if (ms.length === 0) return { kind: "needs_onboarding" };
  const tenantId = chooseActiveTenant(ms, pref, opts);
  if (tenantId) return { kind: "ok", tenantId };
  const accepted = ms.filter((m) => m.acceptedAt);
  if (accepted.length === 0) return { kind: "no_access", reason: "pending_only" };
  if (accepted.some((m) => !m.disabledAt)) return { kind: "no_access", reason: "missing_practitioner" };
  return { kind: "no_access", reason: "all_disabled" };
}

export type InvitationLite = { acceptedAt: Date | null; expiresAt: Date; revokedAt?: Date | null };

/**
 * Estado de una invitación. Precedencia: aceptada → anulada → vencida →
 * pendiente. Aceptada primero porque es un hecho consumado (la membresía ya
 * existe); anular después de aceptar no la deshace (para eso está quitar o
 * suspender al miembro). Vence en el instante `expiresAt` (`<=`), igual que el
 * `expiresAt: { gt: now }` de las queries de invitaciones vivas.
 */
export function invitationStatus(i: InvitationLite, now: Date): "pending" | "accepted" | "expired" | "revoked" {
  if (i.acceptedAt) return "accepted";
  if (i.revokedAt) return "revoked";
  if (i.expiresAt.getTime() <= now.getTime()) return "expired";
  return "pending";
}

/**
 * ¿Se puede borrar este usuario de Supabase Auth sin perder nada? Solo los
 * «zombies» que dejan `inviteUserByEmail` al revocar/vencer o un alta
 * abandonada: nunca confirmó, nunca entró, sin `UserProfile`, sin membresías
 * y sin fichas de paciente vinculadas. Ante cualquier duda (incluido un
 * string vacío donde GoTrue manda null) NO: borrar de más es irreversible.
 */
export function canSafelyDeleteAuthUser(u: {
  emailConfirmedAt: string | null;
  lastSignInAt: string | null;
  hasProfile: boolean;
  membershipCount: number;
  patientLinks: number;
}): boolean {
  return (
    u.emailConfirmedAt === null &&
    u.lastSignInAt === null &&
    !u.hasProfile &&
    u.membershipCount === 0 &&
    u.patientLinks === 0
  );
}
