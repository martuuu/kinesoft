/**
 * C-FC1 · formato de la ficha (plan §24.4). Puro: corre en el cliente (editor, importador de Word) y en el server
 * (actions, impresión, portal), sin dependencias. A propósito NO importa Tiptap ni ProseMirror: el editor es un chunk
 * diferido y este módulo entra estático en la timeline, en la impresión y en el portal (+0 kB de cliente).
 *
 * Por qué se re-arma el doc en vez de "validar y guardar lo que llegó":
 *  - el JSON viene del cliente (o de mammoth → generateJSON al importar un .docx) y se renderiza en el portal del
 *    paciente y en el PDF: lo único que se persiste es lo que este módulo construye desde cero con la allow-list, así
 *    un attr de más (`style`, `href`, `src`) nunca llega a la base aunque el renderer también lo ignore;
 *  - el doc canónico hace que "mismo contenido" = "mismo JSON": el guard de revisiones de M14 compara `bodyDoc`, y un
 *    reorden de claves o un texto partido en dos nodos no puede generar una revisión fantasma.
 *
 * Topes (C-FC1): 256 KB de JSON, 10.000 nodos, profundidad 12 y 3 listas anidadas. El recorrido del input crudo es
 * iterativo y corta apenas pasa la profundidad: un doc de 100.000 niveles se rechaza sin desbordar la pila. Recién con
 * la profundidad acotada se normaliza con recursión.
 *
 * Longitudes en unidades UTF-16 (`string.length`): es lo que cuenta ProseMirror para las posiciones y es ≥ que
 * `char_length` de Postgres, así que el tope de 20.000 de acá nunca deja pasar algo que el CHECK de la base rechace.
 */

export const HC_DOC_ALLOWED_NODES = ["doc","paragraph","heading","bulletList","orderedList","listItem","hardBreak","text"] as const;
export const HC_DOC_ALLOWED_MARKS = ["bold","italic","underline"] as const;
export const HC_DOC_MAX_JSON_BYTES = 262_144; export const HC_DOC_MAX_NODES = 10_000;
export const HC_DOC_MAX_DEPTH = 12; export const HC_DOC_MAX_LIST_NESTING = 3;
export const HC_DOC_TEMPLATE_HEADINGS = ["Motivo de consulta", "Evaluación", "Tratamiento", "Indicaciones"] as const;
/**
 * Tope de caracteres del texto derivado (`body`): el mismo 1..20.000 del CHECK de la base y del schema del texto plano.
 * No está en el contrato literal de C-FC1; se exporta para que `splitHcDoc`, el importador y el contador del editor
 * usen un solo número (el copy de "too-long" lo cita).
 */
export const HC_DOC_MAX_CHARS = 20_000;
export type HcMark = { type: "bold" } | { type: "italic" } | { type: "underline" };
export type HcText = { type: "text"; text: string; marks?: HcMark[] };
export type HcHardBreak = { type: "hardBreak" };
export type HcInline = HcText | HcHardBreak;
export type HcParagraph = { type: "paragraph"; content?: HcInline[] };
export type HcHeading = { type: "heading"; attrs: { level: 2 | 3 }; content?: HcInline[] };
export type HcListItem = { type: "listItem"; content: (HcParagraph | HcBulletList | HcOrderedList)[] };
export type HcBulletList = { type: "bulletList"; content: HcListItem[] };
export type HcOrderedList = { type: "orderedList"; attrs?: { start: number }; content: HcListItem[] };
export type HcBlock = HcParagraph | HcHeading | HcBulletList | HcOrderedList;
export type HcDoc = { type: "doc"; content: HcBlock[] };
export type HcDocRejectReason = "not-doc" | "too-deep" | "too-many-nodes" | "too-large" | "empty" | "too-long";
export type HcDocValidation =
  | { ok: true; doc: HcDoc; plainText: string; stats: { nodes: number; maxDepth: number; jsonBytes: number; chars: number } }
  | { ok: false; reason: HcDocRejectReason };
