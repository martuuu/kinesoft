/**
 * Import del catálogo global (B-pre B1.1): `prisma/catalog/*.csv` →
 * Specialty / Practice / PracticeSpecialty / Payer / PayerPlan (globales).
 *
 * Por qué un script y no una migración: los datos vienen de fuentes oficiales
 * que se actualizan (SSS RNOS/RNEMP, PMO, REFEPS) y Plataforma los cura a mano
 * (B1.3). Re-correrlo tiene que ser seguro: upsert por `slug`, NUNCA pisa una
 * fila curada (`curatedAt != null`, solo le suma alias), los `*.seed-*.csv`
 * son create-only y la segunda corrida da 0 cambios. La lógica de decisión es
 * pura y está testeada en `lib/catalog/import-core.ts`; acá solo se lee la
 * base, se imprime el diff y (con `--apply`) se escribe.
 *
 * Seguridad (lo corre Martin; el agente solo contra el Docker local):
 *  - DRY-RUN por defecto: imprime el diff resumido y los conflictos, no
 *    escribe. Para escribir: `--apply`.
 *  - `assertSafeTarget`: local libre; remoto solo con
 *    `KINESOFT_CONFIRM_PROD=<projectRef>` (también para el dry-run: lee prod).
 *  - Conexión owner/BYPASSRLS: las tablas del catálogo son GLOBAL READ-ONLY
 *    bajo RLS (migración 20260930200000_catalog_global): el rol de la app no
 *    puede escribirlas. Usa `DIRECT_URL` (owner) y, si falta, `DATABASE_URL`;
 *    verifica `rolbypassrls` y aborta si no.
 *  - `--apply` escribe TODO en UNA transacción (re-lee el estado adentro y
 *    re-planifica): o entra el import completo o nada. Registra un
 *    `CatalogImportRun` por archivo (sha256, conteos, conflictos).
 *  - Un error de formato (header que no cumple el contrato, CSV roto) aborta
 *    antes de escribir. Un conflicto de fila (matchKey/alias ambiguo,
 *    referencia desconocida, fila inválida) se reporta y esa fila no se
 *    escribe; el resto sí.
 *
 * Uso:
 *   npm run catalog:import                          # local, dry-run
 *   npm run catalog:import -- --apply               # local, escribe
 *   npm run catalog:import -- --only=payers         # un solo kind (+ su seed)
 *   npm run catalog:import -- --dir=otra/carpeta    # otra carpeta de CSV
 * Prod (backup antes; primero dry-run):
 *   KINESOFT_CONFIRM_PROD=<ref> npx dotenv -e .env.prod.local -- npx tsx scripts/catalog-import.ts
 *   KINESOFT_CONFIRM_PROD=<ref> npx dotenv -e .env.prod.local -- npx tsx scripts/catalog-import.ts --apply
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PrismaClient, type Prisma } from "@prisma/client";
import {
  CATALOG_KINDS,
  classifyCatalogFile,
  orderCatalogFiles,
  planCatalogImport,
  summarizeDiff,
  type CatalogFile,
  type CatalogKind,
  type CatalogState,
  type EntityChanges,
  type EntityDiff,
  type EntityKind,
  type ExistingEntity,
  type FileDiff,
  type LinkDiff,
  type PlanDiff,
} from "../lib/catalog/import-core";
import { assertSafeTarget } from "./lib/assert-safe-target";

type Db = Prisma.TransactionClient;

export const DEFAULT_CATALOG_DIR = "prisma/catalog";

/** El import necesita escribir tablas GLOBAL READ-ONLY bajo RLS: exige BYPASSRLS. */
export async function assertBypassRls(db: Db): Promise<void> {
  const [role] = await db.$queryRaw<{ bypass: boolean }[]>`
    SELECT (rolbypassrls OR rolsuper) AS bypass FROM pg_roles WHERE rolname = current_user`;
  if (!role?.bypass) {
    throw new Error(
      "[catalog-import] la conexión no tiene BYPASSRLS: el catálogo es de solo lectura para el rol de la app. Usá la URL owner (DIRECT_URL).",
    );
  }
}

