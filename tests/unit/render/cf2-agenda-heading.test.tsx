import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgendaToolbar, AgendaNavGroup, agendaMonthTitle } from "@/components/agenda/agenda-toolbar";
import { PractitionerChips } from "@/components/agenda/practitioner-chips";
import { DEFAULT_AGENDA_VISIBILITY } from "@/lib/agenda-filters";
import { scopeHeadingOf, type ScopeHeading, type ViewSegment } from "@/lib/agenda-client-state";

/**
 * [CF2-HD] D-CF2-2 (plan §29, brief A.1 y A.4): el encabezado de la agenda dice QUÉ agenda se mira. Con varios
 * profesionales el h1 es el título de alcance («Tu agenda · Laura Pérez», «Todos los profesionales (5)») y la fecha
 * baja a subtítulo con el candado y «En vivo»; los chips suben debajo del título con la etiqueta «Profesionales».
 * Con un solo profesional (sin slot) el markup es el de siempre. En Mes la navegación es ±1 mes y el título es el mes.
 * Render estático (sin jsdom); el click se prueba invocando el `onClick` del árbol real de `AgendaNavGroup`.
 */

const DAY = "2026-10-05"; // lunes
const noop = () => {};
const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const PEOPLE = [
  { id: "p1", name: "Laura Pérez", initials: "LP" },
  { id: "p2", name: "Martín Gómez", initials: "MG" },
  { id: "p3", name: "Ana Ruiz", initials: "AR" },
  { id: "p4", name: "Sofía Díaz", initials: "SD" },
  { id: "p5", name: "Juan Sosa", initials: "JS" },
];
const heading = (selectedIds: string[], view: "timeline" | "room" = "timeline") =>
  scopeHeadingOf({ view, selectedIds, ordered: PEOPLE, ownPractitionerId: "p1" });

type Extra = {
  scopeHeading?: ScopeHeading | null;
  segment?: ViewSegment;
  anchor?: Date;
  practitionerChips?: ReactNode;
  dayLock?: ReactNode;
};
const toolbar = (x: Extra = {}) =>
  renderToStaticMarkup(
    <AgendaToolbar
      anchor={x.anchor ?? new Date(`${DAY}T12:00:00-03:00`)}
      segment={x.segment ?? "day"}
      segments={["day", "week", "month", "list", "reception"]}
      onSegmentChange={noop}
      hiddenLabel={null}
      onShowAll={noop}
      onNavigateWeeks={noop}
      onToday={noop}
      practitioners={[]}
      practitionerFilterId={null}
      onPractitionerFilterChange={noop}
      density="comfortable"
      onDensityChange={noop}
      visibility={DEFAULT_AGENDA_VISIBILITY}
      onVisibilityChange={noop}
      exportFromKey={DAY}
      onCreate={noop}
      practitionerChips={x.practitionerChips}
      dayLock={x.dayLock}
      {...(x.scopeHeading !== undefined ? { scopeHeading: x.scopeHeading } : {})}
    />
  );

const h1s = (html: string) => [...html.matchAll(/<h1\b[^>]*>(.*?)<\/h1>/g)].map((m) => m[1].replace(/<[^>]+>/g, ""));
const LOCK = <button type="button" data-test-lock="1">Bloquear días</button>;
const CHIPS = <div role="group" aria-label="Profesionales a mostrar" data-test-chips="1" />;

