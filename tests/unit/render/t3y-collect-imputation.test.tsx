/**
 * [T3-Y] El modal «Registrar cobro» dice SIEMPRE a quién se imputa el pago (decisión de Martin del 19-oct: «Estaría
 * bueno que se afirme a quién se le imputa el pago»), en los tres lugares donde se cobra: el drawer del turno de la
 * agenda, el escritorio de /sala y Facturación del perfil del paciente. Antes el profesional salía solo en /sala y
 * solo con más de un profesional (T3-Z B2).
 *
 * Render real de cada modal (sin jsdom, como el resto de `tests/unit/render`); se mockean solo las server actions y
 * los hooks de toast/confirm. La línea sale de `collectImputationLine` (lib/booking-collect.ts, su unit test cubre los
 * tres casos); acá se fija que cada pantalla la muestre con el nombre público que tiene a mano y que la descripción no
 * repita el profesional.
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { proxy, billingRowsProps } = vi.hoisted(() => ({
  proxy: () =>
    new Proxy(
      {},
      {
        get: (_t: object, k: string | symbol) =>
          k === "__esModule" ? true : k === "then" ? undefined : async () => ({ ok: true, data: {} }),
      }
    ),
  billingRowsProps: [] as Record<string, unknown>[],
}));
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
// TP-3f2: Facturación monta la card «Links de pago» (server actions de cobros online): solo la red, mockeada.
vi.mock("@/lib/online-charges-read", () => ({
  getBookingOnlineCharges: async () => ({ ok: true, data: [] }),
  listPatientOnlineCharges: async () => ({ ok: true, data: [] }),
}));
vi.mock("@/lib/payment-links", () => ({
  cancelPaymentLink: async () => ({ ok: false, error: "mock" }),
  getPaymentLinkShare: async () => ({ ok: false, error: "mock" }),
  sendPaymentLinkEmail: async () => ({ ok: false, error: "mock" }),
}));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => vi.fn(async () => true) }));
// Solo para leer qué le pasa el drawer a la fila: el componente real sigue renderizando.
vi.mock("@/components/agenda/booking-drawer/billing-rows", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/agenda/booking-drawer/billing-rows")>();
  return {
    ...actual,
    BillingRows: (props: Parameters<typeof actual.BillingRows>[0]) => {
      billingRowsProps.push(props as unknown as Record<string, unknown>);
      return <actual.BillingRows {...props} />;
    },
  };
});

import { BookingDrawer } from "@/components/agenda/booking-drawer";
import { CollectModal } from "@/components/agenda/booking-drawer/collect-modal";
import type { DrawerBooking } from "@/components/agenda/booking-drawer/types";
import { DeskPayModal } from "@/components/sala/desk/desk-pay-modal";
import { FacturacionCollectModal } from "@/components/patients/profile/views/facturacion-view";
import type { BookingDTO } from "@/components/agenda/agenda-utils";
import type { PatientBookingFull } from "@/lib/patients-types";
import { capabilitiesFor } from "@/lib/capabilities";
import { deskViewer } from "@/lib/reception-desk-state";

const EMAIL = "ana.perez@mail.com";

const drawerBooking = (over: Partial<DrawerBooking> = {}): DrawerBooking => ({
  id: "b1",
  // lunes 05/10 09:00 AR
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
});

const imputation = (html: string) => html.match(/data-testid="collect-imputation"[^>]*>([^<]*)</)?.[1] ?? null;

describe("[T3-Y] drawer del turno (agenda)", () => {
  it("[T3-Y] «Se imputa a {profesional}» y la descripción sin el profesional", () => {
    const html = renderToStaticMarkup(
      <CollectModal booking={drawerBooking()} practitionerName="Ana Pérez" onClose={() => {}} onSaved={() => {}} />
    );
    expect(html).toContain("Registrar cobro");
    expect(imputation(html)).toBe("Se imputa a Ana Pérez");
    expect(html).toContain("Juana Gómez · Kinesio · lun 05/10 09:00");
    expect(html).not.toContain("09:00 · Ana Pérez");
    expect(html).not.toContain(EMAIL);
  });

  it("[T3-Y] profesional que no está en la lista de la agenda: «al profesional del turno», nunca «al consultorio»", () => {
    const html = renderToStaticMarkup(<CollectModal booking={drawerBooking()} practitionerName={null} onClose={() => {}} onSaved={() => {}} />);
    expect(imputation(html)).toBe("Se imputa al profesional del turno");
  });

  it("[T3-Y] turno sin profesional: «Se imputa al consultorio»", () => {
    const html = renderToStaticMarkup(
      <CollectModal booking={drawerBooking({ practitionerId: "" })} practitionerName={null} onClose={() => {}} onSaved={() => {}} />
    );
    expect(imputation(html)).toBe("Se imputa al consultorio");
  });

  it("[T3-Y] el drawer le pasa a la fila del cobro el nombre del profesional del turno", () => {
    billingRowsProps.length = 0;
    renderToStaticMarkup(
      <BookingDrawer
        booking={drawerBooking({ canOperate: true, clinicalWritable: false })}
        practitionerName="Ana Pérez"
        onClose={() => {}}
        onSaved={() => {}}
        capabilities={[...capabilitiesFor("ASSISTANT")]}
      />
    );
    expect(billingRowsProps.at(-1)?.practitionerName).toBe("Ana Pérez");
  });
});

describe("[T3-Y] /sala (escritorio de recepción)", () => {
  const VIEWER = deskViewer(null, capabilitiesFor("ASSISTANT"));
  const row = {
    ...drawerBooking(),
    serviceId: "svc",
    patientAccess: "basic",
  } as unknown as BookingDTO;

  it("[T3-Y] con un solo profesional también lo dice (antes B2 lo callaba)", () => {
    const html = renderToStaticMarkup(<DeskPayModal row={row} practitionerName="Ana Pérez" viewer={VIEWER} onClose={() => {}} onSaved={() => {}} />);
    expect(imputation(html)).toBe("Se imputa a Ana Pérez");
    expect(html).not.toContain("09:00 · Ana Pérez");
  });
});

describe("[T3-Y] Facturación del perfil", () => {
  const fila = (over: Partial<PatientBookingFull> = {}): PatientBookingFull =>
    ({
      id: "b9",
      scheduledFor: new Date("2026-10-05T12:00:00.000Z"),
      practitionerId: "p1",
      practitionerName: "Ana Pérez",
      serviceName: "Kinesio",
      obraSocial: "OSDE",
      copagoCents: 150000,
      osAmountCents: 0,
      status: "COMPLETED",
      paymentStatus: "UNPAID",
      copagoPaymentMethod: null,
      updatedAt: new Date("2026-10-05T11:00:00.000Z"),
      ...over,
    }) as unknown as PatientBookingFull;
  const render = (b: PatientBookingFull | null) =>
    renderToStaticMarkup(
      <FacturacionCollectModal
        collecting={b}
        patientName="Juana Gómez"
        method={null}
        onMethod={() => {}}
        error={null}
        saving={false}
        onClose={() => {}}
        onConfirm={() => {}}
      />
    );

  it("[T3-Y] «Se imputa a {practitionerName de la fila}»", () => {
    const html = render(fila());
    expect(imputation(html)).toBe("Se imputa a Ana Pérez");
    expect(html).toContain("Juana Gómez · Kinesio · lun 05/10 09:00");
  });

  it("[T3-Y] cerrado no pinta nada del cobro", () => {
    expect(imputation(render(null))).toBeNull();
  });
});
