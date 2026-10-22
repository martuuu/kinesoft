/**
 * [TP-2h] Lógica pura de las lecturas de cobros online del staff (C-TP9, `lib/online-charges-read.ts`): fila de la
 * base → `OnlineChargeView`, avisos, cursor de `/cobros` y el período del filtro.
 *
 * Por qué fuera del `"use server"`: un archivo de actions solo exporta funciones async (AGENTS §4) y esto se prueba
 * suelto (`tests/unit/tp2h-online-charges-view.test.ts`), en TZ=UTC y AR. Sin Prisma ni `env`; el cursor usa `Buffer`,
 * así que se importa solo desde el server.
 *
 * Qué NUNCA sale al DTO (C-TP9): `publicToken` suelto (solo la URL armada en `link`, y solo para quien puede
 * re-compartirlo), `rawPayload`, `idempotencyKey`, `preferenceId`/`checkoutUrl` ni nada de la credencial. La fila que
 * recibe `chargeViewOf` ya viene con un `select` que no los trae, salvo `publicToken` (para la URL) y las banderas de
 * `rawPayload` que `chargeFlagsOf` reduce a booleanos ANTES de llegar acá.
 */
import { buildMpReceipt, chargeReceiptOf } from "@/lib/mp-receipt";
import { CHARGE_STATUS_LABEL } from "@/lib/online-payments-copy";
import type { ChargeKind, ChargeOrigin, ChargeStatus } from "@/lib/online-charge-logic";
import type { OnlineChargeNotice, OnlineChargeView } from "@/lib/online-payments-types";

/** Lo que `online-charges-read.ts` lee de cada cobro (el `select` exacto, más los nombres ya resueltos). */
export type OnlineChargeRow = {
  id: string;
  origin: ChargeOrigin;
  kind: ChargeKind;
  status: ChargeStatus;
  practitionerId: string;
  bookingId: string | null;
  amountCents: number;
  concept: string | null;
  publicToken: string | null;
  createdAt: Date;
  expiresAt: Date;
  mpPaymentId: string | null;
  mpStatus: string | null;
  mpStatusDetail: string | null;
  paymentMethodId: string | null;
  paymentTypeId: string | null;
  installments: number | null;
  paidAmountCents: number | null;
  approvedAt: Date | null;
  refundedAt: Date | null;
  cancelledAt: Date | null;
  accountKind: "PRACTITIONER" | "CLINIC";
  practitionerName: string | null;
  /** Banderas que el webhook (TP-2a) deja en `rawPayload.flags`, ya reducidas por `chargeFlagsOf`. */
  flags: ChargeFlags;
};

export type ChargeFlags = { duplicate: boolean; amountMismatch: boolean };

/**
 * `rawPayload.flags` → booleanos. Defensivo a propósito: `rawPayload` es JSONB que escribe el webhook con lo que manda
 * MP (redactado) y su forma puede crecer; acá solo se reconocen dos banderas y cualquier otra cosa es «no». Así nada
 * del payload (ids de MP, datos del pagador) llega al DTO.
 */
export function chargeFlagsOf(rawPayload: unknown): ChargeFlags {
  const flags =
    rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload)
      ? (rawPayload as { flags?: unknown }).flags
      : null;
  const f = flags && typeof flags === "object" && !Array.isArray(flags) ? (flags as Record<string, unknown>) : {};
  return { duplicate: f.duplicate === true, amountMismatch: f.amountMismatch === true || f.amount_mismatch === true };
}

/** Tolerancia del control de monto del webhook (§25.6: «monto ±5 centavos»). Fuera de esto, el aviso. */
export const AMOUNT_TOLERANCE_CENTS = 5;

/**
 * Avisos del cobro (C-TP9 `notices`). Cada uno sale de columnas que el guard de M18 escribe una sola vez, o de la
 * bandera del webhook:
 * - `late-after-cancel`: se pagó (o reintegró) un cobro que ya estaba anulado (el guard deja entrar el pago tardío
 *   y conserva `cancelledAt`: «un pago aprobado siempre se registra»);
 * - `amount-mismatch`: lo acreditado difiere del monto en más de 5 centavos, o el webhook lo marcó;
 * - `partial-refund`: MP lo informa como `approved` con `status_detail = partially_refunded`;
 * - `disputed`: en mediación o con contracargo;
 * - `duplicate`: el webhook lo marcó (el turno ya estaba cobrado), o `siblingPaid` (otro cobro FULL pagado del
 *   mismo turno en la misma lectura).
 */
export function chargeNoticesOf(r: OnlineChargeRow, o: { siblingPaid?: boolean } = {}): OnlineChargeNotice[] {
  const out: OnlineChargeNotice[] = [];
  const paid = r.status === "PAID" || r.status === "REFUNDED";
  if (r.flags.duplicate || (paid && o.siblingPaid)) out.push("duplicate");
  if (paid && r.cancelledAt) out.push("late-after-cancel");
  if (r.status === "PAID" && r.mpStatusDetail === "partially_refunded") out.push("partial-refund");
  if (r.mpStatus === "in_mediation" || r.mpStatus === "charged_back") out.push("disputed");
  if (
    r.flags.amountMismatch ||
    (r.paidAmountCents != null && Math.abs(r.paidAmountCents - r.amountCents) > AMOUNT_TOLERANCE_CENTS)
  ) {
    out.push("amount-mismatch");
  }
  return out;
}

/** URL pública del link (`/pagar/<token>`, TP-3i). Sin token (cobro del turnero) → null. */
export function paymentLinkUrl(appUrl: string, publicToken: string | null): string | null {
  if (!publicToken || !/^[A-Za-z0-9_-]{22}$/.test(publicToken)) return null;
  return `${appUrl.replace(/\/+$/, "")}/pagar/${publicToken}`;
}

