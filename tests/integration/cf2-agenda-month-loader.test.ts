/**
 * [CF2-LD] CF2 (§29 D-CF2-7, brief A.4 «Loader» y A.5) — `loadAgendaPage` con `monthRange` (vista Mes), contra
 * Postgres real en los dos roles: `npm run test:integration` (kinesoft_app, RLS) y `npm run test:integration:owner`
 * (BYPASSRLS, como prod).
 *
 * Presupuesto propio (no `tests/perf/loaders.perf.test.ts`, que en esta ola es de P-S2): se mide el loader REAL con el
 * contador de sentencias/tx de `tests/helpers/query-counter.ts`.
 *   - Mes: ≤ 2 tx (bootstrap + resumen del mes), CERO llamadas a la carga de semana (`listAgendaBookings`,
 *     `getAgendaAvailability`), y el resumen = el de `getAgendaMonthSummary` con la sede de las preferencias.
 *   - Semana (sin `monthRange`): las mismas sentencias que antes, sumadas pieza por pieza (turnos + bootstrap +
 *     disponibilidad + preferencias), y `month: null`.
 *   - Sin `agenda.viewAll`: el mes no se calcula (null, ninguna sentencia de franjas ni de turnos).
 *
 * Los dos `vi.mock` de abajo NO reemplazan nada: envuelven la función real en un `vi.fn` para contar las llamadas.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});
vi.mock("@/lib/bookings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/bookings")>();
  return { ...actual, listAgendaBookings: vi.fn(actual.listAgendaBookings) };
});
vi.mock("@/lib/availability-actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/availability-actions")>();
  return { ...actual, getAgendaAvailability: vi.fn(actual.getAgendaAvailability) };
});

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { loadAgendaPage, loadAgendaBootstrapInTx } from "@/lib/agenda-page-loader";
import { getAgendaMonthSummary } from "@/lib/agenda-month";
import type { AgendaMonthSummary } from "@/lib/agenda-month-types";
import { listAgendaBookings } from "@/lib/bookings";
import { getAgendaAvailability } from "@/lib/availability-actions";
import { getUserPreferences } from "@/lib/preferences";
import { capabilitiesForActor } from "@/lib/authz";
import { monthGridRange } from "@/lib/agenda-client-state";
import { agendaRowToDTO, encodeAgendaWire } from "@/lib/agenda-wire";
import { addDays, dayKeyToDbDate, dayWindow } from "@/lib/availability/day";
import { getActor, type Actor } from "@/lib/session";
import { runWithRls } from "@/lib/rls";
import { measure } from "@/tests/helpers/query-counter";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  addStaff,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";
const ANCHOR = "2027-11-17";
const GRID = monthGridRange(ANCHOR); // 2027-11-01 (lun) → 2027-12-05 (dom)
const MONDAY = "2027-11-08";
const ar = (local: string) => new Date(`${local}:00-03:00`);

const bookingsSpy = vi.mocked(listAgendaBookings);
const availabilitySpy = vi.mocked(getAgendaAvailability);

async function actionSummary(locationId: string | null): Promise<AgendaMonthSummary> {
  const r = await getAgendaMonthSummary({ from: GRID.from, to: GRID.to, locationId });
  if (!r.ok) throw new Error(`getAgendaMonthSummary: ${r.error}`);
  return r.data;
}

describe.skipIf(!RUN)("[CF2-LD] loadAgendaPage · vista Mes", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let L1: string;
  let L2: string;
  let P1: string;
  let assistantUser: string;
  let outsiderUser: string;
  const afterAllCleanups: Array<() => Promise<unknown>> = [];

  async function setPrefsLocation(userId: string, locationId: string | null) {
    const agendaPrefs = locationId ? { locationId } : {};
    await db.userPreferences.upsert({
      where: { userId },
      create: { userId, tenantId: T.tenantId, agendaPrefs },
      update: { agendaPrefs },
    });
  }

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
    L1 = (await db.location.create({ data: { tenantId: T.tenantId, name: "Centro", isPrimary: true } })).id;
    L2 = (await db.location.create({ data: { tenantId: T.tenantId, name: "Norte" } })).id;
    P1 = (await addPractitioner(db, T)).practitionerId;
    assistantUser = (await addStaff(db, T, "ASSISTANT")).userId;
    // Un usuario de OTRO consultorio: sin membresía en T, `capabilitiesForActor` falla cerrado (set vacío).
    const other = await createEphemeralTenant(db);
    outsiderUser = other.userId;
    afterAllCleanups.push(() => other.cleanup());

    await db.practitionerSchedule.createMany({
      data: [1, 2, 3, 4, 5].map((dow) => ({ tenantId: T.tenantId, practitionerId: P1, locationId: L1, dow, startMin: 540, endMin: 780 })),
    });
    await db.scheduleException.create({
      data: { tenantId: T.tenantId, practitionerId: P1, date: dayKeyToDbDate("2027-11-15"), kind: "CLOSED", reason: "Congreso", createdById: T.userId },
    });
    const book = (local: string, locationId: string | null, status: "CONFIRMED" | "NO_SHOW" | "CANCELLED" = "CONFIRMED") =>
      db.booking.create({
        data: {
          tenantId: T.tenantId,
          practitionerId: P1,
          serviceId: T.serviceId,
          scheduledFor: ar(local),
          durationMin: 45,
          guestName: "Invitado",
          status,
          locationId,
          idempotencyKey: randomUUID(),
        },
      });
    await book("2027-11-02T10:00", L1);
    await book("2027-11-02T23:30", null); // día AR 2 aunque en UTC sea el 3
    await book("2027-11-09T10:00", L2);
    await book("2027-11-10T11:00", L1, "NO_SHOW");
    await book("2027-11-10T12:00", L1, "CANCELLED");
    await book("2027-12-03T10:00", L1);
  }, 120_000);

  afterAll(async () => {
    for (const c of afterAllCleanups) await c();
    await T?.cleanup();
    await db?.$disconnect();
  });

  beforeEach(() => {
    bookingsSpy.mockClear();
    availabilitySpy.mockClear();
  });

  for (const who of ["owner", "assistant"] as const) {
    it(`[CF2-LD1] (${who}) Mes: ≤ 2 tx, sin carga de semana, resumen = getAgendaMonthSummary`, async () => {
      const userId = who === "owner" ? T.userId : assistantUser;
      await setPrefsLocation(userId, null);
      asUser(userId);
      const actor = await getActor();
      const expected = await actionSummary(null);
      bookingsSpy.mockClear();
      availabilitySpy.mockClear();

      const { result: data, m } = await measure(() =>
        loadAgendaPage(actor, { monday: GRID.from, patientId: null, monthRange: { from: GRID.from, to: GRID.to } })
      );
      console.log(`[CF2-LD1] /agenda?view=month (${who}): ${m.transactions} tx, ${m.statements} sentencias, ${m.dbMs} ms db`);
      expect(m.transactions).toBeLessThanOrEqual(2);
      expect(bookingsSpy).not.toHaveBeenCalled();
      expect(availabilitySpy).not.toHaveBeenCalled();
      expect(data.bookings).toEqual([]);
      expect(data.availability).toBeNull();
      expect(data.month).toEqual(expected);
      // El fixture ejerce el resumen (si no, la igualdad sería trivial): 2 turnos el 2 (uno 23:30 AR), ausente el 10,
      // cancelado fuera, candado «l» el 15 (excepción CLOSED) y el último día de la grilla (3-dic) contado.
      const day = (k: string) => data.month!.days.find((d) => d.k === k);
      expect(data.month!.days).toHaveLength(35);
      expect(day("2027-11-02")?.c?.[P1]).toEqual([2, 0]);
      expect(day("2027-11-10")?.c?.[P1]).toEqual([1, 1]);
      expect(day("2027-11-15")?.l?.[P1]).toBe("l");
      expect(day("2027-12-03")?.c?.[P1]).toEqual([1, 0]);
      // El bootstrap es el mismo que en Semana.
      expect(data.locations.map((l) => l.id).sort()).toEqual([L1, L2].sort());
    });
  }

  it("[CF2-LD2] Mes: la sede sale de las preferencias (y una sede que ya no existe → todas)", async () => {
    asUser(T.userId);
    const actor = await getActor();
    await setPrefsLocation(T.userId, L2);
    const norte = await loadAgendaPage(actor, { monday: GRID.from, monthRange: { from: GRID.from, to: GRID.to } });
    expect(norte.month).toEqual(await actionSummary(L2));
    expect(norte.month!.locationId).toBe(L2);
    expect(norte.month!.days.find((d) => d.k === "2027-11-09")?.c?.[P1]).toEqual([1, 0]);
    expect(norte.month!.days.find((d) => d.k === "2027-11-02")?.c).toBeUndefined();

    await setPrefsLocation(T.userId, "loc-que-no-existe");
    const gone = await loadAgendaPage(actor, { monday: GRID.from, monthRange: { from: GRID.from, to: GRID.to } });
    expect(gone.month!.locationId).toBeNull();
    expect(gone.month).toEqual(await actionSummary(null));
    await setPrefsLocation(T.userId, null);
  });

  it("[CF2-LD3] Semana sin monthRange: mismas sentencias que las piezas de siempre y month null", async () => {
    asUser(T.userId);
    const actor = await getActor();
    await setPrefsLocation(T.userId, null);
    // Calentar (cache de React / pool) para que las dos mediciones vean lo mismo.
    await loadAgendaPage(actor, { monday: MONDAY, patientId: null });
    bookingsSpy.mockClear();
    availabilitySpy.mockClear();

    const { result: data, m } = await measure(() => loadAgendaPage(actor, { monday: MONDAY, patientId: null }));
    expect(bookingsSpy).toHaveBeenCalledTimes(1);
    expect(availabilitySpy).toHaveBeenCalledTimes(1);
    expect(m.transactions).toBeLessThanOrEqual(3);
    expect(data.month).toBeNull();

    // Las piezas sueltas, en el orden del loader de antes de CF2.
    const sunday = addDays(MONDAY, 6);
    const caps = await capabilitiesForActor(actor);
    const { result: rows, m: mB } = await measure(() =>
      listAgendaBookings({ from: dayWindow(MONDAY).start, to: dayWindow(sunday).end })
    );
    const { m: mP } = await measure(() => getUserPreferences());
    const { result: boot, m: mS } = await measure(() =>
      runWithRls(actor.tenantId, (tx) => loadAgendaBootstrapInTx(tx, actor, caps, { patientId: null }))
    );
    const { result: av, m: mA } = await measure(() => getAgendaAvailability({ from: MONDAY, to: sunday, locationId: null }));
    const sum = mB.statements + mP.statements + mS.statements + mA.statements;
    console.log(`[CF2-LD3] semana: ${m.statements} sentencias (piezas: ${mB.statements}+${mP.statements}+${mS.statements}+${mA.statements})`);
    expect(m.statements).toBe(sum);
    // Payload: el cable y la disponibilidad, idénticos a las piezas.
    expect(JSON.stringify(data.bookings)).toBe(
      JSON.stringify(encodeAgendaWire(rows.map(agendaRowToDTO), { services: boot.services, locations: boot.locations, insurers: boot.insurers }))
    );
    expect(av.ok && data.availability).toEqual(av.ok ? av.data : false);
    expect(data.bookings.length).toBe(3); // 9 y 10 (ausente y cancelado: la Semana trae los cancelados)
  });

  it("[CF2-LD4] sin agenda.viewAll el mes no se calcula (null, sin leer franjas ni turnos)", async () => {
    asUser(T.userId);
    const base = await getActor();
    // Mismo consultorio, usuario sin membresía en T y sin la foto de membresía: `capabilitiesForActor` → vacío.
    const actor: Actor = { ...base, userId: outsiderUser, membership: null, practitionerId: null };
    expect((await capabilitiesForActor(actor)).has("agenda.viewAll")).toBe(false);

    const { result: data, m } = await measure(() =>
      loadAgendaPage(actor, { monday: GRID.from, monthRange: { from: GRID.from, to: GRID.to } })
    );
    expect(data.month).toBeNull();
    expect(data.bookings).toEqual([]);
    expect(data.availability).toBeNull();
    expect(bookingsSpy).not.toHaveBeenCalled();
    expect(availabilitySpy).not.toHaveBeenCalled();
    // La búsqueda de la membresía (fuera de un request, `cache` de React no memoiza: su tx) + el bootstrap. Ninguna
    // sentencia del resumen: ni franjas/excepciones/bloqueos ni turnos.
    expect(m.transactions).toBeLessThanOrEqual(2);
    const events = (globalThis as unknown as { __kineQueryRecorder: { events: { query: string }[] } }).__kineQueryRecorder.events;
    expect(events.length).toBeGreaterThan(0);
    expect(events.filter((e) => /"(Booking|PractitionerSchedule|ScheduleException|TimeBlock)"/.test(e.query))).toEqual([]);
  });

  it("[CF2-LD5] un monthRange inválido (no lunes / > 42 días) no tira la página: month null", async () => {
    asUser(T.userId);
    const actor = await getActor();
    const bad = await loadAgendaPage(actor, { monday: GRID.from, monthRange: { from: "2027-11-02", to: "2027-12-05" } });
    expect(bad.month).toBeNull();
    const long = await loadAgendaPage(actor, { monday: GRID.from, monthRange: { from: GRID.from, to: "2028-02-28" } });
    expect(long.month).toBeNull();
    expect(bookingsSpy).not.toHaveBeenCalled();
  });
});