export const HC_DOC_ERROR_COPY: Record<HcDocRejectReason, string> = {
  "not-doc": "El texto llegó con un formato que no reconocemos. Recargá la página e intentá de nuevo.",
  "too-deep": "La ficha tiene demasiadas listas anidadas. Simplificá el formato.",
  "too-many-nodes": "La ficha tiene demasiados elementos de formato. Simplificá el formato o dividila.",
  "too-large": "La ficha es demasiado grande. Dividila en dos.",
  "empty": "Escribí la ficha.",
  "too-long": "La ficha puede tener hasta 20.000 caracteres. Dividila en dos.",
};

type HcList = HcBulletList | HcOrderedList;
type HcItemChild = HcParagraph | HcList;
type Raw = Record<string, unknown>;

/** `start` de una lista numerada: entero positivo razonable; cualquier otra cosa (0, negativo, "4", NaN) → 1. */
const ORDERED_START_MAX = 999_999;
const MARK_ORDER: readonly HcMark["type"][] = HC_DOC_ALLOWED_MARKS;

class RejectError extends Error {
  constructor(readonly reason: HcDocRejectReason) {
    super(reason);
  }
}

function isRaw(v: unknown): v is Raw {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function rawChildren(n: Raw): unknown[] {
  return Array.isArray(n.content) ? n.content : [];
}

// ─── Texto: controles y saltos ────────────────────────────────────────────────

/**
 * Sin U+0000 ni controles C0 (ni DEL): Postgres rechaza U+0000 en text/jsonb y el resto rompe el PDF y el .docx.
 * El tab pasa a espacio (Word lo usa para alinear; en la ficha no significa nada). \r\n y \r → \n.
 */
function cleanText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\r\n?/g, "\n").replace(/\t/g, " ").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "");
}

function marksOf(raw: unknown): HcMark[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const present = new Set<string>();
  for (const m of raw) if (isRaw(m) && typeof m.type === "string") present.add(m.type);
  const out = MARK_ORDER.filter((t) => present.has(t)).map((type) => ({ type }) as HcMark);
  return out.length ? out : undefined;
}

const sameMarks = (a?: HcMark[], b?: HcMark[]) =>
  (a?.length ?? 0) === (b?.length ?? 0) && (a ?? []).every((m, i) => m.type === b![i].type);

/** Agrega texto (partiendo en hardBreak los \n) a la corrida inline, uniendo con el texto anterior de iguales marcas. */
function pushText(out: HcInline[], text: string, marks: HcMark[] | undefined) {
  const lines = cleanText(text).split("\n");
  lines.forEach((line, i) => {
    if (i > 0) out.push({ type: "hardBreak" });
    if (!line) return;
    const last = out[out.length - 1];
    if (last && last.type === "text" && sameMarks(last.marks, marks)) {
      last.text += line;
      return;
    }
    out.push(marks ? { type: "text", text: line, marks } : { type: "text", text: line });
  });
}

// ─── Normalización (sobre un input ya acotado en profundidad) ─────────────────

/**
 * Corrida inline: texto y saltos se conservan; cualquier otro nodo (link, mention, un párrafo metido dentro de un
 * título…) se desenvuelve conservando su texto; lo que no tiene texto (imagen, iframe) se descarta.
 */
function collectInline(nodes: unknown[], out: HcInline[]) {
  for (const n of nodes) {
    if (!isRaw(n)) continue;
    if (n.type === "hardBreak") out.push({ type: "hardBreak" });
    else if (typeof n.text === "string") pushText(out, n.text, n.type === "text" ? marksOf(n.marks) : undefined);
    else collectInline(rawChildren(n), out);
  }
}

function inlineOf(nodes: unknown[]): HcInline[] {
  const out: HcInline[] = [];
  collectInline(nodes, out);
  return out;
}

const paragraph = (content: HcInline[]): HcParagraph => (content.length ? { type: "paragraph", content } : { type: "paragraph" });

function headingLevel(attrs: unknown): 2 | 3 {
  const lv = isRaw(attrs) ? attrs.level : undefined;
  // h1 → 2 (la ficha ya tiene su título en la tarjeta) y h4-6 → 3: solo dos niveles, como la toolbar.
  return typeof lv === "number" && Number.isInteger(lv) && lv >= 3 && lv <= 6 ? 3 : 2;
}

function orderedStart(attrs: unknown): number {
  const s = isRaw(attrs) ? attrs.start : undefined;
  return typeof s === "number" && Number.isInteger(s) && s >= 1 && s <= ORDERED_START_MAX ? s : 1;
}

