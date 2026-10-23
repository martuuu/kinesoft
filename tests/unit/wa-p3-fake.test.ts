/**
 * [WA-P3] Meta falso (C-WA5) + cliente Graph real (C-WA4) contra él. Se prueba el símbolo real (`graph.ts`,
 * `fakeGraphHandle`, la ruta `app/api/whatsapp/fake/[...path]`); lo único reemplazado es la red (`installFakeGraph`
 * enruta `${APP_URL}/api/whatsapp/fake/*` al handler y captura el POST al webhook).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FAKE_WA,
  FAKE_WA_APP_URL,
  FAKE_WA_PHONES,
  approveFakeTemplates,
  fakeGraphAdvance,
  fakeGraphMessageByCallback,
  fakeGraphPartnerRemoved,
  fakeGraphQuality,
  fakeGraphSignup,
  fakeGraphWaba,
  installFakeGraph,
  pressButton,
  sendInbound,
  type InstalledFakeGraph,
} from "@/tests/helpers/whatsapp-fake";
import {
  createTemplate,
  debugToken,
  exchangeCode,
  getPhone,
  graphApiBase,
  graphFetch,
  listPhoneNumbers,
  listTemplates,
  registerPhone,
  sendTemplate,
  sendText,
  signupDialogTarget,
  subscribeApp,
  templateCreateComponents,
  templateSendComponents,
  unsubscribeApp,
  uploadMedia,
} from "@/lib/whatsapp/graph";
import { fakeGraphHandle, fakeGraphProvision } from "@/lib/whatsapp/fake-graph";
import { verifyMetaSignature } from "@/lib/whatsapp/crypto";
import { buildTemplateParams, TEMPLATE_SPECS, TEST_TEMPLATE } from "@/lib/whatsapp/templates";
import { buttonPayload } from "@/lib/whatsapp/logic";
import { GET as routeGET, POST as routePOST } from "@/app/api/whatsapp/fake/[...path]/route";

const FAKE = `${FAKE_WA_APP_URL}/api/whatsapp/fake`;
const PDF = new Uint8Array(Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n", "latin1"));

let fake: InstalledFakeGraph;
beforeEach(() => {
  fake = installFakeGraph();
});
afterEach(() => {
  fake.uninstall();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Recorre el popup como el navegador: GET de la página, POST de «Conectar», y saca el mensaje del `postMessage`. */
