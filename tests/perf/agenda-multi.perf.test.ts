/**
 * B4.6 PERF — agenda multi-profesional con volumen de Secretaria. SOLO MEDICIÓN.
 *
 * Por qué: la agenda de B-pre pasa de 1-2 profesionales a N columnas con
 * franjas, cupo por profesional × servicio, bloqueos y sedes, y el riesgo
 * anotado en bpre-design (hecho 6) era `listBookingsInRange`: incluye por
 * fila paciente → coberturas → programas → caso → diagnósticos. B4.1 entregó
 * la proyección liviana `listAgendaBookings`; acá se mide contra la vieja,
 * junto con el motor de disponibilidad (`getAgendaAvailability`,
 * `listAvailableSlots` "any", `previewRecurrence`), el layout puro de la vista
 * "Día por profesional" (CPU, para decidir si hace falta virtualizar) y los
 * write-paths con el lock de cupo + clasificación del motor (B3.1) contra el
 * baseline de A1 (`tests/perf/baseline.json`, que NO se regraba).
 *
 * Fixture: `createAgendaMultiTenant` (tests/perf/volume-fixture.ts), efímero.
 * Mismo harness que loaders.perf (query-counter: statements, BEGIN, ms de DB,
 * wall-clock; warm-up + mediana de 3). El EXPLAIN de la query más lenta corre
 * con el cliente de la APP (rol `kinesoft_app`) dentro de una tx con
 * `app.current_tenant_id`, o sea con las policies RLS aplicadas: el plan que
 * importa (el owner con BYPASSRLS elige otro).
 *
 * No falla por números (como A1): los presupuestos se activan en C1.
 * Escribe `<PERF_OUT_DIR>/agenda-multi.json` (default `tests/perf/`, el
 * versionado). P0-Ct: para medir sin ensuciar el árbol,
 *   PERF_OUT_DIR=<scratchpad> npm run test:perf -- tests/perf/agenda-multi.perf.test.ts
 *   npx tsx tests/perf/compare.ts <scratchpad>
 * La comparación `vsA1` sigue leyendo el baseline VERSIONADO
 * (`tests/perf/baseline.json`), nunca el recién medido del PERF_OUT_DIR.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});

import { measure, type Measurement } from "@/tests/helpers/query-counter";
import { prisma } from "@/lib/db";
import {
  listBookingsInRange,
  listAgendaBookings,
  listPractitioners,
  listServices,
  createBooking,
  createBookingsBatch,
} from "@/lib/bookings";
import { listPatients } from "@/lib/patients";
import { listInsurers } from "@/lib/insurers";
import { getTenantSettings } from "@/lib/tenant-settings";
import { listLocations } from "@/lib/locations";
import { getUserPreferences } from "@/lib/preferences";
import { getCapabilities } from "@/lib/authz";
import { getActor } from "@/lib/session";
import {
  getAgendaAvailability,
  listAvailableSlots,
  previewRecurrence,
} from "@/lib/availability-actions";
import {
  capOfFromAvailability,
  layoutBlocks,
  rangesForDay,
  type AgendaAvailability,
} from "@/lib/availability-actions-types";
import { buildPractitionerColumns, weekOccupancy, type AgendaZoom } from "@/lib/agenda-layout";
import { addDays } from "@/lib/availability/day";
import { toBookingDTO } from "@/components/agenda/agenda-utils";
import { localToARIso } from "@/lib/datetime-ar";
import { ownerClient } from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { appRoleBypassesRls } from "@/tests/helpers/db-role";
import { createAgendaMultiTenant, type AgendaMultiTenant } from "./volume-fixture";

const RUN = process.env.PERF_IT === "1";
const OUT_DIR = process.env.PERF_OUT_DIR ?? "tests/perf";
const OUT = join(OUT_DIR, "agenda-multi.json");
/** Presupuesto de un render a 60 fps: si el layout puro solo ya se lo come, hay que virtualizar. */
const FRAME_BUDGET_MS = 16;

