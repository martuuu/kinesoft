import "server-only";

/**
 * Rama `?acct=` del webhook de Mercado Pago (T5, C-TP6 del plan §25.6). La llama `app/api/webhooks/mercadopago/route.ts`
 * (3 líneas aditivas de TP-2a, después del rate limit y del parseo de `dataId`/`type`, ANTES de la firma legada). Sin
 * `?acct=` todo sigue por la rama legada (AUDIT §5.4; `mp-webhook.test.ts` no se toca).
 *
 * **Stub de TP-K3 (tanda T5c):** firma congelada. TP-2a lo implementa:
 *   - `type` ≠ payment → 200 ignorado; `acct` mal formado → 200 ignorado;
 *   - firma según `mpConnectSignatureMode()` con `MP_CONNECT_WEBHOOK_SECRET` (`required` + inválida/vieja/ausente → 401
 *     sin llamar a MP);
 *   - `consumeConnectWebhook` → 200 / 503 (MP o reauth) / 500 (base), con `{ result }` en el cuerpo (lo lee el simulador,
 *     handoff de TP-P4).
 *
 * Hasta entonces: 503 (MP reintenta; nada se procesa ni se da por pagado).
 */
export type ConnectWebhookContext = {
  acct: string;
  dataId: string | null;
  type: string | null;
  ip: string;
};

export async function handleConnectWebhook(req: Request, ctx: ConnectWebhookContext): Promise<Response> {
  void req;
  void ctx;
  return new Response(JSON.stringify({ ok: false, result: "ignored" }), {
    status: 503,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
