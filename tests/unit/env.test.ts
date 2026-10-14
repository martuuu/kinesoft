import { describe, it, expect, vi } from "vitest";
import { parseEnv } from "@/lib/env";

const PROD_OK = {
  VERCEL_ENV: "production",
  DATABASE_URL: "postgresql://app:x@pooler.supabase.com:6543/postgres",
  DIRECT_URL: "postgresql://owner:x@pooler.supabase.com:5432/postgres",
  NEXT_PUBLIC_SUPABASE_URL: "https://ref.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  NEXT_PUBLIC_APP_URL: "https://app.kinesoft.com.ar",
};

describe("parseEnv — fail-fast solo en Production", () => {
  it("local/CI sin nada: no falla y APP_URL cae al default", () => {
    expect(parseEnv({}).NEXT_PUBLIC_APP_URL).toBe("http://localhost:3000");
  });
  it("build de CI (NODE_ENV=production sin VERCEL_ENV) no falla con placeholders", () => {
    expect(() => parseEnv({ NODE_ENV: "production" })).not.toThrow();
  });
  it("Preview con config incompleta no falla", () => {
    expect(() => parseEnv({ VERCEL_ENV: "preview" })).not.toThrow();
  });
  it("Production completa pasa (y avisa lo recomendado que falta)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => parseEnv(PROD_OK)).not.toThrow();
    expect(spy.mock.calls[0]?.[0]).toMatch(/DATABASE_URL_SERVICE/);
    spy.mockRestore();
  });
  it("Production sin SUPABASE_SERVICE_ROLE_KEY falla", () => {
    expect(() => parseEnv({ ...PROD_OK, SUPABASE_SERVICE_ROLE_KEY: undefined })).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });
  it("Production con APP_URL en localhost (o sin setear) falla", () => {
    expect(() => parseEnv({ ...PROD_OK, NEXT_PUBLIC_APP_URL: undefined })).toThrow(/NEXT_PUBLIC_APP_URL/);
  });
  it("Production con token de MP pero sin webhook secret falla", () => {
    expect(() => parseEnv({ ...PROD_OK, MP_ACCESS_TOKEN: "tok" })).toThrow(/MP_WEBHOOK_SECRET/);
  });
});

// SV02 · SV-D11: driver del canal realtime de la Sala de Espera.
describe("parseEnv — REALTIME_DRIVER (SV)", () => {
  const PROD_RT = {
    ...PROD_OK,
    REALTIME_DRIVER: "supabase",
    SUPABASE_JWT_SECRET: "test-secret",
  };
  const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});

  it("default off (local, CI y Production sin setear)", () => {
    expect(parseEnv({}).REALTIME_DRIVER).toBe("off");
    const spy = quiet();
    expect(parseEnv(PROD_OK).REALTIME_DRIVER).toBe("off");
    spy.mockRestore();
  });
  it("valor fuera del dominio falla en cualquier entorno", () => {
    expect(() => parseEnv({ REALTIME_DRIVER: "pusher" })).toThrow(/REALTIME_DRIVER/);
  });
  it("supabase en Production completo pasa; SUPABASE_JWT_KID es opcional", () => {
    const spy = quiet();
    expect(parseEnv(PROD_RT).REALTIME_DRIVER).toBe("supabase");
    expect(parseEnv(PROD_RT).SUPABASE_JWT_KID).toBeUndefined();
    expect(parseEnv({ ...PROD_RT, SUPABASE_JWT_KID: "kid-1" }).SUPABASE_JWT_KID).toBe("kid-1");
    spy.mockRestore();
  });
  it("supabase en Production sin SUPABASE_JWT_SECRET falla", () => {
    expect(() => parseEnv({ ...PROD_RT, SUPABASE_JWT_SECRET: undefined })).toThrow(/SUPABASE_JWT_SECRET/);
  });
  it("supabase en Production sin service key o sin URL falla", () => {
    expect(() => parseEnv({ ...PROD_RT, SUPABASE_SERVICE_ROLE_KEY: undefined })).toThrow(
      /SUPABASE_SERVICE_ROLE_KEY: obligatoria en Production con REALTIME_DRIVER=supabase/
    );
    expect(() => parseEnv({ ...PROD_RT, NEXT_PUBLIC_SUPABASE_URL: undefined })).toThrow(
      /NEXT_PUBLIC_SUPABASE_URL: obligatoria en Production con REALTIME_DRIVER=supabase/
    );
  });
  it("[FX1b] supabase en Production sin NEXT_PUBLIC_SUPABASE_ANON_KEY falla (el socket del browser la usa de apikey)", () => {
    expect(() => parseEnv({ ...PROD_RT, NEXT_PUBLIC_SUPABASE_ANON_KEY: undefined })).toThrow(
      /NEXT_PUBLIC_SUPABASE_ANON_KEY: obligatoria en Production con REALTIME_DRIVER=supabase/
    );
    expect(() => parseEnv({ ...PROD_RT, NEXT_PUBLIC_SUPABASE_ANON_KEY: "" })).toThrow(/NEXT_PUBLIC_SUPABASE_ANON_KEY/);
  });
  it("local en Production falla", () => {
    expect(() => parseEnv({ ...PROD_OK, REALTIME_DRIVER: "local" })).toThrow(/REALTIME_DRIVER/);
  });
  it("Preview y CI no fallan con supabase sin secreto ni con local", () => {
    for (const base of [{ VERCEL_ENV: "preview" }, { NODE_ENV: "production" }, {}]) {
      expect(() => parseEnv({ ...base, REALTIME_DRIVER: "supabase" })).not.toThrow();
      expect(parseEnv({ ...base, REALTIME_DRIVER: "local" }).REALTIME_DRIVER).toBe("local");
    }
  });
});
