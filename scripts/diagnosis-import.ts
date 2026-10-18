/**
 * Import de la CIE-11 MMS en español (FC-1d, C-FC11): SimpleTabulation de la
 * OMS (TSV/TXT) → `DiagnosisCode` (GLOBAL_READONLY, M14).
 *
 * Por qué un script y no una migración: la OMS publica una release por año y
 * el archivo no se versiona en el repo (licencia CC BY-ND 3.0 IGO: se usa la
 * versión oficial tal cual; vive en `data/icd11/`, ignorado). Re-correrlo
 * tiene que ser seguro: la decisión es pura y está testeada en
 * `lib/diagnoses-import-core.ts`; acá solo se lee el archivo y la base, se
 * imprime el plan y (con `--apply`) se escribe. La licencia NO pide aviso ni
 * respuesta de la OMS (Enmiendas de Martin, 19-oct): el import no espera nada.
 *
 * Seguridad (lo corre Martin; el agente solo contra el Docker local):
 *  - DRY-RUN por defecto. Para escribir: `--apply --by=<nombre>` (el nombre
 *    queda en `CatalogImportRun.ranBy`; sin él no se escribe).
 *  - `--inspect`: solo lee el archivo (encoding, encabezados, 5 filas); no se
 *    conecta a ninguna base.
 *  - `assertSafeTarget`: local libre; remoto solo con
 *    `KINESOFT_CONFIRM_PROD=<projectRef>` (también el dry-run: lee prod).
 *  - Canal owner/BYPASSRLS: `DiagnosisCode` es `FOR SELECT USING (true)` bajo
 *    RLS, el rol de la app no puede escribirla. Usa `DIRECT_URL` (owner) y, si
 *    falta, `DATABASE_URL`; verifica `rolbypassrls` y aborta si no.
 *  - `--apply` en UNA tx de hasta 10 min, con advisory lock (dos imports a la
 *    vez se serializan) y el plan RE-CALCULADO adentro. Altas y cambios en lotes
 *    de 1000 (~17k filas: una sentencia por fila contra un remoto no entra en
 *    los 10 min). Registra un `CatalogImportRun` (`icd11-mms-es@<release>`,
 *    sha256 del archivo tal cual vino).
 *  - Nunca borra: lo que deja de venir se retira (`retiredAt`,
 *    `retiredInRelease`); lo retirado que vuelve se reactiva.
 *  - Downgrade (release más vieja que la de la base) rechazado salvo
 *    `--allow-downgrade`.
 *
 * Uso:
 *   npm run diagnosis:import -- --file=data/icd11/SimpleTabulation-ICD-11-MMS-es.txt --release=2025-01 --inspect
 *   npm run diagnosis:import -- --file=… --release=2025-01                 # local, dry-run
 *   npm run diagnosis:import -- --file=… --release=2025-01 --apply --by=martin
 *   [--chapters=01-26,V] [--allow-downgrade]
 * Prod (después del deploy de M14; backup antes; primero dry-run):
 *   KINESOFT_CONFIRM_PROD=<ref> npx dotenv -e .env.prod.local -- npx tsx scripts/diagnosis-import.ts --file=… --release=…
 *   KINESOFT_CONFIRM_PROD=<ref> npx dotenv -e .env.prod.local -- npx tsx scripts/diagnosis-import.ts --file=… --release=… --apply --by=martin
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  DEFAULT_ICD_CHAPTERS,
  ICD_RELEASE_RE,
  IcdImportError,
  decodeTabulationBytes,
  icdImportKind,
  icdPlanHasChanges,
  inspectTabulation,
  parseChapterSpec,
  parseIcdTabulation,
  planIcdImport,
  summarizeIcdPlan,
  type ExistingDiagnosisCode,
  type IcdImportPlan,
  type IcdTarget,
  type IcdUpdate,
} from "../lib/diagnoses-import-core";
import { assertSafeTarget, type TargetDescription } from "./lib/assert-safe-target";

type Db = Prisma.TransactionClient | PrismaClient;

const SCRIPT = "diagnosis-import";
export const ICD_BATCH_SIZE = 1000;
/** Mismo número en cualquier corrida: serializa dos imports concurrentes (lock de la tx, se suelta solo). */
const ADVISORY_LOCK_KEY = "kinesoft:diagnosis-import";

