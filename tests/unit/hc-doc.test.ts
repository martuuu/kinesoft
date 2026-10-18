import { describe, it, expect } from "vitest";
import {
  HC_DOC_ALLOWED_MARKS,
  HC_DOC_ALLOWED_NODES,
  HC_DOC_ERROR_COPY,
  HC_DOC_MAX_CHARS,
  HC_DOC_MAX_DEPTH,
  HC_DOC_MAX_JSON_BYTES,
  HC_DOC_MAX_LIST_NESTING,
  HC_DOC_MAX_NODES,
  HC_DOC_TEMPLATE_HEADINGS,
  hcDocTemplate,
  hcDocToPlainText,
  isHcDocEmpty,
  missingStructureHeadings,
  plainOffsetToDocPos,
  plainTextToHcDoc,
  splitHcDoc,
  validateHcDoc,
  type HcDoc,
} from "@/lib/hc-doc";

/**
 * [FC-1a] C-FC1 · formato de la ficha (`lib/hc-doc.ts`): allow-list, topes, normalización y texto plano derivado.
 * El server guarda `bodyDoc` = `validateHcDoc(x).doc` y `body` = su `plainText`, así que todo lo que se afirma acá es
 * lo que termina en la base (y en la búsqueda, la impresión y el portal).
 */

const t = (text: string, ...marks: ("bold" | "italic" | "underline")[]) =>
  marks.length ? { type: "text", text, marks: marks.map((type) => ({ type })) } : { type: "text", text };
const p = (...content: unknown[]) => (content.length ? { type: "paragraph", content } : { type: "paragraph" });
const li = (...content: unknown[]) => ({ type: "listItem", content });
const ul = (...content: unknown[]) => ({ type: "bulletList", content });
const doc = (...content: unknown[]) => ({ type: "doc", content });

function ok(input: unknown, opts?: { maxChars?: number }) {
  const r = validateHcDoc(input, opts);
  if (!r.ok) throw new Error(`rechazado: ${r.reason}`);
  return r;
}

/** Anida `levels` wrappers sin recursión (el fixture de 100.000 niveles no puede armarse recursivo). */
function deepNest(levels: number, wrapperType: string): unknown {
  let node: Record<string, unknown> = { type: "text", text: "x" };
  for (let i = 0; i < levels; i++) node = { type: wrapperType, content: [node] };
  return doc(node);
}

describe("[FC-1a] constantes del contrato", () => {
  it("[FC-1a] allow-list y topes literales", () => {
    expect(HC_DOC_ALLOWED_NODES).toEqual(["doc", "paragraph", "heading", "bulletList", "orderedList", "listItem", "hardBreak", "text"]);
    expect(HC_DOC_ALLOWED_MARKS).toEqual(["bold", "italic", "underline"]);
    expect(HC_DOC_MAX_JSON_BYTES).toBe(262_144);
    expect(HC_DOC_MAX_NODES).toBe(10_000);
    expect(HC_DOC_MAX_DEPTH).toBe(12);
    expect(HC_DOC_MAX_LIST_NESTING).toBe(3);
    expect(HC_DOC_MAX_CHARS).toBe(20_000);
    expect(HC_DOC_ERROR_COPY).toEqual({
      "not-doc": "El texto llegó con un formato que no reconocemos. Recargá la página e intentá de nuevo.",
      "too-deep": "La ficha tiene demasiadas listas anidadas. Simplificá el formato.",
      "too-many-nodes": "La ficha tiene demasiados elementos de formato. Simplificá el formato o dividila.",
      "too-large": "La ficha es demasiado grande. Dividila en dos.",
      "empty": "Escribí la ficha.",
      "too-long": "La ficha puede tener hasta 20.000 caracteres. Dividila en dos.",
    });
  });
});

