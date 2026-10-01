/**
 * B1.1 CAT-import: núcleo puro del import del catálogo (lib/catalog/import-core.ts)
 * y su parser CSV (lib/catalog/csv.ts). Cubre el contrato de la sesión:
 * create / update / alias / conflicto / fila curada protegida / seed
 * create-only / idempotencia, con CSV chicos inline.
 */
import { describe, it, expect } from "vitest";
import { CsvParseError, parseCsv, parseCsvTable } from "@/lib/catalog/csv";
import {
  CATALOG_HEADERS,
  CatalogFormatError,
  classifyCatalogFile,
  diffHasChanges,
  emptyCatalogState,
  orderCatalogFiles,
  parseSourceDate,
  planCatalogFile,
  planCatalogImport,
  summarizeDiff,
  type CatalogFile,
  type CatalogKind,
  type CatalogState,
  type EntityDiff,
  type ExistingEntity,
  type LinkDiff,
  type PlanDiff,
} from "@/lib/catalog/import-core";

const D = new Date(Date.UTC(2026, 8, 30));

function file(name: string): CatalogFile {
  const f = classifyCatalogFile(name);
  if (!f) throw new Error(`nombre inválido ${name}`);
  return f;
}

/** CSV con el header del contrato y filas como objetos (columnas faltantes = ""). */
function csv(kind: CatalogKind, rows: Record<string, string>[]): string {
  const header = CATALOG_HEADERS[kind];
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [header.join(","), ...rows.map((r) => header.map((h) => esc(r[h] ?? "")).join(","))].join("\n") + "\n";
}

const payerRow = (slug: string, name: string, extra: Record<string, string> = {}) => ({
  slug,
  name,
  kind: "PREPAGA",
  source: "RNEMP",
  sourceDate: "2026-09-30",
  ...extra,
});

function existingPayer(slug: string, name: string, over: Partial<ExistingEntity> = {}): ExistingEntity {
  return {
    id: `id-${slug}`,
    slug,
    name,
    matchKey: name.toLowerCase(),
    aliases: [],
    source: "RNEMP",
    sourceRef: null,
    sourceDate: D,
    curatedAt: null,
    archivedAt: null,
    extra: { legalName: null, kind: "PREPAGA", registryCode: null, cuit: null, province: null },
    ...over,
  };
}

function plan(name: string, text: string, state: CatalogState = emptyCatalogState()) {
  return planCatalogFile(file(name), text, state);
}

describe("parseCsv (RFC 4180)", () => {
  it("comillas, comillas escapadas, comas y saltos de línea dentro de comillas", () => {
    const recs = parseCsv('a,b,c\n"x, y","di ""hola""","l1\nl2"\n');
    expect(recs).toEqual([
      { line: 1, cells: ["a", "b", "c"] },
      { line: 2, cells: ["x, y", 'di "hola"', "l1\nl2"] },
    ]);
  });

  it("BOM, CRLF, líneas en blanco y última línea sin \\n", () => {
    const recs = parseCsv("﻿a,b\r\n\r\n1,2\r\n3,");
    expect(recs).toEqual([
      { line: 1, cells: ["a", "b"] },
      { line: 3, cells: ["1", "2"] },
      { line: 4, cells: ["3", ""] },
    ]);
  });

  it("el número de línea cuenta los saltos dentro de comillas", () => {
    const recs = parseCsv('h\n"a\nb"\nc\n');
    expect(recs.map((r) => r.line)).toEqual([1, 2, 4]);
  });

  it("comillas sin cerrar o mal puestas → CsvParseError", () => {
    expect(() => parseCsv('a\n"abc\n')).toThrow(CsvParseError);
    expect(() => parseCsv('a\nab"c\n')).toThrow(CsvParseError);
    expect(() => parseCsv('a\n"ab"c\n')).toThrow(CsvParseError);
  });

  it("parseCsvTable: filas con otra cantidad de columnas van a malformed", () => {
    const t = parseCsvTable("a,b\n1,2\n1,2,3\n");
    expect(t.rows).toEqual([{ line: 2, values: { a: "1", b: "2" } }]);
    expect(t.malformed).toEqual([{ line: 3, got: 3, expected: 2 }]);
  });
});

