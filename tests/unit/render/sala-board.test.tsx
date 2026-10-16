import { beforeAll, describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// [PF1.1-sala] Las caras de /sala, el cuerpo del escritorio y el modal de cobro van con `next/dynamic` (C-PF2).
// `renderToStaticMarkup` no espera Suspense: el mock resuelve cada `import()` en `beforeAll` (hasta que no aparecen
// cargas nuevas: el shell del escritorio declara las suyas al importarse) y después renderiza el componente REAL.
const { dynamicLoads } = vi.hoisted(() => ({ dynamicLoads: [] as Promise<unknown>[] }));
vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<import("react").ComponentType<Record<string, unknown>>>) => {
    let Loaded: import("react").ComponentType<Record<string, unknown>> | null = null;
    dynamicLoads.push(loader().then((C) => (Loaded = C)));
    return function DynamicMock(props: Record<string, unknown>) {
      return Loaded ? <Loaded {...props} /> : null;
    };
  },
}));
beforeAll(async () => {
  let seen = -1;
  while (seen !== dynamicLoads.length) {
    seen = dynamicLoads.length;
    await Promise.all(dynamicLoads);
  }
});

// Red y server actions mockeadas (anti-false-green: se renderiza el SalaClient
// real con el provider realtime real en su valor por defecto, `off`).
vi.mock("@/lib/bookings", () => ({ listAgendaBookings: vi.fn(), markReceptionAction: vi.fn() }));
vi.mock("@/lib/preferences", () => ({ updateAgendaViewPrefs: vi.fn(), updateUserPreferences: vi.fn() }));
// RX-1a: el escritorio (RX-1b) se reemplaza por un testigo que expone lo que SalaClient le pasa; acá se prueba
// la elección de cara y el contrato `SalaLive`, no el escritorio (tiene su propio test).
vi.mock("@/components/sala/desk/reception-desk", () => ({
  ReceptionDesk: (p: {
    live: { entries: unknown[]; rows: unknown[]; dayKey: string; viewer: { canCollect: boolean }; roomById: unknown };
    layout: string;
    viewer: { canCollect: boolean };
  }) => (
    <div
      data-testid="desk"
      data-layout={p.layout}
      data-entries={p.live.entries.length}
      data-rows={p.live.rows.length}
      data-day={p.live.dayKey}
      data-can-collect={String(p.viewer.canCollect)}
      data-live-can-collect={String(p.live.viewer.canCollect)}
      data-rooms={p.live.roomById ? Object.keys(p.live.roomById).join(",") : "none"}
    />
  ),
}));
vi.mock("@/lib/sala-bookings", () => ({ listSalaBookings: vi.fn() }));
// El provider realtime real (valor por defecto `off`); su action de token es
// "use server" (sesión, Prisma) y nunca se invoca con `off`.
vi.mock("@/lib/realtime-token", () => ({ mintRealtimeToken: async () => ({ ok: false, error: "realtime-off" }) }));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));

import { SalaClient } from "@/components/sala/sala-client";
import { salaDayLabel } from "@/components/sala/sala-day-label";
import { TweaksProvider } from "@/components/layout/tweaks-context";
import { deskViewer } from "@/lib/reception-desk-state";
import { SALA_CSS } from "@/components/sala/sala-css";
import SalaLoading from "@/app/(app)/sala/loading";
import { salaViewer } from "@/lib/sala-board-state";
import type { BookingDTO } from "@/components/agenda/agenda-utils";

const DAY = "2026-10-14";
const at = (h: string) => new Date(`${DAY}T${h}:00-03:00`).toISOString();
const NOW = at("10:00");

function dto(id: string, h: string, over: Partial<BookingDTO> = {}): BookingDTO {
  return {
    id, scheduledFor: at(h), durationMin: 45, status: "CONFIRMED", serviceId: "s", serviceName: "Kinesiología",
    serviceColor: "#3d74b5", practitionerId: "p1", patientId: `pat-${id}`, patientName: `Paciente ${id}`,
    patientCondition: null, obraSocial: "Particular", copagoCents: 0, updatedAt: at("08:00"), notes: null,
    title: null, description: null, patientAccess: "full", isOverbooked: false, arrivedAt: null,
    attendingAt: null, calledAt: null, roomId: null, canOperate: true, ...over,
  };
}

