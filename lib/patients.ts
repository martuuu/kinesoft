"use server";

/**
 * Patient domain — server-only queries + Server Actions.
 *
 * Everything is scoped by the actor's tenantId. Reads use `prisma`
 * directly (with an explicit `where: { tenantId }`); writes also go
 * through `prisma` so we can attach computed fields. The Prisma client
 * extension in `lib/db.ts` is reserved for places where we don't want
 * to hand-write the scope (read queries from React Server Components).
 */
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { runWithRls } from "@/lib/rls";
import { getActor, type Actor } from "@/lib/session";
import { getMembershipRole } from "@/lib/authz";
import { isTenantAdminRole } from "@/lib/capabilities";
import { findUsablePayerPlan } from "@/lib/catalog-validate";
import { audit } from "@/lib/audit";
import { localToARIso } from "@/lib/datetime-ar";
import { logger } from "@/lib/logger";
import { notify } from "@/lib/notifications-internal";
import { getParticularCopagoCents, resolveBookingCopagoCents } from "@/lib/billing-internal";
import { resolveInsurerName } from "@/lib/insurers-internal";
import {
  visibilityForActor,
  patientAccessFor,
  bulkPatientAccess,
} from "@/lib/visibility";
import { env } from "@/lib/env";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";
import { hashKeyPart, rateLimitAll, rateLimitedMessage } from "@/lib/rate-limit";
import { NotificationKind } from "@prisma/client";
import {
  PatientCreate,
  PatientUpdate,
  CoverageSet,
  type ActionResult,
  type PatientCreateInput,
  type PatientUpdateInput,
} from "@/lib/validation";

import type { ActivityEvent, PatientBookingFull, PatientRow, PatientSort } from "@/lib/patients-types";

