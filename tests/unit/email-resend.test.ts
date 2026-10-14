import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sendViaResend, RESEND_ENDPOINT, RESEND_TIMEOUT_MS, parseRetryAfter } from "@/lib/email/resend";
import { sendEmail, registerEmailSink, __setEmailTransportForTests } from "@/lib/email/index";
import type { SendEmailInput, SendEmailResult } from "@/lib/email/types";
import { makeEmailFetchFake } from "@/tests/helpers/email-fetch-fake";

// [IAM-0b] Resend por fetch (sin SDK) y `sendEmail`, el único punto de envío.
//
// Lo que fijan: (1) nada de esto tira — un mail que no sale nunca puede romper la
// action que lo dispara (una invitación ya creada, un reset ya emitido); (2) la
// key y el body de Resend no van al log; (3) el log dice qué pasó sin el
// destinatario completo ni el link (los logs de Vercel los lee cualquiera con
// acceso al proyecto y el link lleva el token); (4) el sink (EmailLog, IAM-1)
// recibe el resultado y el host del link.

const MSG = {
  from: "KineSoft <no-reply@mail.kinesoft.com.ar>",
  to: "ana@x.com",
  subject: "Asunto",
  html: '<a href="https://app.kinesoft.com.ar/x">x</a>',
  text: "https://app.kinesoft.com.ar/x",
  replyTo: "consultorio@x.com",
};

describe("sendViaResend", () => {
  afterEach(() => vi.useRealTimers());

  it("POST a api.resend.com con Bearer, payload completo y devuelve el id", async () => {
    const f = makeEmailFetchFake({ json: { id: "re_123" } });
    const r = await sendViaResend(MSG, { apiKey: "re_secret", fetchImpl: f.fetch });
    expect(r).toEqual({ ok: true, id: "re_123" });
    expect(RESEND_ENDPOINT).toBe("https://api.resend.com/emails");
    expect(f.calls[0].url).toBe(RESEND_ENDPOINT);
    expect(f.calls[0].init.method).toBe("POST");
    expect(f.calls[0].headers.authorization).toBe("Bearer re_secret");
    expect(f.calls[0].body).toEqual({
      from: MSG.from,
      to: ["ana@x.com"],
      subject: "Asunto",
      html: MSG.html,
      text: MSG.text,
      reply_to: "consultorio@x.com",
    });
  });

  it("sin replyTo no manda reply_to", async () => {
    const f = makeEmailFetchFake({ json: { id: "re_1" } });
    await sendViaResend({ ...MSG, replyTo: null }, { apiKey: "k", fetchImpl: f.fetch });
    expect(f.calls[0].body).not.toHaveProperty("reply_to");
  });

  it("idempotencyKey va en el header Idempotency-Key", async () => {
    const f = makeEmailFetchFake({ json: { id: "re_1" } });
    await sendViaResend({ ...MSG, idempotencyKey: "inv-1:3" }, { apiKey: "k", fetchImpl: f.fetch });
    expect(f.calls[0].headers["idempotency-key"]).toBe("inv-1:3");
  });

  it("200 sin id → ok con id null", async () => {
    const f = makeEmailFetchFake({ json: {} });
    expect(await sendViaResend(MSG, { apiKey: "k", fetchImpl: f.fetch })).toEqual({ ok: true, id: null });
  });

  it("429 → rate_limited con retryAfter (segundos)", async () => {
    const f = makeEmailFetchFake({ status: 429, json: { name: "rate_limit_exceeded" }, responseHeaders: { "retry-after": "2" } });
    expect(await sendViaResend(MSG, { apiKey: "k", fetchImpl: f.fetch })).toEqual({
      ok: false,
      reason: "rate_limited",
      status: 429,
      retryAfterSec: 2,
      errorName: "rate_limit_exceeded",
    });
  });

  it("4xx → provider_error con status y el nombre del error (nunca el body entero)", async () => {
    const f = makeEmailFetchFake({ status: 403, json: { name: "validation_error", message: "The kinesoft.app domain is not verified ana@x.com" } });
    const r = await sendViaResend(MSG, { apiKey: "k", fetchImpl: f.fetch });
    expect(r).toEqual({ ok: false, reason: "provider_error", status: 403, retryAfterSec: null, errorName: "validation_error" });
    expect(JSON.stringify(r)).not.toContain("ana@x.com");
  });

  it("5xx con body no-JSON → provider_error sin errorName", async () => {
    const f = makeEmailFetchFake({ status: 502 });
    expect(await sendViaResend(MSG, { apiKey: "k", fetchImpl: f.fetch })).toEqual({
      ok: false,
      reason: "provider_error",
      status: 502,
      retryAfterSec: null,
      errorName: null,
    });
  });

  it("red caída → network_error (no tira)", async () => {
    const f = makeEmailFetchFake({ rejectWith: new TypeError("fetch failed") });
    expect(await sendViaResend(MSG, { apiKey: "k", fetchImpl: f.fetch })).toEqual({ ok: false, reason: "network_error" });
  });

  it("Resend colgado → corta a los 5 s con timeout (AbortController)", async () => {
    vi.useFakeTimers();
    expect(RESEND_TIMEOUT_MS).toBe(5000);
    const f = makeEmailFetchFake({ delayMs: Infinity });
    const p = sendViaResend(MSG, { apiKey: "k", fetchImpl: f.fetch });
    await vi.advanceTimersByTimeAsync(4999);
    let settled = false;
    void p.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(await p).toEqual({ ok: false, reason: "timeout" });
    expect(f.calls[0].init.signal?.aborted).toBe(true);
  });

  it("sin key → no_api_key sin llamar a la red", async () => {
    const f = makeEmailFetchFake({ json: { id: "x" } });
    expect(await sendViaResend(MSG, { apiKey: "  ", fetchImpl: f.fetch })).toEqual({ ok: false, reason: "no_api_key" });
    expect(f.calls).toHaveLength(0);
  });

  it("parseRetryAfter: segundos, fecha HTTP o null", () => {
    expect(parseRetryAfter("3")).toBe(3);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("basura")).toBeNull();
    const now = Date.parse("2026-10-14T12:00:00Z");
    expect(parseRetryAfter("Wed, 14 Oct 2026 12:00:10 GMT", now)).toBe(10);
  });
});

