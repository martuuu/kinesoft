/**
 * [WA-S4] Diagnóstico de «Avisos por WhatsApp» (T6, brief §26.5): verifica, uno por uno, los SUPUESTOS [S1]…[S13] que
 * el código de `lib/whatsapp/*` y el Meta FALSO (`lib/whatsapp/fake-graph.ts`) hacen sobre la WhatsApp Cloud API y el
 * Embedded Signup v4. Molde: `scripts/diagnose-mp-connect.ts` (S1–S11 de Mercado Pago Connect).
 *
 * Por qué: los tests y el E2E corren contra el Meta FALSO. Si el simulador supone algo que Meta no hace (p. ej. que el
 * botón del recordatorio vuelve con `context.id` = el wamid, o que el estado trae `biz_opaque_callback_data`), los
 * tests dan verde y prod no. Este script ejercita el MISMO código de la app (`lib/whatsapp/graph.ts`, `crypto.ts`,
 * `logic.ts`, `templates.ts`) contra:
 *   - el **simulador** (default, sin `--sandbox`): todo en el proceso, sin red, sin base y SIN leer `.env*` (los
 *     literales son los de `DEV_WAFAKE_LITERALS`). Es lo que corre CI y cualquier agente. Prueba que el fake cumple el
 *     contrato;
 *   - el **sandbox real** (`WHATSAPP_MODE=sandbox` + `--sandbox`): LO CORRE SOLO MARTIN, al final (§26.7 paso 7: «Meta →
 *     sandbox WA S1-S13 → live»), con la app de prueba de Meta, un número de prueba y un túnel para el webhook. Nunca un
 *     agente (regla de T6: producción, Meta real y sandbox, inadmisibles). Las variables las pone Martin en la línea de
 *     comando; el script no carga ningún `.env`.
 *
 * Supuestos:
 *   [S1]  El `code` del Embedded Signup se canjea UNA vez (`/oauth/access_token` con client_id + secret) y vive 30 s.
 *   [S2]  `debug_token` (app token `appId|secret`) devuelve `app_id` propio, `is_valid` y el WABA en los `target_ids`
 *         de los DOS `granular_scopes` (management y messaging).
 *   [S3]  `/{waba}/phone_numbers` lista el `phone_number_id` del alta, con calidad y límite.
 *   [S4]  `POST /{waba}/subscribed_apps` suscribe la app (sin eso Meta no manda webhooks del WABA).
 *   [S5]  `POST /{phone}/register` exige el PIN de 6 dígitos; otro PIN sobre un número ya registrado → 133005.
 *   [S6]  Una plantilla nueva queda PENDING y la aprobación llega por webhook `message_template_status_update`.
 *   [S7]  El envío devuelve `wamid` y los estados (sent → delivered → read) llegan con `biz_opaque_callback_data`.
 *   [S8]  El botón quick reply vuelve como `type: button` con NUESTRO payload (`wa1.c|x.<messageId>`) y `context.id`
 *         = el wamid del recordatorio.
 *   [S9]  Todo webhook viene firmado `X-Hub-Signature-256: sha256=<hex>` con el App Secret sobre los bytes crudos.
 *   [S10] El GET de verificación (`hub.mode=subscribe`, `hub.verify_token`, `hub.challenge`) compara con NUESTRO token.
 *   [S11] La media se sube como PDF (`/{phone}/media`, devuelve id) y `cs_documento_v1` la manda en el header DOCUMENT
 *         por id; el alta de esa plantilla exige `example.header_handle` (Resumable Upload).
 *   [S12] Formas de error: `{error:{code,error_subcode}}` con 131026 (destinatario), 131042 (pago), 130429 (rate
 *         limit), 190 (token) y el timeout, clasificados por `classifyGraphError`.
 *   [S13] PARTNER_REMOVED (`account_update`) revoca el token: después, `debug_token` da `is_valid: false`.
 *
 * Seguridad: imprime ✓/✗ y códigos. Nunca tokens, codes, PINs, secretos ni teléfonos completos.
 *
 * Uso:
 *   npx tsx --conditions=react-server scripts/diagnose-whatsapp.ts            # simulador (default)
 *   # Sandbox (SOLO Martin, al final, con la app de prueba de Meta y el túnel apuntando a /api/webhooks/whatsapp):
 *   #   WHATSAPP_MODE=sandbox WHATSAPP_APP_ID=… WHATSAPP_APP_SECRET=… NEXT_PUBLIC_APP_URL=https://<túnel> \
 *   #     npx tsx --conditions=react-server scripts/diagnose-whatsapp.ts --sandbox \
 *   #       --code <code del popup, < 30 s> --waba <waba_id> --phone-number-id <id> --pin <6 dígitos> --to <+549…>
 *   #   → S1-S7 y S12 automáticos; S8-S11 y S13 se miran en el log del webhook (instrucciones al final).
 * Sale con código 1 si algún supuesto automático da ✗.
 */

