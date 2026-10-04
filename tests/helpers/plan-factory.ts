import { randomUUID } from "node:crypto";
import type { BookingStatus, Prisma, PrismaClient } from "@prisma/client";
import { addPatient, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

/**
 * Fixtures de Planes post-M1 (`plans_booking_link`, S10b) para la integración.
 *
 * Todo por INSERT DIRECTO con el cliente que recibe (en los tests, el owner de
 * `ownerClient()`): no pasa por las actions de Planes, que todavía no existen
 * (ES2b) y que no pueden ser las que siembran lo que después se testea. Así un
 * test de schema prueba la BASE (CHECKs, FKs compuestas, únicos parciales) y no
 * la validación de una action.
 *
 * El **fixture legacy** reproduce lo que hay en prod antes de M1 (lo que el
 * backfill y el código de ES2+ tienen que tolerar):
 *   - `totalSessions` ≠ cantidad de filas de Session (el "8 sesiones" del alta
 *     vieja con 3 sesiones cargadas);
 *   - fechas a las 00:00Z (el `new Date("YYYY-MM-DD")` del código viejo: en AR
 *     cae el día ANTERIOR a las 21:00 — S25n normaliza, M1 no);
 *   - sin `practitionerId` (la columna nace en M1; el backfill la llena desde la
 *     primera sesión si ese profesional es del mismo tenant).
 *
 * NO es un `.test.ts`: la corrida unit no lo importa. La limpieza es la de
 * `deleteTenantDeep` (borra turnos → autorizaciones → planes, en ese orden).
 */

/** Día base de las fixtures: lunes 2026-10-05, 13:00Z = 10:00 AR. */
const BASE_MS = Date.parse("2026-10-05T13:00:00Z");
const DAY_MS = 24 * 60 * 60_000;

let slot = 0;
/**
 * Instante único por turno de fixture. El índice paciente-instante
 * (`Booking_tenant_patient_slot_active_key`, excluye solo CANCELLED) rechazaría
 * dos turnos del mismo paciente a la misma hora aunque sean de sesiones
 * distintas; con un instante distinto cada vez, ese índice no interfiere con lo
 * que el test quiere medir.
 */
export function nextSlot(): Date {
  slot += 1;
  return new Date(BASE_MS + slot * 60 * 60_000);
}

export interface PlanFixture {
  programId: string;
  patientId: string;
  /** En orden de `index` (1..n). */
  sessionIds: string[];
  /** Un turno por sesión vinculada, en el mismo orden (vacío si `bookings: 0`). */
  bookingIds: string[];
}

export interface CreatePlanOpts {
  patientId?: string;
  /** Cantidad de sesiones vivas (index 1..n). Default 3. */
  sessions?: number;
  /** Cuántas de esas sesiones llevan un turno vinculado (las primeras). Default 0. */
  bookings?: number;
  bookingStatus?: BookingStatus;
  /** Responsable del plan (D17). Default: el profesional de la factory. `null` = sin responsable. */
  practitionerId?: string | null;
  /** Profesional de las sesiones. Default: el profesional de la factory. */
  sessionPractitionerId?: string;
  totalSessions?: number;
  startDate?: Date;
  /** Columnas M1 extra del plan (pricing, duración, schedule, idempotencyKey…). */
  data?: Partial<Prisma.TreatmentProgramUncheckedCreateInput>;
}

/** Plan M1 "nuevo": responsable, servicio, sesiones con cuota y turnos vinculados. */
export async function createPlan(
  db: PrismaClient,
  t: EphemeralTenant,
  opts: CreatePlanOpts = {}
): Promise<PlanFixture> {
  const patientId = opts.patientId ?? (await addPatient(db, t));
  const n = opts.sessions ?? 3;
  const program = await db.treatmentProgram.create({
    data: {
      tenantId: t.tenantId,
      patientId,
      title: `Plan ${uniqueSuffix()}`,
      totalSessions: opts.totalSessions ?? n,
      frequency: 2,
      startDate: opts.startDate ?? new Date(BASE_MS),
      discipline: "KINESIOLOGY",
      practitionerId: opts.practitionerId === undefined ? t.practitionerId : opts.practitionerId,
      serviceId: t.serviceId,
      pricingMode: "PER_SESSION",
      pricePerSessionCents: 500_000,
      ...opts.data,
    },
  });
  const sessionIds: string[] = [];
  for (let i = 1; i <= n; i++) {
    sessionIds.push(
      await addPlanSession(db, program.id, {
        index: i,
        practitionerId: opts.sessionPractitionerId ?? t.practitionerId,
        priceCents: 500_000,
      })
    );
  }
  const bookingIds: string[] = [];
  for (const sessionId of sessionIds.slice(0, opts.bookings ?? 0)) {
    bookingIds.push(
      await addPlanBooking(db, t, {
        programId: program.id,
        sessionId,
        patientId,
        status: opts.bookingStatus,
      })
    );
  }
  return { programId: program.id, patientId, sessionIds, bookingIds };
}

/** Una fila de Session por insert directo. */
export async function addPlanSession(
  db: PrismaClient,
  programId: string,
  opts: {
    index: number;
    practitionerId: string;
    scheduledFor?: Date;
    priceCents?: number | null;
    archivedAt?: Date | null;
  }
): Promise<string> {
  const s = await db.session.create({
    data: {
      programId,
      practitionerId: opts.practitionerId,
      index: opts.index,
      scheduledFor: opts.scheduledFor ?? new Date(BASE_MS + (opts.index - 1) * DAY_MS),
      priceCents: opts.priceCents ?? null,
      archivedAt: opts.archivedAt ?? null,
    },
  });
  return s.id;
}

/**
 * Un turno por insert directo. Con `programId`/`sessionId` queda vinculado al
 * plan (D25); sin ellos es un turno suelto. `copagoCents` default 0 para que
 * `pricedByPlan: true` cumpla `Booking_priced_by_plan_check` si un test lo pide.
 */
export async function addPlanBooking(
  db: PrismaClient,
  t: EphemeralTenant,
  opts: {
    patientId: string | null;
    programId?: string | null;
    sessionId?: string | null;
    status?: BookingStatus;
    scheduledFor?: Date;
    copagoCents?: number | null;
    pricedByPlan?: boolean;
    tenantId?: string;
  }
): Promise<string> {
  const b = await db.booking.create({
    data: {
      tenantId: opts.tenantId ?? t.tenantId,
      patientId: opts.patientId,
      practitionerId: t.practitionerId,
      serviceId: t.serviceId,
      scheduledFor: opts.scheduledFor ?? nextSlot(),
      durationMin: 45,
      idempotencyKey: randomUUID(),
      status: opts.status ?? "CONFIRMED",
      copagoCents: opts.copagoCents === undefined ? 0 : opts.copagoCents,
      pricedByPlan: opts.pricedByPlan ?? false,
      programId: opts.programId ?? null,
      sessionId: opts.sessionId ?? null,
    },
  });
  return b.id;
}

export interface LegacyPlanFixture {
  programId: string;
  patientId: string;
  sessionIds: string[];
}

/**
 * Plan LEGACY (pre-M1): `totalSessions` ≠ filas, fechas a las 00:00Z, sin
 * `practitionerId` ni ninguna otra columna de M1. `sessionPractitionerIds[i]` es
 * el profesional de la sesión `index = i + 1` (permite que la primera sea de
 * otro tenant, el caso que el backfill NO tiene que tomar).
 */
export async function createLegacyPlan(
  db: PrismaClient,
  t: EphemeralTenant,
  opts: {
    patientId?: string;
    totalSessions?: number;
    sessionPractitionerIds?: string[];
    /** Orden de INSERT de las sesiones (índices de `sessionPractitionerIds`); default el natural. */
    insertOrder?: number[];
  } = {}
): Promise<LegacyPlanFixture> {
  const patientId = opts.patientId ?? (await addPatient(db, t));
  const pros = opts.sessionPractitionerIds ?? [t.practitionerId, t.practitionerId, t.practitionerId];
  const program = await db.treatmentProgram.create({
    data: {
      tenantId: t.tenantId,
      patientId,
      title: `Legacy ${uniqueSuffix()}`,
      totalSessions: opts.totalSessions ?? 8,
      frequency: 2,
      startDate: new Date("2026-09-01T00:00:00Z"),
      practitionerId: null,
    },
  });
  const order = opts.insertOrder ?? pros.map((_, i) => i);
  const byIndex = new Map<number, string>();
  for (const i of order) {
    byIndex.set(
      i,
      await addPlanSession(db, program.id, {
        index: i + 1,
        practitionerId: pros[i],
        scheduledFor: new Date(Date.UTC(2026, 8, 1 + i * 3)), // 00:00Z
      })
    );
  }
  return {
    programId: program.id,
    patientId,
    sessionIds: pros.map((_, i) => byIndex.get(i)!),
  };
}