describe("[FC-1a] validateHcDoc", () => {
  it("[FC-1a] allow-list de nodos, marcas y attrs", () => {
    const r = ok(
      doc(
        { type: "heading", attrs: { level: 2, textAlign: "center", id: "x" }, content: [t("Título")] },
        {
          type: "paragraph",
          attrs: { class: "evil", style: "color:red" },
          content: [
            { type: "text", text: "a", marks: [{ type: "bold", attrs: { x: 1 } }, { type: "link", attrs: { href: "javascript:alert(1)" } }] },
            { type: "text", text: "b", marks: [{ type: "textStyle", attrs: { color: "#f00" } }, { type: "italic" }] },
            { type: "text", text: "c", marks: [{ type: "underline" }, { type: "strike" }, { type: "code" }] },
          ],
        },
        { type: "orderedList", attrs: { start: 3, type: "a" }, content: [li(p(t("x")))] },
      ),
    );
    expect(r.doc).toEqual({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Título" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "a", marks: [{ type: "bold" }] },
            { type: "text", text: "b", marks: [{ type: "italic" }] },
            { type: "text", text: "c", marks: [{ type: "underline" }] },
          ],
        },
        { type: "orderedList", attrs: { start: 3 }, content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }] }] },
      ],
    });
    const json = JSON.stringify(r.doc);
    for (const bad of ["link", "href", "javascript", "textStyle", "color", "class", "style", "strike", "code", "textAlign"]) {
      expect(json).not.toContain(bad);
    }
    // Marcas repetidas y en otro orden salen una sola vez, en el orden canónico.
    const m = ok(doc(p({ type: "text", text: "z", marks: [{ type: "underline" }, { type: "bold" }, { type: "bold" }, { type: "italic" }] })));
    expect(m.doc.content[0]).toEqual({ type: "paragraph", content: [{ type: "text", text: "z", marks: [{ type: "bold" }, { type: "italic" }, { type: "underline" }] }] });
  });

  it("[FC-1a] desenvolver y descartar", () => {
    const r = ok(
      doc(
        { type: "blockquote", content: [p(t("citado")), p(t("dos"))] },
        { type: "image", attrs: { src: "https://x/y.png" } },
        { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [p(t("celda"))] }] }] },
        p(t("a "), { type: "mention", attrs: { id: "u1", label: "Ana" } }, { type: "emoji", text: "🙂" }, t(" b")),
        { type: "horizontalRule" },
        { type: "codeBlock", content: [t("const x = 1")] },
        p({ type: "link", content: [t("enlace")] }),
      ),
    );
    expect(r.doc.content).toEqual([
      p(t("citado")),
      p(t("dos")),
      p(t("celda")),
      p(t("a 🙂 b")),
      p(t("const x = 1")),
      p(t("enlace")),
    ]);
    expect(r.plainText).toBe("citado\n\ndos\n\ncelda\n\na 🙂 b\n\nconst x = 1\n\nenlace");
    // Texto suelto a nivel bloque se envuelve en un párrafo; un listItem fuera de lista se desenvuelve.
    expect(ok(doc(t("suelto"), { type: "hardBreak" }, t("más"))).doc.content).toEqual([p(t("suelto"), { type: "hardBreak" }, t("más"))]);
    expect(ok(doc(li(p(t("ítem huérfano"))))).doc.content).toEqual([p(t("ítem huérfano"))]);
    // Un título dentro de un ítem queda como párrafo (el ítem solo admite párrafos y listas).
    expect(ok(doc(ul(li({ type: "heading", attrs: { level: 2 }, content: [t("h")] })))).doc.content).toEqual([ul(li(p(t("h"))))]);
  });

  it("[FC-1a] h1→2 y h4-6→3; `start` inválido → 1", () => {
    const h = (level: unknown) => ({ type: "heading", attrs: { level }, content: [t("x")] });
    const levels = (lv: unknown) => (ok(doc(h(lv))).doc.content[0] as { attrs: { level: number } }).attrs.level;
    expect(levels(1)).toBe(2);
    expect(levels(2)).toBe(2);
    expect(levels(3)).toBe(3);
    expect(levels(4)).toBe(3);
    expect(levels(5)).toBe(3);
    expect(levels(6)).toBe(3);
    expect(levels("3")).toBe(2);
    expect(levels(undefined)).toBe(2);
    const start = (s: unknown) => ok(doc({ type: "orderedList", attrs: { start: s }, content: [li(p(t("x")))] })).doc.content[0];
    for (const bad of [0, -2, 1.5, "4", null, Number.NaN, Number.POSITIVE_INFINITY, 10_000_000]) {
      expect(start(bad)).toEqual({ type: "orderedList", content: [li(p(t("x")))] });
    }
    expect(start(1)).toEqual({ type: "orderedList", content: [li(p(t("x")))] });
    expect(start(7)).toEqual({ type: "orderedList", attrs: { start: 7 }, content: [li(p(t("x")))] });
  });

  it("[FC-1a] topes sin desbordar la pila (100.000 niveles)", () => {
    expect(validateHcDoc(deepNest(100_000, "blockquote"))).toEqual({ ok: false, reason: "too-deep" });
    expect(validateHcDoc(deepNest(100_000, "bulletList"))).toEqual({ ok: false, reason: "too-deep" });
    // Profundidad 12 entra (doc=1 … text=12); 13 no.
    expect(validateHcDoc(deepNest(10, "blockquote")).ok).toBe(true);
    expect(validateHcDoc(deepNest(11, "blockquote"))).toEqual({ ok: false, reason: "too-deep" });
    // Tres listas anidadas entran; la cuarta no.
    const nested = (n: number): unknown => {
      let item: unknown = li(p(t("hoja")));
      for (let i = 1; i < n; i++) item = li(p(t(`nivel ${n - i}`)), ul(item));
      return doc(ul(item));
    };
    expect(validateHcDoc(nested(3)).ok).toBe(true);
    expect(validateHcDoc(nested(4))).toEqual({ ok: false, reason: "too-deep" });
    // Nodos: 10.000 entran contando doc y textos; uno más no.
    const many = (n: number) => doc(...Array.from({ length: n }, () => ({ type: "hardBreak" })));
    expect(validateHcDoc(many(9_998)).ok).toBe(false); // solo saltos: vacío, pero pasó los topes
    expect(validateHcDoc(many(9_998))).toEqual({ ok: false, reason: "empty" });
    expect(validateHcDoc(doc(p(t("a"), ...Array.from({ length: 9_997 }, () => ({ type: "hardBreak" })))))).toMatchObject({ ok: true });
    expect(validateHcDoc(doc(p(t("a"), ...Array.from({ length: 9_998 }, () => ({ type: "hardBreak" })))))).toEqual({ ok: false, reason: "too-many-nodes" });
    // (sin spread: 200.000 argumentos desbordan la pila del propio test)
    expect(validateHcDoc({ type: "doc", content: Array.from({ length: 200_000 }, () => p(t("x"))) })).toEqual({ ok: false, reason: "too-many-nodes" });
    // 256 KB de JSON (con pocos nodos) → too-large, antes que too-long.
    expect(validateHcDoc(doc(p(t("x".repeat(HC_DOC_MAX_JSON_BYTES)))))).toEqual({ ok: false, reason: "too-large" });
    // Basura profunda en attrs (no en content) no se recorre ni se serializa: el doc se re-arma sin ella.
    let junk: Record<string, unknown> = {};
    for (let i = 0; i < 100_000; i++) junk = { a: junk };
    const withJunk = ok(doc(p(t("x")), { type: "paragraph", attrs: junk, content: [t("y")] }));
    expect(withJunk.doc.content).toEqual([p(t("x")), p(t("y"))]);
  });

  it("[FC-1a] U+0000 y controles", () => {
    const r = ok(doc(p(t("a\u0000b\u0001c\u001fd\te\u007ff"), t("\r\nnueva\rotra"))));
    expect(r.doc.content).toEqual([
      p(t("abcd ef"), { type: "hardBreak" }, t("nueva"), { type: "hardBreak" }, t("otra")),
    ]);
    expect(r.plainText).toBe("abcd ef\nnueva\notra");
    expect(r.plainText).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f]/);
    // Solo controles → vacío.
    expect(validateHcDoc(doc(p(t("\u0000\u0001"))))).toEqual({ ok: false, reason: "empty" });
  });

  it("[FC-1a] idempotente y canónico", () => {
    const messy = doc(
      p(),
      p(t("a", "bold"), t("b", "bold"), t(""), t("c"), { type: "text", text: "d", marks: [] }),
      { type: "foo", content: [t("e"), { type: "hardBreak", attrs: { x: 1 } }, t("f")] },
      ul(li(ul(li(p(t("solo sublista"))))), li(), { type: "paragraph", content: [t("suelto en la lista")] }),
      { type: "bulletList", content: [] },
      p(),
      p(),
    );
    const first = ok(messy);
    expect(first.doc).toEqual({
      type: "doc",
      content: [
        p(t("ab", "bold"), t("cd")),
        p(t("e"), { type: "hardBreak" }, t("f")),
        ul(li(p(), ul(li(p(t("solo sublista"))))), li(p()), li(p(t("suelto en la lista")))),
      ],
    });
    const second = ok(first.doc);
    expect(second.doc).toEqual(first.doc);
    expect(JSON.stringify(second.doc)).toBe(JSON.stringify(first.doc));
    expect(second.plainText).toBe(first.plainText);
    expect(second.stats).toEqual(first.stats);
    // El mismo doc con otro orden de claves da el mismo JSON canónico.
    const reordered = ok({ content: [{ content: [{ marks: [{ type: "bold" }], text: "x", type: "text" }], type: "paragraph" }], type: "doc" });
    expect(JSON.stringify(reordered.doc)).toBe('{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"x","marks":[{"type":"bold"}]}]}]}');
    expect(reordered.stats).toEqual({ nodes: 3, maxDepth: 3, jsonBytes: JSON.stringify(reordered.doc).length, chars: 1 });
    // No-doc.
    for (const bad of [null, undefined, "texto", 3, [], { type: "paragraph" }, { type: "doc", content: "x" }]) {
      expect(validateHcDoc(bad)).toEqual({ ok: false, reason: "not-doc" });
    }
  });

  it("[FC-1a] vacío / demasiado largo", () => {
    expect(validateHcDoc({ type: "doc" })).toEqual({ ok: false, reason: "empty" });
    expect(validateHcDoc(doc())).toEqual({ ok: false, reason: "empty" });
    expect(validateHcDoc(doc(p(), p(t("   ")), ul(li(p()))))).toEqual({ ok: false, reason: "empty" });
    expect(isHcDocEmpty({ type: "doc", content: [{ type: "paragraph" }] })).toBe(true);
    expect(isHcDocEmpty({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: " x " }] }] })).toBe(false);
    expect(validateHcDoc(doc(p(t("x".repeat(20_000))))).ok).toBe(true);
    expect(validateHcDoc(doc(p(t("x".repeat(20_001)))))).toEqual({ ok: false, reason: "too-long" });
    expect(validateHcDoc(doc(p(t("x".repeat(31)))), { maxChars: 30 })).toEqual({ ok: false, reason: "too-long" });
    // El importador valida sin tope de caracteres y después divide.
    expect(validateHcDoc(doc(p(t("x".repeat(25_000)))), { maxChars: Number.POSITIVE_INFINITY }).ok).toBe(true);
  });
});

