import { describe, expect, it } from "vitest";
import {
  buildHcPrintableContent,
  canonicalJson,
  formatLicense,
  formatSignatureLine,
  hcFileBase,
  hcSourceVersion,
  honorificLabel,
  verificationCodeFromSha256,
  hcDateLabel,
  hcDiagnosisLine,
  hcPatientLine,
  hcVoidedLine,
  HC_DIAGNOSIS_SOURCE_LABEL,
  HC_ICD_ATTRIBUTION,
  type HcPrintSource,
  type HcPrintSourceEntry,
} from "@/lib/hc-print-model";
import { DIAGNOSIS_SOURCE_LABEL, ICD11_ATTRIBUTION, ICD11_SHORT_ATTRIBUTION } from "@/lib/diagnoses-types";

// FC-1b3: lo chico y estable del modelo imprimible (C-FC4). FC-2e: `buildHcPrintableContent`, `hcFileBase` y las
// líneas de texto que comparten el PDF y el Word.

describe("[FC-1b] formatLicense / formatSignatureLine", () => {
  it("número pelado → MN (el campo nació como «Matrícula Nacional»)", () => {
    expect(formatLicense("1234")).toBe("MN 1234");
    expect(formatLicense("  12 345  ")).toBe("MN 12 345");
  });

  it("normaliza los prefijos escritos a mano", () => {
    expect(formatLicense("m.p. 55")).toBe("MP 55");
    expect(formatLicense("M.N. 1234")).toBe("MN 1234");
    expect(formatLicense("mn:1234")).toBe("MN 1234");
    expect(formatLicense("MP55")).toBe("MP 55");
    expect(formatLicense("M. P. 9")).toBe("MP 9");
    expect(formatLicense("Matrícula 777")).toBe("MN 777");
    expect(formatLicense("Mat. N° 88")).toBe("MN 88");
    expect(formatLicense("Matrícula provincial 55")).toBe("MP 55");
  });

  it("es idempotente (enmendar no re-formatea la matrícula)", () => {
    for (const raw of ["1234", "m.p. 55", "MN 1234", "MP 55", "Matrícula 777"]) {
      const once = formatLicense(raw);
      expect(formatLicense(once)).toBe(once);
    }
  });

  it("no confunde una palabra que empieza con M con el prefijo", () => {
    expect(formatLicense("Mendoza 12")).toBe("MN Mendoza 12");
    expect(formatLicense("MNX 3")).toBe("MN MNX 3");
  });

  it("vacío o solo prefijo → null; recorta a 60 (CHECK de M14)", () => {
    expect(formatLicense(null)).toBeNull();
    expect(formatLicense(undefined)).toBeNull();
    expect(formatLicense("   ")).toBeNull();
    expect(formatLicense("MP")).toBeNull();
    const long = formatLicense("9".repeat(200));
    expect(long).not.toBeNull();
    expect(Array.from(long!).length).toBeLessThanOrEqual(60);
  });

  it("honorificLabel mapea los cinco códigos del CHECK y nada más", () => {
    expect(honorificLabel("LIC")).toBe("Lic.");
    expect(honorificLabel("KLGO")).toBe("Klgo.");
    expect(honorificLabel("KLGA")).toBe("Klga.");
    expect(honorificLabel("DR")).toBe("Dr.");
    expect(honorificLabel("DRA")).toBe("Dra.");
    expect(honorificLabel(null)).toBeNull();
    expect(honorificLabel("PROF")).toBeNull();
    expect(honorificLabel("")).toBeNull();
  });

  it("formatSignatureLine: «{Lic.} {nombre} · {matrícula}» con cada parte opcional", () => {
    expect(formatSignatureLine({ honorific: "LIC", name: "Ana Pérez", license: "MN 1234" })).toBe(
      "Lic. Ana Pérez · MN 1234",
    );
    expect(formatSignatureLine({ honorific: null, name: "Ana Pérez", license: "MN 1234" })).toBe("Ana Pérez · MN 1234");
    expect(formatSignatureLine({ honorific: "DRA", name: " Ana  Pérez ", license: null })).toBe("Dra. Ana Pérez");
    expect(formatSignatureLine({ honorific: "XX", name: "Ana Pérez", license: "  " })).toBe("Ana Pérez");
  });
});

