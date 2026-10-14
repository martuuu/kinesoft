/**
 * Portal del paciente (A3b-S-auth, 2026-09-30).
 *
 * - staff ≠ paciente: una identidad con Membership no ve fichas en el portal,
 *   aunque su email coincida con una ficha;
 * - el match de email es case-insensitive (fichas cargadas con mayúsculas);
 * - el check-in NO toca `Patient.notes` (antes anteponía el texto y cortaba a
 *   4 kB las notas del kine): crea la EvaScore, notifica al profesional
 *   asignado y deja un audit con el texto.
 *
 * Llama a las actions REALES de lib/portal.ts; solo se mockea la sesión de
 * Supabase (tests/helpers/actor.ts → `<userId>@test.local`, verificado).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { getPortalAuth, getPortalPlan, submitCheckIn } from "@/lib/portal";
import { __rateLimitInternals } from "@/lib/rate-limit";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("portal · identidad y check-in", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
  });
  afterAll(async () => {
    await A?.cleanup();
    await db?.$disconnect();
  });
  beforeEach(() => __rateLimitInternals.reset());

  /** Identidad de paciente (sin Membership). El mock le da `<id>@test.local`. */
  const patientIdentity = () => `test-portal-${uniqueSuffix()}`;

  const addProgramWithSession = async (patientId: string) => {
    const program = await db.treatmentProgram.create({
      data: { tenantId: A.tenantId, patientId, title: "Plan lumbar", startDate: new Date() },
    });
    const session = await db.session.create({
      data: {
        programId: program.id,
        practitionerId: A.practitionerId,
        index: 1,
        scheduledFor: new Date(Date.now() + 86_400_000),
      },
    });
    return { programId: program.id, sessionId: session.id };
  };

  it("una identidad staff (con Membership) no ve fichas aunque su email coincida", async () => {
    // El OWNER del tenant A tiene una ficha de paciente con SU email.
    await addPatient(db, A, { email: `${A.userId}@test.local` });
    await addProgramWithSession(
      (await db.patient.findFirstOrThrow({ where: { tenantId: A.tenantId, email: `${A.userId}@test.local` } })).id
    );
    asUser(A.userId);

    const auth = await getPortalAuth();
    expect(auth.signedIn).toBe(true);
    if (auth.signedIn) expect(auth.patients).toEqual([]);
    expect(await getPortalPlan(A.slug)).toBeNull();
  });

  it("el email con mayúsculas en la ficha matchea al usuario verificado", async () => {
    const uid = patientIdentity();
    const patientId = await addPatient(db, A, { email: `${uid}@test.local`.toUpperCase() });
    await addProgramWithSession(patientId);
    asUser(uid);

    const auth = await getPortalAuth();
    expect(auth.signedIn).toBe(true);
    if (auth.signedIn) expect(auth.patients.map((p) => p.id)).toEqual([patientId]);
    const plan = await getPortalPlan(A.slug);
    expect(plan?.title).toBe("Plan lumbar");
  });

  it("el check-in no toca Patient.notes: crea la EvaScore, notifica al asignado y audita el texto", async () => {
    const uid = patientIdentity();
    const kineNotes = "Nota clínica del kine: no tocar.";
    const patientId = await addPatient(db, A, { email: `${uid}@test.local`, notes: kineNotes });
    const { sessionId } = await addProgramWithSession(patientId);
    asUser(uid);

    const r = await submitCheckIn({ tenantSlug: A.slug, sessionId, pain: 6, notes: "  Me duele al agacharme  " });
    expect(r).toEqual({ ok: true, data: undefined });

    const p = await db.patient.findUniqueOrThrow({ where: { id: patientId }, select: { notes: true } });
    expect(p.notes).toBe(kineNotes);

    const eva = await db.evaScore.findMany({ where: { patientId } });
    expect(eva).toHaveLength(1);
    expect(eva[0]).toMatchObject({ value: 6, source: `checkin-${sessionId}` });

    // El asignado por defecto del factory es el practitioner del OWNER.
    const notif = await db.notification.findMany({
      where: { tenantId: A.tenantId, userId: A.userId, link: `/pacientes/${patientId}` },
    });
    expect(notif).toHaveLength(1);
    expect(notif[0].title).toContain("EVA 6/10");
    expect(notif[0].body).toBe("Me duele al agacharme");

    const ev = await db.auditEvent.findFirstOrThrow({
      where: { tenantId: A.tenantId, action: "portal.checkin", entityId: patientId },
    });
    expect(ev.actorId).toBe(uid);
    expect(ev.payload).toMatchObject({ sessionId, pain: 6, notes: "Me duele al agacharme" });

    // Segundo check-in de la misma sesión: rechazado, sin tocar nada.
    const again = await submitCheckIn({ tenantSlug: A.slug, sessionId, pain: 2, notes: "otra" });
    expect(again.ok).toBe(false);
    expect(await db.evaScore.count({ where: { patientId } })).toBe(1);
  });

  // P0-S02p: `Session.notes` son notas del kine (clínicas, privadas): el DTO
  // del portal las mandaba al navegador del paciente aunque la página no las
  // pintara. Y con dos planes ACTIVE el `findFirst` sin orden devolvía
  // cualquiera de los dos (el que el planner de Postgres leyera primero).
  it("[P0-S02p] getPortalPlan sin notes y determinístico", async () => {
    const uid = patientIdentity();
    const patientId = await addPatient(db, A, { email: `${uid}@test.local` });
    const DAY = 86_400_000;
    // El viejo se crea PRIMERO a propósito: un findFirst sin orden tiende a
    // devolver el primero insertado (menor ctid), o sea el viejo.
    await db.treatmentProgram.create({
      data: { tenantId: A.tenantId, patientId, title: "Plan viejo", startDate: new Date(Date.now() - 60 * DAY) },
    });
    const newer = await db.treatmentProgram.create({
      data: { tenantId: A.tenantId, patientId, title: "Plan nuevo", startDate: new Date(Date.now() - 2 * DAY) },
    });
    await db.session.create({
      data: {
        programId: newer.id,
        practitionerId: A.practitionerId,
        index: 1,
        scheduledFor: new Date(Date.now() + DAY),
        notes: "Nota privada del kine",
      },
    });
    asUser(uid);

    const plan = await getPortalPlan(A.slug);
    expect(plan?.programId).toBe(newer.id);
    expect(plan?.title).toBe("Plan nuevo");
    expect(plan?.sessions).toHaveLength(1);
    expect(plan?.sessions[0]).not.toHaveProperty("notes");
    expect(JSON.stringify(plan)).not.toContain("Nota privada del kine");
  });

  // BO2-D (C-BO1 `publicSurfacesOpen`): el check-in es una escritura sin Actor; con el consultorio suspendido
  // (o en solo lectura bajo `enforce`) se rechaza sin escribir. Leer el plan NO se corta (Ley 26.529).
  it("[BO2-D] consultorio suspendido o en solo lectura con enforce: check-in rechazado, el plan se sigue viendo", async () => {
    const uid = patientIdentity();
    const patientId = await addPatient(db, A, { email: `${uid}@test.local` });
    const { sessionId } = await addProgramWithSession(patientId);
    asUser(uid);
    const prev = process.env.TENANT_ACCESS_ENFORCEMENT;
    try {
      await db.tenant.update({ where: { id: A.tenantId }, data: { status: "SUSPENDED" } });
      const r = await submitCheckIn({ tenantSlug: A.slug, sessionId, pain: 4 });
      expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/no está recibiendo check-ins/) });
      expect((await getPortalPlan(A.slug))?.title).toBe("Plan lumbar");

      await db.tenant.update({
        where: { id: A.tenantId },
        data: { status: "ACTIVE", subscriptionStatus: "TRIALING", trialEndsAt: new Date(Date.now() - 30 * 86_400_000) },
      });
      process.env.TENANT_ACCESS_ENFORCEMENT = "enforce";
      expect((await submitCheckIn({ tenantSlug: A.slug, sessionId, pain: 4 })).ok).toBe(false);
      expect(await db.evaScore.count({ where: { patientId } })).toBe(0);

      // Con `banner` (default) el trial vencido solo se avisa: el check-in pasa.
      process.env.TENANT_ACCESS_ENFORCEMENT = "banner";
      expect(await submitCheckIn({ tenantSlug: A.slug, sessionId, pain: 4 })).toEqual({ ok: true, data: undefined });
      expect(await db.evaScore.count({ where: { patientId } })).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.TENANT_ACCESS_ENFORCEMENT;
      else process.env.TENANT_ACCESS_ENFORCEMENT = prev;
      await db.tenant.update({
        where: { id: A.tenantId },
        data: { status: "ACTIVE", subscriptionStatus: "ACTIVE", trialEndsAt: null },
      });
    }
  });

  it("una identidad staff no puede hacer check-in sobre una ficha con su email", async () => {
    const patientId = (
      await db.patient.findFirstOrThrow({ where: { tenantId: A.tenantId, email: `${A.userId}@test.local` } })
    ).id;
    const session = await db.session.findFirstOrThrow({ where: { program: { patientId } } });
    asUser(A.userId);
    const r = await submitCheckIn({ tenantSlug: A.slug, sessionId: session.id, pain: 3 });
    expect(r.ok).toBe(false);
    expect(await db.evaScore.count({ where: { patientId } })).toBe(0);
  });
});
