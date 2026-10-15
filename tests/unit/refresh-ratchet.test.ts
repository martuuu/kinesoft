/**
 * PF-0d (§20.4 / §20.9) · ratchet de `router.refresh()` en `components/`.
 *
 * Regla: si la server action hace `revalidatePath`, la respuesta de la action YA
 * trae el árbol RSC nuevo de la página actual; un `router.refresh()` después es
 * un segundo render entero (+203 ms en /agenda, +139 ms en /pacientes por
 * mutación, .docs/PERF.md §PF-0). `router.refresh()` queda solo para realtime,
 * route handlers (fetch), cambios de auth del cliente, refresh explícito del
 * usuario o una action que NO revalida — y cada uno lleva `// refresh-ok: <porqué>`
 * en la misma línea o en el bloque de comentarios `//` justo encima.
 *
 * Este guard cuenta los `router.refresh()` de código (no los de comentarios) SIN
 * esa marca. El tope baja a medida que cada área (PF1) los saca: si el número
 * crece, alguien agregó un doble render nuevo; si bajó, ajustá `MAX_UNMARKED`.
 *
 * Además, un CANARIO del supuesto de Next 14.2 en que se apoya la regla: que
 * CUALQUIER `revalidatePath`/`revalidateTag` en la action (aunque sea de otra
 * ruta) marca `pathWasRevalidated` y que eso hace que el action handler mande el
 * árbol de la página actual. Si una versión nueva de Next lo acota por ruta, este
 * test falla y hay que revisar las actions que solo revalidan otras rutas
 * (p. ej. `movePlanSeries` → `/pacientes/<id>`, usada desde el drawer de agenda).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();

/**
 * PF-0d (15-oct-2026): 103 sin marca en HEAD 1553192; PF-0d sacó 10 (agenda 3,
 * pacientes 7) y marcó 2 (agenda: realtime de disponibilidad y Recepción con
 * «cambió en otra sesión», que no revalida).
 */
const MAX_UNMARKED = 90; // PL-Z (integrador): 91 → 90, cambiar el rol en Usuarios ya no refresca (la action revalida).

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?)$/.test(name)) out.push(p);
  }
  return out;
}

const CALL = /\brouter\.refresh\(\)/;

/** ¿La aparición en `line` está dentro de un comentario? */
function inComment(line: string): boolean {
  const t = line.trim();
  if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("{/*")) return true;
  const at = line.search(CALL);
  const slashes = line.indexOf("//");
  return slashes !== -1 && slashes < at;
}

/** `refresh-ok:` en la misma línea o en el bloque de `//` contiguo de arriba. */
function marked(lines: string[], i: number): boolean {
  if (lines[i].includes("refresh-ok:")) return true;
  for (let j = i - 1; j >= 0; j--) {
    const t = lines[j].trim();
    if (!t.startsWith("//")) return false;
    if (t.includes("refresh-ok:")) return true;
  }
  return false;
}

function unmarkedRefreshes(source: string): number[] {
  const lines = source.split("\n");
  const hits: number[] = [];
  lines.forEach((line, i) => {
    if (CALL.test(line) && !inComment(line) && !marked(lines, i)) hits.push(i + 1);
  });
  return hits;
}

describe("PF-0d · ratchet de router.refresh() sin `// refresh-ok:`", () => {
  it("el escáner distingue código, comentarios y la marca", () => {
    const src = [
      "// `router.refresh()` en un comentario no cuenta",
      " * tampoco en un JSDoc: router.refresh()",
      "router.refresh();",
      "// refresh-ok: realtime",
      "if (x) router.refresh();",
      "onDone={() => router.refresh()} // refresh-ok: route handler",
      "// refresh-ok: arriba, pero con una línea de código en el medio",
      "const a = 1;",
      "router.refresh();",
    ].join("\n");
    expect(unmarkedRefreshes(src)).toEqual([3, 9]);
  });

  it(`components/ no supera ${MAX_UNMARKED} router.refresh() sin marca`, () => {
    const found: string[] = [];
    for (const f of walk(join(ROOT, "components"))) {
      for (const n of unmarkedRefreshes(readFileSync(f, "utf8"))) found.push(`${relative(ROOT, f)}:${n}`);
    }
    // El listado sale en el mensaje del fallo: ahí está el nuevo.
    expect(found.length, found.join("\n")).toBeLessThanOrEqual(MAX_UNMARKED);
  });

  it("agenda, pacientes, Recepción y sala (PF-0d) quedan en cero sin marca", () => {
    const owned = ["components/agenda", "components/patients", "components/sala"];
    const found: string[] = [];
    for (const d of owned) {
      for (const f of walk(join(ROOT, d))) {
        for (const n of unmarkedRefreshes(readFileSync(f, "utf8"))) found.push(`${relative(ROOT, f)}:${n}`);
      }
    }
    expect(found).toEqual([]);
  });
});

describe("PF-0d · canario de Next: cualquier revalidación en la action trae el árbol actual", () => {
  const next = (p: string) => readFileSync(join(ROOT, "node_modules/next/dist", p), "utf8");

  it("revalidatePath de OTRA ruta y revalidateTag marcan `pathWasRevalidated` igual", async () => {
    // Los módulos reales de Next (CJS), sin mock: el store es el mínimo que
    // `revalidate()` lee en una action (request dinámico, no build estático).
    // Next arma su ALS con el global que instala su server; acá se lo damos.
    const g = globalThis as { AsyncLocalStorage?: unknown };
    g.AsyncLocalStorage ??= (await import("node:async_hooks")).AsyncLocalStorage;
    const { staticGenerationAsyncStorage } = (await import(
      "next/dist/client/components/static-generation-async-storage.external.js"
    )) as { staticGenerationAsyncStorage: { run: <T>(store: object, fn: () => T) => T } };
    const { revalidatePath, revalidateTag } = (await import(
      "next/dist/server/web/spec-extension/revalidate.js"
    )) as { revalidatePath: (p: string) => void; revalidateTag: (t: string) => void };
    const run = (fn: () => void) => {
      const store: Record<string, unknown> = { incrementalCache: {}, urlPathname: "/agenda", isStaticGeneration: false };
      staticGenerationAsyncStorage.run(store, fn);
      return store.pathWasRevalidated;
    };
    expect(run(() => revalidatePath("/pacientes/abc"))).toBe(true);
    expect(run(() => revalidateTag("t1:dashboard"))).toBe(true);
    expect(run(() => {})).toBeUndefined();
  });

  it("el action handler manda el árbol (flight) cuando hubo revalidación", () => {
    expect(next("server/app-render/action-handler.js")).toContain(
      "skipFlight: !staticGenerationStore.pathWasRevalidated"
    );
  });
});
