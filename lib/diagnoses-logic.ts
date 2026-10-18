/**
 * Diagnósticos de la ficha: lógica PURA (C-FC2, §24.4). Cliente y server, sin Prisma ni I/O.
 *
 * FC-1b3 implementa lo que T4c necesita ya para compilar y testear contra algo real:
 *  - `activeDiagnosisTitle`: lo usa FC-2a al escribir `Patient.diagnosisTitle` con `setActiveDiagnosis`.
 *  - `isLateEntry`: lo usa FC-2b para el chip «Carga tardía» y FC-2e para la marca del PDF.
 * La búsqueda (`normalizeDiagnosisText`, `parseDiagnosisQuery`, `rankDiagnosisMatch`, `dedupeRecents`) queda como
 * stub que tira: la implementa FC-2c junto con `lib/diagnoses.ts`, que es quien define el orden de los grupos.
 */
import { ACTIVE_DIAGNOSIS_TITLE_MAX, type DiagnosisSnapshot } from "@/lib/diagnoses-types";

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

// ─── Stubs (los implementa FC-2c) ────────────────────────────────────────────────────────────────────────────────────

export type ParsedDiagnosisQuery = { text: string; codePrefix: string | null };

function notImplemented(name: string): never {
  throw new Error(`${name}: no implementado (FC-2c).`);
}

/** NFD, sin tildes, minúsculas, `[^a-z0-9]` → espacio. */
export function normalizeDiagnosisText(s: string): string {
  void s;
  return notImplemented("normalizeDiagnosisText");
}

/** < 2 caracteres → null; si parece un código CIE-11, `codePrefix`. */
export function parseDiagnosisQuery(q: string): ParsedDiagnosisQuery | null {
  void q;
  return notImplemented("parseDiagnosisQuery");
}

/** Código exacto 0 > prefijo 1 > empieza con 2 > palabra 3 > contiene 4; sin match → null. */
export function rankDiagnosisMatch(o: { code: string | null; title: string }, q: ParsedDiagnosisQuery): number | null {
  void o;
  void q;
  return notImplemented("rankDiagnosisMatch");
}

/** Recientes: los diagnósticos de las últimas fichas del usuario (la más nueva primero), sin repetir, ≤ `max`. */
export function dedupeRecents(perNote: readonly (readonly DiagnosisSnapshot[])[], max?: number): DiagnosisSnapshot[] {
  void perNote;
  void max;
  return notImplemented("dedupeRecents");
}
