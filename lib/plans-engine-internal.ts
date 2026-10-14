import "server-only";

/**
 * Motor de Planes server-only: preview + commit (S11e, ES2b P2.1; PLANES.md
 * §5 "Motor", contratos C2, C3, C5, C6, C7 y C8).
 *
 * Qué publica para P2.2 (C8, firmas congeladas; S16a, S16b, S25a y S17d SOLO
 * consumen — un cambio acá va por handoff):
 *   - `validatePlanRefsInTx`: ids de entrada contra el tenant (las FK saltean
 *     RLS y en prod la conexión es BYPASSRLS; `TreatmentProgram.locationId`
 *     tiene FK simple, no compuesta), duración efectiva 15..240, membresía
 *     aceptada, regla PS (deshabilitada = rechazo; PRIVATE sí sirve: es el
 *     canal del staff), coherencia de disciplina, plantilla y ejercicios
 *     asignables.
 *   - `previewProgramRowsInTx` y `reclassifyOrThrowStaleInTx` (planes que ya
 *     existen: generar, re-planificar, agregar).
 *   - `commitPlanRowsInTx`: el único escritor de turnos de plan (I8:
 *     `pricedByPlan=true` solo lo escribe esto).
 *   - `createPlanInTx`: el alta completa en la tx del caller (con el hook
 *     `clinicalCase` para Diagnóstico, S17d).
 *   - `StalePlanPreview`.
 *
 * Orden de locks (C2, literal): `lockPlanPatient` primero → cupos
 * (`lockCapacityMany`, UNA sentencia, claves ordenadas) →
 * `lockTenantLocationsShared` una vez → filas Booking `FOR UPDATE` id asc →
 * Session → TreatmentProgram. La disponibilidad se carga DESPUÉS de los locks
 * de cupo: en READ COMMITTED cada sentencia ve lo que otro commiteó mientras
 * esperábamos (mismo criterio que `liveBlocksInTx` de bookings-core).
 *
 * Gates: este módulo NO decide permisos salvo `createPlanInTx`
 * (`assertPlanManageInTx`, la primitiva de "crear"). Las primitivas de P2.2
 * (`previewProgramRowsInTx`, `reclassifyOrThrowStaleInTx`,
 * `commitPlanRowsInTx`) asumen que el caller YA gateó con
 * `assertPlanScheduleInTx` (generar) o `assertPlanManageInTx` (re-planificar,
 * agregar) y, en los commits, que YA tomó `lockPlanPatient`.
 *
 * Realtime (enmienda): nada de acá emite. Los `*InTx` DEVUELVEN
 * `BookingChangeRef[]` y la action llama `afterBookingsCommitted` una vez,
 * después del commit y fuera de la tx.
 */
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { Actor } from "@/lib/session";
import type { DbClient } from "@/lib/rls";
import { auditInTx } from "@/lib/audit";
import { capabilitiesFor, type Capability } from "@/lib/capabilities";
import { assertPlanManageInTx } from "@/lib/plan-authz-internal";
import { lockPlanPatient } from "@/lib/plan-lock";
import { capacityKeysForWindow, lockCapacityMany, type CapacityLockKey } from "@/lib/booking-cap-lock";
import { lockTenantLocationsShared } from "@/lib/location-lock";
import { assertProgramInvariantsInTx } from "@/lib/plan-invariants-internal";
import { adoptableBookingWhere } from "@/lib/plan-predicates";
import { distributePackage, priorPaidStamp, type PricingBooking } from "@/lib/plan-pricing";
import { assignableExerciseWhere, resolveCapabilities } from "@/lib/plan-gating";
import { disciplineLabel } from "@/lib/plan-display";
import { MODULE_DENIED_COPY } from "@/lib/tenant-modules";
import { PLAN_KEY_PREFIX, PLAN_MAX_DURATION, PLAN_MIN_DURATION, type Discipline } from "@/lib/plans-constants";
import { BAD_LOCATION_ERROR } from "@/lib/bookings-constants";
import { buildBookingCreateData, defaultLocationFor, practitionerServiceRule } from "@/lib/bookings-core";
import type { BookingChangeRef } from "@/lib/booking-events-internal";
import { dayKeyToDbDate, dayWindow } from "@/lib/availability/day";
import { defaultRoomFor } from "@/lib/availability/rooms";
import {
  classifyPlanRows,
  expandPlanDates,
  planPreviewSummary,
  planStateToken,
  toPlanPreviewRow,
  type PlanAuthorizationInput,
  type PlanCreateInput,
  type PlanPreview,
  type PlanRowClassification,
  type PlanRowResolution,
  type PlanScheduleV1,
} from "@/lib/availability/plan";
import {
  authorizationInputOf,
  loadOtherActivePlansInTx,
  loadPlanAvailabilityInTx,
  loadProgramForEngineInTx,
  type PatientBookingDetail,
  type PlanAvailability,
  type ProgramEngineRow,
} from "@/lib/plans-load-internal";

const MIN_MS = 60_000;

// ─────────────────────────────────────────────────────────────────────────────
// Errores
// ─────────────────────────────────────────────────────────────────────────────

/**
 * El borrador ya no vale tal cual (C7): alguna fila quedó sin resolución
 * válida (resolución faltante, adoptado que cambió su `updatedAt`, una
 * resolución que ya no está permitida) o cambió el borrador (`stateToken`).
 * Tirarlo dentro de la tx hace rollback total.
 *
 * `preview` = las filas re-clasificadas, para que la UI marque las que
 * cambiaron. `null` = el conflicto se vio recién al escribir (CAS de adopción
 * con `count ≠ 1`); el caller re-previsualiza en una tx nueva.
 */
export class StalePlanPreview extends Error {
  constructor(
    public readonly preview: PlanPreview | null,
    public readonly reason: "rows" | "draft" | "write-conflict" = "rows"
  ) {
    super("La agenda cambió mientras armabas el plan. Revisá las filas marcadas y confirmá de nuevo.");
    this.name = "StalePlanPreview";
  }
}

/** Rechazo de datos (ids ajenos, duración, sede…): la action lo devuelve como `{ ok:false, error }`. */
export class PlanRejected extends Error {
  constructor(
    message: string,
    public readonly field?: string
  ) {
    super(message);
    this.name = "PlanRejected";
  }
}

