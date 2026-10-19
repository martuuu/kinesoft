/**
 * [FC-3f] Importar fichas de Word · lógica pura del drawer (§24.7 «Importar Word», FC-D10/D11). Sin React, sin
 * Tiptap y sin mammoth: el drawer la importa estática y la lectura del .docx (`word-reader.ts`) baja aparte, recién
 * al elegir archivos.
 *
 * Qué resuelve y por qué:
 *  - **Fecha** (FC-D11): la ficha importada es la consulta VIEJA que el profesional tenía en Word, no la de hoy. Se
 *    toma del nombre del archivo (es como la gente los nombra: «Pérez 15-03-2024.docx») y si no, de `lastModified`;
 *    la UI dice de dónde salió y pide «Revisé las fechas» porque las dos fuentes son conjeturas.
 *    `lastModified` es un instante: se pasa a DÍA de Argentina con `toARDateKey` (en el host UTC de Vercel —o en un
 *    navegador con otra zona— un `toISOString().slice(0,10)` corre la fecha después de las 21:00 AR).
 *  - **Hora**: 12:00 AR del día elegido. Una hora del día evita que un cambio de zona mueva la ficha de día, y el
 *    server rechaza más de 12 h en el futuro (EV2-D12): hoy a las 12:00 entra siempre.
 *  - **Dividir** (> 20.000 caracteres): el `body` de la base tiene ese tope (ClinicalNote_body_check). Un informe
 *    largo se parte con `splitHcDoc` en hasta 50 fichas (el máximo de `ImportSourceSchema`).
 *  - **El .docx nunca viaja**: lo que se manda es el `bodyDoc` (JSON) que el server re-arma con `validateHcDoc`. Ni
 *    bytes ni nombres de imágenes salen del navegador; `buildImportInputs` es lo único que arma el input de la action.
 */
import {
  HC_DOC_MAX_CHARS,
  hcDocToPlainText,
  isHcDocEmpty,
  splitHcDoc,
  validateHcDoc,
  type HcBlock,
  type HcDoc,
  type HcDocRejectReason,
} from "@/lib/hc-doc";
import { localToARIso, toARDateKey } from "@/lib/datetime-ar";
import {
  CLINICAL_NOTE_IMPORT_FILE_NAME_MAX,
  CLINICAL_NOTE_IMPORT_MAX_BYTES,
  CLINICAL_NOTE_IMPORT_PARTS_MAX,
  type CreateClinicalNoteInput,
} from "@/lib/clinical-notes-types";

export const WORD_IMPORT_MAX_FILES = 50;
export const WORD_IMPORT_MAX_BYTES = CLINICAL_NOTE_IMPORT_MAX_BYTES;
export const WORD_IMPORT_MAX_PARTS = CLINICAL_NOTE_IMPORT_PARTS_MAX;

// ─── Archivo ─────────────────────────────────────────────────────────────────

export type WordFileIssue = "doc" | "not-docx" | "too-big";

/**
 * Antes de leer un byte. `.doc` (Word 97-2003, binario OLE) tiene aviso propio: mammoth no lo lee y la salida es
 * «guardalo como .docx», no «ese archivo no sirve». Un archivo vacío no puede ser un .docx (un zip mide ≥ 22 bytes).
 */
export function precheckWordFile(f: { name: string; size: number }): WordFileIssue | null {
  const name = f.name.trim().toLowerCase();
  if (name.endsWith(".doc")) return "doc";
  if (!name.endsWith(".docx") || name.length <= ".docx".length || f.size <= 0) return "not-docx";
  if (f.size > WORD_IMPORT_MAX_BYTES) return "too-big";
  return null;
}

/**
 * Magic bytes de un zip (`PK\x03\x04`): un .docx es un zip. Frena un .doc, un PDF o una imagen renombrados a .docx
 * antes de pasarle el archivo entero a mammoth (que ante basura tarda y tira errores poco claros).
 */
export function hasDocxMagic(head: Uint8Array): boolean {
  return head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
}

/** Hasta 50 por tanda (contando los que ya están en la lista): el resto se descarta y se avisa cuántos. */
export function limitWordFiles<T>(files: readonly T[], already = 0): { accepted: T[]; dropped: number } {
  const room = Math.max(0, WORD_IMPORT_MAX_FILES - already);
  return { accepted: files.slice(0, room), dropped: Math.max(0, files.length - room) };
}

/** `fileName` de `importSource` es 1..200: un nombre más largo se recorta conservando la extensión. */
export function importFileName(name: string): string {
  const n = name.trim();
  if (n.length <= CLINICAL_NOTE_IMPORT_FILE_NAME_MAX) return n;
  const dot = n.lastIndexOf(".");
  const ext = dot > 0 && n.length - dot <= 10 ? n.slice(dot) : "";
  return n.slice(0, CLINICAL_NOTE_IMPORT_FILE_NAME_MAX - ext.length) + ext;
}

// ─── Fecha ───────────────────────────────────────────────────────────────────

export type ImportDateSource = "name" | "modified";

