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
  // INF-ENV (T6, MPS hallazgo 4): cuenta de la PLATAFORMA falsa (cobro de la suscripción SaaS con `SAAS_BILLING_MODE=mp`).
  // Antes iban vacíos: sin secreto, el webhook legado saltea la firma en dev y la rama `?scope=saas` no se podía probar
  // como en prod (firma `required`). El token es un literal que el simulador reconoce; NUNCA un `APP_USR-…` real.
  MP_ACCESS_TOKEN: "FAKE-PLATFORM-ACCESS-TOKEN",
  MP_WEBHOOK_SECRET: "secreto-de-prueba-del-webhook-de-la-plataforma",
});

/**
 * INF-ENV (T6, C-WA1/C-WA5): literales del Meta FALSO (`WHATSAPP_MODE=fake`). Los mismos tiene que usar
 * `tests/helpers/whatsapp-fake.ts`. El verify token cumple el mínimo de 32 de `lib/env.ts`. Nunca de `.env*`.
 */
export const DEV_WAFAKE_LITERALS = Object.freeze({
  WHATSAPP_APP_ID: "kinesoft-fake-wa-app",
  WHATSAPP_APP_SECRET: "kinesoft-fake-wa-app-secret",
  WHATSAPP_CONFIG_ID: "kinesoft-fake-wa-config",
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: "kinesoft-fake-wa-verify-token-0123456789",
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
    // Cuenta de la PLATAFORMA (legado AUDIT §5.4 + suscripción SaaS): literales falsos, nunca los del padre.
    MP_ACCESS_TOKEN: DEV_MPFAKE_LITERALS.MP_ACCESS_TOKEN,
    MP_PUBLIC_KEY: "",
    MP_WEBHOOK_SECRET: DEV_MPFAKE_LITERALS.MP_WEBHOOK_SECRET,

    // Cobro de la suscripción SaaS por MP contra el simulador (MPS-D22). Sin datos de transferencia ni override del
    // mínimo: lo que valga es lo del código, igual en cada máquina.
    SAAS_BILLING_MODE: "mp",
    SAAS_BILLING_TRANSFER_INFO: "",
    MP_MIN_DEBIT_CENTS: "",
    SAAS_MP_CHECKOUT_NOTIFY: "scope",

    // WhatsApp con el Meta FALSO (C-WA5): versión y feature del código, nada del padre.
    WHATSAPP_MODE: "fake",
    WHATSAPP_APP_ID: DEV_WAFAKE_LITERALS.WHATSAPP_APP_ID,
    WHATSAPP_APP_SECRET: DEV_WAFAKE_LITERALS.WHATSAPP_APP_SECRET,
    WHATSAPP_CONFIG_ID: DEV_WAFAKE_LITERALS.WHATSAPP_CONFIG_ID,
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: DEV_WAFAKE_LITERALS.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
    WHATSAPP_GRAPH_VERSION: "",
    WHATSAPP_SIGNUP_FEATURE: "",

    // Ninguna pausa de 2FA heredada: el QA de Plataforma ve la 2FA como es.
    SUPERADMIN_2FA_BYPASS: "",

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

    // Ni mails, ni Sentry, ni Upstash.
    EMAIL_TRANSPORT: "log",
    RESEND_API_KEY: "",
    // PV INT-c: el remitente y el Reply-To tampoco se heredan del `.env` (que puede ser el de Production, HD-6): con
    // "" el transporte usa su default de dev (`DEFAULT_EMAIL_FROM`) y el log del mail no muestra datos reales.
    EMAIL_FROM: "",
    EMAIL_REPLY_TO: "",
    PLATFORM_INBOX_EMAIL: "",
    SENTRY_DSN: "",
    SENTRY_AUTH_TOKEN: "",
    SENTRY_ORG: "",
    SENTRY_PROJECT: "",
    UPSTASH_REDIS_REST_URL: "",
    UPSTASH_REDIS_REST_TOKEN: "",
    MAINTENANCE_MODE: "off",
  };
  // Las de Vercel se BORRAN (no ""): `VERCEL_ENV` es un enum en lib/env.ts y con `VERCEL`/`VERCEL_ENV` presentes el
  // boot rechaza `MP_CONNECT_MODE=fake` (que es justo la barrera que se quiere en Vercel, no acá).
  for (const k of Object.keys(env)) if (k === "VERCEL" || k.startsWith("VERCEL_")) delete env[k];
  return env;
}
