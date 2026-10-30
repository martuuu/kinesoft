/**
 * [CF-P1..4] CF-P (§28 del plan; decisiones 1, 2, 3 y 6 de Martin del 30-oct; defaults CF-D7/D8/D9; M20) — el turnero
 * público con las reglas de agenda por profesional, contra Postgres real en los dos roles.
 *
 * Qué fija:
 *   - [CF-P1] «No atiende servicios distintos a la vez» (default de M20) es DURO en el turnero (decisión 2): con un
 *     turno de otro servicio pisado el horario no se ofrece (ni en la lista ni en la ventana) y el submit responde el
 *     `slotGone` de siempre sin escribir. Un día ocupado entero por otro servicio sigue siendo hábil («Completo»), no
 *     «no atiende». Con el interruptor «Atiende servicios distintos a la vez» prendido vuelve la conducta de antes.
 *   - [CF-P2] Paso de la grilla pública: profesional > consultorio > automático por duración (CF-D7).
 *   - [CF-P3] Anticipación: PractitionerService > consultorio > 60' (decisión 6; el 0 del PS es un valor). Una
 *     anticipación más larga que la búsqueda de 6 semanas carga la ventana desde el día de anticipación, y
 *     «cualquier profesional» también arranca ahí. La ventana devuelve la efectiva para el copy (CF-D9).
 *   - [CF-P4] El submit toma la clave del día del profesional (`kinesoft:pday:…`, enmienda C2 (1d)) en la MISMA
 *     sentencia, después del cupo y antes de la hora.
 *
 * Símbolos reales; se mockea solo el rate-limit (red) y, vía el setup de integración, `next/cache`. Sin
 * `TURNERO_CHECKOUT` (default `off`): las reservas nacen CONFIRMED sin Mercado Pago. Fixtures por owner. Cada test
 * usa su propio profesional (franjas propias, todos los días) para no depender del horario fallback ni pisarse.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...actual, rateLimit: async () => ({ ok: true, remaining: 99, retryAfterMs: 0 }) };
});

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  findFirstPublicSlot,
  listPublicSlotWindow,
  listPublicSlots,
  submitPublicBooking,
} from "@/lib/public-booking";
import type { SubmitPublicBookingInput } from "@/lib/public-booking-types";
import {
  capacityLockKey,
  hourKeyForStart,
  hourLockKey,
  practitionerDayLockKey,
} from "@/lib/booking-cap-lock";
import { localToARIso, toARDateKey, toARDow } from "@/lib/datetime-ar";
import { addDays } from "@/lib/availability/day";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  sweepOrphanTestTenants,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { waitForAdvisoryWaiter } from "@/tests/helpers/advisory-wait";

const RUN = process.env.INTEGRATION === "1";

const at = (day: string, hhmm: string) => new Date(localToARIso(`${day}T${hhmm}:00`));

/** El próximo `dow` (0=Dom) entre 7 y 13 días adelante, en calendario AR (dentro del horizonte del turnero). */
function futureDow(dow: number): string {
  for (let d = 7; ; d++) {
    const key = toARDateKey(new Date(Date.now() + d * 86_400_000));
    if (toARDow(new Date(localToARIso(`${key}T12:00:00`))) === dow) return key;
  }
}

/** ¿Cuántas sesiones tienen el advisory lock de `key` CONCEDIDO? (misma forma bigint que `countAdvisoryWaiters`). */
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

const MIN = 60_000;
const DAY_MIN = 1440;