// ── sendEmail ────────────────────────────────────────────────────────────────

const INPUT: SendEmailInput = {
  kind: "staff_invite",
  to: "juana.perez@gmail.com",
  subject: "Te invitaron a Consultorio Ramos",
  html: '<p>Hola</p><a href="https://app.kinesoft.com.ar/auth/confirm?token_hash=SECRETO123&amp;type=invite">Aceptar</a>',
  text: "Aceptar: https://app.kinesoft.com.ar/auth/confirm?token_hash=SECRETO123&type=invite",
  tenantId: "t1",
  entity: "Invitation",
  entityId: "inv1",
  fromName: "Consultorio Ramos",
  replyTo: "ramos@consultorio.com",
};

const ENV_KEYS = ["VERCEL_ENV", "EMAIL_TRANSPORT", "RESEND_API_KEY", "EMAIL_FROM", "EMAIL_REPLY_TO", "MAILPIT_URL"];

function captureStdout(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  return { lines, restore: () => spy.mockRestore() };
}

type SinkCall = { input: SendEmailInput; result: SendEmailResult; linkHost: string | null };

describe("sendEmail", () => {
  let out: ReturnType<typeof captureStdout>;
  let sinkCalls: SinkCall[];

  beforeEach(() => {
    for (const k of ENV_KEYS) vi.stubEnv(k, "");
    out = captureStdout();
    sinkCalls = [];
    registerEmailSink(async (input, result, linkHost) => {
      sinkCalls.push({ input, result, linkHost });
    });
  });
  afterEach(() => {
    out.restore();
    registerEmailSink(null);
    __setEmailTransportForTests(null);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function prod() {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("RESEND_API_KEY", "re_supersecreta");
    vi.stubEnv("EMAIL_FROM", "KineSoft <no-reply@mail.kinesoft.com.ar>");
  }

  it("Production: sale por Resend con remitente «X vía KineSoft», replyTo y el sink recibe el host", async () => {
    prod();
    const f = makeEmailFetchFake({ json: { id: "re_9" } });
    vi.stubGlobal("fetch", f.fetch);
    const r = await sendEmail(INPUT);
    expect(r).toEqual({ ok: true, transport: "resend", providerId: "re_9" });
    const body = f.calls[0].body as Record<string, unknown>;
    expect(body.from).toBe("Consultorio Ramos vía KineSoft <no-reply@mail.kinesoft.com.ar>");
    expect(body.to).toEqual(["juana.perez@gmail.com"]);
    expect(body.reply_to).toBe("ramos@consultorio.com");
    expect(sinkCalls).toHaveLength(1);
    expect(sinkCalls[0].result).toEqual(r);
    expect(sinkCalls[0].linkHost).toBe("app.kinesoft.com.ar");
    expect(sinkCalls[0].input.entityId).toBe("inv1");
  });

  it("el log dice email.sent sin el destinatario completo, sin el link ni el token y sin la key", async () => {
    prod();
    vi.stubGlobal("fetch", makeEmailFetchFake({ json: { id: "re_9" } }).fetch);
    await sendEmail(INPUT);
    const log = out.lines.join("");
    expect(log).toContain("email.sent");
    expect(log).toContain("j***@gmail.com");
    expect(log).not.toContain("juana.perez");
    expect(log).not.toContain("SECRETO123");
    expect(log).not.toContain("/auth/confirm");
    expect(log).not.toContain("re_supersecreta");
  });

  it("EMAIL_REPLY_TO es el default cuando el emisor no pasa replyTo", async () => {
    prod();
    vi.stubEnv("EMAIL_REPLY_TO", "soporte@kinesoft.app");
    const f = makeEmailFetchFake({ json: { id: "re_9" } });
    vi.stubGlobal("fetch", f.fetch);
    await sendEmail({ ...INPUT, replyTo: null });
    expect((f.calls[0].body as Record<string, unknown>).reply_to).toBe("soporte@kinesoft.app");
  });

  it("replyTo inválido se descarta (no rompe el envío)", async () => {
    prod();
    const f = makeEmailFetchFake({ json: { id: "re_9" } });
    vi.stubGlobal("fetch", f.fetch);
    const r = await sendEmail({ ...INPUT, replyTo: "no es un mail\r\nBcc: x@y.com" });
    expect(r.ok).toBe(true);
    expect(f.calls[0].body).not.toHaveProperty("reply_to");
  });

  it("Production con link a localhost → blocked, sin red, log email.blocked", async () => {
    prod();
    const f = makeEmailFetchFake({ json: { id: "x" } });
    vi.stubGlobal("fetch", f.fetch);
    const html = '<a href="http://localhost:3000/auth/confirm?token_hash=SECRETO123">x</a>';
    const r = await sendEmail({ ...INPUT, html, text: "" });
    expect(r).toEqual({ ok: false, transport: "blocked", skipped: false, reason: "unsafe_link_host" });
    expect(f.calls).toHaveLength(0);
    expect(sinkCalls[0].linkHost).toBe("localhost");
    expect(out.lines.join("")).toContain("email.blocked");
    expect(out.lines.join("")).not.toContain("SECRETO123");
  });

  it("Production sin key → log (skipped, no_api_key) y aviso", async () => {
    prod();
    vi.stubEnv("RESEND_API_KEY", "");
    const r = await sendEmail(INPUT);
    expect(r).toEqual({ ok: false, transport: "log", skipped: true, reason: "no_api_key" });
    expect(out.lines.join("")).toContain("email.skipped");
  });

  it("dev: log por defecto (skipped log_only), sin red", async () => {
    const f = makeEmailFetchFake({ json: { id: "x" } });
    vi.stubGlobal("fetch", f.fetch);
    const r = await sendEmail(INPUT);
    expect(r).toEqual({ ok: false, transport: "log", skipped: true, reason: "log_only" });
    expect(f.calls).toHaveLength(0);
    expect(sinkCalls).toHaveLength(1);
  });

  it("dev + mailpit: POST a MAILPIT_URL", async () => {
    vi.stubEnv("EMAIL_TRANSPORT", "mailpit");
    vi.stubEnv("MAILPIT_URL", "http://localhost:8025");
    const f = makeEmailFetchFake({ json: { ID: "mp_1" } });
    vi.stubGlobal("fetch", f.fetch);
    const r = await sendEmail(INPUT);
    expect(r).toEqual({ ok: true, transport: "mailpit", providerId: "mp_1" });
    expect(f.calls[0].url).toBe("http://localhost:8025/api/v1/send");
    expect((f.calls[0].body as { From: unknown }).From).toEqual({
      Name: "Consultorio Ramos vía KineSoft",
      Email: "no-reply@kinesoft.app",
    });
  });

  it("dev + mailpit caído → cae a log (skipped mailpit_unreachable)", async () => {
    vi.stubEnv("EMAIL_TRANSPORT", "mailpit");
    vi.stubGlobal("fetch", makeEmailFetchFake({ rejectWith: new TypeError("ECONNREFUSED") }).fetch);
    expect(await sendEmail(INPUT)).toEqual({ ok: false, transport: "log", skipped: true, reason: "mailpit_unreachable" });
  });

  it("Resend 429 → failed con status y reason rate_limited", async () => {
    prod();
    vi.stubGlobal("fetch", makeEmailFetchFake({ status: 429, responseHeaders: { "retry-after": "1" } }).fetch);
    const r = await sendEmail(INPUT);
    expect(r).toEqual({ ok: false, transport: "resend", skipped: false, reason: "rate_limited", status: 429 });
    expect(out.lines.join("")).toContain("email.failed");
  });

  it("Resend con la red caída → failed network_error, no tira", async () => {
    prod();
    vi.stubGlobal("fetch", makeEmailFetchFake({ rejectWith: new Error("boom") }).fetch);
    expect(await sendEmail(INPUT)).toEqual({ ok: false, transport: "resend", skipped: false, reason: "network_error" });
  });

  it.each(["", "no-es-mail", "a@b.com, c@d.com", "a@b.com\nBcc: c@d.com"])("to inválido %j → invalid_to, sin red", async (to) => {
    prod();
    const f = makeEmailFetchFake({ json: { id: "x" } });
    vi.stubGlobal("fetch", f.fetch);
    const r = await sendEmail({ ...INPUT, to });
    expect(r).toMatchObject({ ok: false, skipped: false, reason: "invalid_to" });
    expect(f.calls).toHaveLength(0);
  });

  it("un sink que tira no rompe el envío", async () => {
    registerEmailSink(async () => {
      throw new Error("EmailLog caído");
    });
    const r = await sendEmail(INPUT);
    expect(r.ok).toBe(false);
    expect(out.lines.join("")).toContain("email.sink_failed");
  });

  it("__setEmailTransportForTests: reemplaza el despacho y ve el input normalizado; sink y log siguen", async () => {
    const seen: SendEmailInput[] = [];
    __setEmailTransportForTests(async (i) => {
      seen.push(i);
      return { ok: true, transport: "log", providerId: "fake-1" };
    });
    const r = await sendEmail({ ...INPUT, to: "  juana.perez@gmail.com " });
    expect(r).toEqual({ ok: true, transport: "log", providerId: "fake-1" });
    expect(seen[0].to).toBe("juana.perez@gmail.com");
    expect(sinkCalls[0].result).toEqual(r);
  });

  it("un transporte de test que tira tampoco rompe: failed internal_error", async () => {
    __setEmailTransportForTests(async () => {
      throw new Error("x");
    });
    expect(await sendEmail(INPUT)).toMatchObject({ ok: false, skipped: false, reason: "internal_error" });
  });

  it("el bloqueo de Production corre ANTES del transporte de test", async () => {
    prod();
    const seen: SendEmailInput[] = [];
    __setEmailTransportForTests(async (i) => {
      seen.push(i);
      return { ok: true, transport: "log", providerId: null };
    });
    const r = await sendEmail({ ...INPUT, html: '<a href="http://127.0.0.1:3000/x">x</a>', text: "" });
    expect(r.transport).toBe("blocked");
    expect(seen).toHaveLength(0);
  });
});
