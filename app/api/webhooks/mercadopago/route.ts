import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { verifyWebhookSignature, consumeWebhook } from "@/lib/mercadopago";
import { rateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/client-ip";
import { logger } from "@/lib/logger";
import { env } from "@/lib/env";
import { handleConnectWebhook } from "@/lib/mp-connect/webhook-route";
import { isSaasTopic } from "@/lib/saas-mp-webhook-route";

export const runtime = "nodejs";

/**
 * Mercado Pago webhook receiver.
 *
 * Hardened in Sprint 11:
 *   - Signature verification is enforced **always** when MP_WEBHOOK_SECRET
 *     is configured. We do NOT downgrade in non-prod.
 *   - When the secret is missing the route refuses requests in production
 *     and allows them only in dev/test (so localhost testing still works).
 *   - 5-minute timestamp window in `verifyWebhookSignature` defeats replay.
 *   - Per-IP rate limit caps webhook spam (idempotency in `consumeWebhook`
 *     would already short-circuit replays, but the limit avoids touching
 *     MP's API on every replayed call).
 */
export async function POST(req: Request) {
  const ip = clientIp(headers());
  const rl = await rateLimit(`mp:webhook:${ip}`, { limit: 60, windowMs: 60_000 });
  if (!rl.ok) {
    return new NextResponse("rate limited", {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
    });
  }

  const url = new URL(req.url);
  const dataId =
    url.searchParams.get("data.id") ??
    url.searchParams.get("id") ??
    (await req.clone().json().then((b) => b?.data?.id ?? b?.id ?? null).catch(() => null));
  const type =
    url.searchParams.get("type") ??
    url.searchParams.get("topic") ??
    (await req.clone().json().then((b) => b?.type ?? null).catch(() => null));

  // T5 (C-TP6): cobros con la cuenta del vendedor → rama nueva; sin `?acct=` todo sigue igual (AUDIT §5.4).
  const acct = url.searchParams.get("acct");
  if (acct !== null) return handleConnectWebhook(req, { acct, dataId: dataId == null ? null : String(dataId), type, ip });
  // MPS (C-MPS6): suscripción de la plataforma (`?scope=saas` o topic de preapproval/débito) → rama propia, firma SIEMPRE con MP_WEBHOOK_SECRET.
  if (url.searchParams.get("scope") === "saas" || isSaasTopic(type)) return (await import("@/lib/saas-mp-webhook-route")).handleSaasWebhook(req, { dataId: dataId == null ? null : String(dataId), type, ip });

  if (type && type !== "payment") {
    return NextResponse.json({ ok: true, ignored: type });
  }
  if (!dataId) {
    return NextResponse.json({ ok: false, reason: "missing dataId" }, { status: 400 });
  }

  // Signature: required when MP_WEBHOOK_SECRET is configured. When it
  // isn't, only allow non-prod (localhost / staging-without-secret).
  if (env.MP_WEBHOOK_SECRET) {
    const v = verifyWebhookSignature({
      signature: req.headers.get("x-signature"),
      requestId: req.headers.get("x-request-id"),
      dataId: String(dataId),
    });
    if (!v.ok) {
      logger.warn("mp.webhook.bad_signature", { reason: v.reason, ip });
      return NextResponse.json(
        { ok: false, reason: "bad_signature" },
        { status: 401 }
      );
    }
  } else if (env.NODE_ENV === "production") {
    logger.error("mp.webhook.no_secret_in_prod");
    return NextResponse.json(
      { ok: false, reason: "server_not_configured" },
      { status: 503 }
    );
  } else {
    logger.warn("mp.webhook.skipping_signature_dev");
  }

  const result = await consumeWebhook(String(dataId));
  return NextResponse.json(result);
}