describe("[FC-1b] hcSourceVersion", () => {
  const am = (id: string, revision = 1, voided = false) => ({ id, revision, voided });

  it("cambia con cada edición o enmienda", () => {
    const base = hcSourceVersion({ revision: 1 }, [am("a")]);
    expect(hcSourceVersion({ revision: 2 }, [am("a")])).not.toBe(base); // edición de la raíz
    expect(hcSourceVersion({ revision: 1 }, [am("a"), am("b")])).not.toBe(base); // enmienda nueva
    expect(hcSourceVersion({ revision: 1 }, [am("a", 2)])).not.toBe(base); // edición de la enmienda
    expect(hcSourceVersion({ revision: 1 }, [am("a", 1, true)])).not.toBe(base); // enmienda anulada
    expect(hcSourceVersion({ revision: 1 }, [])).not.toBe(base);
  });

  it("no depende del orden en que llegan las enmiendas", () => {
    expect(hcSourceVersion({ revision: 3 }, [am("b"), am("a", 2)])).toBe(
      hcSourceVersion({ revision: 3 }, [am("a", 2), am("b")]),
    );
  });

  it("es un string estable (va a sha256 → sourceDigest)", () => {
    expect(hcSourceVersion({ revision: 1 }, [])).toBe("v1|r1");
    expect(hcSourceVersion({ revision: 2 }, [am("x", 1, true)])).toBe("v1|r2|x:1:1");
  });
});

