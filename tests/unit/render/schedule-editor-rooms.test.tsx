/**
 * [SR-U2] Configuración › Profesionales › Horarios: sala y vigencia por franja.
 * Render estático (`renderToStaticMarkup`, sin jsdom) del `RangeRowsEditor`
 * real (lo usan la semana y las excepciones). Se mockean solo las server
 * actions (red) y `next/navigation`; nunca el componente bajo test. TZ=UTC.
 *
 * Contratos:
 *   • sin salas en la sede de la fila, el select de sala NO aparece (sin salas
 *     cargadas, la pantalla es la de antes de SR);
 *   • con salas, aparece filtrado por la sede de la fila, con "Sin sala";
 *   • el error de choque va en la fila ("Esa sala ya la usa…");
 *   • la vigencia está plegada ("Siempre · Solo por un período" / "Del … al …");
 *   • mobile 360 px: la fila hace wrap y nada impone un ancho fijo.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));
vi.mock("@/lib/practitioner-schedule", () => ({
  getPractitionerSchedule: async () => null,
  savePractitionerWeek: async () => ({ ok: true, data: { version: null } }),
}));

import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { RangeRowsEditor, WeekDrawer } from "@/components/configuracion/panels/practitioners/schedule-editor";
import type { PractitionerScheduleView, ScheduleRangeRow } from "@/lib/practitioner-schedule-schemas";
import type { LocationRow } from "@/lib/locations-schemas";
import { emptyWeek, validateDraft, type DraftRange, type RoomCatalogEntry } from "@/lib/schedule-editor-state";

const render = (el: ReactElement) =>
  renderToStaticMarkup(
    <ToastProvider>
      <ConfirmProvider>{el}</ConfirmProvider>
    </ToastProvider>
  );
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const loc = (id: string, name: string, isPrimary = false): LocationRow =>
  ({ id, name, isPrimary, active: true }) as unknown as LocationRow;
const LOCS = [loc("L1", "Centro", true), loc("L2", "Norte")];

const ROOMS: RoomCatalogEntry[] = [
  { id: "c1", locationId: "L1", name: "Consultorio 1", kind: "CONSULTORIO", capacity: 1, active: true },
  { id: "c2", locationId: "L1", name: "Consultorio 2", kind: "CONSULTORIO", capacity: 1, active: true },
  { id: "b1", locationId: "L2", name: "Box Norte", kind: "BOX", capacity: 1, active: true },
  { id: "old", locationId: "L1", name: "Viejo", kind: "SALA", capacity: 1, active: false },
];

const row = (p: Partial<DraftRange> = {}): DraftRange => ({
  key: "k1",
  startMin: 600,
  endMin: 660,
  locationId: "L1",
  roomId: null,
  validFrom: null,
  validUntil: null,
  ...p,
});

function editor(o: {
  rows: DraftRange[];
  rooms?: RoomCatalogEntry[];
  errors?: Record<string, string>;
  showLocation?: boolean;
  showValidity?: boolean;
}) {
  return render(
    <RangeRowsEditor
      rows={o.rows}
      onChange={() => {}}
      errors={o.errors ?? {}}
      locations={LOCS}
      showLocation={o.showLocation ?? false}
      defaults={{ startMin: 480, endMin: 1140, locationId: "L1" }}
      dayLabel="Lunes"
      rooms={o.rooms}
      showValidity={o.showValidity}
    />
  );
}

/** Opciones (texto) del <select> cuyo aria-label es `label`. */
function selectOptions(html: string, label: string): string[] {
  const start = html.indexOf(`aria-label="${label}"`);
  if (start < 0) return [];
  const end = html.indexOf("</select>", start);
  return Array.from(html.slice(start, end).matchAll(/<option[^>]*>([^<]*)<\/option>/g), (m) => m[1]);
}

