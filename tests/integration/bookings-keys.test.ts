/**
 * S07k (Planes P0.1) · keys reservadas de `createBooking` y del batch (C3).
 *
 * `plan:<generationId>:<index>` es el espacio de keys de los turnos que genera
 * un plan (lib/plans-constants.ts, `PLAN_KEY_PREFIX`), como `pub:` lo es del
 * turnero. La key es de cliente y `@unique` global: si `acceptClientKey` la
 * aceptara, el upsert de `createBooking` encontraría el turno del plan y
 * entraría a su rama `update` (resetea copago, status, notas, sede…), pisando
 * un turno que el cliente nunca creó. Mismo tratamiento que `pub:`: la key se
 * descarta y el alta cae a una al azar (fila nueva, el turno del plan intacto).
 *
 * Corre con `getActor()` real en los dos modos (kinesoft_app con RLS y owner
 * BYPASSRLS = prod). Las keys llevan un UUID: `idempotencyKey` es único
 * global y las dos corridas comparten la base.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createBooking, createBookingsBatch } from "@/lib/bookings";
import { PLAN_KEY_PREFIX } from "@/lib/plans-constants";
import { localToARIso } from "@/lib/datetime-ar";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  sweepOrphanTestTenants,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

/** "2027-03-10", "10:00" → instante ISO del reloj AR (sin depender del host). */
const ar = (day: string, hhmm: string) => new Date(localToARIso(`${day}T${hhmm}:00`)).toISOString();

describe.skipIf(!RUN)("S07k · keys reservadas (plan:)", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    A = await createEphemeralTenant(db);
    asUser(A.userId);
  });

  afterAll(async () => {
    await A?.cleanup();
    await db?.$disconnect();
  });

  const base = (patientId: string, when: string, extra: Record<string, unknown> = {}) => ({
    patientId,
    serviceId: A.serviceId,
    practitionerId: A.practitionerId,
    scheduledFor: when,
    durationMin: 45,
    ...extra,
  });

  it("[P0-S07k] createBooking con key 'plan:g:1' se rechaza y no entra a la rama update", async () => {
    // El "turno de plan" ya existe con su key (lo sembraría el motor de S11e).
    const p = await addPatient(db, A);
    const planKey = `${PLAN_KEY_PREFIX}g-${randomUUID()}:1`;
    const planned = await db.booking.create({
      data: {
        tenantId: A.tenantId,
        practitionerId: A.practitionerId,
        serviceId: A.serviceId,
        patientId: p,
        scheduledFor: new Date(ar("2027-04-05", "09:00")),
        durationMin: 45,
        status: "CONFIRMED",
        copagoCents: 1234,
        notes: "turno del plan",
        idempotencyKey: planKey,
      },
    });

    // Un cliente manda esa misma key en un alta cualquiera (otro paciente, otro horario).
    const other = await addPatient(db, A);
    const r = await createBooking({
      ...base(other, ar("2027-04-06", "11:00")),
      notes: "alta del cliente",
      idempotencyKey: planKey,
    });
    if (!r.ok) throw new Error(r.error);

    // Fila nueva, con una key que no es la del plan ni parece de plan.
    expect(r.data.id).not.toBe(planned.id);
    const created = await db.booking.findUniqueOrThrow({ where: { id: r.data.id } });
    expect(created.idempotencyKey).not.toBe(planKey);
    expect(created.idempotencyKey.startsWith(PLAN_KEY_PREFIX)).toBe(false);
    expect(created.patientId).toBe(other);

    // El turno del plan, intacto (la rama update hubiera reseteado copago y notas).
    const after = await db.booking.findUniqueOrThrow({ where: { id: planned.id } });
    expect({
      notes: after.notes,
      copagoCents: after.copagoCents,
      status: after.status,
      patientId: after.patientId,
      updatedAt: after.updatedAt.toISOString(),
    }).toEqual({
      notes: "turno del plan",
      copagoCents: 1234,
      status: "CONFIRMED",
      patientId: p,
      updatedAt: planned.updatedAt.toISOString(),
    });
    expect(await db.booking.count({ where: { tenantId: A.tenantId, idempotencyKey: planKey } })).toBe(1);
  });

  it("[P0-S07k] createBookingsBatch con key de cliente 'plan:…' no la usa como base de las keys de la serie", async () => {
    const p = await addPatient(db, A);
    const planKey = `${PLAN_KEY_PREFIX}g-${randomUUID()}`;
    const r = await createBookingsBatch({
      ...base(p, ar("2027-04-12", "10:00")),
      count: 2,
      idempotencyKey: planKey,
    });
    if (!r.ok) throw new Error(r.error);
    const rows = await db.booking.findMany({ where: { tenantId: A.tenantId, patientId: p } });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.idempotencyKey.startsWith(PLAN_KEY_PREFIX)).toBe(false);
      expect(row.idempotencyKey.startsWith(planKey)).toBe(false);
    }
  });

  it("una key de cliente común (UUID) se sigue usando tal cual", async () => {
    const p = await addPatient(db, A);
    const k = randomUUID();
    const r = await createBooking({ ...base(p, ar("2027-04-07", "10:00")), idempotencyKey: k });
    if (!r.ok) throw new Error(r.error);
    const row = await db.booking.findUniqueOrThrow({ where: { id: r.data.id } });
    expect(row.idempotencyKey).toBe(k);
  });
});
