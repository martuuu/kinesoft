/**
 * IAM-0a · match de email sin comodines (C-IAM4, hallazgo [A] «Email con ILIKE
 * sin escapar», plan §19.1). Lo de punta a punta contra Postgres (que el ILIKE
 * escapado matchea solo el literal, en cada superficie) vive en
 * tests/integration/email-match.test.ts; acá va la lógica pura y un guard
 * estático para que nadie vuelva a escribir el filtro pelado.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { emailEqualsFilter, escapeLike, normalizeEmail, sameEmail } from "@/lib/email-match";

/** Emula `ILIKE` de Postgres con `\` como escape (lo que hace la base con el filtro). */
function ilike(value: string, pattern: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) {
      re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (c === "%") re += "[\\s\\S]*";
    else if (c === "_") re += "[\\s\\S]";
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i").test(value);
}

describe("normalizeEmail", () => {
  it("recorta espacios y baja a minúsculas", () => {
    expect(normalizeEmail("  Juan.Perez@Mail.COM \n")).toBe("juan.perez@mail.com");
  });
});

describe("escapeLike", () => {
  it("escapa los tres metacaracteres de LIKE", () => {
    expect(escapeLike("juan_perez@x.com")).toBe("juan\\_perez@x.com");
    expect(escapeLike("a%b@x.com")).toBe("a\\%b@x.com");
    expect(escapeLike("a\\b@x.com")).toBe("a\\\\b@x.com");
    expect(escapeLike("a\\_b%@x.com")).toBe("a\\\\\\_b\\%@x.com");
  });
  it("deja intacto un email sin metacaracteres", () => {
    expect(escapeLike("ana@test.local")).toBe("ana@test.local");
  });
});

describe("emailEqualsFilter", () => {
  it("normaliza, escapa y pide mode insensitive", () => {
    expect(emailEqualsFilter("  JPere_@Hotmail.com ")).toEqual({
      equals: "jpere\\_@hotmail.com",
      mode: "insensitive",
    });
  });

  it("el bug: sin escapar, `_` y `%` matchean a otra persona", () => {
    // Lo que hacía el código viejo (valor pelado en el ILIKE).
    expect(ilike("jperez@hotmail.com", "jpere_@hotmail.com")).toBe(true);
    expect(ilike("ana.lopez@x.com", "%@x.com")).toBe(true);
  });

  it("escapado, solo matchea el literal (sin distinguir mayúsculas)", () => {
    const f = emailEqualsFilter("jpere_@hotmail.com").equals;
    expect(ilike("jperez@hotmail.com", f)).toBe(false);
    expect(ilike("jpere_@hotmail.com", f)).toBe(true);
    expect(ilike("JPERE_@HOTMAIL.COM", f)).toBe(true);

    const p = emailEqualsFilter("%@x.com").equals;
    expect(ilike("ana.lopez@x.com", p)).toBe(false);
    expect(ilike("%@x.com", p)).toBe(true);

    const b = emailEqualsFilter("a\\b@x.com").equals;
    expect(ilike("a\\b@x.com", b)).toBe(true);
    expect(ilike("ab@x.com", b)).toBe(false);
  });
});

describe("sameEmail", () => {
  it("compara exacto normalizado", () => {
    expect(sameEmail("Juan@Mail.com", " juan@mail.com ")).toBe(true);
    expect(sameEmail("jpere_@hotmail.com", "jperez@hotmail.com")).toBe(false);
    expect(sameEmail("%@x.com", "ana@x.com")).toBe(false);
  });
  it("null, undefined o vacío nunca matchean", () => {
    expect(sameEmail(null, null)).toBe(false);
    expect(sameEmail(undefined, "a@x.com")).toBe(false);
    expect(sameEmail("a@x.com", null)).toBe(false);
    expect(sameEmail("", "")).toBe(false);
    expect(sameEmail("  ", " ")).toBe(false);
  });
});

// ── Guard estático ────────────────────────────────────────────────────
// Un `email: { equals: <x>, mode: "insensitive" }` escrito a mano es el ILIKE con
// comodines: todo match de email va por `emailEqualsFilter`. (`contains` sobre
// email en los buscadores es una búsqueda, no una identidad: no entra acá.)

const ROOT = path.resolve(__dirname, "../..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "generated" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/** Filtros de igualdad insensible sobre un campo de email con el valor pelado. */
function bareEmailEquals(code: string): number {
  return [...code.matchAll(/\b\w*email\w*\s*:\s*\{\s*equals\s*:[^}]*mode\s*:\s*["']insensitive["']/gi)].length;
}

describe("guard · ningún email con ILIKE pelado", () => {
  it("canario del detector", () => {
    expect(bareEmailEquals(`where: { email: { equals: user.email, mode: "insensitive" } }`)).toBe(1);
    expect(bareEmailEquals(`where: { email: { equals: email.trim(), mode: 'insensitive' } }`)).toBe(1);
    expect(bareEmailEquals(`where: { email: emailEqualsFilter(user.email) }`)).toBe(0);
    expect(bareEmailEquals(`where: { name: { equals: name, mode: "insensitive" } }`)).toBe(0);
    expect(bareEmailEquals(`{ email: { contains: q, mode: "insensitive" } }`)).toBe(0);
  });

  it("lib/ y app/ no tienen `email: { equals, mode: insensitive }` a mano", () => {
    const offenders = [...sourceFiles(path.join(ROOT, "lib")), ...sourceFiles(path.join(ROOT, "app"))]
      .filter((f) => bareEmailEquals(stripComments(fs.readFileSync(f, "utf8"))) > 0)
      .map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });
});
