/**
 * [MB-1d · C-MB3] Pacientes a 390: FAB «Nuevo paciente», búsqueda sticky, fila-card sin checkbox colgado, «⋯» de
 * 44 px, pestañas del perfil con scroll horizontal y fade de borde, y el perfil sin interactivos anidados.
 *
 * Vitest en `node` (sin jsdom, como el resto de `tests/unit/render`): markup real por SSR + el CSS Module real (sin
 * comentarios). Una regla dentro de `@media (max-width: 767px)` no le gana a un `style` inline: por eso varios casos
 * afirman que la propiedad ya NO va inline (el bug de `.cellCheck`: `display: flex` inline pisaba el `display: none`
 * de la card y a 390 cada fila sumaba una cuarta fila con el checkbox). Lo que depende del layout vivo (medidas a
 * 390, CLS) lo mide el revisor B con Playwright.
 *
 * Se mockean solo la red (server actions), el router y `next/dynamic` del drawer de alta; los componentes son los
 * reales.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/pacientes",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, default: actual, cache: <T,>(fn: T) => fn };
});
vi.mock("@/lib/patients", () => ({
  setPatientArchived: vi.fn(),
  bulkArchivePatients: vi.fn(),
  sendPatientPortalInvite: vi.fn(),
  recordEvaScore: vi.fn(),
}));
vi.mock("@/lib/bookings", () => ({ setBookingInsurerPaid: vi.fn(), setBookingCopagoPaid: vi.fn() }));
const net = vi.hoisted(() => ({ getPatientPlans: vi.fn(), getPatientPlanBalances: vi.fn() }));
vi.mock("@/lib/plans-read", () => net);

import { NewPatientButton } from "@/components/patients/new-patient-button";
import { PatientsList } from "@/components/patients/patients-list";
import { PatientsSearchBar } from "@/components/patients/patients-search-bar";
import { PatientRowActions } from "@/components/patients/patient-row-actions";
import { TabsBar, tabsFadeState, scrollDeltaToReveal } from "@/components/patients/profile/tabs-bar";
import { PatientProfile } from "@/components/patients/patient-profile";
import { BulkSelectProvider } from "@/components/patients/bulk-select";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { ToastProvider } from "@/components/ui/toast";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { modulesFor } from "@/lib/tenant-modules";
import type { PatientRow, PatientCore } from "@/lib/patients-types";

const KINE = Array.from(modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: false }));
const ROOT = join(__dirname, "..", "..", "..");
const css = (rel: string) => readFileSync(join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const DIR_CSS = css("components/patients/patients-directory.module.css");
const TABS_CSS = css("components/patients/profile/tabs-bar.module.css");

/** Cuerpo de cada bloque `@media (max-width: 767px)` del CSS (llaves balanceadas). */
function mobileBlocks(source: string, query = "max-width: 767px"): string {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf(`@media (${query})`, from);
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
/** Declaraciones de la regla `selector { … }` (la primera que aparece en `source`). */
function rule(source: string, selector: string): string {
  const re = new RegExp(`(^|[\\s}])${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`);
  return re.exec(source)?.[2] ?? "";
}

function wrap(node: ReactNode) {
  return renderToStaticMarkup(
    <ToastProvider>
      <ConfirmProvider>
        <TenantModulesProvider modules={KINE}>{node}</TenantModulesProvider>
      </ConfirmProvider>
    </ToastProvider>,
  );
}

function row(over: Partial<PatientRow> = {}): PatientRow {
  return {
    id: "p1",
    firstName: "Ana",
    lastName: "García",
    email: "ana@example.test",
    phone: "1155550000",
    documentId: "30111222",
    dateOfBirth: null,
    notes: null,
    createdAt: new Date("2026-01-01T12:00:00Z"),
    activeProgramTitle: null,
    sessionsTotal: 0,
    sessionsDone: 0,
    lastVisit: null,
    upcomingAt: null,
    obraSocial: "OSDE",
    access: "full",
    activePlans: [],
    ...over,
  } as PatientRow;
}

/**
 * Interactivos anidados en el markup (mismo criterio que la auditoría de PF1-Z: `a[href]`/`button` que contienen
 * otro `a[href]`, `button`, `input` visible, `select` o `textarea`). Tokeniza las etiquetas del SSR.
 */
function nestedInteractive(html: string): string[] {
  const found: string[] = [];
  const stack: string[] = [];
  const tagRe = /<(\/?)([a-z][a-z0-9-]*)([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html))) {
    const [, close, name, attrs] = m;
    const interactive =
      (name === "a" && /\shref=/.test(attrs)) ||
      name === "button" ||
      name === "select" ||
      name === "textarea" ||
      (name === "input" && !/type="hidden"/.test(attrs));
    if (close) {
      if ((name === "a" || name === "button") && stack.length && stack[stack.length - 1] === name) stack.pop();
      continue;
    }
    if (interactive && stack.length) found.push(`<${name}${attrs.slice(0, 60)}> dentro de <${stack[stack.length - 1]}>`);
    if (name === "a" || name === "button") {
      // `<a>` sin href no es interactivo pero igual hay que cerrarlo bien: se apila con su nombre.
      if (name === "button" || /\shref=/.test(attrs)) stack.push(name);
    }
  }
  return found;
}

