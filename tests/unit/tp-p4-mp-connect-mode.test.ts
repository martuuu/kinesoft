/**
 * [TP-P4] Modo de Mercado Pago (C-TP2, plan §25.4 «Modos»). Lo que se prueba es que el simulador (`fake`) no pueda
 * llegar nunca a un deploy de Vercel: el boot lo rechaza y, si igual llegara (otra ruta de arranque, env cambiado en
 * caliente), el getter lo trata como `off`. Y que Production con `sandbox`/`live` no arranque a medias (sin
 * credenciales de la app, sin claves del cifrado o sin el secreto del webhook con firma obligatoria).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeMpAllowed, mpConnectMode, mpConnectSignatureMode, parseEnv } from "@/lib/env";

const PROD_OK = {
  VERCEL_ENV: "production",
  DATABASE_URL: "postgresql://app:x@pooler.supabase.com:6543/postgres",
  DIRECT_URL: "postgresql://owner:x@pooler.supabase.com:5432/postgres",
  NEXT_PUBLIC_SUPABASE_URL: "https://ref.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  NEXT_PUBLIC_APP_URL: "https://app.kinesoft.com.ar",
};
// Claves de prueba (32 bytes de ceros / de unos en base64): nunca una clave real.
const KEY_A = Buffer.alloc(32, 0).toString("base64");
const KEY_B = Buffer.alloc(32, 1).toString("base64");
const MP_PROD = {
  MP_OAUTH_CLIENT_ID: "123",
  MP_OAUTH_CLIENT_SECRET: "app-secret",
  SECRET_BOX_KEYS: `k2:${KEY_B},k1:${KEY_A}`,
  MP_CONNECT_WEBHOOK_SECRET: "hook-secret",
};
const quiet = () => {
  const e = vi.spyOn(console, "error").mockImplementation(() => {});
  const w = vi.spyOn(console, "warn").mockImplementation(() => {});
  return () => {
    e.mockRestore();
    w.mockRestore();
  };
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("[TP-P4] Modo y fake", () => {
  it("[TP-P4] MP_CONNECT_MODE default off y un typo frena el boot", () => {
    expect(parseEnv({}).MP_CONNECT_MODE).toBe("off");
    expect(parseEnv({ MP_CONNECT_MODE: "" }).MP_CONNECT_MODE).toBe("off");
    expect(parseEnv({ MP_CONNECT_MODE: " Sandbox\n" }).MP_CONNECT_MODE).toBe("sandbox");
    for (const m of ["off", "fake", "sandbox", "live"] as const) expect(parseEnv({ MP_CONNECT_MODE: m }).MP_CONNECT_MODE).toBe(m);
    expect(() => parseEnv({ MP_CONNECT_MODE: "prod" })).toThrow(/MP_CONNECT_MODE/);
    expect(() => parseEnv({ MP_CONNECT_MODE: "on" })).toThrow(/MP_CONNECT_MODE/);
    // La firma: default required; typo frena.
    expect(parseEnv({}).MP_CONNECT_WEBHOOK_SIGNATURE).toBe("required");
    expect(parseEnv({ MP_CONNECT_WEBHOOK_SIGNATURE: "Fetch-Only" }).MP_CONNECT_WEBHOOK_SIGNATURE).toBe("fetch-only");
    expect(() => parseEnv({ MP_CONNECT_WEBHOOK_SIGNATURE: "none" })).toThrow(/MP_CONNECT_WEBHOOK_SIGNATURE/);
    // Getters en caliente: inválido o vacío → off / required (el boot ya lo rechazó; acá no se tira).
    vi.stubEnv("VERCEL_ENV", undefined);
    vi.stubEnv("VERCEL", undefined);
    vi.stubEnv("MP_CONNECT_MODE", "");
    expect(mpConnectMode()).toBe("off");
    vi.stubEnv("MP_CONNECT_MODE", "cualquiera");
    expect(mpConnectMode()).toBe("off");
    vi.stubEnv("MP_CONNECT_MODE", " LIVE ");
    expect(mpConnectMode()).toBe("live");
    vi.stubEnv("MP_CONNECT_WEBHOOK_SIGNATURE", "fetch-only");
    expect(mpConnectSignatureMode()).toBe("fetch-only");
    vi.stubEnv("MP_CONNECT_WEBHOOK_SIGNATURE", "otra");
    expect(mpConnectSignatureMode()).toBe("required");
  });

  it("[TP-P4] fake + VERCEL_ENV frena el boot y el getter da off", () => {
    expect(parseEnv({ MP_CONNECT_MODE: "fake" }).MP_CONNECT_MODE).toBe("fake");
    for (const vercelEnv of ["production", "preview", "development"]) {
      expect(() => parseEnv({ MP_CONNECT_MODE: "fake", VERCEL_ENV: vercelEnv })).toThrow(/MP_CONNECT_MODE/);
    }
    // `VERCEL=1` solo (sin VERCEL_ENV, p. ej. un build en Vercel con el entorno a medias) también frena.
    expect(() => parseEnv({ MP_CONNECT_MODE: "fake", VERCEL: "1" })).toThrow(/MP_CONNECT_MODE/);
    // Getter: fake solo sin ninguna de las dos.
    vi.stubEnv("VERCEL_ENV", undefined);
    vi.stubEnv("VERCEL", undefined);
    vi.stubEnv("MP_CONNECT_MODE", "fake");
    expect(mpConnectMode()).toBe("fake");
    expect(fakeMpAllowed()).toBe(true);
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(mpConnectMode()).toBe("off");
    expect(fakeMpAllowed()).toBe(false);
    vi.stubEnv("VERCEL_ENV", undefined);
    vi.stubEnv("VERCEL", "1");
    expect(mpConnectMode()).toBe("off");
    expect(fakeMpAllowed()).toBe(false);
    // Aun vacías cuentan como «estamos en Vercel»: ante la duda, sin simulador.
    vi.stubEnv("VERCEL", "");
    expect(fakeMpAllowed()).toBe(false);
    vi.stubEnv("VERCEL", undefined);
    vi.stubEnv("MP_CONNECT_MODE", "sandbox");
    expect(fakeMpAllowed()).toBe(false);
  });

  it("[TP-P4] Production sandbox/live exige credenciales", () => {
    for (const mode of ["sandbox", "live"]) {
      const restore = quiet();
      expect(parseEnv({ ...PROD_OK, ...MP_PROD, MP_CONNECT_MODE: mode }).MP_CONNECT_MODE).toBe(mode);
      restore();
      for (const key of ["MP_OAUTH_CLIENT_ID", "MP_OAUTH_CLIENT_SECRET", "SECRET_BOX_KEYS", "MP_CONNECT_WEBHOOK_SECRET"]) {
        expect(() => parseEnv({ ...PROD_OK, ...MP_PROD, MP_CONNECT_MODE: mode, [key]: undefined })).toThrow(
          new RegExp(`${key}: obligatoria en Production con MP_CONNECT_MODE=${mode}`)
        );
        // Solo espacios = no seteada (Vercel guarda lo que se pegue).
        expect(() => parseEnv({ ...PROD_OK, ...MP_PROD, MP_CONNECT_MODE: mode, [key]: "  " })).toThrow(new RegExp(key));
      }
      // Con firma fetch-only el secreto del webhook no es obligatorio (la rama nueva re-pide el pago igual, §25.2 #8).
      const r2 = quiet();
      expect(() =>
        parseEnv({
          ...PROD_OK,
          ...MP_PROD,
          MP_CONNECT_MODE: mode,
          MP_CONNECT_WEBHOOK_SIGNATURE: "fetch-only",
          MP_CONNECT_WEBHOOK_SECRET: undefined,
        })
      ).not.toThrow();
      r2();
    }
    // off en Production no exige nada; Preview/local con sandbox tampoco.
    const r3 = quiet();
    expect(() => parseEnv({ ...PROD_OK, MP_CONNECT_MODE: "off" })).not.toThrow();
    r3();
    expect(() => parseEnv({ VERCEL_ENV: "preview", MP_CONNECT_MODE: "sandbox" })).not.toThrow();
    expect(() => parseEnv({ MP_CONNECT_MODE: "live" })).not.toThrow();
    // SECRET_BOX_KEYS mal formada frena en cualquier entorno y el mensaje NO trae la clave.
    const bad = "k1:ZXN0b05vRXNVbmFDbGF2ZQ=="; // 16 bytes, no 32
    let msg = "";
    try {
      parseEnv({ SECRET_BOX_KEYS: bad });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/SECRET_BOX_KEYS/);
    expect(msg).not.toContain("ZXN0b05vRXNVbmFDbGF2ZQ");
    expect(() => parseEnv({ SECRET_BOX_KEYS: `k1:${KEY_A},k1:${KEY_B}` })).toThrow(/SECRET_BOX_KEYS/);
    expect(() => parseEnv({ SECRET_BOX_KEYS: KEY_A })).toThrow(/SECRET_BOX_KEYS/);
    // Misma regla que secret-box (TP-P1) y el CHECK de M18: kid en minúsculas ≤16, «dev» reservado; base64url vale.
    expect(() => parseEnv({ SECRET_BOX_KEYS: `K1:${KEY_A}` })).toThrow(/SECRET_BOX_KEYS/);
    expect(() => parseEnv({ SECRET_BOX_KEYS: `k12345678901234567:${KEY_A}` })).toThrow(/SECRET_BOX_KEYS/);
    expect(() => parseEnv({ SECRET_BOX_KEYS: `dev:${KEY_A}` })).toThrow(/SECRET_BOX_KEYS: el kid «dev» está reservado/);
    const urlKey = Buffer.alloc(32, 0xfb).toString("base64url");
    expect(parseEnv({ SECRET_BOX_KEYS: `k3:${urlKey}` }).SECRET_BOX_KEYS).toBe(`k3:${urlKey}`);
    expect(parseEnv({ SECRET_BOX_KEYS: ` k2:${KEY_B}, k1:${KEY_A} ` }).SECRET_BOX_KEYS).toBe(`k2:${KEY_B}, k1:${KEY_A}`);
  });

  it("[TP-P4] TURNERO_CHECKOUT=platform no cambia nada", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const e = parseEnv({ TURNERO_CHECKOUT: "platform" });
    // Sigue en el enum (un valor ya cargado en Vercel no rompe el deploy) …
    expect(e.TURNERO_CHECKOUT).toBe("platform");
    // … pero no prende ningún cobro: el modo de MP sigue en off y se avisa una línea.
    expect(e.MP_CONNECT_MODE).toBe("off");
    expect(warn.mock.calls.some((c) => String(c[0]).includes("turnero_checkout.platform_ignored"))).toBe(true);
    warn.mockClear();
    parseEnv({ TURNERO_CHECKOUT: "off" });
    expect(warn).not.toHaveBeenCalled();
    vi.stubEnv("VERCEL_ENV", undefined);
    vi.stubEnv("VERCEL", undefined);
    vi.stubEnv("MP_CONNECT_MODE", undefined);
    vi.stubEnv("TURNERO_CHECKOUT", "platform");
    expect(mpConnectMode()).toBe("off");
    expect(fakeMpAllowed()).toBe(false);
  });
});
