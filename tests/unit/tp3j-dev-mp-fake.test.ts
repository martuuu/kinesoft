/**
 * [TP-3j] `npm run dev:mpfake` (brief §25.9): `next dev` con TZ=UTC, `MP_CONNECT_MODE=fake` y literales de prueba,
 * SIN leer ni escribir `.env*`. Se prueba la función real que arma el entorno del hijo
 * (`scripts/lib/dev-mp-fake-env.mjs`) con un padre lleno de valores MARCADOS como «de producción»: ninguno con efecto
 * externo puede sobrevivir. Y, por texto, que ni el script ni su módulo tocan archivos `.env*` (anti-regresión: la
 * tentación es `dotenv/config` o `loadEnvConfig`, que leerían el `.env` que puede ser de PRODUCCIÓN).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEV_MPFAKE_LITERALS,
  DEV_MPFAKE_SUPABASE_URL,
  devMpFakeEnv,
  parsePort,
} from "../../scripts/lib/dev-mp-fake-env.mjs";
import { FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FAKE_HOOK_SECRET } from "../helpers/mp-connect-fake";

const LOCAL_DB = "postgresql://kinesoft:kinesoft@localhost:5433/kinesoft?schema=public";
const PROD = "PROD-MARCADO";

/** Un padre como el de un shell con un `.env` de prod ya exportado (el peor caso). */
function prodLikeParent(): Record<string, string> {
  return {
    PATH: "/usr/bin",
    HOME: "/Users/x",
    DATABASE_URL: LOCAL_DB,
    DIRECT_URL: LOCAL_DB,
    NEXT_PUBLIC_SUPABASE_URL: `https://${PROD}.supabase.co`,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: `${PROD}-anon`,
    SUPABASE_SERVICE_ROLE_KEY: `${PROD}-service`,
    SUPABASE_JWT_SECRET: `${PROD}-jwt`,
    SUPABASE_JWT_KID: `${PROD}-kid`,
    PROD_SUPABASE_REF: PROD.toLowerCase(),
    NEXT_PUBLIC_APP_URL: `https://${PROD}.vercel.app`,
    MP_ACCESS_TOKEN: `APP_USR-${PROD}`,
    MP_PUBLIC_KEY: `APP_USR-${PROD}-pk`,
    MP_WEBHOOK_SECRET: `${PROD}-hook`,
    MP_CONNECT_MODE: "live",
    MP_OAUTH_CLIENT_ID: `${PROD}-client`,
    MP_OAUTH_CLIENT_SECRET: `${PROD}-client-secret`,
    MP_CONNECT_WEBHOOK_SECRET: `${PROD}-connect-hook`,
    MP_CONNECT_WEBHOOK_SIGNATURE: "fetch-only",
    SECRET_BOX_KEYS: `k1:${PROD}`,
    TURNERO_CHECKOUT: "platform",
    RESEND_API_KEY: `re_${PROD}`,
    EMAIL_TRANSPORT: "resend",
    PLATFORM_INBOX_EMAIL: "equipo@prod.example",
    SENTRY_DSN: `https://${PROD}@sentry.io/1`,
    SENTRY_AUTH_TOKEN: `${PROD}-sentry`,
    SENTRY_ORG: PROD,
    SENTRY_PROJECT: PROD,
    UPSTASH_REDIS_REST_URL: `https://${PROD}.upstash.io`,
    UPSTASH_REDIS_REST_TOKEN: `${PROD}-upstash`,
    REALTIME_DRIVER: "supabase",
    SAAS_BILLING_MODE: "mp",
    MAINTENANCE_MODE: "on",
    KINESOFT_ALLOW_DEMO_ACTOR: "0",
    TZ: "America/Argentina/Buenos_Aires",
    NODE_ENV: "production",
    VERCEL: "1",
    VERCEL_ENV: "production",
    VERCEL_URL: `${PROD}.vercel.app`,
  };
}

