/**
 * HD-4 (PV §27.E) · el webhook de Mercado Pago lee el cuerpo UNA vez y con tope.
 *
 * Por qué: la ruta hacía `await req.clone().json()` dos veces cuando la query no traía `data.id` o `type`. Un POST
 * anónimo de varios MB se leía entero (dos veces, por el clone) antes del rate limit de MP, la firma o cualquier otro
 * filtro. Ahora: rate limit → query; SOLO si falta algo en la query se lee el cuerpo con `MP_WEBHOOK_MAX_BYTES`
 * (64 KiB, `readCappedBody` compartido con el webhook de WhatsApp) y se parsea una vez.
 *
 * Se prueba el `POST` REAL de la ruta. Mockeado solo lo externo/estado: rate limit, `next/headers` (no hay request de
 * Next), `consumeWebhook` (va a MP + Postgres) y la rama `?acct=` (consume contra la base). La firma legada corre real
 * (sin `MP_WEBHOOK_SECRET` en unit = el camino de dev que la saltea con un warn). `mp-webhook.test.ts` (integración,
 * AUDIT §5.4) cubre la firma HMAC y el consumo de punta a punta y no se toca.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const consumeWebhook = vi.hoisted(() => vi.fn(async (id: string) => ({ ok: true, id })));
const handleConnectWebhook = vi.hoisted(() =>
  vi.fn(async (_req: Request, _ctx: unknown) => new Response(JSON.stringify({ ok: true, result: "ignored" }), { status: 200 }))
);

vi.mock("next/headers", () => ({ headers: () => new Headers({ "x-forwarded-for": "203.0.113.7" }) }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: async () => ({ ok: true, remaining: 59, retryAfterMs: 0 }) }));
vi.mock("@/lib/mercadopago", async (orig) => ({
  ...(await orig<typeof import("@/lib/mercadopago")>()),
  consumeWebhook,
}));
vi.mock("@/lib/mp-connect/webhook-route", () => ({ handleConnectWebhook }));

import { POST } from "@/app/api/webhooks/mercadopago/route";

/** El tope del brief (64 KiB). La ruta no lo exporta: un `route.ts` de Next solo puede exportar handlers y config. */
const MP_WEBHOOK_MAX_BYTES = 64 * 1024;

const BASE = "http://localhost/api/webhooks/mercadopago";

/** Cuerpo en stream (sin Content-Length, como un POST chunked) que cuenta cuántas veces se le pidió un chunk. */
function chunkedBody(totalBytes: number, chunkBytes = 8192) {
  let sent = 0;
  const stats = { pulls: 0 };
  const stream = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      stats.pulls += 1;
      if (sent >= totalBytes) return ctrl.close();
      const n = Math.min(chunkBytes, totalBytes - sent);
      sent += n;
      ctrl.enqueue(new Uint8Array(n).fill(0x20)); // espacios: JSON válido si se pegara a algo
    },
  });
  return { stream, stats };
}

function post(url: string, body: BodyInit | null, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);
}

beforeEach(() => {
  consumeWebhook.mockClear();
  handleConnectWebhook.mockClear();
});

describe("[HD-4] tope del cuerpo del webhook de MP", () => {
  it("[HD-4] Content-Length de más sin query → 413 sin leer el cuerpo ni consumir", async () => {
    // El cuerpo es un JSON válido con data.id: antes se leía entero y se consumía el pago.
    const pad = "x".repeat(MP_WEBHOOK_MAX_BYTES + 10);
    const body = JSON.stringify({ type: "payment", data: { id: "123" }, pad });
    const res = await POST(post(BASE, body, { "content-length": String(Buffer.byteLength(body)) }));
    expect(res.status).toBe(413);
    expect(consumeWebhook).not.toHaveBeenCalled();
  });

  it("[HD-4] chunked (sin Content-Length) que se pasa del tope → 413 y deja de leer", async () => {
    const { stream, stats } = chunkedBody(MP_WEBHOOK_MAX_BYTES * 4);
    const res = await POST(post(BASE, stream));
    expect(res.status).toBe(413);
    expect(consumeWebhook).not.toHaveBeenCalled();
    // Cortó apenas pasó el tope: no drenó los 256 KiB (32 chunks de 8 KiB).
    expect(stats.pulls).toBeLessThan(16);
  });

  it("chico sin query con data.id en el cuerpo → igual que antes (consume con el id del cuerpo)", async () => {
    const res = await POST(post(BASE, JSON.stringify({ type: "payment", data: { id: 4567 } })));
    expect(res.status).toBe(200);
    expect(consumeWebhook).toHaveBeenCalledTimes(1);
    expect(consumeWebhook).toHaveBeenCalledWith("4567");
    expect(await res.json()).toEqual({ ok: true, id: "4567" });
  });

  it("chico sin query con `id` suelto (IPN viejo) → mismo fallback `b?.id`", async () => {
    const res = await POST(post(BASE, JSON.stringify({ id: "889", type: "payment" })));
    expect(res.status).toBe(200);
    expect(consumeWebhook).toHaveBeenCalledWith("889");
  });

  it("type del cuerpo ≠ payment → 200 ignorado, sin consumir", async () => {
    const res = await POST(post(BASE, JSON.stringify({ type: "merchant_order", data: { id: "1" } })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: "merchant_order" });
    expect(consumeWebhook).not.toHaveBeenCalled();
  });

  it("cuerpo que no es JSON y sin query → 400 missing dataId (parse fallido = null, como antes)", async () => {
    const res = await POST(post(BASE, "no soy json"));
    expect(res.status).toBe(400);
    expect(consumeWebhook).not.toHaveBeenCalled();
  });

  it("sin cuerpo y sin query → 400 missing dataId", async () => {
    const res = await POST(new Request(BASE, { method: "POST" }));
    expect(res.status).toBe(400);
  });

  it("con data.id y type en la query → el cuerpo no se lee (ni siquiera uno gigante)", async () => {
    const { stream, stats } = chunkedBody(MP_WEBHOOK_MAX_BYTES * 4);
    const req = post(`${BASE}?data.id=777&type=payment`, stream);
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(consumeWebhook).toHaveBeenCalledWith("777");
    expect(req.bodyUsed).toBe(false);
    // El stream puede haber pedido UN chunk al construirse (high-water mark), nunca drenarse.
    expect(stats.pulls).toBeLessThanOrEqual(1);
  });

  it("[HD-4] query con data.id pero sin type → lee el cuerpo UNA vez (no dos clones) y toma type de ahí", async () => {
    const req = post(`${BASE}?data.id=31`, JSON.stringify({ type: "payment" }));
    const clone = vi.spyOn(req, "clone");
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(consumeWebhook).toHaveBeenCalledWith("31");
    expect(clone).not.toHaveBeenCalled();
  });

  it("rama ?acct= recibe dataId/type del cuerpo cuando faltan en la query (los sub-handlers solo leen headers)", async () => {
    const res = await POST(post(`${BASE}?acct=AAAAAAAAAAAAAAAAAAAAAA`, JSON.stringify({ type: "payment", data: { id: 55 } })));
    expect(res.status).toBe(200);
    expect(handleConnectWebhook).toHaveBeenCalledTimes(1);
    expect(handleConnectWebhook.mock.calls[0][1]).toMatchObject({ acct: "AAAAAAAAAAAAAAAAAAAAAA", dataId: "55", type: "payment" });
  });
});
