/**
 * [MPS-E] Diagnóstico de la suscripción SaaS con Mercado Pago (T6, brief §26.6; ADR-027): verifica, uno por uno, los
 * SUPUESTOS [S1]…[S10] que el puerto `lib/mercadopago-saas.ts`, la lógica `lib/saas-mp-logic.ts` y el MP FALSO
 * (`lib/mp-connect/fake-mp-saas.ts` + `fake-mp.ts`) hacen sobre preapprovals, débitos y el checkout de un cargo.
 * Molde: `scripts/diagnose-mp-connect.ts` (S1–S11 de T5) y `scripts/diagnose-whatsapp.ts` (S1–S13 de WA).
 *
 * Por qué: los tests de integración y el E2E (`tests/e2e/subscription.spec.ts`) corren contra el simulador. Si el
 * simulador supone algo que MP no hace (p. ej. que el débito del preapproval avisa por `subscription_authorized_payment`
 * con un id numérico, o que el pago trae el preapproval en `metadata`), todo da verde y prod no cobra. Este script
 * ejercita el MISMO puerto de la app contra:
 *   - el **simulador** (default, sin `--sandbox`): todo en el proceso, sin red, sin base y SIN leer `.env*` (los literales
 *     son los de `DEV_MPFAKE_LITERALS`). Es lo que corre CI y cualquier agente: prueba que el fake cumple el contrato;
 *   - el **sandbox real** (`--sandbox`, `SAAS_BILLING_MODE=mp`, token del VENDEDOR de prueba como `MP_ACCESS_TOKEN`): LO
 *     CORRE SOLO MARTIN (§26.7 paso 5: «`manual` → sandbox S1-S10 → `mp`»), con usuarios de prueba vendedor/comprador AR
 *     y el webhook de la aplicación apuntando a staging o a un túnel. Nunca un agente (regla de T6: producción, MP real y
 *     sandbox, inadmisibles). Las variables las pone Martin en la línea de comando; el script no carga ningún `.env`.
 *
 * Supuestos (los nombres del plan §21.7: preapproval, autorización con tarjeta de prueba, webhook, primer cobro, cambio
 * de monto, pausa, cancelación, checkout aprobado y rechazado; el reintento del débito rechazado va en S7):
 *   [S1]  `POST /preapproval` SIN tarjeta y SIN `billing_day` (MPS-D23) crea uno `pending` con `init_point`; MP rechaza
 *         un `start_date` pasado; la misma `X-Idempotency-Key` devuelve el mismo preapproval.
 *   [S2]  `pending` no se autoriza por API (pide `card_token_id`); se autoriza en la página de MP con la tarjeta de
 *         prueba, vuelve al `back_url` con `?preapproval_id=` y queda `authorized` con el primer débito en `start_date`.
 *   [S3]  El aviso del preapproval llega al webhook de la APLICACIÓN (sin `?scope=`), `type=subscription_preapproval`,
 *         `data.id` = 32 hex en minúscula, firmado con `MP_WEBHOOK_SECRET` (no con el secreto de la app de OAuth).
 *   [S4]  El primer débito: `subscription_authorized_payment` con id numérico; `GET /authorized_payments/:id` trae el
 *         pago, y `GET /v1/payments/:id` (token de la plataforma) trae collector = plataforma, ARS, la referencia
 *         `saas:<tenant>` y el preapproval (en `metadata` o en `point_of_interaction`).
 *   [S5]  `PUT` del monto (`auto_recurring.transaction_amount`) cambia el próximo débito; el mínimo de MP es
 *         `MP_MIN_DEBIT_CENTS` (1500 = $15) y la lógica nunca pide menos.
 *   [S6]  `PUT status=paused` frena los débitos (MP no cobra un preapproval pausado) y `authorized` lo reanuda.
 *   [S7]  Un débito rechazado deja el authorized_payment en `recycling`; el reintento aprobado es el MISMO
 *         authorized_payment con un pago NUEVO; un reintegro avisa solo por `payment` y deja el pago `refunded`.
 *   [S8]  `cancelled` es TERMINAL (un PUT posterior → 400); cancelar desde la cuenta de MP avisa por
 *         `subscription_preapproval`.
 *   [S9]  El link de pago de un cargo (`createChargeCheckout`): `binary_mode`, sin efectivo, vence a las 72 h,
 *         `notification_url …?scope=saas` (MPS-D9), referencia `saas:<tenant>:<cargo>`; el pago aprobado avisa ahí
 *         firmado con `MP_WEBHOOK_SECRET`.
 *   [S10] Con `binary_mode` un pago que no se aprueba sale `rejected` (nunca `pending`), y una preferencia vencida
 *         (`expireCheckout`) ya no se puede pagar.
 *
 * Seguridad: imprime ✓/✗ y códigos. Nunca tokens, secretos, emails completos ni ids de pago reales.
 *
 * Uso:
 *   npm run diagnose:mp-subscriptions                       # simulador (default)
 *   # Sandbox (SOLO Martin, con el VENDEDOR de prueba como plataforma y el webhook de la aplicación en staging/túnel):
 *   #   SAAS_BILLING_MODE=mp MP_CONNECT_MODE=off MP_ACCESS_TOKEN=<token del vendedor de prueba> \
 *   #   NEXT_PUBLIC_APP_URL=https://<staging o túnel> \
 *   #     npx tsx --conditions=react-server scripts/diagnose-mp-subscriptions.ts --sandbox --test-user-token \
 *   #       --payer-email <comprador de prueba>
 *   #   → S1 automático e imprime el init_point: autorizá con el COMPRADOR de prueba y la tarjeta de prueba. Después:
 *   #     … --sandbox --test-user-token --preapproval <id>            → S2, S5, S6 automáticos (S6 pausa y reanuda)
 *   #     … --sandbox --test-user-token --preapproval <id> --cancel   → S8 (cancela de verdad: al final)
 *   #   S3, S4, S7, S9 y S10 se miran en el log del webhook (instrucciones al final).
 * Sale con código 1 si algún supuesto automático da ✗.
 */
