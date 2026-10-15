/**
 * [RX-2b] Escritorio de Recepción, cara B «Flujo»: línea de tiempo «Hoy», franja y tres carriles. Render SSR
 * (`renderToStaticMarkup`) de los componentes REALES (`DeskFlow` dentro del shell `ReceptionDesk` o del
 * `DeskActionsProvider`); se mockean la red (server actions), el router y el toast. Horas AR explícitas y `now` fijo:
 * corre igual con TZ=UTC y AR.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/bookings", () => ({ markReceptionAction: vi.fn(), setBookingCopagoPaid: vi.fn(), listAgendaBookings: vi.fn() }));
vi.mock("@/lib/preferences", () => ({ updateAgendaViewPrefs: vi.fn(), updateUserPreferences: vi.fn() }));
vi.mock("@/lib/realtime-token", () => ({ mintRealtimeToken: async () => ({ ok: false, error: "realtime-off" }) }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/sala",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));

import type { BookingDTO } from "@/components/agenda/agenda-utils";
import type { SalaLive } from "@/components/sala/sala-live-types";
import { ReceptionDesk } from "@/components/sala/desk/reception-desk";
import { DeskFlow, DESK_FLOW_CSS, flowRowSig, flowTimeline, type FlowView } from "@/components/sala/desk/desk-flow";
import { DeskActionsProvider, type DeskActionsApi } from "@/components/sala/desk/desk-actions";
import { formatARS } from "@/lib/format";
import { chronological, deskEntries, deskViewer, type DeskViewer } from "@/lib/reception-desk-state";

const DAY = "2026-10-15";
const at = (h: string) => new Date(`${DAY}T${h}:00-03:00`).toISOString();
const NOW = new Date("2026-10-15T13:42:00Z"); // 10:42 AR

// PD-13: TODAS las filas traen lo clínico lleno; nada de esto puede aparecer en el markup.
const SECRETS = ["DX-SECRETO", "NOTA-SECRETA", "DESC-SECRETA", "COND-SECRETA"];

function dto(id: string, h: string, over: Partial<BookingDTO> = {}): BookingDTO {
  return {
    id, scheduledFor: at(h), durationMin: 45, status: "CONFIRMED", serviceId: "s", serviceName: "Kinesiología",
    serviceColor: "#3d74b5", practitionerId: "p1", patientId: `pat-${id}`, patientName: `Paciente ${id}`,
    patientCondition: "COND-SECRETA", obraSocial: "Particular", copagoCents: 0, updatedAt: at("08:00"),
    notes: "NOTA-SECRETA", title: "DX-SECRETO", description: "DESC-SECRETA", patientAccess: "full",
    isOverbooked: false, arrivedAt: null, attendingAt: null, calledAt: null, roomId: null, canOperate: true,
    paymentStatus: "UNPAID", ...over,
  };
}

const ROWS: BookingDTO[] = [
  dto("box", "10:00", { patientName: "Martín Suárez", arrivedAt: at("09:55"), calledAt: at("10:03"), attendingAt: at("10:05"), roomId: "r1" }),
  dto("llamado", "10:30", { patientName: "Laura Paz", practitionerId: "p2", arrivedAt: at("10:20"), calledAt: at("10:40") }),
  dto("sala", "10:40", { arrivedAt: at("10:35") }),
  dto("tarde", "10:20", { practitionerId: "p2", arrivedAt: at("10:10") }), // en sala y ya pasó su hora
  dto("demorado", "10:15", { practitionerId: "p2" }),
  dto("prox", "11:00", { obraSocial: "OSDE", isOverbooked: true }),
  dto("lejos", "12:30"),
  dto("cobrar", "09:00", { status: "COMPLETED", copagoCents: 600000, obraSocial: "OSDE" }),
  dto("cobrar2", "09:30", { practitionerId: "p2", status: "COMPLETED", copagoCents: 450000 }),
  dto("pagado", "08:00", { practitionerId: "p2", status: "COMPLETED", copagoCents: 500000, paymentStatus: "PAID" }),
  dto("cancel", "12:00", { status: "CANCELLED", patientName: "Cancelado Ruiz" }),
];
const PRACTITIONERS = [
  { id: "p1", name: "Ana Pérez", initials: "AP" },
  { id: "p2", name: "Bruno Sosa", initials: "BS" },
];
const ROOMS = [{ id: "r1", name: "Consultorio 1", capacity: 1 }];

const SECRETARIA = deskViewer(null, ["agenda.viewAll", "agenda.reception", "agenda.operateAll"]);
const TITULAR = deskViewer("p1", ["agenda.viewAll", "agenda.reception", "agenda.operateAll", "billing.manage", "clinical.read"]);
/** Profesional sin operateAll: opera solo sus filas (p2). */
const PROFESIONAL = deskViewer("p2", ["agenda.viewAll", "agenda.reception"]);

