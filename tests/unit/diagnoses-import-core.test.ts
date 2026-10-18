/**
 * FC-1d (C-FC11): núcleo puro del importador CIE-11. Fixtures SINTÉTICOS
 * (`tests/fixtures/icd11/*.txt`, códigos 9Z**, URIs 9000000**): nunca datos
 * reales de la OMS en el repo (licencia CC BY-ND 3.0 IGO; el archivo real vive
 * en `data/icd11/`, ignorado).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_ICD_CHAPTERS,
  IcdImportError,
  decodeTabulationBytes,
  icdPlanHasChanges,
  inspectTabulation,
  normalizeIcdSearchText,
  parseChapterSpec,
  parseIcdTabulation,
  planIcdImport,
  stripTabulationDepth,
  summarizeIcdPlan,
  type ExistingDiagnosisCode,
  type IcdImportPlan,
} from "@/lib/diagnoses-import-core";

const FIX = join(process.cwd(), "tests/fixtures/icd11");
const miniBytes = readFileSync(join(FIX, "simple-tabulation.mini.txt"));
const v2Bytes = readFileSync(join(FIX, "simple-tabulation.v2.txt"));
const NOW = new Date("2026-10-19T12:00:00.000Z");
const CHAPTERS = parseChapterSpec(DEFAULT_ICD_CHAPTERS);

const rowsOf = (bytes: Uint8Array) => parseIcdTabulation(decodeTabulationBytes(bytes).text).rows;
const plan = (bytes: Uint8Array, existing: ExistingDiagnosisCode[], release: string, extra = {}) =>
  planIcdImport(rowsOf(bytes), existing, { release, chapters: CHAPTERS, now: NOW, ...extra });

/** Lo que quedaría en la base después de aplicar el plan (para encadenar corridas sin DB). */
function applyInMemory(existing: ExistingDiagnosisCode[], p: IcdImportPlan): ExistingDiagnosisCode[] {
  const byId = new Map(existing.map((e) => [e.id, { ...e }]));
  for (const u of [...p.update, ...p.unretire]) {
    Object.assign(byId.get(u.id)!, u.target, { retiredAt: null, retiredInRelease: null });
  }
  for (const r of p.retire) Object.assign(byId.get(r.id)!, { retiredAt: p.retiredAt, retiredInRelease: p.release });
  const created = p.create.map((t, i) => ({ ...t, id: `new-${t.code}-${i}`, retiredAt: null, retiredInRelease: null }));
  return [...byId.values(), ...created];
}

/** UTF-16LE con BOM: lo que exporta Excel como «Texto Unicode». */
function toUtf16le(text: string): Uint8Array {
  return new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]));
}

