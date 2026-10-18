/**
 * [AS-3h] Render accesible de Agenda → Ocupación (`components/agenda/occupancy/occupancy-view.tsx`): tabla con
 * `<caption>` y `th scope`, el número en cada celda, «en el tope» con marca no cromática + texto, filtros por GET
 * nativo, sin `<button>` de JS (el único es el submit), lista por día para < 640 px y el link desde el panel «Vista».
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OccupancyView } from "@/components/agenda/occupancy/occupancy-view";
import { buildPastTable, buildUpcomingTables, type OccupancyView as Data } from "@/lib/agenda-occupancy";

vi.mock("@/components/providers/arrival-alerts", () => ({ useAlertPrefs: () => ({ live: false }) }));

const ar = (local: string) => new Date(`${local}:00-03:00`);
const NOW = ar("2027-11-10T15:00");
const BH = { start: 9, end: 12 };

function pastData(): Data {
  return {
    params: { tab: "pasado", weeks: 4, pro: null },
    scope: { kind: "team", practitionerId: null },
    practitioners: [
      { id: "p-1", name: "Ana Pérez" },
      { id: "p-2", name: "Bruno Díaz" },
    ],
    practitionerName: null,
    cap: null,
    truncated: false,
    tables: [
      buildPastTable([{ day: null, dow: 2, hour: 10, q: null, n: 6, hold: null }], {
        weeks: 4,
        now: NOW,
        fromKey: "2027-10-11",
        toKey: "2027-11-08",
        businessHours: BH,
      }),
    ],
  };
}

describe("[AS-3h] OccupancyView", () => {
  it("tabla accesible: caption, th scope col/row y número en cada celda", () => {
    const html = renderToStaticMarkup(<OccupancyView data={pastData()} />);
    expect(html).toContain("<caption>Promedio de turnos por día y hora de inicio · últimas 4 semanas completas");
    expect(html.match(/<th scope="col"/g)).toHaveLength(7); // Hora + lun..sáb
    expect(html.match(/<th scope="row"/g)).toHaveLength(3); // 09, 10, 11
    const tds = [...html.matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => m[1]);
    expect(tds).toHaveLength(18);
    for (const t of tds) expect(t).toMatch(/^\d/);
    expect(tds).toContain("1,5");
  });

  it("filtros por formulario GET nativo con pestaña, profesional y semanas", () => {
    const html = renderToStaticMarkup(<OccupancyView data={pastData()} />);
    expect(html).toMatch(/<form[^>]*method="get"[^>]*action="\/agenda\/ocupacion"/);
    expect(html).toContain('<input type="hidden" name="tab" value="pasado"/>');
    expect(html).toContain('name="pro"');
    expect(html).toContain('<option value="p-2">Bruno Díaz</option>');
    expect(html).toContain('name="semanas"');
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain('type="submit"');
    expect(html).toMatch(/aria-current="page"[^>]*>Lo que pasó</);
    expect(html).toContain('href="/agenda/ocupacion?tab=proximo"');
  });

  it("el Profesional no ve el selector de profesional", () => {
    const d = { ...pastData(), scope: { kind: "own" as const, practitionerId: "p-1" }, practitioners: [] };
    const html = renderToStaticMarkup(<OccupancyView data={d} />);
    expect(html).not.toContain('name="pro"');
    expect(html).toContain("Tu agenda.");
  });

  it("«en el tope»: marca no cromática + texto para el lector, y leyenda", () => {
    const d: Data = {
      params: { tab: "proximo", weeks: 1, pro: "p-1" },
      scope: { kind: "team", practitionerId: "p-1" },
      practitioners: [{ id: "p-1", name: "Ana Pérez" }],
      practitionerName: "Ana Pérez",
      cap: { count: 2, intervalMin: 60 },
      truncated: false,
      tables: buildUpcomingTables([{ day: "2027-11-11", dow: 4, hour: 10, q: 0, n: 2, hold: null }], {
        weeks: 1,
        now: NOW,
        fromKey: "2027-11-10",
        cap: { count: 2, intervalMin: 60 },
        businessHours: BH,
      }),
    };
    const html = renderToStaticMarkup(<OccupancyView data={d} />);
    expect(html).toContain("2/2");
    expect(html).toContain("0/2");
    expect(html).toMatch(/<span[^>]*aria-hidden="true">▲<\/span><span class="k-sr-only"> \(En el tope\)<\/span>/);
    expect(html).toContain("En el tope (turnos/tope)");
    expect(html).toContain("Agenda de Ana Pérez.");
    // Lista por día (< 640 px) con el mismo dato.
    expect(html).toContain("<h3>Jueves 11/11</h3>");
    expect(html).toContain("2 de 2 (tope)");
  });

  it("[T3-Z M6/B9] leyenda por intervalo, sin relleno de tope con < 60, «x de y (tope)» y «Aplicar»", () => {
    const cap = { count: 2, intervalMin: 15 } as const;
    const d: Data = {
      params: { tab: "proximo", weeks: 1, pro: "p-1" },
      scope: { kind: "team", practitionerId: "p-1" },
      practitioners: [{ id: "p-1", name: "Ana Pérez" }],
      practitionerName: "Ana Pérez",
      cap,
      truncated: false,
      tables: buildUpcomingTables([{ day: "2027-11-11", dow: 4, hour: 10, q: 0, n: 2, hold: null }], {
        weeks: 1,
        now: NOW,
        fromKey: "2027-11-10",
        cap,
        businessHours: BH,
      }),
    };
    const html = renderToStaticMarkup(<OccupancyView data={d} />);
    expect(html).toContain("Algún intervalo de 15 min llegó al tope");
    expect(html).toContain("En 1 de 4 intervalos de 15 min se llegó al tope de 2 turnos.");
    expect(html).toContain("▲");
    // Ni la celda ni la leyenda llevan el relleno de «en el tope»: con < 60 la marca es solo el triángulo.
    expect(html).not.toMatch(/class="[^"]*_cap_/);
    expect(html).toContain(">Aplicar<");
    expect(html).not.toContain(">Ver<");

    const d60: Data = {
      ...d,
      cap: { count: 2, intervalMin: 60 },
      tables: buildUpcomingTables([{ day: "2027-11-11", dow: 4, hour: 10, q: 0, n: 2, hold: null }], {
        weeks: 1,
        now: NOW,
        fromKey: "2027-11-10",
        cap: { count: 2, intervalMin: 60 },
        businessHours: BH,
      }),
    };
    const h60 = renderToStaticMarkup(<OccupancyView data={d60} />);
    expect(h60).toContain("En el tope (turnos/tope)");
    expect(h60).toContain("2 de 2 (tope)");
    expect(h60).toMatch(/class="[^"]*_cap_/);
  });

  it("el panel «Vista» de la agenda lleva el link a Ocupación", async () => {
    const { ViewOptionsPanel } = await import("@/components/agenda/view-options-panel");
    const html = renderToStaticMarkup(
      <ViewOptionsPanel
        density="comfortable"
        setDensity={() => {}}
        visibility={{ showCancelled: false, showNoShow: false } as never}
        setVisibility={() => {}}
      />
    );
    expect(html).toMatch(/<a role="menuitem"[^>]*href="\/agenda\/ocupacion">Ocupación<\/a>/);
  });
});