import { randomUUID } from "node:crypto";

const NAME = "diagnose-mp-subscriptions";
type Check = { id: string; desc: string; pass: boolean | null; detail: string };
const results: Check[] = [];

function check(id: string, desc: string, pass: boolean | null, detail = "") {
  results.push({ id, desc, pass, detail });
  const mark = pass === null ? "·" : pass ? "✓" : "✗";
  console.log(`${mark}  ${id.padEnd(5)} ${desc}${detail ? `  (${detail})` : ""}`);
}

function argValue(name: string): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === `--${name}`) return argv[i + 1];
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return undefined;
}
const hasFlag = (name: string) => process.argv.slice(2).includes(`--${name}`);

/** Corre un paso sin dejar que una excepción corte los demás (el mensaje nunca trae tokens: son errores propios). */
async function step(id: string, desc: string, fn: () => Promise<{ pass: boolean; detail?: string }>) {
  try {
    const r = await fn();
    check(id, desc, r.pass, r.detail ?? "");
  } catch (err) {
    check(id, desc, false, `excepción ${err instanceof Error ? `${err.name}${"code" in err ? `:${String(err.code)}` : ""}` : "desconocida"}`);
  }
}

type PortErr = { ok: false; kind: string; status?: number };
const errDetail = (r: { ok: true } | PortErr) => (r.ok ? "ok" : `${r.kind}${r.status ? `/${r.status}` : ""}`);

/** Tenant y cargo de mentira con la forma de los reales (cuid): la referencia `saas:` valida `[A-Za-z0-9_-]`. */
const DIAG_TENANT = "diagtenant000000000000000";
const DIAG_CHARGE = "diagcharge000000000000000";
const BASE_CENTS = 20_000_00;

// ── Simulador ───────────────────────────────────────────────────────────────────────────────────────────────────

