/**
 * DIR-0 (decisión 19 de Martin, 15-oct-2026): el email NO se muestra nunca como nombre de un profesional o usuario.
 *
 * El bug: `fullName ?? email` (y `name || user.email`) en ~20 lugares. Con un perfil sin nombre, el turnero
 * público, el estado de reserva y el portal mostraban el email del profesional a cualquier visitante, y la app lo
 * usaba como nombre en agenda, sala, planes, historial y saludo. Ahora todo pasa por `lib/display-name.ts`.
 *
 * Este guard recorre `lib/`, `components/` y `app/` y falla ante un fallback de un nombre a un email:
 *   - `<algo>Name|fullName|name … ?? … email`   (incluye `?? user.email`, `?? p.user.email`, `?? email`)
 *   - `<algo>Name|fullName|name … || … email`
 * Donde el email es EL dato mostrado (columna «Email», «te mandamos un mail a …») no hay fallback desde un
 * nombre, así que no matchea. Un caso legítimo que sí matchee va a `ALLOWLIST` con su porqué.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  publicPractitionerName,
  displayMemberName,
  displayUserName,
  greetingFirstName,
} from "@/lib/display-name";

const ROOT = join(__dirname, "..", "..");
const DIRS = ["lib", "components", "app"];

/**
 * Un identificador de nombre, después hasta 80 caracteres sin `;` (cubre el `??` en la línea siguiente), el
 * operador de fallback, y un acceso que termina en `email` (no `emailVerified`, no `sameEmail(`).
 */
const EMAIL_AS_NAME =
  /\b\w*(?:fullName|[nN]ame)\b[^;]{0,80}?(?:\?\?|\|\|)\s*\(?\s*(?:[\w$]+\??\.)*(?:email|Email)\b(?!\s*\()/g;

/**
 * Casos que matchean y son correctos. Formato `ruta:fragmento exacto` + porqué. Hoy vacío: si algo entra acá,
 * que sea porque el email ES el dato que se muestra, nunca un nombre.
 */
const ALLOWLIST: { file: string; snippet: string; why: string }[] = [];

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** Saca comentarios (`//` y `/* *\/`) para no matchear prosa que explique el bug. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function offenders(rel: string, src: string): string[] {
  const out: string[] = [];
  const code = stripComments(src);
  for (const m of code.matchAll(EMAIL_AS_NAME)) {
    const snippet = m[0].replace(/\s+/g, " ").trim();
    if (ALLOWLIST.some((a) => a.file === rel && snippet.includes(a.snippet))) continue;
    const line = code.slice(0, m.index).split("\n").length;
    out.push(`${rel}:${line}  ${snippet}`);
  }
  return out;
}

describe("[DIR-0] el email nunca como nombre", () => {
  it("helpers: nombre recortado o el texto de reemplazo; nunca el email", () => {
    expect(publicPractitionerName(null)).toBe("Profesional");
    expect(publicPractitionerName(undefined)).toBe("Profesional");
    expect(publicPractitionerName("   ")).toBe("Profesional");
    expect(publicPractitionerName("  Ana Gómez ")).toBe("Ana Gómez");
    expect(displayMemberName(null)).toBe("Profesional sin nombre");
    expect(displayMemberName(" Ana ")).toBe("Ana");
    expect(displayUserName("")).toBe("Usuario sin nombre");
    expect(displayUserName("Beto")).toBe("Beto");
    expect(greetingFirstName("Ana Gómez")).toBe("Ana");
    expect(greetingFirstName("Usuario sin nombre")).toBe("");
    expect(greetingFirstName("Profesional sin nombre")).toBe("");
    expect(greetingFirstName(null)).toBe("");
  });

  it("el patrón del guard detecta las formas del bug (anti-false-green)", () => {
    const bad = [
      "name: p.user.fullName ?? p.user.email,",
      "const who = member.fullName ?? member.email;",
      "{r.fullName || r.email}",
      "return m.fullName?.trim() || m.email;",
      "practitionerName: s.profile.fullName ?? s.profile.email,",
      "const n = name ?? email;",
      "displayName: u.fullName ??\n      u.email,",
      "name: p.user.fullName || p.user.email })",
      "x = user?.fullName ?? user?.email",
    ];
    for (const b of bad) expect(offenders("x.ts", b), b).toHaveLength(1);
    const ok = [
      "if (!inv || !sameEmail(inv.email, user.email)) return",
      "`Se borra la cuenta de ${action.email ?? \"este usuario\"}`",
      "<div>{member.email}</div>",
      "name: displayMemberName(p.user.fullName),",
      "// antes: fullName ?? email",
      "fullName: metaName ?? existing?.fullName ?? `${invite.firstName} ${invite.lastName}`,",
    ];
    for (const g of ok) expect(offenders("x.ts", g), g).toEqual([]);
  });

  it("lib/, components/ y app/ no tienen fallbacks de nombre a email", () => {
    const files = DIRS.flatMap((d) => walk(join(ROOT, d), []));
    expect(files.length).toBeGreaterThan(100);
    const found = files.flatMap((f) => offenders(relative(ROOT, f), readFileSync(f, "utf8")));
    expect(found).toEqual([]);
  });

  it("la allowlist no tiene entradas muertas", () => {
    for (const a of ALLOWLIST) {
      const src = stripComments(readFileSync(join(ROOT, a.file), "utf8"));
      expect(src, `${a.file}: ${a.why}`).toContain(a.snippet);
    }
  });
});
