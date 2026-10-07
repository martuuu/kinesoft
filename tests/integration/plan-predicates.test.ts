/**
 * P2-C1 · predicados canónicos de Planes (`lib/plan-predicates.ts`) contra la
 * base real: los fragmentos `where` tienen que seleccionar exactamente lo que
 * dicen C3, C4, C5 y R-LEGACY. Se consulta por `runWithRls` del tenant (corre
 * con `kinesoft_app` y con el owner BYPASSRLS) y siempre con `tenantId` a mano.
 *
 * Paridad: `bookingHasPaymentWhere` ↔ `bookingHasMoney` (puro, lib/plan-pricing.ts)
 * y `adoptableBookingWhere` ↔ las reglas de `isAdoptable` (lib/availability/plan.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { BookingStatus, PaymentStatus, PrismaClient } from "@prisma/client";
import { runWithRls } from "@/lib/rls";
import {
  adoptableBookingWhere,
  bookingHasPaymentWhere,
  linkedProgramWhere,
  liveProgramWhere,
  liveSessionWhere,
  sessionWithoutActiveBookingWhere,
} from "@/lib/plan-predicates";
import { bookingHasMoney } from "@/lib/plan-pricing";
import { ownerClient, createEphemeralTenant, addPatient, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { createPlan, createLegacyPlan, addPlanBooking, addPlanSession, nextSlot } from "@/tests/helpers/plan-factory";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("P2-C1 · plan-predicates", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let Other: EphemeralTenant;

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
    Other = await createEphemeralTenant(db);
  });

  afterAll(async () => {
    await T?.cleanup();
    await Other?.cleanup();
    await db?.$disconnect();
  });

  /** Turno suelto por insert directo con key y cobro a elección. */
  async function loose(o: {
    patientId: string;
    status?: BookingStatus;
    paymentStatus?: PaymentStatus;
    key?: string;
    insurerPaidAt?: Date | null;
    t?: EphemeralTenant;
  }): Promise<string> {
    const t = o.t ?? T;
    const b = await db.booking.create({
      data: {
        tenantId: t.tenantId,
        patientId: o.patientId,
        practitionerId: t.practitionerId,
        serviceId: t.serviceId,
        scheduledFor: nextSlot(),
        durationMin: 45,
        idempotencyKey: o.key ?? randomUUID(),
        status: o.status ?? "CONFIRMED",
        paymentStatus: o.paymentStatus ?? "UNPAID",
        insurerPaidAt: o.insurerPaidAt ?? null,
      },
    });
    return b.id;
  }

  it("sessionWithoutActiveBookingWhere: sin turno = viva, no realizada, sin turno ∉ {CANCELLED, NO_SHOW}", async () => {
    const plan = await createPlan(db, T, { sessions: 4, bookings: 1 }); // s1 con turno CONFIRMED
    const [s1, s2, s3, s4] = plan.sessionIds;
    await addPlanBooking(db, T, { patientId: plan.patientId, programId: plan.programId, sessionId: s2, status: "CANCELLED" });
    await addPlanBooking(db, T, { patientId: plan.patientId, programId: plan.programId, sessionId: s2, status: "NO_SHOW" });
    await db.session.update({ where: { id: s4 }, data: { completedAt: new Date() } });
    const archived = await addPlanSession(db, plan.programId, {
      index: 5,
      practitionerId: T.practitionerId,
      archivedAt: new Date(),
    });

    const rows = await runWithRls(T.tenantId, (tx) =>
      tx.session.findMany({
        where: { program: { tenantId: T.tenantId, id: plan.programId }, ...sessionWithoutActiveBookingWhere },
        select: { id: true },
      })
    );
    const ids = new Set(rows.map((r) => r.id));
    expect(ids.has(s1)).toBe(false); // con turno activo
    expect(ids.has(s2)).toBe(true); // cancelado + ausente = sin turno
    expect(ids.has(s3)).toBe(true); // nunca tuvo turno
    expect(ids.has(s4)).toBe(false); // realizada
    expect(ids.has(archived)).toBe(false); // archivada

    const live = await runWithRls(T.tenantId, (tx) =>
      tx.session.count({ where: { program: { tenantId: T.tenantId, id: plan.programId }, ...liveSessionWhere } })
    );
    expect(live).toBe(4);
  });

  it("linkedProgramWhere (R-LEGACY): schedule o algún turno vinculado; legacy no", async () => {
    const withBooking = await createPlan(db, T, { sessions: 1, bookings: 1 });
    const withSchedule = await createPlan(db, T, {
      sessions: 1,
      data: { schedule: { v: 1, frequency: "weekly", slots: [{ dow: 1, startMin: 600 }] } },
    });
    const bare = await createPlan(db, T, { sessions: 1 }); // sin schedule ni turnos
    const legacy = await createLegacyPlan(db, T);
    const archivedPlan = await createPlan(db, T, { sessions: 1, data: { archivedAt: new Date() } });

    const rows = await runWithRls(T.tenantId, (tx) =>
      tx.treatmentProgram.findMany({
        where: { tenantId: T.tenantId, AND: [linkedProgramWhere, liveProgramWhere] },
        select: { id: true },
      })
    );
    const ids = new Set(rows.map((r) => r.id));
    expect(ids.has(withBooking.programId)).toBe(true);
    expect(ids.has(withSchedule.programId)).toBe(true);
    expect(ids.has(bare.programId)).toBe(false);
    expect(ids.has(legacy.programId)).toBe(false);
    expect(ids.has(archivedPlan.programId)).toBe(false);
  });

  it("adoptableBookingWhere: suelto, del paciente y del tenant, activo, nunca reserva pública PENDING impaga", async () => {
    const patientId = await addPatient(db, T);
    const otherPatient = await addPatient(db, T);
    const plan = await createPlan(db, T, { patientId, sessions: 1 });
    const iso = "2026-10-06T13:00:00.000Z";

    const yes = {
      confirmed: await loose({ patientId }),
      pending: await loose({ patientId, status: "PENDING" }),
      completed: await loose({ patientId, status: "COMPLETED" }),
      pubPaid: await loose({ patientId, status: "PENDING", paymentStatus: "PAID", key: `pub:${randomUUID()}:x` }),
      pubConfirmedUnpaid: await loose({ patientId, status: "CONFIRMED", key: `pub:${randomUUID()}:y` }),
    };
    const no = {
      cancelled: await loose({ patientId, status: "CANCELLED" }),
      noShow: await loose({ patientId, status: "NO_SHOW" }),
      pubUnpaid: await loose({ patientId, status: "PENDING", key: `pub:${randomUUID()}:z` }),
      pubFailed: await loose({ patientId, status: "PENDING", paymentStatus: "FAILED", key: `pub:${randomUUID()}:w` }),
      legacyPublic: await loose({ patientId, status: "PENDING", key: `${T.slug}:svc:${iso}:${patientId}` }),
      otherPatient: await loose({ patientId: otherPatient }),
      linked: await addPlanBooking(db, T, { patientId, programId: plan.programId, sessionId: plan.sessionIds[0] }),
    };
    const otherTenantPatient = await addPatient(db, Other);
    const foreign = await loose({ patientId: otherTenantPatient, t: Other });

    const rows = await runWithRls(T.tenantId, (tx) =>
      tx.booking.findMany({ where: adoptableBookingWhere({ tenantId: T.tenantId, patientId }), select: { id: true } })
    );
    const ids = new Set(rows.map((r) => r.id));
    for (const [k, id] of Object.entries(yes)) expect([k, ids.has(id)]).toEqual([k, true]);
    for (const [k, id] of Object.entries(no)) expect([k, ids.has(id)]).toEqual([k, false]);
    expect(ids.has(foreign)).toBe(false);
  });

  it("bookingHasPaymentWhere ↔ bookingHasMoney (paridad del criterio canónico)", async () => {
    const patientId = await addPatient(db, T);
    const cases: Array<{ ps: PaymentStatus; insurer?: boolean; pay?: PaymentStatus }> = [
      { ps: "UNPAID" },
      { ps: "FAILED" },
      { ps: "PAID" },
      { ps: "AUTHORIZED" },
      { ps: "REFUNDED" },
      { ps: "UNPAID", insurer: true },
      { ps: "UNPAID", pay: "AUTHORIZED" },
      { ps: "UNPAID", pay: "PAID" },
      { ps: "UNPAID", pay: "REFUNDED" },
      { ps: "UNPAID", pay: "FAILED" },
      { ps: "UNPAID", pay: "UNPAID" },
    ];
    const ids: string[] = [];
    for (const c of cases) {
      const id = await loose({ patientId, paymentStatus: c.ps, insurerPaidAt: c.insurer ? new Date() : null });
      if (c.pay) await db.payment.create({ data: { bookingId: id, status: c.pay, amountCents: 0 } });
      ids.push(id);
    }
    const matched = new Set(
      (
        await runWithRls(T.tenantId, (tx) =>
          tx.booking.findMany({
            where: { tenantId: T.tenantId, id: { in: ids }, ...bookingHasPaymentWhere },
            select: { id: true },
          })
        )
      ).map((r) => r.id)
    );
    const full = await db.booking.findMany({
      where: { id: { in: ids } },
      select: { id: true, paymentStatus: true, insurerPaidAt: true, payment: { select: { status: true } } },
    });
    expect(full).toHaveLength(cases.length);
    for (const b of full) expect([b.id, matched.has(b.id)]).toEqual([b.id, bookingHasMoney(b)]);
    // Control: el criterio no es "todo" ni "nada".
    expect(matched.size).toBeGreaterThan(0);
    expect(matched.size).toBeLessThan(cases.length);
  });
});
