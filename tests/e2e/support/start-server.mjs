#!/usr/bin/env node
/**
 * OPS-6 · server de la suite E2E: un GoTrue FALSO + `next build` + `next start`, en un solo proceso que Playwright
 * levanta como `webServer` (playwright.config.ts) y mata al terminar.
 *
 * Por qué así y no el actor demo (`KINESOFT_ALLOW_DEMO_ACTOR=1`): `lib/session.ts` lo habilita solo con
 * `NODE_ENV !== "production"`, y `next start` corre en production; además cae en el tenant `movare` del seed, y la
 * suite NUNCA usa seeds. Con el GoTrue falso el camino es el REAL de prod (mismo patrón que `scripts/perf/ttfb.mjs`):
 * form de /login → `signInWithPassword` por HTTP → cookie `sb-127-auth-token` → middleware → `getSessionUser` (JWT
 * verificado local con `SUPABASE_JWT_SECRET`) → membresías → actor.
 *
 * El GoTrue falso implementa lo mínimo que usa la app en un login con contraseña:
 *   - POST /auth/v1/token?grant_type=password  → valida contra `tests/e2e/.state/users.json` (lo escribe el global-setup)
 *   - POST /auth/v1/token?grant_type=refresh_token → re-emite la sesión del dueño del refresh token
 *   - GET  /auth/v1/user                       → el usuario del Bearer (firma verificada)
 *   - POST /auth/v1/logout                     → 204
 *   - Storage en memoria para subir y bajar objetos (FC-E; ver `handleStorage`);
 *   - todo lo demás (admin de service-role, otp, etc.) → 200 `{}`: ningún mail ni usuario real sale de acá.
 * Lee el archivo de usuarios en CADA request: así no importa si Playwright arranca el webServer antes o después del
 * global-setup.
 *
 * Variables (todas opcionales):
 *   E2E_APP_DIR     directorio de la app a buildear/servir (default: la raíz del repo). Sirve para correr contra un
 *                   snapshot `git archive HEAD` cuando hay otras sesiones editando el árbol (el `.next` es uno solo).
 *   E2E_SKIP_BUILD=1  no buildea: usa el `.next` que haya.
 *
 * El `.env` puede apuntar a PRODUCCIÓN y `next start` lo carga: TODAS las claves que la app lee con efecto externo se
 * pisan acá (process.env gana sobre los `.env*` en Next), y la DB tiene que ser localhost o el script no arranca.
 */
import { spawn } from "node:child_process";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import {
  E2E_AUTH_PORT,
  E2E_AUTH_URL,
  E2E_BASE_URL,
  E2E_JWT_SECRET,
  E2E_PORT,
  E2E_REPO_ROOT,
  E2E_USERS_FILE,
} from "./e2e-constants.mjs";
// TP-E (T5): los MISMOS literales del MP falso que `npm run dev:mpfake` y `tests/helpers/mp-connect-fake.ts`. Nunca de `.env*`.
import { DEV_MPFAKE_LITERALS } from "../../../scripts/lib/dev-mp-fake-env.mjs";

const APP_DIR = process.env.E2E_APP_DIR ?? E2E_REPO_ROOT;

function isLocalDb(u) {
  try {
    const h = new URL(u).hostname;
    return h === "localhost" || h === "127.0.0.1";
  } catch {
    return false;
  }
}
if (!isLocalDb(process.env.DATABASE_URL) || !isLocalDb(process.env.DIRECT_URL ?? process.env.DATABASE_URL)) {
  console.error("e2e: DATABASE_URL/DIRECT_URL no son locales. Corré la suite con `npm run test:e2e` (usa .env.local).");
  process.exit(2);
}
// TP-E: el canal service (`prismaService`, lib/db.ts) lee DATABASE_URL_SERVICE primero. El webhook de MP y el turnero
// escriben por ahí: si viniera de otro lado que no sea localhost, no se arranca.
if (process.env.DATABASE_URL_SERVICE !== undefined && !isLocalDb(process.env.DATABASE_URL_SERVICE)) {
  console.error("e2e: DATABASE_URL_SERVICE no es local.");
  process.exit(2);
}

