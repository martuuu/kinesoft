/**
 * [MPS-1b] Puerto de la suscripción SaaS (`lib/mercadopago-saas.ts`, C-MPS3) contra el Mercado Pago FALSO extendido a
 * preapprovals (`lib/mp-connect/fake-mp-saas.ts` + hooks en `fake-mp.ts`, C-MPS4).
 *
 * Se prueba el símbolo real (el puerto, `fakeMpHandle`, la ruta del fake, `simulateFakeDebit`); lo único reemplazado es la
 * red (`globalThis.fetch`, vía `installSaasFakeMp`). Lo que importa afirmar:
 *   - el ciclo del débito: pending (sin tarjeta) → authorized por la página del simulador; cancelled es terminal;
 *   - las notificaciones de la plataforma salen FIRMADAS con `MP_WEBHOOK_SECRET` (no con el de la cuenta del vendedor) y
 *     las verifica `verifyMpSignature` con ese secreto;
 *   - el fake no existe con `VERCEL_ENV` seteado (404 / no habilitado);
 *   - el puerto NUNCA tira (red caída, timeout, HTML, 500, modo apagado): devuelve `{ ok: false, kind }`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyMpSignature } from "@/lib/mp-connect/signature";
import { mpFetch } from "@/lib/mp-connect/http";
import { fakeMpGetPreference, fakeMpHandle, simulateFakePayment } from "@/lib/mp-connect/fake-mp";
import { GET as routeGET } from "@/app/api/mp/fake/[...path]/route";
import {
  createChargeCheckout,
  createPreapproval,
  expireCheckout,
  getAuthorizedPayment,
  getPreapproval,
  getSaasPayment,
  platformCollectorId,
  saasMpEnabled,
  updatePreapproval,
} from "@/lib/mercadopago-saas";
import {
  FAKE_MP_PLATFORM,
  FAKE_SAAS_HOOK_SECRET,
  authorizeFakePreapproval,
  fakeMpGetPreapproval,
  installSaasFakeMp,
  simulateFakeDebit,
  walkFakeSubscriptionCheckout,
  type InstalledSaasFakeMp,
} from "../helpers/mp-saas-fake";
import { FAKE_HOOK_SECRET } from "../helpers/mp-connect-fake";

const APP = "http://localhost:3000";
const FAKE = `${APP}/api/mp/fake`;
const DAY = 86_400_000;

let fake: InstalledSaasFakeMp;
beforeEach(() => {
  fake = installSaasFakeMp();
});
afterEach(() => {
  fake.uninstall();
  vi.useRealTimers();
});

function preapprovalInput(o: Partial<Parameters<typeof createPreapproval>[0]> = {}): Parameters<typeof createPreapproval>[0] {
  return {
    reason: "KineSoft · plan Consultorio",
    externalReference: "saas:tenant-1",
    payerEmail: "titular@consultorio.test",
    amountCents: 2_500_000,
    startDate: new Date(Date.now() + 10 * DAY),
    backUrl: `${APP}/configuracion?tab=plan`,
    idempotencyKey: `idem-${Math.random()}`,
    ...o,
  };
}

/** El hook firmado tiene que verificar con el secreto de la PLATAFORMA y no con el de la cuenta del vendedor. */
function expectSignedByPlatform(h: { url: string; headers: Record<string, string> }) {
  const dataId = new URL(h.url).searchParams.get("data.id");
  const args = { signature: h.headers["x-signature"] ?? null, requestId: h.headers["x-request-id"] ?? null, dataId };
  expect(verifyMpSignature({ ...args, secret: FAKE_SAAS_HOOK_SECRET })).toEqual({ ok: true });
  expect(verifyMpSignature({ ...args, secret: FAKE_HOOK_SECRET })).toEqual({ ok: false, reason: "mismatch" });
}

