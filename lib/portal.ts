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
 *   - ES4 S24: lo que se ve por ficha lo decide `portalSectionsFor(ref.modules)` (lib/portal-nav.ts), la misma fuente que
 *     las tabs: plan y turnos del plan solo con `planes`, check-in con `planes` ∧ `evaluaciones`. Antes el portal
 *     mostraba planes y aceptaba check-ins en un consultorio de Clínica general (sin esos módulos) si había filas viejas.
 *   - DTOs por allowlist (`select`, nunca `include` de la fila): sin montos, sin notas del kine, sin email del profesional.
 */
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
// Patient-facing portal: no practitioner Actor. Las fichas salen de `requirePortalPatient` / `listPortalPatients`
// (por userId) y cada query va acotada por el par patientId + tenantId de ese ref, así que corre en el canal service
// (BYPASSRLS) — same trust model as public-booking.
import { prismaService as prisma } from "@/lib/db";
import { getPortalUser, listPortalPatients, requirePortalPatient } from "@/lib/portal-identity-internal";
import { PORTAL_SECTIONS, portalSectionsFor } from "@/lib/portal-nav";
import { linkedProgramWhere, liveProgramWhere, liveSessionWhere } from "@/lib/plan-predicates";
import { planSessionOrdinals } from "@/lib/plan-display";
import { rateLimit, rateLimitedMessage } from "@/lib/rate-limit";
import { clientIp } from "@/lib/client-ip";
import { notify, notifyTenantOwners } from "@/lib/notifications-internal";
import { publicPractitionerName } from "@/lib/display-name";
import type { Prisma } from "@prisma/client";
import type { ActionResult } from "@/lib/validation";
import type {
  PortalAuth,
  PortalPatient,
  PortalPlanDTO,
} from "@/lib/portal-types";

/**
 * ES4-D5: el plan que ve el paciente es un plan ACTIVE, vivo y VINCULADO (`linkedProgramWhere`: tiene agenda o turnos
 * con `programId`). Un legacy (alta vieja, sesiones a las 00:00Z sin turnos) mostraba fechas corridas un día en AR y
 * no tiene turnos que listar; prod es demo y el precheck (a) de ES4 confirma que no hay planes legacy que rescatar.
 * No se exporta: un archivo "use server" solo exporta funciones async.
 */
const PORTAL_PROGRAM_WHERE = {
  status: "ACTIVE",
  ...liveProgramWhere,
  ...linkedProgramWhere,
} satisfies Prisma.TreatmentProgramWhereInput;

/**
 * Turno vigente de una sesión: ni cancelado ni ausente (C4: un turno cancelado o ausente deja la sesión «sin turno»).
 * El único parcial `Booking_session_active_key` deja a lo sumo uno; `take: 1` con orden es defensa.
 */
const ACTIVE_PLAN_BOOKING = {
  status: { notIn: ["CANCELLED", "NO_SHOW"] },
} satisfies Prisma.BookingWhereInput;

/** Check-ins del paciente: `source` «checkin-<sessionId>» (compat) — una EVA del kine con `sessionId` NO cuenta. */
const CHECKIN_SOURCE_PREFIX = "checkin-";

