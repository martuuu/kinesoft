/**
 * ES4 S26s · PERF de Planes y del portal. Mide y FIJA presupuestos.
 *
 * Por qué: ES2-ES4 sumaron el motor de Planes (alta con preview + commit en una
 * tx, locks de cupo y de paciente, verificador de invariantes), la lectura del
 * plan (`getPlanDetail`), los buckets de Seguimiento (`listOpenSessions`), el
 * `groupBy` del listado de pacientes (S32) y la identidad del portal por vínculo
 * (S24a). Nada de eso tenía techo medido: un N+1 nuevo (una sentencia por fila
 * de plan, una por consultorio y por módulo en el portal) pasaba los tests
 * funcionales sin que nadie lo viera. Presupuestos del brief ES4 §4 (S26s):
 *
 *   - `createPlan` de 20 filas: ≤ 60 sentencias DENTRO de 1 sola tx (§5 de
 *     PLANES; el getActor y el post-commit van afuera y se informan aparte);
 *   - `previewPlan` de 20 filas: ≤ 30 sentencias;
 *   - `listOpenSessions` / `getPlanDetail`: techo = lo medido en S26s (abajo);
 *   - agenda (`listAgendaBookings`, `getAgendaAvailability` de la semana) con
 *     turnos de plan en la grilla: ≤ +5 % contra `agenda-multi.json` (B4.6);
 *   - `requirePortalPatient`: ≤ 3 sentencias;
 *   - `/portal` home (`getPortalAuth`): ≤ 1 sentencia por consultorio vinculado;
 *   - `listPatients` con el `groupBy` de S32 y `updateBooking` (AUDIT
 *     `ev2-perf-update-booking`): techo medido.
 * Un presupuesto que HEAD no cumple queda como `it.fails("[ES4-S26s] …")` y es
 * un hallazgo: esta sesión no toca producción. Cuando se arregle, el test pasa a
 * fallar y se da vuelta a `it`.
 *
 * Fixture: `createAgendaMultiTenant` (6 profesionales, ~6.900 turnos, 1.000
 * pacientes) + 150 planes de 20 sesiones VINCULADOS a turnos reales de la grilla
 * (por insert directo del owner: no es el código bajo test el que siembra). Así
 * la agenda medida es la de B4.6 con un tercio de los turnos de plan.
 *
 * Mismo harness que agenda-multi (query-counter: statements sin BEGIN/COMMIT ni
 * el set_config de RLS; warm-up + 3 corridas; mediana de wall-clock). Escribe
 * `<PERF_OUT_DIR>/plans.json` (default `tests/perf/`); para no ensuciar el árbol:
 *   PERF_OUT_DIR=<scratchpad> npm run test:perf -- tests/perf/plans.perf.test.ts
 *   npx tsx tests/perf/compare.ts <scratchpad>
 * No regraba ningún JSON versionado: la referencia de agenda se LEE de
 * `tests/perf/agenda-multi.json`.
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

import { measure, type Measurement, type QueryEvent } from "@/tests/helpers/query-counter";
import { createPlan, previewPlan } from "@/lib/plans";
import type { PlanCreateInput, PlanPreview, PlanRowResolution } from "@/lib/plans-types";
import { getPlanDetail } from "@/lib/plans-read";
import { listOpenSessions } from "@/lib/sessions";
import { listPatients } from "@/lib/patients";
import { listAgendaBookings, updateBooking } from "@/lib/bookings";
import { getAgendaAvailability } from "@/lib/availability-actions";
import { getPortalAuth } from "@/lib/portal";
import { requirePortalPatient } from "@/lib/portal-identity-internal";
import { addDays } from "@/lib/availability/day";
import { localToARIso } from "@/lib/datetime-ar";
import { ownerClient, createEphemeralTenant, addPatient, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { appRoleBypassesRls } from "@/tests/helpers/db-role";
import { createAgendaMultiTenant, type AgendaMultiTenant } from "./volume-fixture";

const RUN = process.env.PERF_IT === "1";
const OUT_DIR = process.env.PERF_OUT_DIR ?? "tests/perf";
const OUT = join(OUT_DIR, "plans.json");

/**
 * Presupuestos. Los del brief van literales; los "medidos" son lo que dio HEAD
 * e28d2c4 en la primera corrida de S26s (2026-10-15, Docker local, los dos
 * roles dan el mismo conteo): subir uno es una decisión, no un ajuste.
 */