describe.skipIf(!RUN)("[CF-P] turnero con reglas de agenda por profesional (M20)", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let locationId: string;
  let svcA: string; // «Kine», 60', del consultorio, cupo ilimitado
  let svcB: string; // «Evaluación», 60', del consultorio, cupo ilimitado
  const prevMode = process.env.TURNERO_CHECKOUT;

  beforeAll(async () => {
    delete process.env.TURNERO_CHECKOUT;
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    // Sin `allowParallelServices`: la regla por defecto de M20 es la que se prueba.
    T = await createEphemeralTenant(db);
    for (const name of ["Kine", "Evaluación"]) {
      const s = await db.service.create({
        data: { tenantId: T.tenantId, practitionerId: null, name, durationMin: 60, priceCents: 0 },
      });
      if (name === "Kine") svcA = s.id;
      else svcB = s.id;
    }
    const loc = await db.location.create({ data: { tenantId: T.tenantId, name: "Centro", isPrimary: true } });
    locationId = loc.id;
  });

  afterAll(async () => {
    if (prevMode === undefined) delete process.env.TURNERO_CHECKOUT;
    else process.env.TURNERO_CHECKOUT = prevMode;
    await T?.cleanup();
    await db?.$disconnect();
  });

  /** Profesional nuevo con franja `[start, end)` (HH:MM) los 7 días. */
  async function practitionerWithHours(start: string, end: string): Promise<string> {
    const p = await addPractitioner(db, T, "PRACTITIONER");
    const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
    await db.practitionerSchedule.createMany({
      data: [0, 1, 2, 3, 4, 5, 6].map((dow) => ({
        tenantId: T.tenantId,
        practitionerId: p.practitionerId,
        locationId,
        dow,
        startMin: toMin(start),
        endMin: toMin(end),
      })),
    });
    return p.practitionerId;
  }

  /** Turno cargado por el staff (fixture directo). */
  async function staffBooking(o: { prac: string; svc: string; when: Date; durationMin?: number }) {
    const patientId = await addPatient(db, T);
    return db.booking.create({
      data: {
        tenantId: T.tenantId,
        practitionerId: o.prac,
        serviceId: o.svc,
        patientId,
        locationId,
        scheduledFor: o.when,
        durationMin: o.durationMin ?? 60,
        status: "CONFIRMED",
        idempotencyKey: randomUUID(),
      },
    });
  }

  function req(o: { prac: string; svc: string; when: Date; dni: string }): SubmitPublicBookingInput {
    return {
      tenantSlug: T.slug,
      idempotencyKey: randomUUID(),
      practitionerId: o.prac,
      serviceId: o.svc,
      scheduledFor: o.when.toISOString(),
      patient: {
        firstName: "Ana",
        lastName: "Regla",
        email: `cf-p-${randomUUID().slice(0, 8)}@test.local`,
        phone: `11${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`,
        documentId: o.dni,
        dateOfBirth: null, // opcional desde CF-FORM (decisión 5)
        // Diagnóstico (Kine: `title`) / motivo (General: `notes`): obligatorios desde CF-FORM (decisión 5).
        title: "Lumbalgia",
        notes: "Dolor lumbar",
      },
    };
  }

  const times = async (prac: string, svc: string, day: string) =>
    (await listPublicSlots({ tenantSlug: T.slug, practitionerId: prac, serviceId: svc, date: day })).map((s) => s.time);

  it("[CF-P1] bloqueo duro: un turno de otro servicio pisado saca el horario y el submit da slotGone; con el interruptor prendido se ofrece", async () => {
    const prac = await practitionerWithHours("09:00", "13:00");
    const day = futureDow(2);
    await staffBooking({ prac, svc: svcB, when: at(day, "10:00") });
    // Mismo servicio: cuenta solo contra el cupo (ilimitado), no contra la regla.
    await staffBooking({ prac, svc: svcA, when: at(day, "11:00") });

    const list = await listPublicSlots({ tenantSlug: T.slug, practitionerId: prac, serviceId: svcA, date: day });
    expect(list.map((s) => [s.time, s.available])).toEqual([
      ["09:00", true], // 09:00 + 60' termina justo a las 10:00: semiabierto, no se pisa
      ["10:00", false],
      ["11:00", true],
      ["12:00", true],
    ]);
    const w = await listPublicSlotWindow({ tenantSlug: T.slug, practitionerId: prac, serviceId: svcA, from: day });
    expect(w.days[0]).toMatchObject({ date: day, status: "open" });
    expect(w.days[0].slots.map((s) => s.time)).toEqual(["09:00", "11:00", "12:00"]);

    const r = await submitPublicBooking(req({ prac, svc: svcA, when: at(day, "10:00"), dni: "72100001" }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/se acaba de ocupar o ya no se puede reservar online/);
      expect(r.fieldErrors?.scheduledFor).toEqual([r.error]);
    }
    expect(await db.booking.count({ where: { tenantId: T.tenantId, serviceId: svcA, scheduledFor: at(day, "10:00") } })).toBe(0);

    // Un día ocupado ENTERO por otro servicio sigue siendo hábil: «Completo», no «no atiende» (fuera de NOT_AHEAD).
    const fullDay = futureDow(4);
    await staffBooking({ prac, svc: svcB, when: at(fullDay, "09:00"), durationMin: 240 });
    const wf = await listPublicSlotWindow({ tenantSlug: T.slug, practitionerId: prac, serviceId: svcA, from: fullDay });
    expect(wf.days[0]).toEqual({ date: fullDay, status: "full", slots: [] });

    // Interruptor «Atiende servicios distintos a la vez» prendido → la conducta de antes de M20.
    await db.practitioner.update({ where: { id: prac }, data: { allowParallelServices: true } });
    const relaxed = await listPublicSlots({ tenantSlug: T.slug, practitionerId: prac, serviceId: svcA, date: day });
    expect(relaxed.find((s) => s.time === "10:00")?.available).toBe(true);
    const ok = await submitPublicBooking(req({ prac, svc: svcA, when: at(day, "10:00"), dni: "72100002" }));
    expect(ok.ok).toBe(true);
  });

  it("[CF-P2] paso del turnero: profesional > consultorio > automático por duración", async () => {
    const prac = await practitionerWithHours("09:00", "12:00");
    const day = futureDow(1);
    try {
      // Automático (AS-D9): 60' → paso 60.
      expect(await times(prac, svcA, day)).toEqual(["09:00", "10:00", "11:00"]);
      const off = await submitPublicBooking(req({ prac, svc: svcA, when: at(day, "09:30"), dni: "72200001" }));
      expect(off).toMatchObject({ ok: false, error: /no está disponible para reservar online/ });

      // Consultorio 30.
      await db.tenant.update({ where: { id: T.tenantId }, data: { publicSlotStepMin: 30 } });
      expect(await times(prac, svcA, day)).toEqual(["09:00", "09:30", "10:00", "10:30", "11:00"]);
      // Lo que se ofrece se acepta: el submit lee el mismo paso.
      const ok = await submitPublicBooking(req({ prac, svc: svcA, when: at(day, "09:30"), dni: "72200002" }));
      expect(ok.ok).toBe(true);

      // Profesional 45 gana sobre el consultorio 30 (anclado a la franja).
      await db.practitioner.update({ where: { id: prac }, data: { publicSlotStepMin: 45 } });
      const day2 = futureDow(5);
      expect(await times(prac, svcA, day2)).toEqual(["09:00", "09:45", "10:30"]);
      await db.practitioner.update({ where: { id: prac }, data: { publicSlotStepMin: 15 } });
      expect(await times(prac, svcA, day2)).toEqual([
        "09:00", "09:15", "09:30", "09:45", "10:00", "10:15", "10:30", "10:45", "11:00",
      ]);
      // El paso del STAFF no toca el turnero.
      await db.practitioner.update({ where: { id: prac }, data: { publicSlotStepMin: null, agendaSlotStepMin: 15 } });
      expect(await times(prac, svcA, day2)).toEqual(["09:00", "09:30", "10:00", "10:30", "11:00"]);
    } finally {
      await db.tenant.update({ where: { id: T.tenantId }, data: { publicSlotStepMin: null } });
    }
  });

  it("[CF-P3] anticipación: consultorio > 60', el 0 del PS gana, y una anticipación larga carga desde ese día", async () => {
    const prac = await practitionerWithHours("08:00", "19:00");
    const today = toARDateKey(new Date());
    const tomorrow = addDays(today, 1);
    const win = () => listPublicSlotWindow({ tenantSlug: T.slug, practitionerId: prac, serviceId: svcA });
    try {
      // Sin configurar: 60' (y se devuelve para el copy, CF-D9).
      expect((await win()).minLeadMinutes).toBe(60);

      // Consultorio 2 días: no se ofrece nada antes de now + 48 h.
      await db.tenant.update({ where: { id: T.tenantId }, data: { publicMinLeadMinutes: 2 * DAY_MIN } });
      const before = Date.now();
      const w2 = await win();
      expect(w2.minLeadMinutes).toBe(2 * DAY_MIN);
      expect(w2.days.length).toBe(5);
      for (const d of w2.days) for (const s of d.slots) expect(Date.parse(s.iso)).toBeGreaterThanOrEqual(before + 2 * DAY_MIN * MIN);
      const tom = await listPublicSlots({ tenantSlug: T.slug, practitionerId: prac, serviceId: svcA, date: tomorrow });
      expect(tom.length).toBeGreaterThan(0);
      expect(tom.filter((s) => s.available)).toEqual([]);

      // PS en 0 gana sobre el consultorio (0 es un valor, no «vacío»).
      await db.practitionerService.create({
        data: { tenantId: T.tenantId, practitionerId: prac, serviceId: svcA, minLeadMinutes: 0 },
      });
      const w0 = await win();
      expect(w0.minLeadMinutes).toBe(0);
      expect(w0.days[0].date <= tomorrow).toBe(true);
      const tom0 = await listPublicSlots({ tenantSlug: T.slug, practitionerId: prac, serviceId: svcA, date: tomorrow });
      expect(tom0.every((s) => s.available)).toBe(true);
      await db.practitionerService.deleteMany({ where: { practitionerId: prac, serviceId: svcA } });

      // Consultorio 2 semanas: la ventana arranca en el día de anticipación.
      await db.tenant.update({ where: { id: T.tenantId }, data: { publicMinLeadMinutes: 14 * DAY_MIN } });
      const w14 = await win();
      expect(w14.minLeadMinutes).toBe(14 * DAY_MIN);
      expect(w14.days.length).toBe(5);
      expect(w14.days[0].date >= addDays(today, 14)).toBe(true);
      expect(w14.days[0].date <= addDays(today, 15)).toBe(true);

      // 6 semanas: más que la búsqueda de 6 semanas (42 días) → la ventana se carga desde el día de anticipación.
      // Antes de CF-P salía vacía con «Siguientes» (todo `anticipacion-minima`).
      await db.tenant.update({ where: { id: T.tenantId }, data: { publicMinLeadMinutes: 42 * DAY_MIN } });
      const w42 = await win();
      expect(w42.days.length).toBe(5);
      expect(w42.days.every((d) => d.status === "open")).toBe(true);
      expect(w42.days[0].date >= addDays(today, 42)).toBe(true);
      expect(w42.days[0].date <= addDays(today, 43)).toBe(true);
      // Lo que ofrece lo acepta el submit (misma grilla, misma anticipación).
      const slot = w42.days[1].slots[0];
      const ok = await submitPublicBooking(req({ prac, svc: svcA, when: new Date(slot.iso), dni: "72300001" }));
      expect(ok.ok).toBe(true);

      // «Cualquier profesional» (horizonte de 14 días) arranca en el día de anticipación más temprano.
      const first = await findFirstPublicSlot({ tenantSlug: T.slug, serviceId: svcA });
      expect(first).not.toBeNull();
      expect(Date.parse(first!.iso)).toBeGreaterThanOrEqual(before + 42 * DAY_MIN * MIN);
    } finally {
      await db.practitionerService.deleteMany({ where: { practitionerId: prac, serviceId: svcA } });
      await db.tenant.update({ where: { id: T.tenantId }, data: { publicMinLeadMinutes: null } });
    }
  });

  it("[CF-P4] el submit toma el día del profesional (pday) en la misma sentencia: después del cupo, antes de la hora", async () => {
    const prac = await practitionerWithHours("09:00", "13:00");
    const day = futureDow(3);
    const when = at(day, "10:00");
    const pday = practitionerDayLockKey({ tenantId: T.tenantId, practitionerId: prac, dayKey: day });
    const cap = capacityLockKey({ tenantId: T.tenantId, practitionerId: prac, serviceId: svcA, dayKey: day });
    const hour = hourLockKey(hourKeyForStart({ tenantId: T.tenantId, practitionerId: prac, start: when }));
    const holder = ownerClient();
    const probe = ownerClient();
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let acquired!: () => void;
    const got = new Promise<void>((r) => (acquired = r));
    const held = holder.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${pday}, 0))`;
        acquired();
        await released;
      },
      { timeout: 20_000 }
    );
    await got;
    const p = submitPublicBooking(req({ prac, svc: svcA, when, dni: "72400001" }));
    try {
      await waitForAdvisoryWaiter(probe, pday, { timeoutMs: 8_000 });
      // Orden C2 (1d): cupo → día → hora. Esperando el día ya tiene el cupo y todavía no la hora.
      expect(await grantedHolders(probe, cap)).toBe(1);
      expect(await grantedHolders(probe, hour)).toBe(0);
      release();
      await held;
      const r = await p;
      expect(r.ok).toBe(true);
      expect(await db.booking.count({ where: { tenantId: T.tenantId, practitionerId: prac, scheduledFor: when } })).toBe(1);
    } finally {
      release();
      await held.catch(() => {});
      await p.catch(() => {});
      await Promise.all([holder.$disconnect(), probe.$disconnect()]);
    }
  });
});