// --- GoTrue falso ------------------------------------------------------------------------------------------------
const b64url = (s) => Buffer.from(s).toString("base64url");
function readUsers() {
  try {
    return JSON.parse(readFileSync(E2E_USERS_FILE, "utf8"));
  } catch {
    return [];
  }
}
function authUserOf(u) {
  return {
    id: u.id,
    aud: "authenticated",
    role: "authenticated",
    email: u.email,
    email_confirmed_at: "2026-01-01T00:00:00Z",
    app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: { full_name: u.fullName ?? "E2E" },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}
function signJwt(payload) {
  const input = [b64url(JSON.stringify({ alg: "HS256", typ: "JWT" })), b64url(JSON.stringify(payload))].join(".");
  return `${input}.${createHmac("sha256", E2E_JWT_SECRET).update(input).digest("base64url")}`;
}
function verifyJwt(token) {
  const [h, p, s] = String(token ?? "").split(".");
  if (!h || !p || !s) return null;
  const expected = createHmac("sha256", E2E_JWT_SECRET).update(`${h}.${p}`).digest();
  const got = Buffer.from(s, "base64url");
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
  const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  if (typeof claims.exp !== "number" || claims.exp < Date.now() / 1000) return null;
  return claims;
}
function sessionFor(u) {
  const now = Math.floor(Date.now() / 1000);
  const sessionId = randomUUID();
  const access = signJwt({
    iss: `${E2E_AUTH_URL}/auth/v1`,
    sub: u.id,
    aud: "authenticated",
    role: "authenticated",
    email: u.email,
    iat: now,
    exp: now + 3600,
    session_id: sessionId,
    aal: "aal1",
  });
  return {
    access_token: access,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: now + 3600,
    // El refresh token lleva el id del usuario: el falso no guarda estado entre requests.
    refresh_token: `e2e-refresh.${u.id}.${sessionId}`,
    user: authUserOf(u),
  };
}
function readBody(req) {
  return new Promise((ok) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        ok(data ? JSON.parse(data) : {});
      } catch {
        ok({});
      }
    });
  });
}
function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
const invalid = { code: "invalid_credentials", error: "invalid_grant", error_description: "Invalid login credentials", msg: "Invalid login credentials" };

/*
 * FC-E (T4): Storage en memoria. `SUPABASE_SERVICE_ROLE_KEY` está puesto (lo pide el admin de GoTrue), así que la app
 * cree que hay Storage (`isStorageConfigured`) y sube el PDF de la ficha compartida acá; con el `{}` de abajo el upload
 * «andaba» pero la descarga del portal devolvía JSON y el sha256 no coincidía (500). Lo mínimo de supabase-js 2.x:
 *   - POST/PUT /storage/v1/object/<bucket>/<clave>   (cuerpo crudo; POST sin `x-upsert: true` no pisa: 409)
 *   - GET      /storage/v1/object/<bucket>/<clave>   (los bytes con su Content-Type; 404 si no está)
 *   - DELETE   /storage/v1/object/<bucket>           ({ prefixes }) → borra
 * El resto (sign, info, move, list, subida firmada) sigue en `{}`: la suite no lo usa (QA manual con Supabase real).
 */
