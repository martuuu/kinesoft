import "server-only";
/**
 * Comprobantes de pago de la suscripción (PL-2b, PL-D22, plan §20.5.6): bucket PRIVADO `billing-receipts`, PDF/JPG/
 * PNG/WEBP de hasta 4 MB, URL firmada de 60 s.
 *
 * Orden (el porqué de cada paso):
 *  1. `readReceiptFile`: tamaño y tipo ANTES de leer los bytes enteros y, sobre todo, ANTES de Storage. El tipo
 *     declarado por el navegador lo controla el cliente: se comparan los primeros bytes (magic bytes,
 *     `checkReceipt`) contra lo declarado. Un archivo que no pasa nunca llega al bucket (no queda basura subida
 *     que después haya que borrar, ni un objeto ejecutable servido con `Content-Type: application/pdf`).
 *  2. El caller genera el id del pago y sube con `uploadReceipt` (clave armada acá, `upsert: false`).
 *  3. El caller inserta la fila en su tx; si la tx falla, `removeReceipt` (best effort) para no dejar huérfanos.
 *
 * Por el canal service (`lib/storage-internal.ts`): este módulo no decide quién puede qué. La clave que se firma
 * sale SIEMPRE de la fila `SaasPayment.receiptPath` que el caller ya filtró por consultorio.
 */
import {
  checkReceipt,
  isDateKey,
  receiptStorageKey,
  RECEIPT_ERROR_COPY,
  RECEIPT_MAX_BYTES,
  type ReceiptMimeType,
} from "@/lib/saas-billing-logic";
import { z } from "zod";
import type { SaasPaymentMethod } from "@prisma/client";
import { BILLING_COPY, SAAS_PAYMENT_METHODS } from "@/lib/saas-billing-types";
import { parseMoneyInput } from "@/lib/format";
import { toARDateKey } from "@/lib/datetime-ar";
import { storageRemove, storageSign, storageUpload } from "@/lib/storage-internal";

const BUCKET = "billing-receipts" as const;
/** PL-D22: las URLs de comprobantes viven 60 s (se piden de nuevo al hacer clic). */
export const RECEIPT_URL_TTL_S = 60;

export type ReadReceipt =
  | { ok: true; bytes: Uint8Array; mimeType: ReceiptMimeType; ext: string; sizeBytes: number }
  | { ok: false; error: string };

/** Lo mínimo de un `File` que se usa (el `File` de un FormData de server action lo cumple). */
export type ReceiptFileLike = { size: number; type: string; slice(start?: number, end?: number): Blob; arrayBuffer(): Promise<ArrayBuffer> };

export function isReceiptFile(v: unknown): v is ReceiptFileLike {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as ReceiptFileLike).size === "number" &&
    typeof (v as ReceiptFileLike).arrayBuffer === "function" &&
    typeof (v as ReceiptFileLike).slice === "function"
  );
}

/**
 * Valida y lee el archivo. El tamaño se mira con `file.size` antes de leer nada (un archivo de 50 MB no se carga en
 * memoria para después rechazarlo); los magic bytes con los primeros 16 bytes; recién si todo pasa se leen los bytes.
 * El cuerpo de la server action ya viene acotado por `serverActions.bodySizeLimit` (4.5 MB, next.config.mjs).
 */
export async function readReceiptFile(file: ReceiptFileLike): Promise<ReadReceipt> {
  if (file.size > RECEIPT_MAX_BYTES) return { ok: false, error: RECEIPT_ERROR_COPY.too_large };
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const check = checkReceipt({ declaredType: file.type ?? "", sizeBytes: file.size, head });
  if (!check.ok) return { ok: false, error: RECEIPT_ERROR_COPY[check.reason] };
  const bytes = new Uint8Array(await file.arrayBuffer());
  // El tamaño real tiene que coincidir con el declarado (un `size` mentido no pasa por acá con un File real, pero el
  // contrato no depende de eso).
  if (bytes.byteLength !== check.sizeBytes || bytes.byteLength > RECEIPT_MAX_BYTES) {
    return { ok: false, error: RECEIPT_ERROR_COPY.too_large };
  }
  return { ok: true, bytes, mimeType: check.mimeType, ext: check.ext, sizeBytes: check.sizeBytes };
}

