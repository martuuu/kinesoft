/**
 * [RX-1b] Escritorio de Recepción en /sala: shell común (header, franja, acciones por fila, modal de cobro, CSS) y
 * los stubs de las caras según el layout. Render SSR (`renderToStaticMarkup`) de los componentes REALES; se mockean
 * la red (server actions), el router y el toast. Horas AR explícitas y `now` fijo: corre igual con TZ=UTC y AR.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
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
import { TweaksProvider } from "@/components/layout/tweaks-context";
import {
  ReceptionDesk,
  deskFit,
  deskShortcutInScope,
  undoCheckOutcome,
  DESK_MIN_FIT_HEIGHT,
  DESK_NEW_BOOKING_HREF,
} from "@/components/sala/desk/reception-desk";
import { DeskStrip, pulseBadge } from "@/components/sala/desk/desk-strip";
import {
  DeskActionsProvider,
  DeskMenu,
  DeskPrimaryAction,
  DeskStateTag,
  deskActionToast,
  stableDeskActions,
  type DeskActionsApi,
} from "@/components/sala/desk/desk-actions";
import { DeskPayModal, applyCopagoPaid } from "@/components/sala/desk/desk-pay-modal";
import { DESK_CSS } from "@/components/sala/desk/desk-css";
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

const ROWS: BookingDTO[] = [
  dto("box", "10:00", { patientName: "Martín Suárez", arrivedAt: at("09:55"), calledAt: at("10:03"), attendingAt: at("10:05"), roomId: "r1" }),
  dto("llamado", "10:30", { patientName: "Laura Paz", practitionerId: "p2", arrivedAt: at("10:20"), calledAt: at("10:40") }),
  dto("sala", "10:40", { arrivedAt: at("10:35") }),
  dto("demorado", "10:15", { practitionerId: "p2" }),
  dto("prox", "11:00"),
  dto("cobrar", "09:00", { status: "COMPLETED", copagoCents: 600000, obraSocial: "OSDE" }),
  dto("pagado", "08:00", { practitionerId: "p2", status: "COMPLETED", copagoCents: 500000, paymentStatus: "PAID" }),
  dto("cancel", "12:00", { status: "CANCELLED" }),
];
const PRACTITIONERS = [
  { id: "p1", name: "Ana Pérez", initials: "AP" },
  { id: "p2", name: "Bruno Sosa", initials: "BS" },
];
const ROOMS = [{ id: "r1", name: "Consultorio 1", capacity: 1 }];

const SECRETARIA = deskViewer(null, ["agenda.viewAll", "agenda.reception", "agenda.operateAll"]);
const TITULAR = deskViewer("p1", ["agenda.viewAll", "agenda.reception", "agenda.operateAll", "billing.manage", "clinical.read"]);

function makeLive(viewer: DeskViewer, over: Partial<SalaLive> = {}): SalaLive {
  return {
    dayKey: DAY, clock: NOW, loading: false, rows: ROWS, entries: deskEntries(ROWS, NOW, viewer),
    pendingIds: new Set(), act: vi.fn(async () => {}), replaceRow: vi.fn(), call: null, dismissCall: vi.fn(),
    pulseIds: new Set(), announce: "", practitioners: PRACTITIONERS, rooms: ROOMS,
    roomById: { r1: { name: "Consultorio 1" } }, viewer, ...over,
  };
}

function api(viewer: DeskViewer, over: Partial<DeskActionsApi> = {}): DeskActionsApi {
  return {
    viewer, dayKey: DAY, now: NOW, pendingIds: new Set(), practitionerName: (id) => PRACTITIONERS.find((p) => p.id === id)?.name ?? "Profesional",
    run: vi.fn(), collect: vi.fn(), ...over,
  };
}

/** Todas las piezas por fila, para cada entry del día (lo que van a montar las caras de RX-2). */
function renderRows(viewer: DeskViewer, over: Partial<DeskActionsApi> = {}) {
  const live = makeLive(viewer);
  return renderToStaticMarkup(
    <DeskActionsProvider value={api(viewer, over)}>
      {live.entries.map((e) => (
        <div key={e.row.id} data-row={e.row.id}>
          <DeskStateTag entry={e} />
          <DeskPrimaryAction entry={e} />
          <DeskMenu entry={e} />
        </div>
      ))}
    </DeskActionsProvider>
  );
}

