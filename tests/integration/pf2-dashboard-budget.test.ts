/**
 * PF2-a · presupuesto de transacciones de `/dashboard` (C-PF8, brief-pf §2.4).
 *
 * Contrato: `/dashboard` ≤ 2 tx en frío (cache de los counts vacío) y ≤ 1 en caliente. La 1.ª tx es la de la
 * página (visibilidad, acceso por fila A2b, recordatorio, turnero propio, ingresos, días del calendario); la 2.ª,
 * la de los counts adentro de `unstable_cache`. Antes de PF2 (PF-0b): 15-16 en frío y 4 en caliente, porque cada
 * lectura abría su `runWithRls` (8 en paralelo para los counts, 1 por resumen de ingresos, 1 por los días del
 * calendario, más visibilidad, acceso, recordatorio y turnero).
 *
 * Se mide con el contador de `tests/helpers/query-counter.ts` sobre el loader REAL que llama la página
 * (`getDashboardPageData`, mismos argumentos: ninguno), con el cache en pass-through (frío: todo se recalcula)
 * y con el Map real de `unstable_cache` (caliente: segunda carga del mismo actor). Va con los dos roles (RLS
 * aplicado y owner BYPASSRLS) y con tres actores (titular con ingresos del consultorio, profesional con
 * ingresos propios y la Secretaria sin ingresos), porque cada uno toma un camino distinto.
 *
 * También fija dos cambios de resultado de PF2-a (handoff de PF1.1-dashboard, brief-pf §3.2):
 *   - `adherencePct` es `null` sin turnos con resultado en la semana (antes 100: «100 % de adherencia» en un
 *     consultorio nuevo, D4 de VX0-b);
 *   - `cond` es el diagnóstico (la condición de rango 1 del caso) o vacío, nunca el título del plan (D6).
 */