/**
 * Bloques. `inItem`: dentro de un ítem solo valen párrafos y listas (el título pasa a párrafo). `listLevel`: listas
 * abiertas por encima; la cuarta rechaza el doc (no se aplana: cambiaría lo que escribió el profesional).
 */
function collectBlocks(nodes: unknown[], listLevel: number, inItem: boolean, out: HcBlock[]) {
  let pending: HcInline[] | null = null;
  const flush = () => {
    if (pending) out.push(paragraph(pending));
    pending = null;
  };
  const walk = (list: unknown[]) => {
    for (const n of list) {
      if (!isRaw(n)) continue;
      const type = n.type;
      if (type === "hardBreak" || typeof n.text === "string") {
        pending ??= [];
        collectInline([n], pending);
      } else if (type === "paragraph" || (type === "heading" && inItem)) {
        flush();
        out.push(paragraph(inlineOf(rawChildren(n))));
      } else if (type === "heading") {
        flush();
        const content = inlineOf(rawChildren(n));
        const h: HcHeading = { type: "heading", attrs: { level: headingLevel(n.attrs) } };
        if (content.length) h.content = content;
        out.push(h);
      } else if (type === "bulletList" || type === "orderedList") {
        flush();
        const list = buildList(n, listLevel + 1);
        if (list) out.push(list);
      } else {
        // Desconocido (blockquote, table, codeBlock, un doc anidado, un listItem huérfano…): se desenvuelve en el
        // mismo flujo, así el texto suelto que tenga se une con lo que lo rodea.
        walk(rawChildren(n));
      }
    }
  };
  walk(nodes);
  flush();
}

function buildList(n: Raw, level: number): HcList | null {
  if (level > HC_DOC_MAX_LIST_NESTING) throw new RejectError("too-deep");
  const items: HcListItem[] = [];
  for (const child of rawChildren(n)) {
    if (!isRaw(child)) continue;
    // Un párrafo (o texto) suelto dentro de la lista se vuelve un ítem más en vez de perderse.
    const blocks: HcBlock[] = [];
    collectBlocks(child.type === "listItem" ? rawChildren(child) : [child], level, true, blocks);
    const content = blocks as HcItemChild[];
    // ProseMirror exige que el ítem empiece con un párrafo (`paragraph block*`).
    if (!content.length || content[0].type !== "paragraph") content.unshift({ type: "paragraph" });
    items.push({ type: "listItem", content });
  }
  if (!items.length) return null;
  if (n.type === "bulletList") return { type: "bulletList", content: items };
  const start = orderedStart(n.attrs);
  return start === 1 ? { type: "orderedList", content: items } : { type: "orderedList", attrs: { start }, content: items };
}

const isBlankParagraph = (b: HcBlock) => b.type === "paragraph" && !b.content;

// ─── Recorrido acotado del input crudo y del doc ──────────────────────────────

/** Cuenta nodos y profundidad sin recursión; corta en cuanto pasa un tope. doc = profundidad 1. */
function scanRaw(root: Raw): HcDocRejectReason | null {
  const stack: [Raw, number][] = [[root, 1]];
  let nodes = 0;
  while (stack.length) {
    const [n, depth] = stack.pop()!;
    if (++nodes > HC_DOC_MAX_NODES) return "too-many-nodes";
    const kids = rawChildren(n);
    if (!kids.length) continue;
    if (depth + 1 > HC_DOC_MAX_DEPTH) return "too-deep";
    for (const k of kids) if (isRaw(k)) stack.push([k, depth + 1]);
  }
  return null;
}

function docStats(doc: HcDoc): { nodes: number; maxDepth: number } {
  let nodes = 0;
  let maxDepth = 0;
  const visit = (n: { content?: readonly unknown[] }, depth: number) => {
    nodes++;
    if (depth > maxDepth) maxDepth = depth;
    for (const k of n.content ?? []) visit(k as { content?: unknown[] }, depth + 1);
  };
  visit(doc, 1);
  return { nodes, maxDepth };
}