describe("[SR-U2] select de sala", () => {
  it("sin salas (catálogo vacío o ausente) no aparece", () => {
    for (const rooms of [undefined, []]) {
      const html = editor({ rows: [row()], rooms });
      expect(html).not.toContain("Lunes, franja 1: sala");
      expect(text(html)).not.toContain("Sin sala");
    }
  });

  it("con salas aparece, filtrado por la sede de la fila y con «Sin sala»", () => {
    const html = editor({ rows: [row(), row({ key: "k2", startMin: 700, endMin: 760, locationId: "L2" })], rooms: ROOMS });
    expect(selectOptions(html, "Lunes, franja 1: sala")).toEqual(["Sin sala", "Consultorio 1", "Consultorio 2"]);
    expect(selectOptions(html, "Lunes, franja 2: sala")).toEqual(["Sin sala", "Box Norte"]);
  });

  it("una sede sin salas no muestra el select aunque otra sede tenga", () => {
    const html = editor({ rows: [row({ locationId: "L2" })], rooms: ROOMS.filter((r) => r.locationId === "L1") });
    expect(html).not.toContain("Lunes, franja 1: sala");
  });

  it("la sala elegida queda seleccionada; una archivada ya asignada se rotula", () => {
    const html = editor({ rows: [row({ roomId: "old" })], rooms: ROOMS });
    expect(selectOptions(html, "Lunes, franja 1: sala")).toContain("Viejo (archivada)");
    expect(html).toMatch(/<option value="old" selected="">Viejo \(archivada\)<\/option>/);
  });
});

describe("[SR-U2] error por fila", () => {
  it("«Esa sala ya la usa…» se pinta en la fila que choca (mismo validador que la action)", () => {
    const week = emptyWeek();
    const ok = row({ key: "libre", startMin: 480, endMin: 540, roomId: "c1" });
    const bad = row({ key: "choca", roomId: "c2" });
    week[1] = [ok, bad];
    const errors = validateDraft(week, undefined, {
      rooms: ROOMS,
      usage: [
        {
          roomId: "c2",
          practitionerId: "ana",
          practitionerName: "Ana Pérez",
          dow: 1,
          startMin: 540,
          endMin: 780,
          validFrom: null,
          validUntil: null,
        },
      ],
      practitionerId: "beto",
      today: "2026-10-07",
    });
    const html = editor({ rows: week[1], rooms: ROOMS, errors });
    const alerts = Array.from(html.matchAll(/<div role="alert"[^>]*>([^<]*)<\/div>/g), (m) => m[1]);
    expect(alerts).toEqual([
      "Esa sala ya la usa Ana Pérez los lunes de 9:00 a 13:00. Elegí otra sala o cambiá el horario.",
    ]);
    // El alert va después de la fila que choca (k2), no de la libre.
    expect(html.indexOf('data-range-row="choca"')).toBeLessThan(html.indexOf('role="alert"'));
    expect(html.indexOf('data-range-row="libre"')).toBeLessThan(html.indexOf('data-range-row="choca"'));
  });
});

describe("[SR-U2] vigencia plegada", () => {
  it("sin vigencia: «Siempre · Solo por un período», sin campos de fecha", () => {
    const html = editor({ rows: [row()], rooms: ROOMS, showValidity: true });
    expect(text(html)).toContain("Siempre · Solo por un período");
    expect(html).not.toContain('type="date"');
  });

  it("con vigencia: «Del 01/11 al 30/11 · Cambiar»", () => {
    const html = editor({
      rows: [row({ validFrom: "2026-11-01", validUntil: "2026-11-30" })],
      rooms: ROOMS,
      showValidity: true,
    });
    expect(text(html)).toContain("Del 01/11 al 30/11 · Cambiar");
    expect(html).not.toContain('type="date"');
  });

  it("en una excepción (sin showValidity) no hay vigencia", () => {
    const html = editor({ rows: [row()], rooms: ROOMS });
    expect(text(html)).not.toContain("Solo por un período");
  });
});

