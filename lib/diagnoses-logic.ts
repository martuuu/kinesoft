/**
 * Diagnósticos de la ficha: lógica PURA (C-FC2, §24.4). Cliente y server, sin Prisma ni I/O.
 *
 * FC-1b3 implementa lo que T4c necesita ya para compilar y testear contra algo real:
 *  - `activeDiagnosisTitle`: lo usa FC-2a al escribir `Patient.diagnosisTitle` con `setActiveDiagnosis`.
 *  - `isLateEntry`: lo usa FC-2b para el chip «Carga tardía» y FC-2e para la marca del PDF.
 * FC-2c implementa la búsqueda (`normalizeDiagnosisText`, `parseDiagnosisQuery`, `rankDiagnosisMatch`,
 * `dedupeRecents`): las usan las actions de `lib/diagnoses.ts` y el selector del cliente.
 *
 * `lib/diagnoses-import-core.ts` también es puro (sin DB ni fs): importarlo acá no arrastra I/O al cliente.
 */
import { normalizeIcdSearchText } from "@/lib/diagnoses-import-core";
import { ACTIVE_DIAGNOSIS_TITLE_MAX, DIAGNOSIS_RECENTS_MAX, type DiagnosisSnapshot } from "@/lib/diagnoses-types";

const ELLIPSIS = "…";

/**
 * «{código} {título}» para `Patient.diagnosisTitle`, ≤ `ACTIVE_DIAGNOSIS_TITLE_MAX` (80) contando la «…».
 *
 * Por qué se corta en límite de palabra: el título aparece en el hero del paciente y en el chip del turno de la agenda
 * (`lib/bookings.ts` lo usa de fallback); «Lumbalgia mecánica con irradi…» se lee como error, «Lumbalgia mecánica con…»
 * no. Si no hay un espacio razonable (una sola palabra larguísima, o el espacio queda en la primera mitad), se corta
 * duro: perder la mitad del texto por respetar una palabra es peor.
 * Los espacios repetidos o saltos de línea del título (texto libre, Condition vieja) se colapsan antes de medir.
 */
export function activeDiagnosisTitle(s: Pick<DiagnosisSnapshot, "code" | "title">): string {
  const code = s.code?.replace(/\s+/g, " ").trim() || null;
  const title = s.title.replace(/\s+/g, " ").trim();
  const full = code ? (title ? `${code} ${title}` : code) : title;
  const max = ACTIVE_DIAGNOSIS_TITLE_MAX;
  // Array.from: se cuenta por code point, así un emoji o un carácter fuera del BMP no queda partido al medio.
  const chars = Array.from(full);
  if (chars.length <= max) return full;
  const head = chars.slice(0, max - 1).join("");
  const lastSpace = head.lastIndexOf(" ");
  const cut = lastSpace >= Math.floor(head.length / 2) ? head.slice(0, lastSpace) : head;
  return `${cut.replace(/[\s,;:.\-–—·]+$/u, "")}${ELLIPSIS}`;
}

/** 24 h: una ficha escrita al día siguiente del turno o más tarde es «carga tardía» (Ley 26.529, registro en el acto). */
export const LATE_ENTRY_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/**
 * ¿La ficha va marcada «Carga tardía»? Sí si es importada (Word: el texto es de otra época por definición) o si se
 * creó más de 24 h después de la fecha de atención (`createdAt − occurredAt > 24 h`, estricto).
 *
 * Es aritmética de instantes, sin días calendario: no depende del timezone del host (Vercel corre en UTC) y por eso
 * no pasa por `lib/datetime-ar.ts`. Una fecha inválida no marca nada (mejor sin chip que un chip falso en una HC).
 */
export function isLateEntry(p: {
  importSource: unknown;
  createdAt: Date | string;
  occurredAt: Date | string;
}): boolean {
  if (p.importSource !== null && p.importSource !== undefined) return true;
  const created = new Date(p.createdAt).getTime();
  const occurred = new Date(p.occurredAt).getTime();
  if (!Number.isFinite(created) || !Number.isFinite(occurred)) return false;
  return created - occurred > LATE_ENTRY_THRESHOLD_MS;
}

// ─── Búsqueda (FC-2c) ────────────────────────────────────────────────────────────────────────────────────────────────

export type ParsedDiagnosisQuery = { text: string; codePrefix: string | null };

