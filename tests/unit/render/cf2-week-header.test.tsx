import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WeekStrip } from "@/components/agenda/views/week-strip";
import { WeekGridView } from "@/components/agenda/views/week-grid-view";
import { DayLockButton } from "@/components/agenda/day-lock/day-lock-button";
import type { BookingDTO } from "@/components/agenda/agenda-utils";
import type { AggregatedDayLock } from "@/lib/agenda-client-state";

/**
 * [CF2-WS] D-CF2-6 (plan §29, brief A.3): la Semana tiene UN solo encabezado, la tira linda (variante `columns`) que
 * dibuja `WeekGridView` adentro de su scroll, sticky y con las mismas columnas que la grilla. Antes había dos: la tira
 * de afuera (`agenda-client`) y una fila «Lun 12 🔒» propia de la grilla, desalineadas (`1fr` contra `minmax(0,1fr)`).
 * Render estático (sin jsdom): se afirma el markup; el click se prueba invocando el `onClick` del árbol real.
 */

const WEEK = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"];
const TUE = "2026-10-13";
const WED = "2026-10-14";
const NOW = new Date("2026-10-13T15:00:00.000Z"); // martes 12:00 AR
const hours = { start: 8, end: 12, slotMinutes: 60 };
const noop = () => {};
const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

function dto(id: string, day: string, h: string): BookingDTO {
  const iso = new Date(`${day}T${h}:00-03:00`).toISOString();
  return {
    id,
    scheduledFor: iso,
    durationMin: 45,
    status: "CONFIRMED",
    serviceId: "s-kine",
    serviceName: "Kinesiología",
    serviceColor: "#3d74b5",
    practitionerId: "p1",
    patientId: "pat",
    patientName: `Paciente ${id}`,
    patientCondition: null,
    obraSocial: "Particular",
    copagoCents: 0,
    updatedAt: iso,
    notes: null,
    title: null,
    description: null,
    patientAccess: "full",
    arrivedAt: null,
    attendingAt: null,
    isOverbooked: false,
    programId: null,
    sessionId: null,
    pricedByPlan: false,
    plan: null,
    serviceDiscipline: "KINESIOLOGY",
    patientActiveLinkedPlanDisciplines: [],
  };
}

const LOCKS: Record<string, AggregatedDayLock> = {
  "2026-10-12": { status: "open", detail: null, blockIds: [] },
  [TUE]: { status: "partial", detail: "Reunión", blockIds: ["b1"] },
  [WED]: { status: "locked", detail: "Congreso", blockIds: ["b2"] },
};

const lockFor = (k: string) => {
  const l = LOCKS[k];
  return l ? <DayLockButton state={l.status === "off" ? "open" : l.status} reason={l.detail} onClick={noop} compact /> : null;
};

const grid = (over: Partial<Parameters<typeof WeekGridView>[0]> = {}) =>
  renderToStaticMarkup(
    <WeekGridView
      weekDays={WEEK}
      bookings={[dto("a", TUE, "09:00"), dto("b", TUE, "10:00"), dto("c", "2026-10-12", "09:00")]}
      onEdit={noop}
      businessHours={hours}
      showHeader
      showSaturday={false}
      showSunday={false}
      highlight={null}
      dayLocks={LOCKS}
      renderDayLock={lockFor}
      now={NOW}
      onPickDay={noop}
      {...over}
    />
  );

/** Nunca botón dentro de botón: profundidad de `<button>` abiertos en el markup. */
function maxButtonDepth(html: string): number {
  let depth = 0;
  let max = 0;
  for (const m of html.matchAll(/<(\/?)button\b/g)) {
    depth += m[1] ? -1 : 1;
    max = Math.max(max, depth);
  }
  return max;
}

/** Celda del día `key` en el encabezado (`div[data-day-key]`), con su contenido. */
function headerCell(html: string, key: string): string {
  const head = html.match(/<div[^>]*data-week-header[^>]*>([\s\S]*?)<\/div><div[^>]*data-week-body/)?.[0] ?? "";
  const start = head.indexOf(`data-day-key="${key}"`);
  if (start < 0) return "";
  const next = head.indexOf("data-day-key=", start + 1);
  return head.slice(head.lastIndexOf("<div", start), next < 0 ? undefined : head.lastIndexOf("<div", next));
}

/** Recorre el árbol de elementos de un componente sin hooks (la tira) y junta los `<button>`. */
function collectButtons(node: ReactNode, out: ReactElement<{ onClick?: () => void; "data-day-key"?: string }>[] = []) {
  if (Array.isArray(node)) node.forEach((n) => collectButtons(n, out));
  else if (isValidElement(node)) {
    const el = node as ReactElement<{ children?: ReactNode; onClick?: () => void }>;
    if (el.type === "button") out.push(el);
    collectButtons(el.props.children, out);
  }
  return out;
}

