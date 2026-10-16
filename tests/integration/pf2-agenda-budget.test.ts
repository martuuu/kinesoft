/**
 * PF2-c · presupuesto de `/agenda` y de `previewRecurrence` (C-PF8, brief-pf §2.4).
 *
 * Contratos:
 *   - `/agenda` ≤ 3 tx (antes 8): turnos (`listAgendaBookings`, su tx), bootstrap en UNA tx y disponibilidad
 *     (`getAgendaAvailability`). Se mide `loadAgendaPage` (el loader REAL de la página, mismos argumentos: el Actor,
 *     el lunes de la semana y `?patient=`), en los dos roles (RLS aplicado y owner BYPASSRLS).
 *   - Sin cambio observable: lo que el loader entrega es igual a lo que la página armaba antes con los lectores de
 *     siempre (`listServices`, `listPractitioners`, `listInsurers`, `getTenantSettings`, `listLocations`,
 *     `listRoomOptions`, `getCapabilities`, `getAgendaAvailability`), y los turnos decodificados del cable son, byte
 *     a byte, `listAgendaBookings(...).map(toBookingDTO)`.
 *   - Sin directorio de pacientes: `patients` es solo el del deep-link, leído por id (ajeno o archivado → vacío).
 *   - `previewRecurrence` mensual de 20 fechas: ≤ 40 sentencias y 1 tx (antes ~106: una carga del motor por ventana
 *     de 62 días). Resultado idéntico (`items`, `summary`, `counts`) al algoritmo anterior (`legacyPreview`, copia
 *     literal del cuerpo de antes de PF2-c) sobre 3 recurrencias, incluida una mensual con fin de mes y una que cruza
 *     la medianoche. Correr también con TZ=America/Argentina/Buenos_Aires (ver el reporte de PF2-c).
 *   - Payload de la semana (≤ 400 kB, `agendaPayloadBytes`): sobre el fixture de volumen de A1 (el mismo de
 *     `tests/perf/loaders.perf.test.ts`, 1.008 turnos en la semana): 802.569 → 317.049 bytes al cerrar PF2-c, con el
 *     cable decodificado idéntico al DTO de antes. `PF2_VOLUME=0` lo saltea.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});

import type { PrismaClient } from "@prisma/client";
import { measure } from "@/tests/helpers/query-counter";
import { loadAgendaPage } from "@/lib/agenda-page-loader";
import { decodeAgendaWire } from "@/lib/agenda-wire";
import { listAgendaBookings, listPractitioners, listServices } from "@/lib/bookings";
import { listInsurers } from "@/lib/insurers";
import { getTenantSettings } from "@/lib/tenant-settings";
import { listLocations } from "@/lib/locations";
import { listRoomOptions } from "@/lib/rooms";
import { getCapabilities } from "@/lib/authz";
import { getUserPreferences } from "@/lib/preferences";
import { getAgendaAvailability, previewRecurrence } from "@/lib/availability-actions";
import { getActor } from "@/lib/session";
import { runWithRls } from "@/lib/rls";
import { displayMemberName } from "@/lib/display-name";
import { toBookingDTO } from "@/components/agenda/agenda-utils";
import { loadAvailabilityInputs, type LoadedAvailabilityInput } from "@/lib/availability-loader";
import {
  addDays,
  classifyBatchInstant,
  classifyInstant,
  dayKeyDiff,
  dayKeyOf,
  dayWindow,
  expandDates,
  resolvePractitionerService,
  scheduledRanges,
  summarizeRange,
  type ClassifyInstantInput,
} from "@/lib/availability";
import { formatWallTime, minutesOfDayAR } from "@/lib/availability/day";
import { modulesFor } from "@/lib/tenant-modules";
import { bookingUnitOf } from "@/lib/copy/booking-unit";
import { toARDateKey } from "@/lib/datetime-ar";
import { weekStartKey } from "@/lib/agenda-client-state";
import type { RecurrencePreviewItem, RecurrencePreviewQueryInput } from "@/lib/availability-actions-types";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  addInsurer,
  addRoom,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";
// El fixture de volumen tarda ~5 s en local: corre siempre; `PF2_VOLUME=0` lo saltea.
const VOLUME = process.env.PF2_VOLUME !== "0";

const MONDAY = "2027-03-08";
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-03:00`);

/** Lo que la página armaba ANTES de PF2-c (app/(app)/agenda/page.tsx a HEAD 633cdee), con los mismos lectores. */
async function legacyAgendaProps(monday: string) {
  const sunday = addDays(monday, 6);
  const [bookings, services, practitioners, insurers, settings, locations, rooms, caps, prefs] = await Promise.all([
    listAgendaBookings({ from: dayWindow(monday).start, to: dayWindow(sunday).end }),
    listServices(),
    listPractitioners(),
    listInsurers({ onlyActive: true }),
    getTenantSettings(),
    listLocations().catch(() => []),
    listRoomOptions().catch(() => []),
    getCapabilities().then((c) => [...c] as string[]),
    getUserPreferences().then((p) => p.agendaView),
  ]);
  const locationId = locations.some((l) => l.id === prefs.locationId) ? prefs.locationId : null;
  const av = await getAgendaAvailability({ from: monday, to: sunday, locationId });
  return {
    bookings: bookings.map(toBookingDTO),
    services: services.map((s) => ({
      id: s.id,
      name: s.name,
      durationMin: s.durationMin,
      priceCents: s.priceCents,
      color: s.color,
      discipline: s.discipline,
    })),
    practitioners: practitioners.map((p) => ({ id: p.id, name: displayMemberName(p.user.fullName) })),
    insurers: insurers.filter((i) => !i.isParticular).map((i) => ({ id: i.id, name: i.name })),
    businessHours: {
      start: settings.businessHoursStart,
      end: settings.businessHoursEnd,
      slotMinutes: settings.agendaSlotMinutes,
    },
    locations: locations.map((l) => ({ id: l.id, name: l.name, isPrimary: l.isPrimary })),
    rooms,
    capabilities: caps,
    agendaView: prefs,
    availability: av.ok ? av.data : null,
  };
}

