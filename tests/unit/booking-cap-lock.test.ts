/**
 * SR1.0 (SR-C) — claves de lock de SALA y `lockCapacityAndRoomsMany`, enmienda
 * C2 (1b): paciente → cupo → SALA → sedes → filas, con cupo y sala en UNA
 * sentencia. Lo puro (orden, días AR, forma de la sentencia) acá; lo que pasa
 * en Postgres (`pg_locks`, una sola sentencia real) en
 * `tests/integration/locks-room.test.ts`.
 *
 * Se mockea solo el cliente de base (`$executeRaw`): la función bajo test es la
 * real.
 */
import { describe, expect, it } from "vitest";
import {
  capacityLockKey,
  hourKeyForStart,
  hourLockKey,
  lockAgendaKeysMany,
  lockCapacityAndRoomsMany,
  lockCapacityMany,
  lockCapacityWindow,
  orderedAgendaLockKeys,
  orderedCapacityAndRoomLockKeys,
  orderedCapacityLockKeys,
  orderedHourLockKeys,
  orderedPractitionerDayLockKeys,
  orderedRoomLockKeys,
  pdayKeysFromCapacityKeys,
  practitionerDayKeysForWindow,
  practitionerDayLockKey,
  roomKeysForWindow,
  roomLockKey,
  type CapacityLockKey,
  type HourLockKey,
  type PractitionerDayLockKey,
  type RoomLockKey,
} from "@/lib/booking-cap-lock";
import type { DbClient } from "@/lib/rls";

const T = "t1";

/** Cliente falso que registra cada `$executeRaw` (texto SQL + valores). */
function fakeTx() {
  const calls: { sql: string; values: unknown[] }[] = [];
  const tx = {
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ sql: strings.join("?"), values });
      return 0;
    },
  } as unknown as DbClient;
  return { tx, calls };
}

describe("claves de sala (C2 (1b))", () => {
  it("roomLockKey: prefijo propio, no choca con cupo ni con room-schedule", () => {
    const k = roomLockKey({ tenantId: T, roomId: "r1", dayKey: "2027-01-01" });
    expect(k).toBe("kinesoft:room:t1:r1:2027-01-01");
    expect(k.startsWith("kinesoft:cap:")).toBe(false);
    expect(k.startsWith("kinesoft:room-schedule:")).toBe(false);
  });

  it("orderedRoomLockKeys deduplica y ordena por componente (tenant, sala, día)", () => {
    const keys: RoomLockKey[] = [
      { tenantId: T, roomId: "r2", dayKey: "2027-01-01" },
      { tenantId: T, roomId: "r1", dayKey: "2027-01-02" },
      { tenantId: T, roomId: "r1", dayKey: "2027-01-01" },
      { tenantId: T, roomId: "r2", dayKey: "2027-01-01" }, // duplicada
    ];
    expect(orderedRoomLockKeys(keys)).toEqual([
      "kinesoft:room:t1:r1:2027-01-01",
      "kinesoft:room:t1:r1:2027-01-02",
      "kinesoft:room:t1:r2:2027-01-01",
    ]);
  });

  it("orden por componente aun con ids de largo distinto ('ab' antes que 'ab1')", () => {
    const keys: RoomLockKey[] = [
      { tenantId: T, roomId: "ab1", dayKey: "2027-01-01" },
      { tenantId: T, roomId: "ab", dayKey: "2027-01-01" },
    ];
    // Concatenado, "…:ab1:…" < "…:ab:…" ('1' < ':'): el orden por componente lo evita.
    expect(orderedRoomLockKeys(keys)).toEqual(["kinesoft:room:t1:ab:2027-01-01", "kinesoft:room:t1:ab1:2027-01-01"]);
  });

  it("roomKeysForWindow: día AR, y el siguiente solo si cruza la medianoche AR", () => {
    const base = { tenantId: T, roomId: "r" };
    const cross = roomKeysForWindow({
      ...base,
      start: new Date("2027-03-09T23:30:00-03:00"),
      end: new Date("2027-03-10T00:30:00-03:00"),
    });
    expect(cross).toEqual([
      { tenantId: T, roomId: "r", dayKey: "2027-03-09" },
      { tenantId: T, roomId: "r", dayKey: "2027-03-10" },
    ]);
    const edge = roomKeysForWindow({
      ...base,
      start: new Date("2027-03-09T23:00:00-03:00"),
      end: new Date("2027-03-10T00:00:00-03:00"),
    });
    expect(edge.map((k) => k.dayKey)).toEqual(["2027-03-09"]);
    // 22:00 AR = 01:00 UTC del día siguiente: manda el día AR, no el del host.
    const late = roomKeysForWindow({
      ...base,
      start: new Date("2027-03-09T22:00:00-03:00"),
      end: new Date("2027-03-09T22:45:00-03:00"),
    });
    expect(late.map((k) => k.dayKey)).toEqual(["2027-03-09"]);
  });
});