export async function listPatients(opts: {
  q?: string;
  filter?: "all" | "active" | "no-program" | "archived";
  sort?: PatientSort;
  insurer?: string;
  /** Inclusive age bounds in years. Translated to dateOfBirth ranges. */
  ageMin?: number;
  ageMax?: number;
  /** Last-diagnosis filter (Condition.slug) — patients whose active or
   * most recent ClinicalCase resolved to this condition. */
  diagnosisSlug?: string;
  /** Inclusive last-visit (completed booking) date range, ISO yyyy-mm-dd. */
  lastVisitFrom?: string;
  lastVisitTo?: string;
} = {}): Promise<PatientRow[]> {
  const actor = await getActor();
  const q = opts.q?.trim();
  const sort = opts.sort ?? "lastName.asc";
  // Sprint 16: directory shows EVERY patient of the tenant; per-row
  // access (full vs basic) is resolved below via `bulkPatientAccess`
  // and PHI fields are masked accordingly for basic rows.

  // Age bounds: a patient whose age is in [min, max] has dateOfBirth in
  // [today - (max+1) years, today - min years]. Inclusive on both sides.
  const now = new Date();
  const dobMax =
    opts.ageMin != null
      ? new Date(now.getFullYear() - opts.ageMin, now.getMonth(), now.getDate())
      : undefined;
  const dobMin =
    opts.ageMax != null
      ? new Date(now.getFullYear() - opts.ageMax - 1, now.getMonth(), now.getDate() + 1)
      : undefined;
  const dobWhere: Prisma.PatientWhereInput = {};
  if (dobMin || dobMax) {
    dobWhere.dateOfBirth = {
      ...(dobMin ? { gte: dobMin } : {}),
      ...(dobMax ? { lte: dobMax } : {}),
    };
  }

  // Last-visit range — patients with at least one COMPLETED booking
  // whose scheduledFor falls in the window.
  const lvFrom = opts.lastVisitFrom ? new Date(opts.lastVisitFrom + "T00:00:00") : undefined;
  const lvTo = opts.lastVisitTo ? new Date(opts.lastVisitTo + "T23:59:59") : undefined;
  const lastVisitWhere: Prisma.PatientWhereInput =
    lvFrom || lvTo
      ? {
          bookings: {
            some: {
              status: "COMPLETED",
              ...(lvFrom || lvTo
                ? {
                    scheduledFor: {
                      ...(lvFrom ? { gte: lvFrom } : {}),
                      ...(lvTo ? { lte: lvTo } : {}),
                    },
                  }
                : {}),
            },
          },
        }
      : {};

  // Diagnosis filter — patient has a clinical case whose top-rank
  // diagnosis matches the given condition slug. We use `some` on the
  // chain so the SQL stays one tractable subquery.
  const diagnosisWhere: Prisma.PatientWhereInput = opts.diagnosisSlug
    ? {
        programs: {
          some: {
            case: {
              diagnoses: {
                some: { condition: { slug: opts.diagnosisSlug } },
              },
            },
          },
        },
      }
    : {};

  const where: Prisma.PatientWhereInput = {
    tenantId: actor.tenantId,
    ...(opts.filter === "archived"
      ? { archivedAt: { not: null } }
      : { archivedAt: null }),
    ...(q
      ? {
          OR: [
            { firstName: { contains: q, mode: "insensitive" } },
            { lastName: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
            { documentId: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
    ...(opts.filter === "active"
      ? { programs: { some: { status: "ACTIVE" } } }
      : opts.filter === "no-program"
        ? { programs: { none: {} } }
        : {}),
    ...(opts.insurer
      ? { coverages: { some: { insurer: { contains: opts.insurer, mode: "insensitive" } } } }
      : {}),
    ...dobWhere,
    ...lastVisitWhere,
    ...diagnosisWhere,
  };

  // Map sort directly when supported by Prisma; for upcoming/lastVisit we
  // sort in-memory after the read since they depend on related rows.
  const orderBy: Prisma.PatientOrderByWithRelationInput[] =
    sort === "lastName.asc"
      ? [{ lastName: "asc" }, { firstName: "asc" }]
      : sort === "lastName.desc"
        ? [{ lastName: "desc" }, { firstName: "desc" }]
        : sort === "createdAt.desc"
          ? [{ createdAt: "desc" }]
          : sort === "createdAt.asc"
            ? [{ createdAt: "asc" }]
            : [{ lastName: "asc" }];

  const rows = await runWithRls(actor.tenantId, (tx) => tx.patient.findMany({
    where,
    orderBy,
    include: {
      programs: {
        where: { status: "ACTIVE" },
        take: 1,
        include: {
          sessions: { orderBy: { index: "asc" } },
        },
      },
      bookings: {
        where: { scheduledFor: { gte: new Date() }, status: { not: "CANCELLED" } },
        orderBy: { scheduledFor: "asc" },
        take: 1,
      },
      coverages: { include: { insurerRef: true }, orderBy: { id: "desc" }, take: 1 },
    },
  }));

  // Resolve access per row in one batch — much cheaper than N share
  // lookups when the directory has hundreds of patients.
  const accessMap = await bulkPatientAccess(actor, rows.map((r) => r.id));

  return rows
    .map((p): PatientRow => {
      const access = accessMap.get(p.id) ?? "basic";
      const upcomingAt = p.bookings[0]?.scheduledFor ?? null;
      // Basic rows expose ONLY name + DNI + next booking. Every other
      // field is nulled out so a basic-access kine can't even infer
      // medical history by glancing at the directory.
      if (access === "basic") {
        return {
          id: p.id,
          firstName: p.firstName,
          lastName: p.lastName,
          email: null,
          phone: null,
          documentId: p.documentId,
          dateOfBirth: null,
          notes: null,
          createdAt: p.createdAt,
          activeProgramTitle: null,
          sessionsTotal: 0,
          sessionsDone: 0,
          lastVisit: null,
          upcomingAt,
          obraSocial: null,
          access: "basic",
        };
      }
      const prog = p.programs[0];
      const sessions = prog?.sessions ?? [];
      const done = sessions.filter((s) => s.completedAt).length;
      const lastDone = sessions
        .filter((s) => s.completedAt)
        .sort((a, b) => +b.completedAt! - +a.completedAt!)[0];
      const coverage = p.coverages[0];
      const obraSocial = coverage?.insurerRef?.name ?? coverage?.insurer ?? "Particular";
      return {
        id: p.id,
        firstName: p.firstName,
        lastName: p.lastName,
        email: p.email,
        phone: p.phone,
        documentId: p.documentId,
        dateOfBirth: p.dateOfBirth,
        notes: p.notes,
        createdAt: p.createdAt,
        activeProgramTitle: prog?.title ?? null,
        sessionsTotal: prog?.totalSessions ?? 0,
        sessionsDone: done,
        lastVisit: lastDone?.completedAt ?? null,
        upcomingAt,
        obraSocial,
        access: "full",
      };
    })
    .sort((a, b) => {
      // Secondary in-memory sort for fields that depend on joined data.
      if (sort === "upcoming.asc") {
        const va = a.upcomingAt ? +a.upcomingAt : Number.POSITIVE_INFINITY;
        const vb = b.upcomingAt ? +b.upcomingAt : Number.POSITIVE_INFINITY;
        return va - vb;
      }
      if (sort === "lastVisit.desc") {
        const va = a.lastVisit ? +a.lastVisit : 0;
        const vb = b.lastVisit ? +b.lastVisit : 0;
        return vb - va;
      }
      return 0;
    });
}

/**
 * Archivar / desarchivar.
 *
 * A2b-S-vis (30-sep) — gate `full`: archivar se trata como mutación de la
 * ficha, no como tarea administrativa libre. Saca al paciente del directorio
 * y de los buscadores de TODO el equipo, así que un profesional con acceso
 * básico (solo ver) no puede hacerlo sobre un paciente ajeno. OWNER/ADMIN
 * siempre tienen `full`, así que la parte administrativa queda cubierta sin
 * un caso aparte; el profesional asignado o con share también puede.
 */
export async function setPatientArchived(input: {
  id: string;
  archived: boolean;
}): Promise<ActionResult> {
  const actor = await getActor();
  const denied = await runWithRls(actor.tenantId, async (tx) => {
    const err = await hcAccessError(actor, input.id, tx);
    if (err) return err;
    await tx.patient.update({
      where: { id: input.id, tenantId: actor.tenantId },
      data: { archivedAt: input.archived ? new Date() : null },
    });
    return null;
  });
  if (denied) return { ok: false, error: denied };
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: input.archived ? "patient.archive" : "patient.unarchive",
    entity: "Patient",
    entityId: input.id,
  });
  revalidatePath("/pacientes");
  revalidatePath(`/pacientes/${input.id}`);
  return { ok: true, data: undefined };
}

/**
 * Patient core — base patient + coverages + emergency contacts.
 *
 * **Hot path + access-gated.** Returns the full payload when the actor
 * has FULL access (owner / shared / OWNER+ADMIN / sharedView), or a
 * minimal "basic" projection (name + DNI + next booking) otherwise.
 * Pages branch on `result.access`.
 *
 * Audit log is written here — `patient.read` fires once per page load
 * regardless of which tabs the user navigates into afterwards. Basic
 * access still writes the audit row so OWNER/ADMIN can see who looked
 * at whose name.
 */
export async function getPatientCore(id: string) {
  const actor = await getActor();
  const access = await patientAccessFor(actor, id);
  if (access === "none") return null;

  if (access === "basic") {
    // Minimal projection — name + DNI + next upcoming booking only.
    const [patient, nextBooking] = await Promise.all([
      runWithRls(actor.tenantId, (tx) => tx.patient.findFirst({
        where: { id, tenantId: actor.tenantId },
        select: { id: true, firstName: true, lastName: true, documentId: true },
      })),
      runWithRls(actor.tenantId, (tx) => tx.booking.findFirst({
        where: {
          patientId: id,
          scheduledFor: { gte: new Date() },
          status: { notIn: ["CANCELLED"] },
        },
        orderBy: { scheduledFor: "asc" },
        select: { scheduledFor: true },
      })),
    ]);
    if (!patient) return null;
    await audit({
      tenantId: actor.tenantId,
      actorId: actor.userId ?? undefined,
      action: "patient.read.basic",
      entity: "Patient",
      entityId: patient.id,
    });
    return {
      id: patient.id,
      firstName: patient.firstName,
      lastName: patient.lastName,
      documentId: patient.documentId,
      nextBookingAt: nextBooking?.scheduledFor ?? null,
      access: "basic" as const,
    };
  }

  // RLS adoption (Sprint 16 — Etapa 1): the FULL HC fetch is the highest
  // value target for defense-in-depth. App-layer guards (visibility +
  // patientAccessFor) decide access; `runWithRls` sets
  // `app.current_tenant_id` so the Postgres policies in
  // `prisma/migrations/policies.sql` are also enforced. Audit write
  // stays OUTSIDE the RLS tx — it's a fire-and-forget that doesn't need
  // the GUC.
  const patient = await runWithRls(actor.tenantId, async (tx) =>
    tx.patient.findFirst({
      where: { id, tenantId: actor.tenantId },
      include: {
        // Deterministic order so `coverages[0]` is always the latest/active
        // one (the app keeps a single active coverage; ordering is defence
        // in depth in case 2+ rows ever exist). cuid `id` is time-sortable.
        coverages: { orderBy: { id: "desc" } },
        emergency: true,
      },
    })
  );
  if (patient) {
    await audit({
      tenantId: actor.tenantId,
      actorId: actor.userId ?? undefined,
      action: "patient.read",
      entity: "Patient",
      entityId: patient.id,
    });
    return { ...patient, access: "full" as const };
  }
  return null;
}

/**
 * Lite list of patient's programs — programs + minimal session metadata
 * (id, index, completedAt, scheduledFor, notes, exercise count) but
 * **no** SessionExercise rows / Exercise joins. Enough for:
 *
 *   - Resumen tab (active program detection + done count)
 *   - SesionesView (list rows with status + exercise count)
 *   - Tab badges (programs.length, allSessionsCount)
 *
 * The heavy join (SessionExercise + Exercise) is only fetched by
 * `getPatientProgramsFull` when the Plan tab opens.
 */
export async function getPatientProgramsLite(patientId: string) {
  const actor = await getActor();
  const access = await patientAccessFor(actor, patientId);
  if (access !== "full") return [];
  return runWithRls(actor.tenantId, (tx) => tx.treatmentProgram.findMany({
    where: { patientId },
    select: {
      id: true,
      title: true,
      status: true,
      totalSessions: true,
      frequency: true,
      startDate: true,
      createdAt: true,
      sessions: {
        orderBy: { index: "asc" },
        select: {
          id: true,
          index: true,
          scheduledFor: true,
          completedAt: true,
          notes: true,
          _count: { select: { exercises: true } },
        },
      },
      case: {
        select: {
          diagnoses: {
            take: 1,
            orderBy: { rank: "asc" },
            select: { condition: { select: { id: true, name: true, cie10: true } } },
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  }));
}

/**
 * Aggregate count of bookings worth showing on the Facturación tab
 * badge — anything that isn't UNPAID counts as "billable". Cheap;
 * keeps the tab count accurate without paying for the full bookings
 * payload until the user actually opens that tab.
 */
export async function getPatientBillableCount(patientId: string) {
  const actor = await getActor();
  const access = await patientAccessFor(actor, patientId);
  if (access !== "full") return 0;
  return runWithRls(actor.tenantId, (tx) => tx.booking.count({
    where: {
      patientId,
      paymentStatus: { not: "UNPAID" },
    },
  }));
}

/**
 * Full patient programs — all sessions + ordered exercises, with the
 * clinical case + diagnoses. Heavy. Only fetch when the user opens
 * the Sesiones or Plan tab.
 */
export async function getPatientProgramsFull(patientId: string) {
  const actor = await getActor();
  const access = await patientAccessFor(actor, patientId);
  if (access !== "full") return [];
  return runWithRls(actor.tenantId, (tx) => tx.treatmentProgram.findMany({
    where: { patientId },
    include: {
      sessions: {
        orderBy: { index: "asc" },
        include: {
          exercises: { include: { exercise: true }, orderBy: { order: "asc" } },
        },
      },
      case: { include: { diagnoses: { include: { condition: true } } } },
    },
    orderBy: { createdAt: "desc" },
  }));
}

/**
 * Resolve a patient's active obra social → { name, copagoCents }. Used to
 * stamp the billing line on each booking row. "Particular" + null copago
 * when there's no coverage (the caller falls back to the service price).
 */
type PatientBilling = {
  obraSocial: string;
  coverageOverride: number | null; // per-patient copago override
  hasCoverage: boolean;
  insurerCopago: number | null;
  particularCopago: number | null;
  // What the obra social reimburses the kine per session (Insurer.fixedFeeCents).
  // 0 for Particular / uninsured / free-form coverage (no OS pays).
  insurerFixedFeeCents: number;
  /** The coverage row points at the tenant's Particular Insurer (per-patient override holder). */
  isParticular: boolean;
};

async function resolvePatientBilling(
  patientId: string,
  tenantId: string
): Promise<PatientBilling> {
  const coverage = await runWithRls(tenantId, (tx) => tx.coverage.findFirst({
    where: { patientId },
    include: { insurerRef: true },
    orderBy: { id: "desc" }, // deterministic: latest coverage = active
  }));
  if (!coverage) {
    // No obra social → Particular. Use the tenant's configured Particular
    // copago exactly as set (incl. 0). `null` only when there's no
    // Particular row, in which case callers fall back to the service price.
    const particularCopago = await getParticularCopagoCents(tenantId);
    return {
      obraSocial: "Particular",
      coverageOverride: null,
      hasCoverage: false,
      insurerCopago: null,
      particularCopago,
      insurerFixedFeeCents: 0,
      isParticular: true,
    };
  }
  return {
    obraSocial: coverage.insurerRef?.name ?? coverage.insurer ?? "Particular",
    coverageOverride: coverage.copagoCents,
    hasCoverage: true,
    insurerCopago: coverage.insurerRef ? coverage.insurerRef.copagoCents : null,
    particularCopago: null,
    insurerFixedFeeCents: coverage.insurerRef?.fixedFeeCents ?? 0,
    isParticular: coverage.insurerRef?.isParticular === true,
  };
}

/**
 * Recent bookings — capped at `take`. Used by the Resumen tab.
 *
 * Now carries the billing line (serviceName + obra social + copago) so
 * the patient turnos list can show "Servicio - ObraSocial - $Copago".
 * Copago = insurer copago when insured, else the service price.
 */
export async function getPatientBookingsSummary(patientId: string, take = 5) {
  const actor = await getActor();
  const access = await patientAccessFor(actor, patientId);
  if (access !== "full") return [];
  const [rows, billing] = await Promise.all([
    runWithRls(actor.tenantId, (tx) => tx.booking.findMany({
      where: { patientId },
      orderBy: { scheduledFor: "desc" },
      take,
      select: {
        id: true,
        scheduledFor: true,
        durationMin: true,
        status: true,
        paymentStatus: true,
        notes: true,
        title: true,
        description: true,
        copagoCents: true,
        service: { select: { name: true, priceCents: true } },
      },
    })),
    resolvePatientBilling(patientId, actor.tenantId),
  ]);
  return rows.map(({ service, copagoCents: bookingCopago, ...b }) => ({
    ...b,
    serviceName: service.name,
    obraSocial: billing.obraSocial,
    copagoCents: resolveBookingCopagoCents({
      bookingOverride: bookingCopago,
      coverageOverride: billing.coverageOverride,
      hasCoverage: billing.hasCoverage,
      insurerCopago: billing.insurerCopago,
      particularCopago: billing.particularCopago,
      servicePriceCents: service.priceCents,
    }),
  }));
}

/**
 * Full bookings list for the Turnos + Facturación tabs, paginated.
 *
 * A2a-S08: antes devolvía un array cortado en 100 sin avisar — un paciente
 * largo "perdía" sus turnos viejos en Facturación. Ahora devuelve
 * `{ rows, hasMore, nextCursor }`; el perfil muestra "Últimos N · Ver más" y
 * pide la página siguiente con `cursor` = `nextCursor`. Orden estable
 * `scheduledFor desc, id desc` para que el cursor no saltee ni repita filas
 * con el mismo horario. Carries the same billing line as
 * `getPatientBookingsSummary` (service + obra social + copago).
 */
export async function getPatientBookingsAll(patientId: string, take = 100, cursor?: string) {
  const actor = await getActor();
  const access = await patientAccessFor(actor, patientId);
  const size = Math.min(Math.max(Math.trunc(take) || 100, 1), 200);
  if (access !== "full") {
    return { rows: [] as PatientBookingFull[], hasMore: false, nextCursor: null as string | null };
  }
  const [found, billing] = await Promise.all([
    runWithRls(actor.tenantId, (tx) => tx.booking.findMany({
      where: { patientId, tenantId: actor.tenantId },
      orderBy: [{ scheduledFor: "desc" }, { id: "desc" }],
      take: size + 1, // +1 = sonda de "hay más"
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { service: { select: { name: true, priceCents: true } } },
    })),
    resolvePatientBilling(patientId, actor.tenantId),
  ]);
  const hasMore = found.length > size;
  const page = hasMore ? found.slice(0, size) : found;
  const rows: PatientBookingFull[] = page.map(({ service, copagoCents: bookingCopago, ...b }) => ({
    ...b,
    serviceName: service.name,
    obraSocial: billing.obraSocial,
    // What the patient pays (copago) and what the OS reimburses (osAmount),
    // kept separate for the Facturación tab. `insurerPaidAt` rides along in
    // `...b` (booking scalar) so the UI knows if the OS already paid.
    copagoCents: resolveBookingCopagoCents({
      bookingOverride: bookingCopago,
      coverageOverride: billing.coverageOverride,
      hasCoverage: billing.hasCoverage,
      insurerCopago: billing.insurerCopago,
      particularCopago: billing.particularCopago,
      servicePriceCents: service.priceCents,
    }),
    osAmountCents: billing.insurerFixedFeeCents,
  }));
  return { rows, hasMore, nextCursor: hasMore ? page[page.length - 1].id : null };
}

/**
 * EVA scores — chronological. Used by the Evolución tab chart.
 */
export async function getPatientEvaScores(patientId: string) {
  const actor = await getActor();
  const access = await patientAccessFor(actor, patientId);
  if (access !== "full") return [];
  return runWithRls(actor.tenantId, (tx) => tx.evaScore.findMany({
    where: { patientId },
    orderBy: { takenAt: "asc" },
  }));
}

/**
 * **Backwards-compatible wrapper** — loads everything in one shot like
 * the pre-Sprint-16 implementation. Kept so callers that haven't
 * migrated yet (`generateMetadata`, ad-hoc scripts) still work.
 *
 * New code should call the slice-specific fetchers above so it doesn't
 * pay for relations it doesn't render.
 */
export async function getPatient(id: string) {
  const actor = await getActor();
  const v = await visibilityForActor(actor);
  const patient = await runWithRls(actor.tenantId, (tx) => tx.patient.findFirst({
    where: { id, tenantId: actor.tenantId, ...v.patientWhere },
    include: {
      coverages: { orderBy: { id: "desc" } },
      emergency: true,
      programs: {
        include: {
          sessions: {
            orderBy: { index: "asc" },
            include: {
              exercises: { include: { exercise: true }, orderBy: { order: "asc" } },
            },
          },
          case: { include: { diagnoses: { include: { condition: true } } } },
        },
        orderBy: { createdAt: "desc" },
      },
      bookings: { orderBy: { scheduledFor: "desc" }, take: 20 },
      evaScores: { orderBy: { takenAt: "asc" } },
    },
  }));
  if (patient) {
    await audit({
      tenantId: actor.tenantId,
      actorId: actor.userId ?? undefined,
      action: "patient.read",
      entity: "Patient",
      entityId: patient.id,
    });
  }
  return patient;
}

/**
 * Lightweight name-only fetch for metadata + breadcrumbs. Avoids the
 * audit write so it doesn't double-log every page view.
 */
export async function getPatientName(id: string) {
  const actor = await getActor();
  return runWithRls(actor.tenantId, (tx) => tx.patient.findFirst({
    where: { id, tenantId: actor.tenantId },
    select: { firstName: true, lastName: true },
  }));
}

/**
 * Map a Prisma unique-constraint violation (P2002) on the Patient table to
 * a field-specific, human-friendly error. Returns null when `e` isn't a
 * P2002 so callers can fall through to a generic message. `e.meta.target`
 * carries the offending column list (e.g. ["tenantId","email"]).
 */
function patientUniqueError(
  e: unknown
): { ok: false; error: string; fieldErrors?: Record<string, string[]> } | null {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") return null;
  const target = Array.isArray(e.meta?.target) ? (e.meta!.target as string[]) : [];
  if (target.includes("documentId"))
    return { ok: false, error: "Ya existe un paciente con ese DNI en este consultorio.", fieldErrors: { documentId: ["DNI ya registrado"] } };
  if (target.includes("email"))
    return { ok: false, error: "Ya existe un paciente con ese email en este consultorio.", fieldErrors: { email: ["Email ya registrado"] } };
  if (target.includes("phone"))
    return { ok: false, error: "Ya existe un paciente con ese teléfono en este consultorio.", fieldErrors: { phone: ["Teléfono ya registrado"] } };
  return { ok: false, error: "Ya existe un paciente con esos datos en este consultorio." };
}

export async function createPatient(
  raw: PatientCreateInput
): Promise<ActionResult<{ id: string }>> {
  const actor = await getActor();
  const parsed = PatientCreate.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Datos inválidos",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  // Coverage fields aren't `Patient` columns — split them out before the
  // create so Prisma doesn't choke, and use them to seed the primary
  // Coverage inside the same transaction.
  const { insurerId, insurerName, ...patientData } = parsed.data;
  try {
    // RLS Etapa 2: create runs under the tenant GUC. The notify+audit
    // calls land outside the transaction since they're fire-and-forget.
    const p = await runWithRls(actor.tenantId, async (tx) => {
      const created = await tx.patient.create({
        data: {
          ...patientData,
          // Patient-level active diagnosis (short title + long note). These
          // ARE Patient columns (unlike insurerId/insurerName), so persist
          // them explicitly — empty → null. Auto-fills new turnos.
          diagnosisTitle: parsed.data.diagnosisTitle ?? null,
          diagnosisNote: parsed.data.diagnosisNote ?? null,
          tenantId: actor.tenantId,
          // Auto-assign the new patient to the kine creating them, so the
          // per-kine visibility mode works out of the box. OWNER/ADMIN can
          // later re-assign or set null for "consultorio común".
          assignedPractitionerId: actor.practitionerId,
        },
      });
      // Seed coverage when an obra social was chosen at creation time.
      let resolvedName = "";
      let resolvedInsurerId: string | null = null;
      if (insurerId) {
        const ins = await tx.insurer.findFirst({
          where: { id: insurerId, tenantId: actor.tenantId },
          select: { id: true, name: true },
        });
        if (ins) {
          resolvedInsurerId = ins.id;
          resolvedName = ins.name;
        }
      } else if (insurerName) {
        // Free-form ("Otra"): normalize + link to the catalogue if it matches.
        const r = await resolveInsurerName(actor.tenantId, insurerName, tx);
        resolvedInsurerId = r.insurerId;
        resolvedName = r.name;
      }
      if (resolvedName) {
        await tx.coverage.create({
          data: { patientId: created.id, insurer: resolvedName, insurerId: resolvedInsurerId },
        });
      }
      return created;
    });
    await audit({
      tenantId: actor.tenantId,
      actorId: actor.userId ?? undefined,
      action: "patient.create",
      entity: "Patient",
      entityId: p.id,
    });
    if (actor.userId) {
      await notify({
        tenantId: actor.tenantId,
        userId: actor.userId,
        kind: NotificationKind.PATIENT_NEW,
        title: `Nuevo paciente · ${p.firstName} ${p.lastName}`,
        body: p.email ?? p.documentId ?? undefined,
        link: `/pacientes/${p.id}`,
      });
    }
    revalidatePath("/pacientes");
    return { ok: true, data: { id: p.id } };
  } catch (e) {
    const dup = patientUniqueError(e);
    if (dup) return dup;
    logger.error("patient.create.failed", { err: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: "No pudimos crear el paciente." };
  }
}

/** Campos de `Patient` que edita `updatePatient` (y que se comparan para el audit). */
const PATIENT_EDITABLE_FIELDS = [
  "firstName",
  "lastName",
  "email",
  "phone",
  "documentId",
  "dateOfBirth",
  "notes",
  "diagnosisTitle",
  "diagnosisNote",
] as const;

/**
 * Editar la ficha (drawer "Editar paciente" del perfil).
 *
 * A2a-S08:
 *  - `""` borra los opcionales (→ null) — antes respondía OK y el valor quedaba.
 *  - optimistic lock con `Patient.updatedAt` (`expectedUpdatedAt`): el UPDATE
 *    lleva el `updatedAt` leído en el WHERE, así dos pestañas editando la misma
 *    ficha no se pisan en silencio (la segunda recibe "cambió en otra sesión").
 *  - exige acceso `full` (decisión del dueño 30-sep: acceso básico = solo ver).
 *  - el audit registra QUÉ campos cambiaron (solo nombres, sin valores: PHI).
 */
export async function updatePatient(
  raw: PatientUpdateInput
): Promise<ActionResult<{ id: string; updatedAt: string }>> {
  const actor = await getActor();
  const parsed = PatientUpdate.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Datos inválidos",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const { id, expectedUpdatedAt, ...data } = parsed.data;
  // RLS Etapa 2: the ownership check + update share the same tx so a
  // race that flipped tenantId between them couldn't slip through. The
  // try/catch surfaces the email/phone uniqueness violations with a
  // field-specific message instead of crashing the action.
  type Outcome =
    | { kind: "notfound" }
    | { kind: "forbidden" }
    | { kind: "stale" }
    | { kind: "ok"; changed: string[]; updatedAt: Date };
  let outcome: Outcome;
  try {
    outcome = await runWithRls(actor.tenantId, async (tx): Promise<Outcome> => {
      const before = await tx.patient.findFirst({
        where: { id, tenantId: actor.tenantId },
        select: {
          id: true,
          updatedAt: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          documentId: true,
          dateOfBirth: true,
          notes: true,
          diagnosisTitle: true,
          diagnosisNote: true,
        },
      });
      if (!before) return { kind: "notfound" };
      if ((await patientAccessFor(actor, id, tx)) !== "full") return { kind: "forbidden" };
      if (expectedUpdatedAt && +before.updatedAt !== +new Date(expectedUpdatedAt)) {
        return { kind: "stale" };
      }
      const prev: Record<string, unknown> = before;
      const same = (a: unknown, b: unknown) =>
        a instanceof Date || b instanceof Date ? +(a as Date) === +(b as Date) : (a ?? null) === (b ?? null);
      const changed = PATIENT_EDITABLE_FIELDS.filter(
        (f) => (data as Record<string, unknown>)[f] !== undefined && !same(prev[f], (data as Record<string, unknown>)[f])
      );
      // `updatedAt` leído en el WHERE: si otra tx lo movió entre el SELECT y
      // acá (READ COMMITTED), count = 0 → stale en vez de pisar.
      const res = await tx.patient.updateMany({
        where: { id, tenantId: actor.tenantId, updatedAt: before.updatedAt },
        data,
      });
      if (res.count === 0) return { kind: "stale" };
      const after = await tx.patient.findUniqueOrThrow({ where: { id }, select: { updatedAt: true } });
      return { kind: "ok", changed, updatedAt: after.updatedAt };
    });
  } catch (e) {
    const dup = patientUniqueError(e);
    if (dup) return dup;
    logger.error("patient.update.failed", { err: e instanceof Error ? e.message : String(e) });
    throw e;
  }
  if (outcome.kind === "notfound") return { ok: false, error: "Paciente no encontrado." };
  if (outcome.kind === "forbidden") {
    return { ok: false, error: "No tenés acceso completo a este paciente: solo podés verlo." };
  }
  if (outcome.kind === "stale") {
    return {
      ok: false,
      error: "La ficha cambió en otra sesión mientras la editabas. Cerrá y volvé a abrir para ver los cambios.",
    };
  }
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "patient.update",
    entity: "Patient",
    entityId: id,
    payload: { fields: outcome.changed },
  });
  revalidatePath("/pacientes");
  revalidatePath(`/pacientes/${id}`);
  return { ok: true, data: { id, updatedAt: outcome.updatedAt.toISOString() } };
}

/**
 * Set the patient's active diagnosis (short title + long note). These
 * fields auto-fill the title/description of every NEW turno created for
 * the patient, so the booking-drawer calls this when the practitioner
 * edits the diagnosis inline. Empty strings clear the field (→ null).
 *
 * Same RLS-guarded pattern as the other patient mutations: the ownership
 * check + update share one tenant-GUC transaction; audit + revalidate
 * fire outside it.
 */
export async function setPatientDiagnosis(
  patientId: string,
  title: string,
  note: string
): Promise<ActionResult> {
  const actor = await getActor();
  const result = await runWithRls(actor.tenantId, async (tx) => {
    const access = await hcAccessError(actor, patientId, tx);
    if (access) return { ok: false as const, error: access };
    await tx.patient.update({
      where: { id: patientId },
      data: {
        diagnosisTitle: title.trim() || null,
        diagnosisNote: note.trim() || null,
      },
    });
    return { ok: true as const };
  });
  if (!result.ok) return { ok: false, error: result.error };
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "patient.diagnosis.update",
    entity: "Patient",
    entityId: patientId,
  });
  revalidatePath(`/pacientes/${patientId}`);
  revalidatePath("/agenda");
  return { ok: true, data: undefined };
}

/**
 * A2b-S-vis (30-sep) — gate `full` de las mutaciones de HC. Decisión del
 * dueño: acceso básico = solo ver. Antes estas actions solo chequeaban el
 * tenant, así que un profesional no asignado ni compartido podía editar el
 * diagnóstico, crear/editar planes, cargar EVA o archivar pacientes ajenos
 * desde la consola. Devuelve el mensaje de error, o `null` si puede seguir.
 * Corre dentro del `runWithRls` del caller (pasa su `tx`).
 */
async function hcAccessError(
  actor: Actor,
  patientId: string,
  tx: Prisma.TransactionClient
): Promise<string | null> {
  const access = await patientAccessFor(actor, patientId, tx);
  if (access === "none") return "Paciente no encontrado.";
  if (access !== "full") return "No tenés acceso completo a este paciente.";
  return null;
}

/**
 * Gate a hard-delete of a plan/session (or other admin-only mutation) to OWNER/ADMIN.
 * Returns an `ActionResult` error when the actor's membership role is
 * anything else, or `null` when the actor may proceed. Mirrors the inline
 * role check in `assignPatientToPractitioner`.
 */
async function requireAdminRole(
  actor: Actor
): Promise<{ ok: false; error: string } | null> {
  // B1.7: el rol sale de `lib/authz` (una query por request, cacheada) y el
  // criterio OWNER/ADMIN de `lib/capabilities` (un solo lugar para C0).
  if (!isTenantAdminRole(await getMembershipRole(actor))) {
    return {
      ok: false,
      error: "Solo el dueño o un administrador puede eliminar definitivamente.",
    };
  }
  return null;
}

// A2a-S08 (decisión del dueño 30-sep): se quitó `deletePatient`. El borrado
// definitivo de una ficha arrastraba en cascada turnos, cobros, planes y
// archivos sin retorno; la única salida es Archivar (`setPatientArchived`).

export async function createProgram(input: {
  patientId: string;
  title: string;
  totalSessions: number;
  frequency: number;
  startDate: Date;
}): Promise<ActionResult<{ id: string }>> {
  const actor = await getActor();
  // RLS Etapa 2: owner check + program-with-nested-sessions create
  // share the tx. Returns null if the patient isn't in this tenant.
  const program = await runWithRls(actor.tenantId, async (tx) => {
    const denied = await hcAccessError(actor, input.patientId, tx);
    if (denied) return { error: denied };
    return tx.treatmentProgram.create({
      data: {
        tenantId: actor.tenantId,
        patientId: input.patientId,
        title: input.title,
        totalSessions: input.totalSessions,
        frequency: input.frequency,
        startDate: input.startDate,
        sessions: {
          create: Array.from({ length: input.totalSessions }).map((_, i) => ({
            practitionerId: actor.practitionerId,
            index: i + 1,
            scheduledFor: new Date(
              input.startDate.getTime() + Math.floor(i * (7 / input.frequency)) * 86_400_000
            ),
          })),
        },
      },
    });
  });
  if ("error" in program) return { ok: false, error: program.error };
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "program.create",
    entity: "TreatmentProgram",
    entityId: program.id,
  });
  revalidatePath(`/pacientes/${input.patientId}`);
  return { ok: true, data: { id: program.id } };
}

export async function recordEvaScore(input: {
  patientId: string;
  value: number;
  source?: string;
}): Promise<ActionResult<{ id: string }>> {
  const actor = await getActor();
  // Gate + insert en la misma tx (antes eran dos: check y escritura separados).
  const row = await runWithRls(actor.tenantId, async (tx) => {
    const denied = await hcAccessError(actor, input.patientId, tx);
    if (denied) return { error: denied };
    return tx.evaScore.create({
      data: { patientId: input.patientId, value: input.value, source: input.source },
    });
  });
  if ("error" in row) return { ok: false, error: row.error };
  revalidatePath(`/pacientes/${input.patientId}`);
  return { ok: true, data: { id: row.id } };
}

// `completeSession` (cierre de sesión en 4 tx, sin gate de acceso ni idempotencia)
// se borró en A2a: no tenía callers y el cierre vive en
// `completeSessionFromSeguimiento` (lib/sessions.ts), atómico e idempotente (H3).

// ──────────────────────────────────────────────────────────────────────
// Coverage (Obra Social) management
// ──────────────────────────────────────────────────────────────────────

/**
 * Set the patient's primary coverage. Either `insurerId` resolves to a tenant
 * Insurer row, OR `insurerName` writes a free-form name (when the practitioner
 * hasn't created the Insurer yet). Neither = "Particular" (sin cobertura).
 *
 * H2 (A2a-S08): antes hacía `deleteMany` + `create` en CADA guardado, así que
 * editar solo el N° de afiliado (o re-guardar una OS "Otra", que el drawer
 * re-enviaba siempre) borraba `Coverage.copagoCents` — el copago propio del
 * paciente — y `validUntil`, y los turnos siguientes cobraban el copago de la
 * OS sin que nadie lo notara. Ahora:
 *  - misma OS → UPDATE en el lugar (conserva copago propio y vigencia);
 *  - OS distinta → UPDATE en el lugar con la OS nueva; el copago propio se
 *    borra SOLO si el caller lo confirma (`resetCopago: true`; la UI lo pide
 *    con useConfirm). La vigencia sí se resetea: era de la credencial vieja.
 *  - pasar a Particular con copago propio conservado → la fila queda como
 *    "Particular" con el override (igual que `setPatientDefaultCopago`).
 * La cobertura sigue siendo single-active (`coverages[0]` = id desc): las
 * filas legacy extra se borran.
 */
export async function setPatientCoverage(input: {
  patientId: string;
  insurerId?: string;
  insurerName?: string;
  planName?: string;
  /** Plan del catálogo (`PayerPlan`) de la prestadora vinculada al Insurer. */
  payerPlanId?: string;
  memberId?: string;
  resetCopago?: boolean;
}): Promise<ActionResult> {
  const actor = await getActor();

  const parsed = CoverageSet.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Datos de cobertura inválidos.",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const { patientId, insurerId, insurerName, planName, payerPlanId, memberId, resetCopago } = parsed.data;

  // RLS-guarded: the ownership check, the insurer lookup and the write of the
  // Coverage row all run inside the same tenant GUC transaction. Previously
  // the ownership check sat OUTSIDE any tx, so a race that flipped the
  // patient's tenantId between check and write could attach coverage to a
  // foreign patient (audit finding: critical race).
  const result = await runWithRls(actor.tenantId, async (tx) => {
    const owned = await tx.patient.findFirst({
      where: { id: patientId, tenantId: actor.tenantId },
      select: { id: true },
    });
    if (!owned) return { ok: false as const, error: "Paciente no encontrado." };
    if ((await patientAccessFor(actor, patientId, tx)) !== "full") {
      return { ok: false as const, error: "No tenés acceso completo a este paciente: solo podés verlo." };
    }

    let resolvedName = "";
    let resolvedInsurerId: string | null = null;
    let resolvedIsParticular = false;
    let insurerPayerId: string | null = null;
    if (insurerId) {
      const ins = await tx.insurer.findFirst({
        where: { id: insurerId, tenantId: actor.tenantId },
        select: { id: true, name: true, isParticular: true, payerId: true },
      });
      if (!ins) return { ok: false as const, error: "Obra social no encontrada." };
      resolvedInsurerId = ins.id;
      resolvedName = ins.name;
      resolvedIsParticular = ins.isParticular;
      insurerPayerId = ins.payerId;
    } else if (insurerName) {
      // Free-form ("Otra"): normalize + link to the catalogue if it matches.
      const r = await resolveInsurerName(actor.tenantId, insurerName, tx);
      resolvedInsurerId = r.insurerId;
      resolvedName = r.name;
    }

    // B1 (catálogo): plan de la prestadora. La FK `Coverage.payerPlanId`
    // saltea RLS (y en prod la conexión tiene BYPASSRLS), así que el plan se
    // valida acá, en la misma tx: global o propuesto por ESTE consultorio, no
    // archivado, y de la prestadora vinculada a la OS elegida. Sin OS
    // vinculada al catálogo no hay plan posible (si no, `payerId` vacío
    // aceptaría el plan de cualquier prestadora). Particular nunca lleva plan.
    let resolvedPlan: { id: string; name: string } | null = null;
    if (payerPlanId) {
      if (!resolvedInsurerId || resolvedIsParticular || !insurerPayerId) {
        return { ok: false as const, error: "Plan no encontrado para esta obra social." };
      }
      resolvedPlan = await findUsablePayerPlan(tx, actor.tenantId, payerPlanId, insurerPayerId);
      if (!resolvedPlan) return { ok: false as const, error: "Plan no encontrado para esta obra social." };
    }

    const existing = await tx.coverage.findFirst({
      where: { patientId },
      orderBy: { id: "desc" }, // same "active" row the resolver reads
      select: {
        id: true,
        insurer: true,
        insurerId: true,
        copagoCents: true,
        insurerRef: { select: { isParticular: true } },
      },
    });

    // "Particular" = sin fila o fila apuntando al Insurer isParticular.
    const norm = (s: string) => s.trim().toLowerCase();
    const newIsParticular = !resolvedName || resolvedIsParticular;
    const oldIsParticular = !existing || existing.insurerRef?.isParticular === true;
    const sameOs =
      newIsParticular || oldIsParticular
        ? newIsParticular && oldIsParticular
        : existing!.insurerId && resolvedInsurerId
          ? existing!.insurerId === resolvedInsurerId
          : norm(existing!.insurer) === norm(resolvedName);

    const copagoReset = !sameOs && resetCopago === true && existing?.copagoCents != null;
    const keptCopago = !existing ? null : sameOs || !resetCopago ? existing.copagoCents : null;

    if (existing) {
      // Single-active: drop legacy duplicates, keep the row we update.
      await tx.coverage.deleteMany({ where: { patientId, id: { not: existing.id } } });
    }

    if (!resolvedName) {
      // → Particular sin OS. Si queda un copago propio, se materializa como
      // fila "Particular" con el override (el resolver lo lee por hasCoverage).
      if (existing && keptCopago != null) {
        if (!oldIsParticular) {
          const particular = await tx.insurer.findFirst({
            where: { tenantId: actor.tenantId, isParticular: true },
            select: { id: true, name: true },
          });
          await tx.coverage.update({
            where: { id: existing.id },
            data: {
              insurer: particular?.name ?? "Particular",
              insurerId: particular?.id ?? null,
              planName: null,
              payerPlanId: null,
              memberId: null,
              validUntil: null,
              copagoCents: keptCopago,
            },
          });
        }
      } else if (existing) {
        await tx.coverage.deleteMany({ where: { patientId } });
      }
    } else if (existing) {
      await tx.coverage.update({
        where: { id: existing.id },
        data: {
          insurer: resolvedName,
          insurerId: resolvedInsurerId,
          // `planName` = cache de display: con plan del catálogo, su nombre.
          payerPlanId: resolvedPlan?.id ?? null,
          planName: resolvedPlan?.name ?? (planName?.trim() || null),
          memberId: memberId?.trim() || null,
          copagoCents: keptCopago,
          // La vigencia es de la credencial: se conserva solo con la misma OS.
          ...(sameOs ? {} : { validUntil: null }),
        },
      });
    } else {
      await tx.coverage.create({
        data: {
          patientId,
          insurer: resolvedName,
          insurerId: resolvedInsurerId,
          payerPlanId: resolvedPlan?.id ?? null,
          planName: resolvedPlan?.name ?? (planName?.trim() || null),
          memberId: memberId?.trim() || null,
        },
      });
    }
    return {
      ok: true as const,
      resolvedName,
      resolvedInsurerId,
      payerPlanId: resolvedPlan?.id ?? null,
      osChanged: !sameOs,
      copagoReset,
    };
  });

  if (!result.ok) return { ok: false, error: result.error };
  const { resolvedName, resolvedInsurerId, osChanged, copagoReset } = result;

  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "patient.coverage.update",
    entity: "Patient",
    entityId: patientId,
    payload: {
      insurer: resolvedName || "Particular",
      insurerId: resolvedInsurerId,
      payerPlanId: result.payerPlanId,
      osChanged,
      copagoReset,
    },
  });
  revalidatePath(`/pacientes/${patientId}`);
  revalidatePath("/agenda");
  return { ok: true, data: undefined };
}

