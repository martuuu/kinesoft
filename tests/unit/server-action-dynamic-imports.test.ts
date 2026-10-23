import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * WA-E (T6, X8) · Guard: un `import()` de un módulo `"use server"` que vive SOLO adentro de un `useEffect` /
 * `useLayoutEffect` deja a esas actions fuera del manifest de Server Actions.
 *
 * Por qué: Next 14 (optimizeServerReact) borra los efectos del build de SSR, y el registro de las actions que importa
 * el cliente recorre el grafo de SSR. Si ningún otro import (estático, o un `import()` fuera de un efecto) llega al
 * módulo, el server contesta «Failed to find Server Action» en runtime. Lo encontró la E2E de WhatsApp: la fila de
 * consentimiento de «Editar paciente» decía «No pudimos leer el estado de WhatsApp…» y compartir una ficha nunca
 * ofrecía WhatsApp (`lib/whatsapp-patient-ui.ts`, importado solo desde efectos). `tsc` y los render tests no lo ven:
 * solo el build. Arreglo: el `import()` a nivel de módulo (`const load = () => import(...)`) y el efecto llama `load()`.
 */
const ROOT = resolve(__dirname, "../..");
const SCAN = ["components", "app", "lib"];
const EFFECTS = new Set(["useEffect", "useLayoutEffect"]);

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" || e.name.startsWith(".") ? [] : walk(p);
    return /\.(ts|tsx)$/.test(e.name) && !/\.d\.ts$/.test(e.name) ? [p] : [];
  });
}

function resolveSpec(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? join(ROOT, spec.slice(2)) : spec.startsWith(".") ? resolve(from, "..", spec) : null;
  if (!base) return null;
  for (const c of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) if (existsSync(c)) return c;
  return null;
}

const useServerCache = new Map<string, boolean>();
function isUseServer(file: string): boolean {
  let v = useServerCache.get(file);
  if (v === undefined) {
    v = /^\s*(\/\/[^\n]*\n\s*)*["']use server["']/.test(readFileSync(file, "utf8"));
    useServerCache.set(file, v);
  }
  return v;
}

function insideEffect(node: ts.Node): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isCallExpression(p)) {
      const c = p.expression;
      const name = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : null;
      if (name && EFFECTS.has(name)) return true;
    }
  }
  return false;
}

type Use = { file: string; line: number; target: string; inEffect: boolean };

function collect(): Use[] {
  const out: Use[] = [];
  for (const file of SCAN.flatMap((d) => walk(join(ROOT, d)))) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("use server") && !/import\s*\(/.test(text) && !/from\s+["']/.test(text)) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (n: ts.Node) => {
      let spec: string | null = null;
      let dynamic = false;
      if (ts.isImportDeclaration(n) && !n.importClause?.isTypeOnly && ts.isStringLiteral(n.moduleSpecifier)) spec = n.moduleSpecifier.text;
      else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) {
        spec = n.arguments[0].text;
        dynamic = true;
      }
      if (spec) {
        const target = resolveSpec(file, spec);
        if (target && target !== file && isUseServer(target)) {
          out.push({
            file: relative(ROOT, file),
            line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1,
            target: relative(ROOT, target),
            inEffect: dynamic && insideEffect(n),
          });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

describe("[WA-E] import() de Server Actions adentro de efectos", () => {
  const uses = collect();

  it("el escaneo encuentra los imports diferidos conocidos (anti-false-green)", () => {
    expect(uses.some((u) => u.target === "lib/whatsapp-patient-ui.ts")).toBe(true);
    expect(uses.some((u) => u.target === "lib/whatsapp-booking-actions.ts")).toBe(true);
  });

  it("ningún módulo \"use server\" llega al cliente SOLO por un import() dentro de useEffect/useLayoutEffect", () => {
    const byTarget = new Map<string, Use[]>();
    for (const u of uses) byTarget.set(u.target, [...(byTarget.get(u.target) ?? []), u]);
    const bad = [...byTarget.entries()]
      .filter(([, us]) => us.some((u) => u.inEffect) && us.every((u) => u.inEffect))
      .map(([t, us]) => `${t} ← ${us.map((u) => `${u.file}:${u.line}`).join(", ")}`);
    expect(bad).toEqual([]);
  });

  it("el detector marca un import() dentro de un efecto", () => {
    const src = 'useEffect(() => { import("@/lib/x").then(() => {}); }, []); const ok = () => import("@/lib/y");';
    const sf = ts.createSourceFile("t.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const found: boolean[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) found.push(insideEffect(n));
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(found).toEqual([true, false]);
  });
});
