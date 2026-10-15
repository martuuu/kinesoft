/**
 * [EV2-1a] Guard estático de evoluciones (ratchet: nace verde y no se afloja).
 *
 *  - EV2-D5 (nunca en el portal), EV2-D6 (sin ⌘K) y Plataforma nunca baja PHI: ninguna de esas superficies menciona
 *    `clinicalNote` / `ClinicalNote` / `clinical-notes`. Se mira el fuente entero (comentarios incluidos): un import
 *    comentado «para después» ya es el primer paso de la fuga.
 *  - Las actions (`lib/clinical-notes.ts`, `-read.ts`) son `"use server"` y exportan solo `async function` (AGENTS §4:
 *    un `"use server"` que exporta una constante rompe el build de Next, y un tipo exportado ahí invita a importar el
 *    archivo de actions desde la UI para tipar).
 *  - `lib/clinical-notes-internal.ts` importa `server-only` (el gate y el select no pueden llegar al bundle).
 *  - Nadie escribe `revision:` en el `data:` de un write de `clinicalNote`: la sube el trigger `ClinicalNote_guard`
 *    (M9) al copiar la versión anterior a ClinicalNoteRevision. Si la app la escribiera, se desincroniza del historial.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "..");

function walk(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(name)) acc.push(p);
  }
  return acc;
}

function libFiles(re: RegExp): string[] {
  return readdirSync(join(ROOT, "lib"))
    .filter((f) => re.test(f))
    .map((f) => join(ROOT, "lib", f));
}

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

/** Superficies que nunca tocan evoluciones (EV2-D5, EV2-D6, Plataforma). `app/api/public` si algún día existe. */
function forbiddenSurfaces(): string[] {
  const files = [
    ...libFiles(/^portal.*\.ts$/),
    ...walk(join(ROOT, "app", "(portal)")),
    ...walk(join(ROOT, "components", "portal")),
    ...libFiles(/^search.*\.ts$/),
    join(ROOT, "components", "global", "command-palette.tsx"),
    ...libFiles(/^public-.*\.ts$/),
    ...walk(join(ROOT, "app", "api", "public")),
    ...libFiles(/^platform-.*\.ts$/),
    // EV2-Z a5: más superficies sin HC. Plataforma (UI), turnero público, realtime (el payload viaja a otros
    // clientes), notificaciones y mails (salen del sistema), CSV y exports de agenda/pacientes (el único export con
    // HC es el del Titular, `tenant-export-*`, AUDIT §5 «preservar»: portabilidad) y la sala (PD-13: sin texto clínico;
    // puede importar el toast de «Atendido» de Recepción, que no menciona notas en su ruta).
    ...walk(join(ROOT, "app", "(platform)")),
    ...walk(join(ROOT, "app", "(booking)")),
    ...walk(join(ROOT, "app", "api", "realtime")),
    ...libFiles(/^realtime-.*\.ts$/),
    ...libFiles(/^notifications.*\.ts$/),
    ...walk(join(ROOT, "lib", "email")),
    join(ROOT, "lib", "csv.ts"),
    join(ROOT, "lib", "bookings-export-internal.ts"),
    join(ROOT, "lib", "patients-export-internal.ts"),
    ...libFiles(/^sala-.*\.ts$/),
    ...walk(join(ROOT, "components", "sala")),
  ];
  return files.filter((f) => existsSync(f)).map((f) => relative(ROOT, f)).sort();
}

const MENTION = /clinicalNote|ClinicalNote|clinical-notes/;

