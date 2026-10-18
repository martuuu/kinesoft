/**
 * TP-1 (plan §22.5, TP-D2): `listPublicSlotWindow` REAL contra Postgres, en el canal de servicio (sin Actor, como en
 * prod). Corre con los dos roles (`test:integration` = kinesoft_app, `test:integration:owner` = BYPASSRLS).
 *
 * Se mockea solo el rate limit (para contar los hits por bucket) — nunca la función bajo test. La regla pura (qué es
 * hábil, «Completo», avance, topes) tiene su tabla en tests/unit/public-slot-window.test.ts; acá se afirma lo que solo
 * se ve con la base: el loader trae turnos/franjas reales, las compuertas del turnero, y que lo ofrecido lo acepta el
 * submit real (paridad end-to-end) y después deja de ofrecerse.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

const rl = vi.hoisted(() => ({ keys: [] as string[] }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: async (key: string) => {
    rl.keys.push(key);
    return { ok: true, remaining: 99, retryAfterMs: 0 };
  },
}));

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { listPublicSlotWindow, listPublicSlots, submitPublicBooking } from "@/lib/public-booking";
import { localToARIso, toARDateKey } from "@/lib/datetime-ar";
import { addDays, dowOfDayKey } from "@/lib/availability/day";
import {
  ownerClient,
  createEphemeralTenant,
  addService,
  addPractitioner,
  sweepOrphanTestTenants,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

/** Primer lunes AR a 14 días o más de hoy (lejos de la anticipación y dentro del tope de 90). */
function futureMonday(): string {
  let k = addDays(toARDateKey(new Date()), 14);
  while (dowOfDayKey(k) !== 1) k = addDays(k, 1);
  return k;
}
const at = (day: string, hhmm: string) => new Date(localToARIso(`${day}T${hhmm}:00`));
const SLOT_TIMES = ["09:00", "09:45", "10:30", "11:15"];

