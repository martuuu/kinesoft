"use server";

/**
 * Patient portal — server-only queries.
 *
 * The portal is consumed by *patients* (not practitioners). El actor es una cuenta de Supabase verificada; lo que ve
 * lo autoriza el VÍNCULO `Patient.userId` por (tenantId, userId) — `lib/portal-identity-internal.ts`, la única puerta
 * de autorización del portal (ES4 S24a). Hasta ES4 se autorizaba por coincidencia de email entre consultorios: una
 * ficha con el email de la cuenta pero sin vincular ya mostraba plan y turnos (AUDIT `portal-auth-por-email-no-userid`).
 * El vínculo lo escriben solo `lib/portal-link-internal.ts` (auto-vínculo con una única ficha libre) y la invitación.
 *
 * Security model:
 *   - `email_confirmed_at` obligatorio (`getPortalUser`): sin verificar, alguien se registra con el email de otro.
 *   - staff ≠ paciente (A3b-S-auth, AUDIT §5.22): con Membership en cualquier consultorio, «sin fichas».
 *   - `submitCheckIn` con rate-limit; el check-in ya no escribe `Patient.notes` (ver `submitCheckIn`).
 */
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
// Patient-facing portal: no practitioner Actor. Las fichas salen de `requirePortalPatient` / `listPortalPatients`
// (por userId) y cada query va acotada por el par patientId + tenantId de ese ref, así que corre en el canal service
// (BYPASSRLS) — same trust model as public-booking.
import { prismaService as prisma } from "@/lib/db";
import { getPortalUser, listPortalPatients, requirePortalPatient } from "@/lib/portal-identity-internal";
import { rateLimit, rateLimitedMessage } from "@/lib/rate-limit";
import { clientIp } from "@/lib/client-ip";
import { notify, notifyTenantOwners } from "@/lib/notifications-internal";
import { publicPractitionerName } from "@/lib/display-name";
import type { ActionResult } from "@/lib/validation";
import type {
  PortalAuth,
  PortalPatient,
  PortalPlanDTO,
} from "@/lib/portal-types";

export async function getPortalAuth(): Promise<PortalAuth> {
  const me = await getPortalUser();
  if (!me) return { signedIn: false };
  // Staff: sesión válida pero sin fichas (la pantalla "no hay fichas
  // vinculadas"); devolver signedIn:false lo dejaba en un loop de
  // "Ingresá con Google" estando ya logueado.
  if (me.isStaff) return { signedIn: true, email: me.email, fullName: me.fullName, patients: [] };

  // S24a: solo las fichas VINCULADAS a esta cuenta (por userId), nunca por email.
  const refs = await listPortalPatients(me.id);
  const now = new Date();
  const patients = await Promise.all(
    refs.map(async (ref): Promise<PortalPatient> => {
      const [programs, bookings] = await Promise.all([
        prisma.treatmentProgram.findMany({
          where: { patientId: ref.patientId, tenantId: ref.tenantId, status: "ACTIVE" },
          select: {
            id: true,
            title: true,
            totalSessions: true,
            startDate: true,
            sessions: { select: { completedAt: true } },
          },
        }),
        prisma.booking.findMany({
          where: {
            patientId: ref.patientId,
            tenantId: ref.tenantId,
            scheduledFor: { gte: now },
            status: { notIn: ["CANCELLED"] },
          },
          orderBy: { scheduledFor: "asc" },
          take: 5,
          select: {
            id: true,
            scheduledFor: true,
            durationMin: true,
            service: { select: { name: true } },
            // DIR-0: sin `email`; el portal nunca muestra el email del profesional como nombre.
            practitioner: { select: { user: { select: { fullName: true } } } },
          },
        }),
      ]);
      return {
        id: ref.patientId,
        tenantSlug: ref.tenant.slug,
        tenantName: ref.tenant.name,
        tenantVertical: ref.tenant.vertical,
        firstName: ref.patient.firstName,
        lastName: ref.patient.lastName,
        programs: programs.map((pr) => ({
          id: pr.id,
          title: pr.title,
          totalSessions: pr.totalSessions,
          completedSessions: pr.sessions.filter((s) => s.completedAt).length,
          startDate: pr.startDate,
        })),
        upcoming: bookings.map((b) => ({
          id: b.id,
          scheduledFor: b.scheduledFor,
          durationMin: b.durationMin,
          serviceName: b.service.name,
          practitionerName: publicPractitionerName(b.practitioner.user.fullName),
        })),
      };
    })
  );

  return { signedIn: true, email: me.email, fullName: me.fullName, patients };
}

// ──────────────────────────────────────────────────────────────────────
// Plan timeline + pre-session check-in (Phase 9 surface)
// ──────────────────────────────────────────────────────────────────────

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
  const ref = await requirePortalPatient(tenantSlug);
  if (!ref) return null;
  const program = await prisma.treatmentProgram.findFirst({
    where: { patientId: ref.patientId, tenantId: ref.tenantId, status: "ACTIVE" },
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
    where: { patientId: ref.patientId, source: { startsWith: "checkin-" } },
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

  const ref = await requirePortalPatient(input.tenantSlug);
  if (!ref) return { ok: false, error: "Sin acceso." };
  // BO2-D (C-BO1 `publicSurfacesOpen`): un consultorio suspendido / dado de baja (o en solo lectura con
  // `enforce`) no recibe check-ins: es una ESCRITURA sin Actor (EvaScore + notificación) que nadie del equipo
  // podría atender. Leer el plan (`getPortalPlan`) NO se corta: la HC del paciente se puede ver siempre.
  if (!ref.surfacesOpen) {
    return { ok: false, error: "Tu consultorio no está recibiendo check-ins por ahora. Escribiles directamente." };
  }

  // Per-patient throttle — one check-in per (patient, session) is enough.
  const existing = await prisma.evaScore.findFirst({
    where: {
      patientId: ref.patientId,
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
      program: { patientId: ref.patientId, tenantId: ref.tenantId },
    },
    select: { id: true, index: true },
  });
  if (!sess) return { ok: false, error: "Sesión no encontrada." };

  const pain = Math.min(10, Math.max(0, Math.floor(input.pain)));
  await prisma.evaScore.create({
    data: {
      patientId: ref.patientId,
      value: pain,
      source: `checkin-${sess.id}`,
    },
  });
  const patientText = input.notes?.trim().slice(0, 500) || null;
  const patientName = `${ref.patient.firstName} ${ref.patient.lastName}`.trim();
  const title = `Check-in de ${patientName} · sesión ${sess.index} · EVA ${pain}/10`;
  const link = `/pacientes/${ref.patientId}`;
  const assignedUserId = ref.patient.assignedPractitionerId
    ? (
        await prisma.practitioner.findFirst({
          where: { id: ref.patient.assignedPractitionerId, tenantId: ref.tenantId },
          select: { userId: true },
        })
      )?.userId
    : null;
  if (assignedUserId) {
    await notify({
      tenantId: ref.tenantId,
      userId: assignedUserId,
      kind: "SYSTEM",
      title,
      body: patientText ?? undefined,
      link,
    });
  } else {
    await notifyTenantOwners({
      tenantId: ref.tenantId,
      kind: "SYSTEM",
      title,
      body: patientText ?? undefined,
      link,
    });
  }
  revalidatePath(`/portal/c/${input.tenantSlug}`);
  return { ok: true, data: undefined };
}
