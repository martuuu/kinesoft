import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/bookings", () => ({ markReceptionAction: vi.fn() }));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));

import { ReceptionView } from "@/components/agenda/reception/reception-view";
import type { BookingDTO } from "@/components/agenda/agenda-utils";

const DAY = "2026-10-05";
const iso = (h: string) => new Date(`${DAY}T${h}:00-03:00`).toISOString();
const NOW = new Date(`${DAY}T10:00:00-03:00`);
function dto(id: string, h: string, over: Partial<BookingDTO> = {}): BookingDTO {
  return { id, scheduledFor: iso(h), durationMin: 45, status: "CONFIRMED", serviceId: "s", serviceName: "Kinesiología", serviceColor: "#3d74b5", practitionerId: "p1", patientId: "pat", patientName: `Paciente ${id}`, patientCondition: null, obraSocial: "Particular", copagoCents: 0, updatedAt: iso("08:00"), notes: null, title: null, description: null, patientAccess: "full", arrivedAt: null, attendingAt: null, ...over };
}
const rows = [
  dto("futuro", "10:30", { practitionerId: "p2" }),
  dto("demorado", "09:40"),
  dto("sala", "09:50", { arrivedAt: iso("09:45") }),
  dto("box", "09:30", { arrivedAt: iso("09:20"), attendingAt: iso("09:35") }),
  dto("hecho", "08:30", { status: "COMPLETED" }),
  dto("guest", "11:00", { patientId: null, patientName: "Juan Invitado", patientAccess: "none" }),
  dto("cancel", "12:00", { status: "CANCELLED" }),
];
const pr = [{ id: "p1", name: "Ana Pérez", initials: "AP" }, { id: "p2", name: "Bruno Sosa", initials: "BS" }];
const noop = () => {};

describe("ReceptionView render", () => {
  it("operable", () => {
    const html = renderToStaticMarkup(<ReceptionView dayKey={DAY} bookings={rows} practitioners={pr} now={NOW} canOperate onOpenBooking={noop} onChanged={noop} />);
    expect(html).toContain("<table");
    expect(html).toContain('scope="col"');
    expect(html).toContain("Demorado 20&#x27;");
    expect(html).toContain("En sala 15&#x27;");
    expect(html).toContain("Marcar Llegó: Paciente demorado, 09:40");
    expect(html).toContain("Deshacer (vuelve a Por llegar): Paciente sala, 09:50");
    expect(html).toContain('title="Próximamente"');
    expect(html).toContain("Invitado");
    expect(html).toContain("1/6");
    // en atención primero
    expect(html.indexOf("Paciente box")).toBeLessThan(html.indexOf("Paciente hecho"));
  });
  it("solo lectura", () => {
    const html = renderToStaticMarkup(<ReceptionView dayKey={DAY} bookings={rows} practitioners={pr} now={NOW} canOperate={false} onOpenBooking={noop} onChanged={noop} />);
    expect(html).not.toContain("Marcar ");
    expect(html).not.toContain(">Acciones<");
    expect(html).toContain("Solo lectura");
  });
  it("otro día: sin Llegó", () => {
    const html = renderToStaticMarkup(<ReceptionView dayKey={DAY} bookings={rows} practitioners={pr} now={new Date(`2026-10-04T10:00:00-03:00`)} canOperate onOpenBooking={noop} onChanged={noop} />);
    expect(html).not.toContain("Marcar Llegó");
    expect(html).toContain("Este día no es hoy");
  });
  it("[SR-U5a] columna Sala solo con salas; sin salas el markup es el de siempre", () => {
    const render = (roomById?: Record<string, { name: string }> | null) =>
      renderToStaticMarkup(
        <ReceptionView dayKey={DAY} bookings={withRooms} practitioners={pr} now={NOW} canOperate onOpenBooking={noop} onChanged={noop} roomById={roomById} />
      );
    const sin = render(undefined);
    expect(sin).not.toContain(">Sala<");
    expect(sin).not.toContain('data-label="Sala"');
    // Catálogo vacío o null = consultorio sin salas: idéntico a no pasar nada.
    expect(render({})).toBe(sin);
    expect(render(null)).toBe(sin);

    const con = render({ room_c2: { name: "Consultorio 2" } });
    expect(con).toContain('<th scope="col">Sala</th>');
    // Una celda por fila (data-label para las cards de mobile), con o sin sala.
    expect(con.split('data-label="Sala"').length - 1).toBe(withRooms.length);
    expect(con).toContain("Consultorio 2");
    // La columna va después de Profesional y antes de Estado.
    expect(con.indexOf(">Profesional<")).toBeLessThan(con.indexOf(">Sala<"));
    expect(con.indexOf(">Sala<")).toBeLessThan(con.indexOf(">Estado<"));
  });
  it("[SRZ-FX2a B5] sala fuera del catálogo = 'Sala archivada' (nunca '—', que es 'sin sala')", () => {
    const html = renderToStaticMarkup(
      <ReceptionView dayKey={DAY} bookings={withRooms} practitioners={pr} now={NOW} canOperate onOpenBooking={noop} onChanged={noop} roomById={{ room_c2: { name: "Consultorio 2" } }} />
    );
    const cell = (id: string) => {
      const i = html.indexOf(`Paciente ${id}<`);
      const j = html.indexOf('data-label="Sala"', i);
      return html.slice(j, html.indexOf("</td>", j));
    };
    expect(cell("archivada")).toContain("Sala archivada");
    expect(cell("sin")).toContain("—");
    expect(cell("sin")).not.toContain("Sala archivada");
    expect(cell("c2")).toContain("Consultorio 2");
  });
});

const withRooms = [
  dto("c2", "09:00", { isOverbooked: false, roomId: "room_c2" }),
  dto("sin", "09:30", { isOverbooked: false, roomId: null }),
  dto("archivada", "10:30", { isOverbooked: false, roomId: "room_vieja" }),
];
