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
 *     parcial respeta las franjas.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { applyDayLock, previewDayLock, removeDayLock } from "@/lib/time-blocks";
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
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { revalidatePathSpy, revalidateTagSpy } from "@/tests/helpers/integration-setup";

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
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
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
    const ev = await db.auditEvent.findFirst({
      where: { tenantId: A.tenantId, action: "timeBlock.dayLock", entityId: rows[0].id },
    });
    expect(ev).not.toBeNull();

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
      ).toBeGreaterThanOrEqual(2);
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
