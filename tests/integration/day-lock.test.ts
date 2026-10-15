/**
 * B4.4 AG-lock — candado de día contra la DB real (rol app con RLS en
 * `test:integration`, owner BYPASSRLS = prod en `:owner`). Corre en TZ=UTC: es
 * lo que destapa un "día" calculado con el reloj del host en vez del AR.
 *
 * Lo que se protege:
 *   - el bloqueo se crea con la ventana AR correcta (todos = una fila null;
 *     subconjunto = N filas con groupId, decisión 8);
 *   - mantener vs cancelar los turnos de debajo; H1: un turno con cobro NO se
 *     cancela en lote y vuelve en `skipped` ("resolver a mano");
 *   - carrera: un turno nuevo entre el preview y el apply → `changed`, sin
 *     escribir nada (ni bloqueo ni cancelaciones);
 *   - authz: PRACTITIONER solo sobre su agenda; "todos" exige manageBlocks;
 *   - desbloquear (soft) y aviso de lo que queda;
 *   - el motor deja de ofrecer slots ese día (staff y turnero) y un bloqueo
 *     parcial respeta las franjas;
 *   - S18b H2 (P3.Z): cada afectado dice si es de plan (`inPlan`), para la nota
 *     precisa del diálogo ("el candado deja la sesión sin turno");
 *   - SR-B (§17.5 "Bloquear sala"): el alcance "Una sala" (fila con roomId,
 *     sede de la sala y practitionerId null), sala de otra sede / archivada /
 *     ajena rechazada sin escribir, preview solo de esa sala, mantener /
 *     cancelar, permisos (agenda.manageBlocks), desbloquear por sala sin
 *     tocar el resto y viceversa, y el lock de sala tomado ANTES que el de
 *     sedes (pg_locks).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  applyDayLock,
  createTimeBlock,
  deleteTimeBlock,
  listTimeBlocks,
  previewDayLock,
  removeDayLock,
} from "@/lib/time-blocks";
import { ROOM_BLOCK_ORDER, ROOM_BLOCK_SELECT, roomBlocksWhere, toAgendaRoomBlockViews } from "@/lib/time-blocks-schemas";
import { roomLockKey } from "@/lib/booking-cap-lock";
import { BAD_ROOM_ERROR } from "@/lib/bookings-constants";
import { countAdvisoryWaiters, waitForAdvisoryWaiter } from "@/tests/helpers/advisory-wait";
import { listAvailableSlots } from "@/lib/availability-actions";
import { listPublicSlots } from "@/lib/public-booking";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { ForbiddenError } from "@/lib/session";
import { tags } from "@/lib/cache-tags";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  addPatient,
  addRoom,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { createPlan, addPlanBooking } from "@/tests/helpers/plan-factory";
import { realtimeFake, revalidatePathSpy, revalidateTagSpy } from "@/tests/helpers/integration-setup";
import { createBooking } from "@/lib/bookings";

const RUN = process.env.INTEGRATION === "1";

// Martes/miércoles lejanos (sin franjas propias → horario del tenant lun-sáb).
const at = (day: string, hhmm: string) => `${day}T${hhmm}:00-03:00`;

describe.skipIf(!RUN)("candado de día (B4.4)", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let prac2: { userId: string; practitionerId: string };
  let assistant: { userId: string; practitionerId: string };
  let locOfB: string;

  async function bookingAt(
    practitionerId: string,
    day: string,
    hhmm: string,
    extra: { paymentStatus?: "PAID"; status?: "CONFIRMED" | "PENDING"; durationMin?: number } = {}
  ) {
    const patientId = await addPatient(db, A, { firstName: "Ana", lastName: `Paz ${uniqueSuffix()}` });
    return db.booking.create({
      data: {
        tenantId: A.tenantId,
        patientId,
        practitionerId,
        serviceId: A.serviceId,
        scheduledFor: new Date(at(day, hhmm)),
        durationMin: extra.durationMin ?? 45,
        status: extra.status ?? "CONFIRMED",
        ...(extra.paymentStatus ? { paymentStatus: extra.paymentStatus } : {}),
        idempotencyKey: `dl-${uniqueSuffix()}`,
      },
    });
  }

  const blocksOn = (day: string) =>
    db.timeBlock.findMany({
      where: {
        tenantId: A.tenantId,
        deletedAt: null,
        startsAt: { lt: new Date(at(day, "23:59")) },
        endsAt: { gt: new Date(at(day, "00:00")) },
      },
      orderBy: { createdAt: "asc" },
    });

  beforeAll(async () => {
    db = ownerClient();
    // PL-2f (C-PL1): salas y Sala de Espera son de Clínica / Libre; sin el plan, el motor ignora las salas.
    A = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    B = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    prac2 = await addPractitioner(db, A, "PRACTITIONER");
    assistant = await addPractitioner(db, A, "ASSISTANT");
    await db.location.create({ data: { tenantId: A.tenantId, name: "Principal", isPrimary: true } });
    locOfB = (await db.location.create({ data: { tenantId: B.tenantId, name: "Principal", isPrimary: true } })).id;
  });
  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await db?.$disconnect();
  });
  beforeEach(() => {
    revalidatePathSpy.mockClear();
    revalidateTagSpy.mockClear();
  });

  it("día sin turnos: preview vacío → bloqueo 'todos' de día completo (ventana AR), revalida y audita", async () => {
    const DAY = "2027-03-09";
    asUser(A.userId);
    const p = await previewDayLock({ dayKey: DAY, practitionerIds: null, allDay: true });
    expect(p).toMatchObject({ ok: true, data: { affected: [], allDay: true } });

    const r = await applyDayLock({
      dayKey: DAY,
      practitionerIds: null,
      allDay: true,
      reason: "Feriado",
      bookingsDecision: "keep",
      expectedAffectedIds: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toMatchObject({ groupId: null, reused: false, kept: [], cancelled: [], skipped: [] });
    const rows = await blocksOn(DAY);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      practitionerId: null,
      locationId: null,
      allDay: true,
      reason: "Feriado",
      groupId: null,
      createdById: A.userId,
    });
    expect(rows[0].startsAt.toISOString()).toBe("2027-03-09T03:00:00.000Z");
    expect(rows[0].endsAt.toISOString()).toBe("2027-03-10T03:00:00.000Z");

    expect(revalidatePathSpy).toHaveBeenCalledWith("/agenda");
    expect(revalidateTagSpy).toHaveBeenCalledWith(tags.bookingDays(A.tenantId));
    expect(revalidateTagSpy).toHaveBeenCalledWith(tags.dashboard(A.tenantId));
    // [PL-A2] Bloqueos: ruido operativo, sin audit (§20.5.9).
    expect(await db.auditEvent.count({ where: { tenantId: A.tenantId, action: { startsWith: "timeBlock." } } })).toBe(0);

    // Reintento idéntico (doble click): no duplica.
    const again = await applyDayLock({
      dayKey: DAY,
      practitionerIds: null,
      allDay: true,
      reason: "Feriado",
      bookingsDecision: "keep",
      expectedAffectedIds: [],
    });
    expect(again.ok && again.data.reused).toBe(true);
    expect(await blocksOn(DAY)).toHaveLength(1);
  });

  it("con turnos y MANTENER: se bloquea y los turnos siguen igual", async () => {
    const DAY = "2027-03-10";
    asUser(A.userId);
    const b1 = await bookingAt(A.practitionerId, DAY, "10:00");
    const b2 = await bookingAt(prac2.practitionerId, DAY, "11:00");
    // Fuera de la franja (termina justo cuando arranca): no es afectado.
    await bookingAt(A.practitionerId, DAY, "08:15");

    const scope = {
      dayKey: DAY,
      practitionerIds: [A.practitionerId, prac2.practitionerId],
      allDay: false,
      startMin: 9 * 60,
      endMin: 13 * 60,
    };
    const p = await previewDayLock(scope);
    if (!p.ok) throw new Error(p.error);
    expect(p.data.affected.map((a) => a.id)).toEqual([b1.id, b2.id]);
    expect(p.data.affected[0]).toMatchObject({ status: "CONFIRMED", hasPayment: false });
    expect(p.data.affected[0].patientName).toMatch(/^Ana Paz/);

    const r = await applyDayLock({
      ...scope,
      reason: "Congreso",
      bookingsDecision: "keep",
      expectedAffectedIds: p.data.affected.map((a) => a.id),
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.data.kept.map((k) => k.id)).toEqual([b1.id, b2.id]);
    expect(r.data.cancelled).toEqual([]);
    // Subconjunto = N filas con el mismo groupId (decisión 8).
    const rows = await blocksOn(DAY);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((x) => x.practitionerId))).toEqual(new Set([A.practitionerId, prac2.practitionerId]));
    expect(rows[0].groupId).not.toBeNull();
    expect(rows[0].groupId).toBe(rows[1].groupId);
    expect(rows[0]).toMatchObject({ allDay: false });
    expect(rows[0].startsAt.toISOString()).toBe("2027-03-10T12:00:00.000Z");
    for (const id of [b1.id, b2.id]) {
      expect((await db.booking.findUniqueOrThrow({ where: { id } })).status).toBe("CONFIRMED");
    }
  });

  it("[P3-Z] preview: `inPlan` marca los turnos de plan y no los sueltos (sin título ni datos del plan)", async () => {
    const DAY = "2027-03-30";
    asUser(A.userId);
    const loose = await bookingAt(A.practitionerId, DAY, "10:00");
    const plan = await createPlan(db, A, { sessions: 1, bookings: 0 });
    const inPlan = await addPlanBooking(db, A, {
      patientId: plan.patientId,
      programId: plan.programId,
      sessionId: plan.sessionIds[0],
      scheduledFor: new Date(at(DAY, "11:00")),
    });
    const p = await previewDayLock({ dayKey: DAY, practitionerIds: [A.practitionerId], allDay: true });
    if (!p.ok) throw new Error(p.error);
    expect(p.data.affected.map((a) => [a.id, a.inPlan])).toEqual([
      [loose.id, false],
      [inPlan, true],
    ]);
    // Sin PHI del plan en el cable: ni título ni programId.
    for (const a of p.data.affected) {
      expect(Object.keys(a).sort()).toEqual(
        ["durationMin", "hasPayment", "id", "inPlan", "patientName", "practitionerId", "scheduledFor", "status"]
      );
    }
  });

  it("con turnos y CANCELAR: cancela los activos; el que tiene cobro queda y vuelve como 'resolver a mano'", async () => {
    const DAY = "2027-03-11";
    asUser(assistant.userId);
    const plain = await bookingAt(A.practitionerId, DAY, "09:00");
    const pending = await bookingAt(prac2.practitionerId, DAY, "10:00", { status: "PENDING" });
    const paid = await bookingAt(A.practitionerId, DAY, "11:00", { paymentStatus: "PAID" });
    const before = await db.booking.findUniqueOrThrow({ where: { id: plain.id } });

    const p = await previewDayLock({ dayKey: DAY, practitionerIds: null, allDay: true });
    if (!p.ok) throw new Error(p.error);
    expect(p.data.affected.map((a) => [a.id, a.hasPayment])).toEqual([
      [plain.id, false],
      [pending.id, false],
      [paid.id, true],
    ]);

    const r = await applyDayLock({
      dayKey: DAY,
      practitionerIds: null,
      allDay: true,
      reason: "Feriado",
      bookingsDecision: "cancel",
      expectedAffectedIds: p.data.affected.map((a) => a.id),
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.data.cancelled.map((c) => c.id).sort()).toEqual([plain.id, pending.id].sort());
    expect(r.data.skipped).toEqual([{ booking: expect.objectContaining({ id: paid.id }), reason: "has-payment" }]);
    expect(r.data.kept).toEqual([]);

    const after = await db.booking.findUniqueOrThrow({ where: { id: plain.id } });
    expect(after.status).toBe("CANCELLED");
    // updatedAt se mueve: un drawer abierto queda stale para el lock optimista.
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    expect((await db.booking.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe("CANCELLED");
    expect((await db.booking.findUniqueOrThrow({ where: { id: paid.id } })).status).toBe("CONFIRMED");
    const audits = await db.auditEvent.findMany({
      where: { tenantId: A.tenantId, action: "booking.cancel.dayLock" },
      select: { entityId: true, payload: true },
    });
    expect(audits.map((a) => a.entityId).sort()).toEqual([plain.id, pending.id].sort());
    expect(audits[0].payload).toMatchObject({ reason: `Candado del día ${DAY}: Feriado` });
    expect(await blocksOn(DAY)).toHaveLength(1);
  });

  it("carrera: un turno nuevo entre el preview y el apply → changed, sin escribir nada; con la lista nueva aplica", async () => {
    const DAY = "2027-03-12";
    asUser(A.userId);
    const p = await previewDayLock({ dayKey: DAY, practitionerIds: [A.practitionerId], allDay: true });
    if (!p.ok) throw new Error(p.error);
    expect(p.data.affected).toEqual([]);

    const sneaky = await bookingAt(A.practitionerId, DAY, "15:00");
    const r = await applyDayLock({
      dayKey: DAY,
      practitionerIds: [A.practitionerId],
      allDay: true,
      bookingsDecision: "cancel",
      expectedAffectedIds: [],
    });
    expect(r.ok).toBe(false);
    if (r.ok || !("changed" in r)) throw new Error("se esperaba changed");
    expect(r.changed).toBe(true);
    expect(r.affected.affected.map((a) => a.id)).toEqual([sneaky.id]);
    expect(await blocksOn(DAY)).toHaveLength(0);
    expect((await db.booking.findUniqueOrThrow({ where: { id: sneaky.id } })).status).toBe("CONFIRMED");
    expect(revalidatePathSpy).not.toHaveBeenCalled();

    const r2 = await applyDayLock({
      dayKey: DAY,
      practitionerIds: [A.practitionerId],
      allDay: true,
      bookingsDecision: "cancel",
      expectedAffectedIds: [sneaky.id],
    });
    expect(r2.ok && r2.data.cancelled.map((c) => c.id)).toEqual([sneaky.id]);
    const rows = await blocksOn(DAY);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ practitionerId: A.practitionerId, groupId: null });
  });

  it("carrera concurrente: dos apply del mismo candado a la vez → un solo bloqueo (locks de cupo serializan)", async () => {
    const DAY = "2027-03-13";
    asUser(A.userId);
    const input = {
      dayKey: DAY,
      practitionerIds: null,
      allDay: true,
      bookingsDecision: "keep" as const,
      expectedAffectedIds: [],
    };
    const [x, y] = await Promise.all([applyDayLock(input), applyDayLock(input)]);
    expect(x.ok && y.ok).toBe(true);
    expect(await blocksOn(DAY)).toHaveLength(1);
    expect([x.ok && x.data.reused, y.ok && y.data.reused].sort()).toEqual([false, true]);
  });

  describe("authz", () => {
    it("PRACTITIONER sobre la agenda de otro o 'todos' → ForbiddenError, sin filas ni cancelaciones", async () => {
      const DAY = "2027-03-15";
      const other = await bookingAt(A.practitionerId, DAY, "10:00");
      asUser(prac2.userId);
      await expect(
        previewDayLock({ dayKey: DAY, practitionerIds: [A.practitionerId], allDay: true })
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        applyDayLock({
          dayKey: DAY,
          practitionerIds: [A.practitionerId],
          allDay: true,
          bookingsDecision: "cancel",
          expectedAffectedIds: [other.id],
        })
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        applyDayLock({
          dayKey: DAY,
          practitionerIds: null,
          allDay: true,
          bookingsDecision: "cancel",
          expectedAffectedIds: [other.id],
        })
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        applyDayLock({
          dayKey: DAY,
          practitionerIds: [prac2.practitionerId, A.practitionerId],
          allDay: true,
          bookingsDecision: "keep",
          expectedAffectedIds: [],
        })
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(await blocksOn(DAY)).toHaveLength(0);
      expect((await db.booking.findUniqueOrThrow({ where: { id: other.id } })).status).toBe("CONFIRMED");
      await expect(removeDayLock({ dayKey: DAY, practitionerId: null })).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("PRACTITIONER bloquea su propia agenda; el turno ajeno del día no aparece", async () => {
      const DAY = "2027-03-15";
      asUser(prac2.userId);
      const p = await previewDayLock({ dayKey: DAY, practitionerIds: [prac2.practitionerId], allDay: true });
      if (!p.ok) throw new Error(p.error);
      expect(p.data.affected).toEqual([]);
      const r = await applyDayLock({
        dayKey: DAY,
        practitionerIds: [prac2.practitionerId],
        allDay: true,
        bookingsDecision: "keep",
        expectedAffectedIds: [],
      });
      expect(r.ok).toBe(true);
      expect((await blocksOn(DAY)).map((b) => b.practitionerId)).toEqual([prac2.practitionerId]);
    });

    it("IDOR: profesional o sede de otro tenant → error, sin filas", async () => {
      const DAY = "2027-03-16";
      asUser(A.userId);
      expect(await previewDayLock({ dayKey: DAY, practitionerIds: [B.practitionerId], allDay: true })).toEqual({
        ok: false,
        error: "Profesional no encontrado.",
      });
      expect(
        await applyDayLock({
          dayKey: DAY,
          practitionerIds: null,
          locationId: locOfB,
          allDay: true,
          bookingsDecision: "keep",
          expectedAffectedIds: [],
        })
      ).toEqual({ ok: false, error: "Sede no encontrada." });
      expect(await blocksOn(DAY)).toHaveLength(0);
      expect(await db.timeBlock.count({ where: { tenantId: B.tenantId } })).toBe(0);
    });
  });

  describe("desbloquear", () => {
    it("quita los bloqueos del día del alcance y avisa lo que queda (varios días, 'todos' visto desde un profesional)", async () => {
      const DAY = "2027-03-17";
      asUser(A.userId);
      const all = await applyDayLock({
        dayKey: DAY,
        practitionerIds: null,
        allDay: true,
        reason: "Feriado",
        bookingsDecision: "keep",
        expectedAffectedIds: [],
      });
      if (!all.ok) throw new Error(all.error);
      // Franja propia de prac2 y unas vacaciones de varios días que tocan el día.
      const own = await db.timeBlock.create({
        data: {
          tenantId: A.tenantId,
          practitionerId: prac2.practitionerId,
          startsAt: new Date(at(DAY, "09:00")),
          endsAt: new Date(at(DAY, "12:00")),
          createdById: prac2.userId,
        },
      });
      const vac = await db.timeBlock.create({
        data: {
          tenantId: A.tenantId,
          practitionerId: prac2.practitionerId,
          startsAt: new Date(at("2027-03-16", "00:00")),
          endsAt: new Date(at("2027-03-19", "00:00")),
          allDay: true,
          reason: "Vacaciones",
          createdById: prac2.userId,
        },
      });

      // PRACTITIONER: su franja sí; el de "todos" y las vacaciones quedan.
      asUser(prac2.userId);
      const r1 = await removeDayLock({ dayKey: DAY, practitionerId: prac2.practitionerId });
      if (!r1.ok) throw new Error(r1.error);
      expect(r1.data.deleted).toBe(1);
      expect(r1.data.remaining.map((b) => [b.id, b.multiDay]).sort()).toEqual(
        [
          [all.data.ids[0], false],
          [vac.id, true],
        ].sort()
      );
      expect((await db.timeBlock.findUniqueOrThrow({ where: { id: own.id } })).deletedAt).not.toBeNull();

      // Admin, todo el consultorio: quita el de "todos"; las vacaciones quedan.
      asUser(A.userId);
      const r2 = await removeDayLock({ dayKey: DAY, practitionerId: null });
      if (!r2.ok) throw new Error(r2.error);
      expect(r2.data.deleted).toBe(1);
      expect(r2.data.remaining.map((b) => b.id)).toEqual([vac.id]);
      expect((await db.timeBlock.findUniqueOrThrow({ where: { id: all.data.ids[0] } })).deletedAt).not.toBeNull();
      expect((await db.timeBlock.findUniqueOrThrow({ where: { id: vac.id } })).deletedAt).toBeNull();
      expect(revalidatePathSpy).toHaveBeenCalledWith("/agenda");
      expect(
        await db.auditEvent.count({ where: { tenantId: A.tenantId, action: "timeBlock.dayUnlock" } })
      ).toBe(0); // [PL-A2] sin audit (§20.5.9)
    });

    it("con blockIds solo quita los tildados; día sin bloqueos → error", async () => {
      const DAY = "2027-03-29"; // lejos de las vacaciones (16-18) del test anterior
      asUser(assistant.userId);
      const a = await applyDayLock({
        dayKey: DAY,
        practitionerIds: [A.practitionerId],
        allDay: false,
        startMin: 540,
        endMin: 600,
        bookingsDecision: "keep",
        expectedAffectedIds: [],
      });
      const b = await applyDayLock({
        dayKey: DAY,
        practitionerIds: [A.practitionerId],
        allDay: false,
        startMin: 900,
        endMin: 960,
        bookingsDecision: "keep",
        expectedAffectedIds: [],
      });
      if (!a.ok || !b.ok) throw new Error("setup");
      const r = await removeDayLock({ dayKey: DAY, practitionerId: null, blockIds: [a.data.ids[0]] });
      expect(r.ok && r.data).toMatchObject({ deleted: 1, remaining: [{ id: b.data.ids[0], multiDay: false }] });
      expect(await removeDayLock({ dayKey: "2027-03-22", practitionerId: null })).toEqual({
        ok: false,
        error: "Ese día no tiene bloqueos.",
      });
    });
  });

  describe("el motor respeta el candado (TZ=UTC)", () => {
    it("día bloqueado: sin slots para el staff ni para el turnero", async () => {
      const OPEN = "2027-03-23";
      const LOCKED = "2027-03-24";
      asUser(A.userId);
      const base = await listAvailableSlots({ practitionerId: A.practitionerId, serviceId: A.serviceId, dayKey: OPEN });
      if (!base.ok || base.data.mode !== "practitioner") throw new Error("setup");
      expect(base.data.slots.filter((s) => s.available).length).toBeGreaterThan(0);
      __rateLimitInternals.reset();
      const pubBase = await listPublicSlots({
        tenantSlug: A.slug,
        practitionerId: A.practitionerId,
        serviceId: A.serviceId,
        date: OPEN,
      });
      expect(pubBase.length).toBeGreaterThan(0);

      const r = await applyDayLock({
        dayKey: LOCKED,
        practitionerIds: null,
        allDay: true,
        reason: "Feriado",
        bookingsDecision: "keep",
        expectedAffectedIds: [],
      });
      expect(r.ok).toBe(true);
      const s = await listAvailableSlots({ practitionerId: A.practitionerId, serviceId: A.serviceId, dayKey: LOCKED });
      if (!s.ok || s.data.mode !== "practitioner") throw new Error("slots");
      expect(s.data.slots.filter((x) => x.available)).toEqual([]);
      expect(s.data.dayLockState).toMatchObject({ status: "locked", reason: "bloqueo", detail: "Feriado" });
      __rateLimitInternals.reset();
      expect(
        await listPublicSlots({ tenantSlug: A.slug, practitionerId: A.practitionerId, serviceId: A.serviceId, date: LOCKED })
      ).toEqual([]);
    });

    it("bloqueo parcial: la franja bloqueada no ofrece slots y el resto del horario sí", async () => {
      const DAY = "2027-03-25";
      asUser(A.userId);
      const r = await applyDayLock({
        dayKey: DAY,
        practitionerIds: [A.practitionerId],
        allDay: false,
        startMin: 10 * 60,
        endMin: 12 * 60,
        reason: "Capacitación",
        bookingsDecision: "keep",
        expectedAffectedIds: [],
      });
      expect(r.ok).toBe(true);
      const s = await listAvailableSlots({ practitionerId: A.practitionerId, serviceId: A.serviceId, dayKey: DAY });
      if (!s.ok || s.data.mode !== "practitioner") throw new Error("slots");
      expect(s.data.dayLockState.status).toBe("partial");
      const times = s.data.slots.filter((x) => x.available).map((x) => x.time);
      // Un turno de 45' que pisa [10:00, 12:00) no se ofrece (09:15 termina 10:00: sí).
      expect(times).toContain("09:15");
      expect(times).not.toContain("09:30");
      expect(times).not.toContain("10:00");
      expect(times).not.toContain("11:45");
      expect(times).toContain("12:00");
      expect(times.length).toBeGreaterThan(0);
      // Otro profesional del mismo día: intacto.
      const other = await listAvailableSlots({
        practitionerId: prac2.practitionerId,
        serviceId: A.serviceId,
        dayKey: DAY,
      });
      if (!other.ok || other.data.mode !== "practitioner") throw new Error("slots");
      expect(other.data.dayLockState.status).toBe("open");
      expect(other.data.slots.filter((x) => x.available).map((x) => x.time)).toContain("10:00");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SR-B · bloqueo de SALA (§17.5). Tenant propio: las filas de sala tienen
// practitionerId null y no tienen que cruzarse con los "todos" de arriba.
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!RUN)("bloqueo de sala (SR-B, §17.5)", () => {
  let db: PrismaClient;
  let holderDb: PrismaClient;
  let C: EphemeralTenant;
  let D: EphemeralTenant;
  let prac: { userId: string; practitionerId: string };
  let assistant: { userId: string; practitionerId: string };
  let loc1: string;
  let loc2: string;
  let r1: string; // Consultorio 1 (sede 1)
  let r2: string; // Consultorio 2 (sede 1)
  let rArchived: string; // sede 1, archivada
  let rLoc2: string; // sede 2
  let rOfD: string; // otro tenant

  async function roomBooking(
    practitionerId: string,
    day: string,
    hhmm: string,
    room: { roomId: string | null; locationId: string | null },
    extra: { paymentStatus?: "PAID"; status?: "CONFIRMED" | "PENDING" } = {}
  ) {
    const patientId = await addPatient(db, C, { firstName: "Eva", lastName: `Sala ${uniqueSuffix()}` });
    return db.booking.create({
      data: {
        tenantId: C.tenantId,
        patientId,
        practitionerId,
        serviceId: C.serviceId,
        scheduledFor: new Date(at(day, hhmm)),
        durationMin: 45,
        status: extra.status ?? "CONFIRMED",
        locationId: room.locationId,
        roomId: room.roomId,
        ...(extra.paymentStatus ? { paymentStatus: extra.paymentStatus } : {}),
        idempotencyKey: `rb-${uniqueSuffix()}`,
      },
    });
  }

  const liveBlocksOn = (day: string) =>
    db.timeBlock.findMany({
      where: {
        tenantId: C.tenantId,
        deletedAt: null,
        startsAt: { lt: new Date(at(day, "23:59")) },
        endsAt: { gt: new Date(at(day, "00:00")) },
      },
      orderBy: { createdAt: "asc" },
    });

  /** Toma `key` en una tx de otra conexión hasta `release()` (patrón de locks-room). */
  async function hold(key: string) {
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let acquired!: () => void;
    const got = new Promise<void>((r) => (acquired = r));
    const done = holderDb.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        acquired();
        await released;
      },
      { timeout: 20_000 }
    );
    await got;
    return { release, done };
  }

  beforeAll(async () => {
    db = ownerClient();
    holderDb = ownerClient();
    C = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    D = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    prac = await addPractitioner(db, C, "PRACTITIONER");
    assistant = await addPractitioner(db, C, "ASSISTANT");
    const a = await addRoom(db, C, { name: "Consultorio 1" });
    loc1 = a.locationId;
    r1 = a.roomId;
    r2 = (await addRoom(db, C, { name: "Consultorio 2", locationId: loc1 })).roomId;
    rArchived = (await addRoom(db, C, { name: "Viejo", locationId: loc1, active: false })).roomId;
    loc2 = (await db.location.create({ data: { tenantId: C.tenantId, name: "Norte" } })).id;
    rLoc2 = (await addRoom(db, C, { name: "Box Norte", locationId: loc2, kind: "BOX" })).roomId;
    rOfD = (await addRoom(db, D, { name: "Ajeno" })).roomId;
  });
  afterAll(async () => {
    await C?.cleanup();
    await D?.cleanup();
    await Promise.all([db?.$disconnect(), holderDb?.$disconnect()]);
  });

  it("createTimeBlock con roomId: una fila con la sala, la sede de la sala y practitionerId null; affected = solo esa sala", async () => {
    const DAY = "2027-04-06";
    asUser(C.userId);
    const inRoom = await roomBooking(C.practitionerId, DAY, "10:00", { roomId: r1, locationId: loc1 });
    await roomBooking(prac.practitionerId, DAY, "10:00", { roomId: r2, locationId: loc1 });
    await roomBooking(prac.practitionerId, DAY, "11:00", { roomId: null, locationId: loc1 });

    const r = await createTimeBlock({
      roomId: r1,
      startsAt: at(DAY, "09:00"),
      endsAt: at(DAY, "13:00"),
      reason: "Mantenimiento",
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.data.groupId).toBeNull();
    expect(r.data.affected).toMatchObject({ count: 1, bookings: [{ id: inRoom.id }] });
    const rows = await liveBlocksOn(DAY);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: r.data.ids[0],
      roomId: r1,
      locationId: loc1,
      practitionerId: null,
      reason: "Mantenimiento",
      groupId: null,
      createdById: C.userId,
    });
    // [PL-A2] sin audit (§20.5.9); la sala y la sede quedan en la fila (arriba).
    expect(await db.auditEvent.count({ where: { tenantId: C.tenantId, action: "timeBlock.create" } })).toBe(0);
    // Con la sede de la sala explícita también pasa.
    const same = await createTimeBlock({
      roomId: r2,
      locationId: loc1,
      startsAt: at(DAY, "15:00"),
      endsAt: at(DAY, "16:00"),
    });
    expect(same.ok).toBe(true);
  });

  it("sala de otra sede, archivada o de otro tenant → rechazo sin escribir (createTimeBlock y applyDayLock)", async () => {
    const DAY = "2027-04-07";
    asUser(C.userId);
    const win = { startsAt: at(DAY, "09:00"), endsAt: at(DAY, "10:00") };
    for (const input of [
      { roomId: r1, locationId: loc2, ...win }, // sala de la sede 1 contra la sede 2
      { roomId: rArchived, ...win },
      { roomId: rOfD, ...win },
    ]) {
      expect(await createTimeBlock(input)).toEqual({ ok: false, error: BAD_ROOM_ERROR });
    }
    for (const scope of [
      { roomId: r1, locationId: loc2 },
      { roomId: rArchived },
      { roomId: rOfD },
    ]) {
      const base = { dayKey: DAY, practitionerIds: null, allDay: true, ...scope };
      expect(await previewDayLock(base)).toEqual({ ok: false, error: BAD_ROOM_ERROR });
      expect(
        await applyDayLock({ ...base, bookingsDecision: "keep", expectedAffectedIds: [] })
      ).toEqual({ ok: false, error: BAD_ROOM_ERROR });
    }
    expect(await liveBlocksOn(DAY)).toHaveLength(0);
    expect(await db.timeBlock.count({ where: { tenantId: D.tenantId } })).toBe(0);
  });

  it("zod: sala + profesionales → Datos inválidos, sin escribir", async () => {
    const DAY = "2027-04-08";
    asUser(C.userId);
    const r = await createTimeBlock({
      roomId: r1,
      practitionerIds: [C.practitionerId],
      startsAt: at(DAY, "09:00"),
      endsAt: at(DAY, "10:00"),
    });
    expect(r).toMatchObject({ ok: false, error: "Datos inválidos" });
    const p = await previewDayLock({ dayKey: DAY, practitionerIds: [C.practitionerId], roomId: r1, allDay: true });
    expect(p).toMatchObject({ ok: false, error: "Datos inválidos" });
    expect(await liveBlocksOn(DAY)).toHaveLength(0);
  });

  it("preview de sala: solo los turnos activos de ESA sala, mismo shape que el candado (inPlan, hasPayment)", async () => {
    const DAY = "2027-04-09";
    asUser(assistant.userId);
    const a = await roomBooking(C.practitionerId, DAY, "09:00", { roomId: r1, locationId: loc1 });
    const paid = await roomBooking(prac.practitionerId, DAY, "12:00", { roomId: r1, locationId: loc1 }, { paymentStatus: "PAID" });
    await roomBooking(prac.practitionerId, DAY, "09:00", { roomId: r2, locationId: loc1 });
    await roomBooking(C.practitionerId, DAY, "11:00", { roomId: null, locationId: null });
    await roomBooking(C.practitionerId, DAY, "13:00", { roomId: r1, locationId: loc1 }, { status: "PENDING" }).then((b) =>
      db.booking.update({ where: { id: b.id }, data: { status: "CANCELLED" } })
    );

    const p = await previewDayLock({ dayKey: DAY, practitionerIds: null, roomId: r1, allDay: true });
    if (!p.ok) throw new Error(p.error);
    expect(p.data.affected.map((x) => [x.id, x.hasPayment, x.inPlan])).toEqual([
      [a.id, false, false],
      [paid.id, true, false],
    ]);
    for (const x of p.data.affected) {
      expect(Object.keys(x).sort()).toEqual(
        ["durationMin", "hasPayment", "id", "inPlan", "patientName", "practitionerId", "scheduledFor", "status"]
      );
    }
  });

  it("apply de sala: MANTENER deja los turnos con su sala; CANCELAR cancela solo los de la sala y el cobrado queda", async () => {
    const KEEP = "2027-04-12";
    asUser(C.userId);
    const k = await roomBooking(C.practitionerId, KEEP, "10:00", { roomId: r1, locationId: loc1 });
    const r = await applyDayLock({
      dayKey: KEEP,
      practitionerIds: null,
      roomId: r1,
      allDay: true,
      reason: "Pintura",
      bookingsDecision: "keep",
      expectedAffectedIds: [k.id],
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.data.kept.map((x) => x.id)).toEqual([k.id]);
    const kept = await db.booking.findUniqueOrThrow({ where: { id: k.id } });
    // Un bloqueo de sala NO saca la sala de los turnos.
    expect(kept).toMatchObject({ status: "CONFIRMED", roomId: r1, locationId: loc1 });
    const rows = await liveBlocksOn(KEEP);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ roomId: r1, locationId: loc1, practitionerId: null, allDay: true, reason: "Pintura" });
    expect(rows[0].startsAt.toISOString()).toBe("2027-04-12T03:00:00.000Z");
    // [PL-A2] sin audit (§20.5.9); la sala y la sede quedan en la fila (arriba).
    expect(await db.auditEvent.count({ where: { tenantId: C.tenantId, action: "timeBlock.dayLock" } })).toBe(0);

    const CANCEL = "2027-04-13";
    const plain = await roomBooking(C.practitionerId, CANCEL, "09:00", { roomId: r1, locationId: loc1 });
    const paid = await roomBooking(prac.practitionerId, CANCEL, "11:00", { roomId: r1, locationId: loc1 }, { paymentStatus: "PAID" });
    const other = await roomBooking(prac.practitionerId, CANCEL, "09:00", { roomId: r2, locationId: loc1 });
    const c = await applyDayLock({
      dayKey: CANCEL,
      practitionerIds: null,
      roomId: r1,
      allDay: false,
      startMin: 8 * 60,
      endMin: 14 * 60,
      bookingsDecision: "cancel",
      expectedAffectedIds: [plain.id, paid.id],
    });
    if (!c.ok) throw new Error(c.error);
    expect(c.data.cancelled.map((x) => x.id)).toEqual([plain.id]);
    expect(c.data.skipped).toEqual([{ booking: expect.objectContaining({ id: paid.id }), reason: "has-payment" }]);
    expect((await db.booking.findUniqueOrThrow({ where: { id: plain.id } })).status).toBe("CANCELLED");
    expect((await db.booking.findUniqueOrThrow({ where: { id: paid.id } })).status).toBe("CONFIRMED");
    expect((await db.booking.findUniqueOrThrow({ where: { id: other.id } })).status).toBe("CONFIRMED");
  });

  it("idempotencia: el mismo bloqueo de sala no se duplica, y un candado 'todos' de la sede NO reusa la fila de sala (ni al revés)", async () => {
    const DAY = "2027-04-14";
    asUser(C.userId);
    const roomLock = {
      dayKey: DAY,
      practitionerIds: null,
      roomId: r1,
      locationId: loc1,
      allDay: true,
      bookingsDecision: "keep" as const,
      expectedAffectedIds: [],
    };
    const x = await applyDayLock(roomLock);
    const y = await applyDayLock(roomLock);
    expect(x.ok && x.data.reused).toBe(false);
    expect(y.ok && y.data.reused).toBe(true);
    // Misma ventana y sede, pero "todos los profesionales": es OTRO bloqueo.
    const all = await applyDayLock({ ...roomLock, roomId: null });
    if (!all.ok) throw new Error(all.error);
    expect(all.data.reused).toBe(false);
    const rows = await liveBlocksOn(DAY);
    expect(rows.map((b) => b.roomId).sort()).toEqual([r1, null].sort());
    // Y otra sala, la misma ventana: tampoco reusa.
    const z = await applyDayLock({ ...roomLock, roomId: r2 });
    expect(z.ok && z.data.reused).toBe(false);
    expect(await liveBlocksOn(DAY)).toHaveLength(3);
  });

  it("permisos: PRACTITIONER (sin agenda.manageBlocks) → ForbiddenError en preview, apply, alta, desbloqueo y borrado", async () => {
    const DAY = "2027-04-15";
    asUser(prac.userId);
    await expect(previewDayLock({ dayKey: DAY, practitionerIds: null, roomId: r1, allDay: true })).rejects.toBeInstanceOf(
      ForbiddenError
    );
    await expect(
      applyDayLock({
        dayKey: DAY,
        practitionerIds: null,
        roomId: r1,
        allDay: true,
        bookingsDecision: "keep",
        expectedAffectedIds: [],
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      createTimeBlock({ roomId: r1, startsAt: at(DAY, "09:00"), endsAt: at(DAY, "10:00") })
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await liveBlocksOn(DAY)).toHaveLength(0);

    // Lo crea la Secretaria; el profesional no lo puede quitar.
    asUser(assistant.userId);
    const made = await createTimeBlock({ roomId: r1, startsAt: at(DAY, "09:00"), endsAt: at(DAY, "10:00") });
    if (!made.ok) throw new Error(made.error);
    asUser(prac.userId);
    await expect(removeDayLock({ dayKey: DAY, practitionerId: null, roomId: r1 })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteTimeBlock({ id: made.data.ids[0] })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await liveBlocksOn(DAY)).toHaveLength(1);
    // La Secretaria sí.
    asUser(assistant.userId);
    expect(await deleteTimeBlock({ id: made.data.ids[0] })).toEqual({ ok: true, data: { deleted: 1 } });
  });

  it("desbloquear: por sala quita solo esa sala; el desbloqueo de profesionales/'todos' no toca ni lista bloqueos de sala", async () => {
    const DAY = "2027-04-16";
    asUser(C.userId);
    const mk = (roomId: string | null) =>
      applyDayLock({
        dayKey: DAY,
        practitionerIds: null,
        roomId,
        allDay: true,
        bookingsDecision: "keep",
        expectedAffectedIds: [],
      });
    const b1 = await mk(r1);
    const b2 = await mk(r2);
    const all = await mk(null);
    if (!b1.ok || !b2.ok || !all.ok) throw new Error("setup");

    // Todo el consultorio (sin sala): solo el de "todos"; las salas ni aparecen.
    const r = await removeDayLock({ dayKey: DAY, practitionerId: null });
    if (!r.ok) throw new Error(r.error);
    expect(r.data.deleted).toBe(1);
    expect(r.data.remaining).toEqual([]);
    expect((await db.timeBlock.findUniqueOrThrow({ where: { id: all.data.ids[0] } })).deletedAt).not.toBeNull();

    // Por sala: solo la 1. La 2 sigue viva y no sale en `remaining` (el alcance es la sala 1).
    const s = await removeDayLock({ dayKey: DAY, practitionerId: null, roomId: r1 });
    if (!s.ok) throw new Error(s.error);
    expect(s.data.deleted).toBe(1);
    expect(s.data.remaining).toEqual([]);
    const live = await liveBlocksOn(DAY);
    expect(live.map((b) => b.id)).toEqual([b2.data.ids[0]]);
    // Sala sin bloqueos ese día → el mismo error que un día sin bloqueos.
    expect(await removeDayLock({ dayKey: DAY, practitionerId: null, roomId: r1 })).toEqual({
      ok: false,
      error: "Ese día no tiene bloqueos.",
    });
  });

  it("lectura: listTimeBlocks sin roomIds no trae bloqueos de sala; con roomIds trae solo esos; helper de la agenda → AgendaRoomBlockView", async () => {
    const DAY = "2027-04-19";
    asUser(C.userId);
    const rb = await createTimeBlock({ roomId: r1, startsAt: at(DAY, "09:00"), endsAt: at(DAY, "10:00"), reason: "Arreglo" });
    const rbN = await createTimeBlock({ roomId: rLoc2, startsAt: at(DAY, "09:00"), endsAt: at(DAY, "10:00") });
    const pb = await createTimeBlock({ practitionerId: null, startsAt: at(DAY, "18:00"), endsAt: at(DAY, "19:00") });
    if (!rb.ok || !rbN.ok || !pb.ok) throw new Error("setup");

    const plain = await listTimeBlocks({ from: DAY, to: DAY, practitionerIds: [C.practitionerId] });
    if (!plain.ok) throw new Error(plain.error);
    expect(plain.data.map((b) => b.id)).toEqual([pb.data.ids[0]]);
    expect(plain.data[0].roomId).toBeNull();

    const rooms = await listTimeBlocks({ from: DAY, to: DAY, roomIds: [r1] });
    if (!rooms.ok) throw new Error(rooms.error);
    expect(rooms.data.map((b) => [b.id, b.roomId, b.practitionerId, b.locationId])).toEqual([
      [rb.data.ids[0], r1, null, loc1],
    ]);

    // Helper puro que usa getAgendaAvailability (SR3a) dentro de su tx.
    const rows = await db.timeBlock.findMany({
      where: roomBlocksWhere({
        tenantId: C.tenantId,
        start: new Date(at(DAY, "00:00")),
        end: new Date(at("2027-04-20", "00:00")),
        locationId: loc1,
      }),
      select: ROOM_BLOCK_SELECT,
      orderBy: ROOM_BLOCK_ORDER,
    });
    expect(toAgendaRoomBlockViews(rows)).toEqual([
      {
        id: rb.data.ids[0],
        roomId: r1,
        startsAt: new Date(at(DAY, "09:00")).toISOString(),
        endsAt: new Date(at(DAY, "10:00")).toISOString(),
        reason: "Arreglo",
      },
    ]);
  });

  it("concurrencia: el bloqueo de sala espera la clave de sala de CADA día (antes que el lock de sedes) y recién después escribe", async () => {
    const days = ["2027-04-20", "2027-04-21", "2027-04-22"];
    const middle = roomLockKey({ tenantId: C.tenantId, roomId: r1, dayKey: days[1] });
    const locationsKey = `kinesoft:locations:${C.tenantId}`;
    asUser(C.userId);
    const h = await hold(middle);
    let settled = false;
    const pending = createTimeBlock({
      roomId: r1,
      startsAt: at(days[0], "00:00"),
      endsAt: at("2027-04-23", "00:00"),
      allDay: true,
      reason: "Obra",
    }).finally(() => (settled = true));
    try {
      await waitForAdvisoryWaiter(db, middle);
      // Espera en la sala: todavía no pidió el lock de sedes ni escribió.
      expect(await countAdvisoryWaiters(db, locationsKey)).toBe(0);
      expect(settled).toBe(false);
      expect(await db.timeBlock.count({ where: { tenantId: C.tenantId, reason: "Obra" } })).toBe(0);
    } finally {
      h.release();
      await h.done;
    }
    const r = await pending;
    if (!r.ok) throw new Error(r.error);
    expect(await db.timeBlock.count({ where: { tenantId: C.tenantId, reason: "Obra", deletedAt: null } })).toBe(1);

    // applyDayLock de sala: la misma clave del día.
    const DAY = "2027-04-26";
    const k = roomLockKey({ tenantId: C.tenantId, roomId: r2, dayKey: DAY });
    const h2 = await hold(k);
    const p2 = applyDayLock({
      dayKey: DAY,
      practitionerIds: null,
      roomId: r2,
      allDay: true,
      bookingsDecision: "keep",
      expectedAffectedIds: [],
    });
    try {
      await waitForAdvisoryWaiter(db, k);
      expect(await countAdvisoryWaiters(db, locationsKey)).toBe(0);
    } finally {
      h2.release();
      await h2.done;
    }
    expect((await p2).ok).toBe(true);
    // El E2E (createBooking con esa sala en paralelo con este apply: o el alta
    // entra antes y sale en `changed`, o ve el bloqueo como room-busy con
    // blocked) está en tests/integration/bookings-rooms.test.ts › "gate SR-B".
  });

  // Arrancó como it.fails("[SR1a] …"); se dio vuelta con el loader de SR1a (el bloqueo de sala sale de `blocks`).
  it("[SR1a] un bloqueo de sala no cambia los slots de nadie (el loader lo excluye de los bloqueos de 'todos')", async () => {
    const DAY = "2027-04-27";
    asUser(C.userId);
    const before = await listAvailableSlots({ practitionerId: C.practitionerId, serviceId: C.serviceId, dayKey: DAY });
    if (!before.ok || before.data.mode !== "practitioner") throw new Error("setup");
    const r = await applyDayLock({
      dayKey: DAY,
      practitionerIds: null,
      roomId: r1,
      allDay: true,
      bookingsDecision: "keep",
      expectedAffectedIds: [],
    });
    expect(r.ok).toBe(true);
    const after = await listAvailableSlots({ practitionerId: C.practitionerId, serviceId: C.serviceId, dayKey: DAY });
    if (!after.ok || after.data.mode !== "practitioner") throw new Error("slots");
    expect(after.data.dayLockState.status).toBe("open");
    expect(after.data.slots.filter((s) => s.available).map((s) => s.time)).toEqual(
      before.data.slots.filter((s) => s.available).map((s) => s.time)
    );
  });

  // Orquestador (handoff de SR-B): `liveBlocksInTx` (lib/bookings-core.ts,
  // el re-chequeo de bloqueos con el lock de cupo de `createBooking` y del
  // batch) trataba el bloqueo de SALA (practitionerId null por CHECK) como
  // "todos": un alta de cualquier profesional en esa ventana daba "bloqueado".
  it("[SR-B] un bloqueo de sala no bloquea el alta de un profesional (re-chequeo en vivo)", async () => {
    const DAY = "2027-04-13";
    asUser(C.userId);
    const blk = await createTimeBlock({ roomId: r1, startsAt: at(DAY, "09:00"), endsAt: at(DAY, "13:00"), reason: "Mantenimiento" });
    if (!blk.ok) throw new Error(blk.error);
    const patientId = await addPatient(db, C, { firstName: "Alta", lastName: `Sala ${uniqueSuffix()}` });
    const r = await createBooking({
      patientId,
      serviceId: C.serviceId,
      practitionerId: C.practitionerId,
      scheduledFor: new Date(at(DAY, "10:00")).toISOString(),
      durationMin: 45,
      idempotencyKey: `rbc-${uniqueSuffix()}`,
    });
    expect(r).toMatchObject({ ok: true });
  });
});

