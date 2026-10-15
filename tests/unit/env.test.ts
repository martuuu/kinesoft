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

// [IAM-0b] Mail (C-IAM1): todo opcional. En Production, sin RESEND_API_KEY o
// EMAIL_FROM la app no manda mails (transporte log), pero el deploy NO se cae:
// se vuelven obligatorias cuando Martin cargue el dominio de envío (§19.9).
describe("parseEnv — mail (IAM-0b)", () => {
  const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});

  it("local/CI sin nada: todo undefined, sin fallar", () => {
    const e = parseEnv({});
    expect(e.RESEND_API_KEY).toBeUndefined();
    expect(e.EMAIL_FROM).toBeUndefined();
    expect(e.EMAIL_TRANSPORT).toBeUndefined();
    expect(e.EMAIL_REPLY_TO).toBeUndefined();
    expect(e.MAILPIT_URL).toBeUndefined();
  });
  it("vacíos (como en .env.example) cuentan como no seteados", () => {
    const e = parseEnv({ EMAIL_TRANSPORT: "", MAILPIT_URL: "", EMAIL_REPLY_TO: "", EMAIL_FROM: "", RESEND_API_KEY: "" });
    expect(e.EMAIL_TRANSPORT).toBeUndefined();
    expect(e.MAILPIT_URL).toBeUndefined();
  });
  it("EMAIL_TRANSPORT acepta resend|mailpit|log y rechaza otro valor", () => {
    for (const t of ["resend", "mailpit", "log"] as const) expect(parseEnv({ EMAIL_TRANSPORT: t }).EMAIL_TRANSPORT).toBe(t);
    expect(() => parseEnv({ EMAIL_TRANSPORT: "smtp" })).toThrow(/EMAIL_TRANSPORT/);
  });
  it("MAILPIT_URL tiene que ser una URL", () => {
    expect(parseEnv({ MAILPIT_URL: "http://localhost:8025" }).MAILPIT_URL).toBe("http://localhost:8025");
    expect(() => parseEnv({ MAILPIT_URL: "localhost" })).toThrow(/MAILPIT_URL/);
  });
  it("Production sin RESEND_API_KEY ni EMAIL_FROM: NO falla, avisa por console.error", () => {
    const spy = quiet();
    expect(() => parseEnv(PROD_OK)).not.toThrow();
    const msg = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(msg).toMatch(/RESEND_API_KEY/);
    expect(msg).toMatch(/EMAIL_FROM/);
    spy.mockRestore();
  });
  it("Production con mail configurado no lo lista entre lo que falta", () => {
    const spy = quiet();
    parseEnv({ ...PROD_OK, RESEND_API_KEY: "re_x", EMAIL_FROM: "KineSoft <no-reply@mail.kinesoft.com.ar>" });
    const msg = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(msg).not.toMatch(/RESEND_API_KEY|EMAIL_FROM/);
    spy.mockRestore();
  });
  it("Preview sin mail no avisa (el aviso es solo de Production)", () => {
    const spy = quiet();
    parseEnv({ VERCEL_ENV: "preview" });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// BO5-B: modo mantenimiento.
describe("parseEnv — MAINTENANCE_MODE (BO5-B)", () => {
  it("default off; vacío cuenta como no seteada", () => {
    expect(parseEnv({}).MAINTENANCE_MODE).toBe("off");
    expect(parseEnv({ MAINTENANCE_MODE: "" }).MAINTENANCE_MODE).toBe("off");
  });
  it("on, tolerando mayúsculas y espacios", () => {
    expect(parseEnv({ MAINTENANCE_MODE: " ON " }).MAINTENANCE_MODE).toBe("on");
  });
  it("un typo frena el boot (no queda abierta creyendo que está en mantenimiento)", () => {
    expect(() => parseEnv({ MAINTENANCE_MODE: "true" })).toThrow(/MAINTENANCE_MODE/);
  });
  it("MAINTENANCE_MESSAGE largo no frena el deploy", () => {
    expect(parseEnv({ MAINTENANCE_MESSAGE: "x".repeat(1000) }).MAINTENANCE_MESSAGE).toHaveLength(1000);
  });
});

// Integración BO4/BO5: lib/env.ts lo editaron BO4 (MFA) y BO5-B (mantenimiento) en paralelo; esto fija que las
// variables de Plataforma sigan en el schema Y en el objeto que arma `parseEnv` (si una falta en el schema, zod la
// descarta en silencio y el flag nunca prende).
describe("parseEnv — flags de Plataforma (BO1/BO4/BO5)", () => {
  it("TENANT_ACCESS_ENFORCEMENT: default banner, acepta off|banner|enforce, typo frena", () => {
    expect(parseEnv({}).TENANT_ACCESS_ENFORCEMENT).toBe("banner");
    expect(parseEnv({ TENANT_ACCESS_ENFORCEMENT: "" }).TENANT_ACCESS_ENFORCEMENT).toBe("banner");
    for (const v of ["off", "banner", "enforce"] as const)
      expect(parseEnv({ TENANT_ACCESS_ENFORCEMENT: v }).TENANT_ACCESS_ENFORCEMENT).toBe(v);
    expect(() => parseEnv({ TENANT_ACCESS_ENFORCEMENT: "on" })).toThrow(/TENANT_ACCESS_ENFORCEMENT/);
  });
  it("PLATFORM_MFA_ENFORCEMENT: default off, acepta enforce, typo frena", () => {
    expect(parseEnv({}).PLATFORM_MFA_ENFORCEMENT).toBe("off");
    expect(parseEnv({ PLATFORM_MFA_ENFORCEMENT: "" }).PLATFORM_MFA_ENFORCEMENT).toBe("off");
    expect(parseEnv({ PLATFORM_MFA_ENFORCEMENT: "enforce" }).PLATFORM_MFA_ENFORCEMENT).toBe("enforce");
    expect(() => parseEnv({ PLATFORM_MFA_ENFORCEMENT: "true" })).toThrow(/PLATFORM_MFA_ENFORCEMENT/);
  });
  it("[BO-Z] SIGNUP_MODE: default open, acepta assisted (mayúsculas/espacios tolerados), typo frena", () => {
    expect(parseEnv({}).SIGNUP_MODE).toBe("open");
    expect(parseEnv({ SIGNUP_MODE: "" }).SIGNUP_MODE).toBe("open");
    expect(parseEnv({ SIGNUP_MODE: " Assisted " }).SIGNUP_MODE).toBe("assisted");
    expect(() => parseEnv({ SIGNUP_MODE: "closed" })).toThrow(/SIGNUP_MODE/);
  });
  it("[BO-Z] signupMode() e isVercelProduction() leen process.env en cada llamada", async () => {
    const { signupMode, isVercelProduction } = await import("@/lib/env");
    const prev = { s: process.env.SIGNUP_MODE, v: process.env.VERCEL_ENV };
    try {
      delete process.env.SIGNUP_MODE;
      expect(signupMode()).toBe("open");
      process.env.SIGNUP_MODE = "assisted";
      expect(signupMode()).toBe("assisted");
      process.env.SIGNUP_MODE = "cualquiera";
      expect(signupMode()).toBe("open");
      process.env.VERCEL_ENV = "preview";
      expect(isVercelProduction()).toBe(false);
      process.env.VERCEL_ENV = "production";
      expect(isVercelProduction()).toBe(true);
    } finally {
      if (prev.s === undefined) delete process.env.SIGNUP_MODE;
      else process.env.SIGNUP_MODE = prev.s;
      if (prev.v === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = prev.v;
    }
  });
  it("CRON_SECRET: opcional, vacío = no seteada", () => {
    expect(parseEnv({}).CRON_SECRET).toBeUndefined();
    expect(parseEnv({ CRON_SECRET: "" }).CRON_SECRET).toBeUndefined();
    expect(parseEnv({ CRON_SECRET: "s3cr3t" }).CRON_SECRET).toBe("s3cr3t");
  });
});

describe("[PL-1a] SAAS_BILLING_MODE y PLATFORM_INBOX_EMAIL", () => {
  it("SAAS_BILLING_MODE: default off, acepta manual/mp (mayúsculas/espacios tolerados), typo frena", () => {
    expect(parseEnv({}).SAAS_BILLING_MODE).toBe("off");
    expect(parseEnv({ SAAS_BILLING_MODE: "" }).SAAS_BILLING_MODE).toBe("off");
    expect(parseEnv({ SAAS_BILLING_MODE: " Manual " }).SAAS_BILLING_MODE).toBe("manual");
    expect(parseEnv({ SAAS_BILLING_MODE: "mp" }).SAAS_BILLING_MODE).toBe("mp");
    expect(() => parseEnv({ SAAS_BILLING_MODE: "on" })).toThrow(/SAAS_BILLING_MODE/);
  });
  it("PLATFORM_INBOX_EMAIL: opcional; vacío = no seteado; un no-email frena", () => {
    expect(parseEnv({}).PLATFORM_INBOX_EMAIL).toBeUndefined();
    expect(parseEnv({ PLATFORM_INBOX_EMAIL: "" }).PLATFORM_INBOX_EMAIL).toBeUndefined();
    expect(parseEnv({ PLATFORM_INBOX_EMAIL: "equipo@kinesoft.app" }).PLATFORM_INBOX_EMAIL).toBe("equipo@kinesoft.app");
    expect(() => parseEnv({ PLATFORM_INBOX_EMAIL: "equipo" })).toThrow(/PLATFORM_INBOX_EMAIL/);
  });
  it("saasBillingMode() y platformInboxEmail() leen process.env en cada llamada (inválido → off)", async () => {
    const { saasBillingMode, platformInboxEmail } = await import("@/lib/env");
    const prev = { m: process.env.SAAS_BILLING_MODE, i: process.env.PLATFORM_INBOX_EMAIL };
    try {
      delete process.env.SAAS_BILLING_MODE;
      expect(saasBillingMode()).toBe("off");
      process.env.SAAS_BILLING_MODE = "MP";
      expect(saasBillingMode()).toBe("mp");
      process.env.SAAS_BILLING_MODE = "manual";
      expect(saasBillingMode()).toBe("manual");
      process.env.SAAS_BILLING_MODE = "cobrar";
      expect(saasBillingMode()).toBe("off");
      process.env.PLATFORM_INBOX_EMAIL = "  ";
      expect(platformInboxEmail()).toBeNull();
      process.env.PLATFORM_INBOX_EMAIL = "equipo@kinesoft.app";
      expect(platformInboxEmail()).toBe("equipo@kinesoft.app");
    } finally {
      if (prev.m === undefined) delete process.env.SAAS_BILLING_MODE;
      else process.env.SAAS_BILLING_MODE = prev.m;
      if (prev.i === undefined) delete process.env.PLATFORM_INBOX_EMAIL;
      else process.env.PLATFORM_INBOX_EMAIL = prev.i;
    }
  });
});