describe("[MB-1d] FAB «Nuevo paciente» (C-MB3 Pacientes)", () => {
  it("el botón de la cabecera sigue igual en escritorio y suma un `.k-fab` con nombre accesible, envuelto en una clase que solo existe < 768", () => {
    const html = renderToStaticMarkup(<NewPatientButton insurers={[]} />);
    // Escritorio: el mismo botón primario con texto (lo envuelve una clase que lo esconde < 768).
    expect(html).toMatch(/class="[^"]*desktopAction[^"]*"[^>]*>.*Nuevo paciente/);
    // Mobile: un FAB de 56 px de la utilidad global, un solo botón (no anidado), con aria-label.
    expect(html).toMatch(/<button[^>]*class="k-fab"[^>]*aria-label="Nuevo paciente"/);
    expect(html).toMatch(/class="[^"]*fabOnly[^"]*"/);
    expect(nestedInteractive(html)).toEqual([]);
    // El drawer de alta no se pinta hasta abrirlo (C-PF2 sigue).
    expect(html).not.toContain("role=\"dialog\"");
  });

  it("CSS: `.fabOnly` no se ve en escritorio y aparece < 768; la acción de escritorio se esconde < 768", () => {
    expect(rule(DIR_CSS, ".fabOnly")).toMatch(/display:\s*none/);
    const mobile = mobileBlocks(DIR_CSS);
    expect(rule(mobile, ".fabOnly")).toMatch(/display:\s*contents/);
    expect(rule(mobile, ".desktopAction")).toMatch(/display:\s*none/);
  });
});