const MONTHS: Record<string, number> = {
  enero: 1, ene: 1, febrero: 2, feb: 2, marzo: 3, mar: 3, abril: 4, abr: 4, mayo: 5, may: 5, junio: 6, jun: 6,
  julio: 7, jul: 7, agosto: 8, ago: 8, septiembre: 9, setiembre: 9, sept: 9, sep: 9, set: 9, octubre: 10, oct: 10,
  noviembre: 11, nov: 11, diciembre: 12, dic: 12,
};

const pad2 = (n: number) => String(n).padStart(2, "0");

/** "AAAA-MM-DD" si es un día real entre 1900 y 2100; si no, null (30-02 no existe). */
function dateKeyOf(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/**
 * Los 5 formatos, en este orden (el primero que da un día real gana). Sin lookbehind (`(?<!\d)`): Safari < 16.4 no
 * lo parsea y un SyntaxError tiraría el chunk entero; se usa `(?:^|\D)` y el grupo de los dígitos.
 *   1. AAAA-MM-DD (también `_`, `.` o espacio): «2024-03-15».
 *   2. AAAAMMDD, exactamente 8 dígitos: «20240315». Un DNI de 8 no da un mes/día real y uno de 9 no matchea.
 *   3. DD-MM-AAAA (`-`, `_`, `.` o espacio): «15-03-2024», el formato argentino.
 *   4. DD-MM-AA (`-`, `_` o `.`; sin espacio, sería demasiado laxo): «15-03-24» → 2024.
 *   5. DD de mes de AAAA, con el mes en letras (completo o abreviado): «15 de marzo de 2024», «2-ago-2023».
 */
const NAME_PATTERNS: { re: RegExp; ymd: (m: RegExpExecArray) => [number, number, number] | null }[] = [
  { re: /(?:^|\D)(\d{4})[-_. ](\d{1,2})[-_. ](\d{1,2})(?!\d)/g, ymd: (m) => [+m[1], +m[2], +m[3]] },
  { re: /(?:^|\D)(\d{4})(\d{2})(\d{2})(?!\d)/g, ymd: (m) => [+m[1], +m[2], +m[3]] },
  { re: /(?:^|\D)(\d{1,2})[-_. ](\d{1,2})[-_. ](\d{4})(?!\d)/g, ymd: (m) => [+m[3], +m[2], +m[1]] },
  { re: /(?:^|\D)(\d{1,2})[-_.](\d{1,2})[-_.](\d{2})(?!\d)/g, ymd: (m) => [2000 + +m[3], +m[2], +m[1]] },
  {
    re: /(?:^|[^a-z0-9])(\d{1,2})(?:\s+de\s+|[-_. ]+)([a-z]+)\.?(?:\s+de\s+|[-_. ]+)(\d{4})(?!\d)/g,
    ymd: (m) => (MONTHS[m[2]] ? [+m[3], MONTHS[m[2]], +m[1]] : null),
  },
];

/** Día ("AAAA-MM-DD") escrito en el nombre del archivo, o null. Insensible a mayúsculas y tildes. */
export function dateFromFileName(fileName: string): string | null {
  const base = fileName
    .replace(/\.docx?$/i, "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  for (const { re, ymd } of NAME_PATTERNS) {
    for (const m of base.matchAll(re)) {
      const parts = ymd(m);
      const key = parts && dateKeyOf(parts[0], parts[1], parts[2]);
      if (key) return key;
    }
  }
  return null;
}

/** `File.lastModified` (ms) → día de Argentina. 0/NaN (algunos navegadores o archivos sin metadato) → null. */
export function dateFromLastModified(ms: number): string | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return toARDateKey(new Date(ms));
}

/** ISO del `lastModified` para `importSource.fileLastModified` (auditoría del import), o null. */
export function fileLastModifiedIso(ms: number): string | null {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

/** El nombre manda sobre `lastModified` (copiar un archivo cambia su fecha de modificación; el nombre no). */
export function resolveImportDate(f: { name: string; lastModified: number }): { date: string; source: ImportDateSource } | null {
  const fromName = dateFromFileName(f.name);
  if (fromName) return { date: fromName, source: "name" };
  const fromModified = dateFromLastModified(f.lastModified);
  return fromModified ? { date: fromModified, source: "modified" } : null;
}

/** Qué le falta a la fecha del `<input type="date">` para poder importar. Futuro = después de hoy en Argentina. */
export function importDateIssue(dateKey: string, now: Date): "invalid" | "future" | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!m || !dateKeyOf(+m[1], +m[2], +m[3])) return "invalid";
  return dateKey > toARDateKey(now) ? "future" : null;
}

/** 12:00 de Argentina del día elegido, como ISO UTC (lo que espera `occurredAt`). */
export function importOccurredAt(dateKey: string): string {
  return new Date(localToARIso(`${dateKey}T12:00`)).toISOString();
}

// ─── Contenido ───────────────────────────────────────────────────────────────

/** Saca los `<img>` (mammoth los emite aunque el src venga vacío): las fichas guardan solo texto. */
export function stripHtmlImages(html: string): string {
  return html.replace(/<img\b[^>]*>/gi, "");
}

