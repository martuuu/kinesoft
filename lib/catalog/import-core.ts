/**
 * Núcleo PURO del import del catálogo global (B-pre B1.1): CSV → filas
 * validadas → resolución contra el estado actual por slug / matchKey / alias →
 * diff `{ create, update, aliasAdd, conflicts }` por archivo. Sin DB ni fs: el
 * escritor (`scripts/catalog-import.ts`) lee los archivos y el estado, llama a
 * `planCatalogImport` y aplica el diff en UNA transacción.
 *
 * Reglas (contrato de la sesión, bpre-design §A "Import"):
 *  - Upsert por `slug`. Una fila con `curatedAt != null` (la tocó Plataforma)
 *    NUNCA se pisa: solo se le agregan alias nuevos (y el nombre oficial, si
 *    difiere del curado, entra como alias para que siga resolviendo).
 *  - Archivos `*.seed-*.csv` (seed del benchmark, `source=CURATED`):
 *    create-only. Si la fila ya existe por slug o por matchKey, no se hace
 *    nada (cuenta como `skipped`).
 *  - Conflicto = la matchKey de la fila es la clave (matchKey o alias) de OTRA
 *    fila con slug distinto, o un alias de la fila es clave de otra fila: se
 *    reporta y esa fila NO se escribe. Si el choque es entre dos filas del
 *    mismo archivo, se reportan y se saltean LAS DOS (no hay forma objetiva de
 *    elegir; el orden del archivo no es una decisión de curado).
 *  - Los alias nunca se borran (unión): un consultorio puede haber vinculado
 *    su obra social a través de uno. Si cambia el nombre de una fila no
 *    curada, el nombre anterior queda como alias por la misma razón.
 *  - Idempotente: aplicar el diff y volver a planificar el mismo archivo da
 *    cero cambios.
 *  - Fila ARCHIVADA (Plataforma; B1.3 archivar/merge también marcan
 *    `curatedAt` y conservan slug + matchKey): no se desarchiva, no se pisa,
 *    no se re-crea por slug (cuenta como `archived`). Al resolver claves gana
 *    la fila activa: de una archivada solo cuenta su matchKey (ocupa el
 *    @unique), no sus alias. Así el origen de un merge (cuyo nombre pasó a
 *    alias del destino) no produce un conflicto falso.
 *  - PayerPlan: solo GLOBALES (`tenantId null`), clave `(payerSlug, slug)`
 *    (en la base: único parcial `(payerId, slug) WHERE tenantId IS NULL`).
 *    PayerPlan no tiene `curatedAt`; un plan PROMOVIDO desde un consultorio
 *    (`promotedAt != null`) es curado por definición y no se pisa.
 */
import type { CatalogSource, PayerKind } from "@prisma/client";
import { parseCsvTable, CsvParseError } from "./csv";
import { isCatalogSlug, matchKey, splitAliases } from "./normalize";

export const CATALOG_SOURCES = [
  "REFEPS",
  "NOMENCLADOR_NACIONAL",
  "PMO",
  "RNOS",
  "RNEMP",
  "PROVINCIAL",
  "CURATED",
  "TENANT",
] as const satisfies readonly CatalogSource[];

export const PAYER_KINDS = ["OBRA_SOCIAL", "PREPAGA", "MUTUAL", "OTRA"] as const satisfies readonly PayerKind[];

/** Orden de aplicación: las referencias van después de lo referenciado. */
export const CATALOG_KINDS = [
  "specialties",
  "practices",
  "practice-specialties",
  "payers",
  "payer-plans",
] as const;
export type CatalogKind = (typeof CATALOG_KINDS)[number];
export type EntityKind = "specialties" | "practices" | "payers";

/** Headers obligatorios por archivo (contrato de CSV B1.1/B1.2). */
export const CATALOG_HEADERS: Record<CatalogKind, readonly string[]> = {
  specialties: ["slug", "name", "aliases", "source", "sourceRef", "sourceDate", "sourceUrl"],
  practices: [
    "slug",
    "name",
    "code",
    "nomenclador",
    "defaultDurationMin",
    "aliases",
    "source",
    "sourceRef",
    "sourceDate",
    "sourceUrl",
  ],
  "practice-specialties": ["practiceSlug", "specialtySlug"],
  payers: [
    "slug",
    "name",
    "legalName",
    "kind",
    "registryCode",
    "cuit",
    "province",
    "aliases",
    "source",
    "sourceRef",
    "sourceDate",
    "sourceUrl",
  ],
  "payer-plans": ["payerSlug", "slug", "name", "source", "sourceDate", "sourceUrl"],
};

