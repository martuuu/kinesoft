/**
 * T5 TP-P2 · state del OAuth de Mercado Pago y PKCE (lib/mp-connect/oauth-state.ts, símbolo real; brief §25.4 C-TP4,
 * Anexo B C-TP3). Se mockea solo el ENV (la service key de la que se deriva la clave) y se espía `timingSafeEqual` sin
 * reemplazarlo. El vencimiento es epoch puro: corre igual en TZ=UTC y TZ=AR.
 */
import { createHash, createHmac } from "node:crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";

const spy = vi.hoisted(() => ({ calls: 0 }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  const timingSafeEqual = (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
    spy.calls++;
    return actual.timingSafeEqual(a, b);
  };
  return { ...actual, default: { ...actual, timingSafeEqual }, timingSafeEqual };
});
const over = vi.hoisted(() => ({ key: "service-key-A" as string | undefined }));
vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  const env = new Proxy(actual.env, {
    get: (t, k: string) => (k === "SUPABASE_SERVICE_ROLE_KEY" ? over.key : (t as Record<string, unknown>)[k]),
  });
  return { ...actual, env };
});

import {
  MP_OAUTH_COOKIE,
  MP_OAUTH_STATE_TTL_S,
  buildAuthorizationUrl,
  makeOAuthState,
  mpOAuthCookieOptions,
  mpOAuthStateExp,
  newOAuthNonce,
  pkceChallenge,
  pkceVerifierFrom,
  readOAuthState,
} from "@/lib/mp-connect/oauth-state";
import { MP_OAUTH_COOKIE_PATH, REDIRECT_PATH, mpHostsFor, mpRedirectUri } from "@/lib/mp-connect/constants";

const NOW = Date.UTC(2026, 9, 22, 15, 0, 0);
const U = "7f9c2b1e-3a4d-4e5f-8a6b-1c2d3e4f5a6b";
const S = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const T = "ten_11112222";
const P = "pra_33334444";
const ctx = { userId: U, sessionId: S, tenantId: T, nowMs: NOW };

function own(nonce = newOAuthNonce()) {
  return makeOAuthState({
    userId: U,
    sessionId: S,
    tenantId: T,
    target: "own",
    practitionerId: P,
    nonce,
    exp: mpOAuthStateExp(NOW),
  });
}
function payloadOf(o: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(o)).toString("base64url");
}
/** Reimplementa la derivación a mano: clave = HMAC(service key, etiqueta); MAC de la cookie = HMAC(clave, "cookie\0" + payload). */
function signWithLabel(payload: string, label: string, domain: string | null = "cookie"): string {
  const key = createHmac("sha256", over.key!).update(label).digest();
  return createHmac("sha256", key)
    .update(domain === null ? payload : `${domain}\0${payload}`)
    .digest("base64url");
}

beforeEach(() => {
  over.key = "service-key-A";
  spy.calls = 0;
});

