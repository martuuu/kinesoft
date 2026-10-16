/**
 * [MB-1e · C-MB3 Configuración] Configuración y cuenta a 390: `select` de sección en vez de la píldora de pestañas
 * (< 768), Obras sociales y Diagnósticos como cards (antes una grilla de 5 columnas que scrolleaba adentro de la card),
 * formularios en una columna y targets de 44 px; onboarding con `100dvh`.
 *
 * Vitest en `node` (sin jsdom, como el resto de `tests/unit/render`): markup real por SSR + el CSS Module real (sin
 * comentarios). Una regla dentro de `@media (max-width: 767px)` no le gana a un `style` inline: por eso los casos de
 * las cards afirman que la grilla YA NO va inline. Lo que depende del layout vivo lo mide el revisor B con Playwright.
 * Se mockea solo la red (server actions); los componentes son los reales.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/configuracion",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));
vi.mock("@/lib/insurers", () => ({
  createInsurer: vi.fn(),
  updateInsurer: vi.fn(),
  deleteInsurer: vi.fn(),
  addInsurerFromCatalog: vi.fn(),
  linkInsurerToPayer: vi.fn(),
}));
vi.mock("@/lib/catalog", () => ({ listInsurerPayerSuggestions: vi.fn(async () => ({ ok: true, data: {} })) }));
vi.mock("@/lib/conditions", () => ({
  createCustomCondition: vi.fn(),
  updateCustomCondition: vi.fn(),
  deleteCustomCondition: vi.fn(),
}));

import { TabsBar } from "@/components/configuracion/controls";
import { InsurersPanel } from "@/components/configuracion/panels/insurers-panel";
import { DiagnosticosPanel } from "@/components/configuracion/panels/diagnosticos-panel";
import { ToastProvider } from "@/components/ui/toast";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { modulesFor } from "@/lib/tenant-modules";
import { AccessWall } from "@/components/ui/access-wall";
import AppNotFound from "@/app/(app)/not-found";
import type { InsurerRow } from "@/lib/insurers-types";
import type { CustomConditionRow } from "@/lib/conditions";

const KINE = Array.from(modulesFor({ vertical: "KINESIOLOGY", plan: "INDIVIDUAL", publicBookingEnabled: false }));
const ROOT = join(__dirname, "..", "..", "..");
const css = (rel: string) => readFileSync(join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const CONFIG_CSS = css("components/configuracion/configuracion.module.css");

/** Cuerpo de cada bloque `@media (<query>)` del CSS (llaves balanceadas), concatenados. */
function mediaBody(src: string, query: string): string {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf(`@media (${query})`, from);
    if (at < 0) break;
    const open = src.indexOf("{", at);
    let depth = 0;
    let i = open;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) break;
    }
    out.push(src.slice(open + 1, i));
    from = i;
  }
  return out.join("\n");
}
/** Bloque de declaraciones de `selector` dentro de `src` (primera coincidencia exacta del selector). */
function rule(src: string, selector: string): string {
  const re = new RegExp(`(^|[}\\s,])${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "m");
  return src.match(re)?.[2] ?? "";
}
const MOBILE = mediaBody(CONFIG_CSS, "max-width: 767px");
const DESKTOP = CONFIG_CSS.replace(/@media[^{]*\{(?:[^{}]*\{[^}]*\})*[^{}]*\}/g, "");

const wrap = (n: ReactNode) =>
  renderToStaticMarkup(
    <ToastProvider>
      <ConfirmProvider>{n}</ConfirmProvider>
    </ToastProvider>
  );

describe("[MB-1e] sección de Configuración como select < 768", () => {
  const html = renderToStaticMarkup(<TabsBar tab="obras-sociales" setTab={() => {}} role="OWNER" modules={KINE} />);
  const tabs = Array.from(html.matchAll(/role="tab"[^>]*>([^<]+)</g), (m) => m[1]);
  const options = Array.from(html.matchAll(/<option[^>]*>([^<]+)<\/option>/g), (m) => m[1]);

  it("el select lista las mismas secciones, en el mismo orden, que las pestañas visibles", () => {
    expect(html).toMatch(/<select[^>]*aria-label="Sección de Configuración"/);
    expect(options).toEqual(tabs);
    expect(options.length).toBeGreaterThan(5);
  });

  it("marca la sección activa y cada opción lleva la key de la pestaña", () => {
    expect(html).toMatch(/<option(?=[^>]*value="obras-sociales")(?=[^>]*selected="")[^>]*>Obras sociales<\/option>/);
    expect(html).toMatch(/<option[^>]*value="exportar"[^>]*>Exportar datos<\/option>/);
  });

  it("CSS: en escritorio se ve la píldora y no el select; < 768 al revés", () => {
    expect(rule(DESKTOP, ".sectionPicker")).toMatch(/display:\s*none/);
    expect(rule(MOBILE, ".sectionPicker")).toMatch(/display:\s*block/);
    expect(rule(MOBILE, ".tabsWrap")).toMatch(/display:\s*none/);
  });

  it("el select es el campo de 44 px de la app (`.k-input`, 16 px: iOS no hace zoom al enfocarlo)", () => {
    expect(html).toMatch(/<select[^>]*class="k-input[^"]*"/);
  });
});

describe("[MB-1e] targets de 44 px y formularios en una columna", () => {
  it("< 768 todo botón, select e input de la página (salvo switch/checkbox/radio) mide ≥ 44 px", () => {
    const body = MOBILE;
    expect(body).toMatch(/\.page\s+button:not\(\[role="switch"\]\)/);
    expect(body).toMatch(/min-height:\s*44px/);
    expect(body).toMatch(/min-width:\s*44px/);
  });

  it("`.twoCol` baja a una columna en todo < 768 (antes < 640)", () => {
    expect(rule(MOBILE, ".twoCol")).toMatch(/grid-template-columns:\s*1fr/);
    expect(CONFIG_CSS).not.toMatch(/@media \(max-width: 639px\)\s*\{\s*\.twoCol/);
  });

  it("la Sede usa `.twoCol` (Piso/CP y Ciudad/Provincia) en vez de una grilla inline auto-fit", () => {
    const src = readFileSync(join(ROOT, "components/configuracion/panels/locations-panel.tsx"), "utf8");
    expect(src).not.toMatch(/repeat\(auto-fit, minmax\(150px, 1fr\)\)/);
    expect(src.match(/className=\{styles\.twoCol\}/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

const insurer = (over: Partial<InsurerRow>): InsurerRow => ({
  id: "i1",
  name: "OSDE",
  copagoCents: 150000,
  fixedFeeCents: 900000,
  isParticular: false,
  active: true,
  notes: null,
  payerId: "p1",
  payerName: "OSDE",
  patientsCount: 4,
  createdAt: new Date("2026-01-01T12:00:00Z"),
  ...over,
});

describe("[MB-1e] Obras sociales como cards < 768", () => {
  const html = wrap(<InsurersPanel insurers={[insurer({}), insurer({ id: "i2", name: "Particular", isParticular: true, payerId: null, payerName: null })]} />);

  it("la fila usa clases (sin grilla ni min-width inline, que pisarían el @media)", () => {
    expect(html).not.toContain("grid-template-columns:1.4fr");
    expect(html).not.toContain("min-width:560px");
    expect(html.match(/<li[^>]*class="[^"]*insurerRow/g)?.length).toBe(2);
    expect(html).toContain("Copago");
    expect(html).toContain("4 pac.");
  });

  it("CSS: ≥ 768 la grilla de 5 columnas; < 768 card de 2 columnas con el nombre a lo ancho y sin ancho mínimo", () => {
    expect(rule(DESKTOP, ".insurerRow")).toMatch(/grid-template-columns:\s*1\.4fr 110px 110px 80px 80px/);
    expect(rule(DESKTOP, ".insurerList")).toMatch(/min-width:\s*560px/);
    expect(rule(MOBILE, ".insurerList")).toMatch(/min-width:\s*0/);
    expect(rule(MOBILE, ".insurerRow")).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/);
    expect(MOBILE).toMatch(/\.insurerRow > :first-child\s*\{[^}]*grid-column:\s*1 \/ -1/);
  });
});

const condition = (over: Partial<CustomConditionRow>): CustomConditionRow => ({
  id: "c1",
  slug: "lumbalgia",
  name: "Lumbalgia mecánica",
  cie10: "M54.5",
  summary: "Dolor lumbar sin irradiación",
  severity: "MODERATE",
  redFlags: null,
  mechanism: "Sobrecarga",
  createdById: null,
  createdAt: new Date("2026-01-01T12:00:00Z"),
  updatedAt: new Date("2026-01-01T12:00:00Z"),
  ...over,
});

describe("[MB-1e] Diagnósticos como cards < 768", () => {
  const html = wrap(<DiagnosticosPanel conditions={[condition({}), condition({ id: "c2", cie10: null, mechanism: null })]} />);

  it("encabezado y filas con clases; rótulos «CIE-10» y «Mecanismo» en la card", () => {
    expect(html).not.toContain("grid-template-columns:1.6fr");
    expect(html).not.toContain("min-width:600px");
    expect(html.match(/class="[^"]*condRow/g)?.length).toBe(2);
    expect(html).toMatch(/class="[^"]*condHead/);
    expect(html.match(/class="[^"]*cellLabel[^"]*"[^>]*>CIE-10/g)?.length).toBe(2);
    expect(html.match(/class="[^"]*cellLabel[^"]*"[^>]*>Mecanismo/g)?.length).toBe(2);
    expect(html).toContain("Editar");
  });

  it("CSS: < 768 sin encabezado de tabla, sin ancho mínimo y los rótulos de celda visibles", () => {
    expect(rule(DESKTOP, ".condRow")).toMatch(/grid-template-columns:\s*1\.6fr 110px 1fr 90px 110px/);
    expect(rule(DESKTOP, ".cellLabel")).toMatch(/display:\s*none/);
    expect(rule(MOBILE, ".condHead")).toMatch(/display:\s*none/);
    expect(rule(MOBILE, ".condTable")).toMatch(/min-width:\s*0/);
    expect(rule(MOBILE, ".cellLabel")).toMatch(/display:\s*inline/);
  });
});

describe("[MB-1e] onboarding sin 100vh pelado", () => {
  it("`.root` usa 100dvh con 100vh de respaldo (C-MB2)", () => {
    const r = rule(css("components/onboarding/onboarding.module.css"), ".root");
    expect(r).toMatch(/min-height:\s*100vh;\s*min-height:\s*100dvh/);
  });
});

describe("[MB-1e] muro de módulo y 404 de la app a 390", () => {
  const WALL_CSS = css("components/ui/access-wall.module.css");
  it("los links van dentro de `.actions`, que < 768 lleva los `.k-btn` a 44 px (escritorio sin cambios)", () => {
    for (const html of [
      renderToStaticMarkup(<AccessWall module="salaEspera" plan="CLINICA" canBuy />),
      renderToStaticMarkup(<AccessWall module="salaEspera" plan="CLINICA" canBuy={false} />),
      renderToStaticMarkup(<AppNotFound />),
    ]) {
      expect(html).toMatch(/<div class="[^"]*actions[^"]*"[^>]*>(?:<a[^>]*class="k-btn[^"]*"[^>]*>[^<]*<\/a>)+<\/div>/);
    }
    expect(mediaBody(WALL_CSS, "max-width: 767px")).toMatch(/\.actions :global\(\.k-btn\)\s*\{[^}]*min-height:\s*44px/);
    expect(WALL_CSS.replace(/@media[^{]*\{(?:[^{}]*\{[^}]*\})*[^{}]*\}/g, "").trim()).toBe("");
  });
});