describe("archivos del contrato", () => {
  it("clasifica base y seed; ignora lo que no es del contrato", () => {
    expect(classifyCatalogFile("payers.csv")).toEqual({ name: "payers.csv", kind: "payers", seed: false });
    expect(classifyCatalogFile("payer-plans.seed-2026-09.csv")).toEqual({
      name: "payer-plans.seed-2026-09.csv",
      kind: "payer-plans",
      seed: true,
    });
    expect(classifyCatalogFile("aliases.csv")).toBeNull();
    expect(classifyCatalogFile("SOURCES.md")).toBeNull();
  });

  it("orden: specialties → practices → practice-specialties → payers → payer-plans → seeds", () => {
    const names = [
      "payer-plans.seed-2026-09.csv",
      "payers.csv",
      "payers.seed-2026-09.csv",
      "practice-specialties.csv",
      "payer-plans.csv",
      "specialties.csv",
      "practices.csv",
    ];
    expect(orderCatalogFiles(names.map(file)).map((f) => f.name)).toEqual([
      "specialties.csv",
      "practices.csv",
      "practice-specialties.csv",
      "payers.csv",
      "payer-plans.csv",
      "payers.seed-2026-09.csv",
      "payer-plans.seed-2026-09.csv",
    ]);
  });

  it("header sin una columna del contrato → CatalogFormatError (aborta todo)", () => {
    expect(() => plan("payers.csv", "slug,name,kind\nx,X,PREPAGA\n")).toThrow(CatalogFormatError);
    expect(() => plan("payers.csv", "")).toThrow(CatalogFormatError);
  });

  it("columna extra → warning, no error", () => {
    const text = CATALOG_HEADERS.specialties.join(",") + ",extra\nkine,Kine,,REFEPS,,2026-09-30,,zzz\n";
    const { diff } = plan("specialties.csv", text);
    expect(diff.warnings).toEqual(["columnas fuera del contrato (ignoradas): extra"]);
    expect(diff.create).toHaveLength(1);
  });

  it("parseSourceDate: medianoche UTC sin importar el TZ del host; rechaza fechas imposibles", () => {
    expect(parseSourceDate("2026-09-30")?.toISOString()).toBe("2026-09-30T00:00:00.000Z");
    expect(parseSourceDate("2026-02-30")).toBeNull();
    expect(parseSourceDate("30/09/2026")).toBeNull();
  });
});