const ROWS = [
  dto("box", "09:30", { arrivedAt: at("09:20"), calledAt: at("09:33"), attendingAt: at("09:35"), roomId: "r1" }),
  dto("llamado", "09:45", { arrivedAt: at("09:40"), calledAt: at("09:58"), roomId: "r2" }),
  dto("sala1", "09:50", { arrivedAt: at("09:52"), roomId: "r2" }),
  dto("demorado", "09:40"),
  dto("prox", "10:40", { patientId: null, patientName: "Juan Invitado", patientAccess: "none" }),
  dto("tarde", "12:00"),
  dto("tarde2", "15:00", { isOverbooked: true }),
  dto("hecho", "08:30", { status: "COMPLETED" }),
  dto("p2", "09:55", { practitionerId: "p2", arrivedAt: at("09:50") }),
];
const PRACTITIONERS = [
  { id: "p1", name: "Ana Pérez", initials: "AP" },
  { id: "p2", name: "Bruno Sosa", initials: "BS" },
];
const ROOMS = [
  { id: "r1", name: "Consultorio 1", capacity: 1 },
  { id: "r2", name: "Gimnasio", capacity: 3 },
];
const SECRETARIA = salaViewer(null, ["agenda.viewAll", "agenda.reception", "agenda.operateAll"]);
const BILLING = salaViewer(null, ["agenda.viewAll", "billing.manage"]);

function render(over: Partial<Parameters<typeof SalaClient>[0]> = {}) {
  return renderToStaticMarkup(
    <SalaClient
      dayKey={DAY}
      initialNow={NOW}
      initialRows={ROWS}
      practitioners={PRACTITIONERS}
      rooms={ROOMS}
      viewer={SECRETARIA}
      initialGroupBy="practitioner"
      {...over}
    />
  );
}

