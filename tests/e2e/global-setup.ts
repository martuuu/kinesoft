import { mkdirSync, writeFileSync } from "node:fs";
import {
  addPatient,
  addService,
  createEphemeralTenant,
  ownerClient,
  sweepOrphanTestTenants,
  uniqueSuffix,
} from "../helpers/tenant-factory";
import { E2E_FIXTURE_FILE, E2E_PASSWORD, E2E_STATE_DIR, E2E_USERS_FILE } from "./support/e2e-constants.mjs";
import type { E2EFixture } from "./support/fixture";
import { createPlansFixtures, plansUsers } from "./support/plans";
import { createPvFixtures, pvUsers, sweepPvLeftovers } from "./support/pv";

/**
 * OPS-6 · datos de la corrida: un tenant efímero con la MISMA factory que la integración (tests/helpers/tenant-factory.ts),
 * nunca un seed. Lo borra `global-teardown.ts`; si una corrida se corta, `sweepOrphanTestTenants` lo barre a los 30'.
 *
 * Arma lo mínimo para que los flujos corran sin tocar la configuración por la UI:
 *  - OWNER + profesional + servicio «Consulta» (45', $50) + «Particular» (lo de la factory);
 *  - sede principal y franjas de 08:00 a 19:00 los 7 días (el horario del consultorio por defecto es 8-19): así hay
 *    turnos libres en el turnero cualquier día que corra la suite, y un turno de hoy para Recepción aunque sea domingo;
 *  - una paciente con usuario del portal y un turno de mañana;
 *  - tres pacientes, uno por familia de specs (turnos, ficha, plan), para que un spec no le cambie la pantalla al otro.
 */
function isLocal(u: string | undefined): boolean {
  try {
    const h = new URL(u ?? "").hostname;
    return h === "localhost" || h === "127.0.0.1";
  } catch {
    return false;
  }
}

