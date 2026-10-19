/**
 * [FC-3a] Editor de fichas (§24.7 «Editor», Anexo C «[FC-3a]»): extensiones = allow-list; pegado de Word; el handoff
 * conserva el texto y el cursor; sin swap durante IME o con menos de 600 ms; «Insertar estructura» en vacío, parcial y
 * completo (un solo deshacer); toolbar con roving tabindex.
 *
 * Anti-false-green: el schema sale de `getSchema(hcExtensions())`, el MISMO arreglo que monta el editor; la
 * estructura y el handoff se prueban sobre un `EditorState` real de ProseMirror con el plugin de historial que usa
 * Tiptap (`@tiptap/pm/history`), aplicando las transacciones que arma el código de producción y deshaciendo con
 * `undo` (no con un mock). No hace falta DOM: ninguna de estas piezas toca la vista.
 */
import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/core";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import { history, undo } from "@tiptap/pm/history";
import { HC_DOC_ALLOWED_MARKS, HC_DOC_ALLOWED_NODES, HC_DOC_TEMPLATE_HEADINGS, hcDocToPlainText, plainTextToHcDoc, type HcDoc } from "@/lib/hc-doc";
import { hcExtensions } from "@/components/hc/editor/hc-extensions";
import {
  cleanPastedHtml,
  editorChange,
  freshEditorState,
  isToolbarShortcut,
  rovingIndex,
  runInsertStructure,
  structurePlan,
} from "@/components/hc/editor/hc-editor-logic";
import {
  HC_EDITOR_SWAP_PAUSE_MS,
  docForText,
  handoffCursor,
  shouldPreloadOnIdle,
  swapDecision,
} from "@/components/fichas/hc-editor-field-logic";

const schema = getSchema(hcExtensions());

/** Vista mínima: lo único que usa `runInsertStructure` es `state` + `dispatch`. */
function fakeView(doc: HcDoc) {
  const view = {
    state: EditorState.create({ schema, doc: schema.nodeFromJSON(doc), plugins: [history({ newGroupDelay: 500 })] }),
    dispatch(tr: Transaction) {
      view.state = view.state.apply(tr);
    },
  };
  return view;
}
const json = (s: EditorState) => s.doc.toJSON() as HcDoc;
const headings = (d: HcDoc) =>
  d.content.filter((b) => b.type === "heading").map((h) => (h.content ?? []).map((n) => (n.type === "text" ? n.text : "")).join(""));

describe("[FC-3a] extensiones = allow-list de C-FC1", () => {
  it("el schema del editor tiene exactamente los nodos y marcas permitidos", () => {
    expect(Object.keys(schema.nodes).sort()).toEqual([...HC_DOC_ALLOWED_NODES].sort());
    expect(Object.keys(schema.marks).sort()).toEqual([...HC_DOC_ALLOWED_MARKS].sort());
  });

  it("títulos solo H2/H3 y el historial montado (deshacer/rehacer)", () => {
    const levels = hcExtensions().find((e) => e.name === "heading")?.options as { levels: number[] };
    expect(levels.levels).toEqual([2, 3]);
    expect(hcExtensions().map((e) => e.name)).toContain("undoRedo");
    // Lo que NO está (StarterKit traería todo esto aunque se apague con configure).
    for (const n of ["link", "code", "codeBlock", "blockquote", "horizontalRule", "strike", "dropCursor", "gapCursor", "trailingNode"]) {
      expect(hcExtensions().map((e) => e.name)).not.toContain(n);
    }
  });
});