// ─── Lectura del estado ─────────────────────────────────────────────────────

const commonSelect = {
  id: true,
  slug: true,
  name: true,
  matchKey: true,
  aliases: true,
  source: true,
  sourceRef: true,
  sourceDate: true,
  curatedAt: true,
  archivedAt: true,
} as const;

export async function loadCatalogState(db: Db): Promise<CatalogState> {
  const [specialties, practices, payers, links, plans] = await Promise.all([
    db.specialty.findMany({ select: commonSelect }),
    db.practice.findMany({ select: { ...commonSelect, code: true, nomenclador: true, defaultDurationMin: true } }),
    db.payer.findMany({
      select: { ...commonSelect, legalName: true, kind: true, registryCode: true, cuit: true, province: true },
    }),
    db.practiceSpecialty.findMany({ select: { practice: { select: { slug: true } }, specialty: { select: { slug: true } } } }),
    db.payerPlan.findMany({
      where: { tenantId: null },
      select: {
        id: true,
        slug: true,
        name: true,
        source: true,
        sourceDate: true,
        promotedAt: true,
        archivedAt: true,
        payer: { select: { slug: true } },
      },
    }),
  ]);
  const entity = (
    r: { id: string; slug: string; name: string; matchKey: string; aliases: string[] } & Pick<
      ExistingEntity,
      "source" | "sourceRef" | "sourceDate" | "curatedAt" | "archivedAt"
    >,
    extra: ExistingEntity["extra"],
  ): ExistingEntity => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    matchKey: r.matchKey,
    aliases: r.aliases,
    source: r.source,
    sourceRef: r.sourceRef,
    sourceDate: r.sourceDate,
    curatedAt: r.curatedAt,
    archivedAt: r.archivedAt,
    extra,
  });
  return {
    specialties: specialties.map((r) => entity(r, {})),
    practices: practices.map((r) =>
      entity(r, { code: r.code, nomenclador: r.nomenclador, defaultDurationMin: r.defaultDurationMin }),
    ),
    payers: payers.map((r) =>
      entity(r, {
        legalName: r.legalName,
        kind: r.kind,
        registryCode: r.registryCode,
        cuit: r.cuit,
        province: r.province,
      }),
    ),
    practiceSpecialties: links.map((l) => ({ practiceSlug: l.practice.slug, specialtySlug: l.specialty.slug })),
    payerPlans: plans.map((p) => ({
      id: p.id,
      payerSlug: p.payer.slug,
      slug: p.slug,
      name: p.name,
      source: p.source,
      sourceDate: p.sourceDate,
      promotedAt: p.promotedAt,
      archivedAt: p.archivedAt,
    })),
  };
}

// ─── Escritura ──────────────────────────────────────────────────────────────

/**
 * Delegate mínimo común a specialty/practice/payer. Las tres tablas comparten
 * las columnas comunes; las propias de cada kind salen de `extra` (con los
 * nombres exactos de las columnas). Prisma valida los campos en runtime.
 */
type EntityDelegate = {
  createMany(args: { data: Record<string, unknown>[] }): Promise<{ count: number }>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
};

function entityDelegate(db: Db, kind: EntityKind): EntityDelegate {
  const d = kind === "specialties" ? db.specialty : kind === "practices" ? db.practice : db.payer;
  return d as unknown as EntityDelegate;
}

function flattenChanges(c: EntityChanges): Record<string, unknown> {
  const { extra, ...rest } = c;
  return { ...rest, ...(extra ?? {}) };
}

export type ApplyResult = { created: number; updated: number; skipped: number; warnings: string[] };