/** Copia literal del cuerpo de `previewRecurrence` antes de PF2-c (una carga del motor por ventana de 62 días). */
async function legacyPreview(q: RecurrencePreviewQueryInput) {
  const actor = await getActor();
  const tenantId = actor.tenantId;
  const locationId = q.locationId ?? null;
  const patientId = q.patientId ?? null;
  const anchor = new Date(q.anchor);
  const dates = expandDates({ anchor, count: q.count, daysOfWeek: q.daysOfWeek, frequency: q.frequency });
  const chunks: Date[][] = [];
  for (const d of dates) {
    const last = chunks[chunks.length - 1];
    if (last && dayKeyDiff(dayKeyOf(last[0]), dayKeyOf(d)) <= 62) last.push(d);
    else chunks.push([d]);
  }
  const inputs = await runWithRls(tenantId, async (tx) => {
    const out: { dates: Date[]; input: LoadedAvailabilityInput }[] = [];
    for (const group of chunks) {
      const lastEnd = new Date(group[group.length - 1].getTime() + (q.durationMin ?? 480) * 60_000);
      const input = await loadAvailabilityInputs(tx, {
        tenantId,
        practitionerIds: [q.practitionerId],
        serviceId: q.serviceId,
        locationId: locationId ?? undefined,
        patientId: patientId ?? undefined,
        from: dayKeyOf(group[0]),
        to: dayKeyOf(lastEnd),
      });
      out.push({ dates: group, input });
    }
    return out;
  });
  const first = inputs[0].input;
  const service = first.services.find((s) => s.id === q.serviceId)!;
  const rule = first.practitionerServices.find((r) => r.practitionerId === q.practitionerId && r.serviceId === q.serviceId);
  const eff = resolvePractitionerService(rule, service, q.practitionerId);
  const durationMin = q.durationMin ?? eff.durationMin;
  const now = new Date();
  const items: RecurrencePreviewItem[] = [];
  for (const { dates: group, input } of inputs) {
    const base: Omit<ClassifyInstantInput, "when"> = {
      durationMin,
      patientId,
      practitionerId: q.practitionerId,
      serviceId: q.serviceId,
      locationId,
      cap: eff.cap,
      rangesFor: (pid, dayKey) => scheduledRanges(pid, dayKey, input, { locationId }),
      blocks: input.blocks,
      bookings: input.bookings,
      now,
    };
    for (const when of group) {
      const batch = classifyBatchInstant({ ...base, when });
      const full = classifyInstant({ ...base, when });
      const reasons = batch.blockIds
        .map((id) => input.blocks.find((b) => b.id === id)?.reason?.trim())
        .filter((r): r is string => !!r);
      items.push({
        iso: when.toISOString(),
        dayKey: dayKeyOf(when),
        time: formatWallTime(Math.floor(minutesOfDayAR(when))),
        status: batch.status,
        class: full.class,
        outOfHours: batch.outOfHours,
        blocked: batch.blocked,
        blockReasons: Array.from(new Set(reasons)),
        used: batch.used,
        cap: batch.cap,
      });
    }
  }
  const counts = { libre: 0, sobreturno: 0, duplicado: 0, outOfHours: 0, blocked: 0 };
  for (const it of items) {
    counts[it.status]++;
    if (it.outOfHours) counts.outOfHours++;
    if (it.blocked) counts.blocked++;
  }
  return {
    frequency: q.frequency,
    summary: summarizeRange(dates, q.frequency, bookingUnitOf(modulesFor(actor.entitlements))),
    durationMin,
    requested: q.count,
    items,
    counts,
  };
}

