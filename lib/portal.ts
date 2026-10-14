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
 *
 * A3b-S-auth:
 *   - **staff ≠ paciente:** una identidad con Membership en CUALQUIER
 *     consultorio no ve fichas en el portal (el portal matchea por email
 *     entre tenants; un kine con el mismo email que una ficha de otro
 *     consultorio no tiene por qué entrar por acá). Se ve como "sin fichas".
 *   - match de email **case-insensitive**: había fichas cargadas con
 *     mayúsculas ("Juan@Mail.com") que nunca aparecían en el portal.
 *   - el check-in **ya no escribe `Patient.notes`** (ver `submitCheckIn`).
 *
 * IAM-0a: el match por email era `equals` + `mode: "insensitive"` = `ILIKE`
 * con el email pelado, y `_`/`%` son comodines: `jpere_@hotmail.com`
 * (verificado) veía fichas, turnos y planes de `jperez@hotmail.com`. Ahora va
 * por `emailEqualsFilter` (escapado) + `sameEmail` como post-filtro exacto.
 */
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
// Patient-facing portal: no practitioner Actor; getPortalAuth reads Patient
// ACROSS tenants by verified email and the rest resolves a tenant by slug.
// Every query is explicitly scoped by the verified patient's id/tenant, so it
// runs on the service channel (BYPASSRLS) — same trust model as public-booking.
import { prismaService as prisma } from "@/lib/db";
import { getVerifiedSessionUser } from "@/lib/session-user";
import { rateLimit, rateLimitedMessage } from "@/lib/rate-limit";
import { clientIp } from "@/lib/client-ip";
import { audit } from "@/lib/audit";
import { notify, notifyTenantOwners } from "@/lib/notifications-internal";
import { emailEqualsFilter, sameEmail } from "@/lib/email-match";
import type { ActionResult } from "@/lib/validation";
import type {
  PortalAuth,
  PortalPatient,
  PortalPlanDTO,
} from "@/lib/portal-types";

/**
 * Returns the verified Supabase user, or null. The portal must NEVER act
 * on an unverified email — that's how account takeover via magic-link
 * sign-up happens. (IAM-3c: el magic link del portal llega por
 * `/auth/confirm` → `verifyOtp`, que confirma el email al canjearse; un
 * usuario que nunca abrió el link no tiene `email_confirmed_at`.)
 */
async function verifiedUser(): Promise<{
  id: string;
  email: string;
  fullName: string | null;
  isStaff: boolean;
} | null> {
  // IAM-3c: el `getUser()` de IAM-3a (un solo round-trip por request, chequea `{ error }` y nunca tira).
  const user = await getVerifiedSessionUser();
  if (!user?.email) return null;
  if (!user.emailConfirmedAt) return null;
  // Staff ≠ paciente (A3b-S-auth): con Membership en cualquier consultorio, el
  // portal no la trata como paciente (ver getPortalAuth / authedPatientByTenant).
  const staff = await prisma.membership.findFirst({
    where: { userId: user.id },
    select: { id: true },
  });
  return {
    isStaff: !!staff,
    id: user.id,
    email: user.email.toLowerCase(),
    fullName: user.fullName,
  };
}

