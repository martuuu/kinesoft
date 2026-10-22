/**
 * Reglas de plata de los cobros online (T5, TP-P3; contrato C-TP7 del plan §25). Puro y client-safe: sin DB, sin red,
 * sin `@prisma/client`. Lo usan el turnero (decidir y cotizar el cobro), el consumidor del webhook de Mercado Pago
 * (`lib/mp-connect/consume.ts`: estado del cobro y efecto sobre el turno) y las vistas de cobro (lo que falta).
 *
 * Por qué unions de string y no los enums de Prisma: esta sesión corre ANTES que M18 (`OnlineChargeStatus`, etc.
 * todavía no existen en el cliente generado). Los valores son literalmente los del SQL de M18; el integrador puede
 * agregar un `satisfies` contra los enums cuando M18 esté generada, sin cambiar nada acá.
 *
 * Plata 100 % en centavos `Int` (AGENTS.md §4). Ninguna función multiplica un `Number()` por 100.
 */

export type ChargeStatus = "ACTIVE" | "AUTHORIZED" | "PAID" | "REFUNDED" | "EXPIRED" | "CANCELLED";
export type ChargeOrigin = "TURNERO" | "LINK";
export type ChargeKind = "FULL" | "DEPOSIT" | "FREE";

/**
 * Forma de la política que leen estas funciones. Es un subconjunto ESTRUCTURAL de `PaymentPolicyInput` (C-TP5, en
 * `lib/booking-payment-policy-types.ts`, de TP-K1): cualquier `PaymentPolicyInput` se puede pasar tal cual. No se
 * importa de ahí porque ese archivo nace en otra tanda (T5c) y esto es lógica pura que no debe depender del orden.
 */
export type OnlineChargePolicy = {
  mode: "OFF" | "OPTIONAL" | "REQUIRED";
  chargeKind: "COPAGO" | "FIXED" | "PERCENT";
  fixedCents: number | null;
  percentBps: number | null;
};

/** $1: por debajo, MP rechaza la preferencia y el CHECK `OnlineCharge_amount_check` también (M18). */
export const MIN_ONLINE_CHARGE_CENTS = 100;
/** $1.000.000: tope del CHECK `OnlineCharge_amount_check` y de `priceCents` del servicio (`lib/validation.ts`). */
export const MAX_ONLINE_CHARGE_CENTS = 100_000_000;

/** Modos de `MP_CONNECT_MODE` que habilitan cobros (C-TP2). Cualquier otro valor (incluido un typo) = apagado. */
const CONNECT_MODES_ON: ReadonlySet<string> = new Set(["fake", "sandbox", "live"]);

import { formatARS } from "@/lib/format";

const isCents = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);

export type OnlineChargeDecision =
  | { kind: "none"; reason: "off" | "no-account" | "below-min" | "patient-chose-later" }
  | { kind: "charge"; required: boolean; chargeKind: "FULL" | "DEPOSIT"; amountCents: number };

/**
 * Monto del cobro según la política, sobre la base `copagoCents` (el copago del turno, o el precio del servicio al
 * cotizar). `null` = la política está mal formada o la base es inválida: el caller lo trata como «sin cobro» (fail
 * closed: nunca se cobra un monto que no sale limpio de la política).
 *
 * - COPAGO: el copago entero, FULL.
 * - FIXED: min(seña, copago); si la seña ≥ copago es FULL por el copago (cobrar una «seña» igual al total confunde al
 *   paciente y a la recepción: el turno queda pagado, no señado).
 * - PERCENT: copago·bps/10000 redondeado a PESOS ENTEROS (half-up; «$ 1.234» y no «$ 1.234,57» en el turnero). Si
 *   el redondeo llega al copago (o lo pasa) es FULL por el copago exacto, que puede tener centavos.
 */
function amountFor(policy: OnlineChargePolicy, baseCents: number): { amountCents: number; chargeKind: "FULL" | "DEPOSIT" } | null {
  if (!isCents(baseCents) || baseCents < 0) return null;
  if (policy.chargeKind === "COPAGO") return { amountCents: baseCents, chargeKind: "FULL" };
  if (policy.chargeKind === "FIXED") {
    const fixed = policy.fixedCents;
    if (!isCents(fixed) || fixed <= 0) return null;
    return fixed >= baseCents ? { amountCents: baseCents, chargeKind: "FULL" } : { amountCents: fixed, chargeKind: "DEPOSIT" };
  }
  if (policy.chargeKind === "PERCENT") {
    const bps = policy.percentBps;
    if (!isCents(bps) || bps <= 0 || bps > 10_000) return null;
    // base·bps es entero y ≤ 1e12 (exacto en double). centavos·bps/10000/100 = pesos; +500000 redondea half-up.
    const pesos = Math.floor((baseCents * bps + 500_000) / 1_000_000);
    const cents = pesos * 100;
    return cents >= baseCents ? { amountCents: baseCents, chargeKind: "FULL" } : { amountCents: cents, chargeKind: "DEPOSIT" };
  }
  return null;
}