describe("[CF2-HD] título de alcance (D-CF2-2)", () => {
  it("[CF2-HD1] el propio: h1 «Tu agenda · Laura Pérez» con sus iniciales; la fecha es subtítulo con candado", () => {
    const html = toolbar({ scopeHeading: heading(["p1"]), dayLock: LOCK });
    expect(h1s(html)).toEqual(["Tu agenda · Laura Pérez"]);
    expect(html).toMatch(/<h1 class="k-display [^"]*"/);
    // Iniciales decorativas (el nombre ya está escrito en el h1).
    expect(html).toMatch(/<span aria-hidden="true" data-initials="LP"/);
    // La fecha fuera del h1, en el subtítulo, y el candado al lado.
    const sub = html.slice(html.indexOf("</h1>"));
    expect(sub).toMatch(/lunes, 05 de octubre<\/span><button type="button" data-test-lock="1">/);
  });

  it("[CF2-HD2] otro, dos, tres o más y todos", () => {
    expect(h1s(toolbar({ scopeHeading: heading(["p2"]) }))).toEqual(["Agenda de Martín Gómez"]);
    expect(h1s(toolbar({ scopeHeading: heading(["p1", "p2"]) }))).toEqual(["Agenda de Laura Pérez y Martín Gómez"]);
    const three = toolbar({ scopeHeading: heading(["p1", "p2", "p3"]) });
    expect(h1s(three)).toEqual(["3 profesionales: Laura P., Martín G., Ana R."]);
    expect(three).toContain('data-initials="AR"');
    const all = toolbar({ scopeHeading: heading([]) });
    expect(h1s(all)).toEqual(["Todos los profesionales (5)"]);
    // «Todos» no apila 5 círculos: el número ya está en el título.
    expect(all).not.toContain("data-initials=");
    expect(h1s(toolbar({ scopeHeading: heading(["p1"], "room") }))).toEqual(["Por sala · todos los profesionales"]);
  });

  it("[CF2-HD3] sin slot (o null, un profesional): el markup de hoy, la fecha como h1", () => {
    expect(scopeHeadingOf({ view: "timeline", selectedIds: [], ordered: PEOPLE.slice(0, 1), ownPractitionerId: "p1" })).toBeNull();
    const today = toolbar({ dayLock: LOCK, practitionerChips: CHIPS });
    expect(toolbar({ scopeHeading: null, dayLock: LOCK, practitionerChips: CHIPS })).toBe(today);
    expect(h1s(today)).toEqual(["lunes, 05 de octubre"]);
    expect(today).toMatch(/lunes, 05 de octubre<\/h1><button type="button" data-test-lock="1">/);
    expect(today).not.toContain("Profesionales</");
    // Chips donde siempre: después de la fila de arriba, al final del header.
    expect(today).toMatch(/data-test-chips="1"><\/div><\/header>$/);
  });

  it("[CF2-HD4] chips debajo del título con «Profesionales», antes de las acciones en el DOM", () => {
    const html = toolbar({ scopeHeading: heading([]), practitionerChips: CHIPS });
    const iTitle = html.indexOf("</h1>");
    const iLabel = html.indexOf(">Profesionales</span>");
    const iChips = html.indexOf('data-test-chips="1"');
    const iNav = html.indexOf('aria-label="Semana anterior"');
    expect(iTitle).toBeGreaterThan(-1);
    expect(iLabel).toBeGreaterThan(iTitle);
    expect(iChips).toBeGreaterThan(iLabel);
    expect(iNav).toBeGreaterThan(iChips);
    expect(html).not.toMatch(/data-test-chips="1"><\/div><\/header>$/);
  });

  it("[CF2-HD5] a11y: un solo h1 en todos los casos", () => {
    for (const h of [heading(["p1"]), heading(["p1", "p2"]), heading([]), heading([], "room"), null]) {
      expect(h1s(toolbar({ scopeHeading: h })).length).toBe(1);
      expect(h1s(toolbar({ scopeHeading: h, segment: "month" })).length).toBe(1);
    }
  });
});

