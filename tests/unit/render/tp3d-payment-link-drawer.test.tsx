/**
 * [TP-3d] Render real del `PaymentLinkDrawer`, del paso «Link listo» con `PaymentLinkShare` y del `MpReceiptView`
 * (anexo C del brief de T5 «3d PaymentLinkDrawer»; comprobante de 7 filas de TP-UI-D11), sin jsdom como el resto de
 * `tests/unit/render`. Se mockean solo las server actions de `lib/payment-links` (red/DB): el render de servidor no
 * corre efectos, así que además se verifica que montar el drawer NO llama a nada.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const actions = vi.hoisted(() => ({
  createPaymentLink: vi.fn(async () => ({ ok: true, data: {} })),
  getPaymentLinkSuggestions: vi.fn(async () => ({ ok: true, data: {} })),
  getPaymentLinkShare: vi.fn(async () => ({ ok: true, data: {} })),
  sendPaymentLinkEmail: vi.fn(async () => ({ ok: true, data: {} })),
  cancelPaymentLink: vi.fn(async () => ({ ok: true, data: {} })),
}));
vi.mock("@/lib/payment-links", () => actions);
// El dirty-guard del Drawer usa `useConfirm` (necesita su provider en la app); acá alcanza con el hook.
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => vi.fn(async () => true) }));

import { PaymentLinkDrawer, PaymentLinkForm, PaymentLinkReady } from "@/components/payments/payment-link-drawer";
import { PaymentLinkShare } from "@/components/payments/payment-link-share";
import { MpReceiptView } from "@/components/payments/mp-receipt-view";
import { buildMpReceipt } from "@/lib/mp-receipt";
import { linkAmountOptions, type PaymentLinkFormState } from "@/lib/payment-link-form";
import { PAYMENT_LINK_COPY, defaultLinkConcept } from "@/lib/online-payments-copy";
import { formatARS } from "@/lib/format";

const noop = () => {};
const BOOKING = { id: "b1", startsAt: "2026-10-19T13:00:00.000Z", practitionerId: "pr1", practitionerName: "Ana Pérez" };

function formState(o: Partial<PaymentLinkFormState> = {}): PaymentLinkFormState {
  return { optionKey: null, amountCents: null, concept: "", expiresInDays: 7, practitionerId: "pr1", ...o };
}

/** Atributo `aria-describedby` del input del concepto → el texto de los ids que nombra. */
function describedText(html: string, inputMatch: RegExp): string {
  const tag = html.match(inputMatch)?.[0] ?? "";
  const ids = /aria-describedby="([^"]+)"/.exec(tag)?.[1].split(" ") ?? [];
  return ids
    .map((id) => new RegExp(`id="${id.replace(/[:]/g, "\\:")}"[^>]*>([^<]*)<`).exec(html)?.[1] ?? "")
    .join(" | ");
}

