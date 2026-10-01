import "server-only";
/**
 * Lecturas del signup de unión y del stepper de alta (A3c-S-signup). Las usan
 * los server components (`/signup`, `/onboarding`, el layout de la app) y las
 * actions de `lib/onboarding.ts`. Vive fuera del `"use server"` porque exporta
 * tipos y helpers que no son actions.
 */
// Pre-membresía (el usuario todavía no tiene tenant, o lo está creando): no hay
// Actor ni GUC para leer Invitation/Membership de forma tenant-scoped → canal
// service, con el filtro por userId/email a mano. Lo del tenant propio, una vez
// que existe, va por `runWithRls`. See lib/db.ts.
import { prismaService } from "@/lib/db";
import { runWithRls } from "@/lib/rls";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { hashInviteToken } from "@/lib/invitations-tokens";
import type { OnboardingProgress } from "@/lib/onboarding-logic";

export type SessionUser = {
  id: string;
  email: string;
  emailVerified: boolean;
  fullName: string | null;
};

/** Usuario de Supabase validado contra el server (`getUser`, no `getSession`). */
export async function getSessionUser(): Promise<SessionUser | null> {
  let u;
  try {
    const { data, error } = await getSupabaseServerClient().auth.getUser();
    if (error || !data.user?.id || !data.user.email) return null;
    u = data.user;
  } catch {
    // Supabase caído / sin configurar (dev local): se trata como sin sesión.
    return null;
  }
  return {
    id: u.id,
    email: u.email!.toLowerCase(),
    emailVerified: !!u.email_confirmed_at,
    fullName: (u.user_metadata?.full_name as string | undefined) ?? null,
  };
}

/**
 * Staff ≠ paciente: misma regla que `acceptInvite` (identidad vinculada a una
 * ficha, o su email es de una ficha con portal vinculado, en CUALQUIER
 * consultorio). Solo se llama con la identidad ya verificada: quien pregunta
 * es el dueño del email, así que no es un oráculo.
 */
export async function isPortalPatientIdentity(user: { id: string; email: string }): Promise<boolean> {
  const row = await prismaService.patient.findFirst({
    where: {
      OR: [
        { userId: user.id },
        { email: { equals: user.email, mode: "insensitive" }, userId: { not: null } },
      ],
    },
    select: { id: true },
  });
  return !!row;
}

export type InvitePreview =
  | { valid: true; email: string; firstName: string; tenantName: string }
  | { valid: false; reason: "not_found" | "accepted" | "expired" };

/** `/signup?invite=<token crudo>`: busca por hash, nunca por el token en claro. */
export async function loadInvitePreview(rawToken: string): Promise<InvitePreview> {
  const inv = await prismaService.invitation.findUnique({
    where: { token: hashInviteToken(rawToken) },
    select: { email: true, firstName: true, acceptedAt: true, expiresAt: true, tenant: { select: { name: true } } },
  });
  if (!inv) return { valid: false, reason: "not_found" };
  if (inv.acceptedAt) return { valid: false, reason: "accepted" };
  if (inv.expiresAt < new Date()) return { valid: false, reason: "expired" };
  return { valid: true, email: inv.email.toLowerCase(), firstName: inv.firstName, tenantName: inv.tenant.name };
}

export type PendingInvite = { id: string; tenantName: string; role: string; expiresAt: Date };

export type OnboardingTenant = {
  id: string;
  name: string;
  slug: string;
  phone: string | null;
  whatsapp: string | null;
  publicEmail: string | null;
  businessHoursStart: number;
  businessHoursEnd: number;
  agendaSlotMinutes: number;
};

export type OnboardingService = {
  id: string;
  name: string;
  durationMin: number;
  priceCents: number;
  maxConcurrent: number | null;
};
export type OnboardingInsurer = { id: string; name: string; isParticular: boolean; copagoCents: number };
export type OnboardingInvitation = { id: string; email: string; firstName: string; lastName: string; role: string };