async function signupByPopup(grant = "both"): Promise<{ type: string; event: string; data: Record<string, string>; code: string }> {
  const target = signupDialogTarget();
  expect(target).toMatchObject({ mode: "fake", origin: "http://localhost:3000" });
  const dialogUrl = (target as { dialogUrl: string }).dialogUrl;
  const page = await fakeGraphHandle(new Request(`${dialogUrl}?app_id=${FAKE_WA.WHATSAPP_APP_ID}&config_id=${FAKE_WA.WHATSAPP_CONFIG_ID}`));
  expect(page.status).toBe(200);
  const htmlPage = await page.text();
  expect(htmlPage).toContain("Simulador de Meta (solo desarrollo)");
  expect(htmlPage).toContain("Conectar número de prueba");
  const res = await fakeGraphHandle(
    new Request(dialogUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ app_id: FAKE_WA.WHATSAPP_APP_ID, config_id: FAKE_WA.WHATSAPP_CONFIG_ID, grant, decision: "finish" }).toString(),
    })
  );
  const done = await res.text();
  // `postMessage(<string JSON>, "<origen de la app>")`: el mensaje solo le llega a la ventana de la app.
  const m = /var m=("(?:[^"\\]|\\.)*");var o="([^"]+)"/.exec(done);
  expect(m).not.toBeNull();
  expect(m![2]).toBe("http://localhost:3000");
  expect(done).toContain("window.opener.postMessage(m,o)");
  return JSON.parse(JSON.parse(m![1]));
}

describe("[WA-P3] guard del simulador", () => {
  it("[WA-P3] la ruta da 404 fuera de fake, en Vercel aunque diga fake, y responde en fake", async () => {
    const url = `${FAKE}/panel`;
    process.env.WHATSAPP_MODE = "off";
    expect((await routeGET(new Request(url))).status).toBe(404);
    process.env.WHATSAPP_MODE = "sandbox";
    expect((await routePOST(new Request(`${FAKE}/v23.0/123456/messages`, { method: "POST" }))).status).toBe(404);
    process.env.WHATSAPP_MODE = "fake";
    process.env.VERCEL = "1";
    expect((await routeGET(new Request(url))).status).toBe(404);
    // El handler también mira el guard (si alguien lo monta en otra ruta).
    expect((await fakeGraphHandle(new Request(url))).status).toBe(404);
    expect(() => fakeGraphSignup()).toThrow(/not_allowed/);
    delete process.env.VERCEL;
    const ok = await routeGET(new Request(url));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("Panel del simulador de Meta");
  });

  it("[WA-P3] con WHATSAPP_MODE=off, graph no llama a nadie", async () => {
    process.env.WHATSAPP_MODE = "off";
    expect(graphApiBase()).toBeNull();
    expect(signupDialogTarget()).toBeNull();
    const r = await graphFetch("/123456/phone_numbers", { token: "x" });
    expect(r).toMatchObject({ ok: false, kind: "off", errorCode: "mode_off", retryable: false });
    expect(fake.calls).toEqual([]);
  });

  it("[WA-P3] base por modo: fake → la app; sandbox/live → graph.facebook.com con la versión", async () => {
    expect(graphApiBase()).toBe(FAKE);
    process.env.WHATSAPP_MODE = "sandbox";
    expect(graphApiBase()).toBe("https://graph.facebook.com");
    const seen: string[] = [];
    globalThis.fetch = (async (u: string) => {
      seen.push(u);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }) as typeof fetch;
    expect((await subscribeApp("tok", "1234567890")).ok).toBe(true);
    expect(seen).toEqual(["https://graph.facebook.com/v23.0/1234567890/subscribed_apps"]);
    expect(signupDialogTarget()).toEqual({ mode: "meta", origin: "https://www.facebook.com" });
  });
});

describe("[WA-P3] alta por Embedded Signup contra el fake", () => {
  it("[WA-P3] popup → postMessage WA_EMBEDDED_SIGNUP FINISH {waba_id, phone_number_id} + code; canje; debug_token con los dos scopes", async () => {
    const msg = await signupByPopup();
    expect(msg.type).toBe("WA_EMBEDDED_SIGNUP");
    expect(msg.event).toBe("FINISH");
    expect(msg.data.waba_id).toMatch(/^[0-9]{5,25}$/);
    expect(msg.data.phone_number_id).toMatch(/^[0-9]{5,25}$/);
    expect(msg.code).toMatch(/^FAKEWA-CODE-/);

    const ex = await exchangeCode(msg.code);
    expect(ex.ok).toBe(true);
    const token = (ex as { data: { accessToken: string } }).data.accessToken;

    const info = await debugToken(token);
    if (!info.ok) throw new Error("debug_token falló");
    const d = info.data;
    expect(d.appId).toBe(FAKE_WA.WHATSAPP_APP_ID);
    expect(d.isValid).toBe(true);
    const byScope = Object.fromEntries(d.granularScopes.map((g) => [g.scope, g.targetIds]));
    expect(byScope.whatsapp_business_management).toEqual([msg.data.waba_id]);
    expect(byScope.whatsapp_business_messaging).toEqual([msg.data.waba_id]);

    const phones = await listPhoneNumbers(token, msg.data.waba_id);
    expect(phones.ok && phones.data.map((p) => p.id)).toEqual([msg.data.phone_number_id]);
    const phone = await getPhone(token, msg.data.phone_number_id);
    expect(phone.ok && phone.data.qualityRating).toBe("GREEN");
  });

  it("[WA-P3] el code es de un solo uso", async () => {
    const { code } = fakeGraphSignup();
    expect((await exchangeCode(code)).ok).toBe(true);
    const again = await exchangeCode(code);
    expect(again).toMatchObject({ ok: false, kind: "http", status: 400, subcode: 36009 });
  });

  it("[WA-P3] el code vence a los 30 s", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-22T15:00:00Z"));
    const { code } = fakeGraphSignup();
    vi.setSystemTime(new Date("2026-10-22T15:00:30Z"));
    expect(await exchangeCode(code)).toMatchObject({ ok: false, subcode: 36007 });
    vi.setSystemTime(new Date("2026-10-22T15:01:00Z"));
    const fresh = fakeGraphSignup();
    vi.setSystemTime(new Date("2026-10-22T15:01:29Z"));
    expect((await exchangeCode(fresh.code)).ok).toBe(true);
  });

  it("[WA-P3] secreto de la app equivocado → no canjea; debug_token sin app token → error", async () => {
    // Directo al fake: el cliente y el fake leen la MISMA env en el test, así que el secreto ajeno se manda a mano.
    const { code } = fakeGraphSignup();
    const q = new URLSearchParams({ client_id: FAKE_WA.WHATSAPP_APP_ID, client_secret: "otro-secreto", code });
    expect((await fakeGraphHandle(new Request(`${FAKE}/v23.0/oauth/access_token?${q}`))).status).toBe(400);
    const dbg = await fakeGraphHandle(
      new Request(`${FAKE}/v23.0/debug_token?input_token=x`, { headers: { authorization: `Bearer ${FAKE_WA.WHATSAPP_APP_ID}|otro-secreto` } })
    );
    expect(dbg.status).toBe(400);
    // El code no se gastó con el intento fallido: el canje bueno todavía funciona.
    expect((await exchangeCode(code)).ok).toBe(true);
    // Sin la config de la app, el cliente ni llama.
    delete process.env.WHATSAPP_APP_SECRET;
    const calls = fake.calls.length;
    expect(await debugToken("cualquiera")).toMatchObject({ ok: false, errorCode: "app_not_configured" });
    expect(fake.calls.length).toBe(calls);
  });

  it("[WA-P3] permisos parciales u otra WABA salen en granular_scopes (C-WA6 los rechaza)", async () => {
    for (const grant of ["management_only", "messaging_only", "other_waba"] as const) {
      const s = fakeGraphSignup({ grant });
      const ex = await exchangeCode(s.code);
      const info = await debugToken((ex as { data: { accessToken: string } }).data.accessToken);
      const g = info.ok ? info.data.granularScopes : [];
      const both = ["whatsapp_business_management", "whatsapp_business_messaging"].every((sc) =>
        g.some((x) => x.scope === sc && x.targetIds.includes(s.wabaId))
      );
      expect(both, grant).toBe(false);
    }
  });

  it("[WA-P3] popup con otro app_id/config_id → error; Cancelar → evento CANCEL", async () => {
    const bad = await fakeGraphHandle(new Request(`${FAKE}/dialog/signup?app_id=otra&config_id=${FAKE_WA.WHATSAPP_CONFIG_ID}`));
    expect(bad.status).toBe(400);
    const res = await fakeGraphHandle(
      new Request(`${FAKE}/dialog/signup`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ app_id: FAKE_WA.WHATSAPP_APP_ID, config_id: FAKE_WA.WHATSAPP_CONFIG_ID, decision: "cancel" }).toString(),
      })
    );
    expect(await res.text()).toContain('\\"event\\":\\"CANCEL\\"');
  });

  it("[WA-P3] subscribe, register con PIN (otro PIN → 133005), unsubscribe corta los webhooks; token de otra WABA → 403", async () => {
    const a = fakeGraphSignup();
    const tok = (await exchangeCode(a.code)) as { data: { accessToken: string } };
    expect((await subscribeApp(tok.data.accessToken, a.wabaId)).ok).toBe(true);
    expect(fakeGraphWaba(a.wabaId)!.subscribed).toBe(true);
    expect((await registerPhone(tok.data.accessToken, a.phoneNumberId, "123456")).ok).toBe(true);
    expect(await registerPhone(tok.data.accessToken, a.phoneNumberId, "654321")).toMatchObject({ ok: false, code: 133005, errorClass: "account" });
    expect(await registerPhone(tok.data.accessToken, a.phoneNumberId, "12")).toMatchObject({ ok: false, code: 100 });
    expect((await unsubscribeApp(tok.data.accessToken, a.wabaId)).ok).toBe(true);
    expect(await fakeGraphQuality(a.phoneNumberId, "FLAGGED")).toEqual({ webhookStatus: 0, skipped: "not_subscribed" });
    expect(fake.hooks).toEqual([]);

    const b = fakeGraphSignup();
    expect(await listPhoneNumbers(tok.data.accessToken, b.wabaId)).toMatchObject({ ok: false, status: 403, code: 200, errorClass: "auth" });
    expect(await listPhoneNumbers("token-inventado", b.wabaId)).toMatchObject({ ok: false, status: 401, code: 190, errorClass: "auth" });
  });
});

