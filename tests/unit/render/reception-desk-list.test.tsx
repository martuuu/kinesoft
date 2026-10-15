/**
 * [RX-2a] Escritorio de Recepción, cara A «Lista y panel» (`DeskList`). Render SSR (`renderToStaticMarkup`) del
 * componente REAL, montado por el shell real (`ReceptionDesk layout="list"`) o con su provider de acciones; se
 * mockean la red (server actions), el router y el toast. Horas AR explícitas y `now` fijo (10:42 AR): corre igual con
 * TZ=UTC y con TZ=AR.
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
import { DeskList, DESK_LIST_CSS, deskRowSig, deskWaitText } from "@/components/sala/desk/desk-list";
import { minutesSince } from "@/lib/reception-desk-state";
import { DeskActionsProvider, type DeskActionsApi } from "@/components/sala/desk/desk-actions";
import { formatARS } from "@/lib/format";
import { deskEntries, deskViewer, type DeskViewer } from "@/lib/reception-desk-state";

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

// Cronológico sin cancelados: pagado 08:00, cobrar 09:00, box 10:00, demorado 10:15, llamado 10:30, sala 10:40,
// prox 11:00 (el primero futuro: la línea de «ahora» va antes; el ancla del scroll, 3 antes = demorado).
const ROWS: BookingDTO[] = [
  dto("box", "10:00", { patientName: "Martín Suárez", arrivedAt: at("09:55"), calledAt: at("10:03"), attendingAt: at("10:05"), roomId: "r1" }),
  dto("llamado", "10:30", { patientName: "Laura Paz", practitionerId: "p2", arrivedAt: at("10:20"), calledAt: at("10:40") }),
  dto("sala", "10:40", { arrivedAt: at("10:35") }),
  dto("demorado", "10:15", { practitionerId: "p2", isOverbooked: true }),
  dto("prox", "11:00", { serviceName: "Osteopatía", serviceColor: "#AEE9AE" }),
  dto("cobrar", "09:00", { status: "COMPLETED", copagoCents: 600000, obraSocial: "OSDE" }),
  dto("pagado", "08:00", { practitionerId: "p2", status: "COMPLETED", copagoCents: 500000, paymentStatus: "PAID" }),
  dto("cancel", "12:00", { status: "CANCELLED", patientName: "Cancelada Total" }),
];
const PRACTITIONERS = [
  { id: "p1", name: "Ana Pérez", initials: "AP" },
  { id: "p2", name: "Bruno Sosa", initials: "BS" },
];
const ROOMS = [{ id: "r1", name: "Consultorio 1", capacity: 1 }];

const SECRETARIA = deskViewer(null, ["agenda.viewAll", "agenda.reception", "agenda.operateAll"]);
const TITULAR = deskViewer("p1", ["agenda.viewAll", "agenda.reception", "agenda.operateAll", "billing.manage", "clinical.read"]);

function makeLive(viewer: DeskViewer, over: Partial<SalaLive> = {}, rows: BookingDTO[] = ROWS): SalaLive {
  return {
    dayKey: DAY, clock: NOW, loading: false, rows, entries: deskEntries(rows, NOW, viewer),
    pendingIds: new Set(), act: vi.fn(async () => {}), replaceRow: vi.fn(), call: null, dismissCall: vi.fn(),
    pulseIds: new Set(), announce: "", practitioners: PRACTITIONERS, rooms: ROOMS,
    roomById: { r1: { name: "Consultorio 1" } }, viewer, ...over,
  };
}

function api(viewer: DeskViewer): DeskActionsApi {
  return {
    viewer, dayKey: DAY, now: NOW, pendingIds: new Set(),
    practitionerName: (id) => PRACTITIONERS.find((p) => p.id === id)?.name ?? "Profesional",
    run: vi.fn(), collect: vi.fn(),
  };
}

/** La cara sola (con el provider de acciones que pone el shell). */
function face(live: SalaLive, opts: { query?: string; proFilter?: string | null } = {}): string {
  return renderToStaticMarkup(
    <DeskActionsProvider value={api(live.viewer)}>
      <DeskList live={live} query={opts.query ?? ""} proFilter={opts.proFilter ?? null} onProFilter={() => {}} />
    </DeskActionsProvider>
  );
}

