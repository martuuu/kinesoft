import "server-only";

/**
 * Cargas del motor de Planes (S11e, ES2b P2.1). Server-only, sin `"use server"`:
 * lo consumen el motor (`lib/plans-engine-internal.ts`) y, por handoff, las
 * sesiones de P2.2 (S16a, S16b, S25a, S17d). Todo corre con el `tx` del caller
 * y con `tenantId` a mano en cada where (prod = BYPASSRLS: el filtro explícito
 * es la única barrera; `Session` no tiene `tenantId` y va por
 * `program: { tenantId }`).
 *
 * Pieza central: `loadPlanAvailabilityInTx`. Por qué no alcanza con llamar al
 * loader por días con los días de las filas (advertencia S07L × S07p, literal
 * del plan): `loadAvailabilityInputsForDays` trae datos SOLO de los `days`
 * pedidos y el motor no mira `from/to`; `suggestRowSlot` busca hueco hasta el
 * día previo a la próxima sesión y, en la última fila, hasta el horizonte de
 * `nextFreeSlot` (14 días). Un día que no se cargó no tiene excepciones,
 * bloqueos ni turnos → "libre" de mentira. Acá se hacen las DOS cosas:
 *   1. se cargan los días candidatos de cada fila (su día, el siguiente si el
 *      turno cruza la medianoche AR, el destino de un `move` explícito y el
 *      tramo de sugerencia de cada fila, los más cercanos primero);
 *   2. `rangesFor` falla cerrado: un día que no está en lo cargado devuelve
 *      "sin franjas" → `classifyInstant` dice fuera de horario y ninguna
 *      sugerencia cae ahí. Así, si el tope `FOR_DAYS_MAX` obliga a recortar el
 *      tramo de sugerencia (un mensual de 60 filas son ~1.800 días), la
 *      sugerencia sale de lo cargado o no sale, nunca de un día a ciegas.
 *
 * `PlanAvailabilityBooking` (requisito literal de ES1): el turno necesita
 * `updatedAt`, `programId` y `sessionId`; si faltan, NO es adoptable (falla
 * cerrado). El loader de B-pre no los trae (y no es de esta sesión): se suman
 * con UNA query sobre los turnos del paciente ya cargados (los de otros
 * pacientes nunca son "duplicado" de esta fila, así que no hacen falta).
 */
import type { Prisma } from "@prisma/client";
import type { DbClient } from "@/lib/rls";
import {
  addDays,
  dayKeyOf,
  dbDateToDayKey,
  minutesOfDayAR,
  scheduledRanges,
  NEXT_FREE_HORIZON_DAYS,
  type DayKey,
  type RangesFor,
} from "@/lib/availability";
import {
  loadAvailabilityInputsForDays,
  FOR_DAYS_MAX,
  type LoadedAvailabilityInputForDays,
} from "@/lib/availability-loader";
import type { PlanAvailabilityBooking, PlanAuthorizationInput } from "@/lib/availability/plan";
import { isLinkedProgram } from "@/lib/plan-display";
import { sessionDayKey } from "@/lib/plans-read-internal";
import type { PricingBooking } from "@/lib/plan-pricing";
import { liveProgramWhere, liveSessionWhere } from "@/lib/plan-predicates";
import type { Discipline } from "@/lib/plans-constants";

// ─────────────────────────────────────────────────────────────────────────────
// Días candidatos
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Días AR que tiene que cargar el motor para clasificar `rows` y buscarles
 * hueco sin falsos "libre". Puro (exportado para el test unit del recorte).
 *
 * Tramo de sugerencia de la fila i (el mismo cálculo que `classifyPlanRows`):
 * del día siguiente al suyo hasta el anterior a la próxima sesión; si la
 * próxima cae el mismo día, solo el siguiente; la última, el horizonte de
 * `nextFreeSlot` (14 días desde el fin del día, +1 por el redondeo a 15 min).
 * Los obligatorios (día de cada fila, día siguiente si cruza la medianoche,
 * destinos explícitos) entran siempre; los de sugerencia, de a un día por
 * fila y del más cercano al más lejano, hasta `max`.
 */
