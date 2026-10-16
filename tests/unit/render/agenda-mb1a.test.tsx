import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { AgendaToolbar } from "@/components/agenda/agenda-toolbar";
import { WeekDayList } from "@/components/agenda/views/week-day-list";
import type { BookingDTO } from "@/components/agenda/agenda-utils";
import { DEFAULT_AGENDA_VISIBILITY } from "@/lib/agenda-filters";

/**
 * [MB-1a] Agenda en el celular y en monitores bajos (C-MB3 Agenda, C-MB4 agenda). Render estático (sin jsdom) + el
 * CSS que decide qué se ve en cada ancho (no hay navegador acá: las medidas reales las toma el revisor B).
 */

const DAY = "2026-10-05"; // lunes
const WEEK = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"];
const iso = (h: string, day = DAY) => new Date(`${day}T${h}:00-03:00`).toISOString();
const noop = () => {};
const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const media = (css: string, q: string) => {
  const i = css.indexOf(`@media ${q}`);
  expect(i, q).toBeGreaterThan(-1);
  return css.slice(i, css.indexOf("\n}\n", i));
};

function dto(id: string, h: string, over: Partial<BookingDTO> = {}, day = DAY): BookingDTO {
  return {
    id,
    scheduledFor: iso(h, day),
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
    updatedAt: iso("07:00"),
    notes: null,
    title: null,
    description: null,
    patientAccess: "full",
    arrivedAt: null,
    attendingAt: null,
    isOverbooked: false,
    locationId: null,
    locationName: null,
    isTelemedicine: false,
    telemedicineUrl: null,
    clinicalHidden: false,
    ...over,
  } as BookingDTO;
}

const toolbar = () =>
  renderToStaticMarkup(
    <AgendaToolbar
      anchor={new Date(`${DAY}T12:00:00-03:00`)}
      segment="day"
      segments={["day", "week", "list"]}
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
    />
  );