describe("[CF2-HD] Mes: navegación ±1 mes y título del mes (A.4)", () => {
  it("[CF2-HD6] título «noviembre de 2026» en zona AR (no la del host)", () => {
    expect(agendaMonthTitle(new Date("2026-11-30T12:00:00-03:00"))).toBe("noviembre de 2026");
    // 31-oct 22:30 AR = 1-nov 01:30 UTC: con la zona del host (UTC) diría noviembre.
    expect(agendaMonthTitle(new Date("2026-10-31T22:30:00-03:00"))).toBe("octubre de 2026");
    const html = toolbar({ segment: "month", anchor: new Date("2026-11-03T12:00:00-03:00") });
    expect(h1s(html)).toEqual(["noviembre de 2026"]);
    const scoped = toolbar({ segment: "month", anchor: new Date("2026-11-03T12:00:00-03:00"), scopeHeading: heading([]) });
    expect(h1s(scoped)).toEqual(["Todos los profesionales (5)"]);
    expect(scoped).toContain("noviembre de 2026</span>");
  });

  it("[CF2-HD7] botones «Mes anterior»/«Mes siguiente» que llaman a onNavigateMonths; fuera de Mes, semanas", () => {
    const html = toolbar({ segment: "month" });
    expect(html).toContain('aria-label="Mes anterior"');
    expect(html).toContain('aria-label="Mes siguiente"');
    expect(html).not.toContain("Semana anterior");

    const calls: string[] = [];
    const tree = (segment: ViewSegment, withMonths = true) =>
      AgendaNavGroup({
        segment,
        onNavigateWeeks: (d) => void calls.push(`w${d}`),
        onNavigateMonths: withMonths ? (d) => void calls.push(`m${d}`) : undefined,
        onToday: () => void calls.push("today"),
      });
    const click = (node: ReactNode, label: string) => findByLabel(node, label)?.props.onClick?.();
    click(tree("month"), "Mes anterior");
    click(tree("month"), "Mes siguiente");
    click(tree("week"), "Semana siguiente");
    click(tree("day"), "Semana anterior");
    // Sin `onNavigateMonths` (agenda-client todavía sin cablear) cae en el de semanas: no rompe.
    click(tree("month", false), "Mes siguiente");
    expect(calls).toEqual(["m-1", "m1", "w1", "w-1", "w1"]);
  });
});

describe("[CF2-HD] chips en el encabezado (layout «heading»)", () => {
  const chips = (layout?: "wrap" | "heading") =>
    renderToStaticMarkup(
      <PractitionerChips
        practitioners={PEOPLE.map((p) => ({ ...p, count: 2 }))}
        selectedIds={["p1"]}
        onChange={noop}
        {...(layout ? { layout } : {})}
      />
    );

  it("[CF2-HD8] sin layout: el markup de hoy (32 de alto, wrap inline); heading: 36 y clase para el scroll", () => {
    const today = chips();
    expect(chips("wrap")).toBe(today);
    expect(today).toContain("flex-wrap:wrap");
    expect(today).toContain("height:32px");
    const h = chips("heading");
    expect(h).toContain("height:36px");
    expect(h).not.toContain("height:32px");
    expect(h).toMatch(/<div role="group" aria-label="Profesionales a mostrar" class="[^"]+"/);
    expect(h).not.toContain("flex-wrap:wrap");
  });

  it("[CF2-HD9] CSS: mobile scroll horizontal sin wrap; título 24 → 18 a ≤760 de alto o <768 de ancho", () => {
    const chipsCss = src("components/agenda/practitioner-chips.module.css");
    const m = chipsCss.slice(chipsCss.indexOf("@media (max-width: 767px)"));
    expect(m).toMatch(/flex-wrap:\s*nowrap/);
    expect(m).toMatch(/overflow-x:\s*auto/);
    const hCss = src("components/agenda/agenda-scope-heading.module.css");
    expect(hCss).toMatch(/\.title\s*\{[^}]*font-size:\s*24px/);
    expect(hCss).toMatch(/@media \(max-width: 767px\), \(max-height: 760px\)\s*\{\s*\.title\s*\{\s*font-size:\s*18px/);
  });

  it("[CF2-HD10] el toolbar no importa los chips (siguen lazy en agenda-client)", () => {
    const t = src("components/agenda/agenda-toolbar.tsx");
    expect(t).not.toMatch(/from ["']\.\/practitioner-chips["']/);
    expect(src("components/agenda/agenda-scope-heading.tsx")).not.toMatch(/practitioner-chips/);
  });
});

function findByLabel(node: ReactNode, label: string): ReactElement<{ onClick?: () => void }> | undefined {
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = findByLabel(n, label);
      if (f) return f;
    }
    return undefined;
  }
  if (!isValidElement(node)) return undefined;
  const el = node as ReactElement<{ children?: ReactNode; onClick?: () => void; "aria-label"?: string }>;
  if (el.props["aria-label"] === label) return el;
  return findByLabel(el.props.children, label);
}
