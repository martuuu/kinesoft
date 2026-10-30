/**
 * Portal del paciente (A3b-S-auth, 2026-09-30).
 *
 * - staff ≠ paciente: una identidad con Membership no ve fichas en el portal,
 *   aunque su email coincida con una ficha (y aunque esté vinculada);
 * - [P4-S24a] el portal autoriza por el vínculo `Patient.userId` (tenantId, userId), no por email: los fixtures
 *   crean la ficha YA vinculada a la cuenta (lo que deja el sign-in o la invitación). La regla de vínculo y el
 *   «sin vínculo no ve nada» están en tests/integration/portal-identity.test.ts;
 * - [CF-L3] el check-in pre-sesión (EVA 0..10 + notas, `submitCheckIn`) se borró con la EVA de toda la app (decisión
 *   de Martin 30-oct, §28.1 punto 4): ni la action, ni la sección, ni el dato en el DTO. Las `EvaScore` viejas quedan.
 * - [P4-S24] el plan que se muestra es el VINCULADO (turnos con `programId` o `schedule`) más reciente: los fixtures
 *   arman planes con su turno, como los deja el motor de Planes. Los gates por módulo (`portalSectionsFor`) se prueban
 *   con un consultorio de Clínica general (sin `planes`; en la matriz no existe un Kine sin planes).
 *
 * Llama a las actions REALES de lib/portal.ts; solo se mockea la sesión de
 * Supabase (tests/helpers/actor.ts → `<userId>@test.local`, verificado).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import * as portalActions from "@/lib/portal";
import { getPortalAuth, getPortalPlan } from "@/lib/portal";
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

describe.skipIf(!RUN)("portal · identidad y plan", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  /** Clínica general: sin `planes` (lib/tenant-modules.ts); turnero apagado. */
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

  // [CF-L3] La EVA salió de toda la app (decisión de Martin 30-oct, §28.1 punto 4), incluido el check-in del portal.
  // Antes `submitCheckIn` escribía una `EvaScore` «checkin-<sesión>» y notificaba «… · EVA 6/10» al profesional, y
  // `getPortalPlan` traía `hasCheckIn` por sesión. Los datos viejos quedan en la base: el portal no los lee ni los manda.
  it("[CF-L3] sin check-in: no hay action, el plan no trae el dato y una EvaScore vieja no se filtra", async () => {
    expect("submitCheckIn" in portalActions).toBe(false);
    const uid = await patientIdentity();
    const patientId = await linkedPatient(uid);
    const { sessionId } = await addProgramWithSession(patientId);
    await db.evaScore.create({
      data: { patientId, value: 7, source: `checkin-${sessionId}`, sessionId, note: "Texto viejo del paciente" },
    });
    asUser(uid);

    const plan = await getPortalPlan(A.slug);
    expect(plan?.title).toBe("Plan lumbar");
    expect(plan?.sessions).toHaveLength(1);
    expect(plan?.sessions[0]).not.toHaveProperty("hasCheckIn");
    expect(JSON.stringify(plan)).not.toMatch(/checkin|Texto viejo/i);
    const auth = await getPortalAuth();
    if (!auth.signedIn) throw new Error("debería tener sesión");
    expect(auth.patients.find((p) => p.id === patientId)?.sections).not.toContain("checkin");
    // El dato no se borra (los datos y el modelo quedan).
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

  // ES4 P4.Z (handoff S24e): el plan del portal es el mismo que eligen los ejercicios: sin archivados y con el orden
  // startDate desc, createdAt desc, id desc. Un plan archivado más nuevo no le gana al vigente.
  it("[ES4-P4.Z] getPortalPlan: sin planes archivados y mismo orden que ejercicios (startDate, createdAt, id)", async () => {
    const uid = await patientIdentity();
    const patientId = await linkedPatient(uid);
    const start = new Date(Date.now() - 10 * 86_400_000);
    const first = await addProgramWithSession(patientId, A, "Plan primero");
    await db.treatmentProgram.update({ where: { id: first.programId }, data: { startDate: start, createdAt: new Date(Date.now() - 60_000) } });
    // Mismo startDate, creado después → gana por createdAt desc.
    const second = await addProgramWithSession(patientId, A, "Plan segundo");
    await db.treatmentProgram.update({ where: { id: second.programId }, data: { startDate: start } });
    // Más nuevo pero archivado → no cuenta ni en el plan ni en la home.
    const archived = await addProgramWithSession(patientId, A, "Plan archivado");
    await db.treatmentProgram.update({ where: { id: archived.programId }, data: { archivedAt: new Date() } });
    asUser(uid);

    const plan = await getPortalPlan(A.slug);
    expect(plan?.programId).toBe(second.programId);
    const auth = await getPortalAuth();
    if (!auth.signedIn) throw new Error("debería tener sesión");
    expect(auth.patients.find((p) => p.id === patientId)?.programs.map((p) => p.id)).toEqual([second.programId, first.programId]);
  });

  // BO2-D (C-BO1 `publicSurfacesOpen`): con el consultorio suspendido leer el plan NO se corta (Ley 26.529). La mitad
  // de escritura (el check-in rechazado) se fue con el check-in en CF.
  it("[BO2-D] consultorio suspendido: el plan se sigue viendo", async () => {
    const uid = await patientIdentity();
    const patientId = await linkedPatient(uid);
    await addProgramWithSession(patientId);
    asUser(uid);
    try {
      await db.tenant.update({ where: { id: A.tenantId }, data: { status: "SUSPENDED" } });
      expect((await getPortalPlan(A.slug))?.title).toBe("Plan lumbar");
    } finally {
      await db.tenant.update({
        where: { id: A.tenantId },
        data: { status: "ACTIVE", subscriptionStatus: "ACTIVE", trialEndsAt: null },
      });
    }
  });

  // ── ES4 S24 · turnos del plan y gates por módulo ─────────────────────────────────────────────────────────────────

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

  it("[P4-S24] secciones por ficha: Kine con turnero = plan, ejercicios, cuenta y reservar (sin check-in, CF-L3); General sin turnero = inicio y cuenta", async () => {
    const uid = await patientIdentity();
    await linkedPatient(uid);
    await linkedPatient(uid, {}, G);
    asUser(uid);

    const auth = await getPortalAuth();
    if (!auth.signedIn) throw new Error("sin sesión");
    const byTenant = new Map(auth.patients.map((p) => [p.tenantSlug, [...p.sections].sort()]));
    expect(byTenant.get(A.slug)).toEqual(["cuenta", "documentos", "ejercicios", "inicio", "plan", "reservar"]);
    expect(byTenant.get(G.slug)).toEqual(["cuenta", "documentos", "inicio"]);
  });
});