const objects = new Map();
function readRaw(req) {
  return new Promise((ok) => {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => ok(Buffer.concat(parts)));
  });
}
const STORAGE_RESERVED = new Set(["sign", "info", "move", "list", "upload", "copy", "public", "authenticated"]);
async function handleStorage(req, res, url) {
  const rest = decodeURIComponent(url.pathname.slice("/storage/v1/object/".length));
  const [bucket, ...keyParts] = rest.split("/");
  if (!bucket || STORAGE_RESERVED.has(bucket)) return false;
  const key = keyParts.join("/");
  if (req.method === "DELETE" && !key) {
    const body = JSON.parse((await readRaw(req)).toString("utf8") || "{}");
    const removed = (body.prefixes ?? []).filter((k) => objects.delete(`${bucket}/${k}`));
    json(res, 200, removed.map((name) => ({ name, bucket_id: bucket })));
    return true;
  }
  if (!key) return false;
  const id = `${bucket}/${key}`;
  if (req.method === "POST" || req.method === "PUT") {
    const bytes = await readRaw(req);
    if (req.method === "POST" && req.headers["x-upsert"] !== "true" && objects.has(id)) {
      json(res, 400, { statusCode: "409", error: "Duplicate", message: "The resource already exists" });
      return true;
    }
    objects.set(id, { bytes, contentType: String(req.headers["content-type"] ?? "application/octet-stream") });
    json(res, 200, { Key: id, Id: randomUUID() });
    return true;
  }
  if (req.method === "GET") {
    const o = objects.get(id);
    if (!o) {
      json(res, 400, { statusCode: "404", error: "not_found", message: "Object not found" });
      return true;
    }
    res.writeHead(200, { "content-type": o.contentType, "content-length": String(o.bytes.length) });
    res.end(o.bytes);
    return true;
  }
  return false;
}

const authServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", E2E_AUTH_URL);
  if (url.pathname.startsWith("/storage/v1/object/") && (await handleStorage(req, res, url))) return;
  if (req.method === "POST" && url.pathname === "/auth/v1/token") {
    const body = await readBody(req);
    const users = readUsers();
    if (url.searchParams.get("grant_type") === "password") {
      const email = String(body.email ?? "").trim().toLowerCase();
      const u = users.find((x) => x.email.toLowerCase() === email && x.password === body.password);
      return u ? json(res, 200, sessionFor(u)) : json(res, 400, invalid);
    }
    if (url.searchParams.get("grant_type") === "refresh_token") {
      const id = String(body.refresh_token ?? "").split(".")[1];
      const u = users.find((x) => x.id === id);
      return u ? json(res, 200, sessionFor(u)) : json(res, 400, { code: "refresh_token_not_found", error: "invalid_grant", msg: "Invalid Refresh Token" });
    }
    return json(res, 400, invalid);
  }
  if (req.method === "GET" && url.pathname === "/auth/v1/user") {
    const claims = verifyJwt((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
    const u = claims && readUsers().find((x) => x.id === claims.sub);
    return u ? json(res, 200, authUserOf(u)) : json(res, 401, { code: "bad_jwt", msg: "invalid JWT" });
  }
  if (url.pathname === "/auth/v1/logout") {
    res.writeHead(204);
    return res.end();
  }
  return json(res, 200, {});
});
await new Promise((ok) => authServer.listen(E2E_AUTH_PORT, "127.0.0.1", ok));
console.log(`e2e: GoTrue falso en ${E2E_AUTH_URL}`);

