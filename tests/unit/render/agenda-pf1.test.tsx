import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { AgendaToolbar } from "@/components/agenda/agenda-toolbar";
import { ModeToggle, AGENDA_MODE_OPTIONS } from "@/components/agenda/mode-toggle";
import { WeekStrip } from "@/components/agenda/views/week-strip";
import { WeekGridView, weekCellLineCapacity } from "@/components/agenda/views/week-grid-view";
import { TimelineView } from "@/components/agenda/views/timeline-view";
import { ListView } from "@/components/agenda/views/list-view";
import { BookingCard } from "@/components/agenda/grid/booking-card";
import { columnMinWidth } from "@/components/agenda/views/practitioner-day-view";
import type { BookingDTO } from "@/components/agenda/agenda-utils";
import { DEFAULT_AGENDA_VISIBILITY } from "@/lib/agenda-filters";

/**
 * [PF1.1-agenda-a] Vistas y encabezado de la agenda: bundle (C-PF1, sin `motion.`) y pulido de VX0-b (G2-G5, G9).
 * Render estático (sin jsdom): se afirma el markup que ve la Secretaria, no la implementación.
 */

const DAY = "2026-10-05"; // lunes
const WEEK = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"];
const iso = (h: string, day = DAY) => new Date(`${day}T${h}:00-03:00`).toISOString();
const noop = () => {};
const src = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

function dto(id: string, h: string, over: Partial<BookingDTO> = {}): BookingDTO {
  return {
    id,
    scheduledFor: iso(h),
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
    programId: null,
    sessionId: null,
    pricedByPlan: false,
    plan: null,
    serviceDiscipline: "KINESIOLOGY",
    patientActiveLinkedPlanDisciplines: [],
    ...over,
  };
}

describe("[PF1.1-agenda-a] C-PF1: sin framer completo en la carga inicial de /agenda", () => {
  it("los archivos de la sesión no usan `motion.` (solo `m` tras interacción)", () => {
    for (const f of [
      "components/agenda/agenda-client.tsx",
      "components/agenda/agenda-toolbar.tsx",
      "components/agenda/controls.tsx",
      "components/agenda/mode-toggle.tsx",
    ]) {
      const code = src(f);
      expect(code, f).not.toMatch(/<\/?motion\./);
      expect(code, f).not.toMatch(/import\s*\{[^}]*\bmotion\b[^}]*\}\s*from\s*"framer-motion"/);
    }
  });

  it("la vista entra con CSS (`.k-page-in`), sin `initial={{ opacity: 0 }}` que la deje invisible hasta hidratar", () => {
    const code = src("components/agenda/agenda-client.tsx");
    expect(code).toContain('className="k-page-in"');
    expect(code).not.toContain('<AnimatePresence mode="wait">');
  });

  it("modal y drawer del turno siguen con `next/dynamic` (ssr: false) y precarga", () => {
    const code = src("components/agenda/agenda-client.tsx");
    expect(code).toMatch(/const BookingModal = dynamic\(\(\) => import\("\.\/booking-modal"\)[^;]*ssr: false/);
    expect(code).toMatch(/const BookingDrawer = dynamic\(\(\) => import\("\.\/booking-drawer"\)[^;]*ssr: false/);
  });

  it("S5: las pastillas de los segmentados llevan clase, no `style` (sin style mismatch)", () => {
    const toggle = renderToStaticMarkup(
      <ModeToggle mode="day" options={[AGENDA_MODE_OPTIONS.day, AGENDA_MODE_OPTIONS.practitioner]} onChange={noop} />
    );
    expect(toggle).toContain('role="radiogroup"');
    expect(toggle).toContain('aria-checked="true"');
    expect(toggle).not.toMatch(/<button[^>]*style=/);
  });
});

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

describe("[PF1.1-agenda-a] Encabezado (G9)", () => {
  it("«.ics» es un link con look de botón, sin `<button>` adentro de `<a>`", () => {
    const html = toolbar();
    expect(html).toMatch(/<a [^>]*href="\/api\/agenda\/export\?from=2026-10-05"[^>]*class="k-btn[^"]*"/);
    expect(html).not.toMatch(/<a [^>]*>(?:(?!<\/a>).)*<button/);
  });

  it("«⋯» controla las secundarias (.ics y Vista) y «Nuevo turno» queda fuera del menú", () => {
    const html = toolbar();
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*aria-controls="agenda-toolbar-more"/);
    const more = html.slice(html.indexOf('id="agenda-toolbar-more"'));
    expect(more).toContain(".ics");
    expect(more).not.toContain("Nuevo turno");
    expect(html).toContain("Nuevo turno");
  });

  it("selector de vista: grupo con nombre y `aria-pressed`; la fecha con zona AR", () => {
    const html = toolbar();
    expect(html).toContain('role="group" aria-label="Vista de la agenda"');
    expect(html).toMatch(/aria-pressed="true"[^>]*>.*?Día/);
    expect(html).toContain("lunes, 05 de octubre");
  });
});

