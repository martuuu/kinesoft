/**
 * PF2-b (C-PF8) · Loader de `/pacientes/[id]`: una tx para el perfil.
 *
 * Antes (PF-0b): ~12 transacciones por carga. Cada lector (`getPatientCore`, turnos, conteo, EVA, planes, saldos,
 * profesionales, el turno del deep link, el nombre del `generateMetadata`) abría su `runWithRls`, y cada uno volvía a
 * resolver el acceso al paciente (paciente + ajustes + membresía + share) en su propia tx. Con un pool chico se
 * serializaban y una lectura lenta tiraba P2028 al resto (AUDIT `runwithrls-interactive-tx-per-read`).
 *
 * Ahora (presupuesto C-PF8: ≤ 3):
 *  1. `runWithRls(tenantId, tx => loadPatientProfile(actor, tx, input))`: acceso UNA vez, core y todos los slices.
 *  2. `listInsurers` (lib/insurers.ts, de PF2-d): queda con su `unstable_cache` y su tx propia solo en frío.
 *  3. `getPatientClinicalSummary` (evoluciones): `lib/clinical-notes*.ts` no admite `tx` sin tocar AUDIT §5.51-55, así
 *     que queda como 1 tx propia (excepción escrita en C-PF8).
 * `generateMetadata` y la página comparten la carga por `cache()` de React (mismo request): el nombre sale del core.
 *
 * Visibilidad: tiene que dar EXACTAMENTE lo mismo que los lectores públicos. El nivel sale de
 * `patientAccessFor(actor, patientId, tx)` y cada slice usa el MISMO cuerpo que su lector público
 * (`lib/patients-profile-internal.ts`, al que delegan los de `lib/patients.ts`). Planes y saldos replican
 * `getPatientPlans` / `getPatientPlanBalances` de `lib/plans-read.ts` (archivo de otra sesión, "use server") con sus
 * mismos helpers de `lib/plans-read-internal.ts`; la paridad la fija tests/integration/pf2-profile-budget.test.ts.
 */
import "server-only";
import { cache } from "react";
import type { Prisma } from "@prisma/client";
import { runWithRls, type DbClient } from "@/lib/rls";
import type { Actor } from "@/lib/session";
import type { Capability } from "@/lib/capabilities";
import { memberCapabilitiesForActor } from "@/lib/authz";
import { modulesFor } from "@/lib/tenant-modules";
import { patientAccessFor, type AccessLevel } from "@/lib/visibility";
import { bookablePractitionerWhere } from "@/lib/practitioner-scope";
import { liveProgramWhere } from "@/lib/plan-predicates";
import { planTitleFor } from "@/lib/plan-authz-internal";
import { balanceOf, loadPlansInTx, planReadLevel, projectPlan } from "@/lib/plans-read-internal";
import {
  PatientIdInput,
  PatientPlansInput,
  PLAN_READ_COPY,
  type PatientPlanBalances,
  type PlanDTO,
  type PlanReadResult,
} from "@/lib/plans-read-types";
import { parseProfilePlanParams, type SearchParamsLike } from "@/lib/plans-deeplink";
import {
  patientBillableCountInTx,
  patientBookingsAllInTx,
  patientBookingsSummaryInTx,
  patientCoreInTx,
  patientEvaScoresInTx,
} from "@/lib/patients-profile-internal";
import type { PatientAdminCore, PatientBasic, PatientCore } from "@/lib/patients-types";
import { listInsurers } from "@/lib/insurers";
import { getPatientClinicalSummary } from "@/lib/clinical-notes-read";

/** Turnos del perfil `admin` (mismo tope que pedía la página: 100). */
export const PROFILE_ADMIN_BOOKINGS = 100;
/** Turnos de Resumen del perfil `full` (mismo tope que pedía la página: 5). */
export const PROFILE_RECENT_BOOKINGS = 5;

/**
 * EV2-3a · deep link `?tab=evoluciones&turno=<bookingId>`: el id se valida con el mismo molde que el resto de los ids
 * de URL y solo se mira con el módulo `evoluciones` y la pestaña de evoluciones. Puro (sin base): lo usan la página y
 * `generateMetadata` para pedir la MISMA carga (misma clave de `cache()`).
 */
export function profileNoteBookingId(actor: Actor, searchParams: SearchParamsLike): string | null {
  if (!modulesFor(actor.entitlements).has("evoluciones")) return null;
  const { tab } = parseProfilePlanParams(searchParams);
  const raw =
    searchParams instanceof URLSearchParams
      ? searchParams.get("turno")
      : typeof searchParams.turno === "string"
        ? searchParams.turno
        : null;
  return tab === "evoluciones" && raw && /^[A-Za-z0-9_-]{1,64}$/.test(raw) ? raw : null;
}

