/**
 * [CF2-ZF1] Fixer de los hallazgos ZB-2, ZB-3 y ZB-7 de CF2 (el ZB-1, criterio único de «Por cobrar», lo fijan
 * [CF2-AD7]/[CF2-ZF1-1*] en `tests/unit/cf2-copago-tag.test.ts`):
 *   - ZB-2: header del Tablero de /sala. Con ≤ 800 px de alto el header es UNA fila flex (`display: contents` en las
 *     filas) y cobro, Sede, «¿Otro día?» y «Pantallas» no tenían `order`: se dibujaban ANTES del título. Con más alto,
 *     `.sala-tools` en nowrap desbordaba y el buscador quedaba en 0. El link no tenía estilo en el Tablero.
 *   - ZB-3: en la Semana compacta «Retenido» y «Por cobrar» eran el mismo glifo `$`.
 *   - ZB-7: «Por cobrar» con formato y comportamiento distintos en Recepción y /sala, y «Cobrar» sin la jerarquía de
 *     /sala en Recepción.
 *
 * El repo no tiene DOM en vitest (render estático): el layout se verifica evaluando `SALA_CSS` contra cada viewport
 * con un evaluador mínimo de `@media` (min/max-width/height; lo demás, p. ej. reduced motion, no aplica) y mirando
 * que el markup real del header lleve las clases a las que apuntan esas reglas. Anti-false-green: el header, la vista
 * de Recepción y el badge son los componentes reales; se mockean la red (actions) y `next/dynamic`.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/lib/preferences", () => ({ updateAgendaViewPrefs: vi.fn(), updateUserPreferences: vi.fn() }));
vi.mock("@/lib/bookings", () => ({ markReceptionAction: vi.fn(), setBookingCopagoPaid: vi.fn() }));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));

import { SALA_CSS } from "@/components/sala/sala-css";
import { SalaHeader, salaCashLabel } from "@/components/sala/sala-header";
import { SalaLocationContext } from "@/components/sala/sala-location";
import { DisplaysContext } from "@/components/sala/displays/displays-button";
import { MoneyBadge } from "@/components/agenda/grid/money-badge";
import { ReceptionView } from "@/components/agenda/reception/reception-view";
import { porCobrarLabel } from "@/lib/copago-owed";
import { formatARS } from "@/lib/format";
import type { BookingDTO } from "@/components/agenda/agenda-utils";

// ── Evaluador mínimo de SALA_CSS ────────────────────────────────────────────

type Vp = { w: number; h: number };
type Rule = { media: string | null; selectors: string[]; decls: Record<string, string> };

function parseCss(css: string): Rule[] {
  const out: Rule[] = [];
  const walk = (text: string, media: string | null) => {
    let pos = 0;
    while (pos < text.length) {
      const open = text.indexOf("{", pos);
      if (open < 0) break;
      const head = text.slice(pos, open).trim();
      let depth = 1;
      let j = open + 1;
      while (depth && j < text.length) {
        if (text[j] === "{") depth++;
        else if (text[j] === "}") depth--;
        j++;
      }
      const body = text.slice(open + 1, j - 1);
      if (head.startsWith("@media")) walk(body, head.slice(6).trim());
      else if (!head.startsWith("@")) {
        const decls: Record<string, string> = {};
        for (const d of body.split(";")) {
          const k = d.indexOf(":");
          if (k > 0) decls[d.slice(0, k).trim()] = d.slice(k + 1).trim();
        }
        out.push({ media, selectors: head.split(",").map((s) => s.trim()), decls });
      }
      pos = j;
    }
  };
  walk(css.replace(/\/\*[\s\S]*?\*\//g, ""), null);
  return out;
}

function mediaMatches(media: string | null, vp: Vp): boolean {
  if (media == null) return true;
  return media.split(/\s+and\s+/).every((c) => {
    const m = /^\(\s*(min|max)-(width|height)\s*:\s*(\d+)px\s*\)$/.exec(c.trim());
    if (!m) return false;
    const v = m[2] === "width" ? vp.w : vp.h;
    return m[1] === "min" ? v >= Number(m[3]) : v <= Number(m[3]);
  });
}

const RULES = parseCss(SALA_CSS);
/** Declaraciones que aplican a `selectors` (en orden de fuente: el último gana, misma especificidad) en `vp`. */
function computed(vp: Vp, ...selectors: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of RULES) if (mediaMatches(r.media, vp) && r.selectors.some((s) => selectors.includes(s))) Object.assign(out, r.decls);
  return out;
}
const order = (vp: Vp, ...sel: string[]) => Number(computed(vp, ...sel).order ?? 0);

