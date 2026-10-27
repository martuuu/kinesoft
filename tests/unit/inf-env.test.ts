/**
 * [INF-ENV] (T6+T7, brief §26.3 fila ENV, C-WA1, C-MPS2 / MPS hallazgo 4, §26.7): entorno de WhatsApp, del cobro SaaS
 * por Mercado Pago y las claves que se leían por `process.env` sin pasar por el schema. Se prueba el `parseEnv` real
 * (el mismo que corre al boot) y los getters reales con `vi.stubEnv` (leen `process.env` en cada llamada).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as envModule from "@/lib/env";
import { parseEnv } from "@/lib/env";

const ROOT = resolve(__dirname, "../..");

const PROD_OK = {
  VERCEL_ENV: "production",
  DATABASE_URL: "postgresql://app:x@pooler.supabase.com:6543/postgres",
  DIRECT_URL: "postgresql://owner:x@pooler.supabase.com:5432/postgres",
  NEXT_PUBLIC_SUPABASE_URL: "https://ref.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  NEXT_PUBLIC_APP_URL: "https://app.kinesoft.com.ar",
  // HD-6: obligatorias en Production.
  RESEND_API_KEY: "re_test",
  EMAIL_FROM: "KineSoft <no-reply@mail.kinesoft.com.ar>",
};
const KEYS = `k1:${Buffer.alloc(32, 7).toString("base64")}`;
const VERIFY = "v".repeat(32);
const WA_PROD = {
  ...PROD_OK,
  WHATSAPP_APP_ID: "123456789",
  WHATSAPP_APP_SECRET: "app-secret",
  WHATSAPP_CONFIG_ID: "987654321",
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: VERIFY,
  SECRET_BOX_KEYS: KEYS,
};

const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});

/** Sin rastros de Vercel ni de los modos: cada test arranca de un entorno local limpio. */
function stubLocal(extra: Record<string, string | undefined> = {}) {
  for (const k of ["VERCEL", "VERCEL_ENV", "WHATSAPP_MODE", "SAAS_BILLING_MODE", "MP_MIN_DEBIT_CENTS", "SAAS_MP_CHECKOUT_NOTIFY", "WHATSAPP_GRAPH_VERSION", "WHATSAPP_SIGNUP_FEATURE"]) {
    vi.stubEnv(k, undefined);
  }
  for (const [k, v] of Object.entries(extra)) vi.stubEnv(k, v);
}
afterEach(() => vi.unstubAllEnvs());

