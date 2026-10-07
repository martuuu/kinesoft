/**
 * S14r (ES3, plan §16.2) · ingresos reales del dashboard con Mes/Semana.
 *
 * Antes el widget sumaba solo los `Payment` PAID de Mercado Pago: el copago
 * cobrado en mano no aparecía nunca (AUDIT P11, "ingresos del dashboard que
 * solo cuentan MP"). Se prueba contra Postgres, con las actions REALES
 * (`setBookingCopagoPaid`, `getRevenue`, `getDashboardData`,
 * `updateDashboardPrefs`) y en los dos roles (`kinesoft_app` y owner BYPASSRLS):
 *
 *   - copago manual marcado → cuenta en la semana y en el mes; desmarcado →
 *     `copagoPaidAt` NULL y deja de contar;
 *   - borde del domingo 23:30 AR con TZ=UTC (reloj fijado: solo `Date`);
 *   - un turno con `Payment` de MP PAID no se cuenta dos veces;
 *   - la obra social va aparte (arancel × turnos con `insurerPaidAt`);
 *   - consultorio General (sin `planes`): ingresos igual, sin tocar planes;
 *   - el período elegido se guarda en `dashboardPrefs` y el dashboard arranca ahí;
 *   - aislamiento: la plata de otro consultorio no entra.
 */
import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { getDashboardData, getRevenue } from "@/lib/dashboard";
import { setBookingCopagoPaid } from "@/lib/bookings";
import { getUserPreferences, updateDashboardPrefs } from "@/lib/preferences";
import { measure, type QueryEvent } from "@/tests/helpers/query-counter";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addInsurer,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser, asAnonymous } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";
const ar = (s: string) => new Date(`${s}-03:00`);

function recorded(): QueryEvent[] {
  return (globalThis as unknown as { __kineQueryRecorder: { events: QueryEvent[] } }).__kineQueryRecorder.events;
}
const touches = (table: string) => recorded().filter((e) => e.query.includes(`"${table}"`));