describe("[FC-1a] texto plano", () => {
  const fixture: HcDoc = {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Motivo de consulta" }] },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Dolor " },
          { type: "text", text: "lumbar", marks: [{ type: "bold" }] },
          { type: "hardBreak" },
          { type: "text", text: "desde hace 2 semanas" },
        ],
      },
      {
        type: "bulletList",
        content: [
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Flexión limitada" }] }] },
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "Lasègue" }] },
              {
                type: "orderedList",
                content: [
                  { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Derecho +" }] }] },
                  {
                    type: "listItem",
                    content: [
                      { type: "paragraph", content: [{ type: "text", text: "Izquierdo −" }, { type: "hardBreak" }, { type: "text", text: "a 40°" }] },
                      { type: "paragraph", content: [{ type: "text", text: "repetir" }] },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Tratamiento" }] },
      {
        type: "orderedList",
        attrs: { start: 3 },
        content: [
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Calor" }] }] },
          { type: "listItem", content: [{ type: "paragraph" }] },
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "TENS" }] }] },
        ],
      },
      { type: "paragraph" },
      { type: "paragraph", content: [{ type: "text", text: "Fin." }] },
    ],
  };

  it("[FC-1a] `hcDocToPlainText` con fixtures literales", () => {
    expect(hcDocToPlainText(fixture)).toBe(
      "Motivo de consulta\n\n" +
        "Dolor lumbar\ndesde hace 2 semanas\n\n" +
        "• Flexión limitada\n" +
        "• Lasègue\n" +
        "  1. Derecho +\n" +
        "  2. Izquierdo −\n" +
        "    a 40°\n" +
        "    repetir\n\n" +
        "Tratamiento\n\n" +
        "3. Calor\n" +
        "4. \n" +
        "5. TENS\n\n" +
        "\n\n" +
        "Fin.",
    );
    expect(hcDocToPlainText({ type: "doc", content: [] })).toBe("");
    expect(hcDocToPlainText(fixture)).toBe(hcDocToPlainText(JSON.parse(JSON.stringify(fixture)) as HcDoc));
    // El body que deriva el server = plainText de la validación.
    expect(ok(fixture).plainText).toBe(hcDocToPlainText(ok(fixture).doc));
  });

  it("[FC-1a] ida y vuelta texto ↔ doc", () => {
    const samples = [
      "Una línea",
      "Párrafo uno\n\nPárrafo dos\ncon salto",
      "a\n\n\nb",
      "a\n\n\n\nb",
      "\n\nempieza con blanco",
      "termina con blanco\n\n",
      "  sangría  \n• no es lista\n1. tampoco",
      "",
    ];
    for (const s of samples) expect(hcDocToPlainText(plainTextToHcDoc(s))).toBe(s);
    expect(plainTextToHcDoc("a\r\nb\u0000c\n\nd")).toEqual({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "a" }, { type: "hardBreak" }, { type: "text", text: "bc" }] },
        { type: "paragraph", content: [{ type: "text", text: "d" }] },
      ],
    });
    // Sin blancos en los bordes, el doc ya es canónico (validar no lo cambia).
    const d = plainTextToHcDoc("Uno\ndos\n\ntres");
    expect(ok(d).doc).toEqual(d);
    expect(plainTextToHcDoc("")).toEqual({ type: "doc", content: [{ type: "paragraph" }] });
  });

  it("[FC-1a] plainOffsetToDocPos mapea el texto plano a posiciones del editor", () => {
    const d: HcDoc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "ab" }] },
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "cd" }] }] }] },
      ],
    };
    // plain = "ab\n\n• cd"; posiciones: p abre 0, "ab" 1-2, p cierra 3; ul 4, li 5, p 6, "cd" 7-8.
    expect(plainOffsetToDocPos(d, 0)).toBe(1);
    expect(plainOffsetToDocPos(d, 1)).toBe(2);
    expect(plainOffsetToDocPos(d, 2)).toBe(3);
    expect(plainOffsetToDocPos(d, 4)).toBe(7); // dentro de «• » → inicio del ítem
    expect(plainOffsetToDocPos(d, 6)).toBe(7);
    expect(plainOffsetToDocPos(d, 7)).toBe(8);
    expect(plainOffsetToDocPos(d, 8)).toBe(9);
    expect(plainOffsetToDocPos(d, 999)).toBe(9);
    expect(plainOffsetToDocPos(d, -5)).toBe(1);
  });
});