describe("[INF-ENV] WHATSAPP_MODE (C-WA1) · boot", () => {
  it("[INF-ENV] default off; acepta off|fake|sandbox|live con mayúsculas y espacios; un typo frena el boot", () => {
    expect(parseEnv({}).WHATSAPP_MODE).toBe("off");
    expect(parseEnv({ WHATSAPP_MODE: "" }).WHATSAPP_MODE).toBe("off");
    for (const m of ["off", "fake", "sandbox", "live"] as const) expect(parseEnv({ WHATSAPP_MODE: m }).WHATSAPP_MODE).toBe(m);
    expect(parseEnv({ WHATSAPP_MODE: " Sandbox " }).WHATSAPP_MODE).toBe("sandbox");
    expect(() => parseEnv({ WHATSAPP_MODE: "on" })).toThrow(/WHATSAPP_MODE/);
  });

  it("[INF-ENV] fake en Vercel (VERCEL_ENV o VERCEL, cualquier scope) frena el boot", () => {
    expect(() => parseEnv({ WHATSAPP_MODE: "fake", VERCEL_ENV: "preview" })).toThrow(/WHATSAPP_MODE/);
    expect(() => parseEnv({ WHATSAPP_MODE: "fake", VERCEL: "1" })).toThrow(/WHATSAPP_MODE/);
    expect(() => parseEnv({ WHATSAPP_MODE: "fake", VERCEL: "" })).toThrow(/WHATSAPP_MODE/);
    expect(() => parseEnv({ ...WA_PROD, WHATSAPP_MODE: "fake" })).toThrow(/WHATSAPP_MODE/);
    // Fuera de Vercel (dev, vitest, `next start` del E2E con NODE_ENV=production) sí.
    expect(parseEnv({ WHATSAPP_MODE: "fake", NODE_ENV: "production" }).WHATSAPP_MODE).toBe("fake");
  });

  it("[INF-ENV] Production con sandbox/live exige App ID, App Secret, Config ID, Verify Token y SECRET_BOX_KEYS", () => {
    const spy = quiet();
    for (const mode of ["sandbox", "live"]) {
      expect(parseEnv({ ...WA_PROD, WHATSAPP_MODE: mode }).WHATSAPP_MODE).toBe(mode);
      for (const key of ["WHATSAPP_APP_ID", "WHATSAPP_APP_SECRET", "WHATSAPP_CONFIG_ID", "WHATSAPP_WEBHOOK_VERIFY_TOKEN", "SECRET_BOX_KEYS"]) {
        expect(() => parseEnv({ ...WA_PROD, WHATSAPP_MODE: mode, [key]: undefined }), key).toThrow(
          new RegExp(`${key}: obligatoria en Production con WHATSAPP_MODE=${mode}`)
        );
        expect(() => parseEnv({ ...WA_PROD, WHATSAPP_MODE: mode, [key]: "  " }), `${key} vacía`).toThrow(new RegExp(key));
      }
    }
    // off (default) en Production no pide nada de WhatsApp.
    expect(() => parseEnv(PROD_OK)).not.toThrow();
    spy.mockRestore();
  });

  it("[INF-ENV] Preview y local con live/sandbox sin credenciales no frenan (Preview lee live como off)", () => {
    for (const base of [{ VERCEL_ENV: "preview" }, {}, { NODE_ENV: "production" }]) {
      expect(() => parseEnv({ ...base, WHATSAPP_MODE: "live" })).not.toThrow();
      expect(() => parseEnv({ ...base, WHATSAPP_MODE: "sandbox" })).not.toThrow();
    }
  });

  it("[INF-ENV] WHATSAPP_WEBHOOK_VERIFY_TOKEN: ≥ 32 caracteres en cualquier entorno; el mensaje no trae el valor", () => {
    expect(parseEnv({ WHATSAPP_WEBHOOK_VERIFY_TOKEN: VERIFY }).WHATSAPP_WEBHOOK_VERIFY_TOKEN).toBe(VERIFY);
    expect(parseEnv({ WHATSAPP_WEBHOOK_VERIFY_TOKEN: ` ${VERIFY}\n` }).WHATSAPP_WEBHOOK_VERIFY_TOKEN).toBe(VERIFY);
    expect(parseEnv({ WHATSAPP_WEBHOOK_VERIFY_TOKEN: "" }).WHATSAPP_WEBHOOK_VERIFY_TOKEN).toBeUndefined();
    const short = "corto-secreto-123";
    let msg = "";
    try {
      parseEnv({ WHATSAPP_WEBHOOK_VERIFY_TOKEN: short });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/WHATSAPP_WEBHOOK_VERIFY_TOKEN/);
    expect(msg).not.toContain(short);
  });

  it("[INF-ENV] WHATSAPP_GRAPH_VERSION: default constante, forma ^v\\d{2}\\.0$; WHATSAPP_SIGNUP_FEATURE: vacía o whatsapp_business_app_onboarding", () => {
    const def = envModule.WHATSAPP_GRAPH_VERSION_DEFAULT;
    expect(def).toMatch(/^v\d{2}\.0$/);
    expect(parseEnv({}).WHATSAPP_GRAPH_VERSION).toBe(def);
    expect(parseEnv({ WHATSAPP_GRAPH_VERSION: "" }).WHATSAPP_GRAPH_VERSION).toBe(def);
    expect(parseEnv({ WHATSAPP_GRAPH_VERSION: "v24.0" }).WHATSAPP_GRAPH_VERSION).toBe("v24.0");
    for (const bad of ["v24", "24.0", "v24.1", "v2.0", "latest"]) {
      expect(() => parseEnv({ WHATSAPP_GRAPH_VERSION: bad }), bad).toThrow(/WHATSAPP_GRAPH_VERSION/);
    }
    expect(parseEnv({}).WHATSAPP_SIGNUP_FEATURE).toBeUndefined();
    expect(parseEnv({ WHATSAPP_SIGNUP_FEATURE: "" }).WHATSAPP_SIGNUP_FEATURE).toBeUndefined();
    expect(parseEnv({ WHATSAPP_SIGNUP_FEATURE: "whatsapp_business_app_onboarding" }).WHATSAPP_SIGNUP_FEATURE).toBe(
      "whatsapp_business_app_onboarding"
    );
    expect(() => parseEnv({ WHATSAPP_SIGNUP_FEATURE: "coexistence" })).toThrow(/WHATSAPP_SIGNUP_FEATURE/);
  });
});