describe("[TP-3d] PaymentLinkDrawer", () => {
  it("sin turno: profesional, monto obligatorio, concepto vacío con el aviso por aria-describedby y vence 7 por default", () => {
    const html = renderToStaticMarkup(
      <PaymentLinkDrawer
        open
        onClose={noop}
        surface="facturacion"
        patient={{ id: "pa1", name: "Laura Gómez" }}
        booking={null}
        practitioners={[
          { id: "pr1", name: "Ana Pérez" },
          { id: "pr2", name: "Juan Díaz" },
        ]}
        defaultPractitionerId="pr2"
      />,
    );
    expect(html).toContain("Generar link de pago");
    expect(html).toContain("Profesional");
    expect(html).toMatch(/<option value="pr2" selected="">Juan Díaz<\/option>/);
    // Monto obligatorio (FREE) y sin «¿Cuánto?» (no hay turno del que sugerir).
    expect(html).toMatch(/<input[^>]*required=""[^>]*inputMode="decimal"|<input[^>]*inputMode="decimal"[^>]*required=""/);
    expect(html).not.toContain("¿Cuánto?");
    // 7 días seleccionado.
    expect(html).toMatch(/<option value="7" selected="">7 días<\/option>/);
    expect(html).toContain('<option value="1">1 día</option>');
    // El aviso está atado al campo del concepto.
    expect(describedText(html, /<input[^>]*maxLength="120"[^>]*>/)).toContain(PAYMENT_LINK_COPY.conceptWarning);
    // Montar no llama a nada (sin turno no hay sugerencias; los efectos no corren en el server).
    expect(actions.getPaymentLinkSuggestions).not.toHaveBeenCalled();
    expect(actions.createPaymentLink).not.toHaveBeenCalled();
  });

  it("con turno: mientras llegan las sugerencias no muestra un form a medias", () => {
    const html = renderToStaticMarkup(
      <PaymentLinkDrawer
        open
        onClose={noop}
        surface="agenda"
        patient={{ id: "pa1", name: "Laura Gómez" }}
        booking={BOOKING}
        practitioners={[]}
      />,
    );
    expect(html).toContain("Calculando lo que falta cobrar");
    expect(html).not.toContain('data-testid="payment-link-form"');
  });

  it("con turno: opciones deduplicadas (un solo radio con el total), cuenta y concepto sin servicio", () => {
    const options = linkAmountOptions({
      remainingCents: 2_000_000,
      totalCents: 2_000_000,
      depositPaidCents: 0,
      canTotal: true,
      accountKind: "PRACTITIONER",
      blocked: null,
    });
    const html = renderToStaticMarkup(
      <PaymentLinkForm
        options={options}
        accountLabel="Mercado Pago de Ana Pérez"
        practitioners={[]}
        state={formState({ optionKey: "TOTAL", concept: defaultLinkConcept(BOOKING.startsAt) })}
        onChange={noop}
        blocked={null}
        error={null}
        pending={false}
        onSubmit={noop}
        onCancel={noop}
      />,
    );
    expect(html).toContain("¿Cuánto?");
    expect(html.match(/data-option="/g)).toHaveLength(2);
    expect(html).toContain('data-option="TOTAL"');
    expect(html).toContain('data-option="OTHER"');
    expect(html).not.toContain("Lo que falta");
    // El monto sale una vez como opción (la otra mención es el tope de «Otro monto»).
    expect(html.match(/tabular-nums">[^<]*<\/span><\/label>/g)).toHaveLength(1);
    expect(html).toContain("Mercado Pago de Ana Pérez");
    expect(html).toContain('value="Turno del lun 19/10 a las 10:00"');
    // «El total» elegido → sin campo de monto (lo calcula el server).
    expect(html).not.toContain('inputMode="decimal"');
    // Sin el profesional a elegir: el del turno manda.
    expect(html).not.toContain(">Profesional<");
  });

  it("«Otro monto» elegido → aparece el monto", () => {
    const options = linkAmountOptions({
      remainingCents: 1_400_000,
      totalCents: 2_000_000,
      depositPaidCents: 600_000,
      canTotal: false,
      accountKind: "CLINIC",
      blocked: null,
    });
    const html = renderToStaticMarkup(
      <PaymentLinkForm
        options={options}
        accountLabel="Mercado Pago del consultorio"
        practitioners={[]}
        state={formState({ optionKey: "OTHER", concept: "Turno" })}
        onChange={noop}
        blocked={null}
        error={{ field: "amount", message: PAYMENT_LINK_COPY.depositTooHigh }}
        pending={false}
        onSubmit={noop}
        onCancel={noop}
      />,
    );
    expect(html).toContain("Lo que falta");
    expect(html).not.toContain("El total");
    expect(html).toContain('inputMode="decimal"');
    expect(html).toContain(PAYMENT_LINK_COPY.depositTooHigh);
  });

  it("bloqueado: el motivo a la vista y «Generar» deshabilitado", () => {
    const html = renderToStaticMarkup(
      <PaymentLinkForm
        options={[]}
        accountLabel={null}
        practitioners={[]}
        state={formState({ concept: "Turno" })}
        onChange={noop}
        blocked={PAYMENT_LINK_COPY.notDelegated("Ana Pérez")}
        error={null}
        pending={false}
        onSubmit={noop}
        onCancel={noop}
      />,
    );
    expect(html).toContain("Ana Pérez no autorizó links de pago a su Mercado Pago.");
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
  });

  it("«Link listo»: monto, vencimiento en hora AR, cuenta, link y compartir", () => {
    const html = renderToStaticMarkup(
      <PaymentLinkReady
        created={{
          chargeId: "c1",
          url: "https://app.example/pagar/AbCdEfGhIjKlMnOpQrStUv",
          amountCents: 500_000,
          // 02:30 UTC del 27 = 23:30 AR del 26.
          expiresAt: "2026-10-27T02:30:00.000Z",
          accountKind: "PRACTITIONER",
        }}
        practitionerName="Ana Pérez"
        patientName="Laura Gómez"
        onDone={noop}
      />,
    );
    expect(html).toContain("Link listo");
    expect(html).toContain(formatARS(500_000));
    expect(html).toContain("26/10");
    expect(html).toContain("Mercado Pago de Ana Pérez");
    expect(html).toContain('value="https://app.example/pagar/AbCdEfGhIjKlMnOpQrStUv"');
    expect(html).toContain('data-testid="payment-link-share"');
    expect(html).toContain("Copiar link");
    expect(html).toContain("Mandar por email");
  });
});

describe("[TP-3d] PaymentLinkShare", () => {
  const url = "https://app.example/pagar/AbCdEfGhIjKlMnOpQrStUv";

  it("con celular válido: WhatsApp directo al paciente (wa.me con destinatario)", () => {
    const html = renderToStaticMarkup(
      <PaymentLinkShare
        chargeId="c1"
        url={url}
        patientName="Laura Gómez"
        initialShare={{
          text: "Hola Laura, te mandamos el link de pago",
          waUrl: "https://wa.me/5491155550000?text=Hola",
          contact: { status: "ok", e164: "+5491155550000" },
        }}
      />,
    );
    expect(html).toContain('href="https://wa.me/5491155550000?text=Hola"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain("celular válido");
  });

  it("sin celular válido: wa.me sin destinatario + el aviso de siempre", () => {
    const html = renderToStaticMarkup(
      <PaymentLinkShare
        chargeId="c1"
        url={url}
        patientName="Laura Gómez"
        initialShare={{ text: "Hola", waUrl: null, contact: { status: "invalid", reason: "landline" } }}
      />,
    );
    expect(html).toContain('href="https://wa.me/?text=Hola"');
    expect(html).toContain("El paciente no tiene un celular válido");
    expect(html).toContain("aria-describedby");
  });

  it("sin datos todavía: copiar el link ya funciona y no se inventa un WhatsApp", () => {
    const html = renderToStaticMarkup(<PaymentLinkShare chargeId="c1" url={url} patientName="Laura Gómez" />);
    expect(html).toContain("Copiar link");
    expect(html).not.toContain("wa.me");
    expect(html).toContain("Preparando el mensaje");
  });
});

describe("[TP-3d] MpReceiptView", () => {
  const receipt = buildMpReceipt({
    mpPaymentId: "1234567890",
    approvedAt: "2026-10-21T02:30:00.000Z",
    paidAmountCents: 600_000,
    paymentMethodId: "visa",
    paymentTypeId: "credit_card",
    installments: 1,
    mpStatus: "approved",
    account: { kind: "PRACTITIONER", practitionerName: "Ana Pérez" },
  })!;

  it("plegable en el drawer con 7 filas (con «Acreditado en») y fecha AR", () => {
    const html = renderToStaticMarkup(<MpReceiptView receipt={receipt} variant="collapsible" />);
    expect(html).toMatch(/^<details/);
    expect(html).toContain("<summary");
    expect(html).toContain("Comprobante");
    expect(html).toContain('data-receipt-rows="7"');
    expect(html.match(/<dt/g)).toHaveLength(7);
    expect(html).toContain("Mercado Pago de Ana Pérez");
    expect(html).toContain("20/10");
    expect(html).not.toMatch(/<details[^>]* open/);
  });

  it("plain (Modal de Facturación y /cobros): la lista sola; defaultOpen abre el plegable", () => {
    expect(renderToStaticMarkup(<MpReceiptView receipt={receipt} variant="plain" />)).toMatch(/^<dl/);
    expect(renderToStaticMarkup(<MpReceiptView receipt={receipt} variant="collapsible" defaultOpen />)).toMatch(
      /<details[^>]* open=""/,
    );
  });
});