import { vi, describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { getDashboardPageData } from "@/lib/dashboard";
import { updateDashboardPrefs } from "@/lib/preferences";
import { measure } from "@/tests/helpers/query-counter";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { addPlanSession } from "@/tests/helpers/plan-factory";
import { asUser, asAnonymous } from "@/tests/helpers/actor";
import { useRealUnstableCache, usePassthroughUnstableCache } from "@/tests/helpers/integration-setup";

const RUN = process.env.INTEGRATION === "1";
const DAY = 86_400_000;

describe.skipIf(!RUN)("PF2-a · /dashboard ≤ 2 tx en frío, ≤ 1 en caliente", () => {
  let db: PrismaClient;
  let K: EphemeralTenant;
  let E: EphemeralTenant;
  let kine: { userId: string; practitionerId: string };
  let assistant: string;
  let diagnosed: string;
  let undiagnosed: string;

  /** Plan vivo con una sesión cerrada ayer (alimenta «Pacientes recientes»); `conditionName` arma caso + diagnóstico. */
  async function planWithClosedSession(patientId: string, title: string, conditionName?: string) {
    let caseId: string | undefined;
    if (conditionName) {
      const cond = await db.condition.create({
        data: { slug: `pf2a-${randomUUID()}`, name: conditionName, tenantId: K.tenantId },
      });
      const c = await db.clinicalCase.create({
        data: {
          tenantId: K.tenantId,
          authorId: K.practitionerId,
          patientId,
          selectedZones: [],
          refinements: {},
          diagnoses: { create: [{ conditionId: cond.id, matchScore: 0.9, rank: 1 }] },
        },
      });
      caseId = c.id;
    }
    const p = await db.treatmentProgram.create({
      data: {
        tenantId: K.tenantId,
        patientId,
        caseId,
        title,
        totalSessions: 2,
        startDate: new Date(Date.now() - 10 * DAY),
        status: "ACTIVE",
      },
    });
    const s = await addPlanSession(db, p.id, {
      index: 1,
      practitionerId: K.practitionerId,
      scheduledFor: new Date(Date.now() - DAY),
    });
    await db.session.update({ where: { id: s }, data: { completedAt: new Date(Date.now() - DAY) } });
  }

  beforeAll(async () => {
    db = ownerClient();
    K = await createEphemeralTenant(db, { vertical: "KINESIOLOGY" });
    // Consultorio sin un solo turno: la adherencia no tiene denominador.
    E = await createEphemeralTenant(db, { vertical: "KINESIOLOGY" });
    kine = await addPractitioner(db, K, "PRACTITIONER");
    assistant = (await addPractitioner(db, K, "ASSISTANT")).userId;

    diagnosed = await addPatient(db, K, { firstName: "Con", lastName: "Diagnóstico", assignedPractitionerId: kine.practitionerId });
    undiagnosed = await addPatient(db, K, { firstName: "Sin", lastName: "Diagnóstico" });
    await planWithClosedSession(diagnosed, "Plan PF2-a título A", "Lumbalgia PF2-a");
    await planWithClosedSession(undiagnosed, "Plan PF2-a título B");

    // Turnos: uno futuro por paciente (próximos + «nextBooking» de recientes) y uno cobrado (ingresos).
    for (const [i, patientId] of [diagnosed, undiagnosed].entries()) {
      await db.booking.create({
        data: {
          tenantId: K.tenantId,
          patientId,
          practitionerId: i === 0 ? kine.practitionerId : K.practitionerId,
          serviceId: K.serviceId,
          scheduledFor: new Date(Date.now() + (i + 2) * DAY),
          durationMin: 45,
          status: "CONFIRMED",
          idempotencyKey: randomUUID(),
        },
      });
    }
    await db.booking.create({
      data: {
        tenantId: K.tenantId,
        patientId: diagnosed,
        practitionerId: kine.practitionerId,
        serviceId: K.serviceId,
        scheduledFor: new Date(Date.now() - 2 * 3_600_000),
        durationMin: 45,
        status: "COMPLETED",
        paymentStatus: "PAID",
        copagoCents: 150_000,
        copagoPaidAt: new Date(),
        idempotencyKey: randomUUID(),
      },
    });
  });

  afterEach(() => {
    usePassthroughUnstableCache();
    asAnonymous();
  });

  afterAll(async () => {
    await K?.cleanup();
    await E?.cleanup();
    await db?.$disconnect();
  });

  const actors = () =>
    [
      ["titular (ingresos del consultorio)", K.userId],
      ["profesional (ingresos propios)", kine.userId],
      ["Secretaria (sin ingresos)", assistant],
    ] as const;

  it("frío (cache de counts vacío): ≤ 2 tx por carga, para cada rol", async () => {
    for (const [label, userId] of actors()) {
      asUser(userId);
      const { m } = await measure(() => getDashboardPageData());
      expect(m.transactions, `${label}: ${m.transactions} tx / ${m.statements} sentencias`).toBeLessThanOrEqual(2);
    }
  });

  it("caliente (segunda carga, counts en cache): ≤ 1 tx por carga, para cada rol", async () => {
    useRealUnstableCache();
    for (const [label, userId] of actors()) {
      asUser(userId);
      await getDashboardPageData();
      const { m } = await measure(() => getDashboardPageData());
      expect(m.transactions, `${label}: ${m.transactions} tx / ${m.statements} sentencias`).toBeLessThanOrEqual(1);
    }
  });

  it("con el widget en Semana (preferencia guardada) el presupuesto no cambia", async () => {
    asUser(K.userId);
    expect((await updateDashboardPrefs({ revenueRange: "week" })).ok).toBe(true);
    try {
      const { result, m } = await measure(() => getDashboardPageData());
      expect(m.transactions).toBeLessThanOrEqual(2);
      expect(result.data.revenue?.range).toBe("week");
      expect(result.data.monthRevenue?.range).toBe("month");
      expect(result.preferences.dashboard.revenueRange).toBe("week");
    } finally {
      expect((await updateDashboardPrefs({ revenueRange: "month" })).ok).toBe(true);
    }
  });

  it("el resultado no cambia entre frío y caliente (fechas rehidratadas incluidas)", async () => {
    asUser(K.userId);
    const cold = await getDashboardPageData();
    useRealUnstableCache();
    await getDashboardPageData();
    const warm = await getDashboardPageData();
    expect(warm).toEqual(cold);
    const row = warm.data.recent.find((r) => r.id === diagnosed);
    expect(row?.nextBookingAt).toBeInstanceOf(Date);
    expect(row?.nextBookingUpdatedAt).toBeInstanceOf(Date);
    // El turno cobrado hoy cuenta en el mes del consultorio y marca el día en el calendario.
    expect(warm.data.monthRevenue?.totalCents).toBe(150_000);
    expect(warm.bookingDays.length).toBeGreaterThan(0);
  });

  it("scope sin query previa: el profesional ve todo solo con la vista compartida (leída adentro de los counts)", async () => {
    asUser(kine.userId);
    const own = (await getDashboardPageData()).data;
    // Sin vista compartida: solo su turno futuro (el otro es del titular).
    expect(own.next).toHaveLength(1);
    await db.tenant.update({ where: { id: K.tenantId }, data: { sharedPatientView: true } });
    try {
      useRealUnstableCache();
      const { result, m } = await measure(() => getDashboardPageData());
      expect(m.transactions).toBeLessThanOrEqual(2);
      expect(result.data.next).toHaveLength(2);
      asUser(K.userId);
      expect((await getDashboardPageData()).data.next).toHaveLength(2);
    } finally {
      await db.tenant.update({ where: { id: K.tenantId }, data: { sharedPatientView: false } });
    }
  });

  it("[PF2-a] cond = diagnóstico o vacío, nunca el título del plan (D6)", async () => {
    asUser(K.userId);
    const { data } = await getDashboardPageData();
    expect(data.recent.find((r) => r.id === diagnosed)).toMatchObject({ access: "full", cond: "Lumbalgia PF2-a" });
    expect(data.recent.find((r) => r.id === undiagnosed)).toMatchObject({ access: "full", cond: "" });
    expect(JSON.stringify(data.recent)).not.toContain("Plan PF2-a título");
  });

  it("[PF2-a] «Pacientes recientes» trae un paciente una sola vez (su sesión cerrada más reciente)", async () => {
    // Un plan con 3 sesiones cerradas, las 3 más recientes del consultorio: antes ocupaban 3 de las 4 filas.
    const repeated = await addPatient(db, K, { firstName: "Eugenio", lastName: "Repetido" });
    const p = await db.treatmentProgram.create({
      data: {
        tenantId: K.tenantId,
        patientId: repeated,
        title: "Plan repetido",
        totalSessions: 3,
        startDate: new Date(Date.now() - 5 * DAY),
        status: "ACTIVE",
      },
    });
    for (const index of [1, 2, 3]) {
      const s = await addPlanSession(db, p.id, {
        index,
        practitionerId: K.practitionerId,
        scheduledFor: new Date(Date.now() - (4 - index) * 3_600_000),
      });
      await db.session.update({ where: { id: s }, data: { completedAt: new Date(Date.now() - (4 - index) * 60_000) } });
    }
    asUser(K.userId);
    const { data } = await getDashboardPageData();
    const ids = data.recent.map((r) => r.id);
    expect(ids.filter((id) => id === repeated)).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);
    // Los otros dos pacientes con sesión cerrada siguen apareciendo (antes los tapaba el repetido).
    expect(ids).toEqual(expect.arrayContaining([repeated, diagnosed, undiagnosed]));
    // La fila del repetido es la de su ÚLTIMA sesión: ordinal 3 de 3.
    expect(data.recent.find((r) => r.id === repeated)).toMatchObject({ sessionsDone: 3, sessionsTotal: 3 });
    expect(ids[0]).toBe(repeated);
  });

  it("[PF2-a] adherencePct = null sin turnos con resultado en la semana (no 100)", async () => {
    asUser(E.userId);
    const { data } = await getDashboardPageData();
    expect(data.weeklyBars.every((b) => b.c === 0 && b.a === 0)).toBe(true);
    expect(data.pinned.adherencePct).toBeNull();
  });

  it("adherencePct sigue siendo el % entero con turnos en la semana", async () => {
    asUser(K.userId);
    const { data } = await getDashboardPageData();
    const done = data.weeklyBars.reduce((s, b) => s + b.c, 0);
    const slots = data.weeklyBars.reduce((s, b) => s + b.c + b.a, 0);
    // El COMPLETED de hoy está en la semana (salvo que «hace 2 h» caiga en la semana anterior: lunes 00-02 AR).
    if (slots > 0) expect(data.pinned.adherencePct).toBe(Math.round((done / slots) * 100));
    else expect(data.pinned.adherencePct).toBeNull();
  });
});
