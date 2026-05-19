import { NextResponse } from "next/server";
import { verifyWebhookSignature, consumeWebhook } from "@/lib/mercadopago";

export const runtime = "nodejs";

/**
 * Mercado Pago webhook receiver.
 *
 * MP sends two flavours of notifications: the legacy IPN (querystring) and
 * the new "webhook" with a signed body. We handle both — the type filter
 * limits processing to `payment` events.
 */
export async function POST(req: Request) {
  const url = new URL(req.url);
  const dataId =
    url.searchParams.get("data.id") ??
    url.searchParams.get("id") ??
    (await req.clone().json().then((b) => b?.data?.id ?? b?.id ?? null).catch(() => null));
  const type =
    url.searchParams.get("type") ??
    url.searchParams.get("topic") ??
    (await req.clone().json().then((b) => b?.type ?? null).catch(() => null));

  if (type && type !== "payment") {
    return NextResponse.json({ ok: true, ignored: type });
  }
  if (!dataId) return NextResponse.json({ ok: false, reason: "missing dataId" }, { status: 400 });

  const ok = verifyWebhookSignature({
    signature: req.headers.get("x-signature"),
    requestId: req.headers.get("x-request-id"),
    dataId: String(dataId),
  });
  if (!ok && process.env.NODE_ENV === "production") {
    return NextResponse.json({ ok: false, reason: "bad_signature" }, { status: 401 });
  }

  const result = await consumeWebhook(String(dataId));
  return NextResponse.json(result);
}
