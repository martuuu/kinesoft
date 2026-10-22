/**
 * Body de la preferencia de Checkout Pro de un cobro online (T5, TP-P3; contrato C-TP3 del plan §25). Puro: no llama
 * a MP (eso es `mpCreatePreference` de `account-client.ts`, con el token del VENDEDOR). Se separa para testear sin red
 * lo que decide a qué rama del webhook vuelve el pago y cuánto se cobra.
 *
 * Reglas (C-TP3, literales):
 * - `items[0]` = `{ id, title: "Turno del dd/mm · {Consultorio}" | "Link de pago · {Consultorio}", quantity: 1,
 *   unit_price, currency_id: "ARS" }`. El título NO lleva el servicio (lo ve MP y el resumen de la tarjeta: puede ser
 *   un dato de salud). El día va en hora AR (`lib/datetime-ar.ts`): con el reloj del host, en Vercel (UTC) un turno de
 *   las 22:00 AR saldría con el día siguiente.
 * - `external_reference: "oc:<id>"`: el prefijo `oc:` separa los cobros nuevos de los `bookingId` del checkout legado.
 * - `notification_url` con `?acct=<webhookRef>`: SIN `acct` el webhook cae en la rama legada (cuenta de la plataforma,
 *   AUDIT §5.4) y el pago no se imputaría. Por eso se exige y se tira si falta: es un bug del caller, no un caso.
 * - `statement_descriptor` = nombre del consultorio en ASCII, ≤22 (límite de MP para el resumen); vacío → sin campo.
 * - `expires: true` + `expiration_date_to` (= `OnlineCharge.expiresAt`, con el offset de AR explícito).
 * - REQUIRED: `binary_mode` (aprobado o rechazado, sin «pendiente» que retenga el hold) + sin `ticket`/`atm` (un pago en
 *   efectivo se acredita días después del hold de 30 min; TP-D15).
 * - `back_urls`, `auto_return: "approved"`, `metadata: { chargeId }`.
 * - Sin `payer` (los links los abre cualquiera con el link; el turnero no manda datos del paciente a MP) y sin
 *   `marketplace_fee` (comisión 0, TP-D11: «nada pago»).
 */
import { AR_OFFSET, toARDateKey } from "@/lib/datetime-ar";

export type ChargePreferenceMode = "REQUIRED" | "OPTIONAL" | "LINK";

export type ChargePreferenceInput = {
  charge: {
    id: string;
    amountCents: number;
    /** Inicio del turno: obligatorio en REQUIRED/OPTIONAL (título «Turno del dd/mm»). */
    scheduledFor?: Date | string | null;
  };
  tenantName: string;
  mode: ChargePreferenceMode;
  notificationUrl: string;
  backUrls: { success: string; failure: string; pending: string };
  expiresAt: Date;
};

export type ChargePreferenceBody = {
  items: [{ id: string; title: string; quantity: 1; unit_price: number; currency_id: "ARS" }];
  external_reference: string;
  notification_url: string;
  statement_descriptor?: string;
  expires: true;
  expiration_date_to: string;
  binary_mode?: true;
  payment_methods?: { excluded_payment_types: { id: "ticket" | "atm" }[] };
  back_urls: { success: string; failure: string; pending: string };
  auto_return: "approved";
  metadata: { chargeId: string };
};

/** Límite de MP para `statement_descriptor` (lo que sale en el resumen de la tarjeta). */
export const STATEMENT_DESCRIPTOR_MAX = 22;

/**
 * Nombre del consultorio → descriptor del resumen: sin tildes (NFD), solo letras/dígitos/espacio (MP rechaza o
 * deforma el resto; «Kinesiología Ñandú & Cía.» → «Kinesiologia Nandu Cia»), espacios colapsados, ≤22, sin espacio
 * colgando. `""` si no queda nada (el caller omite el campo y MP usa el nombre de la cuenta del vendedor).
 */
export function statementDescriptorFrom(name: string): string {
  return String(name ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, STATEMENT_DESCRIPTOR_MAX)
    .trim();
}

/**
 * Centavos `Int` → `unit_price` decimal de MP. `cents / 100` es el double más cercano al decimal exacto (el mismo
 * que produce `JSON.parse("1234.56")`), así que MP recibe exactamente el monto: no hay `Number()*100` ni redondeo.
 */
function unitPriceFrom(cents: number): number {
  if (!Number.isInteger(cents) || cents <= 0) throw new Error(`buildChargePreference: monto inválido (${cents})`);
  return cents / 100;
}

/** `2026-10-22T09:30:00.000-03:00`: el instante en hora AR con el offset explícito (AR no tiene horario de verano). */
function arIsoWithOffset(d: Date): string {
  if (Number.isNaN(d.getTime())) throw new Error("buildChargePreference: expiresAt inválido");
  const offsetMin = Number(AR_OFFSET.slice(0, 3)) * 60;
  return `${new Date(d.getTime() + offsetMin * 60_000).toISOString().slice(0, 23)}${AR_OFFSET}`;
}

function hasAcct(url: string): boolean {
  try {
    return (new URL(url).searchParams.get("acct") ?? "").trim() !== "";
  } catch {
    return false;
  }
}

/** `notification_url` de un cobro online: la ruta del webhook de siempre + `?acct=<webhookRef>` de la cuenta. */
export function connectNotificationUrl(appUrl: string, webhookRef: string): string {
  return `${appUrl.replace(/\/+$/, "")}/api/webhooks/mercadopago?acct=${encodeURIComponent(webhookRef)}`;
}

export function buildChargePreference(input: ChargePreferenceInput): ChargePreferenceBody {
  const { charge, mode } = input;
  if (!hasAcct(input.notificationUrl)) {
    throw new Error("buildChargePreference: notification_url sin ?acct= (caería en la rama legada del webhook)");
  }
  const clinic = String(input.tenantName ?? "").trim();
  let title: string;
  if (mode === "LINK") {
    title = `Link de pago · ${clinic}`;
  } else {
    if (charge.scheduledFor == null) throw new Error("buildChargePreference: un cobro del turnero necesita la fecha del turno");
    const [, mm, dd] = toARDateKey(charge.scheduledFor).split("-");
    title = `Turno del ${dd}/${mm} · ${clinic}`;
  }

  const body: ChargePreferenceBody = {
    items: [{ id: charge.id, title, quantity: 1, unit_price: unitPriceFrom(charge.amountCents), currency_id: "ARS" }],
    external_reference: `oc:${charge.id}`,
    notification_url: input.notificationUrl,
    expires: true,
    expiration_date_to: arIsoWithOffset(input.expiresAt),
    back_urls: { ...input.backUrls },
    auto_return: "approved",
    metadata: { chargeId: charge.id },
  };
  const descriptor = statementDescriptorFrom(clinic);
  if (descriptor) body.statement_descriptor = descriptor;
  if (mode === "REQUIRED") {
    body.binary_mode = true;
    body.payment_methods = { excluded_payment_types: [{ id: "ticket" }, { id: "atm" }] };
  }
  return body;
}
