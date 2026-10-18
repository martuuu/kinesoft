/**
 * [AS-1r] T3d-1r · cobrar desde el drawer del turno (T3, C-AS2; plan §23.4: «drawer del turno "Cobrar" / "Pagado ·
 * Efectivo · Deshacer cobro" (diferido)»).
 *
 * Render real de `BillingRows` (la fila Copago del drawer) y del cuerpo del modal «Registrar cobro» del drawer, sin
 * jsdom, como el resto de `tests/unit/render`. Se mockean solo las server actions (red/DB) y los hooks de toast/confirm.
 * Quién cobra sale de `canCollectCopago` con las capabilities REALES de cada rol (`capabilitiesFor`): el mismo gate que
 * `toggleBilling` en el server, así el botón y la action no divergen.
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

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
// Las actions (red/DB) y lo que arrastra el drawer completo (mismo set que booking-drawer-secretaria.test.tsx).
vi.mock("@/lib/bookings", () => proxy());
vi.mock("@/lib/booking-share-actions", () => ({ getPatientShareContact: async () => ({ status: "hidden" }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));
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
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => vi.fn(async () => true) }));

import { BookingDrawer } from "@/components/agenda/booking-drawer";
import { BillingRows, copagoCollectView } from "@/components/agenda/booking-drawer/billing-rows";
import { CollectForm, validateCollect } from "@/components/agenda/booking-drawer/collect-modal";
import type { DrawerBooking } from "@/components/agenda/booking-drawer/types";
import { capabilitiesFor, type Capability } from "@/lib/capabilities";
import { formatARS } from "@/lib/format";

const SECRETARIA = capabilitiesFor("ASSISTANT");
const PROFESIONAL = capabilitiesFor("PRACTITIONER");
const NADIE: ReadonlySet<Capability> = new Set();

function booking(over: Partial<DrawerBooking> = {}): DrawerBooking {
  return {
    id: "b1",
    scheduledFor: "2026-10-05T12:00:00.000Z",
    durationMin: 45,
    status: "CONFIRMED",
    serviceName: "Kinesio",
    serviceColor: "#3b82f6",
    practitionerId: "p1",
    patientId: "pt1",
    patientName: "Juana Gómez",
    patientCondition: null,
    obraSocial: "OSDE",
    copagoCents: 150000,
    updatedAt: "2026-10-05T11:00:00.000Z",
    notes: null,
    title: null,
    description: null,
    patientAccess: "basic",
    paymentStatus: "UNPAID",
    copagoPaymentMethod: null,
    ...over,
  };
}

const render = (b: DrawerBooking, caps: ReadonlySet<Capability>, viewerPractitionerId: string | null = null) =>
  renderToStaticMarkup(<BillingRows booking={b} caps={caps} viewerPractitionerId={viewerPractitionerId} />);

describe("[AS-1r] fila Copago del drawer", () => {
  it("[AS-1r] la Secretaria ve «Cobrar» en un turno por cobrar", () => {
    const html = render(booking(), SECRETARIA);
    expect(html).toContain("Por cobrar");
    expect(html).toContain(">Cobrar<");
    expect(html).not.toContain("Deshacer cobro");
  });

  it("[AS-1r] el profesional ve «Cobrar» solo en SU turno (en el ajeno, solo el estado)", () => {
    expect(render(booking({ practitionerId: "p1" }), PROFESIONAL, "p1")).toContain(">Cobrar<");
    const ajeno = render(booking({ practitionerId: "p2" }), PROFESIONAL, "p1");
    expect(ajeno).toContain("Por cobrar");
    expect(ajeno).not.toContain(">Cobrar<");
    // Sin saber quién es el profesional del viewer (null), nunca hay «propios».
    expect(render(booking({ practitionerId: "p1" }), PROFESIONAL, null)).not.toContain(">Cobrar<");
  });

  it("[AS-1r] pagado muestra el medio y «Deshacer cobro» a quien cobra", () => {
    const html = render(booking({ paymentStatus: "PAID", copagoPaymentMethod: "CASH" }), SECRETARIA);
    expect(html).toContain("Pagado · Efectivo");
    expect(html).toContain("Deshacer cobro");
    expect(html).not.toContain(">Cobrar<");
    // Cobrado antes de T3 (sin medio): «Sin informar», no se inventa uno.
    expect(render(booking({ paymentStatus: "PAID", copagoPaymentMethod: null }), SECRETARIA)).toContain("Pagado · Sin informar");
  });

  it("[AS-1r] sin permiso de cobro: solo el estado, sin botones", () => {
    const porCobrar = render(booking(), NADIE);
    expect(porCobrar).toContain("Por cobrar");
    expect(porCobrar).not.toContain(">Cobrar<");
    const pagado = render(booking({ paymentStatus: "PAID", copagoPaymentMethod: "TRANSFER" }), NADIE);
    expect(pagado).toContain("Pagado · Transferencia");
    expect(pagado).not.toContain("Deshacer cobro");
  });

  it("[AS-1r] pagado por Mercado Pago: sin botones, aunque el viewer cobre", () => {
    // Reserva pública cobrada por MP: el webhook marca PAID sin medio manual.
    const mp = render(booking({ paymentStatus: "PAID", copagoPaymentMethod: null, publicReservation: true }), SECRETARIA);
    expect(mp).toContain("Pagado por Mercado Pago");
    expect(mp).not.toContain("Deshacer cobro");
    const retenido = render(booking({ paymentStatus: "AUTHORIZED" }), SECRETARIA);
    expect(retenido).not.toContain(">Cobrar<");
    expect(retenido).not.toContain("Deshacer cobro");
  });

  it("[AS-1r] sin copago, cancelado o sin dato del cobro: no se ofrece «Cobrar»", () => {
    expect(copagoCollectView(booking({ copagoCents: 0 }), SECRETARIA, null).action).toBeNull();
    expect(copagoCollectView(booking({ status: "CANCELLED" }), SECRETARIA, null).action).toBeNull();
    expect(copagoCollectView(booking({ status: "NO_SHOW" }), SECRETARIA, null).action).toBeNull();
    expect(copagoCollectView(booking({ paymentStatus: undefined }), SECRETARIA, null)).toEqual({ label: null, action: null });
    // Un cancelado que se había cobrado SÍ se puede deshacer (cobro previo de plan, B-M3).
    expect(copagoCollectView(booking({ status: "CANCELLED", paymentStatus: "PAID", copagoPaymentMethod: "CASH" }), SECRETARIA, null).action).toBe("undo");
  });
});

describe("[AS-1r] modal «Registrar cobro» del drawer", () => {
  it("[AS-1r] el medio es obligatorio: sin preselección y «Elegí cómo pagó.» si falta", () => {
    expect(validateCollect(null)).toEqual({ ok: false, error: "Elegí cómo pagó." });
    expect(validateCollect("CARD")).toEqual({ ok: true, method: "CARD" });
    const html = renderToStaticMarkup(
      <CollectForm amountCents={150000} method={null} onMethod={() => {}} error="Elegí cómo pagó." saving={false} onCancel={() => {}} onConfirm={() => {}} />
    );
    expect(html).not.toMatch(/checked=""/);
    expect(html).toContain("Elegí cómo pagó.");
    expect(html).toContain(`Marcar pagado · ${formatARS(150000)}`);
  });
});

describe("[AS-1r] drawer completo", () => {
  it("[AS-1r] el drawer le pasa las capabilities a la fila: la Secretaria ve «Cobrar»", () => {
    const html = renderToStaticMarkup(
      <BookingDrawer booking={booking({ canOperate: true, clinicalWritable: false })} onClose={() => {}} onSaved={() => {}} capabilities={[...SECRETARIA]} />
    );
    expect(html).toContain(">Cobrar<");
    // Sin capabilities (proyección vieja / caller que no las pasa): solo el estado.
    const sin = renderToStaticMarkup(<BookingDrawer booking={booking()} onClose={() => {}} onSaved={() => {}} capabilities={null} />);
    expect(sin).toContain("Por cobrar");
    expect(sin).not.toContain(">Cobrar<");
  });
});
