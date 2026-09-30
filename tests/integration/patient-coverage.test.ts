/**
 * Caracterización de paciente / cobertura / copago (A1.1, 2026-09-29).
 * Convención `it.fails("[sesión] …")`: ver bookings-write.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  setPatientCoverage,
  setPatientDefaultCopago,
  updatePatient,
  getPatientBillingPreview,
} from "@/lib/patients";
import { createBooking, listBookingsInRange } from "@/lib/bookings";
import { localToARIso } from "@/lib/datetime-ar";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addInsurer,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("pacientes · cobertura y copago (caracterización)", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    asUser(A.userId);
  });

  afterAll(async () => {
    await A?.cleanup();
    await db?.$disconnect();
  });

  it("setPatientCoverage guarda plan y N° de afiliado (camino server)", async () => {
    const p = await addPatient(db, A);
    const osde = await addInsurer(db, A, { copagoCents: 150000 });
    const r = await setPatientCoverage({ patientId: p, insurerId: osde, planName: "210", memberId: "123" });
    expect(r.ok).toBe(true);
    expect(await db.coverage.findFirst({ where: { patientId: p } })).toMatchObject({
      insurerId: osde,
      planName: "210",
      memberId: "123",
    });
  });

  it.fails("[A2-S08 · H2] re-guardar la MISMA obra social conserva el copago propio del paciente", async () => {
    const p = await addPatient(db, A);
    const osde = await addInsurer(db, A, { copagoCents: 150000 });
    await setPatientCoverage({ patientId: p, insurerId: osde, planName: "210", memberId: "123" });
    await setPatientDefaultCopago({ patientId: p, copagoCents: 200000 });
    // Editar el afiliado (o cualquier campo con OS "Otra", que re-guarda siempre)
    // hoy hace deleteMany + create y pierde Coverage.copagoCents.
    await setPatientCoverage({ patientId: p, insurerId: osde, planName: "210", memberId: "456" });
    expect((await db.coverage.findFirst({ where: { patientId: p } }))?.copagoCents).toBe(200000);
  });

  it.fails("[A2-S08] updatePatient con email vacío lo borra (hoy dice OK y el valor queda)", async () => {
    const p = await addPatient(db, A, { email: `p-${randomUUID()}@test.local` });
    const r = await updatePatient({ id: p, email: "" });
    expect(r.ok).toBe(true);
    expect((await db.patient.findUnique({ where: { id: p } }))?.email).toBeNull();
  });

  it.fails("[A2-S08] el preview de copago del modal coincide con lo que cobra el turno (OS libre sin catálogo)", async () => {
    const p = await addPatient(db, A);
    // OS "Otra" libre, sin fila de Insurer: el resolver cae al precio del servicio.
    await db.coverage.create({ data: { patientId: p, insurer: "Mutual Inexistente", insurerId: null } });
    const b = await createBooking({
      patientId: p,
      serviceId: A.serviceId,
      practitionerId: A.practitionerId,
      scheduledFor: new Date(localToARIso("2027-08-02T10:00:00")).toISOString(),
      idempotencyKey: randomUUID(),
    });
    if (!b.ok) throw new Error(b.error);
    const from = new Date("2027-08-02T03:00:00.000Z");
    const row = (await listBookingsInRange({ from, to: new Date(from.getTime() + 86_400_000) })).find(
      (r) => r.id === b.data.id
    );
    const preview = await getPatientBillingPreview(p);
    expect(row?.copagoCents).toBe(5000); // precio del servicio (resolver)
    expect(preview?.copagoCents).toBe(row?.copagoCents); // hoy el preview dice $0
  });
});