export const PLAN_ENGINE_COPY = {
  stale: "La agenda cambió mientras armabas el plan. Revisá las filas marcadas y confirmá de nuevo.",
  practitioner: "El profesional responsable no es un miembro activo del consultorio.",
  service: "Servicio inválido.",
  serviceDisabled: (name: string) => `${name} no está habilitado para el profesional responsable.`,
  discipline: (d: Discipline) =>
    `El servicio es de ${disciplineLabel(d)}: elegí uno de la disciplina del plan o sin disciplina.`,
  durationLong: "La duración supera 4 h: definí una duración para el plan",
  durationShort: "La duración del plan tiene que ser de al menos 15 minutos.",
  location: BAD_LOCATION_ERROR,
  template: "Plantilla inválida.",
  exercises: "Hay ejercicios que no se pueden asignar.",
  program: "Plan inválido.",
  fromBooking: "El turno de origen no es de este paciente.",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Refs (C8: validatePlanRefsInTx)
// ─────────────────────────────────────────────────────────────────────────────

export type PlanRefsInput = {
  discipline: Discipline | null;
  practitionerId: string;
  serviceId: string;
  locationId: string | null;
  /** Override del plan (15..240); null/undefined = PS ?? Service. */
  durationMin?: number | null;
  templateId?: string | null;
  exerciseIds?: ReadonlyArray<string>;
};

export type PlanRefsOk = {
  practitioner: { id: string; userId: string };
  service: { id: string; name: string; discipline: Discipline | null };
  /** Duración efectiva = override ?? PS ?? Service, ya en 15..240. */
  durationMin: number;
  /** Cupo efectivo (PS override o el del servicio); null = ilimitado. */
  cap: number | null;
  locationId: string | null;
  /**
   * `exerciseIds` = los de la plantilla que HOY son asignables, en su orden
   * (P3.Z: los que se archivaron o salieron del catálogo después de guardarla
   * se saltean, no rechazan el alta). `exercises` = esos mismos con la dosis
   * por defecto del ejercicio `?? 3×12` (C8), para un alta sin `exercises`.
   */
  template: {
    id: string;
    exerciseIds: string[];
    exercises: Array<{ exerciseId: string; sets: number; reps: number }>;
  } | null;
};

/** Dosis por defecto cuando el ejercicio no trae series/reps (C8 · `?? 3/12`, como el prefill). */
const DEFAULT_SETS = 3;
const DEFAULT_REPS = 12;

/**
 * Valida (dentro de la tx) TODO id que el plan va a escribir en
 * `TreatmentProgram.{practitionerId, serviceId, locationId, templateId}` y en
 * `SessionExercise.exerciseId` (I4). Tira `PlanRejected` con el copy.
 *
 * La sede se chequea acá SIN lock (rechazo temprano de una sede ajena o
 * archivada). La validación autoritativa es la del commit: después de
 * `lockTenantLocationsShared` (S13g, literal: el lock ANTES de validar con
 * `{id, tenantId, active}`), que por C2 va después de los cupos.
 */
export async function validatePlanRefsInTx(tx: DbClient, actor: Actor, refs: PlanRefsInput): Promise<PlanRefsOk> {
  const tenantId = actor.tenantId;
  // Visibilidad del catálogo y módulos por los entitlements del actor (C-EV3,
  // sin query): `buildActor` ya leyó la fila de Tenant en este request.
  const gate = resolveCapabilities(actor.entitlements.plan, tenantId, actor.entitlements.vertical);
  // P3.Z (F1): plantillas solo con el módulo `plantillas` (enmienda EV0,
  // literal: "plantillas solo por canBuildTemplates / has('plantillas')").
  // Antes lo cortaba el "aplicar" viejo (`[P0-S02t] FREE no aplica`); al
  // retirarlo, un FREE o un STARTER que bajó de plan con filas viejas la
  // aplicaba por RPC con `createPlan({ templateId })`. Va antes de leer la
  // plantilla: sin el módulo no importa si existe (no oráculo).
  if (refs.templateId && !gate.canBuildTemplates) {
    throw new PlanRejected(MODULE_DENIED_COPY.plantillas, "templateId");
  }
  const [prac, service, location, template] = await Promise.all([
    tx.practitioner.findFirst({
      where: { id: refs.practitionerId, tenantId },
      select: {
        id: true,
        userId: true,
        // IAM-4b: + `disabledAt` (escalar de la misma relación: 0 sentencias nuevas).
        user: { select: { memberships: { where: { tenantId }, select: { role: true, acceptedAt: true, disabledAt: true } } } },
      },
    }),
    tx.service.findFirst({
      where: { id: refs.serviceId, tenantId },
      select: { id: true, name: true, discipline: true, durationMin: true, maxConcurrent: true, practitionerId: true },
    }),
    refs.locationId
      ? tx.location.findFirst({ where: { id: refs.locationId, tenantId, active: true }, select: { id: true } })
      : Promise.resolve(null),
    refs.templateId
      ? tx.planTemplate.findFirst({
          where: { id: refs.templateId, tenantId, archivedAt: null },
          select: { id: true, exerciseIds: true },
        })
      : Promise.resolve(null),
  ]);
  // Responsable = miembro ACEPTADO con un rol que gestiona planes (no la
  // Secretaria ni Facturación, que también tienen fila de Practitioner).
  // IAM-4b: y sin suspender (`Membership.disabledAt`, M6): mismo criterio que
  // `bookablePractitionerWhere`; un suspendido no aparece en la agenda ni
  // ofrece slots, así que un plan nuevo a su nombre quedaría huérfano.
  const m = prac?.user.memberships[0];
  if (!prac || !m || m.acceptedAt == null || m.disabledAt != null || !capabilitiesFor(m.role).has("plans.manage")) {
    throw new PlanRejected(PLAN_ENGINE_COPY.practitioner, "practitionerId");
  }
  if (!service) throw new PlanRejected(PLAN_ENGINE_COPY.service, "serviceId");
  if (refs.discipline && service.discipline && service.discipline !== refs.discipline) {
    throw new PlanRejected(PLAN_ENGINE_COPY.discipline(service.discipline), "serviceId");
  }
  if (refs.locationId && !location) throw new PlanRejected(PLAN_ENGINE_COPY.location, "locationId");
  if (refs.templateId && !template) throw new PlanRejected(PLAN_ENGINE_COPY.template, "templateId");

  const rule = await practitionerServiceRule(tx, tenantId, prac.id, service);
  if (!rule.enabled) throw new PlanRejected(PLAN_ENGINE_COPY.serviceDisabled(service.name), "serviceId");
  const durationMin = refs.durationMin ?? rule.durationMin;
  if (durationMin > PLAN_MAX_DURATION) throw new PlanRejected(PLAN_ENGINE_COPY.durationLong, "durationMin");
  if (durationMin < PLAN_MIN_DURATION) throw new PlanRejected(PLAN_ENGINE_COPY.durationShort, "durationMin");

  const templateExerciseIds = template && Array.isArray(template.exerciseIds)
    ? (template.exerciseIds as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  const clientIds = Array.from(new Set(refs.exerciseIds ?? []));
  const exerciseIds = Array.from(new Set([...clientIds, ...templateExerciseIds]));
  const assignable = new Map<string, { defaultSets: number | null; defaultReps: number | null }>();
  if (exerciseIds.length) {
    // Asignable = visible por el plan SaaS + no archivado. Un ejercicio de
    // otro consultorio no matchea.
    const ok = await tx.exercise.findMany({
      where: { AND: [{ id: { in: exerciseIds } }, assignableExerciseWhere(gate)] },
      select: { id: true, defaultSets: true, defaultReps: true },
    });
    for (const e of ok) assignable.set(e.id, e);
    // Solo se rechazan los ids que manda el CLIENTE. Los de la plantilla se
    // filtran (P3.Z): antes un ejercicio archivado después de guardarla
    // mataba el alta entera, y el prefill omitía `templateId` para esquivarlo
    // (el plan perdía el vínculo con su plantilla).
    if (clientIds.some((id) => !assignable.has(id))) throw new PlanRejected(PLAN_ENGINE_COPY.exercises, "exercises");
  }
  const templateAssignable = templateExerciseIds.filter((id) => assignable.has(id));
  return {
    practitioner: { id: prac.id, userId: prac.userId },
    service: { id: service.id, name: service.name, discipline: service.discipline },
    durationMin,
    cap: rule.cap,
    locationId: refs.locationId,
    template: template
      ? {
          id: template.id,
          exerciseIds: templateAssignable,
          exercises: templateAssignable.map((exerciseId) => {
            const e = assignable.get(exerciseId)!;
            return { exerciseId, sets: e.defaultSets ?? DEFAULT_SETS, reps: e.defaultReps ?? DEFAULT_REPS };
          }),
        }
      : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Núcleo: filas → clasificación
// ─────────────────────────────────────────────────────────────────────────────

/** Contexto del clasificador (plan nuevo o existente). */
export type PlanEngineContext = {
  tenantId: string;
  patientId: string;
  practitionerId: string;
  serviceId: string;
  /** Sede del plan; null = la deciden las franjas (el turno toma la de la franja o la principal). */
  locationId: string | null;
  durationMin: number;
  cap: number | null;
  authorization?: PlanAuthorizationInput;
};

/** Una fila a clasificar: una sesión (existente o nueva) en su instante planificado. */
export type PlanEngineRow = {
  index: number;
  at: Date;
  sessionId?: string;
  /**
   * Fecha ACTUAL de la sesión existente (`Session.scheduledFor`), distinta de
   * `at` (la planificada de la fila) cuando se re-planifica o se adopta: el
   * commit compara contra esta para decidir si mueve la sesión (I3). P2-Z:
   * comparar contra `at` dejaba la sesión en la fecha vieja en una fila "libre".
   */
  currentAt?: Date;
  /** Turno activo actual de la sesión (re-planificar): no cuenta contra sí mismo. */
  excludeBookingId?: string | null;
  /** La cuota de la sesión (C5: `Session.priceCents` es la fuente). */
  priceCents: number | null;
  /** Turnos previos de la sesión (cobro previo, C5). Vacío en una sesión nueva. */
  priorBookings?: ReadonlyArray<PricingBooking>;
  /** Título de la sesión (solo para escribir una sesión nueva). */
  title?: string | null;
};

export type ClassifiedPlan = {
  classifications: PlanRowClassification[];
  availability: PlanAvailability;
  rows: PlanEngineRow[];
};

/** Instante donde una resolución crea un turno (para los locks de cupo), o null. */
function landingInstant(row: PlanEngineRow, res: PlanRowResolution | undefined): Date | null {
  if (!res) return row.at; // sin resolución solo vale si la fila está libre (crear tal cual)
  if (res.kind === "create" || res.kind === "force") return row.at;
  if (res.kind === "move" && res.at) {
    const t = new Date(res.at);
    return Number.isNaN(t.getTime()) ? null : t;
  }
  return null;
}

/**
 * Locks de cupo (C2 (1)) de todos los turnos que las resoluciones pueden
 * crear, en UNA sentencia, y después el lock compartido de sedes (C2 (2)),
 * una vez. Va antes de cargar la disponibilidad.
 */
async function lockPlanWindowsInTx(
  tx: DbClient,
  ctx: PlanEngineContext,
  rows: ReadonlyArray<PlanEngineRow>,
  resolutions: ReadonlyMap<number, PlanRowResolution>
): Promise<void> {
  const keys: CapacityLockKey[] = [];
  for (const r of rows) {
    const at = landingInstant(r, resolutions.get(r.index));
    if (!at) continue;
    keys.push(
      ...capacityKeysForWindow({
        tenantId: ctx.tenantId,
        practitionerId: ctx.practitionerId,
        serviceId: ctx.serviceId,
        start: at,
        end: new Date(at.getTime() + ctx.durationMin * MIN_MS),
      })
    );
  }
  await lockCapacityMany(tx, keys);
  await lockTenantLocationsShared(tx, ctx.tenantId);
}

/** C2 (3): los turnos que se van a adoptar, `FOR UPDATE` en orden de id. */
async function lockAdoptedBookingsInTx(
  tx: DbClient,
  tenantId: string,
  resolutions: ReadonlyMap<number, PlanRowResolution>
): Promise<void> {
  const ids = Array.from(
    new Set(
      Array.from(resolutions.values())
        .filter((r) => r.kind === "adopt" && r.bookingId)
        .map((r) => r.bookingId as string)
    )
  ).sort();
  if (ids.length === 0) return;
  await tx.$queryRaw`SELECT "id" FROM "Booking" WHERE "tenantId" = ${tenantId} AND "id" = ANY(${ids}::text[]) ORDER BY "id" FOR UPDATE`;
}

async function classifyInTx(
  tx: DbClient,
  ctx: PlanEngineContext,
  rows: PlanEngineRow[],
  resolutions: ReadonlyMap<number, PlanRowResolution>,
  now: Date
): Promise<ClassifiedPlan> {
  const extraInstants = Array.from(resolutions.values())
    .filter((r) => r.kind === "move" && r.at)
    .map((r) => new Date(r.at as string))
    .filter((d) => !Number.isNaN(d.getTime()));
  const availability = await loadPlanAvailabilityInTx(tx, {
    tenantId: ctx.tenantId,
    patientId: ctx.patientId,
    practitionerId: ctx.practitionerId,
    serviceId: ctx.serviceId,
    locationId: ctx.locationId,
    durationMin: ctx.durationMin,
    rows,
    extraInstants,
  });
  const excludeBookingIds = rows.map((r) => r.excludeBookingId).filter((x): x is string => !!x);
  const classifications = classifyPlanRows(
    {
      rows: rows.map((r) => {
        const prior = r.priorBookings?.length ? priorPaidStamp({ priceCents: r.priceCents }, r.priorBookings).priorPaid : null;
        return {
          index: r.index,
          at: r.at,
          ...(r.sessionId ? { sessionId: r.sessionId } : {}),
          excludeBookingId: r.excludeBookingId ?? null,
          ...(prior ? { priorPaid: prior } : {}),
          ...(resolutions.has(r.index) ? { resolution: resolutions.get(r.index) } : {}),
        };
      }),
      patientId: ctx.patientId,
      practitionerId: ctx.practitionerId,
      serviceId: ctx.serviceId,
      locationId: ctx.locationId,
      durationMin: ctx.durationMin,
      cap: ctx.cap,
      rangesFor: availability.rangesFor,
      blocks: availability.input.blocks,
      bookings: availability.bookings,
      now,
      excludeBookingIds,
    },
    ctx.authorization
  );
  return { classifications, availability, rows };
}

/**
 * ¿La fila está stale para el commit? (C7: resolución faltante o una que no
 * vale; nunca por hash de disponibilidad). Sin resolución explícita solo se
 * acepta lo que no necesita decisión: una fila libre (se crea tal cual) o una
 * pasada sin turno a la vista (queda sin turno).
 */
export function isRowStale(c: PlanRowClassification, res: PlanRowResolution | undefined): boolean {
  if (res) return c.resolutionOk === false;
  if (c.class === "libre" && c.defaultResolution === "create") return false;
  if (c.class === "pasado" && c.defaultResolution === "none") return false;
  return true;
}

function previewOf(
  cp: ClassifiedPlan,
  stateToken: string,
  otherActivePlans: PlanPreview["otherActivePlans"]
): PlanPreview {
  const price = new Map(cp.rows.map((r) => [r.index, r.priceCents]));
  return {
    rows: cp.classifications.map((c) => toPlanPreviewRow(c, price.get(c.index) ?? null)),
    stateToken,
    summary: planPreviewSummary(cp.classifications),
    otherActivePlans,
  };
}

const resolutionMap = (rows: ReadonlyArray<PlanRowResolution> | undefined) =>
  new Map((rows ?? []).map((r) => [r.index, r]));

// ─────────────────────────────────────────────────────────────────────────────
// Plan nuevo: filas, cuotas y preview
// ─────────────────────────────────────────────────────────────────────────────

/** Cuotas de N sesiones nuevas (C5 · P4): por sesión, paquete repartido o null. */
export function sessionPricesFor(pricing: PlanCreateInput["pricing"], n: number): Array<number | null> {
  if (!pricing) return Array(n).fill(null);
  if (pricing.mode === "PER_SESSION") return Array(n).fill(pricing.pricePerSessionCents);
  return distributePackage(pricing.totalPriceCents, n);
}

/**
 * Filas de un plan nuevo. Con `fromBookingId` + `countBookingAsSession1`
 * (puerta "Crealo como plan" desde un turno, C10): la sesión 1 ES ese turno
 * (su instante; el clasificador lo ve como duplicado adoptable y, si estaba
 * COMPLETED, la sesión nace realizada) y el horario genera las N−1 restantes.
 * El turno tiene que ser del tenant y del paciente (si no, rechazo: la FK
 * compuesta lo frenaría igual, pero con un 23503 en vez de un mensaje).
 */
async function newPlanRowsInTx(tx: DbClient, tenantId: string, input: PlanCreateInput, now: Date): Promise<PlanEngineRow[]> {
  let origin: Date | null = null;
  if (input.fromBookingId) {
    const b = await tx.booking.findFirst({
      where: { id: input.fromBookingId, tenantId, patientId: input.patientId },
      select: { scheduledFor: true },
    });
    if (!b) throw new PlanRejected(PLAN_ENGINE_COPY.fromBooking, "fromBookingId");
    if (input.countBookingAsSession1) origin = b.scheduledFor;
  }
  const dates = expandPlanDates({
    schedule: input.schedule,
    startDayKey: input.startDayKey,
    count: origin ? input.totalSessions - 1 : input.totalSessions,
    now,
  })
    .map((d) => d.at)
    .filter((at) => !origin || +at !== +origin);
  const all = (origin ? [origin, ...dates] : dates).sort((a, b) => +a - +b).slice(0, input.totalSessions);
  // El reparto del paquete es por fecha (lo que ve el paciente); en un plan
  // nuevo el orden de `index` ES el de fecha.
  const prices = sessionPricesFor(input.pricing, all.length);
  return all.map((at, i) => ({ index: i + 1, at, priceCents: prices[i] }));
}

function authorizationInputForNew(input: PlanCreateInput): PlanAuthorizationInput | undefined {
  const a = input.authorization;
  if (!a) return undefined;
  return {
    authorizedSessions: a.authorizedSessions ?? null,
    usedBefore: 0,
    startsOnDayKey: a.startsOnDayKey,
    expiresOnDayKey: a.expiresOnDayKey ?? null,
  };
}

function contextForNew(actor: Actor, input: PlanCreateInput, refs: PlanRefsOk): PlanEngineContext {
  return {
    tenantId: actor.tenantId,
    patientId: input.patientId,
    practitionerId: refs.practitioner.id,
    serviceId: refs.service.id,
    locationId: refs.locationId,
    durationMin: refs.durationMin,
    cap: refs.cap,
    authorization: authorizationInputForNew(input),
  };
}

function refsOfInput(input: PlanCreateInput): PlanRefsInput {
  return {
    discipline: input.discipline,
    practitionerId: input.practitionerId,
    serviceId: input.serviceId,
    locationId: input.locationId,
    durationMin: input.durationMin ?? null,
    templateId: input.templateId ?? null,
    exerciseIds: (input.exercises ?? []).map((e) => e.exerciseId),
  };
}

/** `stateToken` del borrador (C7): ignora `rows`, `stateToken` e `idempotencyKey`. */
export function draftStateToken(input: PlanCreateInput): string {
  return planStateToken(input as unknown as Record<string, unknown>);
}

/**
 * Preview de un plan NUEVO (solo lectura, §5 "Preview"): refs → fechas →
 * disponibilidad por días → clasificación + sugerencias → cuota por fila →
 * `stateToken` + otros planes activos. El caller gatea (`assertPlanManageInTx`).
 * Las resoluciones de `input.rows` entran al fold (re-preview con las
 * elegidas). Tira `PlanRejected`.
 */
export async function previewNewPlanInTx(tx: DbClient, actor: Actor, input: PlanCreateInput, opts: { now: Date }): Promise<PlanPreview> {
  const refs = await validatePlanRefsInTx(tx, actor, refsOfInput(input));
  const ctx = contextForNew(actor, input, refs);
  const cp = await classifyInTx(tx, ctx, await newPlanRowsInTx(tx, actor.tenantId, input, opts.now), resolutionMap(input.rows), opts.now);
  const others = await loadOtherActivePlansInTx(tx, { tenantId: actor.tenantId, patientId: input.patientId });
  return previewOf(cp, draftStateToken(input), others);
}

// ─────────────────────────────────────────────────────────────────────────────
// Plan existente (P2.2): preview y re-clasificación
// ─────────────────────────────────────────────────────────────────────────────

/** Qué filas mira la operación: sesiones existentes (generar) o filas nuevas/re-planificadas. */
export type PlanPreviewTarget =
  | { sessionIds: string[] }
  | { newRows: Array<{ at: string | Date; sessionId?: string; index?: number; priceCents?: number | null; title?: string | null }> };

export type ProgramPreviewParams = {
  programId: string;
  target: PlanPreviewTarget;
  mode: "generate" | "replan" | "add";
  /** Resoluciones elegidas (re-preview / commit). */
  overrides?: ReadonlyArray<PlanRowResolution>;
  now: Date;
};

const ACTIVE_STATUSES: ReadonlySet<string> = new Set(["PENDING", "CONFIRMED", "COMPLETED"]);

type ProgramEngine = { program: ProgramEngineRow; ctx: PlanEngineContext; rows: PlanEngineRow[]; refs: PlanRefsOk };

async function programEngineInTx(tx: DbClient, actor: Actor, p: Omit<ProgramPreviewParams, "now" | "overrides">): Promise<ProgramEngine> {
  const program = await loadProgramForEngineInTx(tx, actor.tenantId, p.programId);
  if (!program || program.archivedAt || !program.practitionerId || !program.serviceId) {
    throw new PlanRejected(PLAN_ENGINE_COPY.program, "programId");
  }
  const refs = await validatePlanRefsInTx(tx, actor, {
    discipline: program.discipline,
    practitionerId: program.practitionerId,
    serviceId: program.serviceId,
    locationId: program.locationId,
    durationMin: program.durationMin,
  });
  const ctx: PlanEngineContext = {
    tenantId: actor.tenantId,
    patientId: program.patientId,
    practitionerId: refs.practitioner.id,
    serviceId: refs.service.id,
    locationId: refs.locationId,
    durationMin: refs.durationMin,
    cap: refs.cap,
    authorization: authorizationInputOf(program),
  };
  const byId = new Map(program.sessions.map((s) => [s.id, s]));
  const toPricing = (b: ProgramEngineRow["sessions"][number]["bookings"][number]): PricingBooking => ({
    id: b.id,
    status: b.status,
    paymentStatus: b.paymentStatus,
    insurerPaidAt: b.insurerPaidAt,
    payment: b.payment,
    copagoCents: b.copagoCents,
    pricedByPlan: b.pricedByPlan,
    scheduledFor: b.scheduledFor,
  });
  const sessionRow = (sid: string, at: Date, index?: number, title?: string | null): PlanEngineRow => {
    const s = byId.get(sid);
    if (!s) throw new PlanRejected(PLAN_ENGINE_COPY.program, "sessionIds");
    const active = s.bookings.find((b) => ACTIVE_STATUSES.has(b.status));
    return {
      index: index ?? s.index,
      at,
      sessionId: s.id,
      currentAt: s.scheduledFor,
      excludeBookingId: active?.id ?? null,
      priceCents: s.priceCents,
      priorBookings: s.bookings.map(toPricing),
      title: title ?? s.title,
    };
  };
  let rows: PlanEngineRow[];
  if ("sessionIds" in p.target) {
    rows = p.target.sessionIds.map((sid) => sessionRow(sid, byId.get(sid)?.scheduledFor ?? new Date(NaN)));
  } else {
    let nextIndex = program.sessions.reduce((a, s) => Math.max(a, s.index), 0);
    rows = p.target.newRows.map((r) => {
      const at = new Date(r.at);
      if (r.sessionId) return sessionRow(r.sessionId, at, r.index, r.title);
      nextIndex = Math.max(nextIndex, r.index ?? 0);
      const index = r.index ?? ++nextIndex;
      return { index, at, priceCents: r.priceCents ?? null, title: r.title ?? null };
    });
  }
  if (rows.some((r) => Number.isNaN(r.at.getTime()))) throw new PlanRejected(PLAN_ENGINE_COPY.program, "target");
  return { program, ctx, rows, refs };
}

/**
 * C8 · Preview de una operación sobre un plan EXISTENTE (generar las
 * pendientes, re-planificar desde la sesión N, agregar sesiones). Solo
 * lectura; ≤ 30 statements. El caller gatea (generar = `plans.schedule`;
 * re-planificar/agregar = `plans.manage`). `PlanPreview` no lleva títulos
 * (nada que redactar); `priorPaid` y la cuota quedan para todos.
 */
export async function previewProgramRowsInTx(db: DbClient, actor: Actor, p: ProgramPreviewParams): Promise<PlanPreview> {
  const eng = await programEngineInTx(db, actor, p);
  const cp = await classifyInTx(db, eng.ctx, eng.rows, resolutionMap(p.overrides), p.now);
  const others = await loadOtherActivePlansInTx(db, {
    tenantId: actor.tenantId,
    patientId: eng.program.patientId,
    excludeProgramId: eng.program.id,
  });
  return previewOf(cp, programStateToken(eng.program, p), others);
}

/** Token de una operación sobre un plan: el plan (su `updatedAt`) + el target + el modo. */
export function programStateToken(program: ProgramEngineRow, p: Omit<ProgramPreviewParams, "now" | "overrides">): string {
  return planStateToken({
    programId: program.id,
    programUpdatedAt: program.updatedAt.toISOString(),
    mode: p.mode,
    target: p.target as unknown as Record<string, unknown>,
  });
}

export type ReclassifiedPlan = ClassifiedPlan & {
  ctx: PlanEngineContext;
  program: ProgramEngineRow;
  refs: PlanRefsOk;
};

/**
 * C8 · Re-clasificación del commit sobre un plan existente: refs → locks de
 * cupo y sedes (C2 (1)(2)) → `FOR UPDATE` de los turnos a adoptar (C2 (3)) →
 * disponibilidad → clasificación con las resoluciones → `StalePlanPreview` si
 * alguna fila quedó sin resolución válida. Precondición: el caller gateó y
 * tomó `lockPlanPatient` (C2 (0)). `rows` = el mismo target del preview.
 */
export async function reclassifyOrThrowStaleInTx(
  tx: DbClient,
  actor: Actor,
  p: {
    programId: string;
    rows: PlanPreviewTarget;
    resolutions: ReadonlyArray<PlanRowResolution>;
    now: Date;
    mode?: ProgramPreviewParams["mode"];
    /** Si viene, se compara con el del preview (el plan no cambió entremedio). */
    stateToken?: string;
  }
): Promise<ReclassifiedPlan> {
  const mode = p.mode ?? ("sessionIds" in p.rows ? "generate" : "replan");
  const eng = await programEngineInTx(tx, actor, { programId: p.programId, target: p.rows, mode });
  const resolutions = resolutionMap(p.resolutions);
  await lockPlanWindowsInTx(tx, eng.ctx, eng.rows, resolutions);
  await lockAdoptedBookingsInTx(tx, actor.tenantId, resolutions);
  const cp = await classifyInTx(tx, eng.ctx, eng.rows, resolutions, p.now);
  const token = programStateToken(eng.program, { programId: p.programId, target: p.rows, mode });
  const draftChanged = p.stateToken !== undefined && p.stateToken !== token;
  if (draftChanged || cp.classifications.some((c) => isRowStale(c, resolutions.get(c.index)))) {
    const others = await loadOtherActivePlansInTx(tx, {
      tenantId: actor.tenantId,
      patientId: eng.program.patientId,
      excludeProgramId: eng.program.id,
    });
    throw new StalePlanPreview(previewOf(cp, token, others), draftChanged ? "draft" : "rows");
  }
  return { ...cp, ctx: eng.ctx, program: eng.program, refs: eng.refs };
}

// ─────────────────────────────────────────────────────────────────────────────
// Commit de filas (C8: commitPlanRowsInTx)
// ─────────────────────────────────────────────────────────────────────────────

export type CommitPlanProgram = {
  id: string;
  patientId: string;
  /** Responsable: profesional de las sesiones y de los turnos nuevos. */
  practitionerId: string;
  serviceId: string;
  locationId: string | null;
  durationMin: number;
};

export type CommitPlanRowsResult = {
  /** Para `afterBookingsCommitted` después del commit (nunca se emite acá). */
  refs: BookingChangeRef[];
  /** index → id de la sesión (nuevas y existentes). */
  sessionIds: Map<number, string>;
  createdBookings: number;
  adoptedBookings: number;
  generationId: string;
};

const stampable = (d: PatientBookingDetail, now: Date) =>
  d.copagoCents == null &&
  d.paymentStatus === "UNPAID" &&
  d.insurerPaidAt == null &&
  (d.payment == null || d.payment.status === "UNPAID" || d.payment.status === "FAILED") &&
  (d.status === "PENDING" || d.status === "CONFIRMED") &&
  d.scheduledFor.getTime() > now.getTime();

/**
 * C2 (3) · Session `FOR UPDATE` id asc de las sesiones EXISTENTES que el
 * commit escribe (les crea/adopta un turno, las mueve o las marca realizadas),
 * en una sentencia, ANTES de cualquier escritura de Session o de Booking (los
 * adoptados ya están lockeados por la re-clasificación; el plan va al final).
 *
 * Por qué (H-a1, revisor (a) ES2b): generar/vincular eligen las sesiones "sin
 * turno" bajo `lockPlanPatient`, pero Seguimiento no toma ese lock, y el
 * INSERT del turno solo pide FOR KEY SHARE sobre la sesión (compatible con el
 * UPDATE de `completedAt`): nada serializaba "cerrar la sesión" con "darle un
 * turno" → sesión realizada con un turno activo futuro (cobro doble, C4). Con
 * el lock: si Seguimiento cerró primero, en READ COMMITTED el WHERE se
 * re-evalúa después de esperar y la sesión ya no viene → stale; si el motor
 * llegó primero, Seguimiento espera la fila y re-cuenta (su lado del fix).
 *
 * Abierta = viva y sin `completedAt`. Única excepción: adoptar un turno
 * ATENDIDO en una sesión ya realizada (vincular lo permite, `assertSessionTakes`).
 * Si falta alguna → `StalePlanPreview(null, 'write-conflict')`: rollback y el
 * caller re-previsualiza en una tx nueva.
 */
async function lockWrittenSessionsInTx(
  tx: DbClient,
  programId: string,
  plans: ReadonlyArray<{
    row: PlanEngineRow;
    creates: boolean;
    adopt: PatientBookingDetail | null;
    completedAt: Date | null;
    moved: boolean;
  }>
): Promise<void> {
  const mustBeOpen = new Map<string, boolean>();
  for (const x of plans) {
    const sid = x.row.sessionId;
    if (!sid || !(x.creates || x.adopt || x.completedAt || x.moved)) continue;
    const open = !(x.adopt?.status === "COMPLETED");
    mustBeOpen.set(sid, (mustBeOpen.get(sid) ?? false) || open);
  }
  if (mustBeOpen.size === 0) return;
  const ids = Array.from(mustBeOpen.keys()).sort();
  // `programId` ya es del tenant (el motor cargó el plan con `{id, tenantId}`);
  // Session no tiene tenantId.
  const locked = await tx.$queryRaw<{ id: string; completedAt: Date | null }[]>`
    SELECT "id", "completedAt" FROM "Session"
    WHERE "id" = ANY(${ids}::text[]) AND "programId" = ${programId} AND "archivedAt" IS NULL
    ORDER BY "id"
    FOR UPDATE`;
  const byId = new Map(locked.map((s) => [s.id, s]));
  for (const [id, open] of mustBeOpen) {
    const s = byId.get(id);
    if (!s || (open && s.completedAt)) throw new StalePlanPreview(null, "write-conflict");
  }
}

/**
 * Escrituras del commit (§5 "Commit", paso 8) sobre filas YA re-clasificadas
 * y sin stale (`reclassifyOrThrowStaleInTx` o el alta). Precondición: locks
 * C2 (0)-(2) tomados y turnos a adoptar `FOR UPDATE`.
 *
 *   - Sesiones nuevas (`sessionId` ausente): `createManyAndReturn` con
 *     `index`, fecha (la del turno si lo hay: I3), cuota y título; las
 *     existentes se mueven a la fecha del turno si cambió (I3).
 *   - Ejercicios (`exercises`, solo sesiones nuevas): `createMany`, orden 1..n.
 *   - Turnos nuevos: `createManyAndReturn`, correlación por KEY
 *     `plan:<generationId>:<index>` (C3; nunca termina en `:<ISO>:<patientId>`
 *     → `isPublicReservation` false), `seriesId = generationId`,
 *     CONFIRMED, `isOverbooked` + prefijo "[SOBRETURNO]" (§5.29), plata C5:
 *     `priorPaidStamp` (cuota, $0 con cobro previo, o null/false sin precio).
 *   - Adopciones: CAS por fila con `adoptableBookingWhere` + `updatedAt`
 *     esperado y `count === 1` (si no, `StalePlanPreview(null)`); primer
 *     estampado solo si el turno está libre de plata (C5 rama b): un copago
 *     cobrado o manual queda como está. Un COMPLETED adoptado deja la sesión
 *     realizada.
 *   - `mark-done`: la sesión nace (o queda) realizada en su fecha.
 *   - Sede: la del plan o la de la franja (la principal si no cae en
 *     ninguna), validadas activas con el lock compartido ya tomado; una de
 *     franja archivada en el medio queda null (como `bookings-core`).
 *   - Sala (SR2b, SR-D3): la de la franja (`defaultRoomFor`, sede ya
 *     resuelta), validada activa en UNA sentencia con el mismo lock; una
 *     archivada en el medio queda null. Sin chequeo de ocupación ni lock de
 *     sala, y fuera del preview y del `stateToken` (C6/C7 no cambian).
 *   - Caché `totalSessions` solo en modo `add` (el alta la escribe al crear).
 */
export async function commitPlanRowsInTx(
  tx: DbClient,
  actor: Actor,
  p: {
    program: CommitPlanProgram;
    rows: ClassifiedPlan;
    mode: "create" | "generate" | "replan" | "add";
    now: Date;
    exercises?: ReadonlyArray<{ exerciseId: string; sets: number; reps: number }>;
  }
): Promise<CommitPlanRowsResult> {
  const { program, now } = p;
  const tenantId = actor.tenantId;
  const generationId = randomUUID();
  const byIndex = new Map(p.rows.rows.map((r) => [r.index, r]));
  const input = p.rows.availability.input;
  const details = p.rows.availability.patientBookings;

  type Plan = {
    c: PlanRowClassification;
    row: PlanEngineRow;
    creates: boolean;
    at: Date;
    completedAt: Date | null;
    adopt: PatientBookingDetail | null;
    locationId: string | null;
    /** SR: sala por defecto de la franja (solo turnos nuevos); con sala, `locationId` es explícito (SR-D6). */
    roomId: string | null;
    /** Sesión existente cuya fecha cambia (I3). */
    moved: boolean;
  };
  const plans: Plan[] = p.rows.classifications.map((c) => {
    const row = byIndex.get(c.index)!;
    const kind = c.effectiveResolution;
    const creates = kind === "create" || kind === "force" || kind === "move";
    const adoptId = kind === "adopt" ? c.flags.duplicate?.bookingId : undefined;
    const adopt = adoptId ? details.get(adoptId) ?? null : null;
    if (kind === "adopt" && !adopt) throw new StalePlanPreview(null, "write-conflict");
    const at = creates ? new Date(c.at) : adopt ? adopt.scheduledFor : row.at;
    const completedAt = kind === "mark-done" ? row.at : adopt?.status === "COMPLETED" ? adopt.scheduledFor : null;
    const locationId = creates ? program.locationId ?? defaultLocationFor(input, program.practitionerId, at, program.durationMin) : null;
    // SR (SR2b, SR-D3): la sala por defecto de la franja que contiene el turno,
    // en la sede YA resuelta (la del plan o la de la franja). Sin chequeo de
    // ocupación ni lock de sala: Planes no toca C6/C7 (el preview y el
    // `stateToken` no la miran) y la barrera es la validación de Configuración.
    // `locationId` null acá = el tenant no tiene sedes → tampoco salas.
    const roomId = locationId ? defaultRoomFor(input, program.practitionerId, at, program.durationMin, locationId) : null;
    // I3: contra la fecha ACTUAL de la sesión (P2-Z), no contra el `at` de la
    // fila: en replan/adopción la fila ya trae la fecha nueva.
    const moved = !!row.sessionId && (+at !== +(row.currentAt ?? row.at) || row.index !== c.index);
    return { c, row, creates, at, completedAt, adopt, locationId, roomId, moved };
  });

  await lockWrittenSessionsInTx(tx, program.id, plans);

  // Sedes efectivamente escritas, activas (el lock compartido ya está tomado).
  const locIds = Array.from(new Set(plans.map((x) => x.locationId).filter((x): x is string => !!x)));
  if (locIds.length) {
    const active = new Set(
      (await tx.location.findMany({ where: { id: { in: locIds }, tenantId, active: true }, select: { id: true } })).map((l) => l.id)
    );
    if (program.locationId && !active.has(program.locationId)) throw new PlanRejected(PLAN_ENGINE_COPY.location, "locationId");
    for (const x of plans) {
      if (x.locationId && !active.has(x.locationId)) {
        x.locationId = null;
        x.roomId = null; // la sala es de esa sede (FK compuesta): se va con ella
      }
    }
  }

  // Salas efectivamente escritas (SR2b): UNA sentencia para todas, y solo si
  // alguna fila tiene sala (sin salas, 0 statements nuevos). Mismo lock
  // compartido de sedes que arriba: `archiveRoom` toma el exclusivo, así que no
  // se intercala entre esta lectura y el INSERT. Una sala archivada (o de otra
  // sede, p. ej. una excepción con JSON viejo) entre el preview y el commit deja
  // la fila SIN sala, no es error: el plan no la eligió, la puso la franja.
  // `tenantId` a mano (prod es BYPASSRLS y las FK saltean RLS).
  const roomIds = Array.from(new Set(plans.map((x) => x.roomId).filter((x): x is string => !!x)));
  if (roomIds.length) {
    const live = new Map(
      (
        await tx.room.findMany({
          where: { id: { in: roomIds }, tenantId, active: true, location: { active: true } },
          select: { id: true, locationId: true },
        })
      ).map((r) => [r.id, r.locationId])
    );
    for (const x of plans) if (x.roomId && live.get(x.roomId) !== x.locationId) x.roomId = null;
  }

  // ── Sesiones ──
  const sessionIds = new Map<number, string>();
  const fresh = plans.filter((x) => !x.row.sessionId);
  if (fresh.length) {
    const created = await tx.session.createManyAndReturn({
      data: fresh.map((x) => ({
        programId: program.id,
        practitionerId: program.practitionerId,
        index: x.c.index,
        scheduledFor: x.at,
        priceCents: x.row.priceCents,
        title: x.row.title ?? null,
        completedAt: x.completedAt,
      })),
      select: { id: true, index: true },
    });
    for (const s of created) sessionIds.set(s.index, s.id);
    if (p.exercises?.length) {
      await tx.sessionExercise.createMany({
        data: created.flatMap((s) =>
          p.exercises!.map((e, i) => ({ sessionId: s.id, exerciseId: e.exerciseId, order: i + 1, sets: e.sets, reps: e.reps }))
        ),
      });
    }
  }
  for (const x of plans) {
    if (!x.row.sessionId) continue;
    sessionIds.set(x.c.index, x.row.sessionId);
    if (!x.moved && !x.completedAt) continue;
    // I3: la sesión toma la fecha de su turno. `program: { tenantId }`: Session no tiene tenantId.
    await tx.session.updateMany({
      where: { id: x.row.sessionId, programId: program.id, program: { tenantId }, archivedAt: null },
      data: { scheduledFor: x.at, ...(x.completedAt ? { completedAt: x.completedAt } : {}) },
    });
  }

  // ── Turnos nuevos ──
  const refs: BookingChangeRef[] = [];
  const toCreate = plans.filter((x) => x.creates);
  if (toCreate.length) {
    const data = toCreate.map((x) => {
      const stamp = priorPaidStamp({ priceCents: x.row.priceCents }, x.row.priorBookings ?? []);
      const overbooked = x.c.overbooked;
      return {
        ...buildBookingCreateData({
          tenantId,
          practitionerId: program.practitionerId,
          serviceId: program.serviceId,
          scheduledFor: x.at,
          durationMin: program.durationMin,
          copagoCents: stamp.copagoCents,
          patientId: program.patientId,
          notes: overbooked ? "[SOBRETURNO]" : null,
          isOverbooked: overbooked,
          locationId: x.locationId,
          isTelemedicine: false,
          telemedicineUrl: null,
          title: null,
          description: null,
          idempotencyKey: `${PLAN_KEY_PREFIX}${generationId}:${x.c.index}`,
          seriesId: generationId,
        }),
        // SR2b: después del spread, así manda aunque `buildBookingCreateData`
        // sume `roomId` (SR2a). Con sala, `locationId` ya es explícito (CHECK
        // Booking_room_location_check, SR-D6).
        roomId: x.roomId,
        programId: program.id,
        sessionId: sessionIds.get(x.c.index)!,
        pricedByPlan: stamp.pricedByPlan,
      } satisfies Prisma.BookingUncheckedCreateInput;
    });
    const rows = await tx.booking.createManyAndReturn({
      data,
      select: { id: true, idempotencyKey: true, practitionerId: true, scheduledFor: true, roomId: true },
    });
    for (const b of rows)
      refs.push({ bookingId: b.id, practitionerId: b.practitionerId, scheduledFor: b.scheduledFor, roomId: b.roomId, prev: null, kind: "booking" });
  }

  // ── Adopciones (CAS) ──
  // FX1a (SV08-gap): el ref del adoptado lleva el profesional y la sala DEL
  // TURNO, no los del plan. Se adopta un turno suelto del paciente de cualquier
  // profesional: con `program.practitionerId` el aviso iba a la agenda
  // equivocada (y un plan sin responsable mandaba `null`), y sin `roomId` la
  // vista «Por sala» no se enteraba. Sale del pool que ya cargó
  // `loadPlanAvailabilityInTx` (mismo snapshot que `details`, de donde sale
  // `x.adopt`, leído con el turno ya `FOR UPDATE`): sin sentencias nuevas. El
  // CAS de abajo no cambia ni la fecha, ni el profesional, ni la sala → sin
  // `prev`.
  const poolById = new Map(input.bookings.map((b) => [b.id, b]));
  let adopted = 0;
  for (const x of plans) {
    if (!x.adopt) continue;
    const pooled = poolById.get(x.adopt.id);
    // `details` se arma filtrando este mismo pool: si no está, el estado es
    // inconsistente y se revierte como cualquier conflicto de escritura.
    if (!pooled) throw new StalePlanPreview(null, "write-conflict");
    const stamp = priorPaidStamp({ priceCents: x.row.priceCents }, x.row.priorBookings ?? []);
    const doStamp = stamp.pricedByPlan && stampable(x.adopt, now);
    const res = await tx.booking.updateMany({
      where: {
        AND: [
          adoptableBookingWhere({ tenantId, patientId: program.patientId }),
          { id: x.adopt.id, updatedAt: x.adopt.updatedAt },
          ...(doStamp
            ? [
                {
                  copagoCents: null,
                  paymentStatus: "UNPAID" as const,
                  insurerPaidAt: null,
                  status: { in: ["PENDING" as const, "CONFIRMED" as const] },
                  scheduledFor: { gt: now },
                  OR: [{ payment: { is: null } }, { payment: { is: { status: { in: ["UNPAID" as const, "FAILED" as const] } } } }],
                },
              ]
            : []),
        ],
      },
      data: {
        programId: program.id,
        sessionId: sessionIds.get(x.c.index)!,
        ...(doStamp ? { copagoCents: stamp.copagoCents, pricedByPlan: true } : {}),
      },
    });
    if (res.count !== 1) throw new StalePlanPreview(null, "write-conflict");
    adopted++;
    refs.push({
      bookingId: x.adopt.id,
      practitionerId: pooled.practitionerId,
      scheduledFor: x.adopt.scheduledFor,
      roomId: pooled.roomId,
      prev: null,
      kind: "booking",
    });
  }

  if (p.mode === "add") {
    const live = await tx.session.count({ where: { programId: program.id, archivedAt: null, program: { tenantId } } });
    await tx.treatmentProgram.updateMany({ where: { id: program.id, tenantId }, data: { totalSessions: live } });
  }

  return { refs, sessionIds, createdBookings: toCreate.length, adoptedBookings: adopted, generationId };
}

// ─────────────────────────────────────────────────────────────────────────────
// Alta completa (C8: createPlanInTx)
// ─────────────────────────────────────────────────────────────────────────────

export type CreatePlanInTxResult = {
  programId: string;
  idempotent: boolean;
  refs: BookingChangeRef[];
  /** Responsable (para el aviso post-commit) y conteos sin PHI. */
  practitionerUserId: string | null;
  sessions: number;
  bookings: number;
};

export function legacyFrequency(schedule: PlanScheduleV1): number {
  // `frequency` (por semana) es del alta legacy y sigue NOT NULL con default:
  // se escribe un valor coherente para los lectores viejos.
  return schedule.frequency === "weekly" ? Math.max(1, schedule.slots.length) : 1;
}

/**
 * Alta de un plan con sus sesiones y turnos en la tx del caller (§5
 * "Commit"). Pasos: gate `plans.manage` → `lockPlanPatient` → idempotencia
 * por `{tenantId, idempotencyKey}` → refs → `stateToken` → locks de cupo y
 * sedes → `FOR UPDATE` de adoptados → re-clasificación (stale → rollback) →
 * hook `clinicalCase` → program + autorización de la OS (E2) → filas →
 * invariantes → audit en la tx. Tira `StalePlanPreview`, `PlanRejected` o
 * `ForbiddenError`; un P2002 lo resuelve el caller en una tx nueva.
 */
export async function createPlanInTx(
  tx: DbClient,
  actor: Actor,
  input: PlanCreateInput,
  opts: {
    now: Date;
    clinicalCase?: (tx: DbClient) => Promise<string>;
    caps?: ReadonlySet<Capability>;
    origin?: string;
  }
): Promise<CreatePlanInTxResult> {
  const { now } = opts;
  const tenantId = actor.tenantId;
  const caps = opts.caps ?? capabilitiesFor(
    (await tx.membership.findUnique({
      where: { userId_tenantId: { userId: actor.userId, tenantId } },
      select: { role: true },
    }))?.role
  );
  await assertPlanManageInTx(tx, actor, caps, input.patientId);
  await lockPlanPatient(tx, { tenantId, patientId: input.patientId });

  // Idempotencia (C3): misma key = el mismo intento. Va antes de clasificar:
  // si no, el reintento vería sus propios turnos como "duplicado" y daría stale.
  const existing = await tx.treatmentProgram.findFirst({
    where: { tenantId, idempotencyKey: input.idempotencyKey },
    select: { id: true, patientId: true },
  });
  if (existing) {
    if (existing.patientId !== input.patientId) throw new PlanRejected(PLAN_ENGINE_COPY.program, "idempotencyKey");
    return { programId: existing.id, idempotent: true, refs: [], practitionerUserId: null, sessions: 0, bookings: 0 };
  }

  const refs = await validatePlanRefsInTx(tx, actor, refsOfInput(input));
  const ctx = contextForNew(actor, input, refs);
  const rows = await newPlanRowsInTx(tx, tenantId, input, now);
  const resolutions = resolutionMap(input.rows);
  await lockPlanWindowsInTx(tx, ctx, rows, resolutions);
  await lockAdoptedBookingsInTx(tx, tenantId, resolutions);
  const cp = await classifyInTx(tx, ctx, rows, resolutions, now);
  const token = draftStateToken(input);
  const draftChanged = input.stateToken !== token;
  if (draftChanged || cp.classifications.some((c) => isRowStale(c, resolutions.get(c.index)))) {
    const others = await loadOtherActivePlansInTx(tx, { tenantId, patientId: input.patientId });
    throw new StalePlanPreview(previewOf(cp, token, others), draftChanged ? "draft" : "rows");
  }

  const caseId = opts.clinicalCase ? await opts.clinicalCase(tx) : null;
  const title = input.title ?? `${disciplineLabel(input.discipline)} · ${rows.length} sesiones`;
  const program = await tx.treatmentProgram.create({
    data: {
      tenantId,
      patientId: input.patientId,
      caseId,
      title,
      notes: input.notes ?? null,
      totalSessions: rows.length,
      frequency: legacyFrequency(input.schedule),
      startDate: dayWindow(input.startDayKey).start,
      status: "ACTIVE",
      discipline: input.discipline,
      practitionerId: refs.practitioner.id,
      serviceId: refs.service.id,
      locationId: refs.locationId,
      templateId: refs.template?.id ?? null,
      durationMin: input.durationMin ?? null,
      schedule: input.schedule as unknown as Prisma.InputJsonValue,
      pricingMode: input.pricing?.mode ?? null,
      pricePerSessionCents: input.pricing?.mode === "PER_SESSION" ? input.pricing.pricePerSessionCents : null,
      totalPriceCents: input.pricing?.mode === "PACKAGE" ? input.pricing.totalPriceCents : null,
      idempotencyKey: input.idempotencyKey,
    },
    select: { id: true },
  });

  // E2: la autorización de la OS nace como la primera fila vigente del
  // historial, en la misma tx (la carga sola / renovación es S16b).
  if (input.authorization) {
    const a = input.authorization;
    await tx.programAuthorization.create({
      data: {
        tenantId,
        programId: program.id,
        code: a.code ?? null,
        authorizedSessions: a.authorizedSessions ?? null,
        startsOn: dayKeyToDbDate(a.startsOnDayKey),
        expiresOn: a.expiresOnDayKey ? dayKeyToDbDate(a.expiresOnDayKey) : null,
        createdById: actor.userId,
      },
    });
  }

  // Ejercicios: los explícitos o, si no vinieron, los asignables de la
  // plantilla con la dosis por defecto DEL EJERCICIO `?? 3×12` (C8). P3.Z:
  // antes era 3×12 fijo, distinto de lo que proponía el prefill.
  const exercises = input.exercises?.length ? input.exercises : (refs.template?.exercises ?? []);

  const written = await commitPlanRowsInTx(tx, actor, {
    program: {
      id: program.id,
      patientId: input.patientId,
      practitionerId: refs.practitioner.id,
      serviceId: refs.service.id,
      locationId: refs.locationId,
      durationMin: refs.durationMin,
    },
    rows: cp,
    mode: "create",
    now,
    exercises,
  });

  await assertProgramInvariantsInTx(tx, { tenantId, programId: program.id });
  // Audit en la tx (existe si y solo si el plan): ids y conteos, sin PHI.
  await auditInTx(tx, {
    tenantId,
    actorId: actor.userId,
    action: "program.create",
    entity: "TreatmentProgram",
    entityId: program.id,
    payload: {
      patientId: input.patientId,
      discipline: input.discipline,
      practitionerId: refs.practitioner.id,
      serviceId: refs.service.id,
      sessions: rows.length,
      bookingsCreated: written.createdBookings,
      bookingsAdopted: written.adoptedBookings,
      generationId: written.generationId,
      pricingMode: input.pricing?.mode ?? null,
      hasAuthorization: !!input.authorization,
      origin: opts.origin ?? input.origin?.kind ?? "manual",
    },
  });

  return {
    programId: program.id,
    idempotent: false,
    refs: written.refs,
    practitionerUserId: refs.practitioner.userId,
    sessions: rows.length,
    bookings: written.createdBookings + written.adoptedBookings,
  };
}

/** P2002 del alta, resuelto por los datos en una tx NUEVA (la otra quedó abortada). */
export async function findProgramByKeyInTx(
  tx: DbClient,
  tenantId: string,
  idempotencyKey: string
): Promise<{ id: string; patientId: string } | null> {
  return tx.treatmentProgram.findFirst({ where: { tenantId, idempotencyKey }, select: { id: true, patientId: true } });
}
