/**
 * TP-1u · paso «Fecha y hora» con la ventana de 5 días hábiles (`components/booking/wizard/slot-window-step.tsx`).
 *
 * Render estático (entorno node, sin jsdom): se renderiza la VISTA (`SlotWindowView`, sin efectos) con una ventana
 * dada, igual que la arma `listPublicSlotWindow`. La parte con efectos (`SlotWindowStep`: pedir la ventana, elegir el
 * primer libre y enfocarlo) se apoya en la lógica pura de `lib/public-wizard-state.ts`, testeada en
 * `tests/unit/public-wizard-state.test.ts`; acá se fija que el contenedor use esos helpers.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

vi.mock("@/lib/public-booking", () => ({
  listPublicSlots: vi.fn(async () => []),
  listPublicSlotWindow: vi.fn(async () => ({ days: [], nextFrom: null, reachedEnd: true, skippedFrom: null })),
  findFirstPublicSlot: vi.fn(async () => null),
  submitPublicBooking: vi.fn(),
}));

import * as Step from "@/components/booking/wizard/slot-window-step";
import { firstAvailable } from "@/lib/public-wizard-state";
import type { PublicSlotWindow } from "@/lib/public-booking-types";

const slot = (date: string, time: string, locationId: string | null = null) => ({
  iso: `${date}T${time}:00.000-03:00`,
  time,
  available: true,
  locationId,
});
const times = (date: string, n: number) =>
  Array.from({ length: n }, (_, i) => slot(date, `${String(8 + Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`));

const WINDOW: PublicSlotWindow = {
  days: [
    { date: "2026-10-19", status: "open", slots: times("2026-10-19", 10) },
    { date: "2026-10-20", status: "full", slots: [] },
    { date: "2026-10-21", status: "open", slots: times("2026-10-21", 3) },
    { date: "2026-10-22", status: "open", slots: times("2026-10-22", 8) },
    { date: "2026-10-23", status: "open", slots: times("2026-10-23", 1) },
  ],
  nextFrom: "2026-10-24",
  reachedEnd: false,
  skippedFrom: null,
};

const noop = () => {};
function view(over: Partial<Step.SlotWindowViewProps> = {}) {
  const props: Step.SlotWindowViewProps = {
    status: "ready",
    window: WINDOW,
    notice: null,
    canPrev: false,
    jumpValue: "2026-10-17",
    today: "2026-10-17",
    slotISO: null,
    locations: [],
    locationId: null,
    onLocationChange: noop,
    onPrev: noop,
    onNext: noop,
    onJump: noop,
    onFirstAvailable: noop,
    onPick: noop,
    onLater: null,
    onRetry: noop,
    ...over,
  };
  return renderToStaticMarkup(<Step.SlotWindowView {...props} />);
}

describe("[TP-1] render 390: secciones con heading y nombre accesible día+hora", () => {
  it("un <section aria-labelledby> por día con su h3, rango con aria-live y botones con nombre día+hora", () => {
    const html = view();
    const sections = html.match(/<section[^>]*aria-labelledby="([^"]+)"/g) ?? [];
    expect(sections).toHaveLength(5);
    for (const sec of sections) {
      const id = /aria-labelledby="([^"]+)"/.exec(sec)![1];
      expect(html).toMatch(new RegExp(`<h3[^>]*id="${id}"`));
    }
    expect(html).toMatch(/<h3[^>]*>Lunes 19 de oct · 10 horarios<\/h3>/);
    expect(html).toMatch(/aria-live="polite"[^>]*>lun 19 al vie 23 de octubre</);
    expect(html).toMatch(/<button[^>]*aria-label="Lunes 19 de octubre a las 09:00"[^>]*aria-pressed="false"/);
    expect(html).toContain("‹ Anteriores");
    expect(html).toContain("Siguientes ›");
    expect(html).toMatch(/<input[^>]*type="date"[^>]*min="2026-10-17"/);
  });

  it("más de 8 horarios: 8 visibles + «Ver N más» con aria-expanded; con 8 justos, sin botón", () => {
    const html = view();
    const lunes = html.slice(html.indexOf("Lunes 19 de oct"), html.indexOf("Martes 20 de oct"));
    expect(lunes.match(/aria-label="Lunes 19 de octubre a las/g)).toHaveLength(8);
    expect(lunes).toMatch(/<button[^>]*aria-expanded="false"[^>]*>Ver 2 más<\/button>/);
    const jueves = html.slice(html.indexOf("Jueves 22 de oct"), html.indexOf("Viernes 23 de oct"));
    expect(jueves.match(/aria-label="Jueves 22 de octubre a las/g)).toHaveLength(8);
    expect(jueves).not.toContain("Ver ");
    // Si el horario elegido quedó más allá de los 8 (volvió al paso), el día arranca abierto: no se esconde la selección.
    const sel = view({ slotISO: WINDOW.days[0].slots[9].iso });
    const lunesSel = sel.slice(sel.indexOf("Lunes 19 de oct"), sel.indexOf("Martes 20 de oct"));
    expect(lunesSel.match(/aria-label="Lunes 19 de octubre a las/g)).toHaveLength(10);
    expect(lunesSel).toMatch(/aria-expanded="true"/);
  });

  it("CSS: días apilados a 390, grilla minmax(72px,1fr), botones de 44 px y 5 columnas desde 900", () => {
    const css = readFileSync("components/booking/public-booking.module.css", "utf8");
    expect(css).toMatch(/\.windowDays\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/\.daySlots\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(72px,\s*1fr\)\)/);
    expect(css).toMatch(/\.slot\s*\{[^}]*min-height:\s*44px/);
    expect(css).toMatch(/@media \(min-width: 900px\)\s*\{\s*\.windowDays\s*\{[^}]*repeat\(5,\s*minmax\(0,\s*1fr\)\)/);
  });

  it("varias sedes sin filtrar: el nombre accesible dice dónde", () => {
    const w: PublicSlotWindow = { ...WINDOW, days: [{ date: "2026-10-19", status: "open", slots: [slot("2026-10-19", "09:00", "L2")] }] };
    const locs = [
      { id: "L1", name: "Centro", address: null, addressLine2: null, city: null, province: null, isPrimary: true },
      { id: "L2", name: "Fisherton", address: null, addressLine2: null, city: null, province: null, isPrimary: false },
    ];
    expect(view({ window: w, locations: locs })).toContain('aria-label="Lunes 19 de octubre a las 09:00, en Fisherton"');
    expect(view({ window: w, locations: locs, locationId: "L2" })).toContain('aria-label="Lunes 19 de octubre a las 09:00"');
  });
});

describe("[TP-1] día full muestra «Completo»", () => {
  it("el día lleno tiene su sección con «Completo» y ningún botón de horario", () => {
    const html = view();
    expect(html).toMatch(/<h3[^>]*>Martes 20 de oct · Completo<\/h3>/);
    const martes = html.slice(html.indexOf("Martes 20 de oct"), html.indexOf("Miércoles 21 de oct"));
    expect(martes).not.toContain('aria-label="Martes 20 de octubre a las');
  });

  it("salto automático (5 completos): aviso; ventana vacía: «No hay turnos libres…» + «Buscar más adelante»", () => {
    const skipped = view({ notice: "No había turnos libres hasta el domingo 25; te mostramos desde el lunes 26." });
    expect(skipped).toContain("No había turnos libres hasta el domingo 25; te mostramos desde el lunes 26.");
    // Contrato de TP-1s: sin libres en 6 semanas llega la primera tanda toda «Completo» (sin salto), no vacía.
    const allFull: PublicSlotWindow = { ...WINDOW, days: WINDOW.days.map((d) => ({ ...d, status: "full" as const, slots: [] })) };
    const full = view({ window: allFull, onLater: noop });
    expect(full).toContain("No hay turnos libres en las próximas 6 semanas");
    expect(full).toMatch(/<button[^>]*>Buscar más adelante<\/button>/);
    expect(full.match(/<section/g)).toHaveLength(5);
    expect(full).toMatch(/<h3[^>]*>Lunes 19 de oct · Completo<\/h3>/);
    // Una semana con libres no muestra el aviso.
    expect(view()).not.toContain("próximas 6 semanas");
    const empty = view({ window: { days: [], nextFrom: null, reachedEnd: true, skippedFrom: null }, onLater: noop });
    expect(empty).toContain("No hay turnos libres en las próximas 6 semanas");
    expect(empty).toMatch(/<button[^>]*>Buscar más adelante<\/button>/);
    expect(empty).not.toMatch(/<section/);
    const end = view({ window: { days: [], nextFrom: null, reachedEnd: true, skippedFrom: null }, onLater: null });
    expect(end).not.toContain("Buscar más adelante");
  });

  it("cargando y rate limit", () => {
    expect(view({ status: "loading", window: null })).toContain("Buscando horarios…");
    expect(view({ status: "rate", window: null })).toContain("Demasiadas consultas seguidas");
  });
});

describe("[TP-1] Próximo turno disponible selecciona el primer libre", () => {
  it("el botón está; elegido el primer libre, ese horario queda marcado (aria-pressed) y es el único", () => {
    const first = firstAvailable(WINDOW)!;
    const html = view({ slotISO: first.slot.iso });
    expect(html).toMatch(/<button[^>]*>Próximo turno disponible<\/button>/);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-label="Lunes 19 de octubre a las 08:00"[^>]*aria-pressed="true"/);
    expect(html).toContain(`data-slot-iso="${first.slot.iso}"`);
  });

  it("el contenedor pide la ventana desde hoy, elige con `firstAvailable` y enfoca ese botón", () => {
    const src = readFileSync("components/booking/wizard/slot-window-step.tsx", "utf8");
    expect(src).toContain("firstAvailable(");
    expect(src).toContain("keepSelectionInWindow(");
    expect(src).toMatch(/listPublicSlotWindow\(/);
    expect(src).toMatch(/\.focus\(/);
    // Nada de primitivas con framer/portal (guard `public-surface-imports`).
    expect(src).not.toMatch(/components\/ui\/(drawer|modal|toast|confirm-dialog)/);
  });
});

describe("[CF-U5] anticipación mínima del turnero (CF-D9)", () => {
  const LEAD = "de anticipación.";
  it("con 120' muestra el aviso con formatLeadTime", () => {
    const html = view({ window: { ...WINDOW, minLeadMinutes: 120 } });
    expect(html).toContain("Los turnos online se piden con al menos 2 horas de anticipación.");
  });
  it("con 60' o sin el campo no hay aviso", () => {
    expect(view({ window: { ...WINDOW, minLeadMinutes: 60 } })).not.toContain(LEAD);
    expect(view()).not.toContain(LEAD);
  });
});
