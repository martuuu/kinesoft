/**
 * [AS-2l] T3c-2l (C-AS3, decisión 6 del 19-oct; AS-D9): el tope «N turnos cada X min» en el turnero (duro) y en las
 * lecturas de disponibilidad del staff, contra Postgres real en los dos roles.
 *
 * Qué fija:
 *   - Submit: con el intervalo lleno por un turno de OTRO servicio, rechaza con el copy de siempre («se acaba de
 *     ocupar…») sin escribir. El cupo por servicio no lo ve: el que frena es el tope (cruza servicios).
 *   - Carrera: dos reservas online de servicios DISTINTOS en la misma hora con tope 1 cada 60' → entra una. Las claves
 *     de cupo son distintas (llevan el servicio); solo la clave de HORA (`kinesoft:phour:…`) las serializa. Mientras
 *     esperan la hora, cada una YA tiene su cupo tomado (orden C2 (1c): cupo → hora, en una sentencia).
 *   - Staff: `listAvailableSlots` marca el slot `tope-intervalo` con `intervalCapUse`; `classifyBookingInstant`
 *     devuelve `intervalCapped` / `intervalCapUse` (el modal pide «Cargar como sobreturno»).
 *
 * Símbolos reales; se mockean solo el rate-limit (bucket in-memory por IP) y, vía el setup de integración, la red.
 * Sin `TURNERO_CHECKOUT` (default `off`): las reservas nacen CONFIRMED sin Mercado Pago.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...actual, rateLimit: async () => ({ ok: true, remaining: 99, retryAfterMs: 0 }) };
});

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { submitPublicBooking } from "@/lib/public-booking";
import { classifyBookingInstant, listAvailableSlots } from "@/lib/availability-actions";
import { capacityLockKey, hourKeyForStart, hourLockKey } from "@/lib/booking-cap-lock";
import type { SubmitPublicBookingInput } from "@/lib/public-booking-types";
import { localToARIso, toARDateKey, toARDow } from "@/lib/datetime-ar";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  sweepOrphanTestTenants,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { waitForAdvisoryWaiter } from "@/tests/helpers/advisory-wait";

const RUN = process.env.INTEGRATION === "1";

/** El próximo `dow` (0=Dom) entre 7 y 13 días adelante, en calendario AR (dentro del horizonte del turnero). */
function futureDow(dow: number): string {
  for (let d = 7; ; d++) {
    const key = toARDateKey(new Date(Date.now() + d * 86_400_000));
    if (toARDow(new Date(localToARIso(`${key}T12:00:00`))) === dow) return key;
  }
}
const at = (day: string, hhmm: string) => new Date(localToARIso(`${day}T${hhmm}:00`));

/** ¿Hay una sesión con el advisory lock de `key` CONCEDIDO? (misma forma bigint que `countAdvisoryWaiters`). */
async function grantedHolders(db: PrismaClient, key: string): Promise<number> {
  const rows = await db.$queryRaw<{ n: number }[]>`
    WITH k AS (SELECT hashtextextended(${key}, 0) AS v)
    SELECT count(*)::int AS n
    FROM pg_locks l, k
    WHERE l.locktype = 'advisory'
      AND l.granted
      AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND l.objsubid = 1
      AND l.classid = ((k.v >> 32) & 4294967295)::oid
      AND l.objid = (k.v & 4294967295)::oid`;
  return rows[0]?.n ?? 0;
}

