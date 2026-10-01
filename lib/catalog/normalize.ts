/**
 * Normalización del catálogo global (B-pre B1.1). Lógica PURA: la usan el
 * import (`scripts/catalog-import.ts` vía `lib/catalog/import-core.ts`), las
 * lecturas del tenant (`lib/catalog.ts`: búsqueda y "vincular al catálogo") y
 * Plataforma. Si cambia el algoritmo, cambian las `matchKey` persistidas
 * (`Specialty/Practice/Payer.matchKey @unique`): hay que re-correr el import
 * en dry-run y revisar conflictos antes de tocar prod. Los tests de
 * `tests/unit/catalog-normalize.test.ts` fijan la salida exacta para que un
 * cambio accidental se vea.
 *
 * Por qué existe: cada consultorio tipea sus obras sociales a mano ("OSDE",
 * "O.S.D.E.", "Osde S.A.", "Obra Social de Empleados de Comercio" vs "OSECAC")
 * y las fuentes oficiales escriben el mismo nombre con o sin acentos, con
 * siglas punteadas y con la forma jurídica pegada. `matchKey` es la clave de
 * comparación: dos textos que refieren a la misma entidad deberían dar la
 * misma clave, sin juntar entidades distintas (eso lo frena el import como
 * conflicto, que es la red de seguridad).
 */

/**
 * Prefijos genéricos que se sacan del PRINCIPIO del nombre (sobre tokens ya
 * normalizados). Son la "clase" de entidad, no su identidad: la SSS registra
 * "Obra Social del Personal de X" y el consultorio tipea "Personal de X" u
 * "OS Personal de X". `connector` = solo se saca si lo sigue un conector
 * ("instituto de …"); "Instituto Universitario X" no se toca, porque ahí
 * "instituto" sí es parte del nombre.
 *
 * Fuera de la lista a propósito: "mutual", "prepaga", "sindicato", "plan",
 * "salud": en muchos nombres son la parte distintiva ("Mutual Médica",
 * "Salud Total") y sacarlos juntaría entidades distintas.
 */
const PREFIXES: { tokens: string[]; connector: boolean }[] = [
  { tokens: ["obra", "social"], connector: false }, // "Obra Social (de/del/…) X"
  { tokens: ["os"], connector: false }, // "O.S." / "OS" abreviado
  { tokens: ["instituto"], connector: true }, // "Instituto de/del X" (IOMA, IOSFA…)
  { tokens: ["asociacion", "civil"], connector: false },
  { tokens: ["asociacion", "mutual"], connector: false },
];

/**
 * Formas jurídicas que se sacan del FINAL. "OSDE S.A." y "OSDE" son la misma
 * prestadora; el padrón RNEMP la trae con razón social y el usuario no.
 */
const SUFFIXES: string[][] = [
  ["sociedad", "anonima"],
  ["asociacion", "civil"],
  ["sa"],
  ["sau"],
  ["sas"],
  ["srl"],
  ["ltda"],
  ["limitada"],
];

/**
 * Formas jurídicas deletreadas ("S.A." → tokens "s a"). Se sacan ANTES de unir
 * siglas: si no, "O.S.D.E. S.A." daría "osdesa" (todas letras sueltas) en vez
 * de "osde".
 */
const SPELLED_SUFFIXES: string[][] = [
  ["s", "a", "u"],
  ["s", "a", "s"],
  ["s", "r", "l"],
  ["s", "a"],
];

function stripSpelledSuffix(tokens: string[]): string[] {
  for (const s of SPELLED_SUFFIXES) {
    if (tokens.length > s.length && endsWith(tokens, s)) return tokens.slice(0, tokens.length - s.length);
  }
  return tokens;
}

/** Conectores que se sacan SOLO detrás de un prefijo genérico ya quitado. */
const CONNECTORS = new Set(["de", "del", "la", "el", "los", "las", "para"]);

function startsWith(tokens: string[], seq: string[]): boolean {
  return seq.length <= tokens.length && seq.every((t, i) => tokens[i] === t);
}

