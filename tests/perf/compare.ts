/**
 * Compara una corrida de perf contra el baseline versionado (P0-Ct, C14 de
 * .docs/PLANES.md).
 *
 * Por qué: hasta P0 los tests de perf REGRABABAN los JSON versionados
 * (`loaders.perf` pisaba `baseline.json`), así que medir ensuciaba el árbol y
 * el número de referencia se movía solo. Ahora se mide a un directorio aparte
 * y este script decide si hubo regresión:
 *
 *   PERF_OUT_DIR=<scratchpad> npm run test:perf
 *   npx tsx tests/perf/compare.ts <scratchpad>
 *
 * Referencia: las filas de `tests/perf/baseline.json` (A1) y, para los
 * escenarios de agenda que A1 no tenía (`listAgendaBookings`…), las de
 * `tests/perf/agenda-multi.json` (B4.6), ambos versionados. Se empareja por
 * nombre de escenario EXACTO: `f.createBooking` (34 statements, con motor y
 * lock de cupo) no se compara contra el `createBooking` de A1 (12), que mide
 * otro camino; esa comparación cruzada ya la informa agenda-multi en `vsA1`.
 * OJO: `loaders.perf` sigue midiendo `createBooking` con ese MISMO nombre (hoy
 * con motor y lock), así que el nombre exacto no alcanzaba para evitar el
 * cruce: lo resuelve `REFERENCE_ERRATA`.
 *
 * Reglas:
 *   - write-paths de turnos (`createBooking*`, `updateBooking*` y el batch
 *     `createBookingsBatch*`): statements y transactions ≤ baseline (estricto:
 *     cada sentencia de más es un round-trip dentro del lock de cupo);
 *   - `listAgendaBookings*` y `listOpenSessions*`: statements ≤ baseline +10 %;
 *   - el resto de los escenarios y `wallMs` son informativos (el wall-clock de
 *     una laptop no es reproducible);
 *   - escenarios nuevos (sin referencia) se reportan, no fallan;
 *   - `REFERENCE_ERRATA` corrige filas versionadas que quedaron viejas respecto
 *     de HEAD (ver abajo): no se regraban los JSON, se documenta el desvío.
 * Sale con 1 si alguna regla falla y con 2 si no hay nada que comparar.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export type PerfRow = { scenario: string; statements: number; transactions: number; wallMs?: number };
export type Rule = "strict" | "plus10" | "info";
export type Verdict = {
  scenario: string;
  rule: Rule;
  status: "ok" | "fail" | "new" | "info";
  base?: PerfRow;
  now: PerfRow;
  reason?: string;
};

/** Archivos versionados que hacen de referencia (en este orden; el primero gana si se repite un escenario). */
export const REFERENCE_FILES = ["baseline.json", "agenda-multi.json"] as const;

const STRICT = /(^|\.)(createBooking|updateBooking|createBookingsBatch)(\.|$)/;
const PLUS10 = /(^|\.)(listAgendaBookings|listOpenSessions)(\.|$)/;

export function ruleFor(scenario: string): Rule {
  if (STRICT.test(scenario)) return "strict";
  if (PLUS10.test(scenario)) return "plus10";
  return "info";
}

/**
 * Fe de erratas de la referencia versionada (fixer 3 del cierre de ES1,
 * 2026-10-04). Los JSON NO se regraban (P0-Ct: medir no ensucia el árbol y el
 * número de referencia no se mueve solo); cuando una fila versionada quedó
 * vieja respecto de HEAD por un cambio ya commiteado, se corrige ACÁ, con el
 * porqué y la evidencia, y la regla estricta sigue valiendo sobre el resto.
 *
 * Evidencia: el árbol de HEAD 3ff2e50 (B-pre) extraído con `git archive` y
 * medido con la misma suite el 2026-10-04 da exactamente las cifras de abajo,
 * con las MISMAS sentencias que el árbol de ES1 (el único cambio en el SQL es
 * el texto del lock de cupo de S07i, 1 sentencia → 1 sentencia).
 *
 *   - `createBooking` / `createBookingsBatch.20` de `baseline.json` son de A1
 *     (cd4de04), ANTES de B-pre: miden el camino sin motor de disponibilidad,
 *     sin lock de cupo y sin re-chequeo de bloqueos. `loaders.perf` sigue
 *     emitiendo esos nombres exactos, así que el emparejamiento por nombre los
 *     comparaba contra 12/68 (HEAD da 31/5 y 144/22: preexistente desde B-pre,
 *     no regresión de ES1). Quedan informativos: el techo estricto de ese
 *     mismo código lo ponen las filas `f.*` de agenda-multi (B4.6).
 *   - Las filas `f.createBooking*` / `f.createBookingsBatch.20*` de
 *     `agenda-multi.json` se grabaron (2026-10-01T02:32Z) antes del
 *     "integrador final de B-pre", que agregó `liveBlocksInTx` (lib/bookings.ts:
 *     re-lectura de bloqueos con el lock de cupo tomado, TOCTOU contra un
 *     candado commiteado después del preflight): +1 sentencia por tx de
 *     escritura = +1 en el alta simple y +20 en el batch de 20. Es seguridad
 *     de agenda y no se saca; se suma a la referencia.
 *
 * Si alguien regraba los JSON versionados con HEAD, estas entradas sobran y se
 * borran (con el delta ya incluido, dejarlas aflojaría el techo).
 */