describe("[MPS-1b] preapproval: pending → authorized, cancelled terminal", () => {
  it("[MPS-1b] createPreapproval nace pending sin tarjeta; la página del simulador lo autoriza y avisa firmado", async () => {
    expect(saasMpEnabled()).toBe(true);
    const r = await createPreapproval(preapprovalInput());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.status).toBe("pending");
    expect(r.data.collectorId).toBe(FAKE_MP_PLATFORM.userId);
    expect(r.data.amountCents).toBe(2_500_000);
    expect(r.data.externalReference).toBe("saas:tenant-1");
    expect(r.data.initPoint).toBe(`${FAKE}/subscriptions/checkout?preapproval_id=${r.data.id}`);
    // Lo que recibió el fake: mensual, ARS, pending, sin `card_token_id` ni `billing_day` (MPS-D23).
    const rec = fakeMpGetPreapproval(r.data.id)!;
    expect(rec.body.card_token_id).toBeUndefined();
    expect(rec.body.status).toBe("pending");
    expect(rec.body.auto_recurring).toMatchObject({ frequency: 1, frequency_type: "months", currency_id: "ARS", transaction_amount: 25000 });
    expect((rec.body.auto_recurring as Record<string, unknown>).billing_day).toBeUndefined();
    expect(String((rec.body.auto_recurring as Record<string, unknown>).start_date)).toMatch(/-03:00$/);

    // La página: los dos botones literales de C-MPS4.
    const { page, decision } = await walkFakeSubscriptionCheckout(r.data.initPoint!, "authorize");
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain("Simulador de Mercado Pago (solo desarrollo)");
    expect(html).toContain("Autorizar débito (tarjeta de prueba)");
    expect(html).toContain("Cancelar y volver");
    expect(decision.status).toBe(303);
    const loc = new URL(decision.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe(`${APP}/configuracion`);
    expect(loc.searchParams.get("preapproval_id")).toBe(r.data.id);

    const g = await getPreapproval(r.data.id);
    expect(g.ok && g.data.status).toBe("authorized");

    expect(fake.hooks).toHaveLength(1);
    const h = fake.hooks[0];
    const u = new URL(h.url);
    expect(u.origin + u.pathname).toBe(`${APP}/api/webhooks/mercadopago`);
    expect(u.searchParams.get("type")).toBe("subscription_preapproval");
    expect(u.searchParams.get("data.id")).toBe(r.data.id);
    expect(h.body).toMatchObject({ type: "subscription_preapproval", entity: "preapproval", data: { id: r.data.id } });
    expectSignedByPlatform(h);
  });

  it("[MPS-1b] «Cancelar y volver» vuelve al back_url y el preapproval sigue pending (sin aviso)", async () => {
    const r = await createPreapproval(preapprovalInput());
    if (!r.ok) throw new Error("create");
    const { decision } = await walkFakeSubscriptionCheckout(r.data.initPoint!, "cancel");
    expect(decision.status).toBe(303);
    expect(decision.headers.get("location")).toContain(`${APP}/configuracion`);
    expect(fakeMpGetPreapproval(r.data.id)!.status).toBe("pending");
    expect(fake.hooks).toHaveLength(0);
  });

  it("[MPS-1b] la misma X-Idempotency-Key devuelve el mismo preapproval", async () => {
    const input = preapprovalInput({ idempotencyKey: "una-sola-vez" });
    const a = await createPreapproval(input);
    const b = await createPreapproval(input);
    expect(a.ok && b.ok && a.data.id === b.data.id).toBe(true);
  });

  it("[MPS-1b] el fake valida auto_recurring mensual en ARS, start_date futuro y billing_day 1..28", async () => {
    const token = FAKE_MP_PLATFORM.accessToken;
    const ok = {
      reason: "x",
      payer_email: "a@b.test",
      back_url: `${APP}/configuracion`,
      external_reference: "saas:t",
      status: "pending",
      auto_recurring: { frequency: 1, frequency_type: "months", transaction_amount: 100, currency_id: "ARS", start_date: new Date(Date.now() + DAY).toISOString() },
    };
    const post = (body: unknown) => mpFetch("/preapproval", { token, method: "POST", body, apiBase: FAKE });
    expect((await post(ok)).ok).toBe(true);
    for (const bad of [
      { frequency_type: "days" },
      { frequency: 2 },
      { currency_id: "USD" },
      { transaction_amount: 0 },
      { start_date: new Date(Date.now() - DAY).toISOString() },
      { billing_day: 29 },
      { billing_day: 0 },
    ]) {
      const r = await post({ ...ok, auto_recurring: { ...ok.auto_recurring, ...bad } });
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      expect(!r.ok && r.status).toBe(400);
    }
    expect((await post({ ...ok, auto_recurring: { ...ok.auto_recurring, billing_day: 4 } })).ok).toBe(true);
    // Sin token de la plataforma: 401 (un vendedor no puede leer preapprovals de la plataforma, ni al revés).
    const anon = await mpFetch("/preapproval", { method: "POST", body: ok, apiBase: FAKE });
    expect(!anon.ok && anon.status).toBe(401);
  });

  it("[MPS-1b] updatePreapproval: paused ↔ authorized y monto; cancelled es terminal", async () => {
    const r = await createPreapproval(preapprovalInput());
    if (!r.ok) throw new Error("create");
    // pending no se autoriza por API: solo con la tarjeta, en la página.
    const forced = await updatePreapproval(r.data.id, { status: "authorized" });
    expect(!forced.ok && forced.kind === "http" && forced.status).toBe(400);
    await authorizeFakePreapproval(r.data.id);

    const p = await updatePreapproval(r.data.id, { status: "paused", amountCents: 1_500 });
    expect(p.ok && p.data.status).toBe("paused");
    expect(p.ok && p.data.amountCents).toBe(1_500);
    const back = await updatePreapproval(r.data.id, { status: "authorized" });
    expect(back.ok && back.data.status).toBe("authorized");

    const c = await updatePreapproval(r.data.id, { status: "cancelled" });
    expect(c.ok && c.data.status).toBe("cancelled");
    for (const patch of [{ status: "authorized" as const }, { status: "paused" as const }, { amountCents: 2_000 }]) {
      const again = await updatePreapproval(r.data.id, patch);
      expect(!again.ok && again.kind === "http" && again.status).toBe(400);
    }
    expect((await getPreapproval(r.data.id)).ok && fakeMpGetPreapproval(r.data.id)!.status).toBe("cancelled");
    await expect(simulateFakeDebit({ preapprovalId: r.data.id, outcome: "approved" })).rejects.toThrow(/not_authorized/);
  });
});