/** Campos propios de cada entidad, además de los comunes. */
const EXTRA_FIELDS: Record<EntityKind, readonly string[]> = {
  specialties: [],
  practices: ["code", "nomenclador", "defaultDurationMin"],
  payers: ["legalName", "kind", "registryCode", "cuit", "province"],
};

export type CatalogFile = { name: string; kind: CatalogKind; seed: boolean };

const FILE_RE = /^(specialties|practices|practice-specialties|payers|payer-plans)(\.seed-[a-z0-9][a-z0-9-]*)?\.csv$/;

/** `payers.csv` → base; `payers.seed-2026-09.csv` → seed. Otro nombre → null. */
export function classifyCatalogFile(name: string): CatalogFile | null {
  const m = FILE_RE.exec(name);
  if (!m) return null;
  return { name, kind: m[1] as CatalogKind, seed: Boolean(m[2]) };
}

/** specialties → practices → practice-specialties → payers → payer-plans → seeds (mismo orden). */
export function orderCatalogFiles<T extends CatalogFile>(files: T[]): T[] {
  const rank = (f: CatalogFile) => (f.seed ? CATALOG_KINDS.length : 0) + CATALOG_KINDS.indexOf(f.kind);
  return [...files].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

// ─── Estado (lo que ya hay en la base) ──────────────────────────────────────

export type ExtraValue = string | number | null;

export type ExistingEntity = {
  id: string;
  slug: string;
  name: string;
  matchKey: string;
  aliases: string[];
  source: CatalogSource;
  sourceRef: string | null;
  sourceDate: Date;
  curatedAt: Date | null;
  /**
   * Archivada desde Plataforma (B1.3: archivar y el ORIGEN de un merge marcan
   * también `curatedAt` y conservan slug + matchKey). El import nunca la
   * desarchiva, ni la actualiza, ni la re-crea por slug.
   */
  archivedAt: Date | null;
  /** Campos de EXTRA_FIELDS del kind (`code`, `kind`, `cuit`, …). */
  extra: Record<string, ExtraValue>;
};

export type ExistingPlan = {
  id: string;
  payerSlug: string;
  slug: string;
  name: string;
  source: CatalogSource;
  sourceDate: Date;
  promotedAt: Date | null;
  archivedAt: Date | null;
};

export type CatalogState = {
  specialties: ExistingEntity[];
  practices: ExistingEntity[];
  payers: ExistingEntity[];
  practiceSpecialties: { practiceSlug: string; specialtySlug: string }[];
  /** Solo globales (`tenantId IS NULL`). */
  payerPlans: ExistingPlan[];
};

export function emptyCatalogState(): CatalogState {
  return { specialties: [], practices: [], payers: [], practiceSpecialties: [], payerPlans: [] };
}

/** Id provisorio de una fila que este mismo import va a crear (dry-run / planes encadenados). */
export const PENDING_ID_PREFIX = "pending:";

// ─── Diff ───────────────────────────────────────────────────────────────────

export type ConflictReason =
  | "invalido"
  | "slug-duplicado"
  | "matchKey-duplicado"
  | "alias-ambiguo"
  | "referencia-desconocida";

export type CatalogConflict = {
  file: string;
  line: number;
  slug: string;
  reason: ConflictReason;
  detail: string;
  otherSlugs?: string[];
};

export type EntityData = {
  name: string;
  matchKey: string;
  aliases: string[];
  source: CatalogSource;
  sourceRef: string | null;
  sourceDate: Date;
  extra: Record<string, ExtraValue>;
};

export type EntityChanges = Partial<Omit<EntityData, "aliases" | "extra">> & { extra?: Record<string, ExtraValue> };

export type EntityDiff = {
  shape: "entity";
  file: string;
  kind: EntityKind;
  seed: boolean;
  create: ({ slug: string; line: number } & EntityData)[];
  /** Filas no curadas con cambios de campos (y, opcionalmente, alias nuevos). */
  update: { id: string; slug: string; line: number; changes: EntityChanges; changedFields: string[]; aliasAdd: string[] }[];
  /** Solo alias nuevos (fila curada, o fila sin otros cambios). */
  aliasAdd: { id: string; slug: string; line: number; aliases: string[]; curated: boolean }[];
  unchanged: number;
  /** Seed: ya existía por slug o matchKey (create-only). */
  skipped: number;
  /** Fila archivada en la base: no se toca. */
  archived: number;
  conflicts: CatalogConflict[];
  warnings: string[];
};

export type LinkDiff = {
  shape: "link";
  file: string;
  kind: "practice-specialties";
  seed: boolean;
  create: { practiceSlug: string; specialtySlug: string; line: number }[];
  unchanged: number;
  skipped: number;
  /** Siempre 0 (los vínculos no se archivan); está para que el resumen sea uniforme. */
  archived: number;
  conflicts: CatalogConflict[];
  warnings: string[];
};

export type PlanData = { payerSlug: string; slug: string; name: string; source: CatalogSource; sourceDate: Date };

export type PlanDiff = {
  shape: "plan";
  file: string;
  kind: "payer-plans";
  seed: boolean;
  create: (PlanData & { line: number })[];
  update: {
    id: string;
    payerSlug: string;
    slug: string;
    line: number;
    changes: Partial<Pick<PlanData, "name" | "source" | "sourceDate">>;
    changedFields: string[];
  }[];
  unchanged: number;
  skipped: number;
  archived: number;
  conflicts: CatalogConflict[];
  warnings: string[];
};

export type FileDiff = EntityDiff | LinkDiff | PlanDiff;

export type DiffSummary = {
  file: string;
  kind: CatalogKind;
  seed: boolean;
  create: number;
  update: number;
  aliasAdd: number;
  unchanged: number;
  skipped: number;
  archived: number;
  conflicts: number;
};

export function summarizeDiff(d: FileDiff): DiffSummary {
  return {
    file: d.file,
    kind: d.kind,
    seed: d.seed,
    create: d.create.length,
    update: d.shape === "link" ? 0 : d.update.length,
    aliasAdd: d.shape === "entity" ? d.aliasAdd.length : 0,
    unchanged: d.unchanged,
    skipped: d.skipped,
    archived: d.archived,
    conflicts: d.conflicts.length,
  };
}

/** ¿El diff escribe algo? (idempotencia: la segunda corrida da false en todos). */
export function diffHasChanges(d: FileDiff): boolean {
  const s = summarizeDiff(d);
  return s.create + s.update + s.aliasAdd > 0;
}

/** Error de formato que aborta TODO el import antes de escribir (header roto, CSV ilegible). */
export class CatalogFormatError extends Error {
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(`[${file}] ${message}`);
    this.name = "CatalogFormatError";
  }
}

