"use server";

/**
 * Patient portal — server-only queries.
 *
 * The portal is consumed by *patients* (not practitioners), so the actor
 * is a Supabase auth user whose email maps to one or more `Patient` rows
 * across tenants. Authorisation is by-email; the practitioner workspace
 * is by-tenant.
 */
import { prisma } from "@/lib/db";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export type PortalPatient = {
  id: string;
  tenantSlug: string;
  tenantName: string;
  firstName: string;
  lastName: string;
  programs: {
    id: string;
    title: string;
    totalSessions: number;
    completedSessions: number;
    startDate: Date;
  }[];
  upcoming: {
    id: string;
    scheduledFor: Date;
    durationMin: number;
    serviceName: string;
    practitionerName: string;
  }[];
};

export type PortalAuth =
  | { signedIn: false }
  | { signedIn: true; email: string; fullName: string | null; patients: PortalPatient[] };

export async function getPortalAuth(): Promise<PortalAuth> {
  const supabase = getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) return { signedIn: false };

  const patients = await prisma.patient.findMany({
    where: { email: user.email },
    include: {
      tenant: { select: { slug: true, name: true } },
      programs: {
        where: { status: "ACTIVE" },
        include: { sessions: { select: { completedAt: true } } },
      },
      bookings: {
        where: { scheduledFor: { gte: new Date() }, status: { notIn: ["CANCELLED"] } },
        orderBy: { scheduledFor: "asc" },
        take: 5,
        include: {
          service: { select: { name: true } },
          practitioner: { include: { user: { select: { fullName: true, email: true } } } },
        },
      },
    },
  });

  return {
    signedIn: true,
    email: user.email,
    fullName: (user.user_metadata?.full_name as string | undefined) ?? null,
    patients: patients.map((p): PortalPatient => ({
      id: p.id,
      tenantSlug: p.tenant.slug,
      tenantName: p.tenant.name,
      firstName: p.firstName,
      lastName: p.lastName,
      programs: p.programs.map((pr) => ({
        id: pr.id,
        title: pr.title,
        totalSessions: pr.totalSessions,
        completedSessions: pr.sessions.filter((s) => s.completedAt).length,
        startDate: pr.startDate,
      })),
      upcoming: p.bookings.map((b) => ({
        id: b.id,
        scheduledFor: b.scheduledFor,
        durationMin: b.durationMin,
        serviceName: b.service.name,
        practitionerName: b.practitioner.user.fullName ?? b.practitioner.user.email,
      })),
    })),
  };
}