/**
 * HTML de mammoth → lo que el schema del editor entiende. El schema solo tiene H2/H3 (`hcExtensions`): sin esto un
 * «Título 1» de Word quedaría como párrafo plano. Mismo criterio que `validateHcDoc` (h1→2, h4-6→3) y que el pegado
 * del editor (`cleanPastedHtml`), que no se reusa porque arrastraría ProseMirror a este módulo estático.
 */
export function normalizeImportedHtml(html: string): string {
  return stripHtmlImages(html)
    .replace(/<(\/?)h1\b/gi, "<$1h2")
    .replace(/<(\/?)h[4-6]\b/gi, "<$1h3");
}

export type PreparedWordDoc =
  | { ok: true; parts: HcDoc[]; chars: number }
  | { ok: false; reason: HcDocRejectReason | "too-many-parts" };

const isRawDoc = (v: unknown): v is { type: "doc"; content: unknown[] } =>
  typeof v === "object" && v !== null && (v as { type?: unknown }).type === "doc" && Array.isArray((v as { content?: unknown }).content);

/**
 * `validateHcDoc` sin tope de caracteres. Sus otros topes (256 KB de JSON, 10.000 nodos) son por FICHA: un informe
 * de 100 páginas los pasa entero aunque cada parte de ≤20.000 caracteres entre cómoda. Entonces se valida por mitades
 * de bloques de primer nivel hasta que cada tramo entra, y se juntan los bloques ya re-armados. Un solo bloque que
 * no entra (una tabla gigante convertida en un párrafo) sí se rechaza.
 */
function validateLoose(raw: unknown): { ok: true; blocks: HcBlock[] } | { ok: false; reason: HcDocRejectReason } {
  const r = validateHcDoc(raw, { maxChars: Number.POSITIVE_INFINITY });
  if (r.ok) return { ok: true, blocks: r.doc.content };
  if (r.reason === "empty") return { ok: true, blocks: [] };
  if ((r.reason === "too-large" || r.reason === "too-many-nodes") && isRawDoc(raw) && raw.content.length > 1) {
    const mid = Math.floor(raw.content.length / 2);
    const a = validateLoose({ type: "doc", content: raw.content.slice(0, mid) });
    if (!a.ok) return a;
    const b = validateLoose({ type: "doc", content: raw.content.slice(mid) });
    if (!b.ok) return b;
    return { ok: true, blocks: [...a.blocks, ...b.blocks] };
  }
  return { ok: false, reason: r.reason };
}

/**
 * JSON de `generateJSON` → fichas listas para mandar. Cada parte se re-valida con los topes reales de una ficha
 * (los mismos del server): si una no entra, el archivo entero se rechaza antes de crear ninguna.
 */
export function prepareImportedDoc(raw: unknown): PreparedWordDoc {
  const loose = validateLoose(raw);
  if (!loose.ok) return loose;
  const doc: HcDoc = { type: "doc", content: loose.blocks };
  if (!doc.content.length || isHcDocEmpty(doc)) return { ok: false, reason: "empty" };
  const chars = hcDocToPlainText(doc).length;
  if (chars > HC_DOC_MAX_CHARS * WORD_IMPORT_MAX_PARTS) return { ok: false, reason: "too-many-parts" };
  const split = splitHcDoc(doc, HC_DOC_MAX_CHARS);
  if (split.length > WORD_IMPORT_MAX_PARTS) return { ok: false, reason: "too-many-parts" };
  const parts: HcDoc[] = [];
  for (const part of split) {
    const v = validateHcDoc(part);
    if (!v.ok) return { ok: false, reason: v.reason };
    parts.push(v.doc);
  }
  return { ok: true, parts, chars };
}

// ─── Input de la action ──────────────────────────────────────────────────────

/**
 * Un `createClinicalNote` por parte, cada una con SU clave (estable mientras el drawer está abierto: un reintento de
 * una que falló por red es replay, no un duplicado). Sin turno (`!importSource || !bookingId`, C-FC3) y sin `kind`
 * ni título: el tipo es el default del server y la tarjeta ya muestra «Importada de {archivo}».
 */
export function buildImportInputs(p: {
  patientId: string;
  file: { name: string; size: number; lastModified: number };
  dateKey: string;
  batchId: string;
  parts: HcDoc[];
  keys: string[];
}): CreateClinicalNoteInput[] {
  const occurredAt = importOccurredAt(p.dateKey);
  const fileName = importFileName(p.file.name);
  const fileLastModified = fileLastModifiedIso(p.file.lastModified);
  return p.parts.map((doc, i) => ({
    patientId: p.patientId,
    bookingId: null,
    bodyDoc: doc,
    occurredAt,
    idempotencyKey: p.keys[i],
    importSource: {
      kind: "docx",
      fileName,
      fileSize: p.file.size,
      fileLastModified,
      batchId: p.batchId,
      part: i + 1,
      parts: p.parts.length,
    },
  }));
}