describe("[WA-P3] plantillas", () => {
  it("[WA-P3] alta PENDING → aprobación con webhook firmado (message_template_status_update) → listTemplates APPROVED", async () => {
    const a = fakeGraphSignup();
    const tok = ((await exchangeCode(a.code)) as { data: { accessToken: string } }).data.accessToken;
    await subscribeApp(tok, a.wabaId);
    const spec = TEMPLATE_SPECS.BOOKING_REMINDER;
    const c = await createTemplate(tok, a.wabaId, { name: spec.name, language: spec.language, category: spec.category, components: templateCreateComponents(spec) });
    expect(c.ok && c.data.status).toBe("PENDING");
    const dup = await createTemplate(tok, a.wabaId, { name: spec.name, language: spec.language, category: spec.category, components: templateCreateComponents(spec) });
    expect(dup).toMatchObject({ ok: false, subcode: 2388024 });

    const decided = await approveFakeTemplates({ wabaId: a.wabaId });
    expect(decided.map((d) => d.name)).toEqual([spec.name]);
    expect(fake.hooks).toHaveLength(1);
    const h = fake.hooks[0];
    expect(h.url).toBe(`${FAKE_WA_APP_URL}/api/webhooks/whatsapp`);
    expect(verifyMetaSignature(Buffer.from(h.raw, "utf8"), h.headers["x-hub-signature-256"], FAKE_WA.WHATSAPP_APP_SECRET)).toBe(true);
    const change = (h.body as { entry: { id: string; changes: { field: string; value: Record<string, unknown> }[] }[] }).entry[0];
    expect(change.id).toBe(a.wabaId);
    expect(change.changes[0].field).toBe("message_template_status_update");
    expect(change.changes[0].value).toMatchObject({ event: "APPROVED", message_template_name: spec.name, message_template_language: "es_AR" });

    const list = await listTemplates(tok, a.wabaId);
    expect(list.ok && list.data.find((t) => t.name === spec.name)?.status).toBe("APPROVED");
    // `hello_world` viene aprobada en toda WABA (WA-D28).
    expect(list.ok && list.data.find((t) => t.name === TEST_TEMPLATE.name)?.status).toBe("APPROVED");
  });

  it("[WA-P3] aprobación automática: el webhook sale solo después del delay", async () => {
    fake.uninstall();
    fake = installFakeGraph({ config: { templateApproval: "auto", autoApproveDelayMs: 5 } });
    const a = fakeGraphSignup();
    const tok = ((await exchangeCode(a.code)) as { data: { accessToken: string } }).data.accessToken;
    await subscribeApp(tok, a.wabaId);
    const spec = TEMPLATE_SPECS.BOOKING_CREATED;
    await createTemplate(tok, a.wabaId, { name: spec.name, language: spec.language, category: spec.category, components: templateCreateComponents(spec) });
    await vi.waitFor(() => expect(fake.hooks).toHaveLength(1), { timeout: 1000, interval: 5 });
    expect(fakeGraphWaba(a.wabaId)!.templates.find((t) => t.name === spec.name)!.status).toBe("APPROVED");
  });
});

