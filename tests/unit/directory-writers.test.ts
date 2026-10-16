/**
 * [DIR-2b] Guard de escritor único del directorio (C-DIR8) + validación pura del perfil público.
 *
 * Por qué el guard: las columnas que deciden si algo se publica tienen UN dueño cada una, porque cada dueño tiene su
 * barrera distinta y una escritura por otro lado la saltea:
 *   - `lib/directory-settings.ts`: `Tenant.directoryListed*` y `publicDescription` (tenant.admin, soporte NO).
 *   - `lib/public-profile.ts`: `ProfessionalPublicProfile.listed` / `consent*` (la persona, con su sesión: el
 *     consentimiento es suyo, Ley 25.326).
 *   - `lib/platform-directory.ts`: moderación (`Tenant.directoryHidden*`, `hidden*`, `licenseVerified*`) con
 *     `requirePlatformAdmin` y doble audit.
 * DIR-D24: `Tenant` tiene UPDATE policy de tenant, así que la base no impide que otra action escriba la moderación;
 * la barrera es este guard.
 *
 * Cómo detecta una escritura: en `lib/`, `app/` y `components/` busca cada `.tenant.` / `.professionalPublicProfile.`
 * `update|updateMany|upsert|create|createMany(`, toma el argumento balanceado y mira las claves de sus `data:` /
 * `create:` / `update:` (resolviendo `...ident` contra un `const ident = { … }` del mismo archivo), más el SQL a mano
 * (`UPDATE "Tenant" … SET …`, `INSERT INTO "ProfessionalPublicProfile"`). `where:`/`select:` no cuentan (los lectores
 * del snapshot filtran por `hiddenAt: null`). Los tests (fixtures) quedan afuera.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  checkConsent,
  parsePublicProfileFields,
  publicProfileStatus,
} from "@/lib/public-profile-logic";
import { DIRECTORY_CONSENT_TEXT, DIRECTORY_CONSENT_VERSION } from "@/lib/directory-constants";
import { BRAND_NAME } from "@/lib/brand";

const ROOT = join(__dirname, "..", "..");
const DIRS = ["lib", "app", "components"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** Saca comentarios (de bloque y de línea) para que el porqué de un módulo no cuente como escritura. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/(^|[^:"'`\\])\/\/.*$/, "$1"))
    .join("\n");
}

/** Texto balanceado desde `open` (índice de `(` o `{`) hasta su cierre, inclusive. */
function balanced(src: string, open: number): string {
  const o = src[open];
  const c = o === "(" ? ")" : o === "{" ? "}" : "]";
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === o) depth++;
    else if (src[i] === c) {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

type Model = "tenant" | "professionalPublicProfile";
const SQL_TABLE: Record<Model, string> = { tenant: "Tenant", professionalPublicProfile: "ProfessionalPublicProfile" };

/** Claves de nivel superior de un objeto literal (`{ a: 1, b, ...c }`), con los spreads resueltos en el archivo. */
function objectKeys(obj: string, file: string, seen = new Set<string>()): string[] {
  const inner = obj.slice(1, -1);
  const keys: string[] = [];
  let depth = 0;
  let token = "";
  const flush = () => {
    const t = token.trim();
    token = "";
    if (!t) return;
    const spread = t.match(/^\.\.\.\s*([A-Za-z_$][\w$]*)$/);
    if (spread) {
      const id = spread[1];
      if (seen.has(id)) return;
      seen.add(id);
      const decl = new RegExp(`(?:const|let)\\s+${id}\\s*(?::[^=]+)?=\\s*\\{`).exec(file);
      if (decl) keys.push(...objectKeys(balanced(file, decl.index + decl[0].length - 1), file, seen));
      return;
    }
    const k = t.match(/^["']?([A-Za-z_$][\w$]*)["']?\s*(?::|$)/);
    if (k) keys.push(k[1]);
  };
  for (const ch of inner) {
    if ("({[".includes(ch)) depth++;
    else if (")}]".includes(ch)) depth--;
    if (ch === "," && depth === 0) flush();
    else token += ch;
  }
  flush();
  return keys;
}

/** Campos que un archivo escribe en `model` (por Prisma o por SQL a mano). */
function writtenFields(file: string, model: Model): Set<string> {
  const out = new Set<string>();
  const call = new RegExp(`\\.${model}\\.(?:update|updateMany|upsert|create|createMany)\\s*\\(`, "g");
  for (let m = call.exec(file); m; m = call.exec(file)) {
    const arg = balanced(file, m.index + m[0].length - 1);
    const sub = /\b(data|create|update)\s*:\s*/g;
    for (let s = sub.exec(arg); s; s = sub.exec(arg)) {
      const at = s.index + s[0].length;
      if (arg[at] === "{") {
        for (const k of objectKeys(balanced(arg, at), file)) out.add(k);
      } else {
        // `data: ident` → el objeto del `const ident = { … }` del archivo.
        const id = arg.slice(at).match(/^([A-Za-z_$][\w$]*)/)?.[1];
        if (id) for (const k of objectKeys(`{...${id}}`, file)) out.add(k);
      }
    }
  }
  const table = SQL_TABLE[model];
  const sql = new RegExp(`(?:UPDATE\\s+"${table}"|INSERT\\s+INTO\\s+"${table}")([^\`]*)`, "gi");
  for (let m = sql.exec(file); m; m = sql.exec(file)) {
    for (const q of m[1].matchAll(/"([A-Za-z]\w*)"/g)) out.add(q[1]);
  }
  return out;
}

const FILES = DIRS.flatMap((d) => walk(join(ROOT, d))).map((abs) => ({
  rel: relative(ROOT, abs).split("\\").join("/"),
  code: stripComments(readFileSync(abs, "utf8")),
}));

const OWNERS: Array<{ owner: string; model: Model; fields: string[] }> = [
  { owner: "lib/directory-settings.ts", model: "tenant", fields: ["directoryListed", "directoryListedAt", "publicDescription"] },
  {
    owner: "lib/platform-directory.ts",
    model: "tenant",
    fields: ["directoryHiddenAt", "directoryHiddenReason", "directoryHiddenById"],
  },
  {
    owner: "lib/platform-directory.ts",
    model: "professionalPublicProfile",
    fields: ["hiddenAt", "hiddenReason", "hiddenById", "licenseVerifiedAt", "licenseVerifiedById"],
  },
  {
    owner: "lib/public-profile.ts",
    model: "professionalPublicProfile",
    fields: ["listed", "consentAt", "consentVersion", "consentWithdrawnAt"],
  },
];

describe("[DIR-2b] escritor único del directorio (C-DIR8)", () => {
  for (const { owner, model, fields } of OWNERS) {
    it(`solo ${owner} escribe ${model}.{${fields.join(", ")}}`, () => {
      const offenders: string[] = [];
      for (const f of FILES) {
        if (f.rel === owner) continue;
        const w = writtenFields(f.code, model);
        const bad = fields.filter((x) => w.has(x));
        if (bad.length) offenders.push(`${f.rel}: ${bad.join(", ")}`);
      }
      expect(offenders).toEqual([]);
    });
  }

  // Anti-false-green: si el detector dejara de ver escrituras, el guard de arriba pasaría siempre. Los dueños que ya
  // existen tienen que aparecer escribiendo lo suyo.
  it("el detector ve a los dueños escribiendo sus columnas", () => {
    for (const { owner, model, fields } of OWNERS) {
      if (!existsSync(join(ROOT, owner))) continue; // DIR-2c crea lib/platform-directory.ts en la misma ola
      const file = FILES.find((f) => f.rel === owner)!;
      const w = writtenFields(file.code, model);
      const seen = fields.filter((x) => w.has(x));
      expect(seen.length, `${owner} no aparece escribiendo ${model}`).toBeGreaterThan(0);
    }
    expect([...writtenFields(FILES.find((f) => f.rel === "lib/public-profile.ts")!.code, "professionalPublicProfile")]).toEqual(
      expect.arrayContaining(["listed", "consentAt", "consentVersion", "consentWithdrawnAt"])
    );
    expect([...writtenFields(FILES.find((f) => f.rel === "lib/directory-settings.ts")!.code, "tenant")]).toEqual(
      expect.arrayContaining(["directoryListed", "directoryListedAt", "publicDescription"])
    );
  });

  it("el detector caza un writer intruso (spread, data: ident y SQL a mano)", () => {
    const viaSpread = `const pub = { listed: true, consentAt: new Date() };\nawait db.professionalPublicProfile.update({ where: { id }, data: { ...pub } });`;
    expect([...writtenFields(viaSpread, "professionalPublicProfile")]).toEqual(expect.arrayContaining(["listed", "consentAt"]));
    const viaIdent = `const patch = { directoryHiddenAt: now };\nawait tx.tenant.updateMany({ where: { id }, data: patch });`;
    expect([...writtenFields(viaIdent, "tenant")]).toContain("directoryHiddenAt");
    const viaSql = 'await tx.$executeRaw`UPDATE "Tenant" SET "directoryListed" = true WHERE id = ${id}`;';
    expect([...writtenFields(viaSql, "tenant")]).toContain("directoryListed");
    // Un lector que FILTRA por moderación no es un escritor.
    const reader = `await db.professionalPublicProfile.findMany({ where: { hiddenAt: null, listed: true } });`;
    expect([...writtenFields(reader, "professionalPublicProfile")]).toEqual([]);
  });
});

describe("[DIR-2b] public-profile-logic", () => {
  const base = { publicName: "  Ana   Pérez ", honorific: "LIC", licenseKind: null, licenseNumber: null, bio: "" };

  it("normaliza: espacios colapsados, bio vacía = null, sin matrícula = todo null", () => {
    const r = parsePublicProfileFields(base);
    expect(r).toEqual({
      ok: true,
      data: { publicName: "Ana Pérez", honorific: "LIC", licenseKind: null, licenseNumber: null, licenseJurisdiction: null, bio: null },
    });
  });

  it("nunca un email como nombre (decisión 19)", () => {
    const r = parsePublicProfileFields({ ...base, publicName: "ana@consultorio.com" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fieldErrors.publicName).toContain("El nombre público no puede ser un email.");
  });

  it("nombre de 1 letra o de más de 120 → error", () => {
    expect(parsePublicProfileFields({ ...base, publicName: "A" }).ok).toBe(false);
    expect(parsePublicProfileFields({ ...base, publicName: "x".repeat(121) }).ok).toBe(false);
    expect(parsePublicProfileFields({ ...base, publicName: "x".repeat(120) }).ok).toBe(true);
  });

  it("honorífico fuera de la lista → error", () => {
    expect(parsePublicProfileFields({ ...base, honorific: "PROF" }).ok).toBe(false);
  });

  it("MN descarta la jurisdicción; MP la exige y debe ser una de las 24", () => {
    const mn = parsePublicProfileFields({ ...base, licenseKind: "MN", licenseNumber: "12345", licenseJurisdiction: "B" });
    expect(mn.ok && mn.data).toMatchObject({ licenseKind: "MN", licenseNumber: "12345", licenseJurisdiction: null });
    expect(parsePublicProfileFields({ ...base, licenseKind: "MP", licenseNumber: "12345" }).ok).toBe(false);
    expect(parsePublicProfileFields({ ...base, licenseKind: "MP", licenseNumber: "12345", licenseJurisdiction: "AR-B" }).ok).toBe(false);
    const mp = parsePublicProfileFields({ ...base, licenseKind: "MP", licenseNumber: "12.345/B", licenseJurisdiction: "b" });
    expect(mp.ok && mp.data).toMatchObject({ licenseKind: "MP", licenseNumber: "12.345/B", licenseJurisdiction: "B" });
  });

  it("matrícula: número sin tipo, tipo sin número o con caracteres raros → error", () => {
    expect(parsePublicProfileFields({ ...base, licenseNumber: "123" }).ok).toBe(false);
    expect(parsePublicProfileFields({ ...base, licenseKind: "MN" }).ok).toBe(false);
    expect(parsePublicProfileFields({ ...base, licenseKind: "MN", licenseNumber: "12<script>" }).ok).toBe(false);
    expect(parsePublicProfileFields({ ...base, licenseKind: "MN", licenseNumber: "1".repeat(21) }).ok).toBe(false);
  });

  it("presentación: ≤ 1000 code points (como char_length de Postgres)", () => {
    expect(parsePublicProfileFields({ ...base, bio: "a".repeat(1001) }).ok).toBe(false);
    // 1000 emojis = 2000 unidades UTF-16 pero 1000 caracteres para la base: se acepta.
    expect(parsePublicProfileFields({ ...base, bio: "😀".repeat(1000) }).ok).toBe(true);
  });

  it("consentimiento: casilla === true y versión vigente", () => {
    expect(checkConsent({ accepted: true, version: DIRECTORY_CONSENT_VERSION })).toEqual({
      ok: true,
      data: { version: DIRECTORY_CONSENT_VERSION },
    });
    expect(checkConsent({ accepted: "true", version: DIRECTORY_CONSENT_VERSION }).ok).toBe(false);
    expect(checkConsent({ accepted: false, version: DIRECTORY_CONSENT_VERSION }).ok).toBe(false);
    expect(checkConsent({ accepted: true, version: "2025-01-v0" }).ok).toBe(false);
  });

  it("texto del consentimiento v2026-10-v1 literal (DIR-D20)", () => {
    expect(DIRECTORY_CONSENT_VERSION).toBe("2026-10-v1");
    expect(DIRECTORY_CONSENT_TEXT).toBe(
      `Acepto que ${BRAND_NAME} publique en su directorio mi nombre público, mi matrícula, mis especialidades, las ` +
        "coberturas que acepto, los consultorios donde atiendo y la presentación que cargué. Puedo retirar este " +
        "consentimiento cuando quiera desde esta pantalla, y mi perfil deja de verse en ese momento."
    );
  });

  it("estado: hidden gana, published con consentimiento vigente, withdrawn, draft", () => {
    const d = new Date();
    expect(publicProfileStatus(null)).toBe("none");
    expect(publicProfileStatus({ listed: true, consentAt: d, consentWithdrawnAt: null, hiddenAt: d })).toBe("hidden");
    expect(publicProfileStatus({ listed: true, consentAt: d, consentWithdrawnAt: null, hiddenAt: null })).toBe("published");
    expect(publicProfileStatus({ listed: false, consentAt: d, consentWithdrawnAt: d, hiddenAt: null })).toBe("withdrawn");
    expect(publicProfileStatus({ listed: false, consentAt: null, consentWithdrawnAt: null, hiddenAt: null })).toBe("draft");
  });
});