function makeLive(viewer: DeskViewer, over: Partial<SalaLive> = {}): SalaLive {
  const rows = over.rows ?? ROWS;
  return {
    dayKey: DAY, clock: NOW, loading: false, rows, entries: deskEntries(rows, NOW, viewer),
    pendingIds: new Set(), act: vi.fn(async () => {}), replaceRow: vi.fn(), call: null, dismissCall: vi.fn(),
    pulseIds: new Set(), announce: "", practitioners: PRACTITIONERS, rooms: ROOMS,
    roomById: { r1: { name: "Consultorio 1" } }, viewer, ...over,
  };
}

function api(viewer: DeskViewer, over: Partial<DeskActionsApi> = {}): DeskActionsApi {
  return {
    viewer, dayKey: DAY, now: NOW, pendingIds: new Set(),
    practitionerName: (id) => PRACTITIONERS.find((p) => p.id === id)?.name ?? "Profesional",
    run: vi.fn(), collect: vi.fn(), ...over,
  };
}

function flow(
  viewer: DeskViewer,
  o: { live?: Partial<SalaLive>; query?: string; proFilter?: string | null; api?: Partial<DeskActionsApi> } = {}
): string {
  return renderToStaticMarkup(
    <DeskActionsProvider value={api(viewer, o.api)}>
      <DeskFlow live={makeLive(viewer, o.live)} query={o.query ?? ""} proFilter={o.proFilter ?? null} onProFilter={() => {}} />
    </DeskActionsProvider>
  );
}

/** Markup de una sección (línea de tiempo o carril) por el texto de su h2. */
function section(html: string, title: string): string {
  const h = html.indexOf(`>${title}</h2>`);
  expect(h, `sección «${title}»`).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<section", h);
  const end = html.indexOf("</section>", h);
  return html.slice(start, end);
}

/** Ids de las filas (data-row) en el orden del markup. */
function rowIds(html: string): string[] {
  return Array.from(html.matchAll(/data-row="([^"]+)"/g), (m) => m[1]);
}

function ticket(html: string, id: string): string {
  const start = html.indexOf(`data-row="${id}"`);
  expect(start, `ticket ${id}`).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</li>", html.indexOf("desk-tk-a", start)));
}

