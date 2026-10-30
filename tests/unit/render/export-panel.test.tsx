import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ExportPanel, exportHref } from "@/components/configuracion/panels/export-panel";

/** [BO5-C] Configuración → «Exportar datos»: qué incluye, qué no (binarios), botón de descarga y aviso de demora. */
describe("[BO5-C] ExportPanel", () => {
  it("link de descarga a la ruta (sin tenant: el consultorio activo)", () => {
    const html = renderToStaticMarkup(<ExportPanel />);
    expect(html).toMatch(/href="\/api\/consultorio\/export"[^>]*download/);
    expect(html).toContain("Descargar export");
  });

  it("con tenantId (p. ej. /suspendido) lo manda en ?tenant= codificado", () => {
    expect(exportHref("abc 1")).toBe("/api/consultorio/export?tenant=abc%201");
    expect(renderToStaticMarkup(<ExportPanel tenantId="t1" />)).toContain('href="/api/consultorio/export?tenant=t1"');
  });

  it("dice que los archivos adjuntos no van y que puede tardar", () => {
    const html = renderToStaticMarkup(<ExportPanel />);
    expect(html).toContain("Los archivos adjuntos");
    expect(html).toContain("puede tardar");
    expect(html).toContain("Historia clínica");
  });

  it("[CF-L] sin claims de EVA (salió de la app, decisión de Martin 30-oct)", () => {
    // Las filas de `EvaScore` siguen en el archivo (`lib/tenant-export-logic.ts`, «los datos quedan»), pero el panel ya
    // no la nombra: es una pantalla de la app y la app ya no tiene EVA.
    const html = renderToStaticMarkup(<ExportPanel />);
    expect(html).not.toMatch(/\bEVA\b/);
    expect(html).toContain("Historia clínica: diagnósticos, evaluaciones y notas.");
  });
});