/**
 * Billing preview for the booking modal: the patient's obra social + what the
 * turno would charge, computed with THE SAME resolver the booking uses
 * (`resolveBookingCopagoCents`, AUDIT §5 precedence). Prefills the editable
 * copago row when a patient is picked.
 *
 * A2a-S08: antes calculaba `override ?? insurer ?? particular ?? 0` a mano:
 * sin el escalón "precio del servicio", una OS libre sin catálogo mostraba $0
 * en el modal y el turno cobraba el precio del servicio.
 *
 * `serviceId` opcional: sin él se usa el primer servicio del tenant en el
 * orden del modal (`listServices`, nombre asc). El modal lo re-consulta al
 * cambiar de servicio. `source` dice de qué escalón salió el monto.
 * Returns null when the actor lacks full access to the patient.
 */
export async function getPatientBillingPreview(
  patientId: string,
  serviceId?: string
): Promise<{
  obraSocial: string;
  copagoCents: number;
  source: "OS" | "copago propio" | "Particular" | "precio del servicio";
  /** Servicio cuyo precio se usó (el pedido, o el default si no vino). */
  serviceId: string | null;
} | null> {
  const actor = await getActor();
  const access = await patientAccessFor(actor, patientId);
  if (access !== "full") return null;
  const [b, service] = await Promise.all([
    resolvePatientBilling(patientId, actor.tenantId),
    runWithRls(actor.tenantId, (tx) =>
      tx.service.findFirst({
        where: { tenantId: actor.tenantId, ...(serviceId ? { id: serviceId } : {}) },
        orderBy: { name: "asc" },
        select: { id: true, priceCents: true },
      })
    ),
  ]);
  const copagoCents = resolveBookingCopagoCents({
    bookingOverride: null,
    coverageOverride: b.coverageOverride,
    hasCoverage: b.hasCoverage,
    insurerCopago: b.insurerCopago,
    particularCopago: b.particularCopago,
    servicePriceCents: service?.priceCents ?? 0,
  });
  // Mismo orden que el resolver (lib/copago.ts), solo para etiquetar la fuente.
  const source = b.hasCoverage
    ? b.coverageOverride != null
      ? "copago propio"
      : b.insurerCopago != null
        ? b.isParticular ? "Particular" : "OS"
        : "precio del servicio"
    : b.particularCopago != null
      ? "Particular"
      : "precio del servicio";
  return { obraSocial: b.obraSocial, copagoCents, source, serviceId: service?.id ?? null };
}