describe.skipIf(!RUN)("PF2-c · /agenda ≤ 3 tx, sin directorio, cable idéntico", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let other: EphemeralTenant;
  let assistant: { userId: string; practitionerId: string };
  let patient: string;
  let archived: string;
  let foreignPatient: string;
  let norte: string;
  let osteo: string;

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    other = await createEphemeralTenant(db);
    assistant = await addPractitioner(db, T, "ASSISTANT");
    const kine2 = await addPractitioner(db, T, "PRACTITIONER");
    const { roomId, locationId: principal } = await addRoom(db, T, { name: "Box 1" });
    norte = (await db.location.create({ data: { tenantId: T.tenantId, name: "Norte" } })).id;
    const archivedLoc = (await db.location.create({ data: { tenantId: T.tenantId, name: "Sur", active: false } })).id;
    osteo = (
      await db.service.create({
        data: { tenantId: T.tenantId, practitionerId: T.practitionerId, name: "Osteo", durationMin: 60, priceCents: 9000, color: "#123456" },
      })
    ).id;
    await addInsurer(db, T, { name: `OS ${uniqueSuffix()}`, copagoCents: 120000 });
    patient = await addPatient(db, T, { firstName: "Deep", lastName: "Link" });
    archived = await addPatient(db, T);
    await db.patient.update({ where: { id: archived }, data: { archivedAt: new Date() } });
    foreignPatient = await addPatient(db, other);
    await db.practitionerSchedule.create({
      data: { tenantId: T.tenantId, practitionerId: T.practitionerId, locationId: principal, dow: 2, startMin: 540, endMin: 780, roomId },
    });
    const mk = (data: Record<string, unknown>) =>
      db.booking.create({
        data: {
          tenantId: T.tenantId,
          practitionerId: T.practitionerId,
          serviceId: T.serviceId,
          durationMin: 45,
          status: "CONFIRMED",
          idempotencyKey: `pf2c-${uniqueSuffix()}`,
          ...data,
        } as never,
      });
    await mk({ patientId: patient, scheduledFor: at("2027-03-09", "10:00"), roomId, locationId: principal });
    await mk({ patientId: patient, scheduledFor: at("2027-03-10", "11:00"), notes: "nota", title: "Control", isOverbooked: true, locationId: norte });
    await mk({ patientId: null, guestName: "Invitada", scheduledFor: at("2027-03-11", "09:00"), serviceId: osteo, practitionerId: kine2.practitionerId });
    await mk({ patientId: archived, scheduledFor: at("2027-03-12", "12:00"), locationId: archivedLoc, paymentStatus: "PAID", isTelemedicine: true, telemedicineUrl: "https://x.test/a" });
    await mk({ patientId: patient, scheduledFor: at("2027-03-13", "08:00"), status: "CANCELLED" });
  });

  afterAll(async () => {
    await T?.cleanup();
    await other?.cleanup();
    await db?.$disconnect();
  });

  for (const who of ["owner", "assistant"] as const) {
    it(`[${who}] ≤ 3 tx y mismo resultado que los lectores de antes`, async () => {
      asUser(who === "owner" ? T.userId : assistant.userId);
      const actor = await getActor();
      const { result: data, m } = await measure(() => loadAgendaPage(actor, { monday: MONDAY, patientId: null }));
      console.log(`[PF2-c] /agenda (${who}): ${m.transactions} tx, ${m.statements} sentencias`);
      expect(m.transactions).toBeLessThanOrEqual(3);

      const { result: before, m: mBefore } = await measure(() => legacyAgendaProps(MONDAY));
      console.log(`[PF2-c] /agenda antes (${who}, sin listPatients): ${mBefore.transactions} tx, ${mBefore.statements} sentencias`);
      const decoded = decodeAgendaWire(data.bookings, { services: data.services, locations: data.locations });
      expect(decoded.length).toBe(5);
      expect(JSON.stringify(decoded)).toBe(JSON.stringify(before.bookings));
      expect(data.services).toEqual(before.services);
      expect(data.practitioners).toEqual(before.practitioners);
      expect(data.insurers).toEqual(before.insurers);
      expect(data.businessHours).toEqual(before.businessHours);
      expect(data.locations).toEqual(before.locations);
      expect(data.rooms).toEqual(before.rooms);
      expect(data.capabilities.sort()).toEqual([...before.capabilities].sort());
      expect(data.agendaView).toEqual(before.agendaView);
      expect(data.availability).toEqual(before.availability);
      expect(data.patients).toEqual([]);
      // El cable pesa menos que el DTO de antes.
      expect(JSON.stringify(data.bookings).length).toBeLessThan(JSON.stringify(before.bookings).length * 0.6);
    });
  }

  it("deep-link: el paciente por id; ajeno, archivado o basura → vacío", async () => {
    asUser(T.userId);
    const actor = await getActor();
    const load = (patientId: string | null) => loadAgendaPage(actor, { monday: MONDAY, patientId });
    expect((await load(patient)).patients).toEqual([{ id: patient, name: "Deep Link" }]);
    expect((await load(foreignPatient)).patients).toEqual([]);
    expect((await load(archived)).patients).toEqual([]);
    expect((await load("x".repeat(500))).patients).toEqual([]);
    const { m } = await measure(() => load(patient));
    expect(m.transactions).toBeLessThanOrEqual(3);
  });
});