function endsWith(tokens: string[], seq: string[]): boolean {
  const off = tokens.length - seq.length;
  return off >= 0 && seq.every((t, i) => tokens[off + i] === t);
}

/**
 * Une corridas de 2+ tokens de UNA letra: "o s d e" → "osde", "s a" → "sa".
 * Así "O.S.D.E.", "O. S. D. E." y "OSDE" dan lo mismo sin tener que decidir
 * si el punto es separador o no. Costo aceptado: "A y B" → "ayb" (raro en
 * nombres de prestadoras/prácticas).
 */
function joinAcronyms(tokens: string[]): string[] {
  const out: string[] = [];
  let run = "";
  let runLen = 0;
  const flush = () => {
    if (runLen === 0) return;
    out.push(run);
    run = "";
    runLen = 0;
  };
  for (const t of tokens) {
    if (/^[a-z]$/.test(t)) {
      run += t;
      runLen += 1;
    } else {
      flush();
      out.push(t);
    }
  }
  flush();
  return out;
}

function stripGeneric(tokens: string[]): string[] {
  let cur = tokens;
  // Iterativo: "Instituto de Obra Social de las Fuerzas Armadas" saca los dos.
  for (let changed = true; changed; ) {
    changed = false;
    for (const p of PREFIXES) {
      if (!startsWith(cur, p.tokens)) continue;
      let next = cur.slice(p.tokens.length);
      if (p.connector && !(next.length > 0 && CONNECTORS.has(next[0]))) continue;
      while (next.length > 0 && CONNECTORS.has(next[0])) next = next.slice(1);
      // Nunca dejar la clave vacía: "Obra Social" a secas queda como está.
      if (next.length === 0) continue;
      cur = next;
      changed = true;
      break;
    }
    for (const s of SUFFIXES) {
      if (!endsWith(cur, s) || cur.length === s.length) continue;
      cur = cur.slice(0, cur.length - s.length);
      changed = true;
      break;
    }
  }
  return cur;
}

/**
 * Clave de comparación de un nombre o alias del catálogo:
 *   1. minúsculas y sin acentos/diacríticos (NFD; "ñ" → "n");
 *   2. punto entre dígitos se borra ("25.01.01" → "250101", así el código del
 *      nomenclador escrito con puntos matchea el código pelado); apóstrofos
 *      se borran ("D'Amico" → "damico");
 *   3. toda otra puntuación/símbolo → espacio; espacios colapsados;
 *   4. forma jurídica deletreada al final ("s a", "s r l") se saca; después
 *      las siglas de letras sueltas se unen ("o s d e" → "osde");
 *   5. sin prefijos genéricos (PREFIXES) ni formas jurídicas (SUFFIXES).
 * Devuelve "" si no queda nada (el import lo trata como fila inválida).
 */
export function matchKey(value: string): string {
  const base = String(value ?? "")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/(\d)\.(?=\d)/g, "$1")
    .replace(/['’`´]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!base) return "";
  return stripGeneric(joinAcronyms(stripSpelledSuffix(base.split(" ")))).join(" ");
}

/** Separador de alias en los CSV del catálogo (contrato B1.1/B1.2). */
export const ALIAS_SEPARATOR = "|";

/**
 * Lista de alias de una celda `a|b|c`: trim, sin vacíos y sin repetidos por
 * `matchKey` (se conserva la primera escritura). `exclude` = claves que no
 * suman (p. ej. la `matchKey` del propio nombre).
 */
export function splitAliases(cell: string | null | undefined, exclude: Iterable<string> = []): string[] {
  const seen = new Set(exclude);
  const out: string[] = [];
  for (const raw of String(cell ?? "").split(ALIAS_SEPARATOR)) {
    const alias = raw.trim().replace(/\s+/g, " ");
    const key = matchKey(alias);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(alias);
  }
  return out;
}

/** Slug del catálogo: kebab-case ASCII (lo produce B1.2; Plataforma lo respeta). */
export const CATALOG_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const CATALOG_SLUG_MAX = 120;

export function isCatalogSlug(slug: string): boolean {
  return slug.length <= CATALOG_SLUG_MAX && CATALOG_SLUG_RE.test(slug);
}
