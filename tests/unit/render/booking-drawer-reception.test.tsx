import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// HF-2c (H-LL1, D-HF1/PL-D6): «Llegó» / «En atención» / «Deshacer» en el drawer del turno, para TODOS los planes.
// Antes Individual y Consultorio no tenían dónde marcar la llegada (la vista Recepción y /sala son de Clínica /
// Libre, y el drawer solo tenía las acciones de estado) aunque `markReceptionAction` lo permitía. Render real del
// drawer (sin jsdom, como el resto de `tests/unit/render`); se mockean solo las server actions (red/DB), toast,
// confirm y la navegación. El reloj se fija con fake timers: «hoy» es el día AR del sistema.
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

import { BookingDrawer } from "@/components/agenda/booking-drawer";
import type { DrawerBooking } from "@/components/agenda/booking-drawer/types";
import { ReceptionInfo } from "@/components/agenda/booking-drawer/reception-info";
import { drawerReceptionActions } from "@/components/agenda/booking-drawer/reception-actions";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { capabilitiesFor } from "@/lib/capabilities";
import { modulesFor } from "@/lib/tenant-modules";

// 2026-10-05 10:50 AR (13:50Z). El turno de «hoy» es a las 10:30 AR.
const NOW = new Date("2026-10-05T13:50:00.000Z");
const TODAY_SLOT = "2026-10-05T13:30:00.000Z";
const TOMORROW_SLOT = "2026-10-06T13:30:00.000Z";

const ASSISTANT = [...capabilitiesFor("ASSISTANT")];
const BILLING = [...capabilitiesFor("BILLING")];
const OWNER = [...capabilitiesFor("OWNER")];

const consultorio = [...modulesFor({ vertical: "GENERAL", plan: "CONSULTORIO", publicBookingEnabled: false })];
const clinica = [...modulesFor({ vertical: "GENERAL", plan: "CLINICA", publicBookingEnabled: false })];

function booking(over: Partial<DrawerBooking> = {}): DrawerBooking {
  return {
    id: "b1",
    scheduledFor: TODAY_SLOT,
    durationMin: 45,
    status: "CONFIRMED",
    serviceName: "Consulta",
    serviceColor: "#3b82f6",
    practitionerId: "p1",
    patientId: "pt1",
    patientName: "Martina Gómez",
    patientCondition: null,
    obraSocial: "OSDE",
    copagoCents: 0,
    updatedAt: "2026-10-05T11:00:00.000Z",
    notes: null,
    title: null,
    description: null,
    patientAccess: "basic",
    clinicalHidden: true,
    canOperate: true,
    clinicalWritable: false,
    ...over,
  };
}

const renderDrawer = (b: DrawerBooking, capabilities: readonly string[], modules: readonly string[]) =>
  renderToStaticMarkup(
    <TenantModulesProvider modules={modules as never}>
      <BookingDrawer booking={b} onClose={() => {}} onSaved={() => {}} capabilities={capabilities} />
    </TenantModulesProvider>
  );

