/**
 * Guard de AUDIT §5.26 (enmienda IAM-2b, IAM-D1): crear o confirmar una cuenta salteando la verificación del
 * email (`email_confirm: true` en supabase-js, `emailConfirm: true` en el puerto de C-IAM3) solo se permite donde
 * otra cosa prueba la propiedad del email:
 *  - `lib/invite-activation-internal.ts`: activación con el token de una invitación vigente (el link llegó a
 *    ese email);
 *  - `scripts/create-tenant.ts`: alta asistida que corre Martin a mano;
 *  - `lib/identity/auth-admin.ts`: el puerto (traduce `emailConfirm` → `email_confirm`);
 *  - `scripts/diagnose-auth.ts`: verificación del contrato del fake contra Supabase real (lo corre Martin).
 * El H5 original (signup que auto-confirmaba cualquier email tipeado) no puede volver por otro archivo.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const ALLOWED = new Set([
  "lib/invite-activation-internal.ts",
  "lib/identity/auth-admin.ts",
  "scripts/create-tenant.ts",
  "scripts/diagnose-auth.ts",
]);
const PATTERN = /\b(email_confirm|emailConfirm)\s*:\s*true\b/;

/** Saca comentarios (bloque y de línea) para que una explicación del porqué no cuente como uso. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function walk(dir: string, out: string[]): void {
  for (const f of readdirSync(dir)) {
    if (f === "node_modules" || f.startsWith(".")) continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|cts|js|mjs)$/.test(f)) out.push(p);
  }
}

describe("[IAM-2b] AUDIT §5.26: email_confirm:true solo en los lugares permitidos", () => {
  it("ningún otro archivo de app/lib/components/scripts confirma un email por admin", () => {
    const files: string[] = [];
    for (const d of ["app", "lib", "components", "scripts"]) walk(join(ROOT, d), files);
    const offenders = files
      .map((f) => relative(ROOT, f).split("\\").join("/"))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => PATTERN.test(stripComments(readFileSync(join(ROOT, rel), "utf8"))));
    expect(offenders).toEqual([]);
  });

  it("la activación sí lo usa (si deja de hacerlo, este guard y la enmienda quedan viejos)", () => {
    const src = stripComments(readFileSync(join(ROOT, "lib/invite-activation-internal.ts"), "utf8"));
    expect(src).toMatch(PATTERN);
  });

  it("el detector no se deja engañar por comentarios ni deja pasar un uso real", () => {
    expect(PATTERN.test(stripComments("// createUser({ email_confirm: true })"))).toBe(false);
    expect(PATTERN.test(stripComments("/* emailConfirm: true */ const x = 1;"))).toBe(false);
    expect(PATTERN.test(stripComments('admin.createUser({ email: "a@b.c", email_confirm: true });'))).toBe(true);
    expect(PATTERN.test(stripComments('fetch("https://x.test"); port.createUser({ emailConfirm: true })'))).toBe(true);
  });
});
