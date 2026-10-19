/**
 * [FC-3f] Lectura de un .docx EN EL NAVEGADOR (FC-D10/D11: el archivo nunca viaja al server).
 *
 * Cadena: bytes → mammoth (HTML) → `generateJSON` de `@tiptap/core` con las MISMAS extensiones del editor
 * (`hcExtensions()`, la allow-list de C-FC1 hecha schema) → JSON crudo. Después `prepareImportedDoc`
 * (`word-import-logic.ts`) lo pasa por `validateHcDoc`, y el server lo vuelve a re-armar al guardar.
 *
 * Bundle (§24.9; `/agenda` sin margen, FC-3i1). Cada chunk diferido NUEVO suma ~20 B al runtime de webpack de TODAS
 * las rutas, y medido en el build (HEAD 739ed6d + FC-3f) un `import()` de este archivo desde el drawer abría 4 chunks
 * nuevos: el del lector, el de mammoth y dos de Tiptap, porque splitChunks parte los vendors por el CONJUNTO de grupos
 * que los usan y el lector usaba solo una parte de lo que usa el editor. Por eso:
 *  - el drawer importa este archivo ESTÁTICO (no es un chunk aparte);
 *  - `generateJSON` se toma de `@tiptap/react` y se ancla `EditorContent`: así este grupo usa exactamente los mismos
 *    módulos de Tiptap que el editor y los 3 chunks de Tiptap quedan como estaban (compartidos, mismo hash). Sin el
 *    ancla, `@tiptap/core` re-exportado deja afuera `@tiptap/react` (sideEffects:false) y aparece un chunk más;
 *  - mammoth entra SOLO por `import()` (guard `hc-heavy-deps` 5) y queda como el único chunk nuevo (~96 kB gz), que
 *    baja recién al leer el primer archivo: ni al abrir el drawer ni con la precarga del menú «⋯».
 *
 * Imágenes: `convertImage` las cuenta y devuelve un src vacío, así mammoth no lee los bytes de cada foto ni arma un
 * data: URI de varios MB solo para que el schema lo descarte. Los `<img>` se sacan del HTML y el drawer avisa cuántas
 * se omitieron.
 */
import { EditorContent, generateJSON } from "@tiptap/react";
import { hcExtensions } from "@/components/hc/editor/hc-extensions";
import { normalizeImportedHtml, stripHtmlImages } from "@/components/fichas/word-import-logic";

/**
 * Style map sumado al default de mammoth: el subrayado (que mammoth ignora por default; el schema sí lo tiene) y el
 * estilo «Título»/«Subtítulo» de Word, que por default salen como párrafo.
 */
const STYLE_MAP = ["u => u", "p[style-name='Title'] => h2:fresh", "p[style-name='Subtitle'] => h3:fresh"];

/** Ancla de bundle (ver cabecera): referenciar `EditorContent` mete `@tiptap/react` en este grupo, igual que el editor. */
export const WORD_READER_EDITOR_ANCHOR = EditorContent;

export type WordReadResult = { ok: true; raw: unknown; images: number } | { ok: false; reason: "unreadable" };

/** mammoth → HTML sin imágenes + cuántas había. */
export async function docxToHtml(buf: ArrayBuffer): Promise<{ html: string; images: number }> {
  const mod = await import("mammoth");
  const mammoth = (mod as unknown as { default?: typeof mod }).default ?? mod;
  let images = 0;
  const convertImage = mammoth.images.imgElement(async () => {
    images++;
    return { src: "" };
  });
  // En el navegador mammoth lee `arrayBuffer` (campo `browser` de su package.json); en node (unit) lee `buffer`, que
  // JSZip también acepta como ArrayBuffer. Se pasan los dos para probar el mismo símbolo que corre en el cliente.
  const input = { arrayBuffer: buf, buffer: buf } as unknown as { arrayBuffer: ArrayBuffer };
  const res = await mammoth.convertToHtml(input, { styleMap: STYLE_MAP, convertImage, ignoreEmptyParagraphs: true });
  return { html: stripHtmlImages(res.value), images };
}

/** HTML → JSON crudo del schema del editor. Necesita `window.DOMParser` (solo navegador). */
export function htmlToRawDoc(html: string): unknown {
  return generateJSON(normalizeImportedHtml(html), hcExtensions());
}

/** El .docx entero → JSON crudo (sin validar) + imágenes omitidas. Cualquier error de lectura → `unreadable`. */
export async function readWordDocx(buf: ArrayBuffer): Promise<WordReadResult> {
  try {
    const { html, images } = await docxToHtml(buf);
    return { ok: true, raw: htmlToRawDoc(html), images };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}
