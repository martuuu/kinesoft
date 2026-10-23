import { NextResponse } from "next/server";
import { env, whatsappMode } from "@/lib/env";
import { logger } from "@/lib/logger";
import { verifyMetaSignature, verifyTokenMatches } from "@/lib/whatsapp/crypto";
import { handleWhatsAppWebhook, readCappedBody } from "@/lib/whatsapp/webhook-internal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * WA-S3 (T6, C-WA9, brief §26.5) · Webhook de WhatsApp Cloud API (Meta).
 *
 *   - Con `WHATSAPP_MODE=off` la ruta no existe (404): sin canal no hay nada que verificar ni procesar, y un
 *     escaneo no distingue «apagado» de «no hay webhook».
 *   - GET = verify challenge de la suscripción (`hub.mode=subscribe` + `hub.verify_token`): devuelve `hub.challenge`
 *     en texto plano; si no, 403.
 *   - POST: tope de 1 MB → cuerpo CRUDO → `X-Hub-Signature-256` con el App Secret sobre esos bytes (inválida → 401) →
 *     `handleWhatsAppWebhook`. Todo lo demás responde 200 RÁPIDO aunque no rutee o falle: Meta reintenta los 5xx
 *     durante días, y un reintento de algo que no es de nadie (o de un dato raro) solo suma carga. La firma es la
 *     única puerta: sin ella no se parsea ni se toca la base.
 *
 * Por qué el secreto y el token se leen de `process.env` en cada request (con `env` de respaldo): los tests y el
 * simulador los cambian en caliente; `env` se congela al cargar el módulo. No hay literal de dev de respaldo: un
 * secreto vacío no valida nada (401), en ningún entorno.
 *
 * Sin rate limit por IP (a diferencia del webhook de MP): Meta manda desde un pool compartido y en ráfagas; el HMAC es
 * barato y corta todo lo no firmado antes de la base.
 */

const appSecret = () => process.env.WHATSAPP_APP_SECRET?.trim() || env.WHATSAPP_APP_SECRET || "";
const verifyToken = () => process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN?.trim() || env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || "";

const NO_STORE = { "cache-control": "no-store" } as const;
/** Meta manda un entero; se acota para no reflejar cualquier cosa en la respuesta. */
const CHALLENGE_RE = /^[A-Za-z0-9_.-]{1,256}$/;

function notFound(): NextResponse {
  return new NextResponse("Not found", { status: 404, headers: NO_STORE });
}

export async function GET(req: Request): Promise<Response> {
  if (whatsappMode() === "off") return notFound();
  const q = new URL(req.url).searchParams;
  const challenge = q.get("hub.challenge") ?? "";
  if (q.get("hub.mode") === "subscribe" && CHALLENGE_RE.test(challenge) && verifyTokenMatches(q.get("hub.verify_token"), verifyToken())) {
    return new NextResponse(challenge, {
      status: 200,
      headers: { ...NO_STORE, "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" },
    });
  }
  logger.warn("whatsapp.webhook.verify_rejected", { mode: q.get("hub.mode") ?? null });
  return new NextResponse("Forbidden", { status: 403, headers: NO_STORE });
}

export async function POST(req: Request): Promise<Response> {
  if (whatsappMode() === "off") return notFound();
  const raw = await readCappedBody(req);
  if (raw === "too_large") {
    logger.warn("whatsapp.webhook.too_large");
    return NextResponse.json({ result: "too_large" }, { status: 413, headers: NO_STORE });
  }
  if (!verifyMetaSignature(raw, req.headers.get("x-hub-signature-256"), appSecret())) {
    if (!appSecret()) logger.error("whatsapp.webhook.no_secret");
    else logger.warn("whatsapp.webhook.bad_signature");
    return NextResponse.json({ result: "bad_signature" }, { status: 401, headers: NO_STORE });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    return NextResponse.json({ result: "ignored" }, { headers: NO_STORE });
  }
  try {
    const s = await handleWhatsAppWebhook(body);
    // Un solo entrante (lo normal: un botón o un texto por webhook): su outcome va en `result` (el simulador lo
    // muestra en el panel y los tests lo leen). Varios o solo estados: un resumen.
    const result = s.outcomes.length === 1 ? s.outcomes[0] : s.processed > 0 ? "ok" : "ignored";
    return NextResponse.json({ result, processed: s.processed, ignored: s.ignored, statuses: s.statuses }, { headers: NO_STORE });
  } catch (err) {
    // 200 igual (ver cabecera). Lo que alcanzó a commitear quedó; un entrante a medias se fue con su rollback (la
    // reclamación del `wamid` está en la misma tx que su efecto).
    logger.error("whatsapp.webhook.failed", { error: (err as Error)?.name, code: (err as { code?: unknown })?.code ?? null /* nunca el mensaje: un error de base puede traer valores */ });
    return NextResponse.json({ result: "error" }, { headers: NO_STORE });
  }
}