/** Cuenta lista para mandar: provisionada con las 5 plantillas APPROVED. */
function provisioned() {
  return fakeGraphProvision({
    pin: "123456",
    templates: Object.values(TEMPLATE_SPECS).map((s) => ({ name: s.name, language: s.language, body: s.body, header: s.header, buttons: s.buttons.length, status: "APPROVED" as const })),
  });
}

function reminderMessage(to: string, messageId = "msg_1") {
  const built = buildTemplateParams("BOOKING_REMINDER", { firstName: "Martina", clinicName: "Consultorio Sur", scheduledFor: new Date("2026-10-23T12:30:00Z") });
  return {
    to,
    name: built.name,
    language: built.language,
    components: templateSendComponents(built, { buttonPayloads: [buttonPayload("confirm", messageId), buttonPayload("cancel", messageId)] }),
    callbackData: messageId,
  };
}

describe("[WA-P3] media y mensajes", () => {
  it("[WA-P3] media: solo PDF por magic bytes (un HTML con type pdf no pasa)", async () => {
    const p = provisioned();
    const ok = await uploadMedia(p.token, p.phoneNumberId, { bytes: PDF, filename: "ficha.pdf" });
    expect(ok.ok && ok.data.id).toMatch(/^[0-9]+$/);
    const bad = await uploadMedia(p.token, p.phoneNumberId, { bytes: new Uint8Array(Buffer.from("<html>no</html>")), filename: "x.pdf" });
    expect(bad).toMatchObject({ ok: false, code: 131053 });
  });

  it("[WA-P3] documento: header DOCUMENT con media id; un link en vez de media se rechaza", async () => {
    const p = provisioned();
    const media = await uploadMedia(p.token, p.phoneNumberId, { bytes: PDF, filename: "ficha.pdf" });
    const built = buildTemplateParams("DOCUMENT_SHARED", { firstName: "Martina", clinicName: "Consultorio Sur" });
    const send = (components: unknown[]) =>
      sendTemplate(p.token, p.phoneNumberId, { to: FAKE_WA_PHONES.ok, name: built.name, language: built.language, components, callbackData: "msg_doc" });
    const ok = await send(templateSendComponents(built, { documentMediaId: (media as { data: { id: string } }).data.id, documentFilename: "ficha.pdf" }));
    expect(ok.ok).toBe(true);
    const link = await send([{ type: "header", parameters: [{ type: "document", document: { link: "https://x/ficha.pdf" } }] }, ...templateSendComponents(built).slice(0)]);
    expect(link).toMatchObject({ ok: false, code: 132012 });
    expect(await send(templateSendComponents(built, { documentMediaId: "999999999" }))).toMatchObject({ ok: false, code: 131053 });
  });

  it("[WA-P3] valida plantilla APPROVED y cantidad de params", async () => {
    const p = provisioned();
    const m = reminderMessage(FAKE_WA_PHONES.ok);
    expect((await sendTemplate(p.token, p.phoneNumberId, m)).ok).toBe(true);
    expect(await sendTemplate(p.token, p.phoneNumberId, { ...m, name: "no_existe_v1" })).toMatchObject({ ok: false, code: 132001, errorClass: "template" });
    const fewer = { ...m, components: [{ type: "body", parameters: [{ type: "text", text: "Martina" }] }] };
    expect(await sendTemplate(p.token, p.phoneNumberId, fewer)).toMatchObject({ ok: false, code: 132000, errorClass: "template" });
    // `hello_world` sin params (la prueba de envío).
    expect((await sendTemplate(p.token, p.phoneNumberId, { to: FAKE_WA_PHONES.ok, name: TEST_TEMPLATE.name, language: TEST_TEMPLATE.language, components: [], callbackData: "t1" })).ok).toBe(true);
  });

  it("[WA-P3] cadena sent → delivered → read por webhooks firmados con biz_opaque_callback_data", async () => {
    const p = provisioned();
    const r = await sendTemplate(p.token, p.phoneNumberId, reminderMessage(FAKE_WA_PHONES.ok, "msg_chain"));
    const wamid = (r as { data: { wamid: string } }).data.wamid;
    await fakeGraphAdvance(wamid, "read");
    expect(fake.hooks).toHaveLength(3);
    const statuses = fake.hooks.map((h) => {
      expect(verifyMetaSignature(Buffer.from(h.raw), h.headers["x-hub-signature-256"], FAKE_WA.WHATSAPP_APP_SECRET)).toBe(true);
      const v = (h.body as { entry: { changes: { value: { statuses: Record<string, unknown>[]; metadata: Record<string, string> } }[] }[] }).entry[0].changes[0].value;
      expect(v.metadata.phone_number_id).toBe(p.phoneNumberId);
      return v.statuses[0];
    });
    expect(statuses.map((s) => s.status)).toEqual(["sent", "delivered", "read"]);
    for (const s of statuses) expect(s).toMatchObject({ id: wamid, biz_opaque_callback_data: "msg_chain" });
  });

  it("[WA-P3] números mágicos: …0001 → 131026, …0002 → 131042, …0004 → 130429", async () => {
    const p = provisioned();
    expect(await sendTemplate(p.token, p.phoneNumberId, reminderMessage(FAKE_WA_PHONES.undeliverable))).toMatchObject({
      ok: false,
      code: 131026,
      errorClass: "recipient",
      errorCode: "recipient:131026",
    });
    expect(await sendTemplate(p.token, p.phoneNumberId, reminderMessage(FAKE_WA_PHONES.payment))).toMatchObject({
      ok: false,
      code: 131042,
      errorClass: "payment",
    });
    expect(await sendTemplate(p.token, p.phoneNumberId, reminderMessage(FAKE_WA_PHONES.rateLimit))).toMatchObject({
      ok: false,
      code: 130429,
      errorClass: "retry",
      retryable: true,
    });
  });

  it("[WA-P3] …0003 → timeout inline (2,5 s); Meta lo registró igual, con nuestro id", async () => {
    const p = provisioned();
    const t0 = Date.now();
    const r = await sendTemplate(p.token, p.phoneNumberId, reminderMessage(FAKE_WA_PHONES.timeout, "msg_slow"), { inline: true });
    const took = Date.now() - t0;
    expect(r).toMatchObject({ ok: false, kind: "timeout", errorCode: "timeout", retryable: true });
    expect(took).toBeGreaterThanOrEqual(2400);
    expect(took).toBeLessThan(4000);
    // El caso que resuelve `biz_opaque_callback_data`: la cola ve el `sent` con su id y no lo reenvía.
    expect(fakeGraphMessageByCallback("msg_slow")).not.toBeNull();
  }, 10_000);

  it("[WA-P3] texto libre solo dentro de las 24 h del último mensaje del paciente", async () => {
    const p = provisioned();
    const msg = { to: FAKE_WA_PHONES.ok, body: "Gracias, te esperamos." };
    expect(await sendText(p.token, p.phoneNumberId, msg)).toMatchObject({ ok: false, code: 131047, errorClass: "recipient" });
    await sendInbound(FAKE_WA_PHONES.ok, "Hola", { phoneNumberId: p.phoneNumberId });
    expect((await sendText(p.token, p.phoneNumberId, msg)).ok).toBe(true);
  });

  it("[WA-P3] número sin registrar → 133010", async () => {
    const a = fakeGraphSignup();
    const tok = ((await exchangeCode(a.code)) as { data: { accessToken: string } }).data.accessToken;
    expect(await sendTemplate(tok, a.phoneNumberId, reminderMessage(FAKE_WA_PHONES.ok))).toMatchObject({ ok: false, code: 133010 });
  });
});

