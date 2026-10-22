import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Firma `x-signature` de las notificaciones de Mercado Pago, versión pura (T5 TP-P2; brief §25.2 hallazgo 8, Anexo B
 * C-TP3).
 *
 * Por qué existe aparte de `verifyWebhookSignature` (lib/mercadopago.ts): la legada lee `env.MP_WEBHOOK_SECRET` y
 * `Date.now()` adentro, y está congelada por AUDIT §5.4 (no se toca ni se relaja). La rama nueva `?acct=` (TP-2a)
 * verifica con OTRO secreto (`MP_CONNECT_WEBHOOK_SECRET`, la app de OAuth) y el MP falso (C-TP12) tiene que FIRMAR con
 * el mismo manifiesto para que el E2E pase por la ruta real. Las dos cosas piden el secreto y el reloj como parámetros.
 *
 * Contrato: mismo manifiesto, mismo parseo del header, mismo tope de 5 min y mismos motivos que la legada; lo fija el
 * test de paridad (`tests/unit/tp-p2-mp-signature.test.ts`) contra el símbolo legado real. Si MP cambia el formato,
 * cambian las dos a la vez.
 *
 * Nota (no se corrige acá, por la paridad): la doc de MP pide el `data.id` en minúsculas en el manifiesto cuando es
 * alfanumérico. Los ids de pago son numéricos, así que hoy no muerde; la legada firma tal cual y esta también.
 */
export const MP_SIGNATURE_MAX_AGE_MS = 5 * 60_000;

export type MpSignatureVerification =
  | { ok: true }
  | { ok: false; reason: "no_secret" | "missing" | "stale" | "mismatch" };

function manifestOf(dataId: string, requestId: string | null, ts: string): string {
  return `id:${dataId};request-id:${requestId ?? ""};ts:${ts};`;
}

export function verifyMpSignature(opts: {
  signature: string | null;
  requestId: string | null;
  dataId: string | null;
  secret: string | null | undefined;
  nowMs?: number;
}): MpSignatureVerification {
  if (!opts.secret) return { ok: false, reason: "no_secret" };
  if (!opts.signature || !opts.dataId) return { ok: false, reason: "missing" };

  // Mismo parseo que la legada (`ts=…,v1=…`, orden libre, espacios recortados), a propósito: cualquier diferencia de
  // tolerancia haría que un mismo header valga en una rama y no en la otra.
  const parts: Record<string, string | undefined> = Object.fromEntries(
    opts.signature.split(",").map((p) => p.split("=").map((s) => s.trim()))
  );
  const ts = parts.ts;
  const v1 = parts.v1;
  if (!ts || !v1) return { ok: false, reason: "missing" };

  // Anti-replay: MP manda `ts` en segundos; se aceptan ms por magnitud como la legada.
  const tsMs = Number(ts);
  if (!Number.isFinite(tsMs)) return { ok: false, reason: "missing" };
  const tsAsMs = tsMs > 1e12 ? tsMs : tsMs * 1000;
  if (Math.abs((opts.nowMs ?? Date.now()) - tsAsMs) > MP_SIGNATURE_MAX_AGE_MS) {
    return { ok: false, reason: "stale" };
  }

  const hmac = createHmac("sha256", opts.secret).update(manifestOf(opts.dataId, opts.requestId, ts)).digest("hex");
  const a = Buffer.from(hmac);
  const b = Buffer.from(v1);
  // Tiempo constante; el largo del hex no es secreto.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "mismatch" };
  return { ok: true };
}

/**
 * Arma el header `x-signature` como lo manda MP. Solo para el MP falso (C-TP12) y los tests: en producción firma MP.
 * `ts` en segundos epoch.
 */
export function signMpNotification(o: {
  dataId: string;
  secret: string;
  ts: number | string;
  requestId: string | null;
}): string {
  const ts = String(o.ts);
  const v1 = createHmac("sha256", o.secret).update(manifestOf(o.dataId, o.requestId, ts)).digest("hex");
  return `ts=${ts},v1=${v1}`;
}
