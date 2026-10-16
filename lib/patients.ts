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
import { displayMemberName, displayUserName } from "@/lib/display-name";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { runWithRls } from "@/lib/rls";
import { bookablePractitionerWhere, clinicalMembershipWhere, isActorPractitioner } from "@/lib/practitioner-scope";
import { getActor, writableError, type Actor } from "@/lib/session";
import { memberCapabilitiesForActor, requireModule } from "@/lib/authz";
import { modulesFor } from "@/lib/tenant-modules";
import { canWriteClinical } from "@/lib/capabilities";
import { bookingFieldAccess } from "@/lib/booking-field-access";
import { findUsablePayerPlan } from "@/lib/catalog-validate";
import { auditInTx } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { notify } from "@/lib/notifications-internal";
import { getParticularCopagoCents, resolveBookingCopagoCents } from "@/lib/billing-internal";
import { resolveInsurerName } from "@/lib/insurers-internal";
// P0-S02a (E0): `visibilityForActor` salió con `getPatient`, su único uso acá.
import { patientAccessFor, bulkPatientAccess, type AccessLevel } from "@/lib/visibility";
import { hcAccessError } from "@/lib/patient-access-internal";
import { env } from "@/lib/env";
import { issueAccessLink } from "@/lib/identity/access-link";
import { sendEmail } from "@/lib/email";
// Registra el sink de EmailLog (cada emisor de mails lo importa: ver lib/email/log.ts).
import "@/lib/email/log";
import { portalInviteEmail } from "@/lib/email/templates";
import { makePortalInviteToken } from "@/lib/portal-invite-token";
import { portalVincularPath } from "@/lib/portal-vincular-copy";
import type { EmailTransportName } from "@/lib/email/types";
import { emailEqualsFilter, escapeLike, sameEmail } from "@/lib/email-match";
import { hashKeyPart, rateLimitAll, rateLimitedMessage } from "@/lib/rate-limit";
import { NotificationKind } from "@prisma/client";
import { applyPatientArchivePlansInTx, PlanLifecycleStale } from "@/lib/plans-lifecycle-internal";
import { liveProgramWhere, liveSessionWhere } from "@/lib/plan-predicates";
import { ProgramInvariantViolation } from "@/lib/plan-invariants-internal";
import { afterBookingsCommitted, type BookingChangeRef } from "@/lib/booking-events-internal";
import { readOnlyFailure, withReadOnlyResult } from "@/lib/read-only-result";
import {
  DEFAULT_PATIENT_ARCHIVE_PLANS_ACTION,
  PATIENT_ARCHIVE_PLANS_ACTIONS,
  type PatientArchivePlansAction,
} from "@/lib/plans-lifecycle-state";
import {
  PatientCreate,
  PatientCreateOptions,
  PatientUpdate,
  CoverageSet,
  type ActionResult,
  type PatientCreateInput,
  type PatientCreateOptionsInput,
  type PatientUpdateInput,
} from "@/lib/validation";