// ─── Parseo y validación de filas ───────────────────────────────────────────

type RowValues = Record<string, string>;
type Invalid = { error: string };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `YYYY-MM-DD` → medianoche UTC de ese día. Es una fecha sin hora (la fecha de
 * consulta de la fuente); con `Date.UTC` el resultado no depende del TZ del
 * host (TZ=UTC y TZ=AR dan el mismo instante).
 */
export function parseSourceDate(value: string): Date | null {
  const m = DATE_RE.exec(value.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date;
}

const opt = (v: string | undefined): string | null => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};

function parseCommon(v: RowValues): Invalid | Omit<EntityData, "extra"> & { slug: string } {
  const slug = (v.slug ?? "").trim();
  if (!isCatalogSlug(slug)) return { error: `slug inválido "${slug}"` };
  const name = (v.name ?? "").trim().replace(/\s+/g, " ");
  const key = matchKey(name);
  if (!key) return { error: "name vacío o sin letras/números" };
  const source = (v.source ?? "").trim();
  if (!(CATALOG_SOURCES as readonly string[]).includes(source)) return { error: `source inválido "${source}"` };
  const sourceDate = parseSourceDate(v.sourceDate ?? "");
  if (!sourceDate) return { error: `sourceDate inválida "${v.sourceDate ?? ""}" (YYYY-MM-DD)` };
  return {
    slug,
    name,
    matchKey: key,
    aliases: splitAliases(v.aliases, [key]),
    source: source as CatalogSource,
    sourceRef: opt(v.sourceRef),
    sourceDate,
  };
}

