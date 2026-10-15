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
    // [PL-F1c] el «Cobrar» deshabilitado («Próximamente») se quitó: nada de botones a medio hacer.
    expect(html).not.toContain("Próximamente");
    expect(html).not.toContain(">Cobrar<");
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


describe("[SV10b] «Llamar» en Recepción", () => {
  const svRows = [
    dto("sala", "09:50", { arrivedAt: iso("09:45") }),
    dto("llamado", "09:40", { arrivedAt: iso("09:30"), calledAt: iso("09:55") }),
    dto("boxllamado", "09:00", { arrivedAt: iso("08:55"), calledAt: iso("09:02"), attendingAt: iso("09:05") }),
    dto("boxdirecto", "09:10", { arrivedAt: iso("09:05"), attendingAt: iso("09:12") }),
    dto("ajeno", "09:20", { arrivedAt: iso("09:15"), practitionerId: "p2", canOperate: false }),
  ];
  const render = (over: { now?: Date; canOperate?: boolean } = {}) =>
    renderToStaticMarkup(
      <ReceptionView dayKey={DAY} bookings={svRows} practitioners={pr} now={over.now ?? NOW} canOperate={over.canOperate ?? true} onOpenBooking={noop} onChanged={noop} />
    );
  // El <button> completo cuyo aria-label es `label` (para mirar su clase).
  const buttonWith = (html: string, label: string) => {
    const i = html.indexOf(`aria-label="${label}"`);
    expect(i).toBeGreaterThan(-1);
    return html.slice(html.lastIndexOf("<button", i), html.indexOf("</button>", i));
  };

  it("fila en sala de hoy: «Llamar» primario y «En atención» secundario", () => {
    const html = render();
    expect(buttonWith(html, "Marcar Llamar: Paciente sala, 09:50")).toContain("rcp-btn-primary");
    expect(buttonWith(html, "Marcar En atención: Paciente sala, 09:50")).not.toContain("rcp-btn-primary");
  });
  it("fila llamada: tag «Llamado 5'» con el token --rc-called-* y «En atención» primario", () => {
    const html = render();
    expect(html).toContain("Llamado 5&#x27;");
    expect(html).toContain("background:var(--rc-called-bg);color:var(--rc-called-fg)");
    expect(buttonWith(html, "Marcar En atención: Paciente llamado, 09:40")).toContain("rcp-btn-primary");
    expect(html).not.toContain("Marcar Llamar: Paciente llamado");
  });
  it("deshacer: desde llamado vuelve a En sala; desde en atención con llamado vuelve a Llamado, sin llamado a En sala", () => {
    const html = render();
    expect(html).toContain("Deshacer (vuelve a En sala): Paciente llamado, 09:40");
    expect(html).toContain("Deshacer (vuelve a Llamado): Paciente boxllamado, 09:00");
    expect(html).toContain("Deshacer (vuelve a En sala): Paciente boxdirecto, 09:10");
  });
  it("contador «Llamados»", () => {
    const html = render();
    expect(html).toMatch(/Llamados<\/div><div class="rcp-counter-value k-mono">1</);
  });
  it("fuera de hoy no hay «Llamar»", () => {
    const html = render({ now: new Date("2026-10-04T10:00:00-03:00") });
    expect(html).not.toContain("Marcar Llamar");
    expect(html).toContain("«Llamar»");
  });
  it("quien no opera la fila no ve «Llamar» (ni las demás acciones de esa fila)", () => {
    const html = render();
    expect(html).not.toContain("Marcar Llamar: Paciente ajeno");
    expect(html).not.toContain("Deshacer (vuelve a Por llegar): Paciente ajeno");
    expect(render({ canOperate: false })).not.toContain("Marcar Llamar");
  });
  it("tokens --rc-* en vez de literales (en sala, en atención, demorado)", () => {
    const html = renderToStaticMarkup(<ReceptionView dayKey={DAY} bookings={rows} practitioners={pr} now={NOW} canOperate onOpenBooking={noop} onChanged={noop} />);
    expect(html).toContain("background:var(--rc-insala-bg);color:var(--rc-insala-fg)");
    expect(html).toContain("background:var(--rc-attending-bg);color:var(--rc-attending-fg)");
    expect(html).toContain("background:var(--rc-late-bg);color:var(--rc-late-fg);border:1px solid var(--rc-late-border)");
    expect(html).not.toContain("rgba(200,245,100");
  });
});

const withRooms = [
  dto("c2", "09:00", { isOverbooked: false, roomId: "room_c2" }),
  dto("sin", "09:30", { isOverbooked: false, roomId: null }),
  dto("archivada", "10:30", { isOverbooked: false, roomId: "room_vieja" }),
];

describe("[RX-1f] G1 y link al escritorio", () => {
  const render = (over: { now?: Date; canOperate?: boolean } = {}) =>
    renderToStaticMarkup(
      <ReceptionView dayKey={DAY} bookings={rows} practitioners={pr} now={over.now ?? NOW} canOperate={over.canOperate ?? true} onOpenBooking={noop} onChanged={noop} />
    );
  it("[RX-1f] día pasado: sin «Demorado», sin filas resaltadas ni contador en ámbar", () => {
    const html = render({ now: new Date("2026-10-06T10:00:00-03:00") });
    expect(html).toContain("Este día no es hoy");
    expect(html).not.toContain("Demorado ");
    // Atributos, no el selector del CSS embebido (`.rcp-counter[data-warn]`).
    expect(html).not.toMatch(/ data-warn=/);
    expect(html).not.toMatch(/ data-highlight=/);
    expect(html).toContain("Sin marcar");
    expect(html).toMatch(/Demorados<\/div><div class="rcp-counter-value k-mono">0</);
  });
  it("[RX-1f] hoy el demorado sigue destacado y el contador en ámbar", () => {
    const html = render();
    expect(html).toContain("Demorado 20&#x27;");
    expect(html).toMatch(/ data-warn=/);
    expect(html).toMatch(/ data-highlight=/);
  });
  it("[RX-1f] link «Abrir escritorio de Recepción» → /sala solo con agenda.reception + salaEspera", () => {
    const html = render();
    expect(html).toMatch(/<a [^>]*href="\/sala"[^>]*>[^<]*Abrir escritorio de Recepción/);
    expect(render({ canOperate: false })).not.toContain("Abrir escritorio de Recepción");
  });
});
