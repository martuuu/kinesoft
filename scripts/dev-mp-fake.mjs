#!/usr/bin/env node
/**
 * TP-3j (T5, brief §25.9) · `npm run dev:mpfake`: `next dev` con el Mercado Pago FALSO para el QA manual de T5
 * (QA.md «T5»): conectar la cuenta de prueba, cobrar desde el turnero y desde un link de pago, reintegrar y forzar la
 * reconexión, todo contra `/api/mp/fake/*` y sin tocar Mercado Pago real.
 *
 * Reglas (AGENTS §4, regla de T5 «PRODUCCIÓN: INADMISIBLE»):
 *   - este script NUNCA lee ni escribe `.env*`. El script de npm es `dotenv -e .env.local -- node scripts/dev-mp-fake.mjs`
 *     (como `test:e2e`): dotenv-cli trae SOLO la DB local y acá se verifica que sea localhost, o no arranca;
 *   - toda variable con efecto externo se pisa con un literal de prueba o vacía (`scripts/lib/dev-mp-fake-env.mjs`): Next
 *     no pisa lo que ya está en `process.env`, así que un `.env` de producción no se cuela;
 *   - el simulador solo existe con `MP_CONNECT_MODE=fake` y sin `VERCEL`/`VERCEL_ENV` (lib/env.ts y la ruta lo niegan).
 *
 * Uso: `npm run dev:mpfake` (puerto 3000) o `npm run dev:mpfake -- --port 3100`. Entra el actor demo de dev (no hay
 * Supabase). Panel del simulador: `http://localhost:<puerto>/api/mp/fake/panel` (y Plataforma → Sistema lo linkea).
 */
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { devMpFakeEnv, parsePort } from "./lib/dev-mp-fake-env.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let port;
let env;
try {
  port = parsePort(process.argv.slice(2), process.env);
  env = devMpFakeEnv(process.env, { port });
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(2);
}

console.log(`dev:mpfake: next dev en http://localhost:${port} · MP_CONNECT_MODE=fake · TZ=UTC · DB local`);
console.log(`dev:mpfake: simulador en http://localhost:${port}/api/mp/fake/panel (nada de esto toca Mercado Pago real)`);

const child = spawn("npx", ["next", "dev", "-p", String(port)], { cwd: ROOT, env, stdio: "inherit" });
const stop = (sig) => {
  try {
    child.kill(sig);
  } catch {}
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 0 : 1)));