describe("[TP-P2] OAuth y firma · state", () => {
  it("ida y vuelta: own con profesional y clinic sin profesional", () => {
    const n = newOAuthNonce();
    const { cookie, state } = own(n);
    expect(readOAuthState(cookie, state, ctx)).toEqual({
      userId: U,
      sessionId: S,
      tenantId: T,
      target: "own",
      practitionerId: P,
      nonce: n,
      exp: Math.floor(NOW / 1000) + MP_OAUTH_STATE_TTL_S,
    });
    const c = makeOAuthState({ ...ctx, target: "clinic", practitionerId: null, nonce: n, exp: mpOAuthStateExp(NOW) });
    expect(readOAuthState(c.cookie, c.state, ctx)).toMatchObject({ target: "clinic", practitionerId: null });
    expect(spy.calls).toBeGreaterThan(0);
  });

  it("el state viaja en la URL: URL-safe, sin ids ni el nonce en claro", () => {
    const n = newOAuthNonce();
    const { cookie, state } = own(n);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(state).not.toContain(n);
    expect(cookie).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(cookie).not.toContain(state);
  });

  it("state: otro usuario/sesión/consultorio, alterado o vencido → error", () => {
    const { cookie, state } = own();
    expect(readOAuthState(cookie, state, { ...ctx, userId: "otro" })).toEqual({ error: "other_user" });
    expect(readOAuthState(cookie, state, { ...ctx, sessionId: "otra" })).toEqual({ error: "other_session" });
    expect(readOAuthState(cookie, state, { ...ctx, tenantId: "ten_otro" })).toEqual({ error: "other_tenant" });

    // El state de otro intento (otro nonce) con esta cookie: CSRF de login / cruce de pestañas.
    expect(readOAuthState(cookie, own().state, ctx)).toEqual({ error: "state_mismatch" });
    const flip = state.slice(0, -1) + (state.at(-1) === "A" ? "B" : "A");
    expect(readOAuthState(cookie, flip, ctx)).toEqual({ error: "state_mismatch" });
    expect(readOAuthState(cookie, null, ctx)).toEqual({ error: "state_mismatch" });
    expect(readOAuthState(cookie, "", ctx)).toEqual({ error: "state_mismatch" });

    // Vencido: a los 10 min justos y después; vale a los 10 min − 1 s.
    expect(readOAuthState(cookie, state, { ...ctx, nowMs: NOW + (MP_OAUTH_STATE_TTL_S - 1) * 1000 })).not.toHaveProperty(
      "error"
    );
    expect(readOAuthState(cookie, state, { ...ctx, nowMs: NOW + MP_OAUTH_STATE_TTL_S * 1000 })).toEqual({
      error: "expired",
    });
    expect(readOAuthState(cookie, state, { ...ctx, nowMs: NOW + 3600_000 })).toEqual({ error: "expired" });
  });

  it("cookie alterada, re-firmada con otra etiqueta u otra service key → bad_mac", () => {
    const { cookie, state } = own();
    const [payload, mac] = cookie.split(".");
    const raw = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;

    // Mover la cookie a otro usuario/consultorio con la firma vieja.
    for (const k of Object.keys(raw)) {
      const forged = payloadOf({ ...raw, [k]: typeof raw[k] === "number" ? (raw[k] as number) + 60 : "x" });
      expect(readOAuthState(`${forged}.${mac}`, state, ctx)).toEqual({ error: "bad_mac" });
    }
    const last = mac.at(-1)!;
    expect(readOAuthState(`${payload}.${mac.slice(0, -1)}${last === "A" ? "B" : "A"}`, state, ctx)).toEqual({
      error: "bad_mac",
    });
    // Mismo payload firmado con la etiqueta de otra cookie del repo: no valida.
    for (const label of ["kinesoft:portal-invite:v1", "kinesoft:recovery-cookie:v1", "kinesoft:two-factor:v1"]) {
      for (const domain of ["cookie", null]) {
        expect(readOAuthState(`${payload}.${signWithLabel(payload, label, domain)}`, state, ctx)).toEqual({
          error: "bad_mac",
        });
      }
    }
    // Con la etiqueta correcta pero otro dominio (el MAC del state o del verifier no sirven de firma de la cookie).
    for (const domain of ["state", "pkce", null]) {
      expect(readOAuthState(`${payload}.${signWithLabel(payload, "kinesoft:mp-oauth-state:v1", domain)}`, state, ctx)).toEqual({
        error: "bad_mac",
      });
    }
    // Control: la reimplementación a mano reproduce la firma real (si no, los casos de arriba serían false-green).
    expect(signWithLabel(payload, "kinesoft:mp-oauth-state:v1")).toBe(mac);
    over.key = "service-key-B";
    expect(readOAuthState(cookie, state, ctx)).toEqual({ error: "bad_mac" });
  });

  it("vacía, basura o enorme → bad_mac sin tirar", () => {
    for (const v of [null, undefined, "", "x", "a.b.c", ".", "abc.", ".abc", "x".repeat(5000) + ".y"]) {
      expect(readOAuthState(v, "s", ctx)).toEqual({ error: "bad_mac" });
    }
  });

  it("bien firmada pero con forma inválida o exp más lejos que el TTL → error, no tira", () => {
    const n = newOAuthNonce();
    const { state } = own(n);
    const x = Math.floor(NOW / 1000) + MP_OAUTH_STATE_TTL_S;
    const base = { u: U, s: S, t: T, g: "own", p: P, n, x };
    for (const o of [
      { ...base, g: "otro" },
      { ...base, g: "own", p: null },
      { ...base, g: "clinic", p: P },
      { ...base, u: "" },
      { ...base, n: "corto" },
      { ...base, x: "mañana" },
    ]) {
      const pl = payloadOf(o);
      expect(readOAuthState(`${pl}.${signWithLabel(pl, "kinesoft:mp-oauth-state:v1")}`, state, ctx)).toEqual({
        error: "bad_mac",
      });
    }
    // Control: la misma base, bien firmada a mano, se lee (los rechazos de arriba son por forma, no por firma).
    const ok = payloadOf(base);
    expect(readOAuthState(`${ok}.${signWithLabel(ok, "kinesoft:mp-oauth-state:v1")}`, state, ctx)).toMatchObject({
      nonce: n,
    });
    const far = payloadOf({ ...base, x: x + 24 * 3600 });
    expect(readOAuthState(`${far}.${signWithLabel(far, "kinesoft:mp-oauth-state:v1")}`, state, ctx)).toEqual({
      error: "expired",
    });
    const notJson = Buffer.from("{nope").toString("base64url");
    expect(
      readOAuthState(`${notJson}.${signWithLabel(notJson, "kinesoft:mp-oauth-state:v1")}`, state, ctx)
    ).toEqual({ error: "bad_mac" });
  });

  it("makeOAuthState rechaza entradas que nunca deberían firmarse", () => {
    const exp = mpOAuthStateExp(NOW);
    const base = { userId: U, sessionId: S, tenantId: T, nonce: newOAuthNonce(), exp };
    expect(() => makeOAuthState({ ...base, target: "own", practitionerId: null })).toThrow();
    expect(() => makeOAuthState({ ...base, target: "clinic", practitionerId: P })).toThrow();
    expect(() => makeOAuthState({ ...base, userId: "", target: "clinic", practitionerId: null })).toThrow();
    expect(() => makeOAuthState({ ...base, nonce: "corto", target: "clinic", practitionerId: null })).toThrow();
  });

  it("cookie kine_mp_oauth: httpOnly, SameSite=Lax (la vuelta es un GET cross-site), path /api/mp/oauth, 10 min", () => {
    expect(MP_OAUTH_COOKIE).toBe("kine_mp_oauth");
    expect(MP_OAUTH_STATE_TTL_S).toBe(600);
    expect(MP_OAUTH_COOKIE_PATH).toBe("/api/mp/oauth");
    expect(REDIRECT_PATH.startsWith(MP_OAUTH_COOKIE_PATH)).toBe(true);
    expect(mpOAuthCookieOptions()).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/api/mp/oauth", maxAge: 600 });
  });
});