describe("[TP-3j] dev:mpfake · entorno del next dev", () => {
  it("MP falso con los literales de prueba (los mismos del helper de tests), TZ=UTC y la URL local", () => {
    const env = devMpFakeEnv(prodLikeParent(), { port: 3100 });
    expect(env.MP_CONNECT_MODE).toBe("fake");
    expect(env.TZ).toBe("UTC");
    expect(env.NODE_ENV).toBe("development");
    expect(env.NEXT_PUBLIC_APP_URL).toBe("http://localhost:3100");
    expect(env.MP_OAUTH_CLIENT_ID).toBe(FAKE_CLIENT_ID);
    expect(env.MP_OAUTH_CLIENT_SECRET).toBe(FAKE_CLIENT_SECRET);
    expect(env.MP_CONNECT_WEBHOOK_SECRET).toBe(FAKE_HOOK_SECRET);
    expect(DEV_MPFAKE_LITERALS.MP_CONNECT_WEBHOOK_SECRET).toBe(FAKE_HOOK_SECRET);
    expect(env.MP_CONNECT_WEBHOOK_SIGNATURE).toBe("required");
    expect(env.TURNERO_CHECKOUT).toBe("off");
    expect(env.REALTIME_DRIVER).toBe("local");
    expect(env.EMAIL_TRANSPORT).toBe("log");
    expect(env.KINESOFT_ALLOW_DEMO_ACTOR).toBe("1");
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe(DEV_MPFAKE_SUPABASE_URL);
    expect(new URL(DEV_MPFAKE_SUPABASE_URL).hostname).toBe("127.0.0.1");
    // La DB local pasa tal cual; PATH y HOME también (npx los necesita).
    expect(env.DATABASE_URL).toBe(LOCAL_DB);
    expect(env.PATH).toBe("/usr/bin");
  });

  it("ningún valor marcado de producción sobrevive; las de Vercel se borran (si no, el boot niega el fake)", () => {
    const env = devMpFakeEnv(prodLikeParent());
    const leaked = Object.entries(env).filter(([, v]) => typeof v === "string" && (v.includes(PROD) || v.includes(PROD.toLowerCase()) || v.includes("prod.example")));
    expect(leaked).toEqual([]);
    for (const k of ["VERCEL", "VERCEL_ENV", "VERCEL_URL"]) expect(k in env).toBe(false);
    // Vacías (no borradas): Next no pisa una clave presente, así que "" tapa la del `.env`.
    for (const k of ["MP_ACCESS_TOKEN", "MP_WEBHOOK_SECRET", "SECRET_BOX_KEYS", "RESEND_API_KEY", "SENTRY_DSN", "UPSTASH_REDIS_REST_TOKEN", "SUPABASE_SERVICE_ROLE_KEY"]) {
      expect(env[k]).toBe("");
    }
  });

  it("no arranca contra una base remota (ni DIRECT_URL ni el canal de servicio)", () => {
    const remote = "postgresql://u:p@db.abcdefgh.supabase.co:5432/postgres";
    expect(() => devMpFakeEnv({ ...prodLikeParent(), DATABASE_URL: remote })).toThrow(/no son locales/);
    expect(() => devMpFakeEnv({ ...prodLikeParent(), DIRECT_URL: remote })).toThrow(/no son locales/);
    expect(() => devMpFakeEnv({ ...prodLikeParent(), DATABASE_URL_SERVICE: remote })).toThrow(/DATABASE_URL_SERVICE/);
    const { DATABASE_URL: _db, DIRECT_URL: _direct, ...sinDb } = prodLikeParent();
    expect(() => devMpFakeEnv(sinDb)).toThrow(/npm run dev:mpfake/);
  });

  it("puerto: --port, --port=, -p, PORT o 3000; inválido → error", () => {
    expect(parsePort([], {})).toBe(3000);
    expect(parsePort([], { PORT: "3200" })).toBe(3200);
    expect(parsePort(["--port", "3100"], { PORT: "3200" })).toBe(3100);
    expect(parsePort(["--port=3101"])).toBe(3101);
    expect(parsePort(["-p", "3102"])).toBe(3102);
    expect(() => parsePort(["--port", "abc"])).toThrow(/puerto inválido/);
    expect(() => parsePort(["--port", "70000"])).toThrow(/puerto inválido/);
  });

  it("ni el script ni su módulo leen o escriben archivos `.env*` (solo comentarios los nombran)", () => {
    for (const f of ["scripts/dev-mp-fake.mjs", "scripts/lib/dev-mp-fake-env.mjs"]) {
      const code = readFileSync(resolve(__dirname, "../..", f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(code, f).not.toMatch(/readFile|writeFile|appendFile|createWriteStream|createReadStream|copyFile|dotenv|loadEnvConfig|@next\/env/);
      // Un literal que sea una RUTA a un `.env*` (".env", "./.env.local", `${ROOT}/.env`), no `process.env`.
      expect(code, f).not.toMatch(/["'`/](?:[^"'`\n]*\/)?\.env[\w.-]*["'`]/);
    }
  });
});