describe("[RX-2b] estructura", () => {
  it("el shell con layout flow monta B: «Hoy», franja y los tres carriles", () => {
    const html = renderToStaticMarkup(<ReceptionDesk live={makeLive(SECRETARIA)} layout="flow" />);
    expect(html).toContain('data-face="flow"');
    expect(html).not.toContain('data-face="list"');
    expect(html).toContain(">Hoy</h2>");
    expect(html).toContain('class="desk-strip"');
    expect(html).toContain(">Llegan pronto</h2>");
    expect(html).toContain(">Sala de espera</h2>");
    expect(html).toContain(">En atención</h2>");
    // Orden: la línea de tiempo primero (a la izquierda), la franja a la derecha y después los carriles.
    const iDay = html.indexOf(">Hoy</h2>");
    const iStrip = html.indexOf('class="desk-strip"');
    const iSoon = html.indexOf(">Llegan pronto</h2>");
    expect(iDay).toBeLessThan(iStrip);
    expect(iStrip).toBeLessThan(iSoon);
  });

  it("cada carril es una región con nombre (aria-labelledby → h2)", () => {
    const html = flow(SECRETARIA);
    for (const t of ["Hoy", "Llegan pronto", "Sala de espera", "En atención"]) {
      const sec = section(html, t);
      const id = sec.match(/aria-labelledby="([^"]+)"/)?.[1];
      expect(id).toBeTruthy();
      expect(sec).toContain(`<h2 id="${id}">${t}</h2>`);
    }
  });
});

describe("[RX-2b] línea de tiempo «Hoy»", () => {
  it("cronológica, sin cancelados, con separadores por hora AR y la marca de ahora antes del primer futuro", () => {
    const html = section(flow(SECRETARIA), "Hoy");
    expect(rowIds(html)).toEqual(["pagado", "cobrar", "cobrar2", "box", "demorado", "tarde", "llamado", "sala", "prox", "lejos"]);
    expect(html).not.toContain("Cancelado Ruiz");
    for (const h of ["08 h", "09 h", "10 h", "11 h", "12 h"]) expect(html).toContain(`>${h}</li>`);
    // La marca de ahora (10:42) va entre «sala» (10:40) y «prox» (11:00), antes del separador de las 11.
    const iNow = html.indexOf('data-now="10:42"');
    expect(iNow).toBeGreaterThan(html.indexOf('data-row="sala"'));
    expect(iNow).toBeLessThan(html.indexOf(">11 h</li>"));
    expect(html).toContain('aria-label="Ahora, 10:42"');
    // Cabecera: total sin cancelados y terminados (atendidos + ausentes).
    expect(html).toContain('<span class="desk-flow-count">10</span>');
    expect(html).toContain("3 terminados");
  });

  it("punto del color del servicio, iniciales del profesional y tag de estado (vacío para por llegar)", () => {
    const html = section(flow(SECRETARIA), "Hoy");
    const row = (id: string) => html.slice(html.indexOf(`data-row="${id}"`), html.indexOf("</li>", html.indexOf(`data-row="${id}"`)));
    expect(row("llamado")).toContain("background:#3d74b5");
    expect(row("llamado")).toContain(">BS</span>");
    expect(row("llamado")).toContain(", con Bruno Sosa");
    expect(row("llamado")).toContain('data-state="llamado"');
    expect(row("prox")).not.toContain("desk-tag");
    expect(row("cobrar")).toContain('data-past="true"');
    expect(row("cobrar")).toContain(">Atendido<");
    // Ancla de scroll: 3 turnos antes de la marca (prox es el índice 8 → 5 = «tarde»).
    expect(row("tarde")).toContain('data-anchor="true"');
    expect(html.match(/data-anchor="true"/g)).toHaveLength(1);
  });

  it("flowTimeline: sin futuros, la marca va al final; día vacío, nada; 23:30 AR es «23 h» también en UTC", () => {
    const es = chronological(deskEntries([dto("a", "08:00"), dto("b", "09:15")], NOW, SECRETARIA));
    const items = flowTimeline(es, NOW);
    expect(items.map((i) => i.kind)).toEqual(["hour", "row", "hour", "row", "now"]);
    expect(flowTimeline([], NOW)).toEqual([]);
    const late = flowTimeline(chronological(deskEntries([dto("n", "23:30")], NOW, SECRETARIA)), NOW);
    expect(late[0]).toEqual({ kind: "now", key: "now" });
    expect(late[1]).toMatchObject({ kind: "hour", hour: 23 });
    expect(late[2]).toMatchObject({ kind: "row", anchor: true });
  });

  it("buscador y franja filtran (sin resaltado: todo lo visible coincide); sin coincidencias, el texto lo dice", () => {
    const q = section(flow(SECRETARIA, { query: "paciente" }), "Hoy");
    expect(rowIds(q).length).toBeGreaterThan(1);
    // [RX-Z #8] con búsqueda activa todas las filas coinciden: marcarlas pintaba de lima toda la lista.
    expect(q).not.toContain("data-hit");
    expect(DESK_FLOW_CSS).not.toContain("data-hit");
    expect(rowIds(section(flow(SECRETARIA, { query: "laura" }), "Hoy"))).toEqual(["llamado"]);
    const p2 = flow(SECRETARIA, { proFilter: "p2" });
    expect(rowIds(section(p2, "Hoy"))).toEqual(["pagado", "cobrar2", "demorado", "tarde", "llamado"]);
    expect(rowIds(section(p2, "Sala de espera"))).toEqual(["llamado", "tarde"]);
    expect(section(flow(SECRETARIA, { query: "zzz" }), "Hoy")).toContain("Ningún turno de hoy coincide con «zzz».");
  });
});

