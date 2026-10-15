/**
 * [PL-2f] Salas por plan en la UI (C-PL1, PL-D7): sin el módulo `salas` (Individual / Consultorio) Configuración no
 * muestra el CRUD de salas ni el selector de sala de las franjas, y en su lugar va el aviso corto «Las salas están en
 * el plan Clínica». Con el módulo (Clínica), lo de siempre. Render estático (`renderToStaticMarkup`, sin jsdom) de
 * los componentes reales dentro del `TenantModulesProvider` real; se mockean solo las server actions (red) y
 * `next/navigation`. La barrera es el server (tests/integration/pl2f-rooms-plan.test.ts): esto es UX.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));
vi.mock("@/lib/rooms", () => ({
  createRoom: async () => ({ ok: true, data: { id: "x" } }),
  updateRoom: async () => ({ ok: true, data: undefined }),
  archiveRoom: async () => ({ ok: true, data: undefined }),
  restoreRoom: async () => ({ ok: true, data: undefined }),
}));
vi.mock("@/lib/practitioner-schedule", () => ({
  getPractitionerSchedule: async () => null,
  savePractitionerWeek: async () => ({ ok: true, data: { version: null } }),
}));

import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import type { SaasPlan } from "@prisma/client";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { RoomsSection, ROOMS_COPY } from "@/components/configuracion/panels/rooms-section";
import { RangeRowsEditor } from "@/components/configuracion/panels/practitioners/schedule-editor";
import { modulesFor } from "@/lib/tenant-modules";
import type { LocationRow } from "@/lib/locations-schemas";
import type { RoomRow } from "@/lib/rooms-types";
import type { DraftRange, RoomCatalogEntry } from "@/lib/schedule-editor-state";

const render = (plan: SaasPlan, el: ReactElement) =>
  renderToStaticMarkup(
    <TenantModulesProvider modules={modulesFor({ vertical: "GENERAL", plan, publicBookingEnabled: false })} vertical="GENERAL">
      <ToastProvider>
        <ConfirmProvider>{el}</ConfirmProvider>
      </ToastProvider>
    </TenantModulesProvider>
  );
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const ROOM_ROWS: RoomRow[] = [
  { id: "c1", locationId: "L1", name: "Consultorio 1", kind: "CONSULTORIO", capacity: 1, active: true, sortOrder: 0, scheduleCount: 2 },
];
const CATALOG: RoomCatalogEntry[] = [
  { id: "c1", locationId: "L1", name: "Consultorio 1", kind: "CONSULTORIO", capacity: 1, active: true },
];
const LOCS = [{ id: "L1", name: "Centro", isPrimary: true, active: true }] as unknown as LocationRow[];
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
const rangeEditor = (rows: DraftRange[]) => (
  <RangeRowsEditor
    rows={rows}
    onChange={() => {}}
    errors={{}}
    locations={LOCS}
    showLocation={false}
    defaults={{ startMin: 480, endMin: 1140, locationId: "L1" }}
    dayLabel="Lunes"
    rooms={CATALOG}
  />
);

describe("[PL-2f] Configuración › salas según el plan", () => {
  it("Consultorio: la sección de salas es solo el aviso (sin lista ni «Nueva sala»)", () => {
    const html = render("CONSULTORIO", <RoomsSection locationId="L1" locationName="Centro" rooms={ROOM_ROWS} />);
    expect(text(html)).toContain(ROOMS_COPY.upsell);
    expect(ROOMS_COPY.upsell).toBe("Las salas vienen con los planes Clínica y Libre. El plan se cambia en Configuración → Plan y uso.");
    expect(text(html)).not.toContain(ROOMS_COPY.add);
    expect(text(html)).not.toContain("Consultorio 1");
  });

  it("Clínica: la sección de siempre, sin el aviso", () => {
    const html = render("CLINICA", <RoomsSection locationId="L1" locationName="Centro" rooms={ROOM_ROWS} />);
    expect(text(html)).toContain(ROOMS_COPY.add);
    expect(text(html)).toContain("Consultorio 1");
    expect(text(html)).not.toContain(ROOMS_COPY.upsell);
  });

  it("franjas: sin el módulo no hay selector de sala, ni siquiera con una sala dormida en la franja", () => {
    for (const r of [row(), row({ roomId: "c1" })]) {
      const html = render("CONSULTORIO", rangeEditor([r]));
      expect(html).not.toContain("Lunes, franja 1: sala");
      expect(text(html)).not.toContain("Sin sala");
    }
    expect(render("CLINICA", rangeEditor([row()]))).toContain("Lunes, franja 1: sala");
  });
});
