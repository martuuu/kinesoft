/**
 * Caracterización de paciente / cobertura / copago (A1.1, 2026-09-29).
 * Convención `it.fails("[sesión] …")`: ver bookings-write.test.ts.
 * A2a-S08 (2026-09-30): los 3 `it.fails` quedaron dados vuelta + tests nuevos
 * (cambio de OS con/sin resetCopago, email normalizado, lock optimista,
 * invite con Supabase fallando, acceso básico, paginado de turnos).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  createPatient,
  setPatientCoverage,
  setPatientDefaultCopago,
  updatePatient,
  getPatientBillingPreview,
  getPatientBookingsAll,
  sendPatientPortalInvite,
} from "@/lib/patients";
import { createBooking, listBookingsInRange } from "@/lib/bookings";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { localToARIso } from "@/lib/datetime-ar";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addInsurer,
  addPractitioner,
  addService,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

// El setup de integración mockea el admin client de Supabase como `null`
// (sin red). Acá se reemplaza por uno controlable para simular que Supabase
// RESPONDE con `{ error }` (supabase-js no tira excepción): se mockea la
// dependencia externa, nunca `sendPatientPortalInvite`.
const supa = vi.hoisted(() => ({
  inviteError: null as null | { message: string },
  calls: 0,
}));
vi.mock("@/lib/supabase/admin", () => ({
  getSupabaseAdminClient: () => ({
    auth: {
      admin: {
        inviteUserByEmail: async () => {
          supa.calls += 1;
          return { data: supa.inviteError ? null : { user: null }, error: supa.inviteError };
        },
      },
    },
  }),
}));

describe.skipIf(!RUN)("pacientes · cobertura y copago (caracterización)", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  const portalUsers: string[] = [];

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    asUser(A.userId);
  });

  afterAll(async () => {
    await A?.cleanup();
    if (portalUsers.length) await db?.userProfile.deleteMany({ where: { id: { in: portalUsers } } });
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

  it("[A2-S08 · H2] re-guardar la MISMA obra social conserva el copago propio del paciente", async () => {
    const p = await addPatient(db, A);
    const osde = await addInsurer(db, A, { copagoCents: 150000 });
    await setPatientCoverage({ patientId: p, insurerId: osde, planName: "210", memberId: "123" });
    await setPatientDefaultCopago({ patientId: p, copagoCents: 200000 });
    // Editar el afiliado (o cualquier campo con OS "Otra", que re-guarda siempre)
    // hoy hace deleteMany + create y pierde Coverage.copagoCents.
    await setPatientCoverage({ patientId: p, insurerId: osde, planName: "210", memberId: "456" });
    expect((await db.coverage.findFirst({ where: { patientId: p } }))?.copagoCents).toBe(200000);
  });

  it("[A2-S08] updatePatient con email vacío lo borra (hoy dice OK y el valor queda)", async () => {
    const p = await addPatient(db, A, { email: `p-${randomUUID()}@test.local` });
    const r = await updatePatient({ id: p, email: "" });
    expect(r.ok).toBe(true);
    expect((await db.patient.findUnique({ where: { id: p } }))?.email).toBeNull();
  });

  it("[A2-S08] el preview de copago del modal coincide con lo que cobra el turno (OS libre sin catálogo)", async () => {
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

  // ───────────────────────── A2a-S08 · tests nuevos ─────────────────────────

  it("[A2-S08 · H2] misma OS: actualiza en el lugar (conserva fila, copago y vigencia)", async () => {
    const p = await addPatient(db, A);
    const osde = await addInsurer(db, A, { copagoCents: 150000 });
    await setPatientCoverage({ patientId: p, insurerId: osde, planName: "210", memberId: "1" });
    const before = await db.coverage.findFirstOrThrow({ where: { patientId: p } });
    const validUntil = new Date("2027-12-31T00:00:00.000Z");
    await db.coverage.update({ where: { id: before.id }, data: { copagoCents: 90000, validUntil } });
    const r = await setPatientCoverage({ patientId: p, insurerId: osde, planName: "310", memberId: "2" });
    expect(r.ok).toBe(true);
    const rows = await db.coverage.findMany({ where: { patientId: p } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: before.id, planName: "310", memberId: "2", copagoCents: 90000, validUntil });
  });

  it("[A2-S08 · H2] cambio de OS SIN resetCopago conserva el copago propio", async () => {
    const p = await addPatient(db, A);
    const osde = await addInsurer(db, A, { copagoCents: 150000 });
    const swiss = await addInsurer(db, A, { copagoCents: 50000 });
    await setPatientCoverage({ patientId: p, insurerId: osde });
    await setPatientDefaultCopago({ patientId: p, copagoCents: 200000 });
    const r = await setPatientCoverage({ patientId: p, insurerId: swiss, memberId: "9" });
    expect(r.ok).toBe(true);
    const rows = await db.coverage.findMany({ where: { patientId: p } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ insurerId: swiss, memberId: "9", copagoCents: 200000 });
  });

  it("[A2-S08 · H2] cambio de OS CON resetCopago borra el copago propio (cae al de la OS nueva)", async () => {
    const p = await addPatient(db, A);
    const osde = await addInsurer(db, A, { copagoCents: 150000 });
    const swiss = await addInsurer(db, A, { copagoCents: 50000 });
    await setPatientCoverage({ patientId: p, insurerId: osde });
    await setPatientDefaultCopago({ patientId: p, copagoCents: 200000 });
    const r = await setPatientCoverage({ patientId: p, insurerId: swiss, resetCopago: true });
    expect(r.ok).toBe(true);
    const row = await db.coverage.findFirstOrThrow({ where: { patientId: p } });
    expect(row).toMatchObject({ insurerId: swiss, copagoCents: null });
    const preview = await getPatientBillingPreview(p, A.serviceId);
    expect(preview).toMatchObject({ copagoCents: 50000, source: "OS" });
  });

  it("[A2-S08 · H2] resetCopago con la MISMA OS no borra nada", async () => {
    const p = await addPatient(db, A);
    const osde = await addInsurer(db, A, { copagoCents: 150000 });
    await setPatientCoverage({ patientId: p, insurerId: osde });
    await setPatientDefaultCopago({ patientId: p, copagoCents: 200000 });
    await setPatientCoverage({ patientId: p, insurerId: osde, memberId: "7", resetCopago: true });
    expect((await db.coverage.findFirstOrThrow({ where: { patientId: p } })).copagoCents).toBe(200000);
  });

  it("[A2-S08] el email se guarda normalizado (alta y edición)", async () => {
    const s = uniqueSuffix();
    const c = await createPatient({
      firstName: "Ana",
      lastName: "Norm",
      documentId: `N-${s}`,
      email: `  Ana.NORM-${s}@Mail.COM `,
    });
    if (!c.ok) throw new Error(c.error);
    expect((await db.patient.findUniqueOrThrow({ where: { id: c.data.id } })).email).toBe(`ana.norm-${s}@mail.com`);
    const u = await updatePatient({ id: c.data.id, email: ` OTRO-${s}@Mail.com` });
    expect(u.ok).toBe(true);
    expect((await db.patient.findUniqueOrThrow({ where: { id: c.data.id } })).email).toBe(`otro-${s}@mail.com`);
  });

  it("[A2-S08] updatePatient: vacía los opcionales y guarda notas de hasta 4000", async () => {
    const p = await addPatient(db, A, { phone: `11${Date.now().toString().slice(-8)}`, notes: "vieja" });
    const long = "x".repeat(3500);
    const r = await updatePatient({ id: p, phone: "", notes: long, dateOfBirth: "" });
    expect(r.ok).toBe(true);
    expect(await db.patient.findUniqueOrThrow({ where: { id: p } })).toMatchObject({
      phone: null,
      notes: long,
      dateOfBirth: null,
    });
  });

  it("[A2-S08] updatePatient con expectedUpdatedAt viejo → rechaza sin escribir", async () => {
    const p = await addPatient(db, A, { notes: "original" });
    const seen = (await db.patient.findUniqueOrThrow({ where: { id: p } })).updatedAt.toISOString();
    const first = await updatePatient({ id: p, notes: "primera", expectedUpdatedAt: seen });
    expect(first.ok).toBe(true);
    // Segunda pestaña con la versión vieja.
    const stale = await updatePatient({ id: p, notes: "pisada", expectedUpdatedAt: seen });
    expect(stale.ok).toBe(false);
    expect((await db.patient.findUniqueOrThrow({ where: { id: p } })).notes).toBe("primera");
    // Con el updatedAt devuelto por el guardado OK, sí pasa.
    if (!first.ok) throw new Error("unreachable");
    const again = await updatePatient({ id: p, notes: "tercera", expectedUpdatedAt: first.data.updatedAt });
    expect(again.ok).toBe(true);
  });

  it("[A2-S08] updatePatient audita los campos cambiados (sin valores)", async () => {
    const p = await addPatient(db, A, { notes: "a" });
    await updatePatient({ id: p, notes: "b", firstName: "Paciente" });
    const ev = await db.auditEvent.findFirst({
      where: { tenantId: A.tenantId, entityId: p, action: "patient.update" },
      orderBy: { createdAt: "desc" },
    });
    expect(ev?.payload).toEqual({ fields: ["notes"] });
  });

  it("[A2-S08] invite al portal: si Supabase responde { error } → emailSent false (primera vez y reenvío)", async () => {
    supa.inviteError = { message: "SMTP caído" };
    try {
      const p = await addPatient(db, A, { email: `inv-${uniqueSuffix()}@test.local` });
      const first = await sendPatientPortalInvite({ patientId: p });
      expect(first).toMatchObject({ ok: true, data: { emailSent: false } });

      // Rama "ya linkeado" (userId): antes ignoraba el `{ error }` y decía "enviado".
      const uid = `test-portal-${uniqueSuffix()}`;
      portalUsers.push(uid);
      await db.userProfile.create({ data: { id: uid, email: `${uid}@test.local` } });
      await db.patient.update({ where: { id: p }, data: { userId: uid } });
      const calls = supa.calls;
      // A3a: 1 envío cada 10 min por destinatario; este test mide la rama de
      // error de Supabase, no el límite (ese va en su propio test abajo).
      __rateLimitInternals.reset();
      const resend = await sendPatientPortalInvite({ patientId: p });
      expect(supa.calls).toBe(calls + 1);
      expect(resend).toMatchObject({ ok: true, data: { emailSent: false } });

      supa.inviteError = null;
      __rateLimitInternals.reset();
      expect(await sendPatientPortalInvite({ patientId: p })).toMatchObject({ ok: true, data: { emailSent: true } });
    } finally {
      supa.inviteError = null;
    }
  });

  it("[A3a-S-rl] reenviar el portal dos veces seguidas al mismo paciente → el segundo se limita sin llamar a Supabase", async () => {
    const p = await addPatient(db, A, { email: `rl-${uniqueSuffix()}@test.local` });
    __rateLimitInternals.reset();
    expect((await sendPatientPortalInvite({ patientId: p })).ok).toBe(true);
    const calls = supa.calls;
    const second = await sendPatientPortalInvite({ patientId: p });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/Probá de nuevo en \d+ s/);
    expect(supa.calls).toBe(calls);
  });

  it("[A2-S08] acceso básico = solo ver: editar, cobertura, copago e invite → rechaza sin escribir", async () => {
    const other = await addPractitioner(db, A);
    const p = await addPatient(db, A, { notes: "intacta", email: `basic-${uniqueSuffix()}@test.local` });
    asUser(other.userId);
    try {
      expect((await updatePatient({ id: p, notes: "pisada" })).ok).toBe(false);
      expect((await setPatientCoverage({ patientId: p, insurerName: "Colada" })).ok).toBe(false);
      expect((await setPatientDefaultCopago({ patientId: p, copagoCents: 1 })).ok).toBe(false);
      expect((await sendPatientPortalInvite({ patientId: p })).ok).toBe(false);
    } finally {
      asUser(A.userId);
    }
    expect((await db.patient.findUniqueOrThrow({ where: { id: p } })).notes).toBe("intacta");
    expect(await db.coverage.count({ where: { patientId: p } })).toBe(0);
  });

  it("[A2-S08] getPatientBookingsAll pagina con cursor (hasMore + Ver más) sin repetir filas", async () => {
    const p = await addPatient(db, A);
    const days = ["2027-10-01", "2027-10-02", "2027-10-03"];
    for (const d of days) {
      await db.booking.create({
        data: {
          tenantId: A.tenantId,
          patientId: p,
          practitionerId: A.practitionerId,
          serviceId: A.serviceId,
          scheduledFor: new Date(localToARIso(`${d}T10:00:00`)),
          durationMin: 45,
          status: "CONFIRMED",
          idempotencyKey: randomUUID(),
        },
      });
    }
    const first = await getPatientBookingsAll(p, 2);
    expect(first.rows).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe(first.rows[1].id);
    const second = await getPatientBookingsAll(p, 2, first.nextCursor!);
    expect(second.rows).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.rows, ...second.rows].map((r) => r.id);
    expect(new Set(ids).size).toBe(3);
    // Orden desc: la más nueva primero.
    expect(+first.rows[0].scheduledFor).toBeGreaterThan(+second.rows[0].scheduledFor);
  });

  it("[A2-S08] preview: re-consulta por servicio y etiqueta la fuente", async () => {
    const p = await addPatient(db, A);
    // OS libre sin catálogo → el monto depende del servicio.
    await db.coverage.create({ data: { patientId: p, insurer: "Mutual Libre", insurerId: null } });
    const osteo = await addService(db, A, { name: "ZZ Osteo", priceCents: 8000 });
    expect(await getPatientBillingPreview(p, osteo)).toMatchObject({
      copagoCents: 8000,
      source: "precio del servicio",
      serviceId: osteo,
    });
    await setPatientDefaultCopago({ patientId: p, copagoCents: 3000 });
    expect(await getPatientBillingPreview(p, osteo)).toMatchObject({ copagoCents: 3000, source: "copago propio" });
  });
});