describe("[SR-U2] mobile 360 px", () => {
  it("la fila hace wrap y ningún control impone un ancho fijo mayor a la pantalla", () => {
    const html = editor({ rows: [row({ roomId: "c1" })], rooms: ROOMS, showLocation: true, showValidity: true });
    const rowDiv = html.slice(html.indexOf('data-range-row="k1"'));
    expect(rowDiv).toMatch(/^[^>]*><div style="display:flex;flex-wrap:wrap/);
    // Selects de sede y sala: se encogen (min-width:0) y no pasan de 260 px.
    const selects = Array.from(html.matchAll(/<select[^>]*style="([^"]*)"/g), (m) => m[1]);
    expect(selects.length).toBe(4); // desde, hasta, sede, sala
    for (const s of selects) expect(s).toContain("min-width:0");
    for (const m of html.matchAll(/(?:^|[;"])(?:min-)?width:(\d+)px/g)) expect(Number(m[1])).toBeLessThanOrEqual(260);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [SRZ-FX3] M3 · la vigencia sale solo con salas (o si la franja ya la tiene)
//
// Bug (revisión b, M3): el cliente vivo, SIN salas, abría "Editar semana" y
// veía una línea "Siempre · Solo por un período" en cada franja (≈12 líneas
// extra con 2 franjas × 6 días), contra el contrato "sin salas, todo igual que
// hoy". Decisión del orquestador: se oculta sin salas, salvo que la franja ya
// tenga vigencia (nunca se esconde un dato cargado). Se monta el `WeekDrawer`
// real (es quien decide `showValidity`).
// ─────────────────────────────────────────────────────────────────────────────

const rangeRow = (p: Partial<ScheduleRangeRow> = {}): ScheduleRangeRow => ({
  id: "r1",
  dow: 1,
  startMin: 540,
  endMin: 780,
  locationId: "L1",
  roomId: null,
  validFrom: null,
  validUntil: null,
  ...p,
});
const scheduleView = (ranges: ScheduleRangeRow[]): PractitionerScheduleView => ({
  practitionerId: "beto",
  ranges,
  version: "2026-10-01T00:00:00.000Z",
  isFallback: false,
  tenantHours: { startMin: 480, endMin: 1200 },
  roomUsage: [],
});
function weekDrawer(ranges: ScheduleRangeRow[], rooms?: RoomCatalogEntry[]) {
  return render(
    <WeekDrawer
      view={scheduleView(ranges)}
      practitionerId="beto"
      practitionerName="Beto"
      locations={LOCS}
      rooms={rooms}
      primaryLocationId="L1"
      reload={async () => null}
      onClose={() => {}}
      onSaved={() => {}}
    />
  );
}

describe("[SRZ-FX3] M3 · vigencia en «Editar semana»", () => {
  const two = [rangeRow(), rangeRow({ id: "r2", dow: 2, startMin: 900, endMin: 1140 })];

  it("sin salas (catálogo ausente o vacío): ni «Siempre» ni «Solo por un período»", () => {
    for (const rooms of [undefined, []]) {
      const t = text(weekDrawer(two, rooms));
      expect(t).toContain("Lunes"); // el drawer se dibujó
      expect(t).not.toContain("Siempre");
      expect(t).not.toContain("Solo por un período");
    }
  });

  it("con salas: cada franja tiene su línea de vigencia", () => {
    const html = weekDrawer(two, ROOMS);
    expect(html.match(/Siempre/g)?.length).toBe(2);
  });

  it("sin salas pero con una vigencia ya cargada: esa franja la muestra (no se esconde un dato)", () => {
    const t = text(weekDrawer([rangeRow({ validUntil: "2026-11-30" }), rangeRow({ id: "r2", dow: 2 })], []));
    expect(t).toContain("Hasta el 30/11 · Cambiar");
    expect(t).not.toContain("Siempre"); // la otra franja, sin vigencia, no
  });
});
