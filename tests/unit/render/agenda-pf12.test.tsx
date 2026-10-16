import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

// PF1.2-agenda-b — pulido del drawer «Nuevo turno» (G6) y del drawer del turno (G7) de VX0-b. Render real (sin
// jsdom, como el resto de `tests/unit/render`); se mockean solo las server actions y los hooks de toast/confirm
// (mismo set que agenda-general-copy.test.tsx).
const { proxy } = vi.hoisted(() => ({
  proxy: () =>
    new Proxy(
      {},
      {
        get: (_t: object, k: string | symbol) =>
          k === "__esModule" ? true : k === "then" ? undefined : async () => ({ ok: true, data: {} }),
      }
    ),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => vi.fn(async () => true) }));
vi.mock("@/lib/bookings", () => proxy());
vi.mock("@/lib/plans-move", () => proxy());
vi.mock("@/lib/plans-read", () => proxy());
vi.mock("@/lib/plans-adopt", () => proxy());
vi.mock("@/lib/plans-edit", () => proxy());
vi.mock("@/lib/sessions", () => proxy());
vi.mock("@/lib/patients", () => proxy());
vi.mock("@/lib/diagnosis", () => proxy());
vi.mock("@/lib/availability-actions", () => proxy());
vi.mock("@/lib/time-blocks", () => proxy());
vi.mock("@/lib/session", () => proxy());
vi.mock("@/lib/search", () => proxy());

import { BookingModal } from "@/components/agenda/booking-modal";
import { StatusActions, statusActionOptions } from "@/components/agenda/booking-drawer/status-actions";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { capabilitiesFor } from "@/lib/capabilities";
import { modulesFor } from "@/lib/tenant-modules";

const KINE = modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: false });
const kine = (n: ReactNode) => renderToStaticMarkup(<TenantModulesProvider modules={KINE}>{n}</TenantModulesProvider>);

const props = {
  services: [{ id: "s1", name: "Consulta", durationMin: 30, priceCents: 0, color: null }],
  practitioners: [{ id: "p1", name: "Ana Pérez" }],
  patients: [{ id: "pt1", name: "Juana Gómez" }],
  insurers: [],
  onClose: () => {},
  onSaved: () => {},
  defaultISO: "2026-10-05T12:00:00.000Z",
  defaultPractitionerId: "p1",
  capabilities: [...capabilitiesFor("OWNER")],
};

/** Posición de cada marca en el HTML; falla si alguna no está. */
function positions(html: string, marks: string[]): number[] {
  return marks.map((m) => {
    const i = html.indexOf(m);
    expect(i, `falta ${m}`).toBeGreaterThanOrEqual(0);
    return i;
  });
}

describe("[PF1.2 G6] «Nuevo turno»: orden y «Detalles» colapsable", () => {
  it("Profesional → Servicio (+ayuda) → Fecha y hora → Detalles (título, descripción, notas) → footer", () => {
    const html = kine(<BookingModal {...props} />);
    const pos = positions(html, [
      'name="practitionerId"',
      'name="serviceId"',
      "Elegí el servicio para ver los horarios libres.",
      'name="scheduledFor"',
      "<details",
      'name="title"',
      'name="description"',
      'name="notes"',
      'type="submit"',
    ]);
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
    // La ayuda sale UNA vez (antes vivía en el hueco del picker, lejos del selector).
    expect(html.split("para ver los horarios libres").length - 1).toBe(1);
  });

  it("«Detalles» arranca cerrado y es un <summary> (foco y teclado nativos)", () => {
    const html = kine(<BookingModal {...props} />);
    expect(html).toMatch(/<details class="[^"]*"><summary class="[^"]*">Detalles/);
    expect(html).not.toMatch(/<details[^>]*\sopen/);
  });

  it("título y descripción ya no repiten el mismo placeholder", () => {
    const html = kine(<BookingModal {...props} />);
    const ph = [...html.matchAll(/name="(title|description)"[^>]*placeholder="([^"]*)"|placeholder="([^"]*)"[^>]*name="(title|description)"/g)].map(
      (m) => m[2] ?? m[3]
    );
    expect(ph).toHaveLength(2);
    expect(new Set(ph).size).toBe(2);
  });
});

describe("[PF1.2 G7] «Cambiar estado»: sin la transición al estado actual, una sola primaria", () => {
  it("statusActionOptions", () => {
    const confirmed = statusActionOptions("CONFIRMED");
    expect(confirmed.map((o) => o.status)).toEqual(["COMPLETED", "NO_SHOW", "CANCELLED"]);
    expect(confirmed.filter((o) => o.primary).map((o) => o.label)).toEqual(["Realizado"]);
    expect(statusActionOptions("PENDING").map((o) => o.label)).toEqual(["Realizado", "Confirmar", "Ausente", "Cancelar turno"]);
    // Ya realizado: nada primario, quedan las correcciones.
    const done = statusActionOptions("COMPLETED");
    expect(done.some((o) => o.primary)).toBe(false);
    expect(done.map((o) => o.label)).toEqual(["Confirmar", "Ausente", "Cancelar turno"]);
  });

  it("render: un turno Confirmado no ofrece «Confirmar» y hay un solo botón primario", () => {
    const html = renderToStaticMarkup(<StatusActions pending={false} onSetStatus={() => {}} current="CONFIRMED" />);
    expect(html).not.toContain(">Confirmar<");
    expect(html).toContain("Realizado");
    expect(html.split("k-btn-primary").length - 1).toBe(1);
    expect(html).not.toContain("k-btn-lime");
  });
});