describe("[FC-1a] dividir y plantilla", () => {
  const squash = (s: string) => s.replace(/\s+/g, "");

  it("[FC-1a] `splitHcDoc` ≤20.000 conservando el texto", () => {
    const para = (n: number, ch: string) => ({ type: "paragraph" as const, content: [{ type: "text" as const, text: ch.repeat(n) }] });
    const big: HcDoc = { type: "doc", content: [para(12_000, "a"), para(12_000, "b"), para(5_000, "c")] };
    const parts = splitHcDoc(big);
    expect(parts.length).toBe(2);
    for (const part of parts) expect(hcDocToPlainText(part).length).toBeLessThanOrEqual(HC_DOC_MAX_CHARS);
    // Cortes entre bloques: el texto se conserva exacto con el separador de bloques.
    expect(parts.map(hcDocToPlainText).join("\n\n")).toBe(hcDocToPlainText(big));
    for (const part of parts) expect(validateHcDoc(part).ok).toBe(true);

    // Un párrafo solo de 45.000 con palabras se corta en espacios; un bloque sin espacios, a la fuerza.
    const words: HcDoc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "palabra ".repeat(5_625) }] }] };
    const wp = splitHcDoc(words);
    expect(wp.length).toBe(3);
    for (const part of wp) {
      const s = hcDocToPlainText(part);
      expect(s.length).toBeLessThanOrEqual(20_000);
      expect(s.endsWith(" ") || part === wp[wp.length - 1]).toBe(true);
    }
    expect(wp.map(hcDocToPlainText).join("")).toBe(hcDocToPlainText(words));
    const solid: HcDoc = { type: "doc", content: [para(41_000, "z")] };
    expect(splitHcDoc(solid).map((x) => hcDocToPlainText(x).length)).toEqual([20_000, 20_000, 1_000]);

    // Listas largas: se parten por ítem y la numeración sigue.
    const items = Array.from({ length: 3_000 }, (_, i) => ({
      type: "listItem" as const,
      content: [{ type: "paragraph" as const, content: [{ type: "text" as const, text: `paso ${i + 1} ${"x".repeat(10)}` }] }],
    }));
    const list: HcDoc = { type: "doc", content: [{ type: "orderedList", content: items }] };
    const lp = splitHcDoc(list, 20_000);
    expect(lp.length).toBeGreaterThan(1);
    for (const part of lp) expect(hcDocToPlainText(part).length).toBeLessThanOrEqual(20_000);
    expect(squash(lp.map(hcDocToPlainText).join(""))).toBe(squash(hcDocToPlainText(list)));
    expect(lp.map(hcDocToPlainText).join("\n")).toBe(hcDocToPlainText(list));

    // Marcas, saltos y texto mixto: tope chico, nada se pierde.
    const mixed: HcDoc = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Evaluación" }] },
        { type: "paragraph", content: [{ type: "text", text: "uno dos ", marks: [{ type: "bold" }] }, { type: "hardBreak" }, { type: "text", text: "tres cuatro cinco" }] },
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "seis siete ocho nueve diez" }] }] }] },
      ],
    };
    const mp = splitHcDoc(mixed, 12);
    for (const part of mp) {
      expect(hcDocToPlainText(part).length).toBeLessThanOrEqual(12);
      expect(isHcDocEmpty(part)).toBe(false);
    }
    expect(squash(mp.map(hcDocToPlainText).join(""))).toBe(squash(hcDocToPlainText(mixed)));

    // Lo que ya entra vuelve tal cual.
    const small: HcDoc = { type: "doc", content: [para(10, "q")] };
    expect(splitHcDoc(small)).toEqual([small]);
  });

  it("[FC-1a] plantilla literal", () => {
    expect(HC_DOC_TEMPLATE_HEADINGS).toEqual(["Motivo de consulta", "Evaluación", "Tratamiento", "Indicaciones"]);
    const h = (text: string) => ({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text }] });
    expect(hcDocTemplate()).toEqual({
      type: "doc",
      content: [
        h("Motivo de consulta"),
        { type: "paragraph" },
        h("Evaluación"),
        { type: "paragraph" },
        h("Tratamiento"),
        { type: "paragraph" },
        h("Indicaciones"),
        { type: "paragraph" },
      ],
    });
    // Cada llamada devuelve un objeto nuevo (el editor lo muta).
    expect(hcDocTemplate()).not.toBe(hcDocTemplate());
    expect(hcDocTemplate().content[0]).not.toBe(hcDocTemplate().content[0]);
    expect(missingStructureHeadings(hcDocTemplate())).toEqual([]);
    expect(missingStructureHeadings({ type: "doc", content: [] })).toEqual([...HC_DOC_TEMPLATE_HEADINGS]);
    // Sin tildes ni mayúsculas, en H2 o H3; un párrafo con el mismo texto no cuenta.
    expect(
      missingStructureHeadings({
        type: "doc",
        content: [
          { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: " EVALUACION " }] },
          { type: "paragraph", content: [{ type: "text", text: "Tratamiento" }] },
        ],
      }),
    ).toEqual(["Motivo de consulta", "Tratamiento", "Indicaciones"]);
  });
});
