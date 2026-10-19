/**
 * [FC-3a] Lógica del editor de fichas que no necesita DOM ni React: limpieza del pegado de Word, normalización de lo
 * que emite el editor, «Insertar estructura» como transacción de ProseMirror, estado nuevo para el handoff y el
 * roving tabindex de la barra. Se prueba en `tests/unit/hc-editor-logic.test.ts` sobre un `EditorState` real.
 *
 * Puede importar `@tiptap/pm/*` porque es uno de los 4 archivos del editor (allow-list de `hc-heavy-deps`) y solo lo
 * alcanza el chunk diferido de `hc-editor.tsx`.
 */
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import { Fragment, type Node as PmNode } from "@tiptap/pm/model";
import { closeHistory } from "@tiptap/pm/history";
import {
  hcDocTemplate,
  hcDocToPlainText,
  isHcDocEmpty,
  missingStructureHeadings,
  plainTextToHcDoc,
  validateHcDoc,
  type HcBlock,
  type HcDoc,
} from "@/lib/hc-doc";
import type { HcEditorChange } from "@/components/fichas/fichas-ui-types";

// ─── Pegado ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Viñeta falsa de Word: `<span style='mso-list:Ignore'>·<span>&nbsp;&nbsp;</span></span>` (un nivel de span adentro). */
const MSO_IGNORE_SPAN = /<span[^>]*mso-list:\s*Ignore[^>]*>(?:[^<]|<span[^>]*>[^<]*<\/span>)*<\/span>/gi;
const MSO_LIST_P = /<p\b[^>]*mso-list:[^>]*>([\s\S]*?)<\/p>/gi;
/** «1.», «a)», «iv.»: numeradas; cualquier otro marcador (·, o, §, -) es viñeta. */
const ORDERED_MARKER = /^\s*(?:\d+|[a-z]|[ivxlcdm]+)[.)]/i;

const stripTags = (s: string) => s.replace(/<[^>]*>/g, "").replace(/&nbsp;/gi, " ");

/**
 * Word (y Outlook) pegan HTML con `<style>`, comentarios condicionales, XML de Office, `<o:p>`, imágenes `file:///` y
 * listas que NO son listas: párrafos con `mso-list` y la viñeta como texto dentro de un span «Ignore». ProseMirror ya
 * descarta lo que el schema no tiene (color, tipografía, link, tabla, imagen), pero no entiende las listas de Word (la
 * viñeta «·» quedaría como texto) ni los H1/H4-H6 (quedarían como párrafo porque el schema solo tiene H2/H3). Esto
 * arregla eso y saca el ruido antes de parsear; `validateHcDoc` en el server sigue siendo la barrera.
 *
 * Regex y no DOMParser a propósito: corre en `transformPastedHTML` (string → string) y así se prueba en node sin DOM.
 * Las listas de Word se aplanan a un nivel (el `level2` de `mso-list` no se interpreta): el profesional re-anida con
 * Tab si lo necesita, y nunca se pierde texto.
 */
export function cleanPastedHtml(html: string): string {
  let s = html;
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(s);
  if (body) s = body[1];
  s = s
    .replace(/<!\[if !supportLists\]>[\s\S]*?<!\[endif\]>/gi, (m) => m.replace(/<!\[if !supportLists\]>|<!\[endif\]>/gi, ""))
    .replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(style|script|xml|head|title)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<(meta|link|img|base)\b[^>]*>/gi, "")
    .replace(/<\/?[a-z]+:[a-z]+\b[^>]*>/gi, "");

  // Listas de Word: corridas de párrafos `mso-list` consecutivos → una <ul>/<ol>, según el marcador del primero.
  s = s.replace(/(?:<p\b[^>]*mso-list:[^>]*>[\s\S]*?<\/p>\s*)+/gi, (run) => {
    const items: { ordered: boolean; html: string }[] = [];
    for (const m of run.matchAll(MSO_LIST_P)) {
      const inner = m[1];
      const marker = /<span[^>]*mso-list:\s*Ignore[^>]*>((?:[^<]|<span[^>]*>[^<]*<\/span>)*)<\/span>/i.exec(inner);
      items.push({
        ordered: marker ? ORDERED_MARKER.test(stripTags(marker[1])) : false,
        html: inner.replace(MSO_IGNORE_SPAN, "").trim(),
      });
    }
    if (!items.length) return run;
    // Un cambio de tipo de marcador dentro de la corrida abre otra lista (viñetas seguidas de numeradas).
    let out = "";
    let open: "ul" | "ol" | null = null;
    for (const it of items) {
      const tag = it.ordered ? "ol" : "ul";
      if (open !== tag) {
        if (open) out += `</${open}>`;
        out += `<${tag}>`;
        open = tag;
      }
      out += `<li><p>${it.html}</p></li>`;
    }
    if (open) out += `</${open}>`;
    return out + "\n";
  });

  return (
    s
      .replace(MSO_IGNORE_SPAN, "")
      // Títulos fuera del schema: H1 → H2 y H4-H6 → H3 (mismo mapeo que validateHcDoc).
      .replace(/<(\/?)h1\b[^>]*>/gi, "<$1h2>")
      .replace(/<(\/?)h[4-6]\b[^>]*>/gi, "<$1h3>")
      // Celdas sin <p> se pegarían letra con letra ("EVA7"): un espacio entre celdas.
      .replace(/<\/(td|th)>(?!\s)/gi, "</$1> ")
      .trim()
  );
}

// ─── Cambio emitido ───────────────────────────────────────────────────────────────────────────────────────────────

const EMPTY_DOC: HcDoc = { type: "doc", content: [{ type: "paragraph" }] };