/**
 * Update the patient's DEFAULT copago — a per-patient override stored on
 * their Coverage row. Triggered by the "¿Actualizar el copago?" prompt in
 * the booking modal ("ambas opciones": the turno keeps its own override, and
 * this makes the new amount the patient's standing value going forward). If
 * the patient has no coverage (Particular), attach a Particular row carrying
 * the override.
 */
export async function setPatientDefaultCopago(input: {
  patientId: string;
  copagoCents: number;
}): Promise<ActionResult> {
  const actor = await getActor();
  // Mismo tope que `BookingCreate.copagoCents` (centavos Int).
  if (!Number.isFinite(input.copagoCents) || input.copagoCents < 0 || input.copagoCents > 100_000_00) {
    return { ok: false, error: "Copago inválido." };
  }
  const copago = Math.round(input.copagoCents);
  const result = await runWithRls(actor.tenantId, async (tx) => {
    const owned = await tx.patient.findFirst({
      where: { id: input.patientId, tenantId: actor.tenantId },
      select: { id: true },
    });
    if (!owned) return { ok: false as const, error: "Paciente no encontrado." };
    if ((await patientAccessFor(actor, input.patientId, tx)) !== "full") {
      return { ok: false as const, error: "No tenés acceso completo a este paciente: solo podés verlo." };
    }
    // `orderBy id desc`: la fila ACTIVA (la que lee el resolver). Sin orden,
    // con filas legacy duplicadas se podía escribir el override en otra.
    const coverage = await tx.coverage.findFirst({
      where: { patientId: input.patientId },
      orderBy: { id: "desc" },
      select: { id: true },
    });
    if (coverage) {
      await tx.coverage.update({ where: { id: coverage.id }, data: { copagoCents: copago } });
    } else {
      // No coverage → Particular. Attach a Particular row with the override.
      const particular = await tx.insurer.findFirst({
        where: { tenantId: actor.tenantId, isParticular: true },
        select: { id: true, name: true },
      });
      await tx.coverage.create({
        data: {
          patientId: input.patientId,
          insurer: particular?.name ?? "Particular",
          insurerId: particular?.id ?? null,
          copagoCents: copago,
        },
      });
    }
    return { ok: true as const };
  });
  if (!result.ok) return { ok: false, error: result.error };
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "patient.copago.update",
    entity: "Patient",
    entityId: input.patientId,
    payload: { copagoCents: copago },
  });
  revalidatePath(`/pacientes/${input.patientId}`);
  revalidatePath("/agenda");
  return { ok: true, data: undefined };
}

