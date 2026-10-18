/**
 * [AS-2k] T3 (C-AS3) — `loadAvailabilityInputs` expone `intervalCaps` (tope efectivo por profesional) leyendo las
 * columnas de M12 en los selects de tenant y profesional que ya corrían. Dos roles (RLS / BYPASSRLS).
 *
 * Se fija: INHERIT → el del consultorio; NONE → null; CUSTOM → el propio; consultorio sin tope + INHERIT → null;
 * una entrada por profesional reservable (los mismos de `templates`), y 0 sentencias nuevas (mismo conteo con y
 * sin tope: el tope no agrega lecturas).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { loadAvailabilityInputs } from "@/lib/availability-loader";
import { runWithRls } from "@/lib/rls";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const DAY = "2027-11-10";

describe.skipIf(!RUN)("[AS-2k] loader: intervalCaps (C-AS3)", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let inherit: string;
  let none: string;
  let custom: string;

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
    inherit = (await addPractitioner(db, T)).practitionerId;
    none = (await addPractitioner(db, T)).practitionerId;
    custom = (await addPractitioner(db, T)).practitionerId;
    await db.practitioner.update({ where: { id: none }, data: { bookingCapMode: "NONE" } });
    await db.practitioner.update({
      where: { id: custom },
      data: { bookingCapMode: "CUSTOM", bookingCapCount: 3, bookingCapIntervalMin: 60 },
    });
  });
  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });

  const load = () => runWithRls(T.tenantId, (tx) => loadAvailabilityInputs(tx, { tenantId: T.tenantId, from: DAY, to: DAY }));

  it("consultorio sin tope: INHERIT y NONE → null; CUSTOM → el propio; una entrada por profesional", async () => {
    await db.tenant.update({ where: { id: T.tenantId }, data: { bookingCapCount: null, bookingCapIntervalMin: null } });
    const input = await load();
    expect(Object.keys(input.intervalCaps).sort()).toEqual(input.templates.map((t) => t.practitionerId).sort());
    expect(input.intervalCaps[T.practitionerId]).toBeNull();
    expect(input.intervalCaps[inherit]).toBeNull();
    expect(input.intervalCaps[none]).toBeNull();
    expect(input.intervalCaps[custom]).toEqual({ count: 3, intervalMin: 60 });
  });

  it("consultorio con tope 2 cada 15': INHERIT lo hereda, NONE no, CUSTOM manda el propio", async () => {
    await db.tenant.update({ where: { id: T.tenantId }, data: { bookingCapCount: 2, bookingCapIntervalMin: 15 } });
    const input = await load();
    expect(input.intervalCaps[T.practitionerId]).toEqual({ count: 2, intervalMin: 15 });
    expect(input.intervalCaps[inherit]).toEqual({ count: 2, intervalMin: 15 });
    expect(input.intervalCaps[none]).toBeNull();
    expect(input.intervalCaps[custom]).toEqual({ count: 3, intervalMin: 60 });
  });

  it("0 sentencias nuevas: el mismo conteo con y sin tope", async () => {
    // Owner (BYPASSRLS) para contar sin GUC de tenant: lo que se mide es el loader, no la policy.
    const counted = new PrismaClient({
      datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } },
      log: [{ emit: "event", level: "query" }],
    });
    let n = 0;
    counted.$on("query" as never, () => {
      n++;
    });
    try {
      const measure = async () => {
        n = 0;
        await counted.$transaction((tx) => loadAvailabilityInputs(tx, { tenantId: T.tenantId, from: DAY, to: DAY }));
        return n;
      };
      await measure(); // calentamiento: la 1.ª tx del cliente suma la sentencia de conexión
      await db.tenant.update({ where: { id: T.tenantId }, data: { bookingCapCount: null, bookingCapIntervalMin: null } });
      const without = await measure();
      await db.tenant.update({ where: { id: T.tenantId }, data: { bookingCapCount: 2, bookingCapIntervalMin: 15 } });
      const withCap = await measure();
      expect(withCap).toBe(without);
    } finally {
      await counted.$disconnect();
    }
  });
});