describe("[INF-ENV] WhatsApp · getters en caliente", () => {
  it("[INF-ENV] whatsappMode() lee process.env en cada llamada; inválido o vacío → off", () => {
    stubLocal();
    expect(envModule.whatsappMode()).toBe("off");
    vi.stubEnv("WHATSAPP_MODE", " SANDBOX ");
    expect(envModule.whatsappMode()).toBe("sandbox");
    vi.stubEnv("WHATSAPP_MODE", "live");
    expect(envModule.whatsappMode()).toBe("live");
    vi.stubEnv("WHATSAPP_MODE", "fake");
    expect(envModule.whatsappMode()).toBe("fake");
    vi.stubEnv("WHATSAPP_MODE", "prendido");
    expect(envModule.whatsappMode()).toBe("off");
  });

  it("[INF-ENV] fake con VERCEL o VERCEL_ENV → off y fakeGraphAllowed() false (segunda barrera)", () => {
    stubLocal({ WHATSAPP_MODE: "fake" });
    expect(envModule.fakeGraphAllowed()).toBe(true);
    vi.stubEnv("VERCEL", "1");
    expect(envModule.whatsappMode()).toBe("off");
    expect(envModule.fakeGraphAllowed()).toBe(false);
    vi.stubEnv("VERCEL", undefined);
    vi.stubEnv("VERCEL_ENV", "production");
    expect(envModule.whatsappMode()).toBe("off");
    expect(envModule.fakeGraphAllowed()).toBe(false);
    // Con otro modo el simulador no responde aunque estemos en local.
    stubLocal({ WHATSAPP_MODE: "sandbox" });
    expect(envModule.fakeGraphAllowed()).toBe(false);
  });

  it("[INF-ENV] live en Preview se lee como off; sandbox en Preview sigue siendo sandbox", () => {
    stubLocal({ WHATSAPP_MODE: "live", VERCEL_ENV: "preview", VERCEL: "1" });
    expect(envModule.whatsappMode()).toBe("off");
    vi.stubEnv("WHATSAPP_MODE", "sandbox");
    expect(envModule.whatsappMode()).toBe("sandbox");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("WHATSAPP_MODE", "live");
    expect(envModule.whatsappMode()).toBe("live");
  });

  it("[INF-ENV] whatsappGraphVersion(): la de la env si tiene forma; si no, el default", () => {
    stubLocal();
    expect(envModule.whatsappGraphVersion()).toBe(envModule.WHATSAPP_GRAPH_VERSION_DEFAULT);
    vi.stubEnv("WHATSAPP_GRAPH_VERSION", "v25.0");
    expect(envModule.whatsappGraphVersion()).toBe("v25.0");
    vi.stubEnv("WHATSAPP_GRAPH_VERSION", "v25");
    expect(envModule.whatsappGraphVersion()).toBe(envModule.WHATSAPP_GRAPH_VERSION_DEFAULT);
  });
});