async function applyEntityDiff(db: Db, d: EntityDiff): Promise<ApplyResult> {
  const del = entityDelegate(db, d.kind);
  const warnings: string[] = [];
  let created = 0;
  let updated = 0;
  if (d.create.length > 0) {
    const r = await del.createMany({
      data: d.create.map((c) => ({
        slug: c.slug,
        name: c.name,
        matchKey: c.matchKey,
        aliases: c.aliases,
        source: c.source,
        sourceRef: c.sourceRef,
        sourceDate: c.sourceDate,
        ...c.extra,
      })),
    });
    created = r.count;
  }
  for (const u of d.update) {
    // `curatedAt/archivedAt: null` en el WHERE: si Plataforma la curó o
    // archivó después de leer el estado, no se pisa (0 filas → se avisa).
    const r = await del.updateMany({
      where: { id: u.id, curatedAt: null, archivedAt: null },
      data: { ...flattenChanges(u.changes), ...(u.aliasAdd.length > 0 ? { aliases: { push: u.aliasAdd } } : {}) },
    });
    if (r.count === 0) warnings.push(`${u.slug}: se curó/archivó durante el import, no se actualizó`);
    updated += r.count;
  }
  for (const a of d.aliasAdd) {
    const r = await del.updateMany({ where: { id: a.id, archivedAt: null }, data: { aliases: { push: a.aliases } } });
    updated += r.count;
  }
  return { created, updated, skipped: d.unchanged + d.skipped + d.archived, warnings };
}

async function applyLinkDiff(db: Db, d: LinkDiff): Promise<ApplyResult> {
  if (d.create.length === 0) return { created: 0, updated: 0, skipped: d.unchanged + d.skipped + d.archived, warnings: [] };
  const [practices, specialties] = await Promise.all([
    db.practice.findMany({
      where: { slug: { in: [...new Set(d.create.map((c) => c.practiceSlug))] } },
      select: { id: true, slug: true },
    }),
    db.specialty.findMany({
      where: { slug: { in: [...new Set(d.create.map((c) => c.specialtySlug))] } },
      select: { id: true, slug: true },
    }),
  ]);
  const pid = new Map(practices.map((p) => [p.slug, p.id]));
  const sid = new Map(specialties.map((s) => [s.slug, s.id]));
  const data = d.create.map((c) => {
    const practiceId = pid.get(c.practiceSlug);
    const specialtyId = sid.get(c.specialtySlug);
    // El plan ya validó las referencias contra el estado leído en ESTA tx.
    if (!practiceId || !specialtyId) throw new Error(`[${d.file}:${c.line}] referencia desaparecida durante el import`);
    return { practiceId, specialtyId };
  });
  const r = await db.practiceSpecialty.createMany({ data, skipDuplicates: true });
  return { created: r.count, updated: 0, skipped: d.unchanged + d.skipped + d.archived, warnings: [] };
}

async function applyPlanDiff(db: Db, d: PlanDiff): Promise<ApplyResult> {
  const warnings: string[] = [];
  let created = 0;
  let updated = 0;
  if (d.create.length > 0) {
    const payers = await db.payer.findMany({
      where: { slug: { in: [...new Set(d.create.map((c) => c.payerSlug))] } },
      select: { id: true, slug: true },
    });
    const byslug = new Map(payers.map((p) => [p.slug, p.id]));
    const r = await db.payerPlan.createMany({
      data: d.create.map((c) => {
        const payerId = byslug.get(c.payerSlug);
        if (!payerId) throw new Error(`[${d.file}:${c.line}] prestadora "${c.payerSlug}" desaparecida durante el import`);
        // tenantId null = plan GLOBAL. Sin @@unique en Prisma: la unicidad la
        // da el índice parcial (payerId, slug) WHERE tenantId IS NULL (SQL).
        return { payerId, tenantId: null, slug: c.slug, name: c.name, source: c.source, sourceDate: c.sourceDate };
      }),
    });
    created = r.count;
  }
  for (const u of d.update) {
    const r = await db.payerPlan.updateMany({
      where: { id: u.id, tenantId: null, promotedAt: null, archivedAt: null },
      data: u.changes,
    });
    if (r.count === 0) warnings.push(`${u.payerSlug}/${u.slug}: cambió durante el import, no se actualizó`);
    updated += r.count;
  }
  return { created, updated, skipped: d.unchanged + d.skipped + d.archived, warnings };
}

