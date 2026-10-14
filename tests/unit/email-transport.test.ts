import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import {
  decideEmailTransport,
  resolveBaseFrom,
  composeFrom,
  sanitizeFromName,
  fromAddress,
  localLinkHostIn,
  firstLinkHost,
  isLocalHost,
  maskEmail,
  normalizeEmailAddress,
  DEFAULT_EMAIL_FROM,
} from "@/lib/email/transport";
import { sendViaMailpit, mailpitBaseUrl, MAILPIT_DEFAULT_URL, parseMailbox } from "@/lib/email/mailpit";
import { makeEmailFetchFake } from "@/tests/helpers/email-fetch-fake";

// [IAM-0b] Por dónde sale un mail según el entorno (C-IAM1).
//
// La regla que fijan estos tests: Production con key y remitente → Resend;
// Production sin config → log (con aviso), nunca un 422 de Resend con un dominio
// sin verificar; Preview → log (los Preview de Vercel corren contra la base de
// prod y no pueden mandar mails reales a pacientes); dev/test → log o Mailpit,
// y Resend solo con EMAIL_TRANSPORT=resend explícito. Y la barrera de Traze: en
// Production un mail con un link a localhost NO sale (`blocked`): no le sirve a
// nadie y viaja con el token adentro.

type Env = Record<string, string | undefined>;

const PROD: Env = {
  NODE_ENV: "production",
  VERCEL_ENV: "production",
  RESEND_API_KEY: "re_test_key",
  EMAIL_FROM: "KineSoft <no-reply@mail.kinesoft.com.ar>",
};
const PREVIEW: Env = { ...PROD, VERCEL_ENV: "preview" };
const DEV: Env = { NODE_ENV: "development" };
const TEST: Env = { NODE_ENV: "test" };

const SAFE = { html: '<a href="https://app.kinesoft.com.ar/invite/abc">x</a>', text: "https://app.kinesoft.com.ar/invite/abc" };
const LOCAL_HTML = { html: '<a href="http://localhost:3000/auth/confirm?token_hash=abc">x</a>', text: "" };

describe("decideEmailTransport — la matriz", () => {
  it.each<[string, Env, string]>([
    ["Production con key y remitente", PROD, "resend"],
    ["Production ignora EMAIL_TRANSPORT=log", { ...PROD, EMAIL_TRANSPORT: "log" }, "resend"],
    ["Production ignora EMAIL_TRANSPORT=mailpit", { ...PROD, EMAIL_TRANSPORT: "mailpit" }, "resend"],
    ["Production sin key → log", { ...PROD, RESEND_API_KEY: undefined }, "log"],
    ["Production con key vacía → log", { ...PROD, RESEND_API_KEY: "  " }, "log"],
    ["Production sin EMAIL_FROM → log", { ...PROD, EMAIL_FROM: undefined }, "log"],
    ["Preview → log", PREVIEW, "log"],
    ["Preview con EMAIL_TRANSPORT=resend → log igual", { ...PREVIEW, EMAIL_TRANSPORT: "resend" }, "log"],
    ["Preview con EMAIL_TRANSPORT=mailpit → log (no hay Mailpit en Vercel)", { ...PREVIEW, EMAIL_TRANSPORT: "mailpit" }, "log"],
    ["dev sin nada → log", DEV, "log"],
    ["dev con la key de prod colada → log", { ...DEV, RESEND_API_KEY: "re_prod" }, "log"],
    ["dev + EMAIL_TRANSPORT=mailpit", { ...DEV, EMAIL_TRANSPORT: "mailpit" }, "mailpit"],
    ["dev + EMAIL_TRANSPORT en mayúsculas", { ...DEV, EMAIL_TRANSPORT: " MAILPIT " }, "mailpit"],
    ["dev + EMAIL_TRANSPORT desconocido → log", { ...DEV, EMAIL_TRANSPORT: "smtp" }, "log"],
    ["dev + EMAIL_TRANSPORT=resend con key → resend (opt-in explícito)", { ...DEV, EMAIL_TRANSPORT: "resend", RESEND_API_KEY: "re_x" }, "resend"],
    ["dev + EMAIL_TRANSPORT=resend sin key → log", { ...DEV, EMAIL_TRANSPORT: "resend" }, "log"],
    ["next start local (NODE_ENV=production sin VERCEL_ENV) → log", { ...PROD, VERCEL_ENV: undefined }, "log"],
    ["test → log", TEST, "log"],
    ["test + mailpit", { ...TEST, EMAIL_TRANSPORT: "mailpit" }, "mailpit"],
    ["test + resend con key → log (los tests nunca mandan)", { ...TEST, EMAIL_TRANSPORT: "resend", RESEND_API_KEY: "re_x" }, "log"],
  ])("%s → %s", (_name, env, expected) => {
    expect(decideEmailTransport(env, SAFE).transport).toBe(expected);
  });

  it("los motivos del log son legibles (no tienen la key)", () => {
    const noKey = decideEmailTransport({ ...PROD, RESEND_API_KEY: undefined }, SAFE);
    expect(noKey.reason).toBe("no_api_key");
    const noFrom = decideEmailTransport({ ...PROD, EMAIL_FROM: undefined }, SAFE);
    expect(noFrom.reason).toBe("no_from");
    expect(decideEmailTransport(PREVIEW, SAFE).reason).toBe("log_only");
    for (const env of [PROD, PREVIEW, DEV]) {
      expect(decideEmailTransport(env, SAFE).why).not.toContain("re_test_key");
    }
  });

  it("ningún entorno que no sea Production o un opt-in de dev da resend", () => {
    for (const NODE_ENV of ["development", "production", "test", undefined]) {
      for (const VERCEL_ENV of [undefined, "preview", "development"]) {
        for (const EMAIL_TRANSPORT of [undefined, "log", "mailpit", "RESEND", "smtp"]) {
          const env = { NODE_ENV, VERCEL_ENV, EMAIL_TRANSPORT, RESEND_API_KEY: "re_x", EMAIL_FROM: PROD.EMAIL_FROM };
          const got = decideEmailTransport(env, SAFE).transport;
          const optIn = NODE_ENV !== "test" && VERCEL_ENV !== "preview" && EMAIL_TRANSPORT === "RESEND";
          if (!optIn) expect(got, JSON.stringify(env)).not.toBe("resend");
        }
      }
    }
  });
});

