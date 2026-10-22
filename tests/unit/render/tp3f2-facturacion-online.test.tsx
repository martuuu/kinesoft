/**
 * [TP-3f] Facturación del paciente con señas y links de pago (§25.10 «Facturación del paciente»; Anexo C «3f1 Sala /
 * 3f2 Facturación»: lo que falta; «Comprobante»; «Nuevo link de pago» sin turno; estados de la lista; resumen sin
 * doble conteo).
 *
 * Render real (sin jsdom, como el resto de `tests/unit/render`) de `FacturacionView`, del modal «Registrar cobro» y de
 * las partes presentacionales de la card «Links de pago» (`PatientLinksBody`) y del modal «Comprobante»
 * (`ChargeReceiptsBody`). Se mockean solo las server actions (red/DB). Los efectos no corren en el render de servidor:
 * la decisión de leer los cobros vive en funciones puras (`linksCardWanted`, `rowReceiptWanted`) que se testean acá.
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

const { proxy } = vi.hoisted(() => ({
  proxy: () =>
    new Proxy(
      {},
      {
        get: (_t: object, k: string | symbol) =>
          k === "__esModule" ? true : k === "then" ? undefined : async () => ({ ok: true, data: [] }),
      }
    ),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/lib/bookings", () => proxy());
vi.mock("@/lib/payment-links", () => proxy());
vi.mock("@/lib/online-charges-read", () => proxy());

import {
  FacturacionCollectModal,
  FacturacionView,
} from "@/components/patients/profile/views/facturacion-view";
import {
  ChargeReceiptsBody,
  PatientLinksBody,
  linkPractitionerOptions,
  linkRowsOf,
  linksCardWanted,
  rowReceiptWanted,
} from "@/components/payments/patient-links-list";
import { ToastProvider } from "@/components/ui/toast";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { capabilitiesFor } from "@/lib/capabilities";
import { formatARS } from "@/lib/format";
import type { OnlineChargeView } from "@/lib/online-payments-types";
import type { PatientBookingFull } from "@/lib/patients-types";

let seq = 0;
function booking(over: Partial<PatientBookingFull> = {}): PatientBookingFull {
  seq += 1;
  return {
    id: `bk_${seq}`,
    tenantId: "t1",
    patientId: "pat_1",
    serviceId: "svc_1",
    practitionerId: "pr_1",
    practitionerName: "Ana Pérez",
    status: "COMPLETED",
    paymentStatus: "UNPAID",
    copagoPaymentMethod: null,
    copagoCollectedById: null,
    onlineDepositCents: 0,
    insurerPaidAt: null,
    durationMin: 45,
    programId: null,
    sessionId: null,
    serviceName: "Kinesiología",
    obraSocial: "Particular",
    copagoCents: 600_000,
    osAmountCents: 0,
    updatedAt: new Date("2026-10-01T12:00:00Z"),
    scheduledFor: new Date("2026-10-01T13:00:00Z"),
    title: null,
    notes: null,
    idempotencyKey: `idem_${seq}`,
    ...over,
  } as unknown as PatientBookingFull;
}

function charge(over: Partial<OnlineChargeView> = {}): OnlineChargeView {
  seq += 1;
  return {
    id: `oc_${seq}`,
    origin: "LINK",
    kind: "FREE",
    status: "ACTIVE",
    statusLabel: "Pendiente de pago",
    amountCents: 250_000,
    concept: "Sesión de octubre",
    createdAt: "2026-10-20T13:00:00.000Z",
    // 27/10 23:30 AR = 28/10 02:30 UTC: el vencimiento se lee en hora AR.
    expiresAt: "2026-10-28T02:30:00.000Z",
    practitionerName: "Ana Pérez",
    accountKind: "PRACTITIONER",
    receipt: null,
    link: { url: "https://app.test/pagar/tok_x", canCancel: true, canResend: true },
    notices: [],
    ...over,
  };
}

const RECEIPT: NonNullable<OnlineChargeView["receipt"]> = {
  operationId: "123456789",
  approvedAt: "2026-10-20T13:05:00.000Z",
  approvedAtLabel: "20/10/2026 10:05",
  paidAmountCents: 250_000,
  methodLabel: "Visa",
  statusLabel: "Aprobado",
  refundedAt: null,
  paymentMethodId: "visa",
  paymentTypeId: "credit_card",
  installments: 1,
  mpStatus: "approved",
  account: { kind: "PRACTITIONER", practitionerName: "Ana Pérez" },
};

const wrap = (el: ReactElement) =>
  renderToStaticMarkup(
    <ToastProvider>
      <ConfirmProvider>{el}</ConfirmProvider>
    </ToastProvider>
  );
const noop = () => {};
const rowOf = (html: string, i: number) => html.split('data-testid="fact-row"')[i + 1] ?? "";
const access = (role: "ASSISTANT" | "BILLING" | "PRACTITIONER", practitionerId: string | null = null) => ({
  capabilities: [...capabilitiesFor(role)],
  practitionerId,
});

describe("[TP-3f] Facturación: lo que falta con seña", () => {
  it("[TP-3f] la fila con seña dice «Seña pagada · $X» y «Por cobrar · $Y» (copago − seña)", () => {
    const html = wrap(
      <FacturacionView
        bookings={[booking({ onlineDepositCents: 200_000 })]}
        loading={false}
        patchBooking={noop}
        billingAccess={access("ASSISTANT")}
      />
    );
    const row = rowOf(html, 0);
    expect(row).toContain(`Seña pagada · ${formatARS(200_000)}`);
    expect(row).toContain(`Por cobrar · ${formatARS(400_000)}`);
    expect(row).toContain(">Cobrar<");
  });

  it("[TP-3f] el modal «Registrar cobro» cobra lo que falta y avisa la seña", () => {
    const html = wrap(
      <FacturacionCollectModal
        collecting={booking({ onlineDepositCents: 200_000 })}
        patientName="Juana Gómez"
        method={null}
        onMethod={noop}
        error={null}
        saving={false}
        onClose={noop}
        onConfirm={noop}
      />
    );
    expect(html).toContain('data-testid="collect-deposit"');
    expect(html).toContain(formatARS(400_000));
    expect(html).not.toContain(formatARS(600_000));
  });

  it("[TP-3f] la seña que cubre todo el copago no dice «Por cobrar · $ 0»", () => {
    const html = wrap(
      <FacturacionView
        bookings={[booking({ onlineDepositCents: 600_000 })]}
        loading={false}
        patchBooking={noop}
        billingAccess={access("ASSISTANT")}
      />
    );
    expect(rowOf(html, 0)).not.toContain(`Por cobrar · ${formatARS(0)}`);
  });
});

describe("[TP-3f] Facturación: pagado por Mercado Pago y «Comprobante»", () => {
  it("[TP-3f] pagado entero por Mercado Pago (webhook, sin quién cobró): sin deshacer y con «Comprobante»", () => {
    const html = wrap(
      <FacturacionView
        bookings={[booking({ paymentStatus: "PAID", copagoPaymentMethod: "MERCADO_PAGO", copagoCollectedById: null })]}
        loading={false}
        patchBooking={noop}
        billingAccess={access("ASSISTANT")}
      />
    );
    const row = rowOf(html, 0);
    expect(row).toContain("Pagado por Mercado Pago");
    expect(row).not.toContain("Deshacer cobro");
    expect(row).toContain(">Comprobante<");
  });

  it("[TP-3f] «Mercado Pago» registrado a mano (con quién cobró) sí se deshace y no ofrece comprobante", () => {
    const html = wrap(
      <FacturacionView
        bookings={[booking({ paymentStatus: "PAID", copagoPaymentMethod: "MERCADO_PAGO", copagoCollectedById: "u_1" })]}
        loading={false}
        patchBooking={noop}
        billingAccess={access("ASSISTANT")}
      />
    );
    const row = rowOf(html, 0);
    expect(row).toContain("Deshacer cobro");
    expect(row).not.toContain(">Comprobante<");
  });

  it("[TP-3f] sin plata online no hay «Comprobante» (ni lectura); con seña o REFUNDED, sí; AUTHORIZED todavía no", () => {
    expect(rowReceiptWanted(booking())).toBe(false);
    expect(rowReceiptWanted(booking({ paymentStatus: "PAID", copagoPaymentMethod: "CASH", copagoCollectedById: "u_1" }))).toBe(false);
    expect(rowReceiptWanted(booking({ onlineDepositCents: 100 }))).toBe(true);
    expect(rowReceiptWanted(booking({ paymentStatus: "REFUNDED" }))).toBe(true);
    // Retenido por Mercado Pago: todavía no hay comprobante (TP-D20 lo arma con el pago acreditado).
    expect(rowReceiptWanted(booking({ paymentStatus: "AUTHORIZED" }))).toBe(false);
    // Reserva pública del turnero legado (PAID sin medio): el comprobante nuevo no existe, no se ofrece.
    expect(rowReceiptWanted(booking({ paymentStatus: "PAID", copagoPaymentMethod: null }))).toBe(false);
  });

  it("[TP-3f] el modal «Comprobante» pinta el comprobante plano (7 filas, sin plegable) de cada pago", () => {
    const html = renderToStaticMarkup(
      <ChargeReceiptsBody state={{ status: "ready", charges: [charge({ status: "PAID", statusLabel: "Pagado", kind: "DEPOSIT", receipt: RECEIPT, link: null })] }} />
    );
    expect(html).toContain('data-receipt-rows="7"');
    expect(html).not.toContain("<details");
    expect(html).toContain("123456789");
  });

  it("[TP-3f] el modal «Comprobante» sin pagos acreditados lo dice, y un error de lectura se muestra", () => {
    const empty = renderToStaticMarkup(<ChargeReceiptsBody state={{ status: "ready", charges: [charge()] }} />);
    expect(empty).toContain("Todavía no hay pagos acreditados");
    const err = renderToStaticMarkup(<ChargeReceiptsBody state={{ status: "error", error: "No tenés permiso para ver los cobros online." }} />);
    expect(err).toContain("No tenés permiso para ver los cobros online.");
  });
});

describe("[TP-3f] Facturación: resumen sin doble conteo", () => {
  it("[TP-3f] la seña cuenta una vez: percibido = copago (pagado) + seña (sin cobrar); pendiente = lo que falta", () => {
    const html = wrap(
      <FacturacionView
        bookings={[
          // Seña $2.000 y después cobrado a mano: percibido $6.000 (no $8.000).
          booking({ onlineDepositCents: 200_000, paymentStatus: "PAID", copagoPaymentMethod: "CASH", copagoCollectedById: "u_1" }),
          // Seña $1.000 sin cobrar el resto: percibido $1.000, pendiente $5.000.
          booking({ onlineDepositCents: 100_000 }),
        ]}
        loading={false}
        patchBooking={noop}
        billingAccess={access("ASSISTANT")}
      />
    );
    const summary = html.split('data-testid="fact-row"')[0];
    expect(summary).toContain(formatARS(700_000));
    expect(summary).toContain(formatARS(500_000));
    expect(summary).not.toContain(formatARS(800_000));
  });
});

describe("[TP-3f] card «Links de pago»", () => {
  it("[TP-3f] estados de la lista: estado en texto, monto y vence (hora AR); acciones solo en el link activo", () => {
    const rows = [
      charge({ id: "oc_live" }),
      charge({ id: "oc_paid", status: "PAID", statusLabel: "Pagado", receipt: RECEIPT, link: null }),
      charge({ id: "oc_exp", status: "EXPIRED", statusLabel: "Vencido", link: null }),
      charge({ id: "oc_can", status: "CANCELLED", statusLabel: "Anulado", link: null }),
    ];
    const html = renderToStaticMarkup(
      <PatientLinksBody rows={rows} loading={false} error={null} canCreate busyId={null} onNew={noop} onCopy={noop} onResend={noop} onCancel={noop} onReceipt={noop} />
    );
    for (const s of ["Pendiente de pago", "Pagado", "Vencido", "Anulado"]) expect(html).toContain(s);
    expect(html).toContain(formatARS(250_000));
    expect(html).toContain("27/10");
    const part = (id: string) => html.split(`data-charge="${id}"`)[1]?.split("data-charge=")[0] ?? "";
    expect(part("oc_live")).toContain(">Copiar<");
    expect(part("oc_live")).toContain(">Reenviar<");
    expect(part("oc_live")).toContain(">Anular<");
    expect(part("oc_paid")).toContain(">Comprobante<");
    for (const id of ["oc_paid", "oc_exp", "oc_can"]) {
      expect(part(id)).not.toContain(">Copiar<");
      expect(part(id)).not.toContain(">Anular<");
    }
    expect(html).toContain(">Nuevo link de pago<");
  });

  it("[TP-3f] sin permiso de anular o reenviar (canCancel/canResend) el link activo solo se copia", () => {
    const html = renderToStaticMarkup(
      <PatientLinksBody
        rows={[charge({ id: "oc_ro", link: { url: "https://app.test/pagar/t", canCancel: false, canResend: false } })]}
        loading={false}
        error={null}
        canCreate={false}
        busyId={null}
        onNew={noop}
        onCopy={noop}
        onResend={noop}
        onCancel={noop}
        onReceipt={noop}
      />
    );
    expect(html).toContain(">Copiar<");
    expect(html).not.toContain(">Reenviar<");
    expect(html).not.toContain(">Anular<");
    expect(html).not.toContain("Nuevo link de pago");
  });

  it("[TP-3f] la lista es de links (el cobro del turnero vive en su turno) y la vacía lo dice", () => {
    const rows = linkRowsOf([charge({ id: "oc_l" }), charge({ id: "oc_t", origin: "TURNERO", kind: "DEPOSIT", link: null })]);
    expect(rows.map((r) => r.id)).toEqual(["oc_l"]);
    const html = renderToStaticMarkup(
      <PatientLinksBody rows={[]} loading={false} error={null} canCreate busyId={null} onNew={noop} onCopy={noop} onResend={noop} onCancel={noop} onReceipt={noop} />
    );
    expect(html).toContain("Sin links de pago");
  });

  it("[TP-3f] «Nuevo link de pago» sin turno: profesionales de los turnos del paciente; el profesional que cobra solo lo suyo", () => {
    const bookings = [
      booking({ practitionerId: "pr_1", practitionerName: "Ana Pérez" }),
      booking({ practitionerId: "pr_2", practitionerName: "Beto Ruiz" }),
      booking({ practitionerId: "pr_1", practitionerName: "Ana Pérez" }),
    ];
    const assistant = linkPractitionerOptions({ bookings, explicit: null, caps: new Set(capabilitiesFor("ASSISTANT")), viewerPractitionerId: null });
    expect(assistant.options).toEqual([
      { id: "pr_1", name: "Ana Pérez" },
      { id: "pr_2", name: "Beto Ruiz" },
    ]);
    expect(assistant.defaultId).toBeNull();
    const own = linkPractitionerOptions({ bookings, explicit: null, caps: new Set(capabilitiesFor("PRACTITIONER")), viewerPractitionerId: "pr_2" });
    expect(own.options).toEqual([{ id: "pr_2", name: "Beto Ruiz" }]);
    expect(own.defaultId).toBe("pr_2");
    // La lista del consultorio (si el caller la pasa) manda sobre la que sale de los turnos.
    const explicit = linkPractitionerOptions({
      bookings: [],
      explicit: [{ id: "pr_9", name: "Caro Díaz" }],
      caps: new Set(capabilitiesFor("ASSISTANT")),
      viewerPractitionerId: null,
    });
    expect(explicit.options).toEqual([{ id: "pr_9", name: "Caro Díaz" }]);
  });

  it("[TP-3f] la card se monta solo con paciente, cobros online prendidos y quien cobra", () => {
    const assistant = access("ASSISTANT");
    expect(linksCardWanted({ patientId: "pat_1", onlinePayments: true, billingAccess: assistant })).toBe(true);
    expect(linksCardWanted({ patientId: null, onlinePayments: true, billingAccess: assistant })).toBe(false);
    expect(linksCardWanted({ patientId: "pat_1", onlinePayments: false, billingAccess: assistant })).toBe(false);
    expect(linksCardWanted({ patientId: "pat_1", onlinePayments: true, billingAccess: { capabilities: [], practitionerId: null } })).toBe(false);
    expect(linksCardWanted({ patientId: "pat_1", onlinePayments: true, billingAccess: access("PRACTITIONER", "pr_1") })).toBe(true);
  });

  it("[TP-3f] Facturación monta la card «Links de pago» con «Nuevo link de pago» para quien cobra", () => {
    const html = wrap(
      <FacturacionView
        bookings={[booking()]}
        loading={false}
        patchBooking={noop}
        patientId="pat_1"
        onlinePayments
        billingAccess={access("ASSISTANT")}
      />
    );
    expect(html).toContain("Links de pago");
    expect(html).toContain(">Nuevo link de pago<");
    const off = wrap(
      <FacturacionView bookings={[booking()]} loading={false} patchBooking={noop} patientId="pat_1" onlinePayments={false} billingAccess={access("ASSISTANT")} />
    );
    expect(off).not.toContain("Links de pago");
  });
});