function rowHtml(html: string, id: string): string {
  const start = html.indexOf(`data-row="${id}"`);
  const end = html.indexOf("data-row=", start + 1);
  return html.slice(start, end === -1 ? undefined : end);
}

describe("[RX-1b] shell del escritorio", () => {
  it("monta la cara según el layout (stubs de C-RX5)", () => {
    const list = renderToStaticMarkup(<ReceptionDesk live={makeLive(SECRETARIA)} layout="list" />);
    expect(list).toContain('data-face="list"');
    expect(list).not.toContain('data-face="flow"');
    expect(list).toContain('data-layout="list"');
    const flow = renderToStaticMarkup(<ReceptionDesk live={makeLive(SECRETARIA)} layout="flow" />);
    expect(flow).toContain('data-face="flow"');
    expect(flow).not.toContain('data-face="list"');
  });

  it("header: KPIs de deskKpis (llamados dentro de En sala, cancelados fuera del total), fecha AR, reloj y Nuevo turno", () => {
    const html = renderToStaticMarkup(<ReceptionDesk live={makeLive(SECRETARIA)} layout="list" />);
    expect(html).toContain(">Recepción</h1>");
    expect(html).toContain(">Jueves, 15 de octubre<"); // salaDayLabel, la misma fecha que el Tablero
    expect(html).toMatch(/data-kpi="en-sala"><dt>En sala<\/dt><dd class="desk-mono">2<\/dd>/);
    expect(html).toMatch(/data-kpi="en-atencion"><dt>En atención<\/dt><dd class="desk-mono">1<\/dd>/);
    expect(html).toMatch(/data-kpi="demorados" data-warn="true"><dt>Demorados<\/dt><dd class="desk-mono">1<\/dd>/);
    expect(html).toMatch(/data-kpi="terminados"><dt>Terminados<\/dt><dd class="desk-mono">2\/7<\/dd>/);
    expect(html).toContain(">10:42</time>");
    expect(html).toContain("Nuevo turno");
    expect(html).toContain('aria-keyshortcuts="/"');
    expect(DESK_NEW_BOOKING_HREF).toBe("/agenda?new=1");
  });

  it("«Vista» solo con Apariencia (provider): sin provider no hay botón que no haga nada", () => {
    const sin = renderToStaticMarkup(<ReceptionDesk live={makeLive(SECRETARIA)} layout="list" />);
    expect(sin).not.toContain("Cambiar vista");
    const con = renderToStaticMarkup(
      <TweaksProvider>
        <ReceptionDesk live={makeLive(SECRETARIA)} layout="flow" />
      </TweaksProvider>
    );
    expect(con).toContain('aria-label="Cambiar vista (Apariencia)"');
  });

  it("banda de llamado con «Cerrar» y región aria-live siempre presente", () => {
    const sin = renderToStaticMarkup(<ReceptionDesk live={makeLive(SECRETARIA)} layout="list" />);
    expect(sin).toContain('class="desk-call" role="status" aria-live="polite"');
    const con = renderToStaticMarkup(
      <ReceptionDesk live={makeLive(SECRETARIA, { call: { key: "k1", text: "Pase Paciente L. · Consultorio 1" } })} layout="list" />
    );
    expect(con).toContain("Pase Paciente L. · Consultorio 1");
    expect(con).toContain(">Cerrar</button>");
  });

  it("PD-13: ni title, ni notes, ni description, ni patientCondition en ninguna pieza", () => {
    const html = [
      renderToStaticMarkup(<ReceptionDesk live={makeLive(TITULAR)} layout="list" />),
      renderToStaticMarkup(<ReceptionDesk live={makeLive(TITULAR)} layout="flow" />),
      renderRows(TITULAR),
      renderRows(SECRETARIA),
      renderToStaticMarkup(<DeskStrip live={makeLive(TITULAR)} proFilter={null} onProFilter={() => {}} />),
      renderToStaticMarkup(
        <DeskPayModal row={ROWS[5]} practitionerName="Ana Pérez" viewer={TITULAR} onClose={() => {}} onSaved={() => {}} />
      ),
    ].join("\n");
    expect(html).toContain("Paciente cobrar"); // el markup no está vacío
    for (const s of SECRETS) expect(html).not.toContain(s);
  });
});

