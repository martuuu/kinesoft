import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [CT-L-5] Sección «Matrícula» de «Mi agenda» (CF3b, M23): `LicenseSection` REAL con `renderToStaticMarkup` (sin DOM).
 * Se mockea solo la server action (red). Lo que decide un cambio del select (vaciar, esconder la provincia) vive en la
 * lógica pura (`licenseDraftWithKind`, `[CT-L-3]`); acá se fija lo que se pinta para cada estado guardado.
 */
vi.mock("@/lib/user-license", () => ({
  setOwnLicense: async () => ({ ok: true, data: { license: null, updatedAt: null } }),
  getOwnLicense: async () => ({ ok: true, data: { license: null, updatedAt: null } }),
}));

import { LicenseSection } from "@/components/configuracion/panels/license-section";
import { ToastProvider } from "@/components/ui/toast";
import { USER_LICENSE_COPY } from "@/lib/user-license-logic";
import { formatDateAR } from "@/lib/format";
import type { UserLicenseView } from "@/lib/user-license-logic";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const render = (initial: UserLicenseView) =>
  renderToStaticMarkup(
    <ToastProvider>
      <LicenseSection initial={initial} onDirtyChange={() => {}} />
    </ToastProvider>
  );
const selected = (html: string, name: string) => {
  const sel = new RegExp(`<select[^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`).exec(html)?.[1] ?? null;
  if (sel === null) return null;
  return /<option[^>]*value="([^"]*)"[^>]*selected=""/.exec(sel)?.[1] ?? /<option selected=""[^>]*value="([^"]*)"/.exec(sel)?.[1] ?? "";
};

describe("[CT-L-5] LicenseSection", () => {
  it("sin matrícula: el select en «Sin matrícula», sin número ni provincia, la nota y «Guardar» deshabilitado", () => {
    const html = render({ license: null, updatedAt: null });
    const t = text(html);
    expect(t).toContain(USER_LICENSE_COPY.kindLabel);
    for (const o of [USER_LICENSE_COPY.kindNone, USER_LICENSE_COPY.kindMN, USER_LICENSE_COPY.kindMP]) expect(t).toContain(o);
    expect(selected(html, "licenseKind")).toBe("");
    expect(html).not.toContain('name="licenseNumber"');
    expect(html).not.toContain('name="licenseJurisdiction"');
    expect(t).toContain("Opcional. La ve el titular del consultorio; no se publica.");
    expect(t).not.toContain("Última modificación");
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
    expect(html).toContain('data-license-form="none"');
  });

  it("MN: número cargado, sin provincia, con la fecha del último cambio (hora de Argentina)", () => {
    const html = render({
      license: { kind: "MN", number: "12345", jurisdiction: null },
      updatedAt: "2026-11-05T02:30:00.000Z",
    });
    expect(selected(html, "licenseKind")).toBe("MN");
    expect(html).toMatch(/name="licenseNumber"[^>]*value="12345"|value="12345"[^>]*name="licenseNumber"/);
    expect(html).not.toContain('name="licenseJurisdiction"');
    // 02:30 UTC del 5 = 23:30 del 4 en Argentina: la fecha sale del reloj AR, no del host (TZ=UTC).
    const shown = formatDateAR("2026-11-05T02:30:00.000Z");
    expect(shown).toMatch(/^04\b/);
    expect(text(html)).toContain(`Última modificación: ${shown}.`);
    expect(html).toContain('data-license-form="MN"');
  });

  it("MP: número y provincia elegida entre las 24 (más «Elegí la provincia»)", () => {
    const html = render({ license: { kind: "MP", number: "4567", jurisdiction: "X" }, updatedAt: "2026-11-05T15:00:00.000Z" });
    expect(selected(html, "licenseKind")).toBe("MP");
    expect(selected(html, "licenseJurisdiction")).toBe("X");
    const options = /<select[^>]*name="licenseJurisdiction"[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1].match(/<option/g);
    expect(options?.length).toBe(25);
    expect(text(html)).toContain("Córdoba");
    expect(text(html)).toContain(USER_LICENSE_COPY.jurisdictionLabel);
  });
});
