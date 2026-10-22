/**
 * [TP-P5] Copy de T5 (cobros online con la cuenta de Mercado Pago del vendedor, ADR-026): una sola fuente para el
 * vocabulario de §25.10 y los textos literales del brief (C-TP7 campana, C-TP9 links, §25.5 turnero, §25.8 cobro).
 *
 * Vocabulario (tabla literal de §25.10; lo hace cumplir `tests/unit/online-payments-copy.test.ts` sobre los archivos
 * de T5):
 *   - **seña**: lo que se paga antes · **pago**: lo que hace el paciente · **cobro**: lo que registra el consultorio;
 *   - **link de pago**: nunca la palabra de la API de MP para el checkout ni la del vale de descuento (TP-UI-D1: también
 *     en el switch de delegación);
 *   - **reintegro**: nunca el sinónimo que usa el webhook legado (hallazgo 17 de §25.2; el legado queda como está por
 *     AUDIT §5.4);
 *   - **Mercado Pago**: siempre completo. Única abreviatura: el badge «Pagado MP» de la card de la agenda (TP-UI-D4),
 *     que no entra de otra forma en una card de 15 minutos; su nombre accesible sí lo dice completo;
 *   - **Secretaría**, con tilde, como en la app (`lib/tenant-plan-usage-logic.ts`).
 *
 * Puro y client-safe: lo importan la card de la agenda (techo de `/agenda` +0,3 kB, §25.11), el turnero, `/pagar`,
 * el drawer, /cobros, Configuración, los emails y la campana. Por eso solo depende de `lib/datetime-ar.ts` (sin
 * imports) y nada de `server-only`, Prisma ni React. Los tipos de estado son unions de string a propósito (como
 * `lib/online-charge-logic.ts`, TP-P3): los enums de M18 no existen hasta T5b y este módulo no puede esperar.
 */
import { toARDateKey, toARDow, toARMinutes } from "@/lib/datetime-ar";

/** Tabla de §25.10, para quien necesite la palabra (y para que el test fije la tabla). */
export const ONLINE_PAYMENTS_VOCAB = {
  deposit: "seña",
  payment: "pago",
  charge: "cobro",
  paymentLink: "link de pago",
  refund: "reintegro",
  mercadoPago: "Mercado Pago",
  secretary: "Secretaría",
} as const;

// ── Estados ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** = `ChargeStatus` de C-TP7 (enum `OnlineChargeStatus` de M18). */
export type OnlineChargeStatusValue = "ACTIVE" | "AUTHORIZED" | "PAID" | "REFUNDED" | "EXPIRED" | "CANCELLED";
export type OnlineChargeKindValue = "FULL" | "DEPOSIT" | "FREE";
export type OnlineChargeOriginValue = "TURNERO" | "LINK";

/**
 * Estado del cobro en /cobros, Facturación y el drawer. «Pendiente de pago» es el texto que ya ve el hold del turnero
 * (QA manual 4 de T5); AUTHORIZED es el pago retenido que MP todavía no acreditó.
 */
export const CHARGE_STATUS_LABEL: Readonly<Record<OnlineChargeStatusValue, string>> = {
  ACTIVE: "Pendiente de pago",
  AUTHORIZED: "En proceso",
  PAID: "Pagado",
  REFUNDED: "Reintegrado",
  EXPIRED: "Vencido",
  CANCELLED: "Anulado",
};

export const CHARGE_KIND_LABEL: Readonly<Record<OnlineChargeKindValue, string>> = {
  FULL: "Total",
  DEPOSIT: "Seña",
  FREE: "Sin turno",
};

export const CHARGE_ORIGIN_LABEL: Readonly<Record<OnlineChargeOriginValue, string>> = {
  TURNERO: "Turnero",
  LINK: "Link de pago",
};

/** Estado del pago según MP (`mpStatus`, los valores del CHECK `OnlineCharge_mpStatus_check` de M18). */
export const MP_STATUS_LABEL: Readonly<Record<string, string>> = {
  approved: "Aprobado",
  authorized: "Autorizado",
  pending: "Pendiente",
  in_process: "En proceso",
  in_mediation: "En disputa",
  rejected: "Rechazado",
  cancelled: "Cancelado",
  refunded: "Reintegrado",
  charged_back: "Contracargo",
};
export const MP_STATUS_UNKNOWN = "Sin informar";

/**
 * Medio de pago (`payment_type_id` de MP). `ticket` es el pago en efectivo en un local (Rapipago, Pago Fácil): MP le
 * dice de otra forma, pero acá es «Efectivo». El turnero REQUIRED no lo ofrece (TP-D15); un link sí puede recibirlo.
 */