describe("orderedCapacityAndRoomLockKeys / lockCapacityAndRoomsMany", () => {
  const cap: CapacityLockKey[] = [
    { tenantId: "t2", practitionerId: "p2", serviceId: "s", dayKey: "2027-01-01" },
    { tenantId: "t2", practitionerId: "p1", serviceId: "s", dayKey: "2027-01-01" },
  ];
  // Tenant "t1" < "t2": si se ordenara todo junto, la sala iría ANTES que el
  // cupo. El contrato es cupo ++ sala, siempre.
  const rooms: RoomLockKey[] = [
    { tenantId: "t1", roomId: "r2", dayKey: "2027-01-01" },
    { tenantId: "t1", roomId: "r1", dayKey: "2027-01-01" },
    { tenantId: "t1", roomId: "r1", dayKey: "2027-01-01" },
  ];

  it("todo el cupo ordenado y DESPUÉS todas las salas ordenadas (nunca intercaladas)", () => {
    expect(orderedCapacityAndRoomLockKeys(cap, rooms)).toEqual([
      capacityLockKey(cap[1]),
      capacityLockKey(cap[0]),
      "kinesoft:room:t1:r1:2027-01-01",
      "kinesoft:room:t1:r2:2027-01-01",
    ]);
  });

  it("UNA sentencia, con la misma SQL de C2 (1) y el array cupo ++ sala", async () => {
    const { tx, calls } = fakeTx();
    await lockCapacityAndRoomsMany(tx, cap, rooms);
    expect(calls).toHaveLength(1);
    expect(calls[0].values).toEqual([orderedCapacityAndRoomLockKeys(cap, rooms)]);
    expect(calls[0].sql).toContain("pg_advisory_xact_lock(hashtextextended(k, 0))");
    expect(calls[0].sql).toContain("WITH ORDINALITY u(k, o) ORDER BY o");

    // Misma sentencia literal que lockCapacityMany (no pueden divergir).
    const other = fakeTx();
    await lockCapacityMany(other.tx, cap);
    expect(other.calls).toHaveLength(1);
    expect(other.calls[0].sql).toBe(calls[0].sql);
    expect(other.calls[0].values).toEqual([orderedCapacityLockKeys(cap)]);
  });

  it("sin salas = lo mismo que lockCapacityMany; solo salas = una sentencia; nada = no-op", async () => {
    const a = fakeTx();
    await lockCapacityAndRoomsMany(a.tx, cap, []);
    expect(a.calls.map((c) => c.values)).toEqual([[orderedCapacityLockKeys(cap)]]);

    const b = fakeTx();
    await lockCapacityAndRoomsMany(b.tx, [], rooms);
    expect(b.calls.map((c) => c.values)).toEqual([[orderedRoomLockKeys(rooms)]]);

    const c = fakeTx();
    await lockCapacityAndRoomsMany(c.tx, [], []);
    expect(c.calls).toHaveLength(0);
  });
});