describe("[MPS-1b] débitos simulados y pagos de la plataforma", () => {
  async function authorized(): Promise<string> {
    const r = await createPreapproval(preapprovalInput());
    if (!r.ok) throw new Error("create");
    await authorizeFakePreapproval(r.data.id);
    fake.hooks.length = 0;
    return r.data.id;
  }

  it("[MPS-1b] débito aprobado: aviso de authorized_payment firmado; el puerto lee el débito y el pago", async () => {
    const pre = await authorized();
    const d = await simulateFakeDebit({ preapprovalId: pre, outcome: "approved", alsoPaymentTopic: true });
    expect(d.webhookStatus).toBe(200);
    expect(fake.hooks.map((h) => new URL(h.url).searchParams.get("type"))).toEqual(["subscription_authorized_payment", "payment"]);
    expect(new URL(fake.hooks[0].url).searchParams.get("data.id")).toBe(d.authorizedPaymentId);
    // El de `payment` va a la URL de la app SIN `scope`: así llega de MP (webhook de la aplicación) y lo rutea el
    // camino legado por la referencia `saas:` (C-MPS6).
    const payHook = new URL(fake.hooks[1].url);
    expect(payHook.searchParams.get("data.id")).toBe(d.paymentId);
    expect(payHook.searchParams.get("scope")).toBeNull();
    for (const h of fake.hooks) expectSignedByPlatform(h);

    const ap = await getAuthorizedPayment(d.authorizedPaymentId);
    expect(ap.ok).toBe(true);
    if (!ap.ok) return;
    expect(ap.data).toMatchObject({ id: d.authorizedPaymentId, preapprovalId: pre, status: "processed", amountCents: 2_500_000 });
    expect(ap.data.payment).toEqual({ id: d.paymentId, status: "approved" });
    expect(ap.data.debitDate).toBeInstanceOf(Date);

    const pay = await getSaasPayment(d.paymentId!);
    expect(pay.ok).toBe(true);
    if (!pay.ok) return;
    expect(pay.data).toMatchObject({
      id: d.paymentId,
      status: "approved",
      amountCents: 2_500_000,
      collectorId: FAKE_MP_PLATFORM.userId,
      externalReference: "saas:tenant-1",
      preapprovalId: pre,
      currencyId: "ARS",
    });
    expect(pay.data.approvedAt).toBeInstanceOf(Date);
  });

  it("[MPS-1b] rechazado → reintento aprobado (mismo débito, pago nuevo) → reintegro por el topic payment", async () => {
    const pre = await authorized();
    const rej = await simulateFakeDebit({ preapprovalId: pre, outcome: "rejected", amountCents: 1_500 });
    const a1 = await getAuthorizedPayment(rej.authorizedPaymentId);
    expect(a1.ok && a1.data.status).toBe("recycling");
    expect(a1.ok && a1.data.payment?.status).toBe("rejected");
    expect(a1.ok && a1.data.amountCents).toBe(1_500);

    const retry = await simulateFakeDebit({ preapprovalId: pre, outcome: "retry_approved" });
    expect(retry.authorizedPaymentId).toBe(rej.authorizedPaymentId);
    expect(retry.paymentId).not.toBe(rej.paymentId);
    const a2 = await getAuthorizedPayment(retry.authorizedPaymentId);
    expect(a2.ok && a2.data.status).toBe("processed");
    expect(a2.ok && a2.data.payment).toEqual({ id: retry.paymentId, status: "approved" });

    fake.hooks.length = 0;
    const ref = await simulateFakeDebit({ preapprovalId: pre, outcome: "refunded" });
    expect(ref.paymentId).toBe(retry.paymentId);
    expect(fake.hooks.map((h) => new URL(h.url).searchParams.get("type"))).toEqual(["payment"]);
    const pay = await getSaasPayment(retry.paymentId!);
    expect(pay.ok && pay.data.status).toBe("refunded");
    // Sin un reintento pendiente no hay «reintento aprobado».
    await expect(simulateFakeDebit({ preapprovalId: pre, outcome: "retry_approved" })).rejects.toThrow(/nothing_to_retry/);
  });

  it("[MPS-1b] «cancelar desde Mercado Pago» del panel: cancelled + aviso de preapproval", async () => {
    const pre = await authorized();
    const panel = await fakeMpHandle(new Request(`${FAKE}/panel`));
    const html = await panel.text();
    expect(html).toContain("Suscripciones");
    expect(html).toContain("Simular débito aprobado");
    expect(html).toContain("Simular débito rechazado");
    expect(html).toContain("Cancelar desde Mercado Pago");
    const res = await fakeMpHandle(
      new Request(`${FAKE}/panel/suscripciones`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ preapproval_id: pre, action: "cancel" }).toString(),
      })
    );
    expect(res.status).toBe(303);
    expect(fakeMpGetPreapproval(pre)!.status).toBe("cancelled");
    expect(new URL(fake.hooks[0].url).searchParams.get("type")).toBe("subscription_preapproval");
    expectSignedByPlatform(fake.hooks[0]);
  });

  it("[MPS-1b] createChargeCheckout: binary_mode, 72 h, ref saas:t:c, ?scope=saas; el pago avisa firmado por la plataforma", async () => {
    const before = Date.now();
    const r = await createChargeCheckout({
      tenantId: "tenant-1",
      chargeId: "charge-9",
      title: "KineSoft · cargo de noviembre",
      amountCents: 2_500_050,
      payerEmail: "titular@consultorio.test",
      idempotencyKey: "chk-1",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.initPoint).toBe(`${FAKE}/checkout/${encodeURIComponent(r.data.preferenceId)}`);
    const pref = fakeMpGetPreference(r.data.preferenceId)!;
    expect(pref.collectorId).toBe(FAKE_MP_PLATFORM.userId);
    expect(pref.amountCents).toBe(2_500_050);
    expect(pref.binary).toBe(true);
    expect(pref.externalReference).toBe("saas:tenant-1:charge-9");
    expect(pref.notificationUrl).toBe(`${APP}/api/webhooks/mercadopago?scope=saas`);
    const exp = Date.parse(String(pref.body.expiration_date_to));
    expect(exp - before).toBeGreaterThanOrEqual(72 * 3600_000 - 1000);
    expect(exp - Date.now()).toBeLessThanOrEqual(72 * 3600_000 + 1000);
    expect(r.data.expiresAt.getTime()).toBe(exp);

    const paid = await simulateFakePayment({ preferenceId: r.data.preferenceId, outcome: "approved" });
    const u = new URL(fake.hooks[0].url);
    expect(u.searchParams.get("scope")).toBe("saas");
    expect(u.searchParams.get("data.id")).toBe(paid.paymentId);
    expect(u.searchParams.get("type")).toBe("payment");
    expectSignedByPlatform(fake.hooks[0]);
    const pay = await getSaasPayment(paid.paymentId);
    expect(pay.ok && pay.data).toMatchObject({ status: "approved", externalReference: "saas:tenant-1:charge-9", preapprovalId: null });

    expect((await expireCheckout(r.data.preferenceId)).ok).toBe(true);
    expect(fakeMpGetPreference(r.data.preferenceId)!.expired).toBe(true);
  });

  it("[MPS-1b] los links de pago de un vendedor siguen firmando con el secreto de la cuenta (T5 intacto)", async () => {
    const { fakeMpIssueTokens } = await import("@/lib/mp-connect/fake-mp");
    const seller = fakeMpIssueTokens(1);
    const created = await mpFetch("/checkout/preferences", {
      token: seller.accessToken,
      method: "POST",
      apiBase: FAKE,
      body: { items: [{ unit_price: 10, quantity: 1, currency_id: "ARS" }], notification_url: `${APP}/api/webhooks/mercadopago?acct=abc` },
    });
    if (!created.ok) throw new Error("pref");
    await simulateFakePayment({ preferenceId: (created.json as { id: string }).id, outcome: "approved" });
    const h = fake.hooks[0];
    const dataId = new URL(h.url).searchParams.get("data.id");
    expect(verifyMpSignature({ signature: h.headers["x-signature"], requestId: h.headers["x-request-id"], dataId, secret: FAKE_HOOK_SECRET })).toEqual({ ok: true });
  });

  it("[MPS-1b] platformCollectorId = el usuario falso de la plataforma, memorizado", async () => {
    const a = await platformCollectorId();
    expect(a).toEqual({ ok: true, data: FAKE_MP_PLATFORM.userId });
    const n = fake.calls.length;
    expect(await platformCollectorId()).toEqual({ ok: true, data: FAKE_MP_PLATFORM.userId });
    expect(fake.calls.length).toBe(n);
  });

  it("[MPS-1b] en modo fake NO viaja el MP_ACCESS_TOKEN de la plataforma", async () => {
    fake.uninstall();
    fake = installSaasFakeMp({ accessToken: "APP_USR-token-real-que-no-tiene-que-salir" });
    const seen: string[] = [];
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("authorization") ?? "");
      return inner(input, init);
    }) as typeof fetch;
    const r = await createPreapproval(preapprovalInput());
    expect(r.ok).toBe(true);
    expect(seen).toEqual([`Bearer ${FAKE_MP_PLATFORM.accessToken}`]);
  });
});

