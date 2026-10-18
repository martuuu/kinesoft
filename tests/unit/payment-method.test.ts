/**
 * [AS-1k1] C-AS2 · `lib/payment-method.ts`: el medio de pago del cobro de un turno (decisión 5 del 19-oct: un cobro
 * por turno con medio de pago) y sus etiquetas, compartidas con la suscripción (`lib/saas-billing-types.ts`).
 *
 * Por qué la paridad contra los enums de Prisma: `PAYMENT_METHODS` es una lista a mano (el módulo es client-safe y no
 * puede importar el runtime de `@prisma/client`); si M12 o una migración futura suma un medio al enum de Postgres y
 * nadie lo suma acá, el picker no lo ofrece y `paymentMethodLabel` devolvería `undefined` para una fila real. El
 * `SaasPaymentMethod` (M8c) tiene otro ORDEN (Transferencia primero: así lo muestran los selects de la suscripción),
 * por eso se compara como conjunto.
 */
import { describe, expect, it } from "vitest";
import { BookingPaymentMethod, SaasPaymentMethod } from "@prisma/client";
import {
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABEL,
  PAYMENT_METHOD_UNKNOWN,
  isPaymentMethod,
  paymentMethodLabel,
  type PaymentMethod,
} from "@/lib/payment-method";
import {
  SAAS_PAYMENT_METHODS,
  SAAS_PAYMENT_METHOD_LABEL,
  SAAS_PAYMENT_METHOD_UNKNOWN,
  paymentMethodLabel as saasPaymentMethodLabel,
} from "@/lib/saas-billing-types";

// Paridad de TIPOS (tsc): `PaymentMethod` ≡ `BookingPaymentMethod` ≡ `SaasPaymentMethod`.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _booking: Same<PaymentMethod, BookingPaymentMethod> = true;
const _saas: Same<PaymentMethod, SaasPaymentMethod> = true;
void _booking;
void _saas;

describe("[AS-1k1] PAYMENT_METHODS", () => {
  it("[AS-1k1] orden del contrato (el del picker): Efectivo primero, el caso más común en la recepción", () => {
    expect([...PAYMENT_METHODS]).toEqual(["CASH", "TRANSFER", "CARD", "WALLET", "MERCADO_PAGO", "OTHER"]);
  });

  it("[AS-1k1] paridad con el enum de Postgres del turno (M12) y con el de la suscripción (M8c), como conjunto", () => {
    expect([...PAYMENT_METHODS].sort()).toEqual(Object.values(BookingPaymentMethod).sort());
    expect([...PAYMENT_METHODS].sort()).toEqual(Object.values(SaasPaymentMethod).sort());
    expect(new Set(PAYMENT_METHODS).size).toBe(PAYMENT_METHODS.length);
  });

  it("[AS-1k1] etiquetas en castellano, una por medio", () => {
    expect(PAYMENT_METHOD_LABEL).toEqual({
      CASH: "Efectivo",
      TRANSFER: "Transferencia",
      CARD: "Tarjeta",
      WALLET: "Billetera virtual",
      MERCADO_PAGO: "Mercado Pago",
      OTHER: "Otro",
    });
  });

  it("[AS-1k1] paymentMethodLabel: null/undefined → «Sin informar»", () => {
    expect(paymentMethodLabel(null)).toBe("Sin informar");
    expect(paymentMethodLabel(undefined)).toBe("Sin informar");
    expect(PAYMENT_METHOD_UNKNOWN).toBe("Sin informar");
    for (const m of PAYMENT_METHODS) expect(paymentMethodLabel(m)).toBe(PAYMENT_METHOD_LABEL[m]);
  });

  it("[AS-1k1] isPaymentMethod: solo los del enum (lo que llega del cliente o del wire)", () => {
    for (const m of PAYMENT_METHODS) expect(isPaymentMethod(m)).toBe(true);
    for (const v of ["cash", "", null, undefined, 1, "DEBIT", {}]) expect(isPaymentMethod(v)).toBe(false);
  });
});

describe("[AS-1k1] saas-billing-types re-exporta las mismas etiquetas (API intacta)", () => {
  it("[AS-1k1] mismo objeto de etiquetas y mismo «Sin informar»; el orden de la suscripción no cambia", () => {
    expect(SAAS_PAYMENT_METHOD_LABEL).toBe(PAYMENT_METHOD_LABEL);
    expect(SAAS_PAYMENT_METHOD_UNKNOWN).toBe(PAYMENT_METHOD_UNKNOWN);
    expect(saasPaymentMethodLabel).toBe(paymentMethodLabel);
    expect([...SAAS_PAYMENT_METHODS]).toEqual(["TRANSFER", "CASH", "CARD", "WALLET", "MERCADO_PAGO", "OTHER"]);
  });
});