export type OnboardingContext =
  | { kind: "unverified"; email: string }
  /** Ya tiene un consultorio operativo (o es miembro no-OWNER): nada que hacer acá. */
  | { kind: "done" }
  /** Tiene invitaciones pendientes y todavía no eligió crear su propio consultorio. */
  | { kind: "invites"; invites: PendingInvite[] }
  | {
      kind: "stepper";
      patientIdentity: boolean;
      user: SessionUser;
      tenant: OnboardingTenant | null;
      services: OnboardingService[];
      insurers: OnboardingInsurer[];
      invitations: OnboardingInvitation[];
      progress: OnboardingProgress;
    };

/** Invitaciones vivas para el email de la sesión (en cualquier consultorio). */
export async function listPendingInvitesFor(email: string): Promise<PendingInvite[]> {
  const rows = await prismaService.invitation.findMany({
    where: {
      email: { equals: email, mode: "insensitive" },
      acceptedAt: null,
      expiresAt: { gt: new Date() },
    },
    select: { id: true, role: true, expiresAt: true, tenant: { select: { name: true } } },
    orderBy: { invitedAt: "desc" },
  });
  return rows.map((r) => ({ id: r.id, tenantName: r.tenant.name, role: r.role, expiresAt: r.expiresAt }));
}

/**
 * Membresías aceptadas del usuario con el estado de alta de cada tenant. El
 * tenant "en alta" es el que el usuario es OWNER y todavía no terminó.
 */
export async function loadMemberships(userId: string) {
  return prismaService.membership.findMany({
    where: { userId, acceptedAt: { not: null } },
    select: {
      role: true,
      tenantId: true,
      tenant: { select: { onboardingCompletedAt: true } },
    },
  });
}

export async function loadOnboardingContext(
  user: SessionUser,
  opts: { skipInvites?: boolean } = {}
): Promise<OnboardingContext> {
  if (!user.emailVerified) return { kind: "unverified", email: user.email };

  const memberships = await loadMemberships(user.id);
  const inProgress = memberships.find((m) => m.role === "OWNER" && !m.tenant.onboardingCompletedAt);
  if (!inProgress && memberships.length > 0) return { kind: "done" };

  if (!inProgress) {
    if (!opts.skipInvites) {
      const invites = await listPendingInvitesFor(user.email);
      if (invites.length > 0) return { kind: "invites", invites };
    }
    return {
      kind: "stepper",
      patientIdentity: await isPortalPatientIdentity(user),
      user,
      tenant: null,
      services: [],
      insurers: [],
      invitations: [],
      progress: { hasTenant: false, servicesCount: 0, insurersCount: 0, invitationsCount: 0 },
    };
  }

  const tenantId = inProgress.tenantId;
  const { tenant, services, insurers, invitations } = await runWithRls(tenantId, async (tx) => {
    const [tenant, services, insurers, invitations] = await Promise.all([
      tx.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: {
          id: true,
          name: true,
          slug: true,
          phone: true,
          whatsapp: true,
          publicEmail: true,
          businessHoursStart: true,
          businessHoursEnd: true,
          agendaSlotMinutes: true,
        },
      }),
      tx.service.findMany({
        where: { tenantId },
        select: { id: true, name: true, durationMin: true, priceCents: true, maxConcurrent: true },
        orderBy: { name: "asc" },
      }),
      tx.insurer.findMany({
        where: { tenantId },
        select: { id: true, name: true, isParticular: true, copagoCents: true },
        orderBy: [{ isParticular: "desc" }, { name: "asc" }],
      }),
      tx.invitation.findMany({
        where: { tenantId, acceptedAt: null },
        select: { id: true, email: true, firstName: true, lastName: true, role: true },
        orderBy: { invitedAt: "asc" },
      }),
    ]);
    return { tenant, services, insurers, invitations };
  });

  return {
    kind: "stepper",
    patientIdentity: false,
    user,
    tenant,
    services,
    insurers,
    invitations,
    progress: {
      hasTenant: true,
      servicesCount: services.length,
      insurersCount: insurers.filter((i) => !i.isParticular).length,
      invitationsCount: invitations.length,
    },
  };
}
