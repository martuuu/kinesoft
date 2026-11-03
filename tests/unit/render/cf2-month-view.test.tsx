import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// La action es la red: se mockea. En SSR los effects no corren, así que con un `initial` que coincide no se llama.
const getAgendaMonthSummary = vi.fn();
vi.mock("@/lib/agenda-month", () => ({ getAgendaMonthSummary: (...a: unknown[]) => getAgendaMonthSummary(...a) }));

import { MonthGrid, MonthView, type MonthViewProps } from "@/components/agenda/views/month-view";
import { monthGridModel } from "@/lib/agenda-month-view-state";
import { monthGridRange } from "@/lib/agenda-client-state";
import { dayKeyRange } from "@/lib/availability/day";
import type { AgendaMonthDay, AgendaMonthSummary } from "@/lib/agenda-month-types";

/**
 * [CF2-MV] D-CF2-7 (plan §29, brief A.4): vista Mes. Render estático (sin jsdom) con un resumen fijo: se afirma el
 * markup (un botón por día con el aria completo, hoy con `aria-current`, fuera del mes atenuado, candado agregado) y el
 * clic se prueba invocando el `onClick` del árbol real de `MonthGrid` (sin hooks). Fechas fijas en DayKeys: TZ=UTC.
 */

const ANCHOR = "2026-11-15";
const TODAY = "2026-11-02";
const R = monthGridRange(ANCHOR);
const PRACS = [
  { id: "p1", name: "Laura Pérez", initials: "LP" },
  { id: "p2", name: "Martín Gómez", initials: "MG" },
];
const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const EXTRA: Record<string, Partial<AgendaMonthDay>> = {
  "2026-11-03": { c: { p1: [5, 1], p2: [7, 2] }, l: { p1: "l", p2: "l" }, d: { p1: "Vacaciones" } },
  "2026-11-04": { c: { p1: [2, 0] }, l: { p2: "p" }, d: { p2: "Reunión" } },
  "2026-11-08": { l: { p1: "x", p2: "x" } },
};

function summary(locationId: string | null = null): AgendaMonthSummary {
  return {
    from: R.from,
    to: R.to,
    locationId,
    days: dayKeyRange(R.from, R.to).map((k) => ({ k, ...(EXTRA[k] ?? {}) })),
  };
}

const props = (over: Partial<MonthViewProps> = {}): MonthViewProps => ({
  initial: summary(),
  anchorDayKey: ANCHOR,
  todayKey: TODAY,
  selectedPractitionerIds: [],
  practitioners: PRACS,
  locationId: null,
  hideNoShow: false,
  showSaturday: true,
  showSunday: true,
  onPickDay: () => {},
  ...over,
});

const view = (over: Partial<MonthViewProps> = {}) => renderToStaticMarkup(<MonthView {...props(over)} />);

/** El `<button>` de un día en el HTML (por su `data-day-key`). */
function cellHtml(html: string, key: string): string {
  const at = html.indexOf(`data-day-key="${key}"`);
  if (at < 0) return "";
  const start = html.lastIndexOf("<button", at);
  return html.slice(start, html.indexOf("</button>", at) + 9);
}

function collectButtons(node: ReactNode, out: ReactElement<{ onClick?: () => void; "data-day-key"?: string }>[] = []) {
  if (Array.isArray(node)) node.forEach((n) => collectButtons(n, out));
  else if (isValidElement(node)) {
    const el = node as ReactElement<{ children?: ReactNode; onClick?: () => void }>;
    // `MonthCell` y `PractitionerBadge` no tienen hooks: se expanden llamándolos (el árbol real, no un doble).
    if (typeof el.type === "function") return collectButtons((el.type as (p: unknown) => ReactNode)(el.props), out);
    if (el.type === "button") out.push(el);
    collectButtons(el.props.children, out);
  }
  return out;
}