/**
 * Re-assign a patient to another practitioner of the same tenant — or
 * unassign (set to `null` = "consultorio común").
 *
 * Auth: OWNER + ADMIN only (PRACTITIONER could only see their own
 * patients in per-kine mode and shouldn't be able to give them away).
 * The visibility filter already enforces who sees what, so we just
 * enforce the role on write.
 */
export async function assignPatientToPractitioner(input: {
  patientId: string;
  practitionerId: string | null;
}): Promise<ActionResult> {
  const actor = await getActor();
  if (!isTenantAdminRole(await getMembershipRole(actor))) {
    return { ok: false, error: "Solo OWNER/ADMIN pueden re-asignar pacientes." };
  }

  const owned = await runWithRls(actor.tenantId, (tx) => tx.patient.findFirst({
    where: { id: input.patientId, tenantId: actor.tenantId },
    select: { id: true, assignedPractitionerId: true },
  }));
  if (!owned) return { ok: false, error: "Paciente no encontrado." };

  if (input.practitionerId) {
    const prac = await runWithRls(actor.tenantId, (tx) => tx.practitioner.findFirst({
      where: { id: input.practitionerId!, tenantId: actor.tenantId },
      select: { id: true },
    }));
    if (!prac) return { ok: false, error: "Profesional fuera del tenant." };
  }

  await runWithRls(actor.tenantId, (tx) => tx.patient.update({
    where: { id: input.patientId },
    data: { assignedPractitionerId: input.practitionerId },
  }));
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "patient.reassign",
    entity: "Patient",
    entityId: input.patientId,
    payload: {
      from: owned.assignedPractitionerId,
      to: input.practitionerId,
    },
  });
  revalidatePath(`/pacientes/${input.patientId}`);
  revalidatePath("/pacientes");
  return { ok: true, data: undefined };
}