export async function applyDiff(db: Db, d: FileDiff): Promise<ApplyResult> {
  if (d.shape === "entity") return applyEntityDiff(db, d);
  if (d.shape === "link") return applyLinkDiff(db, d);
  return applyPlanDiff(db, d);
}

// ─── Orquestación ───────────────────────────────────────────────────────────

export type CatalogInput = { file: CatalogFile; text: string; sha256: string };

/** Lee los CSV del directorio (sin tocar la base). `only` filtra un kind (+ su seed). */
export function readCatalogDir(dir: string, only?: CatalogKind): { inputs: CatalogInput[]; ignored: string[] } {
  const inputs: CatalogInput[] = [];
  const ignored: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".csv")) continue;
    const file = classifyCatalogFile(name);
    if (!file) {
      // P. ej. `aliases.csv`: no tiene contrato de headers (bpre-waves) → no se adivina.
      ignored.push(name);
      continue;
    }
    if (only && file.kind !== only) continue;
    const bytes = readFileSync(join(dir, name));
    inputs.push({ file, text: bytes.toString("utf8"), sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  return { inputs: orderCatalogFiles(inputs.map((i) => ({ ...i.file, i }))).map((x) => x.i), ignored };
}

export type RunOptions = {
  db: PrismaClient;
  dir: string;
  apply: boolean;
  only?: CatalogKind;
  ranBy?: string | null;
  log?: (msg: string) => void;
};

export type RunResult = {
  applied: boolean;
  diffs: FileDiff[];
  ignored: string[];
  results: (ApplyResult & { file: string })[];
};

export async function runCatalogImport(opts: RunOptions): Promise<RunResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  await assertBypassRls(opts.db);
  const { inputs, ignored } = readCatalogDir(opts.dir, opts.only);
  for (const name of ignored) log(`⚠ ${name}: no es un archivo del contrato, se ignora`);
  if (inputs.length === 0) throw new Error(`[catalog-import] no hay CSV del contrato en ${opts.dir}`);

  if (!opts.apply) {
    const state = await loadCatalogState(opts.db);
    const { diffs } = planCatalogImport(inputs, state);
    printReport(diffs, log);
    log("Dry-run: no se escribió nada. Repetí con --apply para escribir.");
    return { applied: false, diffs, ignored, results: [] };
  }

  const sha = new Map(inputs.map((i) => [i.file.name, i.sha256]));
  const { diffs, results } = await opts.db.$transaction(
    async (tx) => {
      // Estado y plan se recalculan ADENTRO de la tx: lo que se escribe es
      // exactamente lo que se planificó contra la base de este momento.
      const state = await loadCatalogState(tx);
      const plan = planCatalogImport(inputs, state);
      const results: RunResult["results"] = [];
      for (const d of plan.diffs) {
        const r = await applyDiff(tx, d);
        results.push({ file: d.file, ...r });
        await tx.catalogImportRun.create({
          data: {
            file: d.file,
            sha256: sha.get(d.file)!,
            kind: d.kind,
            created: r.created,
            updated: r.updated,
            skipped: r.skipped,
            conflicts: d.conflicts as unknown as Prisma.InputJsonValue,
            ranBy: opts.ranBy ?? null,
          },
        });
      }
      return { diffs: plan.diffs, results };
    },
    // Cientos de filas en una sola tx contra un remoto: el default (5 s) no alcanza.
    { timeout: 10 * 60_000, maxWait: 30_000 },
  );
  printReport(diffs, log);
  for (const r of results) {
    log(`✔ ${r.file}: creadas ${r.created}, actualizadas ${r.updated}, sin cambios ${r.skipped}`);
    for (const w of r.warnings) log(`  ⚠ ${w}`);
  }
  return { applied: true, diffs, ignored, results };
}