const PRACTITIONER_INCLUDE = { user: { select: { fullName: true, email: true } } } as const;
type PractitionerRow = Prisma.PractitionerGetPayload<{ include: typeof PRACTITIONER_INCLUDE }>;

export type ProfileNoteBookingRow = {
  id: string;
  scheduledFor: Date;
  status: Prisma.BookingGetPayload<object>["status"];
  service: { name: string } | null;
};

export type PatientProfileTx =
  | { access: "none" }
  | { access: "basic"; core: PatientBasic }
  | {
      access: "admin";
      core: PatientAdminCore;
      bookingsPage: Awaited<ReturnType<typeof patientBookingsAllInTx>>;
      /** null = sin módulo `planes` (no se pidió). */
      plans: PlanReadResult<PlanDTO[]> | null;
      balances: PlanReadResult<PatientPlanBalances> | null;
    }
  | {
      access: "full";
      core: PatientCore & { access: "full" };
      plans: PlanReadResult<PlanDTO[]> | null;
      balances: PlanReadResult<PatientPlanBalances> | null;
      recentBookings: Awaited<ReturnType<typeof patientBookingsSummaryInTx>>;
      billableCount: number;
      evaScores: Awaited<ReturnType<typeof patientEvaScoresInTx>>;
      practitioners: PractitionerRow[];
      noteBookingRow: ProfileNoteBookingRow | null;
    };

/**
 * La carga del perfil dentro del `tx` que abre el que llama (C-PF8). Sin `runWithRls` propio. Las sentencias corren
 * en serie (una conexión): primero el acceso y el core (cortan temprano: "none" no lee nada más, `basic` nada más que
 * su proyección), después los slices del nivel.
 */
export async function loadPatientProfile(
  actor: Actor,
  tx: DbClient,
  input: { patientId: string; noteBookingId: string | null }
): Promise<PatientProfileTx> {
  const { patientId } = input;
  const access = await patientAccessFor(actor, patientId, tx);
  const core = await patientCoreInTx(tx, actor, patientId, access);
  if (!core) return { access: "none" };
  if (core.access === "basic") return { access: "basic", core };

  const modules = modulesFor(actor.entitlements);
  const plansEnabled = modules.has("planes");
  const caps = await memberCapabilitiesForActor(actor);

  // P0-S07v · nivel `admin` (PD-13): turnos (con estado de cobro) y, con el módulo `planes`, planes en su proyección
  // `admin` (sin título ni notas, S14) y saldos, para agrupar Turnos por plan (H1 de S22f). Ningún slice clínico.
  if (core.access === "admin") {
    const bookingsPage = await patientBookingsAllInTx(tx, actor, patientId, access, PROFILE_ADMIN_BOOKINGS);
    const pb = plansEnabled ? await patientPlansAndBalancesInTx(tx, actor, caps, patientId, access) : null;
    return { access: "admin", core, bookingsPage, plans: pb?.plans ?? null, balances: pb?.balances ?? null };
  }

  const pb = plansEnabled ? await patientPlansAndBalancesInTx(tx, actor, caps, patientId, access) : null;
  const recentBookings = await patientBookingsSummaryInTx(tx, actor, patientId, access, PROFILE_RECENT_BOOKINGS);
  const billableCount = await patientBillableCountInTx(tx, actor, patientId, access);
  // Enmienda EV0 de S22b: sin `evaluaciones` no se piden EVA (y la pestaña EVA no se muestra).
  const evaScores = await patientEvaScoresInTx(tx, actor, patientId, access);
  const practitioners = await tx.practitioner.findMany({
    // Solo miembros con la invitación aceptada: un profesional removido
    // (membresía borrada) conserva su fila Practitioner y seguía en los
    // pickers. Mismo filtro que `listPractitioners` (lib/bookings.ts):
    // IAM-2e, solo roles clínicos sin suspender (la Secretaria no atiende).
    where: bookablePractitionerWhere(actor.tenantId, { includeDisabledFilter: true }),
    include: PRACTITIONER_INCLUDE,
    orderBy: { createdAt: "asc" },
  });
  // EV2-3a: el turno del deep link se proyecta solo si es de ESTE paciente y del consultorio (fecha, estado y
  // servicio: lo que la ficha `full` ya ve en Turnos).
  const noteBookingRow = input.noteBookingId
    ? await tx.booking.findFirst({
        where: { id: input.noteBookingId, tenantId: actor.tenantId, patientId },
        select: { id: true, scheduledFor: true, status: true, service: { select: { name: true } } },
      })
    : null;
  return {
    access: "full",
    core,
    plans: pb?.plans ?? null,
    balances: pb?.balances ?? null,
    recentBookings,
    billableCount,
    evaScores,
    practitioners,
    noteBookingRow,
  };
}