describe("[WA-P3] respuestas del paciente y avisos de la cuenta", () => {
  it("[WA-P3] botones Confirmo / No puedo ir: payload wa1.c|x.<id> y context.id = el wamid del recordatorio", async () => {
    const p = provisioned();
    const r = await sendTemplate(p.token, p.phoneNumberId, reminderMessage(FAKE_WA_PHONES.ok, "msg_btn"));
    const wamid = (r as { data: { wamid: string } }).data.wamid;
    await pressButton(wamid, "c");
    await pressButton(wamid, "x");
    const msgs = fake.hooks.map((h) => (h.body as { entry: { changes: { value: { messages: Record<string, unknown>[] } }[] }[] }).entry[0].changes[0].value.messages[0]);
    expect(msgs[0]).toMatchObject({ type: "button", button: { payload: "wa1.c.msg_btn", text: "Confirmo" }, context: { id: wamid }, from: "5491155550100" });
    expect(msgs[1]).toMatchObject({ type: "button", button: { payload: "wa1.x.msg_btn", text: "No puedo ir" } });
  });

  it("[WA-P3] texto entrante (BAJA), calidad y PARTNER_REMOVED (revoca el token)", async () => {
    const p = provisioned();
    await sendInbound(FAKE_WA_PHONES.ok, "BAJA", { phoneNumberId: p.phoneNumberId });
    await fakeGraphQuality(p.phoneNumberId, "FLAGGED");
    await fakeGraphPartnerRemoved(p.wabaId);
    const fields = fake.hooks.map((h) => (h.body as { entry: { changes: { field: string; value: Record<string, unknown> }[] }[] }).entry[0].changes[0]);
    expect(fields.map((f) => f.field)).toEqual(["messages", "phone_number_quality_update", "account_update"]);
    expect((fields[0].value.messages as Record<string, unknown>[])[0]).toMatchObject({ type: "text", text: { body: "BAJA" } });
    expect(fields[1].value).toMatchObject({ event: "FLAGGED" });
    expect(fields[2].value).toMatchObject({ event: "PARTNER_REMOVED", waba_info: { waba_id: p.wabaId } });
    expect(await listPhoneNumbers(p.token, p.wabaId)).toMatchObject({ ok: false, code: 190 });
  });

  it("[WA-P3] el panel lista los botones y responde por el webhook real; sin teléfonos enteros en el HTML", async () => {
    const p = provisioned();
    const r = await sendTemplate(p.token, p.phoneNumberId, reminderMessage(FAKE_WA_PHONES.ok, "msg_panel"));
    const wamid = (r as { data: { wamid: string } }).data.wamid;
    const page = await (await fakeGraphHandle(new Request(`${FAKE}/panel`))).text();
    for (const label of ["Confirmo", "No puedo ir", "BAJA", "ALTA", "Mandar texto", "Mandar aviso de calidad", "PARTNER_REMOVED"]) {
      expect(page, label).toContain(label);
    }
    expect(page).toContain("+54 9 11 ****-0100");
    expect(page).not.toContain("5491155550100");
    const res = await fakeGraphHandle(
      new Request(`${FAKE}/panel/button`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ wamid, kind: "c" }).toString(),
      })
    );
    expect(await res.text()).toContain("Webhook enviado · respuesta 200 · recorded");
    expect(fake.hooks).toHaveLength(1);
  });

  it("[WA-P3] el webhook inyectable recibe el Request con el cuerpo crudo firmado", async () => {
    const seen: { ok: boolean }[] = [];
    fake.setWebhook(async (req) => {
      const raw = Buffer.from(await req.arrayBuffer());
      seen.push({ ok: verifyMetaSignature(raw, req.headers.get("x-hub-signature-256"), FAKE_WA.WHATSAPP_APP_SECRET) });
      return new Response(JSON.stringify({ result: "applied" }), { status: 200 });
    });
    const p = provisioned();
    const h = await sendInbound(FAKE_WA_PHONES.ok, "ALTA", { phoneNumberId: p.phoneNumberId });
    expect(h).toEqual({ webhookStatus: 200, webhookResult: "applied" });
    expect(seen).toEqual([{ ok: true }]);
  });
});

