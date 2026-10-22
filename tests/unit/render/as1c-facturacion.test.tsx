// T3c-1c · [AS-1c] Facturación del paciente con medio de pago y toggles por capability (plan §23.4, C-AS2).
//
// Contrato:
//  - el copago cobrado dice cómo pagó («Pagado · Efectivo»; «Sin informar» si es de antes de M12);
//  - el toggle del copago solo para quien lo cobra (`canCollectCopago`: el profesional, sus turnos);
//  - el de la obra social solo con `billing.manage` (`canConfirmInsurer`: la Secretaria no);
//  - sin `billingAccess` (caller de antes de T3) se muestran los dos como antes (decide el server).
//
// Vista real con `renderToStaticMarkup`; se mockean solo las server actions (red) y el router.
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/lib/bookings", () => ({ setBookingCopagoPaid: vi.fn(), setBookingInsurerPaid: vi.fn() }));
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

import { FacturacionView } from "@/components/patients/profile/views/facturacion-view";
import { ToastProvider } from "@/components/ui/toast";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { capabilitiesFor } from "@/lib/capabilities";
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
    status: "COMPLETED",
    paymentStatus: "UNPAID",
    copagoPaymentMethod: null,
    insurerPaidAt: null,
    durationMin: 45,
    programId: null,
    sessionId: null,
    serviceName: "Kinesiología",
    obraSocial: "OSDE",
    copagoCents: 600_000,
    osAmountCents: 400_000,
    updatedAt: new Date("2026-10-01T12:00:00Z"),
    scheduledFor: new Date("2026-10-01T13:00:00Z"),
    title: null,
    notes: null,
    idempotencyKey: `idem_${seq}`,
    ...over,
  } as unknown as PatientBookingFull;
}

const wrap = (el: ReactElement) =>
  renderToStaticMarkup(
    <ToastProvider>
      <ConfirmProvider>{el}</ConfirmProvider>
    </ToastProvider>
  );
const noop = () => {};
const PUBLIC_KEY = "pub:slot_1:nonce_1";
const rowOf = (html: string, i: number) => html.split('data-testid="fact-row"')[i + 1] ?? "";
const access = (role: "ASSISTANT" | "BILLING" | "PRACTITIONER", practitionerId: string | null = null) => ({
  capabilities: [...capabilitiesFor(role)],
  practitionerId,
});