function parseExtra(kind: EntityKind, v: RowValues): Invalid | { extra: Record<string, ExtraValue> } {
  if (kind === "practices") {
    const dur = opt(v.defaultDurationMin);
    let defaultDurationMin: number | null = null;
    if (dur !== null) {
      const n = Number(dur);
      if (!/^\d+$/.test(dur) || n < 1 || n > 720) return { error: `defaultDurationMin inválido "${dur}"` };
      defaultDurationMin = n;
    }
    return { extra: { code: opt(v.code), nomenclador: opt(v.nomenclador), defaultDurationMin } };
  }
  if (kind === "payers") {
    const k = (v.kind ?? "").trim();
    if (!(PAYER_KINDS as readonly string[]).includes(k)) return { error: `kind inválido "${k}"` };
    return {
      extra: {
        legalName: opt(v.legalName),
        kind: k,
        registryCode: opt(v.registryCode),
        cuit: opt(v.cuit),
        province: opt(v.province),
      },
    };
  }
  return { extra: {} };
}

type ParsedTable = { rows: { line: number; values: RowValues }[]; conflicts: CatalogConflict[]; warnings: string[] };

function readTable(file: CatalogFile, text: string): ParsedTable {
  let table;
  try {
    table = parseCsvTable(text);
  } catch (e) {
    if (e instanceof CsvParseError) throw new CatalogFormatError(file.name, e.message);
    throw e;
  }
  const expected = CATALOG_HEADERS[file.kind];
  if (table.header.length === 0) throw new CatalogFormatError(file.name, "archivo vacío (falta el header)");
  const missing = expected.filter((h) => !table.header.includes(h));
  if (missing.length > 0) {
    throw new CatalogFormatError(file.name, `faltan columnas del contrato: ${missing.join(", ")}`);
  }
  const warnings: string[] = [];
  const extra = table.header.filter((h) => !expected.includes(h));
  if (extra.length > 0) warnings.push(`columnas fuera del contrato (ignoradas): ${extra.join(", ")}`);
  const conflicts: CatalogConflict[] = table.malformed.map((m) => ({
    file: file.name,
    line: m.line,
    slug: "",
    reason: "invalido",
    detail: `${m.got} columnas, se esperaban ${m.expected}`,
  }));
  return { rows: table.rows, conflicts, warnings };
}

// ─── Planificación ──────────────────────────────────────────────────────────

/** Claves con las que se resuelve una fila: su matchKey y la de cada alias. */
function keysOf(e: { matchKey: string; aliases: string[] }): string[] {
  return [e.matchKey, ...e.aliases.map(matchKey).filter(Boolean)];
}

function addOwner(owners: Map<string, Set<string>>, key: string, slug: string) {
  const set = owners.get(key) ?? new Set<string>();
  set.add(slug);
  owners.set(key, set);
}

function othersOf(owners: Map<string, Set<string>>, key: string, slug: string): string[] {
  return [...(owners.get(key) ?? [])].filter((s) => s !== slug).sort();
}

const sameExtra = (a: ExtraValue | undefined, b: ExtraValue | undefined) => (a ?? null) === (b ?? null);