describe("[MB-1d] directorio a 390", () => {
  it("la celda del checkbox no lleva `display` inline (la card < 768 la esconde por clase)", () => {
    const html = wrap(
      <BulkSelectProvider>
        <PatientsList rows={[row()]} archived={false} />
      </BulkSelectProvider>,
    );
    const cell = /<span class="[^"]*cellCheck[^"]*"([^>]*)>/.exec(html);
    expect(cell).not.toBeNull();
    expect(cell![1]).not.toMatch(/display/);
    expect(rule(DIR_CSS, ".cellCheck")).toMatch(/display:\s*flex/);
    expect(rule(mobileBlocks(DIR_CSS), ".cellCheck,\n  .cellLast")).toMatch(/display:\s*none/);
  });

  it("«⋯» de la fila: 28 px en escritorio y 44 px < 768 (por clase: un `width` inline no se pisa desde la media query)", () => {
    const html = wrap(<PatientRowActions patientId="p1" archived={false} patientName="Ana García" />);
    const btn = /<button[^>]*aria-label="Acciones"[^>]*>/.exec(html)![0];
    expect(btn).toMatch(/class="[^"]*rowMenuBtn/);
    expect(btn).not.toMatch(/width:|height:/);
    expect(rule(DIR_CSS, ".rowMenuBtn")).toMatch(/width:\s*28px/);
    expect(rule(mobileBlocks(DIR_CSS), ".rowMenuBtn")).toMatch(/min-width:\s*44px/);
    expect(rule(mobileBlocks(DIR_CSS), ".rowMenuBtn")).toMatch(/min-height:\s*44px/);
  });

  it("búsqueda sticky < 768, debajo de la barra móvil (sticky en 8 px + 56 de alto)", () => {
    const html = wrap(<PatientsSearchBar filter="all" totals={{ all: 3, withProgram: 1, withoutProgram: 2 }} />);
    expect(html).toMatch(/class="[^"]*searchBar/);
    const r = rule(mobileBlocks(DIR_CSS), ".searchBar");
    expect(r).toMatch(/position:\s*sticky/);
    expect(r).toMatch(/top:\s*72px/);
    expect(r).toMatch(/z-index:\s*1[0-9]/);
    // Escritorio: sin sticky (todo `sticky` del archivo vive en el bloque < 768).
    const count = (t: string) => t.split("position: sticky").length - 1;
    expect(count(DIR_CSS)).toBe(count(mobileBlocks(DIR_CSS)));
  });

  it("fila de orden/cobertura < 768: una sola línea con scroll horizontal (el alto no depende de cuántas píldoras entran: CLS)", () => {
    const r = rule(mobileBlocks(DIR_CSS), ".sortRow");
    expect(r).toMatch(/flex-wrap:\s*nowrap/);
    expect(r).toMatch(/overflow-x:\s*auto/);
    expect(r).toMatch(/overscroll-behavior-x:\s*contain/);
  });
});

describe("[MB-1d] pestañas del perfil: scroll horizontal con fade de borde", () => {
  it("la barra sigue siendo el `<nav>` con nombre (P3-Z-F3b) y suma la clase del scroller; los botones, la de 44 px", () => {
    const html = renderToStaticMarkup(
      <TabsBar active="turnos" onChange={() => {}} counts={{ turnos: 3 }} only={["resumen", "turnos"]} />,
    );
    expect(html).toMatch(/^<nav aria-label="Secciones de la ficha" class="[^"]*tabs/);
    expect(html).toMatch(/data-profile-tab="turnos" aria-current="true" class="[^"]*tab/);
    // SSR sin fade (no se sabe el ancho): el efecto lo prende si hay overflow. Es solo `mask`: no mueve layout.
    expect(html).not.toContain("data-fade-start");
    expect(html).not.toContain("data-fade-end");
  });

  it("tabsFadeState: fade al final si queda contenido a la derecha, al inicio si se scrolleó", () => {
    expect(tabsFadeState({ scrollLeft: 0, clientWidth: 400, scrollWidth: 400 })).toEqual({ start: false, end: false });
    expect(tabsFadeState({ scrollLeft: 0, clientWidth: 360, scrollWidth: 900 })).toEqual({ start: false, end: true });
    expect(tabsFadeState({ scrollLeft: 200, clientWidth: 360, scrollWidth: 900 })).toEqual({ start: true, end: true });
    expect(tabsFadeState({ scrollLeft: 540, clientWidth: 360, scrollWidth: 900 })).toEqual({ start: true, end: false });
    // Subpíxeles del zoom no prenden el fade.
    expect(tabsFadeState({ scrollLeft: 0.5, clientWidth: 360, scrollWidth: 360.6 })).toEqual({ start: false, end: false });
  });

  it("scrollDeltaToReveal: la pestaña activa fuera de vista se trae con margen; visible, no se mueve", () => {
    const nav = { left: 0, right: 360 };
    expect(scrollDeltaToReveal(nav, { left: 100, right: 200 })).toBe(0);
    expect(scrollDeltaToReveal(nav, { left: 340, right: 440 })).toBe(440 - 360 + 32);
    expect(scrollDeltaToReveal(nav, { left: -50, right: 40 })).toBe(-50 - 32);
  });

  it("CSS: mask con degradé según data-fade-*, scroller contenido y pestañas de 44 px < 768", () => {
    expect(rule(TABS_CSS, ".tabs")).toMatch(/overscroll-behavior-x:\s*contain/);
    expect(TABS_CSS).toMatch(/\.tabs\[data-fade-end\][^{]*\{[^}]*mask-image:\s*linear-gradient/);
    expect(TABS_CSS).toMatch(/\.tabs\[data-fade-start\][^{]*\{[^}]*mask-image:\s*linear-gradient/);
    expect(rule(mobileBlocks(TABS_CSS), ".tab")).toMatch(/min-height:\s*44px/);
  });
});