const SAMPLE = 15;

export function printReport(diffs: FileDiff[], log: (m: string) => void): void {
  log("");
  log("archivo                              kind                  crear  actual  alias  igual  seed=  archiv  confl");
  for (const d of diffs) {
    const s = summarizeDiff(d);
    log(
      `${s.file.padEnd(36)} ${s.kind.padEnd(20)} ${String(s.create).padStart(6)} ${String(s.update).padStart(7)} ${String(
        s.aliasAdd,
      ).padStart(6)} ${String(s.unchanged).padStart(6)} ${String(s.skipped).padStart(6)} ${String(s.archived).padStart(7)} ${String(s.conflicts).padStart(6)}`,
    );
  }
  for (const d of diffs) {
    for (const w of d.warnings) log(`⚠ ${d.file}: ${w}`);
    if (d.shape !== "link" && d.update.length > 0) {
      log(`\n${d.file} — actualizaciones (${d.update.length}${d.update.length > SAMPLE ? `, primeras ${SAMPLE}` : ""}):`);
      for (const u of d.update.slice(0, SAMPLE)) log(`  ~ ${"payerSlug" in u ? `${u.payerSlug}/` : ""}${u.slug}: ${u.changedFields.join(", ")}`);
    }
    if (d.shape === "entity" && d.aliasAdd.length > 0) {
      log(`\n${d.file} — alias nuevos (${d.aliasAdd.length}${d.aliasAdd.length > SAMPLE ? `, primeros ${SAMPLE}` : ""}):`);
      for (const a of d.aliasAdd.slice(0, SAMPLE)) {
        log(`  + ${a.slug}${a.curated ? " (curada)" : ""}: ${a.aliases.join(" | ")}`);
      }
    }
    if (d.conflicts.length > 0) {
      // Los conflictos se imprimen TODOS: son las filas que no se escriben.
      log(`\n${d.file} — CONFLICTOS (${d.conflicts.length}, no se escriben):`);
      for (const c of d.conflicts) log(`  ✖ línea ${c.line} · ${c.slug || "?"} · ${c.reason}: ${c.detail}`);
    }
  }
  log("");
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const pref = `--${name}=`;
  return process.argv.find((a) => a.startsWith(pref))?.slice(pref.length);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const onlyRaw = arg("only");
  if (onlyRaw && !(CATALOG_KINDS as readonly string[]).includes(onlyRaw)) {
    throw new Error(`[catalog-import] --only inválido "${onlyRaw}" (${CATALOG_KINDS.join(", ")})`);
  }
  const dir = resolve(arg("dir") ?? DEFAULT_CATALOG_DIR);
  // Owner primero: con `.env.local`/`.env.prod.local`, DATABASE_URL es el rol
  // de la app (RLS) y DIRECT_URL el owner. Se imprime el NOMBRE, nunca el valor.
  const envName = process.env.DIRECT_URL ? "DIRECT_URL" : "DATABASE_URL";
  const url = process.env[envName];
  console.log(`[catalog-import] conexión: ${envName}`);
  assertSafeTarget({ url, allowRemote: true, confirm: process.env.KINESOFT_CONFIRM_PROD, scriptName: "catalog-import" });
  console.log(`[catalog-import] modo: ${apply ? "APPLY (escribe)" : "DRY-RUN (no escribe)"} · carpeta: ${dir}${onlyRaw ? ` · solo ${onlyRaw}` : ""}`);
  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    await runCatalogImport({
      db,
      dir,
      apply,
      only: onlyRaw as CatalogKind | undefined,
      ranBy: arg("by") ?? process.env.USER ?? null,
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
