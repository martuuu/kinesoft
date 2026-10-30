/**
 * [CF-R1] / [CF-R2] CF (decisión 1 del 30-oct, ADR-032, enmienda C2 (1d)) — carrera de dos altas de servicios
 * DISTINTOS del mismo profesional que se pisan, con la regla por defecto (`Practitioner.allowParallelServices = false`:
 * «no atiende servicios distintos a la vez»), contra Postgres real en los dos roles.
 *
 * El bug (brief CF «Hechos» 3): el chequeo «¿hay un turno de otro servicio en esa ventana?» es un SELECT seguido del
 * INSERT, y ninguna clave de lock de hoy serializa el par: la de cupo lleva el servicio y la de hora es la hora AR de
 * INICIO (09:30 + 60' toma «T09» y 10:00 toma «T10»). Las dos altas leen «0 de otro servicio» y entran las dos. El
 * arreglo es la clave `kinesoft:pday:<t>:<profesional>:<día AR>` en la MISMA sentencia que el cupo
 * (`lockAgendaKeysMany`, `lib/booking-cap-lock.ts`, CF-L): dos turnos que se pisan comparten al menos un día AR.
 *
 * Arrancan como `it.fails` (CF-L publicó la clave; ningún write-path la toma todavía, y ninguno aplica la regla). Hoy
 * fallan por el motivo correcto: ENTRAN LAS DOS (la primera aserción, `toHaveLength(1)` sobre las que entraron, ve 2).
 * Quién los da vuelta:
 *   - [CF-R1] (agenda vs agenda, `createBooking`) → **CF-W1** (escrituras de un turno: regla en tx + `pday` en el
 *     `lockAgendaKeysMany` del alta; el perdedor recibe `otherService` sin escribir). Ya dado vuelta.
 *   - [CF-R2] (turnero vs agenda) → **CF-P** (submit del turnero con `pday` + bloqueo duro), sobre CF-W1. Pide que LAS
 *     DOS esperen el `pday`: con solo CF-W1 el turnero no espera y el test sigue fallando (`sawBothWaiting`). Ya dado vuelta.
 * Al darlos vuelta: `it.fails` → `it`, sin tocar las aserciones.
 *
 * Cómo se arma la carrera sin falso verde: un holder toma el `pday` del día; las dos altas arrancan y, con el lock,
 * quedan las dos esperándolo (se mira `pg_locks` por la clave exacta, no un conteo global); se suelta y la segunda
 * cuenta con la fila de la primera ya commiteada (READ COMMITTED). Hoy no esperan nada: terminan solas y el test
 * llega a la aserción del resultado. `sawBothWaiting` se afirma DESPUÉS del resultado para que hoy el motivo del fallo
 * sea «entraron las dos» y, ya arreglado, el test no pueda pasar sin haber probado la carrera.
 *
 * Símbolos reales; se mockean la sesión (`asUser`), `next/cache` (setup) y el rate-limit del turnero (red). Fixtures
 * por owner. Servicios del consultorio sin fila PractitionerService (habilitados y PUBLIC para todos), cupo
 * ilimitado y sin tope por intervalo: lo único que puede frenar es la regla de otro servicio.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...actual, rateLimit: async () => ({ ok: true, remaining: 99, retryAfterMs: 0 }) };
});

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createBooking } from "@/lib/bookings";
import { submitPublicBooking } from "@/lib/public-booking";
import type { SubmitPublicBookingInput } from "@/lib/public-booking-types";
import { practitionerDayLockKey } from "@/lib/booking-cap-lock";
import { localToARIso, toARDateKey, toARDow } from "@/lib/datetime-ar";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  sweepOrphanTestTenants,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { countAdvisoryWaiters } from "@/tests/helpers/advisory-wait";

const RUN = process.env.INTEGRATION === "1";

/** Pared AR → instante. */
const at = (day: string, hhmm: string) => new Date(localToARIso(`${day}T${hhmm}:00`));

/** El próximo `dow` (0=Dom) entre 7 y 13 días adelante, en calendario AR (dentro del horizonte del turnero). */
function futureDow(dow: number): string {
  for (let d = 7; ; d++) {
    const key = toARDateKey(new Date(Date.now() + d * 86_400_000));
    if (toARDow(new Date(localToARIso(`${key}T12:00:00`))) === dow) return key;
  }
}

