/**
 * SR-D5I · ingresos del dashboard por rol (decisión de Martin, 08-oct:
 * "Ingresos del dashboard restringidos: cada Profesional ve sus ingresos").
 *
 * Antes de SR-D5I `getRevenue` y la KPI `monthRevenue` sumaban la plata de
 * TODO el consultorio para cualquier rol: un PRACTITIONER veía lo que cobraba
 * su colega y la Secretaria (ASSISTANT) veía la caja entera. Ahora
 * (`revenueScopeFor`, `lib/dashboard-revenue.ts`):
 *   - `billing.manage` (OWNER / ADMIN / BILLING) → todo el consultorio;
 *   - `clinical.read` sin `billing.manage` (PRACTITIONER) → solo sus turnos
 *     (`Booking.practitionerId` ACTUAL del turno), aunque el consultorio tenga
 *     `sharedPatientView` (por eso no se usa `visibilityForActor`);
 *   - el resto (ASSISTANT) → nada: `getRevenue` da error, el widget y la KPI
 *     vienen en null y no se consulta `Payment`.
 *
 * Fuga por cache: el mock de `unstable_cache` es pass-through en toda la
 * suite, así que dos actores con la MISMA clave nunca se pisaban en un test.
 * Acá se prende el Map real (`useRealUnstableCache`) y se recorre A → B →
 * OWNER → A: si la clave no llevara el scope, el segundo leería el número del
 * primero.
 *
 * Fixture (por consultorio): A y B (PRACTITIONER) con un turno cobrado por MP,
 * uno con copago a mano y turnos con la OS pagada (un mismo paciente con
 * turnos de los dos, para que el `groupBy` por paciente no mezcle):
 *   A: MP 100.000 + copago 20.000 = 120.000 · OS 1 turno × 3.000
 *   B: MP 400.000 + copago 50.000 = 450.000 · OS 2 turnos × 3.000
 * Montos en centavos.
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
import { updateDashboardPrefs } from "@/lib/preferences";
import { measure, type QueryEvent } from "@/tests/helpers/query-counter";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addInsurer,
  addPractitioner,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser, asAnonymous } from "@/tests/helpers/actor";
import { useRealUnstableCache, usePassthroughUnstableCache } from "@/tests/helpers/integration-setup";

const RUN = process.env.INTEGRATION === "1";

function recorded(): QueryEvent[] {
  return (globalThis as unknown as { __kineQueryRecorder: { events: QueryEvent[] } }).__kineQueryRecorder.events;
}
const touches = (table: string) => recorded().filter((e) => e.query.includes(`"${table}"`));

const FEE = 3_000;
const A_TOTAL = 120_000;
const B_TOTAL = 450_000;
const A_OS = FEE;
const B_OS = 2 * FEE;

type Fixture = {
  T: EphemeralTenant;
  A: { userId: string; practitionerId: string };
  B: { userId: string; practitionerId: string };
  admin: string;
  billing: string;
  assistant: string;
};

async function revenue(range: "week" | "month") {
  const r = await getRevenue(range);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

describe.skipIf(!RUN)("SR-D5I · ingresos del dashboard por rol", () => {
  let db: PrismaClient;
  const tenants: EphemeralTenant[] = [];
  // SRZ (FX1): cada turno en un instante distinto. Con `new Date()` dos turnos
  // del MISMO paciente (`shared`) podían caer en el mismo milisegundo y chocar
  // con el índice único parcial (tenantId, patientId, scheduledFor): el test
  // fallaba ~1 de 4 corridas con el rol owner. Los ingresos se cuentan por
  // `copagoPaidAt` / `insurerPaidAt` / `Payment.createdAt`, no por
  // `scheduledFor`, así que correrlos minutos hacia atrás no cambia los montos.
  let seq = 0;

  async function booking(
    t: EphemeralTenant,
    practitionerId: string,
    o: { patientId?: string; copagoCents?: number; paid?: boolean; insurerPaid?: boolean }
  ) {
    return db.booking.create({
      data: {
        tenantId: t.tenantId,
        patientId: o.patientId,
        guestName: o.patientId ? undefined : "Invitado SR-D5I",
        practitionerId,
        serviceId: t.serviceId,
        scheduledFor: new Date(Date.now() - ++seq * 60_000),
        durationMin: 45,
        idempotencyKey: randomUUID(),
        status: "COMPLETED",
        copagoCents: o.copagoCents ?? null,
        paymentStatus: o.paid ? "PAID" : "UNPAID",
        copagoPaidAt: o.paid ? new Date() : null,
        insurerPaidAt: o.insurerPaid ? new Date() : null,
      },
    });
  }

  async function fixture(sharedPatientView = false): Promise<Fixture> {
    const T = await createEphemeralTenant(db, { sharedPatientView });
    tenants.push(T);
    const A = await addPractitioner(db, T, "PRACTITIONER");
    const B = await addPractitioner(db, T, "PRACTITIONER");
    const admin = (await addPractitioner(db, T, "ADMIN")).userId;
    const billing = (await addPractitioner(db, T, "BILLING")).userId;
    const assistant = (await addPractitioner(db, T, "ASSISTANT")).userId;

    const money = async (p: { practitionerId: string }, mp: number, manual: number, osTurns: number, osPatient: string) => {
      const m = await booking(T, p.practitionerId, { paid: true, copagoCents: mp });
      await db.payment.create({ data: { bookingId: m.id, status: "PAID", amountCents: mp } });
      await booking(T, p.practitionerId, { paid: true, copagoCents: manual });
      for (let i = 0; i < osTurns; i++) await booking(T, p.practitionerId, { patientId: osPatient, insurerPaid: true });
    };
    const osId = await addInsurer(db, T, { name: "OS SR-D5I", fixedFeeCents: FEE });
    // Un mismo paciente con turnos de A y de B: el `groupBy` por paciente no
    // puede mezclar los turnos de un profesional con los del otro.
    const shared = await addPatient(db, T);
    await db.coverage.create({ data: { patientId: shared, insurer: "OS SR-D5I", insurerId: osId } });
    await money(A, 100_000, 20_000, 1, shared);
    await money(B, 400_000, 50_000, 2, shared);
    return { T, A, B, admin, billing, assistant };
  }

  let F: Fixture;

  beforeAll(async () => {
    db = ownerClient();
    F = await fixture(false);
  });

  afterEach(() => {
    usePassthroughUnstableCache();
    asAnonymous();
  });

  afterAll(async () => {
    for (const t of tenants) await t.cleanup();
    await db?.$disconnect();
  });

  async function expectOwn(userId: string, total: number, os: number) {
    asUser(userId);
    for (const range of ["week", "month"] as const) {
      expect(await revenue(range)).toMatchObject({ range, totalCents: total, insurerCents: os });
    }
    const d = await getDashboardData();
    expect(d.revenueScope).toBe("own");
    expect(d.monthRevenue).toMatchObject({ range: "month", totalCents: total, insurerCents: os });
    expect(d.revenue).toMatchObject({ totalCents: total, insurerCents: os });
  }

  it("PRACTITIONER A ve solo lo suyo (semana, mes, KPI del mes y OS)", async () => {
    await expectOwn(F.A.userId, A_TOTAL, A_OS);
    asUser(F.A.userId);
    expect(await revenue("month")).toMatchObject({ mpCents: 100_000, manualCents: 20_000 });
  });

  it("PRACTITIONER B ve solo lo suyo", async () => {
    await expectOwn(F.B.userId, B_TOTAL, B_OS);
    asUser(F.B.userId);
    expect(await revenue("week")).toMatchObject({ mpCents: 400_000, manualCents: 50_000 });
  });

  it("el widget en Semana (preferencia guardada) también va por el scope propio", async () => {
    asUser(F.A.userId);
    expect((await updateDashboardPrefs({ revenueRange: "week" })).ok).toBe(true);
    const d = await getDashboardData();
    expect(d.revenue).toMatchObject({ range: "week", totalCents: A_TOTAL, insurerCents: A_OS });
    expect(d.monthRevenue).toMatchObject({ range: "month", totalCents: A_TOTAL });
    expect((await updateDashboardPrefs({ revenueRange: "month" })).ok).toBe(true);
  });

  it("OWNER, ADMIN y BILLING (billing.manage) ven todo el consultorio", async () => {
    for (const userId of [F.T.userId, F.admin, F.billing]) {
      asUser(userId);
      for (const range of ["week", "month"] as const) {
        expect(await revenue(range)).toMatchObject({ totalCents: A_TOTAL + B_TOTAL, insurerCents: A_OS + B_OS });
      }
      const d = await getDashboardData();
      expect(d.revenueScope).toBe("tenant");
      expect(d.monthRevenue).toMatchObject({ totalCents: A_TOTAL + B_TOTAL, insurerCents: A_OS + B_OS });
    }
  });

  it("con sharedPatientView = true, A sigue viendo solo lo suyo", async () => {
    const S = await fixture(true);
    await expectOwn(S.A.userId, A_TOTAL, A_OS);
    asUser(S.T.userId);
    expect((await revenue("month")).totalCents).toBe(A_TOTAL + B_TOTAL);
  });

  it("ASSISTANT (Secretaria): getRevenue da error, widget y KPI en null, sin consultar Payment", async () => {
    asUser(F.assistant);
    const { result: r } = await measure(() => getRevenue("week"));
    expect(r).toEqual({ ok: false, error: "No tenés acceso a los ingresos del consultorio." });
    expect(touches("Payment")).toEqual([]);

    const { result: d } = await measure(() => getDashboardData());
    expect(d.revenueScope).toBe("none");
    expect(d.revenue).toBeNull();
    expect(d.monthRevenue).toBeNull();
    expect(touches("Payment")).toEqual([]);
  });

  it("fuga por cache: A → B → OWNER → A con el cache real, cada uno ve su número y la clave lleva el scope", async () => {
    const cache = useRealUnstableCache();
    const seq: [string, number, number, string][] = [
      [F.A.userId, A_TOTAL, A_OS, `own:${F.A.practitionerId}`],
      [F.B.userId, B_TOTAL, B_OS, `own:${F.B.practitionerId}`],
      [F.T.userId, A_TOTAL + B_TOTAL, A_OS + B_OS, "tenant"],
      [F.A.userId, A_TOTAL, A_OS, `own:${F.A.practitionerId}`],
    ];
    for (const [userId, total, os, scopeKey] of seq) {
      asUser(userId);
      const seen = cache.keyParts.length;
      const d = await getDashboardData();
      expect(d.monthRevenue).toMatchObject({ totalCents: total, insurerCents: os });
      expect(d.revenue).toMatchObject({ totalCents: total, insurerCents: os });
      expect(await revenue("week")).toMatchObject({ totalCents: total, insurerCents: os });
      // SRZ (FX1): el contrato es la CLAVE, no el número. La clave del mock
      // también serializa los args (y `practitionerId` viaja como arg), así que
      // sin esto el test seguía verde aunque se borrara `revenueScopeKey(scope)`
      // de los keyParts de `cachedRevenue` (lib/dashboard.ts).
      const revenueKeys = cache.keyParts.slice(seen).filter((k) => k[0] === "dashboard:revenue");
      expect(revenueKeys.length).toBeGreaterThan(0);
      for (const k of revenueKeys) expect(k).toEqual(["dashboard:revenue", F.T.tenantId, scopeKey, expect.any(String), expect.any(String)]);
    }
    // El cache de verdad se usó: la segunda vuelta de A no consulta Payment.
    asUser(F.A.userId);
    await measure(() => getRevenue("week"));
    expect(touches("Payment")).toEqual([]);
  });
});
