/**
 * P4-C (ES4, brief §3.5): DTO de «Cuenta» del portal. Tipos puros: los arma el server y los pinta el portal.
 *
 * PROHIBIDO en cualquier nivel: `osAmountCents`, arancel, `listPriceCents`, `priceCents` crudo de Service, `notes`,
 * `insurer*`. El paciente ve lo que le toca pagar a él (copago), no lo que el consultorio factura a la obra social ni el
 * precio de lista: eso es información comercial del consultorio. El test de forma del server (S24p,
 * `tests/integration/portal-account.test.ts`) recorre el DTO entero contra una allowlist de claves.
 *
 * Plata en centavos `Int` (AGENTS §4); se formatea con `formatARS` en la UI.
 */

/** Un monto, o «A confirmar en el consultorio» cuando el copago todavía no está definido (no se inventa un 0). */
export type PortalMoney = { kind: "amount"; cents: number } | { kind: "to_confirm" };

export type PortalAccountDTO = {
  plans: {
    programId: string;
    title: string;
    sessionWord: "sesión" | "turno";
    agreed: PortalMoney | null;
    collectedCents: number;
    pendingCents: number;
    creditCents: number;
    inProcessCents: number;
  }[];
  looseBookings: {
    id: string;
    /** ISO 8601. */
    date: string;
    serviceName: string;
    amount: PortalMoney;
    paid: boolean;
    /** Pago en proceso (AUTHORIZED): «Pago en proceso». */
    inProcess: boolean;
    /** Realizado, con monto y sin cobrar: suma a «Te falta pagar» («A pagar»). */
    pending: boolean;
    /** Cancelado o ausente (solo se lista si tiene plata en juego). */
    cancelled: boolean;
  }[];
  totals: { pendingCents: number; creditCents: number };
};
