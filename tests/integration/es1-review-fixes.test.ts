/**
 * P0.Z (cierre de ES1) — hallazgos del revisor (b), preexistentes, que entran
 * en ES1 por tocar E1/PD-13 (rol sin `clinical.read` = siempre `admin`, nunca
 * diagnóstico/HC).
 *
 *  - H-b1 `listPatients`: los filtros clínicos (diagnóstico, con/sin plan) y
 *    los que miran campos enmascarados en basic (obra social, edad, última
 *    visita, email en la búsqueda) se aplicaban en SQL para cualquier actor →
 *    oráculo: la Secretaria/BILLING o un kine en básico filtraba por
 *    "lumbalgia" y recibía nombre + DNI de quienes la tienen.
 *  - H-b2 `requireShareAuthority`: "dueño" = asignado, sin mirar el rol → una
 *    Secretaria asignada (precheck 15 de prod) abría la HC a otros.
 *    `assignPatientToPractitioner` aceptaba un destino sin rol clínico.
 *  - H-b3 guest evaluado como "full": BILLING (sin `agenda.operateAll`) creaba
 *    y operaba turnos guest con copago arbitrario, y los borraba/cobraba.
 *  - H-b4 `searchPatientsForAssignment`: edad + "con plan activo" a cualquier
 *    rol (y búsqueda por email) en el picker del Plan Builder.
 *
 * Símbolos reales contra la DB; solo se mockea la sesión (integration-setup).
 * Cada caso lleva su control positivo para no dar verde porque "todo se
 * rechaza".
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { listPatients, setPatientShares, assignPatientToPractitioner } from "@/lib/patients";
import {
  createBooking,
  deleteBooking,
  setBookingCopagoPaid,
  listAgendaBookings,
} from "@/lib/bookings";
import { searchPatientsForAssignment } from "@/lib/diagnosis";
import { localToARIso } from "@/lib/datetime-ar";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

type Staff = { userId: string; practitionerId: string };

const ar = (day: string, hhmm: string) => new Date(localToARIso(`${day}T${hhmm}:00`)).toISOString();
const key = () => randomUUID();
const v = (d: Date) => d.toISOString();
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe.skipIf(!RUN)("P0.Z · hallazgos del revisor (b) de ES1", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  /** Kine con los pacientes a cargo (full). */
  let kine: Staff;
  /** Otro kine sin asignación ni share (basic). */
  let other: Staff;
  let assistant: Staff;
  let billing: Staff;
  /** Paciente con diagnóstico + plan activo + cobertura + visita + edad + email. */
  let pDx: string;
  /** Paciente del kine sin plan. */
  let pPlain: string;
  /** Paciente asignado a la Secretaria (dato de prod, precheck 15). */
  let pSec: string;
  let condSlug: string;
  let dxEmail: string;

  beforeAll(async () => {
    db = ownerClient();
    // Sin "Consultorio común": el acceso sale de la asignación/share.
    T = await createEphemeralTenant(db);
    kine = await addPractitioner(db, T, "PRACTITIONER");
    other = await addPractitioner(db, T, "PRACTITIONER");
    assistant = await addPractitioner(db, T, "ASSISTANT");
    billing = await addPractitioner(db, T, "BILLING");

    const s = uniqueSuffix();
    dxEmail = `dx-${s}@example.test`;
    condSlug = `pz-lumbalgia-${s}`;
    pDx = await addPatient(db, T, { assignedPractitionerId: kine.practitionerId, email: dxEmail, lastName: `Dx ${s}` });
    pPlain = await addPatient(db, T, { assignedPractitionerId: kine.practitionerId, lastName: `Plain ${s}` });
    pSec = await addPatient(db, T, { assignedPractitionerId: assistant.practitionerId, lastName: `Sec ${s}` });

    await db.patient.update({ where: { id: pDx }, data: { dateOfBirth: new Date("1980-05-10T00:00:00Z") } });
    await db.coverage.create({ data: { patientId: pDx, insurer: "OSDE-PZ" } });
    const cond = await db.condition.create({ data: { slug: condSlug, name: "Lumbalgia P0.Z", tenantId: T.tenantId } });
    const kase = await db.clinicalCase.create({
      data: { tenantId: T.tenantId, authorId: kine.practitionerId, selectedZones: [], refinements: {}, patientId: pDx },
    });
    await db.diagnosis.create({ data: { caseId: kase.id, conditionId: cond.id, matchScore: 0.9, rank: 1 } });
    await db.treatmentProgram.create({
      data: {
        tenantId: T.tenantId,
        patientId: pDx,
        caseId: kase.id,
        title: "Plan lumbar",
        startDate: new Date("2030-01-01T12:00:00Z"),
        status: "ACTIVE",
      },
    });
    await db.booking.create({
      data: {
        tenantId: T.tenantId,
        patientId: pDx,
        practitionerId: T.practitionerId,
        serviceId: T.serviceId,
        scheduledFor: new Date(ar("2030-02-01", "10:00")),
        durationMin: 45,
        status: "COMPLETED",
        idempotencyKey: key(),
      },
    });
  });

  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });

  // ── H-b1 ─────────────────────────────────────────────────────────────────

  it("[P0-Z] H-b1 listPatients: diagnóstico y con/sin plan no son oráculo para ASSISTANT, BILLING ni un kine en básico", async () => {
    for (const who of [assistant, billing, other]) {
      asUser(who.userId);
      expect(ids(await listPatients({ diagnosisSlug: condSlug }))).not.toContain(pDx);
      expect(ids(await listPatients({ filter: "active" }))).not.toContain(pDx);
      // "Sin plan" también delata (por exclusión) quién tiene plan.
      const noProgram = ids(await listPatients({ filter: "no-program" }));
      expect(noProgram).not.toContain(pPlain);
      expect(noProgram).not.toContain(pDx);
    }
    // Sin filtro clínico el directorio sigue mostrando a todos (proyección recortada).
    asUser(other.userId);
    expect(ids(await listPatients({}))).toEqual(expect.arrayContaining([pDx, pPlain, pSec]));
    asUser(assistant.userId);
    expect(ids(await listPatients({}))).toEqual(expect.arrayContaining([pDx, pPlain, pSec]));

    // Control: el kine a cargo filtra como siempre.
    asUser(kine.userId);
    expect(ids(await listPatients({ diagnosisSlug: condSlug }))).toEqual([pDx]);
    expect(ids(await listPatients({ filter: "active" }))).toContain(pDx);
    const noProg = ids(await listPatients({ filter: "no-program" }));
    expect(noProg).toContain(pPlain);
    expect(noProg).not.toContain(pDx);
    // OWNER: full sobre todo.
    asUser(T.userId);
    expect(ids(await listPatients({ diagnosisSlug: condSlug }))).toEqual([pDx]);
  });

  it("[P0-Z] H-b1 listPatients: obra social, edad, última visita y email no filtran filas basic (sí las `admin`, que ven esos datos)", async () => {
    const masked = [
      { insurer: "OSDE-PZ" },
      { ageMin: 40, ageMax: 60 },
      { lastVisitFrom: "2030-01-15", lastVisitTo: "2030-02-15" },
      { q: dxEmail },
    ];
    asUser(other.userId);
    for (const f of masked) expect(ids(await listPatients(f))).not.toContain(pDx);
    // `admin` (PD-13) ve contacto, cobertura, nacimiento y turnos en el perfil:
    // filtrar por eso no le revela nada nuevo.
    asUser(assistant.userId);
    for (const f of masked) expect(ids(await listPatients(f))).toContain(pDx);
    // Control: el kine a cargo.
    asUser(kine.userId);
    for (const f of masked) expect(ids(await listPatients(f))).toContain(pDx);
    // Nombre y DNI siguen buscando para basic.
    asUser(other.userId);
    const dni = (await db.patient.findUniqueOrThrow({ where: { id: pDx } })).documentId!;
    expect(ids(await listPatients({ q: dni }))).toContain(pDx);
  });

  // ── H-b2 ─────────────────────────────────────────────────────────────────

  it("[P0-Z] H-b2 una Secretaria asignada no maneja los shares del paciente", async () => {
    asUser(assistant.userId);
    const r = await setPatientShares({ patientId: pSec, practitionerIds: [other.practitionerId] });
    expect(r.ok).toBe(false);
    expect(await db.patientShare.count({ where: { patientId: pSec } })).toBe(0);

    // Control: el kine asignado sí comparte (y se limpia).
    asUser(kine.userId);
    const ok = await setPatientShares({ patientId: pDx, practitionerIds: [other.practitionerId] });
    expect(ok).toMatchObject({ ok: true });
    expect(await db.patientShare.count({ where: { patientId: pDx, practitionerId: other.practitionerId } })).toBe(1);
    expect(await setPatientShares({ patientId: pDx, practitionerIds: [] })).toMatchObject({ ok: true });
    expect(await db.patientShare.count({ where: { patientId: pDx } })).toBe(0);
  });

  it("[P0-Z] H-b2 assignPatientToPractitioner rechaza un destino sin rol clínico", async () => {
    asUser(T.userId);
    for (const target of [assistant, billing]) {
      const r = await assignPatientToPractitioner({ patientId: pPlain, practitionerId: target.practitionerId });
      expect(r.ok).toBe(false);
      const row = await db.patient.findUniqueOrThrow({ where: { id: pPlain } });
      expect(row.assignedPractitionerId).toBe(kine.practitionerId);
    }
    // Control: a otro kine sí, y de vuelta.
    expect(await assignPatientToPractitioner({ patientId: pPlain, practitionerId: other.practitionerId })).toMatchObject({ ok: true });
    expect((await db.patient.findUniqueOrThrow({ where: { id: pPlain } })).assignedPractitionerId).toBe(other.practitionerId);
    expect(await assignPatientToPractitioner({ patientId: pPlain, practitionerId: kine.practitionerId })).toMatchObject({ ok: true });
  });

  // ── H-b3 ─────────────────────────────────────────────────────────────────

  async function seedGuest(day: string, hhmm = "10:00") {
    return db.booking.create({
      data: {
        tenantId: T.tenantId,
        patientId: null,
        guestName: "Reserva telefónica",
        practitionerId: T.practitionerId,
        serviceId: T.serviceId,
        scheduledFor: new Date(ar(day, hhmm)),
        durationMin: 45,
        status: "PENDING",
        idempotencyKey: key(),
      },
    });
  }

  it("[P0-Z] H-b3 BILLING no crea turnos guest (ni con copago propio)", async () => {
    asUser(billing.userId);
    const r = await createBooking({
      serviceId: T.serviceId,
      practitionerId: T.practitionerId,
      scheduledFor: ar("2031-06-02", "10:00"),
      guestName: "Guest BILLING",
      copagoCents: 1,
      idempotencyKey: key(),
    });
    expect(r.ok).toBe(false);
    expect(await db.booking.count({ where: { tenantId: T.tenantId, guestName: "Guest BILLING" } })).toBe(0);

    // Control: la Secretaria crea el guest y fija su copago (intencional).
    asUser(assistant.userId);
    const ok = await createBooking({
      serviceId: T.serviceId,
      practitionerId: T.practitionerId,
      scheduledFor: ar("2031-06-02", "11:00"),
      guestName: "Guest Secretaria",
      copagoCents: 1234,
      idempotencyKey: key(),
    });
    expect(ok).toMatchObject({ ok: true });
    const row = await db.booking.findUniqueOrThrow({ where: { id: ok.ok ? ok.data.id : "" } });
    expect(row.copagoCents).toBe(1234);
  });

  it("[P0-Z] H-b3 BILLING no borra ni cobra un guest; la Secretaria y el kine sí (como hoy)", async () => {
    const g = await seedGuest("2031-06-09");
    asUser(billing.userId);
    expect((await deleteBooking(g.id, v(g.updatedAt))).ok).toBe(false);
    expect((await setBookingCopagoPaid(g.id, true, v(g.updatedAt))).ok).toBe(false);
    const row = await db.booking.findUniqueOrThrow({ where: { id: g.id } });
    expect(row.paymentStatus).toBe(g.paymentStatus);
    expect(+row.updatedAt).toBe(+g.updatedAt);

    // Controles.
    asUser(assistant.userId);
    const paid = await setBookingCopagoPaid(g.id, true, v(g.updatedAt));
    expect(paid).toMatchObject({ ok: true });
    expect((await db.booking.findUniqueOrThrow({ where: { id: g.id } })).paymentStatus).toBe("PAID");
    // (Un turno cobrado no se borra, regla aparte: el borrado va sobre otro guest.)
    const g1 = await seedGuest("2031-06-09", "11:00");
    expect(await deleteBooking(g1.id, v(g1.updatedAt))).toMatchObject({ ok: true });
    expect(await db.booking.count({ where: { id: g1.id } })).toBe(0);

    const g2 = await seedGuest("2031-06-09", "12:00");
    asUser(other.userId);
    expect(await deleteBooking(g2.id, v(g2.updatedAt))).toMatchObject({ ok: true });
    expect(await db.booking.count({ where: { id: g2.id } })).toBe(0);
  });

  it("[P0-Z] H-b3 listAgendaBookings: un guest no es operable para BILLING", async () => {
    const g = await seedGuest("2031-06-16");
    const range = { from: new Date(ar("2031-06-16", "00:00")), to: new Date(ar("2031-06-17", "00:00")) };
    asUser(billing.userId);
    expect((await listAgendaBookings(range)).find((r) => r.id === g.id)).toMatchObject({ canOperate: false });
    asUser(assistant.userId);
    expect((await listAgendaBookings(range)).find((r) => r.id === g.id)).toMatchObject({ canOperate: true });
    asUser(other.userId);
    expect((await listAgendaBookings(range)).find((r) => r.id === g.id)).toMatchObject({ canOperate: true });
  });

  // ── H-b4 ─────────────────────────────────────────────────────────────────

  it("[P0-Z] H-b4 searchPatientsForAssignment devuelve solo pacientes con acceso full", async () => {
    for (const who of [assistant, billing]) {
      asUser(who.userId);
      expect(await searchPatientsForAssignment("")).toEqual([]);
      expect(await searchPatientsForAssignment(dxEmail)).toEqual([]);
    }
    asUser(other.userId);
    expect(ids(await searchPatientsForAssignment(""))).not.toContain(pDx);
    expect(ids(await searchPatientsForAssignment(dxEmail))).not.toContain(pDx);

    // Control: el kine a cargo (y el que recibe un share) lo encuentran.
    asUser(kine.userId);
    const mine = await searchPatientsForAssignment(dxEmail);
    expect(ids(mine)).toEqual([pDx]);
    expect(mine[0].info).toContain("con plan activo");
    await db.patientShare.create({ data: { tenantId: T.tenantId, patientId: pDx, practitionerId: other.practitionerId } });
    asUser(other.userId);
    expect(ids(await searchPatientsForAssignment(dxEmail))).toEqual([pDx]);
    await db.patientShare.deleteMany({ where: { patientId: pDx } });
  });
});