/** Los botones de recepción del drawer (`data-reception-action`), en orden. */
const receptionButtons = (html: string) => [...html.matchAll(/data-reception-action="([^"]+)"/g)].map((m) => m[1]);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("[HF-2c] «Llegó» en el drawer del turno", () => {
  it("[HF-2c] drawer en Consultorio muestra «Llegó» y no «Llamar»", () => {
    const html = renderDrawer(booking(), ASSISTANT, consultorio);
    expect(receptionButtons(html)).toEqual(["llego"]);
    expect(html).toContain(">Llegó<");
    expect(html).not.toContain(">Llamar<");

    // En sala: En atención + Deshacer, todavía sin Llamar (sin `salaEspera`).
    const inRoom = renderDrawer(booking({ arrivedAt: "2026-10-05T13:42:00.000Z" }), ASSISTANT, consultorio);
    expect(receptionButtons(inRoom)).toEqual(["en-atencion", "deshacer"]);
    expect(inRoom).not.toContain(">Llamar<");
  });

  it("[HF-2c] con Sala de Espera (Clínica), en sala ofrece también «Llamar»", () => {
    const html = renderDrawer(booking({ arrivedAt: "2026-10-05T13:42:00.000Z" }), ASSISTANT, clinica);
    expect(receptionButtons(html)).toEqual(["llamar", "en-atencion", "deshacer"]);
  });

  it("[HF-2c] turno de mañana no muestra acciones de recepción", () => {
    const html = renderDrawer(booking({ scheduledFor: TOMORROW_SLOT }), ASSISTANT, consultorio);
    expect(receptionButtons(html)).toEqual([]);
    // El drawer sigue siendo el de siempre (las acciones de estado no dependen del día).
    expect(html).toContain("Cambiar estado");
  });

  it("[HF-2c] BILLING no ve las acciones", () => {
    // BILLING no tiene `agenda.reception` (el server lo rechaza con «permiso»): aunque la fila diga canOperate.
    const html = renderDrawer(booking(), BILLING, consultorio);
    expect(receptionButtons(html)).toEqual([]);
  });

  it("[HF-2c] sin canOperate del turno (acceso básico sin operateAll) no hay acciones", () => {
    const html = renderDrawer(booking({ canOperate: false }), OWNER, consultorio);
    expect(receptionButtons(html)).toEqual([]);
  });

  it("[HF-2c] Deshacer solo desde en sala, llamado o en atención: no desde Atendido / Ausente (eso es Cambiar estado)", () => {
    const now = NOW;
    const base = { caps: new Set(ASSISTANT), canOperate: true, waitingRoom: true, now } as const;
    expect(drawerReceptionActions(booking({ status: "COMPLETED", arrivedAt: TODAY_SLOT }), base)).toEqual([]);
    expect(drawerReceptionActions(booking({ status: "NO_SHOW" }), base)).toEqual([]);
    expect(drawerReceptionActions(booking({ status: "CANCELLED" }), base)).toEqual([]);
    expect(
      drawerReceptionActions(booking({ arrivedAt: TODAY_SLOT, calledAt: "2026-10-05T13:45:00.000Z" }), base)
    ).toEqual(["en-atencion", "deshacer"]);
    expect(
      drawerReceptionActions(booking({ arrivedAt: TODAY_SLOT, attendingAt: "2026-10-05T13:48:00.000Z" }), base)
    ).toEqual(["deshacer"]);
    // Demorado (pasaron más de 10'): sigue ofreciendo «Llegó».
    expect(drawerReceptionActions(booking({ scheduledFor: "2026-10-05T13:00:00.000Z" }), base)).toEqual(["llego"]);
  });

  it("[HF-2c] «hoy» es el día AR: un turno de las 22:30 AR de hoy (= mañana en UTC) muestra «Llegó»", () => {
    vi.setSystemTime(new Date("2026-10-06T01:00:00.000Z")); // 22:00 AR del 05
    const b = booking({ scheduledFor: "2026-10-06T01:30:00.000Z" }); // 22:30 AR del 05
    const base = { caps: new Set(ASSISTANT), canOperate: true, waitingRoom: false, now: new Date() } as const;
    expect(drawerReceptionActions(b, base)).toEqual(["llego"]);
  });
});

describe("[HF-2c] fila Recepción del detalle", () => {
  const info = (b: DrawerBooking) => renderToStaticMarkup(<ReceptionInfo booking={b} />);

  it("en sala hoy: «En sala de espera desde las 10:42» (hora AR)", () => {
    expect(info(booking({ arrivedAt: "2026-10-05T13:42:00.000Z" }))).toContain("En sala de espera desde las 10:42");
  });

  it("llamado: dice el llamado y desde cuándo espera", () => {
    const html = info(booking({ arrivedAt: "2026-10-05T13:42:00.000Z", calledAt: "2026-10-05T13:47:00.000Z" }));
    expect(html).toContain("Llamado a las 10:47");
    expect(html).toContain("en sala desde las 10:42");
  });

  it("llegada de otro día: «Llegó a las …», no «En sala» (no sigue esperando)", () => {
    const html = info(booking({ scheduledFor: "2026-10-04T13:30:00.000Z", arrivedAt: "2026-10-04T13:42:00.000Z" }));
    expect(html).toContain("Llegó a las 10:42");
    expect(html).not.toContain("En sala de espera");
  });

  it("en atención y atendido como antes", () => {
    expect(
      info(booking({ arrivedAt: "2026-10-05T13:42:00.000Z", attendingAt: "2026-10-05T13:48:00.000Z" }))
    ).toContain("En atención desde las 10:48");
    expect(
      info(
        booking({
          status: "COMPLETED",
          arrivedAt: "2026-10-05T13:42:00.000Z",
          attendingAt: "2026-10-05T13:48:00.000Z",
        })
      )
    ).toContain("Llegó a las 10:42");
  });
});