describe.skipIf(!RUN)("PF2-c · previewRecurrence: ≤ 40 sentencias, 1 tx, mismo resultado", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let patient: string;
  let osteo: string;

  const RECURRENCES: Record<string, () => RecurrencePreviewQueryInput> = {
    // Fin de mes: 31/01 → 28/02 → 31/03 … (20 fechas, ~19 meses: 10 ventanas de carga antes).
    "mensual fin de mes ×20": () => ({
      anchor: at("2027-01-31", "10:00").toISOString(),
      count: 20,
      frequency: "monthly",
      practitionerId: T.practitionerId,
      serviceId: osteo,
      patientId: patient,
    }),
    "semanal Lun/Mié/Vie ×20": () => ({
      anchor: at("2027-04-05", "11:00").toISOString(),
      count: 20,
      daysOfWeek: [0, 2, 4],
      frequency: "weekly",
      practitionerId: T.practitionerId,
      serviceId: osteo,
      patientId: patient,
      durationMin: 60,
    }),
    // 22:30 + 120' cruza la medianoche AR (la ventana de carga incluye el día siguiente).
    "quincenal 22:30 que cruza la medianoche ×12": () => ({
      anchor: at("2027-03-09", "22:30").toISOString(),
      count: 12,
      frequency: "biweekly",
      practitionerId: T.practitionerId,
      serviceId: osteo,
      patientId: patient,
      durationMin: 120,
    }),
  };

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
    patient = await addPatient(db, T);
    const other = await addPatient(db, T);
    const loc = (await db.location.create({ data: { tenantId: T.tenantId, name: "Principal", isPrimary: true } })).id;
    osteo = (
      await db.service.create({
        data: { tenantId: T.tenantId, practitionerId: T.practitionerId, name: "Osteo", durationMin: 60, priceCents: 9000, maxConcurrent: 1 },
      })
    ).id;
    for (const dow of [1, 2, 3, 4, 5]) {
      await db.practitionerSchedule.create({
        data: { tenantId: T.tenantId, practitionerId: T.practitionerId, locationId: loc, dow, startMin: 540, endMin: 1200 },
      });
    }
    const book = (patientId: string, when: Date, durationMin = 60) =>
      db.booking.create({
        data: {
          tenantId: T.tenantId,
          patientId,
          practitionerId: T.practitionerId,
          serviceId: osteo,
          scheduledFor: when,
          durationMin,
          status: "CONFIRMED",
          idempotencyKey: `pf2c-p-${uniqueSuffix()}`,
        },
      });
    // Mensual: duplicado del paciente, cupo lleno por otro paciente, bloqueo con motivo, excepción de día.
    await book(patient, at("2027-02-28", "10:00"));
    await book(other, at("2027-06-30", "10:00"));
    await book(other, at("2028-02-29", "09:30"));
    await db.timeBlock.create({
      data: { tenantId: T.tenantId, practitionerId: T.practitionerId, startsAt: at("2027-08-31", "09:00"), endsAt: at("2027-08-31", "12:00"), reason: "Congreso", createdById: T.userId },
    });
    await db.scheduleException.create({
      data: { tenantId: T.tenantId, practitionerId: T.practitionerId, date: new Date("2027-10-29T00:00:00.000Z"), kind: "CLOSED", reason: "Mudanza", createdById: T.userId },
    });
    // Semanal: el paciente en la última semana, otro en el medio.
    await book(patient, at("2027-05-14", "11:00"));
    await book(other, at("2027-04-21", "11:30"));
    // Quincenal: turno del otro paciente pasada la medianoche (cupo 1) y del paciente en el día siguiente.
    await book(other, at("2027-03-24", "00:00"));
    await book(patient, at("2027-04-07", "00:15"), 30);
  });

  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });

  it("[PF2-c] mensual ×20: ≤ 40 sentencias y 1 tx", async () => {
    asUser(T.userId);
    const q = RECURRENCES["mensual fin de mes ×20"]();
    const { result, m } = await measure(() => previewRecurrence(q));
    console.log(`[PF2-c] previewRecurrence mensual ×20: ${m.statements} sentencias, ${m.transactions} tx`);
    expect(result.ok).toBe(true);
    expect(m.transactions).toBe(1);
    expect(m.statements).toBeLessThanOrEqual(40);
  });

  for (const [name, q] of Object.entries(RECURRENCES)) {
    it(`igual que antes: ${name} (TZ=${process.env.TZ ?? "host"})`, async () => {
      asUser(T.userId);
      const r = await previewRecurrence(q());
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const before = await legacyPreview(q());
      expect(r.data.items).toEqual(before.items);
      expect(r.data.summary).toBe(before.summary);
      expect(r.data).toEqual(before);
      // La fixture ejerce los caminos (si no, la igualdad sería trivial).
      if (name.startsWith("mensual")) {
        expect(new Set(r.data.items.map((i) => i.status))).toEqual(new Set(["libre", "duplicado", "sobreturno"]));
        expect(r.data.items.some((i) => i.blockReasons.includes("Congreso"))).toBe(true);
      }
    });
  }
});

