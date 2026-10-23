import "server-only";
import { logger } from "@/lib/logger";
import { captureException } from "@/lib/observability";
import { verifyMpSignature } from "@/lib/mp-connect/signature";
import type { SaasMpConsumeResult } from "@/lib/saas-billing-mp-internal";

/**
 * Rama SaaS del webhook de Mercado Pago (C-MPS6). La llama `app/api/webhooks/mercadopago/route.ts` con DOS líneas,
 * después de la rama `?acct=` y antes del filtro legado de `type`: `scope=saas` o `isSaasTopic(type)` →
 * `handleSaasWebhook`. El legado queda como estaba (AUDIT §5.4; `mp-webhook.test.ts` no se toca).
 *
 * Orden (MPS-2b1):
 *   1. firma SIEMPRE con `MP_WEBHOOK_SECRET` leído en vivo (`env` se congela al importar; los tests y la rotación lo
 *      cambian en caliente). A diferencia de la legada, acá no hay «sin secreto en dev se deja pasar»: sin secreto →
 *      503 (MP reintenta cuando se cargue, en vez de perder un pago con un 401); firma inválida, vieja o ausente → 401
 *      SIN llamar a MP (un POST anónimo no nos hace gastar requests con el token de la plataforma);
 *   2. topic → recurso (`payment`, preapproval, authorized_payment); otro topic (p. ej. `merchant_order` con
 *      `?scope=saas`) → 200 ignorado (un 4xx haría que MP reintente días);
 *   3. `data.id` validado con la regex de su topic ANTES de armar un path a MP: preapproval = 32 hex en minúscula,
 *      authorized_payment y pago = numéricos. Uno que no calza → 200 ignorado;
 *   4. el consumidor (`lib/saas-billing-mp-internal.ts`) re-pide el recurso con el token de la plataforma → 200
 *      `{ ok, result }` / 503 si MP no respondió (MP reintenta) / 500 si falló la base.
 *
 * Los consumidores se cargan con `import()`: así el módulo de la ruta (y `mp-webhook.test.ts`, que la importa) no
 * arrastra el núcleo de cobros ni los mails para cada webhook de turnos.
 */

export type SaasWebhookContext = { dataId: string | null; type: string | null; ip: string };

/**
 * Topics de suscripciones de MP: los nombres nuevos (`subscription_*`) y los viejos que todavía manda según cómo se
 * creó el preapproval. Un `payment` NO es SaaS por topic: llega por `?scope=saas` (MPS-D9) o por la referencia
 * `saas:` en el camino legado.
 */
export const SAAS_WEBHOOK_TOPICS = [
  "subscription_preapproval",
  "subscription_authorized_payment",
  "preapproval",
  "authorized_payment",
] as const;

/** ¿El `type`/`topic` del webhook es de suscripciones? Puro; null/vacío → false. */
export function isSaasTopic(type: string | null | undefined): boolean {
  return typeof type === "string" && (SAAS_WEBHOOK_TOPICS as readonly string[]).includes(type);
}

type Resource = "payment" | "preapproval" | "authorized_payment";

/** Regex del `data.id` por recurso (handoff MPS-1b: ids de preapproval = 32 hex minúscula; los otros, numéricos). */
const DATA_ID_RE: Record<Resource, RegExp> = {
  preapproval: /^[0-9a-f]{32}$/,
  authorized_payment: /^[0-9]{1,20}$/,
  payment: /^[0-9]{1,20}$/,
};

function resourceOf(type: string | null): Resource | null {
  switch (type) {
    case "subscription_preapproval":
    case "preapproval":
      return "preapproval";
    case "subscription_authorized_payment":
    case "authorized_payment":
      return "authorized_payment";
    // Con `?scope=saas` solo llegan pagos del link de un cargo; MP viejo (IPN) puede mandarlo sin `type`.
    case "payment":
    case null:
      return "payment";
    default:
      return null;
  }
}

type Result = "applied" | "replay" | "mismatch" | "ignored";

function reply(status: number, result: Result, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ ok: status < 300, result, ...extra }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** El secreto de la plataforma vigente, leído en vivo (no `env.MP_WEBHOOK_SECRET`, que se congela al importar). */
function platformWebhookSecret(): string | null {
  const v = process.env.MP_WEBHOOK_SECRET?.trim();
  return v ? v : null;
}

/** Atiende un webhook SaaS (firma → topic → re-fetch → consumidor) y devuelve 200/401/503/500 con `{ ok, result }`. */
export async function handleSaasWebhook(req: Request, ctx: SaasWebhookContext): Promise<Response> {
  const secret = platformWebhookSecret();
  if (!secret) {
    logger.error("saas_mp.webhook.no_secret");
    return reply(503, "ignored", { reason: "server_not_configured" });
  }
  const v = verifyMpSignature({
    signature: req.headers.get("x-signature"),
    requestId: req.headers.get("x-request-id"),
    dataId: ctx.dataId,
    secret,
  });
  if (!v.ok) {
    logger.warn("saas_mp.webhook.bad_signature", { reason: v.reason, ip: ctx.ip });
    return reply(401, "ignored", { reason: "bad_signature" });
  }

  const resource = resourceOf(ctx.type);
  if (!resource) return reply(200, "ignored", { reason: "topic" });
  const dataId = ctx.dataId ?? "";
  if (!DATA_ID_RE[resource].test(dataId)) return reply(200, "ignored", { reason: "bad_data_id" });

  let r: SaasMpConsumeResult;
  try {
    const mod = await import("@/lib/saas-billing-mp-internal");
    r =
      resource === "payment"
        ? await mod.consumeSaasMpPayment(dataId, { source: "webhook" })
        : resource === "preapproval"
          ? await mod.consumeSaasPreapproval(dataId, { source: "webhook" })
          : await mod.consumeSaasAuthorizedPayment(dataId, { source: "webhook" });
  } catch (err) {
    // Solo el nombre del error: el mensaje de Prisma puede traer valores de la fila.
    logger.error("saas_mp.webhook.failed", { resource, error: err instanceof Error ? err.name : "unknown" });
    captureException(err, { scope: "saas_mp.webhook" });
    return reply(500, "ignored", { reason: "error" });
  }
  if (r.ok) return reply(200, r.result);
  return r.reason === "retry" ? reply(503, "ignored", { reason: "mp_unavailable" }) : reply(500, "ignored", { reason: "error" });
}