/**
 * SV06b · emisión realtime del candado y de los bloqueos (§18.7/§18.8, SV-D12).
 *
 * Antes de SV06b el candado revalidaba `bookingDays`/`dashboard` inline y no
 * avisaba a nadie: la Secretaria cancelaba un día entero y la agenda del
 * profesional (o la Sala de Espera) seguía mostrando los turnos hasta el
 * polling. Ahora:
 *   - los cancelados salen por `afterBookingsCommitted` (1 publish, con
 *     `roomId`, después del commit);
 *   - el bloqueo en sí sale por `afterAvailabilityCommitted` (1 `availability`);
 *   - «mantener» → refs vacío → 0 publish de turnos (SV-D12), igual invalida;
 *   - alta/baja de bloqueos sueltos (profesional o sala) y desbloquear → 1
 *     `availability` cada uno; uno de varios días → 1 con `day: null` (FX1b).
 * Se afirma con `realtimeFake.calls` (el publisher real nunca corre en
 * integración) y con `onCall` que la fila ya está commiteada al publicar.
 */
describe.skipIf(!RUN)("SV06b · emisión realtime del candado y los bloqueos", () => {
  let db: PrismaClient;
  let E: EphemeralTenant;
  let prac2: { userId: string; practitionerId: string };
  let room: { roomId: string; locationId: string };

  const bookingsCalls = () => realtimeFake.calls.filter((c) => c.refs !== undefined);
  const availabilityCalls = () => realtimeFake.calls.filter((c) => c.availability !== undefined);
  const tagCalls = (tag: string) => revalidateTagSpy.mock.calls.filter((c) => c[0] === tag).length;

  async function booking(practitionerId: string, day: string, hhmm: string, withRoom: boolean) {
    const patientId = await addPatient(db, E, { firstName: "Rita", lastName: `Rt ${uniqueSuffix()}` });
    return db.booking.create({
      data: {
        tenantId: E.tenantId,
        patientId,
        practitionerId,
        serviceId: E.serviceId,
        scheduledFor: new Date(at(day, hhmm)),
        durationMin: 45,
        status: "CONFIRMED",
        ...(withRoom ? { roomId: room.roomId, locationId: room.locationId } : {}),
        idempotencyKey: `sv06b-${uniqueSuffix()}`,
      },
    });
  }

  beforeAll(async () => {
    db = ownerClient();
    E = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    prac2 = await addPractitioner(db, E, "PRACTITIONER");
    room = await addRoom(db, E, { name: "Box SV" });
  });
  afterAll(async () => {
    await E?.cleanup();
    await db?.$disconnect();
  });
  beforeEach(() => {
    revalidatePathSpy.mockClear();
    revalidateTagSpy.mockClear();
  });

  // Arrancó como it.fails("[SV06b] …"): el candado no publicaba nada.
  it("[SV06b] candado con cancelar emite los cancelados con roomId, 1 vez, y ya no revalida inline", async () => {
    const DAY = "2027-06-08";
    asUser(E.userId);
    const withRoom = await booking(E.practitionerId, DAY, "10:00", true);
    const noRoom = await booking(E.practitionerId, DAY, "11:00", false);
    let statusAtPublish: string[] = [];
    realtimeFake.onCall = async (call) => {
      if (!call.refs) return;
      const rows = await db.booking.findMany({
        where: { id: { in: [withRoom.id, noRoom.id] } },
        select: { status: true },
      });
      statusAtPublish = rows.map((r) => r.status);
    };

    const r = await applyDayLock({
      dayKey: DAY,
      practitionerIds: [E.practitionerId],
      allDay: true,
      bookingsDecision: "cancel",
      expectedAffectedIds: [withRoom.id, noRoom.id].sort(),
    });
    if (!r.ok) throw new Error(r.error);

    const pub = bookingsCalls();
    expect(pub).toHaveLength(1);
    const refs = [...pub[0].refs!].sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime());
    expect(refs).toEqual([
      { bookingId: withRoom.id, practitionerId: E.practitionerId, scheduledFor: withRoom.scheduledFor, roomId: room.roomId },
      { bookingId: noRoom.id, practitionerId: E.practitionerId, scheduledFor: noRoom.scheduledFor, roomId: null },
    ]);
    // Fechas `Date` desde la tx, no el ISO de `DayLockAffected`.
    expect(refs[0].scheduledFor).toBeInstanceOf(Date);
    // Post-commit: al publicar, la cancelación ya está en la base.
    expect(statusAtPublish).toEqual(["CANCELLED", "CANCELLED"]);
    expect(availabilityCalls().map((c) => c.availability)).toEqual([{ practitionerId: E.practitionerId, day: DAY }]);
    // La invalidación sale por los hooks: `dashboard` una sola vez (antes
    // inline, ahora `afterBookingsCommitted`); `bookingDays` no se pierde.
    expect(tagCalls(tags.dashboard(E.tenantId))).toBe(1);
    expect(tagCalls(tags.bookingDays(E.tenantId))).toBe(1);
    expect(revalidatePathSpy).toHaveBeenCalledWith("/agenda");
  });

  it("candado con MANTENER → 0 publish de turnos y 1 availability (todos → practitionerId null), igual invalida", async () => {
    const DAY = "2027-06-09";
    asUser(E.userId);
    const b = await booking(prac2.practitionerId, DAY, "10:00", false);
    const r = await applyDayLock({
      dayKey: DAY,
      practitionerIds: null,
      allDay: true,
      bookingsDecision: "keep",
      expectedAffectedIds: [b.id],
    });
    if (!r.ok) throw new Error(r.error);
    expect(bookingsCalls()).toHaveLength(0);
    expect(availabilityCalls().map((c) => c.availability)).toEqual([{ practitionerId: null, day: DAY }]);
    expect(tagCalls(tags.bookingDays(E.tenantId))).toBe(1);
  });

  it("candado de varios profesionales → availability con practitionerId null", async () => {
    const DAY = "2027-06-10";
    asUser(E.userId);
    const r = await applyDayLock({
      dayKey: DAY,
      practitionerIds: [E.practitionerId, prac2.practitionerId],
      allDay: true,
      bookingsDecision: "keep",
      expectedAffectedIds: [],
    });
    if (!r.ok) throw new Error(r.error);
    expect(availabilityCalls().map((c) => c.availability)).toEqual([{ practitionerId: null, day: DAY }]);
  });

  it("bloqueo de profesional: crear y borrar → 1 availability cada uno, con el día AR (TZ=UTC)", async () => {
    // 22:00 AR = 01:00 UTC del día siguiente: el día tiene que ser el AR.
    const DAY = "2027-06-11";
    asUser(E.userId);
    const c = await createTimeBlock({
      practitionerId: prac2.practitionerId,
      startsAt: at(DAY, "21:00"),
      endsAt: at(DAY, "22:30"),
      reason: "Trámite",
    });
    if (!c.ok) throw new Error(c.error);
    expect(bookingsCalls()).toHaveLength(0);
    expect(availabilityCalls().map((x) => x.availability)).toEqual([{ practitionerId: prac2.practitionerId, day: DAY }]);
    expect(tagCalls(tags.bookingDays(E.tenantId))).toBe(1);

    realtimeFake.reset();
    const d = await deleteTimeBlock({ id: c.data.ids[0] });
    if (!d.ok) throw new Error(d.error);
    expect(availabilityCalls().map((x) => x.availability)).toEqual([{ practitionerId: prac2.practitionerId, day: DAY }]);
  });

  it("bloqueo de sala: crear y borrar → 1 availability cada uno (practitionerId null)", async () => {
    const DAY = "2027-06-14";
    asUser(E.userId);
    const c = await createTimeBlock({ roomId: room.roomId, startsAt: at(DAY, "09:00"), endsAt: at(DAY, "12:00") });
    if (!c.ok) throw new Error(c.error);
    expect(availabilityCalls().map((x) => x.availability)).toEqual([{ practitionerId: null, day: DAY }]);

    realtimeFake.reset();
    const d = await deleteTimeBlock({ id: c.data.ids[0] });
    if (!d.ok) throw new Error(d.error);
    expect(availabilityCalls().map((x) => x.availability)).toEqual([{ practitionerId: null, day: DAY }]);
  });

  it("[FX1b] bloqueo de 3 días → 1 availability con day:null y bookingDays revalidado 1 vez (crear y borrar); bloqueo que no se crea → nada", async () => {
    // §18.2 «1 commit = 1 POST»: SV06b mandaba un availability por día AR (3
    // POST + 3 revalidateTag del mismo tag por tenant). `day: null` = varios
    // días; el cliente re-pide lo que esté mirando.
    asUser(E.userId);
    const c = await createTimeBlock({
      practitionerId: E.practitionerId,
      startsAt: at("2027-06-15", "00:00"),
      endsAt: at("2027-06-18", "00:00"),
      allDay: true,
    });
    if (!c.ok) throw new Error(c.error);
    expect(availabilityCalls().map((x) => x.availability)).toEqual([{ practitionerId: E.practitionerId, day: null }]);
    expect(tagCalls(tags.bookingDays(E.tenantId))).toBe(1);

    realtimeFake.reset();
    revalidateTagSpy.mockClear();
    const d = await deleteTimeBlock({ id: c.data.ids[0] });
    if (!d.ok) throw new Error(d.error);
    expect(availabilityCalls().map((x) => x.availability)).toEqual([{ practitionerId: E.practitionerId, day: null }]);
    expect(tagCalls(tags.bookingDays(E.tenantId))).toBe(1);

    realtimeFake.reset();
    const bad = await deleteTimeBlock({ id: "c0000000000000000000000000" });
    expect(bad.ok).toBe(false);
    expect(realtimeFake.calls).toHaveLength(0);
  });

  it("[FX1b] bloqueo de día completo (00:00 → 00:00 del día siguiente AR) → 1 availability con SU día, no null", async () => {
    // El fin es exclusivo: termina a las 00:00 AR del día siguiente y no lo
    // toca. Con TZ=UTC, 00:00 AR = 03:00 UTC: el día tiene que ser el AR.
    asUser(E.userId);
    const c = await createTimeBlock({
      practitionerId: E.practitionerId,
      startsAt: at("2027-06-22", "00:00"),
      endsAt: at("2027-06-23", "00:00"),
      allDay: true,
    });
    if (!c.ok) throw new Error(c.error);
    expect(availabilityCalls().map((x) => x.availability)).toEqual([
      { practitionerId: E.practitionerId, day: "2027-06-22" },
    ]);
    expect(tagCalls(tags.bookingDays(E.tenantId))).toBe(1);
  });

  it("desbloquear el día → 1 availability; sin nada que quitar → nada", async () => {
    const DAY = "2027-06-21";
    asUser(E.userId);
    const r = await applyDayLock({
      dayKey: DAY,
      practitionerIds: [prac2.practitionerId],
      allDay: true,
      bookingsDecision: "keep",
      expectedAffectedIds: [],
    });
    if (!r.ok) throw new Error(r.error);
    realtimeFake.reset();
    const u = await removeDayLock({ dayKey: DAY, practitionerId: prac2.practitionerId });
    if (!u.ok) throw new Error(u.error);
    expect(u.data.deleted).toBe(1);
    expect(availabilityCalls().map((x) => x.availability)).toEqual([{ practitionerId: prac2.practitionerId, day: DAY }]);

    realtimeFake.reset();
    expect((await removeDayLock({ dayKey: DAY, practitionerId: prac2.practitionerId })).ok).toBe(false);
    expect(realtimeFake.calls).toHaveLength(0);
  });
});