describe("planCatalogFile · entidades", () => {
  it("create: matchKey calculada, alias deduplicados (sin la clave del nombre), campos propios", () => {
    const text = csv("payers", [
      payerRow("osde", "OSDE", { aliases: "O.S.D.E.|Binario|binario", legalName: "Org. de Servicios", cuit: "30-1" }),
    ]);
    const { diff } = plan("payers.csv", text);
    const d = diff as EntityDiff;
    expect(d.create).toEqual([
      {
        slug: "osde",
        line: 2,
        name: "OSDE",
        matchKey: "osde",
        aliases: ["Binario"],
        source: "RNEMP",
        sourceRef: null,
        sourceDate: D,
        extra: { legalName: "Org. de Servicios", kind: "PREPAGA", registryCode: null, cuit: "30-1", province: null },
      },
    ]);
    expect(d.conflicts).toEqual([]);
  });

  it("practices: defaultDurationMin entero; inválido → conflicto 'invalido'", () => {
    const text = csv("practices", [
      { slug: "kine", name: "Kinesioterapia", defaultDurationMin: "45", source: "PMO", sourceDate: "2026-09-30" },
      { slug: "rpg", name: "RPG", defaultDurationMin: "4.5", source: "PMO", sourceDate: "2026-09-30" },
    ]);
    const d = plan("practices.csv", text).diff as EntityDiff;
    expect(d.create.map((c) => [c.slug, c.extra.defaultDurationMin])).toEqual([["kine", 45]]);
    expect(d.conflicts.map((c) => [c.line, c.reason])).toEqual([[3, "invalido"]]);
  });

  it("filas inválidas se reportan con su línea y no frenan al resto", () => {
    const text =
      csv("payers", [
        payerRow("ok", "Ok"),
        payerRow("BAD SLUG", "X"),
        payerRow("src", "Src", { source: "SSS" }),
        payerRow("fecha", "Fecha", { sourceDate: "2026-13-01" }),
        payerRow("kind", "Kind", { kind: "PREPAGO" }),
        payerRow("vacio", "..."),
      ]) + "a,b\n";
    const d = plan("payers.csv", text).diff as EntityDiff;
    expect(d.create.map((c) => c.slug)).toEqual(["ok"]);
    expect(d.conflicts.map((c) => [c.line, c.reason])).toEqual([
      [8, "invalido"], // columnas de menos (malformed, se reporta primero)
      [3, "invalido"],
      [4, "invalido"],
      [5, "invalido"],
      [6, "invalido"],
      [7, "invalido"],
    ]);
  });

  it("update de una fila NO curada: cambios por campo; el nombre viejo queda como alias", () => {
    const state = { ...emptyCatalogState(), payers: [existingPayer("osde", "OSDE", { aliases: ["Binario"] })] };
    const text = csv("payers", [payerRow("osde", "OSDE Argentina", { aliases: "Binario|Neo", cuit: "30-9" })]);
    const d = plan("payers.csv", text, state).diff as EntityDiff;
    expect(d.update).toEqual([
      {
        id: "id-osde",
        slug: "osde",
        line: 2,
        changes: { name: "OSDE Argentina", matchKey: "osde argentina", extra: { cuit: "30-9" } },
        changedFields: ["name", "matchKey", "cuit"],
        aliasAdd: ["OSDE", "Neo"],
      },
    ]);
    expect(d.create).toEqual([]);
  });

  it("sin cambios de campos pero con alias nuevos → aliasAdd (no update)", () => {
    const state = { ...emptyCatalogState(), payers: [existingPayer("osde", "osde")] };
    const d = plan("payers.csv", csv("payers", [payerRow("osde", "osde", { aliases: "Binario" })]), state)
      .diff as EntityDiff;
    expect(d.update).toEqual([]);
    expect(d.aliasAdd).toEqual([{ id: "id-osde", slug: "osde", line: 2, aliases: ["Binario"], curated: false }]);
  });

  it("fila CURADA: nunca pisa nombre ni campos; solo suma alias (incluido el nombre oficial)", () => {
    const curated = existingPayer("osde", "OSDE Curada", {
      matchKey: "osde curada",
      aliases: ["Binario"],
      curatedAt: D,
      extra: { legalName: "Curada SA", kind: "PREPAGA", registryCode: "1", cuit: null, province: null },
    });
    const state = { ...emptyCatalogState(), payers: [curated] };
    const text = csv("payers", [
      payerRow("osde", "OSDE Oficial", { aliases: "Binario|Neo", legalName: "Otra", kind: "MUTUAL", source: "RNOS" }),
    ]);
    const { diff, state: next } = plan("payers.csv", text, state);
    const d = diff as EntityDiff;
    expect(d.update).toEqual([]);
    expect(d.aliasAdd).toEqual([
      { id: "id-osde", slug: "osde", line: 2, aliases: ["OSDE Oficial", "Neo"], curated: true },
    ]);
    const after = next.payers.find((p) => p.slug === "osde")!;
    expect(after.name).toBe("OSDE Curada");
    expect(after.extra.legalName).toBe("Curada SA");
    expect(after.extra.kind).toBe("PREPAGA");
  });

  it("fila curada sin nada nuevo → unchanged", () => {
    const curated = existingPayer("osde", "OSDE", { matchKey: "osde", aliases: ["Binario"], curatedAt: D });
    const d = plan("payers.csv", csv("payers", [payerRow("osde", "O.S.D.E.", { aliases: "binario" })]), {
      ...emptyCatalogState(),
      payers: [curated],
    }).diff as EntityDiff;
    expect(summarizeDiff(d)).toMatchObject({ create: 0, update: 0, aliasAdd: 0, unchanged: 1 });
  });
});