describe("[RX-1b] acciones por fila y por rol", () => {
  it("primaria por estado con aria-label con el nombre, y el ⋯ con su nombre", () => {
    const html = renderRows(SECRETARIA);
    expect(html).toContain('aria-label="Llegó: Paciente demorado, 10:15"');
    expect(html).toContain('aria-label="Llamar: Paciente sala, 10:40"');
    expect(html).toContain('aria-label="En atención: Laura Paz, 10:30"');
    expect(html).toContain('aria-label="Atendido: Martín Suárez, 10:00"');
    expect(html).toContain('aria-label="Más acciones: Paciente prox, 11:00"');
    expect(html).toContain('aria-haspopup="menu"');
    // Tag con el estado escrito (no solo color).
    expect(rowHtml(html, "demorado")).toContain("Demorado 27&#x27;");
    expect(rowHtml(html, "llamado")).toContain('data-state="llamado"');
  });

  it("Secretaria (sin billing.manage): ni Cobrar ni Cobrado", () => {
    const html = renderRows(SECRETARIA);
    expect(html).not.toContain("Cobrar");
    expect(html).not.toContain("Cobrado");
    expect(rowHtml(html, "cobrar")).not.toContain('data-kind="pay"');
  });

  it("Titular (billing.manage): Cobrar en el atendido que debe, Cobrado en el pagado", () => {
    const html = renderRows(TITULAR);
    expect(rowHtml(html, "cobrar")).toContain(`aria-label="Cobrar a Paciente cobrar, ${formatARS(600000)}"`);
    expect(rowHtml(html, "cobrar")).toContain('data-kind="pay"');
    expect(rowHtml(html, "pagado")).toContain("Cobrado");
    expect(rowHtml(html, "pagado")).not.toContain('data-kind="pay"');
  });

  it("fila con una acción en vuelo: botones deshabilitados", () => {
    const html = renderRows(SECRETARIA, { pendingIds: new Set(["sala"]) });
    expect(rowHtml(html, "sala")).toMatch(/aria-label="Llamar: Paciente sala, 10:40" disabled=""/);
    expect(rowHtml(html, "demorado")).not.toContain("disabled");
  });
});

