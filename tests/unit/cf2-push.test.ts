/**
 * [CF2-TP*] (CF2 §29, D-CF2-12, brief T.C «Push» y «Env»): avisos push web al profesional.
 *   [CF2-TP1] Env: forma de las 3 claves VAPID, «si hay una, las tres», Production sin ninguna = solo aviso.
 *   [CF2-TP2] `webPushVapid()` lee process.env en cada llamada; null si falta alguna o la forma no da.
 *   [CF2-TP3] `parsePushSubscriptionInput`: endpoint https ≤ 1024 de un servicio push conocido, claves como el CHECK de M21.
 *   [CF2-TP4] `pushDeviceLabel(ua)`: «Chrome en Android», ≤ 60 (CHECK de M21).
 *   [CF2-TP5] `pushSupportState(...)`: ready | needs-install-ios | unsupported | denied | granted.
 *   [CF2-TP6] `clampPushPayload`: recorta y nunca deja una URL fuera del origen.
 *   [CF2-TP7] `sendPushToUser` sin VAPID: {0,0,0} sin tocar la base ni importar `web-push`.
 * El envío con VAPID (borra 404/410, cuenta fallas, lastSuccessAt) va contra la base real en
 * `tests/integration/cf2-push-sender.test.ts`.
 */
import { createECDH } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEnv, webPushVapid } from "@/lib/env";
import {
  clampPushPayload,
  parsePushSubscriptionInput,
  pushDeviceLabel,
  pushSupportState,
  PUSH_LABEL_MAX,
  type PushSupportInput,
} from "@/lib/web-push-types";

const loads = vi.hoisted(() => ({ webPush: 0 }));
vi.mock("web-push", () => {
  loads.webPush += 1;
  return { default: { sendNotification: vi.fn() }, sendNotification: vi.fn() };
});
// Sin VAPID el sender no puede tocar la base: cualquier acceso al cliente service tira.
vi.mock("@/lib/db", () => ({
  prismaService: new Proxy({}, { get: () => { throw new Error("prismaService no se debía tocar"); } }),
  prisma: new Proxy({}, { get: () => { throw new Error("prisma no se debía tocar"); } }),
}));

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/** Par VAPID real (P-256): pública sin comprimir 65 B → 87 base64url que empieza con «B»; privada 32 B → 43. */
function vapidPair() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { pub: b64url(ecdh.getPublicKey()), priv: b64url(ecdh.getPrivateKey()) };
}
const { pub: PUB, priv: PRIV } = vapidPair();
const SUBJECT = "mailto:avisos@consultorio.online";