describe("[CF2-WS] Semana: un solo encabezado (D-CF2-6)", () => {
  it("[CF2-WS1] un encabezado, adentro del scroll, sticky y con las columnas de la grilla", () => {
    const html = grid();
    expect(html.match(/data-week-header/g)).toHaveLength(1);
    // Mismas columnas en el encabezado y en el cuerpo (antes `1fr`, que se ensanchaba con el contenido).
    expect(html.match(/grid-template-columns:52px repeat\(5, minmax\(0, 1fr\)\)/g)).toHaveLength(2);
    expect(html).not.toContain("repeat(5, 1fr)");
    // Encabezado sticky dentro de la caja que scrollea (no afuera de la card).
    expect(html).toMatch(/data-week-scroll[^>]*overflow:auto[^>]*>\s*<div[^>]*data-week-header[^>]*position:sticky;top:0/);
    expect(html).toMatch(/data-week-header[^>]*background:var\(--card-bg\)/);
    // El header viejo («Mar 13» en una línea con el candado) no está.
    expect(html).not.toMatch(/<span>Mar 13<\/span>/);
  });

  it("[CF2-WS2] por día: botón (día, número, «N turnos») y el candado como HERMANO; nunca botón en botón", () => {
    const html = grid();
    expect(maxButtonDepth(html)).toBe(1);
    const tue = headerCell(html, TUE);
    expect(tue).toContain('data-day-status="partial"');
    expect(tue).toMatch(/<button[^>]*data-strip-day[^>]*>.*?>mar<.*?>13<.*?>2<span[^>]*> turnos<\/span>.*?<\/button><button[^>]*data-lock-status="partial"/);
    const mon = headerCell(html, "2026-10-12");
    expect(mon).toMatch(/>1<span[^>]*> turno<\/span>/);
    expect(mon).toContain('data-day-status="open"');
  });

  it("[CF2-WS3] día bloqueado: rayado, «Bloqueado» en lugar del conteo y el motivo en el tooltip", () => {
    const wed = headerCell(grid(), WED);
    expect(wed).toContain('data-day-status="locked"');
    // El rayado va por CSS sobre `data-day-status="locked"` (el de la columna bloqueada, sin sumar módulos al first load).
    expect(src("components/agenda/views/views.module.css")).toMatch(
      /\.stripCell\[data-day-status="locked"\]\s*\{\s*background-image: repeating-linear-gradient\(135deg/
    );
    expect(wed).toContain(">Bloqueado<");
    expect(wed).not.toMatch(/ turnos?<\/span>/);
    expect(wed).toContain('title="Bloqueado: Congreso"');
    // Parcial: el motivo también va en el tooltip.
    expect(headerCell(grid(), TUE)).toContain('title="Bloqueado en parte: Reunión"');
  });

  it("[CF2-WS4] HOY con aria-current=\"date\" (uno solo); semana sin hoy, ninguno", () => {
    const html = grid();
    expect(html.match(/aria-current="date"/g)).toHaveLength(1);
    expect(headerCell(html, TUE)).toContain('aria-current="date"');
    expect(grid({ now: new Date("2026-11-03T15:00:00.000Z") })).not.toContain('aria-current="date"');
  });

  it("[CF2-WS5] `showHeader` ya no apaga el encabezado de la Semana (la pref solo es de la tira de Día/Lista)", () => {
    expect(grid({ showHeader: false })).toBe(grid({ showHeader: true }));
  });

  it("[CF2-WS6] clic en un día de la tira de Semana → `onPickDay(dayKey)` (abre ese día en Día)", () => {
    const picked: string[] = [];
    const tree = WeekStrip({
      variant: "columns",
      weekDays: WEEK,
      dayKey: TUE,
      todayKey: TUE,
      bookingsByDay: new Map(),
      showSaturday: false,
      showSunday: false,
      onPick: (k) => picked.push(k),
      dayLocks: LOCKS,
      renderDayLock: lockFor,
    });
    const days = collectButtons(tree).filter((b) => b.props["data-day-key"]);
    expect(days).toHaveLength(5);
    days.find((b) => b.props["data-day-key"] === WED)?.props.onClick?.();
    expect(picked).toEqual([WED]);
  });

  it("[CF2-WS7] picker (Día/Lista) con `dayLocks`: mismo estado de candado, NO interactivo (sin botón extra)", () => {
    const html = renderToStaticMarkup(
      <WeekStrip
        weekDays={WEEK}
        dayKey={TUE}
        bookingsByDay={new Map([[TUE, [dto("a", TUE, "09:00")]]])}
        showSaturday={false}
        showSunday={false}
        onPick={noop}
        dayLocks={LOCKS}
      />
    );
    // Solo los 5 días: el candado es un glifo, no un botón.
    expect(html.match(/<button/g)).toHaveLength(5);
    expect(html).not.toContain("data-lock-status");
    expect(html).toMatch(/data-day-status="locked"[^>]*title="Bloqueado: Congreso"/);
    expect(html).toMatch(/data-day-status="partial"[^>]*title="Bloqueado en parte: Reunión"/);
    expect(html).toContain("data-strip-lock-glyph");
    // Picker: aria-current sigue siendo el día ELEGIDO.
    expect(html.match(/aria-current="date"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="date"[^>]*>.*?>mar<.*?>13</);
  });

  it("[CF2-WS8] picker sin `dayLocks`: igual que antes (sin estado ni glifo)", () => {
    const html = renderToStaticMarkup(
      <WeekStrip weekDays={WEEK} dayKey={TUE} bookingsByDay={new Map()} showSaturday showSunday={false} onPick={noop} />
    );
    expect(html).not.toContain("data-day-status");
    expect(html).not.toContain("data-strip-lock-glyph");
    expect(html).not.toContain("data-strip-day");
    expect(html).toContain("repeat(6, minmax(0, 1fr))");
  });

  it("[CF2-WS9] la pref se rotula como lo que hace ahora: la tira de Día, Lista y Recepción", () => {
    // ZB-8: un solo nombre en Apariencia y Configuración, y el hint dice dónde aparece.
    const tweaks = src("components/layout/tweaks-panel.tsx");
    expect(tweaks).toContain('label="Tira de días"');
    expect(tweaks).toContain('"Arriba de Día, Lista y Recepción."');
    const general = src("components/configuracion/panels/general-panel.tsx");
    expect(general).toContain('label="Tira de días"');
    expect(general).not.toContain("Encabezado de días");
    expect(general).toContain("arriba de Día, Lista y Recepción");
    expect(general).toContain("En Semana el encabezado siempre está");
    expect(general).not.toContain("y el encabezado de la grilla semanal");
  });
});