describe.skipIf(!RUN)("TP-1 · listPublicSlotWindow (turnero real)", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let serviceId: string;
  let otherPractitionerId: string;
  const W1 = futureMonday();
  const W2 = addDays(W1, 7);
  const prevMode = process.env.TURNERO_CHECKOUT;

  const slotKeys = () => rl.keys.filter((k) => k.startsWith("pub:slots:"));
  const call = (extra: Partial<Parameters<typeof listPublicSlotWindow>[0]> = {}) =>
    listPublicSlotWindow({ tenantSlug: T.slug, practitionerId: T.practitionerId, serviceId, ...extra });

  beforeAll(async () => {
    // Sin checkout: el submit de la paridad reserva sin Mercado Pago (TP-0).
    delete process.env.TURNERO_CHECKOUT;
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    T = await createEphemeralTenant(db);
    serviceId = await addService(db, T, { name: "Evaluación", durationMin: 45, priceCents: 0, maxConcurrent: 1 });
    const loc = await db.location.create({ data: { tenantId: T.tenantId, name: "Centro", isPrimary: true } });
    // Lun-vie 09:00-12:00 → 4 horarios por día con 45 min.
    await db.practitionerSchedule.createMany({
      data: [1, 2, 3, 4, 5].map((dow) => ({
        tenantId: T.tenantId,
        practitionerId: T.practitionerId,
        locationId: loc.id,
        dow,
        startMin: 540,
        endMin: 720,
      })),
    });
    // La semana W1 completa (cupo 1) y el martes de W2.
    const full = [0, 1, 2, 3, 4].map((i) => addDays(W1, i)).concat(addDays(W2, 1));
    await db.booking.createMany({
      data: full.flatMap((day) =>
        SLOT_TIMES.map((t) => ({
          tenantId: T.tenantId,
          practitionerId: T.practitionerId,
          serviceId,
          locationId: loc.id,
          scheduledFor: at(day, t),
          durationMin: 45,
          status: "CONFIRMED" as const,
          paymentStatus: "UNPAID" as const,
          idempotencyKey: randomUUID(),
          guestName: "Ocupado",
        }))
      ),
    });
    // Un profesional del consultorio apagado en el turnero (PL-2f): no tiene ventana.
    const other = await addPractitioner(db, T, "PRACTITIONER");
    otherPractitionerId = other.practitionerId;
    await db.practitioner.update({ where: { id: otherPractitionerId }, data: { publicBookingEnabled: false } });
  });

  afterAll(async () => {
    if (prevMode === undefined) delete process.env.TURNERO_CHECKOUT;
    else process.env.TURNERO_CHECKOUT = prevMode;
    await T?.cleanup();
    await db?.$disconnect();
  });

  it("[TP-1] 5 hábiles llenos → avanza a la semana siguiente con skippedFrom; el martes lleno queda «Completo»", async () => {
    const before = slotKeys().length;
    const w = await call({ from: W1 });
    expect(slotKeys().length - before).toBe(1);
    expect(w.skippedFrom).toBe(W1);
    expect(w.days.map((d) => d.date)).toEqual([0, 1, 2, 3, 4].map((i) => addDays(W2, i)));
    expect(w.days.map((d) => d.status)).toEqual(["open", "full", "open", "open", "open"]);
    expect(w.days[1].slots).toEqual([]);
    expect(w.days[0].slots.map((s) => s.time)).toEqual(SLOT_TIMES);
    expect(w).toMatchObject({ nextFrom: addDays(W2, 5), reachedEnd: false });
  });

  it("[TP-1] cada horario de la ventana es un libre de la lista de su día (misma grilla del submit)", async () => {
    const w = await call({ from: W2 });
    expect(w.skippedFrom).toBeNull();
    for (const day of w.days) {
      const list = await listPublicSlots({ tenantSlug: T.slug, practitionerId: T.practitionerId, serviceId, date: day.date });
      expect(day.slots).toEqual(list.filter((s) => s.available));
    }
  });

  it("[TP-1] lo que ofrece la ventana lo acepta el submit real y después deja de ofrecerse", async () => {
    const w = await call({ from: W2 });
    const slot = w.days[0].slots[0];
    const res = await submitPublicBooking({
      tenantSlug: T.slug,
      idempotencyKey: randomUUID(),
      practitionerId: T.practitionerId,
      serviceId,
      scheduledFor: slot.iso,
      patient: {
        firstName: "Ana",
        lastName: "Pérez",
        email: `ana-${randomUUID().slice(0, 8)}@test.local`,
        phone: "1155554444",
        documentId: `${Math.floor(Math.random() * 1e8)}`,
        dateOfBirth: "1990-05-10",
      },
    });
    expect(res).toMatchObject({ ok: true, data: { next: "reserved", initPoint: null } });
    const after = await call({ from: W2 });
    expect(after.days[0].slots.map((s) => s.iso)).not.toContain(slot.iso);
    expect(after.days[0].slots).toHaveLength(SLOT_TIMES.length - 1);
  });

  it("[TP-1] sin `from` (o con uno pasado) arranca hoy AR; el primer día es hábil y no anterior a hoy", async () => {
    const today = toARDateKey(new Date());
    for (const from of [undefined, "2020-01-06"]) {
      const w = await call(from ? { from } : {});
      expect(w.days.length).toBeGreaterThan(0);
      expect(w.days[0].date >= today).toBe(true);
      expect([1, 2, 3, 4, 5]).toContain(dowOfDayKey(w.days[0].date));
    }
  });

  it("[TP-1] compuertas: turnero cerrado, profesional apagado, servicio ajeno o input inválido → ventana vacía", async () => {
    const empty = { days: [], nextFrom: null, reachedEnd: true, skippedFrom: null };
    expect(await call({ practitionerId: otherPractitionerId })).toEqual(empty);
    expect(await call({ serviceId: "svc-que-no-existe" })).toEqual(empty);
    expect(await call({ from: "2026-02-30" })).toEqual(empty);
    expect(await call({ tenantSlug: "" })).toEqual(empty);
    // Más allá del tope de 90 días.
    expect(await call({ from: addDays(toARDateKey(new Date()), 91) })).toEqual(empty);
    await db.tenant.update({ where: { id: T.tenantId }, data: { publicBookingEnabled: false } });
    try {
      expect(await call({ from: W2 })).toEqual(empty);
    } finally {
      await db.tenant.update({ where: { id: T.tenantId }, data: { publicBookingEnabled: true } });
    }
  });
});