/**
 * JSON del editor → `{ doc, text }` para el formulario. Se re-arma con `validateHcDoc` (el mismo del server) para que el
 * borrador y el contador vean lo mismo que se va a guardar. Sin tope de caracteres acá: el contador muestra «20.500 /
 * 20.000» en rojo y el server responde con el copy de "too-long"; recortar en silencio perdería texto.
 */
export function editorChange(json: unknown): HcEditorChange {
  const v = validateHcDoc(json, { maxChars: Number.MAX_SAFE_INTEGER });
  if (v.ok) return { doc: v.doc, text: v.plainText, rich: true };
  if (v.reason === "empty") return { doc: EMPTY_DOC, text: "", rich: true };
  // too-large / too-many-nodes / too-deep: se manda tal cual y el server lo rechaza con su copy (HC_DOC_ERROR_COPY).
  const doc = json as HcDoc;
  return { doc, text: hcDocToPlainText(doc), rich: true };
}

// ─── Insertar estructura ─────────────────────────────────────────────────────────────────────────────────────────

export type StructurePlan = { mode: "none" } | { mode: "replace" | "append"; blocks: HcBlock[] };

/**
 * Qué agrega «Insertar estructura» (FC-UI-D7): solo los títulos H2 de la plantilla que faltan, cada uno con su párrafo,
 * al final. En una ficha vacía reemplaza el párrafo vacío (si no, queda un renglón en blanco arriba del primer título).
 */
export function structurePlan(doc: HcDoc): StructurePlan {
  const missing = new Set(missingStructureHeadings(doc));
  if (!missing.size) return { mode: "none" };
  const tpl = hcDocTemplate().content;
  const blocks: HcBlock[] = [];
  for (let i = 0; i < tpl.length; i += 2) {
    const h = tpl[i];
    const text = h.type === "heading" ? (h.content ?? []).map((n) => (n.type === "text" ? n.text : "")).join("") : "";
    if (missing.has(text)) blocks.push(h, tpl[i + 1]);
  }
  const onlyEmptyParagraphs = doc.content.every((b) => b.type === "paragraph") && isHcDocEmpty(doc);
  return { mode: onlyEmptyParagraphs ? "replace" : "append", blocks };
}

type ViewLike = { state: EditorState; dispatch: (tr: Transaction) => void };

/**
 * Aplica «Insertar estructura» como UNA transacción y la aísla en el historial: `closeHistory` antes (para que no se
 * funda con lo tipeado en los últimos 500 ms) y una transacción vacía con `closeHistory` después (para que lo que se
 * tipee enseguida en el primer párrafo tampoco se funda con ella). Resultado: un Ctrl+Z la deshace entera y solo a
 * ella. Devuelve false si no faltaba nada (la barra avisa «La ficha ya tiene todos los títulos.»).
 */
export function runInsertStructure(view: ViewLike): boolean {
  const { state } = view;
  const plan = structurePlan(state.doc.toJSON() as HcDoc);
  if (plan.mode === "none") return false;
  const nodes = plan.blocks.map((b) => state.schema.nodeFromJSON(b));
  const end = state.doc.content.size;
  let from = end;
  if (plan.mode === "replace") from = 0;
  else {
    const last = state.doc.lastChild;
    if (last && last.type.name === "paragraph" && last.content.size === 0) from = end - last.nodeSize;
  }
  const tr = closeHistory(state.tr.replaceWith(from, end, Fragment.from(nodes)));
  // Cursor en el párrafo debajo del primer título insertado: abrir el título + su contenido + cerrar + abrir el párrafo.
  tr.setSelection(TextSelection.create(tr.doc, from + nodes[0].nodeSize + 1)).scrollIntoView();
  view.dispatch(tr);
  view.dispatch(closeHistory(view.state.tr));
  return true;
}

// ─── Handoff ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Estado NUEVO con `doc` y el cursor en `pos`, con los mismos plugins: es como se carga el texto del textarea al hacer
 * el swap y como se aplica un `resetKey` (después de guardar o al restaurar un borrador). Un `setContent` dejaría el
 * historial de la ficha anterior y Ctrl+Z la traería de vuelta. Un doc que el schema no acepta (no debería pasar:
 * viene de `plainTextToHcDoc` o de `validateHcDoc`) cae a su texto plano en vez de romper el editor.
 */
export function freshEditorState(current: EditorState, doc: HcDoc, pos: number): EditorState {
  const { schema } = current;
  let node: PmNode;
  try {
    node = schema.nodeFromJSON(doc);
    node.check();
  } catch {
    node = schema.nodeFromJSON(plainTextToHcDoc(safePlain(doc)));
  }
  const clamped = Math.min(Math.max(0, Math.trunc(pos) || 0), node.content.size);
  return EditorState.create({
    schema,
    doc: node,
    plugins: current.plugins,
    selection: TextSelection.near(node.resolve(clamped)),
  });
}

function safePlain(doc: HcDoc): string {
  try {
    return hcDocToPlainText(doc);
  } catch {
    return "";
  }
}

// ─── Barra ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** Roving tabindex de la barra (WAI-ARIA APG «Toolbar»): flechas con vuelta, Inicio/Fin. null = la tecla no mueve. */
export function rovingIndex(current: number, key: string, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight":
      return (current + 1) % count;
    case "ArrowLeft":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

type KeyLike = { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean };

/** Alt+F10: atajo estándar (TinyMCE, CKEditor, Google Docs) para saltar del área de texto a su barra de formato. */
export function isToolbarShortcut(e: KeyLike): boolean {
  return e.key === "F10" && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
}
