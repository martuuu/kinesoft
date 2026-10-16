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
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});

import { measure, type Measurement } from "@/tests/helpers/query-counter";
import {
  listBookingsInRange,
  listPractitioners,
  listServices,
  createBooking,
  createBookingsBatch,
  updateBooking,
} from "@/lib/bookings";
import { loadAgendaPage } from "@/lib/agenda-page-loader";
import { weekStartKey } from "@/lib/agenda-client-state";
import { loadPatientProfilePage } from "@/lib/patient-profile-loader";
import { listPatients } from "@/lib/patients";
import { createPlan, previewPlan } from "@/lib/plans";
import type { PlanCreateInput, PlanRowResolution } from "@/lib/plans-types";
import { addDays } from "@/lib/availability/day";
import { listInsurers } from "@/lib/insurers";
import { getTenantSettings } from "@/lib/tenant-settings";
import { getDashboardPageData } from "@/lib/dashboard";
import { listOpenSessions } from "@/lib/sessions";
import { listAllTags, listExercises, loadFilterFacets } from "@/lib/exercises";
import { gatingForActor } from "@/lib/plan-gating";
import { getActor } from "@/lib/session";
import { localToARIso, toARDateKey, toARDow } from "@/lib/datetime-ar";
import { ownerClient } from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { BOOKING_CLINICAL_NOTE_PATIENT_ERROR } from "@/lib/bookings-constants";
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
  // PF-M: claves extra de la corrida (no son filas: compare.ts no las lee como escenarios).
  //  - agendaPayloadBytes: JSON de los DTO de la semana que /agenda le pasa al cliente (referencia de PF2, que la
  //    vuelve regla estricta; acá solo se mide con el fixture de volumen de A1).
  //  - fkExplain: EXPLAIN de lecturas por FK que M10 indexó (antes Seq Scan del hijo).
  let agendaPayloadBytes: number | null = null;
  const fkExplain: { check: string; seqScans: string[]; indexes: string[]; execMs: number }[] = [];

  beforeAll(async () => {
    db = ownerClient();
    const t0 = Date.now();
    T = await createVolumeTenant(db);
    console.log(`[perf] fixture de volumen creado en ${Math.round((Date.now() - t0) / 1000)} s`);
    asUser(T.userId);
  }, 600_000);

  afterAll(async () => {
    // P0-Cs: `PERF_OUT_DIR` deja escribir la medición fuera del árbol (scratchpad)
    // para compararla con `tests/perf/compare.ts` sin pisar el baseline versionado.
    writeFileSync(
      join(process.env.PERF_OUT_DIR ?? "tests/perf", "baseline.json"),
      JSON.stringify(
        { measuredAt: new Date().toISOString(), role: process.env.PERF_ROLE ?? "app", agendaPayloadBytes, fkExplain, rows },
        null,
        2,
      ) + "\n",
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

  /**
   * EXPLAIN ANALYZE (solo SELECT) de la query más lenta, como owner.
   *
   * PF-M (AUDIT `perf-harness-explain-params-tipados`): los parámetros se INLINEAN como literales sin tipo, igual que
   * `agenda-multi.perf.test.ts`. Antes se pasaban como `$n` y un `Date` viajaba como `timestamptz`: Postgres casteaba
   * la COLUMNA `timestamp(3)`, el índice `(tenantId, scheduledFor)` dejaba de servir y el EXPLAIN mostraba un Seq Scan
   * de Booking que la query real de Prisma no hace (falso positivo de A1, .docs/PERF.md §B4.6). Un literal
   * 'YYYY-MM-DD hh:mm:ss' toma el tipo de la columna; Prisma serializa los DateTime como "… UTC" y la columna guarda
   * UTC sin zona.
   */
  async function explainSlowest(m: Measurement): Promise<Row["explain"]> {
    const q = m.slowest.find((e) => /^\s*SELECT/i.test(e.query));
    if (!q) return null;
    let sql: string;
    try {
      sql = inlineParams(q.query, JSON.parse(q.params) as unknown[]);
    } catch {
      return null;
    }
    try {
      const plan = await explainJson(sql);
      return { seqScans: seqScansOf(plan.Plan), execMs: Math.round(plan["Execution Time"]) };
    } catch {
      return null;
    }
  }
  type PlanNode = {
    "Node Type": string;
    "Relation Name"?: string;
    "Index Name"?: string;
    "Actual Rows"?: number;
    "Actual Loops"?: number;
    Plans?: PlanNode[];
  };

  function inlineParams(query: string, params: unknown[]): string {
    const lit = (p: unknown): string => {
      if (p === null || p === undefined) return "NULL";
      if (typeof p === "number" || typeof p === "boolean") return String(p);
      const str = typeof p === "string" ? p.replace(/^(\d{4}-\d{2}-\d{2} [\d:.]+) UTC$/, "$1") : JSON.stringify(p);
      return `'${str.replace(/'/g, "''")}'`;
    };
    return query.replace(/\$(\d+)\b/g, (_, n: string) => lit(params[Number(n) - 1]));
  }

  async function explainJson(sql: string): Promise<{ Plan: PlanNode; "Execution Time": number }> {
    const out = await db.$queryRawUnsafe<{ "QUERY PLAN": unknown }[]>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`);
    return (out[0]["QUERY PLAN"] as { Plan: PlanNode; "Execution Time": number }[])[0];
  }

  /** Seq Scans de más de 500 filas (los chicos son elección legítima del planner). */
  function seqScansOf(root: PlanNode): string[] {
    const seq: string[] = [];
    const walk = (n: PlanNode) => {
      if (n["Node Type"] === "Seq Scan" && (n["Actual Rows"] ?? 0) * (n["Actual Loops"] ?? 1) > 500) seq.push(n["Relation Name"] ?? "?");
      (n.Plans ?? []).forEach(walk);
    };
    walk(root);
    return [...new Set(seq)];
  }

  function indexesOf(root: PlanNode): string[] {
    const idx: string[] = [];
    const walk = (n: PlanNode) => {
      if (n["Index Name"]) idx.push(n["Index Name"]);
      (n.Plans ?? []).forEach(walk);
    };
    walk(root);
    return [...new Set(idx)];
  }

  it("GET /agenda (semana actual, 6 loaders en paralelo)", async () => {
    const w = weekOf(new Date());
    await bench("agenda", () =>
      Promise.all([listBookingsInRange(w), listServices(), listPractitioners(), listPatients(), listInsurers({ onlyActive: true }), getTenantSettings()]),
    );
  });

  it("GET /agenda (loadAgendaPage: lo que corre la página, PF2-c)", async () => {
    const actor = await getActor();
    const monday = weekStartKey(toARDateKey(new Date()));
    await bench("agenda.page", () => loadAgendaPage(actor, { monday, patientId: null }));
  });

  it("GET /agenda — payload de la semana (agendaPayloadBytes, regla estricta de PF2)", async () => {
    // Lo que /agenda serializa al cliente por turno: el cable compacto de `loadAgendaPage` (lib/agenda-wire.ts), con
    // los mismos argumentos que la página. compare.ts lo corta en 400 kB (C-PF8, `perf-agenda-payload-1mb`).
    const { bookings } = await loadAgendaPage(await getActor(), {
      monday: weekStartKey(toARDateKey(new Date())),
      patientId: null,
    });
    agendaPayloadBytes = JSON.stringify(bookings).length;
    expect(bookings.length).toBeGreaterThan(0);
  });

  it("GET /agenda — solo listBookingsInRange (semana)", async () => {
    await bench("agenda.bookings", () => listBookingsInRange(weekOf(new Date())));
  });

  it("GET /agenda — solo listPatients() (directorio para el dropdown)", async () => {
    await bench("agenda.listPatients", () => listPatients());
  });

  it("GET /dashboard", async () => {
    await bench("dashboard", () => getDashboardPageData());
  });

  it("GET /pacientes/[id] (paciente con plan de 20 sesiones)", async () => {
    const id = T.patientIds[0];
    // PF2-b: la misma carga que la página (`loadPatientProfilePage`: actor resuelto antes + una tx).
    await bench("paciente", async () => {
      const actor = await getActor();
      await loadPatientProfilePage(actor, id, null);
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

  it("POST createPlan (16 sesiones, motor: preview afuera, se mide el commit)", async () => {
    // P3-S27a: reemplaza al escenario del alta vieja (16 sesiones sin turno).
    // `createPlan` crea sesiones Y turnos en una tx con locks y verificador:
    // los números no son comparables con el escenario viejo.
    // El preview (que da el `stateToken`) se arma ANTES y fuera de la medición;
    // cada corrida usa otro paciente y otro bloque de 10 semanas (2/semana = 8
    // semanas por plan), así un commit no vuelve stale el preview del siguiente.
    const inputs: PlanCreateInput[] = [];
    for (let k = 0; k < 4; k++) {
      const draft: PlanCreateInput = {
        idempotencyKey: randomUUID(),
        patientId: T.patientIds[500 + k],
        discipline: "KINESIOLOGY",
        practitionerId: T.practitionerId,
        serviceId: T.serviceId,
        locationId: null,
        title: "Plan perf",
        schedule: { v: 1, frequency: "weekly", slots: [{ dow: 1, startMin: 600 }, { dow: 4, startMin: 600 }] },
        startDayKey: addDays("2028-03-06", k * 70), // lunes
        totalSessions: 16,
        pricing: null,
        rows: [],
        stateToken: "x",
      };
      const pv = await previewPlan(draft);
      if (!pv.ok) throw new Error(`preview falló: ${pv.error}`);
      const rows = pv.preview.rows.map((r) =>
        r.defaultResolution === "move" ? { index: r.index, kind: "move", at: r.suggestion } : { index: r.index, kind: r.defaultResolution },
      ) as PlanRowResolution[];
      inputs.push({ ...draft, stateToken: pv.preview.stateToken, rows });
    }
    let i = 0;
    await bench("createPlan.16", async () => {
      const r = await createPlan(inputs[i++]);
      if (!r.ok) throw new Error(`createPlan falló: ${"kind" in r ? r.kind : r.error}`);
    });
  });

  // ── updateBooking re-vinculando paciente (PF-M, AUDIT `ev2-perf-update-booking`) ─────────────────────────
  // El chequeo de evolución de EV2 (lib/bookings-core.ts, C-EV2-7) corre SOLO cuando el turno cambia de un paciente a
  // otro: +1 sentencia (findFirst de ClinicalNote por bookingId). Dos caras: sin evolución (pasa el chequeo y re-vincula)
  // y con evolución (corta antes de escribir). Son write-paths de turnos: entran a la regla estricta de compare.ts con
  // esta primera medición como referencia (tests/perf/pf.json). `plans.perf` mide lo mismo sobre otro fixture
  // (`f.updateBooking.patientChange`, techo de S26s).

  /** Turno suelto nuevo (insert del owner, fuera de la medición) en una hora libre lejos de la grilla del fixture. */
  async function looseBooking(k: number, patientId: string) {
    return db.booking.create({
      data: {
        tenantId: T.tenantId,
        patientId,
        practitionerId: T.practitionerId,
        serviceId: T.serviceId,
        scheduledFor: new Date(localToARIso(`2029-03-${String(5 + k).padStart(2, "0")}T08:00:00`)),
        durationMin: 45,
        idempotencyKey: randomUUID(),
        status: "CONFIRMED",
      },
      select: { id: true, updatedAt: true },
    });
  }

  it("POST updateBooking — cambiar el paciente de un turno sin evolución", async () => {
    // Warm-up + 3 corridas = 4 turnos distintos (cada corrida re-vincula uno nuevo).
    const bs = await Promise.all([0, 1, 2, 3].map((k) => looseBooking(k, T.patientIds[700 + k])));
    let i = 0;
    const results: { ok: boolean }[] = [];
    await bench("updateBooking.patientChange", async () => {
      const k = i++;
      const r = await updateBooking({ id: bs[k].id, patientId: T.patientIds[720 + k], expectedUpdatedAt: bs[k].updatedAt.toISOString() });
      results.push(r);
    });
    expect(results.every((r) => r.ok)).toBe(true);
    const moved = await db.booking.findMany({ where: { id: { in: bs.map((b) => b.id) } }, select: { patientId: true } });
    expect(new Set(moved.map((b) => b.patientId))).toEqual(new Set([0, 1, 2, 3].map((k) => T.patientIds[720 + k])));
  });

  it("POST updateBooking — cambiar el paciente de un turno CON evolución (se rechaza sin escribir)", async () => {
    const b = await looseBooking(10, T.patientIds[740]);
    // Evolución colgada del turno (insert del owner: no es el código bajo test el que siembra). La limpieza del
    // fixture la borra en modo réplica (tests/helpers/tenant-factory.ts): el trigger de M9 rechaza el DELETE.
    await db.clinicalNote.create({
      data: {
        tenantId: T.tenantId,
        patientId: T.patientIds[740],
        bookingId: b.id,
        body: "Evolución de perf",
        occurredAt: new Date(),
        authorUserId: T.userId,
        authorPractitionerId: T.practitionerId,
        authorName: "Profesional perf",
        idempotencyKey: `perf-${randomUUID()}`,
      },
    });
    const results: { ok: boolean; error?: string }[] = [];
    await bench("updateBooking.patientChange.withNote", async () => {
      results.push(await updateBooking({ id: b.id, patientId: T.patientIds[741], expectedUpdatedAt: b.updatedAt.toISOString() }));
    });
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(results[0].error).toBe(BOOKING_CLINICAL_NOTE_PATIENT_ERROR);
    const after = await db.booking.findUniqueOrThrow({ where: { id: b.id }, select: { patientId: true, updatedAt: true } });
    expect(after).toEqual({ patientId: T.patientIds[740], updatedAt: b.updatedAt });
  });

  // ── EXPLAIN de lecturas por FK de M10 (PF-M) ───────────────────────────────────────────────────────────────
  it("EXPLAIN — lecturas por FK que indexó M10 no hacen Seq Scan del hijo", async () => {
    // Coverage.patientId: el «OS percibido» de cada turno lee las coberturas del paciente (Seq Scan confirmado en A1).
    // Booking.serviceId: el panel de Servicios cuenta «N turnos» por servicio; informativo (el servicio cubre 1/3 de los
    // turnos del fixture y el planner puede elegir un Seq Scan legítimo). Literales sin tipo (ver inlineParams).
    const checks: { check: string; sql: string }[] = [
      {
        check: "Coverage.patientId",
        sql: `SELECT * FROM "Coverage" WHERE "patientId" = ${inlineParams("$1", [T.patientIds[2]])}`,
      },
      {
        check: "Booking.serviceId (count)",
        sql: `SELECT count(*) FROM "Booking" WHERE "serviceId" = ${inlineParams("$1", [T.secondServiceId])}`,
      },
    ];
    for (const c of checks) {
      const plan = await explainJson(c.sql);
      fkExplain.push({ check: c.check, seqScans: seqScansOf(plan.Plan), indexes: indexesOf(plan.Plan), execMs: Math.round(plan["Execution Time"]) });
    }
    console.table(fkExplain);
    expect(fkExplain[0].indexes).toContain("Coverage_patientId_idx");
    expect(fkExplain[0].seqScans).toEqual([]);
  });
});
