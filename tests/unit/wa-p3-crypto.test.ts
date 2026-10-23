/**
 * [WA-P3] Cripto de WhatsApp (C-WA3, brief §26.5): firma del webhook de Meta, verify token, hash y máscara del teléfono,
 * cookie del alta (`kine_wa_signup`) y la separación de la caja sellada entre MP y WA.
 *
 * Se prueba el símbolo real de `lib/whatsapp/crypto.ts` y de `lib/secret-box.ts`. Lo único que se toca es el env
 * (`SUPABASE_SERVICE_ROLE_KEY`, de la que se derivan las claves; `VERCEL*` para la rama de falla cerrada).
 */
import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WA_SIGNUP_COOKIE,
  WA_SIGNUP_TTL_S,
  maskPhone,
  makeSignupState,
  newSignupNonce,
  phoneHash,
  readSignupState,
  signMetaPayload,
  verifyMetaSignature,
  verifyTokenMatches,
  waSignupCookieOptions,
  waSignupExp,
} from "@/lib/whatsapp/crypto";
import { makeOAuthState } from "@/lib/mp-connect/oauth-state";
import { SecretBoxError, mpCredentialAad, openSecret, sealSecret, waCredentialAad } from "@/lib/secret-box";

const SECRET = "secreto-de-la-app-de-prueba";
const BODY = Buffer.from(JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "100200300400" }] }), "utf8");