describe("blocked — links a localhost", () => {
  it.each<[string, { html: string; text: string }]>([
    ["href a localhost", LOCAL_HTML],
    ["href a 127.0.0.1", { html: '<a href="http://127.0.0.1:3000/x">x</a>', text: "" }],
    ["href a 127.1.2.3", { html: '<a href="http://127.1.2.3/x">x</a>', text: "" }],
    ["href a 0.0.0.0", { html: '<a href="http://0.0.0.0:3000/x">x</a>', text: "" }],
    ["href a [::1]", { html: '<a href="http://[::1]:3000/x">x</a>', text: "" }],
    ["subdominio .localhost", { html: '<a href="http://app.localhost/x">x</a>', text: "" }],
    ["LOCALHOST en mayúsculas", { html: '<a href="HTTP://LOCALHOST:3000/x">x</a>', text: "" }],
    ["solo en la parte de texto", { html: "<p>hola</p>", text: "Entrá: http://localhost:3000/invite/abc" }],
    ["link de respaldo en el html (fuera de un href)", { html: "<p>http://localhost:3000/x</p>", text: "" }],
    ["href escapado (&amp;) a localhost", { html: '<a href="http://localhost:3000/a?x=1&amp;y=2">x</a>', text: "" }],
  ])("Production: %s → blocked", (_n, msg) => {
    const d = decideEmailTransport(PROD, msg);
    expect(d.transport).toBe("blocked");
    expect(d.reason).toBe("unsafe_link_host");
  });

  it("Production sin key igual bloquea (blocked gana sobre log: es un error de config que tiene que verse)", () => {
    expect(decideEmailTransport({ ...PROD, RESEND_API_KEY: undefined }, LOCAL_HTML).transport).toBe("blocked");
  });

  it("Production con links reales no bloquea", () => {
    expect(decideEmailTransport(PROD, SAFE).transport).toBe("resend");
  });

  it("un host que solo EMPIEZA con localhost no es local", () => {
    const msg = { html: '<a href="https://localhost.example.com/x">x</a>', text: "" };
    expect(decideEmailTransport(PROD, msg).transport).toBe("resend");
  });

  it("dev con opt-in de Resend y link local → blocked (el incidente de Traze: mails reales a localhost)", () => {
    const env = { ...DEV, EMAIL_TRANSPORT: "resend", RESEND_API_KEY: "re_x" };
    expect(decideEmailTransport(env, LOCAL_HTML).transport).toBe("blocked");
  });

  it("dev con mailpit o log y link local sale normal (no sale de la máquina)", () => {
    expect(decideEmailTransport({ ...DEV, EMAIL_TRANSPORT: "mailpit" }, LOCAL_HTML).transport).toBe("mailpit");
    expect(decideEmailTransport(DEV, LOCAL_HTML).transport).toBe("log");
  });

  it("Preview con link local: log, no blocked (no sale nada de todos modos)", () => {
    expect(decideEmailTransport(PREVIEW, LOCAL_HTML).transport).toBe("log");
  });
});