export function planCandidateDays(
  rows: ReadonlyArray<{ at: Date }>,
  o: { durationMin: number; extraInstants?: ReadonlyArray<Date>; max?: number }
): DayKey[] {
  const max = o.max ?? FOR_DAYS_MAX;
  const set = new Set<DayKey>();
  const must = (when: Date) => {
    const d = dayKeyOf(when);
    set.add(d);
    // Un turno de 23:30 de 60 min toca el día siguiente (cupo y bloqueos).
    if (minutesOfDayAR(when) + o.durationMin > 24 * 60) set.add(addDays(d, 1));
  };
  const sorted = [...rows].sort((a, b) => +a.at - +b.at);
  sorted.forEach((r) => must(r.at));
  (o.extraInstants ?? []).forEach(must);

  const gaps: DayKey[][] = sorted.map((r, i) => {
    const day = dayKeyOf(r.at);
    const next = i + 1 < sorted.length ? dayKeyOf(sorted[i + 1].at) : null;
    const lastIncl = next === null ? addDays(day, NEXT_FREE_HORIZON_DAYS + 1) : next > day ? addDays(next, -1) : addDays(day, 1);
    const out: DayKey[] = [];
    for (let d = addDays(day, 1); d <= lastIncl; d = addDays(d, 1)) out.push(d);
    return out;
  });
  const longest = gaps.reduce((a, g) => Math.max(a, g.length), 0);
  for (let k = 0; k < longest && set.size < max; k++) {
    for (const g of gaps) {
      if (k < g.length) set.add(g[k]);
      if (set.size >= max) break;
    }
  }
  return Array.from(set).sort().slice(0, Math.max(max, 1));
}

// ─────────────────────────────────────────────────────────────────────────────
// Disponibilidad del plan
// ─────────────────────────────────────────────────────────────────────────────

/** Turno del paciente con lo que hace falta para adoptarlo y estamparlo (C5). */
export type PatientBookingDetail = {
  id: string;
  updatedAt: Date;
  programId: string | null;
  sessionId: string | null;
  status: PricingBooking["status"];
  paymentStatus: PricingBooking["paymentStatus"];
  copagoCents: number | null;
  insurerPaidAt: Date | null;
  payment: { status: PricingBooking["paymentStatus"] } | null;
  scheduledFor: Date;
};

export type PlanAvailability = {
  input: LoadedAvailabilityInputForDays;
  /** Franjas SIN restar bloqueos (contrato de `classify`), con falla cerrada
   *  fuera de los días cargados. */
  rangesFor: RangesFor;
  /** Turnos del pool con `updatedAt/programId/sessionId` (los del paciente). */
  bookings: PlanAvailabilityBooking[];
  /** Detalle de los turnos del paciente en el pool, por id. */
  patientBookings: Map<string, PatientBookingDetail>;
};

/**
 * Carga lo que el clasificador necesita para las filas de un plan: franjas,
 * excepciones, bloqueos y turnos del profesional (+ los del paciente, de
 * cualquier profesional) en los días candidatos. Ver la cabecera.
 *
 * En el commit se llama DESPUÉS de los locks de cupo y de sedes (C2): en READ
 * COMMITTED cada sentencia ve lo que otro commiteó mientras esperábamos.
 */
export async function loadPlanAvailabilityInTx(
  tx: DbClient,
  o: {
    tenantId: string;
    patientId: string;
    practitionerId: string;
    serviceId: string;
    locationId: string | null;
    durationMin: number;
    rows: ReadonlyArray<{ at: Date }>;
    /** Destinos explícitos (`move.at`) que tienen que estar cargados. */
    extraInstants?: ReadonlyArray<Date>;
  }
): Promise<PlanAvailability> {
  const days = planCandidateDays(o.rows, { durationMin: o.durationMin, extraInstants: o.extraInstants });
  const input = await loadAvailabilityInputsForDays(tx, {
    tenantId: o.tenantId,
    practitionerIds: [o.practitionerId],
    serviceId: o.serviceId,
    ...(o.locationId ? { locationId: o.locationId } : {}),
    patientId: o.patientId,
    days,
  });
  const loaded = new Set(input.days);
  const rangesFor: RangesFor = (pid, dayKey) => (loaded.has(dayKey) ? scheduledRanges(pid, dayKey, input) : []);

  const mine = input.bookings.filter((b) => b.patientId === o.patientId).map((b) => b.id);
  const details = mine.length
    ? await tx.booking.findMany({
        where: { tenantId: o.tenantId, patientId: o.patientId, id: { in: mine } },
        select: {
          id: true,
          updatedAt: true,
          programId: true,
          sessionId: true,
          status: true,
          paymentStatus: true,
          copagoCents: true,
          insurerPaidAt: true,
          scheduledFor: true,
          payment: { select: { status: true } },
        },
      })
    : [];
  const patientBookings = new Map<string, PatientBookingDetail>(details.map((d) => [d.id, d]));
  // Los de otros pacientes quedan con `programId/sessionId` AUSENTES (undefined):
  // `isAdoptable` los trata como "no se sabe" → no adoptables. Nunca son
  // duplicado de una fila de este paciente igual.
  const bookings: PlanAvailabilityBooking[] = input.bookings.map((b) => {
    const d = patientBookings.get(b.id);
    return d ? { ...b, updatedAt: d.updatedAt, programId: d.programId, sessionId: d.sessionId } : { ...b };
  });
  return { input, rangesFor, bookings, patientBookings };
}

// ─────────────────────────────────────────────────────────────────────────────
// Otros planes activos del paciente (aviso del preview, C13)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "Este paciente ya tiene el plan Kine (3/10) activo." Planes ACTIVE y vivos
 * del paciente, con `ordinal` = sesiones vivas realizadas y `total` = sesiones
 * vivas. Sin título (PHI): el aviso usa el chip.
 */