/** Fecha de HOY en Argentina (YYYY-MM-DD), corrida por `addDays`. El host puede estar en cualquier TZ. */
function arDay(addDays = 0): string {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());
  const d = new Date(`${today}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + addDays);
  return d.toISOString().slice(0, 10);
}
/** Instante de `day` a las `hh:mm` de Argentina (UTC−3 fijo, sin horario de verano desde 2009). */
function arAt(day: string, hh: number, mm = 0): Date {
  return new Date(`${day}T${String(hh + 3).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00.000Z`);
}

export default async function globalSetup(): Promise<void> {
  if (!isLocal(process.env.DIRECT_URL ?? process.env.DATABASE_URL)) {
    throw new Error("e2e: la DB no es local. Corré la suite con `npm run test:e2e` (usa .env.local).");
  }
  const db = ownerClient();
  try {
    await sweepOrphanTestTenants(db);
    // PV (Q4, sesión E2E): perfiles sin consultorio y tickets LEAD de una corrida cortada (no cuelgan de un tenant).
    await sweepPvLeftovers(db);
    const t = await createEphemeralTenant(db, { role: "OWNER" });
    const owner = await db.userProfile.findUniqueOrThrow({ where: { id: t.userId }, select: { email: true, fullName: true } });
    const location = await db.location.create({ data: { tenantId: t.tenantId, name: "Principal", isPrimary: true } });
    await db.practitionerSchedule.createMany({
      data: [0, 1, 2, 3, 4, 5, 6].map((dow) => ({
        tenantId: t.tenantId,
        practitionerId: t.practitionerId,
        locationId: location.id,
        dow,
        startMin: 8 * 60,
        endMin: 19 * 60,
      })),
    });
    const patient = { firstName: "Lucía", lastName: "Turnos E2E", phone: "+5491155550101" };
    const chartPatient = { firstName: "Martín", lastName: "Ficha E2E" };
    const planPatient = { firstName: "Sofía", lastName: "Plan E2E" };
    const patientId = await addPatient(db, t, patient);
    const chartPatientId = await addPatient(db, t, chartPatient);
    const planPatientId = await addPatient(db, t, planPatient);

    // Portal: un usuario SIN Membership en ningún tenant (con una, el portal lo trata como staff y no muestra fichas)
    // vinculado por `Patient.userId`, con un turno de mañana a las 10:00 de Argentina (13:00 UTC).
    const portalUserId = `test-user-portal-${uniqueSuffix()}`;
    const portalEmail = `${portalUserId}@test.local`;
    await db.userProfile.create({ data: { id: portalUserId, email: portalEmail, fullName: "Ana Portal E2E" } });
    const portalPatientId = await addPatient(db, t, { firstName: "Ana", lastName: "Portal E2E", email: portalEmail });
    await db.patient.update({ where: { id: portalPatientId }, data: { userId: portalUserId } });
    const portalBookingAt = arAt(arDay(1), 10);
    await db.booking.create({
      data: {
        tenantId: t.tenantId,
        patientId: portalPatientId,
        practitionerId: t.practitionerId,
        serviceId: t.serviceId,
        locationId: location.id,
        scheduledFor: portalBookingAt,
        durationMin: 45,
        status: "CONFIRMED",
        idempotencyKey: `e2e-portal-${portalUserId}`,
      },
    });

    // Servicio con cupo 1 por horario: con el «Consulta» de la factory (maxConcurrent null = ilimitado) dos turnos
    // a la misma hora entran sin aviso, así que el conflicto se prueba con este.
    const cappedServiceName = "Kinesio 1 a 1";
    const cappedServiceId = await addService(db, t, { name: cappedServiceName, durationMin: 45, priceCents: 5000, maxConcurrent: 1 });
    const conflictPatient = { firstName: "Bruno", lastName: "Conflicto E2E" };
    const conflictPatientId = await addPatient(db, t, conflictPatient);

    const booking = (patientId: string, at: Date, key: string, extra: { copagoCents?: number } = {}) =>
      db.booking.create({
        data: {
          tenantId: t.tenantId,
          patientId,
          practitionerId: t.practitionerId,
          serviceId: t.serviceId,
          locationId: location.id,
          scheduledFor: at,
          durationMin: 45,
          status: "CONFIRMED",
          idempotencyKey: `e2e-${key}-${t.tenantId}`,
          ...extra,
        },
        select: { id: true },
      });

    // Recepción + WhatsApp: turno de HOY (día AR) de Lucía a las 18:00.
    const today = arDay(0);
    const todayBooking = await booking(patientId, arAt(today, 18), "today");
    // Mover: turno de mañana a las 09:00 de otro paciente.
    const movePatient = { firstName: "Elena", lastName: "Mover E2E" };
    const movePatientId = await addPatient(db, t, movePatient);
    const moveDay = arDay(1);
    const moveBooking = await booking(movePatientId, arAt(moveDay, 9), "move");
    // Cobro: turno CONFIRMADO de ayer con copago de $50 sin cobrar.
    const payPatient = { firstName: "Carla", lastName: "Cobro E2E" };
    const payPatientId = await addPatient(db, t, payPatient);
    const payBooking = await booking(payPatientId, arAt(arDay(-1), 11), "pay", { copagoCents: 5000 });
    // Enmienda: una evolución de hace 3 días (fuera de la ventana de edición de 24 h del autor → «Agregar enmienda»).
    const oldNote = await db.clinicalNote.create({
      data: {
        tenantId: t.tenantId,
        patientId: chartPatientId,
        kind: "EVOLUTION",
        title: "Evolución vieja E2E",
        body: "Dolor lumbar 6/10. Se trabajó movilidad.",
        occurredAt: new Date(Date.now() - 3 * 86400_000),
        createdAt: new Date(Date.now() - 3 * 86400_000),
        authorUserId: t.userId,
        authorPractitionerId: t.practitionerId,
        authorName: owner.fullName ?? "E2E",
        idempotencyKey: `e2e-old-note-${t.tenantId}`,
      },
      select: { id: true },
    });

    const fixture: E2EFixture = {
      tenantId: t.tenantId,
      slug: t.slug,
      owner: { id: t.userId, email: owner.email, password: E2E_PASSWORD, fullName: owner.fullName ?? "E2E" },
      practitionerId: t.practitionerId,
      serviceId: t.serviceId,
      serviceName: "Consulta",
      locationId: location.id,
      patient: { id: patientId, ...patient },
      chartPatient: { id: chartPatientId, ...chartPatient },
      planPatient: { id: planPatientId, ...planPatient },
      cappedService: { id: cappedServiceId, name: cappedServiceName },
      conflictPatient: { id: conflictPatientId, ...conflictPatient },
      today,
      todayBookingId: todayBooking.id,
      movePatient: { id: movePatientId, ...movePatient },
      moveDay,
      moveBookingId: moveBooking.id,
      payPatient: { id: payPatientId, ...payPatient },
      payBookingId: payBooking.id,
      oldNoteId: oldNote.id,
      portal: { userId: portalUserId, email: portalEmail, password: E2E_PASSWORD, patientId: portalPatientId, bookingAt: portalBookingAt.toISOString() },
    };
    mkdirSync(E2E_STATE_DIR, { recursive: true });
    // QA-E (T6+T7, §26.8): 3 consultorios más para `plans-matrix.spec.ts` (Consultorio General con Secretaría, Clínica
    // Kine con salas, Individual Kine en solo lectura). Archivo propio (`plans.json`); sus usuarios van al GoTrue falso.
    const plans = await createPlansFixtures(db);
    // PV (§27, Q4): superadmin, consultorio suspendido, usuario deshabilitado y consultorio para el cierre por
    // inactividad (con una invitación pendiente) de tickets/legal/idle.spec.ts. Archivo propio (`pv.json`).
    const pv = await createPvFixtures(db);
    writeFileSync(E2E_FIXTURE_FILE, JSON.stringify(fixture, null, 2));
    // El GoTrue falso (support/start-server.mjs) lee este archivo en cada request.
    writeFileSync(
      E2E_USERS_FILE,
      JSON.stringify(
        [
          { id: t.userId, email: owner.email, password: E2E_PASSWORD, fullName: fixture.owner.fullName },
          { id: portalUserId, email: portalEmail, password: E2E_PASSWORD, fullName: "Ana Portal E2E" },
          ...plansUsers(plans),
          ...pvUsers(pv),
        ],
        null,
        2
      )
    );
  } finally {
    await db.$disconnect();
  }
}