describe("[RX-1b] franja de profesionales", () => {
  it("una tarjeta por profesional con turnos, demora, línea y filtro con aria-pressed", () => {
    const html = renderToStaticMarkup(<DeskStrip live={makeLive(SECRETARIA)} proFilter="p2" onProFilter={() => {}} />);
    expect(html).toContain("Ana Pérez");
    expect(html).toContain("Bruno Sosa");
    // Ana está con «box» desde 10:05 (37'), que empezó 5' tarde y no se pasó del fin: al día.
    expect(html).toMatch(/data-pro="p1"[^]*?data-status="on-time"[^]*?Al día/);
    expect(html).toContain("Con <b>Martín S.</b> · 37&#x27;");
    // Bruno llamó a «llamado» (10:30, ahora 10:42 → +12').
    expect(html).toMatch(/data-pro="p2"[^]*?data-status="late"[^]*?\+12&#x27;/);
    expect(html).toContain("Llamó a <b>Laura P.</b>");
    expect(html).toMatch(/aria-pressed="true" data-pro="p2"/);
    expect(html).toMatch(/aria-pressed="false" data-pro="p1"/);
    expect(html).toContain("1 de 4 turnos terminados");
    expect(html).toContain("1 de 3 turnos terminados");
  });

  it("pulseBadge: Libre / Al día / +N'", () => {
    expect(pulseBadge({ status: "free", delayMin: 0 })).toBe("Libre");
    expect(pulseBadge({ status: "on-time", delayMin: 4 })).toBe("Al día");
    expect(pulseBadge({ status: "very-late", delayMin: 22 })).toBe("+22'");
  });
});

describe("[RX-1b] cobro", () => {
  it("modal: importe con formatARS, cobertura, profesional y hora; sin medio de pago (RX-D4)", () => {
    const html = renderToStaticMarkup(
      <DeskPayModal row={ROWS[5]} practitionerName="Ana Pérez" viewer={TITULAR} onClose={() => {}} onSaved={() => {}} />
    );
    expect(html).toContain("Cobrar a Paciente cobrar");
    expect(html).toContain("Copago OSDE · Ana Pérez · 09:00");
    expect(html).toContain(formatARS(600000));
    expect(html).toContain("Registrar cobro");
    expect(html).not.toContain("Medio de pago");
    expect(renderToStaticMarkup(<DeskPayModal row={null} practitionerName="" viewer={TITULAR} onClose={() => {}} onSaved={() => {}} />)).toBe("");
  });

  it("applyCopagoPaid: PAID y el updatedAt nuevo del server (el próximo expectedUpdatedAt)", () => {
    const next = applyCopagoPaid(ROWS[5], new Date("2026-10-15T13:45:00Z"));
    expect(next.paymentStatus).toBe("PAID");
    expect(next.updatedAt).toBe("2026-10-15T13:45:00.000Z");
    expect(next.copagoCents).toBe(600000);
    expect(ROWS[5].paymentStatus).toBe("UNPAID"); // no muta
  });
});

describe("[RX-1b] lógica del shell", () => {
  it("deskFit: alto medido + 14; con menos de 560 px de ventana, alto natural", () => {
    expect(deskFit(768, 72)).toEqual({ natural: false, deskTopPx: 86 });
    expect(deskFit(680, 72.4)).toEqual({ natural: false, deskTopPx: 86 });
    expect(deskFit(DESK_MIN_FIT_HEIGHT - 1, 72)).toEqual({ natural: true });
    expect(deskFit(DESK_MIN_FIT_HEIGHT, 0)).toEqual({ natural: false, deskTopPx: 14 });
  });

  it("undoCheckOutcome: en vuelo espera; guardado si cambió updatedAt y quedó en el estado prometido; si no, nada", () => {
    const check = { id: "sala", action: "llamar" as const, name: "Paciente S.", prevUpdatedAt: at("08:00"), to: "llamado" as const };
    const saved = { state: "llamado" as const, row: { ...ROWS[2], updatedAt: at("10:42") } };
    expect(undoCheckOutcome(check, saved, true)).toBe("wait");
    expect(undoCheckOutcome(check, saved, false)).toBe("saved");
    // Rollback: misma fila de antes.
    expect(undoCheckOutcome(check, { state: "en-sala", row: ROWS[2] }, false)).toBe("dropped");
    // «Cambió en otra sesión»: re-pedido con otro updatedAt pero sin el estado de la acción.
    expect(undoCheckOutcome(check, { state: "en-atencion", row: { ...ROWS[2], updatedAt: at("10:41") } }, false)).toBe("dropped");
    expect(undoCheckOutcome(check, undefined, false)).toBe("dropped");
  });

  it("deskActionToast: textos del prototipo; Deshacer no ofrece deshacer", () => {
    expect(deskActionToast("llego", "María G.", NOW)).toBe("Llegó María G. · 10:42");
    expect(deskActionToast("llamar", "María G.", NOW)).toBe("Llamaste a María G.");
    expect(deskActionToast("en-atencion", "María G.", NOW)).toBe("María G. pasó a atención");
    expect(deskActionToast("atendido", "María G.", NOW)).toBe("María G. · atendido");
    expect(deskActionToast("ausente", "María G.", NOW)).toBe("María G. · ausente");
    expect(deskActionToast("deshacer", "María G.", NOW)).toBeNull();
  });
});

describe("[RX-1b] DESK_CSS", () => {
  it("container queries (wide/compact/stack), fallback por viewport, alto calzado y reduced motion", () => {
    expect(DESK_CSS).toContain("container-type: inline-size");
    expect(DESK_CSS).toContain("container: desk / inline-size");
    expect(DESK_CSS).toContain("@container desk (max-width: 1179px)");
    expect(DESK_CSS).toContain("@container desk (max-width: 719px)");
    expect(DESK_CSS).toContain("@supports not (container-type: inline-size)");
    expect(DESK_CSS).toContain("@media (max-width: 1243px)");
    expect(DESK_CSS).toContain("@media (max-width: 783px)");
    expect(DESK_CSS).toContain("height: calc(100dvh - 28px)");
    // En una columna el alto natural le gana al inline medido por el shell.
    expect(DESK_CSS).toContain(".desk-frame { height: auto !important; overflow: visible; }");
    expect(DESK_CSS).toContain("prefers-reduced-motion: reduce");
  });

  it("sin caracteres que React escapa adentro de <style> (viaja en el HTML del server)", () => {
    expect(DESK_CSS).not.toMatch(/[<>"'&]/);
  });

  it("sin colores fuera de los tokens para los estados (solo var(--st-*) / var(--rc-*))", () => {
    const stateRules = DESK_CSS.split("\n").filter((l) => /data-(state|status)=/.test(l));
    expect(stateRules.length).toBeGreaterThan(8);
    for (const l of stateRules) expect(l).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });
});

describe("[RX-Z] fixes del shell", () => {
  it("#11 atajos: solo con el foco en el body o adentro del escritorio (Apariencia o sidebar enfocados: se ignora)", () => {
    const body = { tag: "body" };
    const inside = { tag: "input#desk-q" };
    const tweaksPanel = { tag: "button en Apariencia" };
    const frame = { contains: (n: unknown) => n === inside };
    expect(deskShortcutInScope(body as unknown as EventTarget, body, frame)).toBe(true);
    expect(deskShortcutInScope(inside as unknown as EventTarget, body, frame)).toBe(true);
    expect(deskShortcutInScope(tweaksPanel as unknown as EventTarget, body, frame)).toBe(false);
    // Antes del mount (sin frame) solo el body.
    expect(deskShortcutInScope(tweaksPanel as unknown as EventTarget, body, null)).toBe(false);
    expect(deskShortcutInScope(null, body, frame)).toBe(false);
  });

  it("#12 contexto estable: el tick (now) y pendingIds no cambian su identidad; un cambio de rol, día o callback sí", () => {
    const getNow = () => NOW;
    const base = api(TITULAR);
    const first = stableDeskActions(null, base, getNow);
    // Lo que el shell arma en el render del tick siguiente: otro `now`, otro objeto.
    const nextTick: DeskActionsApi = { ...base, now: new Date(NOW.getTime() + 30_000), pendingIds: new Set(["x"]) };
    const tick = stableDeskActions(first, nextTick, getNow);
    expect(tick).toBe(first);
    expect(first).not.toHaveProperty("now");
    expect(first).not.toHaveProperty("pendingIds");
    expect(stableDeskActions(first, { ...base, dayKey: "2026-10-16" }, getNow)).not.toBe(first);
    expect(stableDeskActions(first, { ...base, viewer: SECRETARIA }, getNow)).not.toBe(first);
    expect(stableDeskActions(first, { ...base, run: vi.fn() }, getNow)).not.toBe(first);
    expect(first.getNow()).toBe(NOW);
  });

  it("#13 menú ⋯ de 44 px fuera del @container (vive en un portal al body: el container nunca lo alcanza)", () => {
    const rule = ".desk-menu-item { min-height: 44px; }";
    expect(DESK_CSS.split(rule).length - 1).toBe(1);
    const at = DESK_CSS.indexOf(rule);
    const opener = DESK_CSS.lastIndexOf("@", at);
    expect(DESK_CSS.slice(opener, at)).toMatch(/^@media \(pointer: coarse\), \(max-width: 719px\) \{\s*$/);
    // Ninguna regla del menú adentro de los bloques @container.
    const blocks = DESK_CSS.split("@container desk").slice(1);
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      // Cada bloque cierra con una línea que es solo «}» (las reglas de adentro terminan en «; }»).
      expect(block.slice(0, block.indexOf("\n}"))).not.toContain(".desk-menu-item");
    }
  });

  it("#14 y bajos: sin #fff ni rgba(27,112,75,…) literales; fecha unificada con el Tablero", () => {
    expect(DESK_CSS).not.toMatch(/#fff\b/i);
    expect(DESK_CSS).not.toContain("rgba(27,112,75");
    expect(DESK_CSS).toContain("border-color: var(--st-completed-border)");
    const html = renderToStaticMarkup(<ReceptionDesk live={makeLive(SECRETARIA)} layout="list" />);
    expect(html).toContain('<span class="desk-date">Jueves, 15 de octubre</span>');
  });
});