describe("[TP-P2] OAuth y firma · PKCE", () => {
  it("verifier ≥43 y challenge S256", () => {
    const n = newOAuthNonce();
    const v = pkceVerifierFrom(n);
    // RFC 7636 §4.1: 43..128 caracteres de [A-Z a-z 0-9 - . _ ~].
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v.length).toBeLessThanOrEqual(128);
    expect(v).toMatch(/^[A-Za-z0-9._~-]+$/);
    // Determinista por nonce (el callback lo recalcula de la cookie) y distinto por nonce.
    expect(pkceVerifierFrom(n)).toBe(v);
    expect(pkceVerifierFrom(newOAuthNonce())).not.toBe(v);
    // No se deduce del state ni del nonce sin la clave del servidor.
    expect(v).not.toContain(n);
    expect(v).not.toBe(own(n).state);
    over.key = "service-key-B";
    expect(pkceVerifierFrom(n)).not.toBe(v);
    // S256 = BASE64URL(SHA256(ASCII(verifier))) sin padding; vector del Apéndice B del RFC 7636.
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
    expect(pkceChallenge(v)).toBe(createHash("sha256").update(v, "ascii").digest("base64url"));
  });
});

describe("[TP-P2] OAuth y firma · URL de autorización", () => {
  it("authorizationUrl con client_id, response_type=code, platform_id=mp, state, redirect exacto, S256", () => {
    const appUrl = "https://kinesoft.example.com/";
    const { cookie, state } = own();
    const nonce = (JSON.parse(Buffer.from(cookie.split(".")[0], "base64url").toString("utf8")) as { n: string }).n;
    const challenge = pkceChallenge(pkceVerifierFrom(nonce));
    for (const mode of ["live", "sandbox", "fake"] as const) {
      const hosts = mpHostsFor(mode, appUrl);
      const url = new URL(
        buildAuthorizationUrl({
          authUrl: hosts.authUrl,
          clientId: "123456",
          redirectUri: mpRedirectUri(appUrl),
          state,
          codeChallenge: challenge,
        })
      );
      expect(`${url.origin}${url.pathname}`).toBe(hosts.authUrl);
      const q = url.searchParams;
      expect(q.get("client_id")).toBe("123456");
      expect(q.get("response_type")).toBe("code");
      expect(q.get("platform_id")).toBe("mp");
      expect(q.get("state")).toBe(state);
      expect(q.get("redirect_uri")).toBe("https://kinesoft.example.com/api/mp/oauth/callback");
      expect(q.get("code_challenge")).toBe(challenge);
      expect(q.get("code_challenge_method")).toBe("S256");
      // El verifier nunca sale del servidor.
      expect(url.toString()).not.toContain(pkceVerifierFrom(nonce));
    }
    expect(mpHostsFor("live", appUrl).authUrl).toBe("https://auth.mercadopago.com/authorization");
    expect(mpHostsFor("sandbox", appUrl).apiBase).toBe("https://api.mercadopago.com");
    expect(mpHostsFor("fake", appUrl).apiBase).toBe("https://kinesoft.example.com/api/mp/fake");
  });
});