/** El import escribe una tabla GLOBAL_READONLY bajo RLS: exige BYPASSRLS. */
export async function assertBypassRls(db: Db): Promise<void> {
  const [role] = await db.$queryRaw<{ bypass: boolean }[]>`
    SELECT (rolbypassrls OR rolsuper) AS bypass FROM pg_roles WHERE rolname = current_user`;
  if (!role?.bypass) {
    throw new IcdImportError(
      "la conexión no tiene BYPASSRLS: DiagnosisCode es de solo lectura para el rol de la app. Usá la URL owner (DIRECT_URL).",
    );
  }
}

/**
 * Elige la conexión (owner primero) y valida el destino. Se imprime el NOMBRE
 * de la variable, nunca el valor.
 */
export function resolveImportTarget(
  env: Record<string, string | undefined>,
  log: (m: string) => void = console.log,
): { url: string; envName: string; target: TargetDescription } {
  const envName = env.DIRECT_URL ? "DIRECT_URL" : "DATABASE_URL";
  const url = env[envName];
  log(`[${SCRIPT}] conexión: ${envName}`);
  const target = assertSafeTarget({ url, allowRemote: true, confirm: env.KINESOFT_CONFIRM_PROD, scriptName: SCRIPT, log });
  return { url: url!, envName, target };
}

// ─── Lectura ────────────────────────────────────────────────────────────────

export async function loadExistingCodes(db: Db, scope?: { codePrefix: string }): Promise<ExistingDiagnosisCode[]> {
  return db.diagnosisCode.findMany({
    where: { system: "ICD11_MMS", ...(scope ? { code: { startsWith: scope.codePrefix } } : {}) },
    select: {
      id: true,
      code: true,
      title: true,
      uri: true,
      foundationUri: true,
      chapter: true,
      isLeaf: true,
      isResidual: true,
      release: true,
      searchText: true,
      retiredAt: true,
      retiredInRelease: true,
    },
  });
}

// ─── Escritura ──────────────────────────────────────────────────────────────

function chunks<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/**
 * Cambios y reactivaciones en lotes: un UPDATE … FROM unnest(...) por cada
 * 1000 filas. Reactivar = mismos valores + `retiredAt`/`retiredInRelease` en
 * null; actualizar una vigente también los deja en null (ya lo estaban).
 */
async function updateBatch(db: Db, rows: IcdUpdate[], now: Date): Promise<number> {
  if (rows.length === 0) return 0;
  const col = <K extends keyof IcdTarget>(k: K) => rows.map((r) => r.target[k]);
  return db.$executeRaw`
    UPDATE "DiagnosisCode" AS d SET
      "title" = v.title, "uri" = v.uri, "foundationUri" = v."foundationUri", "chapter" = v.chapter,
      "isLeaf" = v."isLeaf", "isResidual" = v."isResidual", "release" = v.release, "searchText" = v."searchText",
      "retiredAt" = NULL, "retiredInRelease" = NULL, "updatedAt" = ${now}
    FROM unnest(
      ${rows.map((r) => r.id)}::text[], ${col("title")}::text[], ${col("uri")}::text[], ${col("foundationUri")}::text[],
      ${col("chapter")}::text[], ${col("isLeaf")}::boolean[], ${col("isResidual")}::boolean[], ${col("release")}::text[],
      ${col("searchText")}::text[]
    ) AS v(id, title, uri, "foundationUri", chapter, "isLeaf", "isResidual", release, "searchText")
    WHERE d.id = v.id AND d.system = 'ICD11_MMS'`;
}

export type IcdApplyResult = { created: number; updated: number; retired: number; unretired: number };