async function runFake(): Promise<void> {
  const { DEV_MPFAKE_LITERALS: L } = await import("./lib/dev-mp-fake-env.mjs");
  const APP = "http://localhost:3000";
  // Entorno ANTES de importar la app: el modo y la URL se leen en cada llamada, pero `env` se congela al importar.
  process.env.MP_CONNECT_MODE = "fake";
  process.env.SAAS_BILLING_MODE = "mp";
  process.env.SAAS_MP_CHECKOUT_NOTIFY = "scope";
  delete process.env.MP_MIN_DEBIT_CENTS;
  delete process.env.VERCEL_ENV;
  delete process.env.VERCEL;
  process.env.NEXT_PUBLIC_APP_URL = APP;
  process.env.MP_ACCESS_TOKEN = L.MP_ACCESS_TOKEN;
  process.env.MP_WEBHOOK_SECRET = L.MP_WEBHOOK_SECRET;
  process.env.MP_CONNECT_WEBHOOK_SECRET = L.MP_CONNECT_WEBHOOK_SECRET;
  process.env.MP_OAUTH_CLIENT_ID = L.MP_OAUTH_CLIENT_ID;
  process.env.MP_OAUTH_CLIENT_SECRET = L.MP_OAUTH_CLIENT_SECRET;

  const fakeMp = await import("../lib/mp-connect/fake-mp");
  const fakeSaas = await import("../lib/mp-connect/fake-mp-saas");
  const port = await import("../lib/mercadopago-saas");
  const logic = await import("../lib/saas-mp-logic");
  const { nextAnchorKey } = await import("../lib/saas-billing-logic");
  const { toARDateKey } = await import("../lib/datetime-ar");
  const { verifyMpSignature } = await import("../lib/mp-connect/signature");
  const { isSaasTopic } = await import("../lib/saas-mp-webhook-route");
  const { MP_FAKE_PATH } = await import("../lib/mp-connect/constants");
  fakeMp.resetFakeMp();
  port.__resetSaasMpMemoForTests();

  // Red en el proceso: lo que va al simulador lo atiende `fakeMpHandle` (el MISMO router que monta la app); el webhook
  // lo recibe este script y verifica la firma con el MISMO verificador que la rama SaaS de la ruta (C-MPS6), con el
  // secreto de la plataforma Y con el de la app de OAuth (tiene que valer solo el primero). Otro host tira.
  const fakeBase = `${APP}${MP_FAKE_PATH}`;
  type Hook = { url: URL; platformOk: boolean; connectOk: boolean; body: Record<string, unknown> };
  const hooks: Hook[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(fakeBase)) return fakeMp.fakeMpHandle(input instanceof Request && !init ? input : new Request(url, init));
    if (url.startsWith(`${APP}/api/webhooks/mercadopago`)) {
      const u = new URL(url);
      const h = new Headers(init?.headers);
      const sig = { signature: h.get("x-signature"), requestId: h.get("x-request-id"), dataId: u.searchParams.get("data.id") };
      hooks.push({
        url: u,
        platformOk: verifyMpSignature({ ...sig, secret: L.MP_WEBHOOK_SECRET }).ok,
        connectOk: verifyMpSignature({ ...sig, secret: L.MP_CONNECT_WEBHOOK_SECRET }).ok,
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ ok: true, result: "applied" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error("red real bloqueada");
  }) as typeof fetch;
  const lastHook = () => hooks[hooks.length - 1];

  const now = new Date();
  const startDate = new Date(logic.debitStartInstant(now, nextAnchorKey(toARDateKey(now))));
  const preInput = {
    reason: "Suscripción de diagnóstico",
    externalReference: logic.saasExternalReference(DIAG_TENANT),
    payerEmail: "comprador-diag@example.com",
    amountCents: BASE_CENTS,
    startDate,
    backUrl: `${APP}/configuracion?tab=facturacion&debito=1`,
  };

  let preId = "";
  await step("S1", "POST /preapproval sin tarjeta ni billing_day → pending con init_point; start_date pasado → 400; idempotente", async () => {
    const idem = randomUUID();
    const r = await port.createPreapproval({ ...preInput, idempotencyKey: idem });
    if (!r.ok) return { pass: false, detail: errDetail(r) };
    preId = r.data.id;
    const again = await port.createPreapproval({ ...preInput, idempotencyKey: idem });
    const past = await port.createPreapproval({ ...preInput, startDate: new Date(now.getTime() - 60_000), idempotencyKey: randomUUID() });
    const sent = fakeSaas.fakeMpGetPreapproval(preId)?.body ?? {};
    const ar = (sent.auto_recurring ?? {}) as Record<string, unknown>;
    const pass =
      r.data.status === "pending" &&
      !!r.data.initPoint &&
      /^[0-9a-f]{32}$/.test(preId) &&
      again.ok &&
      again.data.id === preId &&
      !past.ok &&
      past.kind === "http" &&
      past.status === 400 &&
      !("card_token_id" in sent) &&
      !("billing_day" in ar) &&
      ar.frequency === 1 &&
      ar.frequency_type === "months" &&
      ar.currency_id === "ARS" &&
      typeof ar.start_date === "string" &&
      ar.start_date.endsWith("T08:00:00.000-03:00");
    return { pass, detail: `start_date ${String(ar.start_date ?? "—").slice(0, 10)} · pasado → ${errDetail(past)}` };
  });

  await step("S2", "pending no se autoriza por API; la página con tarjeta de prueba lo deja authorized y vuelve al back_url", async () => {
    const byApi = await port.updatePreapproval(preId, { status: "authorized" });
    const g = await port.getPreapproval(preId);
    if (!g.ok || !g.data.initPoint) return { pass: false, detail: errDetail(g) };
    const page = await fetch(g.data.initPoint);
    const html = await page.text();
    const action = new URL(g.data.initPoint);
    action.search = "";
    const decide = await fetch(action.toString(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ preapproval_id: preId, decision: "authorize" }).toString(),
    });
    const back = new URL(decide.headers.get("location") ?? "about:blank");
    const after = await port.getPreapproval(preId);
    const pass =
      !byApi.ok &&
      byApi.status === 400 &&
      page.status === 200 &&
      html.includes("Autorizar débito (tarjeta de prueba)") &&
      decide.status >= 300 &&
      decide.status < 400 &&
      back.searchParams.get("preapproval_id") === preId &&
      back.searchParams.get("debito") === "1" &&
      after.ok &&
      after.data.status === "authorized" &&
      after.data.nextPaymentDate?.getTime() === startDate.getTime();
    return { pass, detail: `por API → ${errDetail(byApi)} · página ${page.status} · vuelta ${decide.status}` };
  });

  await step("S3", "aviso del preapproval: sin ?scope, type subscription_preapproval, 32 hex, firmado con el secreto de la plataforma", async () => {
    const h = lastHook();
    if (!h) return { pass: false, detail: "no llegó ningún aviso" };
    const type = h.url.searchParams.get("type");
    const pass =
      !h.url.searchParams.has("scope") &&
      type === "subscription_preapproval" &&
      isSaasTopic(type) &&
      h.url.searchParams.get("data.id") === preId &&
      (h.body.data as { id?: unknown } | undefined)?.id === preId &&
      h.platformOk &&
      !h.connectOk;
    return { pass, detail: `firma plataforma ${h.platformOk ? "ok" : "NO"} · con el secreto de OAuth ${h.connectOk ? "VALIDA" : "no valida"}` };
  });

  let firstPaymentId = "";
  await step("S4", "primer débito: authorized_payment numérico con su pago; el pago es de la plataforma, ARS, saas:<tenant> y el preapproval", async () => {
    const before = hooks.length;
    const d = await fakeSaas.simulateFakeDebit({ preapprovalId: preId, outcome: "approved", alsoPaymentTopic: true });
    const mine = hooks.slice(before);
    const ap = await port.getAuthorizedPayment(d.authorizedPaymentId);
    if (!ap.ok || !ap.data.payment) return { pass: false, detail: errDetail(ap as PortErr) };
    firstPaymentId = ap.data.payment.id;
    const pay = await port.getSaasPayment(firstPaymentId);
    const collector = await port.platformCollectorId();
    if (!pay.ok || !collector.ok) return { pass: false, detail: `pago ${errDetail(pay as PortErr)} · collector ${errDetail(collector as PortErr)}` };
    const ref = logic.parseSaasExternalReference(pay.data.externalReference);
    const topics = mine.map((h) => h.url.searchParams.get("type"));
    const pass =
      /^[0-9]{1,20}$/.test(d.authorizedPaymentId) &&
      topics.includes("subscription_authorized_payment") &&
      topics.includes("payment") &&
      mine.every((h) => h.platformOk && !h.url.searchParams.has("scope")) &&
      ap.data.status === "processed" &&
      ap.data.preapprovalId === preId &&
      ap.data.amountCents === BASE_CENTS &&
      logic.mapMpPaymentStatus(pay.data.status) === "APPROVED" &&
      pay.data.collectorId === collector.data &&
      collector.data === fakeMp.FAKE_MP_PLATFORM.userId &&
      pay.data.currencyId === "ARS" &&
      pay.data.amountCents === BASE_CENTS &&
      pay.data.preapprovalId === preId &&
      ref?.tenantId === DIAG_TENANT &&
      ref.chargeId === null;
    return { pass, detail: `avisos ${topics.join("+")} · ${ap.data.status}` };
  });

  await step("S5", "PUT del monto cambia el próximo débito; la lógica nunca pide menos que el mínimo de MP", async () => {
    const amount = 25_000_00;
    const u = await port.updatePreapproval(preId, { amountCents: amount });
    const g = await port.getPreapproval(preId);
    const d = await fakeSaas.simulateFakeDebit({ preapprovalId: preId, outcome: "approved" });
    const ap = await port.getAuthorizedPayment(d.authorizedPaymentId);
    const zero = await port.updatePreapproval(preId, { amountCents: 0 });
    // Día fuera de la ventana del 3-4: la base; $ 5 → el mínimo (1500 centavos).
    const low = logic.desiredDebit({
      today: "2026-10-20",
      subscriptionStatus: "ACTIVE",
      collectionMethod: "AUTO_DEBIT",
      autoDebitAllowed: true,
      cancelAtPeriodEnd: false,
      nextBaseCents: 500,
      projectedCents: 500,
    });
    const pass =
      u.ok &&
      g.ok &&
      g.data.amountCents === amount &&
      ap.ok &&
      ap.data.amountCents === amount &&
      !zero.ok &&
      zero.kind === "invalid" &&
      logic.MP_MIN_DEBIT_CENTS === 1500 &&
      low.status === "authorized" &&
      low.amountCents === logic.MP_MIN_DEBIT_CENTS;
    return { pass, detail: `monto $0 → ${errDetail(zero)} (sin llamar a MP) · mínimo ${logic.MP_MIN_DEBIT_CENTS}` };
  });

  await step("S6", "paused frena los débitos y authorized lo reanuda", async () => {
    const p = await port.updatePreapproval(preId, { status: "paused" });
    let refused = false;
    try {
      await fakeSaas.simulateFakeDebit({ preapprovalId: preId, outcome: "approved" });
    } catch (e) {
      refused = e instanceof fakeSaas.FakeMpSaasError && e.code === "not_authorized";
    }
    const r = await port.updatePreapproval(preId, { status: "authorized" });
    const pass = p.ok && p.data.status === "paused" && refused && r.ok && r.data.status === "authorized";
    return { pass, detail: `pausado ${refused ? "no debita" : "DEBITA"}` };
  });

  await step("S7", "rechazado → recycling; el reintento es el mismo authorized_payment con un pago nuevo; reintegro solo por payment", async () => {
    const rej = await fakeSaas.simulateFakeDebit({ preapprovalId: preId, outcome: "rejected" });
    const apRej = await port.getAuthorizedPayment(rej.authorizedPaymentId);
    const payRej = rej.paymentId ? await port.getSaasPayment(rej.paymentId) : null;
    const retry = await fakeSaas.simulateFakeDebit({ preapprovalId: preId, outcome: "retry_approved" });
    const apOk = await port.getAuthorizedPayment(retry.authorizedPaymentId);
    const before = hooks.length;
    const ref = await fakeSaas.simulateFakeDebit({ preapprovalId: preId, outcome: "refunded" });
    const refundHooks = hooks.slice(before).map((h) => h.url.searchParams.get("type"));
    const payRef = ref.paymentId ? await port.getSaasPayment(ref.paymentId) : null;
    const pass =
      apRej.ok &&
      apRej.data.status === "recycling" &&
      !!payRej?.ok &&
      logic.mapMpPaymentStatus(payRej.data.status) === "REJECTED" &&
      retry.authorizedPaymentId === rej.authorizedPaymentId &&
      !!retry.paymentId &&
      retry.paymentId !== rej.paymentId &&
      apOk.ok &&
      apOk.data.status === "processed" &&
      apOk.data.payment?.id === retry.paymentId &&
      refundHooks.length === 1 &&
      refundHooks[0] === "payment" &&
      !!payRef?.ok &&
      logic.mapMpPaymentStatus(payRef.data.status) === "REFUNDED" &&
      payRef.data.refundedCents === payRef.data.amountCents;
    return { pass, detail: `reintento ${retry.authorizedPaymentId === rej.authorizedPaymentId ? "mismo" : "OTRO"} authorized_payment · reintegro avisa ${refundHooks.join("+") || "nada"}` };
  });

  await step("S8", "cancelled es terminal (PUT posterior → 400); cancelar desde MP avisa por subscription_preapproval", async () => {
    // Uno nuevo para la cancelación por API (el de S1 se cancela «desde MP»).
    const other = await port.createPreapproval({ ...preInput, idempotencyKey: randomUUID() });
    if (!other.ok) return { pass: false, detail: errDetail(other) };
    await fakeSaas.authorizeFakePreapproval(other.data.id);
    const c = await port.updatePreapproval(other.data.id, { status: "cancelled" });
    const again = await port.updatePreapproval(other.data.id, { status: "authorized" });
    const before = hooks.length;
    await fakeSaas.cancelFakePreapprovalFromMp(preId);
    const h = hooks.slice(before)[0];
    const g = await port.getPreapproval(preId);
    const pass =
      c.ok &&
      c.data.status === "cancelled" &&
      !again.ok &&
      again.status === 400 &&
      !!h &&
      h.url.searchParams.get("type") === "subscription_preapproval" &&
      h.url.searchParams.get("data.id") === preId &&
      h.platformOk &&
      g.ok &&
      g.data.status === "cancelled";
    return { pass, detail: `PUT tras cancelar → ${errDetail(again)}` };
  });

  let prefId = "";
  await step("S9", "link de pago del cargo: binary_mode, sin efectivo, 72 h, ?scope=saas, saas:<t>:<c>; el aprobado avisa ahí firmado", async () => {
    const r = await port.createChargeCheckout({
      tenantId: DIAG_TENANT,
      chargeId: DIAG_CHARGE,
      title: "Suscripción de diagnóstico · octubre",
      amountCents: BASE_CENTS,
      payerEmail: "comprador-diag@example.com",
      idempotencyKey: randomUUID(),
    });
    if (!r.ok) return { pass: false, detail: errDetail(r) };
    prefId = r.data.preferenceId;
    const pref = fakeMp.fakeMpGetPreference(prefId);
    const body = (pref?.body ?? {}) as Record<string, unknown>;
    const excluded = ((body.payment_methods as { excluded_payment_types?: { id: string }[] } | undefined)?.excluded_payment_types ?? []).map((x) => x.id);
    const notif = new URL(String(body.notification_url ?? "about:blank"));
    const ttlH = (r.data.expiresAt.getTime() - Date.now()) / 3_600_000;
    const before = hooks.length;
    const paid = await fakeMp.simulateFakePayment({ preferenceId: prefId, outcome: "approved" });
    const h = hooks.slice(before)[0];
    const pay = await port.getSaasPayment(paid.paymentId);
    const ref = pay.ok ? logic.parseSaasExternalReference(pay.data.externalReference) : null;
    const pass =
      body.binary_mode === true &&
      excluded.includes("ticket") &&
      excluded.includes("atm") &&
      ttlH > 71.9 &&
      ttlH <= 72 &&
      notif.pathname === "/api/webhooks/mercadopago" &&
      notif.searchParams.get("scope") === "saas" &&
      body.external_reference === logic.saasExternalReference(DIAG_TENANT, DIAG_CHARGE) &&
      !!h &&
      h.url.searchParams.get("scope") === "saas" &&
      h.url.searchParams.get("type") === "payment" &&
      h.platformOk &&
      !h.connectOk &&
      pay.ok &&
      logic.mapMpPaymentStatus(pay.data.status) === "APPROVED" &&
      pay.data.collectorId === fakeMp.FAKE_MP_PLATFORM.userId &&
      pay.data.preapprovalId === null &&
      ref?.tenantId === DIAG_TENANT &&
      ref.chargeId === DIAG_CHARGE;
    return { pass, detail: `vence en ${ttlH.toFixed(1)} h · aviso ${h ? `${h.url.searchParams.get("type")} scope=${h.url.searchParams.get("scope")}` : "no llegó"}` };
  });

  await step("S10", "binary_mode: lo que no se aprueba sale rejected (nunca pending); vencida no se paga", async () => {
    const r = await fakeMp.simulateFakePayment({ preferenceId: prefId, outcome: "pending" });
    const pay = await port.getSaasPayment(r.paymentId);
    const exp = await port.expireCheckout(prefId);
    let refused = false;
    try {
      await fakeMp.simulateFakePayment({ preferenceId: prefId, outcome: "approved" });
    } catch (e) {
      refused = e instanceof fakeMp.FakeMpError && e.code === "preference_expired";
    }
    const pass = pay.ok && pay.data.status === "rejected" && logic.mapMpPaymentStatus(pay.data.status) === "REJECTED" && exp.ok && refused;
    return { pass, detail: `«pendiente» → ${pay.ok ? pay.data.status : errDetail(pay)} · vencida ${refused ? "rechazada" : "PAGABLE"}` };
  });
}

