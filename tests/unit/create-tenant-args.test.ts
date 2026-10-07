/**
 * EV0 (EV-O): `--vertical` de `scripts/create-tenant.ts`. Un typo no puede
 * crear el consultorio con otra vertical: lo que no está en la lista corta el
 * script (null) antes de tocar Supabase o la base.
 */
import { describe, it, expect } from "vitest";
import { parseVerticalFlag, VERTICAL_FLAG_VALUES } from "@/scripts/create-tenant";

describe("create-tenant · parseVerticalFlag", () => {
  it("sin flag → KINESIOLOGY (default)", () => {
    expect(parseVerticalFlag(undefined)).toBe("KINESIOLOGY");
    expect(parseVerticalFlag(null)).toBe("KINESIOLOGY");
  });

  it("mapea general / kinesiologia al enum, sin importar mayúsculas ni espacios", () => {
    expect(parseVerticalFlag("general")).toBe("GENERAL");
    expect(parseVerticalFlag(" GENERAL ")).toBe("GENERAL");
    expect(parseVerticalFlag("kinesiologia")).toBe("KINESIOLOGY");
    expect(parseVerticalFlag("Kinesiología")).toBe("KINESIOLOGY");
    expect(parseVerticalFlag("KINESIOLOGY")).toBe("KINESIOLOGY");
  });

  it("valor desconocido, vacío o flag sin valor → null (el script corta)", () => {
    expect(parseVerticalFlag("kine")).toBeNull();
    expect(parseVerticalFlag("odontologia")).toBeNull();
    expect(parseVerticalFlag("")).toBeNull();
    expect(parseVerticalFlag(true)).toBeNull();
  });

  it("los valores documentados en el uso son exactamente los aceptados", () => {
    expect(VERTICAL_FLAG_VALUES.map((v) => parseVerticalFlag(v))).toEqual(["GENERAL", "KINESIOLOGY"]);
  });
});
