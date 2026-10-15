/**
 * BO2 (pedido de BO-Z, adelantado por el integrador de BO2) · guard estático del back-office de Plataforma.
 *
 * Por qué estático: todo `lib/platform-*` corre por el canal service (`prismaService`, BYPASSRLS) y cruza
 * consultorios. La ÚNICA barrera es `requirePlatformAdmin(…)` al principio de cada export (C-BO2). Un export nuevo
 * que se olvide la llamada queda expuesto a cualquier usuario logueado (los `"use server"` son endpoints RPC) y los
 * tests de integración solo cubren los exports que alguien se acordó de testear. Este test lee el código real.
 *
 * Reglas:
 *  1. Cada `export async function` de `lib/platform-*.ts` (salvo las excepciones de abajo) llama a
 *     `requirePlatformAdmin(` en su cuerpo, o delega en una función importada de un `*-internal` cuyo cuerpo la
 *     llama (p. ej. `createTenantWithOwner` → `provisionTenantWithOwner`).
 *  2. Ningún `lib/platform-*` hace `find*` sobre tablas clínicas/PHI ni las lee por SQL crudo. Plataforma ve
 *     consultorios, usuarios y salud; nunca pacientes, turnos ni historia clínica (decisión 3 de Martin: ni el
 *     soporte tiene acceso clínico). Los conteos (`count`, `groupBy` con `_count`) sí: no traen filas.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const LIB = join(ROOT, "lib");

/**
 * Archivos sin exports que requieran barrera, cada uno con su porqué:
 *  - platform-actor.ts: DEFINE `requirePlatformAdmin`.
 *  - *-types / *-schemas / *-logic / platform-audit-types: puros (tipos, zod, funciones sin I/O). Incluye
 *    `platform-health-logic.ts` (handoff BO2-C).
 */
const EXEMPT_FILES = new Set([
  "lib/platform-actor.ts",
  "lib/platform-audit-types.ts",
  "lib/platform-health-logic.ts",
  "lib/platform-provisioning-schemas.ts",
  "lib/platform-tenants-schemas.ts",
  "lib/platform-tenants-types.ts",
]);
const PURE_SUFFIX = /-(types|schemas|logic)\.ts$/;

/**
 * Exports puntuales sin `requirePlatformAdmin`, cada uno con su porqué:
 *  - listSupportSessionsForTenant: es del LADO CONSULTORIO (Configuración → Accesos de soporte). La barrera es
 *    `getActor()` (cualquier miembro activo del consultorio, PL-F1b) + `runWithRls` del consultorio activo
 *    (handoff BO2-E). El corte de soporte se prueba en tests/integration/support-session.test.ts (BO-Z C3).
 */
const EXEMPT_EXPORTS = new Map<string, string>([
  ["lib/platform-support.ts#listSupportSessionsForTenant", "await getActor()"],
]);

/** Modelos con PHI o datos del paciente (Prisma delegates en camelCase). */
const PHI_MODELS = [
  "patient",
  "patientShare",
  "patientFile",
  "patientTenantLink",
  "patientChangeRequest",
  "emergencyContact",
  "coverage",
  "clinicalCase",
  "diagnosis",
  "treatmentProgram",
  "programAuthorization",
  "session",
  "sessionExercise",
  "evaScore",
  "booking",
  "payment",
];
const PHI_TABLES = PHI_MODELS.map((m) => m[0].toUpperCase() + m.slice(1));

function platformFiles(): string[] {
  return readdirSync(LIB)
    .filter((f) => /^platform-.*\.ts$/.test(f))
    .map((f) => `lib/${f}`)
    .sort();
}

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

/** Cuerpo de cada `export async function` (hasta la primera `}` en columna 0: estilo del repo, prettier). */
function asyncExports(src: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const re = /^export\s+async\s+function\s+(\w+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const rest = src.slice(m.index);
    const end = rest.search(/\n\}\s*(\n|$)/);
    out.push({ name: m[1], body: end === -1 ? rest : rest.slice(0, end + 2) });
  }
  return out;
}

/** Nombre → módulo de los imports con nombre desde `@/lib/*-internal`. */
function internalImports(src: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /import\s*\{([^}]+)\}\s*from\s*["']@\/lib\/([\w-]+-internal)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    for (const part of m[1].split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).pop()!.trim();
      if (name) map.set(name, `lib/${m[2]}.ts`);
    }
  }
  return map;
}

