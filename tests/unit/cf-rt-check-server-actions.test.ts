/**
 * [CF-RT3] `scripts/check-server-actions.mjs`: después de `next build`, cada action que un chunk del cliente llama
 * (`(0,X.$)("<id>")`) tiene que estar en `server-reference-manifest.json`. Si no, el server responde «Failed to find
 * Server Action» con el MISMO build (lo que rompió el realtime en prod, §28 E).
 *
 * Fixtures en un tmp con la forma REAL de Next 14.2.35 (copiada de `.next/static/chunks/8781.*.js` y del wrapper
 * `12119`). Se prueba el `checkServerActions` / `main` reales del script.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkServerActions, extractActionIds, main, manifestActionIds } from "../../scripts/check-server-actions.mjs";

const TOKEN = "528c3df51728f66fedc9a5ad40415559b3966dbb";
const FEED = "59a70022324d89e22f15538bbf48fb5f7f8c08be";
const EDGE = "0123456789abcdef0123456789abcdef01234567";

// Forma minificada real (chunk del hub) y la sin minificar (dev / build sin terser).
const HUB_CHUNK = `"use strict";(self.webpackChunk_N_E=self.webpackChunk_N_E||[]).push([[8781],{1:function(e,n,t){t.d(n,{getRealtimeToken:function(){return u}});var r=t(25199),o=t(62585);t(83079);var i=(0,t(12119).$)("${TOKEN}");function u(){}}}]);`;
const TV_CHUNK = `var a=n(12119),l=(0,a.$)("${FEED}"),m=(0,a.$)("${EDGE}");`;
const DEV_CHUNK = `const x = (0,private_next_rsc_action_client_wrapper__WEBPACK_IMPORTED_MODULE_0__.createServerReference)("${FEED}");`;
// Un hash de 40 hex que NO es una referencia (no es una llamada `(0,fn)(…)`): no cuenta.
const NOISE_CHUNK = `var h="${"f".repeat(40)}";foo("${"e".repeat(40)}");`;

let dir: string;

function build(chunks: Record<string, string>, manifest: unknown) {
  mkdirSync(join(dir, "static", "chunks", "app"), { recursive: true });
  mkdirSync(join(dir, "server"), { recursive: true });
  for (const [name, code] of Object.entries(chunks)) writeFileSync(join(dir, "static", "chunks", name), code);
  writeFileSync(join(dir, "server", "server-reference-manifest.json"), JSON.stringify(manifest));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cf-rt3-"));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("[CF-RT3] check-server-actions", () => {
  it("[CF-RT3] extrae ids de la forma minificada y de la sin minificar; ignora hashes sueltos", () => {
    expect(extractActionIds(HUB_CHUNK)).toEqual([TOKEN]);
    expect(extractActionIds(TV_CHUNK)).toEqual([FEED, EDGE]);
    expect(extractActionIds(DEV_CHUNK)).toEqual([FEED]);
    expect(extractActionIds(NOISE_CHUNK)).toEqual([]);
    expect([...manifestActionIds({ node: { [FEED]: {} }, edge: { [EDGE]: {} }, encryptionKey: "k" })]).toEqual([FEED, EDGE]);
  });

  it("[CF-RT3] detecta el id que el cliente llama y el server no registró (el caso de prod)", () => {
    build(
      { "8781.b2b7ada16f547052.js": HUB_CHUNK, "app/tv.js": TV_CHUNK, "noise.js": NOISE_CHUNK },
      { node: { [FEED]: { workers: {} } }, edge: { [EDGE]: { workers: {} } }, encryptionKey: "k" },
    );
    const r = checkServerActions(dir);
    expect(r.referenced).toBe(3);
    expect(r.missing).toEqual([{ id: TOKEN, chunks: [join("static", "chunks", "8781.b2b7ada16f547052.js")] }]);
    expect(main(["--dir", dir])).toBe(1);
  });

  it("[CF-RT3] pasa (exit 0) con todos los ids en node o edge", () => {
    build(
      { "8781.js": HUB_CHUNK, "app/tv.js": TV_CHUNK, "dev.js": DEV_CHUNK },
      { node: { [TOKEN]: {}, [FEED]: {} }, edge: { [EDGE]: {} }, encryptionKey: "k" },
    );
    expect(checkServerActions(dir).missing).toEqual([]);
    expect(main(["--dir", dir])).toBe(0);
  });

  it("[CF-RT3] sin build no es verde (2), y cero referencias tampoco (1: cambió la forma de Next)", () => {
    expect(main(["--dir", join(dir, "nada")])).toBe(2);
    build({ "noise.js": NOISE_CHUNK }, { node: {}, edge: {} });
    expect(main(["--dir", dir])).toBe(1);
  });
});