export const MP_PAYMENT_TYPE_LABEL: Readonly<Record<string, string>> = {
  credit_card: "Tarjeta de crédito",
  debit_card: "Tarjeta de débito",
  prepaid_card: "Tarjeta prepaga",
  account_money: "Dinero en cuenta de Mercado Pago",
  digital_currency: "Crédito de Mercado Pago",
  digital_wallet: "Billetera virtual",
  bank_transfer: "Transferencia",
  ticket: "Efectivo",
  atm: "Cajero automático",
};

/** Marca de la tarjeta (`payment_method_id`). Solo las de Argentina que vale la pena nombrar; el resto, sin marca. */
export const MP_CARD_BRAND_LABEL: Readonly<Record<string, string>> = {
  visa: "Visa",
  debvisa: "Visa",
  master: "Mastercard",
  debmaster: "Mastercard",
  maestro: "Maestro",
  amex: "American Express",
  naranja: "Naranja",
  cabal: "Cabal",
  debcabal: "Cabal",
  argencard: "Argencard",
  cencosud: "Cencosud",
  tarshop: "Tarjeta Shopping",
  cordobesa: "Cordobesa",
  diners: "Diners",
};
export const MP_METHOD_FALLBACK = "Mercado Pago";

// ── Comprobante (TP-D20 / TP-UI-D11) ────────────────────────────────────────────────────────────────────────────────

export const RECEIPT_COPY = {
  title: "Comprobante",
  operation: "N° de operación",
  date: "Fecha",
  amount: "Monto",
  method: "Medio de pago",
  installments: "Cuotas",
  status: "Estado",
  account: "Acreditado en",
  refunded: "Reintegrado el",
  oneInstallment: "En un pago",
  manyInstallments: (n: number) => `${n} cuotas`,
  practitionerAccount: (name: string) => `Mercado Pago de ${name}`,
  clinicAccount: "Mercado Pago del consultorio",
} as const;

// ── Turno: agenda y drawer (§25.10) ─────────────────────────────────────────────────────────────────────────────────

/** Mini-badge de la card (TP-UI-D4: solo estos dos). El nombre accesible lo dice completo. */
export const MONEY_BADGE_COPY = {
  deposit: { label: "Seña", aria: (amount: string) => `Seña pagada por Mercado Pago: ${amount}` },
  paidMp: { label: "Pagado MP", aria: "Pagado por Mercado Pago" },
} as const;

export const BOOKING_MONEY_COPY = {
  depositPaid: (amount: string) => `Seña pagada · ${amount}`,
  remaining: (amount: string) => `Por cobrar · ${amount}`,
  paidOnline: "Pagado por Mercado Pago",
  refundedOnline: "Reintegrado por Mercado Pago",
  receipt: "Comprobante",
  generateLink: "Generar link de pago",
  newLink: "Nuevo link de pago",
  sendLink: "Enviar link de pago",
  copy: "Copiar",
  whatsapp: "WhatsApp",
  cancelLink: "Anular",
  linkReady: "Link listo",
} as const;

/** §25.8: cobro a mano sobre un turno con plata online (literales). */
export const ONLINE_COLLECT_COPY = {
  mercadoPagoLocked: "Este turno se pagó por Mercado Pago: el cobro no se cambia a mano.",
  mercadoPagoInFlight: "Hay un pago de Mercado Pago en proceso: esperá a que se resuelva.",
  deleteWithOnlineCharge: "Este turno tiene un cobro online: cancelalo en lugar de borrarlo.",
} as const;

// ── Links de pago (C-TP9, literales) ────────────────────────────────────────────────────────────────────────────────

export const PAYMENT_LINK_COPY = {
  notDelegated: (name: string) => `${name} no autorizó links de pago a su Mercado Pago.`,
  noAccount: (name: string) => `${name} no tiene Mercado Pago conectado.`,
  reauth: (name: string) => `El Mercado Pago de ${name} necesita reconectarse.`,
  alreadyPaid: "Este turno ya está cobrado.",
  liveLinkExists: "Ya hay un link de pago activo para este turno: anulalo antes de generar otro.",
  amountRange: "El monto tiene que ser de $ 1 a $ 1.000.000.",
  depositTooHigh: "La seña tiene que ser menor que lo que falta cobrar.",
  depositAlreadyPaid: "Este turno ya tiene una seña pagada: generá el link por lo que falta.",
  preferenceFailed: "No pudimos crear el link en Mercado Pago. Probá de nuevo en unos minutos.",
  inFlight: "Hay un pago en proceso: esperá a que Mercado Pago lo resuelva.",
  conceptWarning: "No pongas datos clínicos en el concepto: lo ven el paciente y Mercado Pago.",
  noEmail: (name: string) => `${name} no tiene email cargado.`,
} as const;

const AR_WEEKDAY_SHORT = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"] as const;