describe("planCatalogFile · conflictos", () => {
  it("matchKey igual a otra fila de la base con slug distinto → conflicto, no se escribe", () => {
    const state = { ...emptyCatalogState(), payers: [existingPayer("osde", "osde")] };
    const d = plan("payers.csv", csv("payers", [payerRow("osde-2", "O.S.D.E. S.A."), payerRow("swiss", "Swiss")]), state)
      .diff as EntityDiff;
    expect(d.conflicts).toEqual([
      {
        file: "payers.csv",
        line: 2,
        slug: "osde-2",
        reason: "matchKey-duplicado",
        detail: '"O.S.D.E. S.A." → "osde" ya es de osde',
        otherSlugs: ["osde"],
      },
    ]);
    expect(d.create.map((c) => c.slug)).toEqual(["swiss"]);
  });

  it("matchKey igual a un ALIAS de otra fila → conflicto", () => {
    const state = { ...emptyCatalogState(), payers: [existingPayer("osde", "osde", { aliases: ["Binario"] })] };
    const d = plan("payers.csv", csv("payers", [payerRow("binario", "Binario")]), state).diff as EntityDiff;
    expect(d.conflicts.map((c) => [c.slug, c.reason, c.otherSlugs])).toEqual([["binario", "matchKey-duplicado", ["osde"]]]);
  });

  it("alias que apunta a dos filas (base) → conflicto 'alias-ambiguo'", () => {
    const state = { ...emptyCatalogState(), payers: [existingPayer("osde", "osde", { aliases: ["Plan Joven"] })] };
    const d = plan("payers.csv", csv("payers", [payerRow("swiss", "Swiss", { aliases: "plan joven" })]), state)
      .diff as EntityDiff;
    expect(d.conflicts.map((c) => [c.slug, c.reason, c.otherSlugs])).toEqual([["swiss", "alias-ambiguo", ["osde"]]]);
    expect(d.create).toEqual([]);
  });

  it("choque entre dos filas del MISMO archivo → se saltean las dos (no depende del orden)", () => {
    const rows = [payerRow("a", "A", { aliases: "Compartido" }), payerRow("b", "B", { aliases: "compartido" })];
    for (const order of [rows, [...rows].reverse()]) {
      const d = plan("payers.csv", csv("payers", order)).diff as EntityDiff;
      expect(d.create).toEqual([]);
      expect(d.conflicts.map((c) => c.slug).sort()).toEqual(["a", "b"]);
    }
  });

  it("slug repetido en el archivo → todas sus filas son conflicto", () => {
    const d = plan("payers.csv", csv("payers", [payerRow("a", "A"), payerRow("a", "A2"), payerRow("b", "B")]))
      .diff as EntityDiff;
    expect(d.conflicts.map((c) => [c.line, c.reason])).toEqual([
      [2, "slug-duplicado"],
      [3, "slug-duplicado"],
    ]);
    expect(d.create.map((c) => c.slug)).toEqual(["b"]);
  });
});