describe("[FC-3a] pegado desde Word", () => {
  const WORD = `<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta name=Generator content="Microsoft Word 15">
<style><!-- p.MsoNormal {mso-style-parent:""; color:red} --></style><!--[if gte mso 9]><xml><w:WordDocument></w:WordDocument></xml><![endif]--></head>
<body lang=ES-AR><!--StartFragment-->
<h1>Evaluación</h1>
<p class=MsoNormal><b><span style='color:#C00000'>Dolor</span></b> lumbar<o:p></o:p></p>
<p class=MsoListParagraphCxSpFirst style='mso-list:l0 level1 lfo1'><![if !supportLists]><span style='font-family:Symbol;mso-list:Ignore'>·<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp; </span></span><![endif]>Movilidad<o:p></o:p></p>
<p class=MsoListParagraphCxSpLast style='mso-list:l0 level1 lfo1'><![if !supportLists]><span style='font-family:Symbol;mso-list:Ignore'>·<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp; </span></span><![endif]>Fuerza<o:p></o:p></p>
<p class=MsoListParagraphCxSpFirst style='mso-list:l1 level1 lfo2'><![if !supportLists]><span style='mso-list:Ignore'>1.<span>&nbsp; </span></span><![endif]>Calor<o:p></o:p></p>
<p class=MsoNormal><img width=100 src="file:///C:/x.png"><a href="https://x.test">ver informe</a></p>
<table><tr><td>EVA</td><td>7</td></tr></table>
<h5>Detalle</h5>
<!--EndFragment--></body></html>`;

  it("saca estilos, comentarios, xml de Office, imágenes y viñetas falsas; arma listas y baja los títulos", () => {
    const out = cleanPastedHtml(WORD);
    for (const bad of ["<style", "<!--", "<xml", "w:WordDocument", "<o:p", "<img", "mso-list:Ignore", "<meta", "<head", "<![if"]) {
      expect(out, bad).not.toContain(bad);
    }
    expect(out).toContain("<h2>Evaluación</h2>");
    expect(out).toContain("<h3>Detalle</h3>");
    expect(out).toMatch(/<ul><li><p>Movilidad<\/p><\/li><li><p>Fuerza<\/p><\/li><\/ul>/);
    expect(out).toMatch(/<ol><li><p>Calor<\/p><\/li><\/ol>/);
    // Las viñetas de Word (`·`) no quedan como texto.
    expect(out).not.toMatch(/·/);
    // Las celdas no se pegan entre sí.
    expect(out).toMatch(/EVA<\/td>\s+<td>7/);
    // El texto del link sobrevive (el schema no tiene link: ProseMirror deja solo el texto).
    expect(out).toContain("ver informe");
    expect(out).toContain("<b>");
  });

  it("HTML sin Word pasa casi igual (no rompe el pegado común)", () => {
    expect(cleanPastedHtml("<p>Hola <strong>mundo</strong></p>")).toBe("<p>Hola <strong>mundo</strong></p>");
  });
});

describe("[FC-3a] cambio emitido por el editor", () => {
  it("normaliza con validateHcDoc y deriva el texto plano", () => {
    const c = editorChange({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Hola", marks: [{ type: "bold" }] }] }],
    });
    expect(c).toEqual({ doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hola", marks: [{ type: "bold" }] }] }] }, text: "Hola", rich: true });
  });
  it("vacío → texto vacío (el contador marca 0 y el server responde «Escribí la ficha.»)", () => {
    const c = editorChange({ type: "doc", content: [{ type: "paragraph" }] });
    expect(c.text).toBe("");
    expect(c.rich).toBe(true);
  });
  it("más de 20.000 caracteres NO se recorta: el contador lo muestra y el server lo rechaza", () => {
    const long = "a".repeat(20_500);
    const c = editorChange({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: long }] }] });
    expect(c.text.length).toBe(20_500);
  });
});

describe("[FC-3a] «Insertar estructura» (FC-UI-D7: H2 que faltan, al final, un solo deshacer)", () => {
  it("vacío: reemplaza el párrafo vacío por la plantilla completa", () => {
    const empty: HcDoc = { type: "doc", content: [{ type: "paragraph" }] };
    expect(structurePlan(empty).mode).toBe("replace");
    const v = fakeView(empty);
    expect(runInsertStructure(v)).toBe(true);
    expect(headings(json(v.state))).toEqual([...HC_DOC_TEMPLATE_HEADINGS]);
    expect(json(v.state).content[0].type).toBe("heading");
    // El cursor queda en el párrafo debajo del primer título.
    expect(v.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(v.state.selection.$from.index(0)).toBe(1);
    undo(v.state, v.dispatch);
    expect(json(v.state)).toEqual(empty);
  });

  it("parcial: agrega solo los que faltan, al final (sin tildes ni mayúsculas cuenta como existente)", () => {
    const partial: HcDoc = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "motivo de consulta" }] },
        { type: "paragraph", content: [{ type: "text", text: "Lumbalgia" }] },
        { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "EVALUACION" }] },
      ],
    };
    const v = fakeView(partial);
    expect(runInsertStructure(v)).toBe(true);
    expect(headings(json(v.state))).toEqual(["motivo de consulta", "EVALUACION", "Tratamiento", "Indicaciones"]);
    expect(json(v.state).content.slice(0, 3)).toEqual(partial.content);
  });

  it("completo: no hace nada (la UI avisa que ya están)", () => {
    const v = fakeView({ type: "doc", content: [{ type: "paragraph" }] });
    runInsertStructure(v);
    const before = json(v.state);
    expect(structurePlan(before).mode).toBe("none");
    expect(runInsertStructure(v)).toBe(false);
    expect(json(v.state)).toEqual(before);
  });

  it("un solo deshacer: no se mezcla con lo tipeado justo antes ni justo después", () => {
    const v = fakeView({ type: "doc", content: [{ type: "paragraph" }] });
    v.dispatch(v.state.tr.insertText("Dolor", 1));
    const typed = json(v.state);
    runInsertStructure(v);
    v.dispatch(v.state.tr.insertText("x"));
    undo(v.state, v.dispatch); // deshace la "x"
    expect(headings(json(v.state))).toHaveLength(4);
    undo(v.state, v.dispatch); // deshace la estructura entera, deja lo tipeado
    expect(json(v.state)).toEqual(typed);
  });

  it("el párrafo vacío del final se reusa (no queda un renglón en blanco antes del primer título)", () => {
    const v = fakeView({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Nota" }] }, { type: "paragraph" }],
    });
    runInsertStructure(v);
    const d = json(v.state);
    expect(d.content[0]).toEqual({ type: "paragraph", content: [{ type: "text", text: "Nota" }] });
    expect(d.content[1].type).toBe("heading");
  });
});

