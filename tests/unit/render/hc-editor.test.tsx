/**
 * [FC-3a] Render del editor de fichas: el SSR del campo es un `<textarea>` sin Tiptap (lo que se tipea antes de
 * hidratar no se pierde), con contador; la barra de Tiptap es `role="toolbar"` con roving tabindex y `aria-pressed`.
 *
 * Sin jsdom (`renderToStaticMarkup` en node). La barra se renderiza con un `Editor` REAL de Tiptap sin montar en el
 * DOM (Tiptap 3 crea el estado sin vista hasta `mount`): `aria-pressed` sale de `editor.isActive` sobre la selección
 * de verdad, no de un mock.
 */
import { describe, expect, it } from "vitest";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Editor } from "@tiptap/core";
import { HcEditorField } from "@/components/fichas/hc-editor-field";
import { HcToolbar } from "@/components/hc/editor/hc-toolbar";
import { hcExtensions } from "@/components/hc/editor/hc-extensions";
import { HC_EDITOR_COPY } from "@/components/fichas/fichas-copy";
import type { HcDoc } from "@/lib/hc-doc";

const doc: HcDoc = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Evaluación" }] },
    { type: "paragraph", content: [{ type: "text", text: "Dolor", marks: [{ type: "bold" }] }, { type: "text", text: " lumbar" }] },
  ],
};

describe("[FC-3a] el SSR sin Tiptap", () => {
  const html = renderToStaticMarkup(
    <HcEditorField id="ficha-body" label="Ficha" initialDoc={doc} onChange={() => {}} placeholder="Escribí la ficha" />,
  );

  it("pinta un textarea no controlado con el texto del doc, enlazado al label", () => {
    expect(html).toMatch(/<label[^>]*for="ficha-body"/);
    expect(html).toMatch(/<textarea[^>]*id="ficha-body"/);
    expect(html).toContain("Evaluación\n\nDolor lumbar</textarea>");
    expect(html).not.toMatch(/<textarea[^>]*\svalue=/);
  });

  it("nada de ProseMirror ni contenteditable en el HTML del server; la barra es solo un hueco aria-hidden", () => {
    expect(html).not.toMatch(/ProseMirror|contenteditable|role="toolbar"|tiptap/i);
    expect(html).toMatch(/<div[^>]*aria-hidden="true"[^>]*data-testid="hc-editor-toolbar-skeleton"/);
  });

  it("contador con separador de miles es-AR, referenciado por aria-describedby", () => {
    expect(html).toContain(`>${HC_EDITOR_COPY.counter("Evaluación\n\nDolor lumbar".length, 20_000)}</span>`);
    expect(HC_EDITOR_COPY.counter(19_999, 20_000)).toBe("19.999 / 20.000");
    const counterId = /id="([^"]+)"[^>]*data-testid="hc-editor-counter"/.exec(html)?.[1];
    expect(counterId).toBeTruthy();
    expect(html).toMatch(new RegExp(`<textarea[^>]*aria-describedby="${counterId}"`));
  });

  it("con error: aria-invalid y el error en aria-describedby", () => {
    const h = renderToStaticMarkup(<HcEditorField id="b" label="Ficha" initialDoc={null} initialText="x" onChange={() => {}} error="Escribí la ficha." />);
    expect(h).toMatch(/<textarea[^>]*aria-invalid="true"/);
    expect(h).toMatch(/role="alert"[^>]*>Escribí la ficha\.</);
  });
});

describe("[FC-3a] barra de formato", () => {
  const editor = new Editor({ extensions: hcExtensions(), content: doc });
  // Cursor dentro de «Dolor» (negrita): heading(0..11) → párrafo abre en 12, texto desde 13.
  editor.commands.setTextSelection(15);
  const html = renderToStaticMarkup(<HcToolbar editor={editor} toolbarRef={createRef()} onPlainMode={() => {}} />);
  const buttons = [...html.matchAll(/<button[^>]*>/g)].map((m) => m[0]);

  it("role=toolbar con nombre accesible", () => {
    expect(html).toMatch(new RegExp(`role="toolbar" aria-label="${HC_EDITOR_COPY.toolbarLabel}"`));
  });

  it("roving tabindex: un solo botón en el orden de Tab", () => {
    expect(buttons.length).toBeGreaterThanOrEqual(11);
    expect(buttons.filter((b) => b.includes('tabindex="0"'))).toHaveLength(1);
    expect(buttons.filter((b) => b.includes('tabindex="-1"'))).toHaveLength(buttons.length - 1);
  });

  it("aria-pressed refleja la selección: negrita prendida, cursiva y título apagados", () => {
    const btn = (k: string) => buttons.find((b) => b.includes(`data-hc-tool="${k}"`))!;
    expect(btn("bold")).toContain('aria-pressed="true"');
    expect(btn("italic")).toContain('aria-pressed="false"');
    expect(btn("h2")).toContain('aria-pressed="false"');
    expect(btn("plain")).toContain('aria-pressed="false"');
    // Deshacer sin historial: aria-disabled, no `disabled` (sigue en el recorrido de flechas).
    expect(btn("undo")).toContain('aria-disabled="true"');
    expect(btn("undo")).not.toMatch(/\sdisabled=""/);
    expect(btn("bold")).toContain(`aria-label="${HC_EDITOR_COPY.bold}"`);
  });

  it("[T4-Z ZF3] títulos con íconos «H2»/«H3»; guardando, toda la barra queda aria-disabled (sin salir del recorrido)", () => {
    const btn = (k: string) => buttons.find((b) => b.includes(`data-hc-tool="${k}"`))!;
    expect(html).toMatch(/data-hc-tool="h2"[^>]*>H2<\/button>/);
    expect(html).toMatch(/data-hc-tool="h3"[^>]*>H3<\/button>/);
    expect(btn("bold")).not.toContain("aria-disabled");
    const saving = renderToStaticMarkup(<HcToolbar editor={editor} toolbarRef={createRef()} onPlainMode={() => {}} disabled />);
    const all = [...saving.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
    expect(all.every((b) => b.includes('aria-disabled="true"'))).toBe(true);
    expect(all.some((b) => /\sdisabled=""/.test(b))).toBe(false);
  });

  it("«Insertar estructura» y «Sin formato» con su texto visible", () => {
    expect(html).toContain(`>${HC_EDITOR_COPY.insertStructure}</button>`);
    expect(html).toContain(`>${HC_EDITOR_COPY.plainMode}</button>`);
  });
});