export async function uploadReceipt(p: {
  tenantId: string;
  paymentId: string;
  ext: string;
  bytes: Uint8Array;
  mimeType: ReceiptMimeType;
}): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const path = receiptStorageKey(p.tenantId, p.paymentId, p.ext);
  const r = await storageUpload(BUCKET, path, p.bytes, p.mimeType);
  if (!r.ok) {
    return {
      ok: false,
      error:
        r.reason === "unconfigured"
          ? "Todavía no se pueden subir comprobantes. Escribinos y lo resolvemos."
          : "No pudimos guardar el comprobante. Probá de nuevo en un rato.",
    };
  }
  return { ok: true, path };
}

/** Best effort: si falla, queda logueado por `storage-internal` (sin la clave) y el objeto queda huérfano. */
export async function removeReceipt(path: string): Promise<void> {
  await storageRemove(BUCKET, [path]);
}

export async function signReceipt(path: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const r = await storageSign(BUCKET, path, RECEIPT_URL_TTL_S);
  if (!r.ok) return { ok: false, error: "No pudimos abrir el comprobante. Probá de nuevo." };
  return { ok: true, url: r.data };
}

// ── Formulario de pago (consultorio y Plataforma) ───────────────────────────────────────────────────────────────

export type PaymentFormFields = {
  file: ReceiptFileLike | null;
  chargeId: string | null;
  /** null = vacío (el caller decide: con cargo, lo que falta pagar). */
  amountCents: number | null;
  /** Instante del pago (mediodía AR del día elegido) o null si no lo dijo. */
  paidAt: Date | null;
  note: string | null;
  /** PL-F1a (M8c): obligatorio en todo pago nuevo (consultorio y Plataforma). */
  method: SaasPaymentMethod;
};

/** El medio viaja con el valor del enum (`TRANSFER`…), no con la etiqueta: el server no adivina textos. */
const METHOD = z.enum(SAAS_PAYMENT_METHODS);

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Máximo de un `INTEGER` de Postgres (la columna `SaasPayment.amountCents`). */
const MAX_PAYMENT_CENTS = 2_147_483_647;

function field(form: FormData, name: string): string | null {
  const v = form.get(name);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/**
 * Lee y valida el FormData del pago. Nada de esto toca Storage ni la base. El medio (`method`, PL-F1a) es obligatorio
 * y va a su columna: la nota ya no lleva el «Medio: …» de antes de M8c. El monto pasa por `parseMoneyInput`
 * (aritmética exacta, nunca `Number()*100`); la fecha es la de un `<input type="date">` (clave civil, sin TZ del
 * host) y no puede ser futura en AR.
 */
export function parsePaymentForm(form: FormData, now: Date): { ok: true; data: PaymentFormFields } | { ok: false; error: string; field: string } {
  const rawFile = form.get("file");
  const file = isReceiptFile(rawFile) && rawFile.size > 0 ? rawFile : null;
  const chargeId = field(form, "chargeId");
  if (chargeId !== null && !ID_RE.test(chargeId)) return { ok: false, error: "Cargo inválido.", field: "chargeId" };
  const money = parseMoneyInput(field(form, "amount"));
  if (!money.ok) return { ok: false, error: "Revisá el monto (por ejemplo, 15.000 o 15.000,50).", field: "amount" };
  if (money.cents !== null && money.cents <= 0) return { ok: false, error: "Ingresá un monto mayor a cero.", field: "amount" };
  // PL-Z a1#6: `SaasPayment.amountCents` es INTEGER; más que eso es un error de tipeo y en la base sería un 22003.
  if (money.cents !== null && money.cents > MAX_PAYMENT_CENTS) {
    return { ok: false, error: "Revisá el monto: es demasiado alto.", field: "amount" };
  }
  const paidOn = field(form, "paidOn");
  let paidAt: Date | null = null;
  if (paidOn !== null) {
    if (!isDateKey(paidOn)) return { ok: false, error: "Revisá la fecha del pago.", field: "paidOn" };
    if (paidOn > toARDateKey(now)) return { ok: false, error: "La fecha del pago no puede ser futura.", field: "paidOn" };
    paidAt = new Date(`${paidOn}T12:00:00-03:00`);
  }
  const note = field(form, "note");
  if (note !== null && note.length > 500) return { ok: false, error: "La nota puede tener hasta 500 caracteres.", field: "note" };
  const method = METHOD.safeParse(field(form, "method"));
  if (!method.success) return { ok: false, error: BILLING_COPY.methodRequired, field: "method" };
  return { ok: true, data: { file, chargeId, amountCents: money.cents, paidAt, note, method: method.data } };
}
