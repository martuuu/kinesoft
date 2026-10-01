/**
 * B1.2 CAT-data: valida los CSV REALES de `prisma/catalog/` contra el "Contrato de CSV del catálogo"
 * (bpre-waves.md). Lo corre el unit para que un CSV roto se vea antes de que Martin corra el import
 * (`scripts/catalog-import.ts`, B1.1) contra prod.
 *
 * El parser RFC 4180 de acá es a propósito independiente del de B1.1 (`lib/catalog/import-core.ts`): si los dos
 * coinciden en que el archivo es válido, el error no es del parser. La unicidad se mide con el `matchKey` REAL
 * (`lib/catalog/normalize.ts`) y al final se corre el planner real del import contra una base vacía: el primer
 * import en prod no puede saltear filas por conflicto (el import solo las lista en el reporte).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";
import { matchKey } from "@/lib/catalog/normalize";
import { classifyCatalogFile, emptyCatalogState, planCatalogImport, summarizeDiff } from "@/lib/catalog/import-core";

const DIR = resolve(process.cwd(), "prisma/catalog");

const CATALOG_SOURCES = ["REFEPS", "NOMENCLADOR_NACIONAL", "PMO", "RNOS", "RNEMP", "PROVINCIAL", "CURATED", "TENANT"];
// TENANT es para filas propuestas por un consultorio: nunca viene en los CSV del repo.
const FILE_SOURCES = CATALOG_SOURCES.filter((s) => s !== "TENANT");
const PAYER_KINDS = ["OBRA_SOCIAL", "PREPAGA", "MUTUAL", "OTRA"];

const HEADERS = {
  "specialties.csv": ["slug", "name", "aliases", "source", "sourceRef", "sourceDate", "sourceUrl"],
  "practices.csv": [
    "slug", "name", "code", "nomenclador", "defaultDurationMin", "aliases", "source", "sourceRef", "sourceDate",
    "sourceUrl",
  ],
  "practice-specialties.csv": ["practiceSlug", "specialtySlug"],
  "payers.csv": [
    "slug", "name", "legalName", "kind", "registryCode", "cuit", "province", "aliases", "source", "sourceRef",
    "sourceDate", "sourceUrl",
  ],
  "payer-plans.csv": ["payerSlug", "slug", "name", "source", "sourceDate", "sourceUrl"],
  "payers.seed-2026-09.csv": [] as string[],
  "payer-plans.seed-2026-09.csv": [] as string[],
} as const;
type FileName = keyof typeof HEADERS;
// El seed del benchmark usa los MISMOS headers que su archivo base.
const headerOf = (f: FileName): readonly string[] =>
  f === "payers.seed-2026-09.csv" ? HEADERS["payers.csv"]
  : f === "payer-plans.seed-2026-09.csv" ? HEADERS["payer-plans.csv"]
  : HEADERS[f];

/** RFC 4180: comillas dobles, "" escapado, comas y saltos de línea dentro de comillas. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') {
      if (field !== "") throw new Error(`comilla en medio de un campo (offset ${i})`);
      quoted = true;
    } else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (quoted) throw new Error("comilla sin cerrar al final del archivo");
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

type Row = Record<string, string>;
function load(f: FileName): { header: string[]; rows: Row[]; raw: string[][] } {
  const text = readFileSync(resolve(DIR, f), "utf8");
  const [header, ...raw] = parseCsv(text);
  const rows = raw.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""])));
  return { header, rows, raw };
}

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const isValidDate = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.toISOString().slice(0, 10) === s; // fecha pura en UTC, no depende de TZ
};
const dupes = (xs: string[]) => xs.filter((x, i) => xs.indexOf(x) !== i);

const FILES = Object.keys(HEADERS) as FileName[];
const data = Object.fromEntries(FILES.map((f) => [f, load(f)])) as Record<FileName, ReturnType<typeof load>>;

describe("catálogo: formato de archivo", () => {
  it.each(FILES)("%s: UTF-8 sin BOM ni caracteres de reemplazo", (f) => {
    const buf = readFileSync(resolve(DIR, f));
    expect(buf.subarray(0, 3).toString("hex")).not.toBe("efbbbf");
    expect(buf.toString("utf8")).not.toContain("�");
  });

  it.each(FILES)("%s: header exacto del contrato", (f) => {
    expect(data[f].header).toEqual(headerOf(f));
  });

  it.each(FILES)("%s: todas las filas tienen las columnas del header y no está vacío", (f) => {
    const { header, raw } = data[f];
    expect(raw.length).toBeGreaterThan(0);
    const bad = raw.map((cells, i) => [i + 2, cells.length] as const).filter(([, n]) => n !== header.length);
    expect(bad).toEqual([]);
  });

  it.each(FILES)("%s: sin espacios sobrantes ni saltos de línea en las celdas", (f) => {
    const bad = data[f].raw.flatMap((cells, i) =>
      cells.filter((c) => c !== c.trim() || /[\r\n]/.test(c)).map((c) => `${i + 2}: ${JSON.stringify(c)}`),
    );
    expect(bad).toEqual([]);
  });
});

describe("catálogo: valores por columna", () => {
  const withSource = FILES.filter((f) => headerOf(f).includes("source"));

  it.each(withSource)("%s: source ∈ CatalogSource (sin TENANT) y fecha válida", (f) => {
    for (const r of data[f].rows) {
      expect(FILE_SOURCES, `${f} ${r.slug}`).toContain(r.source);
      expect(isValidDate(r.sourceDate), `${f} ${r.slug} sourceDate=${r.sourceDate}`).toBe(true);
    }
  });

  it.each(withSource)("%s: sourceUrl vacía o http(s) única (sin listas)", (f) => {
    const bad = data[f].rows.filter((r) => r.sourceUrl && !/^https?:\/\/\S+$/.test(r.sourceUrl));
    expect(bad.map((r) => r.sourceUrl)).toEqual([]);
  });

  it.each(FILES.filter((f) => headerOf(f).includes("name")))("%s: name no vacío", (f) => {
    expect(data[f].rows.filter((r) => !r.name)).toEqual([]);
  });

  it.each(FILES.filter((f) => headerOf(f).includes("aliases")))(
    "%s: aliases separados por | sin vacíos, sin repetidos y distintos del name",
    (f) => {
      for (const r of data[f].rows) {
        if (!r.aliases) continue;
        const parts = r.aliases.split("|");
        expect(parts.every((a) => a.trim() === a && a !== ""), `${r.slug}: ${r.aliases}`).toBe(true);
        expect(dupes(parts.map((a) => a.toLowerCase())), r.slug).toEqual([]);
        expect(parts.map((a) => a.toLowerCase()), r.slug).not.toContain(r.name.toLowerCase());
      }
    },
  );

  it.each(["specialties.csv", "practices.csv", "payers.csv", "payers.seed-2026-09.csv"] as FileName[])(
    "%s: slug kebab-case y único",
    (f) => {
      const slugs = data[f].rows.map((r) => r.slug);
      expect(slugs.filter((s) => !KEBAB.test(s))).toEqual([]);
      expect(dupes(slugs)).toEqual([]);
    },
  );

  it.each(["specialties.csv", "practices.csv", "payers.csv"] as FileName[])(
    "%s: matchKey del name única (UNIQUE en la base)",
    (f) => {
      const keys = data[f].rows.map((r) => matchKey(r.name));
      expect(keys.filter((k) => !k)).toEqual([]);
      expect(dupes(keys)).toEqual([]);
    },
  );

  it.each(["payers.csv", "payers.seed-2026-09.csv"] as FileName[])("%s: kind, registro, provincia y CUIT", (f) => {
    for (const r of data[f].rows) {
      expect(PAYER_KINDS, r.slug).toContain(r.kind);
      if (r.cuit) expect(r.cuit, r.slug).toMatch(/^\d{11}$/);
      if (r.registryCode) expect(r.registryCode, r.slug).toMatch(/^\d{6}$/);
      if (r.source === "PROVINCIAL") {
        expect(r.province, r.slug).not.toBe("");
        expect(r.kind, r.slug).toBe("OBRA_SOCIAL");
      }
    }
  });

  it("payers.csv: RNOS/RNEMP llevan registryCode único y su referencia en sourceRef", () => {
    const { rows } = data["payers.csv"];
    for (const r of rows) {
      const fromRegistry = r.source === "RNOS" || r.source === "RNEMP";
      expect(Boolean(r.registryCode), r.slug).toBe(fromRegistry);
      if (fromRegistry) expect(r.sourceRef.startsWith(`${r.source} `), `${r.slug}: ${r.sourceRef}`).toBe(true);
    }
    expect(dupes(rows.map((r) => r.registryCode).filter(Boolean))).toEqual([]);
  });

  it("payers.csv: las 24 provinciales de COSSPRA mantienen sus slugs", () => {
    const prov = data["payers.csv"].rows.filter((r) => r.source === "PROVINCIAL").map((r) => r.slug);
    expect(prov).toHaveLength(24);
    expect(prov).toEqual(expect.arrayContaining(["ioma", "iapos", "apross", "osep-mendoza", "osep-catamarca", "oser"]));
  });

  it("practices.csv: duración entera positiva; code ⇔ nomenclador; PMO ⇔ code", () => {
    for (const r of data["practices.csv"].rows) {
      if (r.defaultDurationMin) expect(r.defaultDurationMin, r.slug).toMatch(/^[1-9]\d{0,2}$/);
      expect(Boolean(r.code), r.slug).toBe(Boolean(r.nomenclador));
      expect(Boolean(r.code), r.slug).toBe(r.source === "PMO");
      if (r.code) expect(r.code, r.slug).toMatch(/^\d{6}$/);
    }
    expect(dupes(data["practices.csv"].rows.map((r) => r.code).filter(Boolean))).toEqual([]);
  });
});

describe("catálogo: referencias cruzadas", () => {
  const payerSlugs = new Set(data["payers.csv"].rows.map((r) => r.slug));

  it.each(["payer-plans.csv", "payer-plans.seed-2026-09.csv"] as FileName[])(
    "%s: payerSlug existe, slug kebab y (payerSlug, slug) único",
    (f) => {
      const { rows } = data[f];
      expect(rows.filter((r) => !payerSlugs.has(r.payerSlug)).map((r) => r.payerSlug)).toEqual([]);
      expect(rows.filter((r) => !KEBAB.test(r.slug)).map((r) => r.slug)).toEqual([]);
      expect(dupes(rows.map((r) => `${r.payerSlug}/${r.slug}`))).toEqual([]);
    },
  );

  it("practice-specialties.csv: los dos slugs existen y el par no se repite", () => {
    const practices = new Set(data["practices.csv"].rows.map((r) => r.slug));
    const specialties = new Set(data["specialties.csv"].rows.map((r) => r.slug));
    const { rows } = data["practice-specialties.csv"];
    expect(rows.filter((r) => !practices.has(r.practiceSlug)).map((r) => r.practiceSlug)).toEqual([]);
    expect(rows.filter((r) => !specialties.has(r.specialtySlug)).map((r) => r.specialtySlug)).toEqual([]);
    expect(dupes(rows.map((r) => `${r.practiceSlug}/${r.specialtySlug}`))).toEqual([]);
  });

  it("las consultas médicas genéricas (42.01.01 / 42.02.01) no tienen especialidad; el resto sí", () => {
    const linked = new Set(data["practice-specialties.csv"].rows.map((r) => r.practiceSlug));
    const unlinked = data["practices.csv"].rows.filter((r) => !linked.has(r.slug)).map((r) => r.code);
    expect(unlinked.sort()).toEqual(["420101", "420201"]);
  });
});

describe("catálogo: alias", () => {
  it.each(["specialties.csv", "practices.csv", "payers.csv"] as FileName[])(
    "%s: ningún alias apunta a otra entidad (nombre o alias ajeno con la misma matchKey)",
    (f) => {
      const owners = new Map<string, Set<string>>();
      const own = (k: string, slug: string) => owners.set(k, (owners.get(k) ?? new Set<string>()).add(slug));
      for (const r of data[f].rows) {
        own(matchKey(r.name), r.slug);
        for (const a of r.aliases.split("|").filter(Boolean)) own(matchKey(a), r.slug);
      }
      const ambiguous = data[f].rows.flatMap((r) =>
        r.aliases
          .split("|")
          .filter(Boolean)
          .filter((a) => [...(owners.get(matchKey(a)) ?? [])].some((s) => s !== r.slug))
          .map((a) => `${r.slug}: ${a}`),
      );
      expect(ambiguous).toEqual([]);
    },
  );
});

describe("catálogo: seed del benchmark 2026-09 (create-only)", () => {
  const base = new Map(data["payers.csv"].rows.map((r) => [r.slug, r]));
  const seedPayers = data["payers.seed-2026-09.csv"].rows;
  const seedPlans = data["payer-plans.seed-2026-09.csv"].rows;

  it("todo es source=CURATED", () => {
    expect([...seedPayers, ...seedPlans].filter((r) => r.source !== "CURATED")).toEqual([]);
  });

  it("cada prestadora del seed usa el MISMO slug y datos que en payers.csv (solo cambia source)", () => {
    for (const r of seedPayers) {
      const b = base.get(r.slug);
      expect(b, r.slug).toBeDefined();
      expect({ ...r, source: "" }).toEqual({ ...b, source: "" });
    }
  });

  it("los planes del seed están en payer-plans.csv y cuelgan de prestadoras del seed", () => {
    const plans = new Set(data["payer-plans.csv"].rows.map((r) => `${r.payerSlug}/${r.slug}`));
    const seedSlugs = new Set(seedPayers.map((r) => r.slug));
    expect(seedPlans.filter((r) => !plans.has(`${r.payerSlug}/${r.slug}`))).toEqual([]);
    expect(seedPlans.filter((r) => !seedSlugs.has(r.payerSlug))).toEqual([]);
  });

  it("cubre la lista mínima que pidió el dueño", () => {
    const got = seedPlans.map((r) => `${r.payerSlug}: ${r.name}`);
    expect(got).toEqual(
      expect.arrayContaining([
        "avalian: Plan Único", "avalian: Clásica Plan 2", "avalian: PMO", "avalian: Prepago", "avalian: Selecta",
        "avalian: Superior", "boreal: A2", "boreal: Magnun", "federada-salud: 7", "federada-salud: Plan Único",
        "grupo-alianza-medica: Todos los planes", "iapos: Plan Único", "ioma: IO Plan A", "ioma: IO Plan B",
        "ioma: Plan 056", "osam: No Mineros", "osam: Plan Único", "oschoca: Plan Único", "osdepym: Pyme 1000",
        "osdepym: Pyme 2000", "osdepym: Pyme 4000", "osdepym: Visitar", "osdop: Plan Único", "osecac: Azul",
        "osecac: Carhue",
      ]),
    );
    expect(seedPayers.map((r) => r.slug)).toEqual(expect.arrayContaining(["confianza", "gma-salud"]));
    // "Aca Salud" es Avalian (RNEMP: "AVALIAN … EX ACA SALUD"): va como alias, no como prestadora aparte.
    expect(base.get("avalian")?.aliases.split("|")).toContain("ACA Salud");
  });
});

describe("catálogo: planner real del import (B1.1) sobre los archivos del repo", () => {
  const inputs = readdirSync(DIR).flatMap((name) => {
    const file = classifyCatalogFile(name);
    return file ? [{ file, text: readFileSync(resolve(DIR, name), "utf8") }] : [];
  });
  const n = (f: FileName) => data[f].rows.length;

  it("reconoce los 7 archivos del contrato", () => {
    expect(inputs.map((i) => i.file.name).sort()).toEqual([...FILES].sort());
  });

  it("primer import contra base vacía: todo se crea, cero conflictos, el seed se saltea", () => {
    const { diffs } = planCatalogImport(inputs, emptyCatalogState());
    const summary = Object.fromEntries(
      diffs.map((d) => {
        const { file, create, conflicts, skipped } = summarizeDiff(d);
        return [file, { create, conflicts, skipped }];
      }),
    );
    expect(summary).toEqual({
      "specialties.csv": { create: n("specialties.csv"), conflicts: 0, skipped: 0 },
      "practices.csv": { create: n("practices.csv"), conflicts: 0, skipped: 0 },
      "practice-specialties.csv": { create: n("practice-specialties.csv"), conflicts: 0, skipped: 0 },
      "payers.csv": { create: n("payers.csv"), conflicts: 0, skipped: 0 },
      "payer-plans.csv": { create: n("payer-plans.csv"), conflicts: 0, skipped: 0 },
      "payers.seed-2026-09.csv": { create: 0, conflicts: 0, skipped: n("payers.seed-2026-09.csv") },
      "payer-plans.seed-2026-09.csv": { create: 0, conflicts: 0, skipped: n("payer-plans.seed-2026-09.csv") },
    });
  });

  it("el seed solo, contra base vacía, también entra sin conflictos", () => {
    const { diffs } = planCatalogImport(inputs.filter((i) => i.file.seed), emptyCatalogState());
    expect(diffs.map((d) => summarizeDiff(d)).map(({ file, create, conflicts }) => ({ file, create, conflicts })))
      .toEqual([
        { file: "payers.seed-2026-09.csv", create: n("payers.seed-2026-09.csv"), conflicts: 0 },
        { file: "payer-plans.seed-2026-09.csv", create: n("payer-plans.seed-2026-09.csv"), conflicts: 0 },
      ]);
  });
});