/**
 * Decide si el turnero cobra online y cuánto (§25.5). Precedencia, en este orden:
 * 1. `off`: modo de conexión apagado, sin política, política OFF o política/base inválida.
 * 2. `no-account`: sin cuenta usable (TP-D8: sin cuenta → sin cobro; nunca la de la plataforma, H-TP1).
 * 3. `below-min`: el monto da menos de $1 (copago 0, porcentaje chico) → reserva sin cobro, como TP-0.
 * 4. OPTIONAL sin «Pagar ahora» explícito → `patient-chose-later` (TP-UI-D5: sin preselección; `undefined` NO es sí).
 *
 * REQUIRED ignora `payNow`: el paciente no elige. Un monto > $1.000.000 cae en `off` (el CHECK de M18 lo rechazaría y
 * el turnero respondería 500); hoy no puede pasar porque `priceCents` y los copagos tienen el mismo tope.
 */
export function decideOnlineCharge(o: {
  connectMode: string;
  policy: OnlineChargePolicy | null;
  account: { kind: "PRACTITIONER" | "CLINIC" } | null;
  payNow: boolean | undefined;
  copagoCents: number;
}): OnlineChargeDecision {
  const policy = o.policy;
  if (!CONNECT_MODES_ON.has(o.connectMode) || !policy || (policy.mode !== "OPTIONAL" && policy.mode !== "REQUIRED")) {
    return { kind: "none", reason: "off" };
  }
  const amount = amountFor(policy, o.copagoCents);
  if (!amount || amount.amountCents > MAX_ONLINE_CHARGE_CENTS) return { kind: "none", reason: "off" };
  if (!o.account) return { kind: "none", reason: "no-account" };
  if (amount.amountCents < MIN_ONLINE_CHARGE_CENTS) return { kind: "none", reason: "below-min" };
  const required = policy.mode === "REQUIRED";
  if (!required && o.payNow !== true) return { kind: "none", reason: "patient-chose-later" };
  return { kind: "charge", required, chargeKind: amount.chargeKind, amountCents: amount.amountCents };
}

/**
 * Cotización del wizard con el precio del servicio (antes de identificar al paciente). Paridad con
 * `decideOnlineCharge` POR CONSTRUCCIÓN: llama a la misma función con modo y cuenta «encendidos» y `payNow: true`,
 * así no hay dos copias de la regla de montos que diverjan. Si el server después resuelve otro copago (obra social),
 * el turnero muestra el interstitial (TP-UI-D6). `null` = no se cobra nada con ese precio.
 */
export function quoteOnlineCharge(o: {
  policy: OnlineChargePolicy | null;
  servicePriceCents: number;
}): { amountCents: number; chargeKind: "FULL" | "DEPOSIT" } | null {
  const d = decideOnlineCharge({
    connectMode: "live",
    policy: o.policy,
    account: { kind: "PRACTITIONER" },
    payNow: true,
    copagoCents: o.servicePriceCents,
  });
  return d.kind === "charge" ? { amountCents: d.amountCents, chargeKind: d.chargeKind } : null;
}

export type MpPaymentStatus = "approved" | "pending" | "rejected" | "refunded" | "charged_back" | "cancelled" | "in_mediation";

/**
 * Estado de un pago de MP (`/v1/payments/:id`.status) a nuestro vocabulario reducido.
 * - `authorized` (MP retiene sin capturar) e `in_process` son «en proceso» → `pending`.
 * - Un valor desconocido también cae en `pending`: deja el cobro AUTHORIZED, que BLOQUEA el cobro a mano («Hay un pago
 *   de Mercado Pago en proceso») hasta que llegue un estado conocido. La otra opción (`rejected`) dejaría cobrar en la
 *   recepción con un pago de estado incierto en vuelo: el riesgo es cobrar dos veces.
 */
