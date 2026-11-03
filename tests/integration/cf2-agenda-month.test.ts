/**
 * [CF2-MS] CF2 (§29 D-CF2-7, brief A.4/A.5) — `getAgendaMonthSummary` contra Postgres real, en los dos roles:
 * `npm run test:integration` (kinesoft_app, RLS) y `npm run test:integration:owner` (BYPASSRLS, como prod: ahí la
 * única barrera es el `where: { tenantId }` a mano).
 *
 * Se fija: paridad del conteo con `listAgendaBookings` para la misma sede (la principal incluye los turnos sin sede),
 * día AR en TZ=UTC (23:30 AR), cancelados fuera, ausentes en el segundo contador, candado `p`/`l`/`x` igual al
 * `dayLockState` que devuelve `getAgendaAvailability` (la Semana), profesionales con turnos y sin franjas, aislamiento
 * de tenant, la puerta (BILLING pasa: tiene `agenda.viewAll`; sin sesión no), ≤ 12 sentencias en 1 tx y ≤ 24 kB con
 * 8 profesionales × 42 días.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});

import { randomUUID } from "node:crypto";
import type { BookingStatus, Prisma, PrismaClient } from "@prisma/client";
import { getAgendaMonthSummary } from "@/lib/agenda-month";
import { listAgendaBookings } from "@/lib/bookings";
import { getAgendaAvailability } from "@/lib/availability-actions";
import type { AgendaMonthSummary, MonthLockCode } from "@/lib/agenda-month-types";
import type { DayLockState } from "@/lib/availability/types";
import { addDays, dayKeyOf, dayKeyToDbDate, dayWindow } from "@/lib/availability/day";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  addStaff,
  sweepOrphanTestTenants,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { measure } from "@/tests/helpers/query-counter";

const RUN = process.env.INTEGRATION === "1";
const FROM = "2027-11-01"; // lunes
const TO = "2027-12-05"; // domingo: 5 semanas
const ar = (local: string) => new Date(`${local}:00-03:00`);

function codeOf(s: DayLockState | undefined): MonthLockCode | undefined {
  if (!s || s.status === "open") return undefined;
  return s.status === "partial" ? "p" : s.reason === "sin-franjas" ? "x" : "l";
}

async function summary(raw: Parameters<typeof getAgendaMonthSummary>[0]): Promise<AgendaMonthSummary> {
  const r = await getAgendaMonthSummary(raw);
  if (!r.ok) throw new Error(`getAgendaMonthSummary: ${r.error}`);
  return r.data;
}

describe.skipIf(!RUN)("[CF2-MS] getAgendaMonthSummary (vista Mes)", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let U: EphemeralTenant;
  let L1: string;
  let L2: string;
  let LU: string;
  let P0: string; // titular sin franjas propias → red de seguridad lun-sáb en la principal
  let P1: string; // lun-vie 9-13 en la principal
  let P2: string; // lun-mié 14-18 en Norte
  let GHOST: string; // con turnos, sin membresía (no reservable)
  let billingUser: string;

  async function book(
    t: EphemeralTenant,
    practitionerId: string,
    local: string,
    o: { status?: BookingStatus; locationId?: string | null } = {}
  ) {
    await db.booking.create({
      data: {
        tenantId: t.tenantId,
        practitionerId,
        serviceId: t.serviceId,
        scheduledFor: ar(local),
        durationMin: 45,
        guestName: "Invitado",
        status: o.status ?? "CONFIRMED",
        locationId: o.locationId ?? null,
        idempotencyKey: randomUUID(),
      },
    });
  }

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    T = await createEphemeralTenant(db);
    U = await createEphemeralTenant(db);
    L1 = (await db.location.create({ data: { tenantId: T.tenantId, name: "Centro", isPrimary: true } })).id;
    L2 = (await db.location.create({ data: { tenantId: T.tenantId, name: "Norte" } })).id;
    LU = (await db.location.create({ data: { tenantId: U.tenantId, name: "Ajena", isPrimary: true } })).id;
    P0 = T.practitionerId;
    P1 = (await addPractitioner(db, T)).practitionerId;
    P2 = (await addPractitioner(db, T)).practitionerId;
    const ghost = await addPractitioner(db, T);
    GHOST = ghost.practitionerId;
    // `removeMember` borra la membresía y deja la fila Practitioner (historial): deja de ser reservable.
    await db.membership.deleteMany({ where: { tenantId: T.tenantId, userId: ghost.userId } });
    billingUser = (await addStaff(db, T, "BILLING")).userId;

    await db.practitionerSchedule.createMany({
      data: [
        ...[1, 2, 3, 4, 5].map((dow) => ({ tenantId: T.tenantId, practitionerId: P1, locationId: L1, dow, startMin: 540, endMin: 780 })),
        ...[1, 2, 3].map((dow) => ({ tenantId: T.tenantId, practitionerId: P2, locationId: L2, dow, startMin: 840, endMin: 1080 })),
      ],
    });
    await db.timeBlock.createMany({
      data: [
        { tenantId: T.tenantId, practitionerId: P1, startsAt: ar("2027-11-09T09:00"), endsAt: ar("2027-11-09T11:00"), reason: "Trámite", createdById: T.userId },
        { tenantId: T.tenantId, practitionerId: P2, startsAt: ar("2027-11-10T00:00"), endsAt: ar("2027-11-11T00:00"), allDay: true, reason: "Vacaciones", createdById: T.userId },
      ],
    });
    await db.scheduleException.create({
      data: { tenantId: T.tenantId, practitionerId: P1, date: dayKeyToDbDate("2027-11-15"), kind: "CLOSED", reason: "Congreso", createdById: T.userId },
    });

    await book(T, P1, "2027-11-02T23:30", { locationId: L1 }); // 02:30 UTC del 3
    await book(T, P1, "2027-11-02T10:00"); // sin sede = principal
    await book(T, P2, "2027-11-02T15:00", { locationId: L2 });
    await book(T, P1, "2027-11-03T10:00", { status: "CANCELLED" });
    await book(T, P1, "2027-11-03T11:00", { status: "NO_SHOW", locationId: L1 });
    await book(T, P1, "2027-11-03T12:00", { status: "COMPLETED", locationId: L1 });
    await book(T, GHOST, "2027-11-04T10:00");
    await book(T, P0, "2027-11-01T00:00", { locationId: L1 }); // primer instante del rango
    await book(T, P0, "2027-12-05T23:59", { locationId: L1 }); // último día
    await book(T, P0, "2027-10-31T23:59", { locationId: L1 }); // fuera
    await book(T, P0, "2027-12-06T00:00", { locationId: L1 }); // fuera
    await book(U, U.practitionerId, "2027-11-02T10:00", { locationId: LU });
    await book(U, U.practitionerId, "2027-11-02T11:00");
  }, 120_000);

  afterAll(async () => {
    await T?.cleanup();
    await U?.cleanup();
    await db?.$disconnect();
  });

  it("[CF2-MS10] paridad con listAgendaBookings por día, profesional y sede (todas, principal con «sin sede», Norte)", async () => {
    asUser(T.userId);
    for (const locationId of [null, L1, L2]) {
      const s = await summary({ from: FROM, to: TO, locationId });
      const rows = await listAgendaBookings({ from: dayWindow(FROM).start, to: dayWindow(TO).end, locationId });
      const want = new Map<string, [number, number]>();
      for (const r of rows) {
        if (r.status === "CANCELLED") continue;
        const key = `${dayKeyOf(new Date(r.scheduledFor))}|${r.practitionerId}`;
        const c = want.get(key) ?? [0, 0];
        c[0]++;
        if (r.status === "NO_SHOW") c[1]++;
        want.set(key, c);
      }
      const got = new Map<string, [number, number]>();
      for (const d of s.days) for (const [pid, c] of Object.entries(d.c ?? {})) got.set(`${d.k}|${pid}`, [c[0], c[1]]);
      expect(Object.fromEntries(got), `sede ${locationId ?? "todas"}`).toEqual(Object.fromEntries(want));
      expect(want.size).toBeGreaterThan(0);
    }
  });

  it("[CF2-MS11] día AR en TZ=UTC: 23:30 AR cuenta en su día; los bordes del rango entran y lo de afuera no", async () => {
    asUser(T.userId);
    const s = await summary({ from: FROM, to: TO });
    const day = (k: string) => s.days.find((d) => d.k === k)!;
    expect(s.days).toHaveLength(35);
    expect(day("2027-11-02").c?.[P1]).toEqual([2, 0]);
    expect(day("2027-11-03").c?.[P1]).toEqual([2, 1]); // cancelado fuera; el ausente cuenta en los dos
    expect(day("2027-11-01").c?.[P0]).toEqual([1, 0]);
    expect(day("2027-12-05").c?.[P0]).toEqual([1, 0]);
    expect(s.days.reduce((n, d) => n + (d.c?.[P0]?.[0] ?? 0), 0)).toBe(2);
  });

  it("[CF2-MS12] sede principal incluye los turnos sin sede; Norte no", async () => {
    asUser(T.userId);
    const main = await summary({ from: FROM, to: TO, locationId: L1 });
    const north = await summary({ from: FROM, to: TO, locationId: L2 });
    expect(main.locationId).toBe(L1);
    expect(main.days.find((d) => d.k === "2027-11-02")!.c).toEqual({ [P1]: [2, 0] });
    expect(main.days.find((d) => d.k === "2027-11-04")!.c).toEqual({ [GHOST]: [1, 0] });
    expect(north.days.find((d) => d.k === "2027-11-02")!.c).toEqual({ [P2]: [1, 0] });
    expect(north.days.find((d) => d.k === "2027-11-04")!.c).toBeUndefined();
  });

  it("[CF2-MS13] candado = el dayLockState de getAgendaAvailability (la Semana), por profesional y día", async () => {
    asUser(T.userId);
    for (const locationId of [null, L1, L2]) {
      const s = await summary({ from: FROM, to: TO, locationId });
      for (let w = 0; w < 5; w++) {
        const from = addDays(FROM, w * 7);
        const av = await getAgendaAvailability({ from, to: addDays(from, 6), locationId });
        if (!av.ok) throw new Error(av.error);
        for (const d of av.data.days) {
          const got = s.days.find((x) => x.k === d.dayKey)!;
          for (const [pid, pd] of Object.entries(d.byPractitioner)) {
            expect(got.l?.[pid], `${d.dayKey} ${pid} sede ${locationId ?? "todas"}`).toBe(codeOf(pd.dayLockState));
            const detail = pd.dayLockState.status === "open" ? undefined : (pd.dayLockState.detail ?? undefined);
            expect(got.d?.[pid]).toBe(detail);
          }
        }
      }
    }
    const s = await summary({ from: FROM, to: TO });
    const day = (k: string) => s.days.find((d) => d.k === k)!;
    expect(day("2027-11-09").l?.[P1]).toBe("p");
    expect(day("2027-11-09").d?.[P1]).toBe("Trámite");
    expect(day("2027-11-10").l?.[P2]).toBe("l");
    expect(day("2027-11-10").d?.[P2]).toBe("Vacaciones");
    expect(day("2027-11-15").l?.[P1]).toBe("l");
    expect(day("2027-11-15").d?.[P1]).toBe("Congreso");
    expect(day("2027-11-04").l?.[P2]).toBe("x"); // jueves: no atiende
    expect(day("2027-11-06").l?.[P0]).toBeUndefined(); // sábado: red de seguridad abierta
    expect(day("2027-11-07").l?.[P0]).toBe("x"); // domingo
  });

  it("[CF2-MS14] un profesional con turnos y sin franjas (sin membresía) aparece con su conteo y x", async () => {
    asUser(T.userId);
    const s = await summary({ from: FROM, to: TO });
    const d4 = s.days.find((d) => d.k === "2027-11-04")!;
    expect(d4.c?.[GHOST]).toEqual([1, 0]);
    expect(d4.l?.[GHOST]).toBe("x");
  });

  it("[CF2-MS15] where tenantId: el otro consultorio nunca aparece, ni pidiendo su sede", async () => {
    asUser(T.userId);
    const all = JSON.stringify(await summary({ from: FROM, to: TO }));
    expect(all).not.toContain(U.practitionerId);
    // Sede ajena: no matchea nada (como `listAgendaBookings`): sin turnos y nadie con franjas.
    const alien = await summary({ from: FROM, to: TO, locationId: LU });
    expect(JSON.stringify(alien)).not.toContain(U.practitionerId);
    expect(alien.days.some((d) => d.c)).toBe(false);
    // Nadie abierto ni parcial: sin franjas (x), salvo la excepción CLOSED de P1 del 15, que no depende de la sede (l).
    // (GHOST no figura: sin turnos en esa sede, y no es reservable.)
    expect(alien.days.every((d) => [P0, P1, P2].every((pid) => d.l?.[pid] === "x" || d.l?.[pid] === "l"))).toBe(true);
    expect(alien.days.some((d) => d.l?.[GHOST])).toBe(false);
    expect(alien.days.find((d) => d.k === "2027-11-15")!.l?.[P1]).toBe("l");
    // Y U solo se ve a sí mismo.
    asUser(U.userId);
    const u = await summary({ from: FROM, to: TO });
    const ids = new Set(u.days.flatMap((d) => [...Object.keys(d.c ?? {}), ...Object.keys(d.l ?? {})]));
    expect([...ids]).toEqual([U.practitionerId]);
    expect(u.days.find((d) => d.k === "2027-11-02")!.c).toEqual({ [U.practitionerId]: [2, 0] });
  });

  it("[CF2-MS16] puerta: BILLING tiene agenda.viewAll y pasa (como en la Semana); sin sesión no; zod rechaza", async () => {
    asUser(billingUser);
    const b = await getAgendaMonthSummary({ from: FROM, to: TO });
    expect(b.ok).toBe(true);
    expect(b.ok && b.data.days.find((d) => d.k === "2027-11-02")!.c?.[P1]).toEqual([2, 0]);
    asUser(T.userId);
    expect((await getAgendaMonthSummary({ from: "2027-11-02", to: TO })).ok).toBe(false);
    expect((await getAgendaMonthSummary({ from: FROM, to: addDays(FROM, 42) })).ok).toBe(false);
    // Sin sesión no se afirma acá: con KINESOFT_ALLOW_DEMO_ACTOR=1 en .env.local `getActor` devuelve el actor demo
    // (access-loop.test.ts:215). El rechazo sin la capability lo fija la unit [CF2-MS8] con la matriz real.
  });

  it("[CF2-MS17] 1 tx y ≤ 12 sentencias (con y sin sede)", async () => {
    asUser(T.userId);
    for (const locationId of [null, L2]) {
      await getAgendaMonthSummary({ from: FROM, to: TO, locationId }); // calentamiento (memo del actor)
      const { result, m } = await measure(() => getAgendaMonthSummary({ from: FROM, to: TO, locationId }));
      expect(result.ok).toBe(true);
      expect(m.transactions, `sede ${locationId ?? "todas"}`).toBe(1);
      expect(m.statements, `sede ${locationId ?? "todas"}`).toBeLessThanOrEqual(12);
      // `rangesOnly`: el loader no trae servicios, reglas por servicio ni coberturas, y el único SELECT de turnos es
      // el de 3 columnas del resumen (sin `durationMin`, que sí trae la query de turnos del loader).
      const rec = (globalThis as unknown as { __kineQueryRecorder?: { events: { query: string }[] } }).__kineQueryRecorder;
      const qs = (rec?.events ?? []).map((e) => e.query);
      expect(qs.filter((q) => /FROM "public"\."(PractitionerService|Service|PractitionerPayer)"/.test(q))).toEqual([]);
      const bookingSelects = qs.filter((q) => /FROM "public"\."Booking"/.test(q));
      expect(bookingSelects).toHaveLength(1);
      expect(bookingSelects[0]).not.toMatch(/"durationMin"/);
    }
  });

  describe("[CF2-MS18] volumen: 8 profesionales × 42 días", () => {
    let V: EphemeralTenant;
    const FROM42 = FROM;
    const TO42 = addDays(FROM, 41);

    beforeAll(async () => {
      V = await createEphemeralTenant(db);
      const LV = (await db.location.create({ data: { tenantId: V.tenantId, name: "Centro", isPrimary: true } })).id;
      const pracs = [V.practitionerId];
      for (let i = 0; i < 7; i++) pracs.push((await addPractitioner(db, V)).practitionerId);
      await db.practitionerSchedule.createMany({
        data: pracs.flatMap((practitionerId) =>
          [1, 2, 3, 4, 5, 6].map((dow) => ({ tenantId: V.tenantId, practitionerId, locationId: LV, dow, startMin: 480, endMin: 1200 }))
        ),
      });
      const data: Prisma.BookingCreateManyInput[] = [];
      const blocks: Prisma.TimeBlockCreateManyInput[] = [];
      for (let d = 0; d < 42; d++) {
        const k = addDays(FROM42, d);
        pracs.forEach((practitionerId, i) => {
          for (let h = 0; h < 10; h++) {
            data.push({
              tenantId: V.tenantId,
              practitionerId,
              serviceId: V.serviceId,
              scheduledFor: ar(`${k}T${String(8 + h).padStart(2, "0")}:00`),
              durationMin: 45,
              guestName: "Invitado",
              status: h === 9 ? "NO_SHOW" : h === 8 ? "CANCELLED" : "CONFIRMED",
              locationId: LV,
              idempotencyKey: randomUUID(),
            });
          }
          // Un parcial con texto largo cada 3 días por profesional: lo más caro del cable (`l` + `d`).
          if ((d + i) % 3 === 0) {
            blocks.push({
              tenantId: V.tenantId,
              practitionerId,
              startsAt: ar(`${k}T08:00`),
              endsAt: ar(`${k}T10:00`),
              reason: "Capacitación interna del equipo",
              createdById: V.userId,
            });
          }
        });
      }
      await db.booking.createMany({ data });
      await db.timeBlock.createMany({ data: blocks });
    }, 180_000);

    afterAll(async () => {
      await V?.cleanup();
    });

    it("[CF2-MS18] ≤ 24 kB y ≤ 12 sentencias en 1 tx", async () => {
      asUser(V.userId);
      await getAgendaMonthSummary({ from: FROM42, to: TO42 });
      const { result, m } = await measure(() => getAgendaMonthSummary({ from: FROM42, to: TO42 }));
      if (!result.ok) throw new Error(result.error);
      const bytes = Buffer.byteLength(JSON.stringify(result.data), "utf8");
      console.log(`[CF2-MS18] ${bytes} B, ${m.statements} sentencias, ${m.transactions} tx, dbMs ${m.dbMs}`);
      expect(result.data.days).toHaveLength(42);
      expect(result.data.days[0].c?.[V.practitionerId]).toEqual([9, 1]);
      expect(bytes).toBeLessThanOrEqual(24 * 1024);
      expect(m.transactions).toBe(1);
      expect(m.statements).toBeLessThanOrEqual(12);
    });
  });
});
