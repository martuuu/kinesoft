/**
 * [CT-L] Matrícula de la PERSONA (CF3b, M23): parser puro `parseUserLicenseInput` (la barrera de la action y del
 * formulario de «Mi agenda»), su espejo con los CHECK de la migración y los helpers de la UI.
 *
 * Contrato M23 (literal del reporte de MIG2): todo o nada — los tres NULL, o `MN` + número sin provincia, o `MP` +
 * número + provincia (`ProvinceCode` de `lib/ar-provinces.ts`); número 1..30,
 * `^[A-Za-z0-9]([A-Za-z0-9 ./-]{0,28}[A-Za-z0-9])?$`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AR_PROVINCE_CODES } from "@/lib/ar-provinces";
import {
  formatUserLicense,
  licenseDraftDirty,
  licenseDraftOf,
  licenseDraftWithKind,
  licenseFromColumns,
  maskLicenseNumber,
  parseUserLicenseInput,
  sameUserLicense,
  USER_LICENSE_NUMBER_RE,
} from "@/lib/user-license-logic";

describe("[CT-L-1] parseUserLicenseInput: todo o nada", () => {
  it("MN + número sin provincia → ok (y una provincia que quedó cargada en el select se descarta)", () => {
    expect(parseUserLicenseInput({ kind: "MN", number: "12345", jurisdiction: null })).toEqual({
      ok: true,
      data: { kind: "MN", number: "12345", jurisdiction: null },
    });
    expect(parseUserLicenseInput({ kind: "MN", number: "12345", jurisdiction: "X" })).toEqual({
      ok: true,
      data: { kind: "MN", number: "12345", jurisdiction: null },
    });
  });

  it("MP sin provincia (o con una que no es de las 24) → rechazo en el campo provincia", () => {
    for (const jurisdiction of [null, "", "AR-X", "ZZ", "x "]) {
      const r = parseUserLicenseInput({ kind: "MP", number: "4567", jurisdiction });
      if (jurisdiction === "x ") {
        // minúscula con espacio: se normaliza a «X» (Córdoba) y pasa.
        expect(r).toEqual({ ok: true, data: { kind: "MP", number: "4567", jurisdiction: "X" } });
        continue;
      }
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(Object.keys(r.fieldErrors)).toEqual(["jurisdiction"]);
        expect(r.error).toBe("Elegí la provincia que otorgó la matrícula.");
      }
    }
  });

  it("MP + número + provincia → ok, con las 24 jurisdicciones", () => {
    for (const code of AR_PROVINCE_CODES) {
      expect(parseUserLicenseInput({ kind: "MP", number: "MP-1", jurisdiction: code })).toEqual({
        ok: true,
        data: { kind: "MP", number: "MP-1", jurisdiction: code },
      });
    }
  });

  it("los tres vacíos (o ausentes) → null: borrar la matrícula", () => {
    expect(parseUserLicenseInput({})).toEqual({ ok: true, data: null });
    expect(parseUserLicenseInput({ kind: null, number: null, jurisdiction: null })).toEqual({ ok: true, data: null });
    expect(parseUserLicenseInput({ kind: "", number: "   ", jurisdiction: "" })).toEqual({ ok: true, data: null });
    // Sin tipo, una provincia suelta no es un error (es lo que deja el select): se borra igual.
    expect(parseUserLicenseInput({ kind: "", number: "", jurisdiction: "B" })).toEqual({ ok: true, data: null });
  });

  it("número sin tipo, tipo inventado o tipo sin número → error en el campo que corresponde", () => {
    const noKind = parseUserLicenseInput({ kind: null, number: "123", jurisdiction: null });
    expect(noKind.ok === false && Object.keys(noKind.fieldErrors)).toEqual(["kind"]);
    const badKind = parseUserLicenseInput({ kind: "MX", number: "123", jurisdiction: null });
    expect(badKind.ok === false && Object.keys(badKind.fieldErrors)).toEqual(["kind"]);
    const noNumber = parseUserLicenseInput({ kind: "MN", number: "  ", jurisdiction: null });
    expect(noNumber.ok === false && noNumber.fieldErrors.number).toEqual(["Escribí el número de matrícula."]);
    // Tipos que no son string (input armado a mano) no revientan: se tratan como vacíos.
    const weird = parseUserLicenseInput({ kind: 1, number: { a: 1 }, jurisdiction: [] });
    expect(weird).toEqual({ ok: true, data: null });
  });

  it("tipo en minúscula se normaliza; los espacios del número se recortan y colapsan", () => {
    expect(parseUserLicenseInput({ kind: "mn", number: "  12   345  ", jurisdiction: null })).toEqual({
      ok: true,
      data: { kind: "MN", number: "12 345", jurisdiction: null },
    });
  });
});

describe("[CT-L-2] número: el regex de M23", () => {
  const ok = (n: string) => parseUserLicenseInput({ kind: "MN", number: n, jurisdiction: null }).ok;

  it("acepta 1..30 con letra o dígito al principio y al final; en el medio espacio . / -", () => {
    for (const n of ["1", "A", "12.345", "MP 12/345-B", "a1", "1".repeat(30), "Mat. 123"]) expect(ok(n), n).toBe(true);
  });

  it("rechaza 31+, signos al principio o al final, y caracteres fuera del alfabeto", () => {
    for (const n of ["1".repeat(31), ".123", "123-", "12_3", "12#3", "ñ123", "12,345", "-", "12\t3x."]) {
      const r = parseUserLicenseInput({ kind: "MN", number: n, jurisdiction: null });
      expect(r.ok, n).toBe(false);
      if (!r.ok) expect(Object.keys(r.fieldErrors), n).toEqual(["number"]);
    }
  });

  it("espejo del CHECK UserProfile_licenseNumber_check y de las 24 jurisdicciones de la migración", () => {
    const sql = readFileSync(join(process.cwd(), "prisma/migrations/20261105120000_cf3_co_titular/migration.sql"), "utf8");
    const check = /"licenseNumber" ~ '([^']+)'/.exec(sql)?.[1];
    expect(check).toBe(USER_LICENSE_NUMBER_RE.source);
    const jur = /"licenseJurisdiction" IN\s*\(([^)]+)\)/.exec(sql)?.[1] ?? "";
    expect(jur.match(/'([A-Z])'/g)?.map((s) => s.slice(1, 2)).sort()).toEqual([...AR_PROVINCE_CODES].sort());
  });
});

describe("[CT-L-3] helpers: columnas, formato, máscara y borrador del formulario", () => {
  it("licenseFromColumns: terna coherente → matrícula; vacía o a medias → null", () => {
    expect(licenseFromColumns({ licenseKind: null, licenseNumber: null, licenseJurisdiction: null })).toBeNull();
    expect(licenseFromColumns({ licenseKind: "MN", licenseNumber: "1", licenseJurisdiction: null })).toEqual({
      kind: "MN",
      number: "1",
      jurisdiction: null,
    });
    expect(licenseFromColumns({ licenseKind: "MP", licenseNumber: "2", licenseJurisdiction: "S" })).toEqual({
      kind: "MP",
      number: "2",
      jurisdiction: "S",
    });
    expect(licenseFromColumns({ licenseKind: "MP", licenseNumber: "2", licenseJurisdiction: null })).toBeNull();
    expect(licenseFromColumns({ licenseKind: "MN", licenseNumber: "2", licenseJurisdiction: "S" })).toBeNull();
    expect(licenseFromColumns({ licenseKind: "XX", licenseNumber: "2", licenseJurisdiction: null })).toBeNull();
  });

  it("formatUserLicense con el nombre de la provincia; sameUserLicense; la máscara no deja el número completo", () => {
    expect(formatUserLicense({ kind: "MN", number: "12345", jurisdiction: null })).toBe("MN 12345");
    expect(formatUserLicense({ kind: "MP", number: "4567", jurisdiction: "X" })).toBe("MP 4567 · Córdoba");
    expect(sameUserLicense(null, null)).toBe(true);
    expect(sameUserLicense({ kind: "MN", number: "1", jurisdiction: null }, null)).toBe(false);
    expect(sameUserLicense({ kind: "MP", number: "1", jurisdiction: "B" }, { kind: "MP", number: "1", jurisdiction: "C" })).toBe(false);
    expect(maskLicenseNumber("123456")).toBe("•••56");
    expect(maskLicenseNumber("1234")).toBe("•••");
    expect(maskLicenseNumber("123456")).not.toContain("1234");
  });

  it("borrador: «Sin matrícula» vacía todo, MN vacía la provincia, MP conserva el número; dirty ignora espacios", () => {
    const saved = { kind: "MP" as const, number: "4567", jurisdiction: "X" as const };
    const d = licenseDraftOf(saved);
    expect(d).toEqual({ kind: "MP", number: "4567", jurisdiction: "X" });
    expect(licenseDraftDirty(d, saved)).toBe(false);
    expect(licenseDraftDirty({ ...d, number: " 4567  " }, saved)).toBe(false);
    expect(licenseDraftDirty({ ...d, jurisdiction: "B" }, saved)).toBe(true);
    const mn = licenseDraftWithKind(d, "MN");
    expect(mn).toEqual({ kind: "MN", number: "4567", jurisdiction: "" });
    expect(licenseDraftDirty(mn, saved)).toBe(true);
    const none = licenseDraftWithKind(d, "");
    expect(none).toEqual({ kind: "", number: "", jurisdiction: "" });
    expect(licenseDraftDirty(none, saved)).toBe(true);
    expect(licenseDraftDirty(none, null)).toBe(false);
    // MN con una provincia escondida en el estado no es un cambio (no se guarda).
    const mnSaved = { kind: "MN" as const, number: "9", jurisdiction: null };
    expect(licenseDraftDirty({ kind: "MN", number: "9", jurisdiction: "B" }, mnSaved)).toBe(false);
  });
});
