/**
 * Perf baseline (A1.2, 2026-09-29) — SOLO MEDICIÓN.
 *
 * Mide, sobre un tenant de volumen efímero, cuántos statements / transacciones
 * / ms de DB cuesta cada carga de página caliente y cada write-path, llamando
 * a los loaders REALES con los mismos argumentos que la página. Registra en
 * `tests/perf/baseline.json` y en `.docs/PERF.md`. En A1 no hay presupuestos
 * (no falla por números); los presupuestos (baseline +10%) se activan en C1,
 * cuando se hagan los fixes medidos.
 *
 * Corre con `npm run test:perf` (PERF_IT=1, Docker local). Nunca contra prod.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});

import { measure, type Measurement } from "@/tests/helpers/query-counter";
import { listBookingsInRange, listPractitioners, listServices, createBooking, createBookingsBatch } from "@/lib/bookings";
import {
  listPatients,
  getPatientCore,
  getPatientName,
  getPatientProgramsLite,
  getPatientBookingsSummary,
  getPatientBillableCount,
  getPatientEvaScores,
  createProgram,
} from "@/lib/patients";
import { listInsurers } from "@/lib/insurers";
import { getTenantSettings } from "@/lib/tenant-settings";
import { getDashboardData, getMonthBookingDays } from "@/lib/dashboard";
import { getUserPreferences } from "@/lib/preferences";
import { listOpenSessions } from "@/lib/sessions";
import { listAllTags, listExercises, loadFilterFacets } from "@/lib/exercises";
import { gatingForActor } from "@/lib/plan-gating";
import { getActor } from "@/lib/session";
import { runWithRls } from "@/lib/rls";
import { localToARIso, toARDateKey, toARDow } from "@/lib/datetime-ar";
import { ownerClient } from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { createVolumeTenant, type VolumeTenant } from "./volume-fixture";

const RUN = process.env.PERF_IT === "1";

type Row = { scenario: string; runs: number } & Omit<Measurement, "slowest"> & {
  slowest: { ms: number; sql: string }[];
  explain?: { seqScans: string[]; execMs: number } | null;
};

function weekOf(anchor: Date) {
  const monday = new Date(localToARIso(`${toARDateKey(anchor)}T00:00:00`));
  monday.setTime(monday.getTime() - ((toARDow(anchor) + 6) % 7) * 86_400_000);
  return { from: monday, to: new Date(monday.getTime() + 7 * 86_400_000) };
}

describe.skipIf(!RUN)("perf baseline — cargas de página y write-paths", () => {
  let db: PrismaClient;
  let T: VolumeTenant;
  const rows: Row[] = [];

  beforeAll(async () => {
    db = ownerClient();
    const t0 = Date.now();
    T = await createVolumeTenant(db);
    console.log(`[perf] fixture de volumen creado en ${Math.round((Date.now() - t0) / 1000)} s`);
    asUser(T.userId);
  }, 600_000);

  afterAll(async () => {
    writeFileSync(
      "tests/perf/baseline.json",
      JSON.stringify({ measuredAt: new Date().toISOString(), role: process.env.PERF_ROLE ?? "app", rows }, null, 2) + "\n",
    );
    console.table(
      rows.map((r) => ({ escenario: r.scenario, statements: r.statements, tx: r.transactions, dbMs: r.dbMs, wallMs: r.wallMs, seqScans: r.explain?.seqScans.join(",") ?? "" })),
    );
    await T?.cleanup();
    await db?.$disconnect();
  }, 600_000);

  /** Warm-up + 3 corridas; se reporta la mediana de wallMs y los conteos de la última. */
  async function bench(scenario: string, fn: () => Promise<unknown>, runs = 3) {
    await fn();
    const ms: Measurement[] = [];
    for (let i = 0; i < runs; i++) ms.push((await measure(fn)).m);
    const last = ms[ms.length - 1];
    const wall = ms.map((m) => m.wallMs).sort((a, b) => a - b)[Math.floor(runs / 2)];
    const row: Row = {
      scenario,
      runs,
      statements: last.statements,
      transactions: last.transactions,
      dbMs: last.dbMs,
      wallMs: wall,
      byClient: last.byClient,
      slowest: last.slowest.map((q) => ({ ms: q.durationMs, sql: q.query.slice(0, 240) })),
      explain: await explainSlowest(last),
    };
    rows.push(row);
    expect(row.statements).toBeGreaterThan(0);
  }

  /** EXPLAIN ANALYZE (solo SELECT) de la query más lenta, como owner. */
  async function explainSlowest(m: Measurement): Promise<Row["explain"]> {
    const q = m.slowest.find((e) => /^\s*SELECT/i.test(e.query));
    if (!q) return null;
    let params: unknown[];
    try {
      // Prisma serializa las fechas como "YYYY-MM-DD hh:mm:ss.mmm UTC": se
      // devuelven como Date para que Postgres las tipe como timestamp.
      params = (JSON.parse(q.params) as unknown[]).map((p) =>
        typeof p === "string" && /^\d{4}-\d{2}-\d{2} [\d:.]+ UTC$/.test(p) ? new Date(p.replace(" UTC", "Z").replace(" ", "T")) : p,
      );
    } catch {
      return null;
    }
    try {
      const out = await db.$queryRawUnsafe<{ "QUERY PLAN": unknown }[]>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${q.query}`,
        ...params,
      );
      const plan = (out[0]["QUERY PLAN"] as { Plan: PlanNode; "Execution Time": number }[])[0];
      const seq: string[] = [];
      const walk = (n: PlanNode) => {
        if (n["Node Type"] === "Seq Scan" && (n["Actual Rows"] ?? 0) * (n["Actual Loops"] ?? 1) > 500) seq.push(n["Relation Name"] ?? "?");
        (n.Plans ?? []).forEach(walk);
      };
      walk(plan.Plan);
      return { seqScans: [...new Set(seq)], execMs: Math.round(plan["Execution Time"]) };
    } catch {
      return null;
    }
  }
  type PlanNode = { "Node Type": string; "Relation Name"?: string; "Actual Rows"?: number; "Actual Loops"?: number; Plans?: PlanNode[] };

  it("GET /agenda (semana actual, 6 loaders en paralelo)", async () => {
    const w = weekOf(new Date());
    await bench("agenda", () =>
      Promise.all([listBookingsInRange(w), listServices(), listPractitioners(), listPatients(), listInsurers({ onlyActive: true }), getTenantSettings()]),
    );
  });

  it("GET /agenda — solo listBookingsInRange (semana)", async () => {
    await bench("agenda.bookings", () => listBookingsInRange(weekOf(new Date())));
  });

  it("GET /agenda — solo listPatients() (directorio para el dropdown)", async () => {
    await bench("agenda.listPatients", () => listPatients());
  });

  it("GET /dashboard", async () => {
    const [y, m] = toARDateKey(new Date()).split("-").map(Number);
    await bench("dashboard", () => Promise.all([getDashboardData(), getUserPreferences(), getMonthBookingDays(y, m - 1)]));
  });

  it("GET /pacientes/[id] (paciente con plan de 20 sesiones)", async () => {
    const id = T.patientIds[0];
    await bench("paciente", async () => {
      await getPatientName(id);
      const actor = await getActor();
      await getPatientCore(id);
      await Promise.all([
        getPatientProgramsLite(id),
        getPatientBookingsSummary(id, 5),
        getPatientBillableCount(id),
        getPatientEvaScores(id),
        listInsurers({ onlyActive: true }),
        runWithRls(actor.tenantId, (tx) =>
          tx.practitioner.findMany({ where: { tenantId: actor.tenantId }, include: { user: { select: { fullName: true, email: true } } } }),
        ),
      ]);
    });
  });

  it("GET /seguimiento", async () => {
    await bench("seguimiento", () => listOpenSessions());
  });

  it("GET /biblioteca", async () => {
    await bench("biblioteca", () => Promise.all([listExercises({}), loadFilterFacets(), listAllTags(), gatingForActor(), getActor()]));
  });

  it("POST createBooking (turno simple)", async () => {
    let i = 0;
    await bench("createBooking", () =>
      createBooking({
        patientId: T.patientIds[900 + i],
        serviceId: T.serviceId,
        practitionerId: T.practitionerId,
        scheduledFor: new Date(localToARIso(`2028-01-0${3 + i++}T10:00:00`)).toISOString(),
        idempotencyKey: randomUUID(),
      }),
    );
  });

  it("POST createBookingsBatch (20 turnos)", async () => {
    let i = 0;
    await bench("createBookingsBatch.20", () =>
      createBookingsBatch({
        patientId: T.patientIds[950 + i++],
        serviceId: T.serviceId,
        practitionerId: T.practitionerId,
        scheduledFor: new Date(localToARIso("2028-02-07T09:00:00")).toISOString(),
        count: 20,
        daysOfWeek: [0, 2, 4],
        idempotencyKey: randomUUID(),
      }),
    );
  });

  it("POST createProgram (16 sesiones, Tab Plan)", async () => {
    let i = 0;
    await bench("createProgram.16", () =>
      createProgram({ patientId: T.patientIds[500 + i++], title: "Plan perf", totalSessions: 16, frequency: 2, startDate: new Date("2028-03-01T03:00:00.000Z") }),
    );
  });
});