describe("[MB-1d] pestaña Archivos a 390", () => {
  it("la grilla `280px 1fr` ya no va inline: < 768 una columna y la tabla scrollea dentro de la card", () => {
    const tsx = readFileSync(join(ROOT, "components/patients/archivos-view.tsx"), "utf8");
    expect(tsx).not.toContain('"280px 1fr"');
    expect(tsx).toContain("styles.tableScroll");
    const c = css("components/patients/archivos-view.module.css");
    expect(rule(c, ".layout")).toMatch(/grid-template-columns:\s*280px 1fr/);
    expect(rule(mobileBlocks(c), ".layout")).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(rule(c, ".tableScroll")).toMatch(/overflow-x:\s*auto/);
    expect(rule(mobileBlocks(c), ".action")).toMatch(/min-height:\s*44px/);
  });

  it("el botón de eliminar (solo ícono) tiene nombre accesible", () => {
    const tsx = readFileSync(join(ROOT, "components/patients/archivos-view.tsx"), "utf8");
    expect(tsx).toMatch(/aria-label=\{`Eliminar \$\{f\.name\}`\}/);
  });
});

describe("[MB-1d] perfil del paciente sin interactivos anidados (C-MB3: hoy 1 → 0)", () => {
  const core = {
    id: "pat_000000abcdef",
    tenantId: "t1",
    firstName: "Lucía",
    lastName: "Gómez",
    documentId: "30111222",
    dateOfBirth: null,
    phone: "1155550000",
    email: "lucia@example.test",
    notes: null,
    diagnosisTitle: null,
    assignedPractitionerId: null,
    coverages: [],
    emergency: null,
    archivedAt: null,
    portalUserId: null,
    userId: null,
    createdAt: new Date("2026-01-01T12:00:00Z"),
    updatedAt: new Date("2026-09-01T12:00:00Z"),
  } as unknown as PatientCore;

  it("Resumen con hero, pestañas y acciones: ningún `a`/`button` contiene otro interactivo", () => {
    const html = wrap(
      <PatientProfile
        patientCore={core}
        recentBookings={[]}
        billableCount={0}
        evaScores={[]}
        capabilities={["plans.manage", "clinical.read", "clinical.write"] as never}
        role="OWNER"
        initialPlans={[]}
        initialTab="resumen"
      />,
    );
    expect(html).toContain('aria-label="Secciones de la ficha"');
    expect(nestedInteractive(html)).toEqual([]);
  });

  it("el detector sí ve un botón dentro de un link (control del propio test)", () => {
    expect(nestedInteractive('<a href="/x"><button type="button">y</button></a>')).toHaveLength(1);
    expect(nestedInteractive('<a href="/x">y</a><button>z</button>')).toEqual([]);
  });
});

void React;
