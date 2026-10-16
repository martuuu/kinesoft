/**
 * ES4 S24r · pedidos de cambio del portal, lado consultorio (`lib/patient-portal-requests.ts`, brief ES4 §3.6).
 *
 * Símbolos reales contra Postgres en los dos roles (`npm run test:integration -- patient-portal-requests` =
 * kinesoft_app con RLS; `:owner` = BYPASSRLS como prod). Se mockea solo lo externo (sesión de Supabase, cookies,
 * `next/cache`: integration-setup) y el step-up de 2FA para abrir la sesión de soporte.
 *
 * El pedido lo siembra el owner con SQL (la action del portal que lo escribe es de S24d, en paralelo): la fila tiene la
 * misma forma que deja S24d (`changes` validado por `PortalPendingChanges`, `requestedByUserId` = la cuenta vinculada).
 *
 * Cada rechazo afirma el efecto observable: el pedido sigue PENDING con el mismo `updatedAt`, la ficha, el contacto de
 * emergencia y la cobertura quedan como estaban, y no hay AuditEvent del pedido.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  decidePatientPortalRequest,
  listPatientPortalRequests,
  previewPortalRequestImpact,
} from "@/lib/patient-portal-requests";
import type { PortalPendingChangesT } from "@/lib/portal-pending-changes";
import { portalRequestUniqueError } from "@/lib/patient-portal-requests-internal";
import { startSupport } from "@/lib/platform-support";
import { SUPPORT_COOKIE } from "@/lib/support-session-internal";
import { __setEmailTransportForTests } from "@/lib/email";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { getActor } from "@/lib/session";
import { asUser } from "@/tests/helpers/actor";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  addInsurer,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

vi.mock("@/lib/two-factor-step-up", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/two-factor-step-up")>()),
  requireStepUp: async () => {},
}));

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("S24r · pedidos de cambio del portal (lado consultorio)", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  /** Consultorio «casa» del superadmin de soporte. */
  let S: EphemeralTenant;
  let SEC: { userId: string };
  let BASIC: { userId: string };
  const portalUsers: string[] = [];

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
    S = await createEphemeralTenant(db);
    await db.userProfile.update({ where: { id: S.userId }, data: { isPlatformAdmin: true } });
    SEC = await addPractitioner(db, A, "ASSISTANT");
    BASIC = await addPractitioner(db, A, "PRACTITIONER");
  });

  afterEach(() => {
    cookies().delete(SUPPORT_COOKIE);
    asUser(A.userId);
  });

  afterAll(async () => {
    __setEmailTransportForTests(null);
    for (const t of [A, B, S]) await t?.cleanup();
    if (portalUsers.length) await db?.userProfile.deleteMany({ where: { id: { in: portalUsers } } });
    await db?.$disconnect();
  });

  /** Cuenta del portal (UserProfile) vinculada a la ficha, como la deja `/portal/vincular`. */
  async function linkedPatient(t: EphemeralTenant, data: { phone?: string; email?: string } = {}) {
    const userId = `portal-${uniqueSuffix()}`;
    await db.userProfile.create({ data: { id: userId, email: `${userId}@test.local`, fullName: "Ana Paciente" } });
    portalUsers.push(userId);
    const patientId = await addPatient(db, t, data);
    await db.patient.update({ where: { id: patientId }, data: { userId } });
    return { patientId, userId };
  }

  async function seedRequest(
    t: EphemeralTenant,
    patientId: string,
    changes: PortalPendingChangesT,
    requestedByUserId: string | null
  ) {
    return db.patientChangeRequest.create({
      data: { tenantId: t.tenantId, patientId, changes: changes as object, requestedByUserId },
    });
  }

  async function snapshot(patientId: string, requestId: string) {
    const [patient, emergency, coverage, request, audits] = await Promise.all([
      db.patient.findUniqueOrThrow({ where: { id: patientId }, select: { phone: true, email: true, updatedAt: true } }),
      db.emergencyContact.findMany({ where: { patientId }, select: { name: true, relation: true, phone: true } }),
      db.coverage.findMany({ where: { patientId }, select: { insurer: true, planName: true, memberId: true, copagoCents: true } }),
      db.patientChangeRequest.findUniqueOrThrow({ where: { id: requestId } }),
      db.auditEvent.findMany({ where: { entityId: patientId, action: { startsWith: "patient.portalRequest" } } }),
    ]);
    return { patient, emergency, coverage, request, audits };
  }

  async function expectUntouched(patientId: string, requestId: string, before: Awaited<ReturnType<typeof snapshot>>) {
    const after = await snapshot(patientId, requestId);
    expect(after.request.status).toBe("PENDING");
    expect(+after.request.updatedAt).toBe(+before.request.updatedAt);
    expect(after.request.decidedById).toBeNull();
    expect(after.patient).toEqual(before.patient);
    expect(after.emergency).toEqual(before.emergency);
    expect(after.coverage).toEqual(before.coverage);
    expect(after.audits).toHaveLength(0);
  }

  const decide = (r: { id: string; updatedAt: Date }, decision: "APPROVE" | "REJECT" = "APPROVE") =>
    decidePatientPortalRequest({ id: r.id, expectedUpdatedAt: r.updatedAt.toISOString(), decision });

  // ─────────────────────────── aprobar: el camino feliz ───────────────────────────

  it("el titular aprueba: teléfono, email, contacto único y cobertura en una tx; APPROVED con quién y cuándo", async () => {
    asUser(A.userId);
    const { patientId, userId } = await linkedPatient(A, { phone: "1111111111" });
    await db.emergencyContact.createMany({
      data: [
        { patientId, name: "Viejo 1", phone: "222222" },
        { patientId, name: "Viejo 2", phone: "333333" },
      ],
    });
    const req = await seedRequest(
      A,
      patientId,
      {
        phone: "1155554444",
        email: "Ana.Nueva@Test.Local",
        emergencyContact: { name: "Carla", relation: "Hermana", phone: "1166667777" },
        coverage: { insurerName: "Mutual Nueva", planName: "300", memberId: "A-1" },
      },
      userId
    );

    const r = await decide(req);
    expect(r).toEqual({ ok: true, data: { unpaidCopagoBookings: 0 } });

    const after = await snapshot(patientId, req.id);
    expect(after.patient.phone).toBe("1155554444");
    expect(after.patient.email).toBe("ana.nueva@test.local"); // normalizado como updatePatient
    expect(after.emergency).toEqual([{ name: "Carla", relation: "Hermana", phone: "1166667777" }]);
    expect(after.coverage).toEqual([{ insurer: "Mutual Nueva", planName: "300", memberId: "A-1", copagoCents: null }]);
    expect(after.request.status).toBe("APPROVED");
    expect(after.request.decidedById).toBe(A.userId);
    expect(after.request.decidedAt).not.toBeNull();
  });

  it("la Secretaria (nivel admin, PD-13) puede listar y aprobar contacto y cobertura", async () => {
    asUser(A.userId);
    const { patientId, userId } = await linkedPatient(A);
    const req = await seedRequest(A, patientId, { phone: "1177778888" }, userId);
    asUser(SEC.userId);
    const list = await listPatientPortalRequests({ patientId });
    expect(list.ok && list.data.map((x) => x.id)).toEqual([req.id]);
    if (list.ok) expect(list.data[0]).toMatchObject({ fields: ["phone"], emailApplies: true, osChanges: false });
    const r = await decide(req);
    expect(r.ok).toBe(true);
    expect((await db.patient.findUniqueOrThrow({ where: { id: patientId } })).phone).toBe("1177778888");
  });

  it("rechazar → REJECTED con quién y cuándo, sin tocar la ficha; audit con nombres de campo", async () => {
    asUser(A.userId);
    const { patientId, userId } = await linkedPatient(A, { phone: "1199990000" });
    const req = await seedRequest(A, patientId, { phone: "1100001111" }, userId);
    const r = await decide(req, "REJECT");
    expect(r).toEqual({ ok: true, data: { unpaidCopagoBookings: 0 } });
    const after = await snapshot(patientId, req.id);
    expect(after.request.status).toBe("REJECTED");
    expect(after.request.decidedById).toBe(A.userId);
    expect(after.patient.phone).toBe("1199990000");
    expect(after.audits.map((a) => a.action)).toEqual(["patient.portalRequest.reject"]);
  });

  // ─────────────────────────── contratos de la sesión (§4 S24r) ───────────────────────────

  it("[P4-S24r] CAS stale → rechazo sin aplicar nada", async () => {
    asUser(A.userId);
    const { patientId, userId } = await linkedPatient(A, { phone: "1122223333" });
    const req = await seedRequest(A, patientId, { phone: "1144445555" }, userId);
    const before = await snapshot(patientId, req.id);
    const r = await decidePatientPortalRequest({
      id: req.id,
      expectedUpdatedAt: new Date(+req.updatedAt - 60_000).toISOString(),
      decision: "APPROVE",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cambió/);
    await expectUntouched(patientId, req.id, before);
    // Ya decidido: el segundo intento con el updatedAt viejo también es stale (no se aprueba dos veces).
    expect((await decide(req, "REJECT")).ok).toBe(true);
    expect((await decide(req)).ok).toBe(false);
    expect((await db.patientChangeRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("REJECTED");
  });

  it("[P4-S24r] acceso básico → Forbidden (listar y decidir), sin escribir", async () => {
    asUser(A.userId);
    const { patientId, userId } = await linkedPatient(A, { phone: "1133334444" });
    const req = await seedRequest(A, patientId, { phone: "1155556666" }, userId);
    const before = await snapshot(patientId, req.id);
    asUser(BASIC.userId);
    const list = await listPatientPortalRequests({ patientId });
    expect(list.ok).toBe(false);
    const r = await decide(req);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/acceso/);
    expect((await previewPortalRequestImpact({ id: req.id })).ok).toBe(false);
    await expectUntouched(patientId, req.id, before);
  });

  it("[P4-S24r] cross-tenant → rechazo sin escribir (ni listar)", async () => {
    asUser(A.userId);
    const { patientId, userId } = await linkedPatient(A, { phone: "1144443333" });
    const req = await seedRequest(A, patientId, { phone: "1166665555" }, userId);
    const before = await snapshot(patientId, req.id);
    asUser(B.userId);
    const list = await listPatientPortalRequests({ patientId });
    expect(list.ok).toBe(false);
    const r = await decide(req);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no encontr/i);
    await expectUntouched(patientId, req.id, before);
  });

  it("[P4-S24r] P2002 de teléfono → «ya está en otra ficha», nada aplicado (ni el contacto ni el estado)", async () => {
    asUser(A.userId);
    const taken = `11${Date.now().toString().slice(-8)}`;
    await addPatient(db, A, { phone: taken });
    const { patientId, userId } = await linkedPatient(A, { phone: "1100002222" });
    await db.emergencyContact.create({ data: { patientId, name: "Original", phone: "444444" } });
    const req = await seedRequest(
      A,
      patientId,
      { phone: taken, emergencyContact: { name: "Nuevo", phone: "555555" } },
      userId
    );
    const before = await snapshot(patientId, req.id);
    const r = await decide(req);
    expect(r).toEqual({ ok: false, error: "Ese teléfono ya está en otra ficha del consultorio." });
    await expectUntouched(patientId, req.id, before);
  });

  it("[P4-S24r] P2002 de email → «ya está en otra ficha», nada aplicado", async () => {
    asUser(A.userId);
    const taken = `ocupado-${randomUUID()}@test.local`;
    await addPatient(db, A, { email: taken });
    const { patientId, userId } = await linkedPatient(A);
    const req = await seedRequest(A, patientId, { email: taken.toUpperCase(), coverage: { insurerName: "OS Choque" } }, userId);
    const before = await snapshot(patientId, req.id);
    const r = await decide(req);
    expect(r).toEqual({ ok: false, error: "Ese email ya está en otra ficha del consultorio." });
    await expectUntouched(patientId, req.id, before);
  });

  it("carrera después del pre-check: el P2002 de updateMany (target null) se traduce, no es un 500", () => {
    const err = (target: unknown) =>
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
        meta: { modelName: "Patient", target },
      });
    expect(portalRequestUniqueError(err(null))).toBe("Ese email o teléfono ya está en otra ficha del consultorio.");
    expect(portalRequestUniqueError(err(["tenantId", "phone"]))).toBe("Ese teléfono ya está en otra ficha del consultorio.");
    expect(portalRequestUniqueError(err("Patient_tenantId_email_key"))).toBe("Ese email ya está en otra ficha del consultorio.");
    expect(portalRequestUniqueError(new Error("otro"))).toBeNull();
  });

  it("[P4-S24r] audit sin valores: nombres de campo, ningún dato personal del pedido", async () => {
    asUser(A.userId);
    const { patientId, userId } = await linkedPatient(A);
    const changes = {
      phone: "1187654321",
      email: `secreto-${randomUUID()}@test.local`,
      emergencyContact: { name: "Nombre Secreto", relation: "Madre", phone: "1123456789" },
      coverage: { insurerName: "Obra Secreta", planName: "Plan Oculto", memberId: "AFIL-999" },
    };
    const req = await seedRequest(A, patientId, changes, userId);
    expect((await decide(req)).ok).toBe(true);
    const audits = await db.auditEvent.findMany({ where: { tenantId: A.tenantId, entityId: patientId } });
    expect(audits.map((a) => a.action)).toEqual(["patient.portalRequest.approve"]);
    expect(audits[0]).toMatchObject({ actorId: A.userId, entity: "Patient" });
    expect(audits[0].payload).toMatchObject({
      requestId: req.id,
      fields: ["phone", "email", "emergencyContact", "coverage"],
      applied: ["phone", "email", "emergencyContact", "coverage"],
    });
    const text = JSON.stringify(audits[0].payload);
    for (const v of ["1187654321", changes.email, "Nombre Secreto", "Madre", "1123456789", "Obra Secreta", "Plan Oculto", "AFIL-999"]) {
      expect(text).not.toContain(v);
    }
  });

  it("[P4-S24r] email no se aplica sin cuenta vinculada (el resto sí); el listado lo avisa", async () => {
    asUser(A.userId);
    const original = `original-${randomUUID()}@test.local`;
    const { patientId, userId } = await linkedPatient(A, { email: original, phone: "1101010101" });
    const req = await seedRequest(A, patientId, { email: `otro-${randomUUID()}@test.local`, phone: "1102020202" }, userId);
    // La cuenta se desvinculó después del pedido (p. ej. el consultorio corrigió un vínculo equivocado).
    await db.patient.update({ where: { id: patientId }, data: { userId: null } });
    const list = await listPatientPortalRequests({ patientId });
    expect(list.ok && list.data[0].emailApplies).toBe(false);
    const fresh = await db.patientChangeRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect((await decide(fresh)).ok).toBe(true);
    const p = await db.patient.findUniqueOrThrow({ where: { id: patientId } });
    expect(p.email).toBe(original);
    expect(p.phone).toBe("1102020202");
    const [audit] = await db.auditEvent.findMany({ where: { entityId: patientId, action: "patient.portalRequest.approve" } });
    expect(audit.payload).toMatchObject({ applied: ["phone"], skipped: ["email"] });
  });

  it("[P4-S24r] email de otra cuenta: vinculada a una cuenta distinta de la que pidió → no se aplica", async () => {
    asUser(A.userId);
    const original = `orig-${randomUUID()}@test.local`;
    const { patientId } = await linkedPatient(A, { email: original });
    const req = await seedRequest(A, patientId, { email: `nuevo-${randomUUID()}@test.local` }, `otra-cuenta-${uniqueSuffix()}`);
    expect((await decide(req)).ok).toBe(true);
    expect((await db.patient.findUniqueOrThrow({ where: { id: patientId } })).email).toBe(original);
  });

  it("[P4-S24r] SUPPORT → solo lectura: lista, pero decidir devuelve error y no escribe", async () => {
    asUser(A.userId);
    const { patientId, userId } = await linkedPatient(A, { phone: "1103030303" });
    const req = await seedRequest(A, patientId, { phone: "1104040404" }, userId);
    const before = await snapshot(patientId, req.id);
    __rateLimitInternals.reset();
    __setEmailTransportForTests(async () => ({ ok: true, transport: "resend", providerId: "fake" }));
    asUser(S.userId);
    const s = await startSupport(A.tenantId, "Ayuda con pedidos del portal");
    if (!s.ok) throw new Error(s.error);
    expect((await getActor()).support?.sessionId).toBe(s.data.sessionId);
    const list = await listPatientPortalRequests({ patientId });
    expect(list.ok && list.data.map((x) => x.id)).toEqual([req.id]);
    const r = await decide(req);
    expect(r.ok).toBe(false);
    await expectUntouched(patientId, req.id, before);
    await db.supportSession.update({ where: { id: s.data.sessionId }, data: { endedAt: new Date(), endedReason: "test" } });
  });

  // ─────────────────────────── cambio de OS: impacto en el copago ───────────────────────────

  it("cambio de OS: preview y decisión cuentan los turnos impagos que cobran el copago de la cobertura; copago propio se borra", async () => {
    asUser(A.userId);
    const { patientId, userId } = await linkedPatient(A);
    const osde = await addInsurer(db, A, { name: `OSDE ${uniqueSuffix()}`, copagoCents: 150000 });
    await db.coverage.create({
      data: { patientId, insurer: "OSDE", insurerId: osde, planName: "210", copagoCents: 90000 },
    });
    const base = Date.parse("2027-09-06T13:00:00.000Z");
    const mk = (i: number, extra: Record<string, unknown> = {}) =>
      db.booking.create({
        data: {
          tenantId: A.tenantId,
          patientId,
          practitionerId: A.practitionerId,
          serviceId: A.serviceId,
          scheduledFor: new Date(base + i * 86_400_000),
          durationMin: 45,
          idempotencyKey: randomUUID(),
          ...extra,
        },
      });
    await mk(0); // PENDING impago, copago de la cobertura → cuenta
    await mk(1, { status: "COMPLETED" }); // atendido e impago → cuenta
    await mk(2, { copagoCents: 70000 }); // override del turno: no cambia
    await mk(3, { paymentStatus: "PAID" }); // ya cobrado
    await mk(4, { status: "CANCELLED" }); // cancelado
    await mk(5, { insurerPaidAt: new Date() }); // la OS ya pagó

    const req = await seedRequest(A, patientId, { coverage: { insurerName: "Swiss Medical", memberId: "SM-1" } }, userId);
    const preview = await previewPortalRequestImpact({ id: req.id });
    expect(preview).toEqual({ ok: true, data: { osChanges: true, unpaidCopagoBookings: 2, ownCopagoCents: 90000 } });

    const r = await decide(req);
    expect(r).toEqual({ ok: true, data: { unpaidCopagoBookings: 2 } });
    const cov = await db.coverage.findMany({ where: { patientId } });
    expect(cov).toHaveLength(1);
    expect(cov[0]).toMatchObject({ insurer: "Swiss Medical", insurerId: null, memberId: "SM-1", planName: null, copagoCents: null });
    const [audit] = await db.auditEvent.findMany({ where: { entityId: patientId, action: "patient.portalRequest.approve" } });
    expect(audit.payload).toMatchObject({ osChanged: true, copagoReset: true, unpaidCopagoBookings: 2 });
  });

  it("misma OS (otra capitalización): no cambia el copago; actualiza plan y afiliado y conserva el copago propio", async () => {
    asUser(A.userId);
    const { patientId, userId } = await linkedPatient(A);
    const name = `Galeno ${uniqueSuffix()}`;
    const galeno = await addInsurer(db, A, { name, copagoCents: 100000 });
    await db.coverage.create({ data: { patientId, insurer: name, insurerId: galeno, planName: "A", copagoCents: 50000 } });
    const req = await seedRequest(
      A,
      patientId,
      { coverage: { insurerName: name.toUpperCase(), planName: "B", memberId: "G-2" } },
      userId
    );
    const preview = await previewPortalRequestImpact({ id: req.id });
    expect(preview).toEqual({ ok: true, data: { osChanges: false, unpaidCopagoBookings: 0, ownCopagoCents: null } });
    expect((await decide(req)).ok).toBe(true);
    const [cov] = await db.coverage.findMany({ where: { patientId } });
    expect(cov).toMatchObject({ insurerId: galeno, insurer: name, planName: "B", memberId: "G-2", copagoCents: 50000 });
  });

  it("[ES4-Z M2] cambio de OS sin turnos impagos pero con copago propio → el preview lo informa (la UI confirma)", async () => {
    asUser(A.userId);
    const { patientId, userId } = await linkedPatient(A);
    const osde = await addInsurer(db, A, { name: `OSDE ${uniqueSuffix()}`, copagoCents: 150000 });
    await db.coverage.create({ data: { patientId, insurer: "OSDE", insurerId: osde, copagoCents: 45000 } });
    const req = await seedRequest(A, patientId, { coverage: { insurerName: `Otra OS ${uniqueSuffix()}` } }, userId);
    expect(await previewPortalRequestImpact({ id: req.id })).toEqual({
      ok: true,
      data: { osChanges: true, unpaidCopagoBookings: 0, ownCopagoCents: 45000 },
    });
    // Sin copago propio cargado: nada que confirmar por ese lado.
    const other = await linkedPatient(A);
    await db.coverage.create({ data: { patientId: other.patientId, insurer: "OSDE", insurerId: osde } });
    const req2 = await seedRequest(A, other.patientId, { coverage: { insurerName: `Otra OS ${uniqueSuffix()}` } }, other.userId);
    expect(await previewPortalRequestImpact({ id: req2.id })).toEqual({
      ok: true,
      data: { osChanges: true, unpaidCopagoBookings: 0, ownCopagoCents: null },
    });
  });

  it("[ES4-Z B1] email que choca solo en mayúsculas con otra ficha → «ya está en otra ficha», nada aplicado", async () => {
    asUser(A.userId);
    const local = `ocupado-${randomUUID()}`;
    await addPatient(db, A, { email: `${local.toUpperCase()}@Test.Local` });
    const { patientId, userId } = await linkedPatient(A);
    const req = await seedRequest(A, patientId, { email: `${local}@test.local` }, userId);
    const before = await snapshot(patientId, req.id);
    expect(await decide(req)).toEqual({ ok: false, error: "Ese email ya está en otra ficha del consultorio." });
    await expectUntouched(patientId, req.id, before);
  });

  it("contacto de emergencia en null → se borra el contacto", async () => {
    asUser(A.userId);
    const { patientId, userId } = await linkedPatient(A);
    await db.emergencyContact.create({ data: { patientId, name: "Borrar", phone: "666666" } });
    const req = await seedRequest(A, patientId, { emergencyContact: null }, userId);
    expect((await decide(req)).ok).toBe(true);
    expect(await db.emergencyContact.count({ where: { patientId } })).toBe(0);
  });

  it("un pedido con datos que ya no valen (fila tocada a mano) no se aplica; se puede rechazar", async () => {
    asUser(A.userId);
    const { patientId, userId } = await linkedPatient(A, { phone: "1105050505" });
    const req = await db.patientChangeRequest.create({
      data: { tenantId: A.tenantId, patientId, changes: { phone: "1106060606", dni: "999" }, requestedByUserId: userId },
    });
    const before = await snapshot(patientId, req.id);
    const r = await decide(req);
    expect(r.ok).toBe(false);
    await expectUntouched(patientId, req.id, before);
    expect((await decide(req, "REJECT")).ok).toBe(true);
  });
});