function planEntityFile(
  file: CatalogFile & { kind: EntityKind },
  table: ParsedTable,
  existing: ExistingEntity[],
): { diff: EntityDiff; next: ExistingEntity[] } {
  const diff: EntityDiff = {
    shape: "entity",
    file: file.name,
    kind: file.kind,
    seed: file.seed,
    create: [],
    update: [],
    aliasAdd: [],
    unchanged: 0,
    skipped: 0,
    archived: 0,
    conflicts: [...table.conflicts],
    warnings: [...table.warnings],
  };
  const conflict = (line: number, slug: string, reason: ConflictReason, detail: string, otherSlugs?: string[]) =>
    diff.conflicts.push({ file: file.name, line, slug, reason, detail, ...(otherSlugs ? { otherSlugs } : {}) });

  // 1) Validación fila a fila.
  type Row = { line: number; slug: string } & EntityData;
  let rows: Row[] = [];
  for (const r of table.rows) {
    const common = parseCommon(r.values);
    if ("error" in common) {
      conflict(r.line, (r.values.slug ?? "").trim(), "invalido", common.error);
      continue;
    }
    const parsed = parseExtra(file.kind, r.values);
    if ("error" in parsed) {
      conflict(r.line, common.slug, "invalido", parsed.error);
      continue;
    }
    rows.push({ line: r.line, ...common, extra: parsed.extra });
  }

  // 2) Slug repetido dentro del archivo: se saltean todas sus filas.
  const slugCount = new Map<string, number>();
  for (const r of rows) slugCount.set(r.slug, (slugCount.get(r.slug) ?? 0) + 1);
  rows = rows.filter((r) => {
    if (slugCount.get(r.slug)! > 1) {
      conflict(r.line, r.slug, "slug-duplicado", `el slug aparece ${slugCount.get(r.slug)} veces en el archivo`);
      return false;
    }
    return true;
  });

  const bySlug = new Map(existing.map((e) => [e.slug, e]));

  // 3) Fila archivada en la base (slug): no se desarchiva, no se pisa, no se re-crea.
  rows = rows.filter((r) => {
    if (bySlug.get(r.slug)?.archivedAt) {
      diff.archived++;
      return false;
    }
    return true;
  });

  // Dueños de cada clave en la base. `active` = filas no archivadas (matchKey
  // + alias): es contra quien se resuelve. Una ARCHIVADA solo cuenta por su
  // matchKey, que sigue ocupando el @unique de la base; sus alias no. Así el
  // origen archivado de un merge (B1.3: su nombre pasa a alias del destino) no
  // da un conflicto falso contra el destino: gana la fila activa.
  const dbActive = new Map<string, Set<string>>();
  const dbArchivedKey = new Map<string, Set<string>>();
  for (const e of existing) {
    if (e.archivedAt) addOwner(dbArchivedKey, e.matchKey, e.slug);
    else for (const k of keysOf(e)) addOwner(dbActive, k, e.slug);
  }

  // 4) Seed (create-only): lo que ya existe por slug o por clave no se toca.
  if (file.seed) {
    rows = rows.filter((r) => {
      if (bySlug.has(r.slug) || dbActive.has(r.matchKey) || dbArchivedKey.has(r.matchKey)) {
        diff.skipped++;
        return false;
      }
      return true;
    });
  }

  // 5) Dueños: base activa + filas del archivo (simétrico: no depende del orden).
  const owners = new Map<string, Set<string>>();
  for (const [k, set] of dbActive) owners.set(k, new Set(set));
  for (const r of rows) for (const k of keysOf(r)) addOwner(owners, k, r.slug);

  const next = new Map(existing.map((e) => [e.slug, e]));

  for (const r of rows) {
    const keyOthers = othersOf(owners, r.matchKey, r.slug);
    // Sin dueño activo, la matchKey de una archivada igual choca con el @unique.
    const archivedOthers = keyOthers.length > 0 ? [] : othersOf(dbArchivedKey, r.matchKey, r.slug);
    if (keyOthers.length > 0 || archivedOthers.length > 0) {
      const others = keyOthers.length > 0 ? keyOthers : archivedOthers;
      conflict(
        r.line,
        r.slug,
        "matchKey-duplicado",
        `"${r.name}" → "${r.matchKey}" ya es de ${others.join(", ")}${keyOthers.length > 0 ? "" : " (archivada)"}`,
        others,
      );
      continue;
    }
    const ambiguous = r.aliases
      .map((a) => ({ alias: a, others: othersOf(owners, matchKey(a), r.slug) }))
      .filter((x) => x.others.length > 0);
    if (ambiguous.length > 0) {
      const others = [...new Set(ambiguous.flatMap((x) => x.others))].sort();
      conflict(
        r.line,
        r.slug,
        "alias-ambiguo",
        ambiguous.map((x) => `alias "${x.alias}" también es de ${x.others.join(", ")}`).join("; "),
        others,
      );
      continue;
    }

    const cur = bySlug.get(r.slug);
    if (!cur) {
      diff.create.push({
        slug: r.slug,
        line: r.line,
        name: r.name,
        matchKey: r.matchKey,
        aliases: r.aliases,
        source: r.source,
        sourceRef: r.sourceRef,
        sourceDate: r.sourceDate,
        extra: r.extra,
      });
      next.set(r.slug, {
        id: `${PENDING_ID_PREFIX}${r.slug}`,
        slug: r.slug,
        name: r.name,
        matchKey: r.matchKey,
        aliases: r.aliases,
        source: r.source,
        sourceRef: r.sourceRef,
        sourceDate: r.sourceDate,
        curatedAt: null,
        archivedAt: null,
        extra: r.extra,
      });
      continue;
    }

    // Claves que la fila ya tiene y van a seguir siendo suyas después de escribir.
    const newAliases = (candidates: string[], keep: string[]) => {
      const seen = new Set(keep);
      const out: string[] = [];
      for (const a of candidates) {
        const k = matchKey(a);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        out.push(a);
      }
      return out;
    };

    if (cur.curatedAt) {
      // Curada: nada de nombre/campos. El nombre oficial entra como alias.
      const add = newAliases([r.name, ...r.aliases], keysOf(cur));
      if (add.length === 0) {
        diff.unchanged++;
      } else {
        diff.aliasAdd.push({ id: cur.id, slug: r.slug, line: r.line, aliases: add, curated: true });
        next.set(r.slug, { ...cur, aliases: [...cur.aliases, ...add] });
      }
      continue;
    }

    const changes: EntityChanges = {};
    const changedFields: string[] = [];
    if (cur.name !== r.name) {
      changes.name = r.name;
      changedFields.push("name");
    }
    if (cur.matchKey !== r.matchKey) {
      changes.matchKey = r.matchKey;
      changedFields.push("matchKey");
    }
    if (cur.source !== r.source) {
      changes.source = r.source;
      changedFields.push("source");
    }
    if ((cur.sourceRef ?? null) !== r.sourceRef) {
      changes.sourceRef = r.sourceRef;
      changedFields.push("sourceRef");
    }
    if (cur.sourceDate.getTime() !== r.sourceDate.getTime()) {
      changes.sourceDate = r.sourceDate;
      changedFields.push("sourceDate");
    }
    const extraChanges: Record<string, ExtraValue> = {};
    for (const f of EXTRA_FIELDS[file.kind]) {
      if (!sameExtra(cur.extra[f], r.extra[f])) {
        extraChanges[f] = r.extra[f] ?? null;
        changedFields.push(f);
      }
    }
    if (Object.keys(extraChanges).length > 0) changes.extra = extraChanges;
    // Si cambia la matchKey, el nombre anterior queda como alias (no se pierde la clave).
    // La clave vieja deja de ser la matchKey, así que no cuenta como "ya está".
    const add = newAliases(
      [...(changes.matchKey ? [cur.name] : []), ...r.aliases],
      [r.matchKey, ...cur.aliases.map(matchKey).filter(Boolean)],
    );

    if (changedFields.length > 0) {
      diff.update.push({ id: cur.id, slug: r.slug, line: r.line, changes, changedFields, aliasAdd: add });
    } else if (add.length > 0) {
      diff.aliasAdd.push({ id: cur.id, slug: r.slug, line: r.line, aliases: add, curated: false });
    } else {
      diff.unchanged++;
      continue;
    }
    next.set(r.slug, {
      ...cur,
      ...(changes.name !== undefined ? { name: changes.name } : {}),
      ...(changes.matchKey !== undefined ? { matchKey: changes.matchKey } : {}),
      ...(changes.source !== undefined ? { source: changes.source } : {}),
      ...(changes.sourceRef !== undefined ? { sourceRef: changes.sourceRef } : {}),
      ...(changes.sourceDate !== undefined ? { sourceDate: changes.sourceDate } : {}),
      extra: { ...cur.extra, ...extraChanges },
      aliases: [...cur.aliases, ...add],
    });
  }

  return { diff, next: [...next.values()] };
}