// [AS-2k] T3 (C-AS3, enmienda C2 (1c)): clave de HORA del profesional entre el cupo y la sala, en la misma
// sentencia. Lo que pasa en Postgres (orden real en `pg_locks`) en `tests/integration/locks-interval.test.ts`.
describe("[AS-2k] claves de hora del profesional (C2 (1c))", () => {
  it("hourLockKey: prefijo propio, no choca con cupo ni con sala", () => {
    const k = hourLockKey({ tenantId: T, practitionerId: "p1", hourKey: "2027-01-01T10" });
    expect(k).toBe("kinesoft:phour:t1:p1:2027-01-01T10");
    expect(k.startsWith("kinesoft:cap:")).toBe(false);
    expect(k.startsWith("kinesoft:room:")).toBe(false);
  });

  it("hourKeyForStart: hora AR del INICIO (23:30 AR = 02:30Z del día siguiente → «…T23» del día AR)", () => {
    const k = hourKeyForStart({ tenantId: T, practitionerId: "p", start: new Date("2027-03-09T23:30:00-03:00") });
    expect(k).toEqual({ tenantId: T, practitionerId: "p", hourKey: "2027-03-09T23" });
    expect(hourKeyForStart({ tenantId: T, practitionerId: "p", start: new Date("2027-03-10T00:30:00-03:00") }).hourKey).toBe(
      "2027-03-10T00"
    );
  });

  it("orderedHourLockKeys deduplica y ordena por componente (tenant, profesional, hora)", () => {
    const keys: HourLockKey[] = [
      { tenantId: T, practitionerId: "p2", hourKey: "2027-01-01T09" },
      { tenantId: T, practitionerId: "p1", hourKey: "2027-01-01T11" },
      { tenantId: T, practitionerId: "p1", hourKey: "2027-01-01T09" },
      { tenantId: T, practitionerId: "p2", hourKey: "2027-01-01T09" }, // duplicada
    ];
    expect(orderedHourLockKeys(keys)).toEqual([
      "kinesoft:phour:t1:p1:2027-01-01T09",
      "kinesoft:phour:t1:p1:2027-01-01T11",
      "kinesoft:phour:t1:p2:2027-01-01T09",
    ]);
  });

  it("prefijos «a:» vs «a1:»: orden por componente, no por el string concatenado", () => {
    const keys: HourLockKey[] = [
      { tenantId: T, practitionerId: "a1", hourKey: "2027-01-01T10" },
      { tenantId: T, practitionerId: "a", hourKey: "2027-01-01T10" },
    ];
    // Concatenado, "…:a1:…" < "…:a:…" ('1' < ':'): el orden por componente pone «a» primero.
    expect(hourLockKey(keys[0]) < hourLockKey(keys[1])).toBe(true);
    expect(orderedHourLockKeys(keys)).toEqual(["kinesoft:phour:t1:a:2027-01-01T10", "kinesoft:phour:t1:a1:2027-01-01T10"]);
    // Lo mismo con el tenant.
    const byTenant: HourLockKey[] = [
      { tenantId: "a1", practitionerId: "p", hourKey: "2027-01-01T10" },
      { tenantId: "a", practitionerId: "p", hourKey: "2027-01-01T10" },
    ];
    expect(orderedHourLockKeys(byTenant)).toEqual(["kinesoft:phour:a:p:2027-01-01T10", "kinesoft:phour:a1:p:2027-01-01T10"]);
  });

  const cap: CapacityLockKey[] = [
    { tenantId: "t3", practitionerId: "p2", serviceId: "s", dayKey: "2027-01-01" },
    { tenantId: "t3", practitionerId: "p1", serviceId: "s", dayKey: "2027-01-01" },
  ];
  // Tenants elegidos para que un orden global mezclado invierta las familias: sala ("t1") < hora ("t2") < cupo
  // ("t3"). El contrato es cupo ++ hora ++ sala, siempre.
  const hour: HourLockKey[] = [
    { tenantId: "t2", practitionerId: "p1", hourKey: "2027-01-01T11" },
    { tenantId: "t2", practitionerId: "p1", hourKey: "2027-01-01T10" },
    { tenantId: "t2", practitionerId: "p1", hourKey: "2027-01-01T10" },
  ];
  const rooms: RoomLockKey[] = [
    { tenantId: "t1", roomId: "r2", dayKey: "2027-01-01" },
    { tenantId: "t1", roomId: "r1", dayKey: "2027-01-01" },
  ];

  it("orderedAgendaLockKeys: todo el cupo, después todas las horas, después todas las salas", () => {
    expect(orderedAgendaLockKeys({ cap, hour, rooms })).toEqual([
      capacityLockKey(cap[1]),
      capacityLockKey(cap[0]),
      "kinesoft:phour:t2:p1:2027-01-01T10",
      "kinesoft:phour:t2:p1:2027-01-01T11",
      "kinesoft:room:t1:r1:2027-01-01",
      "kinesoft:room:t1:r2:2027-01-01",
    ]);
    // Sin horas = el array de SR de siempre (los envoltorios no cambian de claves).
    expect(orderedAgendaLockKeys({ cap, rooms })).toEqual(orderedCapacityAndRoomLockKeys(cap, rooms));
    expect(orderedAgendaLockKeys({})).toEqual([]);
  });

  it("lockAgendaKeysMany: UNA sentencia, la misma SQL literal de C2 (1), con cupo ++ hora ++ sala", async () => {
    const { tx, calls } = fakeTx();
    await lockAgendaKeysMany(tx, { cap, hour, rooms });
    expect(calls).toHaveLength(1);
    expect(calls[0].values).toEqual([orderedAgendaLockKeys({ cap, hour, rooms })]);
    const ref = fakeTx();
    await lockCapacityMany(ref.tx, cap);
    expect(calls[0].sql).toBe(ref.calls[0].sql);

    // Solo horas también es una sentencia; nada = no-op.
    const h = fakeTx();
    await lockAgendaKeysMany(h.tx, { hour });
    expect(h.calls.map((c) => c.values)).toEqual([[orderedHourLockKeys(hour)]]);
    const none = fakeTx();
    await lockAgendaKeysMany(none.tx, { cap: [], hour: [], rooms: [] });
    expect(none.calls).toHaveLength(0);
  });

  it("los envoltorios conservan firma y claves: lockCapacityMany / Window / AndRoomsMany", async () => {
    const a = fakeTx();
    await lockCapacityMany(a.tx, cap);
    expect(a.calls.map((c) => c.values)).toEqual([[orderedCapacityLockKeys(cap)]]);

    const b = fakeTx();
    await lockCapacityAndRoomsMany(b.tx, cap, rooms);
    expect(b.calls.map((c) => c.values)).toEqual([[orderedCapacityAndRoomLockKeys(cap, rooms)]]);

    const w = fakeTx();
    await lockCapacityWindow(w.tx, {
      tenantId: T,
      practitionerId: "p",
      serviceId: "s",
      start: new Date("2027-03-09T23:30:00-03:00"),
      end: new Date("2027-03-10T00:30:00-03:00"),
    });
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0].values).toEqual([["kinesoft:cap:t1:p:s:2027-03-09", "kinesoft:cap:t1:p:s:2027-03-10"]]);
  });
});

