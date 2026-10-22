/**
 * [TP-3c] Plata online en el drawer del turno (§25.10 «Drawer del turno»; Anexo C «3c Drawer»).
 *
 * Render real (sin jsdom, como el resto de `tests/unit/render`) de la fila Copago (`BillingRows`), del modal «Registrar
 * cobro» (`CollectForm`/`CollectModal`), de la sección de plata (`BookingMoneyBody`) y del drawer completo. Se mockean
 * solo las server actions (red/DB) y los hooks de toast/confirm. Los efectos no corren en el render de servidor: la
 * decisión de leer los cobros vive en `loadOnlineChargesIfHinted` (la que usa el efecto) y se testea con la action
 * mockeada como espía.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { proxy, chargesSpy } = vi.hoisted(() => ({
  proxy: () =>
    new Proxy(
      {},
      {
        get: (_t: object, k: string | symbol) =>
          k === "__esModule" ? true : k === "then" ? undefined : async () => ({ ok: true, data: {} }),
      }
    ),
  chargesSpy: { calls: [] as unknown[] },
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
vi.mock("@/lib/payment-links", () => proxy());
vi.mock("@/lib/online-charges-read", () => ({
  getBookingOnlineCharges: async (input: unknown) => {
    chargesSpy.calls.push(input);
    return { ok: true, data: [] };
  },
}));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => vi.fn(async () => true) }));

import { BookingDrawer, moneySectionWanted } from "@/components/agenda/booking-drawer";
import { BillingRows } from "@/components/agenda/booking-drawer/billing-rows";
import { CollectForm, collectAmountFor } from "@/components/agenda/booking-drawer/collect-modal";
import type { DrawerBooking } from "@/components/agenda/booking-drawer/types";
import {
  BookingMoneyBody,
  BookingMoneySection,
  loadOnlineChargesIfHinted,
  receiptOf,
} from "@/components/payments/booking-money-section";
import { MpReceiptView } from "@/components/payments/mp-receipt-view";
import { bookingMoneyLines } from "@/lib/booking-money-view";
import { capabilitiesFor, type Capability } from "@/lib/capabilities";
import { formatARS } from "@/lib/format";
import { PAYMENT_LINK_COPY } from "@/lib/online-payments-copy";
import type { OnlineChargeView } from "@/lib/online-payments-types";

const SECRETARIA = capabilitiesFor("ASSISTANT");

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
    copagoCents: 2_000_000,
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

function charge(over: Partial<OnlineChargeView> = {}): OnlineChargeView {
  return {
    id: "oc1",
    origin: "TURNERO",
    kind: "DEPOSIT",
    status: "PAID",
    statusLabel: "Pagado",
    amountCents: 600_000,
    concept: null,
    createdAt: "2026-10-04T12:00:00.000Z",
    expiresAt: "2026-10-04T12:30:00.000Z",
    practitionerName: "Ana Pérez",
    accountKind: "PRACTITIONER",
    receipt: {
      operationId: "123456789",
      approvedAt: "2026-10-05T02:30:00.000Z",
      approvedAtLabel: "04/10/2026, 23:30",
      paidAmountCents: 600_000,
      methodLabel: "Tarjeta de crédito Visa",
      statusLabel: "Aprobado",
      refundedAt: null,
      paymentMethodId: "visa",
      paymentTypeId: "credit_card",
      installments: 3,
      mpStatus: "approved",
      account: { kind: "PRACTITIONER", practitionerName: "Ana Pérez" },
    },
    link: null,
    notices: [],
    ...over,
  };
}

const noop = () => {};
const body = (o: Partial<Parameters<typeof BookingMoneyBody>[0]> & { b?: DrawerBooking }) => {
  const b = o.b ?? booking();
  return renderToStaticMarkup(
    <BookingMoneyBody
      lines={
        o.lines ??
        bookingMoneyLines({
          onlineDepositCents: b.onlineDepositCents ?? 0,
          paidOnline: b.paidOnline ?? false,
          copagoCents: b.copagoCents,
          paymentStatus: b.paymentStatus,
        })
      }
      charges={o.charges ?? null}
      canGenerate={o.canGenerate ?? false}
      hint={o.hint ?? null}
      busy={false}
      waUrl={o.waUrl ?? null}
      onGenerate={noop}
      onCopy={noop}
      onCancelLink={noop}
    />
  );
};

beforeEach(() => {
  chargesSpy.calls.length = 0;
});

describe("[TP-3c] drawer del turno: plata online", () => {
  it("[TP-3c] con seña: «Seña pagada · $ 6.000», «Por cobrar · $ 14.000» y modal con la línea de la seña", () => {
    const b = booking({ onlineDepositCents: 600_000 });
    const html = body({ b });
    expect(html).toContain(`Seña pagada · ${formatARS(600_000)}`);
    expect(html).toContain(`Por cobrar · ${formatARS(1_400_000)}`);

    // El modal cobra lo que FALTA (antes `deposits: []` → el copago entero) y lo dice con la línea de la seña.
    expect(collectAmountFor(b)).toEqual({ amountCents: 1_400_000, depositCents: 600_000 });
    expect(collectAmountFor(booking())).toEqual({ amountCents: 2_000_000, depositCents: 0 });
    // Seña mayor que el copago (bajó la cobertura): piso 0, nunca un saldo a favor.
    expect(collectAmountFor(booking({ onlineDepositCents: 2_500_000 })).amountCents).toBe(0);
    const form = renderToStaticMarkup(
      <CollectForm amountCents={1_400_000} depositCents={600_000} imputation="Se imputa a Ana Pérez" method={null} onMethod={noop} error={null} saving={false} onCancel={noop} onConfirm={noop} />
    );
    expect(form).toContain(`Seña pagada por Mercado Pago · ${formatARS(600_000)}`);
    expect(form).toContain(`Marcar pagado · ${formatARS(1_400_000)}`);
    // Sin seña el modal es el de T3 (sin la línea).
    const sinSena = renderToStaticMarkup(
      <CollectForm amountCents={2_000_000} imputation="Se imputa a Ana Pérez" method={null} onMethod={noop} error={null} saving={false} onCancel={noop} onConfirm={noop} />
    );
    expect(sinSena).not.toContain("collect-deposit");

    // Sin seña la sección no repite «Por cobrar» (ya lo dice la fila Copago): nada que mostrar.
    expect(body({ b: booking() })).toBe("");
  });

  it("[TP-3c] MP total sin «Deshacer cobro»; comprobante (7 filas); reintegro", () => {
    const pagado = booking({ paymentStatus: "PAID", copagoPaymentMethod: "MERCADO_PAGO", paidOnline: true });
    const fila = renderToStaticMarkup(<BillingRows booking={pagado} caps={SECRETARIA} />);
    expect(fila).toContain("Pagado por Mercado Pago");
    expect(fila).not.toContain("Deshacer cobro");
    expect(fila).not.toContain(">Cobrar<");
    // «Mercado Pago» cargado A MANO (sin `po`): es un cobro manual y se deshace como en T3.
    const manual = renderToStaticMarkup(
      <BillingRows booking={booking({ paymentStatus: "PAID", copagoPaymentMethod: "MERCADO_PAGO" })} caps={SECRETARIA} />
    );
    expect(manual).toContain("Deshacer cobro");

    const full = charge({ kind: "FULL", amountCents: 2_000_000 });
    const receipt = receiptOf(full);
    expect(receipt?.rows).toHaveLength(7);
    expect(receipt?.rows.map((r) => r.key)).toEqual(["operation", "date", "amount", "method", "installments", "status", "account"]);
    const view = renderToStaticMarkup(<MpReceiptView receipt={receipt!} variant="collapsible" />);
    expect(view).toContain('data-receipt-rows="7"');
    expect(view).toContain("Mercado Pago de Ana Pérez");
    expect(view).toContain("3 cuotas");
    // La sección lista el pago (el comprobante baja diferido: en el render de servidor no está).
    expect(body({ b: pagado, charges: [full] })).toContain(`Pago · ${formatARS(2_000_000)} · Pagado`);

    // Reintegro: la fila Copago lo dice sin botones y el comprobante suma «Reintegrado el».
    const reintegrado = renderToStaticMarkup(<BillingRows booking={booking({ paymentStatus: "REFUNDED" })} caps={SECRETARIA} />);
    expect(reintegrado).toContain("Reintegrado por Mercado Pago");
    expect(reintegrado).not.toContain("Deshacer cobro");
    const conReintegro = receiptOf(
      charge({ status: "REFUNDED", receipt: { ...charge().receipt!, refundedAt: "2026-10-06T15:00:00.000Z", mpStatus: "refunded" } })
    );
    expect(conReintegro?.rows.at(-1)).toMatchObject({ key: "refunded", value: "06/10/2026, 12:00" });
  });

  it("[TP-3c] sin pistas no llama a getBookingOnlineCharges", async () => {
    const sin = { id: "b1", onlineDepositCents: 0, paidOnline: false, paymentStatus: "UNPAID" };
    expect(loadOnlineChargesIfHinted(sin, undefined)).toBeNull();
    expect(loadOnlineChargesIfHinted({ ...sin, paymentStatus: "PAID" }, false)).toBeNull();
    expect(chargesSpy.calls).toEqual([]);

    // Con pista (seña, pagado online, estado de Mercado Pago o un link de esta sección) sí, por el id del turno.
    await loadOnlineChargesIfHinted({ ...sin, onlineDepositCents: 600_000 }, undefined);
    await loadOnlineChargesIfHinted({ ...sin, paidOnline: true }, undefined);
    await loadOnlineChargesIfHinted({ ...sin, paymentStatus: "REFUNDED" }, undefined);
    await loadOnlineChargesIfHinted(sin, true);
    expect(chargesSpy.calls).toEqual([{ bookingId: "b1" }, { bookingId: "b1" }, { bookingId: "b1" }, { bookingId: "b1" }]);

    // El drawer ni siquiera monta la sección en un turno sin plata online de un consultorio que no cobra online.
    expect(moneySectionWanted(booking(), { canCollect: true, onlineMoney: false })).toBe(false);
    expect(moneySectionWanted(booking({ onlineDepositCents: 600_000 }), { canCollect: false, onlineMoney: false })).toBe(true);
    expect(moneySectionWanted(booking(), { canCollect: true, onlineMoney: true })).toBe(true);
    expect(moneySectionWanted(booking({ paymentStatus: "PAID", copagoPaymentMethod: "CASH" }), { canCollect: true, onlineMoney: true })).toBe(false);
    expect(moneySectionWanted(booking({ status: "CANCELLED" }), { canCollect: true, onlineMoney: true })).toBe(false);
    expect(moneySectionWanted(booking({ patientId: null }), { canCollect: true, onlineMoney: true })).toBe(false);

    // Render del componente real: no lee nada al renderizar (la lectura va en el efecto, con la pista).
    renderToStaticMarkup(
      <BookingMoneySection
        booking={{
          id: "b1",
          patientId: "pt1",
          patientName: "Juana Gómez",
          practitionerId: "p1",
          practitionerName: "Ana Pérez",
          startsAt: "2026-10-05T12:00:00.000Z",
          status: "CONFIRMED",
          paymentStatus: "UNPAID",
          copagoCents: 2_000_000,
          onlineDepositCents: 0,
          paidOnline: false,
        }}
        canCollect
      />
    );
    expect(chargesSpy.calls).toHaveLength(4);
  });

  it("[TP-3c] link activo con acciones; sin billing.collect no hay «Generar link de pago»; sin delegación, pista", () => {
    const live = charge({
      id: "oc9",
      origin: "LINK",
      kind: "FREE",
      status: "ACTIVE",
      statusLabel: "Esperando el pago",
      amountCents: 1_400_000,
      receipt: null,
      link: { url: "http://localhost:3000/pagar/abcdefghijklmnopqrstuv", canCancel: true, canResend: true },
    });
    const conLink = body({ charges: [live], canGenerate: true, waUrl: "https://wa.me/5491122334455?text=hola" });
    expect(conLink).toContain(`Link de pago activo · ${formatARS(1_400_000)}`);
    expect(conLink).toContain(">Copiar<");
    expect(conLink).toContain(">WhatsApp<");
    expect(conLink).toContain('href="https://wa.me/5491122334455?text=hola"');
    expect(conLink).toContain(">Anular<");
    // Un link vivo por turno (TP-UI-D9): con uno vivo no se ofrece otro.
    expect(conLink).not.toContain("Generar link de pago");
    // Sin celular válido (`waUrl` null) no hay WhatsApp sin destinatario: queda Copiar.
    expect(body({ charges: [live] })).not.toContain(">WhatsApp<");
    // Sin permiso de anular (lo decide el server en `link.canCancel`), sin «Anular».
    expect(body({ charges: [{ ...live, link: { ...live.link!, canCancel: false } }] })).not.toContain(">Anular<");

    // Quien cobra ve «Generar link de pago»; sin `billing.collect` (ni `collectOwn` sobre su turno), no.
    expect(body({ canGenerate: true })).toContain("Generar link de pago");
    expect(body({ canGenerate: false })).not.toContain("Generar link de pago");
    const drawer = (caps: ReadonlySet<Capability>) =>
      renderToStaticMarkup(
        <BookingDrawer booking={booking({ canOperate: true })} onClose={noop} onSaved={noop} capabilities={[...caps]} onlineMoney />
      );
    // La sección es diferida (no está en el render de servidor); lo que se afirma es el gate que le pasa el drawer.
    expect(drawer(SECRETARIA)).toContain(">Cobrar<");
    expect(moneySectionWanted(booking(), { canCollect: false, onlineMoney: true })).toBe(false);

    // Sin delegación: la pista del server (literal de C-TP9) en lugar del formulario.
    const pista = body({ canGenerate: true, hint: PAYMENT_LINK_COPY.notDelegated("Ana Pérez") });
    expect(pista).toContain("Ana Pérez no autorizó links de pago a su Mercado Pago.");
    expect(pista).toContain('role="status"');
  });
});