describe("[FC-1b] código de verificación estable ante el orden de claves", () => {
  it("canonicalJson ordena claves en todos los niveles", () => {
    const a = { b: 1, a: { d: [1, { z: 1, y: 2 }], c: "x" } };
    const b = { a: { c: "x", d: [1, { y: 2, z: 1 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"c":"x","d":[1,{"y":2,"z":1}]},"b":1}');
  });

  it("canonicalJson sigue la semántica de JSON.stringify", () => {
    const d = new Date("2026-10-18T12:00:00.000Z");
    expect(canonicalJson({ at: d, u: undefined, n: null, f: () => 1 })).toBe('{"at":"2026-10-18T12:00:00.000Z","n":null}');
    expect(canonicalJson([undefined, NaN, Infinity, "á"])).toBe('[null,null,null,"á"]');
    expect(canonicalJson("x")).toBe('"x"');
    expect(canonicalJson(undefined)).toBe("null");
    // Mismo resultado que JSON.stringify cuando no hay claves desordenadas.
    const plain = { a: 1, b: [true, false, null], c: { d: "e\n\"q\"" } };
    expect(canonicalJson(plain)).toBe(JSON.stringify(plain));
  });

  it("canonicalJson tira con un ciclo o un BigInt (igual que JSON.stringify)", () => {
    const o: Record<string, unknown> = {};
    o.self = o;
    expect(() => canonicalJson(o)).toThrow();
    expect(() => canonicalJson({ n: BigInt(1) })).toThrow();
    // Un objeto repetido (no circular) sí vale.
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });

  it("verificationCodeFromSha256 → «A1B2-C3D4-E5F6»", () => {
    const hex = "a1b2c3d4e5f6" + "0".repeat(52);
    expect(verificationCodeFromSha256(hex)).toBe("A1B2-C3D4-E5F6");
    expect(verificationCodeFromSha256(hex.toUpperCase())).toBe("A1B2-C3D4-E5F6");
    expect(() => verificationCodeFromSha256("xyz")).toThrow();
    expect(() => verificationCodeFromSha256("")).toThrow();
  });
});

// ─── FC-2e ─────────────────────────────────────────────────────────────────────────────────────────────────

function entry(over: Partial<HcPrintSourceEntry> = {}): HcPrintSourceEntry {
  return {
    id: "note_root_1",
    revision: 1,
    label: "Ficha",
    title: "Control",
    occurredAt: new Date("2026-10-10T13:00:00.000Z"),
    createdAt: new Date("2026-10-10T14:00:00.000Z"),
    body: "Texto",
    bodyDoc: null,
    diagnoses: [],
    authorName: "Ana Pérez",
    authorHonorific: "LIC",
    authorLicense: "MN 1234",
    authorPractitionerId: "prac_1",
    authorHasSignature: true,
    importSource: null,
    lateEntry: false,
    voidedAt: null,
    voidReason: null,
    ...over,
  };
}

function source(): HcPrintSource {
  return {
    tenant: { name: "Consultorio", addressLine: null, phone: null, hasLogo: false },
    patient: { firstName: "Juan", lastName: "Gómez", documentId: "30111222", dateOfBirth: "1980-01-02" },
    entries: [
      {
        root: entry(),
        amendments: [
          entry({ id: "note_am_1", label: "Enmienda" }),
          entry({ id: "note_am_2", label: "Enmienda", voidedAt: new Date("2026-10-11T10:00:00Z"), voidReason: "MOTIVO_INTERNO" }),
        ],
      },
    ],
    truncated: false,
  };
}

const ICD_DX = { v: 1 as const, source: "icd11" as const, refId: "icd_1", code: "FA20.0", title: "Lumbalgia", uri: "http://id.who.int/icd/entity/1", release: "2026-01" };

describe("[FC-2e] buildHcPrintableContent", () => {
  it("[FC-2e] buildHcPrintableContent sin EVOLUTION, authorPractitionerId, amendsNoteId, voidReason ni ids de nota, y determinista", () => {
    const a = buildHcPrintableContent(source(), "download");
    const b = buildHcPrintableContent(source(), "download");
    const json = JSON.stringify(a.content);
    for (const banned of ["EVOLUTION", "authorPractitionerId", "amendsNoteId", "voidReason", "note_root_1", "note_am_1", "note_am_2", "prac_1", "createdAt", "storage"]) {
      expect(json).not.toContain(banned);
    }
    expect(canonicalJson(a.content)).toBe(canonicalJson(b.content));
    expect(a.signatureOwners).toEqual(b.signatureOwners);
  });

  it("[FC-2e] shared sin enmiendas anuladas", () => {
    const { content } = buildHcPrintableContent(source(), "shared");
    expect(content.fichas[0].amendments).toHaveLength(1);
    // Y ni rastro de la anulada: ni su marca ni su motivo viajan al snapshot del portal.
    const json = JSON.stringify(content);
    expect(json).not.toContain("MOTIVO_INTERNO");
    expect(content.fichas[0].amendments[0].marks.voided).toBeNull();
  });

  it("download conserva la enmienda anulada con fecha y motivo (C-FC4 `marks.voided`, solo download)", () => {
    const { content } = buildHcPrintableContent(source(), "download");
    expect(content.fichas[0].amendments).toHaveLength(2);
    const voided = content.fichas[0].amendments[1];
    expect(voided.marks.voided).toEqual({ at: "2026-10-11T10:00:00.000Z", reason: "MOTIVO_INTERNO" });
    expect(hcVoidedLine(voided)).toBe("Anulada el 11/10/2026 07:00 · Motivo: MOTIVO_INTERNO");
  });

  it("shared saltea una ficha raíz anulada (defensa: compartir ya la rechaza)", () => {
    const src = source();
    src.entries[0].root = entry({ voidedAt: new Date("2026-10-12T00:00:00Z"), voidReason: "x" });
    expect(buildHcPrintableContent(src, "shared").content.fichas).toEqual([]);
    expect(buildHcPrintableContent(src, "download").content.fichas).toHaveLength(1);
  });

  it("firma del AUTOR de cada entrada por imageRef opaco; sin firma cargada → null (FC-D26)", () => {
    const src = source();
    src.entries[0].amendments = [entry({ id: "am_b", authorName: "Beto Ruiz", authorHonorific: "DR", authorLicense: "MP 55", authorPractitionerId: "prac_2" })];
    src.entries.push({ root: entry({ id: "r2", authorHasSignature: false, authorPractitionerId: "prac_3" }), amendments: [] });
    const { content, signatureOwners } = buildHcPrintableContent(src, "download");
    expect(content.fichas[0].main.signature).toEqual({ line: "Lic. Ana Pérez · MN 1234", imageRef: "s1" });
    expect(content.fichas[0].amendments[0].signature).toEqual({ line: "Dr. Beto Ruiz · MP 55", imageRef: "s2" });
    expect(content.fichas[1].main.signature.imageRef).toBeNull();
    expect(signatureOwners).toEqual({ s1: "prac_1", s2: "prac_2" });
  });

  it("cuerpo: bodyDoc válido tal cual; viejo en texto plano → párrafos; marcas tardía e importada", () => {
    const doc = { type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Evaluación" }] }] };
    const src = source();
    src.entries[0].root = entry({
      bodyDoc: doc,
      lateEntry: true,
      importSource: { v: 1, kind: "docx", fileName: "informe.docx", importedAt: "2026-10-01T00:00:00Z", part: 2, parts: 3, batchId: "b" },
    });
    src.entries[0].amendments = [entry({ id: "x", body: "línea 1\n\nlínea 2", bodyDoc: { type: "nope" } })];
    const { content } = buildHcPrintableContent(src, "download");
    expect(content.fichas[0].main.body).toEqual(doc);
    expect(content.fichas[0].main.marks.lateEntry).toBe("Carga tardía");
    expect(content.fichas[0].main.marks.imported).toBe("Importada de informe.docx · parte 2 de 3");
    expect(JSON.stringify(content)).not.toContain("batchId");
    expect(content.fichas[0].amendments[0].body.content).toHaveLength(2);
    expect(content.fichas[0].amendments[0].marks.imported).toBeNull();
  });

  it("diagnósticos con fuente y principal; atribución CIE-11 solo si hay un CIE-11", () => {
    const src = source();
    expect(buildHcPrintableContent(src, "download").content.icdAttribution).toBeNull();
    src.entries[0].root = entry({ diagnoses: [ICD_DX, { ...ICD_DX, source: "text", refId: null, code: null, uri: null, release: null, title: "Dolor ≤ 3/10" }] });
    const { content } = buildHcPrintableContent(src, "download");
    expect(content.fichas[0].main.diagnoses).toEqual([
      { code: "FA20.0", title: "Lumbalgia", uri: "http://id.who.int/icd/entity/1", sourceLabel: "CIE-11 (OMS)", principal: true },
      { code: null, title: "Dolor ≤ 3/10", uri: null, sourceLabel: "Texto libre", principal: false },
    ]);
    expect(content.icdAttribution).toBe(HC_ICD_ATTRIBUTION);
    expect(content.icdAttribution).toContain("CIE-11 © OMS");
    expect(hcDiagnosisLine(content.fichas[0].main.diagnoses[0])).toBe("Principal: FA20.0 Lumbalgia (CIE-11 (OMS))");
  });

  it("las copias de la atribución y de las fuentes son literales a lib/diagnoses-types (anti-deriva)", () => {
    expect(HC_ICD_ATTRIBUTION).toBe(`${ICD11_SHORT_ATTRIBUTION}. ${ICD11_ATTRIBUTION}`);
    expect(HC_DIAGNOSIS_SOURCE_LABEL).toEqual(DIAGNOSIS_SOURCE_LABEL);
  });

  it("membrete, paciente y fechas en hora argentina (independiente del TZ del host)", () => {
    const { content } = buildHcPrintableContent(source(), "download");
    expect(content.patient).toEqual({ fullName: "Juan Gómez", documentId: "30111222", dateOfBirth: "1980-01-02" });
    expect(hcPatientLine(content.patient)).toBe("Paciente: Juan Gómez · DNI 30111222 · Nacimiento 02/01/1980");
    expect(content.fichas[0].main.occurredAt).toBe("2026-10-10T13:00:00.000Z");
    expect(content.fichas[0].main.dateLabel).toBe("10/10/2026 10:00");
    expect(hcDateLabel(new Date("2026-10-11T02:30:00Z"))).toBe("10/10/2026 23:30");
    expect(content.fichas[0].main.revisionLabel).toBe("Versión original");
    expect(buildHcPrintableContent({ ...source(), entries: [{ root: entry({ revision: 3 }), amendments: [] }] }, "shared").content.fichas[0].main.revisionLabel).toBe("Versión 3 (editada)");
  });
});

describe("[FC-2e] hcFileBase", () => {
  it("[FC-2e] hcFileBase arma el nombre del archivo", () => {
    const base = hcFileBase({ lastName: "Gómez", firstName: "Juan", occurredAt: new Date("2026-10-10T13:00:00Z"), title: "Control", shortId: "abc123" });
    expect(base).toBe("Gómez Juan 2026-10-10 Control [abc123]");
  });

  it("día en Argentina, sin título → «Ficha», HC completa → «Historia clínica»", () => {
    // 01:30 UTC del 11 = 22:30 del 10 en AR.
    expect(hcFileBase({ lastName: "Gómez", firstName: "Juan", occurredAt: new Date("2026-10-11T01:30:00Z"), title: null, shortId: "abc123" })).toBe(
      "Gómez Juan 2026-10-10 Ficha [abc123]",
    );
    expect(hcFileBase({ lastName: "Gómez", firstName: "Juan", occurredAt: null, title: "x", shortId: "abc123" })).toBe("Gómez Juan Historia clínica [abc123]");
  });

  it("saneado para Windows y con tope de largo que conserva el id", () => {
    const base = hcFileBase({ lastName: 'Pé<r>ez:"/', firstName: "Ana\\|?*", occurredAt: new Date("2026-10-10T13:00:00Z"), title: "Control. " + "x".repeat(300) + ". ", shortId: "zz9" });
    expect(base).not.toMatch(/[<>:"/\\|?*]/);
    expect(Array.from(base).length).toBeLessThanOrEqual(120);
    expect(base.endsWith(" [zz9]")).toBe(true);
    expect(hcFileBase({ lastName: "Ruiz", firstName: "Bea", occurredAt: new Date("2026-10-10T13:00:00Z"), title: "Fin...  ", shortId: "" })).toBe("Ruiz Bea 2026-10-10 Fin");
  });
});