/**
 * Réplica en-tx de `getPatientPlans({ patientId })` + `getPatientPlanBalances({ patientId })` (lib/plans-read.ts,
 * archivo "use server" de otra sesión) con sus mismos helpers, en UNA lectura de planes: los dos piden los planes del
 * paciente con el mismo `select` y el mismo orden, y solo difieren en que la lista excluye archivados
 * (`liveProgramWhere` = `{ archivedAt: null }`, lib/plan-predicates.ts) y los saldos no. Se filtra en memoria con el
 * mismo predicado; la paridad (con un plan archivado en el fixture) la fija tests/integration/pf2-profile-budget.test.ts.
 *
 * Mismos cortes que los lectores públicos: id inválido → `invalid`; sin nivel de lectura de planes (caps del miembro
 * + acceso) → `forbidden`. El que llama ya miró el módulo `planes`.
 */
export async function patientPlansAndBalancesInTx(
  tx: DbClient,
  actor: Actor,
  caps: ReadonlySet<Capability>,
  patientId: string,
  access: AccessLevel
): Promise<{ plans: PlanReadResult<PlanDTO[]>; balances: PlanReadResult<PatientPlanBalances> }> {
  const fail = (error: string) => ({ plans: { ok: false as const, error }, balances: { ok: false as const, error } });
  if (!PatientPlansInput.safeParse({ patientId }).success || !PatientIdInput.safeParse({ patientId }).success) {
    return fail(PLAN_READ_COPY.invalid);
  }
  const level = planReadLevel(caps, access);
  if (!level) return fail(PLAN_READ_COPY.forbidden);
  const all = await loadPlansInTx(tx, actor.tenantId, { patientId });

  const now = new Date();
  const live = all.filter((p) => p.archivedAt === liveProgramWhere.archivedAt);
  const plans = live.map((p) => projectPlan(p, { caps, access, level, now }));

  const balances: PatientPlanBalances = {
    plans: [],
    totals: { pendingCents: 0, creditCents: 0, collectedCents: 0, inProcessCents: 0 },
  };
  for (const p of all) {
    const balance = balanceOf(p);
    const title = planTitleFor(caps, access, p.title);
    balances.plans.push({ programId: p.id, discipline: p.discipline, status: p.status, title, balance });
    balances.totals.pendingCents += balance.pendingCents;
    balances.totals.creditCents += balance.creditCents;
    balances.totals.collectedCents += balance.collectedCents;
    balances.totals.inProcessCents += balance.inProcessCents;
  }
  return { plans: { ok: true, data: plans }, balances: { ok: true, data: balances } };
}

export type PatientProfileData =
  | Exclude<PatientProfileTx, { access: "full" }>
  | (Extract<PatientProfileTx, { access: "full" }> & {
      insurers: Awaited<ReturnType<typeof listInsurers>>;
      clinicalSummary: Awaited<ReturnType<typeof getPatientClinicalSummary>>;
    });

/**
 * Todo lo que la página lee de la base, con el actor ya resuelto. `cache()` de React: `generateMetadata` y la página
 * piden lo mismo en el mismo request y comparten UNA carga (antes el nombre era otra tx). La clave es
 * (actor, patientId, noteBookingId): el actor es el mismo objeto en el request (`getActor` también es `cache()`).
 *
 * Solo para `full`, después de la tx: obras sociales (cacheadas) y el resumen de evoluciones, en paralelo.
 */
export const loadPatientProfilePage = cache(
  async (actor: Actor, patientId: string, noteBookingId: string | null): Promise<PatientProfileData> => {
    const base = await runWithRls(actor.tenantId, (tx) => loadPatientProfile(actor, tx, { patientId, noteBookingId }));
    if (base.access !== "full") return base;
    const [insurers, clinicalSummary] = await Promise.all([
      listInsurers({ onlyActive: true }),
      // EV2-3a: contador de la pestaña + «Última evolución» de Resumen. Solo en el perfil `full` (nunca en `admin` ni
      // en el básico); el gate de la lectura (`clinical.read` + full) devuelve null al Titular sin agenda.
      modulesFor(actor.entitlements).has("evoluciones") ? getPatientClinicalSummary(patientId) : null,
    ]);
    return { ...base, insurers, clinicalSummary };
  }
);
