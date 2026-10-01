/**
 * B2.4b CFG-api-2 — bloqueos de horario contra la DB real (rol app con RLS y
 * owner BYPASSRLS = prod). Corre en TZ=UTC (script de integración): es lo que
 * destapa un "allDay" calculado con el día del host en vez del día AR.
 *
 * Lo que se protege:
 *   - authz (`canManageBlocksFor`): PRACTITIONER bloquea SOLO lo suyo; "todos"
 *     y agendas ajenas exigen `agenda.manageBlocks` (ASSISTANT sí);
 *   - IDOR: profesional / sede de otro tenant (las FK de TimeBlock saltean RLS);
 *   - groupId: N filas para un subconjunto y borrado (soft) por grupo;
 *   - los turnos afectados se REPORTAN sin modificarlos (cancelar es B4.4).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTimeBlock, deleteTimeBlock, listTimeBlocks } from "@/lib/time-blocks";
import { ForbiddenError } from "@/lib/session";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  addPatient,
  addService,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { lockCapacity } from "@/lib/booking-cap-lock";

const RUN = process.env.INTEGRATION === "1";

// Un martes lejano: no choca con nada y no depende del reloj.
const DAY = "2027-03-09";
const at = (hhmm: string, day = DAY) => `${day}T${hhmm}:00-03:00`;

describe.skipIf(!RUN)("bloqueos de horario (B2.4b)", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let prac2: { userId: string; practitionerId: string };
  let assistant: { userId: string; practitionerId: string };
  let locPrimary: string;
  let locOther: string;
  let locOfB: string;

  async function bookingAt(
    practitionerId: string,
    hhmm: string,
    extra: {
      durationMin?: number;
      status?: "CONFIRMED" | "CANCELLED" | "PENDING";
      locationId?: string | null;
      day?: string;
    } = {}
  ) {
    const patientId = await addPatient(db, A, { firstName: "Ana", lastName: `Paz ${uniqueSuffix()}` });
    return db.booking.create({
      data: {
        tenantId: A.tenantId,
        patientId,
        practitionerId,
        serviceId: A.serviceId,
        scheduledFor: new Date(at(hhmm, extra.day)),
        durationMin: extra.durationMin ?? 45,
        status: extra.status ?? "CONFIRMED",
        idempotencyKey: `tb-${uniqueSuffix()}`,
        locationId: extra.locationId === undefined ? null : extra.locationId,
      },
    });
  }

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
    prac2 = await addPractitioner(db, A, "PRACTITIONER");
    assistant = await addPractitioner(db, A, "ASSISTANT");
    locPrimary = (await db.location.create({ data: { tenantId: A.tenantId, name: "Principal", isPrimary: true } })).id;
    locOther = (await db.location.create({ data: { tenantId: A.tenantId, name: "Anexo" } })).id;
    locOfB = (await db.location.create({ data: { tenantId: B.tenantId, name: "Principal", isPrimary: true } })).id;
  });
  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await db?.$disconnect();
  });

  describe("authz", () => {
    it("PRACTITIONER bloquea su propia agenda", async () => {
      asUser(prac2.userId);
      const r = await createTimeBlock({
        practitionerId: prac2.practitionerId,
        startsAt: at("13:00"),
        endsAt: at("14:00"),
        reason: "Trámite",
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const row = await db.timeBlock.findUniqueOrThrow({ where: { id: r.data.ids[0] } });
      expect(row).toMatchObject({
        tenantId: A.tenantId,
        practitionerId: prac2.practitionerId,
        groupId: null,
        reason: "Trámite",
        createdById: prac2.userId,
        deletedAt: null,
      });
    });

    it("PRACTITIONER: agenda ajena, 'todos' o un grupo con un ajeno → ForbiddenError, sin filas", async () => {
      asUser(prac2.userId);
      const before = await db.timeBlock.count({ where: { tenantId: A.tenantId } });
      await expect(
        createTimeBlock({ practitionerId: A.practitionerId, startsAt: at("09:00"), endsAt: at("10:00") })
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        createTimeBlock({ practitionerId: null, startsAt: at("09:00"), endsAt: at("10:00") })
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        createTimeBlock({
          practitionerIds: [prac2.practitionerId, A.practitionerId],
          startsAt: at("09:00"),
          endsAt: at("10:00"),
        })
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(await db.timeBlock.count({ where: { tenantId: A.tenantId } })).toBe(before);
    });

    it("ASSISTANT bloquea agendas ajenas y 'todos' (una fila con practitionerId null)", async () => {
      asUser(assistant.userId);
      const other = await createTimeBlock({
        practitionerId: A.practitionerId,
        startsAt: at("15:00"),
        endsAt: at("16:00"),
      });
      expect(other.ok).toBe(true);
      const all = await createTimeBlock({
        practitionerId: null,
        startsAt: at("19:00"),
        endsAt: at("20:00"),
        reason: "Feriado",
      });
      expect(all.ok).toBe(true);
      if (!all.ok) return;
      expect(all.data.ids).toHaveLength(1);
      const row = await db.timeBlock.findUniqueOrThrow({ where: { id: all.data.ids[0] } });
      expect(row.practitionerId).toBeNull();
      expect(row.groupId).toBeNull();
    });

    it("PRACTITIONER no borra el bloqueo ajeno ni el de 'todos'; el propio sí", async () => {
      asUser(assistant.userId);
      const theirs = await createTimeBlock({
        practitionerId: A.practitionerId,
        startsAt: at("11:00", "2027-03-10"),
        endsAt: at("12:00", "2027-03-10"),
      });
      if (!theirs.ok) throw new Error(theirs.error);
      asUser(prac2.userId);
      await expect(deleteTimeBlock({ id: theirs.data.ids[0] })).rejects.toBeInstanceOf(ForbiddenError);
      expect((await db.timeBlock.findUniqueOrThrow({ where: { id: theirs.data.ids[0] } })).deletedAt).toBeNull();

      const mine = await createTimeBlock({
        practitionerId: prac2.practitionerId,
        startsAt: at("11:00", "2027-03-10"),
        endsAt: at("12:00", "2027-03-10"),
      });
      if (!mine.ok) throw new Error(mine.error);
      expect(await deleteTimeBlock({ id: mine.data.ids[0] })).toEqual({ ok: true, data: { deleted: 1 } });
      expect((await db.timeBlock.findUniqueOrThrow({ where: { id: mine.data.ids[0] } })).deletedAt).not.toBeNull();
    });
  });

  describe("IDOR", () => {
    it("sede de otro tenant → rechazo, sin fila", async () => {
      asUser(A.userId);
      const before = await db.timeBlock.count({ where: { tenantId: A.tenantId } });
      const r = await createTimeBlock({
        practitionerId: A.practitionerId,
        locationId: locOfB,
        startsAt: at("09:00"),
        endsAt: at("10:00"),
      });
      expect(r).toEqual({ ok: false, error: "Sede no encontrada." });
      expect(await db.timeBlock.count({ where: { tenantId: A.tenantId } })).toBe(before);
      expect(await db.timeBlock.count({ where: { locationId: locOfB } })).toBe(0);
    });

    // Integrador B2 (handoff de B2.4a): sede del tenant pero archivada → rechazo.
    it("sede archivada del propio tenant → rechazo, sin fila", async () => {
      const archived = await db.location.create({
        data: { tenantId: A.tenantId, name: `Archivada ${uniqueSuffix()}`, isPrimary: false, active: false },
      });
      asUser(A.userId);
      const r = await createTimeBlock({
        practitionerId: A.practitionerId,
        locationId: archived.id,
        startsAt: at("09:00"),
        endsAt: at("10:00"),
      });
      expect(r).toEqual({ ok: false, error: "La sede está archivada." });
      expect(await db.timeBlock.count({ where: { locationId: archived.id } })).toBe(0);
    });

    it("profesional de otro tenant (solo o dentro de un grupo) → rechazo, sin filas", async () => {
      asUser(A.userId);
      const before = await db.timeBlock.count({ where: { tenantId: A.tenantId } });
      expect(
        await createTimeBlock({ practitionerId: B.practitionerId, startsAt: at("09:00"), endsAt: at("10:00") })
      ).toEqual({ ok: false, error: "Profesional no encontrado." });
      expect(
        await createTimeBlock({
          practitionerIds: [A.practitionerId, B.practitionerId],
          startsAt: at("09:00"),
          endsAt: at("10:00"),
        })
      ).toEqual({ ok: false, error: "Profesional no encontrado." });
      expect(await db.timeBlock.count({ where: { tenantId: A.tenantId } })).toBe(before);
      expect(await db.timeBlock.count({ where: { practitionerId: B.practitionerId } })).toBe(0);
    });

    it("bloqueo de otro tenant: ni se lista ni se borra", async () => {
      const foreign = await db.timeBlock.create({
        data: {
          tenantId: B.tenantId,
          practitionerId: B.practitionerId,
          startsAt: new Date(at("09:00")),
          endsAt: new Date(at("10:00")),
          createdById: B.userId,
          groupId: `g-${uniqueSuffix()}`,
        },
      });
      asUser(A.userId);
      expect(await deleteTimeBlock({ id: foreign.id })).toEqual({ ok: false, error: "Bloqueo no encontrado." });
      expect(await deleteTimeBlock({ groupId: foreign.groupId! })).toEqual({
        ok: false,
        error: "Bloqueo no encontrado.",
      });
      expect((await db.timeBlock.findUniqueOrThrow({ where: { id: foreign.id } })).deletedAt).toBeNull();
      const list = await listTimeBlocks({ from: DAY, to: DAY });
      expect(list.ok && list.data.some((b) => b.id === foreign.id)).toBe(false);
    });
  });

  describe("grupos y listado", () => {
    it("subconjunto → N filas con el mismo groupId; borrar por grupo las borra todas (soft)", async () => {
      asUser(A.userId);
      const day = "2027-03-11";
      const r = await createTimeBlock({
        practitionerIds: [A.practitionerId, prac2.practitionerId, prac2.practitionerId],
        locationId: locOther,
        startsAt: at("08:00", day),
        endsAt: at("12:00", day),
        reason: "Capacitación",
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data.ids).toHaveLength(2);
      expect(r.data.groupId).toBeTruthy();
      const rows = await db.timeBlock.findMany({ where: { groupId: r.data.groupId! } });
      expect(rows.map((x) => x.practitionerId).sort()).toEqual(
        [A.practitionerId, prac2.practitionerId].sort()
      );
      expect(rows.every((x) => x.locationId === locOther && x.tenantId === A.tenantId)).toBe(true);

      const listed = await listTimeBlocks({ from: day, to: day, practitionerIds: [prac2.practitionerId] });
      expect(listed.ok && listed.data.map((b) => b.id)).toEqual(
        rows.filter((x) => x.practitionerId === prac2.practitionerId).map((x) => x.id)
      );

      expect(await deleteTimeBlock({ groupId: r.data.groupId! })).toEqual({ ok: true, data: { deleted: 2 } });
      const after = await db.timeBlock.findMany({ where: { groupId: r.data.groupId! } });
      expect(after).toHaveLength(2); // soft: las filas siguen
      expect(after.every((x) => x.deletedAt !== null)).toBe(true);
      const relisted = await listTimeBlocks({ from: day, to: day });
      expect(relisted.ok && relisted.data).toEqual([]);
      // Borrar de nuevo: ya no hay vigentes.
      expect(await deleteTimeBlock({ groupId: r.data.groupId! })).toEqual({
        ok: false,
        error: "Bloqueo no encontrado.",
      });
    });

    it("el listado incluye los de 'todos' y los de todas las sedes al filtrar", async () => {
      asUser(A.userId);
      const day = "2027-03-12";
      const all = await createTimeBlock({ practitionerId: null, startsAt: at("09:00", day), endsAt: at("10:00", day) });
      const own = await createTimeBlock({
        practitionerId: A.practitionerId,
        locationId: locOther,
        startsAt: at("10:00", day),
        endsAt: at("11:00", day),
      });
      if (!all.ok || !own.ok) throw new Error("setup");
      const r = await listTimeBlocks({ from: day, to: day, practitionerIds: [prac2.practitionerId], locationId: locPrimary });
      expect(r.ok && r.data.map((b) => b.id)).toEqual(all.data.ids);
      const r2 = await listTimeBlocks({ from: day, to: day, practitionerIds: [A.practitionerId], locationId: locOther });
      expect(r2.ok && r2.data.map((b) => b.id)).toEqual([...all.data.ids, ...own.data.ids]);
    });
  });

  describe("ventana", () => {
    it("allDay en host UTC: el día AR del inicio, [00:00, 24:00) AR", async () => {
      expect(new Date().getTimezoneOffset()).toBe(0); // la suite corre en TZ=UTC
      asUser(A.userId);
      // 01:30Z del 14 = 22:30 AR del 13: el día del host (14) sería el equivocado.
      const r = await createTimeBlock({
        practitionerId: A.practitionerId,
        startsAt: "2027-03-14T01:30:00Z",
        endsAt: "2027-03-14T02:00:00Z",
        allDay: true,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data.startsAt).toBe("2027-03-13T03:00:00.000Z");
      expect(r.data.endsAt).toBe("2027-03-14T03:00:00.000Z");
      const row = await db.timeBlock.findUniqueOrThrow({ where: { id: r.data.ids[0] } });
      expect(row.allDay).toBe(true);
      expect(row.startsAt.toISOString()).toBe("2027-03-13T03:00:00.000Z");
      expect(row.endsAt.toISOString()).toBe("2027-03-14T03:00:00.000Z");
    });

    it("allDay de varios días con fin a medianoche exacta no suma un día", async () => {
      asUser(A.userId);
      const r = await createTimeBlock({
        practitionerId: A.practitionerId,
        startsAt: "2027-04-05T12:00:00-03:00",
        endsAt: "2027-04-08T00:00:00-03:00",
        allDay: true,
      });
      expect(r.ok && [r.data.startsAt, r.data.endsAt]).toEqual([
        "2027-04-05T03:00:00.000Z",
        "2027-04-08T03:00:00.000Z",
      ]);
    });

    it("rechaza fin <= inicio y más de 31 días (sin filas)", async () => {
      asUser(A.userId);
      const before = await db.timeBlock.count({ where: { tenantId: A.tenantId } });
      expect((await createTimeBlock({ practitionerId: A.practitionerId, startsAt: at("10:00"), endsAt: at("10:00") })).ok).toBe(false);
      expect((await createTimeBlock({ practitionerId: A.practitionerId, startsAt: at("10:00"), endsAt: at("09:00") })).ok).toBe(false);
      expect(
        (await createTimeBlock({
          practitionerId: A.practitionerId,
          startsAt: "2027-05-01T00:00:00-03:00",
          endsAt: "2027-06-02T00:00:00-03:00",
        })).ok
      ).toBe(false);
      // 31 días justos sí.
      expect(
        (await createTimeBlock({
          practitionerId: A.practitionerId,
          startsAt: "2027-05-01T00:00:00-03:00",
          endsAt: "2027-06-01T00:00:00-03:00",
        })).ok
      ).toBe(true);
      expect(await db.timeBlock.count({ where: { tenantId: A.tenantId } })).toBe(before + 1);
      // Sin offset sería hora del host: se rechaza.
      expect(
        (await createTimeBlock({ practitionerId: A.practitionerId, startsAt: "2027-03-09T10:00", endsAt: "2027-03-09T11:00" })).ok
      ).toBe(false);
    });
  });

  describe("turnos afectados", () => {
    it("reporta los activos que pisa (incl. el que empezó antes) y NO los modifica", async () => {
      const day = "2027-03-16";
      const t = (h: string) => `${day}T${h}:00-03:00`;
      const mk = (pid: string, h: string, extra: Parameters<typeof bookingAt>[2] = {}) =>
        bookingAt(pid, h, { ...extra, day });
      const overlapsStart = await mk(A.practitionerId, "09:30", { durationMin: 60 }); // 09:30-10:30
      const inside = await mk(A.practitionerId, "10:15", { locationId: locPrimary });
      const endsAtStart = await mk(A.practitionerId, "09:15"); // 09:15-10:00: no pisa
      const cancelled = await mk(A.practitionerId, "10:30", { status: "CANCELLED" });
      const otherPrac = await mk(prac2.practitionerId, "10:30");
      const otherLoc = await mk(A.practitionerId, "11:00", { locationId: locOther });
      // Reserva pública impaga y vencida (>30 min): ya no ocupa el horario (§5.18).
      const expiredPublic = await mk(A.practitionerId, "11:30", { status: "PENDING" });
      await db.booking.update({
        where: { id: expiredPublic.id },
        data: {
          idempotencyKey: `pub:${A.tenantId}:${uniqueSuffix()}`,
          paymentStatus: "UNPAID",
          createdAt: new Date(Date.now() - 2 * 60 * 60_000),
        },
      });
      const snapshot = await db.booking.findMany({
        where: { tenantId: A.tenantId, scheduledFor: { gte: new Date(t("00:00")), lt: new Date(t("23:59")) } },
        orderBy: { id: "asc" },
      });

      asUser(A.userId);
      const r = await createTimeBlock({
        practitionerId: A.practitionerId,
        startsAt: t("10:00"),
        endsAt: t("12:00"),
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data.affected.count).toBe(3);
      expect(r.data.affected.bookings.map((b) => b.id)).toEqual([overlapsStart.id, inside.id, otherLoc.id]);
      expect(r.data.affected.bookings[0]).toMatchObject({
        practitionerId: A.practitionerId,
        scheduledFor: new Date(t("09:30")).toISOString(),
        durationMin: 60,
      });
      expect(r.data.affected.bookings[0].patientName).toMatch(/^Ana Paz /);
      // Nada clínico en la respuesta.
      expect(Object.keys(r.data.affected.bookings[0]).sort()).toEqual(
        ["durationMin", "id", "patientName", "practitionerId", "scheduledFor"]
      );
      expect([endsAtStart.id, cancelled.id, otherPrac.id, expiredPublic.id].some((id) =>
        r.data.affected.bookings.some((b) => b.id === id)
      )).toBe(false);

      // Con sede: la principal incluye los turnos con locationId null (= principal).
      const withLoc = await createTimeBlock({
        practitionerId: A.practitionerId,
        locationId: locPrimary,
        startsAt: t("10:00"),
        endsAt: t("12:00"),
      });
      expect(withLoc.ok && withLoc.data.affected.bookings.map((b) => b.id)).toEqual([overlapsStart.id, inside.id]);

      // "Todos" (ASSISTANT): alcanza al otro profesional.
      asUser(assistant.userId);
      const all = await createTimeBlock({ practitionerId: null, startsAt: t("10:00"), endsAt: t("12:00") });
      expect(all.ok && all.data.affected.bookings.map((b) => b.id).sort()).toEqual(
        [overlapsStart.id, inside.id, otherPrac.id, otherLoc.id].sort()
      );

      // Los turnos quedaron EXACTAMENTE igual (status, updatedAt, todo).
      const after = await db.booking.findMany({
        where: { tenantId: A.tenantId, scheduledFor: { gte: new Date(t("00:00")), lt: new Date(t("23:59")) } },
        orderBy: { id: "asc" },
      });
      expect(after).toEqual(snapshot);
    });
  });

  // ── Carrera con un alta en vuelo (revisión de B-pre) ──────────────────────
  // `createTimeBlock` no tomaba los locks de cupo: un alta que ya había
  // re-chequeado bloqueos con su lock tomado (`liveBlocksInTx`) y todavía no
  // commiteaba no veía el bloqueo, y el bloqueo tampoco la veía a ella → turno
  // sin marca de sobreturno y fuera de `affected`. Sin timing: el test toma el
  // MISMO lock (profesional, servicio, día AR) que el alta, arranca el bloqueo,
  // espera a verlo trabado en `pg_locks`, escribe "el alta" en su tx y suelta.
  describe("carrera con un alta en vuelo", () => {
    async function whileCapLockHeld<T>(
      key: { practitionerId: string; serviceId: string; dayKey: string },
      start: () => Promise<T>,
      inFlight: (t: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]) => Promise<{ id: string }>
    ): Promise<{ result: T; bookingId: string }> {
      let release!: () => void;
      const released = new Promise<void>((r) => (release = r));
      let acquired!: () => void;
      const got = new Promise<void>((r) => (acquired = r));
      let bookingId = "";
      const holder = db.$transaction(
        async (t) => {
          await lockCapacity(t, { tenantId: A.tenantId, ...key });
          acquired();
          await released;
          bookingId = (await inFlight(t)).id;
        },
        { timeout: 20_000 }
      );
      await got;
      const pending = start();
      let waiting = false;
      for (let i = 0; i < 200 && !waiting; i++) {
        const [{ n }] = await db.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;
        waiting = n > 0;
        if (!waiting) await new Promise((r) => setTimeout(r, 25));
      }
      // Sin el fix el bloqueo NO espera: commitea antes y esto queda en false.
      expect(waiting).toBe(true);
      release();
      await holder;
      return { result: await pending, bookingId };
    }

    const inFlightBooking =
      (practitionerId: string, serviceId: string, iso: string) =>
      async (t: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]) =>
        t.booking.create({
          data: {
            tenantId: A.tenantId,
            patientId: await addPatient(db, A),
            practitionerId,
            serviceId,
            scheduledFor: new Date(iso),
            durationMin: 45,
            status: "CONFIRMED",
            idempotencyKey: `tb-race-${uniqueSuffix()}`,
          },
          select: { id: true },
        });

    it("bloqueo de un profesional: espera el COMMIT del alta y la reporta en affected", async () => {
      const day = "2027-04-13";
      asUser(A.userId);
      const { result, bookingId } = await whileCapLockHeld(
        { practitionerId: A.practitionerId, serviceId: A.serviceId, dayKey: day },
        () => createTimeBlock({ practitionerId: A.practitionerId, startsAt: at("09:00", day), endsAt: at("12:00", day) }),
        inFlightBooking(A.practitionerId, A.serviceId, at("10:00", day))
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.affected.bookings.map((b) => b.id)).toEqual([bookingId]);
    });

    it("'todos' de varios días: lockea cada profesional × servicio × día (otro profesional, otro servicio, día 2)", async () => {
      const svc = await addService(db, A, { name: `Race ${uniqueSuffix()}` });
      const day2 = "2027-04-21";
      asUser(assistant.userId);
      const { result, bookingId } = await whileCapLockHeld(
        { practitionerId: prac2.practitionerId, serviceId: svc, dayKey: day2 },
        () =>
          createTimeBlock({
            practitionerId: null,
            allDay: true,
            startsAt: at("00:00", "2027-04-20"),
            endsAt: at("00:00", "2027-04-22"),
          }),
        inFlightBooking(prac2.practitionerId, svc, at("15:00", day2))
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.affected.bookings.map((b) => b.id)).toContain(bookingId);
    });
  });
});