const BUDGET = {
  createPlanInTx: 60,
  createPlanTx: 1,
  previewPlan: 30,
  listOpenSessions: 18,
  getPlanDetail: 13,
  agendaPct: 0.05,
  /**
   * Sentencias FIJAS que suma la proyección C9 (lib/agenda-plan-projection-internal.ts) cuando la semana tiene turnos
   * de plan: sesiones vivas (1), `pricedByPlan` (1) y un segundo `bulkPatientAccess` para el título (3). Medido en
   * S26s: 12 sin planes → 17 con planes. ES4 P4.Z: `pricedByPlan` viene en el select de la agenda, el acceso lo pasa
   * `listAgendaBookings` y planes + sesiones van en una sola sentencia → 12 → 12 (0 de más).
   */
  agendaPlanProjection: 0,
  requirePortalPatient: 3,
  portalPerTenant: 1,
  listPatients: 10,
  updateBookingReschedule: 27,
  updateBookingPlan: 28,
  updateBookingPatient: 14,
} as const;

/** Planes sembrados (de 20 sesiones, vinculadas a turnos de la grilla). */
const SEEDED_PLANS = 150;
const SESSIONS_PER_PLAN = 20;

type Row = { scenario: string; runs: number; note?: string; budget?: number; outcome?: string } & Omit<Measurement, "slowest"> & {
  slowest: { ms: number; sql: string }[];
  /** Sentencias dentro de cada tx (BEGIN..COMMIT), en orden; las de afuera aparte. */
  inTx?: number[];
  outsideTx?: number;
  byTable?: Record<string, number>;
  /** Referencia versionada (agenda-multi.json) cuando aplica. */
  ref?: { file: string; scenario: string; statements: number; transactions: number };
};