function planLinkFile(
  file: CatalogFile,
  table: ParsedTable,
  state: CatalogState,
): { diff: LinkDiff; next: CatalogState["practiceSpecialties"] } {
  const diff: LinkDiff = {
    shape: "link",
    file: file.name,
    kind: "practice-specialties",
    seed: file.seed,
    create: [],
    unchanged: 0,
    skipped: 0,
    archived: 0,
    conflicts: [...table.conflicts],
    warnings: [...table.warnings],
  };
  const practices = new Set(state.practices.map((p) => p.slug));
  const specialties = new Set(state.specialties.map((s) => s.slug));
  const have = new Set(state.practiceSpecialties.map((l) => `${l.practiceSlug}\u0000${l.specialtySlug}`));
  const next = [...state.practiceSpecialties];
  for (const r of table.rows) {
    const practiceSlug = (r.values.practiceSlug ?? "").trim();
    const specialtySlug = (r.values.specialtySlug ?? "").trim();
    const slug = `${practiceSlug}/${specialtySlug}`;
    if (!isCatalogSlug(practiceSlug) || !isCatalogSlug(specialtySlug)) {
      diff.conflicts.push({ file: file.name, line: r.line, slug, reason: "invalido", detail: "slug inválido" });
      continue;
    }
    const missing = [
      ...(practices.has(practiceSlug) ? [] : [`práctica "${practiceSlug}"`]),
      ...(specialties.has(specialtySlug) ? [] : [`especialidad "${specialtySlug}"`]),
    ];
    if (missing.length > 0) {
      diff.conflicts.push({
        file: file.name,
        line: r.line,
        slug,
        reason: "referencia-desconocida",
        detail: `no existe ${missing.join(" ni ")} (ni en la base ni en este import)`,
      });
      continue;
    }
    const key = `${practiceSlug}\u0000${specialtySlug}`;
    if (have.has(key)) {
      diff.unchanged++;
      continue;
    }
    have.add(key);
    diff.create.push({ practiceSlug, specialtySlug, line: r.line });
    next.push({ practiceSlug, specialtySlug });
  }
  return { diff, next };
}

