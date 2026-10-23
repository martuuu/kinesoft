import "server-only";
/**
 * Rama SaaS del webhook de Mercado Pago (C-MPS6). La llama `app/api/webhooks/mercadopago/route.ts` con DOS líneas,
 * después de la rama `?acct=` y antes del filtro legado de `type`: `scope=saas` o `isSaasTopic(type)` →
 * `handleSaasWebhook`. El legado queda byte a byte (AUDIT §5.4; `mp-webhook.test.ts` no se toca).
 *
 * MPS-K: `isSaasTopic` va implementado (puro); `handleSaasWebhook` es STUB con la firma de contrato y lo implementa
 * MPS-2b1: firma SIEMPRE con `MP_WEBHOOK_SECRET` (sin secreto → 503; inválida → 401 sin llamar a MP), `dataId`
 * validado con una regex por topic, y despacho a `lib/saas-billing-mp-internal.ts`.
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

/** Atiende un webhook SaaS (firma → topic → re-fetch → consumidor) y devuelve 200/401/503/500 con `{ ok, result }`. */
export async function handleSaasWebhook(req: Request, ctx: SaasWebhookContext): Promise<Response> {
  void req;
  void ctx;
  throw new Error("not implemented: handleSaasWebhook");
}
