/**
 * SV08 · PERF del publish realtime en los write-paths (plan §18.8 fila SV08,
 * §18.10 punto 6). SOLO MEDICIÓN, informativo.
 *
 * Por qué: SV espera el publish dentro de la action (SV-D7: en Vercel una
 * promesa suelta se pierde), así que el wall-clock de un alta paga lo que tarde
 * el POST a Supabase Broadcast, con tope de 1,5 s y breaker. Tres preguntas:
 *   - `rt.createBooking.lat0`: con el publish instantáneo, ¿el alta cuesta lo
 *     mismo que `f.createBooking` de agenda-multi? El publish es HTTP: tiene que
 *     sumar 0 statements y 0 transacciones (se imprime la comparación contra
 *     `tests/perf/agenda-multi.json` + la errata de `compare.ts`).
 *   - `rt.createBooking.lat1500`: con el publisher tardando 1,5 s (el tope del
 *     real, `realtimeFake.latencyMs`), ¿el wall-clock queda acotado a ~1,5 s
 *     más y no se multiplica? Se documenta; el número de laptop no es regla.
 *   - `rt.createBookingsBatch.20.posts`: un batch de 20 hace UNA llamada al
 *     publisher con 20 refs (no 20 POSTs). Esto sí se afirma.
 *
 * Mismo harness y fixture que agenda-multi (`createAgendaMultiTenant`, mismos
 * argumentos que `f.createBooking` / `f.createBookingsBatch.20`) y el publisher
 * fake del setup (`tests/helpers/integration-setup.ts` lo instala también para
 * perf: nunca sale un POST real).
 *
 * Salida: con `PERF_OUT_DIR` escribe `<PERF_OUT_DIR>/realtime-publish.json`
 * (`rows` en el formato que lee `tests/perf/compare.ts`). Sin `PERF_OUT_DIR` NO
 * escribe (solo imprime la tabla): los `rt.*` no tienen referencia versionada
 * y crear un JSON nuevo en `tests/perf/` ensuciaría el árbol (P0-Ct). En
 * `compare.ts` los `rt.*` salen como «nuevo, sin referencia»: se reportan y
 * no fallan.
 *
 *   PERF_OUT_DIR=<scratchpad> npm run test:perf -- realtime-publish
 *   npx tsx tests/perf/compare.ts <scratchpad>
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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
import { createBooking, createBookingsBatch } from "@/lib/bookings";
import { localToARIso } from "@/lib/datetime-ar";
import { REALTIME_PUBLISH_TIMEOUT_MS } from "@/lib/realtime-constants";
import { REFERENCE_ERRATA, type PerfRow } from "@/tests/perf/compare";
import { realtimeFake } from "@/tests/helpers/integration-setup";
import { ownerClient } from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { appRoleBypassesRls } from "@/tests/helpers/db-role";
import { createAgendaMultiTenant, type AgendaMultiTenant } from "./volume-fixture";

const RUN = process.env.PERF_IT === "1";
const OUT_DIR = process.env.PERF_OUT_DIR;

type Row = PerfRow & {
  runs: number;
  dbMs: number;
  /** Llamadas al publisher en la última corrida (el fake las cuenta). */
  publishCalls: number;
  /** Refs de esas llamadas (20 en el batch de 20). */
  publishedRefs: number;
  latencyMs: number;
  outcome: string;
  /** Escenario `f.*` de agenda-multi.json (+ errata) con el que se compara: mismos argumentos, sin publish. */
  vsF?: { scenario: string; statements: number; transactions: number };
  note?: string;
};

