/**
 * CF3 (D-CF3-8, sesión SH-S) · `getPatientShareBundle` y el `nextBooking` del perfil `full`, contra la DB real.
 *
 * Lo que fija:
 *   - Acceso = el del contacto del drawer (`getPatientShareContact`): `full` (Titular) y `admin` (Secretaria, PD-13)
 *     reciben contacto y turnos; `basic` (kine sin el paciente) y un paciente de OTRO tenant → `{ contact: hidden }`
 *     sin nada más. Controles cruzados sobre el MISMO paciente para que «todo hidden» o «todo ok» no pase en verde.
 *   - Nada clínico: claves exactas de cada turno y ningún texto del título/notas/descripción del turno en el payload.
 *   - Próximos: futuros, sin cancelados ni ausentes, ordenados, ≤ 5; uno de las 23:30 AR cae en SU día con TZ=UTC.
 *   - `turneroUrl` null con el turnero cerrado; con él abierto, el link del consultorio.
 *   - Permisos de cobro (con `MP_CONNECT_MODE=fake`) y de portal.
 * Solo se mockea la sesión (tests/helpers/actor) y el entorno de MP.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { getPatientShareBundle } from "@/lib/booking-share-actions";
import { loadPatientProfilePage } from "@/lib/patient-profile-loader";
import { upcomingBookingsText, bookingReminderText } from "@/lib/booking-share";
import { localToARIso, toARDateKey } from "@/lib/datetime-ar";
import { getActor } from "@/lib/session";
import type { PatientShareBundleVisible } from "@/lib/patient-share-types";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";
const DAY = 86_400_000;

const UPCOMING_KEYS = [
  "bookingId",
  "canPaymentLink",
  "durationMin",
  "locationName",
  "practitionerName",
  "serviceName",
  "startsAt",
  "telemedicineUrl",
].sort();
const BUNDLE_KEYS = [
  "canPaymentLink",
  "canPortalInvite",
  "clinicName",
  "contact",
  "firstName",
  "turneroUrl",
  "upcoming",
].sort();

function visible(b: Awaited<ReturnType<typeof getPatientShareBundle>>): PatientShareBundleVisible {
  if (b.contact.status === "hidden") throw new Error("esperaba contacto visible, vino hidden");
  return b as PatientShareBundleVisible;
}

describe.skipIf(!RUN)("[CF3-SHS] getPatientShareBundle", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let C: EphemeralTenant; // turnero cerrado
  let X: EphemeralTenant;
  let secretaria: { userId: string; practitionerId: string };
  let kineBasico: { userId: string; practitionerId: string };
  let patientId: string;
  let lateKey: string;
  let lateId: string;
  let ids: Record<string, string>;
  let cPatient: string;
  let xPatient: string;
  const prevMp = process.env.MP_CONNECT_MODE;

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db, { sharedPatientView: false });
    C = await createEphemeralTenant(db, { publicBookingEnabled: false });
    X = await createEphemeralTenant(db);
    secretaria = await addPractitioner(db, T, "ASSISTANT");
    kineBasico = await addPractitioner(db, T, "PRACTITIONER");
    patientId = await addPatient(db, T, {
      firstName: "Lucía",
      phone: "0351 155 123456",
      email: `shs-${randomUUID().slice(0, 8)}@test.local`,
      notes: "Nota clínica privada",
    });
    // Dos sedes activas: con más de una, el turno con sede la nombra.
    const sedeA = await db.location.create({ data: { tenantId: T.tenantId, name: "Sede Centro", isPrimary: true } });
    const sedeB = await db.location.create({ data: { tenantId: T.tenantId, name: "Sede Norte" } });

    const mk = async (
      at: Date,
      extra: Partial<{
        status: "CONFIRMED" | "CANCELLED" | "NO_SHOW" | "PENDING";
        practitionerId: string;
        locationId: string;
        isTelemedicine: boolean;
        telemedicineUrl: string;
        patientId: string;
        tenantId: string;
        serviceId: string;
      }> = {}
    ) =>
      (
        await db.booking.create({
          data: {
            tenantId: extra.tenantId ?? T.tenantId,
            patientId: extra.patientId ?? patientId,
            practitionerId: extra.practitionerId ?? T.practitionerId,
            serviceId: extra.serviceId ?? T.serviceId,
            scheduledFor: at,
            durationMin: 45,
            status: extra.status ?? "CONFIRMED",
            locationId: extra.locationId ?? sedeA.id,
            isTelemedicine: extra.isTelemedicine ?? false,
            telemedicineUrl: extra.telemedicineUrl,
            idempotencyKey: randomUUID(),
            title: "Lumbalgia crónica",
            description: "Irradiada a pierna",
            notes: "Refiere dolor 8/10",
          },
        })
      ).id;

    const now = Date.now();
    // 23:30 AR de dentro de 10 días = 02:30 UTC del día siguiente: con TZ=UTC el día «del host» sería otro.
    lateKey = toARDateKey(new Date(now + 10 * DAY));
    ids = {
      past: await mk(new Date(now - 2 * DAY)),
      d1: await mk(new Date(now + 1 * DAY), { practitionerId: kineBasico.practitionerId }),
      d2tele: await mk(new Date(now + 2 * DAY), { isTelemedicine: true, telemedicineUrl: "https://meet.example/abc" }),
      d3norte: await mk(new Date(now + 3 * DAY), { locationId: sedeB.id }),
      cancelled: await mk(new Date(now + 4 * DAY), { status: "CANCELLED" }),
      noShow: await mk(new Date(now + 5 * DAY), { status: "NO_SHOW" }),
      d15: await mk(new Date(now + 15 * DAY)),
      d20: await mk(new Date(now + 20 * DAY)),
    };
    lateId = await mk(new Date(localToARIso(`${lateKey}T23:30`)));

    cPatient = await addPatient(db, C, { phone: "11 2345 6789" });
    xPatient = await addPatient(db, X, { phone: "11 2345 6789" });
  });

  afterEach(() => {
    if (prevMp === undefined) delete process.env.MP_CONNECT_MODE;
    else process.env.MP_CONNECT_MODE = prevMp;
  });

  afterAll(async () => {
    await T?.cleanup();
    await C?.cleanup();
    await X?.cleanup();
    await db?.$disconnect();
  });

  it("[CF3-SHS1] Secretaria (admin): contacto + próximos turnos, sin una sola clave ni texto clínico", async () => {
    asUser(secretaria.userId);
    const b = visible(await getPatientShareBundle(patientId));
    expect(Object.keys(b).sort()).toEqual(BUNDLE_KEYS);
    expect(b.contact).toMatchObject({ status: "ok", e164: "+5493515123456" });
    expect(b.contact.phone).toMatchObject({
      e164: "+5493515123456",
      waChatHref: "https://wa.me/5493515123456",
      telHref: "tel:0351155123456",
      display: "0351 155 123456",
      reason: null,
    });
    expect(b.firstName).toBe("Lucía");
    expect(b.clinicName).toBe((await db.tenant.findUniqueOrThrow({ where: { id: T.tenantId } })).name);
    for (const u of b.upcoming) expect(Object.keys(u).sort()).toEqual(UPCOMING_KEYS);
    const json = JSON.stringify(b);
    for (const clinical of ["Lumbalgia", "Irradiada", "Refiere", "Nota clínica"]) expect(json).not.toContain(clinical);
    // La Secretaria cobra (billing.collect) pero el portal expone la HC: solo `full` invita.
    expect(b.canPortalInvite).toBe(false);
  });

  it("[CF3-SHS2] próximos: futuros, sin cancelados ni ausentes, ordenados y ≤ 5; sede y videollamada solo cuando van", async () => {
    asUser(T.userId);
    const b = visible(await getPatientShareBundle(patientId));
    expect(b.upcoming.map((u) => u.bookingId)).toEqual([ids.d1, ids.d2tele, ids.d3norte, lateId, ids.d15]);
    const byId = Object.fromEntries(b.upcoming.map((u) => [u.bookingId, u]));
    expect(byId[ids.d2tele].telemedicineUrl).toBe("https://meet.example/abc");
    expect(byId[ids.d1].telemedicineUrl).toBeNull();
    expect(byId[ids.d3norte].locationName).toBe("Sede Norte");
    expect(byId[ids.d1].locationName).toBe("Sede Centro");
    expect(byId[ids.d1]).toMatchObject({ serviceName: "Consulta", durationMin: 45 });
    // Nombre público del profesional, nunca el email.
    for (const u of b.upcoming) expect(u.practitionerName).not.toContain("@");
  });

  it("[CF3-SHS3] turno de las 23:30 AR con TZ=UTC: queda en su día AR (ISO + texto)", async () => {
    expect(new Date().getTimezoneOffset()).toBe(0); // el script de integración corre con TZ=UTC
    asUser(T.userId);
    const b = visible(await getPatientShareBundle(patientId));
    const late = b.upcoming.find((u) => u.bookingId === lateId)!;
    expect(toARDateKey(late.startsAt)).toBe(lateKey);
    expect(late.startsAt.slice(0, 10)).not.toBe(lateKey); // en UTC ya es el día siguiente
    const text = upcomingBookingsText({
      firstName: b.firstName,
      clinicName: b.clinicName,
      bookings: b.upcoming.map((u) => ({ ...u, startsAt: new Date(u.startsAt) })),
    });
    const day = String(Number(lateKey.slice(8, 10))).padStart(2, "0");
    expect(text).toMatch(new RegExp(`${day} de .*23:30`));
  });

  it("[CF3-SHS4] kine sin el paciente (basic) → hidden y nada más; el Titular sobre el mismo paciente sí lo ve", async () => {
    asUser(kineBasico.userId);
    expect(await getPatientShareBundle(patientId)).toEqual({ contact: { status: "hidden" } });
    asUser(T.userId);
    expect((await getPatientShareBundle(patientId)).contact.status).toBe("ok");
  });

  it("[CF3-SHS5] paciente de otro tenant, inexistente o basura → hidden", async () => {
    asUser(T.userId);
    for (const id of [xPatient, cPatient, "no-existe", "", "x".repeat(500)]) {
      expect(await getPatientShareBundle(id)).toEqual({ contact: { status: "hidden" } });
    }
  });

  it("[CF3-SHS6] turnero cerrado → turneroUrl null; abierto → link absoluto del consultorio", async () => {
    asUser(C.userId);
    const closed = visible(await getPatientShareBundle(cPatient));
    expect(closed.turneroUrl).toBeNull();
    expect(closed.upcoming).toEqual([]);
    asUser(T.userId);
    const open = visible(await getPatientShareBundle(patientId));
    expect(open.turneroUrl).toMatch(new RegExp(`^https?://[^/]+/c/${T.slug}/booking$`));
  });

  it("[CF3-SHS7] link de pago: nunca con cobros online apagados; con ellos, por permiso de cobro y profesional", async () => {
    delete process.env.MP_CONNECT_MODE;
    asUser(T.userId);
    const off = visible(await getPatientShareBundle(patientId));
    expect(off.canPaymentLink).toBe(false);
    expect(off.upcoming.every((u) => !u.canPaymentLink)).toBe(true);

    process.env.MP_CONNECT_MODE = "fake";
    const owner = visible(await getPatientShareBundle(patientId));
    expect(owner.canPaymentLink).toBe(true);
    expect(owner.upcoming.every((u) => u.canPaymentLink)).toBe(true);

    asUser(secretaria.userId);
    const desk = visible(await getPatientShareBundle(patientId));
    expect(desk.canPaymentLink).toBe(true);
    expect(desk.upcoming.every((u) => u.canPaymentLink)).toBe(true);
  });

  it("[CF3-SHS8] invitar al portal: full con email sí; full sin email no", async () => {
    asUser(T.userId);
    expect(visible(await getPatientShareBundle(patientId)).canPortalInvite).toBe(true);
    const noEmail = await addPatient(db, T, { phone: "011 4321-5678" });
    const b = visible(await getPatientShareBundle(noEmail));
    expect(b.canPortalInvite).toBe(false);
    // Fijo: se puede llamar pero no va a WhatsApp.
    expect(b.contact).toMatchObject({ status: "invalid", reason: "landline" });
    expect(b.contact.phone.waChatHref).toBeNull();
    expect(b.contact.phone.telHref).toBe("tel:01143215678");
  });

  it("[CF3-SHS9] perfil full: `nextBooking` es el próximo real (no el más lejano de recentBookings) y sin texto clínico", async () => {
    asUser(T.userId);
    const actor = await getActor();
    const r = await loadPatientProfilePage(actor, patientId, null);
    if (r.access !== "full") throw new Error(`esperaba full, vino ${r.access}`);
    const b = visible(await getPatientShareBundle(patientId));
    const { canPaymentLink: _ignored, ...first } = b.upcoming[0];
    expect(r.nextBooking).toEqual(first);
    expect(r.nextBooking?.bookingId).toBe(ids.d1);
    // recentBookings sigue siendo «los 5 más lejanos» (no se tocó): el más lejano primero.
    expect(r.recentBookings[0].id).toBe(ids.d20);
    expect(JSON.stringify(r.nextBooking)).not.toMatch(/Lumbalgia|Refiere|Irradiada/);
    const reminder = bookingReminderText(
      { patientName: r.core.firstName, serviceName: r.nextBooking!.serviceName, scheduledFor: r.nextBooking!.startsAt, durationMin: r.nextBooking!.durationMin },
      { clinicName: b.clinicName, locationName: r.nextBooking!.locationName }
    );
    expect(reminder).toContain(`en ${b.clinicName}`);
    expect(reminder).toContain(", en Sede Centro");
  });
});