describe("[PF1.1-agenda-a] Tira de días (G4)", () => {
  it("día elegido con `aria-current=\"date\"` y el conteo en una línea", () => {
    const html = renderToStaticMarkup(
      <WeekStrip
        weekDays={WEEK}
        dayKey={DAY}
        bookingsByDay={new Map([[DAY, [dto("a", "09:00")]]])}
        showSaturday={false}
        showSunday={false}
        onPick={noop}
      />
    );
    expect(html.match(/aria-current="date"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="date"[^>]*>.*?>lun<.*?>5<.*?>1<span[^>]*> turno</);
    expect(html).toContain("repeat(5, minmax(0, 1fr))");
  });
});

describe("[PF1.1-agenda-a] Semana (G2): líneas compactas si entran, agregado suave si no", () => {
  const hours60 = { start: 8, end: 13, slotMinutes: 60 };
  const week = (bookings: BookingDTO[], practitioners: { id: string; initials: string; name: string }[] | null = null) =>
    renderToStaticMarkup(
      <WeekGridView
        weekDays={WEEK}
        bookings={bookings}
        onEdit={noop}
        businessHours={hours60}
        showHeader
        showSaturday={false}
        showSunday={false}
        highlight={null}
        practitioners={practitioners}
      />
    );

  it("capacidad: 50 px → 2 líneas, 34 px → 1, nunca 0", () => {
    expect(weekCellLineCapacity(50)).toBe(2);
    expect(weekCellLineCapacity(34)).toBe(1);
    expect(weekCellLineCapacity(10)).toBe(1);
  });

  it("1 turno: la línea con hora, paciente, barra de servicio y fondo de estado (no un «1 turno» azul)", () => {
    const html = week([dto("a", "09:00", { status: "NO_SHOW" })]);
    expect(html).toContain('data-week-cell="lines"');
    expect(html).not.toContain('data-week-cell="aggregate"');
    expect(html).toMatch(/data-week-line[^>]*border-left:3px solid #3d74b5/);
    expect(html).toMatch(/data-week-line[^>]*background:var\(--warn-bg\)/);
    expect(html).toContain(">Paciente a<");
    expect(html).not.toContain("background:var(--sky-700)");
  });

  it("con varios profesionales, la línea lleva las iniciales (canal no cromático)", () => {
    const html = week([dto("a", "09:00"), dto("b", "09:00", { practitionerId: "p2" })], [
      { id: "p1", initials: "AP", name: "Ana Pérez" },
      { id: "p2", initials: "BD", name: "Bruno Díaz" },
    ]);
    expect(html).toMatch(/aria-hidden="true"[^>]*>AP</);
    expect(html).toMatch(/aria-hidden="true"[^>]*>BD</);
  });

  it("3 turnos en 50 px: agregado en tono suave con barras de servicio y aria que dice la hora", () => {
    const html = week([dto("a", "09:00"), dto("b", "09:00", { serviceColor: "#c0392b" }), dto("c", "09:00")]);
    expect(html).toContain('data-week-cell="aggregate"');
    expect(html).toContain("background:var(--sky-50)");
    expect(html).toContain("background:#c0392b");
    expect(html).toMatch(/aria-label="09:00: 3 turnos\. Ver la lista"/);
  });
});

describe("[PF1.1-agenda-a] Día (G3): fin en la card y filas vacías de los bordes plegadas", () => {
  const timeline = (bookings: BookingDTO[]) =>
    renderToStaticMarkup(
      <TimelineView
        bookings={bookings}
        dayKey={DAY}
        onCreate={noop}
        onEdit={noop}
        density="comfortable"
        businessHours={{ start: 8, end: 22, slotMinutes: 60 }}
        highlight={null}
      />
    );

  it("la card del Día dice «09:00–09:45»; la de columnas no (no entra)", () => {
    expect(timeline([dto("a", "09:00")])).toContain("09:00–09:45");
    const col = renderToStaticMarkup(
      <BookingCard b={dto("a", "09:00")} onEdit={noop} highlight={null} compact sizing={{}} />
    );
    expect(col).not.toContain("09:00–09:45");
  });

  it("turnos de 09 a 10: se ven 08-11 y el resto queda detrás de «Ver 12:00–22:00 (sin turnos)»", () => {
    const html = timeline([dto("a", "09:00"), dto("b", "10:00")]);
    expect(html).toContain("Ver 12:00–22:00 (sin turnos)");
    expect(html).toContain('aria-label="Nuevo turno 11:00"');
    expect(html).toContain('aria-label="Nuevo turno 08:00"');
    expect(html).toContain('aria-label="Nuevo turno 10:00"');
    expect(html).not.toContain('aria-label="Nuevo turno 15:00"');
  });

  it("día sin turnos: el horario entero (ahí se carga el día), sin pliegue", () => {
    const html = timeline([]);
    expect(html).not.toContain("data-fold");
    expect(html).toContain('aria-label="Nuevo turno 21:00"');
  });
});

describe("[PF1.1-agenda-a] Lista (G5)", () => {
  it("«Sin cerrar» en un turno pasado Confirmado; no en uno Atendido ni en uno por venir", () => {
    const now = new Date(`${DAY}T12:00:00-03:00`);
    const html = renderToStaticMarkup(
      <ListView
        bookings={[
          dto("past", "09:00"),
          dto("done", "10:00", { status: "COMPLETED" }),
          dto("later", "15:00"),
        ]}
        onEdit={noop}
        highlight={null}
        now={now}
      />
    );
    expect(html.match(/data-badge="sin-cerrar"/g)).toHaveLength(1);
    expect(html).toMatch(/Paciente past(?:(?!Paciente done).)*Sin cerrar/);
  });

  it("columnas de texto con `minmax(0, …)`: a 1024 con la barra abierta no desborda", () => {
    const html = renderToStaticMarkup(<ListView bookings={[dto("a", "09:00")]} onEdit={noop} highlight={null} />);
    expect(html).toContain("grid-template-columns:70px minmax(0, 1.4fr)");
  });
});

describe("[PF1.1-agenda-a] Densidad «Por profesional»", () => {
  it("4 columnas entran en ~710 px útiles (1024×768 con barra abierta): 56 + 4 × 172", () => {
    expect(56 + 4 * columnMinWidth("comfortable")).toBeLessThanOrEqual(744);
    expect(56 + 5 * columnMinWidth("compact")).toBeLessThanOrEqual(800);
  });
});