export function mapMpStatus(s: string): MpPaymentStatus {
  switch (String(s ?? "").trim().toLowerCase()) {
    case "approved":
      return "approved";
    case "rejected":
      return "rejected";
    case "cancelled":
      return "cancelled";
    case "refunded":
      return "refunded";
    case "charged_back":
      return "charged_back";
    case "in_mediation":
      return "in_mediation";
    default:
      return "pending";
  }
}

/**
 * Transiciones de estado que admite el trigger `online_charge_guard()` de M18, LITERALES del SQL:
 * ACTIVE→AUTHORIZED|PAID|REFUNDED|EXPIRED|CANCELLED · AUTHORIZED→ACTIVE|PAID|REFUNDED · EXPIRED→PAID|REFUNDED ·
 * CANCELLED→PAID|REFUNDED · PAID→REFUNDED · REFUNDED terminal. `nextChargeStatus` nunca propone otra (test de matriz).
 */
export const CHARGE_TRANSITIONS: Readonly<Record<ChargeStatus, readonly ChargeStatus[]>> = {
  ACTIVE: ["AUTHORIZED", "PAID", "REFUNDED", "EXPIRED", "CANCELLED"],
  AUTHORIZED: ["ACTIVE", "PAID", "REFUNDED"],
  EXPIRED: ["PAID", "REFUNDED"],
  CANCELLED: ["PAID", "REFUNDED"],
  PAID: ["REFUNDED"],
  REFUNDED: [],
};

export function canTransitionCharge(from: ChargeStatus, to: ChargeStatus): boolean {
  return from === to || CHARGE_TRANSITIONS[from].includes(to);
}

/**
 * Próximo estado del cobro ante un pago de MP (paso 5 del consumidor, §25.6). Mismo resultado que dejaría pasar el
 * guard SQL; si no hay transición válida, el estado no cambia (el intento igual queda en `rawPayload`).
 *
 * - `approved`: un pago aprobado SIEMPRE se registra (la plata existe), también sobre un link vencido o anulado: la app
 *   avisa. Con `amountMismatch` (±5 centavos, lo mide el consumidor) NO pasa a PAID: el cobro queda como estaba y se
 *   avisa «Pago con monto distinto».
 * - `pending` / `in_mediation`: solo ACTIVE → AUTHORIZED. Un PAID en mediación sigue PAID (reclamo: aviso, no baja);
 *   EXPIRED/CANCELLED no tienen transición a AUTHORIZED en el guard.
 * - `rejected` / `cancelled`: AUTHORIZED → ACTIVE (el paciente puede reintentar); nunca baja un PAID.
 * - `refunded` / `charged_back`: → REFUNDED desde cualquier estado no terminal: es lo único que baja un PAID. Un
 *   reintegro PARCIAL llega como `approved` (status_detail `partially_refunded`) y el cobro sigue PAID (TP-D25).
 */
export function nextChargeStatus(cur: ChargeStatus, incoming: MpPaymentStatus, o: { amountMismatch: boolean }): ChargeStatus {
  let next: ChargeStatus = cur;
  switch (incoming) {
    case "approved":
      if (!o.amountMismatch) next = "PAID";
      break;
    case "pending":
    case "in_mediation":
      if (cur === "ACTIVE") next = "AUTHORIZED";
      break;
    case "rejected":
    case "cancelled":
      if (cur === "AUTHORIZED") next = "ACTIVE";
      break;
    case "refunded":
    case "charged_back":
      next = "REFUNDED";
      break;
  }
  return canTransitionCharge(cur, next) ? next : cur;
}

export type BookingEffect = "confirm" | "mark-paid" | "mark-authorized" | "revert-authorized" | "mark-refunded" | "none";

/** Estado del copago del turno (`PaymentStatus` de Prisma, como string para no importar el cliente). */
type BookingPaymentStatusLike = "UNPAID" | "AUTHORIZED" | "PAID" | "REFUNDED" | "FAILED" | null;