export type ChargeViewContext = {
  appUrl: string;
  /** ¿El viewer puede anular/reenviar ESTE cobro? (`canCollectCopago` con el profesional del cobro, sin soporte). */
  canManage: boolean;
  /** Otro cobro FULL del mismo turno ya está pagado (lo calcula el caller con todas las filas del turno). */
  siblingPaid?: boolean;
};

export function chargeViewOf(r: OnlineChargeRow, ctx: ChargeViewContext): OnlineChargeView {
  const receiptView =
    r.status === "PAID" || r.status === "REFUNDED"
      ? buildMpReceipt({
          mpPaymentId: r.mpPaymentId,
          approvedAt: r.approvedAt,
          paidAmountCents: r.paidAmountCents,
          paymentMethodId: r.paymentMethodId,
          paymentTypeId: r.paymentTypeId,
          installments: r.installments,
          mpStatus: r.mpStatus,
          refundedAt: r.refundedAt,
        })
      : null;
  const account = { kind: r.accountKind, practitionerName: r.accountKind === "PRACTITIONER" ? r.practitionerName : null };
  const url = r.origin === "LINK" ? paymentLinkUrl(ctx.appUrl, r.publicToken) : null;
  const live = r.status === "ACTIVE";
  return {
    id: r.id,
    origin: r.origin,
    kind: r.kind,
    status: r.status,
    statusLabel: CHARGE_STATUS_LABEL[r.status],
    amountCents: r.amountCents,
    concept: r.origin === "LINK" ? r.concept : null,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    practitionerName: r.practitionerName,
    accountKind: r.accountKind,
    receipt: receiptView
      ? {
          ...chargeReceiptOf(receiptView),
          paymentMethodId: r.paymentMethodId,
          paymentTypeId: r.paymentTypeId,
          installments: r.installments,
          mpStatus: r.mpStatus,
          account,
        }
      : null,
    // La URL solo para quien puede re-compartirla: el token es la llave de pago del link (C-TP9).
    link: url && ctx.canManage ? { url, canCancel: live, canResend: live } : null,
    notices: chargeNoticesOf(r, { siblingPaid: ctx.siblingPaid }),
  };
}

/**
 * Cobros FULL pagados de más en un mismo turno: el segundo (por fecha de aprobación) es el duplicado. Devuelve los
 * ids a marcar. El primero no se marca: es el cobro «bueno».
 */
export function duplicatePaidIds(rows: Pick<OnlineChargeRow, "id" | "bookingId" | "kind" | "status" | "approvedAt">[]): Set<string> {
  const byBooking = new Map<string, { id: string; at: number }[]>();
  for (const r of rows) {
    if (!r.bookingId || r.kind !== "FULL" || (r.status !== "PAID" && r.status !== "REFUNDED")) continue;
    const list = byBooking.get(r.bookingId) ?? [];
    list.push({ id: r.id, at: r.approvedAt?.getTime() ?? 0 });
    byBooking.set(r.bookingId, list);
  }
  const out = new Set<string>();
  for (const list of byBooking.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    for (const x of list.slice(1)) out.add(x.id);
  }
  return out;
}

// ── /cobros: cursor y período ───────────────────────────────────────────────────────────────────────────────────────

export const ONLINE_CHARGES_PAGE_SIZE = 50;

/** Cursor opaco de keyset (`createdAt` desc, `id` desc): base64url de `<iso>|<id>`. */
export function encodeChargesCursor(r: { createdAt: Date; id: string }): string {
  return Buffer.from(`${r.createdAt.toISOString()}|${r.id}`, "utf8").toString("base64url");
}

/** Cursor inválido → null (la action lo rechaza: un cursor roto no puede volver a la primera página en silencio). */
export function decodeChargesCursor(c: string): { createdAt: Date; id: string } | null {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(c)) return null;
  const raw = Buffer.from(c, "base64url").toString("utf8");
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\|([A-Za-z0-9_-]{1,64})$/.exec(raw);
  if (!m) return null;
  const createdAt = new Date(m[1]);
  return Number.isNaN(createdAt.getTime()) ? null : { createdAt, id: m[2] };
}

/** Períodos del filtro de `/cobros` (TP-3g los pone en la URL): últimos N días o un mes calendario AR. */
export const CHARGE_PERIODS = ["7d", "30d", "90d"] as const;
export type ChargePeriod = (typeof CHARGE_PERIODS)[number] | `${number}-${number}`;

export function isChargePeriod(p: string): p is ChargePeriod {
  return (CHARGE_PERIODS as readonly string[]).includes(p) || /^\d{4}-(0[1-9]|1[0-2])$/.test(p);
}

/**
 * Rango [from, to) de `createdAt` para el período. Un mes es el mes calendario de ARGENTINA (`2026-10` = del 1/10
 * 00:00 AR al 1/11 00:00 AR), no el del host: en Vercel (UTC) el 31/10 a las 22:00 AR ya es noviembre. AR no tiene
 * horario de verano, así que el offset es fijo.
 */
export function chargePeriodRange(p: ChargePeriod, now: Date): { from: Date; to: Date | null } {
  const days = p === "7d" ? 7 : p === "30d" ? 30 : p === "90d" ? 90 : null;
  if (days !== null) return { from: new Date(now.getTime() - days * 86_400_000), to: null };
  const [y, m] = p.split("-").map(Number);
  const from = new Date(`${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-01T00:00:00.000-03:00`);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const to = new Date(`${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-01T00:00:00.000-03:00`);
  return { from, to };
}
