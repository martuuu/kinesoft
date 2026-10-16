/**
 * Portal del paciente (A3b-S-auth, 2026-09-30).
 *
 * - staff ≠ paciente: una identidad con Membership no ve fichas en el portal,
 *   aunque su email coincida con una ficha (y aunque esté vinculada);
 * - [P4-S24a] el portal autoriza por el vínculo `Patient.userId` (tenantId, userId), no por email: los fixtures
 *   crean la ficha YA vinculada a la cuenta (lo que deja el sign-in o la invitación). La regla de vínculo y el
 *   «sin vínculo no ve nada» están en tests/integration/portal-identity.test.ts;
 * - el check-in NO toca `Patient.notes` (antes anteponía el texto y cortaba a
 *   4 kB las notas del kine): crea la EvaScore, notifica al profesional
 *   asignado y deja un audit con el texto.
 * - [P4-S24] el plan que se muestra es el VINCULADO (turnos con `programId` o `schedule`) más reciente: los fixtures
 *   arman planes con su turno, como los deja el motor de Planes. Los gates por módulo (`portalSectionsFor`) se prueban
 *   con un consultorio de Clínica general (sin `planes` ni `evaluaciones`; en la matriz no existe un Kine sin planes).
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
import { addPlanBooking, addPlanSession } from "@/tests/helpers/plan-factory";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("portal · identidad y check-in", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  /** Clínica general: sin `planes` ni `evaluaciones` (lib/tenant-modules.ts); turnero apagado. */
  let G: EphemeralTenant;

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    G = await createEphemeralTenant(db, { vertical: "GENERAL", publicBookingEnabled: false });
  });
  const profiles: string[] = [];
  afterAll(async () => {
    await A?.cleanup();
    await G?.cleanup();
    if (profiles.length) await db.userProfile.deleteMany({ where: { id: { in: profiles } } });
    await db?.$disconnect();
  });
  beforeEach(() => __rateLimitInternals.reset());

  /**
   * Cuenta de paciente (UserProfile sin Membership; `Patient.userId` tiene FK a UserProfile). El mock de sesión le da
   * `<id>@test.local`, verificado.
   */
  const patientIdentity = async () => {
    const id = `test-portal-${uniqueSuffix()}`;
    await db.userProfile.create({ data: { id, email: `${id}@test.local` } });
    profiles.push(id);
    return id;
  };

  /** Ficha VINCULADA a la cuenta (S24a): lo que deja el auto-vínculo del sign-in o `/portal/vincular`. */
  const linkedPatient = async (uid: string, data: Parameters<typeof addPatient>[2] = {}, t: EphemeralTenant = A) => {
    const patientId = await addPatient(db, t, { email: `${uid}@test.local`, ...data });
    await db.patient.update({ where: { id: patientId }, data: { userId: uid } });
    return patientId;
  };

  /**
   * Plan VINCULADO de una sesión (mañana) con su turno, como lo deja el motor de Planes. `t` = consultorio (G para
   * los gates de Clínica general: el plan existe en la base aunque el módulo no esté).
   */
  const addProgramWithSession = async (patientId: string, t: EphemeralTenant = A, title = "Plan lumbar") => {
    const program = await db.treatmentProgram.create({
      data: { tenantId: t.tenantId, patientId, title, startDate: new Date() },
    });
    const scheduledFor = new Date(Date.now() + 86_400_000);
    const sessionId = await addPlanSession(db, program.id, { index: 1, practitionerId: t.practitionerId, scheduledFor });
    const bookingId = await addPlanBooking(db, t, { programId: program.id, sessionId, patientId, scheduledFor });
    return { programId: program.id, sessionId, bookingId };
  };

  it("una identidad staff (con Membership) no ve fichas aunque su email coincida", async () => {
    // El OWNER del tenant A tiene una ficha de paciente con SU email, y encima vinculada a su cuenta (dato viejo):
    // igual no la ve (AUDIT §5.22).
    const ownerPatientId = await linkedPatient(A.userId);
    await addProgramWithSession(ownerPatientId);
    asUser(A.userId);

    const auth = await getPortalAuth();
    expect(auth.signedIn).toBe(true);
    if (auth.signedIn) expect(auth.patients).toEqual([]);
    expect(await getPortalPlan(A.slug)).toBeNull();
  });

  it("[P4-S24a] la ficha vinculada se ve por userId, aunque su email esté en mayúsculas", async () => {
    const uid = await patientIdentity();
    const patientId = await linkedPatient(uid, { email: `${uid}@test.local`.toUpperCase() });
    await addProgramWithSession(patientId);
    asUser(uid);

    const auth = await getPortalAuth();
    expect(auth.signedIn).toBe(true);
    if (auth.signedIn) expect(auth.patients.map((p) => p.id)).toEqual([patientId]);
    const plan = await getPortalPlan(A.slug);
    expect(plan?.title).toBe("Plan lumbar");
  });

  it("el check-in no toca Patient.notes: crea la EvaScore y notifica al asignado (sin audit, PL-A)", async () => {
    const uid = await patientIdentity();
    const kineNotes = "Nota clínica del kine: no tocar.";
    const patientId = await linkedPatient(uid, { notes: kineNotes });
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

    // PL-A (plan §20.5.9): el check-in es ruido operativo y ya no audita (antes copiaba el texto del paciente al
    // payload del audit). Queda la EvaScore y la notificación de arriba.
    expect(await db.auditEvent.count({ where: { tenantId: A.tenantId, entityId: patientId } })).toBe(0);

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
    const uid = await patientIdentity();
    const patientId = await linkedPatient(uid);
    const DAY = 86_400_000;
    // El viejo se crea PRIMERO a propósito: un findFirst sin orden tiende a
    // devolver el primero insertado (menor ctid), o sea el viejo.
    const older = await db.treatmentProgram.create({
      data: { tenantId: A.tenantId, patientId, title: "Plan viejo", startDate: new Date(Date.now() - 60 * DAY) },
    });
    const olderSession = await addPlanSession(db, older.id, { index: 1, practitionerId: A.practitionerId });
    await addPlanBooking(db, A, { programId: older.id, sessionId: olderSession, patientId });
    const newer = await db.treatmentProgram.create({
      data: { tenantId: A.tenantId, patientId, title: "Plan nuevo", startDate: new Date(Date.now() - 2 * DAY) },
    });
    const newerSession = await db.session.create({
      data: {
        programId: newer.id,
        practitionerId: A.practitionerId,
        index: 1,
        scheduledFor: new Date(Date.now() + DAY),
        notes: "Nota privada del kine",
      },
    });
    await addPlanBooking(db, A, {
      programId: newer.id,
      sessionId: newerSession.id,
      patientId,
      scheduledFor: new Date(Date.now() + DAY),
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
    const uid = await patientIdentity();
    const patientId = await linkedPatient(uid);
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
  // ── ES4 S24 · turnos del plan, gates por módulo y check-in con note/sessionId ──────────────────────────────────

  it("[P4-S24] check-in llena note y sessionId", async () => {
    const uid = await patientIdentity();
    const patientId = await linkedPatient(uid);
    const { sessionId } = await addProgramWithSession(patientId);
    asUser(uid);

    expect(await submitCheckIn({ tenantSlug: A.slug, sessionId, pain: 3, notes: "  Mejor que la semana pasada  " })).toEqual({
      ok: true,
      data: undefined,
    });
    const eva = await db.evaScore.findMany({ where: { patientId } });
    expect(eva).toHaveLength(1);
    // M1 (schema EvaScore): «las escrituras nuevas llenan ambos»; `source` queda por compatibilidad.
    expect(eva[0]).toMatchObject({ value: 3, note: "Mejor que la semana pasada", sessionId, source: `checkin-${sessionId}` });
  });

  it("[P4-S24] General/Kine sin planes → getPortalPlan null y getPortalAuth sin programs", async () => {
    // Un consultorio General no tiene `planes`; el plan existe en la base (alta vieja, cambio de vertical) y aun así
    // el portal no lo muestra. Kine trae `planes` en todos los planes SaaS: el gate es el mismo (por módulo).
    const uid = await patientIdentity();
    const patientId = await linkedPatient(uid, {}, G);
    await addProgramWithSession(patientId, G, "Plan en General");
    asUser(uid);

    const auth = await getPortalAuth();
    expect(auth.signedIn).toBe(true);
    if (!auth.signedIn) return;
    expect(auth.patients).toHaveLength(1);
    expect(auth.patients[0].programs).toEqual([]);
    expect(await getPortalPlan(G.slug)).toBeNull();
  });

  it("[P4-S24] sin evaluaciones → submitCheckIn rechaza", async () => {
    const uid = await patientIdentity();
    const patientId = await linkedPatient(uid, {}, G);
    const { sessionId } = await addProgramWithSession(patientId, G);
    asUser(uid);

    const r = await submitCheckIn({ tenantSlug: G.slug, sessionId, pain: 5, notes: "algo" });
    expect(r.ok).toBe(false);
    expect(await db.evaScore.count({ where: { patientId } })).toBe(0);
    expect(await db.notification.count({ where: { tenantId: G.tenantId, link: `/pacientes/${patientId}` } })).toBe(0);
  });

  it("[P4-S24] turnos del plan: «n de N» por fecha entre las vivas, profesional sin email, sin montos ni notas", async () => {
    const uid = await patientIdentity();
    const patientId = await linkedPatient(uid);
    const DAY = 86_400_000;
    const program = await db.treatmentProgram.create({
      data: { tenantId: A.tenantId, patientId, title: "Plan rodilla", startDate: new Date(), totalSessions: 10 },
    });
    // index 1 y 2 con fechas invertidas: el ordinal es por fecha (M13), no por index. index 3 archivada: no cuenta.
    const s1 = await addPlanSession(db, program.id, {
      index: 1,
      practitionerId: A.practitionerId,
      scheduledFor: new Date(Date.now() + 3 * DAY),
      priceCents: 700_000,
    });
    const s2 = await addPlanSession(db, program.id, {
      index: 2,
      practitionerId: A.practitionerId,
      scheduledFor: new Date(Date.now() + 1 * DAY),
    });
    await addPlanSession(db, program.id, {
      index: 3,
      practitionerId: A.practitionerId,
      scheduledFor: new Date(Date.now() + 5 * DAY),
      archivedAt: new Date(),
    });
    const at = new Date(Date.now() + 1 * DAY + 3_600_000);
    await addPlanBooking(db, A, { programId: program.id, sessionId: s2, patientId, scheduledFor: at, copagoCents: 123_400 });
    // Un turno CANCELADO de s1 no cuenta como turno de la sesión (C4: queda «sin turno»).
    await addPlanBooking(db, A, { programId: program.id, sessionId: s1, patientId, status: "CANCELLED" });
    // El profesional sin nombre: el portal nunca cae al email (DIR-0).
    const ownerName = (await db.userProfile.findUniqueOrThrow({ where: { id: A.userId } })).fullName;
    await db.userProfile.update({ where: { id: A.userId }, data: { fullName: null } });
    asUser(uid);

    try {
      const plan = await getPortalPlan(A.slug);
      expect(plan?.title).toBe("Plan rodilla");
      expect(plan?.totalSessions).toBe(2);
      expect(plan?.sessions.map((s) => [s.id, s.ordinal])).toEqual([
        [s2, 1],
        [s1, 2],
      ]);
      expect(plan?.sessions[0].booking).toEqual({
        scheduledFor: at.toISOString(),
        durationMin: 45,
        serviceName: expect.any(String),
        practitionerName: "Profesional",
      });
      expect(plan?.sessions[1].booking).toBeNull();
      const json = JSON.stringify(plan);
      expect(json).not.toMatch(/cents|copago|price|notes|@test\.local/i);
      expect(json).not.toContain("123400");
    } finally {
      await db.userProfile.update({ where: { id: A.userId }, data: { fullName: ownerName } });
    }
  });

  it("[P4-S24] un plan sin turnos ni agenda (legacy) no se muestra: gana el vinculado aunque sea más viejo", async () => {
    const uid = await patientIdentity();
    const patientId = await linkedPatient(uid);
    const DAY = 86_400_000;
    const { programId } = await addProgramWithSession(patientId, A, "Plan vinculado");
    await db.treatmentProgram.update({ where: { id: programId }, data: { startDate: new Date(Date.now() - 30 * DAY) } });
    const legacy = await db.treatmentProgram.create({
      data: { tenantId: A.tenantId, patientId, title: "Plan legacy", startDate: new Date() },
    });
    await addPlanSession(db, legacy.id, { index: 1, practitionerId: A.practitionerId });
    asUser(uid);

    expect((await getPortalPlan(A.slug))?.programId).toBe(programId);
    const auth = await getPortalAuth();
    if (auth.signedIn) expect(auth.patients[0].programs.map((p) => p.id)).toEqual([programId]);
  });

  it("[P4-S24] «ya enviado» se detecta por sessionId (y por el source viejo)", async () => {
    const uid = await patientIdentity();
    const patientId = await linkedPatient(uid);
    const { sessionId } = await addProgramWithSession(patientId);
    asUser(uid);

    expect((await getPortalPlan(A.slug))?.sessions[0].hasCheckIn).toBe(false);
    // Una EVA del kine con la misma sesión (source "pre") NO es un check-in del paciente.
    await db.evaScore.create({ data: { patientId, value: 2, source: "pre", sessionId } });
    expect((await getPortalPlan(A.slug))?.sessions[0].hasCheckIn).toBe(false);
    expect((await submitCheckIn({ tenantSlug: A.slug, sessionId, pain: 4 })).ok).toBe(true);
    expect((await getPortalPlan(A.slug))?.sessions[0].hasCheckIn).toBe(true);
    const again = await submitCheckIn({ tenantSlug: A.slug, sessionId, pain: 4 });
    expect(again).toMatchObject({ ok: false, error: expect.stringMatching(/Ya enviaste/) });

    // Fila vieja (antes de S24: solo `source`, sin `sessionId`): también cuenta como enviada.
    const uid2 = await patientIdentity();
    const p2 = await linkedPatient(uid2);
    const legacy = await addProgramWithSession(p2);
    await db.evaScore.create({ data: { patientId: p2, value: 5, source: `checkin-${legacy.sessionId}` } });
    asUser(uid2);
    expect((await getPortalPlan(A.slug))?.sessions[0].hasCheckIn).toBe(true);
    expect((await submitCheckIn({ tenantSlug: A.slug, sessionId: legacy.sessionId, pain: 4 })).ok).toBe(false);
    expect(await db.evaScore.count({ where: { patientId: p2 } })).toBe(1);
  });

  it("[P4-S24] check-in sobre una sesión archivada o de un plan de otro paciente: rechazado sin escribir", async () => {
    const uid = await patientIdentity();
    const patientId = await linkedPatient(uid);
    const { programId } = await addProgramWithSession(patientId);
    const archived = await addPlanSession(db, programId, {
      index: 2,
      practitionerId: A.practitionerId,
      archivedAt: new Date(),
    });
    const other = await addPatient(db, A);
    const foreign = await addProgramWithSession(other);
    asUser(uid);

    expect((await submitCheckIn({ tenantSlug: A.slug, sessionId: archived, pain: 4 })).ok).toBe(false);
    expect((await submitCheckIn({ tenantSlug: A.slug, sessionId: foreign.sessionId, pain: 4 })).ok).toBe(false);
    expect(await db.evaScore.count({ where: { patientId: { in: [patientId, other] } } })).toBe(0);
  });

  it("[P4-S24] secciones por ficha: Kine con turnero = plan, check-in, ejercicios, cuenta y reservar; General sin turnero = inicio y cuenta", async () => {
    const uid = await patientIdentity();
    await linkedPatient(uid);
    await linkedPatient(uid, {}, G);
    asUser(uid);

    const auth = await getPortalAuth();
    if (!auth.signedIn) throw new Error("sin sesión");
    const byTenant = new Map(auth.patients.map((p) => [p.tenantSlug, [...p.sections].sort()]));
    expect(byTenant.get(A.slug)).toEqual(["checkin", "cuenta", "ejercicios", "inicio", "plan", "reservar"]);
    expect(byTenant.get(G.slug)).toEqual(["cuenta", "inicio"]);
  });
});
