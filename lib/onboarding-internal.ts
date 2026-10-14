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
import type { TenantVertical } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { runWithRls } from "@/lib/rls";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { hashInviteToken } from "@/lib/invitations-tokens";
import { emailEqualsFilter, sameEmail } from "@/lib/email-match";
import { isCustomSchedule, type OnboardingProgress } from "@/lib/onboarding-logic";
import { agendaDefaultIds } from "@/lib/agenda-defaults";
import type { LocationRow } from "@/lib/locations-schemas";
import type { PractitionerScheduleView } from "@/lib/practitioner-schedule-schemas";

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
        // IAM-0a: escapado; pelado, `ana_@x.com` quedaba marcada como paciente
        // por la ficha con portal de `anax@x.com` y no podía armar su consultorio.
        { email: emailEqualsFilter(user.email), userId: { not: null } },
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
  /** EV0: tipo de consultorio elegido en el paso 2 (editable mientras el alta siga abierta). */
  vertical: TenantVertical;
};

export type OnboardingService = {
  id: string;
  name: string;
  durationMin: number;
  priceCents: number;
  maxConcurrent: number | null;
  /** Práctica del catálogo (B5.5): solo el nombre, para el listado. */
  practiceName: string | null;
};

/** Sede principal (paso "Sede"). */
export type OnboardingLocation = {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  province: string | null;
  phone: string | null;
};

/** Semana del OWNER (paso "Tu horario"): misma forma que `getPractitionerSchedule`. */
export type OnboardingSchedule = {
  practitionerId: string;
  view: PractitionerScheduleView;
  /** `isCustomSchedule`: false = la plantilla del alta, sin tocar. */
  custom: boolean;
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
      /** Sede principal; null sin tenant (o en un tenant viejo sin sede: el paso la crea). */
      location: OnboardingLocation | null;
      /** Todas las sedes (el editor de franjas rotula una franja de otra sede). */
      locations: LocationRow[];
      schedule: OnboardingSchedule | null;
      services: OnboardingService[];
      insurers: OnboardingInsurer[];
      invitations: OnboardingInvitation[];
      progress: OnboardingProgress;
    };

/**
 * Invitaciones vivas para el email de la sesión (en cualquier consultorio).
 *
 * IAM-0a: el email iba pelado a un `ILIKE` y `jpere_@hotmail.com` veía (y con
 * `openPendingInvitation` reabría, rotando el token) las invitaciones de
 * `jperez@hotmail.com`. Filtro escapado + `sameEmail` como post-filtro.
 */
export async function listPendingInvitesFor(email: string): Promise<PendingInvite[]> {
  const rows = await prismaService.invitation.findMany({
    where: {
      email: emailEqualsFilter(email),
      acceptedAt: null,
      expiresAt: { gt: new Date() },
    },
    select: { id: true, email: true, role: true, expiresAt: true, tenant: { select: { name: true } } },
    orderBy: { invitedAt: "desc" },
  });
  return rows.filter((r) => sameEmail(r.email, email)).map((r) => ({ id: r.id, tenantName: r.tenant.name, role: r.role, expiresAt: r.expiresAt }));
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
      location: null,
      locations: [],
      schedule: null,
      services: [],
      insurers: [],
      invitations: [],
      progress: {
        hasTenant: false,
        locationReady: false,
        ownScheduleSaved: false,
        servicesCount: 0,
        insurersCount: 0,
        invitationsCount: 0,
      },
    };
  }

  const tenantId = inProgress.tenantId;
  const data = await runWithRls(tenantId, async (tx) => {
    const [tenant, services, insurers, invitations, locations, practitioner] = await Promise.all([
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
          vertical: true,
        },
      }),
      tx.service.findMany({
        where: { tenantId },
        select: {
          id: true,
          name: true,
          durationMin: true,
          priceCents: true,
          maxConcurrent: true,
          practice: { select: { name: true } },
        },
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
      tx.location.findMany({
        where: { tenantId },
        orderBy: [{ isPrimary: "desc" }, { sortOrder: "asc" }, { name: "asc" }],
        select: {
          id: true,
          name: true,
          address: true,
          addressLine2: true,
          city: true,
          province: true,
          postalCode: true,
          phone: true,
          isPrimary: true,
          active: true,
          sortOrder: true,
          _count: { select: { schedules: true } },
        },
      }),
      // El OWNER es el practitioner de este usuario en este tenant (bootstrap).
      tx.practitioner.findFirst({ where: { tenantId, userId: user.id }, select: { id: true } }),
    ]);
    const scheduleRows = practitioner
      ? await tx.practitionerSchedule.findMany({
          where: { tenantId, practitionerId: practitioner.id },
          orderBy: [{ dow: "asc" }, { startMin: "asc" }],
          select: {
            id: true,
            dow: true,
            startMin: true,
            endMin: true,
            locationId: true,
            validFrom: true,
            validUntil: true,
            updatedAt: true,
          },
        })
      : [];
    return { tenant, services, insurers, invitations, locations, practitioner, scheduleRows };
  });
  const { tenant, insurers, invitations, practitioner, scheduleRows } = data;

  const locations: LocationRow[] = data.locations.map(({ _count, ...l }) => ({
    ...l,
    scheduleCount: _count.schedules,
  }));
  const primary = locations.find((l) => l.isPrimary && l.active) ?? null;

  // Misma forma que `getPractitionerSchedule` (el editor de Configuración usa
  // `draftFromView` sobre esto). La vigencia no se edita en el alta: las
  // franjas del alta nunca la llevan, se pasa null.
  const schedule: OnboardingSchedule | null = practitioner
    ? {
        practitionerId: practitioner.id,
        view: {
          practitionerId: practitioner.id,
          ranges: scheduleRows.map((r) => ({
            id: r.id,
            dow: r.dow,
            startMin: r.startMin,
            endMin: r.endMin,
            locationId: r.locationId,
            validFrom: null,
            validUntil: null,
          })),
          version: scheduleRows.length
            ? new Date(Math.max(...scheduleRows.map((r) => r.updatedAt.getTime()))).toISOString()
            : null,
          isFallback: scheduleRows.length === 0,
          tenantHours: { startMin: tenant.businessHoursStart * 60, endMin: tenant.businessHoursEnd * 60 },
        },
        custom: isCustomSchedule(scheduleRows, (dow) => agendaDefaultIds.schedule(practitioner.id, dow)),
      }
    : null;

  const services: OnboardingService[] = data.services.map(({ practice, ...s }) => ({
    ...s,
    practiceName: practice?.name ?? null,
  }));

  return {
    kind: "stepper",
    patientIdentity: false,
    user,
    tenant,
    location: primary
      ? {
          id: primary.id,
          name: primary.name,
          address: primary.address,
          city: primary.city,
          province: primary.province,
          phone: primary.phone,
        }
      : null,
    locations,
    schedule,
    services,
    insurers,
    invitations,
    progress: {
      hasTenant: true,
      locationReady: !!primary?.address?.trim(),
      ownScheduleSaved: schedule?.custom ?? false,
      servicesCount: services.length,
      insurersCount: insurers.filter((i) => !i.isParticular).length,
      invitationsCount: invitations.length,
    },
  };
}