export async function getPortalAuth(): Promise<PortalAuth> {
  const me = await getPortalUser();
  if (!me) return { signedIn: false };
  // Staff: sesión válida pero sin fichas (la pantalla "no hay fichas
  // vinculadas"); devolver signedIn:false lo dejaba en un loop de
  // "Ingresá con Google" estando ya logueado.
  if (me.isStaff) return { signedIn: true, email: me.email, fullName: me.fullName, patients: [] };

  // S24a: solo las fichas VINCULADAS a esta cuenta (por userId), nunca por email.
  const refs = await listPortalPatients(me.id);
  if (refs.length === 0) return { signedIn: true, email: me.email, fullName: me.fullName, patients: [] };
  const now = new Date();
  // ES4 P4.Z (perf S26s #3): planes y turnos de TODAS las fichas en una lectura cada uno (en lote), no dos por
  // consultorio: la home de una cuenta con N consultorios costaba 2·N sentencias. Cada rama del OR lleva el par
  // patientId + tenantId del ref (canal BYPASSRLS), igual que las queries por ficha de antes.
  const sectionsOf = new Map(refs.map((ref) => [ref.patientId, portalSectionsFor(ref.modules)]));
  // S24: sin `planes` (Clínica general) no se leen planes de esa ficha; si ninguna los usa, ni la query sale.
  const planRefs = refs.filter((ref) => sectionsOf.get(ref.patientId)!.has("plan"));
  const [programs, bookings] = await Promise.all([
    planRefs.length > 0
      ? prisma.treatmentProgram.findMany({
          // AND: `PORTAL_PROGRAM_WHERE` ya trae su propio `OR` (linkedProgramWhere) y un spread lo pisaría.
          where: {
            AND: [{ OR: planRefs.map((ref) => ({ patientId: ref.patientId, tenantId: ref.tenantId })) }, PORTAL_PROGRAM_WHERE],
          },
          orderBy: [{ startDate: "desc" }, { createdAt: "desc" }, { id: "desc" }],
          select: {
            id: true,
            patientId: true,
            tenantId: true,
            title: true,
            startDate: true,
            sessions: { where: liveSessionWhere, select: { completedAt: true } },
          },
        })
      : Promise.resolve([]),
    // Sin `take` por ficha (Prisma no tiene «top 5 por grupo»): se cortan 5 por ficha abajo. Son los turnos FUTUROS
    // no cancelados de un paciente: acotados por su agenda real (un plan de 3/semana por 6 meses ≈ 80 filas).
    prisma.booking.findMany({
      where: {
        OR: refs.map((ref) => ({ patientId: ref.patientId, tenantId: ref.tenantId })),
        scheduledFor: { gte: now },
        status: { notIn: ["CANCELLED"] },
      },
      orderBy: [{ scheduledFor: "asc" }, { id: "asc" }],
      select: {
        id: true,
        patientId: true,
        tenantId: true,
        scheduledFor: true,
        durationMin: true,
        service: { select: { name: true } },
        // DIR-0: sin `email`; el portal nunca muestra el email del profesional como nombre.
        practitioner: { select: { user: { select: { fullName: true } } } },
      },
    }),
  ]);

  const patients = refs.map((ref): PortalPatient => {
    const sections = sectionsOf.get(ref.patientId)!;
    const mine = <T extends { patientId: string | null; tenantId: string }>(r: T) =>
      r.patientId === ref.patientId && r.tenantId === ref.tenantId;
    return {
      id: ref.patientId,
      tenantSlug: ref.tenant.slug,
      tenantName: ref.tenant.name,
      tenantVertical: ref.tenant.vertical,
      firstName: ref.patient.firstName,
      lastName: ref.patient.lastName,
      sections: PORTAL_SECTIONS.filter((x) => sections.has(x)),
      programs: sections.has("plan")
        ? programs.filter(mine).map((pr) => ({
            id: pr.id,
            title: pr.title,
            // V1-D18: la N es la cantidad de sesiones VIVAS, igual que «Sesión n de N» (no `totalSessions`, que puede
            // divergir de las filas: AUDIT `limites-sesiones-divergentes`).
            totalSessions: pr.sessions.length,
            completedSessions: pr.sessions.filter((s) => s.completedAt).length,
            startDate: pr.startDate,
          }))
        : [],
      upcoming: bookings
        .filter(mine)
        .slice(0, 5)
        .map((b) => ({
          id: b.id,
          scheduledFor: b.scheduledFor,
          durationMin: b.durationMin,
          serviceName: b.service.name,
          practitionerName: publicPractitionerName(b.practitioner.user.fullName),
        })),
    };
  });

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
 *
 * ES4 S24:
 * - gate `plan` (⇐ `planes`): Clínica general → null aunque haya filas de plan en la base;
 * - solo el plan VINCULADO (`PORTAL_PROGRAM_WHERE`, ES4-D5) y solo sesiones vivas;
 * - cada sesión trae su turno vigente por allowlist (fecha, duración, servicio, nombre público del profesional) y su
 *   ordinal por fecha (M13) para «Sesión n de N»; sin montos (eso es «Estado de cuenta»).
 */
export async function getPortalPlan(tenantSlug: string): Promise<PortalPlanDTO | null> {
  const ref = await requirePortalPatient(tenantSlug);
  if (!ref || !portalSectionsFor(ref.modules).has("plan")) return null;
  const program = await prisma.treatmentProgram.findFirst({
    where: { patientId: ref.patientId, tenantId: ref.tenantId, ...PORTAL_PROGRAM_WHERE },
    orderBy: [{ startDate: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      title: true,
      startDate: true,
      sessions: {
        where: liveSessionWhere,
        orderBy: { index: "asc" },
        select: {
          id: true,
          index: true,
          scheduledFor: true,
          completedAt: true,
          archivedAt: true,
          bookings: {
            // Mismo par del ref también en el turno: un turno de la sesión con otro paciente/tenant no existe por las
            // FKs compuestas (I1/I4), pero el canal es BYPASSRLS y el filtro no cuesta nada.
            where: { tenantId: ref.tenantId, patientId: ref.patientId, ...ACTIVE_PLAN_BOOKING },
            orderBy: [{ scheduledFor: "asc" }, { id: "asc" }],
            take: 1,
            select: {
              scheduledFor: true,
              durationMin: true,
              service: { select: { name: true } },
              // DIR-0: sin `email`.
              practitioner: { select: { user: { select: { fullName: true } } } },
            },
          },
        },
      },
    },
  });
  if (!program) return null;
  const ids = program.sessions.map((s) => s.id);
  const checkIns = ids.length
    ? await prisma.evaScore.findMany({
        where: {
          patientId: ref.patientId,
          source: { startsWith: CHECKIN_SOURCE_PREFIX },
          // S24: por `sessionId` (M1); las filas de antes de S24 solo tienen el `source` «checkin-<id>».
          OR: [{ sessionId: { in: ids } }, { source: { in: ids.map((id) => CHECKIN_SOURCE_PREFIX + id) } }],
        },
        select: { sessionId: true, source: true },
      })
    : [];
  const withCheckIn = new Set(
    checkIns.map((c) => c.sessionId ?? (c.source ?? "").slice(CHECKIN_SOURCE_PREFIX.length))
  );
  const ordinals = planSessionOrdinals(program.sessions);
  const sessions = program.sessions
    .map((s) => {
      const b = s.bookings[0];
      return {
        id: s.id,
        index: s.index,
        ordinal: ordinals.get(s.id) ?? s.index,
        scheduledFor: (b?.scheduledFor ?? s.scheduledFor).toISOString(),
        completedAt: s.completedAt?.toISOString() ?? null,
        hasCheckIn: withCheckIn.has(s.id),
        booking: b
          ? {
              scheduledFor: b.scheduledFor.toISOString(),
              durationMin: b.durationMin,
              serviceName: b.service.name,
              practitionerName: publicPractitionerName(b.practitioner.user.fullName),
            }
          : null,
      };
    })
    .sort((a, b) => a.ordinal - b.ordinal);
  return {
    programId: program.id,
    title: program.title,
    totalSessions: sessions.length,
    completedSessions: sessions.filter((s) => s.completedAt).length,
    startDate: program.startDate.toISOString(),
    sessions,
  };
}

// Entrada del check-in: es una action llamable con cualquier payload desde el navegador. Antes un `pain` NaN llegaba
// a Prisma (500) y un `sessionId` no-string a la query.
const CheckInInput = z.object({
  tenantSlug: z.string().min(1).max(64),
  sessionId: z.string().min(1).max(64),
  pain: z.number().finite(),
  notes: z.string().max(4000).optional(),
});

/**
 * Patient submits a pre-session check-in. Persists as an `EvaScore` keyed
 * by session id.
 *
 * A3b-S-auth: el texto del paciente YA NO se escribe en `Patient.notes`.
 * Antes se anteponía y se cortaba a 4 kB, así que cada check-in largo le
 * truncaba al kine sus propias notas viejas (pérdida de datos clínicos). Ahora
 * va como notificación al profesional asignado (o a OWNER/ADMIN si no hay
 * asignado).
 *
 * ES4 S24:
 * - gate `checkin` (⇐ `planes` ∧ `evaluaciones`): sin esos módulos se rechaza sin escribir;
 * - la EvaScore llena `note` (texto del paciente, ≤ 500) y `sessionId` (M1: «las escrituras nuevas llenan ambos»)
 *   además del `source` «checkin-<id>» que leen las pantallas viejas;
 * - la sesión tiene que estar viva y ser de un plan ACTIVE vivo de ESTA ficha en ESTE consultorio;
 * - «ya enviado» por `sessionId` (o por el `source` de las filas de antes de S24).
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

  const parsed = CheckInInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Revisá los datos del check-in." };
  const data = parsed.data;

  const ref = await requirePortalPatient(data.tenantSlug);
  if (!ref) return { ok: false, error: "Sin acceso." };
  if (!portalSectionsFor(ref.modules).has("checkin")) {
    return { ok: false, error: "Este consultorio no recibe check-ins por el portal." };
  }
  // BO2-D (C-BO1 `publicSurfacesOpen`): un consultorio suspendido / dado de baja (o en solo lectura con
  // `enforce`) no recibe check-ins: es una ESCRITURA sin Actor (EvaScore + notificación) que nadie del equipo
  // podría atender. Leer el plan (`getPortalPlan`) NO se corta: la HC del paciente se puede ver siempre.
  if (!ref.surfacesOpen) {
    return { ok: false, error: "Tu consultorio no está recibiendo check-ins por ahora. Escribiles directamente." };
  }

  const sess = await prisma.session.findFirst({
    where: {
      id: data.sessionId,
      ...liveSessionWhere,
      program: { patientId: ref.patientId, tenantId: ref.tenantId, status: "ACTIVE", ...liveProgramWhere },
    },
    select: { id: true, index: true },
  });
  if (!sess) return { ok: false, error: "Sesión no encontrada." };

  // Per-patient throttle — one check-in per (patient, session) is enough.
  const existing = await prisma.evaScore.findFirst({
    where: {
      patientId: ref.patientId,
      source: { startsWith: CHECKIN_SOURCE_PREFIX },
      OR: [{ sessionId: sess.id }, { source: CHECKIN_SOURCE_PREFIX + sess.id }],
    },
    select: { id: true },
  });
  if (existing) {
    return { ok: false, error: "Ya enviaste tu check-in para esta sesión." };
  }

  const pain = Math.min(10, Math.max(0, Math.floor(data.pain)));
  const patientText = data.notes?.trim().slice(0, 500) || null;
  await prisma.evaScore.create({
    data: {
      patientId: ref.patientId,
      value: pain,
      source: CHECKIN_SOURCE_PREFIX + sess.id,
      sessionId: sess.id,
      note: patientText,
    },
  });
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
  revalidatePath(`/portal/c/${data.tenantSlug}`);
  return { ok: true, data: undefined };
}