export async function applyIcdPlan(db: Db, p: IcdImportPlan, now: Date): Promise<IcdApplyResult> {
  let created = 0;
  for (const batch of chunks(p.create, ICD_BATCH_SIZE)) {
    // Sin skipDuplicates: un código que apareció entre el plan y la escritura
    // es imposible con el advisory lock; si pasa igual, que la tx explote.
    const r = await db.diagnosisCode.createMany({
      data: batch.map((t) => ({ system: "ICD11_MMS" as const, language: "es", ...t })),
    });
    created += r.count;
  }
  let updated = 0;
  for (const batch of chunks(p.update, ICD_BATCH_SIZE)) updated += await updateBatch(db, batch, now);
  let unretired = 0;
  for (const batch of chunks(p.unretire, ICD_BATCH_SIZE)) unretired += await updateBatch(db, batch, now);
  let retired = 0;
  for (const batch of chunks(p.retire, ICD_BATCH_SIZE)) {
    const r = await db.diagnosisCode.updateMany({
      where: { id: { in: batch.map((x) => x.id) }, system: "ICD11_MMS", retiredAt: null },
      data: { retiredAt: p.retiredAt, retiredInRelease: p.release },
    });
    retired += r.count;
  }
  const expected = { created: p.create.length, updated: p.update.length, retired: p.retire.length, unretired: p.unretire.length };
  const got = { created, updated, retired, unretired };
  // El plan se hizo dentro de la misma tx y con el lock: cualquier diferencia
  // es un bug, no una carrera. Se aborta todo antes que dejar media release.
  if (JSON.stringify(expected) !== JSON.stringify(got)) {
    throw new IcdImportError(`la escritura no coincide con el plan: esperado ${JSON.stringify(expected)}, escrito ${JSON.stringify(got)}`);
  }
  return got;
}

// ─── Orquestación ───────────────────────────────────────────────────────────

export type IcdRunOptions = {
  db: PrismaClient;
  file: string;
  release: string;
  chapters?: string;
  apply: boolean;
  allowDowngrade?: boolean;
  ranBy?: string | null;
  now?: Date;
  log?: (msg: string) => void;
  /**
   * SOLO para los tests de integración contra la base local compartida: limita
   * lo «existente» a un prefijo de código para no retirar filas ajenas al
   * fixture. El CLI no lo expone (en prod el alcance es la tabla entera).
   */
  existingScope?: { codePrefix: string };
};

export type IcdRunResult = {
  applied: boolean;
  plan: IcdImportPlan;
  sha256: string;
  encoding: string;
  result: IcdApplyResult | null;
};

