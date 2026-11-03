import { beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { useContext } from "react";

/**
 * [CF2-SL6..8] SalaClient real con 2 sedes: las caras reciben `live` recortado a la sede guardada y el contexto que
 * montan sus headers. Las caras son testigos (son de A-SB/A-SD); se mockean la red (actions) y `next/dynamic`
 * (resuelto en `beforeAll`, como `sala-board.test.tsx`).
 */
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

vi.mock("@/components/sala/displays/displays-drawer", () => ({ DisplaysDrawer: () => null }));
vi.mock("@/lib/bookings", () => ({ listAgendaBookings: vi.fn(), markReceptionAction: vi.fn() }));
vi.mock("@/lib/preferences", () => ({ updateAgendaViewPrefs: vi.fn(), updateUserPreferences: vi.fn() }));
vi.mock("@/lib/sala-bookings", () => ({ listSalaBookings: vi.fn() }));
vi.mock("@/lib/realtime-token", () => ({ mintRealtimeToken: async () => ({ ok: false, error: "realtime-off" }) }));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));

type LiveProbe = { rows: { id: string }[]; entries: { row: { id: string } }[]; rooms: { id: string }[] };
function Probe({ live }: { live: LiveProbe }) {
  const loc = useContext(SalaLocationContext);
  return (
    <div
      data-testid="face"
      data-rows={live.rows.map((r) => r.id).join(",")}
      data-entries={live.entries.map((e) => e.row.id).sort().join(",")}
      data-rooms={live.rooms.map((r) => r.id).join(",")}
      data-loc={loc ? String(loc.locationId) : "no-ctx"}
    >
      <SalaLocationSelect />
      <SalaOtherDayLink />
    </div>
  );
}
vi.mock("@/components/sala/desk/reception-desk", () => ({ ReceptionDesk: Probe }));
vi.mock("@/components/sala/sala-board-face", () => ({ SalaBoardFace: Probe }));

import { SalaClient } from "@/components/sala/sala-client";
import { SalaLocationContext, SalaLocationSelect, SalaOtherDayLink } from "@/components/sala/sala-location";
import { salaViewer } from "@/lib/sala-board-state";
import type { BookingDTO } from "@/components/agenda/agenda-utils";

const DAY = "2026-10-14";
const at = (h: string) => new Date(`${DAY}T${h}:00-03:00`).toISOString();

function dto(id: string, over: Partial<BookingDTO> = {}): BookingDTO {
  return {
    id, scheduledFor: at("10:00"), durationMin: 45, status: "CONFIRMED", serviceId: "s", serviceName: "Kinesiología",
    serviceColor: "#3d74b5", practitionerId: "p1", patientId: `pat-${id}`, patientName: `Paciente ${id}`,
    patientCondition: null, obraSocial: "Particular", copagoCents: 0, updatedAt: at("08:00"), notes: null,
    title: null, description: null, patientAccess: "full", isOverbooked: false, arrivedAt: null,
    attendingAt: null, calledAt: null, roomId: null, canOperate: true, ...over,
  };
}
const ROWS = [dto("prim", { locationId: null }), dto("centro", { locationId: "a" }), dto("norte", { locationId: "b" })];
const LOCS = [
  { id: "a", name: "Centro", isPrimary: true },
  { id: "b", name: "Norte", isPrimary: false },
];
const ROOMS = [
  { id: "r1", name: "Box 1", capacity: 1, locationId: "a" },
  { id: "r2", name: "Gimnasio", capacity: 3, locationId: "b" },
];
const SECRETARIA = salaViewer(null, ["agenda.viewAll", "agenda.reception", "agenda.operateAll"]);

const render = (over: Partial<Parameters<typeof SalaClient>[0]> = {}) =>
  renderToStaticMarkup(
    <SalaClient
      dayKey={DAY}
      initialNow={at("09:00")}
      initialRows={ROWS}
      practitioners={[{ id: "p1", name: "Ana Pérez", initials: "AP" }]}
      rooms={ROOMS}
      viewer={SECRETARIA}
      initialGroupBy="practitioner"
      initialLayout="list"
      locations={LOCS}
      initialLocationId="b"
      {...over}
    />
  );

describe("[CF2-SL6] /sala con 2 sedes y Norte guardada", () => {
  it("las caras reciben filas, entradas y salas de Norte (escritorio y Tablero)", () => {
    for (const layout of ["list", "board"] as const) {
      const html = render({ initialLayout: layout });
      expect(html, layout).toContain('data-rows="norte"');
      expect(html, layout).toContain('data-entries="norte"');
      expect(html, layout).toContain('data-rooms="r2"');
      expect(html, layout).toContain('data-loc="b"');
    }
  });
  it("Centro (principal) incluye los turnos sin sede", () => {
    const html = render({ initialLocationId: "a" });
    expect(html).toContain('data-rows="prim,centro"');
    expect(html).toContain('data-rooms="r1"');
  });
  it("selector «Sede» con Norte elegida y el link a la Recepción de la agenda", () => {
    const html = render();
    expect(html).toContain("<span class=\"sala-loc-label\">Sede</span>");
    expect(html).toContain('<option value="">Todas las sedes</option>');
    expect(html).toMatch(/<option value="b" selected="">Norte<\/option>/);
    expect(html).toContain('href="/agenda?view=reception"');
    expect(html).toContain("¿Otro día?");
  });
});

describe("[CF2-SL7] sin filtro", () => {
  it("una sola sede: todo, sin contexto ni selector (el link sí)", () => {
    const html = render({ locations: [LOCS[0]], initialLocationId: "a" });
    expect(html).toContain('data-rows="prim,centro,norte"');
    expect(html).toContain('data-rooms="r1,r2"');
    expect(html).toContain('data-loc="no-ctx"');
    expect(html).not.toContain("sala-loc-label");
    expect(html).toContain('href="/agenda?view=reception"');
  });
  it("«Todas las sedes» (o sede guardada que ya no existe): todo, con selector", () => {
    for (const saved of [null, "archivada"]) {
      const html = render({ initialLocationId: saved });
      expect(html).toContain('data-rows="prim,centro,norte"');
      expect(html).toContain('data-loc="null"');
      expect(html).toContain('<option value="" selected="">Todas las sedes</option>');
    }
  });
  it("sin las props nuevas (tests viejos, demo): igual que antes de CF2", () => {
    const html = render({ locations: undefined, initialLocationId: undefined });
    expect(html).toContain('data-rows="prim,centro,norte"');
    expect(html).toContain('data-loc="no-ctx"');
  });
});
