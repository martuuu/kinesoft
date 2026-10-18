import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  WeekGridView,
  weekCellLineCapacity,
  WEEK_ROW_PX,
  WEEK_LINE_H,
  WEEK_CELL_PAD,
} from "@/components/agenda/views/week-grid-view";
import { TimelineView } from "@/components/agenda/views/timeline-view";
import type { BookingDTO } from "@/components/agenda/agenda-utils";

/**
 * [Z-u2] T3-Z (revisor b): Semana de 15' (A1) y contraste de las etiquetas del Día (M7). Render estático: se afirma
 * el markup que ve la Secretaria.
 */

const DAY = "2026-10-05"; // lunes
const WEEK = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11"];
const iso = (h: string, day = DAY) => new Date(`${day}T${h}:00-03:00`).toISOString();
const noop = () => {};

function dto(id: string, h: string, over: Partial<BookingDTO> = {}): BookingDTO {
  return {
    id,
    scheduledFor: iso(h),
    durationMin: 15,
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

describe("[Z-u2 A1] Semana con filas de 15'", () => {
  const hours15 = { start: 8, end: 12, slotMinutes: 15 };
  const practitioners = [
    { id: "p1", initials: "AP", name: "Ana Pérez" },
    { id: "p2", initials: "BD", name: "Bruno Díaz" },
  ];
  const week = (bookings: BookingDTO[], pracs: typeof practitioners | null = null) =>
    renderToStaticMarkup(
      <WeekGridView
        weekDays={WEEK}
        bookings={bookings}
        onEdit={noop}
        businessHours={hours15}
        showHeader
        showSaturday={false}
        showSunday={false}
        highlight={null}
        practitioners={pracs}
      />
    );

  it("la fila de 15' entra una línea compacta entera (alto útil ≥ línea)", () => {
    expect(weekCellLineCapacity(WEEK_ROW_PX[15])).toBeGreaterThanOrEqual(1);
    expect(WEEK_ROW_PX[15] - 2 * WEEK_CELL_PAD).toBeGreaterThanOrEqual(WEEK_LINE_H);
    expect(week([dto("a", "09:00")])).toContain(`repeat(16, ${WEEK_ROW_PX[15]}px)`);
  });

  it("agregado en una fila de 26 px: en línea, número de 12 px, sin reparto; el title lo dice todo", () => {
    const html = week([dto("a", "09:00"), dto("b", "09:00", { practitionerId: "p2" }), dto("c", "09:00")], practitioners);
    const agg = html.match(/<button[^>]*data-week-cell="aggregate"[^>]*>.*?<\/button>/)?.[0] ?? "";
    expect(agg).not.toBe("");
    expect(agg).toContain("flex-direction:row");
    expect(agg).toContain("padding:0 6px 0 10px");
    expect(agg).toMatch(/font-size:12px[^>]*>3</);
    expect(agg).not.toContain("AP 2 · BD 1<");
    expect(agg).toContain('title="3 turnos · AP 2 · BD 1"');
  });

  it("title siempre, aun sin reparto ni plan", () => {
    const html = week([dto("a", "09:00"), dto("b", "09:00")]);
    expect(html).toMatch(/data-week-cell="aggregate"[^>]*title="2 turnos"|title="2 turnos"[^>]*data-week-cell="aggregate"/);
  });

  it("con filas de 60 el agregado sigue en columna con el reparto visible", () => {
    const html = renderToStaticMarkup(
      <WeekGridView
        weekDays={WEEK}
        bookings={[dto("a", "09:00"), dto("b", "09:00", { practitionerId: "p2" }), dto("c", "09:00")]}
        onEdit={noop}
        businessHours={{ start: 8, end: 12, slotMinutes: 60 }}
        showHeader
        showSaturday={false}
        showSunday={false}
        highlight={null}
        practitioners={practitioners}
      />
    );
    expect(html).toContain("flex-direction:column");
    expect(html).toContain(">AP 2 · BD 1<");
  });
});

describe("[Z-u2 M7] Día: etiquetas de hora con contraste", () => {
  const timeline = (slotMinutes: 15 | 30 | 60) =>
    renderToStaticMarkup(
      <TimelineView
        bookings={[dto("a", "09:00")]}
        dayKey={DAY}
        onCreate={noop}
        onEdit={noop}
        density="comfortable"
        businessHours={{ start: 8, end: 12, slotMinutes }}
        highlight={null}
      />
    );
  const labelStyle = (html: string, t: string) =>
    html.match(new RegExp(`aria-label="Nuevo turno ${t}"[^>]*style="([^"]*)"`))?.[1] ?? "";

  it("15': hora navy-500 600; :30 navy-300 400; :15/:45 navy-300 al 75 % y 10 px", () => {
    const html = timeline(15);
    expect(labelStyle(html, "09:00")).toMatch(/font-weight:600;color:var\(--navy-500\)/);
    expect(labelStyle(html, "09:30")).toMatch(/font-size:11px;font-weight:400;color:var\(--navy-300\)/);
    const q = labelStyle(html, "09:15");
    expect(q).toMatch(/font-size:10px;font-weight:400;color:var\(--navy-300\);opacity:0.75/);
    expect(labelStyle(html, "09:45")).toBe(q);
    expect(html).not.toMatch(/rgba\(15,30,51,0\.2\)|rgba\(15,30,51,0\.28\)/);
  });

  it("30': hora navy-500 600 y :30 navy-300 400", () => {
    const html = timeline(30);
    expect(labelStyle(html, "09:00")).toMatch(/font-weight:600;color:var\(--navy-500\)/);
    expect(labelStyle(html, "09:30")).toMatch(/font-weight:400;color:var\(--navy-300\)/);
  });
});