describe("[MPS-1b] barreras del fake", () => {
  it("[MPS-1b] con VERCEL_ENV seteado el fake da 404 y los simuladores no están habilitados", async () => {
    const r = await createPreapproval(preapprovalInput());
    if (!r.ok) throw new Error("create");
    process.env.VERCEL_ENV = "preview";
    try {
      expect((await fakeMpHandle(new Request(`${FAKE}/preapproval/${r.data.id}`))).status).toBe(404);
      expect((await fakeMpHandle(new Request(`${FAKE}/subscriptions/checkout?preapproval_id=${r.data.id}`))).status).toBe(404);
      expect((await routeGET(new Request(`${FAKE}/authorized_payments/1`))).status).toBe(404);
      await expect(authorizeFakePreapproval(r.data.id)).rejects.toThrow(/not_allowed/);
      await expect(simulateFakeDebit({ preapprovalId: r.data.id, outcome: "approved" })).rejects.toThrow(/not_allowed/);
      // El puerto sin fake y sin token de la plataforma está apagado: no sale a la red.
      const n = fake.calls.length;
      expect(saasMpEnabled()).toBe(false);
      expect(await getPreapproval(r.data.id)).toEqual({ ok: false, kind: "off" });
      expect(fake.calls.length).toBe(n);
    } finally {
      delete process.env.VERCEL_ENV;
    }
  });
});

