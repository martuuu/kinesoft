/**
 * [HD-3] `getMonthBookingDays(year, monthIndex0)` (`lib/dashboard.ts`) es una server action: cualquiera con sesión la
 * llama con lo que quiera. Antes armaba el `unstable_cache` con `String(year)`/`String(monthIndex0)` sin validar: cada
 * valor basura abría un slot de cache nuevo por tenant (cardinalidad sin tope) y un mes fuera de rango llegaba a
 * Prisma como `Invalid Date` (500). Ahora: año entero 2000..2100 y mes entero 0..11; si no, `[]` SIN armar la clave
 * de cache ni consultar turnos.
 *
 * Se corre la action REAL con el Map real de `unstable_cache` (`useRealUnstableCache`), que registra los `keyParts`
 * de cada llamada: la afirmación es «no se armó ninguna clave `booking-days`», no solo «devolvió []» (un año 1999
 * sin turnos también daba [] antes). Va con los dos roles.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { getMonthBookingDays } from "@/lib/dashboard";
import { ownerClient, createEphemeralTenant, addPatient, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { asUser, asAnonymous } from "@/tests/helpers/actor";
import { useRealUnstableCache, usePassthroughUnstableCache } from "@/tests/helpers/integration-setup";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("[HD-3] getMonthBookingDays valida año y mes antes del cache", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db, { vertical: "GENERAL", plan: "PRO", publicBookingEnabled: false });
    const patientId = await addPatient(db, T);
    // 15-mar-2026 21:30 AR = 16-mar 00:30 UTC: el día del mes sale en AR (15), no del host.
    await db.booking.create({
      data: {
        tenantId: T.tenantId,
        patientId,
        practitionerId: T.practitionerId,
        serviceId: T.serviceId,
        scheduledFor: new Date("2026-03-15T21:30:00-03:00"),
        durationMin: 45,
        idempotencyKey: randomUUID(),
        status: "CONFIRMED",
      },
    });
  });

  afterEach(() => usePassthroughUnstableCache());

  afterAll(async () => {
    asAnonymous();
    await T?.cleanup();
    await db?.$disconnect();
  });

  it("control: un mes válido arma la clave y devuelve los días AR con turnos", async () => {
    asUser(T.userId);
    const cache = useRealUnstableCache();
    expect(await getMonthBookingDays(2026, 2)).toEqual([15]);
    expect(cache.keyParts).toContainEqual(["booking-days", T.tenantId, "2026", "2"]);
  });

  it("[HD-3] año fuera de 2000..2100 o mes fuera de 0..11 → [] sin clave de cache", async () => {
    asUser(T.userId);
    const cases: Array<[unknown, unknown]> = [
      [1999, 0],
      [2101, 0],
      [2026, 12],
      [2026, -1],
      [2026, 1.5],
      [2026.5, 2],
      [Number.NaN, 2],
      [Number.POSITIVE_INFINITY, 2],
      ["2026", 2],
      [2026, "2"],
      [null, undefined],
    ];
    for (const [y, m] of cases) {
      const cache = useRealUnstableCache();
      // Llamada como la haría un cliente cualquiera: los tipos de TS no viajan por el RPC.
      const out = await (getMonthBookingDays as (y: unknown, m: unknown) => Promise<number[]>)(y, m);
      expect(out, `(${String(y)}, ${String(m)})`).toEqual([]);
      expect(
        cache.keyParts.filter((k) => k[0] === "booking-days"),
        `(${String(y)}, ${String(m)}) no arma clave`
      ).toEqual([]);
    }
  });
});
