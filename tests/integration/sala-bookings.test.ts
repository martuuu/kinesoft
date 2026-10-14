/**
 * FX2a · PD-13 en el re-pedido de /sala: `listSalaBookings` contra Postgres
 * real, con `getActor()` real (solo se mockea la sesión de Supabase,
 * tests/helpers/integration-setup.ts), en los dos modos: `kinesoft_app` (RLS)
 * y owner BYPASSRLS (= prod hoy).
 *
 * Lo observable: la respuesta (lo que viaja al browser) NO TIENE las claves
 * `title`/`description`/`notes`/`patientCondition` ni el título del plan, para
 * ningún rol que entra a la sala (OWNER y PRACTITIONER, que sí tienen
 * `clinical.read`, y la Secretaria); BILLING no entra.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { listSalaBookings } from "@/lib/sala-bookings";
import { dayWindow } from "@/lib/availability/day";
import { toARDateKey } from "@/lib/datetime-ar";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  sweepOrphanTestTenants,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";
const CLINICAL_KEYS = ["title", "description", "notes", "patientCondition"];
const SECRETS = /TITULO-SECRETO|DESCRIPCION-SECRETA|NOTA-SECRETA/;

describe.skipIf(!RUN)("FX2a · listSalaBookings (PD-13 proyectado en el server)", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let assistant: { userId: string; practitionerId: string };
  let billing: { userId: string; practitionerId: string };
  let kine: { userId: string; practitionerId: string };
  let window: { start: Date; end: Date };
  const ids: Record<string, string> = {};

  async function seed(t: EphemeralTenant, practitionerId: string): Promise<string> {
    const b = await db.booking.create({
      data: {
        tenantId: t.tenantId,
        practitionerId,
        serviceId: t.serviceId,
        patientId: await addPatient(db, t),
        scheduledFor: new Date(),
        durationMin: 45,
        status: "CONFIRMED",
        idempotencyKey: randomUUID(),
        title: "TITULO-SECRETO",
        description: "DESCRIPCION-SECRETA",
        notes: "NOTA-SECRETA",
        arrivedAt: new Date(),
      },
    });
    return b.id;
  }

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
    assistant = await addPractitioner(db, A, "ASSISTANT");
    billing = await addPractitioner(db, A, "BILLING");
    kine = await addPractitioner(db, A, "PRACTITIONER");
    ids.owner = await seed(A, A.practitionerId);
    ids.kine = await seed(A, kine.practitionerId);
    ids.otherTenant = await seed(B, B.practitionerId);
    window = dayWindow(toARDateKey(new Date()));
  });

  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await db?.$disconnect();
  });

  function expectNoClinical(rows: Awaited<ReturnType<typeof listSalaBookings>>) {
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      for (const k of CLINICAL_KEYS) expect(Object.keys(r)).not.toContain(k);
      if (r.plan) expect(Object.keys(r.plan)).not.toContain("title");
    }
    // Lo que de verdad viaja (serialización del cable).
    expect(JSON.stringify(rows)).not.toMatch(SECRETS);
  }

  it("OWNER: ve todos los turnos de hoy de su consultorio, sin claves clínicas", async () => {
    asUser(A.userId);
    const rows = await listSalaBookings({ from: window.start, to: window.end });
    expectNoClinical(rows);
    const got = rows.map((r) => r.id);
    expect(got).toEqual(expect.arrayContaining([ids.owner, ids.kine]));
    expect(got).not.toContain(ids.otherTenant);
    // Lo operativo sí está.
    const mine = rows.find((r) => r.id === ids.owner)!;
    expect(mine.arrivedAt).toBeTruthy();
    expect(mine.patientName).toBeTruthy();
  });

  it("PRACTITIONER (con clinical.read): sus turnos, sin claves clínicas", async () => {
    asUser(kine.userId);
    const rows = await listSalaBookings({ from: window.start, to: window.end });
    expectNoClinical(rows);
    expect(rows.map((r) => r.id)).toContain(ids.kine);
    expect(rows.map((r) => r.id)).not.toContain(ids.otherTenant);
  });

  it("ASSISTANT (Secretaria): todos, sin claves clínicas", async () => {
    asUser(assistant.userId);
    const rows = await listSalaBookings({ from: window.start, to: window.end });
    expectNoClinical(rows);
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining([ids.owner, ids.kine]));
  });

  it("BILLING: no entra a la sala (error)", async () => {
    asUser(billing.userId);
    await expect(listSalaBookings({ from: window.start, to: window.end })).rejects.toThrow(/sala de espera/i);
  });

  it("no es un export de la agenda: más de un día → error", async () => {
    asUser(A.userId);
    const to = new Date(window.start.getTime() + 7 * 24 * 60 * 60 * 1000);
    await expect(listSalaBookings({ from: window.start, to })).rejects.toThrow();
  });
});