export const REFERENCE_ERRATA: Readonly<Record<string, { statements?: number; info?: true; why: string }>> = {
  createBooking: { info: true, why: "fila A1 previa a B-pre (sin motor/lock); techo real: f.createBooking" },
  "createBookingsBatch.20": { info: true, why: "fila A1 previa a B-pre (sin motor/lock); techo real: f.createBookingsBatch.20" },
  "f.createBooking": { statements: 1, why: "liveBlocksInTx (integrador final de B-pre) posterior a agenda-multi.json" },
  "f.createBooking.gym.busyWeek": { statements: 1, why: "liveBlocksInTx (integrador final de B-pre) posterior a agenda-multi.json" },
  "f.createBooking.osteo.conflict": { statements: 1, why: "liveBlocksInTx (integrador final de B-pre) posterior a agenda-multi.json" },
  "f.createBookingsBatch.20": { statements: 20, why: "liveBlocksInTx ×20 (integrador final de B-pre) posterior a agenda-multi.json" },
  "f.createBookingsBatch.20.gym.busy": { statements: 20, why: "liveBlocksInTx ×20 (integrador final de B-pre) posterior a agenda-multi.json" },
};

/** Compara las filas medidas contra la referencia. Puro: lo usa el CLI de abajo. */
export function compareRows(
  reference: Map<string, PerfRow>,
  measured: PerfRow[],
  errata: Readonly<Record<string, { statements?: number; info?: true; why: string }>> = REFERENCE_ERRATA,
): Verdict[] {
  return measured.map((now) => {
    const fix = errata[now.scenario];
    const rule = fix?.info ? "info" : ruleFor(now.scenario);
    const raw = reference.get(now.scenario);
    if (!raw) return { scenario: now.scenario, rule, status: "new", now };
    const base = fix?.statements ? { ...raw, statements: raw.statements + fix.statements } : raw;
    if (fix?.info) return { scenario: now.scenario, rule, status: "info", base, now, reason: `errata: ${fix.why}` };
    if (rule === "strict") {
      const bad: string[] = [];
      if (now.statements > base.statements) bad.push(`statements ${base.statements} → ${now.statements}`);
      if (now.transactions > base.transactions) bad.push(`transactions ${base.transactions} → ${now.transactions}`);
      const note = fix?.statements ? ` (referencia +${fix.statements} por errata: ${fix.why})` : "";
      return bad.length
        ? { scenario: now.scenario, rule, status: "fail", base, now, reason: bad.join(", ") + note }
        : { scenario: now.scenario, rule, status: "ok", base, now, ...(note ? { reason: note.trim() } : {}) };
    }
    if (rule === "plus10") {
      // +10 % sobre un entero: con 15 statements el techo es 16 (16,5 → piso).
      const ceiling = Math.floor(base.statements * 1.1);
      return now.statements > ceiling
        ? { scenario: now.scenario, rule, status: "fail", base, now, reason: `statements ${base.statements} → ${now.statements} (techo ${ceiling})` }
        : { scenario: now.scenario, rule, status: "ok", base, now };
    }
    return { scenario: now.scenario, rule, status: "info", base, now };
  });
}

function readRows(file: string): PerfRow[] | null {
  try {
    const json = JSON.parse(readFileSync(file, "utf8")) as { rows?: unknown };
    if (!Array.isArray(json.rows)) return null;
    return (json.rows as PerfRow[]).filter((r) => typeof r?.scenario === "string" && typeof r.statements === "number");
  } catch {
    return null;
  }
}