describe("[CF2-MV5] Mes con un resumen fijo", () => {
  it("[CF2-MV5a] un botón por día de la grilla (6 semanas × 7), con el aria del brief", () => {
    const html = view();
    expect(html.match(/data-day-key=/g)).toHaveLength(42);
    expect(cellHtml(html, "2026-11-03")).toContain(
      'aria-label="Martes 3 de noviembre: 12 turnos (Laura Pérez 5, Martín Gómez 7), bloqueado: Vacaciones. Ver el día"'
    );
    expect(getAgendaMonthSummary).not.toHaveBeenCalled();
  });

  it("[CF2-MV5b] hoy con aria-current; fuera del mes atenuado", () => {
    const html = view();
    expect(cellHtml(html, TODAY)).toContain('aria-current="date"');
    expect(html.match(/aria-current="date"/g)).toHaveLength(1);
    expect(cellHtml(html, "2026-10-26")).toContain('data-in-month="false"');
    expect(cellHtml(html, "2026-11-10")).toContain('data-in-month="true"');
  });

  it("[CF2-MV5c] estados del día: bloqueado (rayado + «Bloqueado» + motivo en tooltip), parcial, sin atención", () => {
    const html = view();
    const tue = cellHtml(html, "2026-11-03");
    expect(tue).toContain('data-day-status="locked"');
    expect(tue).toContain('title="Bloqueado: Vacaciones"');
    expect(tue).toContain(">Bloqueado<");
    const wed = cellHtml(html, "2026-11-04");
    expect(wed).toContain('data-day-status="partial"');
    expect(wed).toContain('data-month-lock-glyph="partial"');
    const sun = cellHtml(html, "2026-11-08");
    expect(sun).toContain('data-day-status="off"');
    expect(sun).toContain(">Sin atención<");
    // El candado no es accionable desde Mes: ningún botón adentro del botón del día.
    expect(tue.match(/<button/g)).toHaveLength(1);
  });

  it("[CF2-MV5d] cantidad de los elegidos; iniciales solo con varios visibles; ausentes restados si se ocultan", () => {
    const both = cellHtml(view(), "2026-11-03");
    expect(both).toContain('data-month-count="12"');
    expect(both).toContain('data-initials="LP"');
    expect(both).toContain('data-initials="MG"');
    const one = cellHtml(view({ selectedPractitionerIds: ["p2"] }), "2026-11-03");
    expect(one).toContain('data-month-count="7"');
    expect(one).not.toContain("data-initials=");
    expect(cellHtml(view({ hideNoShow: true }), "2026-11-03")).toContain('data-month-count="9"');
    // Con el que está abierto elegido, el miércoles queda abierto (el parcial era del otro).
    expect(cellHtml(view({ selectedPractitionerIds: ["p1"] }), "2026-11-04")).toContain('data-day-status="open"');
  });

  it("[CF2-MV5e] sáb/dom según prefs: sin fin de semana, 5 columnas", () => {
    const html = view({ showSaturday: false, showSunday: false });
    expect(html.match(/data-day-key=/g)).toHaveLength(30);
    expect(html).not.toContain('data-day-key="2026-11-08"');
    expect(html).toContain("--month-cols:5");
  });

  it("[CF2-MV5f] clic en un día → onPickDay(ese día)", () => {
    const picked: string[] = [];
    const model = monthGridModel(summary(), {
      monthKey: R.monthKey,
      todayKey: TODAY,
      selectedIds: [],
      practitioners: PRACS,
      hideNoShow: false,
      showSaturday: true,
      showSunday: true,
    });
    const tree = MonthGrid({ model, monthKey: R.monthKey, onPickDay: (k) => picked.push(k) });
    const days = collectButtons(tree).filter((b) => b.props["data-day-key"]);
    expect(days).toHaveLength(42);
    days.find((b) => b.props["data-day-key"] === "2026-10-30")?.props.onClick?.();
    days.find((b) => b.props["data-day-key"] === "2026-11-03")?.props.onClick?.();
    expect(picked).toEqual(["2026-10-30", "2026-11-03"]);
  });
});

describe("[CF2-MV6] cargando, vacío y error", () => {
  it("[CF2-MV6a] sin `initial` → cargando (esqueleto + texto para el lector), sin grilla", () => {
    const html = view({ initial: null });
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Cargando el mes");
    expect(html).not.toContain("data-day-key=");
  });

  it("[CF2-MV6b] un `initial` de otra sede o de otro mes no se usa (hay que pedirlo)", () => {
    expect(view({ locationId: "loc-1" })).toContain("Cargando el mes");
    expect(view({ anchorDayKey: "2026-12-10" })).toContain("Cargando el mes");
    expect(view({ initial: summary("loc-1"), locationId: "loc-1" })).toContain("data-day-key=");
  });

  it("[CF2-MV6c] mes sin turnos de los elegidos → aviso en voseo, la grilla sigue (los candados importan)", () => {
    const empty: AgendaMonthSummary = { ...summary(), days: summary().days.map((d) => ({ k: d.k, l: d.l, d: d.d })) };
    const html = view({ initial: empty });
    expect(html).toContain("No hay turnos en noviembre de 2026");
    expect(html).toContain("data-day-key=");
  });

  it("[CF2-MV6d] fuente: pide con getAgendaMonthSummary, se suscribe al canal con messagesTouchRange + coalescer y onResync", () => {
    const s = src("components/agenda/views/month-view.tsx");
    expect(s).toMatch(/getAgendaMonthSummary\(/);
    expect(s).toMatch(/messagesTouchRange\(/);
    expect(s).toMatch(/createRefetchCoalescer\(/);
    expect(s).toMatch(/onResync\(/);
    expect(s).toMatch(/No pudimos cargar el mes/);
    expect(s).toMatch(/Reintentar/);
  });

  it("[CF2-ZF2-10] encabezado de días AA y, en mobile, el glifo del estado del día se mantiene", () => {
    // ZB-10: 10 px navy-500 a opacidad .75 no llegaba a 4,5:1; y en mobile el glifo era lo único que decía
    // «bloqueado/sin atención» además del fondo (las palabras se ocultan por ancho).
    const css = src("components/agenda/views/month-view.module.css");
    const head = /\.headDay \{[^}]*\}/.exec(css)?.[0] ?? "";
    expect(head).toContain("color: var(--navy-500)");
    expect(head).not.toMatch(/opacity/);
    const mobile = css.slice(css.indexOf("@media (max-width: 767px)"));
    expect(mobile).not.toMatch(/\.glyph \{\s*display: none;/);
    // «Sin atención» también lleva glifo (antes solo bloqueado/parcial): en mobile es el canal no cromático.
    const sun = cellHtml(view(), "2026-11-08");
    expect(sun).toContain('data-month-off-glyph=""');
    expect(cellHtml(view(), "2026-11-03")).not.toContain("data-month-off-glyph");
  });

  it("[CF2-MV6e] mobile: 7 columnas con celda mínima de 44 px; transiciones fuera con reduced motion", () => {
    const css = src("components/agenda/views/month-view.module.css");
    expect(css).toMatch(/@media \(max-width: 767px\)/);
    expect(css).toMatch(/min-height: 44px/);
    expect(css).toMatch(/prefers-reduced-motion: reduce/);
  });
});