/**
 * Efecto sobre el TURNO de una transición del cobro (§25.6 paso 5). Lo aplica el escritor único
 * `applyOnlineChargeToBookingInTx` (`lib/booking-copago-internal.ts`). Devuelve `["none"]` si no hay nada que escribir.
 *
 * - Sin turno (link FREE), sin cambio de estado o transición que el guard SQL no admite → nada.
 * - Turno CANCELLED / NO_SHOW: el pago se registra en el cobro pero el turno NO revive ni se marca cobrado (la app
 *   avisa «si corresponde, reintegralo desde Mercado Pago»). Excepción: el reintegro de un FULL que ya había marcado
 *   el copago por MP (`paidByMp`) sí lo refleja, porque si no el turno seguiría diciendo «Pagado».
 * - → PAID:
 *   - turnero con el turno PENDING (REQUIRED, hold) → `confirm`; también con el hold vencido (TP-D24, como el legado:
 *     se confirma y se avisa «revisá que el horario siga libre»);
 *   - FULL con el copago todavía no PAID → `mark-paid` (PAID + MERCADO_PAGO, sin quién cobró). Si ya estaba PAID (a mano
 *     o por otro cobro) no se pisa: es un duplicado y lo avisa el consumidor;
 *   - DEPOSIT: nada en el copago (TP-D7; la seña la suma el trigger `online_charge_sync_booking`).
 * - ACTIVE → AUTHORIZED de un FULL con el copago sin cobrar → `mark-authorized` («Pago retenido», bloquea el cobro a mano).
 *   TP-ZF1 (B3): también la seña del turnero con el turno PENDING (sostiene el hold mientras MP retiene la seña).
 * - AUTHORIZED → ACTIVE / REFUNDED de un FULL con el copago AUTHORIZED → `revert-authorized` (vuelve a «Por cobrar»).
 *   TP-ZF1 (B3): la seña del turnero también, y además al pasar a PAID (confirm + revert: la seña no marca el copago).
 * - → REFUNDED de un FULL que pagó el copago por MP → `mark-refunded` (el CHECK de M12 admite REFUNDED con medio).
 */
export function bookingEffectFor(
  c: {
    origin: ChargeOrigin;
    kind: ChargeKind;
    bookingStatus: string | null;
    bookingPaymentStatus: BookingPaymentStatusLike | string;
    paidByMp: boolean;
  },
  from: ChargeStatus,
  to: ChargeStatus
): BookingEffect[] {
  // Una transición que el guard SQL rechaza nunca llega a escribirse: no tiene efecto sobre el turno.
  if (from === to || !canTransitionCharge(from, to) || c.kind === "FREE" || c.bookingStatus == null) return ["none"];
  const dead = c.bookingStatus === "CANCELLED" || c.bookingStatus === "NO_SHOW";
  const full = c.kind === "FULL";
  // TP-ZF1 (B3 del revisor de T5-Z): la seña del turnero (REQUIRED con seña) también marca «en proceso» mientras el
  // turno espera en PENDING. Si no, con la seña AUTHORIZED (efectivo, mediación) el turno seguía PENDING/UNPAID, el hold
  // vencía y el horario se liberaba mientras MP retenía la plata. PENDING + AUTHORIZED sostiene el cupo
  // (`isHoldingCapacity`). Al resolverse se revierte: la seña nunca marca el copago (TP-D7).
  const turneroDeposit = c.kind === "DEPOSIT" && c.origin === "TURNERO";
  const ps = c.bookingPaymentStatus;
  const effects: BookingEffect[] = [];

  if (to === "PAID") {
    if (dead) return ["none"];
    if (c.origin === "TURNERO" && c.bookingStatus === "PENDING") effects.push("confirm");
    if (full && ps !== "PAID") effects.push("mark-paid");
    else if (turneroDeposit && ps === "AUTHORIZED") effects.push("revert-authorized");
  } else if (to === "AUTHORIZED") {
    const holds = full || (turneroDeposit && c.bookingStatus === "PENDING");
    if (!dead && holds && ps !== "PAID" && ps !== "AUTHORIZED" && ps !== "REFUNDED") effects.push("mark-authorized");
  } else if (to === "ACTIVE") {
    if ((full || turneroDeposit) && ps === "AUTHORIZED") effects.push("revert-authorized");
  } else if (to === "REFUNDED") {
    if (full && ps === "PAID" && c.paidByMp) effects.push("mark-refunded");
    else if ((full || turneroDeposit) && ps === "AUTHORIZED") effects.push("revert-authorized");
  }
  return effects.length > 0 ? effects : ["none"];
}

/**
 * Lo que falta cobrar del copago: copago resuelto − Σ señas PAID (`Booking.onlineDepositCents`, que escribe solo el
 * trigger de M18), con piso 0. Una seña inválida (negativa o no entera) se ignora: sumarla AUMENTARÍA lo que se le
 * cobra al paciente; ignorarla falla del lado de cobrar lo que dice el copago. Un copago inválido se trata como 0.
 */