describe.skipIf(!RUN)("[AS-2l] turnero y staff con tope por intervalo (C-AS3)", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let svcA: string; // 60', ilimitado, del consultorio
  let svcB: string; // 60', ilimitado, del consultorio

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    T = await createEphemeralTenant(db);
    // Cupo ilimitado y del consultorio (sin fila PractitionerService = habilitado y PUBLIC): lo único que frena es
    // el tope. 60' → paso del turnero 60 (AS-D9): grilla 08:00, 09:00, … con el horario fallback del consultorio.
    for (const name of ["Kine", "Evaluación"]) {
      const s = await db.service.create({
        data: { tenantId: T.tenantId, practitionerId: null, name, durationMin: 60, priceCents: 0 },
      });
      if (name === "Kine") svcA = s.id;
      else svcB = s.id;
    }
    await db.practitioner.update({
      where: { id: T.practitionerId },
      data: { bookingCapMode: "CUSTOM", bookingCapCount: 1, bookingCapIntervalMin: 60 },
    });
  });

  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });

  function req(o: { serviceId: string; when: Date; dni: string }): SubmitPublicBookingInput {
    return {
      tenantSlug: T.slug,
      idempotencyKey: randomUUID(),
      practitionerId: T.practitionerId,
      serviceId: o.serviceId,
      scheduledFor: o.when.toISOString(),
      patient: {
        firstName: "Ana",
        lastName: "Tope",
        email: `tope-${randomUUID().slice(0, 8)}@test.local`,
        phone: `11${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`,
        dateOfBirth: "1990-05-10",
        documentId: o.dni,
      },
    };
  }

  async function mk(o: { when: Date; serviceId: string }) {
    const patientId = await addPatient(db, T);
    return db.booking.create({
      data: {
        tenantId: T.tenantId,
        practitionerId: T.practitionerId,
        serviceId: o.serviceId,
        patientId,
        scheduledFor: o.when,
        durationMin: 30,
        status: "CONFIRMED",
        idempotencyKey: randomUUID(),
      },
    });
  }

  it("[AS-2l] submit: la hora con un turno de otro servicio se rechaza con el copy de siempre, sin escribir", async () => {
    const day = futureDow(2);
    await mk({ when: at(day, "10:20"), serviceId: svcB });
    const r = await submitPublicBooking(req({ serviceId: svcA, when: at(day, "10:00"), dni: "70100001" }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/se acaba de ocupar o ya no se puede reservar online/);
      // Marca estable para que el wizard vuelva a pedir la ventana (sin comparar el copy).
      expect(r.fieldErrors?.scheduledFor).toEqual([r.error]);
    }
    expect(
      await db.booking.count({ where: { tenantId: T.tenantId, serviceId: svcA, scheduledFor: at(day, "10:00") } })
    ).toBe(0);
    // Paso nuevo (AS-D9): 60' → grilla de 60; un 10:45 de la grilla vieja de 45 es off-grid, con la misma marca.
    const off = await submitPublicBooking(req({ serviceId: svcA, when: at(day, "12:45"), dni: "70100003" }));
    expect(off).toMatchObject({ ok: false, error: /no está disponible para reservar online/ });
    expect(off.ok ? null : off.fieldErrors?.scheduledFor).toHaveLength(1);
    // No vacuo: la hora siguiente del mismo día sí entra.
    const ok = await submitPublicBooking(req({ serviceId: svcA, when: at(day, "11:00"), dni: "70100002" }));
    expect(ok.ok).toBe(true);
  });

  it("[AS-2l] carrera: dos reservas online de servicios distintos en la misma hora con tope 1 → entra una", async () => {
    const day = futureDow(3);
    const when = at(day, "15:00");
    const hk = hourLockKey(hourKeyForStart({ tenantId: T.tenantId, practitionerId: T.practitionerId, start: when }));
    const capKey = (serviceId: string) =>
      capacityLockKey({ tenantId: T.tenantId, practitionerId: T.practitionerId, serviceId, dayKey: day });
    const holder = ownerClient();
    const probe = ownerClient();
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let acquired!: () => void;
    const got = new Promise<void>((r) => (acquired = r));
    const held = holder.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${hk}, 0))`;
        acquired();
        await released;
      },
      { timeout: 20_000 }
    );
    await got;
    const pa = submitPublicBooking(req({ serviceId: svcA, when, dni: "70200001" }));
    const pb = submitPublicBooking(req({ serviceId: svcB, when, dni: "70200002" }));
    try {
      await waitForAdvisoryWaiter(probe, hk, { minWaiters: 2, timeoutMs: 8_000 });
      // Orden C2 (1c): quien espera la hora ya tiene su cupo (no al revés: si no, cupo ↔ hora podría ciclar con un
      // alta de la agenda).
      expect(await grantedHolders(probe, capKey(svcA))).toBe(1);
      expect(await grantedHolders(probe, capKey(svcB))).toBe(1);
      release();
      await held;
      const outs = await Promise.all([pa, pb]);
      expect(outs.filter((o) => o.ok)).toHaveLength(1);
      const lost = outs.find((o) => !o.ok);
      expect(lost && !lost.ok ? lost.error : "").toMatch(/se acaba de ocupar/);
      expect(lost && !lost.ok ? lost.fieldErrors?.scheduledFor : null).toHaveLength(1);
      expect(
        await db.booking.count({
          where: {
            tenantId: T.tenantId,
            practitionerId: T.practitionerId,
            scheduledFor: { gte: at(day, "15:00"), lt: at(day, "16:00") },
            status: { not: "CANCELLED" },
          },
        })
      ).toBe(1);
    } finally {
      release();
      await held.catch(() => {});
      await Promise.allSettled([pa, pb]);
      await Promise.all([holder.$disconnect(), probe.$disconnect()]);
    }
  });

  it("[AS-2l] staff: el selector marca `tope-intervalo` con el uso, y el aviso en vivo trae intervalCapped", async () => {
    const day = futureDow(4);
    await mk({ when: at(day, "09:10"), serviceId: svcB });
    asUser(T.userId);
    const list = await listAvailableSlots({
      practitionerId: T.practitionerId,
      serviceId: svcA,
      dayKey: day,
      stepMin: 30,
    });
    if (!list.ok) throw new Error(list.error);
    if (list.data.mode !== "practitioner") throw new Error("modo inesperado");
    const byTime = new Map(list.data.slots.map((s) => [s.time, s]));
    expect(byTime.get("09:00")).toMatchObject({
      available: false,
      reason: "tope-intervalo",
      intervalCapUse: { used: 1, cap: { count: 1, intervalMin: 60 } },
    });
    expect(byTime.get("09:30")).toMatchObject({ available: false, reason: "tope-intervalo" });
    expect(byTime.get("10:00")).toMatchObject({ available: true, intervalCapUse: { used: 0 } });

    const c = await classifyBookingInstant({
      practitionerId: T.practitionerId,
      serviceId: svcA,
      scheduledFor: at(day, "09:30").toISOString(),
    });
    if (!c.ok) throw new Error(c.error);
    expect(c.data).toMatchObject({
      class: "tope-intervalo",
      intervalCapped: true,
      intervalCapUse: { used: 1, cap: { count: 1, intervalMin: 60 } },
    });
    const free = await classifyBookingInstant({
      practitionerId: T.practitionerId,
      serviceId: svcA,
      scheduledFor: at(day, "10:00").toISOString(),
    });
    if (!free.ok) throw new Error(free.error);
    expect(free.data).toMatchObject({ class: "libre", intervalCapped: false, intervalCapUse: { used: 0 } });
  });
});