beforeEach(() => {
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-de-prueba-0123456789");
  vi.stubEnv("VERCEL_ENV", undefined);
  vi.stubEnv("VERCEL", undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("[WA-P3] verifyMetaSignature (HMAC-SHA256 sobre los bytes crudos, sha256=<hex>)", () => {
  const good = `sha256=${createHmac("sha256", SECRET).update(BODY).digest("hex")}`;

  it("[WA-P3] acepta la firma de Meta sobre el cuerpo crudo", () => {
    expect(verifyMetaSignature(BODY, good, SECRET)).toBe(true);
    expect(signMetaPayload(BODY, SECRET)).toBe(good);
  });

  it("[WA-P3] un byte alterado no valida (aunque el JSON parseado sea «igual»)", () => {
    const altered = Buffer.from(BODY);
    altered[altered.length - 2] ^= 0x01;
    expect(verifyMetaSignature(altered, good, SECRET)).toBe(false);
    // Re-serializar con otro espaciado: mismo objeto, otros bytes → no valida. Por eso la ruta firma los bytes crudos.
    const reSerialized = Buffer.from(JSON.stringify(JSON.parse(BODY.toString("utf8")), null, 1), "utf8");
    expect(verifyMetaSignature(reSerialized, good, SECRET)).toBe(false);
  });

  it("[WA-P3] el secreto de otra app no valida", () => {
    expect(verifyMetaSignature(BODY, good, "otro-secreto")).toBe(false);
  });

  it("[WA-P3] sin prefijo, con otro algoritmo, mal formada, vacía o sin secreto → false (nunca tira)", () => {
    const hex = good.slice("sha256=".length);
    expect(verifyMetaSignature(BODY, hex, SECRET)).toBe(false);
    expect(verifyMetaSignature(BODY, `sha1=${hex}`, SECRET)).toBe(false);
    expect(verifyMetaSignature(BODY, `sha256=${hex.slice(0, 63)}`, SECRET)).toBe(false);
    expect(verifyMetaSignature(BODY, `sha256=${hex}00`, SECRET)).toBe(false);
    expect(verifyMetaSignature(BODY, `sha256=${"z".repeat(64)}`, SECRET)).toBe(false);
    expect(verifyMetaSignature(BODY, "", SECRET)).toBe(false);
    expect(verifyMetaSignature(BODY, null, SECRET)).toBe(false);
    expect(verifyMetaSignature(BODY, undefined, SECRET)).toBe(false);
    expect(verifyMetaSignature(BODY, good, "")).toBe(false);
    expect(verifyMetaSignature(BODY, good, undefined)).toBe(false);
  });

  it("[WA-P3] acepta el hex en mayúsculas (el header no distingue) y espacios alrededor", () => {
    expect(verifyMetaSignature(BODY, `  sha256=${good.slice(7).toUpperCase()} `, SECRET)).toBe(true);
  });
});

describe("[WA-P3] verifyTokenMatches (GET del webhook, hub.verify_token)", () => {
  it("[WA-P3] igual → true; distinto, vacío o ausente → false", () => {
    const tok = "kinesoft-fake-wa-verify-token-0123456789";
    expect(verifyTokenMatches(tok, tok)).toBe(true);
    expect(verifyTokenMatches(`${tok}x`, tok)).toBe(false);
    expect(verifyTokenMatches(tok.slice(1), tok)).toBe(false);
    expect(verifyTokenMatches("", "")).toBe(false);
    expect(verifyTokenMatches(null, tok)).toBe(false);
    expect(verifyTokenMatches(tok, undefined)).toBe(false);
  });
});

describe("[WA-P3] phoneHash y maskPhone", () => {
  it("[WA-P3] phoneHash: 64 hex (cumple el CHECK de M15), determinista y distinto por número", () => {
    const a = phoneHash("+5491112346789");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(phoneHash("+5491112346789")).toBe(a);
    expect(phoneHash("+5491112346780")).not.toBe(a);
  });

  it("[WA-P3] phoneHash no es un SHA-256 pelado (no se revierte probando los celulares de AR) y depende de la clave", () => {
    const a = phoneHash("+5491112346789");
    expect(a).not.toBe(createHash("sha256").update("+5491112346789").digest("hex"));
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "otra-service-role");
    expect(phoneHash("+5491112346789")).not.toBe(a);
  });

  it("[WA-P3] phoneHash: sin service key, en local usa una clave determinista; en Vercel falla cerrado", () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const local = phoneHash("+5491112346789");
    expect(local).toMatch(/^[0-9a-f]{64}$/);
    expect(phoneHash("+5491112346789")).toBe(local);
    vi.stubEnv("VERCEL_ENV", "production");
    expect(() => phoneHash("+5491112346789")).toThrow(/wa-phone/);
  });

  it("[WA-P3] phoneHash rechaza lo que no es E.164", () => {
    expect(() => phoneHash("1112346789")).toThrow();
    expect(() => phoneHash("+54 9 11 1234-6789")).toThrow();
    expect(() => phoneHash("")).toThrow();
  });

  it("[WA-P3] maskPhone: celular AR → «+54 9 11 ****-6789»; otro → prefijo y últimos 4", () => {
    expect(maskPhone("+5491112346789")).toBe("+54 9 11 ****-6789");
    expect(maskPhone("+5493514556789")).toBe("+54 9 35 ****-6789");
    expect(maskPhone("+14155552671")).toBe("+14 ****-2671");
    expect(maskPhone("basura")).toBe("****");
    // Cumple el CHECK `char_length(toMasked) BETWEEN 4 AND 32` y nunca trae el número entero.
    for (const p of ["+5491112346789", "+14155552671", "x"]) {
      const m = maskPhone(p);
      expect(m.length).toBeGreaterThanOrEqual(4);
      expect(m.length).toBeLessThanOrEqual(32);
      if (p.startsWith("+")) expect(m.replace(/\D/g, "")).not.toBe(p.replace(/\D/g, ""));
    }
  });
});

describe("[WA-P3] cookie del alta kine_wa_signup", () => {
  const nowMs = Date.UTC(2026, 9, 22, 15, 0, 0);
  const base = { userId: "user_1", sessionId: "sess_1", tenantId: "ten_1" };
  const mk = () => {
    const nonce = newSignupNonce();
    const cookie = makeSignupState({ ...base, nonce, exp: waSignupExp(nowMs) });
    return { nonce, cookie };
  };

  it("[WA-P3] nombre, 10 min y path=/configuracion", () => {
    expect(WA_SIGNUP_COOKIE).toBe("kine_wa_signup");
    expect(WA_SIGNUP_TTL_S).toBe(600);
    const o = waSignupCookieOptions();
    expect(o.path).toBe("/configuracion");
    expect(o.maxAge).toBe(600);
    expect(o.httpOnly).toBe(true);
  });

  it("[WA-P3] el mismo usuario, sesión, consultorio y nonce → claims", () => {
    const { nonce, cookie } = mk();
    const r = readSignupState(cookie, { ...base, nonce, nowMs: nowMs + 60_000 });
    expect(r).toMatchObject({ ...base, nonce });
  });

  it("[WA-P3] rechazada con otro usuario, otra sesión, otro consultorio u otro nonce", () => {
    const { nonce, cookie } = mk();
    expect(readSignupState(cookie, { ...base, userId: "user_2", nonce, nowMs })).toEqual({ error: "other_user" });
    expect(readSignupState(cookie, { ...base, sessionId: "sess_2", nonce, nowMs })).toEqual({ error: "other_session" });
    expect(readSignupState(cookie, { ...base, tenantId: "ten_2", nonce, nowMs })).toEqual({ error: "other_tenant" });
    expect(readSignupState(cookie, { ...base, nonce: newSignupNonce(), nowMs })).toEqual({ error: "nonce_mismatch" });
  });

  it("[WA-P3] vencida a los 10 min, y un exp más lejano que el TTL tampoco vale", () => {
    const { nonce, cookie } = mk();
    expect(readSignupState(cookie, { ...base, nonce, nowMs: nowMs + 600_000 })).toEqual({ error: "expired" });
    const far = makeSignupState({ ...base, nonce, exp: waSignupExp(nowMs) + 3600 });
    expect(readSignupState(far, { ...base, nonce, nowMs })).toEqual({ error: "expired" });
  });

  it("[WA-P3] alterada, truncada, vacía o firmada con la etiqueta del OAuth de MP → bad_mac", () => {
    const { nonce, cookie } = mk();
    const [p, s] = cookie.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, "base64url").toString()), t: "ten_2" })).toString("base64url");
    expect(readSignupState(`${forged}.${s}`, { ...base, tenantId: "ten_2", nonce, nowMs })).toEqual({ error: "bad_mac" });
    expect(readSignupState(cookie.slice(0, -2), { ...base, nonce, nowMs })).toEqual({ error: "bad_mac" });
    expect(readSignupState("", { ...base, nonce, nowMs })).toEqual({ error: "bad_mac" });
    expect(readSignupState(undefined, { ...base, nonce, nowMs })).toEqual({ error: "bad_mac" });
    const mp = makeOAuthState({ ...base, target: "clinic", practitionerId: null, nonce, exp: waSignupExp(nowMs) });
    expect(readSignupState(mp.cookie, { ...base, nonce, nowMs })).toEqual({ error: "bad_mac" });
  });

  it("[WA-P3] una entrada inválida no se firma (bug del caller)", () => {
    expect(() => makeSignupState({ ...base, nonce: "corto", exp: waSignupExp(nowMs) })).toThrow();
    expect(() => makeSignupState({ ...base, userId: "", nonce: newSignupNonce(), exp: waSignupExp(nowMs) })).toThrow();
  });
});

describe("[WA-P3] caja sellada: propósito y AAD", () => {
  it("[WA-P3] la caja de MP no abre como WA (ni con el mismo id de registro)", () => {
    const sealed = sealSecret("FAKE-token-de-mp", mpCredentialAad("acc_1", "accessToken"));
    expect(() => openSecret(sealed, waCredentialAad("acc_1", "token"))).toThrow(SecretBoxError);
    const wa = sealSecret("FAKEWA-token", waCredentialAad("acc_1", "token"));
    expect(openSecret(wa, waCredentialAad("acc_1", "token"))).toBe("FAKEWA-token");
    expect(() => openSecret(wa, waCredentialAad("acc_1", "pin"))).toThrow(SecretBoxError);
    expect(() => openSecret(wa, waCredentialAad("acc_2", "token"))).toThrow(SecretBoxError);
  });
});