describe("[WA-P3] nada de PHI ni secretos en los logs", () => {
  it("[WA-P3] nunca se loguea el teléfono ni el token (ni en los errores ni en el timeout)", async () => {
    const out: string[] = [];
    const cap = (...a: unknown[]) => {
      out.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    };
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      cap(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    for (const k of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, k).mockImplementation(cap);

    const p = provisioned();
    const { code } = fakeGraphSignup();
    const ex = await exchangeCode(code);
    const token = (ex as { data: { accessToken: string } }).data.accessToken;
    await debugToken(token);
    await exchangeCode(code); // ya usado → error HTTP logueado
    await listPhoneNumbers("token-inventado-abc", p.wabaId);
    for (const to of [FAKE_WA_PHONES.ok, FAKE_WA_PHONES.undeliverable, FAKE_WA_PHONES.payment, FAKE_WA_PHONES.rateLimit]) {
      await sendTemplate(p.token, p.phoneNumberId, reminderMessage(to));
    }
    await sendText(p.token, p.phoneNumberId, { to: FAKE_WA_PHONES.ok, body: "x" });
    await sendTemplate(p.token, p.phoneNumberId, reminderMessage(FAKE_WA_PHONES.timeout), { timeoutMs: 50 });
    // Red caída (fetch que tira con la URL en el mensaje, como undici).
    globalThis.fetch = (async (u: string) => {
      throw new TypeError(`fetch failed ${u} ${p.token}`);
    }) as typeof fetch;
    await sendTemplate(p.token, p.phoneNumberId, reminderMessage(FAKE_WA_PHONES.ok));

    const all = out.join("\n");
    expect(all).toContain("whatsapp.graph"); // sí se loguearon los errores…
    for (const secret of [p.token, token, code, "token-inventado-abc", FAKE_WA.WHATSAPP_APP_SECRET]) expect(all).not.toContain(secret);
    for (const phone of Object.values(FAKE_WA_PHONES)) {
      expect(all).not.toContain(phone);
      expect(all).not.toContain(phone.slice(1));
    }
  }, 10_000);
});