// ──────────────────────────────────────────────────────────────────────
// Program / Session CRUD
// ──────────────────────────────────────────────────────────────────────

export async function updateProgram(input: {
  id: string;
  title?: string;
  totalSessions?: number;
  frequency?: number;
  startDate?: string;
}): Promise<ActionResult> {
  const actor = await getActor();
  const program = await runWithRls(actor.tenantId, async (tx) => {
    const row = await tx.treatmentProgram.findFirst({
      where: { id: input.id, tenantId: actor.tenantId },
      select: { id: true, patientId: true },
    });
    if (!row) return null;
    return { ...row, denied: await hcAccessError(actor, row.patientId, tx) };
  });
  if (!program) return { ok: false, error: "Plan no encontrado." };
  if (program.denied) return { ok: false, error: program.denied };
  const patch: Record<string, string | number | Date> = {};
  if (input.title !== undefined) {
    const t = input.title.trim();
    if (!t) return { ok: false, error: "El título no puede estar vacío." };
    patch.title = t;
  }
  if (input.totalSessions !== undefined) {
    const n = Math.floor(input.totalSessions);
    if (n < 1 || n > 64) return { ok: false, error: "Sesiones entre 1 y 64." };
    patch.totalSessions = n;
  }
  if (input.frequency !== undefined) {
    const f = Math.floor(input.frequency);
    if (f < 1 || f > 7) return { ok: false, error: "Frecuencia entre 1 y 7." };
    patch.frequency = f;
  }
  if (input.startDate !== undefined) {
    // `input.startDate` is a "YYYY-MM-DD" value from an <input type="date">.
    // Parsing it bare makes `new Date` read it as UTC midnight (= 21:00 the
    // previous day in AR), rolling session 1 back a day. Anchor to AR local
    // midnight instead.
    const d = new Date(localToARIso(`${input.startDate}T00:00:00`));
    if (Number.isNaN(d.getTime())) return { ok: false, error: "Fecha inválida." };
    patch.startDate = d;
  }
  if (Object.keys(patch).length === 0) return { ok: true, data: undefined };
  await runWithRls(actor.tenantId, (tx) => tx.treatmentProgram.update({ where: { id: input.id }, data: patch }));
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "program.update",
    entity: "TreatmentProgram",
    entityId: input.id,
  });
  revalidatePath(`/pacientes/${program.patientId}`);
  return { ok: true, data: undefined };
}

