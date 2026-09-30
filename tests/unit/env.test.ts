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