export async function runDiagnosisImport(opts: IcdRunOptions): Promise<IcdRunResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  if (!ICD_RELEASE_RE.test(opts.release)) throw new IcdImportError(`--release inválido «${opts.release}» (AAAA-MM)`);
  if (opts.apply && !opts.ranBy?.trim()) throw new IcdImportError("--apply exige --by=<nombre> (queda en CatalogImportRun.ranBy)");
  const chapters = parseChapterSpec(opts.chapters ?? DEFAULT_ICD_CHAPTERS);
  await assertBypassRls(opts.db);

  // Todo lo que puede abortar por formato pasa ANTES de tocar la base.
  const bytes = readFileSync(opts.file);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const { text, encoding } = decodeTabulationBytes(bytes);
  const { rows } = parseIcdTabulation(text);
  const now = opts.now ?? new Date();
  const planOpts = { release: opts.release, chapters, now, allowDowngrade: opts.allowDowngrade };
  log(`[${SCRIPT}] archivo ${basename(opts.file)} · ${encoding} · sha256 ${sha256.slice(0, 12)}… · ${rows.length} filas`);

  if (!opts.apply) {
    const plan = planIcdImport(rows, await loadExistingCodes(opts.db, opts.existingScope), planOpts);
    printPlan(plan, log);
    log("Dry-run: no se escribió nada. Repetí con --apply --by=<nombre> para escribir.");
    return { applied: false, plan, sha256, encoding, result: null };
  }

  const { plan, result } = await opts.db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ADVISORY_LOCK_KEY}))`;
      // Estado y plan ADENTRO de la tx: se escribe exactamente lo planificado contra la base de este momento.
      const plan = planIcdImport(rows, await loadExistingCodes(tx, opts.existingScope), planOpts);
      const result = await applyIcdPlan(tx, plan, now);
      await tx.catalogImportRun.create({
        data: {
          file: basename(opts.file),
          sha256,
          kind: icdImportKind(opts.release),
          created: result.created,
          updated: result.updated + result.retired + result.unretired,
          skipped: plan.unchanged + plan.excluded,
          conflicts: plan.conflicts as unknown as Prisma.InputJsonValue,
          ranBy: opts.ranBy!.trim(),
        },
      });
      return { plan, result };
    },
    // ~17k filas en una tx contra un remoto: el default (5 s) no alcanza.
    { timeout: 10 * 60_000, maxWait: 30_000 },
  );
  printPlan(plan, log);
  log(
    `✔ ${icdImportKind(opts.release)}: creadas ${result.created}, actualizadas ${result.updated}, retiradas ${result.retired}, reactivadas ${result.unretired}`,
  );
  return { applied: true, plan, sha256, encoding, result };
}

const SAMPLE = 15;

export function printPlan(p: IcdImportPlan, log: (m: string) => void): void {
  const s = summarizeIcdPlan(p);
  log("");
  log(`release ${p.release} · capítulos ${p.chapters.join(",")}`);
  log("crear  actual  retirar  reactivar  igual  fuera  confl");
  log(
    [s.create, s.update, s.retire, s.unretire, s.unchanged, s.excluded, s.conflicts]
      .map((n, i) => String(n).padStart([5, 7, 8, 10, 6, 6, 6][i]))
      .join(" "),
  );
  if (!icdPlanHasChanges(p)) log("Sin cambios.");
  const sample = <T>(label: string, xs: T[], fmt: (x: T) => string) => {
    if (xs.length === 0) return;
    log(`\n${label} (${xs.length}${xs.length > SAMPLE ? `, primeras ${SAMPLE}` : ""}):`);
    for (const x of xs.slice(0, SAMPLE)) log(`  ${fmt(x)}`);
  };
  sample("altas", p.create, (c) => `+ ${c.code} ${c.title}`);
  sample("cambios", p.update, (u) => `~ ${u.code}: ${u.changedFields.join(", ")}`);
  sample("retiros", p.retire, (r) => `- ${r.code} ${r.title}`);
  sample("reactivaciones", p.unretire, (u) => `↺ ${u.code} ${u.target.title}`);
  if (p.conflicts.length > 0) {
    // Los conflictos se imprimen TODOS: son las filas que no se escriben.
    log(`\nCONFLICTOS (${p.conflicts.length}, no se escriben ni se retiran):`);
    for (const c of p.conflicts) log(`  ✖ línea ${c.line} · ${c.code} · ${c.reason}: ${c.detail}`);
  }
  log("");
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const pref = `--${name}=`;
  return process.argv.find((a) => a.startsWith(pref))?.slice(pref.length);
}

async function main() {
  const fileArg = arg("file");
  if (!fileArg) throw new IcdImportError("falta --file=<ruta al TSV/TXT de la OMS> (fuera del repo, p. ej. data/icd11/)");
  const file = resolve(fileArg);
  const rel = relative(process.cwd(), file);
  // El archivo de la OMS no se versiona: dentro del repo solo en data/icd11/ (ignorado) o en los fixtures sintéticos.
  if (!rel.startsWith("..") && !rel.startsWith("data/icd11/") && !rel.startsWith("tests/fixtures/icd11/")) {
    console.log(`⚠ ${rel} está dentro del repo y fuera de data/icd11/ (ignorado): no lo commitees.`);
  }

  if (process.argv.includes("--inspect")) {
    const i = inspectTabulation(readFileSync(file));
    console.log(`[${SCRIPT}] --inspect ${basename(file)} (no se conecta a ninguna base)`);
    console.log(`encoding: ${i.encoding}`);
    console.log(`encabezados (${i.headers.length}): ${i.headers.join(" · ")}`);
    console.log(`columna de URI: ${i.uriHeader}`);
    console.log(`filas: ${i.totalRows} · categorías con código: ${i.categoryRows}`);
    for (const r of i.sample) {
      console.log(`  línea ${r.line} · ${r.classKind || "?"} · ${r.code || "(sin código)"} · cap ${r.chapter ?? "?"} · «${r.title}» · ${r.uri}`);
    }
    return;
  }

  const release = arg("release");
  if (!release) throw new IcdImportError("falta --release=<AAAA-MM> (la release de la tabulación)");
  const apply = process.argv.includes("--apply");
  const { url } = resolveImportTarget(process.env);
  console.log(`[${SCRIPT}] modo: ${apply ? "APPLY (escribe)" : "DRY-RUN (no escribe)"} · release ${release}`);
  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    await runDiagnosisImport({
      db,
      file,
      release,
      chapters: arg("chapters"),
      apply,
      allowDowngrade: process.argv.includes("--allow-downgrade"),
      ranBy: arg("by") ?? null,
    });
  } finally {
    await db.$disconnect();
  }
}

// Importable desde los tests de integración sin disparar el CLI.
if (!process.env.VITEST) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