/** Texto entre el delimitador de apertura en `open` y su cierre balanceado (sin parsear strings: alcanza acá). */
function balanced(src: string, open: number): string {
  const o = src[open];
  const c = o === "(" ? ")" : o === "{" ? "}" : "]";
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === o) depth++;
    else if (src[i] === c && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

/** Los `data:` / `create:` / `update:` de cada write sobre `clinicalNote` que escriben `revision:`. */
function revisionWrites(src: string): string[] {
  const out: string[] = [];
  const call = /\bclinicalNote\s*\.\s*(create|createMany|update|updateMany|upsert)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = call.exec(src))) {
    const args = balanced(src, m.index + m[0].length - 1);
    const data = /\b(data|create|update)\s*:\s*\{/g;
    let d: RegExpExecArray | null;
    while ((d = data.exec(args))) {
      const obj = balanced(args, d.index + d[0].length - 1);
      if (/\brevision\s*:/.test(obj)) out.push(`${m[1]} → ${d[1]}: ${obj.replace(/\s+/g, " ").slice(0, 120)}`);
    }
  }
  return out;
}

describe("[EV2-1a] guard estático de evoluciones", () => {
  it("encuentra las superficies vigiladas (el guard no pasa vacío)", () => {
    const files = forbiddenSurfaces();
    expect(files).toContain("lib/portal.ts");
    expect(files).toContain("lib/search.ts");
    expect(files).toContain("components/global/command-palette.tsx");
    expect(files).toContain("lib/public-booking.ts");
    expect(files).toContain("lib/platform-users.ts");
    expect(files.some((f) => f.startsWith("app/(portal)/"))).toBe(true);
    expect(files.some((f) => f.startsWith("components/portal/"))).toBe(true);
    // EV2-Z a5
    for (const prefix of ["app/(platform)/", "app/(booking)/", "app/api/realtime/", "lib/realtime-", "lib/notifications", "lib/email/", "lib/sala-", "components/sala/"]) {
      expect(files.some((f) => f.startsWith(prefix)), prefix).toBe(true);
    }
    expect(files).toContain("lib/csv.ts");
    expect(files).toContain("lib/bookings-export-internal.ts");
    expect(files).toContain("lib/patients-export-internal.ts");
  });

  it("portal, ⌘K, superficies públicas y Plataforma no mencionan evoluciones (EV2-D5, EV2-D6)", () => {
    const offenders = forbiddenSurfaces().flatMap((rel) =>
      read(rel)
        .split("\n")
        .flatMap((l, i) => (MENTION.test(l) ? [`${rel}:${i + 1}: ${l.trim()}`] : []))
    );
    expect(offenders).toEqual([]);
  });

  it.each(["lib/clinical-notes.ts", "lib/clinical-notes-read.ts"])(
    "%s empieza con \"use server\" y exporta solo async function",
    (rel) => {
      const src = read(rel);
      expect(src.trimStart().startsWith('"use server";')).toBe(true);
      const exports = src.split("\n").filter((l) => /^\s*export\b/.test(l));
      expect(exports.length).toBeGreaterThan(0);
      expect(exports.filter((l) => !/^export async function \w+\s*\(/.test(l))).toEqual([]);
    }
  );

  it("lib/clinical-notes-internal.ts importa server-only", () => {
    expect(read("lib/clinical-notes-internal.ts")).toMatch(/^import "server-only";/m);
  });

  it("el detector de `revision:` en un write funciona (anti falso verde)", () => {
    const bad = `await tx.clinicalNote.updateMany({ where: { id, revision: 2 }, data: { body, revision: 3 } });`;
    const okWhere = `await tx.clinicalNote.updateMany({ where: { id, tenantId, revision: expectedRevision }, data: { body } });`;
    const badUpsert = `tx.clinicalNote.upsert({ where: { id }, create: { body, revision: 1 }, update: { body } })`;
    expect(revisionWrites(bad)).toHaveLength(1);
    expect(revisionWrites(okWhere)).toEqual([]);
    expect(revisionWrites(badUpsert)).toHaveLength(1);
  });

  it("nadie escribe `revision:` en el data de clinicalNote (la sube el trigger de M9)", () => {
    const files = [...walk(join(ROOT, "lib")), ...walk(join(ROOT, "app")), ...walk(join(ROOT, "components"))];
    const offenders = files.flatMap((f) => revisionWrites(readFileSync(f, "utf8")).map((o) => `${relative(ROOT, f)}: ${o}`));
    expect(offenders).toEqual([]);
  });
});