describe("filas archivadas (contrato B1.3: archivar y merge marcan curatedAt)", () => {
  // Merge OSDE Viejo → OSDE: el origen queda archivado + curado con su slug y
  // matchKey, y su nombre pasa a alias del destino.
  const origin = existingPayer("osde-viejo", "osde viejo", { name: "OSDE Viejo", archivedAt: D, curatedAt: D });
  const dest = existingPayer("osde", "osde", { aliases: ["OSDE Viejo"], curatedAt: D });
  const merged = () => ({ ...emptyCatalogState(), payers: [origin, dest] });

  it("la fila del origen en el CSV no se toca ni da conflicto falso contra el alias del destino", () => {
    const text = csv("payers", [payerRow("osde-viejo", "OSDE Viejo"), payerRow("osde", "OSDE", { aliases: "OSDE Viejo" })]);
    const { diff, state } = plan("payers.csv", text, merged());
    expect(summarizeDiff(diff)).toMatchObject({ create: 0, update: 0, aliasAdd: 0, unchanged: 1, archived: 1, conflicts: 0 });
    expect(state.payers.find((p) => p.slug === "osde-viejo")).toEqual(origin);
  });

  it("archivada: no se desarchiva ni se actualiza aunque el CSV traiga otros datos", () => {
    const text = csv("payers", [payerRow("osde-viejo", "OSDE Viejo Renombrado", { kind: "MUTUAL" })]);
    const d = plan("payers.csv", text, merged()).diff as EntityDiff;
    expect(summarizeDiff(d)).toMatchObject({ create: 0, update: 0, aliasAdd: 0, archived: 1, conflicts: 0 });
  });

  it("slug nuevo con la matchKey de una archivada (sin dueño activo) → conflicto: el @unique la sigue ocupando", () => {
    const lone = existingPayer("vieja", "vieja", { archivedAt: D, curatedAt: D });
    const d = plan("payers.csv", csv("payers", [payerRow("vieja-2", "Vieja")]), { ...emptyCatalogState(), payers: [lone] })
      .diff as EntityDiff;
    expect(d.create).toEqual([]);
    expect(d.conflicts.map((c) => [c.slug, c.reason, c.otherSlugs])).toEqual([["vieja-2", "matchKey-duplicado", ["vieja"]]]);
    expect(d.conflicts[0].detail).toContain("(archivada)");
  });

  it("los ALIAS de una archivada no cuentan: otra fila puede usarlos", () => {
    const old = existingPayer("vieja", "vieja", { aliases: ["Compartido"], archivedAt: D, curatedAt: D });
    const d = plan("payers.csv", csv("payers", [payerRow("nueva", "Nueva", { aliases: "Compartido" })]), {
      ...emptyCatalogState(),
      payers: [old],
    }).diff as EntityDiff;
    expect(d.conflicts).toEqual([]);
    expect(d.create.map((c) => c.slug)).toEqual(["nueva"]);
  });

  it("seed: no re-crea una archivada (por slug ni por matchKey)", () => {
    const text = csv("payers", [payerRow("osde-viejo", "X", { source: "CURATED" }), payerRow("otro", "OSDE Viejo", { source: "CURATED" })]);
    const d = plan("payers.seed-2026-09.csv", text, merged()).diff as EntityDiff;
    expect(summarizeDiff(d)).toMatchObject({ create: 0, conflicts: 0 });
    expect(d.archived + d.skipped).toBe(2);
  });

  it("plan global archivado: no se pisa ni se re-crea; su nombre queda libre", () => {
    const state: CatalogState = {
      ...emptyCatalogState(),
      payers: [existingPayer("osde", "osde")],
      payerPlans: [
        { id: "p1", payerSlug: "osde", slug: "210", name: "Plan 210", source: "CURATED", sourceDate: D, promotedAt: null, archivedAt: D },
      ],
    };
    const text = csv("payer-plans", [
      { payerSlug: "osde", slug: "210", name: "Plan 210 Nuevo", source: "CURATED", sourceDate: "2026-10-01" },
      { payerSlug: "osde", slug: "210-v2", name: "Plan 210", source: "CURATED", sourceDate: "2026-10-01" },
    ]);
    const d = plan("payer-plans.csv", text, state).diff as PlanDiff;
    expect(summarizeDiff(d)).toMatchObject({ create: 1, update: 0, archived: 1, conflicts: 0 });
    expect(d.create.map((c) => c.slug)).toEqual(["210-v2"]);
  });
});

describe("seed create-only", () => {
  const seedName = "payers.seed-2026-09.csv";

  it("existe por slug → skipped aunque cambien los datos", () => {
    const state = { ...emptyCatalogState(), payers: [existingPayer("galeno", "galeno")] };
    const d = plan(seedName, csv("payers", [payerRow("galeno", "Galeno Renombrado", { source: "CURATED" })]), state)
      .diff as EntityDiff;
    expect(summarizeDiff(d)).toMatchObject({ create: 0, update: 0, aliasAdd: 0, skipped: 1, conflicts: 0 });
  });

  it("existe por matchKey (otro slug) → skipped, no conflicto", () => {
    const state = { ...emptyCatalogState(), payers: [existingPayer("osde", "osde")] };
    const d = plan(seedName, csv("payers", [payerRow("osde-bench", "OSDE S.A.", { source: "CURATED" })]), state)
      .diff as EntityDiff;
    expect(summarizeDiff(d)).toMatchObject({ create: 0, skipped: 1, conflicts: 0 });
  });

  it("no existe → create", () => {
    const d = plan(seedName, csv("payers", [payerRow("nueva", "Nueva", { source: "CURATED" })])).diff as EntityDiff;
    expect(d.create.map((c) => [c.slug, c.source])).toEqual([["nueva", "CURATED"]]);
  });
});

