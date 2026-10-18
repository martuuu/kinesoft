/**
 * [FC-2g] Lógica pura de las descargas del equipo (`lib/hc-export-logic.ts`): formatos de la URL, ids y el
 * `Content-Disposition` (el header es la frontera: un nombre con comillas o `;` no puede inyectar parámetros).
 */
import { describe, expect, it } from "vitest";
import {
  attachmentDisposition,
  hcShortId,
  isRouteId,
  parseFichaFormat,
  parseRecordFormat,
} from "@/lib/hc-export-logic";

describe("[FC-2g] hc-export-logic", () => {
  it("formatos: la ficha acepta pdf y docx; la HC completa solo pdf", () => {
    expect(parseFichaFormat("pdf")).toBe("pdf");
    expect(parseFichaFormat("docx")).toBe("docx");
    for (const bad of ["PDF", "doc", ".pdf", "", undefined, null, ["pdf"]]) expect(parseFichaFormat(bad)).toBeNull();
    expect(parseRecordFormat("pdf")).toBe("pdf");
    expect(parseRecordFormat("docx")).toBeNull();
  });

  it("ids: cuid/hex sí; barras, puntos, vacío o largos no", () => {
    expect(isRouteId("cmabc123xyz")).toBe(true);
    expect(isRouteId("a1b2c3d4e5f6a1b2c3d4e5f6")).toBe(true);
    for (const bad of ["", "../x", "a/b", "a.b", "x".repeat(65), 12, null]) expect(isRouteId(bad)).toBe(false);
  });

  it("hcShortId: los últimos 6", () => {
    expect(hcShortId("cmgz0000abcdef123456")).toBe("123456");
    expect(hcShortId("abc")).toBe("abc");
  });

  it("Content-Disposition: attachment con filename ASCII y filename* UTF-8", () => {
    const h = attachmentDisposition("Gómez Juan 2026-10-10 Control [abc123]", "pdf");
    expect(h).toBe(
      `attachment; filename="Gomez Juan 2026-10-10 Control [abc123].pdf"; filename*=UTF-8''G%C3%B3mez%20Juan%202026-10-10%20Control%20%5Babc123%5D.pdf`,
    );
    expect(decodeURIComponent(h.split("UTF-8''")[1])).toBe("Gómez Juan 2026-10-10 Control [abc123].pdf");
  });

  it("Content-Disposition: comillas, `;`, barras y no-ASCII no rompen el header", () => {
    const h = attachmentDisposition('Pe"rez; x=1 \\ Ñandú 漢 (it\'s)', "docx");
    const ascii = /filename="([^"]*)"/.exec(h)![1];
    expect(ascii).not.toMatch(/["\\;]/);
    expect(ascii).toMatch(/^[\x20-\x7e]+\.docx$/);
    const star = h.split("filename*=UTF-8''")[1];
    expect(star).toMatch(/^[A-Za-z0-9%._~-]+$/);
    expect(decodeURIComponent(star)).toBe('Pe"rez; x=1 \\ Ñandú 漢 (it\'s).docx');
    // Exactamente dos parámetros: nada inyectado.
    expect(h.split("; ").length).toBe(3);
  });
});