export async function setProgramStatus(input: {
  id: string;
  status: "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED";
}): Promise<ActionResult> {
  const actor = await getActor();
  const program = await runWithRls(actor.tenantId, async (tx) => {
    const row = await tx.treatmentProgram.findFirst({
      where: { id: input.id, tenantId: actor.tenantId },
      select: { id: true, patientId: true, status: true },
    });
    if (!row) return null;
    return { ...row, denied: await hcAccessError(actor, row.patientId, tx) };
  });
  if (!program) return { ok: false, error: "Plan no encontrado." };
  if (program.denied) return { ok: false, error: program.denied };
  if (program.status === input.status) return { ok: true, data: undefined };
  await runWithRls(actor.tenantId, (tx) => tx.treatmentProgram.update({
    where: { id: input.id },
    data: { status: input.status },
  }));
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "program.status",
    entity: "TreatmentProgram",
    entityId: input.id,
    payload: { from: program.status, to: input.status },
  });
  revalidatePath(`/pacientes/${program.patientId}`);
  revalidatePath("/seguimiento");
  return { ok: true, data: undefined };
}

/**
 * Hard-delete a TreatmentProgram + all its Sessions + SessionExercises.
 * Bookings that referenced sessions remain in place (no FK to delete
 * cascade). Audit log records the loss.
 */
export async function deleteProgram(id: string): Promise<ActionResult> {
  const actor = await getActor();
  const denied = await requireAdminRole(actor);
  if (denied) return denied;
  // RLS Etapa 2: cascade delete (sessions + sessionExercises) traverses
  // FKs the app-layer extension can't reach. The GUC ensures Postgres
  // policies guard every cascaded row.
  const program = await runWithRls(actor.tenantId, async (tx) => {
    const row = await tx.treatmentProgram.findFirst({
      where: { id, tenantId: actor.tenantId },
      select: { id: true, patientId: true, title: true, totalSessions: true },
    });
    if (!row) return null;
    // A2b-S-vis: OWNER/ADMIN ya implica `full`; el gate queda explícito para
    // que no dependa de que `requireAdminRole` siga siendo el único filtro.
    if (await hcAccessError(actor, row.patientId, tx)) return null;
    await tx.treatmentProgram.delete({ where: { id } });
    return row;
  });
  if (!program) return { ok: false, error: "Plan no encontrado." };
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "program.delete",
    entity: "TreatmentProgram",
    entityId: id,
    payload: { title: program.title, totalSessions: program.totalSessions },
  });
  revalidatePath(`/pacientes/${program.patientId}`);
  return { ok: true, data: undefined };
}

export async function deleteSession(id: string): Promise<ActionResult> {
  const actor = await getActor();
  const denied = await requireAdminRole(actor);
  if (denied) return denied;
  const session = await runWithRls(actor.tenantId, async (tx) => {
    const row = await tx.session.findFirst({
      where: { id, program: { tenantId: actor.tenantId } },
      select: {
        id: true,
        index: true,
        program: { select: { id: true, patientId: true, totalSessions: true } },
      },
    });
    // A2b-S-vis: mismo gate explícito que deleteProgram (OWNER/ADMIN ⇒ full).
    if (!row || (await hcAccessError(actor, row.program.patientId, tx))) return null;
    return row;
  });
  if (!session) return { ok: false, error: "Sesión no encontrada." };

  await runWithRls(actor.tenantId, async (tx) => {
    await tx.session.delete({ where: { id } });
    // Decrement totalSessions so progress bars stay accurate. Atomic
    // decrement (vs. read-modify-write) avoids racing a concurrent edit.
    // The `> 1` guard keeps the counter from ever reaching 0.
    if (session.program.totalSessions > 1) {
      await tx.treatmentProgram.update({
        where: { id: session.program.id },
        data: { totalSessions: { decrement: 1 } },
      });
    }
  });
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "session.delete",
    entity: "Session",
    entityId: id,
    payload: { index: session.index },
  });
  revalidatePath(`/pacientes/${session.program.patientId}`);
  return { ok: true, data: undefined };
}

/**
 * Send a patient portal invitation. Uses Supabase Admin's
 * `inviteUserByEmail` to email the patient a magic link that lands on
 * `/portal` after sign-up. Once they confirm + sign in, the
 * `/auth/callback` route auto-links their Supabase identity to this
 * Patient row (by email match, gated by `email_confirmed_at`).
 *
 * Idempotent — if the Patient already has a `userId` linked, returns
 * { ok: true } without re-sending. Falls back to a manual share-URL
 * when Supabase admin isn't configured (dev/test environments).
 */
export async function sendPatientPortalInvite(input: {
  patientId: string;
}): Promise<ActionResult<{ emailSent: boolean; portalUrl: string }>> {
  const actor = await getActor();
  const patient = await runWithRls(actor.tenantId, (tx) => tx.patient.findFirst({
    where: { id: input.patientId, tenantId: actor.tenantId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      userId: true,
      tenant: { select: { slug: true, name: true } },
    },
  }));
  if (!patient) return { ok: false, error: "Paciente no encontrado." };
  // A2a-S08: invitar al portal expone la historia del paciente → acceso `full`.
  if ((await patientAccessFor(actor, patient.id)) !== "full") {
    return { ok: false, error: "No tenés acceso completo a este paciente: solo podés verlo." };
  }
  if (!patient.email) {
    return { ok: false, error: "El paciente no tiene email cargado." };
  }

  // A3a-S-rl: cada llamada manda un mail de Supabase y no había límite (spam
  // + cuota de envío). 10/h por actor + 1 cada 10 min por destinatario (hash
  // del email, nunca en claro). Va después de los chequeos de acceso para que
  // un rechazo por permisos no consuma cupo.
  const rl = await rateLimitAll([
    { key: `portal-invite:actor:${actor.userId ?? actor.tenantId}`, limit: 10, windowMs: 3_600_000 },
    { key: `portal-invite:to:${hashKeyPart(patient.email)}`, limit: 1, windowMs: 600_000 },
  ]);
  if (!rl.ok) return { ok: false, error: rateLimitedMessage(rl.retryAfterMs) };

  const portalUrl = `${env.NEXT_PUBLIC_APP_URL}/portal/c/${patient.tenant.slug}`;

  if (patient.userId) {
    // Already linked to a Supabase identity. Just send a reminder.
    await audit({
      tenantId: actor.tenantId,
      actorId: actor.userId ?? undefined,
      action: "patient.portal_invite.resend",
      entity: "Patient",
      entityId: patient.id,
    });
    const admin = getSupabaseAdminClient();
    if (admin) {
      try {
        // supabase-js NO tira excepción: devuelve `{ error }`. Antes esta rama
        // lo ignoraba y respondía "Email enviado" aunque Supabase rechazara.
        const { error } = await admin.auth.admin.inviteUserByEmail(patient.email.toLowerCase(), {
          redirectTo: portalUrl,
        });
        if (!error) return { ok: true, data: { emailSent: true, portalUrl } };
        logger.warn("patient.portal_invite.resend_email_failed", { err: error.message });
      } catch (e) {
        logger.warn("patient.portal_invite.resend_email_failed", { err: e instanceof Error ? e.message : String(e) });
        /* fall through to manual URL */
      }
    }
    return { ok: true, data: { emailSent: false, portalUrl } };
  }

  // First-time invite.
  const admin = getSupabaseAdminClient();
  let emailSent = false;
  if (admin) {
    try {
      const { error } = await admin.auth.admin.inviteUserByEmail(
        patient.email.toLowerCase(),
        {
          redirectTo: portalUrl,
          data: {
            full_name: `${patient.firstName} ${patient.lastName}`,
            kinesoft_portal_url: portalUrl,
            kinesoft_tenant: patient.tenant.name,
          },
        }
      );
      if (!error) emailSent = true;
      else logger.warn("patient.portal_invite.email_failed", { err: error.message });
    } catch (e) {
      logger.warn("patient.portal_invite.email_failed", { err: e instanceof Error ? e.message : String(e) });
      /* fall back to manual URL */
    }
  }

  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: "patient.portal_invite",
    entity: "Patient",
    entityId: patient.id,
    payload: { emailSent },
  });
  return { ok: true, data: { emailSent, portalUrl } };
}

/**
 * Bulk archive (or unarchive) patients. Validates tenant ownership on
 * every id, so a client can't sneak ids of patients they don't own.
 * Returns the count of rows that actually changed.
 */
export async function bulkArchivePatients(input: {
  ids: string[];
  archived: boolean;
}): Promise<ActionResult<{ updated: number }>> {
  const actor = await getActor();
  if (input.ids.length === 0) return { ok: true, data: { updated: 0 } };
  if (input.ids.length > 200) {
    return { ok: false, error: "Demasiados pacientes a la vez (máx 200)." };
  }
  // A2b-S-vis: todo-o-nada. Mismo gate `full` que `setPatientArchived`; si
  // algún id es ajeno (otro tenant / inexistente) o de acceso básico, no se
  // archiva NINGUNO y se dice cuántos fallaron. Antes los ids ajenos se
  // descartaban en silencio y los básicos se archivaban.
  const ids = Array.from(new Set(input.ids));
  const outcome = await runWithRls(actor.tenantId, async (tx) => {
    const access = await bulkPatientAccess(actor, ids, tx);
    const missing = ids.filter((id) => !access.has(id)).length;
    const basic = ids.filter((id) => access.get(id) === "basic").length;
    if (missing > 0) return { kind: "missing" as const, n: missing };
    if (basic > 0) return { kind: "basic" as const, n: basic };
    const r = await tx.patient.updateMany({
      where: { id: { in: ids }, tenantId: actor.tenantId },
      data: { archivedAt: input.archived ? new Date() : null },
    });
    return { kind: "ok" as const, count: r.count };
  });
  if (outcome.kind === "missing") {
    return { ok: false, error: "Algunos pacientes no se encontraron. Recargá la lista." };
  }
  if (outcome.kind === "basic") {
    return {
      ok: false,
      error:
        outcome.n === 1
          ? "No tenés acceso completo a 1 de los pacientes elegidos. No se archivó ninguno."
          : `No tenés acceso completo a ${outcome.n} de los pacientes elegidos. No se archivó ninguno.`,
    };
  }
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId ?? undefined,
    action: input.archived ? "patient.bulk_archive" : "patient.bulk_unarchive",
    entity: "Patient",
    payload: { count: outcome.count, ids: ids.slice(0, 50) },
  });
  revalidatePath("/pacientes");
  return { ok: true, data: { updated: outcome.count } };
}