describe("[INF-ENV] SAAS_BILLING_MODE=mp deja de ser alias de manual (C-MPS2)", () => {
  it("[INF-ENV] saasMpActive() es true SOLO con mp; saasBillingMode() distingue mp de manual", () => {
    stubLocal();
    expect(envModule.saasMpActive()).toBe(false);
    vi.stubEnv("SAAS_BILLING_MODE", "manual");
    expect(envModule.saasBillingMode()).toBe("manual");
    expect(envModule.saasMpActive()).toBe(false);
    vi.stubEnv("SAAS_BILLING_MODE", " MP ");
    expect(envModule.saasBillingMode()).toBe("mp");
    expect(envModule.saasMpActive()).toBe(true);
    vi.stubEnv("SAAS_BILLING_MODE", "debito");
    expect(envModule.saasMpActive()).toBe(false);
  });

  it("[INF-ENV] Production con mp exige el token de la plataforma (y, por la regla de siempre, su secreto)", () => {
    const spy = quiet();
    expect(() => parseEnv({ ...PROD_OK, SAAS_BILLING_MODE: "mp" })).toThrow(
      /MP_ACCESS_TOKEN: obligatoria en Production con SAAS_BILLING_MODE=mp/
    );
    expect(() => parseEnv({ ...PROD_OK, SAAS_BILLING_MODE: "mp", MP_ACCESS_TOKEN: "tok" })).toThrow(/MP_WEBHOOK_SECRET/);
    expect(parseEnv({ ...PROD_OK, SAAS_BILLING_MODE: "mp", MP_ACCESS_TOKEN: "tok", MP_WEBHOOK_SECRET: "s" }).SAAS_BILLING_MODE).toBe("mp");
    // manual no habla con MP: no pide token.
    expect(parseEnv({ ...PROD_OK, SAAS_BILLING_MODE: "manual" }).SAAS_BILLING_MODE).toBe("manual");
    // Fuera de Production, mp sin token no frena (dev y E2E van contra el simulador).
    expect(() => parseEnv({ SAAS_BILLING_MODE: "mp" })).not.toThrow();
    expect(() => parseEnv({ VERCEL_ENV: "preview", SAAS_BILLING_MODE: "mp" })).not.toThrow();
    spy.mockRestore();
  });

  it("[INF-ENV] MP_MIN_DEBIT_CENTS: opcional, entero positivo en centavos; inválido frena el boot y el getter da null", () => {
    expect(parseEnv({}).MP_MIN_DEBIT_CENTS).toBeUndefined();
    expect(parseEnv({ MP_MIN_DEBIT_CENTS: "" }).MP_MIN_DEBIT_CENTS).toBeUndefined();
    expect(parseEnv({ MP_MIN_DEBIT_CENTS: " 2000 " }).MP_MIN_DEBIT_CENTS).toBe(2000);
    for (const bad of ["0", "-1", "15.5", "1e3", "abc", "1500 ARS"]) {
      expect(() => parseEnv({ MP_MIN_DEBIT_CENTS: bad }), bad).toThrow(/MP_MIN_DEBIT_CENTS/);
    }
    stubLocal();
    expect(envModule.mpMinDebitCents()).toBeNull();
    vi.stubEnv("MP_MIN_DEBIT_CENTS", "2500");
    expect(envModule.mpMinDebitCents()).toBe(2500);
    vi.stubEnv("MP_MIN_DEBIT_CENTS", "doce");
    expect(envModule.mpMinDebitCents()).toBeNull();
  });

  it("[INF-ENV] SAAS_MP_CHECKOUT_NOTIFY: scope (default) | panel; typo frena; getter en caliente", () => {
    expect(parseEnv({}).SAAS_MP_CHECKOUT_NOTIFY).toBe("scope");
    expect(parseEnv({ SAAS_MP_CHECKOUT_NOTIFY: " Panel " }).SAAS_MP_CHECKOUT_NOTIFY).toBe("panel");
    expect(() => parseEnv({ SAAS_MP_CHECKOUT_NOTIFY: "url" })).toThrow(/SAAS_MP_CHECKOUT_NOTIFY/);
    stubLocal();
    expect(envModule.saasMpCheckoutNotify()).toBe("scope");
    vi.stubEnv("SAAS_MP_CHECKOUT_NOTIFY", "panel");
    expect(envModule.saasMpCheckoutNotify()).toBe("panel");
    vi.stubEnv("SAAS_MP_CHECKOUT_NOTIFY", "otra");
    expect(envModule.saasMpCheckoutNotify()).toBe("scope");
  });
});