async function revenue(range: "week" | "month") {
  const r = await getRevenue(range);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

describe.skipIf(!RUN)("S14r · ingresos del dashboard (Mes/Semana)", () => {
  let db: PrismaClient;
  const tenants: EphemeralTenant[] = [];

  async function tenant(opts: Parameters<typeof createEphemeralTenant>[1] = {}) {
    const t = await createEphemeralTenant(db, opts);
    tenants.push(t);
    return t;
  }

  async function booking(
    t: EphemeralTenant,
    o: {
      patientId?: string;
      scheduledFor?: Date;
      copagoCents?: number;
      paymentStatus?: "PAID" | "UNPAID";
      copagoPaidAt?: Date | null;
      insurerPaidAt?: Date | null;
    } = {}
  ) {
    return db.booking.create({
      data: {
        tenantId: t.tenantId,
        patientId: o.patientId,
        guestName: o.patientId ? undefined : "Invitado S14r",
        practitionerId: t.practitionerId,
        serviceId: t.serviceId,
        scheduledFor: o.scheduledFor ?? new Date(),
        durationMin: 45,
        idempotencyKey: randomUUID(),
        status: "COMPLETED",
        copagoCents: o.copagoCents ?? null,
        paymentStatus: o.paymentStatus ?? "UNPAID",
        copagoPaidAt: o.copagoPaidAt ?? null,
        insurerPaidAt: o.insurerPaidAt ?? null,
      },
    });
  }

  beforeAll(() => {
    db = ownerClient();
  });

  afterEach(() => {
    vi.useRealTimers();
    asAnonymous();
  });

  afterAll(async () => {
    for (const t of tenants) await t.cleanup();
    await db?.$disconnect();
  });

  it("copago manual: marcar lo cuenta en semana y mes; desmarcar limpia copagoPaidAt y lo saca", async () => {
    const T = await tenant();
    const patientId = await addPatient(db, T);
    const b = await booking(T, { patientId, copagoCents: 250_000 });
    asUser(T.userId);

    expect((await revenue("week")).totalCents).toBe(0);

    const before = Date.now();
    const marked = await setBookingCopagoPaid(b.id, true, b.updatedAt.toISOString());
    expect(marked.ok).toBe(true);
    const row = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(row.paymentStatus).toBe("PAID");
    expect(row.copagoPaidAt).not.toBeNull();
    expect(row.copagoPaidAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);

    for (const range of ["week", "month"] as const) {
      expect(await revenue(range)).toMatchObject({ totalCents: 250_000, manualCents: 250_000, mpCents: 0 });
    }
    // La KPI del mes del dashboard dice lo mismo que el widget.
    expect((await getDashboardData()).monthRevenue.totalCents).toBe(250_000);

    const unmarked = await setBookingCopagoPaid(b.id, false, marked.ok ? marked.data.updatedAt.toISOString() : undefined);
    expect(unmarked.ok).toBe(true);
    const after = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(after).toMatchObject({ paymentStatus: "UNPAID", copagoPaidAt: null });
    for (const range of ["week", "month"] as const) {
      expect((await revenue(range)).totalCents).toBe(0);
    }
  });

  it("CAS: un toggle con updatedAt viejo no escribe copagoPaidAt", async () => {
    const T = await tenant();
    const b = await booking(T, { patientId: await addPatient(db, T), copagoCents: 100_000 });
    asUser(T.userId);
    const r = await setBookingCopagoPaid(b.id, true, new Date(b.updatedAt.getTime() - 60_000).toISOString());
    expect(r.ok).toBe(false);
    expect(await db.booking.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({
      paymentStatus: "UNPAID",
      copagoPaidAt: null,
    });
  });

  it("borde: domingo 23:30 AR (lunes 02:30 UTC) sigue siendo la semana del lunes anterior", async () => {
    const T = await tenant();
    // 2026-10-11 = domingo. Semana: lun 05 00:00 AR → lun 12 00:00 AR.
    await booking(T, { paymentStatus: "PAID", copagoCents: 100_000, copagoPaidAt: ar("2026-10-11T23:00:00") }); // dom, adentro
    await booking(T, { paymentStatus: "PAID", copagoCents: 20_000, copagoPaidAt: ar("2026-10-05T00:00:00") }); // lun 00:00, adentro
    await booking(T, { paymentStatus: "PAID", copagoCents: 3_000, copagoPaidAt: ar("2026-10-04T23:59:00") }); // dom anterior
    await booking(T, { paymentStatus: "PAID", copagoCents: 400, copagoPaidAt: ar("2026-10-12T00:10:00") }); // lun siguiente
    await booking(T, { paymentStatus: "PAID", copagoCents: 50, copagoPaidAt: ar("2026-09-30T12:00:00") }); // mes anterior
    asUser(T.userId);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(ar("2026-10-11T23:30:00"));

    expect(await revenue("week")).toMatchObject({ totalCents: 120_000, prevTotalCents: 3_000 + 50, range: "week" });
    // Mes AR de octubre: todo lo de octubre (incluye el lunes 12) vs septiembre.
    expect(await revenue("month")).toMatchObject({ totalCents: 123_400, prevTotalCents: 50, range: "month" });
  });

  it("MP no se duplica: el turno con Payment PAID cuenta una vez (por MP)", async () => {
    const T = await tenant();
    const b = await booking(T, { paymentStatus: "PAID", copagoCents: 500_000, copagoPaidAt: new Date() });
    await db.payment.create({ data: { bookingId: b.id, status: "PAID", amountCents: 500_000 } });
    // Control: un Payment que no está PAID no tapa el copago cobrado a mano.
    const c = await booking(T, { paymentStatus: "PAID", copagoCents: 70_000, copagoPaidAt: new Date() });
    await db.payment.create({ data: { bookingId: c.id, status: "FAILED", amountCents: 0 } });
    asUser(T.userId);
    expect(await revenue("month")).toMatchObject({ mpCents: 500_000, manualCents: 70_000, totalCents: 570_000 });
  });

  it("obra social aparte: arancel × turnos con insurerPaidAt; no suma en el total", async () => {
    const T = await tenant();
    const osId = await addInsurer(db, T, { name: "OS S14r", fixedFeeCents: 300_000, copagoCents: 50_000 });
    const patientId = await addPatient(db, T);
    // Dos coberturas: vale la última (id mayor), como en Facturación.
    const oldOs = await addInsurer(db, T, { name: "OS vieja S14r", fixedFeeCents: 999_900 });
    await db.coverage.create({ data: { id: "a-s14r-" + randomUUID(), patientId, insurer: "OS vieja", insurerId: oldOs } });
    await db.coverage.create({ data: { id: "z-s14r-" + randomUUID(), patientId, insurer: "OS S14r", insurerId: osId } });
    await booking(T, { patientId, insurerPaidAt: new Date(), paymentStatus: "PAID", copagoCents: 50_000, copagoPaidAt: new Date() });
    await booking(T, { patientId, insurerPaidAt: new Date() });
    // Paciente Particular: su "OS" no paga nada.
    const particularPatient = await addPatient(db, T);
    await db.coverage.create({ data: { patientId: particularPatient, insurer: "Particular", insurerId: T.particularInsurerId } });
    await booking(T, { patientId: particularPatient, insurerPaidAt: new Date() });
    asUser(T.userId);
    for (const range of ["week", "month"] as const) {
      expect(await revenue(range)).toMatchObject({ totalCents: 50_000, manualCents: 50_000, insurerCents: 600_000 });
    }
  });

  it("General (sin `planes`): los ingresos cuentan y no se consultan planes ni sesiones", async () => {
    const G = await tenant({ vertical: "GENERAL", plan: "PRO", publicBookingEnabled: false });
    await booking(G, { paymentStatus: "PAID", copagoCents: 80_000, copagoPaidAt: new Date() });
    asUser(G.userId);
    const { result } = await measure(() => getRevenue("week"));
    expect(result).toMatchObject({ ok: true, data: { totalCents: 80_000 } });
    expect(touches("TreatmentProgram")).toEqual([]);
    expect(touches("Session")).toEqual([]);
    const { result: d } = await measure(() => getDashboardData());
    expect(d.monthRevenue.totalCents).toBe(80_000);
    expect(touches("TreatmentProgram")).toEqual([]);
  });

  it("aislamiento: la plata de otro consultorio no entra", async () => {
    const A = await tenant();
    const B = await tenant();
    await booking(B, { paymentStatus: "PAID", copagoCents: 900_000, copagoPaidAt: new Date() });
    const bb = await booking(B, { paymentStatus: "PAID", copagoCents: 0, insurerPaidAt: new Date() });
    await db.payment.create({ data: { bookingId: bb.id, status: "PAID", amountCents: 900_000 } });
    asUser(A.userId);
    expect(await revenue("month")).toMatchObject({ totalCents: 0, mpCents: 0, manualCents: 0, insurerCents: 0 });
  });

  it("el período elegido se guarda en dashboardPrefs y el dashboard arranca ahí", async () => {
    const T = await tenant();
    asUser(T.userId);
    expect((await getUserPreferences()).dashboard).toEqual({ revenueRange: "month" });
    expect((await getDashboardData()).revenue.range).toBe("month");

    expect(await updateDashboardPrefs({ revenueRange: "week" })).toEqual({ ok: true, data: { revenueRange: "week" } });
    const row = await db.userPreferences.findUniqueOrThrow({ where: { userId: T.userId } });
    expect(row.dashboardPrefs).toEqual({ revenueRange: "week" });
    expect((await getUserPreferences()).dashboard.revenueRange).toBe("week");
    const d = await getDashboardData();
    expect(d.revenue.range).toBe("week");
    expect(d.monthRevenue.range).toBe("month");

    // Escritura estricta: no se guarda basura.
    expect((await updateDashboardPrefs({ revenueRange: "year" })).ok).toBe(false);
    expect((await getRevenue("year" as never)).ok).toBe(false);
    expect((await db.userPreferences.findUniqueOrThrow({ where: { userId: T.userId } })).dashboardPrefs).toEqual({
      revenueRange: "week",
    });
  });
});