// ── Sandbox (lo corre Martin) ───────────────────────────────────────────────────────────────────────────────────────

async function runSandbox(): Promise<number> {
  if (!hasFlag("sandbox") || (process.env.SAAS_BILLING_MODE ?? "").trim().toLowerCase() !== "mp") {
    console.error(`[${NAME}] El sandbox pide SAAS_BILLING_MODE=mp Y --sandbox (lo corre Martin, §26.7 paso 5).`);
    return 2;
  }
  if (process.env.VERCEL_ENV || process.env.VERCEL) {
    console.error(`[${NAME}] No corre dentro de Vercel.`);
    return 2;
  }
  if ((process.env.MP_CONNECT_MODE ?? "").trim().toLowerCase() === "fake") {
    console.error(`[${NAME}] Con MP_CONNECT_MODE=fake el puerto usa el simulador: para el sandbox, MP_CONNECT_MODE=off.`);
    return 2;
  }
  // El token de PRODUCCIÓN de la plataforma no sirve acá: tiene que ser el del vendedor de PRUEBA. MP no expone si un
  // token es de prueba, así que se pide confirmarlo en la línea de comando.
  if (!hasFlag("test-user-token")) {
    console.error(`[${NAME}] Confirmá que MP_ACCESS_TOKEN es del VENDEDOR DE PRUEBA con --test-user-token (nunca el de producción).`);
    return 2;
  }
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/+$/, "");
  if (!appUrl || /localhost|127\.0\.0\.1/.test(appUrl)) {
    console.error(`[${NAME}] NEXT_PUBLIC_APP_URL tiene que ser staging o el túnel (el back_url y la notification_url salen de ahí).`);
    return 2;
  }
  const port = await import("../lib/mercadopago-saas");
  const logic = await import("../lib/saas-mp-logic");
  const { nextAnchorKey } = await import("../lib/saas-billing-logic");
  const { toARDateKey } = await import("../lib/datetime-ar");

  const collector = await port.platformCollectorId();
  check("S0", "/users/me con el token de la plataforma (vendedor de prueba)", collector.ok, collector.ok ? "" : errDetail(collector));
  if (!collector.ok) return 1;

  const preId = argValue("preapproval");
  if (!preId) {
    const payerEmail = argValue("payer-email");
    if (!payerEmail) {
      console.error(`[${NAME}] Falta --payer-email <email del COMPRADOR de prueba>.`);
      return 2;
    }
    const now = new Date();
    const startDate = new Date(logic.debitStartInstant(now, nextAnchorKey(toARDateKey(now))));
    const r = await port.createPreapproval({
      reason: "Suscripción de diagnóstico (sandbox)",
      externalReference: logic.saasExternalReference(DIAG_TENANT),
      payerEmail,
      amountCents: 1500,
      startDate,
      backUrl: `${appUrl}/configuracion?tab=facturacion&debito=1`,
      idempotencyKey: randomUUID(),
    });
    check("S1", "POST /preapproval sin tarjeta ni billing_day → pending con init_point", r.ok && r.data.status === "pending" && !!r.data.initPoint, errDetail(r));
    if (!r.ok) return 1;
    const day = r.data.startDate ? toARDateKey(r.data.startDate).slice(8) : "—";
    check("S1b", "MP respeta el start_date del 4 sin billing_day (MPS-D23)", day === "04", `día ${day}`);
    console.log(`     Autorizá con el COMPRADOR de prueba y la tarjeta de prueba: ${r.data.initPoint}`);
    console.log(`     Después: … --sandbox --test-user-token --preapproval ${r.data.id}`);
    return results.some((x) => x.pass === false) ? 1 : 0;
  }

  const g = await port.getPreapproval(preId);
  check("S2", "el preapproval quedó authorized después de la página de MP", g.ok && g.data.status === "authorized", g.ok ? g.data.status : errDetail(g));
  if (!g.ok) return 1;
  check("S2b", "el preapproval es de la plataforma", g.data.collectorId === collector.data);

  if (hasFlag("cancel")) {
    const c = await port.updatePreapproval(preId, { status: "cancelled" });
    const again = await port.updatePreapproval(preId, { status: "authorized" });
    check("S8", "cancelled es terminal (PUT posterior rechazado)", c.ok && c.data.status === "cancelled" && !again.ok, `después → ${errDetail(again)}`);
    return results.some((x) => x.pass === false) ? 1 : 0;
  }

  const base = g.data.amountCents ?? 1500;
  const u = await port.updatePreapproval(preId, { amountCents: base + 100 });
  const u2 = u.ok ? await port.getPreapproval(preId) : null;
  check("S5", "PUT del monto se refleja en el preapproval", !!u2?.ok && u2.data.amountCents === base + 100, errDetail(u));
  const low = await port.updatePreapproval(preId, { amountCents: 100 });
  check("S5b", "MP rechaza un débito menor al mínimo (MP_MIN_DEBIT_CENTS)", !low.ok, low.ok ? "ACEPTÓ $1: revisar el mínimo" : errDetail(low));
  await port.updatePreapproval(preId, { amountCents: base });

  const p = await port.updatePreapproval(preId, { status: "paused" });
  const r = await port.updatePreapproval(preId, { status: "authorized" });
  check("S6", "pausar y reanudar por API", p.ok && p.data.status === "paused" && r.ok && r.data.status === "authorized", `${errDetail(p)} / ${errDetail(r)}`);

  const chargeId = `diag${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const co = await port.createChargeCheckout({
    tenantId: DIAG_TENANT,
    chargeId,
    title: "Suscripción de diagnóstico",
    amountCents: 1500,
    payerEmail: argValue("payer-email") ?? "",
    idempotencyKey: randomUUID(),
  });
  check("S9", "link de pago de un cargo con el token de la plataforma", co.ok, errDetail(co));
  if (co.ok) console.log(`     Pagá $15 con el COMPRADOR de prueba (aprobado y después uno rechazado): ${co.data.initPoint}`);

  check("S3", "aviso del preapproval firmado, sin ?scope, 32 hex", null, "manual: log saas_mp.webhook (firma ok, topic subscription_preapproval)");
  check("S4", "primer débito: authorized_payment numérico + pago con el preapproval", null, "manual: esperá el 4 (o el reintento) y mirá el log");
  check("S7", "rechazado → recycling; reintento = mismo authorized_payment", null, "manual: tarjeta de prueba con fondos insuficientes");
  check("S9b", "el pago del link avisa a ?scope=saas firmado", null, `manual: external_reference = saas:${DIAG_TENANT}:${chargeId}`);
  check("S10", "binary_mode: el rechazado sale rejected, nunca pending", null, "manual: pagá con la tarjeta de prueba que rechaza");
  check("S8", "cancelación terminal", null, "manual, al final: … --preapproval <id> --cancel");
  return results.some((x) => x.pass === false) ? 1 : 0;
}

async function main(): Promise<number> {
  if (hasFlag("sandbox")) return runSandbox();
  console.log(`[${NAME}] contra el MP FALSO (en el proceso; sin red, sin base, sin .env)`);
  await runFake();
  const failed = results.filter((r) => r.pass === false);
  console.log(`\n${results.length - failed.length}/${results.length} supuestos ✓${failed.length ? ` · ✗ ${failed.map((f) => f.id).join(", ")}` : ""}`);
  return failed.length ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`[${NAME}] error: ${err instanceof Error ? err.name : "desconocido"}`);
    process.exit(1);
  }
);