describe.skipIf(!RUN)("perf SV08 — publish realtime en los write-paths", () => {
  let db: PrismaClient;
  let T: AgendaMultiTenant;
  let bypass = true;
  const rows: Row[] = [];
  const fRef = new Map<string, { statements: number; transactions: number }>();

  beforeAll(async () => {
    db = ownerClient();
    // Referencia `f.*` versionada (+ errata de compare.ts): solo para imprimir el Δ.
    try {
      const json = JSON.parse(readFileSync("tests/perf/agenda-multi.json", "utf8")) as { rows: PerfRow[] };
      for (const r of json.rows) {
        if (!r.scenario.startsWith("f.")) continue;
        fRef.set(r.scenario, { statements: r.statements + (REFERENCE_ERRATA[r.scenario]?.statements ?? 0), transactions: r.transactions });
      }
    } catch {
      /* sin referencia: la columna queda vacía */
    }
    T = await createAgendaMultiTenant(db);
    asUser(T.userId);
    bypass = await appRoleBypassesRls();
  }, 600_000);

  afterAll(async () => {
    console.table(
      rows.map((r) => ({
        escenario: r.scenario,
        st: r.statements,
        tx: r.transactions,
        "f.* (st/tx)": r.vsF ? `${r.vsF.statements}/${r.vsF.transactions}` : "",
        wallMs: r.wallMs,
        latencia: r.latencyMs,
        publish: `${r.publishCalls} × ${r.publishedRefs} refs`,
        outcome: r.outcome,
      })),
    );
    if (OUT_DIR) {
      mkdirSync(OUT_DIR, { recursive: true });
      writeFileSync(
        join(OUT_DIR, "realtime-publish.json"),
        JSON.stringify({ measuredAt: new Date().toISOString(), role: bypass ? "owner (BYPASSRLS)" : "kinesoft_app (RLS)", rows }, null, 2) + "\n",
      );
    } else {
      console.log("[perf SV08] sin PERF_OUT_DIR: no se escribe ningún JSON (los rt.* no tienen referencia versionada).");
    }
    await T?.cleanup();
    await db?.$disconnect();
  }, 600_000);

  beforeEach(() => realtimeFake.reset());

  const okOf = (r: { ok: boolean; error?: string }) => (r.ok ? "ok" : `error: ${r.error ?? "?"}`);

  /** Warm-up + `runs` corridas; mediana de wallMs, conteos (y llamadas al publisher) de la última. */
  async function bench<R extends { ok: boolean; error?: string }>(
    scenario: string,
    fn: () => Promise<R>,
    opts: { runs?: number; vsF?: string; note?: string } = {},
  ): Promise<Row> {
    const runs = opts.runs ?? 3;
    const latencyMs = realtimeFake.latencyMs;
    await fn();
    const ms: Measurement[] = [];
    let result!: R;
    for (let i = 0; i < runs; i++) {
      realtimeFake.calls = [];
      const out = await measure(fn);
      ms.push(out.m);
      result = out.result;
    }
    const last = ms[ms.length - 1];
    const ref = opts.vsF ? fRef.get(opts.vsF) : undefined;
    const row: Row = {
      scenario,
      runs,
      statements: last.statements,
      transactions: last.transactions,
      dbMs: last.dbMs,
      wallMs: ms.map((m) => m.wallMs).sort((a, b) => a - b)[Math.floor(runs / 2)],
      publishCalls: realtimeFake.calls.length,
      publishedRefs: realtimeFake.calls.reduce((n, c) => n + (c.refs?.length ?? 0), 0),
      latencyMs,
      outcome: okOf(result),
      ...(ref && opts.vsF ? { vsF: { scenario: opts.vsF, ...ref } } : {}),
      ...(opts.note ? { note: opts.note } : {}),
    };
    rows.push(row);
    expect(row.outcome).toBe("ok");
    return row;
  }

  let day = 0;
  /**
   * Próximo día HÁBIL de 2029 (calendario puro en UTC, sin reloj del host): las
   * franjas del fixture son Lun-Vie y un sábado daría el aviso de fuera de
   * horario (no escribe: mediría otro camino).
   */
  function nextWeekdayKey(): string {
    for (;;) {
      const d = new Date(Date.UTC(2029, 0, 1 + day++));
      if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) return d.toISOString().slice(0, 10);
    }
  }
  /** Mismos argumentos que `f.createBooking`, en días que agenda-multi no usa (2029). */
  const createArgs = (patientIdx: number) => ({
    patientId: T.freePatientIds[patientIdx],
    serviceId: T.serviceId,
    practitionerId: T.practitionerId,
    scheduledFor: new Date(localToARIso(`${nextWeekdayKey()}T10:00:00`)).toISOString(),
    idempotencyKey: randomUUID(),
  });

  it("rt.createBooking.lat0 — alta simple con el publish instantáneo: 1 llamada, mismos statements que f.createBooking", async () => {
    let i = 0;
    const row = await bench("rt.createBooking.lat0", () => createBooking(createArgs(10 + i++)), { vsF: "f.createBooking" });
    expect(row.publishCalls).toBe(1);
    expect(row.publishedRefs).toBe(1);
    if (row.vsF) {
      // Informativo (el JSON versionado puede estar viejo respecto de HEAD; la regla estricta es de compare.ts).
      console.log(`[perf SV08] rt.createBooking.lat0: ${row.statements} st / ${row.transactions} tx vs f.createBooking ${row.vsF.statements}/${row.vsF.transactions}`);
    }
  });

  it("rt.createBooking.lat1500 — el publisher tarda el tope (1,5 s): el alta paga ~1,5 s, una sola vez", async () => {
    realtimeFake.latencyMs = REALTIME_PUBLISH_TIMEOUT_MS;
    let i = 0;
    const row = await bench("rt.createBooking.lat1500", () => createBooking(createArgs(20 + i++)), {
      vsF: "f.createBooking",
      note: "wallMs ≈ lat0 + 1500: el publish se espera una vez por action (SV-D7); el real corta a los 1,5 s y con el breaker abierto no espera",
    });
    expect(row.publishCalls).toBe(1);
    // Acotado: espera la latencia una vez (no N), sin afirmar un techo de laptop.
    expect(row.wallMs).toBeGreaterThanOrEqual(REALTIME_PUBLISH_TIMEOUT_MS);
    expect(row.wallMs).toBeLessThan(2 * REALTIME_PUBLISH_TIMEOUT_MS);
  }, 60_000);

  it("rt.createBookingsBatch.20.posts — batch de 20: UNA llamada al publisher con 20 refs", async () => {
    let i = 0;
    const row = await bench(
      "rt.createBookingsBatch.20.posts",
      () =>
        createBookingsBatch({
          patientId: T.freePatientIds[50 + i++],
          serviceId: T.serviceId,
          practitionerId: T.practitionerId,
          scheduledFor: new Date(localToARIso("2029-06-04T09:00:00")).toISOString(),
          count: 20,
          daysOfWeek: [0, 2, 4],
          idempotencyKey: randomUUID(),
        }),
      { vsF: "f.createBookingsBatch.20" },
    );
    expect(realtimeFake.calls.length).toBe(1);
    expect(row.publishedRefs).toBe(20);
  });
});