describe("practice-specialties y payer-plans", () => {
  const specialties = csv("specialties", [{ slug: "kine", name: "Kinesiología", source: "REFEPS", sourceDate: "2026-09-30" }]);
  const practices = csv("practices", [{ slug: "rpg", name: "RPG", source: "CURATED", sourceDate: "2026-09-30" }]);

  it("links: ven lo creado en el mismo import; referencia desconocida → conflicto; repetido → una vez", () => {
    const links = csv("practice-specialties", [
      { practiceSlug: "rpg", specialtySlug: "kine" },
      { practiceSlug: "rpg", specialtySlug: "kine" },
      { practiceSlug: "rpg", specialtySlug: "nope" },
    ]);
    const { diffs } = planCatalogImport(
      [
        { file: file("practice-specialties.csv"), text: links },
        { file: file("practices.csv"), text: practices },
        { file: file("specialties.csv"), text: specialties },
      ],
      emptyCatalogState(),
    );
    const d = diffs[2] as LinkDiff;
    expect(d.create).toEqual([{ practiceSlug: "rpg", specialtySlug: "kine", line: 2 }]);
    expect(d.unchanged).toBe(1);
    expect(d.conflicts.map((c) => [c.line, c.reason])).toEqual([[4, "referencia-desconocida"]]);
  });

  it("plans: payer del mismo import ok; payer desconocido → conflicto; mismo nombre en la prestadora → conflicto", () => {
    const plans = csv("payer-plans", [
      { payerSlug: "osde", slug: "210", name: "Plan 210", source: "CURATED", sourceDate: "2026-09-30" },
      { payerSlug: "osde", slug: "p-210", name: "PLAN-210", source: "CURATED", sourceDate: "2026-09-30" },
      { payerSlug: "osde", slug: "310", name: "Plan 310", source: "CURATED", sourceDate: "2026-09-30" },
      { payerSlug: "nope", slug: "x", name: "X", source: "CURATED", sourceDate: "2026-09-30" },
    ]);
    const { diffs } = planCatalogImport(
      [
        { file: file("payer-plans.csv"), text: plans },
        { file: file("payers.csv"), text: csv("payers", [payerRow("osde", "OSDE")]) },
      ],
      emptyCatalogState(),
    );
    const d = diffs[1] as PlanDiff;
    expect(d.create.map((c) => `${c.payerSlug}/${c.slug}`)).toEqual(["osde/310"]);
    expect(d.conflicts.map((c) => [c.slug, c.reason]).sort()).toEqual([
      ["nope/x", "referencia-desconocida"],
      ["osde/210", "matchKey-duplicado"],
      ["osde/p-210", "matchKey-duplicado"],
    ]);
  });

  it("plans: update de un global; uno PROMOVIDO desde un consultorio no se pisa", () => {
    const state: CatalogState = {
      ...emptyCatalogState(),
      payers: [existingPayer("osde", "osde")],
      payerPlans: [
        { id: "p1", payerSlug: "osde", slug: "210", name: "Plan 210", source: "CURATED", sourceDate: D, promotedAt: null, archivedAt: null },
        { id: "p2", payerSlug: "osde", slug: "310", name: "Plan 310", source: "TENANT", sourceDate: D, promotedAt: D, archivedAt: null },
      ],
    };
    const text = csv("payer-plans", [
      { payerSlug: "osde", slug: "210", name: "Plan 210 Nuevo", source: "CURATED", sourceDate: "2026-10-01" },
      { payerSlug: "osde", slug: "310", name: "Plan 310 Oficial", source: "CURATED", sourceDate: "2026-10-01" },
    ]);
    const d = plan("payer-plans.csv", text, state).diff as PlanDiff;
    expect(d.update).toEqual([
      {
        id: "p1",
        payerSlug: "osde",
        slug: "210",
        line: 2,
        changes: { name: "Plan 210 Nuevo", sourceDate: new Date(Date.UTC(2026, 9, 1)) },
        changedFields: ["name", "sourceDate"],
      },
    ]);
    expect(d.unchanged).toBe(1);
  });

  it("plans seed: existe por slug o por nombre en la prestadora → skipped", () => {
    const state: CatalogState = {
      ...emptyCatalogState(),
      payers: [existingPayer("osde", "osde")],
      payerPlans: [
        { id: "p1", payerSlug: "osde", slug: "210", name: "Plan 210", source: "CURATED", sourceDate: D, promotedAt: null, archivedAt: null },
      ],
    };
    const text = csv("payer-plans", [
      { payerSlug: "osde", slug: "210", name: "Otro nombre", source: "CURATED", sourceDate: "2026-09-30" },
      { payerSlug: "osde", slug: "plan-210", name: "PLAN 210", source: "CURATED", sourceDate: "2026-09-30" },
      { payerSlug: "osde", slug: "410", name: "Plan 410", source: "CURATED", sourceDate: "2026-09-30" },
    ]);
    const d = plan("payer-plans.seed-2026-09.csv", text, state).diff as PlanDiff;
    expect(summarizeDiff(d)).toMatchObject({ create: 1, update: 0, skipped: 2, conflicts: 0 });
  });
});