describe("[FC-1d] decodificación y encabezados", () => {
  it("[FC-1d] encabezados por nombre: UTF-8 con BOM", () => {
    const { text, encoding } = decodeTabulationBytes(miniBytes);
    expect(encoding).toBe("utf-8-bom");
    const parsed = parseIcdTabulation(text);
    expect(parsed.headers[0]).toBe("Foundation URI"); // el BOM no queda pegado al primer encabezado
    expect(parsed.uriHeader).toBe("Linearization (release) URI");
    const lumbalgia = parsed.rows.find((r) => r.code === "9Z10.0")!;
    expect(lumbalgia).toMatchObject({
      title: "Lumbalgia sintética aguda",
      rawTitle: "- - - Lumbalgia sintética aguda",
      classKind: "category",
      uri: "http://id.who.int/icd/release/11/2025-01/mms/900000011",
      foundationUri: "http://id.who.int/icd/entity/900000011",
      chapter: "15",
    });
  });

  it("[FC-1d] encabezados por nombre: UTF-16LE (Texto Unicode), con columnas en otro orden y «Linearization URI»", () => {
    const text = [
      "Title\tisLeaf\tCode\tChapterNo\tClassKind\tLinearization URI",
      "- - Cuádriceps sintético\tTrue\t9Z1A\t1\tcategory\thttp://id.who.int/icd/release/11/2025-01/mms/900000030",
    ].join("\r\n");
    const { text: decoded, encoding } = decodeTabulationBytes(toUtf16le(text));
    expect(encoding).toBe("utf-16le");
    const parsed = parseIcdTabulation(decoded);
    expect(parsed.uriHeader).toBe("Linearization URI");
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({
      code: "9Z1A",
      title: "Cuádriceps sintético",
      chapter: "01", // «1» → «01»
      isLeafRaw: "True",
      isResidualRaw: null, // columna opcional ausente
      foundationUri: null,
    });
    // UTF-16LE del fixture completo: mismas filas que en UTF-8.
    const mini = decodeTabulationBytes(miniBytes).text;
    expect(rowsOf(toUtf16le(mini))).toEqual(rowsOf(miniBytes));
  });

  it("[FC-1d] solo se saca la sangría: el resto del título queda intacto", () => {
    expect(stripTabulationDepth("- - - Lumbalgia sintética aguda")).toBe("Lumbalgia sintética aguda");
    expect(stripTabulationDepth("-Lumbalgia")).toBe("Lumbalgia");
    expect(stripTabulationDepth("Cervicalgia sintética - tipo mecánico")).toBe("Cervicalgia sintética - tipo mecánico");
    expect(stripTabulationDepth("Título con espacio final ")).toBe("Título con espacio final ");
    const cervical = rowsOf(miniBytes).find((r) => r.code === "9Z11")!;
    expect(cervical.title).toBe("Cervicalgia sintética - tipo mecánico");
  });

  it("[FC-1d] un encabezado obligatorio faltante aborta", () => {
    const sinUri = "Code\tTitle\tClassKind\tChapterNo\n9Z10\t- Dolor\tcategory\t15\n";
    expect(() => parseIcdTabulation(sinUri)).toThrow(IcdImportError);
    expect(() => parseIcdTabulation(sinUri)).toThrow(/Linearization \(release\) URI \| Linearization URI/);
    const sinTitle = "Code\tClassKind\tLinearization URI\n";
    expect(() => parseIcdTabulation(sinTitle)).toThrow(/faltan encabezados obligatorios: Title/);
    expect(() => parseIcdTabulation("")).toThrow(/vacío/);
  });

  it("[FC-1d] campos entre comillas al estilo Excel (tab y comillas adentro)", () => {
    const text = 'Code\tTitle\tClassKind\tLinearization URI\n9Z10\t"- Dolor ""sintético""\tcon tab"\tcategory\thttp://id.who.int/icd/release/11/2025-01/mms/1\n';
    const [row] = parseIcdTabulation(text).rows;
    expect(row.title).toBe('Dolor "sintético"\tcon tab');
    expect(row.line).toBe(2);
  });

  it("[FC-1d] bytes que no decodifican abortan (no se guardan títulos con «�»)", () => {
    expect(() => decodeTabulationBytes(new Uint8Array([0x43, 0x6f, 0xff, 0x64, 0x65]))).toThrow(IcdImportError);
  });

  it("[FC-1d] --inspect: encoding, encabezados y 5 filas", () => {
    const i = inspectTabulation(miniBytes);
    expect(i.encoding).toBe("utf-8-bom");
    expect(i.headers).toContain("ClassKind");
    expect(i.sample).toHaveLength(5);
    expect(i.totalRows).toBe(10);
    expect(i.categoryRows).toBe(8);
  });
});