/**
 * NFD, sin tildes, minúsculas, `[^a-z0-9]` → espacio (colapsado), trim.
 *
 * Por qué REUSA `normalizeIcdSearchText` (FC-1d) en vez de copiar la regla: el `searchText` de `DiagnosisCode` lo
 * escribe el importador con esa función, y la consulta del buscador tiene que normalizarse IGUAL o «cuadriceps» no
 * encuentra «cuádriceps» (una copia que diverge en un carácter rompe la búsqueda sin que falle ningún test del
 * importador). Con código vacío la función da exactamente la normalización del texto (el espacio inicial se recorta).
 */
export function normalizeDiagnosisText(s: string): string {
  return normalizeIcdSearchText("", s);
}

/**
 * Forma de un código (CIE-11 o el código libre de un propio, p. ej. «M54.5» de CIE-10): sin espacios, 2..4 caracteres
 * alfanuméricos con al menos una letra Y un dígito, y opcionalmente «.» + hasta 3. Exigir letra y dígito es lo que
 * separa «ME84» / «fa20» de «lumbalgia» o «dolor» (que nunca tienen dígitos) y de «12» (un número suelto).
 */
const CODE_LIKE_RE = /^(?=[0-9A-Z.]*[0-9])(?=[0-9A-Z.]*[A-Z])[0-9A-Z]{2,4}(\.[0-9A-Z]{0,3})?$/;

/** < 2 caracteres (normalizados) → null; si parece un código, `codePrefix` en mayúsculas (como lo guarda la OMS). */
export function parseDiagnosisQuery(q: string): ParsedDiagnosisQuery | null {
  const text = normalizeDiagnosisText(q);
  if (text.length < 2) return null;
  const raw = q.trim().toUpperCase();
  return { text, codePrefix: CODE_LIKE_RE.test(raw) ? raw : null };
}

/**
 * Código exacto 0 > prefijo de código 1 > el título empieza con la consulta 2 > una palabra del título empieza con la
 * consulta 3 > el título la contiene (o contiene todas sus palabras, en cualquier orden) 4; sin match → null.
 *
 * Es la fuente de verdad del orden: el SQL de `lib/diagnoses.ts` solo pre-filtra candidatos con la misma regla y el
 * orden final sale de acá (un test unit fija el orden sin base). «Todas las palabras en cualquier orden» entra como 4
 * porque la tabulación no trae sinónimos (§24.15): «aguda lumbalgia» tiene que encontrar «Lumbalgia aguda».
 */
export function rankDiagnosisMatch(o: { code: string | null; title: string }, q: ParsedDiagnosisQuery): number | null {
  const code = o.code?.trim().toUpperCase() || null;
  if (q.codePrefix && code) {
    if (code === q.codePrefix) return 0;
    if (code.startsWith(q.codePrefix)) return 1;
  }
  const title = normalizeDiagnosisText(o.title);
  if (!title || !q.text) return null;
  if (title.startsWith(q.text)) return 2;
  if (` ${title}`.includes(` ${q.text}`)) return 3;
  if (title.includes(q.text)) return 4;
  const tokens = q.text.split(" ").filter(Boolean);
  if (tokens.length > 1 && tokens.every((t) => title.includes(t))) return 4;
  return null;
}

/** Clave de «es el mismo diagnóstico»: fuente + id; el texto libre, por su texto normalizado. */
export function diagnosisSnapshotKey(s: Pick<DiagnosisSnapshot, "source" | "refId" | "title">): string {
  return s.source === "text" || !s.refId ? `text:${normalizeDiagnosisText(s.title)}` : `${s.source}:${s.refId}`;
}

/**
 * Recientes: los diagnósticos de las últimas fichas del usuario (la más nueva primero; dentro de una ficha, en su
 * orden: el principal primero), sin repetir, ≤ `max`. Lo que no tiene forma de snapshot se saltea (un JSON viejo o
 * roto no rompe el selector).
 */
export function dedupeRecents(
  perNote: readonly (readonly DiagnosisSnapshot[])[],
  max: number = DIAGNOSIS_RECENTS_MAX
): DiagnosisSnapshot[] {
  const out: DiagnosisSnapshot[] = [];
  const seen = new Set<string>();
  for (const note of perNote) {
    if (!Array.isArray(note)) continue;
    for (const s of note) {
      if (out.length >= max) return out;
      if (!s || typeof s !== "object" || typeof s.title !== "string" || typeof s.source !== "string") continue;
      const key = diagnosisSnapshotKey(s);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}
