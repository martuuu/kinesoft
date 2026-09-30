/**
 * Matriz de autorización cross-tenant (A1.1, 2026-09-29) — esqueleto
 * table-driven que A2/A3 y el Bloque B amplían fila por fila.
 *
 * Por qué importa: en prod la conexión tiene BYPASSRLS, así que el
 * `where: { tenantId }` a mano es la ÚNICA barrera, y los chequeos de FK
 * saltean RLS (un id ajeno se persiste aun con el rol app). Cada fila llama a
 * la action REAL como actor del tenant A con ids del tenant B y afirma que
 * rechaza SIN escribir. Lo que hoy falla va con `it.fails("[sesión] …")`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  createBooking,
  createBookingsBatch,
  updateBooking,
  deleteBooking,
  setBookingStatus,
} from "@/lib/bookings";
import { setPatientCoverage, updatePatient } from "@/lib/patients";
import { localToARIso } from "@/lib/datetime-ar";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

type Ctx = { A: EphemeralTenant; B: EphemeralTenant; patA: string; patB: string; bookingB: string };
type Row = {
  name: string;
  /** Sesión que la tiene que dar vuelta; ausente = hoy ya rechaza. */
  failsUntil?: string;
  act: (c: Ctx) => Promise<{ ok: boolean }>;
  /** Cuenta filas que NO deberían haber cambiado/aparecido. */
  untouched: (c: Ctx, db: PrismaClient) => Promise<unknown>;
};

const when = (d: string) => new Date(localToARIso(`${d}T10:00:00`)).toISOString();

const ROWS: Row[] = [
  {
    name: "createBooking con paciente de B",
    act: (c) =>
      createBooking({ patientId: c.patB, serviceId: c.A.serviceId, practitionerId: c.A.practitionerId, scheduledFor: when("2027-09-01"), idempotencyKey: randomUUID() }),
    untouched: (c, db) => db.booking.count({ where: { patientId: c.patB, tenantId: c.A.tenantId } }),
  },
  {
    name: "createBookingsBatch con paciente de B",
    failsUntil: "A2-S06",
    act: (c) =>
      createBookingsBatch({ patientId: c.patB, serviceId: c.A.serviceId, practitionerId: c.A.practitionerId, scheduledFor: when("2027-09-02"), count: 1, idempotencyKey: randomUUID() }),
    untouched: (c, db) => db.booking.count({ where: { patientId: c.patB, tenantId: c.A.tenantId } }),
  },
  {
    name: "createBooking con profesional de B",
    failsUntil: "A2-S06",
    act: (c) =>
      createBooking({ patientId: c.patA, serviceId: c.A.serviceId, practitionerId: c.B.practitionerId, scheduledFor: when("2027-09-03"), idempotencyKey: randomUUID() }),
    untouched: (c, db) => db.booking.count({ where: { practitionerId: c.B.practitionerId, tenantId: c.A.tenantId } }),
  },
  {
    name: "createBooking con servicio de B",
    act: (c) =>
      createBooking({ patientId: c.patA, serviceId: c.B.serviceId, practitionerId: c.A.practitionerId, scheduledFor: when("2027-09-04"), idempotencyKey: randomUUID() }),
    untouched: (c, db) => db.booking.count({ where: { serviceId: c.B.serviceId, tenantId: c.A.tenantId } }),
  },
  {
    name: "updateBooking de un turno de B",
    act: (c) => updateBooking({ id: c.bookingB, notes: "pisado por A" }),
    untouched: (c, db) => db.booking.count({ where: { id: c.bookingB, notes: "pisado por A" } }),
  },
  {
    name: "setBookingStatus de un turno de B",
    act: (c) => setBookingStatus(c.bookingB, "CANCELLED"),
    untouched: (c, db) => db.booking.count({ where: { id: c.bookingB, status: "CANCELLED" } }),
  },
  {
    name: "deleteBooking de un turno de B",
    act: (c) => deleteBooking(c.bookingB),
    untouched: async (c, db) => ((await db.booking.count({ where: { id: c.bookingB } })) === 1 ? 0 : 1),
  },
  {
    name: "updatePatient de un paciente de B",
    act: (c) => updatePatient({ id: c.patB, notes: "pisado por A" }),
    untouched: (c, db) => db.patient.count({ where: { id: c.patB, notes: "pisado por A" } }),
  },
  {
    name: "setPatientCoverage de un paciente de B",
    act: (c) => setPatientCoverage({ patientId: c.patB, insurerName: "Colada" }),
    untouched: (c, db) => db.coverage.count({ where: { patientId: c.patB, insurer: "Colada" } }),
  },
];

describe.skipIf(!RUN)("autorización cross-tenant (actor de A con ids de B)", () => {
  let db: PrismaClient;
  const ctx = {} as Ctx;

  beforeAll(async () => {
    db = ownerClient();
    ctx.A = await createEphemeralTenant(db);
    ctx.B = await createEphemeralTenant(db);
    ctx.patA = await addPatient(db, ctx.A);
    ctx.patB = await addPatient(db, ctx.B);
    const bk = await db.booking.create({
      data: {
        tenantId: ctx.B.tenantId,
        patientId: ctx.patB,
        practitionerId: ctx.B.practitionerId,
        serviceId: ctx.B.serviceId,
        scheduledFor: new Date(when("2027-09-10")),
        durationMin: 45,
        status: "CONFIRMED",
        idempotencyKey: randomUUID(),
      },
    });
    ctx.bookingB = bk.id;
    asUser(ctx.A.userId);
  });

  afterAll(async () => {
    await ctx.A?.cleanup();
    await ctx.B?.cleanup();
    await db?.$disconnect();
  });

  for (const row of ROWS) {
    const title = row.failsUntil ? `[${row.failsUntil}] ${row.name} → rechaza sin escribir` : `${row.name} → rechaza sin escribir`;
    (row.failsUntil ? it.fails : it)(title, async () => {
      const r = await row.act(ctx);
      expect(r.ok).toBe(false);
      expect(await row.untouched(ctx, db)).toBe(0);
    });
  }
});