describe("[FC-1d] searchText y capítulos", () => {
  it("[FC-1d] searchText es nuestro: NFD sin tildes, minúsculas, [^a-z0-9] → espacio, con el código", () => {
    expect(normalizeIcdSearchText("9Z1A", "Contractura sintética del músculo cuádriceps, niño")).toBe(
      "9z1a contractura sintetica del musculo cuadriceps nino",
    );
    expect(normalizeIcdSearchText("9Z10.0", "Lumbalgia  (aguda)")).toBe("9z10 0 lumbalgia aguda");
  });

  it("[FC-1d] FC-D30: 01-26 y V por defecto; X solo si se pide; rangos inválidos abortan", () => {
    expect(CHAPTERS).toHaveLength(27);
    expect(CHAPTERS).toContain("01");
    expect(CHAPTERS).toContain("26");
    expect(CHAPTERS).toContain("V");
    expect(CHAPTERS).not.toContain("X");
    expect(parseChapterSpec("15, 8 ,V")).toEqual(["15", "08", "V"]);
    expect(() => parseChapterSpec("01-27")).toThrow(IcdImportError);
    expect(() => parseChapterSpec("Q")).toThrow(IcdImportError);
  });
});

describe("[FC-1d] plan", () => {
  it("[FC-1d] plan: crea, actualiza, retira, reactiva; capítulo X afuera", () => {
    const first = plan(miniBytes, [], "2025-01");
    expect(summarizeIcdPlan(first)).toEqual({
      create: 7,
      update: 0,
      retire: 0,
      unretire: 0,
      unchanged: 0,
      // capítulo + bloque + 9ZX1 (capítulo X)
      excluded: 3,
      conflicts: 0,
    });
    expect(first.create.map((c) => c.code)).not.toContain("9ZX1");
    expect(first.create.find((c) => c.code === "9Z10.Y")).toEqual({
      code: "9Z10.Y",
      title: "Otro dolor lumbar sintético especificado",
      uri: "http://id.who.int/icd/release/11/2025-01/mms/900000012/other",
      foundationUri: "http://id.who.int/icd/entity/900000012",
      chapter: "15",
      isLeaf: true,
      isResidual: true,
      release: "2025-01",
      searchText: "9z10 y otro dolor lumbar sintetico especificado",
    });
    expect(first.create.find((c) => c.code === "9ZV1")).toMatchObject({ chapter: "V" });
    expect(first.create.find((c) => c.code === "9Z10")).toMatchObject({ isLeaf: false, isResidual: false });

    // Idempotente: aplicado y re-planificado, 0 cambios.
    const db1 = applyInMemory([], first);
    const again = plan(miniBytes, db1, "2025-01");
    expect(icdPlanHasChanges(again)).toBe(false);
    expect(again.unchanged).toBe(7);

    // v2 (release 2026-01): 9Z10.0 cambia de título, 9Z11 desaparece, 9Z12 es nueva.
    const second = plan(v2Bytes, db1, "2026-01");
    expect(summarizeIcdPlan(second)).toMatchObject({ create: 1, update: 6, retire: 1, unretire: 0, unchanged: 0 });
    expect(second.create.map((c) => c.code)).toEqual(["9Z12"]);
    expect(second.retire).toEqual([
      { id: db1.find((e) => e.code === "9Z11")!.id, code: "9Z11", title: "Cervicalgia sintética - tipo mecánico" },
    ]);
    const lumb = second.update.find((u) => u.code === "9Z10.0")!;
    expect(lumb.changedFields).toEqual(["title", "uri", "release", "searchText"]);
    expect(lumb.target.title).toBe("Lumbalgia sintética aguda con irradiación");
    // El resto cambia solo por la release (la URI la trae).
    expect(second.update.find((u) => u.code === "9ZV1")!.changedFields).toEqual(["uri", "release"]);

    // Reactiva: 9Z11 vuelve en una release posterior.
    const db2 = applyInMemory(db1, second);
    expect(db2.find((e) => e.code === "9Z11")).toMatchObject({ retiredAt: NOW, retiredInRelease: "2026-01" });
    const backText = decodeTabulationBytes(miniBytes).text.replace(/2025-01/g, "2026-07");
    const third = planIcdImport(parseIcdTabulation(backText).rows, db2, { release: "2026-07", chapters: CHAPTERS, now: NOW });
    expect(third.unretire.map((u) => u.code)).toEqual(["9Z11"]);
    expect(third.retire.map((r) => r.code)).toEqual(["9Z12"]);
    // Ya retirada no se vuelve a retirar.
    const db3 = applyInMemory(db2, third);
    const fourth = planIcdImport(parseIcdTabulation(backText).rows, db3, { release: "2026-07", chapters: CHAPTERS, now: NOW });
    expect(icdPlanHasChanges(fourth)).toBe(false);
  });

  it("[FC-1d] import parcial (--chapters=V) no retira los otros capítulos", () => {
    const db1 = applyInMemory([], plan(miniBytes, [], "2025-01"));
    const onlyV = planIcdImport(rowsOf(miniBytes), db1, { release: "2025-01", chapters: ["V"], now: NOW });
    expect(onlyV.retire).toEqual([]);
    expect(onlyV.unchanged).toBe(1);
  });

  it("[FC-1d] downgrade rechazado salvo --allow-downgrade", () => {
    const db1 = applyInMemory([], plan(v2Bytes, [], "2026-01"));
    expect(() => plan(miniBytes, db1, "2025-01")).toThrow(/downgrade rechazado/);
    expect(() => plan(miniBytes, db1, "2025-01", { allowDowngrade: true })).not.toThrow();
  });

  it("[FC-1d] la release de las URIs tiene que coincidir con --release; release mal formada aborta", () => {
    expect(() => plan(miniBytes, [], "2026-01")).toThrow(/release 2025-01 y --release dice 2026-01/);
    expect(() => plan(miniBytes, [], "2025-1")).toThrow(/--release inválido/);
  });

  it("[FC-1d] conflictos: la fila no entra pero su código no se retira", () => {
    const head = "Code\tTitle\tClassKind\tLinearization URI\tChapterNo\tisLeaf";
    const u = (n: number) => `http://id.who.int/icd/release/11/2025-01/mms/${n}`;
    const text = [
      head,
      `9Z10\t- Dolor\tcategory\t${u(1)}\t15\tTrue`,
      `9Z10\t- Dolor repetido\tcategory\t${u(2)}\t15\tTrue`,
      `9z11\t- Minúscula\tcategory\t${u(3)}\t15\tTrue`,
      `9Z12\t- - \tcategory\t${u(4)}\t15\tTrue`,
      `9Z13\t- Sin URI\tcategory\t\t15\tTrue`,
      `9Z14\t- Bool raro\tcategory\t${u(5)}\t15\tquizás`,
      `9Z15\t- ${"x".repeat(501)}\tcategory\t${u(6)}\t15\tTrue`,
    ].join("\n");
    const existing: ExistingDiagnosisCode[] = [
      {
        id: "e13",
        code: "9Z13",
        title: "Sin URI",
        uri: u(9),
        foundationUri: null,
        chapter: "15",
        isLeaf: true,
        isResidual: false,
        release: "2025-01",
        searchText: "9z13 sin uri",
        retiredAt: null,
        retiredInRelease: null,
      },
    ];
    const p = planIcdImport(parseIcdTabulation(text).rows, existing, { release: "2025-01", chapters: CHAPTERS, now: NOW });
    expect(p.create.map((c) => c.code)).toEqual(["9Z10"]);
    expect(p.conflicts.map((c) => [c.line, c.code, c.reason])).toEqual([
      [3, "9Z10", "codigo-duplicado"],
      [4, "9z11", "codigo-invalido"],
      [5, "9Z12", "titulo-invalido"],
      [6, "9Z13", "uri-invalida"],
      [7, "9Z14", "booleano-invalido"],
      [8, "9Z15", "titulo-invalido"], // nunca se acorta un título oficial
    ]);
    expect(p.retire).toEqual([]);
  });
});
