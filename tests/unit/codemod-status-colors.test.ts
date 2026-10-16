/**
 * [VX F2] Codemod de colores de estado (brief VX §4 «F2», D-VX23). Prueba el `transformSource`/`runCodemod` reales del
 * script: mapa literal, normalización (mayúsculas, espacios, `,.1` = `,0.1`), exclusiones e idempotencia sobre el árbol
 * real (después del `--write`, una segunda corrida tiene que dar 0 cambios; si alguien suma un literal exacto nuevo,
 * esto falla antes que el ratchet).
 */
import { describe, it, expect } from "vitest";
import {
  STATUS_COLOR_MAP,
  excludedReason,
  normalizeColor,
  runCodemod,
  transformSource,
} from "../../scripts/codemod-status-colors.mjs";

describe("[VX F2] scripts/codemod-status-colors.mjs", () => {
  it("el mapa es el literal del brief (10 entradas, cada una a su token de C-F1)", () => {
    expect(STATUS_COLOR_MAP).toEqual({
      "#9f1f1f": "var(--danger-fg)",
      "rgba(228,70,70,0.1)": "var(--danger-bg)",
      "rgba(228,70,70,0.18)": "var(--danger-bg-strong)",
      "#c62828": "var(--danger-solid)",
      "#e44646": "var(--danger-dot)",
      "#7a4a00": "var(--warn-fg)",
      "rgba(255,176,32,0.14)": "var(--warn-bg)",
      "rgba(255,176,32,0.24)": "var(--warn-bg-strong)",
      "#1b704b": "var(--success-fg)",
      "rgba(54,179,126,0.12)": "var(--success-bg)",
    });
  });

  it("normaliza mayúsculas, espacios y `.1` → `0.1`", () => {
    expect(normalizeColor("RGBA(228, 70, 70, .1)")).toBe("rgba(228,70,70,0.1)");
    expect(normalizeColor("#9F1F1F")).toBe("#9f1f1f");
  });

  it("reemplaza las igualdades exactas en estilos inline y CSS", () => {
    const src = [
      `const a = { color: "#9F1F1F", background: "rgba(228, 70, 70, .1)" };`,
      `const b = { color: '#7a4a00', background: "rgba(255,176,32,0.14)", c: "rgba(228,70,70,0.18)" };`,
      `.x { color: #1B704B; background: rgba(54, 179, 126, 0.12); border-color: #C62828; }`,
    ].join("\n");
    const r = transformSource(src, "components/x.tsx");
    expect(r.text).toBe(
      [
        `const a = { color: "var(--danger-fg)", background: "var(--danger-bg)" };`,
        `const b = { color: 'var(--warn-fg)', background: "var(--warn-bg)", c: "var(--danger-bg-strong)" };`,
        `.x { color: var(--success-fg); background: var(--success-bg); border-color: var(--danger-solid); }`,
      ].join("\n")
    );
    expect(r.replaced).toHaveLength(8);
  });

  it("D-VX23: lo no exacto no se toca y se reporta (#4F8A10, #9A5B00, alfas distintas)", () => {
    const src = `x = { a: "#4F8A10", b: "#9A5B00", c: "rgba(228,70,70,0.3)", d: "rgba(255,176,32,0.12)" };`;
    const r = transformSource(src, "components/x.tsx");
    expect(r.text).toBe(src);
    expect(r.nearMiss.map((n) => n.literal)).toEqual(["#4f8a10", "#9a5b00", "rgba(228,70,70,0.3)", "rgba(255,176,32,0.12)"]);
  });

  it("no matchea un hex más largo (#9F1F1F80 con alfa)", () => {
    const src = `x = "#9F1F1F80";`;
    expect(transformSource(src, "components/x.tsx").text).toBe(src);
  });

  it("excluye atributos SVG de presentación (fill/stroke/stopColor), pero no `style`", () => {
    const src = [
      `<path fill="#9F1F1F" />`,
      `<circle stroke={on ? "#9F1F1F" : "none"} />`,
      `<stop stopColor="#7A4A00" />`,
      `<svg style={{ color: "#9F1F1F" }} />`,
    ].join("\n");
    const r = transformSource(src, "components/x.tsx");
    expect(r.text.split("\n")).toEqual([
      `<path fill="#9F1F1F" />`,
      `<circle stroke={on ? "#9F1F1F" : "none"} />`,
      `<stop stopColor="#7A4A00" />`,
      `<svg style={{ color: "var(--danger-fg)" }} />`,
    ]);
    expect(r.skipped).toHaveLength(3);
  });

  it("excluye archivos que importan una librería de gráficos", () => {
    const src = `import { Line } from "recharts";\nconst c = "#9F1F1F";`;
    expect(transformSource(src, "components/chart.tsx").text).toBe(src);
  });

  it("excluye rutas: globals.css, lib/email, og/icon, tests, design_source y todo fuera de app/components", () => {
    for (const rel of [
      "app/globals.css",
      "lib/email/templates.ts",
      "components/lib/email/x.ts",
      "app/opengraph-image.tsx",
      "app/icon.tsx",
      "app/apple-icon.tsx",
      "app/c/[slug]/opengraph-image.tsx",
      "tests/unit/x.test.ts",
      "design_source/vx0/shared.css",
      "lib/format.ts",
    ]) {
      expect(excludedReason(rel), rel).not.toBeNull();
      expect(transformSource(`c = "#9F1F1F"`, rel).text, rel).toBe(`c = "#9F1F1F"`);
    }
    expect(excludedReason("components/ui/icons.tsx")).toBeNull();
    expect(excludedReason("app/(app)/configuracion/page.tsx")).toBeNull();
  });

  it("es idempotente sobre un archivo (aplicarlo dos veces = una)", () => {
    const once = transformSource(`a = "#9F1F1F"; b = "rgba(228,70,70,.1)";`, "components/x.tsx").text;
    const twice = transformSource(once, "components/x.tsx");
    expect(twice.text).toBe(once);
    expect(twice.replaced).toHaveLength(0);
  });

  it("árbol real: después del --write, una segunda corrida da 0 cambios", () => {
    const r = runCodemod({ root: process.cwd(), write: false });
    expect(r.total, JSON.stringify(r.files.slice(0, 5), null, 2)).toBe(0);
  });
});
