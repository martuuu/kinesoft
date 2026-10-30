/**
 * CF-LOCK (CF-2, ítem N del brief «Bloquear días»): el candado de día con un RANGO de días (vacaciones), contra la DB
 * real (rol app con RLS en `test:integration`, owner BYPASSRLS = prod en `:owner`). Corre en TZ=UTC: es lo que destapa
 * un día calculado con el reloj del host en vez del AR.
 *
 * Pedido del cliente: «No recuerdo si está la opción de BLOQUEAR DÍA». Existía el candado de UN día y «Bloquear
 * horario» del modal (hasta 31 días, sin preview ni cancelar); faltaba un rango con el flujo del candado.
 *
 * Lo que se protege:
 *   - `endDayKey` opcional: una fila POR DÍA (y por destino) con el MISMO `groupId`; 2 y 31 días entran, 32 no, y un
 *     fin anterior al inicio tampoco (sin escribir nada);
 *   - preview y apply ven los turnos de TODOS los días; cancelar los cancela a todos; la carrera del 2.º día
 *     (turno nuevo entre preview y apply) da `changed`;
 *   - el motor (staff y turnero) no ofrece horarios en ningún día del rango y el día siguiente sí;
 *   - un rango que cruza un domingo (sin atención) no rompe;
 *   - desbloquear un día de un grupo quita solo ese día; `groupId` quita todo el bloqueo; `dayLockGroupSpans` dice
 *     cuántos días tiene el grupo (para «Quitar todo el bloqueo (lun 3 al vie 7)»);
 *   - realtime: 1 `availability` por commit (`day: null` en un rango, FX1b), no uno por día.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { applyDayLock, dayLockGroupSpans, previewDayLock, removeDayLock } from "@/lib/time-blocks";
import { listAvailableSlots } from "@/lib/availability-actions";
import { findFirstPublicSlot, listPublicSlots } from "@/lib/public-booking";
import { __rateLimitInternals } from "@/lib/rate-limit";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  addPatient,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { realtimeFake, revalidatePathSpy, revalidateTagSpy } from "@/tests/helpers/integration-setup";

const RUN = process.env.INTEGRATION === "1";

const at = (day: string, hhmm: string) => `${day}T${hhmm}:00-03:00`;

// 2027-04-06 es martes (2027-03-09 lo es, +28). 2027-04-10 sábado, 04-11 domingo, 04-12 lunes.
describe.skipIf(!RUN)("CF-LOCK · bloquear un rango de días", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let prac2: { userId: string; practitionerId: string };

  async function bookingAt(practitionerId: string, day: string, hhmm: string) {
    const patientId = await addPatient(db, A, { firstName: "Vera", lastName: `Rango ${uniqueSuffix()}` });
    return db.booking.create({
      data: {
        tenantId: A.tenantId,
        patientId,
        practitionerId,
        serviceId: A.serviceId,
        scheduledFor: new Date(at(day, hhmm)),
        durationMin: 45,
        status: "CONFIRMED",
        idempotencyKey: `cfl-${uniqueSuffix()}`,
      },
    });
  }

  const blocksBetween = (from: string, toExclusive: string) =>
    db.timeBlock.findMany({
      where: {
        tenantId: A.tenantId,
        deletedAt: null,
        startsAt: { gte: new Date(at(from, "00:00")), lt: new Date(at(toExclusive, "00:00")) },
      },
      orderBy: [{ startsAt: "asc" }, { practitionerId: "asc" }],
    });

  const availabilityCalls = () => realtimeFake.calls.filter((c) => c.availability !== undefined);

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    prac2 = await addPractitioner(db, A, "PRACTITIONER");
  });
  afterAll(async () => {
    await A?.cleanup();
    await db?.$disconnect();
  });
  beforeEach(() => {
    revalidatePathSpy.mockClear();
    revalidateTagSpy.mockClear();
    realtimeFake.reset();
  });

  it("[CF-N1] 2 días de un profesional: una fila por día, mismo groupId, ventanas AR, 1 availability con day:null", async () => {
    asUser(A.userId);
    const r = await applyDayLock({
      dayKey: "2027-04-06",
      endDayKey: "2027-04-07",
      practitionerIds: [A.practitionerId],
      allDay: true,
      reason: "Vacaciones",
      bookingsDecision: "keep",
      expectedAffectedIds: [],
    });
    if (!r.ok) throw new Error(r.error);
    const rows = await blocksBetween("2027-04-06", "2027-04-08");
    expect(rows).toHaveLength(2);
    expect(r.data.ids.sort()).toEqual(rows.map((x) => x.id).sort());
    expect(r.data.groupId).not.toBeNull();
    expect(new Set(rows.map((x) => x.groupId))).toEqual(new Set([r.data.groupId]));
    expect(rows.map((x) => [x.startsAt.toISOString(), x.endsAt.toISOString()])).toEqual([
      ["2027-04-06T03:00:00.000Z", "2027-04-07T03:00:00.000Z"],
      ["2027-04-07T03:00:00.000Z", "2027-04-08T03:00:00.000Z"],
    ]);
    expect(rows.every((x) => x.practitionerId === A.practitionerId && x.allDay && x.reason === "Vacaciones")).toBe(true);
    expect(r.data).toMatchObject({ startsAt: "2027-04-06T03:00:00.000Z", endsAt: "2027-04-08T03:00:00.000Z" });
    expect(availabilityCalls().map((x) => x.availability)).toEqual([{ practitionerId: A.practitionerId, day: null }]);

    // Reintento idéntico (doble click): reusa las filas, no duplica.
    const again = await applyDayLock({
      dayKey: "2027-04-06",
      endDayKey: "2027-04-07",
      practitionerIds: [A.practitionerId],
      allDay: true,
      reason: "Vacaciones",
      bookingsDecision: "keep",
      expectedAffectedIds: [],
    });
    expect(again.ok && again.data.reused).toBe(true);
    expect(again.ok && again.data.groupId).toBe(r.data.groupId);
    expect(await blocksBetween("2027-04-06", "2027-04-08")).toHaveLength(2);
  });

  it("[CF-N1] 31 días de «todos» (contando los dos extremos): 31 filas null con un solo groupId", async () => {
    asUser(A.userId);
    const r = await applyDayLock({
      dayKey: "2027-07-01",
      endDayKey: "2027-07-31",
      practitionerIds: null,
      allDay: true,
      bookingsDecision: "keep",
      expectedAffectedIds: [],
    });
    if (!r.ok) throw new Error(r.error);
    const rows = await blocksBetween("2027-07-01", "2027-08-01");
    expect(rows).toHaveLength(31);
    expect(rows.every((x) => x.practitionerId === null && x.groupId === r.data.groupId)).toBe(true);
    expect(r.data.groupId).not.toBeNull();
  });

  it("[CF-N1] 32 días → Datos inválidos en preview y apply, sin escribir", async () => {
    asUser(A.userId);
    const scope = {
      dayKey: "2027-09-01",
      endDayKey: "2027-10-02",
      practitionerIds: null,
      allDay: true,
    } as const;
    const p = await previewDayLock(scope);
    expect(p.ok).toBe(false);
    const r = await applyDayLock({ ...scope, bookingsDecision: "keep", expectedAffectedIds: [] });
    expect(r.ok).toBe(false);
    if (!r.ok && "fieldErrors" in r) expect(r.fieldErrors?.endDayKey?.[0]).toMatch(/31 días/);
    expect(await blocksBetween("2027-09-01", "2027-10-03")).toHaveLength(0);
  });

  it("[CF-N1] endDayKey < dayKey → Datos inválidos, sin escribir", async () => {
    asUser(A.userId);
    const r = await applyDayLock({
      dayKey: "2027-09-10",
      endDayKey: "2027-09-09",
      practitionerIds: null,
      allDay: true,
      bookingsDecision: "keep",
      expectedAffectedIds: [],
    });
    expect(r).toMatchObject({ ok: false, error: "Datos inválidos" });
    expect(await blocksBetween("2027-09-08", "2027-09-12")).toHaveLength(0);
  });

  it("[CF-N1] preview ve el turno del 2.º día; un turno nuevo en el 2.º día entre preview y apply → changed; cancelar los cancela a todos", async () => {
    asUser(A.userId);
    const d1 = await bookingAt(A.practitionerId, "2027-04-13", "10:00");
    const d2 = await bookingAt(A.practitionerId, "2027-04-14", "11:00");
    const otherPrac = await bookingAt(prac2.practitionerId, "2027-04-14", "11:00");
    const scope = {
      dayKey: "2027-04-13",
      endDayKey: "2027-04-14",
      practitionerIds: [A.practitionerId],
      allDay: true,
    };
    const p = await previewDayLock(scope);
    if (!p.ok) throw new Error(p.error);
    expect(p.data.affected.map((a) => a.id)).toEqual([d1.id, d2.id]);
    expect(p.data).toMatchObject({ dayKey: "2027-04-13", endDayKey: "2027-04-14" });

    // Carrera en el 2.º día: el apply recalcula sobre TODO el rango.
    const late = await bookingAt(A.practitionerId, "2027-04-14", "15:00");
    const stale = await applyDayLock({
      ...scope,
      bookingsDecision: "cancel",
      expectedAffectedIds: p.data.affected.map((a) => a.id),
    });
    expect(stale.ok).toBe(false);
    if (stale.ok || !("changed" in stale)) throw new Error("se esperaba changed");
    expect(stale.affected.affected.map((a) => a.id)).toEqual([d1.id, d2.id, late.id]);
    expect(await blocksBetween("2027-04-13", "2027-04-15")).toHaveLength(0);

    const r = await applyDayLock({
      ...scope,
      bookingsDecision: "cancel",
      expectedAffectedIds: [d1.id, d2.id, late.id],
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.data.cancelled.map((c) => c.id).sort()).toEqual([d1.id, d2.id, late.id].sort());
    const after = await db.booking.findMany({
      where: { id: { in: [d1.id, d2.id, late.id, otherPrac.id] } },
      select: { id: true, status: true },
    });
    const st = new Map(after.map((b) => [b.id, b.status]));
    expect([st.get(d1.id), st.get(d2.id), st.get(late.id)]).toEqual(["CANCELLED", "CANCELLED", "CANCELLED"]);
    // El turno de otro profesional del mismo día queda.
    expect(st.get(otherPrac.id)).toBe("CONFIRMED");
    expect(await blocksBetween("2027-04-13", "2027-04-15")).toHaveLength(2);
  });

  it("[CF-N1] franja en un rango: una fila por día con la franja, y solo los turnos dentro de la franja de cada día", async () => {
    asUser(A.userId);
    const inside = await bookingAt(prac2.practitionerId, "2027-04-21", "09:30");
    const outside = await bookingAt(prac2.practitionerId, "2027-04-21", "14:00");
    const scope = {
      dayKey: "2027-04-20",
      endDayKey: "2027-04-21",
      practitionerIds: [prac2.practitionerId],
      allDay: false,
      startMin: 9 * 60,
      endMin: 12 * 60,
    };
    const p = await previewDayLock(scope);
    if (!p.ok) throw new Error(p.error);
    expect(p.data.affected.map((a) => a.id)).toEqual([inside.id]);
    expect(outside.id).not.toBe(inside.id);
    const r = await applyDayLock({ ...scope, bookingsDecision: "keep", expectedAffectedIds: [inside.id] });
    if (!r.ok) throw new Error(r.error);
    const rows = await blocksBetween("2027-04-20", "2027-04-22");
    expect(rows.map((x) => [x.startsAt.toISOString(), x.endsAt.toISOString(), x.allDay])).toEqual([
      ["2027-04-20T12:00:00.000Z", "2027-04-20T15:00:00.000Z", false],
      ["2027-04-21T12:00:00.000Z", "2027-04-21T15:00:00.000Z", false],
    ]);
  });

  it("[CF-N1] el turnero y la agenda no ofrecen horarios en ningún día del rango; el día siguiente sí", async () => {
    asUser(A.userId);
    const r = await applyDayLock({
      dayKey: "2027-05-04",
      endDayKey: "2027-05-06",
      // «Todos»: así también el primer turno libre del wizard (que busca entre todos los profesionales) salta el rango.
      practitionerIds: null,
      allDay: true,
      reason: "Vacaciones",
      bookingsDecision: "keep",
      expectedAffectedIds: [],
    });
    if (!r.ok) throw new Error(r.error);
    for (const day of ["2027-05-04", "2027-05-05", "2027-05-06"]) {
      const s = await listAvailableSlots({ practitionerId: A.practitionerId, serviceId: A.serviceId, dayKey: day });
      if (!s.ok || s.data.mode !== "practitioner") throw new Error("slots");
      expect(s.data.slots.filter((x) => x.available)).toEqual([]);
      expect(s.data.dayLockState).toMatchObject({ status: "locked", detail: "Vacaciones" });
      __rateLimitInternals.reset();
      expect(
        await listPublicSlots({ tenantSlug: A.slug, practitionerId: A.practitionerId, serviceId: A.serviceId, date: day })
      ).toEqual([]);
    }
    __rateLimitInternals.reset();
    const next = await listPublicSlots({
      tenantSlug: A.slug,
      practitionerId: A.practitionerId,
      serviceId: A.serviceId,
      date: "2027-05-07",
    });
    expect(next.length).toBeGreaterThan(0);
    // El wizard del turnero arranca por el primer turno libre: desde el 1.er día del rango cae en el día siguiente.
    __rateLimitInternals.reset();
    const first = await findFirstPublicSlot({ tenantSlug: A.slug, serviceId: A.serviceId, fromDate: "2027-05-04" });
    expect(first).not.toBeNull();
    expect(JSON.stringify(first)).toContain("2027-05-07");
    expect(JSON.stringify(first)).not.toMatch(/2027-05-0[456]/);
  });

  it("[CF-N1] un rango que cruza un domingo (sin atención) no rompe: sáb → lun = 3 filas", async () => {
    asUser(A.userId);
    const r = await applyDayLock({
      dayKey: "2027-04-10",
      endDayKey: "2027-04-12",
      practitionerIds: [prac2.practitionerId],
      allDay: true,
      bookingsDecision: "keep",
      expectedAffectedIds: [],
    });
    if (!r.ok) throw new Error(r.error);
    const rows = await blocksBetween("2027-04-10", "2027-04-13");
    expect(rows.map((x) => x.startsAt.toISOString())).toEqual([
      "2027-04-10T03:00:00.000Z",
      "2027-04-11T03:00:00.000Z",
      "2027-04-12T03:00:00.000Z",
    ]);
  });

  it("[CF-N1] desbloquear un día del grupo quita solo ese día; con groupId quita todo el bloqueo; dayLockGroupSpans cuenta los días", async () => {
    asUser(A.userId);
    const r = await applyDayLock({
      dayKey: "2027-06-01",
      endDayKey: "2027-06-04",
      practitionerIds: [A.practitionerId, prac2.practitionerId],
      allDay: true,
      bookingsDecision: "keep",
      expectedAffectedIds: [],
    });
    if (!r.ok) throw new Error(r.error);
    const groupId = r.data.groupId!;
    expect(await blocksBetween("2027-06-01", "2027-06-05")).toHaveLength(8);

    const spans = await dayLockGroupSpans({ groupIds: [groupId] });
    expect(spans).toEqual({
      ok: true,
      data: [{ groupId, firstDayKey: "2027-06-01", lastDayKey: "2027-06-04", days: 4 }],
    });

    realtimeFake.reset();
    const one = await removeDayLock({ dayKey: "2027-06-02", practitionerId: null });
    if (!one.ok) throw new Error(one.error);
    expect(one.data.deleted).toBe(2);
    const left = await blocksBetween("2027-06-01", "2027-06-05");
    expect(left).toHaveLength(6);
    expect(left.some((x) => x.startsAt.toISOString() === "2027-06-02T03:00:00.000Z")).toBe(false);
    expect(availabilityCalls().map((x) => x.availability)).toEqual([{ practitionerId: null, day: "2027-06-02" }]);
    const spans2 = await dayLockGroupSpans({ groupIds: [groupId] });
    expect(spans2.ok && spans2.data[0].days).toBe(3);

    realtimeFake.reset();
    const all = await removeDayLock({ dayKey: "2027-06-03", practitionerId: null, groupId });
    if (!all.ok) throw new Error(all.error);
    expect(all.data.deleted).toBe(6);
    expect(await blocksBetween("2027-06-01", "2027-06-05")).toHaveLength(0);
    expect(availabilityCalls().map((x) => x.availability)).toEqual([{ practitionerId: null, day: null }]);

    // Un grupo que no toca el día pedido: no se quita nada.
    const again = await applyDayLock({
      dayKey: "2027-06-08",
      endDayKey: "2027-06-09",
      practitionerIds: [A.practitionerId],
      allDay: true,
      bookingsDecision: "keep",
      expectedAffectedIds: [],
    });
    if (!again.ok) throw new Error(again.error);
    const miss = await removeDayLock({ dayKey: "2027-06-15", practitionerId: null, groupId: again.data.groupId! });
    expect(miss).toMatchObject({ ok: false, error: "Ese día no tiene bloqueos." });
    expect(await blocksBetween("2027-06-08", "2027-06-10")).toHaveLength(2);
  });

  it("[CF-N1] PRACTITIONER: rango de su agenda sí; quitar todo un grupo compartido quita solo sus filas", async () => {
    asUser(A.userId);
    const shared = await applyDayLock({
      dayKey: "2027-08-03",
      endDayKey: "2027-08-04",
      practitionerIds: [A.practitionerId, prac2.practitionerId],
      allDay: true,
      bookingsDecision: "keep",
      expectedAffectedIds: [],
    });
    if (!shared.ok) throw new Error(shared.error);

    asUser(prac2.userId);
    const own = await applyDayLock({
      dayKey: "2027-08-10",
      endDayKey: "2027-08-12",
      practitionerIds: [prac2.practitionerId],
      allDay: true,
      bookingsDecision: "keep",
      expectedAffectedIds: [],
    });
    if (!own.ok) throw new Error(own.error);
    expect(own.data.ids).toHaveLength(3);
    // Alcance del profesional: solo sus filas del grupo compartido → no puede quitar las del otro.
    const mine = await removeDayLock({
      dayKey: "2027-08-03",
      practitionerId: prac2.practitionerId,
      groupId: shared.data.groupId!,
    });
    if (!mine.ok) throw new Error(mine.error);
    expect(mine.data.deleted).toBe(2);
    const rest = await blocksBetween("2027-08-03", "2027-08-05");
    expect(rest.map((x) => x.practitionerId)).toEqual([A.practitionerId, A.practitionerId]);
  });
});