function callsGuard(body: string): boolean {
  return /\brequirePlatformAdmin\s*\(/.test(body);
}

/** ¿El cuerpo delega en un núcleo `*-internal` que llama a `requirePlatformAdmin`? */
function delegatesToGuardedInternal(body: string, imports: Map<string, string>): boolean {
  for (const [name, mod] of imports) {
    if (!new RegExp(`\\b${name}\\s*\\(`).test(body)) continue;
    if (!existsSync(join(ROOT, mod))) continue;
    const target = asyncExports(read(mod)).find((e) => e.name === name);
    if (target && callsGuard(target.body)) return true;
  }
  return false;
}

describe("[BO2] guard estático de Plataforma (requirePlatformAdmin + sin PHI)", () => {
  const files = platformFiles();
  const guarded = files.filter((f) => !EXEMPT_FILES.has(f) && !PURE_SUFFIX.test(f));

  it("encuentra los archivos de Plataforma (el guard no pasa vacío)", () => {
    expect(guarded.length).toBeGreaterThanOrEqual(10);
    expect(guarded).toContain("lib/platform-users.ts");
    expect(guarded).toContain("lib/platform-support.ts");
    expect(guarded).toContain("lib/platform-health-read.ts");
  });

  it("los archivos exceptuados como puros no exportan funciones async (si alguno empieza, sale de la lista)", () => {
    for (const f of files.filter((x) => EXEMPT_FILES.has(x) && x !== "lib/platform-actor.ts")) {
      expect(asyncExports(read(f)).map((e) => e.name), `${f}: exporta async, ya no es puro`).toEqual([]);
    }
  });

  it("cada export async llama a requirePlatformAdmin (o delega en un *-internal que la llama)", () => {
    const missing: string[] = [];
    let checked = 0;
    for (const f of guarded) {
      const src = read(f);
      const imports = internalImports(src);
      for (const e of asyncExports(src)) {
        const key = `${f}#${e.name}`;
        const exempt = EXEMPT_EXPORTS.get(key);
        if (exempt) {
          // La excepción no es «sin barrera»: tiene que seguir teniendo la suya.
          expect(e.body, `${key}: perdió su barrera de consultorio`).toContain(exempt);
          continue;
        }
        checked++;
        if (!callsGuard(e.body) && !delegatesToGuardedInternal(e.body, imports)) missing.push(key);
      }
    }
    expect(missing, `exports de Plataforma sin requirePlatformAdmin:\n${missing.join("\n")}`).toEqual([]);
    expect(checked).toBeGreaterThanOrEqual(25);
  });

  it("las excepciones puntuales existen (una excepción vieja no queda tapando un export nuevo)", () => {
    for (const key of EXEMPT_EXPORTS.keys()) {
      const [f, name] = key.split("#");
      expect(asyncExports(read(f)).map((e) => e.name), key).toContain(name);
    }
  });

  it("ningún lib/platform-* lee filas de tablas clínicas (find* ni SQL crudo); los conteos sí", () => {
    const findRe = new RegExp(`\\.(${PHI_MODELS.join("|")})\\s*\\.\\s*find\\w*\\s*\\(`, "g");
    const sqlRe = new RegExp(`(FROM|JOIN)\\s+"(${PHI_TABLES.join("|")})"`, "gi");
    const relRe = new RegExp(`\\b(${PHI_MODELS.join("|")})s?\\s*:\\s*\\{\\s*(select|include)\\b`, "g");
    const hits: string[] = [];
    for (const f of files) {
      const src = read(f);
      for (const re of [findRe, sqlRe, relRe]) {
        for (const m of src.matchAll(re)) hits.push(`${f}:${src.slice(0, m.index).split("\n").length}: ${m[0]}`);
      }
    }
    expect(hits, `Plataforma leyendo PHI:\n${hits.join("\n")}`).toEqual([]);
  });

  it("el detector de PHI no es ciego (se prende con un caso armado)", () => {
    const findRe = new RegExp(`\\.(${PHI_MODELS.join("|")})\\s*\\.\\s*find\\w*\\s*\\(`);
    expect(findRe.test("await prismaService.patient.findMany({ where: { tenantId } })")).toBe(true);
    expect(findRe.test("await tx.booking\n  .findFirst({})")).toBe(true);
    expect(findRe.test("await prismaService.patient.count({ where: { userId } })")).toBe(false);
  });
});