/** El tbody de la tabla, en orden: ids de filas y la marca de la línea de «ahora». */
function tableOrder(html: string): string[] {
  const body = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>"));
  return Array.from(body.matchAll(/data-row="([^"]+)"|data-now-line=""/g), (m) => m[1] ?? "NOW");
}

/** HTML de una card del panel (de su <section> a la siguiente). */
function card(html: string, id: string): string {
  const start = html.indexOf(`data-card="${id}"`);
  if (start === -1) return "";
  const end = html.indexOf("data-card=", start + 1);
  return html.slice(start, end === -1 ? undefined : end);
}

function row(html: string, id: string): string {
  const body = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>"));
  const start = body.indexOf(`data-row="${id}"`);
  const end = body.indexOf("</tr>", start);
  return body.slice(start, end);
}

describe("[RX-2a] tabla «Turnos de hoy»", () => {
  it("el shell monta la cara A con la franja a todo el ancho, la tabla y el panel", () => {
    const html = renderToStaticMarkup(<ReceptionDesk live={makeLive(SECRETARIA)} layout="list" />);
    expect(html).toContain('data-face="list"');
    expect(html).toContain('class="desk-strip"');
    expect(html).toContain(">Turnos de hoy</h2>");
    expect(html).toContain(">Sala de espera</h2>");
    expect(html).toContain(">Próximos 30 min</h2>");
    // La franja va antes de la tabla.
    expect(html.indexOf('class="desk-strip"')).toBeLessThan(html.indexOf(">Turnos de hoy</h2>"));
  });

  it("columnas: Hora, Paciente, Servicio, Profesional, Sala, Estado, Espera y acciones", () => {
    const html = face(makeLive(SECRETARIA));
    const head = html.slice(html.indexOf("<thead>"), html.indexOf("</thead>"));
    for (const h of [">Hora<", ">Paciente<", ">Servicio<", ">Profesional<", ">Sala<", ">Estado<", ">Espera<", ">Acciones<"]) {
      expect(head).toContain(h);
    }
    expect(html).toContain('<caption class="desk-sr">Turnos de hoy</caption>');
  });

  it("orden cronológico sin cancelados y línea de «ahora» antes del primer turno futuro", () => {
    const html = face(makeLive(SECRETARIA));
    expect(tableOrder(html)).toEqual(["pagado", "cobrar", "box", "demorado", "llamado", "sala", "NOW", "prox"]);
    expect(html).not.toContain("Cancelada Total");
    expect(html).toContain("Ahora, 10:42");
  });

  it("auto-scroll: el ancla es la fila 3 turnos antes de la línea (scrollAnchorIndex)", () => {
    const html = face(makeLive(SECRETARIA));
    const anchors = Array.from(html.matchAll(/data-row="([^"]+)"[^>]*data-anchor="true"/g), (m) => m[1]);
    expect(anchors).toEqual(["demorado"]);
  });

  it("sin turnos futuros la línea va al final y no hay ancla (el scroll va al final)", () => {
    const past = ROWS.filter((r) => r.id !== "prox");
    const html = face(makeLive(SECRETARIA, {}, past));
    expect(tableOrder(html).at(-1)).toBe("NOW");
    expect(html).not.toContain("data-anchor");
  });

  it("fila: hora AR, nombre, obra social, Sobreturno, barra del servicio, iniciales con el nombre, sala, tag, espera", () => {
    const html = face(makeLive(SECRETARIA));
    const box = row(html, "box");
    expect(box).toContain(">10:00<");
    expect(box).toContain("Martín Suárez");
    expect(box).toContain('class="dl-os">Particular<');
    expect(box).toContain('style="background:#3d74b5"');
    expect(box).toContain('aria-label="Ana Pérez"');
    expect(box).toContain(">AP<");
    expect(box).toContain(">Consultorio 1<");
    expect(box).toContain('data-state="en-atencion"');
    expect(box).toContain("esperó 10&#x27;"); // llegó 09:55, entró 10:05
    expect(row(html, "demorado")).toContain(">Sobreturno<");
    expect(row(html, "demorado")).toContain(">BS<");
    expect(row(html, "prox")).toContain('style="background:#AEE9AE"');
    // En sala desde 10:35, turno 10:40 y ya son 10:42: «pasó la hora».
    expect(row(html, "sala")).toMatch(/data-late="true" title="Ya pasó la hora del turno">7&#x27;</);
    // Atendidos en gris (pasado).
    expect(row(html, "pagado")).toContain('data-past="true"');
  });

  it("acciones por fila: primaria con aria-label con el nombre y el ⋯", () => {
    const html = face(makeLive(SECRETARIA));
    expect(row(html, "demorado")).toContain('aria-label="Llegó: Paciente demorado, 10:15"');
    expect(row(html, "sala")).toContain('aria-label="Llamar: Paciente sala, 10:40"');
    expect(row(html, "prox")).toContain('aria-label="Más acciones: Paciente prox, 11:00"');
  });

  it("chips con contador (Secretaria): sin «Por cobrar»; Demorados en ámbar si hay", () => {
    const html = face(makeLive(SECRETARIA));
    expect(html).toContain('role="group" aria-label="Filtrar turnos"');
    expect(html).toMatch(/data-filter="todos" aria-pressed="true">Todos <span class="dl-n">7</);
    expect(html).toMatch(/data-filter="por-llegar" aria-pressed="false">Por llegar <span class="dl-n">2</);
    expect(html).toMatch(/data-filter="en-sala" aria-pressed="false">En sala <span class="dl-n">2</);
    expect(html).toMatch(/data-filter="demorados" data-warn="true" aria-pressed="false">Demorados <span class="dl-n">1</);
    expect(html).toMatch(/data-filter="atendidos" aria-pressed="false">Atendidos <span class="dl-n">2</);
    expect(html).not.toContain('data-filter="por-cobrar"');
  });

  it("chips (Titular): «Por cobrar» con el que debe, en ámbar", () => {
    const html = face(makeLive(TITULAR));
    expect(html).toMatch(/data-filter="por-cobrar" data-warn="true" aria-pressed="false">Por cobrar <span class="dl-n">1</);
  });

  it("filtro por profesional (franja): tabla, panel y contadores de ese profesional", () => {
    const html = face(makeLive(SECRETARIA), { proFilter: "p2" });
    expect(tableOrder(html).filter((x) => x !== "NOW")).toEqual(["pagado", "demorado", "llamado"]);
    expect(html).toMatch(/data-filter="todos" aria-pressed="true">Todos <span class="dl-n">3</);
    expect(card(html, "wait")).toContain("Laura Paz");
    expect(card(html, "wait")).not.toContain("Paciente sala");
  });

  it("búsqueda: filtra tabla y panel; los chips cuentan sin la búsqueda", () => {
    const html = face(makeLive(SECRETARIA), { query: "laura" });
    expect(tableOrder(html).filter((x) => x !== "NOW")).toEqual(["llamado"]);
    expect(html).toMatch(/Todos <span class="dl-n">7</);
    expect(card(html, "wait")).not.toContain("Paciente sala");
  });

  it("estados vacíos: sin coincidencias, sin turnos y cargando", () => {
    expect(face(makeLive(SECRETARIA), { query: "zzz" })).toContain("Ningún turno de hoy coincide con «zzz».");
    const empty = face(makeLive(SECRETARIA, {}, []));
    expect(empty).toContain("Hoy no hay turnos.");
    expect(empty).not.toContain("<table");
    expect(empty).toContain("Nadie en la sala por ahora.");
    expect(empty).toContain("No llega nadie en la próxima media hora.");
    expect(empty).toContain("Nadie en atención por ahora.");
    expect(face(makeLive(TITULAR, {}, []))).toContain("No hay cobros pendientes.");
    expect(face(makeLive(SECRETARIA, { loading: true }, []))).toContain("Cargando los turnos de hoy…");
    // Solo cancelados: el día está vacío para la recepción.
    expect(face(makeLive(SECRETARIA, {}, [ROWS[7]]))).toContain("Hoy no hay turnos.");
  });
});

describe("[RX-2a] panel", () => {
  it("Sala de espera: llamado primero, después por llegada; espera, barra y «pasó la hora»", () => {
    const html = face(makeLive(SECRETARIA));
    const wait = card(html, "wait");
    expect(wait).toContain('class="dl-count">2<');
    expect(wait).toContain("por orden de llegada");
    expect(wait.indexOf("Laura Paz")).toBeLessThan(wait.indexOf("Paciente sala"));
    expect(wait).toContain("llamado 2&#x27;");
    // [RX-Z FX-A] 3: el llamado muestra la espera desde la llegada (10:20 → 10:42 = 22'), no «0' espera».
    const laura = wait.slice(wait.indexOf("Laura Paz"), wait.indexOf("Paciente sala"));
    expect(laura).toContain('<b class="desk-mono">22&#x27;</b>');
    expect(laura).not.toContain(">0&#x27;<");
    expect(laura).toContain('style="width:73%"'); // 22' de 30'
    expect(wait).toContain("pasó la hora");
    expect(wait).toContain('style="width:23%"'); // 7' de 30'
    expect(wait).toContain('aria-label="En atención: Laura Paz, 10:30"');
    expect(wait).toContain('aria-label="Llamar: Paciente sala, 10:40"');
  });

  it("Próximos 30 min: el demorado y el que llega en 18'", () => {
    const soon = card(face(makeLive(SECRETARIA)), "soon");
    expect(soon).toContain('class="dl-count">2<');
    expect(soon).toContain("demorado 27&#x27;");
    expect(soon).toContain("en 18&#x27;");
    expect(soon.indexOf("Paciente demorado")).toBeLessThan(soon.indexOf("Paciente prox"));
  });

  it("Titular (billing.manage): «Por cobrar» con importe, Cobrar y total con formatARS; sin «En atención»", () => {
    const html = face(makeLive(TITULAR));
    const cash = card(html, "cash");
    expect(cash).toContain(">Por cobrar</h2>");
    expect(cash).toContain("Copago OSDE · Ana Pérez");
    expect(cash).toContain(formatARS(600000));
    expect(cash).toContain(`aria-label="Cobrar a Paciente cobrar, ${formatARS(600000)}"`);
    expect(cash).toContain("Total pendiente");
    // [RX-Z FX-A] 5: el total va en el header (sin footer que le coma la fila visible a 680).
    const header = cash.slice(0, cash.indexOf('class="dl-scroll"'));
    expect(header).toContain(`<b class="desk-mono">${formatARS(600000)}</b>`);
    expect(cash.slice(cash.indexOf('class="dl-scroll"'))).not.toContain("Total pendiente");
    expect(cash).not.toContain("Paciente pagado");
    expect(card(html, "attending")).toBe("");
  });

  it("Secretaria: «En atención» (quién y hace cuánto) y NI «Por cobrar» NI «Cobrar» en ningún lado", () => {
    const html = face(makeLive(SECRETARIA));
    const att = card(html, "attending");
    expect(att).toContain(">En atención</h2>");
    expect(att).toContain("Martín Suárez");
    expect(att).toContain("Consultorio 1");
    expect(att).toContain(">37&#x27;<"); // entró 10:05
    expect(att).toContain('aria-label="Atendido: Martín Suárez, 10:00"');
    expect(html).not.toContain("Por cobrar");
    expect(html).not.toContain("Cobrar");
    expect(html).not.toContain("Total pendiente");
  });

  it("PD-13: ni title, ni notes, ni description, ni patientCondition, con los dos roles", () => {
    const html = [
      face(makeLive(TITULAR)),
      face(makeLive(SECRETARIA)),
      renderToStaticMarkup(<ReceptionDesk live={makeLive(TITULAR)} layout="list" />),
    ].join("\n");
    expect(html).toContain("Paciente cobrar");
    for (const s of SECRETS) expect(html).not.toContain(s);
  });
});

describe("[RX-Z FX-A] espera y profesional en la tabla", () => {
  it("«—» en vez de «esperó 0'» si pasó al box en el mismo minuto que llegó", () => {
    const rows = [dto("directo", "10:00", { arrivedAt: at("10:02"), calledAt: at("10:02"), attendingAt: at("10:02") })];
    const live = makeLive(SECRETARIA, {}, rows);
    const r = row(face(live), "directo");
    expect(r).toContain('data-state="en-atencion"');
    expect(r).not.toContain("esperó 0");
    expect(r).toMatch(/class="dl-wait desk-mono">—</);
    expect(deskWaitText(live.entries[0], NOW)).toBeNull();
    // Con espera real sigue el texto de siempre.
    const box = makeLive(SECRETARIA).entries.find((x) => x.row.id === "box")!;
    expect(deskWaitText(box, NOW)).toBe("esperó 10'");
  });

  it("minutesSince: enteros, 0 si falta o es futuro", () => {
    expect(minutesSince(at("10:20"), NOW)).toBe(22);
    expect(minutesSince(null, NOW)).toBe(0);
    expect(minutesSince(at("11:00"), NOW)).toBe(0);
  });

  it("compact: las iniciales del profesional van también en la sublínea (con el nombre para lectores)", () => {
    const html = face(makeLive(SECRETARIA));
    expect(row(html, "demorado")).toContain(
      '<span class="dl-sub-pro" title="Bruno Sosa"><span aria-hidden="true">BS</span><span class="desk-sr">Bruno Sosa</span></span>'
    );
  });
});

describe("[RX-2a] memo de filas", () => {
  it("deskRowSig cambia con lo que la fila pinta y no con lo que no", () => {
    const live = makeLive(SECRETARIA);
    const e = live.entries.find((x) => x.row.id === "sala")!;
    const v = { pro: PRACTITIONERS[0], room: null, late: true, wait: "7'", anchor: false, just: false };
    const base = deskRowSig(e, v);
    expect(deskRowSig({ ...e, row: { ...e.row, notes: "otra" } }, v)).toBe(base);
    expect(deskRowSig({ ...e, row: { ...e.row, updatedAt: at("10:41") } }, v)).not.toBe(base);
    expect(deskRowSig(e, { ...v, wait: "8'" })).not.toBe(base);
    expect(deskRowSig(e, { ...v, anchor: true })).not.toBe(base);
  });
});

describe("[RX-2a] DESK_LIST_CSS", () => {
  it("sin caracteres que React escapa adentro de <style> (viaja en el HTML del server)", () => {
    expect(DESK_LIST_CSS).not.toMatch(/[<>"'&]/);
  });

  it("container queries compact/stack, fallback por viewport y reduced motion", () => {
    expect(DESK_LIST_CSS).toContain("@container desk (max-width: 1179px)");
    expect(DESK_LIST_CSS).toContain("@container desk (max-width: 719px)");
    expect(DESK_LIST_CSS).toContain("@supports not (container-type: inline-size)");
    expect(DESK_LIST_CSS).toContain("@media (max-width: 1243px)");
    expect(DESK_LIST_CSS).toContain("@media (max-width: 783px)");
    expect(DESK_LIST_CSS).toContain("prefers-reduced-motion: reduce");
    // Wide: tabla + panel de 344; compact: 272; stack: una columna.
    expect(DESK_LIST_CSS).toContain("grid-template-columns: minmax(0, 1fr) 344px");
    expect(DESK_LIST_CSS).toContain("grid-template-columns: minmax(0, 1fr) 272px");
    expect(DESK_LIST_CSS).toMatch(/\.dl \{ height: auto; grid-template-columns: minmax\(0, 1fr\);/);
    // Las listas scrollean adentro (sin scroll de página en wide/compact).
    expect(DESK_LIST_CSS).toContain(".dl-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto;");
  });

  it("[RX-Z FX-A] sin colores literales: blanco = --card-bg, línea de ahora = --now-line, pulso = lime-400", () => {
    expect(DESK_LIST_CSS).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(DESK_LIST_CSS).not.toContain("rgba(142,204,48");
    expect(DESK_LIST_CSS).toContain("border-top: 2px solid var(--now-line)");
    expect(DESK_LIST_CSS).toMatch(/\.dl-now-rule span \{[^}]*background: var\(--now-line\); color: var\(--card-bg\)/);
    expect(DESK_LIST_CSS).toContain(".dl-chip[aria-pressed=true] { background: var(--navy-900); color: var(--card-bg); }");
    expect(DESK_LIST_CSS).toContain("color-mix(in srgb, var(--lime-400) 60%, transparent)");
  });

  /** Bloque de un @container (compact o stack) del CSS. */
  function block(max: number): string {
    const start = DESK_LIST_CSS.indexOf(`@container desk (max-width: ${max}px) {`);
    const next = DESK_LIST_CSS.indexOf("\n@", start + 1);
    return DESK_LIST_CSS.slice(start, next === -1 ? undefined : next);
  }

  it("[RX-Z FX-A] 1: th/td border-box y compact con Profesional a la sublínea (Paciente no queda en 0 px)", () => {
    expect(DESK_LIST_CSS).toContain(".dl-table th, .dl-table td { box-sizing: border-box; }");
    const c = block(1179);
    expect(c).toContain(".dl { grid-template-columns: minmax(0, 1fr) 272px; }");
    // Ancho 0 y no `display: none`: la fila de «ahora» (colSpan 8) crearía columnas fantasma con el sobrante.
    expect(c).toContain(
      ".dl-table .c-svc, .dl-table .c-pro, .dl-table .c-room, .dl-table .c-wait { width: 0; padding: 0; overflow: hidden; visibility: hidden; }"
    );
    expect(c).not.toMatch(/c-(svc|pro|room|wait)[^{]*\{ display: none/);
    expect(c).toContain(".dl-sub-svc, .dl-sub-room, .dl-sub-pro { display: inline-flex; }");
    expect(c).toContain(".dl-table .c-time { width: 52px;");
    expect(c).toContain(".dl-table .c-state { width: 104px; }");
    expect(c).toContain(".dl-table .c-act { width: 132px; }");
    // La sala con estilo de celda solo en td (el th «SALA» no hereda 13px navy-700).
    expect(DESK_LIST_CSS).toContain(".dl-table td.c-room { font-size: 13px;");
  });

  it("[RX-Z FX-A] 2: a 390 el tag ocupa su fila y las acciones van abajo (no lo tapan)", () => {
    const s = block(719);
    expect(s).toContain(".dl-table .c-pro { display: block; visibility: visible; grid-column: 1; grid-row: 2;");
    expect(s).toContain(".dl-sub-pro { display: none; }");
    expect(s).toContain(".dl-table .c-state { grid-column: 2 / 4; grid-row: 2; width: auto; min-width: 0; }");
    expect(s).toMatch(/\.dl-table \.c-act \{ grid-column: 1 \/ -1; grid-row: 3;/);
    expect(s).toContain(".dl-table .c-act .desk-acts { justify-content: flex-start; }");
  });

  it("[RX-Z FX-A] 5/6/7: panel a 680, chips que envuelven y la sala de espera apilada", () => {
    expect(DESK_LIST_CSS).toContain("grid-template-rows: minmax(0, 1.3fr) minmax(0, 1fr) minmax(0, 1fr)");
    expect(DESK_LIST_CSS).toContain(".dl-panel .dl-scroll { min-height: 56px; }");
    const c = block(1179);
    expect(c).toMatch(/\.dl-chips \{[^}]*flex-wrap: wrap/);
    expect(c).toContain(".dl-it.dl-wt { grid-template-columns: minmax(0, 1fr) auto; }");
    expect(c).toContain(".dl-wt .desk-acts { grid-column: 1 / -1; }");
  });
});
