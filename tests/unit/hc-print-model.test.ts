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
  type HcPrintSource,
  type HcPrintSourceEntry,
} from "@/lib/hc-print-model";

// FC-1b3: lo chico y estable del modelo imprimible (C-FC4). `buildHcPrintableContent` y `hcFileBase` son stubs:
// sus `it.fails` los da vuelta FC-2e.

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

// ─── Stubs de FC-2e ─────────────────────────────────────────────────────────────────────────────────────────────────

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

describe("[FC-1b] buildHcPrintableContent (stub de FC-2e)", () => {
  it.fails(
    "[FC-2e] buildHcPrintableContent sin EVOLUTION, authorPractitionerId, amendsNoteId, voidReason ni ids de nota, y determinista",
    () => {
      const a = buildHcPrintableContent(source(), "download");
      const b = buildHcPrintableContent(source(), "download");
      const json = JSON.stringify(a.content);
      for (const banned of ["EVOLUTION", "authorPractitionerId", "amendsNoteId", "voidReason", "note_root_1", "note_am_1", "prac_1", "MOTIVO_INTERNO"]) {
        expect(json).not.toContain(banned);
      }
      expect(canonicalJson(a.content)).toBe(canonicalJson(b.content));
    },
  );

  it.fails("[FC-2e] shared sin enmiendas anuladas", () => {
    const { content } = buildHcPrintableContent(source(), "shared");
    expect(content.fichas[0].amendments).toHaveLength(1);
  });

  it.fails("[FC-2e] hcFileBase arma el nombre del archivo", () => {
    const base = hcFileBase({ lastName: "Gómez", firstName: "Juan", occurredAt: new Date("2026-10-10T13:00:00Z"), title: "Control", shortId: "abc123" });
    expect(base.length).toBeGreaterThan(0);
  });
});
