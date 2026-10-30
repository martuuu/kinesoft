#!/usr/bin/env node
/**
 * Guard post-build de server actions (CF-RT, plan §28 ítem E). Corre DESPUÉS de `next build` y sale 1 si algún chunk
 * del cliente llama una action que el server no conoce.
 *
 * Por qué existe: en prod el indicador realtime decía «Hay una versión nueva · Recargá» sin deploy nuevo. El chunk del
 * hub llamaba `mintRealtimeToken` (id `528c3df5…`) y ese id NO estaba en `.next/server/server-reference-manifest.json`:
 * la action solo era alcanzable por un `import()` dinámico y Next 14.2 no registra esas (AUDIT:2333). El server
 * respondía «Failed to find Server Action» con el MISMO build y nada en el build, tsc ni los tests lo veía: solo un
 * usuario mirando el cartel. Este guard lo convierte en un fallo del gate.
 *
 * Qué compara (forma real de Next 14.2.35, inspeccionada en `.next/static/chunks`):
 * - Cliente: cada referencia a una action compila a `(0,X.$)("<id de 40 hex>")`, donde `$` es el export del wrapper
 *   `action-client-wrapper` (`function a(e){let{createServerReference:t}=n(6671);return t(e,r.callServer)}`). En un
 *   build sin minificar es `(0,…createServerReference)("<id>")`. Se aceptan las dos formas.
 * - Server: las claves de `node` y `edge` del manifest (`encryptionKey` no es un id).
 *
 * Uso: `node scripts/check-server-actions.mjs [--dir .next] [--json]`. Sin `.next/` sale 2 (no es verde: no midió).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * `(0,r.$)("id")` minificado o `(0,…createServerReference)("id")` sin minificar. El `)` antes de `(` ata la forma de
 * llamada `(0, fn)(…)` que emite webpack: un string de 40 hex suelto (un hash cualquiera) no matchea.
 */
const REF_RE = /(?:\.\$|createServerReference)\)\(\s*["']([0-9a-f]{40})["']/g;

/** Ids de action referenciados en un chunk (únicos, en orden de aparición). */
export function extractActionIds(code) {
  const out = [];
  const seen = new Set();
  for (const m of String(code).matchAll(REF_RE)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push(m[1]);
  }
  return out;
}

/** Ids registrados en el server (node + edge). */
export function manifestActionIds(manifest) {
  const ids = new Set();
  for (const side of ["node", "edge"]) {
    const m = manifest && manifest[side];
    if (m && typeof m === "object") for (const id of Object.keys(m)) ids.add(id);
  }
  return ids;
}

function walkJs(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = join(dir, e.name);
    if (e.isDirectory()) walkJs(f, out);
    else if (e.isFile() && f.endsWith(".js")) out.push(f);
  }
  return out;
}

/**
 * Recorre `<dir>/static/chunks/**.js` y cruza con `<dir>/server/server-reference-manifest.json`.
 * Devuelve `{ referenced, registered, missing: [{ id, chunks }] }`; tira si falta algo del build.
 */
export function checkServerActions(nextDir) {
  const chunksDir = join(nextDir, "static", "chunks");
  const manifestPath = join(nextDir, "server", "server-reference-manifest.json");
  if (!existsSync(chunksDir) || !statSync(chunksDir).isDirectory()) {
    throw new Error(`no hay ${chunksDir}: corré el build antes`);
  }
  if (!existsSync(manifestPath)) throw new Error(`no hay ${manifestPath}: corré el build antes`);
  const registered = manifestActionIds(JSON.parse(readFileSync(manifestPath, "utf8")));
  const refs = new Map();
  for (const f of walkJs(chunksDir)) {
    for (const id of extractActionIds(readFileSync(f, "utf8"))) {
      if (!refs.has(id)) refs.set(id, []);
      refs.get(id).push(relative(nextDir, f));
    }
  }
  const missing = [];
  for (const [id, chunks] of refs) if (!registered.has(id)) missing.push({ id, chunks });
  missing.sort((a, b) => a.id.localeCompare(b.id));
  return { referenced: refs.size, registered: registered.size, missing };
}

function main(argv) {
  const dirIdx = argv.indexOf("--dir");
  const dir = dirIdx >= 0 ? argv[dirIdx + 1] : ".next";
  const asJson = argv.includes("--json");
  if (!dir) {
    console.error("[server-actions] uso: --dir <carpeta .next>");
    return 2;
  }
  let r;
  try {
    r = checkServerActions(dir);
  } catch (err) {
    console.error(`[server-actions] ${err instanceof Error ? err.message : err}`);
    return 2;
  }
  if (asJson) console.log(JSON.stringify(r, null, 2));
  if (r.referenced === 0) {
    // Ningún chunk con actions = el regex dejó de reconocer la forma de Next (upgrade): no es verde.
    console.error("[server-actions] ningún chunk referencia actions: ¿cambió la forma de createServerReference en Next?");
    return 1;
  }
  if (r.missing.length) {
    console.error(
      `[server-actions] ${r.missing.length} action(s) que el cliente llama y el server no registró ` +
        `(«Failed to find Server Action» en el MISMO build; suele ser una action alcanzable solo por import()):`,
    );
    for (const m of r.missing) console.error(`  ${m.id}  ← ${m.chunks.join(", ")}`);
    return 1;
  }
  if (!asJson) console.log(`[server-actions] OK: ${r.referenced} ids del cliente, todos en el manifest (${r.registered}).`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}

export { main };