describe("helpers de hosts", () => {
  it("isLocalHost", () => {
    for (const h of ["localhost", "127.0.0.1", "127.9.9.9", "0.0.0.0", "::1", "foo.localhost"]) {
      expect(isLocalHost(h), h).toBe(true);
    }
    for (const h of ["kinesoft.vercel.app", "localhost.example.com", "10.0.0.1", "128.0.0.1"]) {
      expect(isLocalHost(h), h).toBe(false);
    }
  });
  it("localLinkHostIn devuelve el host local o null", () => {
    expect(localLinkHostIn("ver http://localhost:3000/x y https://a.com")).toBe("localhost");
    expect(localLinkHostIn("solo https://app.kinesoft.com.ar/x")).toBeNull();
  });
  it("firstLinkHost: host del primer href, sin path ni query", () => {
    const html = '<p>x</p><a href="https://app.kinesoft.com.ar/auth/confirm?token_hash=abc&amp;type=invite">a</a><a href="https://otro.com">b</a>';
    expect(firstLinkHost(html)).toBe("app.kinesoft.com.ar");
    expect(firstLinkHost("<p>sin links</p>")).toBeNull();
    expect(firstLinkHost('<a href="mailto:x@y.com">x</a>')).toBeNull();
  });
});

describe("remitente «Consultorio X vía KineSoft»", () => {
  it("sin fromName: el EMAIL_FROM tal cual", () => {
    expect(composeFrom("KineSoft <no-reply@kinesoft.app>", null)).toBe("KineSoft <no-reply@kinesoft.app>");
  });
  it("con fromName: nombre + sufijo fijo + la MISMA casilla", () => {
    expect(composeFrom("KineSoft <no-reply@kinesoft.app>", "Consultorio Ramos")).toBe(
      "Consultorio Ramos vía KineSoft <no-reply@kinesoft.app>",
    );
  });
  it("EMAIL_FROM sin nombre también sirve de base", () => {
    expect(composeFrom("no-reply@kinesoft.app", "Kine Sur")).toBe("Kine Sur vía KineSoft <no-reply@kinesoft.app>");
  });
  it("nombre con caracteres especiales del RFC 5322 → display-name entre comillas", () => {
    expect(composeFrom("KineSoft <no-reply@kinesoft.app>", "Kine S.A., Sede Centro")).toBe(
      '"Kine S.A., Sede Centro vía KineSoft" <no-reply@kinesoft.app>',
    );
  });
  it("saneado: sin comillas, <>, barra invertida ni saltos (inyección de cabeceras)", () => {
    const evil = 'Consultorio "X"\r\nBcc: todos@evil.com <a@b.c>\\';
    const out = composeFrom("KineSoft <no-reply@kinesoft.app>", evil);
    expect(out).not.toMatch(/[\r\n]/);
    expect(out.match(/</g)?.length).toBe(1);
    expect(out.endsWith("vía KineSoft <no-reply@kinesoft.app>") || out.endsWith('vía KineSoft" <no-reply@kinesoft.app>')).toBe(true);
    expect(sanitizeFromName(evil)).toBe("Consultorio X Bcc: todos@evil.com a@b.c");
  });
  it("nombre vacío o solo basura → remitente de siempre", () => {
    expect(composeFrom("KineSoft <no-reply@kinesoft.app>", ' "<>" ')).toBe("KineSoft <no-reply@kinesoft.app>");
  });
  it("nombre largo se corta con «…»", () => {
    const name = sanitizeFromName("A".repeat(200));
    expect(name.length).toBe(64);
    expect(name.endsWith("…")).toBe(true);
  });
  it("fromAddress", () => {
    expect(fromAddress("KineSoft <no-reply@kinesoft.app>")).toBe("no-reply@kinesoft.app");
    expect(fromAddress(" no-reply@kinesoft.app ")).toBe("no-reply@kinesoft.app");
  });
  it("resolveBaseFrom: default solo fuera de Production; limpia comillas y comas pegadas", () => {
    expect(resolveBaseFrom(DEV)).toBe(DEFAULT_EMAIL_FROM);
    expect(DEFAULT_EMAIL_FROM).toBe("KineSoft <no-reply@kinesoft.app>");
    expect(resolveBaseFrom({ ...PROD, EMAIL_FROM: undefined })).toBeNull();
    expect(resolveBaseFrom({ ...DEV, EMAIL_FROM: '"KineSoft <hola@kine.ar>",' })).toBe("KineSoft <hola@kine.ar>");
  });
});