const NAME = "diagnose-whatsapp";
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
    check(id, desc, false, `excepción ${err instanceof Error ? err.name : "desconocida"}`);
  }
}

type GraphErrLike = { ok: false; subcode: number | null; errorCode: string; kind: string };
const errDetail = (r: { ok: true } | GraphErrLike) => (r.ok ? "ok" : `${r.kind}/${r.errorCode}${r.subcode ? `/${r.subcode}` : ""}`);

/** PDF mínimo válido (cabecera `%PDF-`): el simulador y Meta miran la firma del archivo, no la extensión. */
const TINY_PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

// ── Simulador ───────────────────────────────────────────────────────────────────────────────────────────────────

async function runFake(): Promise<void> {
  const { DEV_WAFAKE_LITERALS: L } = await import("./lib/dev-mp-fake-env.mjs");
  const APP = "http://localhost:3000";
  // Entorno ANTES de importar la app: el modo y la URL se leen en cada llamada, pero `env` se congela al importar.
  process.env.WHATSAPP_MODE = "fake";
  delete process.env.VERCEL_ENV;
  delete process.env.VERCEL;
  process.env.NEXT_PUBLIC_APP_URL = APP;
  process.env.WHATSAPP_APP_ID = L.WHATSAPP_APP_ID;
  process.env.WHATSAPP_APP_SECRET = L.WHATSAPP_APP_SECRET;
  process.env.WHATSAPP_CONFIG_ID = L.WHATSAPP_CONFIG_ID;
  process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = L.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  delete process.env.WHATSAPP_GRAPH_VERSION;

  const fake = await import("../lib/whatsapp/fake-graph");
  const graph = await import("../lib/whatsapp/graph");
  const { verifyMetaSignature, verifyTokenMatches } = await import("../lib/whatsapp/crypto");
  const { buttonPayload, parseButtonPayload, classifyGraphError } = await import("../lib/whatsapp/logic");
  const { TEMPLATE_SPECS, buildTemplateParams } = await import("../lib/whatsapp/templates");
  fake.resetFakeGraph();
  fake.configureFakeGraph({ templateApproval: "manual", autoStatuses: false });

  // Red en el proceso: lo que va al simulador lo atiende `fakeGraphHandle`; el webhook lo recibe este script y verifica
  // la firma con el MISMO verificador que la ruta. Cualquier otro host tira: nada sale a internet.
  const fakeBase = `${APP}${graph.WA_FAKE_PATH}`;
  type Hook = { raw: string; signature: string | null; signatureOk: boolean; body: Record<string, unknown> };
  const hooks: Hook[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(fakeBase)) {
      const res = fake.fakeGraphHandle(input instanceof Request && !init ? input : new Request(url, init));
      // Como un fetch de verdad: si el caller aborta (timeout de `graph.ts`), la promesa rechaza aunque el fake siga
      // colgado (el número mágico …0003). Sin esto el timeout de S12 se vería como un 200.
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      if (!signal) return res;
      return new Promise<Response>((resolve, reject) => {
        const onAbort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
        res.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
      });
    }
    if (url.startsWith(`${APP}/api/webhooks/whatsapp`)) {
      const raw = String(init?.body ?? "");
      const signature = new Headers(init?.headers).get("x-hub-signature-256");
      hooks.push({
        raw,
        signature,
        signatureOk: verifyMetaSignature(Buffer.from(raw, "utf8"), signature, L.WHATSAPP_APP_SECRET),
        body: JSON.parse(raw || "{}") as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ result: "recorded" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error("red real bloqueada");
  }) as typeof fetch;

  /** El `value` del primer change de un webhook (forma de Meta: entry[0].changes[0]). */
  const valueOf = (h: Hook | undefined) => {
    const entry = (h?.body.entry as { changes?: { field?: string; value?: Record<string, unknown> }[] }[] | undefined)?.[0];
    return { field: entry?.changes?.[0]?.field ?? null, value: entry?.changes?.[0]?.value ?? {} };
  };

  // [S1] canje del code: un uso y 30 s.
  const signup = fake.fakeGraphSignup();
  let token = "";
  await step("S1", "el code se canjea UNA vez y vence a los 30 s", async () => {
    const first = await graph.exchangeCode(signup.code);
    if (!first.ok) return { pass: false, detail: errDetail(first) };
    token = first.data.accessToken;
    const again = await graph.exchangeCode(signup.code);
    const late = fake.fakeGraphSignup();
    const realNow = Date.now;
    Date.now = () => realNow() + 31_000;
    let expired;
    try {
      expired = await graph.exchangeCode(late.code);
    } finally {
      Date.now = realNow;
    }
    const pass = !again.ok && again.subcode === 36009 && !expired.ok && expired.subcode === 36007;
    return { pass, detail: `reuso ${errDetail(again)} · vencido ${errDetail(expired)}` };
  });

  // [S2] debug_token con granular_scopes.
  await step("S2", "debug_token: app_id propio, is_valid y el WABA en los dos granular_scopes", async () => {
    const r = await graph.debugToken(token);
    if (!r.ok) return { pass: false, detail: errDetail(r) };
    const scopeHas = (s: string) => r.data.granularScopes.some((g) => g.scope === s && g.targetIds.includes(signup.wabaId));
    const pass =
      r.data.appId === L.WHATSAPP_APP_ID &&
      r.data.isValid &&
      scopeHas("whatsapp_business_management") &&
      scopeHas("whatsapp_business_messaging");
    const bad = await graph.debugToken("FAKEWA-token-que-no-existe");
    return { pass: pass && bad.ok && !bad.data.isValid, detail: `${r.data.granularScopes.length} scopes; inválido → is_valid ${bad.ok ? bad.data.isValid : "error"}` };
  });

  // [S3] phone_numbers del WABA.
  await step("S3", "phone_numbers lista el número del alta con calidad y límite", async () => {
    const r = await graph.listPhoneNumbers(token, signup.wabaId);
    if (!r.ok) return { pass: false, detail: errDetail(r) };
    const p = r.data.find((x) => x.id === signup.phoneNumberId);
    return { pass: Boolean(p?.qualityRating && p.messagingLimit), detail: p ? `${p.qualityRating} / ${p.messagingLimit}` : "no está" };
  });

  // [S4] subscribe.
  await step("S4", "subscribed_apps suscribe la app al WABA", async () => {
    const r = await graph.subscribeApp(token, signup.wabaId);
    return { pass: r.ok && fake.fakeGraphWaba(signup.wabaId)?.subscribed === true, detail: errDetail(r) };
  });

  // [S5] register con PIN.
  await step("S5", "register exige PIN de 6 dígitos; otro PIN sobre el registrado → 133005", async () => {
    const short = await graph.registerPhone(token, signup.phoneNumberId, "12345");
    const ok = await graph.registerPhone(token, signup.phoneNumberId, "246810");
    const other = await graph.registerPhone(token, signup.phoneNumberId, "135791");
    const pass = !short.ok && ok.ok && !other.ok && other.code === 133005 && other.errorClass === "account";
    return { pass, detail: `corto ${errDetail(short)} · otro ${errDetail(other)}` };
  });

  // [S6] alta de plantilla → PENDING → aprobación por webhook.
  const reminder = TEMPLATE_SPECS.BOOKING_REMINDER;
  await step("S6", "plantilla nueva PENDING; la aprobación llega por message_template_status_update", async () => {
    const c = await graph.createTemplate(token, signup.wabaId, {
      name: reminder.name,
      language: reminder.language,
      category: reminder.category,
      components: graph.templateCreateComponents(reminder),
    });
    if (!c.ok) return { pass: false, detail: errDetail(c) };
    const before = await graph.listTemplates(token, signup.wabaId);
    const n = hooks.length;
    await fake.fakeGraphDecideTemplates({ wabaId: signup.wabaId, names: [reminder.name], decision: "APPROVED" });
    const hook = valueOf(hooks[n]);
    const after = await graph.listTemplates(token, signup.wabaId);
    const st = (r: typeof before) => (r.ok ? r.data.find((t) => t.name === reminder.name)?.status : null);
    const pass =
      c.data.status === "PENDING" &&
      st(before) === "PENDING" &&
      hook.field === "message_template_status_update" &&
      hook.value.event === "APPROVED" &&
      hook.value.message_template_name === reminder.name &&
      st(after) === "APPROVED";
    return { pass, detail: `${st(before)} → ${st(after)}` };
  });

  // [S7] envío → wamid + estados con callback.
  const callbackId = "diag-msg-0001";
  let wamid = "";
  await step("S7", "el envío da wamid y los estados traen biz_opaque_callback_data", async () => {
    const built = buildTemplateParams("BOOKING_REMINDER", {
      firstName: "Martina",
      clinicName: "Consultorio de prueba",
      scheduledFor: new Date(Date.now() + 24 * 3600_000),
      count: null,
    });
    const r = await graph.sendTemplate(token, signup.phoneNumberId, {
      to: "+5491155550100",
      name: built.name,
      language: built.language,
      components: graph.templateSendComponents(built, {
        buttonPayloads: [buttonPayload("confirm", callbackId), buttonPayload("cancel", callbackId)],
      }),
      callbackData: callbackId,
    });
    if (!r.ok) return { pass: false, detail: errDetail(r) };
    wamid = r.data.wamid;
    const n = hooks.length;
    await fake.fakeGraphAdvance(wamid, "read");
    const statuses = hooks.slice(n).map((h) => (valueOf(h).value.statuses as Record<string, unknown>[] | undefined)?.[0] ?? {});
    const pass =
      wamid.startsWith("wamid.") &&
      statuses.map((s) => s.status).join(",") === "sent,delivered,read" &&
      statuses.every((s) => s.id === wamid && s.biz_opaque_callback_data === callbackId);
    return { pass, detail: statuses.map((s) => s.status).join(" → ") };
  });

  // [S8] botón con payload propio y context.id.
  await step("S8", "el botón vuelve con nuestro payload y context.id = wamid del recordatorio", async () => {
    const n = hooks.length;
    await fake.fakeGraphPressButton(wamid, "c");
    const msg = (valueOf(hooks[n]).value.messages as Record<string, unknown>[] | undefined)?.[0] ?? {};
    const btn = msg.button as { payload?: string } | undefined;
    const ctx = msg.context as { id?: string } | undefined;
    const parsed = parseButtonPayload(btn?.payload);
    const pass = msg.type === "button" && ctx?.id === wamid && parsed?.kind === "confirm" && parsed.messageId === callbackId;
    return { pass, detail: `type ${String(msg.type)} · payload ${parsed ? `${parsed.kind}` : "inválido"}` };
  });

  // [S9] firma de todos los webhooks.
  await step("S9", "todo webhook viene firmado sha256=<hex> con el App Secret sobre los bytes crudos", async () => {
    const all = hooks.length > 0 && hooks.every((h) => h.signatureOk && /^sha256=[0-9a-f]{64}$/.test(h.signature ?? ""));
    const h = hooks[0];
    const tampered = h ? verifyMetaSignature(Buffer.from(`${h.raw} `, "utf8"), h.signature, L.WHATSAPP_APP_SECRET) : true;
    const otherSecret = h ? verifyMetaSignature(Buffer.from(h.raw, "utf8"), h.signature, "otro-secreto") : true;
    return { pass: all && !tampered && !otherSecret, detail: `${hooks.length} webhooks; alterado ${tampered} · otro secreto ${otherSecret}` };
  });

  // [S10] GET verify.
  await step("S10", "el GET de verificación compara hub.verify_token con NUESTRO token", async () => {
    const u = new URL(`${APP}/api/webhooks/whatsapp`);
    u.searchParams.set("hub.mode", "subscribe");
    u.searchParams.set("hub.verify_token", L.WHATSAPP_WEBHOOK_VERIFY_TOKEN);
    u.searchParams.set("hub.challenge", "1158201444");
    const expected = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    const good = verifyTokenMatches(u.searchParams.get("hub.verify_token"), expected);
    const bad = verifyTokenMatches("otro-token", expected);
    const empty = verifyTokenMatches("", "");
    return { pass: good && !bad && !empty, detail: "comparador de la ruta (el GET real se prueba en wa-s3-webhook y en el sandbox)" };
  });

  // [S11] media PDF + header DOCUMENT (con header_handle en el alta).
  const doc = TEMPLATE_SPECS.DOCUMENT_SHARED;
  await step("S11", "media PDF por id en el header DOCUMENT; el alta exige example.header_handle", async () => {
    const noHandle = await graph.createTemplate(token, signup.wabaId, {
      name: doc.name,
      language: doc.language,
      category: doc.category,
      components: graph.templateCreateComponents(doc),
    });
    const handle = await graph.uploadHeaderSample(token, L.WHATSAPP_APP_ID, { bytes: TINY_PDF, mimeType: "application/pdf", filename: "ejemplo.pdf" });
    if (!handle.ok) return { pass: false, detail: `header_handle ${errDetail(handle)}` };
    const created = await graph.createTemplate(token, signup.wabaId, {
      name: doc.name,
      language: doc.language,
      category: doc.category,
      components: graph.templateCreateComponents(doc, { headerHandle: handle.data.handle }),
    });
    await fake.fakeGraphDecideTemplates({ wabaId: signup.wabaId, names: [doc.name], decision: "APPROVED" });
    const notPdf = await graph.uploadMedia(token, signup.phoneNumberId, { bytes: new TextEncoder().encode("hola"), filename: "x.pdf" });
    const media = await graph.uploadMedia(token, signup.phoneNumberId, { bytes: TINY_PDF, filename: "ficha.pdf" });
    if (!media.ok) return { pass: false, detail: `media ${errDetail(media)}` };
    const built = buildTemplateParams("DOCUMENT_SHARED", { firstName: "Martina", clinicName: "Consultorio de prueba", scheduledFor: null, count: null });
    const sent = await graph.sendTemplate(token, signup.phoneNumberId, {
      to: "+5491155550100",
      name: built.name,
      language: built.language,
      components: graph.templateSendComponents(built, { documentMediaId: media.data.id, documentFilename: "ficha.pdf" }),
      callbackData: "diag-msg-0002",
    });
    const got = sent.ok ? fake.fakeGraphGetMessage(sent.data.wamid) : null;
    const pass = !noHandle.ok && created.ok && !notPdf.ok && notPdf.code === 131053 && sent.ok && got?.documentMediaId === media.data.id;
    return { pass, detail: `sin handle ${errDetail(noHandle)} · no-PDF ${errDetail(notPdf)} · envío ${errDetail(sent)}` };
  });

  // [S12] formas de error.
  await step("S12", "errores con {error:{code}} clasificados: 131026, 131042, 130429, 190 y timeout", async () => {
    const built = buildTemplateParams("BOOKING_REMINDER", {
      firstName: "Martina",
      clinicName: "Consultorio de prueba",
      scheduledFor: new Date(Date.now() + 24 * 3600_000),
      count: null,
    });
    const send = (to: string, tok = token, timeoutMs?: number) =>
      graph.sendTemplate(
        tok,
        signup.phoneNumberId,
        { to, name: built.name, language: built.language, components: graph.templateSendComponents(built), callbackData: "diag-msg-err" },
        timeoutMs ? { timeoutMs } : {}
      );
    const M = fake.FAKE_WA_MAGIC;
    const undeliverable = await send(`+549115555${M.undeliverable}`);
    const payment = await send(`+549115555${M.payment}`);
    const rate = await send(`+549115555${M.rateLimit}`);
    const auth = await send("+5491155550100", "FAKEWA-token-invalido");
    const timeout = await send(`+549115555${M.timeout}`, token, 300);
    const is = (r: typeof rate, code: number | null, cls: string, retry: boolean) => !r.ok && r.code === code && r.errorClass === cls && r.retryable === retry;
    const pass =
      is(undeliverable, 131026, "recipient", false) &&
      is(payment, 131042, "payment", false) &&
      is(rate, 130429, "retry", true) &&
      is(auth, 190, "auth", false) &&
      !timeout.ok &&
      timeout.kind === "timeout" &&
      classifyGraphError({ code: 132001 }).errorClass === "template";
    return {
      pass,
      detail: [undeliverable, payment, rate, auth, timeout].map((r) => errDetail(r)).join(" · "),
    };
  });

  // [S13] PARTNER_REMOVED.
  await step("S13", "PARTNER_REMOVED llega por account_update y revoca el token", async () => {
    const n = hooks.length;
    await fake.fakeGraphPartnerRemoved(signup.wabaId);
    const v = valueOf(hooks[n]);
    const dbg = await graph.debugToken(token);
    const list = await graph.listTemplates(token, signup.wabaId);
    const pass = v.field === "account_update" && v.value.event === "PARTNER_REMOVED" && dbg.ok && !dbg.data.isValid && !list.ok && list.errorClass === "auth";
    return { pass, detail: `debug_token is_valid ${dbg.ok ? dbg.data.isValid : "error"} · listar ${errDetail(list)}` };
  });
}

// ── Sandbox (solo Martin) ───────────────────────────────────────────────────────────────────────────────────────

async function runSandbox(): Promise<number> {
  if (!hasFlag("sandbox") || (process.env.WHATSAPP_MODE ?? "").trim().toLowerCase() !== "sandbox") {
    console.error(`[${NAME}] El sandbox pide WHATSAPP_MODE=sandbox Y --sandbox (lo corre Martin al final, §26.7).`);
    return 2;
  }
  if (process.env.VERCEL_ENV || process.env.VERCEL) {
    console.error(`[${NAME}] Nunca en Vercel.`);
    return 2;
  }
  const code = argValue("code");
  const wabaId = argValue("waba");
  const phoneNumberId = argValue("phone-number-id");
  const pin = argValue("pin");
  const to = argValue("to");
  if (!code || !wabaId || !phoneNumberId || !pin || !/^[0-9]{6}$/.test(pin) || !to) {
    console.error(`[${NAME}] Faltan --code --waba --phone-number-id --pin (6 dígitos) --to (+549…). El code vive 30 s.`);
    return 2;
  }
  const graph = await import("../lib/whatsapp/graph");
  const { TEST_TEMPLATE } = await import("../lib/whatsapp/templates");

  let token = "";
  await step("S1", "canje del code (un uso; vive 30 s)", async () => {
    const r = await graph.exchangeCode(code);
    if (!r.ok) return { pass: false, detail: errDetail(r) };
    token = r.data.accessToken;
    const again = await graph.exchangeCode(code);
    return { pass: !again.ok, detail: `reuso ${errDetail(again)}` };
  });
  if (!token) {
    console.error(`[${NAME}] Sin token no sigue (¿el code venció? pedí otro en el popup y corré enseguida).`);
    return 1;
  }
  await step("S2", "debug_token: app_id propio, is_valid, WABA en los dos scopes", async () => {
    const r = await graph.debugToken(token);
    if (!r.ok) return { pass: false, detail: errDetail(r) };
    const has = (s: string) => r.data.granularScopes.some((g) => g.scope === s && g.targetIds.includes(wabaId));
    return {
      pass: r.data.appId === process.env.WHATSAPP_APP_ID && r.data.isValid && has("whatsapp_business_management") && has("whatsapp_business_messaging"),
      detail: `${r.data.granularScopes.map((g) => g.scope).join(",")} · expira ${r.data.expiresAt}`,
    };
  });
  await step("S3", "phone_numbers lista el número", async () => {
    const r = await graph.listPhoneNumbers(token, wabaId);
    const p = r.ok ? r.data.find((x) => x.id === phoneNumberId) : undefined;
    return { pass: Boolean(p), detail: r.ok ? `${p?.qualityRating ?? "?"} / ${p?.messagingLimit ?? "?"}` : errDetail(r) };
  });
  await step("S4", "subscribed_apps", async () => {
    const r = await graph.subscribeApp(token, wabaId);
    return { pass: r.ok, detail: errDetail(r) };
  });
  await step("S5", "register con PIN", async () => {
    const r = await graph.registerPhone(token, phoneNumberId, pin);
    return { pass: r.ok, detail: errDetail(r) };
  });
  await step("S6", "plantillas del WABA (estado)", async () => {
    const r = await graph.listTemplates(token, wabaId);
    if (!r.ok) return { pass: false, detail: errDetail(r) };
    return { pass: true, detail: r.data.map((t) => `${t.name}:${t.status}`).join(" ").slice(0, 300) };
  });
  await step("S7", "envío de hello_world → wamid (el callback se mira en el webhook)", async () => {
    const r = await graph.sendTemplate(token, phoneNumberId, {
      to,
      name: TEST_TEMPLATE.name,
      language: TEST_TEMPLATE.language,
      components: [],
      callbackData: "diag-sandbox-0001",
    });
    return { pass: r.ok, detail: r.ok ? "wamid recibido" : errDetail(r) };
  });
  await step("S12", "token inválido → 190 / auth", async () => {
    const r = await graph.listTemplates("token-invalido-diag", wabaId);
    return { pass: !r.ok && r.errorClass === "auth", detail: errDetail(r) };
  });
  check("S7", "estados con biz_opaque_callback_data", null, "manual: el log del webhook muestra statuses con diag-sandbox-0001");
  check("S8", "botón con payload y context.id", null, "manual: mandá un recordatorio desde la app y apretá «Confirmo»");
  check("S9", "firma X-Hub-Signature-256", null, "manual: la ruta no responde 401 a los webhooks de Meta");
  check("S10", "GET verify", null, "manual: «Verificar y guardar» en la consola de Meta con WHATSAPP_WEBHOOK_VERIFY_TOKEN");
  check("S11", "media + header DOCUMENT", null, "manual: compartir una ficha por WhatsApp desde la app");
  check("S13", "PARTNER_REMOVED", null, "manual: quitar la app desde Meta Business y ver account_update en el log");
  return 0;
}

async function main(): Promise<number> {
  const mode = (process.env.WHATSAPP_MODE ?? "").trim().toLowerCase();
  if (mode === "live") {
    console.error(`[${NAME}] Nunca contra live.`);
    return 2;
  }
  if (mode === "sandbox" || hasFlag("sandbox")) {
    const rc = await runSandbox();
    if (rc !== 0) return rc;
  } else {
    console.log(`[${NAME}] Simulador de Meta (en el proceso, sin red ni base, sin .env).`);
    await runFake();
  }
  const failed = results.filter((r) => r.pass === false);
  console.log(`\n[${NAME}] ${results.filter((r) => r.pass).length} ✓ · ${failed.length} ✗ · ${results.filter((r) => r.pass === null).length} manuales`);
  return failed.length > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`[${NAME}] falló: ${err instanceof Error ? err.name : "desconocido"}`);
    process.exit(1);
  }
);
