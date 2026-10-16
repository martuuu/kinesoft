import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * MB-Z-F3 · shell y pantallas (revisión visual mbz-review-b, 390×844).
 *
 *  - B1: «Apariencia» y «Cerrar sesión» (pie del sidebar y menú «Más») salían con otra tipografía: `.navButton` traía
 *    `font: inherit`, que (misma especificidad, declarado después) pisaba el `font-size: 13.5px` / `font-weight: 500`
 *    de `.navItem`. Ahora hereda solo familia, interlineado y tracking; tamaño y peso son los del ítem.
 *  - B2: «Mi perfil público» quedaba debajo de «Cerrar sesión» en «Más». Va dentro del pie, antes de Apariencia.
 *  - B3: targets < 44 px a 390: pills/orden de Pacientes (27-30), período de los gráficos del Dashboard (27), switches
 *    de Configuración (52×30 de caja) y acciones del perfil del paciente (36). Todo solo bajo 768: escritorio igual.
 */
vi.mock("next/navigation", () => ({
  usePathname: () => "/agenda",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock("@/lib/dashboard", () => ({ getSessionsChart: async () => [] }));
vi.mock("@/lib/practitioner-public", () => ({ setPractitionerPublicBooking: async () => ({ ok: true, data: undefined }) }));
vi.mock("@/lib/preferences", () => ({ updateUserPreferences: async () => ({ ok: true, data: undefined }) }));

import { MobileNavDrawer } from "@/components/layout/mobile-nav-drawer";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { TenantChoiceProvider } from "@/components/layout/tenant-switcher";
import { SessionsChart } from "@/components/dashboard/sessions-chart";
import { Switch } from "@/components/ui/switch";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { capabilitiesFor } from "@/lib/capabilities";
import { modulesFor } from "@/lib/tenant-modules";

const ROOT = process.cwd();
const raw = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const css = (rel: string) => raw(rel).replace(/\/\*[\s\S]*?\*\//g, "");
const KINE = Array.from(modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: false }));

/** Cuerpo de cada bloque `@media (max-width: 767px)` (llaves balanceadas). */
function mobileBlocks(source: string): string {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf("@media (max-width: 767px)", from);
    if (at < 0) break;
    const open = source.indexOf("{", at);
    let depth = 1;
    let i = open + 1;
    while (depth > 0 && i < source.length) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") depth--;
      i++;
    }
    out.push(source.slice(open + 1, i - 1));
    from = i;
  }
  return out.join("\n");
}
/** Lo que queda FUERA de los bloques `@media (max-width: 767px)` (= escritorio). */
function desktopOnly(source: string): string {
  let out = "";
  let from = 0;
  for (;;) {
    const at = source.indexOf("@media (max-width: 767px)", from);
    if (at < 0) return out + source.slice(from);
    out += source.slice(from, at);
    let depth = 1;
    let i = source.indexOf("{", at) + 1;
    while (depth > 0 && i < source.length) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") depth--;
      i++;
    }
    from = i;
  }
}
/** Declaraciones de la primera regla cuyo selector es exactamente `selector`. */
function rule(source: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return source.match(new RegExp(`(?:^|[}\\s])${esc}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

describe("[MB-Z-F3 · B1] tipografía de los botones del pie del nav", () => {
  const SHELL = css("components/layout/shell.module.css");
  it("`.navButton` no usa el shorthand `font` (pisaba tamaño y peso de `.navItem`); hereda solo la familia", () => {
    const nb = rule(SHELL, ".navButton");
    expect(nb).not.toMatch(/(^|[;\s])font\s*:/);
    expect(nb).not.toMatch(/font-size|font-weight/);
    expect(nb).toMatch(/font-family:\s*inherit/);
    expect(nb).toMatch(/line-height:\s*inherit/);
    const ni = rule(SHELL, ".navItem");
    expect(ni).toMatch(/font-size:\s*13\.5px/);
    expect(ni).toMatch(/font-weight:\s*500/);
  });
});

describe("[MB-Z-F3 · B2] «Mi perfil público» en «Más» antes del pie de cuenta", () => {
  const drawer = (caps: readonly string[]) =>
    renderToStaticMarkup(
      <TenantModulesProvider modules={KINE}>
        <ConfirmProvider>
        <TenantChoiceProvider options={[]} activeTenantId="a" switchTenant={null}>
          <MobileNavDrawer
            open
            onClose={() => {}}
            isPlatformAdmin={false}
            caps={caps as never}
            onOpenAppearance={() => {}}
          />
        </TenantChoiceProvider>
        </ConfirmProvider>
      </TenantModulesProvider>
    );

  it("quien atiende: una sola entrada, dentro del pie, antes de Apariencia y de Cerrar sesión", () => {
    const html = drawer(Array.from(capabilitiesFor("PRACTITIONER")));
    expect(html.match(/Mi perfil público/g)).toHaveLength(1);
    const profile = html.indexOf("Mi perfil público");
    expect(profile).toBeGreaterThan(html.indexOf('aria-label="Secciones"'));
    expect(profile).toBeLessThan(html.indexOf('aria-label="Apariencia"'));
    expect(profile).toBeLessThan(html.indexOf('aria-label="Cerrar sesión"'));
    // Sigue siendo `<a>` (navegación dura a /cuenta/*) con la forma de ítem del pie.
    expect(html).toMatch(/<a href="\/cuenta\/perfil-publico" class="[^"]*navItem[^"]*"/);
  });

  it("la Secretaria no la ve", () => {
    expect(drawer(Array.from(capabilitiesFor("ASSISTANT")))).not.toContain("Mi perfil público");
  });
});

describe("[MB-Z-F3 · B3] targets de 44 px bajo 768 (escritorio sin cambios)", () => {
  it("Pacientes: pills Todos/Con plan/Sin plan, orden, cobertura y buscador a 44 px; `.seg` de escritorio igual", () => {
    const DIR = css("components/patients/patients-directory.module.css");
    const mobile = mobileBlocks(DIR);
    expect(rule(mobile, ".seg")).toMatch(/min-height:\s*44px/);
    expect(mobile).toMatch(/\.sortRow > a[^{]*\{[^}]*min-height:\s*44px/);
    expect(mobile).toMatch(/\.sortRow input:not\(\[type="hidden"\]\)[^{]*\{[^}]*min-height:\s*44px/);
    expect(rule(mobile, ".bareInput")).toMatch(/min-height:\s*44px/);
    expect(rule(desktopOnly(DIR), ".seg")).not.toMatch(/min-height/);
  });

  it("Dashboard: los botones de período (Sesiones e Ingresos) llevan la clase que < 768 sube a 44 px", () => {
    const DASH = css("components/dashboard/dashboard.module.css");
    expect(rule(mobileBlocks(DASH), ".rangeBtn")).toMatch(/min-height:\s*44px/);
    expect(rule(desktopOnly(DASH), ".rangeBtn")).toBe("");
    const html = renderToStaticMarkup(<SessionsChart initialBars={[]} />);
    const btns = html.match(/<button[^>]*aria-pressed[^>]*>/g) ?? [];
    expect(btns).toHaveLength(3);
    for (const b of btns) expect(b).toMatch(/class="[^"]*rangeBtn/);
    // Ingresos: mismo patrón (render exige server actions; se mira el símbolo en el fuente).
    expect(raw("components/dashboard/revenue-card.tsx")).toMatch(/aria-pressed=\{on\}[\s\S]{0,120}className=\{styles\.rangeBtn\}/);
  });

  it("Switch: < 768 la caja del botón mide 52×44 (pista de 30 y perilla igual); escritorio 52×30", () => {
    const SW = css("components/ui/switch.module.css");
    const mobile = mobileBlocks(SW);
    expect(rule(mobile, ".switch")).toMatch(/height:\s*44px/);
    // Transparente también encendido (el `[aria-checked]` de escritorio pesa más que `.switch`).
    expect(mobile).toMatch(/\.switch,\s*\.switch\[aria-checked="true"\]\s*\{\s*background:\s*transparent/);
    expect(mobile).toMatch(/\.switch\[aria-checked="true"\]::before\s*\{\s*background:\s*var\(--sky-700\)/);
    expect(rule(mobile, ".switch::before")).toMatch(/inset:\s*7px 0/);
    expect(rule(mobile, ".thumb")).toMatch(/top:\s*10px/);
    const desk = desktopOnly(SW);
    expect(rule(desk, ".switch")).toMatch(/height:\s*30px/);
    expect(rule(desk, ".thumb")).toMatch(/top:\s*3px/);
    // El render no cambia: mismo botón con role="switch" y perilla.
    const html = renderToStaticMarkup(<Switch on onChange={() => {}} aria-label="Turnos online" />);
    expect(html).toMatch(/<button type="button" role="switch" aria-checked="true" aria-label="Turnos online" class="[^"]*switch[^"]*"><span aria-hidden="true" class="[^"]*thumb/);
  });

  it("perfil del paciente: acciones del hero y «Ver plan» con la clase de 44 px < 768", () => {
    const HERO = css("components/patients/profile/hero.module.css");
    expect(rule(mobileBlocks(HERO), ".action")).toMatch(/min-height:\s*44px/);
    expect(rule(desktopOnly(HERO), ".action")).toBe("");
    const hero = raw("components/patients/profile/hero.tsx");
    // Agregar turno (x2: hero completo y administrativo), Enviar al portal, Editar, Archivar.
    expect(hero.match(/className=\{heroStyles\.action\}/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
    expect(raw("components/patients/share-patient-button.tsx")).toMatch(/className=\{heroStyles\.action\}/);
    for (const f of ["resumen-view.tsx", "sesiones-view.tsx"]) {
      expect(raw(`components/patients/profile/views/${f}`)).toMatch(/className=\{heroStyles\.action\}[^>]*>\s*Ver plan/);
    }
  });
});