function planPlanFile(
  file: CatalogFile,
  table: ParsedTable,
  state: CatalogState,
): { diff: PlanDiff; next: ExistingPlan[] } {
  const diff: PlanDiff = {
    shape: "plan",
    file: file.name,
    kind: "payer-plans",
    seed: file.seed,
    create: [],
    update: [],
    unchanged: 0,
    skipped: 0,
    archived: 0,
    conflicts: [...table.conflicts],
    warnings: [...table.warnings],
  };
  const conflict = (line: number, slug: string, reason: ConflictReason, detail: string, otherSlugs?: string[]) =>
    diff.conflicts.push({ file: file.name, line, slug, reason, detail, ...(otherSlugs ? { otherSlugs } : {}) });
  const payers = new Set(state.payers.map((p) => p.slug));

  type Row = PlanData & { line: number; nameKey: string; id: string };
  let rows: Row[] = [];
  for (const r of table.rows) {
    const v = r.values;
    const payerSlug = (v.payerSlug ?? "").trim();
    const slug = (v.slug ?? "").trim();
    const id = `${payerSlug}/${slug}`;
    const name = (v.name ?? "").trim().replace(/\s+/g, " ");
    const source = (v.source ?? "").trim();
    const sourceDate = parseSourceDate(v.sourceDate ?? "");
    let error: string | null = null;
    if (!isCatalogSlug(payerSlug)) error = `payerSlug inválido "${payerSlug}"`;
    else if (!isCatalogSlug(slug)) error = `slug inválido "${slug}"`;
    else if (!matchKey(name)) error = "name vacío o sin letras/números";
    else if (!(CATALOG_SOURCES as readonly string[]).includes(source)) error = `source inválido "${source}"`;
    else if (!sourceDate) error = `sourceDate inválida "${v.sourceDate ?? ""}" (YYYY-MM-DD)`;
    if (error) {
      conflict(r.line, id, "invalido", error);
      continue;
    }
    if (!payers.has(payerSlug)) {
      conflict(r.line, id, "referencia-desconocida", `no existe la prestadora "${payerSlug}" (ni en la base ni en este import)`);
      continue;
    }
    rows.push({
      line: r.line,
      id,
      payerSlug,
      slug,
      name,
      nameKey: matchKey(name),
      source: source as CatalogSource,
      sourceDate: sourceDate!,
    });
  }

  const count = new Map<string, number>();
  for (const r of rows) count.set(r.id, (count.get(r.id) ?? 0) + 1);
  rows = rows.filter((r) => {
    if (count.get(r.id)! > 1) {
      conflict(r.line, r.id, "slug-duplicado", `el plan aparece ${count.get(r.id)} veces en el archivo`);
      return false;
    }
    return true;
  });

  const byId = new Map(state.payerPlans.map((p) => [`${p.payerSlug}/${p.slug}`, p]));
  // Plan archivado (slug): no se desarchiva ni se pisa ni se re-crea (el único
  // parcial (payerId, slug) WHERE tenantId IS NULL lo sigue ocupando).
  rows = rows.filter((r) => {
    if (byId.get(r.id)?.archivedAt) {
      diff.archived++;
      return false;
    }
    return true;
  });
  // Nombre normalizado por prestadora: dos planes "Plan 210" y "PLAN-210" de la
  // misma prestadora chocan. Los archivados no cuentan (no hay índice sobre el nombre).
  const dbOwners = new Map<string, Set<string>>();
  for (const p of state.payerPlans) {
    if (!p.archivedAt) addOwner(dbOwners, `${p.payerSlug}\u0000${matchKey(p.name)}`, p.slug);
  }

  if (file.seed) {
    rows = rows.filter((r) => {
      if (byId.has(r.id) || dbOwners.has(`${r.payerSlug}\u0000${r.nameKey}`)) {
        diff.skipped++;
        return false;
      }
      return true;
    });
  }

  const owners = new Map<string, Set<string>>();
  for (const [k, set] of dbOwners) owners.set(k, new Set(set));
  for (const r of rows) addOwner(owners, `${r.payerSlug}\u0000${r.nameKey}`, r.slug);

  const next = new Map(state.payerPlans.map((p) => [`${p.payerSlug}/${p.slug}`, p]));
  for (const r of rows) {
    const others = othersOf(owners, `${r.payerSlug}\u0000${r.nameKey}`, r.slug);
    if (others.length > 0) {
      conflict(
        r.line,
        r.id,
        "matchKey-duplicado",
        `"${r.name}" ya es el nombre de otro plan de ${r.payerSlug}: ${others.join(", ")}`,
        others.map((s) => `${r.payerSlug}/${s}`),
      );
      continue;
    }
    const cur = byId.get(r.id);
    if (!cur) {
      diff.create.push({ line: r.line, payerSlug: r.payerSlug, slug: r.slug, name: r.name, source: r.source, sourceDate: r.sourceDate });
      next.set(r.id, {
        id: `${PENDING_ID_PREFIX}${r.id}`,
        payerSlug: r.payerSlug,
        slug: r.slug,
        name: r.name,
        source: r.source,
        sourceDate: r.sourceDate,
        promotedAt: null,
        archivedAt: null,
      });
      continue;
    }
    if (cur.promotedAt) {
      diff.unchanged++; // promovido desde un consultorio = curado: no se pisa
      continue;
    }
    const changes: PlanDiff["update"][number]["changes"] = {};
    const changedFields: string[] = [];
    if (cur.name !== r.name) {
      changes.name = r.name;
      changedFields.push("name");
    }
    if (cur.source !== r.source) {
      changes.source = r.source;
      changedFields.push("source");
    }
    if (cur.sourceDate.getTime() !== r.sourceDate.getTime()) {
      changes.sourceDate = r.sourceDate;
      changedFields.push("sourceDate");
    }
    if (changedFields.length === 0) {
      diff.unchanged++;
      continue;
    }
    diff.update.push({ id: cur.id, payerSlug: r.payerSlug, slug: r.slug, line: r.line, changes, changedFields });
    next.set(r.id, { ...cur, ...changes });
  }
  return { diff, next: [...next.values()] };
}

