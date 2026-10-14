/**
 * Match de email exacto sin distinguir mayúsculas (IAM-0a, contrato C-IAM4).
 *
 * Hallazgo [A] del 14-oct (plan §19.1, «Email con ILIKE sin escapar»): Prisma
 * compila `{ email: { equals: x, mode: "insensitive" } }` a `"email" ILIKE $1`
 * con el valor TAL CUAL, así que `_` (un carácter cualquiera) y `%` (cualquier
 * tira) son comodines. Una identidad verificada `jpere_@hotmail.com` matcheaba
 * la ficha de `jperez@hotmail.com`: el portal le mostraba fichas, turnos y planes
 * ajenos, el callback de OAuth le vinculaba `Patient.userId` ajeno (toma de
 * ficha), el turnero le precargaba DNI/cobertura de otra persona y el alta le
 * ofrecía (y rotaba) invitaciones ajenas. Mismo bug que Traze cerró en S3.15
 * (`tests/security/auth-email-lookup.test.ts`).
 *
 * Regla: toda comparación de email contra la base pasa por `emailEqualsFilter`
 * (escapa los metacaracteres de LIKE; en ILIKE `\` es el escape por defecto) y,
 * donde el resultado autoriza o vincula algo, además por `sameEmail` como
 * post-filtro exacto (defensa en profundidad: si una versión de Prisma cambiara
 * la compilación del filtro, el post-filtro sigue cortando).
 *
 * Puro: sin imports, se usa desde server components, actions y tests.
 */

/** trim + minúsculas: la forma canónica para comparar (GoTrue guarda en minúsculas). */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Escapa los tres metacaracteres de LIKE/ILIKE: `\` primero (si no, se
 * duplicarían los escapes que agregan `%` y `_`), después `%` y `_`.
 */
export function escapeLike(raw: string): string {
  return raw.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Filtro Prisma de igualdad sin mayúsculas que NO interpreta comodines. El valor
 * se normaliza (trim + minúsculas) y se escapa: `ILIKE 'juan\_perez@x.com'`
 * matchea solo `juan_perez@x.com` (en cualquier combinación de mayúsculas).
 */
export function emailEqualsFilter(raw: string): { equals: string; mode: "insensitive" } {
  return { equals: escapeLike(normalizeEmail(raw)), mode: "insensitive" };
}

/** Post-filtro exacto normalizado. `null`/`undefined`/vacío nunca matchea (ni contra otro vacío). */
export function sameEmail(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return false;
  const na = normalizeEmail(a);
  return na !== "" && na === normalizeEmail(b);
}