// --- next build + next start -----------------------------------------------------------------------------------
const childEnv = {
  ...process.env,
  NODE_ENV: "production",
  // Server en UTC como Vercel: los bugs de timezone se ven acá (el browser va en AR, playwright.config.ts).
  TZ: "UTC",
  NEXT_TELEMETRY_DISABLED: "1",
  NEXT_PUBLIC_SUPABASE_URL: E2E_AUTH_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "e2e-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "e2e-service-key",
  SUPABASE_JWT_SECRET: E2E_JWT_SECRET,
  SUPABASE_JWT_KID: "",
  NEXT_PUBLIC_APP_URL: E2E_BASE_URL,
  // Sin efectos externos: ni realtime, ni mails, ni Mercado Pago, ni Sentry, ni Upstash (rate limit en memoria).
  REALTIME_DRIVER: "off",
  EMAIL_TRANSPORT: "log",
  RESEND_API_KEY: "",
  MP_ACCESS_TOKEN: "",
  MP_PUBLIC_KEY: "",
  MP_WEBHOOK_SECRET: "",
  SENTRY_DSN: "",
  SENTRY_AUTH_TOKEN: "",
  UPSTASH_REDIS_REST_URL: "",
  UPSTASH_REDIS_REST_TOKEN: "",
  KINESOFT_ALLOW_DEMO_ACTOR: "0",
  MAINTENANCE_MODE: "off",
  // TP-0: el turnero reserva sin cobro (el default; explícito para que un `.env` con `platform` no cambie la suite).
  TURNERO_CHECKOUT: "off",
  // TP-E (T5): Mercado Pago FALSO para TODA la suite (un solo server). Las specs de cobro (mp-connect, turnero-cobro,
  // payment-link) conectan la cuenta de prueba por el OAuth del simulador (`/api/mp/fake/*`, que vive en ESTE proceso)
  // y pagan en su checkout; el webhook entra por la ruta real, firmado con este secreto de prueba (`required`, el
  // default de prod). Para las specs de antes no cambia nada: sin `BookingPaymentPolicy` (OFF) el turnero reserva sin
  // cobro y sin cuenta conectada no hay links. NUNCA sandbox ni live: el host de `mpFetch` sale de `NEXT_PUBLIC_APP_URL`
  // (localhost) en modo fake.
  MP_CONNECT_MODE: "fake",
  MP_OAUTH_CLIENT_ID: DEV_MPFAKE_LITERALS.MP_OAUTH_CLIENT_ID,
  MP_OAUTH_CLIENT_SECRET: DEV_MPFAKE_LITERALS.MP_OAUTH_CLIENT_SECRET,
  MP_CONNECT_WEBHOOK_SECRET: DEV_MPFAKE_LITERALS.MP_CONNECT_WEBHOOK_SECRET,
  MP_CONNECT_WEBHOOK_SIGNATURE: "required",
  // Sin claves: secret-box usa la clave dev (solo fuera de Vercel), derivada del `SUPABASE_SERVICE_ROLE_KEY` de arriba.
  SECRET_BOX_KEYS: "",
  // Resto de lo que tiene efecto externo o apunta a prod, tapado igual que en `scripts/lib/dev-mp-fake-env.mjs`.
  PROD_SUPABASE_REF: "",
  PLATFORM_INBOX_EMAIL: "",
  SAAS_BILLING_MODE: "off",
  SENTRY_ORG: "",
  SENTRY_PROJECT: "",
};
// `VERCEL_ENV` es un enum en lib/env.ts ("" no valida): se borra, que es lo que ve un build local. TP-E: también
// `VERCEL` y cualquier `VERCEL_*`: con cualquiera presente el boot rechaza `MP_CONNECT_MODE=fake` (es la barrera que se
// quiere en Vercel, no acá).
for (const k of Object.keys(childEnv)) if (k === "VERCEL" || k.startsWith("VERCEL_")) delete childEnv[k];
// Las claves con efecto externo van en "" (no borradas): process.env gana sobre los `.env*` que carga Next, así que un
// valor vacío acá tapa uno real del `.env` (que puede ser de PRODUCCIÓN).

function run(cmd, argv) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, argv, { cwd: APP_DIR, env: childEnv, stdio: ["ignore", "inherit", "inherit"] });
    p.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`${cmd} ${argv.join(" ")} → ${code}`))));
  });
}

if (process.env.E2E_SKIP_BUILD !== "1" || !existsSync(`${APP_DIR}/.next/BUILD_ID`)) {
  console.log(`e2e: next build en ${APP_DIR}…`);
  await run("npx", ["next", "build"]);
}
const server = spawn("npx", ["next", "start", "-p", String(E2E_PORT)], { cwd: APP_DIR, env: childEnv, stdio: "inherit" });
const shutdown = () => {
  try {
    server.kill("SIGTERM");
  } catch {}
  authServer.close();
};
process.on("SIGTERM", () => (shutdown(), process.exit(0)));
process.on("SIGINT", () => (shutdown(), process.exit(0)));
process.on("exit", shutdown);
server.on("exit", (code) => {
  authServer.close();
  process.exit(code ?? 1);
});