describe("[MPS-1b] el puerto nunca tira", () => {
  it("[MPS-1b] modo off/manual → kind off sin tocar la red", async () => {
    for (const mode of ["manual", "off", undefined]) {
      if (mode === undefined) delete process.env.SAAS_BILLING_MODE;
      else process.env.SAAS_BILLING_MODE = mode;
      expect(saasMpEnabled()).toBe(false);
      expect(await createPreapproval(preapprovalInput())).toEqual({ ok: false, kind: "off" });
      expect(await getSaasPayment("123")).toEqual({ ok: false, kind: "off" });
    }
    expect(fake.calls).toEqual([]);
  });

  it("[MPS-1b] red caída, HTML, 500 e ids/entradas inválidas → { ok: false } sin excepción", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect(await getPreapproval("abc")).toEqual({ ok: false, kind: "network" });
    expect(await createChargeCheckout({ tenantId: "t", chargeId: "c", title: "x", amountCents: 100, payerEmail: "a@b.test", idempotencyKey: "k" })).toEqual({
      ok: false,
      kind: "network",
    });

    globalThis.fetch = (async () => new Response("<html>proxy</html>", { status: 200 })) as typeof fetch;
    expect(await getAuthorizedPayment("1")).toEqual({ ok: false, kind: "invalid" });
    globalThis.fetch = (async () => new Response(JSON.stringify({ id: 1 }), { status: 200 })) as typeof fetch;
    expect(await getSaasPayment("1")).toEqual({ ok: false, kind: "invalid" });
    globalThis.fetch = (async () => new Response("{}", { status: 500 })) as typeof fetch;
    expect(await updatePreapproval("abc", { status: "paused" })).toEqual({ ok: false, kind: "http", status: 500 });

    // Entradas inválidas: ni se llama a la red.
    globalThis.fetch = (async () => {
      throw new Error("no debería llamar");
    }) as typeof fetch;
    expect(await getPreapproval("../users/me")).toEqual({ ok: false, kind: "invalid" });
    expect(await createPreapproval(preapprovalInput({ amountCents: 0 }))).toEqual({ ok: false, kind: "invalid" });
    expect(await createPreapproval(preapprovalInput({ startDate: new Date("nope") }))).toEqual({ ok: false, kind: "invalid" });
    expect(await updatePreapproval("abc", {})).toEqual({ ok: false, kind: "invalid" });
  });

  it("[MPS-1b] un MP colgado corta por timeout", async () => {
    vi.useFakeTimers();
    globalThis.fetch = ((_: unknown, init?: RequestInit) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as typeof fetch;
    const p = getPreapproval("abc");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await p).toEqual({ ok: false, kind: "timeout" });
  });
});

describe("[MPS-1b] mpFetch con apiBase", () => {
  it("[MPS-1b] apiBase manda aunque MP_CONNECT_MODE esté off; sin apiBase, off sigue sin tocar la red", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    process.env.MP_CONNECT_MODE = "off";
    expect(await mpFetch("/x")).toEqual({ ok: false, kind: "network" });
    expect(urls).toEqual([]);
    expect((await mpFetch("/x", { apiBase: "https://api.example.test/" })).ok).toBe(true);
    expect(urls).toEqual(["https://api.example.test/x"]);
  });
});