/**
 * Activity feed for a patient — every AuditEvent that touches the
 * patient row OR any of its child entities (PatientFile, Booking,
 * TreatmentProgram, Session, Coverage, EvaScore). Most recent first.
 *
 * A2b-S-vis: exige acceso `full`. Los payloads del audit llevan nombres de
 * archivos, títulos de planes y cambios de diagnóstico: con acceso básico
 * el feed filtraba HC que la ficha misma esconde. Básico/ajeno → `[]`.
 */
export async function getPatientActivity(
  patientId: string,
  opts: { limit?: number } = {}
): Promise<ActivityEvent[]> {
  const actor = await getActor();
  const owned = await runWithRls(actor.tenantId, async (tx) => {
    if (await hcAccessError(actor, patientId, tx)) return null;
    return tx.patient.findFirst({
      where: { id: patientId, tenantId: actor.tenantId },
      select: {
        id: true,
        bookings: { select: { id: true } },
        programs: {
          select: { id: true, sessions: { select: { id: true } } },
        },
        files: { select: { id: true } },
      },
    });
  });
  if (!owned) return [];

  const childEntities: Record<string, string[]> = {
    Patient: [owned.id],
    Booking: owned.bookings.map((b) => b.id),
    TreatmentProgram: owned.programs.map((p) => p.id),
    Session: owned.programs.flatMap((p) => p.sessions.map((s) => s.id)),
    PatientFile: owned.files.map((f) => f.id),
  };

  const orFragments = Object.entries(childEntities)
    .filter(([, ids]) => ids.length > 0)
    .map(([entity, ids]) => ({ entity, entityId: { in: ids } }));

  if (orFragments.length === 0) return [];

  const events = await runWithRls(actor.tenantId, (tx) => tx.auditEvent.findMany({
    where: { tenantId: actor.tenantId, OR: orFragments },
    orderBy: { createdAt: "desc" },
    take: opts.limit ?? 60,
  }));

  // Resolve actor names in a single round-trip.
  const userIds = Array.from(
    new Set(events.map((e) => e.actorId).filter(Boolean) as string[])
  );
  const users = userIds.length
    ? await prisma.userProfile.findMany({
        where: { id: { in: userIds } },
        select: { id: true, fullName: true, email: true },
      })
    : [];
  const userMap = new Map(users.map((u) => [u.id, u.fullName ?? u.email]));

  return events.map((e) => ({
    id: e.id,
    action: e.action,
    entity: e.entity,
    entityId: e.entityId,
    createdAt: e.createdAt,
    actorName: e.actorId ? userMap.get(e.actorId) ?? "Sistema" : "Sistema",
    ip: e.ip,
    payload: (e.payload as Record<string, unknown> | null) ?? null,
  }));
}

// ══════════════════════════════════════════════════════════════════════
// Patient sharing — Sprint 16
// ══════════════════════════════════════════════════════════════════════

/**
 * Authorise a share mutation. Only the patient's OWNER (assigned
 * practitioner) and tenant OWNER/ADMIN can change shares. Returns the
 * patient row or an error.
 */
async function requireShareAuthority(patientId: string) {
  const actor = await getActor();
  const patient = await runWithRls(actor.tenantId, (tx) => tx.patient.findFirst({
    where: { id: patientId, tenantId: actor.tenantId },
    select: { id: true, assignedPractitionerId: true },
  }));
  if (!patient) return { ok: false as const, error: "Paciente no encontrado." };
  const isAdmin = isTenantAdminRole(await getMembershipRole(actor));
  const isOwner = patient.assignedPractitionerId === actor.practitionerId;
  if (!isAdmin && !isOwner) {
    return {
      ok: false as const,
      error: "Solo el kinesiólogo asignado o un administrador puede compartir este paciente.",
    };
  }
  return { ok: true as const, actor, patient };
}

/**
 * Replace the share set for a patient atomically. Receives the full list
 * of practitioner ids that should have access (excluding the owner —
 * they always have it). Anything in the list that isn't already shared
 * gets a new PatientShare; existing shares not in the list are removed.
 *
 * Idempotent — running with the same list twice is a no-op after the
 * first call.
 */
export async function setPatientShares(input: {
  patientId: string;
  practitionerIds: string[];
}): Promise<ActionResult> {
  const auth = await requireShareAuthority(input.patientId);
  if (!auth.ok) return auth;
  const { actor, patient } = auth;

  // Reject shares to the owner themselves (no-op anyway) and de-dupe.
  const wantedRaw = Array.from(new Set(input.practitionerIds))
    .filter((id) => id !== patient.assignedPractitionerId);

  // Validate every requested practitioner belongs to this tenant — no
  // cross-tenant grants — and is still an active member (invitación aceptada):
  // un profesional removido no recibe shares nuevos y los que tenía se quitan
  // al guardar (no está en `wanted`). Mismo filtro que `listPractitioners`.
  const tenantPractitioners = await runWithRls(actor.tenantId, (tx) => tx.practitioner.findMany({
    where: {
      tenantId: actor.tenantId,
      id: { in: wantedRaw },
      user: { memberships: { some: { tenantId: actor.tenantId, acceptedAt: { not: null } } } },
    },
    select: { id: true },
  }));
  const wanted = new Set(tenantPractitioners.map((p) => p.id));

  const existing = await runWithRls(actor.tenantId, (tx) => tx.patientShare.findMany({
    where: { patientId: input.patientId },
    select: { practitionerId: true },
  }));
  const existingSet = new Set(existing.map((r) => r.practitionerId));

  const toAdd = [...wanted].filter((id) => !existingSet.has(id));
  const toRemove = [...existingSet].filter((id) => !wanted.has(id));

  await runWithRls(actor.tenantId, async (tx) => {
    if (toRemove.length > 0) {
      await tx.patientShare.deleteMany({
        where: {
          patientId: input.patientId,
          practitionerId: { in: toRemove },
        },
      });
    }
    if (toAdd.length > 0) {
      await tx.patientShare.createMany({
        data: toAdd.map((practitionerId) => ({
          tenantId: actor.tenantId,
          patientId: input.patientId,
          practitionerId,
          sharedById: actor.userId,
        })),
      });
    }
  });

  if (toAdd.length > 0 || toRemove.length > 0) {
    await audit({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      action: "patient.share.update",
      entity: "Patient",
      entityId: input.patientId,
      payload: { added: toAdd, removed: toRemove },
    });
  }

  // Notify each NEWLY-added practitioner (not the ones already shared, and
  // never the actor doing the sharing) that a patient was shared with them.
  // Fire-and-forget — `notify` never throws and must not block the mutation.
  if (toAdd.length > 0) {
    const [addedPractitioners, patientRow] = await Promise.all([
      runWithRls(actor.tenantId, (tx) => tx.practitioner.findMany({
        where: { id: { in: toAdd }, tenantId: actor.tenantId },
        select: { id: true, userId: true },
      })),
      // `patient` from requireShareAuthority only carries id +
      // assignedPractitionerId, so pull the name with a minimal select.
      runWithRls(actor.tenantId, (tx) => tx.patient.findFirst({
        where: { id: input.patientId, tenantId: actor.tenantId },
        select: { firstName: true, lastName: true },
      })),
    ]);
    const patientName = patientRow
      ? `${patientRow.firstName} ${patientRow.lastName}`.trim()
      : undefined;
    for (const prac of addedPractitioners) {
      // Skip practitioners with no linked user account and never notify the
      // actor who performed the share.
      if (!prac.userId || prac.userId === actor.userId) continue;
      await notify({
        tenantId: actor.tenantId,
        userId: prac.userId,
        // String cast: the regenerated Prisma client isn't in place yet, so
        // NotificationKind.PATIENT_SHARED would be undefined at runtime.
        kind: "PATIENT_SHARED" as NotificationKind,
        title: "Te compartieron un paciente",
        body: patientName,
        link: `/pacientes/${input.patientId}`,
      });
    }
  }

  revalidatePath(`/pacientes/${input.patientId}`);
  revalidatePath(`/pacientes`);
  return { ok: true, data: undefined };
}

/**
 * Convenience: list the practitionerIds currently granted access.
 * Used by the SharePatientButton popover to pre-check boxes.
 */
export async function getPatientShareList(patientId: string): Promise<string[]> {
  const actor = await getActor();
  const access = await patientAccessFor(actor, patientId);
  // Only people with full access can SEE who else is shared into the HC.
  if (access !== "full") return [];
  const rows = await runWithRls(actor.tenantId, (tx) => tx.patientShare.findMany({
    where: { patientId },
    select: { practitionerId: true },
  }));
  return rows.map((r) => r.practitionerId);
}


