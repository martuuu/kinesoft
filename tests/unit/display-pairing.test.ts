/**
 * TV-1a · `lib/display-pairing-internal.ts` (C-TV «Vínculo», plan §26.4).
 *
 * Qué se prueba y por qué:
 *  - el código de 8 caracteres Crockford son 40 bits: un sha256 pelado se revierte offline recorriendo 2^40, así que
 *    el hash es un HMAC con clave del server. Se verifica la clave real (derivada de `SUPABASE_SERVICE_ROLE_KEY` con
 *    la etiqueta `kinesoft:tv-pair:v1`) recalculándola acá, y que el formato cumple el CHECK de M17 (43 base64url).
 *  - el secreto del dispositivo (256 bits) se guarda como sha256 y la cookie `v1.<id>.<secret>.<día>` se compara en
 *    tiempo constante; una cookie alterada o de otro formato se descarta (null), nunca tira.
 * `@/lib/env` se mockea (configuración, no lógica bajo test); el módulo bajo test es el real.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash, createHmac } from "node:crypto";

const envRef = vi.hoisted(() => ({ env: { SUPABASE_SERVICE_ROLE_KEY: "service-role-de-prueba" as string | undefined } }));
vi.mock("@/lib/env", () => envRef);

import {
  generatePairingCode,
  hashDeviceSecret,
  hashPairingCode,
  makeDisplayCookie,
  newDeviceSecret,
  parseDisplayCookie,
  secretMatches,
} from "@/lib/display-pairing-internal";

/** CHECK `ReceptionDisplay_pairing_check` / `_device_check` de M17. */
const HASH_CHECK = /^[A-Za-z0-9_-]{43}$/;
const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{8}$/;
const ID = "cmh1x2y3z0000abcd1234efgh";

beforeEach(() => {
  envRef.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-de-prueba";
});

describe("[TV-1a] código de vinculación", () => {
  it("[TV-1a] generatePairingCode: 8 chars Crockford (sin I, L, O, U) y distribuido", () => {
    const seen = new Set<string>();
    const chars = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const c = generatePairingCode();
      expect(c).toMatch(CROCKFORD);
      seen.add(c);
      for (const ch of c) chars.add(ch);
    }
    expect(seen.size).toBe(2000);
    // Con 16.000 caracteres sorteados, los 32 símbolos tienen que aparecer: un sesgo/recorte se vería acá.
    expect(chars.size).toBe(32);
  });

  it("[TV-1a] hashPairingCode = HMAC-SHA256(HMAC(SERVICE_ROLE_KEY, etiqueta), code) en base64url de 43", () => {
    const key = createHmac("sha256", "service-role-de-prueba").update("kinesoft:tv-pair:v1").digest();
    const expected = createHmac("sha256", key).update("ABCD2345").digest("base64url");
    const h = hashPairingCode("ABCD2345");
    expect(h).toBe(expected);
    expect(h).toMatch(HASH_CHECK);
    expect(hashPairingCode("ABCD2345")).toBe(h);
    expect(hashPairingCode("ABCD2346")).not.toBe(h);
    // No es un sha256 pelado (reversible offline con 40 bits).
    expect(h).not.toBe(createHash("sha256").update("ABCD2345").digest("base64url"));
  });

  it("[TV-1a] otra SERVICE_ROLE_KEY → otro hash; sin clave (dev) igual cumple el CHECK y es estable en el proceso", () => {
    const a = hashPairingCode("ABCD2345");
    envRef.env.SUPABASE_SERVICE_ROLE_KEY = "otra";
    expect(hashPairingCode("ABCD2345")).not.toBe(a);
    envRef.env.SUPABASE_SERVICE_ROLE_KEY = undefined;
    const dev = hashPairingCode("ABCD2345");
    expect(dev).toMatch(HASH_CHECK);
    expect(dev).not.toBe(a);
    expect(hashPairingCode("ABCD2345")).toBe(dev);
  });
});

describe("[TV-1a] secreto del dispositivo", () => {
  it("[TV-1a] newDeviceSecret: 32 bytes en base64url (43) y únicos", () => {
    const s = newDeviceSecret();
    expect(s).toMatch(HASH_CHECK);
    expect(Buffer.from(s, "base64url").length).toBe(32);
    expect(newDeviceSecret()).not.toBe(s);
  });

  it("[TV-1a] hashDeviceSecret = sha256 base64url (cumple el CHECK de M17)", () => {
    const s = newDeviceSecret();
    const h = hashDeviceSecret(s);
    expect(h).toBe(createHash("sha256").update(s).digest("base64url"));
    expect(h).toMatch(HASH_CHECK);
  });

  it("[TV-1a] secretMatches: true solo con el secreto correcto; null/vacío/largo distinto → false sin tirar", () => {
    const s = newDeviceSecret();
    const h = hashDeviceSecret(s);
    expect(secretMatches(s, h)).toBe(true);
    expect(secretMatches(newDeviceSecret(), h)).toBe(false);
    expect(secretMatches(s, null)).toBe(false);
    expect(secretMatches(s, undefined)).toBe(false);
    expect(secretMatches(s, "")).toBe(false);
    expect(secretMatches(s, h.slice(0, 20))).toBe(false);
    expect(secretMatches("", h)).toBe(false);
  });
});

describe("[TV-1a] cookie del dispositivo", () => {
  it("[TV-1a] makeDisplayCookie → v1.<id>.<secret>.<día> y parseDisplayCookie la devuelve", () => {
    const s = newDeviceSecret();
    const v = makeDisplayCookie(ID, s, "2026-10-22");
    expect(v).toBe(`v1.${ID}.${s}.2026-10-22`);
    expect(parseDisplayCookie(v)).toEqual({ id: ID, secret: s, issuedDay: "2026-10-22" });
  });

  it("[TV-1a] makeDisplayCookie rechaza partes que romperían el formato", () => {
    const s = newDeviceSecret();
    expect(() => makeDisplayCookie("a.b", s, "2026-10-22")).toThrow();
    expect(() => makeDisplayCookie(ID, "corto", "2026-10-22")).toThrow();
    expect(() => makeDisplayCookie(ID, s, "22/10/2026")).toThrow();
  });

  it("[TV-1a] parseDisplayCookie: cualquier cosa fuera de formato → null", () => {
    const s = newDeviceSecret();
    for (const bad of [
      null,
      undefined,
      "",
      `v2.${ID}.${s}.2026-10-22`,
      `v1.${ID}.${s}`,
      `v1.${ID}.${s}.2026-10-22.extra`,
      `v1..${s}.2026-10-22`,
      `v1.${ID}.${s.slice(1)}.2026-10-22`,
      `v1.${ID}.${s}.2026-13-45x`,
      `v1.${ID}.${s}+.2026-10-22`,
      `v1.${"a".repeat(300)}.${s}.2026-10-22`,
    ]) {
      expect(parseDisplayCookie(bad), String(bad).slice(0, 60)).toBeNull();
    }
  });
});