/**
 * Concepto por default de un link con turno (TP-UI-D12): «Turno del lun 20/10 a las 10:00», **sin el servicio** (el
 * concepto lo ven el paciente y Mercado Pago; un servicio puede ser un dato clínico). Día y hora en AR por
 * `lib/datetime-ar.ts`: un turno de las 23:30 AR es del día siguiente en UTC.
 */
export function defaultLinkConcept(startsAt: Date | string): string {
  const d = typeof startsAt === "string" ? new Date(startsAt) : startsAt;
  if (Number.isNaN(d.getTime())) return "Turno";
  const [, mm, dd] = toARDateKey(d).split("-");
  const min = toARMinutes(d);
  const hh = String(Math.floor(min / 60)).padStart(2, "0");
  const mi = String(min % 60).padStart(2, "0");
  return `Turno del ${AR_WEEKDAY_SHORT[toARDow(d)]} ${dd}/${mm} a las ${hh}:${mi}`;
}

// ── Turnero (§25.5 / §25.10) ────────────────────────────────────────────────────────────────────────────────────────

export const TURNERO_PAYMENT_COPY = {
  payLater: "Reservar y pagar en el consultorio",
  payNow: "Pagar ahora con Mercado Pago",
  depositNow: "Seña a pagar ahora",
  restAtClinic: "Resto en el consultorio",
  requiredUnavailable: "No pudimos abrir Mercado Pago. Probá de nuevo en unos minutos.",
  optionalUnavailable: "No pudimos abrir Mercado Pago: lo pagás en el consultorio.",
  depositPaid: "Seña pagada",
  paid: "Pagado",
  refunded: "Reintegrado",
} as const;

// ── Cuentas y Configuración (§25.10) ────────────────────────────────────────────────────────────────────────────────

/** Estado de una cuenta de Mercado Pago conectada (`MpAccount.status` de M18) más «sin cuenta». */
export const MP_ACCOUNT_STATUS_LABEL = {
  ACTIVE: "Conectada",
  REAUTH_REQUIRED: "Necesita reconectarse",
  DISCONNECTED: "Desconectada",
  NONE: "Sin conectar",
} as const;

export const MP_CONNECT_COPY = {
  onlinePaymentsTab: "Cobros online",
  myMpTab: "Mi Mercado Pago",
  chargeOnlineSwitch: "¿Cobrás el turno online?",
  allowBookWithoutPaying: "Permitir reservar sin pagar",
  howMuch: "¿Cuánto se cobra online?",
  useClinicAccount: "Usar la cuenta del consultorio para los profesionales sin Mercado Pago",
  clinicAccountCard: "Cuenta del consultorio",
  practitionersCard: "Profesionales",
  delegationSwitch: "Permitir que la Secretaría y los administradores generen links de pago a mi cuenta",
  badgeSandbox: "Cuenta de prueba",
  badgeFake: "Simulador local",
  reauthTitle: "Reconectá tu Mercado Pago",
  reauthBody: "El acceso de la app a tu cuenta venció: hasta que lo reconectes, el turnero reserva sin cobro online.",
} as const;

/** Aviso de Configuración: «{n} profesionales sin Mercado Pago conectado» (con el singular bien). */
export function missingMpAccountsNotice(n: number): string {
  return `${n} ${n === 1 ? "profesional" : "profesionales"} sin Mercado Pago conectado`;
}

// ── Campana (C-TP7, literales) ──────────────────────────────────────────────────────────────────────────────────────

export const ONLINE_PAYMENT_NOTIFICATION_COPY = {
  paymentTitle: (amount: string) => `Pago recibido · ${amount}`,
  depositTitle: (amount: string) => `Seña recibida · ${amount}`,
  duplicateTitle: (amount: string) => `Pago duplicado · ${amount}`,
  duplicateBody: "El turno ya estaba cobrado: revisá el reintegro en Mercado Pago.",
  cancelledBookingTitle: (amount: string) => `Pago de un turno cancelado · ${amount}`,
  cancelledBookingBody: "si corresponde, reintegralo desde Mercado Pago.",
  lateHoldTitle: (amount: string) => `Pago recibido (reserva vencida) · ${amount}`,
  lateHoldBody: "revisá que el horario siga libre.",
  cancelledLinkTitle: (amount: string) => `Pago de un link anulado · ${amount}`,
  mismatchTitle: (amount: string) => `Pago con monto distinto · ${amount}`,
  mismatchBody: (expected: string) => `Esperábamos ${expected}. Revisalo en Mercado Pago.`,
  refundTitle: (amount: string) => `Reintegro registrado · ${amount}`,
  disputeTitle: (amount: string) => `Pago en disputa · ${amount}`,
  linkBody: (patient: string) => `Link de pago · ${patient}`,
} as const;