function loadReference(dir: string): Map<string, PerfRow> {
  const ref = new Map<string, PerfRow>();
  for (const f of REFERENCE_FILES) {
    for (const r of readRows(join(dir, f)) ?? []) if (!ref.has(r.scenario)) ref.set(r.scenario, r);
  }
  return ref;
}

function delta(a: number | undefined, b: number | undefined): string {
  if (a == null || b == null) return "";
  const d = b - a;
  return d === 0 ? "=" : d > 0 ? `+${d}` : `${d}`;
}

function main(argv: string[]): number {
  const outDir = argv[0];
  if (!outDir) {
    console.error("uso: npx tsx tests/perf/compare.ts <PERF_OUT_DIR> [<dir de referencia, default tests/perf>]");
    return 2;
  }
  const refDir = argv[1] ?? "tests/perf";
  if (resolve(outDir) === resolve(refDir)) {
    // Sería comparar el versionado contra sí mismo (o contra lo que se acaba de regrabar encima).
    console.error(`compare: PERF_OUT_DIR (${outDir}) es el mismo directorio que la referencia; medí con PERF_OUT_DIR=<scratchpad>.`);
    return 2;
  }
  const reference = loadReference(refDir);
  const files = existsSync(outDir) ? readdirSync(outDir).filter((f) => f.endsWith(".json")).sort() : [];
  const measured: PerfRow[] = [];
  for (const f of files) {
    const rows = readRows(join(outDir, f));
    if (rows) measured.push(...rows);
  }

  // pool-pressure no tiene filas: se informa p95/errores contra el versionado, sin regla.
  const pool = join(outDir, "pool-pressure.json");
  if (existsSync(pool)) {
    try {
      const now = JSON.parse(readFileSync(pool, "utf8")) as { p95Ms?: number; errors?: unknown[] };
      const basePath = join(refDir, "pool-pressure.json");
      const base = existsSync(basePath) ? (JSON.parse(readFileSync(basePath, "utf8")) as { p95Ms?: number }) : {};
      console.log(
        `[info] pool-pressure: p95 ${base.p95Ms ?? "?"} → ${now.p95Ms ?? "?"} ms, errores: ${now.errors?.length ?? 0}`,
      );
    } catch {
      console.log("[info] pool-pressure.json ilegible");
    }
  }

  if (measured.length === 0) {
    console.error(`compare: no hay filas de perf en ${outDir} (¿corriste con PERF_OUT_DIR=${outDir}?)`);
    return 2;
  }

  const verdicts = compareRows(reference, measured);
  console.table(
    verdicts.map((v) => ({
      escenario: v.scenario,
      regla: v.rule,
      estado: v.status.toUpperCase(),
      st: `${v.base?.statements ?? "-"} → ${v.now.statements} (${delta(v.base?.statements, v.now.statements)})`,
      tx: `${v.base?.transactions ?? "-"} → ${v.now.transactions} (${delta(v.base?.transactions, v.now.transactions)})`,
      wallMs: `${v.base?.wallMs ?? "-"} → ${v.now.wallMs ?? "-"}`,
      errata: REFERENCE_ERRATA[v.scenario] ? (REFERENCE_ERRATA[v.scenario].info ? "info" : `+${REFERENCE_ERRATA[v.scenario].statements}`) : "",
    })),
  );
  const fails = verdicts.filter((v) => v.status === "fail");
  const news = verdicts.filter((v) => v.status === "new");
  if (news.length) console.log(`[nuevo] sin referencia (no falla): ${news.map((v) => v.scenario).join(", ")}`);
  if (fails.length) {
    for (const v of fails) console.error(`[FALLA] ${v.scenario} (${v.rule}): ${v.reason}`);
    console.error(`compare: ${fails.length} regresión(es) fuera de umbral (${basename(resolve(outDir))} vs ${refDir}).`);
    return 1;
  }
  console.log(`compare: sin regresiones fuera de umbral (${verdicts.length} escenarios, ${news.length} nuevos).`);
  return 0;
}

// CLI solo cuando se ejecuta directo (`npx tsx tests/perf/compare.ts …`), no al importarlo.
if (process.argv[1] && /compare\.ts$/.test(process.argv[1])) {
  process.exit(main(process.argv.slice(2)));
}