describe("[MB-1a] FAB «Nuevo turno» y barra en 2 filas (< 768)", () => {
  it("FAB `.k-fab` con nombre, fuera del menú «⋯»; el botón de la barra sigue para escritorio", () => {
    const html = toolbar();
    expect(html).toMatch(/<button type="button" aria-label="Nuevo turno"[^>]*class="k-fab [^"]+"/);
    const more = html.slice(html.indexOf('id="agenda-toolbar-more"'));
    expect(more).not.toContain("Nuevo turno");
    expect(html.match(/Nuevo turno/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("CSS: FAB solo < 768 y el botón de arriba oculto ahí; «⋯» desde 768; controles a 44 px", () => {
    const css = src("components/agenda/agenda-toolbar.module.css");
    expect(css).toMatch(/\.actions > \.fab \{\s*display: none;/);
    const m = media(css, "(max-width: 767px)");
    expect(m).toMatch(/\.actions > \.fab \{\s*display: inline-flex;/);
    expect(m).toMatch(/\.actions > \.createBtn \{\s*display: none;/);
    expect(m).toMatch(/\.secondary \{\s*display: none;/);
    expect(m).toMatch(/\.navBtn \{\s*width: 44px;\s*height: 44px;/);
    expect(m).toMatch(/\.segBtn \{\s*height: 44px;/);
    expect(m).toMatch(/\.moreBtn \{[^}]*width: 44px;[^}]*height: 44px;/);
  });

  it("monitores bajos: sin rótulo «Agenda» y título más chico (solo ≥ 768 y ≤ 760 de alto)", () => {
    const m = media(src("components/agenda/agenda-toolbar.module.css"), "(min-width: 768px) and (max-height: 760px)");
    expect(m).toMatch(/\.eyebrow \{\s*display: none;/);
  });
});

describe("[MB-1a] Semana en el celular = lista agrupada por día (MB-D10)", () => {
  const bookings = [
    dto("b", "11:00"),
    dto("a", "09:00", { serviceColor: "#ff0000", status: "COMPLETED" }),
    dto("c", "10:00", { practitionerId: "p2" }, "2026-10-07"),
    dto("sat", "10:00", {}, "2026-10-10"),
  ];
  const list = (over: Partial<React.ComponentProps<typeof WeekDayList>> = {}) =>
    renderToStaticMarkup(
      <WeekDayList
        weekDays={WEEK}
        showSaturday={false}
        showSunday={false}
        bookings={bookings}
        onEdit={noop}
        highlight={null}
        practitionerById={null}
        roomById={null}
        anchorDayKey="2026-10-07"
        {...over}
      />
    );

  it("un grupo por día visible (lun-vie), con el ancla marcada y los vacíos con «Sin turnos»", () => {
    const html = list();
    expect(html.match(/<section /g)?.length).toBe(5);
    expect(html).toContain(">Lunes 5</h2>");
    expect(html).toContain(">Viernes 9</h2>");
    expect(html).not.toContain("Sábado");
    expect(html).not.toContain("Paciente sat");
    expect(html).toMatch(/<section aria-labelledby="week-list-2026-10-07" aria-current="date"/);
    expect(html.match(/Sin turnos/g)?.length).toBe(3);
  });

  it("filas por hora (no por orden de llegada) con hora · paciente · servicio; regla de color de AGENTS §5", () => {
    const html = list();
    expect(html.indexOf("Paciente a")).toBeLessThan(html.indexOf("Paciente b"));
    expect(html).toMatch(/data-week-list-row="true"[^>]*style="background:var\(--success-bg\);[^"]*border-left:4px solid #ff0000/);
    expect(html).toContain(">09:00</span>");
    expect(html).toContain("Kinesiología");
    expect(html).toContain('data-status="COMPLETED"');
  });

  it("con sábado visible aparece; con resaltado, lo que no coincide se atenúa", () => {
    expect(list({ showSaturday: true })).toContain("Paciente sat");
    const html = list({ highlight: { kind: "service", serviceId: "otro" } });
    expect(html).toContain('data-highlight="dimmed"');
    expect(html).toMatch(/opacity:0.45/);
  });

  it("iniciales del profesional solo con varios en pantalla", () => {
    expect(list()).not.toContain("data-initials");
    const html = list({ practitionerById: { p1: { initials: "AP", name: "Ana Pérez" }, p2: { initials: "BD", name: "Bruno Díaz" } } });
    expect(html).toContain('data-initials="AP"');
    expect(html).toContain('data-initials="BD"');
  });

  it("CSS: la lista solo < 768 y la grilla se oculta ahí; filas ≥ 44 px", () => {
    const css = src("components/agenda/views/views.module.css");
    expect(css).toMatch(/\.weekList \{\s*display: none;/);
    const m = media(css, "(max-width: 767px)");
    expect(m).toMatch(/\.weekGrid \{\s*display: none !important;/);
    expect(css).toMatch(/\.wlRow \{[^}]*min-height: 48px;/);
  });

  it("agenda-client la carga con next/dynamic (no suma al first load) y la precarga en idle", () => {
    const code = src("components/agenda/agenda-client.tsx");
    expect(code).toMatch(/const WeekDayList = dynamic\(\(\) => import\("\.\/views\/week-day-list"\)/);
    expect(code).toContain('void import("./views/week-day-list");');
    expect(code).not.toMatch(/^import [^;]*week-day-list/m);
  });
});

describe("[MB-1a] Swipe de día y alto de la agenda (C-MB3 / C-MB4)", () => {
  const code = src("components/agenda/agenda-client.tsx");
  const css = src("components/agenda/views/views.module.css");

  it("swipe solo en Día, con pointer events y `touch-action: pan-y`", () => {
    expect(code).toContain('onPointerDown={view === "timeline" ? swipe.onPointerDown : undefined}');
    expect(code).toContain('onPointerUp={view === "timeline" ? swipe.onPointerUp : undefined}');
    expect(code).toContain('onPointerCancel={view === "timeline" ? swipe.onPointerCancel : undefined}');
    expect(code).toContain("adjacentVisibleDay(dayKey, delta");
    expect(css).toMatch(/\.swipeDay \{\s*touch-action: pan-y pinch-zoom;/);
  });

  it("alto fijo ≥ 768 solo en vistas de grilla, con dvh y respaldo vh; sin `100vh` inline", () => {
    expect(code).not.toContain("calc(100vh - 60px)");
    expect(code).toContain('view === "timeline" || view === "practitioner" || view === "room" || view === "week"');
    const m = media(css, "(min-width: 768px)");
    expect(m).toMatch(/\.agendaRoot\[data-fit\] \{\s*height: calc\(100vh - 30px\);\s*height: calc\(100dvh - 30px\);/);
    expect(m).toMatch(/\.agendaRoot\[data-fit\]\[data-chrome="topbar"\] \{\s*height: calc\(100vh - 112px\);\s*height: calc\(100dvh - 112px\);/);
  });

  it("«Por profesional»/«Por sala» < 768: grilla acotada con scroll interno y overscroll contenido", () => {
    expect(src("components/agenda/views/day-columns-grid.tsx")).toContain("className={styles.columnsCard}");
    expect(css).toMatch(/\.columnsScroll \{\s*overscroll-behavior: contain;/);
    expect(css).toMatch(/\.columnsCard \{\s*max-height: calc\(100vh/);
  });
});