export function remainingOf(b: { resolvedCopagoCents: number; onlineDepositCents: number }): number {
  const copago = isCents(b.resolvedCopagoCents) && b.resolvedCopagoCents > 0 ? b.resolvedCopagoCents : 0;
  const deposit = isCents(b.onlineDepositCents) && b.onlineDepositCents > 0 ? b.onlineDepositCents : 0;
  return Math.max(0, copago - deposit);
}

/**
 * Columnas del comprobante (TP-D20) a partir del pago de MP, SANEADAS a los CHECK de M18. Regla de M18: ninguna
 * constraint que la realidad de MP pueda romper; si un CHECK salta, el webhook da 500 y MP reintenta durante días. Por
 * eso acá se trunca y se descarta lo que no entra, en vez de confiar en lo que manda MP.
 *
 * - `mpPaymentId`: `^[0-9]{1,20}$` (MP manda número o string); si no cumple, `null` y el consumidor no registra PAID.
 * - `mpStatus`: solo los valores del CHECK `OnlineCharge_mpStatus_check`; otro → `null`.
 * - Textos: `mpStatusDetail` ≤64, `paymentMethodId`/`paymentTypeId` ≤40. `installments` 1..72 o `null`.
 * - `paidAmountCents`: `transaction_amount` (decimal de MP) a centavos con `Math.round(x·100)`, igual que la rama
 *   legada (`lib/mercadopago.ts`); negativo, no finito o > tope → `null`.
 * - `approvedAt`: `date_approved` si parsea; si no, `now` (el CHECK exige fecha en PAID/REFUNDED y la plata existe).
 * - `settledAt`: SIEMPRE `now`, nuestro reloj al registrar (se compara con `copagoPaidAt`, TP-D28).
 */
export type ReceiptColumns = {
  mpPaymentId: string | null;
  mpStatus: string | null;
  mpStatusDetail: string | null;
  paymentMethodId: string | null;
  paymentTypeId: string | null;
  installments: number | null;
  paidAmountCents: number | null;
  approvedAt: Date;
  settledAt: Date;
};

const MP_STATUS_ALLOWED: ReadonlySet<string> = new Set([
  "approved",
  "authorized",
  "pending",
  "in_process",
  "in_mediation",
  "rejected",
  "cancelled",
  "refunded",
  "charged_back",
]);

function textOrNull(v: unknown, max: number): string | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}

export function receiptColumnsFrom(mp: Record<string, unknown>, now: Date): ReceiptColumns {
  const idRaw = typeof mp.id === "number" || typeof mp.id === "string" ? String(mp.id).trim() : "";
  const status = typeof mp.status === "string" ? mp.status.trim().toLowerCase() : "";
  const inst = mp.installments;
  const amount = mp.transaction_amount;
  let paidAmountCents: number | null = null;
  if (typeof amount === "number" && Number.isFinite(amount) && amount >= 0) {
    const cents = Math.round(amount * 100);
    if (cents <= MAX_ONLINE_CHARGE_CENTS * 10) paidAmountCents = cents;
  }
  const approvedRaw = typeof mp.date_approved === "string" ? new Date(mp.date_approved) : null;
  return {
    mpPaymentId: /^[0-9]{1,20}$/.test(idRaw) ? idRaw : null,
    mpStatus: MP_STATUS_ALLOWED.has(status) ? status : null,
    mpStatusDetail: textOrNull(mp.status_detail, 64),
    paymentMethodId: textOrNull(mp.payment_method_id, 40),
    paymentTypeId: textOrNull(mp.payment_type_id, 40),
    installments: typeof inst === "number" && Number.isInteger(inst) && inst >= 1 && inst <= 72 ? inst : null,
    paidAmountCents,
    approvedAt: approvedRaw && !Number.isNaN(approvedRaw.getTime()) ? approvedRaw : now,
    settledAt: now,
  };
}

/**
 * Aviso al cancelar un turno con seña (decisión 2 del 19-oct: los reintegros se hacen DESDE Mercado Pago; la app no
 * devuelve plata). Copy literal de §25.1.
 */
export function depositRefundNotice(cents: number): string {
  return `Este turno tiene una seña de ${formatARS(cents)}: si corresponde, reintegrala desde Mercado Pago.`;
}