// [CF-L1..3] CF (ADR-032, enmienda C2 (1d)): clave de DÍA del profesional entre el cupo y la hora, en la misma
// sentencia. Lo que pasa en Postgres (orden real en `pg_locks`, 1 sentencia) en `tests/integration/cf-locks-pday.test.ts`.
describe("[CF-L] claves de día del profesional (C2 (1d))", () => {
  it("[CF-L1] practitionerDayLockKey: formato y prefijo propio (no choca con cupo, hora ni sala)", () => {
    const k = practitionerDayLockKey({ tenantId: T, practitionerId: "p1", dayKey: "2027-01-01" });
    expect(k).toBe("kinesoft:pday:t1:p1:2027-01-01");
    for (const other of ["kinesoft:cap:", "kinesoft:phour:", "kinesoft:room:"]) expect(k.startsWith(other)).toBe(false);
  });

  it("[CF-L1] orderedPractitionerDayLockKeys deduplica y ordena por componente (tenant, profesional, día)", () => {
    const keys: PractitionerDayLockKey[] = [
      { tenantId: T, practitionerId: "p2", dayKey: "2027-01-01" },
      { tenantId: T, practitionerId: "p1", dayKey: "2027-01-02" },
      { tenantId: T, practitionerId: "p1", dayKey: "2027-01-01" },
      { tenantId: T, practitionerId: "p2", dayKey: "2027-01-01" }, // duplicada
    ];
    expect(orderedPractitionerDayLockKeys(keys)).toEqual([
      "kinesoft:pday:t1:p1:2027-01-01",
      "kinesoft:pday:t1:p1:2027-01-02",
      "kinesoft:pday:t1:p2:2027-01-01",
    ]);
    expect(orderedPractitionerDayLockKeys([])).toEqual([]);
  });

  it("[CF-L1] prefijos «a:» vs «a1:»: orden por componente, no por el string concatenado", () => {
    const keys: PractitionerDayLockKey[] = [
      { tenantId: T, practitionerId: "a1", dayKey: "2027-01-01" },
      { tenantId: T, practitionerId: "a", dayKey: "2027-01-01" },
    ];
    // Concatenado, "…:a1:…" < "…:a:…" ('1' < ':'): el orden por componente pone «a» primero.
    expect(practitionerDayLockKey(keys[0]) < practitionerDayLockKey(keys[1])).toBe(true);
    expect(orderedPractitionerDayLockKeys(keys)).toEqual([
      "kinesoft:pday:t1:a:2027-01-01",
      "kinesoft:pday:t1:a1:2027-01-01",
    ]);
    const byTenant: PractitionerDayLockKey[] = [
      { tenantId: "a1", practitionerId: "p", dayKey: "2027-01-01" },
      { tenantId: "a", practitionerId: "p", dayKey: "2027-01-01" },
    ];
    expect(orderedPractitionerDayLockKeys(byTenant)).toEqual([
      "kinesoft:pday:a:p:2027-01-01",
      "kinesoft:pday:a1:p:2027-01-01",
    ]);
  });

  it("[CF-L1] pdayKeysFromCapacityKeys: un día por (tenant, profesional, día), sin el servicio, deduplicado", () => {
    const cap: CapacityLockKey[] = [
      { tenantId: T, practitionerId: "p1", serviceId: "s2", dayKey: "2027-01-01" },
      { tenantId: T, practitionerId: "p1", serviceId: "s1", dayKey: "2027-01-01" },
      { tenantId: T, practitionerId: "p1", serviceId: "s1", dayKey: "2027-01-02" },
      { tenantId: T, practitionerId: "p2", serviceId: "s1", dayKey: "2027-01-01" },
    ];
    expect(pdayKeysFromCapacityKeys(cap)).toEqual([
      { tenantId: T, practitionerId: "p1", dayKey: "2027-01-01" },
      { tenantId: T, practitionerId: "p1", dayKey: "2027-01-02" },
      { tenantId: T, practitionerId: "p2", dayKey: "2027-01-01" },
    ]);
    expect(pdayKeysFromCapacityKeys([])).toEqual([]);
  });

  it("[CF-L2] 23:30 AR + 60' = dos días AR; terminar 00:00 AR no toma el siguiente; 22:00 AR es su día AR (no el UTC)", () => {
    const base = { tenantId: T, practitionerId: "p" };
    // 23:30 AR = 02:30Z del día siguiente: con TZ=UTC el día del host sería el 10 de punta a punta.
    const cross = practitionerDayKeysForWindow({
      ...base,
      start: new Date("2027-03-09T23:30:00-03:00"),
      end: new Date("2027-03-10T00:30:00-03:00"),
    });
    expect(cross).toEqual([
      { tenantId: T, practitionerId: "p", dayKey: "2027-03-09" },
      { tenantId: T, practitionerId: "p", dayKey: "2027-03-10" },
    ]);
    const edge = practitionerDayKeysForWindow({
      ...base,
      start: new Date("2027-03-09T23:00:00-03:00"),
      end: new Date("2027-03-10T00:00:00-03:00"),
    });
    expect(edge.map((k) => k.dayKey)).toEqual(["2027-03-09"]);
    const late = practitionerDayKeysForWindow({
      ...base,
      start: new Date("2027-03-09T22:00:00-03:00"),
      end: new Date("2027-03-09T22:45:00-03:00"),
    });
    expect(late.map((k) => k.dayKey)).toEqual(["2027-03-09"]);
    // Ventana vacía (start = end): igual el día del inicio, como el cupo.
    const zero = practitionerDayKeysForWindow({
      ...base,
      start: new Date("2027-03-09T10:00:00-03:00"),
      end: new Date("2027-03-09T10:00:00-03:00"),
    });
    expect(zero.map((k) => k.dayKey)).toEqual(["2027-03-09"]);
  });

  it("[CF-L2] el día de una ventana coincide con el del cupo (mismos días AR, sin el servicio)", () => {
    const w = { tenantId: T, practitionerId: "p", start: new Date("2027-03-09T23:30:00-03:00"), end: new Date("2027-03-10T00:30:00-03:00") };
    const fromCap = pdayKeysFromCapacityKeys(
      ["s1", "s2"].flatMap((serviceId) => [
        { tenantId: T, practitionerId: "p", serviceId, dayKey: "2027-03-09" },
        { tenantId: T, practitionerId: "p", serviceId, dayKey: "2027-03-10" },
      ])
    );
    expect(orderedPractitionerDayLockKeys(fromCap)).toEqual(orderedPractitionerDayLockKeys(practitionerDayKeysForWindow(w)));
  });

  // Tenants elegidos para que un orden global mezclado invierta las familias: sala ("t1") < hora ("t2") < día
  // ("t3") < cupo ("t4"). El contrato es cupo ++ día ++ hora ++ sala, siempre.
  const cap: CapacityLockKey[] = [
    { tenantId: "t4", practitionerId: "p2", serviceId: "s", dayKey: "2027-01-01" },
    { tenantId: "t4", practitionerId: "p1", serviceId: "s", dayKey: "2027-01-01" },
  ];
  const pday: PractitionerDayLockKey[] = [
    { tenantId: "t3", practitionerId: "p2", dayKey: "2027-01-01" },
    { tenantId: "t3", practitionerId: "p1", dayKey: "2027-01-02" },
    { tenantId: "t3", practitionerId: "p1", dayKey: "2027-01-01" },
    { tenantId: "t3", practitionerId: "p1", dayKey: "2027-01-01" },
  ];
  const hour: HourLockKey[] = [
    { tenantId: "t2", practitionerId: "p1", hourKey: "2027-01-01T11" },
    { tenantId: "t2", practitionerId: "p1", hourKey: "2027-01-01T10" },
  ];
  const rooms: RoomLockKey[] = [
    { tenantId: "t1", roomId: "r2", dayKey: "2027-01-01" },
    { tenantId: "t1", roomId: "r1", dayKey: "2027-01-01" },
  ];

  it("[CF-L3] orderedAgendaLockKeys: todo el cupo → todos los días → todas las horas → todas las salas (nunca intercaladas)", () => {
    const all = orderedAgendaLockKeys({ cap, pday, hour, rooms });
    expect(all).toEqual([
      capacityLockKey(cap[1]),
      capacityLockKey(cap[0]),
      "kinesoft:pday:t3:p1:2027-01-01",
      "kinesoft:pday:t3:p1:2027-01-02",
      "kinesoft:pday:t3:p2:2027-01-01",
      "kinesoft:phour:t2:p1:2027-01-01T10",
      "kinesoft:phour:t2:p1:2027-01-01T11",
      "kinesoft:room:t1:r1:2027-01-01",
      "kinesoft:room:t1:r2:2027-01-01",
    ]);
    // Cada familia es un bloque contiguo, en el orden del contrato.
    const fam = all.map((k) => k.split(":")[1]);
    const blocks = fam.filter((f, i) => i === 0 || fam[i - 1] !== f);
    expect(blocks).toEqual(["cap", "pday", "phour", "room"]);
    // Sin días = el array de T3 de siempre (los callers que no pasan `pday` no cambian de claves).
    expect(orderedAgendaLockKeys({ cap, hour, rooms })).toEqual([
      ...orderedCapacityLockKeys(cap),
      ...orderedHourLockKeys(hour),
      ...orderedRoomLockKeys(rooms),
    ]);
    // Planes: cupo + día, sin hora ni sala.
    expect(orderedAgendaLockKeys({ cap, pday: pdayKeysFromCapacityKeys(cap) })).toEqual([
      capacityLockKey(cap[1]),
      capacityLockKey(cap[0]),
      "kinesoft:pday:t4:p1:2027-01-01",
      "kinesoft:pday:t4:p2:2027-01-01",
    ]);
    expect(orderedAgendaLockKeys({ pday: [] })).toEqual([]);
  });

  it("[CF-L3] lockAgendaKeysMany con día: UNA sentencia, la misma SQL literal de C2 (1)", async () => {
    const { tx, calls } = fakeTx();
    await lockAgendaKeysMany(tx, { cap, pday, hour, rooms });
    expect(calls).toHaveLength(1);
    expect(calls[0].values).toEqual([orderedAgendaLockKeys({ cap, pday, hour, rooms })]);
    const ref = fakeTx();
    await lockCapacityMany(ref.tx, cap);
    expect(calls[0].sql).toBe(ref.calls[0].sql);

    // Solo días también es una sentencia; listas vacías = no-op.
    const d = fakeTx();
    await lockAgendaKeysMany(d.tx, { pday });
    expect(d.calls.map((c) => c.values)).toEqual([[orderedPractitionerDayLockKeys(pday)]]);
    const none = fakeTx();
    await lockAgendaKeysMany(none.tx, { cap: [], pday: [], hour: [], rooms: [] });
    expect(none.calls).toHaveLength(0);
  });
});