export async function loadOtherActivePlansInTx(
  tx: DbClient,
  o: { tenantId: string; patientId: string; excludeProgramId?: string }
): Promise<Array<{ programId: string; discipline: Discipline | null; ordinal: number; total: number }>> {
  const rows = await tx.treatmentProgram.findMany({
    where: {
      AND: [
        { tenantId: o.tenantId, patientId: o.patientId, status: "ACTIVE" },
        liveProgramWhere,
        o.excludeProgramId ? { id: { not: o.excludeProgramId } } : {},
      ],
    },
    select: {
      id: true,
      discipline: true,
      _count: {
        select: {
          sessions: { where: liveSessionWhere },
        },
      },
      sessions: { where: { ...liveSessionWhere, completedAt: { not: null } }, select: { id: true } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map((p) => ({
    programId: p.id,
    discipline: p.discipline,
    ordinal: p.sessions.length,
    total: p._count.sessions,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Contexto de un plan existente (P2.2: generar, re-planificar, agregar)
// ─────────────────────────────────────────────────────────────────────────────

const PROGRAM_ENGINE_SELECT = {
  id: true,
  tenantId: true,
  patientId: true,
  status: true,
  archivedAt: true,
  discipline: true,
  practitionerId: true,
  serviceId: true,
  locationId: true,
  templateId: true,
  durationMin: true,
  schedule: true,
  pricingMode: true,
  pricePerSessionCents: true,
  totalPriceCents: true,
  updatedAt: true,
  authorizations: {
    where: { supersededAt: null },
    select: { id: true, authorizedSessions: true, startsOn: true, expiresOn: true },
    take: 1,
  },
  sessions: {
    where: liveSessionWhere,
    orderBy: { index: "asc" },
    select: {
      id: true,
      index: true,
      scheduledFor: true,
      completedAt: true,
      priceCents: true,
      title: true,
      updatedAt: true,
      bookings: {
        select: {
          id: true,
          status: true,
          paymentStatus: true,
          insurerPaidAt: true,
          copagoCents: true,
          pricedByPlan: true,
          scheduledFor: true,
          updatedAt: true,
          payment: { select: { status: true } },
        },
        orderBy: { id: "asc" },
      },
    },
  },
} satisfies Prisma.TreatmentProgramSelect;

export type ProgramEngineRow = Prisma.TreatmentProgramGetPayload<{ select: typeof PROGRAM_ENGINE_SELECT }>;

/**
 * Plan con todo lo que necesitan el preview y el commit de una operación
 * sobre un plan existente: refs, precio, sesiones vivas con TODOS sus turnos
 * (cobro previo, turno activo) y la autorización vigente. `null` si no es del
 * tenant. Una sola query.
 */
export function loadProgramForEngineInTx(tx: DbClient, tenantId: string, programId: string): Promise<ProgramEngineRow | null> {
  return tx.treatmentProgram.findFirst({ where: { id: programId, tenantId }, select: PROGRAM_ENGINE_SELECT });
}

/**
 * Entrada pura de las flags E2 a partir de la autorización vigente: "usadas"
 * (PQ-15) = sesiones vivas realizadas con fecha AR ≥ `startsOn`, antes de esta
 * corrida. Sin autorización vigente → undefined (las flags no salen).
 */
export function authorizationInputOf(
  p: Pick<ProgramEngineRow, "authorizations" | "sessions" | "schedule">
): PlanAuthorizationInput | undefined {
  const a = p.authorizations[0];
  if (!a) return undefined;
  const startsOnDayKey = dbDateToDayKey(a.startsOn);
  // P2-Z · B-L3: mismo criterio que el detalle (`authorizationOf` en
  // plans-read-internal → `sessionDayKey`): en un plan legacy, la sesión del
  // alta vieja a 00:00Z cuenta por su fecha UTC. Con `dayKeyOf` (AR) caía el
  // día anterior y el motor contaba una "usada" menos que lo que muestra el
  // detalle → las flags E2 del preview no coincidían con el panel. Vinculado =
  // `isLinkedProgram` con lo que el loader trae: `schedule` o algún turno
  // colgado de una sesión viva (el detalle mira todos los turnos del plan; la
  // diferencia es solo un legacy cuyo único turno vinculado está en una sesión
  // archivada, que igual no cuenta como usada).
  const linked = isLinkedProgram({
    hasSchedule: p.schedule != null,
    hasLinkedBooking: p.sessions.some((s) => s.bookings.length > 0),
  });
  const usedBefore = p.sessions.filter(
    (s) => s.completedAt != null && sessionDayKey(s.scheduledFor, linked) >= startsOnDayKey
  ).length;
  return {
    authorizedSessions: a.authorizedSessions,
    usedBefore,
    startsOnDayKey,
    expiresOnDayKey: dbDateToDayKey(a.expiresOn),
  };
}
