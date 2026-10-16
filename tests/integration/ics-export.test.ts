/**
 * P0-S02p — export `.ics` de la agenda con la regla única de campos
 * (`bookingFieldAccess`, Planes E1/C8): el detalle (título, descripción,
 * notas) sale solo si el actor puede LEER ese campo en la agenda.
 *
 * Bug vivo que motiva la sesión: el ICS gateaba solo con `access !== "full"`.
 * La Secretaria (ASSISTANT, sin `clinical.read`) con `sharedPatientView`
 * recibía `full` y exportaba título/descripción/notas clínicas de todos los
 * turnos. Con PD-13 queda en `admin`, pero el ICS además mira `clinical.read`
 * (no alcanza con el nivel): así un turno guest tampoco le exporta el título.
 *
 * Se llama al símbolo real `exportBookingsIcs` (la ruta solo le suma
 * rate-limit y tope de rango); solo se mockea la sesión de Supabase.
 *
 * ES4 S24i — «Sesión n/N» en el SUMMARY: «Kine · Sesión 2/3 · <servicio> · <paciente>».
 * El ordinal es M13 (`planSessionOrdinals`: por fecha entre las sesiones vivas),
 * no el `index` ni `totalSessions`: el fixture los hace diverger a propósito
 * (sesión reservada con index 3, una archivada anterior y una posterior). Lo
 * ven todos los que ven el turno (V1-D18); el título del plan y la autorización
 * de la OS no salen nunca (E2/C9). En General (sin módulo `planes`) no hay
 * «Sesión» aunque el turno tenga `programId`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { exportBookingsIcs } from "@/lib/bookings-export-internal";
import { getActor } from "@/lib/session";
import { localToARIso } from "@/lib/datetime-ar";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";
const ar = (day: string, hhmm: string) => new Date(localToARIso(`${day}T${hhmm}:00`));
const RANGE = { from: ar("2027-09-06", "00:00"), to: ar("2027-09-07", "00:00") };

describe.skipIf(!RUN)("P0-S02p · ICS con bookingFieldAccess", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let assistant: { userId: string; practitionerId: string };
  let billing: { userId: string; practitionerId: string };
  let patientBookingId: string;
  let guestBookingId: string;

  beforeAll(async () => {
    db = ownerClient();
    // "Consultorio común" encendido: es el caso que antes le daba full.
    T = await createEphemeralTenant(db, { sharedPatientView: true });
    assistant = await addPractitioner(db, T, "ASSISTANT");
    billing = await addPractitioner(db, T, "BILLING");
    const patientId = await addPatient(db, T, { firstName: "Rosa", lastName: "Agenda" });
    const withPatient = await db.booking.create({
      data: {
        tenantId: T.tenantId,
        patientId,
        practitionerId: T.practitionerId,
        serviceId: T.serviceId,
        scheduledFor: ar("2027-09-06", "10:00"),
        durationMin: 45,
        status: "CONFIRMED",
        idempotencyKey: randomUUID(),
        title: "Lumbalgia aguda",
        description: "Detalle clínico L4-L5",
        notes: "Nota clínica del turno",
      },
    });
    patientBookingId = withPatient.id;
    const guest = await db.booking.create({
      data: {
        tenantId: T.tenantId,
        patientId: null,
        guestName: "Invitado Guest",
        practitionerId: T.practitionerId,
        serviceId: T.serviceId,
        scheduledFor: ar("2027-09-06", "12:00"),
        durationMin: 30,
        status: "PENDING",
        idempotencyKey: randomUUID(),
        title: "Cervicalgia guest",
        description: "Descripción guest",
        notes: "Trae orden médica",
      },
    });
    guestBookingId = guest.id;
  });

  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });

  // ─── ES4 S24i · «Sesión n/N» ───────────────────────────────────────────────
  let planBookingId: string;
  beforeAll(async () => {
    const patientId = await addPatient(db, T, { firstName: "Plano", lastName: "Sesiones" });
    const program = await db.treatmentProgram.create({
      data: {
        tenantId: T.tenantId,
        patientId,
        title: "Plan lumbar confidencial",
        discipline: "KINESIOLOGY",
        totalSessions: 10, // caché vieja: el total que sale es el de las vivas (3)
        startDate: ar("2027-09-01", "00:00"),
      },
    });
    const mk = (index: number, day: string, archived = false) =>
      db.session.create({
        data: {
          programId: program.id,
          practitionerId: T.practitionerId,
          index,
          scheduledFor: ar(day, "15:00"),
          archivedAt: archived ? new Date() : null,
        },
      });
    await mk(1, "2027-09-01");
    await mk(2, "2027-09-20");
    const booked = await mk(3, "2027-09-06"); // ordinal por fecha = 2
    await mk(4, "2027-08-01", true); // archivada: no cuenta
    await db.programAuthorization.create({
      data: { tenantId: T.tenantId, programId: program.id, code: "AUT-OS-7788", authorizedSessions: 10, startsOn: ar("2027-09-01", "00:00") },
    });
    const b = await db.booking.create({
      data: {
        tenantId: T.tenantId,
        patientId,
        practitionerId: T.practitionerId,
        serviceId: T.serviceId,
        programId: program.id,
        sessionId: booked.id,
        scheduledFor: ar("2027-09-06", "15:00"),
        durationMin: 45,
        status: "CONFIRMED",
        idempotencyKey: randomUUID(),
      },
    });
    planBookingId = b.id;
  });

  const summaryOf = (out: string, id: string) => {
    const ev = out.split("BEGIN:VEVENT").find((e) => e.includes(`UID:${id}@kinesoft`)) ?? "";
    return /SUMMARY:(.*)/.exec(ev)?.[1]?.trim() ?? "";
  };

  it("[S24i] ICS: turno de plan Kine sale como «Kine · Sesión 2/3 · <servicio>» (ordinal M13 por fecha)", async () => {
    asUser(T.userId);
    const out = await exportBookingsIcs(await getActor(), RANGE);
    const s = summaryOf(out, planBookingId);
    expect(s).toMatch(/^Kine · Sesión 2\/3 · /);
    expect(s).toContain("Plano Sesiones");
    // Un turno suelto no lleva «Sesión».
    expect(summaryOf(out, patientBookingId)).not.toMatch(/Sesión/);
  });

  it("[S24i] ICS: ASSISTANT y BILLING ven «Sesión n/N» pero nunca el título del plan ni la autorización de la OS", async () => {
    for (const u of [assistant.userId, billing.userId, T.userId]) {
      asUser(u);
      const out = await exportBookingsIcs(await getActor(), RANGE);
      if (u !== T.userId) {
        expect(summaryOf(out, planBookingId)).toMatch(/^Kine · Sesión 2\/3 · /);
        expect(out).not.toMatch(/Plan lumbar confidencial/);
      }
      expect(out).not.toMatch(/AUT-OS-7788/);
    }
  });

  it("[P0-S02p] ICS: ASSISTANT con sharedPatientView no exporta title/description/notes", async () => {
    asUser(assistant.userId);
    const out = await exportBookingsIcs(await getActor(), RANGE);
    // Ve los turnos (nombre, hora, servicio): opera la agenda de todos.
    expect(out).toContain(`UID:${patientBookingId}@kinesoft`);
    expect(out).toContain("Rosa Agenda");
    // Nada clínico del turno con paciente.
    expect(out).not.toMatch(/Lumbalgia|Detalle clínico|Nota clínica/);
  });

  it("ASSISTANT: en un guest exporta la nota administrativa pero no título ni descripción", async () => {
    asUser(assistant.userId);
    const out = await exportBookingsIcs(await getActor(), RANGE);
    expect(out).toContain(`UID:${guestBookingId}@kinesoft`);
    expect(out).toContain("Trae orden médica");
    expect(out).not.toMatch(/Cervicalgia guest|Descripción guest/);
  });

  it("BILLING tampoco exporta detalle clínico", async () => {
    asUser(billing.userId);
    const out = await exportBookingsIcs(await getActor(), RANGE);
    expect(out).toContain(`UID:${patientBookingId}@kinesoft`);
    expect(out).not.toMatch(/Lumbalgia|Detalle clínico|Nota clínica|Cervicalgia guest/);
  });

  it("control: el OWNER (full + clinical.read) exporta todo el detalle", async () => {
    asUser(T.userId);
    const out = await exportBookingsIcs(await getActor(), RANGE);
    expect(out).toMatch(/Lumbalgia aguda/);
    expect(out).toMatch(/Detalle clínico L4-L5/);
    expect(out).toMatch(/Nota clínica del turno/);
    expect(out).toMatch(/Cervicalgia guest/);
    expect(out).toMatch(/Trae orden médica/);
  });
});

describe.skipIf(!RUN)("ES4 S24i · ICS en vertical General", () => {
  let db: PrismaClient;
  let G: EphemeralTenant;
  let bookingId: string;

  beforeAll(async () => {
    db = ownerClient();
    G = await createEphemeralTenant(db, { vertical: "GENERAL" });
    const patientId = await addPatient(db, G, { firstName: "Gral", lastName: "Paciente" });
    // Un plan heredado (de cuando el consultorio era Kine): el turno lo referencia,
    // pero General no tiene el módulo `planes` → nada de «Sesión».
    const program = await db.treatmentProgram.create({
      data: { tenantId: G.tenantId, patientId, title: "Plan heredado", discipline: "KINESIOLOGY", startDate: ar("2027-09-01", "00:00") },
    });
    const session = await db.session.create({
      data: { programId: program.id, practitionerId: G.practitionerId, index: 1, scheduledFor: ar("2027-09-06", "10:00") },
    });
    const b = await db.booking.create({
      data: {
        tenantId: G.tenantId,
        patientId,
        practitionerId: G.practitionerId,
        serviceId: G.serviceId,
        programId: program.id,
        sessionId: session.id,
        scheduledFor: ar("2027-09-06", "10:00"),
        durationMin: 30,
        status: "CONFIRMED",
        idempotencyKey: randomUUID(),
      },
    });
    bookingId = b.id;
  });

  afterAll(async () => {
    await G?.cleanup();
    await db?.$disconnect();
  });

  it("[S24i] ICS General: sin «Sesión» ni disciplina aunque el turno tenga plan", async () => {
    asUser(G.userId);
    const out = await exportBookingsIcs(await getActor(), RANGE);
    expect(out).toContain(`UID:${bookingId}@kinesoft`);
    expect(out).toContain("Gral Paciente");
    expect(out).not.toMatch(/Sesión|Kine ·|Plan heredado/);
  });
});