describe("idempotencia", () => {
  it("planificar → aplicar (estado resultante) → planificar de nuevo = 0 cambios en todos los archivos", () => {
    const inputs = [
      {
        file: file("specialties.csv"),
        text: csv("specialties", [{ slug: "kine", name: "Kinesiología", aliases: "Kinesio", source: "REFEPS", sourceDate: "2026-09-30" }]),
      },
      {
        file: file("practices.csv"),
        text: csv("practices", [{ slug: "rpg", name: "RPG", defaultDurationMin: "60", source: "CURATED", sourceDate: "2026-09-30" }]),
      },
      { file: file("practice-specialties.csv"), text: csv("practice-specialties", [{ practiceSlug: "rpg", specialtySlug: "kine" }]) },
      { file: file("payers.csv"), text: csv("payers", [payerRow("osde", "OSDE", { aliases: "Binario" })]) },
      {
        file: file("payer-plans.csv"),
        text: csv("payer-plans", [{ payerSlug: "osde", slug: "210", name: "Plan 210", source: "CURATED", sourceDate: "2026-09-30" }]),
      },
      { file: file("payers.seed-2026-09.csv"), text: csv("payers", [payerRow("galeno", "Galeno", { source: "CURATED" })]) },
    ];
    const first = planCatalogImport(inputs, emptyCatalogState());
    expect(first.diffs.every(diffHasChanges)).toBe(true);
    const second = planCatalogImport(inputs, first.state);
    expect(second.diffs.map(summarizeDiff).map((s) => [s.file, s.create + s.update + s.aliasAdd, s.conflicts])).toEqual([
      ["specialties.csv", 0, 0],
      ["practices.csv", 0, 0],
      ["practice-specialties.csv", 0, 0],
      ["payers.csv", 0, 0],
      ["payer-plans.csv", 0, 0],
      ["payers.seed-2026-09.csv", 0, 0],
    ]);
  });

  it("update con rename: la segunda corrida tampoco cambia nada (el alias del nombre viejo ya está)", () => {
    const state = { ...emptyCatalogState(), payers: [existingPayer("osde", "osde")] };
    const text = csv("payers", [payerRow("osde", "OSDE Argentina")]);
    const first = plan("payers.csv", text, state);
    expect(diffHasChanges(first.diff)).toBe(true);
    expect(diffHasChanges(plan("payers.csv", text, first.state).diff)).toBe(false);
  });
});