function utf8Bytes(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

// ─── API ──────────────────────────────────────────────────────────────────────

export function validateHcDoc(input: unknown, opts?: { maxChars?: number }): HcDocValidation {
  if (!isRaw(input) || input.type !== "doc" || (input.content !== undefined && !Array.isArray(input.content))) {
    return { ok: false, reason: "not-doc" };
  }
  const scan = scanRaw(input);
  if (scan) return { ok: false, reason: scan };

  const blocks: HcBlock[] = [];
  try {
    collectBlocks(rawChildren(input), 0, false, blocks);
  } catch (e) {
    if (e instanceof RejectError) return { ok: false, reason: e.reason };
    throw e;
  }
  // Los párrafos vacíos de los bordes (el editor siempre deja uno al final) no son contenido: sacarlos hace que el doc
  // canónico no cambie por un Enter de más y que el `body` derivado no arranque ni termine en blanco.
  let from = 0;
  let to = blocks.length;
  while (from < to && isBlankParagraph(blocks[from])) from++;
  while (to > from && isBlankParagraph(blocks[to - 1])) to--;
  const doc: HcDoc = { type: "doc", content: blocks.slice(from, to) };

  const { nodes, maxDepth } = docStats(doc);
  if (nodes > HC_DOC_MAX_NODES) return { ok: false, reason: "too-many-nodes" };
  // El tamaño se mide sobre el doc re-armado (lo que se guarda), no sobre el input: lo que la allow-list descarta
  // (attrs, basura anidada) nunca se serializa, y el JSON tiene profundidad acotada así que stringify no revienta.
  const jsonBytes = utf8Bytes(JSON.stringify(doc));
  if (jsonBytes > HC_DOC_MAX_JSON_BYTES) return { ok: false, reason: "too-large" };
  if (isHcDocEmpty(doc)) return { ok: false, reason: "empty" };
  const plainText = hcDocToPlainText(doc);
  if (plainText.length > (opts?.maxChars ?? HC_DOC_MAX_CHARS)) return { ok: false, reason: "too-long" };
  return { ok: true, doc, plainText, stats: { nodes, maxDepth, jsonBytes, chars: plainText.length } };
}

/**
 * Escritor del texto plano. Se usa para `hcDocToPlainText` y para `plainOffsetToDocPos`, así el mapeo de posiciones
 * nunca se desfasa del texto: los dos salen del mismo recorrido.
 *
 * Formato (C-FC1): bloques separados por "\n\n"; ítems por "\n" con «• » o «N. »; 2 espacios de sangría por nivel de
 * lista. Dentro de un ítem, los saltos y los párrafos siguientes van sangrados un nivel más que el ítem, para que el
 * texto se lea como la lista (búsqueda, mail, portal sin formato).
 * `anchors`: tramos del texto que corresponden a contenido del doc (texto, salto o inicio de un bloque de texto).
 */
type Anchor = { plain: number; pos: number; len: number };

function writePlain(doc: HcDoc, anchors?: Anchor[]): string {
  let out = "";
  const mark = (pos: number, len: number) => anchors?.push({ plain: out.length, pos, len });

  const inline = (content: readonly HcInline[] | undefined, pos: number, cont: string): number => {
    mark(pos, 0);
    for (const n of content ?? []) {
      if (n.type === "hardBreak") {
        mark(pos, 1);
        out += "\n" + cont;
        pos += 1;
      } else if (n.type === "text" && typeof n.text === "string") {
        mark(pos, n.text.length);
        out += n.text;
        pos += n.text.length;
      }
    }
    return pos;
  };

  const list = (l: HcList, pos: number, level: number): number => {
    pos += 1; // abre la lista
    const start = l.type === "orderedList" ? (l.attrs?.start ?? 1) : 1;
    const indent = "  ".repeat(level);
    const cont = "  ".repeat(level + 1);
    (l.content ?? []).forEach((item, k) => {
      if (k > 0) out += "\n";
      out += indent + (l.type === "orderedList" ? `${start + k}. ` : "• ");
      pos += 1; // abre el ítem
      (item.content ?? []).forEach((child, j) => {
        if (child.type === "paragraph") {
          if (j > 0) out += "\n" + cont;
          pos = inline(child.content, pos + 1, cont) + 1;
        } else if (child.type === "bulletList" || child.type === "orderedList") {
          out += "\n";
          pos = list(child, pos, level + 1);
        }
      });
      pos += 1; // cierra el ítem
    });
    return pos + 1; // cierra la lista
  };

  let pos = 0;
  (doc.content ?? []).forEach((b, i) => {
    if (i > 0) out += "\n\n";
    if (b.type === "paragraph" || b.type === "heading") pos = inline(b.content, pos + 1, "") + 1;
    else if (b.type === "bulletList" || b.type === "orderedList") pos = list(b, pos, 0);
  });
  return out;
}

export function hcDocToPlainText(doc: HcDoc): string {
  return writePlain(doc);
}

/**
 * Texto plano → doc, sin interpretar nada («• » o «1. » quedan como texto): "\n\n" separa párrafos y "\n" es un salto.
 * Se parte por "\n\n" exacto (no por /\n{2,}/) para que la ida y vuelta con `hcDocToPlainText` dé el mismo texto: un
 * tercer \n queda como salto al principio del párrafo siguiente.
 */
export function plainTextToHcDoc(text: string): HcDoc {
  const content = cleanText(text)
    .split("\n\n")
    .map((chunk) => {
      const inl: HcInline[] = [];
      pushText(inl, chunk, undefined);
      return paragraph(inl);
    });
  return { type: "doc", content };
}

export function isHcDocEmpty(doc: HcDoc): boolean {
  const hasText = (nodes: readonly unknown[] | undefined): boolean =>
    (nodes ?? []).some((n) => {
      const r = n as { type?: string; text?: unknown; content?: unknown[] };
      return r.type === "text" ? typeof r.text === "string" && r.text.trim() !== "" : hasText(r.content);
    });
  return !hasText(doc.content);
}

/**
 * Offset en el texto plano (p. ej. donde cae el corte de 20.000 o un resultado de búsqueda) → posición de ProseMirror
 * (doc abre en 0; cada nodo con contenido suma 1 al abrir y 1 al cerrar; texto 1 por unidad UTF-16; hardBreak 1).
 * Un offset en lo que solo existe en el texto (separadores, «• », sangría) va al contenido siguiente; fuera de rango
 * se acota.
 */
export function plainOffsetToDocPos(doc: HcDoc, offset: number): number {
  const anchors: Anchor[] = [];
  const text = writePlain(doc, anchors);
  if (!anchors.length) return 0;
  const o = Math.min(Math.max(Number.isFinite(offset) ? Math.trunc(offset) : 0, 0), text.length);
  for (const a of anchors) {
    if (o < a.plain) return a.pos;
    if (o <= a.plain + a.len) return a.pos + (o - a.plain);
  }
  // Al final (o en lo que sigue al último tramo): fin del último contenido.
  const last = anchors[anchors.length - 1];
  return last.pos + last.len;
}

// ─── Dividir (importar Word de más de 20.000 caracteres) ──────────────────────

const blockPlain = (b: HcBlock) => hcDocToPlainText({ type: "doc", content: [b] });

/** Parte la corrida inline en tramos de ≤ max: en un espacio si hay, a la fuerza si no (sin partir un par sustituto). */
function splitInline(content: readonly HcInline[], max: number): HcInline[][] {
  const pieces: HcInline[][] = [];
  let cur: HcInline[] = [];
  let len = 0;
  const flush = () => {
    if (cur.length) pieces.push(cur);
    cur = [];
    len = 0;
  };
  for (const n of content) {
    if (n.type === "hardBreak") {
      if (len + 1 > max) flush();
      cur.push(n);
      len += 1;
      continue;
    }
    let rest = n.text;
    while (rest) {
      const room = max - len;
      if (rest.length <= room) {
        cur.push({ ...n, text: rest });
        len += rest.length;
        break;
      }
      let cut = rest.lastIndexOf(" ", room - 1) + 1;
      if (cut <= 0) {
        // Sin espacio en lo que entra: si el tramo ya tiene algo, se arranca uno nuevo; si está vacío, corte duro.
        if (len > 0) {
          flush();
          continue;
        }
        cut = room;
        const c = rest.charCodeAt(cut - 1);
        if (c >= 0xd800 && c <= 0xdbff && cut > 1) cut -= 1;
      }
      cur.push({ ...n, text: rest.slice(0, cut) });
      rest = rest.slice(cut);
      flush();
    }
  }
  flush();
  return pieces;
}

/** Un bloque de más de `max` → bloques de ≤ max con el mismo texto. */
function splitBlock(b: HcBlock, max: number): HcBlock[] {
  if (b.type === "paragraph" || b.type === "heading") {
    return splitInline(b.content ?? [], max).map((content) => ({ ...b, content }) as HcBlock);
  }
  // Lista: se parte por ítem, cada tramo como una lista nueva que sigue la numeración.
  const start = b.type === "orderedList" ? (b.attrs?.start ?? 1) : 1;
  const sub = (items: HcListItem[], at: number): HcList =>
    b.type === "bulletList"
      ? { type: "bulletList", content: items }
      : at === 1
        ? { type: "orderedList", content: items }
        : { type: "orderedList", attrs: { start: at }, content: items };
  const out: HcBlock[] = [];
  let cur: HcListItem[] = [];
  let curStart = start;
  let len = 0;
  b.content.forEach((item, k) => {
    const single = sub([item], start + k);
    const itemLen = blockPlain(single).length;
    if (itemLen > max) {
      if (cur.length) out.push(sub(cur, curStart));
      cur = [];
      len = 0;
      // Un ítem solo más largo que el tope (raro: un párrafo enorme en una viñeta): se baja a párrafos con su texto
      // tal cual («• » incluido) y se parte como cualquier párrafo. Se pierde la viñeta, no el texto.
      for (const p of plainTextToHcDoc(blockPlain(single)).content) {
        out.push(...(blockPlain(p).length > max ? splitBlock(p, max) : [p]));
      }
      curStart = start + k + 1;
      return;
    }
    const added = cur.length ? len + 1 + itemLen : itemLen;
    if (cur.length && added > max) {
      out.push(sub(cur, curStart));
      cur = [item];
      curStart = start + k;
      len = itemLen;
    } else {
      cur.push(item);
      len = added;
    }
  });
  if (cur.length) out.push(sub(cur, curStart));
  return out;
}

/**
 * Divide un doc en docs de ≤ maxChars de texto plano (el importador ofrece «Dividir en N fichas»). Corta entre bloques
 * siempre que puede, así el texto se conserva exacto con "\n\n"; un bloque solo más largo se parte por dentro. Los
 * tramos que quedan sin texto (un salto suelto en el borde de un corte) se descartan: no serían una ficha válida.
 */
export function splitHcDoc(doc: HcDoc, maxChars: number = HC_DOC_MAX_CHARS): HcDoc[] {
  const max = Math.max(2, Math.floor(maxChars));
  if (hcDocToPlainText(doc).length <= max) return [doc];
  const docs: HcDoc[] = [];
  let cur: HcBlock[] = [];
  let len = 0;
  const flush = () => {
    const d: HcDoc = { type: "doc", content: cur };
    if (cur.length && !isHcDocEmpty(d)) docs.push(d);
    cur = [];
    len = 0;
  };
  for (const block of doc.content) {
    const bl = blockPlain(block).length;
    for (const piece of bl > max ? splitBlock(block, max) : [block]) {
      const pl = piece === block ? bl : blockPlain(piece).length;
      const added = cur.length ? len + 2 + pl : pl;
      if (cur.length && added > max) {
        flush();
        cur = [piece];
        len = pl;
      } else {
        cur.push(piece);
        len = added;
      }
    }
  }
  flush();
  return docs;
}

// ─── Plantilla «Insertar estructura» ──────────────────────────────────────────

/** Un objeto nuevo en cada llamada: el editor inserta y muta el JSON. */
export function hcDocTemplate(): HcDoc {
  return {
    type: "doc",
    content: HC_DOC_TEMPLATE_HEADINGS.flatMap((text): HcBlock[] => [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text }] },
      { type: "paragraph" },
    ]),
  };
}

const foldTitle = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/**
 * Títulos de la plantilla que el doc todavía no tiene (H2 o H3, sin tildes ni mayúsculas). «Insertar estructura»
 * agrega solo estos, al final: así repetirlo no duplica secciones.
 */
export function missingStructureHeadings(doc: HcDoc): string[] {
  const have = new Set(
    doc.content
      .filter((b): b is HcHeading => b.type === "heading")
      .map((h) => foldTitle((h.content ?? []).map((n) => (n.type === "text" ? n.text : " ")).join(""))),
  );
  return HC_DOC_TEMPLATE_HEADINGS.filter((h) => !have.has(foldTitle(h)));
}