describe("[SV10a] /sala render", () => {
  it("por profesional: columnas, bandas en orden y acciones de la Secretaria", () => {
    const html = render();
    expect(html).toContain("Sala de espera");
    // Columnas de los profesionales con turnos hoy, en orden.
    expect(html.indexOf(">Ana Pérez</h2>")).toBeGreaterThan(-1);
    expect(html.indexOf(">Ana Pérez</h2>")).toBeLessThan(html.indexOf(">Bruno Sosa</h2>"));
    // Una sola <ul> por columna, con separadores de banda en orden.
    const col = html.slice(html.indexOf(">Ana Pérez</h2>"), html.indexOf(">Bruno Sosa</h2>"));
    expect(col.split("<ul").length - 1).toBe(1);
    const order = ["En atención", "Llamado", "En sala", "Demorados", "Próximos"].map((l) => col.indexOf(`<span>${l}</span>`));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Acciones con la primaria correcta y el deshacer con su hint.
    expect(html).toContain('aria-label="Llamar: Paciente sala1, 09:50"');
    expect(html).toContain('aria-label="En atención: Paciente llamado, 09:45"');
    expect(html).toContain('aria-label="Deshacer (vuelve a En sala): Paciente llamado, 09:45"');
    expect(html).toContain('aria-label="Llegó: Paciente demorado, 09:40"');
    // La card dice el estado con texto (no solo con color) y la sala en «Por profesional».
    expect(html).toContain("Llamado 2&#x27;");
    expect(html).toContain("Gimnasio");
    // Invitado / sobreturno no se muestran hasta abrir «más tarde», salvo el invitado de Próximos.
    expect(html).toContain("Invitado");
    // «N más tarde» colapsado.
    expect(html).toContain("2 más tarde");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Paciente tarde2");
    // Atendidos solo en el contador.
    expect(html).not.toContain("Paciente hecho");
    expect(html).toMatch(/Atendidos hoy<\/dt><dd><span[^>]*>1<\/span>/);
  });

  it("por sala: salas activas con ocupación y el profesional en la card", () => {
    const html = render({ initialGroupBy: "room" });
    expect(html).toContain(">Consultorio 1</h2>");
    expect(html).toContain(">Gimnasio</h2>");
    expect(html).toContain(">Sin sala</h2>");
    expect(html).toContain('aria-label="1 de 1 lugar ocupado"');
    expect(html).toContain('aria-label="0 de 3 lugares ocupados"');
    // Iniciales del profesional en la card (canal no cromático).
    expect(html).toContain('data-initials="AP"');
    expect(html).toContain('data-initials="BS"');
    expect(html).toContain('aria-pressed="true"><span class="sala-seg-thumb"');
  });

  it("control «Por profesional | Por sala» solo con salas activas; sin salas cae a profesional", () => {
    expect(render()).toContain("Por sala");
    const sinSalas = render({ rooms: [], initialGroupBy: "room" });
    expect(sinSalas).not.toContain("Por sala");
    expect(sinSalas).toContain(">Ana Pérez</h2>");
  });

  it("PD-13: el markup no contiene título, notas, descripción, condición ni título del plan", () => {
    const html = render({
      initialRows: [
        dto("x", "09:50", {
          arrivedAt: at("09:51"),
          title: "TITULO-SECRETO",
          description: "DESCRIPCION-SECRETA",
          notes: "NOTA-SECRETA",
          patientCondition: "CONDICION-SECRETA",
          programId: "prog",
          plan: { discipline: "KINESIOLOGY", ordinal: 3, totalLive: 10, title: "PLAN-SECRETO" },
        }),
      ],
    });
    expect(html).toContain("Paciente x");
    expect(html).not.toMatch(/TITULO-SECRETO|DESCRIPCION-SECRETA|NOTA-SECRETA|CONDICION-SECRETA|PLAN-SECRETO/);
    // El chip del plan sí está (sin título).
    expect(html).toContain("3/10");
  });

  it("BILLING: el tablero se ve pero sin acciones", () => {
    const html = render({ viewer: BILLING });
    expect(html).toContain("Paciente sala1");
    expect(html).not.toContain('class="sala-btn"');
  });

  it("profesional: botones solo en sus filas", () => {
    const html = render({ viewer: salaViewer("p2", ["agenda.viewAll", "agenda.reception", "clinical.read"]) });
    expect(html).toContain('aria-label="Llamar: Paciente p2, 09:55"');
    // Las filas ajenas no tienen botones (la card sí se ve, con su aria-label de grupo).
    expect(html).not.toMatch(/<button[^>]*aria-label="[^"]*Paciente sala1, 09:50"/);
    expect(html).toContain('aria-label="En sala: Paciente sala1, 09:50"');
    // Su columna primero.
    expect(html.indexOf(">Bruno Sosa</h2>")).toBeLessThan(html.indexOf(">Ana Pérez</h2>"));
  });

  it("vacíos: «Hoy no hay turnos» y «Nadie en la sala por ahora» con los próximos", () => {
    const vacio = render({ initialRows: [] });
    expect(vacio).toContain("Hoy no hay turnos");
    expect(vacio).not.toContain(`class="sala-board`);
    const sinGente = render({ initialRows: [dto("prox", "10:30")] });
    expect(sinGente).toContain("Nadie en la sala por ahora");
    expect(sinGente).toContain("Paciente prox");
  });

  it("anuncio de llamado: región role=status aria-live siempre presente, vacía al abrir", () => {
    const html = render();
    expect(html).toContain('<div class="sala-call" role="status" aria-live="polite" aria-atomic="true"></div>');
  });

  it("[FX2a · A2] la banda «Pase …» es overlay del bloque sticky: no está en el flujo del tablero", () => {
    const html = render();
    const top = html.indexOf('<div class="sala-top">');
    const callAt = html.indexOf('<div class="sala-call"');
    const boardAt = html.indexOf('class="sala-board');
    expect(top).toBeGreaterThan(-1);
    expect(callAt).toBeGreaterThan(top);
    expect(callAt).toBeLessThan(boardAt);
    // Absoluta, colgada del bloque sticky (posicionado): aparecer/irse no mueve nada.
    expect(SALA_CSS).toMatch(/\.sala-top \{ position: sticky;/);
    expect(SALA_CSS).toMatch(/\.sala-call \{ position: absolute;[^}]*top: calc\(100% \+ 10px\)/);
    expect(SALA_CSS).toMatch(/@media \(max-width: 767px\) \{[^@]*\.sala-top \{ position: relative; \}/);
  });

  it("[FX2a · A2] «Nadie en la sala por ahora» va en el hueco fijo del header, no arriba del tablero", () => {
    const sinGente = render({ initialRows: [dto("prox", "10:30")] });
    const status = sinGente.indexOf('<div class="sala-status">');
    expect(status).toBeGreaterThan(-1);
    expect(sinGente.indexOf("Nadie en la sala por ahora")).toBeGreaterThan(status);
    expect(sinGente.indexOf("Nadie en la sala por ahora")).toBeLessThan(sinGente.indexOf("</header>"));
    expect(sinGente).not.toContain('class="sala-note"');
    // Con gente el hueco existe igual (vacío): su alto ya está reservado.
    expect(render()).toContain('<div class="sala-status"></div>');
    expect(SALA_CSS).toMatch(/\.sala-status \{[^}]*min-height: 20px/);
  });

  it("[FX2a · A3] popLayout: la lista es el padre posicionado y el cuerpo de la columna recorta", () => {
    expect(SALA_CSS).toMatch(/\.sala-list \{ position: relative;/);
    expect(SALA_CSS).toMatch(/\.sala-item \{ position: relative; \}/);
    expect(SALA_CSS).toMatch(/\.sala-col-body \{[^}]*overflow-y: auto/);
  });

  it("[FX2a · M1/Baja] card: data-booking-id, foco programático y la banda en su aria-label; separadores aria-hidden", () => {
    const html = render();
    expect(html).toMatch(/<div class="sala-card" role="group" aria-label="En sala: Paciente sala1, 09:50" tabindex="-1" data-booking-id="sala1"/);
    expect(html).toContain('aria-label="Llamado: Paciente llamado, 09:45"');
    // El anillo ya no vive en la card (no se remonta para latir).
    expect(html).not.toMatch(/class="sala-card k-arrival-ring"/);
    expect(html).toMatch(/<li class="sala-sep" data-band="waiting" aria-hidden="true"/);
    expect(html).not.toContain('role="presentation"');
  });

  it("[FX2a · M3] contadores: «En sala» incluye llamados, «Llamados» en plural", () => {
    const html = render();
    expect(html).toMatch(/En sala<\/dt><dd><span[^>]*>3<\/span>/); // sala1 + p2 + llamado
    expect(html).toMatch(/Llamados<\/dt><dd><span[^>]*>1<\/span>/);
    expect(html).toContain('data-counter="llamados"');
  });

  it("[FX2a · Baja] botón de borrar búsqueda ≥ 32 px y transiciones con los valores de lib/motion", () => {
    expect(SALA_CSS).toMatch(/\.sala-search-clear \{[^}]*width: 32px; height: 32px;/);
    expect(SALA_CSS).toMatch(/\.sala-card \{[^}]*transition: background-color 0\.22s cubic-bezier\(0\.2,0\.8,0\.2,1\)/);
    expect(SALA_CSS).toMatch(/\.sala-btn \{[^}]*transition: transform 0\.15s cubic-bezier\(0\.2,0\.8,0\.2,1\)/);
  });

  it("[FX2a · Baja] loading.tsx reserva el header real: mismas clases, título y los 4 contadores", () => {
    const html = renderToStaticMarkup(<SalaLoading />);
    expect(html).toContain('class="sala-top"');
    expect(html).toContain('class="sala-head"');
    expect(html).toContain("Sala de espera");
    for (const l of ["En sala", "Llamados", "En atención", "Atendidos hoy"]) expect(html).toContain(`<dt>${l}</dt>`);
    expect(html).toContain('class="sala-head-row sala-tools"');
    expect(html).toContain('class="sala-col"');
    expect(SALA_CSS).toMatch(/\.sala-tools \{[^}]*min-height: 38px/);
  });

  it("360 px: columnas apiladas sin scroll horizontal (clases + media query)", () => {
    const html = render();
    expect(html).toContain('class="sala-board k-scroll"');
    expect(html).toContain('class="sala-col"');
    // [MB-1c] C-MB3: la columna única arranca bajo 768 (antes 640); mismas reglas.
    const mobile = SALA_CSS.slice(SALA_CSS.indexOf("@media (max-width: 767px)"));
    expect(mobile).toContain(".sala-board { flex-direction: column; align-items: stretch; overflow: visible;");
    expect(mobile).toContain(".sala-col { flex: none; width: 100%; min-width: 0;");
    expect(mobile).toContain(".sala-btn { min-height: 44px;"); // MB-1c: target de 44 (antes 40)
    // Desktop: columnas de mínimo 260 px con scroll horizontal del tablero.
    expect(SALA_CSS).toContain("min-width: 260px");
    expect(SALA_CSS).toMatch(/\.sala-board \{[^}]*overflow-x: auto/);
    // El <style> viaja en el HTML del server: sin '>' ni comillas en los selectores.
    expect(SALA_CSS).not.toMatch(/[>"']/);
  });

  it("reduced motion: el CSS apaga las transiciones de la card (el estado final se ve completo)", () => {
    expect(SALA_CSS).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^@]*\.sala-card, \.sala-btn,[^{]*\{ transition: none; \}/);
  });
});

describe("[RX-1a] /sala elige la cara y comparte los datos vivos", () => {
  it("board (default, sin provider ni initialLayout): el Tablero de siempre, sin escritorio", () => {
    const html = render();
    expect(html).toContain('class="sala-board k-scroll"');
    expect(html).not.toContain('data-testid="desk"');
    expect(render({ initialLayout: "board" })).toBe(html);
  });

  it.each(["list", "flow"] as const)("%s: monta el escritorio con SalaLive (todas las filas) y no el Tablero", (layout) => {
    const html = render({ initialLayout: layout, viewer: deskViewer(null, ["agenda.viewAll", "agenda.reception", "agenda.operateAll", "billing.manage"]) });
    expect(html).toContain(`data-layout="${layout}"`);
    expect(html).not.toContain("sala-board");
    expect(html).not.toContain('class="sala-call"');
    // Todas las filas del día (el atendido también: el escritorio decide qué lista lo muestra).
    expect(html).toContain(`data-entries="${ROWS.length}"`);
    expect(html).toContain(`data-rows="${ROWS.length}"`);
    expect(html).toContain(`data-day="${DAY}"`);
    expect(html).toContain('data-can-collect="true"');
    expect(html).toContain('data-live-can-collect="true"');
    expect(html).toContain('data-rooms="r1,r2"');
  });

  it("un SalaViewer pelado no cobra; sin salas, roomById es null", () => {
    const html = render({ initialLayout: "list", rooms: [] });
    expect(html).toContain('data-can-collect="false"');
    expect(html).toContain('data-rooms="none"');
  });

  it("Apariencia manda sobre initialLayout (cambio sin recargar)", () => {
    const html = renderToStaticMarkup(
      <TweaksProvider initialReceptionLayout="flow">
        <SalaClient dayKey={DAY} initialNow={NOW} initialRows={ROWS} practitioners={PRACTITIONERS} rooms={ROOMS} viewer={SECRETARIA} initialGroupBy="practitioner" initialLayout="list" />
      </TweaksProvider>
    );
    expect(html).toContain('data-layout="flow"');
    const board = renderToStaticMarkup(
      <TweaksProvider initialReceptionLayout="board">
        <SalaClient dayKey={DAY} initialNow={NOW} initialRows={ROWS} practitioners={PRACTITIONERS} rooms={ROOMS} viewer={SECRETARIA} initialGroupBy="practitioner" initialLayout="flow" />
      </TweaksProvider>
    );
    expect(board).toContain('class="sala-board k-scroll"');
  });

  it("[VX0-b R1] la fecha capitaliza solo la primera letra (sin «De»)", () => {
    expect(salaDayLabel(DAY)).toBe("Miércoles, 14 de octubre");
    expect(render()).toContain('<div class="sala-eyebrow">Miércoles, 14 de octubre</div>');
    expect(SALA_CSS).not.toContain("capitalize");
  });

  it("[VX0-b R2] vacío del día: ícono, explicación y salidas reales; BILLING sin «Nuevo turno»", () => {
    const vacio = render({ initialRows: [] });
    expect(vacio).toContain('class="sala-empty-icon"');
    expect(vacio).toContain('href="/agenda"');
    expect(vacio).toContain('href="/agenda?new=1"');
    expect(vacio).toContain("Nuevo turno");
    const billing = render({ initialRows: [], viewer: BILLING });
    expect(billing).toContain("Ir a la agenda");
    expect(billing).not.toContain("Nuevo turno");
    // «Llamados» resaltado solo con valor > 0 (el header marca `data-active`).
    expect(SALA_CSS).toMatch(/\.sala-counter\[data-counter=llamados\]\[data-active\] \{/);
    expect(SALA_CSS).not.toMatch(/\.sala-counter\[data-counter=llamados\] \{/);
  });
});
