"use server";

/**
 * Patient portal — server-only queries.
 *
 * The portal is consumed by *patients* (not practitioners). The actor is
 * a Supabase auth user whose email maps to one or more `Patient` rows
 * across tenants.
 *
 * Security model (post-Sprint 11):
 *   - We **require `email_confirmed_at`** before treating the Supabase
 *     email as authoritative. Without verification (magic links, etc.)
 *     an attacker can sign up with a victim's email and read PHI.
 *   - `submitCheckIn` is rate-limited per patient — the prior version let
 *     an authed portal user spam-append into `Patient.notes` until the
 *     practitioner's earlier notes were truncated off the 4 kB tail.
 */
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
// Patient-facing portal: no practitioner Actor; getPortalAuth reads Patient
// ACROSS tenants by verified email and the rest resolves a tenant by slug.
// Every query is explicitly scoped by the verified patient's id/tenant, so it
// runs on the service channel (BYPASSRLS) — same trust model as public-booking.
import { prismaService as prisma } from "@/lib/db";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";
import type { ActionResult } from "@/lib/validation";
import type {
  PortalAuth,
  PortalPatient,
  PortalPlanDTO,
} from "@/lib/portal-types";

/**
 * Returns the verified Supabase user, or null. The portal must NEVER act
 * on an unverified email — that's how account takeover via magic-link
 * sign-up happens.
 */
async function verifiedUser(): Promise<{ id: string; email: string; fullName: string | null } | null> {
  const supabase = getSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return null;
  if (!user.email_confirmed_at) return null;
  return {
    id: user.id,
    email: user.email.toLowerCase(),
    fullName: (user.user_metadata?.full_name as string | undefined) ?? null,
  };
}

export async function getPortalAuth(): Promise<PortalAuth> {
  const me = await verifiedUser();
  if (!me) return { signedIn: false };

  const patients = await prisma.patient.findMany({
    where: { email: me.email },
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
    email: me.email,
    fullName: me.fullName,
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

// ──────────────────────────────────────────────────────────────────────
// Plan timeline + pre-session check-in (Phase 9 surface)
// ──────────────────────────────────────────────────────────────────────

async function authedPatientByTenant(tenantSlug: string) {
  const me = await verifiedUser();
  if (!me) return null;
  const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
  if (!tenant) return null;
  const patient = await prisma.patient.findFirst({
    where: { tenantId: tenant.id, email: me.email },
  });
  if (!patient) return null;
  return { user: me, tenant, patient };
}

export async function getPortalPlan(tenantSlug: string): Promise<PortalPlanDTO | null> {
  const auth = await authedPatientByTenant(tenantSlug);
  if (!auth) return null;
  const program = await prisma.treatmentProgram.findFirst({
    where: { patientId: auth.patient.id, status: "ACTIVE" },
    include: {
      sessions: {
        orderBy: { index: "asc" },
        select: { id: true, index: true, scheduledFor: true, completedAt: true, notes: true },
      },
    },
  });
  if (!program) return null;
  const checkIns = await prisma.evaScore.findMany({
    where: { patientId: auth.patient.id, source: { startsWith: "checkin-" } },
    select: { source: true },
  });
  const withCheckIn = new Set(
    checkIns.map((c) => (c.source ?? "").replace("checkin-", ""))
  );
  return {
    programId: program.id,
    title: program.title,
    totalSessions: program.totalSessions,
    completedSessions: program.sessions.filter((s) => s.completedAt).length,
    startDate: program.startDate.toISOString(),
    sessions: program.sessions.map((s) => ({
      id: s.id,
      index: s.index,
      scheduledFor: s.scheduledFor.toISOString(),
      completedAt: s.completedAt?.toISOString() ?? null,
      notes: s.notes,
      hasCheckIn: withCheckIn.has(s.id),
    })),
  };
}

/**
 * Patient submits a pre-session check-in. Persists as an `EvaScore` keyed
 * by session id. Patient `notes` get **prepended** (newest first) and
 * capped at 4 kB total so a runaway patient can't bury practitioner
 * annotations.
 */
export async function submitCheckIn(input: {
  tenantSlug: string;
  sessionId: string;
  pain: number;
  notes?: string;
}): Promise<ActionResult> {
  const ip = headers().get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  // Tight rate limit — a check-in per session is enough; aggressive spam
  // would be the only reason to exceed this.
  const rl = await rateLimit(`portal:checkin:${ip}`, {
    limit: 4,
    windowMs: 60_000,
  });
  if (!rl.ok) return { ok: false, error: "Demasiados intentos." };

  const auth = await authedPatientByTenant(input.tenantSlug);
  if (!auth) return { ok: false, error: "Sin acceso." };

  // Per-patient throttle — one check-in per (patient, session) is enough.
  const existing = await prisma.evaScore.findFirst({
    where: {
      patientId: auth.patient.id,
      source: `checkin-${input.sessionId}`,
    },
    select: { id: true },
  });
  if (existing) {
    return { ok: false, error: "Ya enviaste tu check-in para esta sesión." };
  }

  const sess = await prisma.session.findFirst({
    where: {
      id: input.sessionId,
      program: { patientId: auth.patient.id, tenantId: auth.tenant.id },
    },
    select: { id: true, index: true },
  });
  if (!sess) return { ok: false, error: "Sesión no encontrada." };

  const pain = Math.min(10, Math.max(0, Math.floor(input.pain)));
  await prisma.evaScore.create({
    data: {
      patientId: auth.patient.id,
      value: pain,
      source: `checkin-${sess.id}`,
    },
  });
  if (input.notes && input.notes.trim()) {
    // Newest-first prepend so practitioner notes stay readable when the
    // 4 kB cap kicks in. Patient input is truncated to 500 chars per entry.
    const patientText = input.notes.trim().slice(0, 500);
    const head = `[check-in sesión ${sess.index} · EVA ${pain}/10] ${patientText}\n`;
    await prisma.patient.update({
      where: { id: auth.patient.id },
      data: {
        notes: { set: (head + (auth.patient.notes ?? "")).slice(0, 4000) },
      },
    });
  }
  revalidatePath(`/portal/c/${input.tenantSlug}`);
  return { ok: true, data: undefined };
}