const DESK_1366: Vp = { w: 1366, h: 768 };
const DESK_1024: Vp = { w: 1024, h: 768 };
const PHONE_390: Vp = { w: 390, h: 844 };
const TALL_1440: Vp = { w: 1440, h: 900 };

// ── Header real ──────────────────────────────────────────────────────────────

function header(): string {
  return renderToStaticMarkup(
    <DisplaysContext.Provider value={{ canManage: true }}>
      <SalaLocationContext.Provider
        value={{
          locations: [
            { id: "l1", name: "Centro", isPrimary: true },
            { id: "l2", name: "Norte", isPrimary: false },
          ],
          locationId: null,
          primaryLocationId: "l1",
          setLocationId: () => {},
        }}
      >
        <SalaHeader
          dayLabel="Jueves, 22 de octubre"
          counters={{ enSala: 1, llamados: 0, enAtencion: 0, atendidos: 2 }}
          groupBy="practitioner"
          canGroupByRoom
          onGroupBy={() => {}}
          query=""
          onQuery={() => {}}
          status={null}
          cash={{ count: 0, totalCents: 0, onOpen: () => {} }}
        />
      </SalaLocationContext.Provider>
    </DisplaysContext.Provider>
  );
}

describe("[CF2-ZF1-2] header del Tablero (ZB-2)", () => {
  const html = header();

  it("[CF2-ZF1-2a] el markup lleva las clases a las que apunta el CSS: cobro, Sede, «¿Otro día?» y «Pantallas» en .sala-tools", () => {
    const tools = html.slice(html.indexOf('class="sala-head-row sala-tools"'));
    expect(tools).toMatch(/<button[^>]*class="k-btn k-btn-ghost k-btn-sm sala-cash"[^>]*data-sala-cash=""/);
    expect(tools).toContain('class="sala-loc"');
    expect(tools).toContain('class="sala-otherday"');
    // «Pantallas» va envuelto (`.sala-displays`): el `order` no se le puede poner al `k-btn` genérico (pisaría el
    // orden de los botones del drawer, que se monta adentro).
    expect(tools).toMatch(/<span class="sala-displays"><button[^>]*class="k-btn k-btn-ghost k-btn-sm"[^>]*aria-haspopup="dialog"[^>]*>[\s\S]*Pantallas/);
    // Orden del DOM (el de pantalla alta, sin `order`): buscador, cobro, Sede, link, Pantallas, aviso.
    const idx = ["sala-search", "sala-cash", "sala-loc", "sala-otherday", "sala-displays", "sala-status"].map((s) => tools.indexOf(s));
    expect(idx.every((i) => i > -1)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  it.each([
    ["1366×768", DESK_1366],
    ["1024×768", DESK_1024],
  ])("[CF2-ZF1-2b] %s (≤ 800 de alto, una fila): título → segmentado → buscador → cobro → Sede → link → Pantallas → aviso → contadores", (_n, vp) => {
    expect(computed(vp, ".sala-head-row").display).toBe("contents");
    expect(computed(vp, ".sala-head")["flex-wrap"]).toBe("wrap");
    const seq = [
      order(vp, ".sala-head-title"),
      order(vp, ".sala-seg"),
      order(vp, ".sala-search"),
      order(vp, ".sala-cash"),
      order(vp, ".sala-loc"),
      order(vp, ".sala-otherday"),
      order(vp, ".sala-displays"),
      order(vp, ".sala-status"),
      order(vp, ".sala-counters"),
    ];
    // Nada en 0 (el default): un hijo sin `order` se dibujaría antes del título.
    expect(seq.every((o) => o > 0), JSON.stringify(seq)).toBe(true);
    expect([...seq].sort((a, b) => a - b)).toEqual(seq);
    expect(new Set(seq).size).toBe(seq.length);
  });

  it("[CF2-ZF1-2c] el link tiene estilo (como .desk-otherday), no se parte ni se achica", () => {
    for (const vp of [DESK_1366, DESK_1024, PHONE_390, TALL_1440]) {
      const s = computed(vp, ".sala-otherday");
      expect(s["white-space"]).toBe("nowrap");
      expect(s["flex-shrink"]).toBe("0");
      expect(s.color).toBe("var(--sky-700)");
      expect(s["font-weight"]).toBe("600");
      expect(computed(vp, ".sala-loc")["flex-shrink"]).toBe("0");
      expect(computed(vp, ".sala-displays")["flex-shrink"]).toBe("0");
    }
  });

  it("[CF2-ZF1-2d] < 1280 px el link se oculta (como el compacto del escritorio); a 1366 y en pantalla alta ancha se ve", () => {
    expect(computed(DESK_1024, ".sala-otherday").display).toBe("none");
    expect(computed(PHONE_390, ".sala-otherday").display).toBe("none");
    expect(computed(DESK_1366, ".sala-otherday").display).not.toBe("none");
    expect(computed(TALL_1440, ".sala-otherday").display).not.toBe("none");
  });

  it("[CF2-ZF1-2e] .sala-tools hace wrap (antes nowrap: desbordaba y el buscador quedaba en 0); el buscador no baja de su base", () => {
    for (const vp of [DESK_1366, DESK_1024, PHONE_390, TALL_1440]) {
      expect(computed(vp, ".sala-tools")["flex-wrap"], JSON.stringify(vp)).toBe("wrap");
      // Con wrap, la base del buscador decide el salto de línea: no se achica a 0 para hacerle lugar al resto.
      expect(computed(vp, ".sala-search").flex, JSON.stringify(vp)).toMatch(/^1 1 (100%|\d+px)$/);
    }
    // 390: el buscador ocupa la fila entera (MB-1c) y el header no es sticky.
    expect(computed(PHONE_390, ".sala-search")["flex-basis"]).toBe("100%");
  });

  it("[CF2-ZF1-4a] el header de /sala usa el rótulo único de «Por cobrar» (`porCobrarLabel`) y queda deshabilitado en 0", () => {
    for (const [n, c] of [[0, 0], [1, 600_000], [12, 7_250_050]] as const) expect(salaCashLabel(n, c)).toBe(porCobrarLabel(n, c));
    expect(html).toMatch(/<button[^>]*data-sala-cash=""[^>]*disabled=""[^>]*>[\s\S]*?Por cobrar · 0/);
  });
});

// ── MoneyBadge compacto ──────────────────────────────────────────────────────

const DAY = "2026-10-05";
const iso = (h: string) => new Date(`${DAY}T${h}:00-03:00`).toISOString();
function dto(id: string, h: string, over: Partial<BookingDTO> = {}): BookingDTO {
  return { id, scheduledFor: iso(h), durationMin: 45, status: "CONFIRMED", serviceId: "s", serviceName: "Kinesiología", serviceColor: "#3d74b5", practitionerId: "p1", patientId: "pat", patientName: `Paciente ${id}`, patientCondition: null, obraSocial: "Particular", copagoCents: 500_000, updatedAt: iso("08:00"), notes: null, title: null, description: null, patientAccess: "full", arrivedAt: null, attendingAt: null, calledAt: null, paymentStatus: "UNPAID", ...over };
}

describe("[CF2-ZF1-3] Semana compacta: «Retenido» no usa el glifo de «Por cobrar» (ZB-3)", () => {
  const badge = (b: BookingDTO) => renderToStaticMarkup(<MoneyBadge b={b} copago compact />);
  const inner = (html: string) => html.replace(/^<span[^>]*>/, "").replace(/<\/span>$/, "");

  it("owed = «$» con borde punteado; held = sin glifo, borde sólido; los dos con el nombre accesible completo", () => {
    const owed = badge(dto("o", "09:00", { status: "COMPLETED" }));
    const held = badge(dto("h", "09:00", { status: "COMPLETED", paymentStatus: "AUTHORIZED" }));
    expect(owed).toContain('data-badge="copago-owed"');
    expect(inner(owed)).toBe("$");
    expect(owed).toContain("dashed");
    expect(held).toContain('data-badge="copago-held"');
    expect(held).toContain('aria-label="Pago retenido por Mercado Pago"');
    expect(inner(held)).not.toContain("$");
    expect(inner(held)).not.toBe(inner(owed));
    expect(held).toContain("1px solid");
    // Sin compacto, el texto entero (no cambia).
    expect(renderToStaticMarkup(<MoneyBadge b={dto("h", "09:00", { status: "COMPLETED", paymentStatus: "AUTHORIZED" })} copago />)).toContain(">Retenido<");
  });
});

// ── Recepción: chip y «Cobrar» como /sala ────────────────────────────────────

const NOW = new Date(`${DAY}T10:00:00-03:00`);
const pr = [{ id: "p1", name: "Ana Pérez", initials: "AP" }, { id: "p2", name: "Bruno Sosa", initials: "BS" }];
const SECRETARIA = { all: true, practitionerId: null };
function reception(bookings: BookingDTO[]) {
  return renderToStaticMarkup(
    <ReceptionView dayKey={DAY} bookings={bookings} practitioners={pr} now={NOW} canOperate onOpenBooking={() => {}} onChanged={() => {}} collect={SECRETARIA} />
  );
}
function rowOf(html: string, id: string): string {
  const at = html.indexOf(`Abrir el turno de Paciente ${id},`);
  expect(at).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<tr", at), html.indexOf("</tr>", at));
}
const chipOf = (html: string) => /<button[^>]*data-chip="por-cobrar"[^>]*>([\s\S]*?)<\/button>/.exec(html);
// Sin tocar el espacio duro de `formatARS` («$\u00a08.000»): solo se colapsa el espacio común del markup.
const text = (s: string) => s.replace(/<[^>]+>/g, "").replace(/[ \t\n]+/g, " ").trim();

describe("[CF2-ZF1-4] Recepción = /sala en «Por cobrar» (ZB-7)", () => {
  it("[CF2-ZF1-4b] mismo formato «Por cobrar · N · $X» que el header de /sala", () => {
    const html = reception([dto("hecho", "08:30", { status: "COMPLETED" }), dto("sala", "09:50", { arrivedAt: iso("09:45"), onlineDepositCents: 200_000 })]);
    const chip = chipOf(html);
    expect(chip).not.toBeNull();
    expect(text(chip![1])).toBe(salaCashLabel(2, 800_000));
    expect(text(chip![1])).toBe(`Por cobrar · 2 · ${formatARS(800_000)}`);
    expect(chip![0]).not.toContain("disabled");
  });

  it("[CF2-ZF1-4c] en 0 el chip queda visible y deshabilitado (la barra no salta), como el botón de /sala", () => {
    const html = reception([dto("futuro", "10:30"), dto("pagado", "08:00", { status: "COMPLETED", paymentStatus: "PAID", copagoPaymentMethod: "CASH" })]);
    const chip = chipOf(html);
    expect(chip).not.toBeNull();
    expect(chip![0]).toContain('disabled=""');
    expect(text(chip![1])).toBe("Por cobrar · 0");
  });

  it("[CF2-ZF1-4d] «Cobrar» es primario cuando es lo único que queda por hacer en la fila (atendido, como /sala); secundario al lado de «Llamar»", () => {
    const html = reception([dto("hecho", "08:30", { status: "COMPLETED" }), dto("sala", "09:50", { arrivedAt: iso("09:45") })]);
    expect(rowOf(html, "hecho")).toMatch(/<button[^>]*class="rcp-btn rcp-btn-primary"[^>]*aria-label="Cobrar /);
    const sala = rowOf(html, "sala");
    expect(sala).toMatch(/<button[^>]*class="rcp-btn"[^>]*aria-label="Cobrar /);
    // Un solo primario por fila: el de la transición («Llamar»).
    expect(sala.match(/rcp-btn-primary/g)?.length).toBe(1);
  });
});
