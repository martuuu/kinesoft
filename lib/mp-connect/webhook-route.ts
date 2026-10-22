import "server-only";
import { env, mpConnectSignatureMode } from "@/lib/env";
import { logger } from "@/lib/logger";
import { captureException } from "@/lib/observability";
import { consumeConnectWebhook } from "@/lib/mp-connect/consume";
import { verifyMpSignature } from "@/lib/mp-connect/signature";

/**
 * Rama `?acct=` del webhook de Mercado Pago (T5, C-TP6 del plan §25.6). La llama `app/api/webhooks/mercadopago/route.ts`
 * (3 líneas aditivas, después del rate limit y del parseo de `dataId`/`type`, ANTES de la firma legada). Sin `?acct=`
 * todo sigue por la rama legada (AUDIT §5.4; `mp-webhook.test.ts` no se toca).
 *
 * Orden (C-TP6):
 *   1. `type` ≠ payment → 200 ignorado (MP manda también merchant_order, etc.: un 4xx lo haría reintentar días);
 *   2. `acct` mal formado → 200 ignorado (no es un `webhookRef` nuestro: 128 bits en base64url, 22 caracteres);
 *   3. firma según `mpConnectSignatureMode()` con `MP_CONNECT_WEBHOOK_SECRET`: con `required`, inválida, vieja o ausente
 *      → 401 SIN llamar a MP (nadie nos hace gastar requests contra la cuenta del vendedor con un POST anónimo). Con
 *      `fetch-only` (hallazgo 8, S3: la doc de MP no dice si los pagos con token de vendedor llegan firmados con el
 *      secreto de nuestra app) se procesa igual: la autenticidad la da el GET del pago con el token de la cuenta +
 *      `collector_id` + `oc:` + monto + moneda, que el consumidor exige siempre;
 *   4. `data.id` que no es un id de pago de MP (numérico) → 200 ignorado (y nunca se interpola en la URL a MP);
 *   5. `consumeConnectWebhook` → 200 / 503 (MP caído o cuenta a reconectar: MP reintenta) / 500 (base).
 *
 * El cuerpo lleva `{ ok, result }`: `result` (`applied|replay|mismatch|ignored`) lo lee el simulador (handoff TP-P4).
 */
export type ConnectWebhookContext = {
  acct: string;
  dataId: string | null;
  type: string | null;
  ip: string;
};

/** `webhookRef` = 16 bytes en base64url (CHECK `MpAccount_webhookRef_check` de M18). */
const ACCT_RE = /^[A-Za-z0-9_-]{22}$/;
/** Ids de pago de MP: numéricos (mismo patrón que el CHECK del comprobante). */
const PAYMENT_ID_RE = /^[0-9]{1,20}$/;

type Result = "applied" | "replay" | "mismatch" | "ignored";

function reply(status: number, result: Result, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ ok: status < 300, result, ...extra }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** El secreto vigente (los tests lo cambian en caliente; `env` se congela al importar). */
function connectWebhookSecret(): string | undefined {
  return process.env.MP_CONNECT_WEBHOOK_SECRET?.trim() || env.MP_CONNECT_WEBHOOK_SECRET || undefined;
}

export async function handleConnectWebhook(req: Request, ctx: ConnectWebhookContext): Promise<Response> {
  if (ctx.type !== "payment") return reply(200, "ignored", { reason: "not_payment" });
  if (!ACCT_RE.test(ctx.acct)) {
    logger.warn("mp_connect.webhook.bad_acct", { ip: ctx.ip });
    return reply(200, "ignored", { reason: "bad_acct" });
  }

  if (mpConnectSignatureMode() === "required") {
    const secret = connectWebhookSecret();
    if (!secret) {
      // Mal configurado (el boot lo exige en sandbox/live): 503 para que MP reintente cuando se cargue el secreto, en vez
      // de perder el pago con un 401 o procesarlo sin la firma que la configuración pide.
      logger.error("mp_connect.webhook.no_secret");
      return reply(503, "ignored", { reason: "server_not_configured" });
    }
    const v = verifyMpSignature({
      signature: req.headers.get("x-signature"),
      requestId: req.headers.get("x-request-id"),
      dataId: ctx.dataId,
      secret,
    });
    if (!v.ok) {
      logger.warn("mp_connect.webhook.bad_signature", { reason: v.reason, ip: ctx.ip });
      return reply(401, "ignored", { reason: "bad_signature" });
    }
  }

  if (!ctx.dataId || !PAYMENT_ID_RE.test(ctx.dataId)) return reply(200, "ignored", { reason: "bad_data_id" });

  try {
    const r = await consumeConnectWebhook({ acct: ctx.acct, paymentId: ctx.dataId });
    return reply(r.status, r.result);
  } catch (err) {
    // Base caída o un CHECK que no previmos: 500 y MP reintenta. Solo el nombre del error en el log (el mensaje de
    // Prisma puede traer valores de la fila).
    logger.error("mp_connect.webhook.failed", { error: err instanceof Error ? err.name : "unknown" });
    captureException(err, { scope: "mp_connect.webhook" });
    return reply(500, "ignored", { reason: "error" });
  }
}