export async function getPortalAuth(): Promise<PortalAuth> {
  const me = await verifiedUser();
  if (!me) return { signedIn: false };
  // Staff: sesión válida pero sin fichas (la pantalla "no hay fichas
  // vinculadas a tu email"); devolver signedIn:false lo dejaba en un loop de
  // "Ingresá con Google" estando ya logueado.
  if (me.isStaff) return { signedIn: true, email: me.email, fullName: me.fullName, patients: [] };

  const patients = await prisma.patient.findMany({
    where: { email: emailEqualsFilter(me.email) },
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

  // Post-filtro exacto (IAM-0a): defensa en profundidad si el filtro de arriba
  // volviera a interpretar comodines.
  const own = patients.filter((p) => sameEmail(p.email, me.email));

  return {
    signedIn: true,
    email: me.email,
    fullName: me.fullName,
    patients: own.map((p): PortalPatient => ({
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
  if (!me || me.isStaff) return null;
  const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
  if (!tenant) return null;
  const patient = await prisma.patient.findFirst({
    where: { tenantId: tenant.id, email: emailEqualsFilter(me.email) },
    select: { id: true, email: true, firstName: true, lastName: true, assignedPractitionerId: true },
  });
  // IAM-0a: post-filtro exacto (la ficha autoriza plan, check-in y PHI).
  if (!patient || !sameEmail(patient.email, me.email)) return null;
  return { user: me, tenant, patient };
}

/**
 * P0-S02p:
 * - **sin `notes`**: `Session.notes` son notas del kine (clínicas, privadas).
 *   Viajaban en el DTO al navegador del paciente aunque la página no las
 *   pintara: cualquiera las leía en el payload RSC. El `select` ya no las pide.
 * - **determinístico**: con dos planes ACTIVE (pasa con datos legacy y con la
 *   adopción de Planes) el `findFirst` sin `orderBy` devolvía el que Postgres
 *   leyera primero. Ahora es el ACTIVE más reciente por `startDate`, con
 *   `createdAt` e `id` de desempate. Se ordena por `startDate` y no solo por
 *   `createdAt` (que usaba `getPatientProgramsLite`, retirado en S27a) porque un plan adoptado o
 *   migrado se crea hoy con un inicio viejo: para el paciente "el plan
 *   actual" es el que empezó último.
 * - acotado al tenant del slug también en la query (el `patientId` ya lo
 *   implica; es defensa en profundidad sobre el canal BYPASSRLS).
 */
export async function getPortalPlan(tenantSlug: string): Promise<PortalPlanDTO | null> {
  const auth = await authedPatientByTenant(tenantSlug);
  if (!auth) return null;
  const program = await prisma.treatmentProgram.findFirst({
    where: { patientId: auth.patient.id, tenantId: auth.tenant.id, status: "ACTIVE" },
    orderBy: [{ startDate: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    include: {
      sessions: {
        orderBy: { index: "asc" },
        select: { id: true, index: true, scheduledFor: true, completedAt: true },
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
      hasCheckIn: withCheckIn.has(s.id),
    })),
  };
}

/**
 * Patient submits a pre-session check-in. Persists as an `EvaScore` keyed
 * by session id.
 *
 * A3b-S-auth: el texto del paciente YA NO se escribe en `Patient.notes`.
 * Antes se anteponía y se cortaba a 4 kB, así que cada check-in largo le
 * truncaba al kine sus propias notas viejas (pérdida de datos clínicos). Ahora
 * va como notificación al profesional asignado (o a OWNER/ADMIN si no hay
 * asignado) + un audit con el texto completo. La EvaScore se crea igual; la
 * nota dentro de la EvaScore llega con M1 en el bloque B.
 */
export async function submitCheckIn(input: {
  tenantSlug: string;
  sessionId: string;
  pain: number;
  notes?: string;
}): Promise<ActionResult> {
  // Tight rate limit — a check-in per session is enough; aggressive spam
  // would be the only reason to exceed this.
  const rl = await rateLimit(`portal:checkin:${clientIp(headers())}`, {
    limit: 4,
    windowMs: 60_000,
  });
  if (!rl.ok) return { ok: false, error: rateLimitedMessage(rl.retryAfterMs) };

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
  const patientText = input.notes?.trim().slice(0, 500) || null;
  await audit({
    tenantId: auth.tenant.id,
    actorId: auth.user.id,
    action: "portal.checkin",
    entity: "Patient",
    entityId: auth.patient.id,
    payload: { sessionId: sess.id, sessionIndex: sess.index, pain, notes: patientText },
  });
  const patientName = `${auth.patient.firstName} ${auth.patient.lastName}`.trim();
  const title = `Check-in de ${patientName} · sesión ${sess.index} · EVA ${pain}/10`;
  const link = `/pacientes/${auth.patient.id}`;
  const assignedUserId = auth.patient.assignedPractitionerId
    ? (
        await prisma.practitioner.findFirst({
          where: { id: auth.patient.assignedPractitionerId, tenantId: auth.tenant.id },
          select: { userId: true },
        })
      )?.userId
    : null;
  if (assignedUserId) {
    await notify({
      tenantId: auth.tenant.id,
      userId: assignedUserId,
      kind: "SYSTEM",
      title,
      body: patientText ?? undefined,
      link,
    });
  } else {
    await notifyTenantOwners({
      tenantId: auth.tenant.id,
      kind: "SYSTEM",
      title,
      body: patientText ?? undefined,
      link,
    });
  }
  revalidatePath(`/portal/c/${input.tenantSlug}`);
  return { ok: true, data: undefined };
}