describe("destinatario", () => {
  it("normalizeEmailAddress acepta un email y rechaza listas, saltos y basura", () => {
    expect(normalizeEmailAddress("  Ana.Perez+kine@Gmail.com ")).toBe("Ana.Perez+kine@Gmail.com");
    for (const bad of ["", "ana", "ana@", "@x.com", "a@b", "a@b.com, c@d.com", "a@b.com\r\nBcc: x@y.com", "a b@c.com", `${"a".repeat(250)}@b.com`]) {
      expect(normalizeEmailAddress(bad), bad).toBeNull();
    }
  });
  it("maskEmail: inicial + *** + dominio", () => {
    expect(maskEmail("juana.perez@gmail.com")).toBe("j***@gmail.com");
    expect(maskEmail("x")).toBe("***");
  });
});

describe("mailpit (API HTTP, no SMTP)", () => {
  afterEach(() => vi.useRealTimers());
  const MSG = {
    from: "Consultorio Ramos vía KineSoft <no-reply@kinesoft.app>",
    to: "ana@x.com",
    replyTo: "ramos@consultorio.com",
    subject: "Asunto",
    html: "<p>h</p>",
    text: "t",
  };

  it("base URL: MAILPIT_URL o el default 8025, sin barra final", () => {
    expect(MAILPIT_DEFAULT_URL).toBe("http://localhost:8025");
    expect(mailpitBaseUrl({})).toBe("http://localhost:8025");
    expect(mailpitBaseUrl({ MAILPIT_URL: "http://127.0.0.1:18025/" })).toBe("http://127.0.0.1:18025");
  });

  it("parseMailbox", () => {
    expect(parseMailbox("Kine Sur vía KineSoft <a@b.com>")).toEqual({ Name: "Kine Sur vía KineSoft", Email: "a@b.com" });
    expect(parseMailbox('"Kine, S.A." <a@b.com>')).toEqual({ Name: "Kine, S.A.", Email: "a@b.com" });
    expect(parseMailbox("a@b.com")).toEqual({ Email: "a@b.com" });
  });

  it("POST /api/v1/send con From/To/ReplyTo/HTML/Text y devuelve el ID", async () => {
    const f = makeEmailFetchFake({ json: { ID: "mp-1" } });
    const r = await sendViaMailpit(MSG, { baseUrl: "http://localhost:8025", fetchImpl: f.fetch });
    expect(r).toEqual({ ok: true, id: "mp-1" });
    expect(f.calls[0].url).toBe("http://localhost:8025/api/v1/send");
    expect(f.calls[0].body).toEqual({
      From: { Name: "Consultorio Ramos vía KineSoft", Email: "no-reply@kinesoft.app" },
      To: [{ Email: "ana@x.com" }],
      ReplyTo: [{ Email: "ramos@consultorio.com" }],
      Subject: "Asunto",
      HTML: "<p>h</p>",
      Text: "t",
    });
  });

  it("Mailpit caído → unreachable (no tira)", async () => {
    const f = makeEmailFetchFake({ rejectWith: new TypeError("fetch failed") });
    expect(await sendViaMailpit(MSG, { fetchImpl: f.fetch })).toEqual({ ok: false, reason: "mailpit_unreachable" });
  });

  it("Mailpit colgado → unreachable por timeout", async () => {
    vi.useFakeTimers();
    const f = makeEmailFetchFake({ delayMs: Infinity });
    const p = sendViaMailpit(MSG, { fetchImpl: f.fetch, timeoutMs: 3000 });
    await vi.advanceTimersByTimeAsync(3001);
    expect(await p).toEqual({ ok: false, reason: "mailpit_unreachable" });
  });

  it("Mailpit rechaza (4xx) → provider_error con status", async () => {
    const f = makeEmailFetchFake({ status: 400, json: { error: "bad" } });
    expect(await sendViaMailpit(MSG, { fetchImpl: f.fetch })).toEqual({ ok: false, reason: "provider_error", status: 400 });
  });
});

// Guard estático (C-IAM1): `api.resend.com` vive en UN solo archivo. Así ningún
// emisor nuevo se saltea el transporte (y con él el bloqueo de localhost, el
// timeout y el log enmascarado) llamando a Resend directo.
describe("guard: solo lib/email/resend.ts conoce api.resend.com", () => {
  const ROOT = path.resolve(__dirname, "../..");
  const DIRS = ["app", "lib", "components", "scripts", "prisma"];
  const EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

  function walk(dir: string, out: string[]) {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (EXT.test(e.name)) out.push(p);
    }
  }

  it("ningún otro archivo de código lo menciona", () => {
    const files: string[] = [];
    for (const d of DIRS) walk(path.join(ROOT, d), files);
    for (const f of fs.readdirSync(ROOT)) if (EXT.test(f)) files.push(path.join(ROOT, f));
    const hits = files
      .filter((f) => fs.readFileSync(f, "utf8").includes("api.resend.com"))
      .map((f) => path.relative(ROOT, f));
    expect(hits).toEqual(["lib/email/resend.ts"]);
  });
});