const isTxMark = (q: string) => /^(BEGIN|COMMIT|ROLLBACK)\b/i.test(q.trim());
const isGuc = (q: string) => /set_config\('app\.current_tenant_id'/.test(q);

/**
 * Sentencias por tx de la última `measure()`. Con un solo flujo secuencial (las
 * write-paths medidas acá) los eventos entre BEGIN y COMMIT son de esa tx; el
 * recorder global conserva los eventos hasta la próxima medición.
 */
function lastEvents(): QueryEvent[] {
  return (globalThis as unknown as { __kineQueryRecorder?: { events: QueryEvent[] } }).__kineQueryRecorder?.events ?? [];
}
function txBreakdown(): { inTx: number[]; outsideTx: number } {
  const inTx: number[] = [];
  let outsideTx = 0;
  let cur: number | null = null;
  for (const e of lastEvents()) {
    const q = e.query.trim();
    if (/^BEGIN\b/i.test(q)) cur = 0;
    else if (/^(COMMIT|ROLLBACK)\b/i.test(q)) {
      if (cur !== null) inTx.push(cur);
      cur = null;
    } else if (!isGuc(q)) {
      if (cur === null) outsideTx++;
      else cur++;
    }
  }
  return { inTx, outsideTx };
}
function statementsByTable(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of lastEvents()) {
    const q = e.query.trim();
    if (isTxMark(q) || isGuc(q)) continue;
    const m =
      /^(UPDATE)\s+"public"\."(\w+)"/i.exec(q) ??
      /^(INSERT)\s+INTO\s+"public"\."(\w+)"/i.exec(q) ??
      /^(SELECT|DELETE)\b[\s\S]*?FROM\s+"public"\."(\w+)"/i.exec(q);
    const key = m ? `${m[1].toUpperCase()} ${m[2]}` : q.slice(0, 40);
    out[key] = (out[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

/** Las resoluciones por defecto del preview, como las manda el editor. */
function acceptDefaults(p: PlanPreview): PlanRowResolution[] {
  return p.rows.map((r) =>
    r.defaultResolution === "move"
      ? { index: r.index, kind: "move", at: r.suggestion }
      : r.defaultResolution === "adopt"
        ? { index: r.index, kind: "adopt", bookingId: r.flags.duplicate!.bookingId, expectedUpdatedAt: r.flags.duplicate!.updatedAt }
        : { index: r.index, kind: r.defaultResolution },
  ) as PlanRowResolution[];
}

describe.skipIf(!RUN)("perf ES4 S26s — Planes, Seguimiento, agenda con planes y portal", () => {
  let db: PrismaClient;
  let T: AgendaMultiTenant;
  let bypass = true;
  let fixtureMs = 0;
  const rows: Row[] = [];
  const agendaRef = new Map<string, { statements: number; transactions: number }>();
  /** La misma agenda medida en esta corrida ANTES de sembrar los planes. */
  const agendaNoPlans = new Map<string, { statements: number; transactions: number; wallMs: number }>();
  /** Planes sembrados: [programId, patientId]. */
  const seeded: { programId: string; patientId: string; linked: number }[] = [];
  /** Portal: la cuenta del paciente y los consultorios extra donde también está vinculada. */
  let portalUserId = "";
  const extraTenants: EphemeralTenant[] = [];
  const extraPatients: { tenant: EphemeralTenant; patientId: string }[] = [];
  let monday = "";
  let weekFrom: Date;
  let weekTo: Date;
  let freeCursor = 0;
  const nextFree = () => T.freePatientIds[freeCursor++];

  beforeAll(async () => {
    db = ownerClient();
    try {
      const ref = JSON.parse(readFileSync("tests/perf/agenda-multi.json", "utf8")) as {
        rows: { scenario: string; statements: number; transactions: number }[];
      };
      for (const r of ref.rows) agendaRef.set(r.scenario, r);
    } catch {
      /* sin referencia: los tests de agenda fallan con un mensaje claro */
    }
    const t0 = Date.now();
    T = await createAgendaMultiTenant(db);
    monday = T.weekMondayKey;
    weekFrom = new Date(localToARIso(`${monday}T00:00:00`));
    weekTo = new Date(localToARIso(`${addDays(monday, 7)}T00:00:00`));

    // ── Línea de base de agenda EN ESTA CORRIDA, antes de sembrar planes ──
    // `agenda-multi.json` se grabó el 01-oct (antes de C9/S12 y de IAM, que
    // cambiaron el getActor): compararse solo contra él mezcla lo que agregan
    // los turnos de plan con todo lo demás. Mismo código, misma máquina, misma
    // grilla, sin planes: el delta de abajo es SOLO el de los planes.
    asUser(T.userId);
    for (const [name, fn] of [
      ["listAgendaBookings", () => listAgendaBookings({ from: weekFrom, to: weekTo })],
      ["getAgendaAvailability", () => getAgendaAvailability({ from: monday, to: addDays(monday, 6) })],
    ] as const) {
      await fn();
      const { m } = await measure(fn as () => Promise<unknown>);
      agendaNoPlans.set(name, { statements: m.statements, transactions: m.transactions, wallMs: m.wallMs });
    }

    // ── 150 planes vinculados a turnos REALES de la grilla (3 sentencias en total) ──
    // Los pacientes 0..149 tienen turnos en la semana medida y alrededor: cada
    // plan toma hasta 20 turnos vivos del paciente (una sesión por turno, mismo
    // instante y profesional), como haría `adoptBookingSeries`.
    const candidates = T.patientIds.slice(0, SEEDED_PLANS);
    const bookings = await db.booking.findMany({
      where: { tenantId: T.tenantId, patientId: { in: candidates }, status: { not: "CANCELLED" }, programId: null },
      orderBy: [{ patientId: "asc" }, { scheduledFor: "asc" }],
      select: { id: true, patientId: true, practitionerId: true, scheduledFor: true },
    });
    const byPatient = new Map<string, typeof bookings>();
    for (const b of bookings) {
      const list = byPatient.get(b.patientId!) ?? [];
      if (list.length < SESSIONS_PER_PLAN) list.push(b);
      byPatient.set(b.patientId!, list);
    }
    const planPatients = candidates.filter((p) => (byPatient.get(p)?.length ?? 0) > 0);
    const programs = await db.treatmentProgram.createManyAndReturn({
      data: planPatients.map((patientId) => ({
        tenantId: T.tenantId,
        patientId,
        title: `Plan perf ${uniqueSuffix()}`,
        totalSessions: SESSIONS_PER_PLAN,
        frequency: 3,
        startDate: byPatient.get(patientId)![0].scheduledFor,
        discipline: "KINESIOLOGY" as const,
        practitionerId: byPatient.get(patientId)![0].practitionerId,
        serviceId: T.gymServiceId,
        pricingMode: "PER_SESSION" as const,
        pricePerSessionCents: 500_000,
      })),
      select: { id: true, patientId: true },
    });
    const sessionData = programs.flatMap((p) => {
      const list = byPatient.get(p.patientId)!;
      // Las sesiones sin turno (paciente con < 20 turnos) quedan a futuro: alimentan "Sin turno".
      return Array.from({ length: SESSIONS_PER_PLAN }, (_, i) => ({
        programId: p.id,
        practitionerId: list[Math.min(i, list.length - 1)].practitionerId,
        index: i + 1,
        scheduledFor: list[i]?.scheduledFor ?? new Date(Date.parse(list[list.length - 1].scheduledFor.toISOString()) + (i + 1) * 86_400_000),
        priceCents: 500_000,
      }));
    });
    const sessions = await db.session.createManyAndReturn({ data: sessionData, select: { id: true, programId: true, index: true } });
    const sessionOf = new Map(sessions.map((s) => [`${s.programId}:${s.index}`, s.id]));
    const link: { bookingId: string; programId: string; sessionId: string }[] = [];
    for (const p of programs) {
      byPatient.get(p.patientId)!.forEach((b, i) => link.push({ bookingId: b.id, programId: p.id, sessionId: sessionOf.get(`${p.id}:${i + 1}`)! }));
      seeded.push({ programId: p.id, patientId: p.patientId, linked: byPatient.get(p.patientId)!.length });
    }
    await db.$executeRaw`
      UPDATE "Booking" b SET "programId" = l.pid, "sessionId" = l.sid
      FROM unnest(${link.map((l) => l.bookingId)}::text[], ${link.map((l) => l.programId)}::text[], ${link.map((l) => l.sessionId)}::text[]) AS l(bid, pid, sid)
      WHERE b.id = l.bid`;

    // ── Portal: una cuenta de paciente vinculada en T y en 2 consultorios más ──
    portalUserId = `test-perf-portal-${uniqueSuffix()}`;
    await db.userProfile.create({ data: { id: portalUserId, email: `${portalUserId}@test.local` } });
    await db.patient.update({ where: { id: seeded[0].patientId }, data: { userId: portalUserId } });
    for (let k = 0; k < 2; k++) {
      const t = await createEphemeralTenant(db);
      extraTenants.push(t);
      const patientId = await addPatient(db, t);
      extraPatients.push({ tenant: t, patientId });
    }
    fixtureMs = Date.now() - t0;
    console.log(
      `[perf S26s] fixture: ${T.totalBookingCount} turnos, ${programs.length} planes × ${SESSIONS_PER_PLAN} sesiones (${link.length} turnos vinculados) en ${Math.round(fixtureMs / 1000)} s`,
    );
    bypass = await appRoleBypassesRls();
    asUser(T.userId);
  }, 600_000);

  afterAll(async () => {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(
      OUT,
      JSON.stringify(
        {
          measuredAt: new Date().toISOString(),
          role: bypass ? "owner (BYPASSRLS)" : "kinesoft_app (RLS)",
          fixture: T
            ? {
                practitioners: T.practitionerIds.length,
                patients: T.patientIds.length,
                bookingsTotal: T.totalBookingCount,
                bookingsWeek: T.weekBookingCount,
                plans: seeded.length,
                sessionsPerPlan: SESSIONS_PER_PLAN,
                weekMonday: T.weekMondayKey,
                buildSeconds: Math.round(fixtureMs / 1000),
              }
            : null,
          budgets: BUDGET,
          rows,
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
        inTx: r.inTx?.join("+") ?? "",
        fuera: r.outsideTx ?? "",
        techo: r.budget ?? "",
        ref: r.ref ? `${r.ref.statements}/${r.ref.transactions}` : "",
        dbMs: r.dbMs,
        wallMs: r.wallMs,
        outcome: r.outcome ?? "",
      })),
    );
    // Portal: las fichas vinculadas se desvinculan antes del cleanup (FK a UserProfile).
    await db?.patient.updateMany({ where: { userId: portalUserId }, data: { userId: null } });
    await T?.cleanup();
    for (const t of extraTenants) await t.cleanup();
    if (portalUserId) await db?.userProfile.deleteMany({ where: { id: portalUserId } });
    await db?.$disconnect();
  }, 600_000);

  /**
   * Warm-up + `runs` corridas; mediana de wallMs, conteos de la última.
   * `prepare(i)` corre FUERA de la medición (un preview fresco, un turno nuevo):
   * así cada corrida de un write-path arranca de un estado válido.
   */
  async function bench<P, R>(
    scenario: string,
    prepare: (i: number) => Promise<P>,
    fn: (p: P) => Promise<R>,
    opts: { runs?: number; budget?: number; note?: string; outcome?: (r: R) => string; warmup?: boolean } = {},
  ): Promise<Row & { result: R }> {
    const runs = opts.runs ?? 3;
    let i = 0;
    if (opts.warmup !== false) await fn(await prepare(i++));
    const ms: Measurement[] = [];
    let result!: R;
    for (let k = 0; k < runs; k++) {
      const p = await prepare(i++);
      const out = await measure(() => fn(p));
      ms.push(out.m);
      result = out.result;
    }
    const last = ms[ms.length - 1];
    const wall = ms.map((m) => m.wallMs).sort((a, b) => a - b)[Math.floor(runs / 2)];
    const row: Row = {
      scenario,
      runs,
      note: opts.note,
      budget: opts.budget,
      statements: last.statements,
      transactions: last.transactions,
      dbMs: last.dbMs,
      wallMs: wall,
      byClient: last.byClient,
      slowest: last.slowest.map((q) => ({ ms: q.durationMs, sql: q.query.slice(0, 300) })),
      ...txBreakdown(),
      byTable: statementsByTable(),
      outcome: opts.outcome?.(result),
    };
    // Los conteos tienen que ser estables entre corridas: si no, el techo mide ruido.
    const counts = new Set(ms.map((m) => m.statements));
    if (counts.size > 1) row.note = `${row.note ?? ""} conteo inestable: ${[...counts].join("/")}`.trim();
    rows.push(row);
    expect(row.statements).toBeGreaterThan(0);
    return { ...row, result };
  }
  const noPrep = async () => undefined;

  const okOf = (r: { ok: boolean; error?: string; kind?: string } & Record<string, unknown>) =>
    r.ok ? "ok" : `error: ${r.kind ?? r.error ?? "?"}${["conflict", "outOfHours", "blocked"].filter((k) => r[k]).map((k) => ` [${k}]`).join("")}`;

  // ── Planes: alta ────────────────────────────────────────────────────────────

  /** Borrador de 20 filas Lun/Mié/Vie 10:00 en Gimnasio, arrancando la semana que viene (la grilla cargada). */
  const draft = (patientId: string): PlanCreateInput => ({
    idempotencyKey: randomUUID(),
    patientId,
    discipline: "KINESIOLOGY",
    practitionerId: T.gymPractitionerIds[0],
    serviceId: T.gymServiceId,
    locationId: null,
    title: "Plan perf S26s",
    schedule: {
      v: 1,
      frequency: "weekly",
      slots: [
        { dow: 1, startMin: 600 },
        { dow: 3, startMin: 600 },
        { dow: 5, startMin: 600 },
      ],
    },
    startDayKey: addDays(monday, 7),
    totalSessions: 20,
    pricing: null,
    rows: [],
    stateToken: "x",
  });

  it("previewPlan — 20 filas sobre la grilla cargada: ≤ 30 sentencias", async () => {
    const r = await bench("p.previewPlan.20", async () => draft(nextFree()), (d) => previewPlan(d), {
      budget: BUDGET.previewPlan,
      outcome: (x) => (x.ok ? `ok: ${x.preview.rows.length} filas` : okOf(x as never)),
    });
    expect(r.result.ok).toBe(true);
    if (r.result.ok) expect(r.result.preview.rows).toHaveLength(20);
    expect(r.statements).toBeLessThanOrEqual(BUDGET.previewPlan);
  });

  it("createPlan — 20 filas con turno: ≤ 60 sentencias en 1 sola tx", async () => {
    const r = await bench(
      "p.createPlan.20",
      async () => {
        const d = draft(nextFree());
        const pv = await previewPlan(d);
        if (!pv.ok) throw new Error(`preview: ${pv.error}`);
        return { ...d, stateToken: pv.preview.stateToken, rows: acceptDefaults(pv.preview) };
      },
      (input) => createPlan(input),
      {
        budget: BUDGET.createPlanInTx,
        note: "inTx = sentencias entre BEGIN y COMMIT; fuera = getActor + post-commit (realtime/notify)",
        outcome: (x) => (x.ok ? `ok${x.idempotent ? " (idempotente)" : ""}` : okOf(x as never)),
      },
    );
    expect(r.result).toMatchObject({ ok: true, idempotent: false });
    // Efecto observable: el plan quedó con sus 20 sesiones y 20 turnos.
    if (r.result.ok) {
      expect(await db.session.count({ where: { programId: r.result.programId, archivedAt: null } })).toBe(20);
      expect(await db.booking.count({ where: { programId: r.result.programId, status: { not: "CANCELLED" } } })).toBe(20);
    }
    expect(r.transactions).toBe(BUDGET.createPlanTx);
    expect(r.inTx).toHaveLength(1);
    expect(r.inTx![0]).toBeLessThanOrEqual(BUDGET.createPlanInTx);
  });

  // ── Planes: lectura ─────────────────────────────────────────────────────────

  it("getPlanDetail — plan de 20 sesiones vinculadas: techo medido", async () => {
    const programId = seeded[1].programId;
    const r = await bench("p.getPlanDetail.20", noPrep, () => getPlanDetail({ programId }), {
      budget: BUDGET.getPlanDetail,
      outcome: (x) => (x.ok ? "ok" : `error: ${(x as { error?: string }).error}`),
    });
    expect(r.result.ok).toBe(true);
    expect(r.statements).toBeLessThanOrEqual(BUDGET.getPlanDetail);
    // Sin N+1: un plan con otra cantidad de turnos vinculados cuesta lo mismo.
    const other = seeded.find((s) => s.linked !== seeded[1].linked) ?? seeded[2];
    const { m } = await measure(() => getPlanDetail({ programId: other.programId }));
    expect(m.statements).toBe(r.statements);
  });

  it("listOpenSessions — 150 planes × 20 sesiones: techo medido (no crece con los planes)", async () => {
    const r = await bench("p.listOpenSessions", noPrep, () => listOpenSessions(), {
      budget: BUDGET.listOpenSessions,
      outcome: (x) => Object.entries(x as Record<string, unknown>).map(([k, v]) => `${k}=${Array.isArray(v) ? v.length : typeof v}`).join(" "),
    });
    expect(r.statements).toBeLessThanOrEqual(BUDGET.listOpenSessions);
  });

  // ── Pacientes ───────────────────────────────────────────────────────────────

  it("listPatients — 1.000 pacientes, 150 con plan (groupBy de S32): techo medido", async () => {
    const r = await bench("p.listPatients", noPrep, () => listPatients(), {
      budget: BUDGET.listPatients,
      outcome: (x) => `${x.length} filas`,
    });
    expect(r.result.length).toBeGreaterThanOrEqual(1000);
    expect(r.statements).toBeLessThanOrEqual(BUDGET.listPatients);
  });

  // ── Agenda con turnos de plan: ≤ +5 % contra la misma agenda sin planes ────

  /**
   * Techo: la línea de base de ESTA corrida (sin planes, medida en beforeAll) +5 %
   * y, como red contra una regresión ajena a Planes, la fila versionada de
   * `agenda-multi.json` (B4.6) +5 %. Con ~15 sentencias, +5 % es 0 sentencias
   * de más: cualquier query nueva por turno de plan lo rompe, que es la idea.
   */
  const agendaCeiling = (name: string, refScenario: string) => {
    const local = agendaNoPlans.get(name);
    const ref = agendaRef.get(refScenario);
    if (!local) throw new Error(`falta la línea de base sin planes de ${name}`);
    if (!ref) throw new Error(`falta ${refScenario} en tests/perf/agenda-multi.json`);
    const pct = (n: number) => Math.floor(n * (1 + BUDGET.agendaPct));
    return { local, ref, ceiling: pct(local.statements), refCeiling: pct(ref.statements) };
  };
  let agendaWithPlans: Row | null = null;

  it("listAgendaBookings — semana con 226 turnos de plan: la proyección C9 es constante (sin N+1 por turno)", async () => {
    const { local, ref } = agendaCeiling("listAgendaBookings", "a.listAgendaBookings.week");
    const r = await bench("p.agenda.listAgendaBookings.week", noPrep, () => listAgendaBookings({ from: weekFrom, to: weekTo }), {
      budget: local.statements + BUDGET.agendaPlanProjection,
      note: `sin planes en esta corrida: ${local.statements} st / ${local.wallMs} ms`,
      outcome: (x) => `${x.length} filas, ${x.filter((b) => (b as { programId?: string | null }).programId).length} de plan`,
    });
    rows[rows.length - 1].ref = { file: "agenda-multi.json", scenario: "a.listAgendaBookings.week", ...ref };
    agendaWithPlans = r;
    // La proyección de C9 (S12p) son queries PLANAS sobre las filas ya leídas: un
    // número fijo de sentencias, no una por turno de plan.
    expect(r.statements).toBeLessThanOrEqual(local.statements + BUDGET.agendaPlanProjection);
    expect(r.transactions).toBe(local.transactions);
    // Con 2 profesionales (menos turnos de plan en la grilla) cuesta lo mismo.
    const { m } = await measure(() =>
      listAgendaBookings({ from: weekFrom, to: weekTo, practitionerIds: [T.gymPractitionerIds[0], T.osteoPractitionerIds[0]] }),
    );
    expect(m.statements).toBe(r.statements);
  });

  it("[ES4-S26s] listAgendaBookings con turnos de plan: ≤ +5 % contra la misma semana sin planes", async () => {
    const { ceiling, refCeiling } = agendaCeiling("listAgendaBookings", "a.listAgendaBookings.week");
    expect(agendaWithPlans).not.toBeNull();
    expect(agendaWithPlans!.statements).toBeLessThanOrEqual(ceiling);
    expect(agendaWithPlans!.statements).toBeLessThanOrEqual(refCeiling);
  });

  it("getAgendaAvailability — semana con turnos de plan: ≤ +5 % (sin planes y agenda-multi)", async () => {
    const { local, ref, ceiling, refCeiling } = agendaCeiling("getAgendaAvailability", "b.getAgendaAvailability.week");
    const r = await bench("p.agenda.getAgendaAvailability.week", noPrep, () => getAgendaAvailability({ from: monday, to: addDays(monday, 6) }), {
      budget: Math.min(ceiling, refCeiling),
      note: `sin planes en esta corrida: ${local.statements} st / ${local.wallMs} ms`,
      outcome: (x) => (x.ok ? "ok" : "error"),
    });
    rows[rows.length - 1].ref = { file: "agenda-multi.json", scenario: "b.getAgendaAvailability.week", ...ref };
    expect(r.statements).toBeLessThanOrEqual(ceiling);
    expect(r.statements).toBeLessThanOrEqual(refCeiling);
  });

  // ── updateBooking (AUDIT ev2-perf-update-booking) ───────────────────────────

  /** Turno suelto nuevo (insert del owner) para que cada corrida mueva uno distinto. */
  const looseBooking = async (k: number, patientId = nextFree()) =>
    db.booking.create({
      data: {
        tenantId: T.tenantId,
        patientId,
        practitionerId: T.gymPractitionerIds[1],
        serviceId: T.gymServiceId,
        scheduledFor: new Date(localToARIso(`${addDays(monday, 8 + k)}T09:00:00`)),
        durationMin: 60,
        idempotencyKey: randomUUID(),
        status: "CONFIRMED",
      },
      select: { id: true, updatedAt: true },
    });

  it("updateBooking — reprogramar un turno suelto: techo medido", async () => {
    const r = await bench(
      "f.updateBooking.reschedule",
      async (k) => ({ b: await looseBooking(k), k }),
      ({ b, k }) =>
        updateBooking({
          id: b.id,
          scheduledFor: new Date(localToARIso(`${addDays(monday, 8 + k)}T11:00:00`)).toISOString(),
          expectedUpdatedAt: b.updatedAt.toISOString(),
        }),
      { budget: BUDGET.updateBookingReschedule, outcome: okOf as never },
    );
    expect(r.result.ok).toBe(true);
    expect(r.statements).toBeLessThanOrEqual(BUDGET.updateBookingReschedule);
  });

  it("updateBooking — reprogramar un turno de plan (sincroniza la sesión): techo medido", async () => {
    // Un plan sembrado distinto por corrida; se mueve su turno vivo más tardío una hora.
    const r = await bench(
      "f.updateBooking.plan.reschedule",
      async (k) => {
        const b = await db.booking.findFirstOrThrow({
          where: { programId: seeded[10 + k].programId, status: "CONFIRMED", scheduledFor: { gt: weekTo } },
          orderBy: { scheduledFor: "desc" },
          select: { id: true, updatedAt: true, scheduledFor: true },
        });
        return b;
      },
      (b) =>
        updateBooking({
          id: b.id,
          scheduledFor: new Date(b.scheduledFor.getTime() + 60 * 60_000).toISOString(),
          expectedUpdatedAt: b.updatedAt.toISOString(),
          allowOutOfHours: true,
          allowOverbooking: true,
          allowPatientOverlap: true,
        }),
      { budget: BUDGET.updateBookingPlan, outcome: okOf as never },
    );
    expect(r.result.ok).toBe(true);
    expect(r.statements).toBeLessThanOrEqual(BUDGET.updateBookingPlan);
  });

  it("updateBooking — cambiar el paciente (chequeo de evolución al re-vincular): techo medido", async () => {
    const r = await bench(
      "f.updateBooking.patientChange",
      async (k) => ({ b: await looseBooking(10 + k), to: nextFree() }),
      ({ b, to }) => updateBooking({ id: b.id, patientId: to, expectedUpdatedAt: b.updatedAt.toISOString() }),
      { budget: BUDGET.updateBookingPatient, outcome: okOf as never },
    );
    expect(r.result.ok).toBe(true);
    expect(r.statements).toBeLessThanOrEqual(BUDGET.updateBookingPatient);
  });

  // ── Portal ──────────────────────────────────────────────────────────────────

  it("[ES4-S26s] requirePortalPatient: ≤ 3 sentencias (P4.Z: los entitlements van en la lectura del Tenant)", async () => {
    asUser(portalUserId);
    try {
      const slug = (await db.tenant.findUniqueOrThrow({ where: { id: T.tenantId }, select: { slug: true } })).slug;
      const r = await bench("portal.requirePortalPatient", noPrep, () => requirePortalPatient(slug), {
        budget: BUDGET.requirePortalPatient,
        outcome: (x) => (x ? "ok" : "null"),
      });
      expect(r.result).not.toBeNull();
      expect(r.statements).toBeLessThanOrEqual(BUDGET.requirePortalPatient);
    } finally {
      asUser(T.userId);
    }
  });

  it("[ES4-S26s] /portal home: ≤ 1 sentencia por consultorio vinculado (P4.Z: planes y turnos en lote)", async () => {
    asUser(portalUserId);
    try {
      const measured: { n: number; statements: number; tenantReads: number }[] = [];
      for (let n = 1; n <= 3; n++) {
        if (n > 1) {
          const { patientId } = extraPatients[n - 2];
          await db.patient.update({ where: { id: patientId }, data: { userId: portalUserId } });
        }
        const r = await bench(`portal.home.${n}`, noPrep, () => getPortalAuth(), {
          outcome: (x) => (x.signedIn ? `${x.patients.length} fichas` : "sin sesión"),
        });
        expect(r.result).toMatchObject({ signedIn: true });
        if (r.result.signedIn) expect(r.result.patients).toHaveLength(n);
        measured.push({ n, statements: r.statements, tenantReads: r.byTable?.["SELECT Tenant"] ?? 0 });
      }
      const perTenant = (measured[2].statements - measured[0].statements) / 2;
      rows[rows.length - 1].note = `marginal por consultorio: ${perTenant} sentencias (${measured.map((m) => `${m.n}→${m.statements}`).join(", ")})`;
      console.log(`[perf S26s] portal home ${rows[rows.length - 1].note}`);
      expect(perTenant).toBeLessThanOrEqual(BUDGET.portalPerTenant);
    } finally {
      asUser(T.userId);
    }
  });
});