describe.skipIf(!RUN || !VOLUME)("PF2-c · payload de la semana ≤ 400 kB (fixture de volumen de A1)", () => {
  let db: PrismaClient;
  let V: Awaited<ReturnType<typeof import("@/tests/perf/volume-fixture").createVolumeTenant>>;

  beforeAll(async () => {
    db = ownerClient();
    const { createVolumeTenant } = await import("@/tests/perf/volume-fixture");
    V = await createVolumeTenant(db);
  }, 600_000);

  afterAll(async () => {
    await V?.cleanup();
    await db?.$disconnect();
  }, 600_000);

  it("agendaPayloadBytes ≤ 400.000 y el cable decodificado = el DTO de antes", async () => {
    asUser(V.userId);
    const actor = await getActor();
    const monday = weekStartKey(toARDateKey(new Date()));
    const data = await loadAgendaPage(actor, { monday, patientId: null });
    const sunday = addDays(monday, 6);
    const before = (await listAgendaBookings({ from: dayWindow(monday).start, to: dayWindow(sunday).end })).map(toBookingDTO);
    const bytes = JSON.stringify(data.bookings).length;
    console.log(`[PF2-c] agendaPayloadBytes: ${JSON.stringify(before).length} → ${bytes} (${data.bookings.length} turnos)`);
    expect(data.bookings.length).toBeGreaterThan(500);
    expect(bytes).toBeLessThanOrEqual(400_000);
    const decoded = decodeAgendaWire(data.bookings, { services: data.services, locations: data.locations });
    expect(JSON.stringify(decoded)).toBe(JSON.stringify(before));
  }, 120_000);
});
