/**
 * [P4-S24a] Guard estático de identidad del portal (ratchet: nace verde y no se afloja).
 *
 * Hasta ES4 el portal autorizaba por coincidencia de email (AUDIT `portal-auth-por-email-no-userid`): una ficha con
 * el email de la cuenta pero sin vincular ya mostraba PHI. Desde S24a autoriza el vínculo por (tenantId, userId)
 * (`lib/portal-identity-internal.ts`). Este guard impide que vuelva un match de email a las superficies del portal:
 *
 *  - Ningún `lib/portal*.ts` usa los helpers de match de email ni un `email: { equals` a mano. Se mira el fuente
 *    entero (comentarios incluidos): es más barato que distinguir un comentario de un uso, y un comentario que nombra
 *    el helper invita a usarlo. Allowlist EXPLÍCITA:
 *      · `portal-link-internal.ts`: el ÚNICO lookup por email con fines de vínculo (PD-15: una sola ficha libre);
 *      · `portal-auth-internal.ts`: `resolvePortalLinkTarget`, solo decide a quién mandarle un magic link, no
 *        autoriza ni devuelve PHI (ES4-D3).
 *  - Ningún `lib/portal*.ts` busca una ficha con `findUnique` por `userId`: el único es por consultorio
 *    (`Patient_tenantId_userId_key`); la misma cuenta tiene una ficha en cada consultorio.
 *
 * Cubre por glob los archivos que agregan S24p/S24d/S24e/S24v (`portal-account*`, `portal-profile*`,
 * `portal-exercises*`, `portal-vincular.ts`): entran solos al crearse.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const LIB = join(ROOT, "lib");

const EMAIL_MATCH_RE = /emailEqualsFilter|email: \{ equals|sameEmail/;
const EMAIL_ALLOWLIST = new Set(["portal-link-internal.ts", "portal-auth-internal.ts"]);

/** Los que el brief nombra uno por uno (los que ya existen tienen que estar en el barrido). */
const NAMED = ["portal.ts", "portal-identity-internal.ts"];

function portalLibFiles(): string[] {
  return readdirSync(LIB)
    .filter((f) => /^portal.*\.ts$/.test(f))
    .sort();
}

/** Argumentos de cada llamada `findUnique(…)` / `findUniqueOrThrow(…)`, con paréntesis balanceados. */
function findUniqueArgs(src: string): string[] {
  const out: string[] = [];
  const re = /\bfindUnique(?:OrThrow)?\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < src.length && depth > 0) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
      i++;
    }
    out.push(src.slice(start, i - 1));
  }
  return out;
}

describe("[P4-S24a] guard de identidad del portal", () => {
  it("el barrido cubre los archivos nombrados en el contrato", () => {
    const files = portalLibFiles();
    for (const f of NAMED) {
      expect(existsSync(join(LIB, f)), `${f} tiene que existir`).toBe(true);
      expect(files).toContain(f);
    }
    // La allowlist no puede crecer en silencio: si se agrega un archivo, se cambia este test a propósito.
    expect([...EMAIL_ALLOWLIST].sort()).toEqual(["portal-auth-internal.ts", "portal-link-internal.ts"]);
  });

  it("0 matches de email en lib/portal*.ts fuera de la allowlist", () => {
    const offenders = portalLibFiles()
      .filter((f) => !EMAIL_ALLOWLIST.has(f))
      .flatMap((f) =>
        readFileSync(join(LIB, f), "utf8")
          .split("\n")
          .map((line, i) => ({ f, n: i + 1, line }))
          .filter(({ line }) => EMAIL_MATCH_RE.test(line))
          .map(({ f, n, line }) => `lib/${f}:${n}: ${line.trim()}`)
      );
    expect(offenders).toEqual([]);
  });

  it("0 findUnique con userId en lib/portal*.ts", () => {
    const offenders = portalLibFiles().flatMap((f) =>
      findUniqueArgs(readFileSync(join(LIB, f), "utf8"))
        .filter((args) => /\buserId\b/.test(args))
        .map((args) => `lib/${f}: findUnique(${args.replace(/\s+/g, " ").slice(0, 120)})`)
    );
    expect(offenders).toEqual([]);
  });

  it("el detector de findUnique agarra el patrón prohibido (control del propio guard)", () => {
    const bad = `await prisma.patient.findUnique({ where: { userId: me.id } });`;
    const ok = `await prisma.tenant.findUnique({ where: { slug }, select: { id: true } });`;
    expect(findUniqueArgs(bad).some((a) => /\buserId\b/.test(a))).toBe(true);
    expect(findUniqueArgs(ok).some((a) => /\buserId\b/.test(a))).toBe(false);
    expect(EMAIL_MATCH_RE.test(`where: { email: emailEqualsFilter(x) }`)).toBe(true);
    expect(EMAIL_MATCH_RE.test(`where: { email: { equals: x, mode: "insensitive" } }`)).toBe(true);
  });
});