type CreateInput = Parameters<typeof createBooking>[0];
/** El resultado real de `createBooking` (CF-W1 le sumó `otherService: BookingOtherServicePrompt`, brief CF A.5). */
type CreateResult = Awaited<ReturnType<typeof createBooking>>;

describe.skipIf(!RUN)("[CF-R] dos servicios distintos del mismo profesional a la vez (regla por defecto)", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let svcA: string; // «Kine», 60'
  let svcB: string; // «Evaluación», 60'
  const NAMES: Record<string, string> = {};
  let P1: { userId: string; practitionerId: string }; // [CF-R1]
  let P2: { userId: string; practitionerId: string }; // [CF-R2]

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    T = await createEphemeralTenant(db);
    for (const name of ["Kine", "Evaluación"]) {
      const s = await db.service.create({
        data: { tenantId: T.tenantId, practitionerId: null, name, durationMin: 60, priceCents: 0 },
      });
      NAMES[s.id] = name;
      if (name === "Kine") svcA = s.id;
      else svcB = s.id;
    }
    P1 = await addPractitioner(db, T, "PRACTITIONER");
    P2 = await addPractitioner(db, T, "PRACTITIONER");
    // No vacuo: la regla por defecto (default de la columna, M20) es la que se prueba; nadie la prende acá.
    const rules = await db.practitioner.findMany({
      where: { id: { in: [P1.practitionerId, P2.practitionerId] } },
      select: { allowParallelServices: true, bookingCapMode: true },
    });
    expect(rules).toEqual([
      { allowParallelServices: false, bookingCapMode: "INHERIT" },
      { allowParallelServices: false, bookingCapMode: "INHERIT" },
    ]);
    const tenant = await db.tenant.findUniqueOrThrow({ where: { id: T.tenantId }, select: { bookingCapCount: true } });
    expect(tenant.bookingCapCount).toBeNull(); // sin tope por intervalo: no se mete en la carrera
  });

  beforeEach(() => asUser(T.userId));

  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });

  /** Alta por la action real de la agenda. */
  async function alta(o: { prac: string; when: Date; svc: string }) {
    const patientId = await addPatient(db, T);
    const idempotencyKey = randomUUID();
    const r = await createBooking({
      patientId,
      serviceId: o.svc,
      practitionerId: o.prac,
      scheduledFor: o.when.toISOString(),
      durationMin: 60,
      idempotencyKey,
    } as CreateInput);
    const row = await db.booking.findUnique({ where: { idempotencyKey } });
    return { kind: "staff" as const, svc: o.svc, when: o.when, r, row };
  }

  /** Reserva por el turnero real (sin `TURNERO_CHECKOUT`: nace CONFIRMED sin Mercado Pago). */
  async function online(o: { prac: string; when: Date; svc: string; dni: string }) {
    const idempotencyKey = randomUUID();
    const input: SubmitPublicBookingInput = {
      tenantSlug: T.slug,
      idempotencyKey,
      practitionerId: o.prac,
      serviceId: o.svc,
      scheduledFor: o.when.toISOString(),
      patient: {
        firstName: "Ana",
        lastName: "Carrera",
        email: `cf-r-${randomUUID().slice(0, 8)}@test.local`,
        phone: `11${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`,
        dateOfBirth: "1990-05-10",
        documentId: o.dni,
        // Diagnóstico (Kine: `title`) / motivo (General: `notes`): CF los vuelve obligatorios (decisión 5).
        title: "Lumbalgia",
        notes: "Dolor lumbar",
      },
    };
    const r = await submitPublicBooking(input);
    const row = await db.booking.findFirst({
      where: { tenantId: T.tenantId, practitionerId: o.prac, serviceId: o.svc, scheduledFor: o.when },
    });
    return { kind: "online" as const, svc: o.svc, when: o.when, r, row };
  }

  /**
   * Toma `key` en un holder, arranca las altas y espera a que LAS DOS queden esperando esa clave o a que terminen
   * solas (hoy, sin el lock). Suelta y devuelve los resultados y si se vio la espera de las dos.
   */
  async function raceOnKey<R>(key: string, start: () => Promise<R>[]) {
    const holder = ownerClient();
    const probe = ownerClient();
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let acquired!: () => void;
    const got = new Promise<void>((r) => (acquired = r));
    const held = holder.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
        acquired();
        await released;
      },
      { timeout: 30_000 }
    );
    let ps: Promise<R>[] = [];
    try {
      await got;
      ps = start();
      const settled = Promise.allSettled(ps);
      let stop = false;
      const sawBoth = (async () => {
        const deadline = Date.now() + 8_000;
        while (!stop && Date.now() < deadline) {
          if ((await countAdvisoryWaiters(probe, key)) >= ps.length) return true;
          await new Promise((r) => setTimeout(r, 25));
        }
        return false;
      })();
      await Promise.race([sawBoth, settled]);
      stop = true;
      const sawBothWaiting = await sawBoth;
      release();
      await held;
      return { outs: await Promise.all(ps), sawBothWaiting };
    } finally {
      release();
      await held.catch(() => {});
      await Promise.allSettled(ps);
      await Promise.all([holder.$disconnect(), probe.$disconnect()]);
    }
  }

  const activeIn = (prac: string, day: string) =>
    db.booking.count({
      where: {
        tenantId: T.tenantId,
        practitionerId: prac,
        scheduledFor: { gte: at(day, "00:00"), lt: at(day, "23:59") },
        status: { not: "CANCELLED" },
      },
    });

  // Dado vuelta por CF-W1.
  it("[CF-R1] agenda: 09:30 + 60' (Kine) vs 10:00 + 60' (Evaluación) del mismo profesional → entra una; la otra recibe otherService", async () => {
    const day = "2027-11-09"; // martes, dentro del horario fallback del consultorio
    const prac = P1.practitionerId;
    const key = practitionerDayLockKey({ tenantId: T.tenantId, practitionerId: prac, dayKey: day });
    const { outs, sawBothWaiting } = await raceOnKey(key, () => [
      alta({ prac, when: at(day, "09:30"), svc: svcA }),
      alta({ prac, when: at(day, "10:00"), svc: svcB }),
    ]);

    // Hoy falla ACÁ: entran las dos.
    const won = outs.filter((o) => o.r.ok);
    expect(won).toHaveLength(1);
    const lost = outs.find((o) => !o.r.ok)!;
    expect(lost.row).toBeNull();
    // El aviso nombra el servicio que YA ocupa el horario (el del ganador) y su inicio.
    expect(lost.r.otherService).toMatchObject({
      practitionerName: expect.any(String),
      serviceName: NAMES[won[0].svc],
      existingISO: won[0].when.toISOString(),
    });
    expect(await activeIn(prac, day)).toBe(1);
    // La carrera ocurrió de verdad: las dos esperaron el día del profesional.
    expect(sawBothWaiting).toBe(true);
  });

  // Dado vuelta con CF-P (sobre CF-W1).
  it("[CF-R2] turnero (Kine 09:00 + 60') vs agenda (Evaluación 09:30 + 60') del mismo profesional → entra una", async () => {
    const day = futureDow(3); // miércoles, 7..13 días adelante (anticipación y horizonte del turnero)
    const prac = P2.practitionerId;
    const key = practitionerDayLockKey({ tenantId: T.tenantId, practitionerId: prac, dayKey: day });
    const { outs, sawBothWaiting } = await raceOnKey<Awaited<ReturnType<typeof alta>> | Awaited<ReturnType<typeof online>>>(
      key,
      () => [online({ prac, when: at(day, "09:00"), svc: svcA, dni: "71300001" }), alta({ prac, when: at(day, "09:30"), svc: svcB })]
    );

    // Hoy falla ACÁ: entran las dos.
    const won = outs.filter((o) => o.r.ok);
    expect(won).toHaveLength(1);
    const lost = outs.find((o) => !o.r.ok)!;
    expect(lost.row).toBeNull();
    if (lost.kind === "online") {
      // Bloqueo duro: el copy de siempre y la marca para que el wizard recargue la ventana.
      const r = lost.r as Extract<Awaited<ReturnType<typeof submitPublicBooking>>, { ok: false }>;
      expect(r.error).toMatch(/se acaba de ocupar/);
      expect(r.fieldErrors?.scheduledFor).toHaveLength(1);
    } else {
      expect((lost.r as CreateResult).otherService).toMatchObject({
        serviceName: NAMES[won[0].svc],
        existingISO: won[0].when.toISOString(),
      });
    }
    expect(await activeIn(prac, day)).toBe(1);
    expect(sawBothWaiting).toBe(true);
  });
});
