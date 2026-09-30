import { describe, it, expect } from "vitest";
import { assertSafeTarget, describeTarget } from "@/scripts/lib/assert-safe-target";

const quiet = () => {};
const LOCAL = "postgresql://kinesoft:kinesoft@localhost:5433/kinesoft?schema=public";
const POOLER = "postgresql://postgres.abcdefghijklmnop:secret@aws-1-sa-east-1.pooler.supabase.com:5432/postgres";

describe("describeTarget", () => {
  it("reconoce destinos locales", () => {
    for (const h of ["localhost", "127.0.0.1", "host.docker.internal"]) {
      expect(describeTarget(`postgresql://u:p@${h}:5433/db`).isLocal).toBe(true);
    }
  });
  it("extrae el project ref del usuario del pooler de Supabase", () => {
    const t = describeTarget(POOLER);
    expect(t).toMatchObject({ isLocal: false, isSupabase: true, projectRef: "abcdefghijklmnop" });
  });
  it("extrae el project ref del host directo db.<ref>.supabase.co", () => {
    expect(describeTarget("postgresql://postgres:p@db.zyxwvutsrqponmlk.supabase.co:5432/postgres").projectRef).toBe(
      "zyxwvutsrqponmlk",
    );
  });
});

describe("assertSafeTarget", () => {
  it("sin DATABASE_URL falla (no hay fallback silencioso a localhost)", () => {
    expect(() => assertSafeTarget({ url: undefined, allowRemote: true, scriptName: "x", log: quiet })).toThrow(
      /Falta DATABASE_URL/,
    );
  });
  it("local pasa siempre, aun en scripts solo-locales", () => {
    expect(assertSafeTarget({ url: LOCAL, allowRemote: false, scriptName: "seed", log: quiet }).isLocal).toBe(true);
  });
  it("un script solo-local rechaza prod aun con confirmación", () => {
    expect(() =>
      assertSafeTarget({ url: POOLER, allowRemote: false, confirm: "abcdefghijklmnop", scriptName: "seed", log: quiet }),
    ).toThrow(/solo LOCAL/);
  });
  it("remoto sin confirmación falla y dice qué valor poner", () => {
    expect(() => assertSafeTarget({ url: POOLER, allowRemote: true, scriptName: "x", log: quiet })).toThrow(
      /KINESOFT_CONFIRM_PROD=abcdefghijklmnop/,
    );
  });
  it("remoto con la confirmación de OTRO proyecto falla", () => {
    expect(() =>
      assertSafeTarget({ url: POOLER, allowRemote: true, confirm: "otroproyecto123", scriptName: "x", log: quiet }),
    ).toThrow();
  });
  it("remoto con la confirmación exacta pasa", () => {
    expect(
      assertSafeTarget({ url: POOLER, allowRemote: true, confirm: "abcdefghijklmnop", scriptName: "x", log: quiet })
        .projectRef,
    ).toBe("abcdefghijklmnop");
  });
});
