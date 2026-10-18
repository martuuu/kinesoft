/**
 * OPS-6 · constantes compartidas entre `playwright.config.ts`, el global-setup (TS) y `start-server.mjs` (node pelado,
 * sin transpilar: por eso es `.mjs` y no `.ts`).
 *
 * Puertos propios (3300/3299) y no los de `scripts/perf/ttfb.mjs` (3100/3199): en una ola puede haber otra sesión con
 * el GoTrue falso de perf o un `next dev` ad hoc levantados en el mismo host.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const E2E_PORT = Number(process.env.E2E_PORT ?? 3300);
export const E2E_AUTH_PORT = Number(process.env.E2E_AUTH_PORT ?? 3299);
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;
export const E2E_AUTH_URL = `http://127.0.0.1:${E2E_AUTH_PORT}`;

/**
 * Secreto HS256 propio de la corrida: el GoTrue falso firma los access tokens con él y el server lo recibe como
 * `SUPABASE_JWT_SECRET`, así `getSessionUser` los verifica LOCAL como en prod (lib/session-jwt.ts). No es un secreto
 * de nada real.
 */
export const E2E_JWT_SECRET = "e2e-jwt-secret-solo-local-0123456789abcdef";

const HERE = dirname(fileURLToPath(import.meta.url));
export const E2E_REPO_ROOT = resolve(HERE, "../../..");
/** Estado de la corrida (usuarios del GoTrue falso, ids del tenant): lo escribe el global-setup. Gitignoreado. */
export const E2E_STATE_DIR = resolve(E2E_REPO_ROOT, "tests/e2e/.state");
export const E2E_USERS_FILE = resolve(E2E_STATE_DIR, "users.json");
export const E2E_FIXTURE_FILE = resolve(E2E_STATE_DIR, "fixture.json");
export const E2E_PASSWORD = "e2e-Clave-123";
