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
  return { id, scheduledFor: iso(h), durationMin: 45, status: "CONFIRMED", serviceId: "s", serviceName: "Kinesiología", serviceColor: "#3d74b5", practitionerId: "p1", patientId: "pat", patientName: `Paciente ${id}`, patientCondition: null, obraSocial: "Particular", copagoCents: 0, updatedAt: iso("08:00"), notes: null, title: null, description: null, patientAccess: "full", arrivedAt: null, attendingAt: null, calledAt: null, ...over };
}
const pr = [{ id: "p1", name: "Ana Pérez", initials: "AP" }, { id: "p2", name: "Bruno Sosa", initials: "BS" }];
const noop = () => {};
const rows = [
  dto("box", "09:30", { arrivedAt: iso("09:20"), attendingAt: iso("09:35") }),
  dto("hecho", "08:30", { status: "COMPLETED" }),
  dto("sala", "09:50", { arrivedAt: iso("09:45") }),
  dto("futuro", "10:30", { practitionerId: "p2" }),
];
const render = (bookings = rows, viewer: string | null = null) =>
  renderToStaticMarkup(
    <ReceptionView dayKey={DAY} bookings={bookings} practitioners={pr} now={NOW} canOperate onOpenBooking={noop} onChanged={noop} clinicalNoteViewer={{ practitionerId: viewer, canReadClinical: true }} />
  );
const mobile = (html: string) => html.slice(html.indexOf('class="rcp-m"'));

describe("[AS-0d] Recepción plegable a 390", () => {
  it("secciones por estado con «Esperando» primero, encabezado con botón aria-expanded/aria-controls y conteo", () => {
    const m = mobile(render());
    expect(m.length).toBeGreaterThan(20);
    const order = ["Esperando", "En atención", "Por llegar", "Atendidos"].map((l) => m.indexOf(`>${l}<`));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(m).toMatch(/<h3[^>]*><button[^>]*aria-expanded="true"[^>]*aria-controls="[^"]+"/);
    // Atendidos arranca plegado: su cuerpo lleva `hidden` y su botón aria-expanded=false.
    expect(m).toMatch(/aria-expanded="false"[^>]*aria-controls="([^"]+)"/);
    const id = /aria-expanded="false"[^>]*aria-controls="([^"]+)"/.exec(m)![1];
    expect(m).toMatch(new RegExp(`id="${id}"[^>]*hidden`));
    expect(m).toContain(", 1 turno</span>");
    expect(m).toMatch(/>Atendidos<\/span>/);
  });
  it("la tabla de escritorio sigue igual: un solo encabezado de columnas y el orden de sortForReception", () => {
    const html = render();
    const desk = html.slice(0, html.indexOf('class="rcp-m"'));
    expect(desk.indexOf("Paciente box")).toBeLessThan(desk.indexOf("Paciente hecho"));
    expect(desk.indexOf("Paciente hecho")).toBeLessThan(desk.indexOf("Paciente sala"));
  });
  it("[sala-canoperate-ui-vs-server] turno propio con paciente basic: el profesional ve las acciones (el server las acepta)", () => {
    const own = [dto("propio", "09:50", { arrivedAt: iso("09:45"), patientAccess: "basic", canOperate: false })];
    expect(render(own, "p1")).toContain("Marcar Llamar: Paciente propio, 09:50");
    expect(render(own, "p2")).not.toContain("Marcar Llamar: Paciente propio");
    expect(render(own, null)).not.toContain("Marcar Llamar: Paciente propio");
  });
});