import type {
  ActivityEvent,
  PatientAdminCore,
  PatientBookingFull,
  PatientCoreWithAccess,
  PatientListPlanChip,
  PatientRow,
  PatientSort,
} from "@/lib/patients-types";

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
  // EV1-B: el directorio se arma por módulos. Sin `planes` (consultorio
  // General) no hay plan que mostrar ni por el cual filtrar: "con plan / sin
  // plan" se ignora (cae a "todos") y no se hace el include de programs, que
  // era un join + subquery por fila para una columna que la UI ya no muestra.
  // Sin `diagnostico`, `diagnosisSlug` se ignora igual. Se ignoran en vez de
  // tirar porque llegan por URL (un link viejo o compartido desde un Kine no
  // tiene que romper la página). Kine: sin cambios.
  const modules = modulesFor(actor.entitlements);
  const plansOn = modules.has("planes");
  const filter =
    !plansOn && (opts.filter === "active" || opts.filter === "no-program") ? "all" : opts.filter;
  const diagnosisSlug = modules.has("diagnostico") ? opts.diagnosisSlug : undefined;
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
  const diagnosisWhere: Prisma.PatientWhereInput = diagnosisSlug
    ? {
        programs: {
          some: {
            case: {
              diagnoses: {
                some: { condition: { slug: diagnosisSlug } },
              },
            },
          },
        },
      }
    : {};

  // EV1-B: Prisma 5 NO escapa `contains`: arma `ILIKE '%' || $1 || '%'` con el
  // valor crudo (medido contra el Docker: `contains: "%"` → param `"%%%"`), así
  // que buscar «%» traía todo el directorio y «_» matcheaba cualquier carácter.
  // Se escapa con `escapeLike` (backslash es el escape default de ILIKE en PG).
  // El post-filtro de filas basic de abajo usa `includes` sobre `q` crudo:
  // ahí no hay comodines.
  const qLike = q ? escapeLike(q) : undefined;
  const insurerLike = opts.insurer ? escapeLike(opts.insurer) : undefined;

  const activeLiveProgramWhere = { ...liveProgramWhere, status: "ACTIVE" } satisfies Prisma.TreatmentProgramWhereInput;

  const where: Prisma.PatientWhereInput = {
    tenantId: actor.tenantId,
    ...(filter === "archived"
      ? { archivedAt: { not: null } }
      : { archivedAt: null }),
    ...(qLike
      ? {
          OR: [
            { firstName: { contains: qLike, mode: "insensitive" } },
            { lastName: { contains: qLike, mode: "insensitive" } },
            { email: { contains: qLike, mode: "insensitive" } },
            { documentId: { contains: qLike, mode: "insensitive" } },
          ],
        }
      : {}),
    // S32: «Con plan» / «Sin plan» con el MISMO predicado que la columna y el
    // contador del pill (plan ACTIVE y vivo, `liveProgramWhere`). Antes «Con
    // plan» contaba un ACTIVE archivado y «Sin plan» era "nunca tuvo plan"
    // (`none: {}`), mientras el pill contaba "sin plan activo": un paciente
    // con el plan COMPLETED sumaba en «Sin plan · N» y no aparecía al clickearlo.
    ...(filter === "active"
      ? { programs: { some: activeLiveProgramWhere } }
      : filter === "no-program"
        ? { programs: { none: activeLiveProgramWhere } }
        : {}),
    ...(insurerLike
      ? { coverages: { some: { insurer: { contains: insurerLike, mode: "insensitive" } } } }
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

  // P0-S02a: con 2 planes ACTIVE (legacy o carrera) el orden físico de la
  // tabla cambiaba el "plan activo" entre requests. Gana el más reciente, como
  // el resto de los lectores de "plan activo" de ES1 (`listBookingsInRange`,
  // Seguimiento); `id` desempata dos altas en el mismo milisegundo.
  // S32: ya no `take: 1`: un paciente puede tener un plan de Kine y otro de
  // Osteo a la vez, y la columna muestra un chip por cada uno. Solo planes
  // ACTIVE y vivos (`liveProgramWhere`) y solo las columnas del chip: las
  // sesiones NO se incluyen (antes venían todas, fila por fila, para contar
  // en memoria); se cuentan abajo con un único `groupBy` agregado.
  const programsInclude = {
    where: activeLiveProgramWhere,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, title: true, discipline: true },
  } satisfies Prisma.Patient$programsArgs;
  const baseInclude = {
    bookings: {
      where: { scheduledFor: { gte: new Date() }, status: { not: "CANCELLED" } },
      orderBy: { scheduledFor: "asc" },
      take: 1,
    },
    coverages: { include: { insurerRef: true }, orderBy: { id: "desc" }, take: 1 },
  } satisfies Prisma.PatientInclude;
  type ProgramsPayload = Prisma.PatientGetPayload<{ include: { programs: typeof programsInclude } }>["programs"];

  const { rows, lastCompletedByPatient, sessionAggByProgram } = await runWithRls(actor.tenantId, async (tx) => {
   // EV1-B: sin `planes` la consulta no lleva el include de programs (Prisma
   // no toca Program ni ProgramSession); la fila sale con `programs: []` para
   // que el mapeo de abajo sea uno solo.
   const rows = plansOn
     ? await tx.patient.findMany({ where, orderBy, include: { ...baseInclude, programs: programsInclude } })
     : (await tx.patient.findMany({ where, orderBy, include: baseInclude })).map((r) => ({
         ...r,
         programs: [] as ProgramsPayload,
       }));
   // EV1-B: en Kine "última visita" sale de la última sesión completada del
   // plan activo. Sin `planes` no hay sesiones y la columna quedaba siempre en
   // "—" (y el orden "Última visita" no ordenaba nada): se usa el último turno
   // COMPLETED, la misma definición que el filtro `lastVisitFrom/To` de arriba.
   // Una sola agregación por página, no una por fila.
   const lastCompletedByPatient = new Map<string, Date>();
   // S32: sesiones vivas / realizadas / última realizada por plan activo, en
   // UNA consulta agregada para toda la página (`GROUP BY programId`): sin
   // N+1 y sin traer filas de Session. `_count.completedAt` = COUNT(columna),
   // que no cuenta NULL → realizadas. El tenant va por `program` (Session no
   // tiene `tenantId`; en prod la conexión es BYPASSRLS).
   const sessionAggByProgram = new Map<string, { totalLive: number; done: number; lastDoneAt: Date | null }>();
   const programIds = plansOn ? rows.flatMap((r) => r.programs.map((p) => p.id)) : [];
   if (programIds.length > 0) {
     const agg = await tx.session.groupBy({
       by: ["programId"],
       where: {
         ...liveSessionWhere,
         programId: { in: programIds },
         program: { tenantId: actor.tenantId, ...activeLiveProgramWhere },
       },
       _count: { _all: true, completedAt: true },
       _max: { completedAt: true },
     });
     for (const a of agg) {
       sessionAggByProgram.set(a.programId, {
         totalLive: a._count._all,
         done: a._count.completedAt,
         lastDoneAt: a._max.completedAt,
       });
     }
   }
   if (!plansOn && rows.length > 0) {
     const agg = await tx.booking.groupBy({
       by: ["patientId"],
       where: { tenantId: actor.tenantId, patientId: { in: rows.map((r) => r.id) }, status: "COMPLETED" },
       _max: { scheduledFor: true },
     });
     for (const a of agg) {
       if (a.patientId && a._max.scheduledFor) lastCompletedByPatient.set(a.patientId, a._max.scheduledFor);
     }
   }
   return { rows, lastCompletedByPatient, sessionAggByProgram };
  });

  // Resolve access per row in one batch — much cheaper than N share
  // lookups when the directory has hundreds of patients.
  const accessMap = await bulkPatientAccess(actor, rows.map((r) => r.id));

  // P0.Z (H-b1, revisor (b) de ES1): los filtros corren en SQL para cualquier
  // actor, así que una fila que NO es full no puede aparecer *por* matchear un
  // filtro sobre datos que el actor no ve: era un oráculo (la Secretaria,
  // BILLING o un kine en básico pedía `diagnosisSlug: "lumbalgia"` y recibía
  // nombre + DNI de quienes la tienen; con "con/sin plan" sabía quién tenía
  // plan). Se descarta la fila en vez de sacar el filtro del SQL: el filtro
  // sigue sirviendo para las filas full y `totals` (que la página calcula
  // sobre este resultado) no cuenta lo descartado.
  //  - Filtros clínicos (diagnóstico, con/sin plan): solo filas `full`. Un rol
  //    sin `clinical.read` (PD-13: siempre `admin`) recibe [] con ellos.
  //  - Obra social, edad, última visita y email (en `q`): son PHI recortada en
  //    `basic`, así que no filtran filas basic. `admin` sí los ve en el perfil
  //    (`PatientAdminCore`: contacto, cobertura, nacimiento, turnos) → se
  //    conservan sus filas. En `q`, una fila basic queda solo si matchea por
  //    nombre o DNI (lo que su proyección muestra), no por email.
  const clinicalFilter =
    Boolean(diagnosisSlug) || filter === "active" || filter === "no-program";
  const maskedFilter =
    Boolean(opts.insurer) || opts.ageMin != null || opts.ageMax != null || Boolean(lvFrom || lvTo);
  const qLower = q?.toLowerCase();
  const visibleRows = rows.filter((p) => {
    const access = accessMap.get(p.id) ?? "basic";
    if (access === "full") return true;
    if (clinicalFilter) return false;
    if (access === "admin") return true;
    if (maskedFilter) return false;
    if (qLower) {
      return [p.firstName, p.lastName, p.documentId].some((f) => f?.toLowerCase().includes(qLower));
    }
    return true;
  });

  return visibleRows
    .map((p): PatientRow => {
      const access = accessMap.get(p.id) ?? "basic";
      const upcomingAt = p.bookings[0]?.scheduledFor ?? null;
      // Basic rows expose ONLY name + DNI + next booking. Every other
      // field is nulled out so a basic-access kine can't even infer
      // medical history by glancing at the directory.
      // PD-13: `admin` (rol sin clinical.read) tampoco ve HC → en el
      // directorio usa la misma proyección que basic (S07sp, P0.2, no sumó
      // `admin` a PatientRow: haría falta pasar `patients-list.tsx` y
      // `recent-patients.tsx` a `=== "full"`). Contacto y cobertura los ve en
      // el perfil (`getPatientCore` admin). HC solo con `=== "full"`.
      if (access !== "full") {
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
          activePlans: [],
          lastVisit: null,
          upcomingAt,
          obraSocial: null,
          access: "basic",
        };
      }
      // S32: un chip por plan activo y vivo (más reciente primero). Un plan
      // sin sesiones vivas no tiene fila en el `groupBy` → 0/0.
      const NO_SESSIONS = { totalLive: 0, done: 0, lastDoneAt: null };
      const activePlans: PatientListPlanChip[] = p.programs.map((pr) => {
        const a = sessionAggByProgram.get(pr.id) ?? NO_SESSIONS;
        return { discipline: pr.discipline, done: a.done, totalLive: a.totalLive };
      });
      const prog = p.programs[0];
      const progAgg = prog ? (sessionAggByProgram.get(prog.id) ?? NO_SESSIONS) : NO_SESSIONS;
      // «Última visita» (Kine) = la última sesión viva realizada de CUALQUIER
      // plan activo (antes: solo del más reciente, contando archivadas).
      let lastDone: Date | null = null;
      for (const pr of p.programs) {
        const at = sessionAggByProgram.get(pr.id)?.lastDoneAt ?? null;
        if (at && (!lastDone || at > lastDone)) lastDone = at;
      }
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
        sessionsTotal: progAgg.totalLive,
        sessionsDone: progAgg.done,
        activePlans,
        lastVisit: plansOn ? lastDone : (lastCompletedByPatient.get(p.id) ?? null),
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
 * L9: `plansAction` llega por RPC sin tipo: lo que no sea `pause`/`cancel` se
 * rechaza (null) antes de abrir la tx. Ausente = default `pause`.
 */
function parsePlansAction(v: unknown): PatientArchivePlansAction | null {
  if (v === undefined || v === null) return DEFAULT_PATIENT_ARCHIVE_PLANS_ACTION;
  return (PATIENT_ARCHIVE_PLANS_ACTIONS as readonly unknown[]).includes(v) ? (v as PatientArchivePlansAction) : null;
}

/** Rechazos de L9 que hicieron rollback del archivado entero → resultado, no 500. */
function patientArchivePlansRejection(e: unknown): { ok: false; error: string } | null {
  if (e instanceof PlanLifecycleStale) {
    return { ok: false, error: "Un plan del paciente cambió mientras lo archivabas. Probá de nuevo." };
  }
  if (e instanceof ProgramInvariantViolation) {
    return { ok: false, error: "Un plan del paciente tiene datos inconsistentes y no se pudo archivar. Ya avisamos al equipo técnico." };
  }
  return null;
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
// BO3-F: el cuerpo va en `setPatientArchivedImpl`; el wrapper convierte el ReadOnlyModeError (modo lectura / soporte)
// en `{ ok:false, error }` para que en prod Next no redacte el mensaje (lib/read-only-result.ts).
export async function setPatientArchived(...args: Parameters<typeof setPatientArchivedImpl>): Promise<ActionResult> {
  return withReadOnlyResult(() => setPatientArchivedImpl(...args));
}

async function setPatientArchivedImpl(input: {
  id: string;
  archived: boolean;
  /**
   * L9 (P2-S15): qué pasa con sus planes vivos al ARCHIVAR. Opcional, default
   * `pause` (ACTIVE → PAUSED sin tocar turnos): los callers de antes no
   * cambian. `cancel` = CANCELLED con los futuros impagos cancelados.
   */
  plansAction?: PatientArchivePlansAction;
}): Promise<ActionResult> {
  const actor = await getActor();
  const plansAction = parsePlansAction(input.plansAction);
  if (!plansAction) return { ok: false, error: "Acción sobre los planes inválida." };
  let outcome: { denied: string | null; refs: BookingChangeRef[] };
  try {
    outcome = await runWithRls(actor.tenantId, async (tx) => {
      const err = await hcAccessError(actor, input.id, tx);
      if (err) return { denied: err, refs: [] };
      // L9 antes del UPDATE del paciente: `lockPlanPatient` va primero (C2 (0)).
      const plans = input.archived
        ? await applyPatientArchivePlansInTx(tx, actor, { patientIds: [input.id], action: plansAction, now: new Date() })
        : null;
      await tx.patient.update({
        where: { id: input.id, tenantId: actor.tenantId },
        data: { archivedAt: input.archived ? new Date() : null },
      });
      return { denied: null, refs: plans?.refs ?? [] };
    });
  } catch (e) {
    const r = patientArchivePlansRejection(e);
    if (r) return r;
    throw e;
  }
  if (outcome.denied) return { ok: false, error: outcome.denied };
  // Post-commit, una vez (enmienda Realtime): solo si L9 canceló turnos.
  if (outcome.refs.length) await afterBookingsCommitted(actor.tenantId, outcome.refs);
  revalidatePath("/pacientes");
  revalidatePath(`/pacientes/${input.id}`);
  return { ok: true, data: undefined };
}

/**
 * Patient core — base patient + coverages + emergency contacts.
 *
 * **Hot path + access-gated.** Three projections, by `result.access`:
 *  - `full` (owner / shared / OWNER+ADMIN / sharedView): the whole row;
 *  - `admin` (rol sin `clinical.read`: Secretaria, Facturación — PD-13):
 *    `PatientAdminCore`, datos para operar la agenda y cobrar, sin HC;
 *  - `basic` (kine sin acceso): name + DNI + next booking.
 * Pages branch on `result.access`; HC solo con `=== "full"`.
 *
 * Audit log is written here — `patient.read` fires once per page load
 * regardless of which tabs the user navigates into afterwards. Basic and
 * admin access still write the audit row (`patient.read.basic` /
 * `patient.read.admin`) so OWNER/ADMIN can see who looked at whose data.
 */
export async function getPatientCore(id: string): Promise<PatientCoreWithAccess | null> {
  const actor = await getActor();
  const access = await patientAccessFor(actor, id);
  if (access === "none") return null;

  if (access === "admin") {
    // P0-S07sp (E1, PD-13): proyección `admin` con `select` explícito, así la
    // HC (notes, diagnosisTitle/Note, userId del portal, montos de cobertura)
    // ni siquiera sale de la DB. Antes `admin` caía en la rama básica (falla
    // cerrado) y la Secretaria no veía contacto ni cobertura para operar.
    const [patient, nextBooking] = await Promise.all([
      runWithRls(actor.tenantId, (tx) => tx.patient.findFirst({
        where: { id, tenantId: actor.tenantId },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          documentId: true,
          email: true,
          phone: true,
          dateOfBirth: true,
          // Misma regla que la rama full: la cobertura vigente es la más
          // reciente (cuid ordenable por tiempo). Sin copago ni vigencia.
          coverages: {
            orderBy: { id: "desc" },
            take: 1,
            select: { insurer: true, planName: true, memberId: true, insurerRef: { select: { name: true } } },
          },
          emergency: { orderBy: { id: "asc" }, select: { name: true, relation: true, phone: true } },
          assignedPractitioner: { select: { user: { select: { fullName: true, email: true } } } },
        },
      })),
      runWithRls(actor.tenantId, (tx) => tx.booking.findFirst({
        where: {
          tenantId: actor.tenantId,
          patientId: id,
          scheduledFor: { gte: new Date() },
          status: { notIn: ["CANCELLED"] },
        },
        orderBy: { scheduledFor: "asc" },
        select: { scheduledFor: true },
      })),
    ]);
    if (!patient) return null;
    const cov = patient.coverages[0];
    const assignedUser = patient.assignedPractitioner?.user;
    // Literal campo por campo (no spread): el tipo congelado es el contrato
    // con el perfil (S07v) y un campo nuevo en el `select` no tiene que
    // filtrarse solo.
    const core: PatientAdminCore = {
      id: patient.id,
      firstName: patient.firstName,
      lastName: patient.lastName,
      documentId: patient.documentId,
      email: patient.email,
      phone: patient.phone,
      dateOfBirth: patient.dateOfBirth,
      coverage: cov
        ? { insurer: cov.insurerRef?.name ?? cov.insurer, planName: cov.planName, memberId: cov.memberId }
        : null,
      emergency: patient.emergency.map((e) => ({ name: e.name, relation: e.relation, phone: e.phone })),
      assignedPractitionerName: assignedUser ? displayMemberName(assignedUser.fullName) : null,
      nextBookingAt: nextBooking?.scheduledFor ?? null,
      access: "admin",
    };
    return core;
  }

  // `basic` (y cualquier nivel futuro no contemplado: falla cerrado).
  if (access !== "full") {
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
        // `insurerRef.isParticular` (ES3, P3.Z): la PlanCard muestra "Obra
        // social: Sin autorización vigente" solo a quien tiene OS de verdad;
        // un Particular (o un nombre libre sin catálogo) no tiene orden.
        coverages: { orderBy: { id: "desc" }, include: { insurerRef: { select: { isParticular: true } } } },
        emergency: true,
      },
    })
  );
  if (patient) {
    return { ...patient, access: "full" as const };
  }
  return null;
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
  // P0-S07sp: el estado de cobro es administrativo (PD-13) → `admin` también.
  if (!seesBookings(access)) return 0;
  return runWithRls(actor.tenantId, (tx) => tx.booking.count({
    where: {
      tenantId: actor.tenantId,
      patientId,
      paymentStatus: { not: "UNPAID" },
    },
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
 * P0-S07sp (E1, PD-13): ¿el actor ve la lista de turnos y el estado de cobro
 * del paciente? `full` y `admin` (Secretaria/Facturación: turnos y cobro son
 * datos administrativos). `basic` sigue sin verlos. Forma positiva: un nivel
 * nuevo no habilita nada por omisión.
 */
function seesBookings(access: AccessLevel): boolean {
  return access === "full" || access === "admin";
}

/**
 * Redacta title/description/notes de un turno del paciente según
 * `bookingFieldAccess` (la misma regla que la agenda y el ICS: con paciente,
 * los tres campos solo con `clinical.read` + full). Para `admin` quedan en
 * null: el campo viaja (forma estable para la UI) pero sin contenido.
 */
async function bookingTextRedactor(actor: Actor, access: AccessLevel) {
  const caps = await memberCapabilitiesForActor(actor);
  const fa = bookingFieldAccess({ clinical: caps.has("clinical.read"), access, hasPatient: true });
  return <T extends { title: string | null; description: string | null; notes: string | null }>(b: T): T => ({
    ...b,
    title: fa.title === "rw" ? b.title : null,
    description: fa.description === "rw" ? b.description : null,
    notes: fa.notes === "rw" ? b.notes : null,
  });
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
  if (!seesBookings(access)) return [];
  const [rows, billing, redact] = await Promise.all([
    runWithRls(actor.tenantId, (tx) => tx.booking.findMany({
      where: { patientId, tenantId: actor.tenantId },
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
    bookingTextRedactor(actor, access),
  ]);
  return rows.map(({ service, copagoCents: bookingCopago, ...b }) => ({
    ...redact(b),
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
  if (!seesBookings(access)) {
    return { rows: [] as PatientBookingFull[], hasMore: false, nextCursor: null as string | null };
  }
  const [found, billing, redact] = await Promise.all([
    runWithRls(actor.tenantId, (tx) => tx.booking.findMany({
      where: { patientId, tenantId: actor.tenantId },
      orderBy: [{ scheduledFor: "desc" }, { id: "desc" }],
      take: size + 1, // +1 = sonda de "hay más"
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { service: { select: { name: true, priceCents: true } } },
    })),
    resolvePatientBilling(patientId, actor.tenantId),
    bookingTextRedactor(actor, access),
  ]);
  const hasMore = found.length > size;
  const page = hasMore ? found.slice(0, size) : found;
  const rows: PatientBookingFull[] = page.map(({ service, copagoCents: bookingCopago, ...b }) => ({
    ...redact(b),
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
  // Enmienda EV0 (S22b): EVA es del módulo `evaluaciones`; un consultorio
  // General no la tiene. Lectura compartida → vacío, no error (C-EV4).
  if (!modulesFor(actor.entitlements).has("evaluaciones")) return [];
  const access = await patientAccessFor(actor, patientId);
  if (access !== "full") return [];
  return runWithRls(actor.tenantId, (tx) => tx.evaScore.findMany({
    where: { patientId },
    orderBy: { takenAt: "asc" },
  }));
}

// P0-S02a (E0, 04-oct): acá vivía `getPatient`, el wrapper pre-Sprint-16
// que cargaba toda la HC (planes, sesiones, ejercicios, diagnósticos, EVA,
// turnos). Tenía 0 callers pero, por estar en un archivo "use server", seguía
// siendo un endpoint con action-id en un chunk público, y sin gate de acceso
// (`patientWhere = {}`): un profesional básico o la Secretaria leían la HC
// completa por RPC. No se reemplaza: cada pantalla usa su lector con gate
// (`getPatientCore`, `getPatientPlans`, `getPatientEvaScores`…).
// `tests/integration/patients-rpc-surface.test.ts` impide que vuelva.

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

/*
 * Un paciente solo puede quedar "a cargo de" (assignedPractitionerId) un miembro que ATIENDE
 * (`clinicalMembershipWhere`, espejo SQL de `isClinicalMember`): asignar a la Secretaria, a Facturación o
 * (PL-1b) a un Titular/Admin sin agenda no le daría HC (PD-13, decisión 8) y dejaría al paciente sin nadie con
 * full. Hasta PL-1b era `CLINICAL_ROLES` derivado de `capabilitiesFor(role)` (AUDIT §5.35), que por rol incluía
 * a todo OWNER/ADMIN.
 */

/**
 * Alta de paciente.
 *
 * P0-S07sp (Planes E1, PD-09/PD-13) — `opts.assignTo` = el profesional del
 * turno que se agenda desde el modal:
 *  - **Sin `clinical.read`** (Secretaria/ASSISTANT): exige `agenda.operateAll`
 *    (BILLING no crea fichas) y `assignTo` obligatorio. Antes el paciente
 *    quedaba asignado a quien lo creaba (`actor.practitionerId`): la
 *    Secretaria se quedaba con acceso full a la ficha y el kine del turno la
 *    veía en básico. Las notas y el diagnóstico se **ignoran**: un campo se
 *    escribe solo si se puede leer, y la Secretaria no lee HC.
 *  - **OWNER/ADMIN**: `assignTo` opcional (sin él, como hoy: a su cargo).
 *  - **PRACTITIONER**: `assignTo` se ignora y la ficha queda a su cargo, como
 *    hasta hoy. Re-asignar es de OWNER/ADMIN (`assignPatientToPractitioner`):
 *    si no, un kine podría "regalar" la ficha que acaba de cargar.
 *
 * `assignTo` se valida dentro de la tx del alta: del tenant (las FK saltean
 * RLS y en prod la conexión tiene BYPASSRLS), membresía aceptada en un rol
 * clínico y, para la Secretaria, distinto del actor. Si no pasa, no se crea
 * nada.
 */
export async function createPatient(
  raw: PatientCreateInput,
  opts?: PatientCreateOptionsInput
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
  const parsedOpts = PatientCreateOptions.safeParse(opts ?? {});
  if (!parsedOpts.success) return { ok: false, error: "Datos inválidos" };

  const caps = await memberCapabilitiesForActor(actor);
  const clinical = caps.has("clinical.read");
  if (!clinical && !caps.has("agenda.operateAll")) {
    return { ok: false, error: "Tu rol no puede dar de alta pacientes." };
  }
  const assignTo = !clinical || caps.has("tenant.admin") ? parsedOpts.data.assignTo : undefined;
  if (!clinical && !assignTo) {
    return { ok: false, error: "Elegí el profesional del turno: el paciente queda a su cargo." };
  }

  // Coverage fields aren't `Patient` columns — split them out before the
  // create so Prisma doesn't choke, and use them to seed the primary
  // Coverage inside the same transaction. Notas y diagnóstico se separan
  // también: sin `clinical.read` no se escriben (ver arriba).
  const { insurerId, insurerName, notes, diagnosisTitle, diagnosisNote, ...patientData } = parsed.data;
  const clinicalIgnored = !clinical && Boolean(notes || diagnosisTitle || diagnosisNote);
  try {
    // RLS Etapa 2: create runs under the tenant GUC. The notify+audit
    // calls land outside the transaction since they're fire-and-forget.
    const p = await runWithRls(actor.tenantId, async (tx) => {
      let assignee = actor.practitionerId;
      if (assignTo) {
        const target = await tx.practitioner.findFirst({
          where: {
            id: assignTo,
            tenantId: actor.tenantId,
            user: { memberships: { some: clinicalMembershipWhere(actor.tenantId) } },
          },
          select: { id: true },
        });
        if (!target || (!clinical && isActorPractitioner(actor, target.id))) return null;
        assignee = target.id;
      }
      // IAM-4a: sin `assignTo` la ficha queda a cargo del actor; un actor sin profesional (rol no clínico, que
      // igual exige `assignTo` arriba) nunca la deja en `null` = «sin asignar» por accidente.
      if (!assignee) return null;
      const created = await tx.patient.create({
        data: {
          ...patientData,
          // Clinical fields only for roles that read them. Patient-level active
          // diagnosis (short title + long note) ARE Patient columns (unlike
          // insurerId/insurerName), so persist them explicitly — empty → null.
          // Auto-fills new turnos.
          notes: clinical ? notes ?? null : null,
          diagnosisTitle: clinical ? diagnosisTitle ?? null : null,
          diagnosisNote: clinical ? diagnosisNote ?? null : null,
          tenantId: actor.tenantId,
          // Por defecto la ficha queda a cargo de quien la crea, así el modo
          // de visibilidad por kine funciona de entrada; desde el modal va al
          // profesional del turno (`assignTo`). OWNER/ADMIN pueden re-asignar
          // o dejarla en "consultorio común" después.
          assignedPractitionerId: assignee,
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
    if (!p) {
      return {
        ok: false,
        error: "El profesional elegido no está disponible en este consultorio.",
        fieldErrors: { assignTo: ["Profesional inválido"] },
      };
    }
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
    // BO3-F (handoff 2): modo lectura / soporte → su copy (antes «No pudimos crear el paciente.»).
    const ro = readOnlyFailure(e);
    if (ro) return ro;
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
// BO3-F: el cuerpo va en `updatePatientImpl`; el wrapper convierte el ReadOnlyModeError (modo lectura / soporte)
// en `{ ok:false, error }` para que en prod Next no redacte el mensaje (lib/read-only-result.ts).
export async function updatePatient(...args: Parameters<typeof updatePatientImpl>): Promise<ActionResult<{ id: string; updatedAt: string }>> {
  return withReadOnlyResult(() => updatePatientImpl(...args));
}

async function updatePatientImpl(
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
 *
 * P0-S07sp (E1): exige `canWriteClinical` (rol con `clinical.read` Y acceso
 * full a ESTE paciente), no solo full (`hcAccessError`). Hoy, con PD-13, un
 * rol sin `clinical.read` nunca llega a full, así que el gate viejo ya lo
 * frenaba; el predicado deja la regla explícita y no depende de cómo
 * `visibility` resuelva el nivel. Mismos mensajes que `hcAccessError`. Importa porque el drawer de la agenda llama esto con
 * "Usar como diagnóstico": con los campos ocultos (null) borraba el
 * diagnóstico del paciente.
 */
// BO3-F: el cuerpo va en `setPatientDiagnosisImpl`; el wrapper convierte el ReadOnlyModeError (modo lectura / soporte)
// en `{ ok:false, error }` para que en prod Next no redacte el mensaje (lib/read-only-result.ts).
export async function setPatientDiagnosis(...args: Parameters<typeof setPatientDiagnosisImpl>): Promise<ActionResult> {
  return withReadOnlyResult(() => setPatientDiagnosisImpl(...args));
}

async function setPatientDiagnosisImpl(
  patientId: string,
  title: string,
  note: string
): Promise<ActionResult> {
  const actor = await getActor();
  const caps = await memberCapabilitiesForActor(actor);
  const result = await runWithRls(actor.tenantId, async (tx) => {
    const access = await patientAccessFor(actor, patientId, tx);
    if (access === "none") return { ok: false as const, error: "Paciente no encontrado." };
    if (!canWriteClinical(caps, access)) {
      return { ok: false as const, error: "No tenés acceso completo a este paciente." };
    }
    await tx.patient.update({
      where: { id: patientId, tenantId: actor.tenantId },
      data: {
        diagnosisTitle: title.trim() || null,
        diagnosisNote: note.trim() || null,
      },
    });
    // PL-A (PL-D14, integridad de HC): en la misma tx. Sin el texto (es HC).
    await auditInTx(tx, {
      tenantId: actor.tenantId,
      actorId: actor.userId ?? undefined,
      action: "patient.diagnosis.update",
      entity: "Patient",
      entityId: patientId,
    });
    return { ok: true as const };
  });
  if (!result.ok) return { ok: false, error: result.error };
  revalidatePath(`/pacientes/${patientId}`);
  revalidatePath("/agenda");
  return { ok: true, data: undefined };
}

// A2a-S08 (decisión del dueño 30-sep): se quitó `deletePatient`. El borrado
// definitivo de una ficha arrastraba en cascada turnos, cobros, planes y
// archivos sin retorno; la única salida es Archivar (`setPatientArchived`).

// BO3-F: el cuerpo va en `recordEvaScoreImpl`; el wrapper convierte el ReadOnlyModeError (modo lectura / soporte)
// en `{ ok:false, error }` para que en prod Next no redacte el mensaje (lib/read-only-result.ts).
export async function recordEvaScore(...args: Parameters<typeof recordEvaScoreImpl>): Promise<ActionResult<{ id: string }>> {
  return withReadOnlyResult(() => recordEvaScoreImpl(...args));
}

async function recordEvaScoreImpl(input: {
  patientId: string;
  value: number;
  source?: string;
}): Promise<ActionResult<{ id: string }>> {
  // Enmienda EV0 (S22b): escritura sin el módulo `evaluaciones` → tira (C-EV4).
  const actor = await requireModule("evaluaciones");
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
// BO3-F: el cuerpo va en `setPatientCoverageImpl`; el wrapper convierte el ReadOnlyModeError (modo lectura / soporte)
// en `{ ok:false, error }` para que en prod Next no redacte el mensaje (lib/read-only-result.ts).
export async function setPatientCoverage(...args: Parameters<typeof setPatientCoverageImpl>): Promise<ActionResult> {
  return withReadOnlyResult(() => setPatientCoverageImpl(...args));
}

async function setPatientCoverageImpl(input: {
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
    // PL-A (plata): la cobertura decide el copago; el audit va en la tx del write.
    await auditInTx(tx, {
      tenantId: actor.tenantId,
      actorId: actor.userId ?? undefined,
      action: "patient.coverage.update",
      entity: "Patient",
      entityId: patientId,
      payload: {
        insurer: resolvedName || "Particular",
        insurerId: resolvedInsurerId,
        payerPlanId: resolvedPlan?.id ?? null,
        osChanged: !sameOs,
        copagoReset,
      },
    });
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
// BO3-F: el cuerpo va en `setPatientDefaultCopagoImpl`; el wrapper convierte el ReadOnlyModeError (modo lectura / soporte)
// en `{ ok:false, error }` para que en prod Next no redacte el mensaje (lib/read-only-result.ts).
export async function setPatientDefaultCopago(...args: Parameters<typeof setPatientDefaultCopagoImpl>): Promise<ActionResult> {
  return withReadOnlyResult(() => setPatientDefaultCopagoImpl(...args));
}

async function setPatientDefaultCopagoImpl(input: {
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
    // PL-A (plata): en la misma tx; si el audit falla, el copago no queda.
    await auditInTx(tx, {
      tenantId: actor.tenantId,
      actorId: actor.userId ?? undefined,
      action: "patient.copago.update",
      entity: "Patient",
      entityId: input.patientId,
      payload: { copagoCents: copago },
    });
    return { ok: true as const };
  });
  if (!result.ok) return { ok: false, error: result.error };
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
// BO3-F: el cuerpo va en `assignPatientToPractitionerImpl`; el wrapper convierte el ReadOnlyModeError (modo lectura / soporte)
// en `{ ok:false, error }` para que en prod Next no redacte el mensaje (lib/read-only-result.ts).
export async function assignPatientToPractitioner(...args: Parameters<typeof assignPatientToPractitionerImpl>): Promise<ActionResult> {
  return withReadOnlyResult(() => assignPatientToPractitionerImpl(...args));
}

/**
 * PL-Z (pendiente b): `.strict()` — un campo de más es un caller roto, no algo que se ignora en silencio — y los ids
 * con tope de largo (antes llegaban crudos a Prisma).
 */
const AssignPatientInput = z
  .object({
    patientId: z.string().min(1).max(64),
    practitionerId: z.string().min(1).max(64).nullable(),
  })
  .strict();

async function assignPatientToPractitionerImpl(raw: {
  patientId: string;
  practitionerId: string | null;
}): Promise<ActionResult> {
  const actor = await getActor();
  // PL-3b (C-PL5): por MIEMBRO (`tenant.admin`: el Titular o quien tenga «Configuración» delegada), no por rol. Antes
  // `isTenantAdminRole(role)` le dejaba reasignar a un ADMIN al que el Titular le sacó «Configuración» y no a una
  // Secretaria que la tiene. Soporte vale como la Secretaria (`memberCapabilitiesForActor`): no reasigna.
  if (!(await memberCapabilitiesForActor(actor)).has("tenant.admin")) {
    return { ok: false, error: "Solo el titular o quien tenga permiso de Configuración puede reasignar pacientes." };
  }
  const parsed = AssignPatientInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Datos inválidos" };
  const input = parsed.data;

  // PL-Z (pendiente b): lectura, validación del profesional, update y audit en UNA tx. Antes eran tres `runWithRls`:
  // el `from` del audit podía ser viejo (otra reasignación en el medio) y el profesional validado podía dejar de
  // atender antes del update. El `FOR UPDATE` del paciente serializa dos reasignaciones simultáneas.
  const res = await runWithRls(actor.tenantId, async (tx) => {
    const locked = await tx.$queryRaw<{ assignedPractitionerId: string | null }[]>`
      SELECT "assignedPractitionerId" FROM "Patient"
      WHERE "id" = ${input.patientId} AND "tenantId" = ${actor.tenantId}
      FOR UPDATE`;
    if (locked.length === 0) return { ok: false as const, error: "Paciente no encontrado." };
    const from = locked[0].assignedPractitionerId;

    if (input.practitionerId) {
      // P0.Z (H-b2): mismo filtro que `createPatient` (`clinicalMembershipWhere`, membresía
      // aceptada). Re-asignar a la Secretaria o a Facturación no les da HC
      // (PD-13) y dejaba al paciente sin profesional con full salvo OWNER/ADMIN.
      const prac = await tx.practitioner.findFirst({
        where: {
          id: input.practitionerId,
          tenantId: actor.tenantId,
          user: { memberships: { some: clinicalMembershipWhere(actor.tenantId) } },
        },
        select: { id: true },
      });
      if (!prac) return { ok: false as const, error: "Elegí un profesional activo del consultorio con acceso clínico." };
    }

    // PL-A (acceso): reasignar cambia quién ve la HC completa → audit en la tx del write.
    await tx.patient.updateMany({
      where: { id: input.patientId, tenantId: actor.tenantId },
      data: { assignedPractitionerId: input.practitionerId },
    });
    await auditInTx(tx, {
      tenantId: actor.tenantId,
      actorId: actor.userId ?? undefined,
      action: "patient.reassign",
      entity: "Patient",
      entityId: input.patientId,
      payload: { from, to: input.practitionerId },
    });
    return { ok: true as const, data: undefined };
  });
  if (!res.ok) return res;
  revalidatePath(`/pacientes/${input.patientId}`);
  revalidatePath("/pacientes");
  return res;
}

/**
 * Invitación al portal del paciente (IAM-3c).
 *
 * Antes usaba `inviteUserByEmail` de Supabase: flujo implícito (link a la Site URL = localhost, §19.1 #3),
 * plantilla genérica sin la marca del consultorio, y a un paciente YA vinculado le volvía a mandar un invite
 * que GoTrue rechaza («already registered»): el reenvío fallaba siempre. Ahora, como el resto del bloque IAM
 * (ADR: la app manda los mails, Supabase solo emite tokens):
 *   - link de acceso de un clic con `issueAccessLink({ kind: "magiclink", next: "/portal/c/<slug>" })` a
 *     NUESTRO `/auth/confirm`. Sirve igual para la primera vez y para reenviar: si el paciente no tiene
 *     cuenta, GoTrue la crea sin confirmar [S4] (aceptable: la ficha la cargó el consultorio, y la cuenta
 *     solo se confirma al abrir el link desde su buzón); si ya la tiene, es un magiclink común;
 *   - mail `portal_invite` por `sendEmail`, remitente «<Consultorio> vía KineSoft», Reply-To = el email
 *     público del consultorio;
 *   - el resultado dice la verdad (como el staff en IAM-2a): `emailSent` = el transporte lo aceptó;
 *     `transport`/`emailStatus`/`emailReason` explican por qué no (entorno sin mails, proveedor, link no
 *     emitido). `portalUrl` es la URL pública del portal (no lleva token: se puede mostrar para copiar).
 *
 * El vínculo `Patient.userId` NO se hace acá. ES4 S24v (brief §3.4): la invitación lleva un token HMAC de 7 días
 * (`makePortalInviteToken`: esta ficha, este consultorio, este email) y vincula `/portal/vincular` con un POST y CAS.
 * Antes el link iba a `/portal/c/<slug>` y el vínculo dependía del auto-vínculo por email, que desde PD-15 se niega con
 * dos fichas del mismo email (`ambiguous`): justo el caso en que el consultorio tiene que poder decir CUÁL ficha.
 * El mail lleva dos links: el magic link (`next=/portal/vincular?t=…`, vence en 1 h, GoTrue) y el de respaldo a
 * `/portal/vincular?t=…` (7 días; pide entrar con el mismo email). El token no se loguea ni va al audit.
 *
 * Staff ≠ paciente (AUDIT §5.22): si el email es de alguien del equipo de ESTE consultorio, se rechaza con el
 * motivo (dato propio del consultorio). De otros consultorios no se consulta: sería un oráculo cross-tenant.
 */
export async function sendPatientPortalInvite(input: {
  patientId: string;
}): Promise<
  ActionResult<{
    emailSent: boolean;
    portalUrl: string;
    transport: EmailTransportName | null;
    emailStatus: "sent" | "skipped" | "failed" | "blocked";
    emailReason: string | null;
  }>
> {
  const actor = await getActor();
  // BO-Z (A1): emite el link y manda el mail ANTES de escribir nada; sin este corte un consultorio en solo lectura
  // (o una sesión de soporte) mandaba la invitación igual.
  const readOnly = writableError(actor);
  if (readOnly) return { ok: false, error: readOnly };
  const patient = await runWithRls(actor.tenantId, (tx) => tx.patient.findFirst({
    where: { id: input.patientId, tenantId: actor.tenantId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      userId: true,
      tenant: { select: { slug: true, name: true, publicEmail: true } },
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
  const email = patient.email.trim().toLowerCase();

  const staffHere = await runWithRls(actor.tenantId, (tx) => tx.membership.findMany({
    where: { tenantId: actor.tenantId, user: { email: emailEqualsFilter(email) } },
    select: { user: { select: { email: true } } },
    take: 5,
  }));
  if (staffHere.some((m) => sameEmail(m.user.email, email))) {
    return {
      ok: false,
      error: "Ese email es de alguien del equipo del consultorio: el portal de pacientes es para otro email.",
    };
  }

  // A3a-S-rl: cada llamada manda un mail y no había límite (spam + cuota de
  // envío). 10/h por actor + 1 cada 10 min por destinatario (hash del email,
  // nunca en claro). Va después de los chequeos de acceso para que un rechazo
  // por permisos no consuma cupo.
  const rl = await rateLimitAll([
    { key: `portal-invite:actor:${actor.userId ?? actor.tenantId}`, limit: 10, windowMs: 3_600_000 },
    { key: `portal-invite:to:${hashKeyPart(email)}`, limit: 1, windowMs: 600_000 },
  ]);
  if (!rl.ok) return { ok: false, error: rateLimitedMessage(rl.retryAfterMs) };

  const portalUrl = `${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}/portal/c/${patient.tenant.slug}`;
  const linked = patient.userId != null;

  let outcome: {
    emailSent: boolean;
    transport: EmailTransportName | null;
    emailStatus: "sent" | "skipped" | "failed" | "blocked";
    emailReason: string | null;
  };
  const appUrl = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
  const invitePath = portalVincularPath(
    makePortalInviteToken({ patientId: patient.id, tenantId: actor.tenantId, email })
  );
  const link = await issueAccessLink({ email, kind: "magiclink", next: invitePath });
  if (!link.ok) {
    logger.warn("patient.portal_invite.link_failed", { code: link.code });
    outcome = { emailSent: false, transport: null, emailStatus: "failed", emailReason: `link_${link.code}` };
  } else {
    const r = await sendEmail({
      ...portalInviteEmail({ tenantName: patient.tenant.name, url: link.url, fallbackUrl: `${appUrl}${invitePath}` }),
      kind: "portal_invite",
      to: email,
      tenantId: actor.tenantId,
      entity: "Patient",
      entityId: patient.id,
      fromName: patient.tenant.name,
      replyTo: patient.tenant.publicEmail || null,
      actorId: actor.userId ?? null,
    });
    outcome = r.ok
      ? { emailSent: true, transport: r.transport, emailStatus: "sent", emailReason: null }
      : {
          emailSent: false,
          transport: r.transport,
          emailStatus: r.transport === "blocked" ? "blocked" : r.skipped ? "skipped" : "failed",
          emailReason: r.reason,
        };
  }

  // PL-A (acceso): la invitación no escribe filas propias (el vínculo lo hace el login), así que el audit es el
  // único write y va en su propia tx con el GUC del consultorio (`auditInTx`; no el canal service).
  await runWithRls(actor.tenantId, (tx) =>
    auditInTx(tx, {
      tenantId: actor.tenantId,
      actorId: actor.userId ?? undefined,
      // Con la ficha ya vinculada es un reenvío (la actividad del paciente lo muestra distinto).
      action: linked ? "patient.portal_invite.resend" : "patient.portal_invite",
      entity: "Patient",
      entityId: patient.id,
      payload: { emailSent: outcome.emailSent, transport: outcome.transport, emailStatus: outcome.emailStatus, linked },
    })
  );
  return { ok: true, data: { ...outcome, portalUrl } };
}

/**
 * Bulk archive (or unarchive) patients. Validates tenant ownership on
 * every id, so a client can't sneak ids of patients they don't own.
 * Returns the count of rows that actually changed.
 */
// BO3-F: el cuerpo va en `bulkArchivePatientsImpl`; el wrapper convierte el ReadOnlyModeError (modo lectura / soporte)
// en `{ ok:false, error }` para que en prod Next no redacte el mensaje (lib/read-only-result.ts).
export async function bulkArchivePatients(...args: Parameters<typeof bulkArchivePatientsImpl>): Promise<ActionResult<{ updated: number }>> {
  return withReadOnlyResult(() => bulkArchivePatientsImpl(...args));
}

async function bulkArchivePatientsImpl(input: {
  ids: string[];
  archived: boolean;
  /** L9 (P2-S15): igual que en `setPatientArchived`; default `pause`. */
  plansAction?: PatientArchivePlansAction;
}): Promise<ActionResult<{ updated: number }>> {
  const actor = await getActor();
  const plansAction = parsePlansAction(input.plansAction);
  if (!plansAction) return { ok: false, error: "Acción sobre los planes inválida." };
  if (input.ids.length === 0) return { ok: true, data: { updated: 0 } };
  if (input.ids.length > 200) {
    return { ok: false, error: "Demasiados pacientes a la vez (máx 200)." };
  }
  // A2b-S-vis: todo-o-nada. Mismo gate `full` que `setPatientArchived`; si
  // algún id es ajeno (otro tenant / inexistente) o de acceso básico, no se
  // archiva NINGUNO y se dice cuántos fallaron. Antes los ids ajenos se
  // descartaban en silencio y los básicos se archivaban.
  const ids = Array.from(new Set(input.ids));
  let outcome:
    | { kind: "missing"; n: number }
    | { kind: "basic"; n: number }
    | { kind: "ok"; count: number; refs: BookingChangeRef[] };
  try {
    outcome = await runWithRls(actor.tenantId, async (tx) => {
      const access = await bulkPatientAccess(actor, ids, tx);
      const missing = ids.filter((id) => !access.has(id)).length;
      const basic = ids.filter((id) => access.has(id) && access.get(id) !== "full").length;
      if (missing > 0) return { kind: "missing" as const, n: missing };
      if (basic > 0) return { kind: "basic" as const, n: basic };
      // L9: todos los `lockPlanPatient` en una sentencia, ordenados, antes de
      // cualquier fila (C2 (0)); todo-o-nada con el archivado.
      const plans = input.archived
        ? await applyPatientArchivePlansInTx(tx, actor, { patientIds: ids, action: plansAction, now: new Date() })
        : null;
      const r = await tx.patient.updateMany({
        where: { id: { in: ids }, tenantId: actor.tenantId },
        data: { archivedAt: input.archived ? new Date() : null },
      });
      return { kind: "ok" as const, count: r.count, refs: plans?.refs ?? [] };
    });
  } catch (e) {
    const r = patientArchivePlansRejection(e);
    if (r) return r;
    throw e;
  }
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
  if (outcome.refs.length) await afterBookingsCommitted(actor.tenantId, outcome.refs);
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
  // DIR-0: el actor puede no ser profesional (Secretaria/Admin) y nunca se muestra su email como nombre.
  const userMap = new Map(users.map((u) => [u.id, displayUserName(u.fullName)]));

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
  // PL-1b: «dueño» exige que el MIEMBRO atienda (un Titular sin agenda con un paciente asignado de antes no lo es).
  const memberCaps = await memberCapabilitiesForActor(actor);
  // PL-3b (C-PL5): «administrador» = `tenant.admin` del miembro (Titular o «Configuración» delegada), no el rol.
  const isAdmin = memberCaps.has("tenant.admin");
  // P0.Z (H-b2): "dueño" = asignado Y con `clinical.read`. En prod hay
  // pacientes asignados a la Secretaria (precheck 15): sin el chequeo de rol,
  // ella manejaba los shares y abría la HC a otros profesionales, aunque por
  // PD-13 nunca tiene full sobre esa ficha.
  // IAM-4a: `isActorPractitioner` (nunca `null === null` con un paciente sin asignar).
  const isOwner =
    isActorPractitioner(actor, patient.assignedPractitionerId) && memberCaps.has("clinical.read");
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
// BO3-F: el cuerpo va en `setPatientSharesImpl`; el wrapper convierte el ReadOnlyModeError (modo lectura / soporte)
// en `{ ok:false, error }` para que en prod Next no redacte el mensaje (lib/read-only-result.ts).
export async function setPatientShares(...args: Parameters<typeof setPatientSharesImpl>): Promise<ActionResult> {
  return withReadOnlyResult(() => setPatientSharesImpl(...args));
}

async function setPatientSharesImpl(input: {
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
  // al guardar (no está en `wanted`). Mismo filtro que `listPractitioners`
  // (IAM-2e: rol clínico y sin suspender; la Secretaria no recibe la HC).
  const tenantPractitioners = await runWithRls(actor.tenantId, (tx) => tx.practitioner.findMany({
    where: {
      ...bookablePractitionerWhere(actor.tenantId, { includeDisabledFilter: true }),
      id: { in: wantedRaw },
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

  // PL-A (acceso): compartir da HC completa a otro profesional → audit en la misma tx que los shares.
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
    if (toAdd.length > 0 || toRemove.length > 0) {
      await auditInTx(tx, {
        tenantId: actor.tenantId,
        actorId: actor.userId,
        action: "patient.share.update",
        entity: "Patient",
        entityId: input.patientId,
        payload: { added: toAdd, removed: toRemove },
      });
    }
  });

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


