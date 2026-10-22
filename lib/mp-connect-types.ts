/**
 * Cuentas de Mercado Pago conectadas por OAuth (T5, TP-K1; contrato C-TP4 del plan §25, Anexo B). Vive fuera de
 * `lib/mp-connect-actions.ts` porque ese archivo es `"use server"` y solo exporta funciones async.
 *
 * Client-safe. Nada de esto lleva tokens, `webhookRef`, `mpUserId` ni nada de `MpCredential`: el Titular ve A QUÉ
 * cuenta entra la plata por el `nickname`, y con eso alcanza (§25.3).
 */
import type { MpConnectMode } from "@/lib/env";
import type { PaymentPolicyInput } from "@/lib/booking-payment-policy-types";

export type { MpConnectMode } from "@/lib/env";

/** De quién es la cuenta que se conecta: la propia del profesional, o la del consultorio (solo el Titular, step-up). */
export type MpConnectTarget = "own" | "clinic";

/** Inputs de `startMpConnect` / `disconnectMpAccount` / `setMpLinksDelegated` (C-TP4, literales). */
export type StartMpConnectInput = { target: MpConnectTarget };
export type DisconnectMpAccountInput = { target: MpConnectTarget };
export type SetMpLinksDelegatedInput = { target: MpConnectTarget; delegated: boolean };

/** Resultados (C-TP4): la URL de autorización (el cliente navega con `location.assign`, TP-UI-D3) y los links anulados. */
export type StartMpConnectResult = { url: string };
export type DisconnectMpAccountResult = { cancelledLinks: number };

/**
 * C-TP4, literal. `NONE` = sin fila (nunca conectó). Fechas en ISO. `badge`: «Cuenta de prueba» (sandbox) o
 * «Simulador local» (fake); null en live.
 */
export type MpAccountView = {
  status: "NONE" | "ACTIVE" | "REAUTH_REQUIRED" | "DISCONNECTED";
  nickname: string | null;
  connectedAt: string | null;
  disconnectedAt: string | null;
  linksDelegated: boolean;
  badge: "sandbox" | "fake" | null;
};

/** Vista de una cuenta que no existe: la usan `getMyMpAccount`/`getOnlinePaymentsSettings` para no inventar ceros. */
export const MP_ACCOUNT_NONE: MpAccountView = {
  status: "NONE",
  nickname: null,
  connectedAt: null,
  disconnectedAt: null,
  linksDelegated: false,
  badge: null,
};

/**
 * Valor de `?mp=` con el que vuelve el callback (`/api/mp/oauth/callback`, 303 a `?tab=mercado-pago` o
 * `?tab=cobros-online`). Lo lee el panel para el aviso; cualquier otro valor se ignora.
 */
export type MpConnectReturn = "ok" | "denied" | "expired" | "in_use" | "error";
export const MP_CONNECT_RETURNS = ["ok", "denied", "expired", "in_use", "error"] as const satisfies readonly MpConnectReturn[];

/** Pestañas de Configuración de T5 (§25.10). `cobros-online` exige `tenant.sensitive`; `mercado-pago`, profesional propio. */
export const ONLINE_PAYMENTS_TAB = "cobros-online";
export const MY_MP_TAB = "mercado-pago";

/**
 * Lo que necesita el panel «Cobros online» (`getOnlinePaymentsSettings`, `tenant.sensitive`). El Anexo B lo nombra sin
 * forma; TP-K1 la fija a partir de §25.10:
 * - `policy` + `policyUpdatedAt`: la política vigente (sin fila = `DEFAULT_PAYMENT_POLICY` y `policyUpdatedAt` null; el
 *   null es el `expectedUpdatedAt` del primer guardado).
 * - `connectMode`: `off` → aviso «Los cobros online todavía no están habilitados» y controles deshabilitados.
 * - `publicBookingEnabled`: aviso «turnero apagado» (la política no sirve si nadie reserva online).
 * - `clinicAccount`: card «Cuenta del consultorio» (estado para todos los que ven la pestaña).
 * - `canManageClinicAccount`: solo el Titular (`account.owner`) ve conectar/desconectar/delegar; el step-up lo pide la
 *   action al actuar, no esto.
 * - `practitioners`: card «Profesionales»; `withoutMpCount` = cuántos no tienen cuenta ACTIVE («{n} profesionales sin
 *   Mercado Pago conectado»).
 */
export type OnlinePaymentsSettingsView = {
  policy: PaymentPolicyInput;
  policyUpdatedAt: string | null;
  connectMode: MpConnectMode;
  publicBookingEnabled: boolean;
  clinicAccount: MpAccountView;
  canManageClinicAccount: boolean;
  practitioners: OnlinePaymentsPractitionerRow[];
  withoutMpCount: number;
};

export type OnlinePaymentsPractitionerRow = {
  practitionerId: string;
  name: string;
  status: MpAccountView["status"];
  linksDelegated: boolean;
};
