#!/usr/bin/env node
/**
 * INF-DEV (T6+T7, brief §26.7) · `npm run dev` seguro.
 *
 * Por qué existe: `next dev` carga `.env` además de `.env.local`, y `.env` puede ser de PRODUCCIÓN (AGENTS §4). Hoy
 * `.env.local` no trae las claves de Supabase, así que un `next dev` pelado toma el Supabase de `.env`: el login, el
 * Storage y el service role de prod desde la máquina de Martin. Este wrapper resuelve el Supabase EFECTIVO que vería
 * `next dev` y, si es remoto (o su ref es `PROD_SUPABASE_REF`), no arranca, salvo `ALLOW_DEV_REMOTE_SUPABASE=1`.
 * El comando diario recomendado pasa a ser `npm run dev:local` (simuladores, `scripts/dev-mp-fake.mjs`).
 *
 * Reglas:
 *   - lee los `.env*` SOLO para decidir, y solo dos claves (`NEXT_PUBLIC_SUPABASE_URL`, `PROD_SUPABASE_REF`); no usa
 *     `dotenv` ni `@next/env` y no carga nada al `process.env` (el hijo hereda el entorno del padre tal cual: Next hace
 *     su carga normal);
 *   - NUNCA imprime un valor: los mensajes nombran el archivo de donde salió la URL, no la URL ni el ref;
 *   - si no hay URL, arranca (no hay remoto al que apuntar: `lib/env.ts` dirá lo que falte); si la URL no parsea,
 *     bloquea (no se puede verificar que sea local).
 *
 * Orden de carga de `next dev` (@next/env, NODE_ENV=development): lo ya exportado en `process.env` gana; después
 * `.env.development.local`, `.env.local`, `.env.development`, `.env`, y el PRIMER archivo que define una clave gana.
 * Descartado: expandir `$VAR` como hace @next/env (nadie lo usa en estas dos claves; una URL con `$` no parsea como
 * host local y bloquea, que es el lado seguro).
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEV_ENV_FILES = Object.freeze([".env.development.local", ".env.local", ".env.development", ".env"]);
const KEYS = ["NEXT_PUBLIC_SUPABASE_URL", "PROD_SUPABASE_REF"];
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export const BLOCK_MESSAGE =
  "`npm run dev` apuntaría a un Supabase remoto (posible producción). Usá `npm run dev:local` (simuladores) o, si de " +
  "verdad querés el remoto, ALLOW_DEV_REMOTE_SUPABASE=1 npm run dev.";

/** Parser mínimo de dotenv: `export `, comillas simples/dobles, comentarios. Devuelve SOLO las claves pedidas. */
export function parseEnvFileKeys(text, keys) {
  const want = new Set(keys);
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m || !want.has(m[1]) || m[1] in out) continue;
    let v = m[2].trim();
    const q = v[0];
    if ((q === '"' || q === "'" || q === "`") && v.indexOf(q, 1) > 0) v = v.slice(1, v.indexOf(q, 1));
    else v = v.replace(/\s+#.*$/, "").trim();
    out[m[1]] = v;
  }
  return out;
}

/**
 * Lo que vería `next dev` para las dos claves, sin tocar `env` ni `process.env`. `urlSource` es el NOMBRE del origen
 * (`process.env` o el archivo), que sí se puede mostrar.
 */
export function resolveEffectiveSupabase({ cwd, env }) {
  const found = {};
  const source = {};
  for (const k of KEYS) {
    if (env[k] !== undefined) {
      found[k] = env[k];
      source[k] = "process.env";
    }
  }
  for (const f of DEV_ENV_FILES) {
    const p = join(cwd, f);
    if (!existsSync(p)) continue;
    const parsed = parseEnvFileKeys(readFileSync(p, "utf8"), KEYS);
    for (const k of KEYS) {
      if (!(k in found) && k in parsed) {
        found[k] = parsed[k];
        source[k] = f;
      }
    }
  }
  return {
    supabaseUrl: found.NEXT_PUBLIC_SUPABASE_URL,
    urlSource: source.NEXT_PUBLIC_SUPABASE_URL ?? null,
    prodRef: found.PROD_SUPABASE_REF,
    allowRemote: env.ALLOW_DEV_REMOTE_SUPABASE,
  };
}

/** `https://<ref>.supabase.co` → `<ref>`; cualquier otra cosa → null. */
export function supabaseRefOf(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const m = host.match(/^([a-z0-9-]+)\.supabase\.(co|in|net)$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Decisión pura. Devuelve `{ action: "start" | "block", reason, message }`; `message` nunca lleva la URL ni el ref.
 * El override es exactamente "1" (como el resto de los flags del repo): "true" no alcanza, para que no se active de
 * casualidad.
 */
export function decideDevStart({ supabaseUrl, urlSource = null, prodRef, allowRemote }) {
  const where = urlSource ? ` (NEXT_PUBLIC_SUPABASE_URL sale de ${urlSource})` : "";
  if (allowRemote === "1") {
    return { action: "start", reason: "override", message: "dev: ALLOW_DEV_REMOTE_SUPABASE=1, arranca sin verificar el Supabase." };
  }
  if (supabaseUrl === undefined || supabaseUrl === "") {
    return { action: "start", reason: "missing", message: "dev: sin NEXT_PUBLIC_SUPABASE_URL; no hay Supabase remoto." };
  }
  let host;
  try {
    host = new URL(supabaseUrl).hostname.toLowerCase();
  } catch {
    return {
      action: "block",
      reason: "invalid",
      message: `dev: NEXT_PUBLIC_SUPABASE_URL no es una URL válida${where}, no se puede verificar que sea local. ${BLOCK_MESSAGE}`,
    };
  }
  const ref = supabaseRefOf(supabaseUrl);
  if (prodRef && ref && ref === String(prodRef).trim().toLowerCase()) {
    return { action: "block", reason: "prod-ref", message: `${BLOCK_MESSAGE}\nEl ref coincide con PROD_SUPABASE_REF${where}.` };
  }
  if (LOCAL_HOSTS.has(host)) return { action: "start", reason: "local", message: "dev: Supabase local." };
  return { action: "block", reason: "remote", message: `${BLOCK_MESSAGE}\nEl host no es localhost/127.0.0.1${where}.` };
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const decision = decideDevStart(resolveEffectiveSupabase({ cwd: root, env: process.env }));
  if (decision.action === "block") {
    console.error(decision.message);
    process.exit(2);
  }
  if (decision.reason === "override") console.warn(decision.message);
  // Entorno del padre sin cambios: Next hace su carga normal de `.env*`.
  const child = spawn("npx", ["next", "dev", ...process.argv.slice(2)], { cwd: root, env: process.env, stdio: "inherit" });
  const stop = (sig) => {
    try {
      child.kill(sig);
    } catch {}
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 0 : 1)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