/** Planifica UN archivo contra `state`. Devuelve el diff y el estado resultante. */
export function planCatalogFile(
  file: CatalogFile,
  text: string,
  state: CatalogState,
): { diff: FileDiff; state: CatalogState } {
  const table = readTable(file, text);
  switch (file.kind) {
    case "specialties":
    case "practices":
    case "payers": {
      const { diff, next } = planEntityFile(file as CatalogFile & { kind: EntityKind }, table, state[file.kind]);
      return { diff, state: { ...state, [file.kind]: next } };
    }
    case "practice-specialties": {
      const { diff, next } = planLinkFile(file, table, state);
      return { diff, state: { ...state, practiceSpecialties: next } };
    }
    case "payer-plans": {
      const { diff, next } = planPlanFile(file, table, state);
      return { diff, state: { ...state, payerPlans: next } };
    }
  }
}

/**
 * Planifica todos los archivos en el orden del contrato. Cada archivo ve lo
 * que planificaron los anteriores (las prácticas creadas en `practices.csv`
 * existen para `practice-specialties.csv`, aunque sea dry-run). Un error de
 * formato en cualquier archivo tira `CatalogFormatError` ANTES de que el
 * escritor toque la base.
 */
export function planCatalogImport(
  inputs: { file: CatalogFile; text: string }[],
  state: CatalogState,
): { diffs: FileDiff[]; state: CatalogState } {
  const ordered = orderCatalogFiles(inputs.map((i) => ({ ...i.file, text: i.text })));
  const diffs: FileDiff[] = [];
  let cur = state;
  for (const f of ordered) {
    const { text, ...file } = f;
    const r = planCatalogFile(file, text, cur);
    diffs.push(r.diff);
    cur = r.state;
  }
  return { diffs, state: cur };
}