const PROD_OK = {
  VERCEL_ENV: "production",
  DATABASE_URL: "postgresql://app:x@pooler.supabase.com:6543/postgres",
  DIRECT_URL: "postgresql://owner:x@pooler.supabase.com:5432/postgres",
  NEXT_PUBLIC_SUPABASE_URL: "https://ref.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  NEXT_PUBLIC_APP_URL: "https://app.kinesoft.com.ar",
  RESEND_API_KEY: "re_test",
  EMAIL_FROM: "KineSoft <no-reply@mail.kinesoft.com.ar>",
};
const VAPID = { WEB_PUSH_VAPID_PUBLIC_KEY: PUB, WEB_PUSH_VAPID_PRIVATE_KEY: PRIV, WEB_PUSH_VAPID_SUBJECT: SUBJECT };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("[CF2-TP1] env VAPID · boot", () => {
  it("[CF2-TP1] las tres con forma válida pasan (recortadas); vacías = no seteadas", () => {
    const e = parseEnv({ ...VAPID, WEB_PUSH_VAPID_PUBLIC_KEY: `${PUB}\n` });
    expect(e.WEB_PUSH_VAPID_PUBLIC_KEY).toBe(PUB);
    expect(e.WEB_PUSH_VAPID_PRIVATE_KEY).toBe(PRIV);
    expect(e.WEB_PUSH_VAPID_SUBJECT).toBe(SUBJECT);
    expect(parseEnv({ ...VAPID, WEB_PUSH_VAPID_SUBJECT: "https://consultorio.online" }).WEB_PUSH_VAPID_SUBJECT).toBe(
      "https://consultorio.online"
    );
    const empty = parseEnv({ WEB_PUSH_VAPID_PUBLIC_KEY: "", WEB_PUSH_VAPID_PRIVATE_KEY: " ", WEB_PUSH_VAPID_SUBJECT: "" });
    expect(empty.WEB_PUSH_VAPID_PUBLIC_KEY).toBeUndefined();
    expect(empty.WEB_PUSH_VAPID_PRIVATE_KEY).toBeUndefined();
  });

  it("[CF2-TP1] forma inválida frena el boot en cualquier entorno, sin imprimir la clave", () => {
    const bad: [string, string][] = [
      ["WEB_PUSH_VAPID_PUBLIC_KEY", PUB.slice(1)], // 86
      ["WEB_PUSH_VAPID_PUBLIC_KEY", `A${PUB.slice(1)}`], // no es un punto sin comprimir (0x04 → «B»)
      ["WEB_PUSH_VAPID_PUBLIC_KEY", `${PUB.slice(0, 86)}+`], // base64 con «+», no url-safe
      ["WEB_PUSH_VAPID_PRIVATE_KEY", `${PRIV}=`],
      ["WEB_PUSH_VAPID_PRIVATE_KEY", PRIV.slice(2)],
      ["WEB_PUSH_VAPID_SUBJECT", "avisos@consultorio.online"],
      ["WEB_PUSH_VAPID_SUBJECT", "http://consultorio.online"],
      ["WEB_PUSH_VAPID_SUBJECT", "mailto:sin-arroba"],
    ];
    for (const [key, value] of bad) {
      for (const base of [{}, PROD_OK]) {
        let msg = "";
        try {
          parseEnv({ ...base, ...VAPID, [key]: value });
        } catch (err) {
          msg = (err as Error).message;
        }
        expect(msg, `${key}=${value}`).toMatch(new RegExp(key));
        if (key !== "WEB_PUSH_VAPID_SUBJECT") expect(msg).not.toContain(value);
      }
    }
  });

  it("[CF2-TP1] si hay una, las tres (falla en local, Preview y Production)", () => {
    for (const missing of Object.keys(VAPID)) {
      const partial = { ...VAPID, [missing]: undefined };
      for (const base of [{}, { VERCEL_ENV: "preview" }, PROD_OK]) {
        expect(() => parseEnv({ ...base, ...partial }), missing).toThrow(new RegExp(`${missing}: .*las tres`));
      }
    }
  });

  it("[CF2-TP1] Production sin ninguna arranca y lo avisa (RECOMMENDED_IN_PRODUCTION); con las tres no las nombra", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => parseEnv(PROD_OK)).not.toThrow();
    const without = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(without).toMatch(/WEB_PUSH_VAPID_PUBLIC_KEY/);
    spy.mockClear();
    expect(() => parseEnv({ ...PROD_OK, ...VAPID })).not.toThrow();
    expect(spy.mock.calls.map((c) => String(c[0])).join("\n")).not.toMatch(/WEB_PUSH_VAPID/);
  });

  it("[CF2-TP1] Preview y local sin VAPID no avisan nada", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => parseEnv({ VERCEL_ENV: "preview", PROD_SUPABASE_REF: "abcdefghijklmnopqrst" })).not.toThrow();
    expect(() => parseEnv({})).not.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("[CF2-TP2] webPushVapid() en caliente", () => {
  it("[CF2-TP2] lee process.env en cada llamada", () => {
    vi.stubEnv("WEB_PUSH_VAPID_PUBLIC_KEY", undefined);
    vi.stubEnv("WEB_PUSH_VAPID_PRIVATE_KEY", undefined);
    vi.stubEnv("WEB_PUSH_VAPID_SUBJECT", undefined);
    expect(webPushVapid()).toBeNull();
    vi.stubEnv("WEB_PUSH_VAPID_PUBLIC_KEY", ` ${PUB} `);
    vi.stubEnv("WEB_PUSH_VAPID_PRIVATE_KEY", PRIV);
    vi.stubEnv("WEB_PUSH_VAPID_SUBJECT", SUBJECT);
    expect(webPushVapid()).toEqual({ publicKey: PUB, privateKey: PRIV, subject: SUBJECT });
  });

  it("[CF2-TP2] null si falta una o la forma no da (el boot ya lo rechazó; acá no se tira)", () => {
    vi.stubEnv("WEB_PUSH_VAPID_PUBLIC_KEY", PUB);
    vi.stubEnv("WEB_PUSH_VAPID_PRIVATE_KEY", PRIV);
    vi.stubEnv("WEB_PUSH_VAPID_SUBJECT", "");
    expect(webPushVapid()).toBeNull();
    vi.stubEnv("WEB_PUSH_VAPID_SUBJECT", SUBJECT);
    vi.stubEnv("WEB_PUSH_VAPID_PRIVATE_KEY", "corta");
    expect(webPushVapid()).toBeNull();
  });
});

// p256dh real: 65 B → 87 base64url; auth 16 B → 22.
const P256DH = b64url(Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 9)]));
const AUTH = b64url(Buffer.alloc(16, 3));
const FCM = "https://fcm.googleapis.com/fcm/send/abc:APA91b-xyz";