type Explain = {
  seqScans: string[];
  execMs: number;
  asAppRole: boolean;
  plan?: string[];
  /** Mismo SQL con `enable_seqscan = off`: lo que costaría por índice (¿el Seq Scan es un problema o lo más barato?). */
  withoutSeqScan?: { execMs: number; topNodes: string[] } | null;
} | null;
type Row = { scenario: string; runs: number; note?: string } & Omit<Measurement, "slowest"> & {
  slowest: { ms: number; sql: string }[];
  explain?: Explain;
  /** Resultado de la última corrida (ok / prompt / filas), para no medir un camino de error sin saberlo. */
  outcome?: string;
  /** Statements de la última corrida por tabla (primer FROM/INTO/UPDATE): de dónde sale el conteo. */
  byTable?: Record<string, number>;
  /** Escenario comparable del baseline de A1 (`tests/perf/baseline.json`). */
  vsA1?: { scenario: string; statements: number; transactions: number; dbMs: number; wallMs: number };
};
type CpuRow = {
  scenario: string;
  bookings: number;
  columns: number;
  rows: number;
  cells: number;
  iterations: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
  overFrameBudget: boolean;
};
type PlanNode = {
  "Node Type": string;
  "Relation Name"?: string;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  Plans?: PlanNode[];
};