describe("[FC-3a] handoff textarea → editor (texto y cursor)", () => {
  it("conserva el texto y pone el cursor donde estaba en el textarea", () => {
    const text = "Lumbalgia\naguda\n\nIndico calor";
    const offset = text.indexOf("calor");
    const doc = docForText(text, null);
    const state = freshEditorState(EditorState.create({ schema }), doc, handoffCursor(doc, offset));
    expect(hcDocToPlainText(state.doc.toJSON() as HcDoc)).toBe(text);
    const pos = state.selection.from;
    expect(state.doc.textBetween(0, pos, "\n\n", "\n")).toBe(text.slice(0, offset));
    expect(state.selection).toBeInstanceOf(TextSelection);
  });

  it("si el texto no cambió, se queda con el doc con formato; si cambió, arma uno nuevo desde el texto", () => {
    const rich: HcDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hola", marks: [{ type: "bold" }] }] }] };
    expect(docForText("Hola", rich)).toBe(rich);
    expect(docForText("Hola!", rich)).toEqual(plainTextToHcDoc("Hola!"));
  });

  it("el estado nuevo no arrastra historial (Ctrl+Z no vuelve a la ficha anterior)", () => {
    const v = fakeView({ type: "doc", content: [{ type: "paragraph" }] });
    v.dispatch(v.state.tr.insertText("ficha vieja", 1));
    const next = freshEditorState(v.state, plainTextToHcDoc("nueva"), 1);
    let changed = false;
    undo(next, () => (changed = true));
    expect(changed).toBe(false);
    expect(next.doc.textContent).toBe("nueva");
  });

  it("un doc inválido para el schema cae a texto plano en vez de tirar", () => {
    const bad = { type: "doc", content: [{ type: "listItem", content: [] }] } as unknown as HcDoc;
    const s = freshEditorState(EditorState.create({ schema }), bad, 99);
    expect(s.doc.type.name).toBe("doc");
  });
});

describe("[FC-3a] swap: sin IME en curso y con pausa de 600 ms", () => {
  const base = { ready: true, plainMode: false, composing: false, lastInputAt: null as number | null, now: 10_000 };
  it("sin tipeo previo y listo → swap", () => {
    expect(swapDecision(base)).toEqual({ swap: true });
  });
  it("durante la composición IME no hay swap (se reintenta en compositionend)", () => {
    expect(swapDecision({ ...base, composing: true, lastInputAt: 0 })).toEqual({ swap: false, retryInMs: null });
  });
  it("con menos de 600 ms desde la última tecla, espera lo que falta", () => {
    expect(HC_EDITOR_SWAP_PAUSE_MS).toBe(600);
    expect(swapDecision({ ...base, lastInputAt: 9_700 })).toEqual({ swap: false, retryInMs: 300 });
    expect(swapDecision({ ...base, lastInputAt: 9_400 })).toEqual({ swap: true });
  });
  it("«Sin formato» o el editor sin cargar → nunca", () => {
    expect(swapDecision({ ...base, plainMode: true })).toEqual({ swap: false, retryInMs: null });
    expect(swapDecision({ ...base, ready: false })).toEqual({ swap: false, retryInMs: null });
  });
  it("precarga en idle solo con puntero fino", () => {
    expect(shouldPreloadOnIdle((q) => ({ matches: q === "(pointer: fine)" }))).toBe(true);
    expect(shouldPreloadOnIdle(() => ({ matches: false }))).toBe(false);
    expect(shouldPreloadOnIdle(undefined)).toBe(false);
  });
});

describe("[FC-3a] toolbar: roving tabindex y Alt+F10", () => {
  it("flechas con vuelta, Inicio/Fin; otras teclas no mueven", () => {
    expect(rovingIndex(0, "ArrowRight", 5)).toBe(1);
    expect(rovingIndex(4, "ArrowRight", 5)).toBe(0);
    expect(rovingIndex(0, "ArrowLeft", 5)).toBe(4);
    expect(rovingIndex(2, "Home", 5)).toBe(0);
    expect(rovingIndex(2, "End", 5)).toBe(4);
    expect(rovingIndex(2, "a", 5)).toBeNull();
  });
  it("Alt+F10 lleva a la barra", () => {
    expect(isToolbarShortcut({ key: "F10", altKey: true, ctrlKey: false, metaKey: false, shiftKey: false })).toBe(true);
    expect(isToolbarShortcut({ key: "F10", altKey: false, ctrlKey: false, metaKey: false, shiftKey: false })).toBe(false);
  });
});
