import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { HcBody, HcDocView } from "@/components/hc/hc-doc-view";
import type { HcDoc } from "@/lib/hc-doc";

/**
 * [FC-1a] `HcDocView` / `HcBody`: render server-safe del JSON de la ficha (web, portal e impresión lo comparten).
 * Se renderiza con `renderToStaticMarkup` (entorno node): si hiciera falta el cliente para pintarlo, acá se vería.
 */

const SRC = readFileSync(join(process.cwd(), "components/hc/hc-doc-view.tsx"), "utf8");

const sample: HcDoc = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Evaluación" }] },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Dolor " },
        { type: "text", text: "lumbar", marks: [{ type: "bold" }, { type: "italic" }, { type: "underline" }] },
        { type: "hardBreak" },
        { type: "text", text: "<script>alert(1)</script> & \"comillas\"" },
      ],
    },
    { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Plan" }] },
    {
      type: "orderedList",
      attrs: { start: 3 },
      content: [
        {
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Calor" }] },
            { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "10 min" }] }] }] },
          ],
        },
      ],
    },
    { type: "paragraph" },
  ],
};

describe("[FC-1a] HcDocView", () => {
  it("[FC-1a] `HcDocView`: sin link/img/table/color, escapa `<script>`, render determinista, sin `\"use client\"`, hooks ni `dangerouslySetInnerHTML`; `HcBody` en pre-wrap", () => {
    const html = renderToStaticMarkup(<HcDocView doc={sample} />);
    // Mapeo C-FC5: p, h2/h3, ul/ol start, br, strong/em/u.
    expect(html).toContain(">Evaluación</h2>");
    expect(html).toContain(">Plan</h3>");
    expect(html).toContain("<strong><em><u>lumbar</u></em></strong>");
    expect(html).toContain("Dolor <strong>");
    expect(html).toContain("<br/>");
    expect(html).toMatch(/<ol[^>]* start="3"/);
    expect(html).toMatch(/<ul[^>]*><li[^>]*><p[^>]*>10 min<\/p><\/li><\/ul>/);
    // Escapado: el texto nunca se vuelve HTML.
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;comillas&quot;");
    // Nada fuera de la allow-list, aunque venga en el JSON (un snapshot viejo o manipulado).
    const hostile = {
      type: "doc",
      content: [
        { type: "image", attrs: { src: "https://evil/x.png" } },
        { type: "table", content: [{ type: "tableRow", content: [] }] },
        {
          type: "paragraph",
          attrs: { style: "color:red" },
          content: [
            { type: "text", text: "clic", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }, { type: "textStyle", attrs: { color: "#f00" } }] },
            { type: "iframe", attrs: { src: "https://evil" } },
          ],
        },
        { type: "heading", attrs: { level: 1, style: "color:red" }, content: [{ type: "text", text: "H" }] },
      ],
    } as unknown as HcDoc;
    const hostileHtml = renderToStaticMarkup(<HcDocView doc={hostile} />);
    for (const bad of ["<a", "href", "<img", "<table", "<iframe", "color", "style=", "javascript", "evil", "<h1"]) {
      expect(hostileHtml).not.toContain(bad);
    }
    expect(hostileHtml).toContain("clic");
    expect(html).not.toMatch(/style=|<a |<img|<table|color/);
    // Determinista: dos renders, mismo HTML; con offset los títulos bajan un nivel (h2→h3, h3→h4).
    expect(renderToStaticMarkup(<HcDocView doc={sample} />)).toBe(html);
    const shifted = renderToStaticMarkup(<HcDocView doc={sample} headingOffset={1} />);
    expect(shifted).toContain(">Evaluación</h3>");
    expect(shifted).toContain(">Plan</h4>");
    // Server-safe: el archivo no es de cliente, no usa hooks ni inyecta HTML crudo.
    expect(SRC).not.toMatch(/["']use client["']/);
    expect(SRC).not.toMatch(/\buse[A-Z]\w*\s*\(/);
    expect(SRC).not.toContain("dangerouslySetInnerHTML");
    expect(SRC).not.toMatch(/clinicalNote|ClinicalNote|clinical-notes/);

    // HcBody: con doc pinta el doc; sin doc, el texto plano viejo con pre-wrap (saltos tal cual, escapado).
    expect(renderToStaticMarkup(<HcBody doc={sample} text="ignorado" />)).toBe(html);
    const plain = renderToStaticMarkup(<HcBody doc={null} text={"Línea 1\n\nLínea <b>2</b>"} />);
    expect(plain).toContain("white-space:pre-wrap");
    expect(plain).toContain("Línea 1\n\nLínea &lt;b&gt;2&lt;/b&gt;");
    expect(plain).not.toContain("<b>");
  });
});
