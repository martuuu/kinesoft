/**
 * TP-3j (T5, brief §25.9) · entorno del `next dev` con el Mercado Pago FALSO (`scripts/dev-mp-fake.mjs`). Lógica pura
 * (recibe el entorno del padre, devuelve el del hijo) para que el unit test `tests/unit/tp3j-dev-mp-fake.test.ts` la
 * pruebe con valores marcados sin levantar nada.
 *
 * Por qué existe y no alcanza con `MP_CONNECT_MODE=fake npm run dev`:
 *   - `next dev` carga `.env` además de `.env.local`, y `.env` puede ser de PRODUCCIÓN (AGENTS §4). Hoy `.env.local`
 *     no trae las claves de Supabase, así que un `next dev` pelado toma las de `.env`. Next NO pisa una variable que ya
 *     está en `process.env` (aunque sea `""`), así que acá se ponen EXPLÍCITAS todas las que tienen efecto externo:
 *     vacías o con un literal de prueba. Mismo criterio que `tests/e2e/support/start-server.mjs`.
 *   - Este módulo NUNCA lee ni escribe `.env*`. La DB local llega por `dotenv -e .env.local` en el script de npm
 *     (`dev:mpfake`), el mismo patrón que `test:e2e`; acá solo se verifica que apunte a localhost, y si no, no arranca.
 *
 * Login: sin Supabase (la URL apunta a un puerto de loopback donde no escucha nadie) entra el actor demo de dev
 * (`KINESOFT_ALLOW_DEMO_ACTOR=1`, `lib/session.ts`; nunca en production). El QA manual multi-rol con usuarios reales
 * queda para la suite E2E (GoTrue falso) o para un Supabase LOCAL que Martin levante a mano.
 */

/** Literales del MP falso: los mismos que `tests/helpers/mp-connect-fake.ts` (FAKE_CLIENT_ID, …). Nunca de `.env*`. */
export const DEV_MPFAKE_LITERALS = Object.freeze({
  MP_OAUTH_CLIENT_ID: "kinesoft-fake-app",
  MP_OAUTH_CLIENT_SECRET: "kinesoft-fake-secret",
  MP_CONNECT_WEBHOOK_SECRET: "secreto-de-prueba-del-webhook",
});

/** Supabase a ningún lado: loopback, puerto sin servidor. La URL tiene que ser válida (`lib/env.ts` la valida con zod). */
export const DEV_MPFAKE_SUPABASE_URL = "http://127.0.0.1:54398";

export const DEV_MPFAKE_DEFAULT_PORT = 3000;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLocalDbUrl(u) {
  try {
    return LOCAL_HOSTS.has(new URL(u).hostname);
  } catch {
    return false;
  }
}

/** `--port 3100`, `--port=3100` o `-p 3100`; si no, `PORT`; si no, 3000. */
export function parsePort(argv, parentEnv = {}) {
  let raw;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port" || a === "-p") raw = argv[i + 1];
    else if (a.startsWith("--port=")) raw = a.slice("--port=".length);
  }
  raw ??= parentEnv.PORT;
  if (raw === undefined || raw === "") return DEV_MPFAKE_DEFAULT_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`dev:mpfake: puerto inválido (${raw}).`);
  return n;
}

/**
 * Entorno del hijo. Tira si la DB no es local (no se levanta nada contra una base remota). Nada del padre con efecto
 * externo sobrevive: o se pisa acá o se borra (las de Vercel).
 */
export function devMpFakeEnv(parentEnv, { port = DEV_MPFAKE_DEFAULT_PORT } = {}) {
  const db = parentEnv.DATABASE_URL;
  const direct = parentEnv.DIRECT_URL ?? db;
  if (!isLocalDbUrl(db) || !isLocalDbUrl(direct)) {
    throw new Error(
      "dev:mpfake: DATABASE_URL/DIRECT_URL no son locales (o faltan). Corrélo con `npm run dev:mpfake`, que trae solo la DB local."
    );
  }
  if (parentEnv.DATABASE_URL_SERVICE && !isLocalDbUrl(parentEnv.DATABASE_URL_SERVICE)) {
    throw new Error("dev:mpfake: DATABASE_URL_SERVICE no es local.");
  }
  const appUrl = `http://localhost:${port}`;
  const env = {
    ...parentEnv,
    NODE_ENV: "development",
    // El server en UTC como Vercel: los bugs de timezone se ven acá (AGENTS §3).
    TZ: "UTC",
    NEXT_TELEMETRY_DISABLED: "1",
    NEXT_PUBLIC_APP_URL: appUrl,

    // Mercado Pago FALSO (C-TP12). Sin SECRET_BOX_KEYS: secret-box usa la clave de desarrollo (Sistema lo avisa).
    MP_CONNECT_MODE: "fake",
    MP_OAUTH_CLIENT_ID: DEV_MPFAKE_LITERALS.MP_OAUTH_CLIENT_ID,
    MP_OAUTH_CLIENT_SECRET: DEV_MPFAKE_LITERALS.MP_OAUTH_CLIENT_SECRET,
    MP_CONNECT_WEBHOOK_SECRET: DEV_MPFAKE_LITERALS.MP_CONNECT_WEBHOOK_SECRET,
    MP_CONNECT_WEBHOOK_SIGNATURE: "required",
    SECRET_BOX_KEYS: "",
    TURNERO_CHECKOUT: "off",
    // Mercado Pago legado (token de la plataforma, AUDIT §5.4): apagado.
    MP_ACCESS_TOKEN: "",
    MP_PUBLIC_KEY: "",
    MP_WEBHOOK_SECRET: "",

    // Supabase a ningún lado (ver la cabecera) y el actor demo para entrar.
    NEXT_PUBLIC_SUPABASE_URL: DEV_MPFAKE_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "dev-mpfake-anon-key-no-real",
    SUPABASE_SERVICE_ROLE_KEY: "",
    SUPABASE_JWT_SECRET: "dev-mpfake-jwt-secret-solo-local-0123456789abcdef",
    SUPABASE_JWT_KID: "",
    PROD_SUPABASE_REF: "",
    KINESOFT_ALLOW_DEMO_ACTOR: "1",
    // Tiempo real con el bus en memoria (un proceso): la agenda de otra pestaña se actualiza sola (QA manual #3).
    REALTIME_DRIVER: "local",

    // Ni mails, ni Sentry, ni Upstash, ni cobro SaaS.
    EMAIL_TRANSPORT: "log",
    RESEND_API_KEY: "",
    PLATFORM_INBOX_EMAIL: "",
    SENTRY_DSN: "",
    SENTRY_AUTH_TOKEN: "",
    SENTRY_ORG: "",
    SENTRY_PROJECT: "",
    UPSTASH_REDIS_REST_URL: "",
    UPSTASH_REDIS_REST_TOKEN: "",
    SAAS_BILLING_MODE: "off",
    MAINTENANCE_MODE: "off",
  };
  // Las de Vercel se BORRAN (no ""): `VERCEL_ENV` es un enum en lib/env.ts y con `VERCEL`/`VERCEL_ENV` presentes el
  // boot rechaza `MP_CONNECT_MODE=fake` (que es justo la barrera que se quiere en Vercel, no acá).
  for (const k of Object.keys(env)) if (k === "VERCEL" || k.startsWith("VERCEL_")) delete env[k];
  return env;
}
