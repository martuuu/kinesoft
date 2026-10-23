/**
 * [INF-DEV] `npm run dev` seguro (brief §26.7): `scripts/dev-safe.mjs` resuelve el Supabase EFECTIVO que vería `next dev`
 * (process.env y después `.env.development.local` → `.env.local` → `.env.development` → `.env`, gana el primero) y se
 * niega a arrancar si es remoto o su ref es `PROD_SUPABASE_REF`, salvo `ALLOW_DEV_REMOTE_SUPABASE=1`.
 *
 * Se prueban las funciones reales del script con archivos `.env*` TEMPORALES (nunca los del repo, que pueden ser de
 * producción) y valores MARCADOS: ninguno puede aparecer en lo que el script devuelve o imprime.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decideDevStart,
  parseEnvFileKeys,
  resolveEffectiveSupabase,
  supabaseRefOf,
} from "../../scripts/dev-safe.mjs";

const PROD_REF = "prodmarcadoabcdefghij";
const PROD_URL = `https://${PROD_REF}.supabase.co`;
const OTHER_URL = "https://otroproyectomarcado.supabase.co";
const SECRET_KEY = "ANON-KEY-MARCADA-NO-DEBE-SALIR";

const dirs: string[] = [];
function tmpRepo(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "inf-dev-safe-"));
  dirs.push(d);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(d, name), body);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function noLeak(out: unknown) {
  const s = JSON.stringify(out);
  expect(s).not.toContain(PROD_REF);
  expect(s).not.toContain("otroproyectomarcado");
  expect(s).not.toContain(SECRET_KEY);
}

describe("[INF-DEV] decideDevStart (pura)", () => {
  it("[INF-DEV] Supabase remoto → bloquea, con el mensaje que manda a dev:local", () => {
    const d = decideDevStart({ supabaseUrl: OTHER_URL, prodRef: "", allowRemote: "" });
    expect(d.action).toBe("block");
    expect(d.reason).toBe("remote");
    expect(d.message).toContain("`npm run dev` apuntaría a un Supabase remoto (posible producción).");
    expect(d.message).toContain("npm run dev:local");
    expect(d.message).toContain("ALLOW_DEV_REMOTE_SUPABASE=1 npm run dev");
    noLeak(d);
  });

  it("[INF-DEV] ref de prod → bloquea con motivo prod-ref", () => {
    const d = decideDevStart({ supabaseUrl: PROD_URL, prodRef: PROD_REF, allowRemote: undefined });
    expect(d.action).toBe("block");
    expect(d.reason).toBe("prod-ref");
    noLeak(d);
  });

  it("[INF-DEV] localhost / 127.0.0.1 → arranca", () => {
    for (const u of ["http://localhost:54321", "http://127.0.0.1:54398", "http://[::1]:54321"]) {
      const d = decideDevStart({ supabaseUrl: u, prodRef: PROD_REF, allowRemote: "" });
      expect(d.action, u).toBe("start");
    }
  });

  it("[INF-DEV] sin URL de Supabase → arranca (no hay remoto al que apuntar)", () => {
    expect(decideDevStart({ supabaseUrl: undefined, prodRef: "", allowRemote: "" }).action).toBe("start");
  });

  it("[INF-DEV] URL inválida → bloquea (no se puede verificar)", () => {
    const d = decideDevStart({ supabaseUrl: "no es una url", prodRef: "", allowRemote: "" });
    expect(d.action).toBe("block");
    expect(d.message).not.toContain("no es una url");
  });

  it("[INF-DEV] ALLOW_DEV_REMOTE_SUPABASE=1 → arranca aunque sea prod; otro valor no alcanza", () => {
    expect(decideDevStart({ supabaseUrl: PROD_URL, prodRef: PROD_REF, allowRemote: "1" }).action).toBe("start");
    expect(decideDevStart({ supabaseUrl: PROD_URL, prodRef: PROD_REF, allowRemote: "true" }).action).toBe("block");
    noLeak(decideDevStart({ supabaseUrl: PROD_URL, prodRef: PROD_REF, allowRemote: "1" }));
  });

  it("[INF-DEV] supabaseRefOf saca el ref de *.supabase.co y nada de un host local", () => {
    expect(supabaseRefOf(PROD_URL)).toBe(PROD_REF);
    expect(supabaseRefOf("http://localhost:54321")).toBeNull();
  });
});

describe("[INF-DEV] resolveEffectiveSupabase (orden de carga de next dev)", () => {
  it("[INF-DEV] .env de prod sin la clave en .env.local → gana .env y bloquea", () => {
    const dir = tmpRepo({
      ".env": `NEXT_PUBLIC_SUPABASE_URL=${PROD_URL}\nNEXT_PUBLIC_SUPABASE_ANON_KEY=${SECRET_KEY}\nPROD_SUPABASE_REF=${PROD_REF}\n`,
      ".env.local": "DATABASE_URL=postgresql://localhost:5433/x\n",
    });
    const eff = resolveEffectiveSupabase({ cwd: dir, env: {} });
    expect(eff.urlSource).toBe(".env");
    const d = decideDevStart(eff);
    expect(d.action).toBe("block");
    expect(d.reason).toBe("prod-ref");
    expect(d.message).toContain(".env");
    noLeak(d);
  });

  it("[INF-DEV] .env.local local pisa al .env remoto → arranca", () => {
    const dir = tmpRepo({
      ".env": `NEXT_PUBLIC_SUPABASE_URL=${PROD_URL}\n`,
      ".env.local": 'NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:54321"\n',
    });
    const eff = resolveEffectiveSupabase({ cwd: dir, env: {} });
    expect(eff.urlSource).toBe(".env.local");
    expect(decideDevStart(eff).action).toBe("start");
  });

  it("[INF-DEV] .env.development.local va antes que .env.local", () => {
    const dir = tmpRepo({
      ".env.development.local": `NEXT_PUBLIC_SUPABASE_URL=${OTHER_URL}\n`,
      ".env.local": "NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321\n",
    });
    const eff = resolveEffectiveSupabase({ cwd: dir, env: {} });
    expect(eff.urlSource).toBe(".env.development.local");
    expect(decideDevStart(eff).action).toBe("block");
  });

  it("[INF-DEV] process.env manda sobre los archivos (Next no pisa lo ya exportado)", () => {
    const dir = tmpRepo({ ".env": `NEXT_PUBLIC_SUPABASE_URL=${PROD_URL}\n` });
    const eff = resolveEffectiveSupabase({
      cwd: dir,
      env: { NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321", PROD_SUPABASE_REF: PROD_REF },
    });
    expect(eff.urlSource).toBe("process.env");
    expect(decideDevStart(eff).action).toBe("start");
  });

  it("[INF-DEV] el ref de prod puede venir de otro archivo que la URL", () => {
    const dir = tmpRepo({
      ".env.local": `NEXT_PUBLIC_SUPABASE_URL=${PROD_URL}\n`,
      ".env": `PROD_SUPABASE_REF='${PROD_REF}'\n`,
    });
    expect(decideDevStart(resolveEffectiveSupabase({ cwd: dir, env: {} })).reason).toBe("prod-ref");
  });

  it("[INF-DEV] no carga nada al process.env del padre", () => {
    const dir = tmpRepo({ ".env": `NEXT_PUBLIC_SUPABASE_URL=${PROD_URL}\nOTRA=${SECRET_KEY}\n` });
    const env: Record<string, string> = {};
    resolveEffectiveSupabase({ cwd: dir, env });
    expect(env).toEqual({});
    expect(process.env.OTRA).toBeUndefined();
  });

  it("[INF-DEV] parseEnvFileKeys: export, comillas, comentarios y solo las claves pedidas", () => {
    const got = parseEnvFileKeys(
      `# comentario\nexport NEXT_PUBLIC_SUPABASE_URL="${PROD_URL}" # inline\nOTRA=${SECRET_KEY}\nPROD_SUPABASE_REF=${PROD_REF}\n`,
      ["NEXT_PUBLIC_SUPABASE_URL", "PROD_SUPABASE_REF"]
    );
    expect(got).toEqual({ NEXT_PUBLIC_SUPABASE_URL: PROD_URL, PROD_SUPABASE_REF: PROD_REF });
  });
});

describe("[INF-DEV] el script por texto", () => {
  const src = readFileSync(resolve(__dirname, "../../scripts/dev-safe.mjs"), "utf8");
  it("[INF-DEV] no usa dotenv ni loadEnvConfig (no carga el .env al proceso) y no loguea valores", () => {
    // Imports/llamadas reales (la cabecera nombra `dotenv` y `@next/env` justamente para decir que no se usan).
    expect(src).not.toMatch(/(from|import)\s*\(?\s*["'](dotenv|@next\/env)|require\(\s*["'](dotenv|@next\/env)|loadEnvConfig\s*\(/);
    expect(src).not.toMatch(/process\.env\[[^\]]+\]\s*=|Object\.assign\(\s*process\.env/);
    expect(src).not.toMatch(/console\.\w+\([^)]*(supabaseUrl|prodRef)/);
  });
  it("[INF-DEV] package.json: dev → dev-safe, dev:local = dev:mpfake, alias y scripts de Martin", () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf8"));
    const s = pkg.scripts;
    expect(s.dev).toBe("node scripts/dev-safe.mjs");
    expect(s["dev:local"]).toBe("dotenv -e .env.local -- node scripts/dev-mp-fake.mjs");
    expect(s["dev:mpfake"]).toBe("npm run dev:local --");
    expect(s["dev:wafake"]).toBe("npm run dev:local --");
    expect(s["db:prod:precheck"]).toBe("dotenv -e .env.prod.local -- tsx scripts/prod-precheck.ts");
    expect(s["qa:tenants"]).toBe("tsx scripts/qa-tenants.ts");
    expect(s["saas:reanchor"]).toBe("tsx scripts/saas-reanchor.ts");
  });
});