describe("[AS-1c] Facturación con medio de pago", () => {
  it("el copago cobrado dice el medio; sin medio (antes de M12) «Sin informar»", () => {
    const html = wrap(
      <FacturacionView
        bookings={[booking({ paymentStatus: "PAID", copagoPaymentMethod: "CASH" }), booking({ paymentStatus: "PAID" })]}
        loading={false}
        patchBooking={noop}
        billingAccess={access("ASSISTANT")}
      />
    );
    expect(rowOf(html, 0)).toContain("Pagado · Efectivo");
    expect(rowOf(html, 1)).toContain("Pagado · Sin informar");
    // Quien cobra puede deshacerlo (botón con su nombre accesible).
    expect(rowOf(html, 0)).toContain('aria-label="Pagado · Efectivo. Deshacer cobro"');
  });

  it("Secretaria: cobra el copago, la obra social queda de solo lectura", () => {
    const html = wrap(<FacturacionView bookings={[booking()]} loading={false} patchBooking={noop} billingAccess={access("ASSISTANT")} />);
    const row = rowOf(html, 0);
    // T3-Z (M1): el copago dice «Cobrar», como el drawer y /sala. La OS muestra el estado sin botón.
    expect(row.match(/>Cobrar</g)).toHaveLength(1);
    expect(row).not.toContain(">Confirmar<");
    expect(row).toContain("Pendiente");
  });

  it("Facturación: confirma las dos", () => {
    const html = wrap(<FacturacionView bookings={[booking()]} loading={false} patchBooking={noop} billingAccess={access("BILLING")} />);
    expect(rowOf(html, 0).match(/>Confirmar</g)).toHaveLength(1);
    expect(rowOf(html, 0).match(/>Cobrar</g)).toHaveLength(1);
  });

  it("profesional (collectOwn): el copago de SU turno sí; el de un turno ajeno y la OS, solo el estado", () => {
    const html = wrap(
      <FacturacionView
        bookings={[booking({ practitionerId: "pr_mio" }), booking({ practitionerId: "pr_otro", paymentStatus: "PAID", copagoPaymentMethod: "CARD" })]}
        loading={false}
        patchBooking={noop}
        billingAccess={access("PRACTITIONER", "pr_mio")}
      />
    );
    expect(rowOf(html, 0).match(/>Cobrar</g)).toHaveLength(1);
    const foreign = rowOf(html, 1);
    expect(foreign).toContain("Pagado · Tarjeta");
    expect(foreign).not.toContain("Deshacer cobro");
    expect(foreign).not.toContain(">Confirmar<");
    expect(foreign).not.toContain(">Cobrar<");
  });

  it("un cobro retenido por Mercado Pago (AUTHORIZED) no ofrece toggle a mano", () => {
    const html = wrap(
      <FacturacionView bookings={[booking({ paymentStatus: "AUTHORIZED" })]} loading={false} patchBooking={noop} billingAccess={access("BILLING")} />
    );
    // Solo el «Confirmar» de la OS; el copago dice lo mismo que el drawer (T3-Z A3).
    expect(rowOf(html, 0).match(/>Confirmar</g)).toHaveLength(1);
    expect(rowOf(html, 0)).not.toContain(">Cobrar<");
    expect(rowOf(html, 0)).toContain("Pago retenido por Mercado Pago");
  });

  it("[Z-u1] REFUNDED sin botón; reserva pública pagada por MP sin medio: «Pagado por Mercado Pago» sin deshacer", () => {
    // Clave del turnero público (`isPublicReservation`): `pub:<a>:<b>`.
    const html = wrap(
      <FacturacionView
        bookings={[
          booking({ paymentStatus: "REFUNDED" }),
          booking({ paymentStatus: "PAID", idempotencyKey: PUBLIC_KEY }),
        ]}
        loading={false}
        patchBooking={noop}
        billingAccess={access("BILLING")}
      />
    );
    const refunded = rowOf(html, 0);
    expect(refunded).toContain("Reintegrado por Mercado Pago");
    expect(refunded).not.toContain(">Cobrar<");
    expect(refunded).not.toContain("Deshacer cobro");
    const mp = rowOf(html, 1);
    expect(mp).toContain("Pagado por Mercado Pago");
    expect(mp).not.toContain("Deshacer cobro");
    expect(mp).not.toContain("Sin informar");
  });

  it("[Z-u1] el chip pagado dice «tocá para deshacer» y los toggles miden 44 px en el teléfono (k-tap-m)", () => {
    const html = wrap(
      <FacturacionView
        bookings={[booking({ paymentStatus: "PAID", copagoPaymentMethod: "CASH" }), booking()]}
        loading={false}
        patchBooking={noop}
        billingAccess={access("BILLING")}
      />
    );
    expect(rowOf(html, 0)).toContain('title="Pagado · Efectivo · tocá para deshacer"');
    // Cada botón de la fila (Confirmar de la OS y Cobrar / chip del copago) lleva la clase de 44 px bajo 768.
    for (const r of [rowOf(html, 0), rowOf(html, 1)]) {
      const buttons = r.match(/<button[^>]*>/g) ?? [];
      expect(buttons.length).toBeGreaterThan(0);
      for (const b of buttons) expect(b).toContain("k-tap-m");
    }
    expect(html).toContain("Tocá «Cobrar» cuando pague el paciente");
  });

  it("sin billingAccess (caller de antes de T3): los dos toggles, como antes", () => {
    const html = wrap(<FacturacionView bookings={[booking()]} loading={false} patchBooking={noop} />);
    expect(rowOf(html, 0).match(/>Confirmar</g)).toHaveLength(1);
    expect(rowOf(html, 0).match(/>Cobrar</g)).toHaveLength(1);
  });
});

describe("[AS-1c] picker: último medio del dispositivo (localStorage en try/catch)", () => {
  it("guarda y lee el último medio; valor inválido o storage que tira → null, sin romper", async () => {
    const { readLastPaymentMethod, rememberPaymentMethod, LAST_PAYMENT_METHOD_KEY } = await import(
      "@/components/billing/payment-method-picker"
    );
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
    });
    try {
      expect(readLastPaymentMethod()).toBeNull();
      rememberPaymentMethod("TRANSFER");
      expect(store.get(LAST_PAYMENT_METHOD_KEY)).toBe("TRANSFER");
      expect(readLastPaymentMethod()).toBe("TRANSFER");
      store.set(LAST_PAYMENT_METHOD_KEY, "BITCOIN");
      expect(readLastPaymentMethod()).toBeNull();
      vi.stubGlobal("window", {
        localStorage: {
          getItem: () => {
            throw new Error("SecurityError");
          },
          setItem: () => {
            throw new Error("QuotaExceeded");
          },
        },
      });
      expect(readLastPaymentMethod()).toBeNull();
      expect(() => rememberPaymentMethod("CASH")).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