describe("[CF2-TP3] parsePushSubscriptionInput", () => {
  it("[CF2-TP3] acepta el toJSON() de PushSubscription de cada servicio push conocido", () => {
    for (const endpoint of [
      FCM,
      "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
      "https://web.push.apple.com/QGuQyavXutnMH",
      "https://wns2-par02p.notify.windows.com/w/?token=BQYAAA",
    ]) {
      const r = parsePushSubscriptionInput({ endpoint, expirationTime: null, keys: { p256dh: P256DH, auth: AUTH } });
      expect(r, endpoint).toEqual({ ok: true, value: { endpoint, keys: { p256dh: P256DH, auth: AUTH } } });
    }
    // El CHECK admite relleno «=» al final.
    expect(parsePushSubscriptionInput({ endpoint: FCM, keys: { p256dh: `${P256DH}=`, auth: `${AUTH}==` } }).ok).toBe(true);
  });

  it("[CF2-TP3] rechaza forma, endpoint y claves como el CHECK de M21 (y servicios que no son push)", () => {
    const keys = { p256dh: P256DH, auth: AUTH };
    const cases: [unknown, string][] = [
      [null, "shape"],
      ["x", "shape"],
      [{ endpoint: FCM }, "shape"],
      [{ endpoint: 1, keys }, "shape"],
      [{ endpoint: FCM, keys: { p256dh: P256DH } }, "shape"],
      [{ endpoint: "http://fcm.googleapis.com/fcm/send/a", keys }, "endpoint"],
      [{ endpoint: `https://fcm.googleapis.com/${"a".repeat(1000)}`, keys }, "endpoint"],
      [{ endpoint: "https://localhost/push", keys }, "endpoint"],
      [{ endpoint: "https://10.0.0.5/push", keys }, "endpoint"],
      [{ endpoint: "https://evil.example.com/fcm.googleapis.com", keys }, "endpoint"],
      [{ endpoint: "https://fcm.googleapis.com.evil.com/a", keys }, "endpoint"],
      [{ endpoint: "https://user:pw@fcm.googleapis.com/a", keys }, "endpoint"],
      [{ endpoint: "no es url", keys }, "endpoint"],
      [{ endpoint: FCM, keys: { p256dh: P256DH.slice(0, 70), auth: AUTH } }, "keys"],
      [{ endpoint: FCM, keys: { p256dh: P256DH.replace(/.$/, "+"), auth: AUTH } }, "keys"],
      [{ endpoint: FCM, keys: { p256dh: P256DH, auth: "a".repeat(15) } }, "keys"],
      [{ endpoint: FCM, keys: { p256dh: P256DH, auth: "a".repeat(33) } }, "keys"],
    ];
    for (const [raw, reason] of cases) {
      expect(parsePushSubscriptionInput(raw), JSON.stringify(raw)?.slice(0, 80)).toEqual({ ok: false, reason });
    }
  });
});

describe("[CF2-TP4] pushDeviceLabel", () => {
  const UA = {
    chromeAndroid:
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
    samsung:
      "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
    safariIphone:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
    pwaIphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
    edgeWin:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
    firefoxMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:132.0) Gecko/20100101 Firefox/132.0",
    safariMac:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
    chromeLinux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    operaWin:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 OPR/114.0.0.0",
    chromeIpad: "Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1",
  };
  it("[CF2-TP4] «<navegador> en <sistema>»", () => {
    expect(pushDeviceLabel(UA.chromeAndroid)).toBe("Chrome en Android");
    expect(pushDeviceLabel(UA.samsung)).toBe("Samsung Internet en Android");
    expect(pushDeviceLabel(UA.safariIphone)).toBe("Safari en iPhone");
    expect(pushDeviceLabel(UA.pwaIphone)).toBe("Safari en iPhone");
    expect(pushDeviceLabel(UA.edgeWin)).toBe("Edge en Windows");
    expect(pushDeviceLabel(UA.firefoxMac)).toBe("Firefox en Mac");
    expect(pushDeviceLabel(UA.safariMac)).toBe("Safari en Mac");
    expect(pushDeviceLabel(UA.chromeLinux)).toBe("Chrome en Linux");
    expect(pushDeviceLabel(UA.operaWin)).toBe("Opera en Windows");
    expect(pushDeviceLabel(UA.chromeIpad)).toBe("Chrome en iPad");
  });
  it("[CF2-TP4] sin datos o raro: nunca vacío y ≤ 60 (CHECK de M21)", () => {
    expect(pushDeviceLabel(null)).toBe("Navegador");
    expect(pushDeviceLabel("")).toBe("Navegador");
    expect(pushDeviceLabel("curl/8.0")).toBe("Navegador");
    expect(pushDeviceLabel("Foo (Windows NT 10.0)")).toBe("Navegador en Windows");
    expect(pushDeviceLabel("x".repeat(5000)).length).toBeLessThanOrEqual(PUSH_LABEL_MAX);
  });
});