describe("[INF-ENV] claves que se leían por process.env, ahora en el schema", () => {
  it("[INF-ENV] SUPERADMIN_2FA_BYPASS, SAAS_BILLING_TRANSFER_INFO, NEXT_PUBLIC_PWA y PATIENT_FILES_SIGNED_UPLOAD: opcionales, sin validar forma (no cambia a quien las lee)", () => {
    const e = parseEnv({
      SUPERADMIN_2FA_BYPASS: "u1@2026-10-30, roto",
      SAAS_BILLING_TRANSFER_INFO: "Alias kine.soft · CBU 0000",
      NEXT_PUBLIC_PWA: "off",
      PATIENT_FILES_SIGNED_UPLOAD: "0",
    });
    expect(e.SUPERADMIN_2FA_BYPASS).toBe("u1@2026-10-30, roto");
    expect(e.SAAS_BILLING_TRANSFER_INFO).toBe("Alias kine.soft · CBU 0000");
    expect(e.NEXT_PUBLIC_PWA).toBe("off");
    expect(e.PATIENT_FILES_SIGNED_UPLOAD).toBe("0");
    const empty = parseEnv({ SUPERADMIN_2FA_BYPASS: "", SAAS_BILLING_TRANSFER_INFO: "", NEXT_PUBLIC_PWA: "", PATIENT_FILES_SIGNED_UPLOAD: "" });
    expect(empty.SUPERADMIN_2FA_BYPASS).toBeUndefined();
    expect(empty.PATIENT_FILES_SIGNED_UPLOAD).toBeUndefined();
    // Un valor raro de un interruptor no frena el deploy: su lector ya lo trata (falla cerrado / default prendido).
    expect(() => parseEnv({ NEXT_PUBLIC_PWA: "apagado", PATIENT_FILES_SIGNED_UPLOAD: "quizás" })).not.toThrow();
  });

  it("[INF-ENV] el comentario de SIGNUP_MODE ya no dice que las altas nacen en prueba PRO", () => {
    const src = readFileSync(join(ROOT, "lib/env.ts"), "utf8");
    expect(src).not.toMatch(/prueba PRO/);
    expect(src).toMatch(/nacen en prueba INDIVIDUAL/);
  });
});

/** Variables de runtime/tooling que nadie configura a mano: no van en `.env.example`. */
const NOT_CONFIGURABLE = new Set(["CI", "NEXT_RUNTIME", "VITEST", "USER", "HOME", "PATH", "TZ", "PORT"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

describe("[INF-ENV] .env.example completo", () => {
  const example = readFileSync(join(ROOT, ".env.example"), "utf8");
  /** Una clave cuenta si está activa (`KEY=`) o documentada comentada (`# KEY=`). */
  const documented = (k: string) => new RegExp(`^#?\\s*${k}=`, "m").test(example);

  it("[INF-ENV] trae TODAS las claves del schema de lib/env.ts", () => {
    const keys = envModule.ENV_SCHEMA_KEYS;
    expect(keys.length).toBeGreaterThan(40);
    expect(keys.filter((k) => !documented(k))).toEqual([]);
  });

  it("[INF-ENV] trae las que la app lee por process.env (app, lib, components, middleware, next.config)", () => {
    const files = [...walk(join(ROOT, "app")), ...walk(join(ROOT, "lib")), ...walk(join(ROOT, "components"))];
    for (const f of ["middleware.ts", "next.config.mjs", "instrumentation.ts", "sentry.server.config.ts", "sentry.edge.config.ts"]) {
      try {
        statSync(join(ROOT, f));
        files.push(join(ROOT, f));
      } catch {
        /* no existe */
      }
    }
    const read = new Set<string>();
    for (const f of files) {
      for (const m of readFileSync(f, "utf8").matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) read.add(m[1]);
    }
    const missing = [...read].filter((k) => !NOT_CONFIGURABLE.has(k) && !documented(k)).sort();
    expect(missing).toEqual([]);
  });

  it("[INF-ENV] ningún secreto activo trae un valor (solo placeholders vacíos)", () => {
    const filled = example
      .split("\n")
      .filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l))
      .filter((l) => /(SECRET|TOKEN|PASSWORD|_KEY|_KEYS|BYPASS)=/.test(l))
      .filter((l) => !/=\s*(""|)?\s*(#.*)?$/.test(l));
    expect(filled).toEqual([]);
  });
});