describe("[RX-2b] carriles por estado", () => {
  it("Llegan pronto: demorados + por llegar en ≤ 30', cronológico, con obra social, Sobreturno y «en N'»", () => {
    const html = section(flow(SECRETARIA), "Llegan pronto");
    expect(rowIds(html)).toEqual(["demorado", "prox"]); // «lejos» (12:30) no entra
    expect(html).toContain('<span class="desk-flow-count">2</span>');
    expect(html).toContain("30 min");
    expect(ticket(html, "demorado")).toContain('data-state="demorado"');
    expect(ticket(html, "demorado")).toContain("Demorado 27&#x27;");
    expect(ticket(html, "prox")).toContain("en 18&#x27;");
    expect(ticket(html, "prox")).toContain(">OSDE<");
    expect(ticket(html, "prox")).toContain(">Sobreturno<");
  });

  it("Sala de espera: llamados primero, después por llegada; espera, barra y «pasó la hora»", () => {
    const html = section(flow(SECRETARIA), "Sala de espera");
    expect(rowIds(html)).toEqual(["llamado", "tarde", "sala"]);
    expect(html).toContain("por llegada");
    // Laura: llegó 10:20 → 22' de espera, turno 10:30 ya pasó.
    const laura = ticket(html, "llamado");
    expect(laura).toContain('data-state="llamado"');
    expect(laura).toContain("Llamado 2&#x27;");
    expect(laura).toMatch(/Espera <b class="desk-mono">22&#x27;<\/b>/);
    expect(laura).toContain("pasó la hora");
    // «tarde»: llegó 10:10 → 32' (barra llena), su turno era 10:20.
    const tarde = ticket(html, "tarde");
    expect(tarde).toContain('data-late-wait="true"');
    expect(tarde).toContain("width:100%");
    // «sala»: llegó 10:35 → 7' (23 %), turno 10:40 → ya pasó.
    expect(ticket(html, "sala")).toContain("width:23%");
    // Sala del catálogo en la meta (Martín está en atención: no está acá).
    expect(html).not.toContain("Martín Suárez");
  });

  it("tercer carril con billing.manage: Por cobrar con el total en el encabezado (formatARS)", () => {
    const html = flow(TITULAR);
    expect(html).not.toContain(">En atención</h2>");
    const cash = section(html, "Por cobrar");
    expect(rowIds(cash)).toEqual(["cobrar", "cobrar2"]); // el pagado no
    expect(cash).toContain(formatARS(1_050_000));
    expect(ticket(cash, "cobrar")).toContain(formatARS(600000));
    expect(ticket(cash, "cobrar")).toContain("Copago · terminó 09:45");
    expect(ticket(cash, "cobrar2")).toContain("Sesión · terminó 10:15");
    expect(ticket(cash, "cobrar")).toContain(`aria-label="Cobrar a Paciente cobrar, ${formatARS(600000)}"`);
  });

  it("tercer carril sin billing.manage: En atención (quién está en el box y hace cuánto), sin Por cobrar ni Cobrar", () => {
    const html = flow(SECRETARIA);
    expect(html).not.toContain(">Por cobrar</h2>");
    expect(html).not.toContain("Cobrar");
    const att = section(html, "En atención");
    expect(rowIds(att)).toEqual(["box"]);
    expect(att).toMatch(/En atención <b class="desk-mono">37&#x27;<\/b>/);
    expect(att).toContain("Consultorio 1");
    // [RX-Z B] separador y sala en un solo span sin corte: el «·» no queda colgado al final de la línea.
    expect(att).toContain('<span class="desk-tk-room"><span aria-hidden="true">·</span> Consultorio 1</span>');
    expect(DESK_FLOW_CSS).toContain(".desk-tk-room { white-space: nowrap; }");
    expect(att).toContain(">AP</span>");
    expect(att).toContain('aria-label="Atendido: Martín Suárez, 10:00"');
  });
});

describe("[RX-2b] acciones por rol", () => {
  it("Secretaria: primaria por estado, «En atención» secundaria solo en el en-sala, y el ⋯", () => {
    const html = flow(SECRETARIA);
    const sala = section(html, "Sala de espera");
    expect(ticket(sala, "sala")).toContain('aria-label="Llamar: Paciente sala, 10:40"');
    expect(ticket(sala, "sala")).toContain('class="desk-act desk-flow-sec" data-kind="attend" aria-label="En atención: Paciente sala, 10:40"');
    // El llamado ya tiene «En atención» como primaria: no se duplica como secundaria.
    expect(ticket(sala, "llamado")).toContain('aria-label="En atención: Laura Paz, 10:30"');
    expect(ticket(sala, "llamado")).not.toContain("desk-flow-sec");
    expect(ticket(sala, "llamado")).toContain('aria-label="Más acciones: Laura Paz, 10:30"');
    expect(ticket(section(html, "Llegan pronto"), "demorado")).toContain('aria-label="Llegó: Paciente demorado, 10:15"');
  });

  it("Profesional sin operateAll: acciones solo en sus filas (sin secundaria ajena)", () => {
    const html = flow(PROFESIONAL);
    const sala = section(html, "Sala de espera");
    // «tarde» y «llamado» son de p2 (suyos); «sala» es de p1.
    expect(ticket(sala, "tarde")).toContain('aria-label="Llamar: Paciente tarde, 10:20"');
    expect(ticket(sala, "tarde")).toContain("desk-flow-sec");
    expect(ticket(sala, "sala")).not.toContain("Llamar");
    expect(ticket(sala, "sala")).not.toContain("desk-flow-sec");
    expect(ticket(section(html, "Llegan pronto"), "prox")).not.toContain("Llegó");
  });

  it("fila con una acción en vuelo: primaria y secundaria deshabilitadas", () => {
    const sala = section(flow(SECRETARIA, { api: { pendingIds: new Set(["sala"]) } }), "Sala de espera");
    expect(ticket(sala, "sala")).toMatch(/aria-label="Llamar: Paciente sala, 10:40" disabled=""/);
    expect(ticket(sala, "sala")).toMatch(/aria-label="En atención: Paciente sala, 10:40" disabled=""/);
    expect(ticket(sala, "tarde")).not.toContain("disabled");
  });

  it("llegada nueva: el ticket se marca para el pulso (decorativo, con reduced motion no anima)", () => {
    const html = flow(SECRETARIA, { live: { pulseIds: new Set(["sala"]) } });
    expect(ticket(section(html, "Sala de espera"), "sala")).toContain('data-just="true"');
    expect(ticket(section(html, "Sala de espera"), "tarde")).not.toContain("data-just");
  });
});

describe("[RX-2b] PD-13", () => {
  it("ni title, ni notes, ni description, ni patientCondition (Titular y Secretaria, con y sin búsqueda)", () => {
    const html = [
      flow(TITULAR),
      flow(SECRETARIA),
      flow(PROFESIONAL, { query: "paciente" }),
      renderToStaticMarkup(<ReceptionDesk live={makeLive(TITULAR)} layout="flow" />),
    ].join("\n");
    expect(html).toContain("Paciente cobrar"); // el markup no está vacío
    for (const s of SECRETS) expect(html).not.toContain(s);
  });
});

describe("[RX-2b] vacíos", () => {
  it("sin turnos: «Hoy no hay turnos.» y el vacío de cada carril", () => {
    const html = flow(TITULAR, { live: { rows: [] } });
    expect(section(html, "Hoy")).toContain("Hoy no hay turnos.");
    expect(section(html, "Llegan pronto")).toContain("No llega nadie en la próxima media hora.");
    expect(section(html, "Sala de espera")).toContain("Nadie en la sala por ahora.");
    expect(section(html, "Por cobrar")).toContain("No hay cobros pendientes.");
    expect(section(html, "Por cobrar")).not.toContain(formatARS(0));
    expect(flow(SECRETARIA, { live: { rows: [] } })).toContain("Nadie en atención por ahora.");
    // Sin profesionales con turnos, la franja no se dibuja (y la cara no se rompe).
    expect(html).not.toContain('class="desk-strip"');
  });

  it("cargando un día nuevo: no dice «Hoy no hay turnos»", () => {
    const html = flow(SECRETARIA, { live: { rows: [], loading: true } });
    expect(html).not.toContain("Hoy no hay turnos");
    expect(html).toContain("Cargando los turnos de hoy…");
  });
});

describe("[RX-2b] DESK_FLOW_CSS", () => {
  it("272 px de día en wide, 236 en compacto, carriles de 3 columnas, una columna en stack y fallback", () => {
    expect(DESK_FLOW_CSS).toContain("grid-template-columns: 272px minmax(0, 1fr)");
    expect(DESK_FLOW_CSS).toContain("grid-template-columns: repeat(3, minmax(0, 1fr))");
    expect(DESK_FLOW_CSS).toContain("@container desk (max-width: 1179px)");
    expect(DESK_FLOW_CSS).toContain("grid-template-columns: 236px minmax(0, 1fr)");
    expect(DESK_FLOW_CSS).toContain("@container desk (max-width: 719px)");
    expect(DESK_FLOW_CSS).toContain(".desk-flow { display: flex; flex-direction: column; height: auto; }");
    expect(DESK_FLOW_CSS).toContain("@supports not (container-type: inline-size)");
    expect(DESK_FLOW_CSS).toContain("@media (max-width: 1243px)");
    expect(DESK_FLOW_CSS).toContain("@media (max-width: 783px)");
  });

  it("alto: la cara llena el cuerpo y cada lista scrollea adentro (sin scroll de página en wide/compact)", () => {
    expect(DESK_FLOW_CSS).toContain(".desk-flow { display: grid;");
    expect(DESK_FLOW_CSS).toMatch(/\.desk-flow \{[^}]*height: 100%; min-height: 0;/);
    expect(DESK_FLOW_CSS).toMatch(/\.desk-flow-scroll \{[^}]*min-height: 0; overflow-y: auto;/);
    expect(DESK_FLOW_CSS).toMatch(/\.desk-flow-card \{[^}]*min-height: 0;[^}]*overflow: hidden;/);
  });

  it("secundaria escondida en compacto y visible en stack; pulso solo sin reduced motion", () => {
    const compact = DESK_FLOW_CSS.slice(DESK_FLOW_CSS.indexOf("@container desk (max-width: 1179px)"), DESK_FLOW_CSS.indexOf("@container desk (max-width: 719px)"));
    expect(compact).toContain(".desk-flow-sec { display: none; }");
    expect(DESK_FLOW_CSS).toContain(".desk-flow-sec { display: inline-flex; }");
    expect(DESK_FLOW_CSS).toContain("@media (prefers-reduced-motion: no-preference)");
    expect(DESK_FLOW_CSS).toContain("prefers-reduced-motion: reduce");
  });

  it("sin caracteres que React escapa adentro de <style> y sin custom properties propias", () => {
    expect(DESK_FLOW_CSS).not.toMatch(/[<>"'&]/);
    // Toda var(--x) usada es un token de globals.css (tests/unit/design-tokens.test.ts): ninguna definida acá.
    expect(DESK_FLOW_CSS).not.toMatch(/(^|[;{\s])--[a-z-]+\s*:/);
  });

  it("estados con tokens (var(--st-*) / var(--rc-*)), no con colores literales", () => {
    const stateRules = DESK_FLOW_CSS.split("\n").filter((l) => /data-state=/.test(l));
    expect(stateRules.length).toBeGreaterThanOrEqual(2);
    for (const l of stateRules) expect(l).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });
});

describe("[RX-Z FX-B] layout y tokens", () => {
  const block = (q: string) => {
    const i = DESK_FLOW_CSS.indexOf(q);
    expect(i, q).toBeGreaterThan(-1);
    return DESK_FLOW_CSS.slice(i, DESK_FLOW_CSS.indexOf("\n}", i) + 2);
  };

  it("#4 la franja no se encoge dentro de la columna de carriles (no queda recortada)", () => {
    expect(DESK_FLOW_CSS).toContain(".desk-flow-main .desk-strip { flex: 0 0 auto; }");
  });

  it("#9 compacto: sin iniciales en la fila de «Hoy»; contenedor ≤ 860: día de 200 px (con fallback por viewport)", () => {
    expect(block("@container desk (max-width: 1179px)")).toContain(".desk-tl-row .desk-av-sm { display: none; }");
    const narrow = block("@container desk (max-width: 860px)");
    expect(narrow).toContain(".desk-flow { grid-template-columns: 200px minmax(0, 1fr); }");
    expect(block("@media (max-width: 924px)")).toContain("grid-template-columns: 200px minmax(0, 1fr)");
    // Orden: compacto → angosto → stack (el stack, último, gana con su flex de una columna).
    const iC = DESK_FLOW_CSS.indexOf("@container desk (max-width: 1179px)");
    const iN = DESK_FLOW_CSS.indexOf("@container desk (max-width: 860px)");
    const iS = DESK_FLOW_CSS.indexOf("@container desk (max-width: 719px)");
    expect(iC).toBeLessThan(iN);
    expect(iN).toBeLessThan(iS);
    // Re-captura a 764: con 200 px el tag deja el nombre en una letra → baja a la segunda línea; las aclaraciones
    // de texto de los carriles se esconden (el total de «Por cobrar» no: no es string).
    expect(narrow).toContain(".desk-tl-s { grid-column: 2; }");
    expect(narrow).toContain(".desk-flow-sub[data-hint=true] { display: none; }");
    // En stack (ancho completo) el tag vuelve a la misma línea.
    expect(block("@container desk (max-width: 719px)")).toContain(".desk-tl-s { grid-column: auto; }");
    const t = flow(TITULAR);
    expect(section(t, "Llegan pronto")).toContain('<span class="desk-flow-sub" data-hint="true">30 min</span>');
    expect(section(t, "Por cobrar")).toMatch(/<span class="desk-flow-sub"><b class="desk-mono">/);
    expect(section(t, "Hoy")).toContain('<span class="desk-tl-s"><span class="desk-tag"');
    // Meta del ticket en una línea: nombre y sala se recortan con «…» en vez de partirse.
    expect(DESK_FLOW_CSS).toContain(".desk-tk-meta { flex-wrap: nowrap; }");
    expect(section(t, "Llegan pronto")).toContain('class="desk-tk-m desk-tk-meta"');
    // Las iniciales siguen para lector de pantalla.
    expect(section(flow(SECRETARIA), "Hoy")).toContain(", con Bruno Sosa");
  });

  it("marca de ahora con var(--now-line) y pulso con color-mix sobre --lime-400 (sin colores literales)", () => {
    expect(DESK_FLOW_CSS).not.toContain("#c2410c");
    expect(DESK_FLOW_CSS).toMatch(/\.desk-tl-now \{[^}]*background: var\(--now-line\)/);
    expect(DESK_FLOW_CSS).toMatch(/\.desk-tl-now span \{[^}]*background: var\(--now-line\)/);
    const kf = DESK_FLOW_CSS.split("\n").find((l) => l.startsWith("@keyframes desk-flow-just")) ?? "";
    expect(kf).toContain("color-mix(in srgb, var(--lime-400)");
    expect(kf).not.toMatch(/rgba?\(/);
  });
});

describe("[RX-Z FX-B] memo por firma (#10)", () => {
  const entry = (id: string) => {
    const e = makeLive(SECRETARIA).entries.find((x) => x.row.id === id);
    if (!e) throw new Error(id);
    return e;
  };
  const v: FlowView = { pro: { name: "Ana Pérez", initials: "AP" }, room: null, minutes: 7, late: false, anchor: false, just: false };

  it("flowRowSig cambia con lo que la fila o el ticket pinta y no con lo que no", () => {
    const e = entry("sala");
    const base = flowRowSig(e, v);
    expect(flowRowSig(e, { ...v })).toBe(base);
    // Lo clínico y lo que no se pinta no entra (PD-13 y menos renders).
    expect(flowRowSig({ ...e, row: { ...e.row, notes: "otra", title: "otro", description: "x", patientCondition: "y" } }, v)).toBe(base);
    expect(base).not.toMatch(/SECRET/);
    // Lo que se pinta o lo que usan las acciones, sí.
    expect(flowRowSig({ ...e, row: { ...e.row, updatedAt: at("10:41") } }, v)).not.toBe(base);
    expect(flowRowSig({ ...e, row: { ...e.row, patientName: "Otro" } }, v)).not.toBe(base);
    expect(flowRowSig({ ...e, row: { ...e.row, copagoCents: 1 } }, v)).not.toBe(base);
    expect(flowRowSig({ ...e, row: { ...e.row, durationMin: 60 } }, v)).not.toBe(base);
    expect(flowRowSig({ ...e, state: "llamado" }, v)).not.toBe(base);
    expect(flowRowSig({ ...e, calledMinutes: 3 }, v)).not.toBe(base);
    expect(flowRowSig({ ...e, salaActions: [] }, v)).not.toBe(base);
    expect(flowRowSig(e, { ...v, minutes: 8 })).not.toBe(base);
    expect(flowRowSig(e, { ...v, late: true })).not.toBe(base);
    expect(flowRowSig(e, { ...v, anchor: true })).not.toBe(base);
    expect(flowRowSig(e, { ...v, just: true })).not.toBe(base);
    expect(flowRowSig(e, { ...v, room: "Consultorio 1" })).not.toBe(base);
    expect(flowRowSig(e, { ...v, pro: { name: "Ana P.", initials: "AP" } })).not.toBe(base);
  });

  it("un tick del reloj que no cambia los minutos mostrados deja la firma igual", () => {
    const later = new Date(NOW.getTime() + 20_000); // 10:42:20: misma espera en minutos
    const e0 = makeLive(SECRETARIA).entries.find((x) => x.row.id === "sala")!;
    const e1 = deskEntries(ROWS, later, SECRETARIA).find((x) => x.row.id === "sala")!;
    expect(flowRowSig(e1, v)).toBe(flowRowSig(e0, v));
  });

  it("el render sigue igual con las filas memoizadas (mismo markup en dos renders)", () => {
    expect(flow(TITULAR)).toBe(flow(TITULAR));
  });
});