describe.skipIf(!RUN)("perf B4.6 — agenda multi-profesional (6 profesionales, volumen de Secretaria)", () => {
  let db: PrismaClient;
  let T: AgendaMultiTenant;
  let bypass = true;
  let fixtureMs = 0;
  const rows: Row[] = [];
  const cpu: CpuRow[] = [];
  let payload: Record<string, number> | null = null;
  const a1 = new Map<string, Row>();

  // Semana medida y días de referencia (todo en días AR, sin reloj del host).
  let monday = "";
  let weekFrom: Date;
  let weekTo: Date;
  /** Martes de la semana que viene: futuro seguro (el motor recorta el pasado). */
  let nextTue = "";

  beforeAll(async () => {
    db = ownerClient();
    try {
      const base = JSON.parse(readFileSync("tests/perf/baseline.json", "utf8")) as { rows: Row[] };
      for (const r of base.rows) a1.set(r.scenario, r);
    } catch {
      /* sin baseline: la comparación queda vacía */
    }
    const t0 = Date.now();
    T = await createAgendaMultiTenant(db);
    fixtureMs = Date.now() - t0;
    console.log(
      `[perf B4.6] fixture: ${T.totalBookingCount} turnos (${T.weekBookingCount} en la semana ${T.weekMondayKey}) en ${Math.round(fixtureMs / 1000)} s`,
    );
    asUser(T.userId);
    bypass = await appRoleBypassesRls();
    monday = T.weekMondayKey;
    weekFrom = new Date(localToARIso(`${monday}T00:00:00`));
    weekTo = new Date(localToARIso(`${addDays(monday, 7)}T00:00:00`));
    nextTue = addDays(monday, 8);
  }, 600_000);

  afterAll(async () => {
    mkdirSync(OUT_DIR, { recursive: true });
    const worst = [...rows].filter((r) => r.explain).sort((a, b) => (b.explain!.execMs ?? 0) - (a.explain!.execMs ?? 0))[0];
    writeFileSync(
      OUT,
      JSON.stringify(
        {
          measuredAt: new Date().toISOString(),
          role: bypass ? "owner (BYPASSRLS)" : "kinesoft_app (RLS)",
          fixture: T
            ? {
                practitioners: T.practitionerIds.length,
                gym: T.gymPractitionerIds.length,
                osteo: T.osteoPractitionerIds.length,
                locations: 2,
                patients: T.patientIds.length,
                bookingsTotal: T.totalBookingCount,
                bookingsWeek: T.weekBookingCount,
                weekMonday: T.weekMondayKey,
                buildSeconds: Math.round(fixtureMs / 1000),
              }
            : null,
          frameBudgetMs: FRAME_BUDGET_MS,
          rows,
          cpu,
          payload,
          slowestQuery: worst ? { scenario: worst.scenario, sql: worst.slowest[0]?.sql, explain: worst.explain } : null,
        },
        null,
        2,
      ) + "\n",
    );
    console.table(
      rows.map((r) => ({
        escenario: r.scenario,
        st: r.statements,
        tx: r.transactions,
        dbMs: r.dbMs,
        wallMs: r.wallMs,
        A1: r.vsA1 ? `${r.vsA1.statements}/${r.vsA1.transactions}/${r.vsA1.wallMs}ms` : "",
        seq: r.explain?.seqScans.join(",") ?? "",
        explainMs: r.explain?.execMs ?? "",
        outcome: r.outcome ?? "",
      })),
    );
    console.table(cpu.map((c) => ({ escenario: c.scenario, turnos: c.bookings, celdas: c.cells, med: c.medianMs, p95: c.p95Ms, max: c.maxMs })));
    await T?.cleanup();
    await db?.$disconnect();
  }, 600_000);

  /** Warm-up + `runs` corridas; mediana de wallMs, conteos de la última. */
  async function bench<R>(
    scenario: string,
    fn: () => Promise<R>,
    opts: { runs?: number; a1?: string; note?: string; outcome?: (r: R) => string } = {},
  ): Promise<R> {
    const runs = opts.runs ?? 3;
    await fn();
    const ms: Measurement[] = [];
    let result!: R;
    for (let i = 0; i < runs; i++) {
      const out = await measure(fn);
      ms.push(out.m);
      result = out.result;
    }
    const last = ms[ms.length - 1];
    const wall = ms.map((m) => m.wallMs).sort((a, b) => a - b)[Math.floor(runs / 2)];
    const ref = opts.a1 ? a1.get(opts.a1) : undefined;
    const row: Row = {
      scenario,
      runs,
      note: opts.note,
      statements: last.statements,
      transactions: last.transactions,
      dbMs: last.dbMs,
      wallMs: wall,
      byClient: last.byClient,
      slowest: last.slowest.map((q) => ({ ms: q.durationMs, sql: q.query.slice(0, 400) })),
      byTable: statementsByTable(),
      explain: await explainSlowest(last),
      outcome: opts.outcome?.(result),
      vsA1: ref
        ? { scenario: ref.scenario, statements: ref.statements, transactions: ref.transactions, dbMs: ref.dbMs, wallMs: ref.wallMs }
        : undefined,
    };
    rows.push(row);
    expect(row.statements).toBeGreaterThan(0);
    return result;
  }

  /**
   * Histograma por tabla de la última `measure()`: el recorder global del
   * query-counter conserva los eventos hasta la próxima medición. Sin
   * BEGIN/COMMIT ni el set_config de `runWithRls` (mismo filtro que `measure`).
   */
  function statementsByTable(): Record<string, number> {
    const rec = (globalThis as unknown as { __kineQueryRecorder?: { events: { query: string }[] } }).__kineQueryRecorder;
    const out: Record<string, number> = {};
    for (const e of rec?.events ?? []) {
      const q = e.query.trim();
      if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(q) || /set_config\('app\.current_tenant_id'/.test(q)) continue;
      const m =
        /^(UPDATE)\s+"public"\."(\w+)"/i.exec(q) ??
        /^(INSERT)\s+INTO\s+"public"\."(\w+)"/i.exec(q) ??
        /^(SELECT|DELETE)\b[\s\S]*?FROM\s+"public"\."(\w+)"/i.exec(q);
      const key = m ? `${m[1].toUpperCase()} ${m[2]}` : q.slice(0, 40);
      out[key] = (out[key] ?? 0) + 1;
    }
    return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
  }

  /**
   * EXPLAIN (ANALYZE, BUFFERS) de la SELECT más lenta, con el cliente de la
   * app y el GUC del tenant: con `kinesoft_app` las policies RLS entran al
   * plan. Se reportan los Seq Scan de más de 500 filas y el plan en texto.
   */
  async function explainSlowest(m: Measurement): Promise<Explain> {
    const q = m.slowest.find((e) => /^\s*SELECT/i.test(e.query));
    if (!q) return null;
    // Los parámetros se INLINEAN como literales sin tipo, no se pasan como
    // `$n`: un Date pasado a `$queryRawUnsafe` viaja como timestamptz y
    // Postgres castea la COLUMNA (`timestamp(3)`), con lo que el índice
    // (tenantId, scheduledFor) deja de servir y el EXPLAIN muestra un Seq Scan
    // que la query real de Prisma no hace (primera corrida de B4.6: falso
    // positivo). Un literal 'YYYY-MM-DD hh:mm:ss' toma el tipo de la columna.
    // Prisma serializa los DateTime como "YYYY-MM-DD hh:mm:ss.mmm UTC" y la
    // columna guarda UTC sin zona.
    let sql: string;
    try {
      const params = JSON.parse(q.params) as unknown[];
      const lit = (p: unknown): string => {
        if (p === null || p === undefined) return "NULL";
        if (typeof p === "number" || typeof p === "boolean") return String(p);
        const str = typeof p === "string" ? p.replace(/^(\d{4}-\d{2}-\d{2} [\d:.]+) UTC$/, "$1") : JSON.stringify(p);
        return `'${str.replace(/'/g, "''")}'`;
      };
      sql = q.query.replace(/\$(\d+)\b/g, (_, n: string) => lit(params[Number(n) - 1]));
    } catch {
      return null;
    }
    const params: unknown[] = [];
    try {
      const [json, text] = await prisma.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(`SELECT set_config('app.current_tenant_id', $1, true)`, T.tenantId);
        const j = await tx.$queryRawUnsafe<{ "QUERY PLAN": unknown }[]>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, ...params);
        const t = await tx.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, ...params);
        return [j, t] as const;
      });
      // Contrafáctico: forzar índice. Con un solo tenant grande en el Docker
      // local, el Seq Scan puede ser lo más barato; en prod (muchos tenants)
      // el planner elige el índice. Esto separa artefacto de problema.
      const noSeq = await prisma
        .$transaction(async (tx) => {
          await tx.$queryRawUnsafe(`SELECT set_config('app.current_tenant_id', $1, true)`, T.tenantId);
          await tx.$executeRawUnsafe(`SET LOCAL enable_seqscan = off`);
          const j = await tx.$queryRawUnsafe<{ "QUERY PLAN": unknown }[]>(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, ...params);
          const p = (j[0]["QUERY PLAN"] as { Plan: PlanNode & { "Index Name"?: string }; "Execution Time": number }[])[0];
          const nodes: string[] = [];
          const walk2 = (n: PlanNode & { "Index Name"?: string }) => {
            if (/Scan/.test(n["Node Type"])) nodes.push(`${n["Node Type"]} ${n["Relation Name"] ?? ""} ${n["Index Name"] ?? ""}`.trim());
            (n.Plans ?? []).forEach(walk2);
          };
          walk2(p.Plan);
          return { execMs: Math.round(p["Execution Time"] * 10) / 10, topNodes: nodes.slice(0, 6) };
        })
        .catch(() => null);
      const plan = (json[0]["QUERY PLAN"] as { Plan: PlanNode; "Execution Time": number }[])[0];
      const seq: string[] = [];
      const walk = (n: PlanNode) => {
        if (n["Node Type"] === "Seq Scan" && (n["Actual Rows"] ?? 0) * (n["Actual Loops"] ?? 1) > 500) seq.push(n["Relation Name"] ?? "?");
        (n.Plans ?? []).forEach(walk);
      };
      walk(plan.Plan);
      return {
        seqScans: [...new Set(seq)],
        execMs: Math.round(plan["Execution Time"] * 10) / 10,
        asAppRole: !bypass,
        // Las listas IN (…) de ids hacen líneas de 30 kB: se recortan.
        plan: text.map((r) => (r["QUERY PLAN"].length > 240 ? `${r["QUERY PLAN"].slice(0, 240)}…` : r["QUERY PLAN"])).slice(0, 40),
        withoutSeqScan: seq.length ? noSeq : undefined,
      };
    } catch (e) {
      console.warn("[perf B4.6] EXPLAIN falló:", e instanceof Error ? e.message : e);
      return null;
    }
  }

  const okOf = (r: { ok: boolean; error?: string } & Record<string, unknown>) =>
    r.ok
      ? "ok"
      : `error: ${r.error ?? "?"}${["conflict", "samePatientDay", "patientOverlap", "outOfHours", "blocked"]
          .filter((k) => r[k])
          .map((k) => ` [${k}]`)
          .join("")}`;

  // ── (a) turnos de la semana: proyección liviana vs la vieja ────────────────

  it("(a) listBookingsInRange (vieja) — semana, 6 profesionales", async () => {
    await bench("a.listBookingsInRange.week", () => listBookingsInRange({ from: weekFrom, to: weekTo }), {
      a1: "agenda.bookings",
      outcome: (r) => `${r.length} filas, ${Math.round(JSON.stringify(r).length / 1024)} kB`,
    });
  });

  it("(a) listAgendaBookings (B4.1) — semana, 6 profesionales", async () => {
    await bench("a.listAgendaBookings.week", () => listAgendaBookings({ from: weekFrom, to: weekTo }), {
      a1: "agenda.bookings",
      outcome: (r) => `${r.length} filas, ${Math.round(JSON.stringify(r).length / 1024)} kB`,
    });
  });

  it("(a) listAgendaBookings — semana, sede principal (incluye locationId null)", async () => {
    await bench(
      "a.listAgendaBookings.week.primary",
      () => listAgendaBookings({ from: weekFrom, to: weekTo, locationId: T.primaryLocationId }),
      { outcome: (r) => `${r.length} filas, ${Math.round(JSON.stringify(r).length / 1024)} kB` },
    );
  });

  it("(a) listAgendaBookings — semana, 2 profesionales (filtro de chips)", async () => {
    await bench(
      "a.listAgendaBookings.week.2pracs",
      () => listAgendaBookings({ from: weekFrom, to: weekTo, practitionerIds: [T.gymPractitionerIds[0], T.osteoPractitionerIds[0]] }),
      { outcome: (r) => `${r.length} filas, ${Math.round(JSON.stringify(r).length / 1024)} kB` },
    );
  });

  it("(a) GET /agenda con la proyección VIEJA (bootstrap de B-pre + listBookingsInRange)", async () => {
    await bench(
      "a.page.oldBookings",
      () =>
        Promise.all([
          listLocations(),
          getUserPreferences(),
          getCapabilities(),
          getAgendaAvailability({ from: monday, to: addDays(monday, 6) }),
          getActor(),
          listBookingsInRange({ from: weekFrom, to: weekTo }),
          listServices(),
          listPractitioners(),
          listPatients(),
          listInsurers({ onlyActive: true }),
          getTenantSettings(),
        ]),
      { a1: "agenda", note: "service sobrecontado: cache() es pass-through fuera de Next (ver PERF.md)" },
    );
  });

  it("(a) GET /agenda como la deja B4.3 (page.tsx: 11 loaders con listAgendaBookings)", async () => {
    await bench(
      "a.page.b43",
      () =>
        Promise.all([
          listLocations(),
          getUserPreferences(),
          getCapabilities(),
          getAgendaAvailability({ from: monday, to: addDays(monday, 6) }),
          getActor(),
          listAgendaBookings({ from: weekFrom, to: weekTo }),
          listServices(),
          listPractitioners(),
          listPatients(),
          listInsurers({ onlyActive: true }),
          getTenantSettings(),
        ]),
      { a1: "agenda", note: "service sobrecontado: cache() es pass-through fuera de Next (ver PERF.md)" },
    );
  });

  // ── (b) disponibilidad de la semana ─────────────────────────────────────────

  it("(b) getAgendaAvailability — semana, todos", async () => {
    await bench("b.getAgendaAvailability.week", () => getAgendaAvailability({ from: monday, to: addDays(monday, 6) }), {
      outcome: (r) => (r.ok ? `ok: ${r.data.practitioners.length} prof × ${r.data.days.length} días, ${r.data.blocks.length} bloqueos` : okOf(r)),
    });
  });

  it("(b) getAgendaAvailability — semana, sede Norte", async () => {
    await bench(
      "b.getAgendaAvailability.week.north",
      () => getAgendaAvailability({ from: monday, to: addDays(monday, 6), locationId: T.northLocationId }),
      { outcome: (r) => (r.ok ? "ok" : okOf(r)) },
    );
  });

  // ── (c) slots del día ───────────────────────────────────────────────────────

  it('(c) listAvailableSlots "any" — Gimnasio, un día (carga 15 días por nextFreeSlot)', async () => {
    await bench(
      "c.listAvailableSlots.any.gym",
      () => listAvailableSlots({ practitionerId: "any", serviceId: T.gymServiceId, dayKey: nextTue, patientId: T.freePatientIds[0] }),
      {
        outcome: (r) =>
          r.ok && r.data.mode === "any"
            ? `ok: ${r.data.practitioners.length} elegibles, firstFree=${r.data.firstFree ? "sí" : "no"}`
            : okOf(r),
      },
    );
  });

  it('(c) listAvailableSlots "any" — Osteopatía cupo 1 + cobertura', async () => {
    await bench(
      "c.listAvailableSlots.any.osteo",
      () =>
        listAvailableSlots({
          practitionerId: "any",
          serviceId: T.osteoServiceId,
          dayKey: nextTue,
          insurerId: T.insurerIds[2],
          patientId: T.freePatientIds[0],
        }),
      {
        outcome: (r) =>
          r.ok && r.data.mode === "any" ? `ok: ${r.data.practitioners.length} elegibles` : okOf(r),
      },
    );
  });

  it("(c) listAvailableSlots — un profesional de gimnasio, un día", async () => {
    await bench(
      "c.listAvailableSlots.one.gym",
      () => listAvailableSlots({ practitionerId: T.gymPractitionerIds[0], serviceId: T.gymServiceId, dayKey: nextTue }),
      { outcome: (r) => (r.ok && r.data.mode === "practitioner" ? `ok: ${r.data.slots.length} slots` : okOf(r)) },
    );
  });

  // ── (d) vista previa de una serie ───────────────────────────────────────────

  it("(d) previewRecurrence — 20 mensual (osteópata)", async () => {
    await bench(
      "d.previewRecurrence.monthly20",
      () =>
        previewRecurrence({
          anchor: new Date(localToARIso(`${nextTue}T10:00:00`)).toISOString(),
          count: 20,
          frequency: "monthly",
          practitionerId: T.osteoPractitionerIds[0],
          serviceId: T.osteoServiceId,
          patientId: T.freePatientIds[1],
        }),
      { outcome: (r) => (r.ok ? `ok: ${r.data.items.length} fechas` : okOf(r)) },
    );
  });

  it("(d) previewRecurrence — 20 semanal Lun/Mié/Vie (gimnasio, cae en las semanas cargadas)", async () => {
    await bench(
      "d.previewRecurrence.weekly20",
      () =>
        previewRecurrence({
          anchor: new Date(localToARIso(`${addDays(monday, 7)}T09:00:00`)).toISOString(),
          count: 20,
          daysOfWeek: [0, 2, 4],
          frequency: "weekly",
          practitionerId: T.gymPractitionerIds[0],
          serviceId: T.gymServiceId,
          patientId: T.freePatientIds[2],
        }),
      { outcome: (r) => (r.ok ? `ok: ${r.data.items.length} fechas` : okOf(r)) },
    );
  });

  // ── (e) layout puro de "Día por profesional" (CPU) ──────────────────────────

  it("(e) buildPractitionerColumns — 6 profesionales × día cargado (CPU, umbral 16 ms)", async () => {
    const av = await getAgendaAvailability({ from: monday, to: addDays(monday, 6) });
    expect(av.ok).toBe(true);
    const availability = (av as { ok: true; data: AgendaAvailability }).data;
    const weekRows = await listAgendaBookings({ from: weekFrom, to: weekTo });
    const dtos = weekRows.map(toBookingDTO);
    // Lo que viaja en el payload RSC de /agenda (B4.3 pasa `toBookingDTO` al cliente).
    const dtoBytes = JSON.stringify(dtos).length;
    payload = {
      weekBookings: dtos.length,
      dtoKB: Math.round(dtoBytes / 1024),
      bytesPerBooking: Math.round(dtoBytes / Math.max(1, dtos.length)),
      availabilityKB: Math.round(JSON.stringify(availability).length / 1024),
    };
    const practitioners = T.practitionerIds.map((id, i) => ({ id, name: `Profesional ${i + 1}` }));
    const capOf = capOfFromAvailability(availability);
    const blocks = layoutBlocks(availability);
    const now = new Date();
    // Martes (el miércoles tiene un osteópata bloqueado todo el día).
    const day = addDays(monday, 1);
    const dayStart = Date.parse(localToARIso(`${day}T00:00:00`));
    const dayEnd = Date.parse(localToARIso(`${addDays(day, 1)}T00:00:00`));
    const dayDtos = dtos.filter((b) => {
      const t = Date.parse(b.scheduledFor);
      return t >= dayStart && t < dayEnd;
    });

    const time = (scenario: string, bookings: typeof dtos, zoom: AgendaZoom, iterations = 200) => {
      const run = () =>
        buildPractitionerColumns(practitioners, bookings, {
          dayKey: day,
          zoom,
          ranges: rangesForDay(availability, day),
          blocks,
          capOf,
          now,
          fallback: availability.tenantHours,
        });
      for (let i = 0; i < 20; i++) run();
      const samples: number[] = [];
      let out = run();
      for (let i = 0; i < iterations; i++) {
        const t0 = performance.now();
        out = run();
        samples.push(performance.now() - t0);
      }
      samples.sort((a, b) => a - b);
      const r2 = (x: number) => Math.round(x * 100) / 100;
      const row: CpuRow = {
        scenario,
        bookings: bookings.filter((b) => T.practitionerIds.includes(b.practitionerId)).length,
        columns: out.columns.length,
        rows: out.rows.length,
        cells: out.columns.length * out.rows.length,
        iterations,
        medianMs: r2(samples[Math.floor(iterations / 2)]),
        p95Ms: r2(samples[Math.floor(iterations * 0.95)]),
        maxMs: r2(samples[iterations - 1]),
        overFrameBudget: samples[Math.floor(iterations * 0.95)] > FRAME_BUDGET_MS,
      };
      cpu.push(row);
      return row;
    };

    // Volumen sintético: el mismo día duplicado (más turnos por celda, misma grilla).
    const scaled = (k: number) =>
      Array.from({ length: k }, (_, c) => dayDtos.map((b) => ({ ...b, id: `${b.id}-x${c}` }))).flat();

    time("e.columns.day.zoom30", dayDtos, 30);
    time("e.columns.day.zoom15", dayDtos, 15);
    time("e.columns.day.x2.zoom15", scaled(2), 15);
    time("e.columns.day.x4.zoom15", scaled(4), 15, 50);

    // Vista Semana (6 profesionales × 7 días): ocupación por celda.
    const weekDays = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
    const wSamples: number[] = [];
    for (let i = 0; i < 70; i++) {
      const t0 = performance.now();
      weekOccupancy({ days: weekDays, practitionerIds: T.practitionerIds, bookings: dtos, zoom: 30, window: { startMin: 480, endMin: 1200 }, now });
      if (i >= 20) wSamples.push(performance.now() - t0);
    }
    wSamples.sort((a, b) => a - b);
    cpu.push({
      scenario: "e.weekOccupancy.week.zoom30",
      bookings: dtos.length,
      columns: T.practitionerIds.length,
      rows: 24,
      cells: 24 * 7,
      iterations: wSamples.length,
      medianMs: Math.round(wSamples[Math.floor(wSamples.length / 2)] * 100) / 100,
      p95Ms: Math.round(wSamples[Math.floor(wSamples.length * 0.95)] * 100) / 100,
      maxMs: Math.round(wSamples[wSamples.length - 1] * 100) / 100,
      overFrameBudget: wSamples[Math.floor(wSamples.length * 0.95)] > FRAME_BUDGET_MS,
    });
    expect(cpu.length).toBeGreaterThan(0);
  });

  // ── (f) write-paths con lock de cupo + motor vs A1 ──────────────────────────

  it("(f) createBooking — turno simple (mismos argumentos que A1)", async () => {
    let i = 0;
    await bench(
      "f.createBooking",
      () =>
        createBooking({
          patientId: T.freePatientIds[10 + i],
          serviceId: T.serviceId,
          practitionerId: T.practitionerId,
          scheduledFor: new Date(localToARIso(`2028-01-0${3 + i++}T10:00:00`)).toISOString(),
          idempotencyKey: randomUUID(),
        }),
      { a1: "createBooking", outcome: okOf },
    );
  });

  it("(f) createBooking — Gimnasio en la semana que viene (franja con ~20 turnos)", async () => {
    let i = 0;
    await bench(
      "f.createBooking.gym.busyWeek",
      () =>
        createBooking({
          patientId: T.freePatientIds[20 + i],
          serviceId: T.gymServiceId,
          practitionerId: T.gymPractitionerIds[0],
          scheduledFor: new Date(localToARIso(`${addDays(monday, 8 + i++)}T10:00:00`)).toISOString(),
          idempotencyKey: randomUUID(),
        }),
      { a1: "createBooking", outcome: okOf },
    );
  });

  it("(f) createBooking — Osteopatía cupo 1 sobre un horario ocupado (camino del conflicto)", async () => {
    await bench(
      "f.createBooking.osteo.conflict",
      () =>
        createBooking({
          patientId: T.freePatientIds[30],
          serviceId: T.osteoServiceId,
          practitionerId: T.osteoPractitionerIds[0],
          // 12:00 y no 10:00: el bloqueo "Fondo" de la semana que viene (09-11)
          // cae justo en el martes de este osteópata y daría el prompt de bloqueo.
          scheduledFor: new Date(localToARIso(`${nextTue}T12:00:00`)).toISOString(),
          idempotencyKey: randomUUID(),
        }),
      { a1: "createBooking", outcome: okOf, note: "no escribe: devuelve el prompt de sobreturno" },
    );
  });

  it("(f) createBookingsBatch — 20 turnos (mismos argumentos que A1)", async () => {
    let i = 0;
    await bench(
      "f.createBookingsBatch.20",
      () =>
        createBookingsBatch({
          patientId: T.freePatientIds[50 + i++],
          serviceId: T.serviceId,
          practitionerId: T.practitionerId,
          scheduledFor: new Date(localToARIso("2028-02-07T09:00:00")).toISOString(),
          count: 20,
          daysOfWeek: [0, 2, 4],
          idempotencyKey: randomUUID(),
        }),
      { a1: "createBookingsBatch.20", outcome: okOf },
    );
  });

  it("(f) createBookingsBatch — 20 de Gimnasio sobre las semanas cargadas", async () => {
    let i = 0;
    await bench(
      "f.createBookingsBatch.20.gym.busy",
      () =>
        createBookingsBatch({
          patientId: T.freePatientIds[60 + i],
          serviceId: T.gymServiceId,
          practitionerId: T.gymPractitionerIds[1],
          // Cada corrida a otra hora de la franja: la misma serie repetida sería duplicado.
          scheduledFor: new Date(localToARIso(`${addDays(monday, 7)}T${String(8 + i++).padStart(2, "0")}:30:00`)).toISOString(),
          count: 20,
          daysOfWeek: [0, 2, 4],
          idempotencyKey: randomUUID(),
        }),
      { a1: "createBookingsBatch.20", outcome: okOf },
    );
  });
});