describe("[CF2-TP5] pushSupportState", () => {
  const ANDROID = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36";
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Version/18.1 Mobile Safari/604.1";
  const IPAD_DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.1 Safari/605.1.15";
  const full: PushSupportInput = {
    userAgent: ANDROID,
    maxTouchPoints: 5,
    standalone: false,
    hasServiceWorker: true,
    hasPushManager: true,
    hasNotification: true,
    permission: "default",
  };
  it("[CF2-TP5] permiso sin pedir → ready; concedido → granted; negado → denied", () => {
    expect(pushSupportState(full)).toBe("ready");
    expect(pushSupportState({ ...full, permission: "granted" })).toBe("granted");
    expect(pushSupportState({ ...full, permission: "denied" })).toBe("denied");
  });
  it("[CF2-TP5] iPhone/iPad en una pestaña (sin instalar) → needs-install-ios, aunque falte PushManager", () => {
    const tab = { ...full, userAgent: IPHONE, hasPushManager: false, hasNotification: false };
    expect(pushSupportState(tab)).toBe("needs-install-ios");
    // iPadOS se presenta como Mac: lo delata el táctil.
    expect(pushSupportState({ ...tab, userAgent: IPAD_DESKTOP })).toBe("needs-install-ios");
    // Una Mac de verdad (sin táctil) con Safari no es iOS.
    expect(pushSupportState({ ...full, userAgent: IPAD_DESKTOP, maxTouchPoints: 0 })).toBe("ready");
    // Instalada (iOS ≥ 16.4) funciona como cualquiera; instalada en un iOS viejo, sin PushManager → unsupported.
    expect(pushSupportState({ ...full, userAgent: IPHONE, standalone: true })).toBe("ready");
    expect(pushSupportState({ ...tab, standalone: true })).toBe("unsupported");
  });
  it("[CF2-TP5] sin service worker, PushManager o Notification → unsupported (antes que el permiso)", () => {
    for (const k of ["hasServiceWorker", "hasPushManager", "hasNotification"] as const) {
      expect(pushSupportState({ ...full, [k]: false, permission: "granted" }), k).toBe("unsupported");
    }
  });
});

describe("[CF2-TP6] clampPushPayload", () => {
  it("[CF2-TP6] recorta título/cuerpo/tag y deja la URL solo si es del mismo origen", () => {
    const p = clampPushPayload({ title: "t".repeat(500), body: "b".repeat(2000), url: "/agenda?date=2026-11-03", tag: "g".repeat(200) });
    expect(p.title.length).toBeLessThanOrEqual(80);
    expect(p.body.length).toBeLessThanOrEqual(160);
    expect(p.tag!.length).toBeLessThanOrEqual(64);
    expect(p.url).toBe("/agenda?date=2026-11-03");
    for (const url of ["https://evil.com", "//evil.com/x", "javascript:alert(1)", "", "/\\evil.com"]) {
      expect(clampPushPayload({ title: "a", body: "b", url }).url, url).toBe("/dashboard");
    }
    expect(clampPushPayload({ title: "a", body: "b", url: "/x" })).not.toHaveProperty("tag");
  });
});

describe("[CF2-TP7] sendPushToUser sin VAPID", () => {
  it("[CF2-TP7] devuelve 0/0/0 sin tocar la base ni cargar web-push", async () => {
    vi.stubEnv("WEB_PUSH_VAPID_PUBLIC_KEY", undefined);
    vi.stubEnv("WEB_PUSH_VAPID_PRIVATE_KEY", undefined);
    vi.stubEnv("WEB_PUSH_VAPID_SUBJECT", undefined);
    const { sendPushToUser } = await import("@/lib/web-push-internal");
    await expect(sendPushToUser("user-1", { title: "a", body: "b", url: "/agenda" })).resolves.toEqual({
      sent: 0,
      removed: 0,
      failed: 0,
    });
    expect(loads.webPush).toBe(0);
  });

  it("[CF2-TP7] web-push solo entra por import() dinámico (nunca estático: no infla el bundle server ni el boot)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("lib/web-push-internal.ts", "utf8");
    expect(src).toMatch(/^import "server-only";/m);
    expect(src).not.toMatch(/^import[^\n]*from "web-push"/m);
    expect(src).toMatch(/import\("web-push"\)/);
    const types = readFileSync("lib/web-push-types.ts", "utf8");
    expect(types).not.toMatch(/^import /m);
  });
});
