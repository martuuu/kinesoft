/**
 * PF-0b · verificación local del access token de Supabase (`lib/session-jwt.ts`, lógica pura).
 *
 * Los tokens se firman acá a mano con `node:crypto` (HS256, el formato de GoTrue con el secreto legacy del proyecto):
 * el módulo bajo test es el real. Lo que importa en cada caso es la CLASE de resultado: `ok` (se acepta sin red),
 * `reject` (sin sesión, sin red) o `fallback` (el caller pregunta a GoTrue). Nunca `ok` para un token que no se pudo
 * probar con el secreto y el `iss` de ESTE proyecto.
 */
import { describe, it, expect } from "vitest";
import { createHmac, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { checkSessionClaims, supabaseIssuer, verifySupabaseAccessToken } from "@/lib/session-jwt";
import { signRealtimeToken } from "@/lib/realtime-token-internal";

const SECRET = "unit-test-jwt-secret-0123456789abcdef";
const URL_PUB = "https://abcd1234.supabase.co";
const ISS = "https://abcd1234.supabase.co/auth/v1";
const NOW = 1_800_000_000;
const SUB = "7f9c2b1e-3a4d-4e5f-8a6b-1c2d3e4f5a6b";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

function claims(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISS,
    sub: SUB,
    aud: "authenticated",
    exp: NOW + 3600,
    iat: NOW - 10,
    email: "kine@consultorio.test",
    phone: "",
    app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: { full_name: "Ana Kine", email_verified: true },
    role: "authenticated",
    aal: "aal1",
    amr: [{ method: "password", timestamp: NOW - 10 }],
    session_id: "0b5f6c7d-1111-4222-8333-944455556666",
    is_anonymous: false,
    ...over,
  };
}

function hs256(payload: Record<string, unknown>, secret = SECRET, header: Record<string, unknown> = { alg: "HS256", typ: "JWT" }): string {
  const input = `${b64(header)}.${b64(payload)}`;
  return `${input}.${createHmac("sha256", secret).update(input).digest("base64url")}`;
}

const verify = (t: string, o: Partial<{ secret: string | null; issuer: string | null; nowSec: number }> = {}) =>
  verifySupabaseAccessToken(t, { secret: SECRET, issuer: ISS, nowSec: NOW, ...o });

describe("[PF-0b] verifySupabaseAccessToken", () => {
  it("token válido de GoTrue (HS256, secreto del proyecto) → ok con los claims que usa la app", () => {
    const r = verify(hs256(claims()));
    expect(r).toEqual({
      kind: "ok",
      claims: {
        sub: SUB,
        email: "kine@consultorio.test",
        sessionId: "0b5f6c7d-1111-4222-8333-944455556666",
        aal: "aal1",
        exp: NOW + 3600,
        fullName: "Ana Kine",
        avatarUrl: null,
      },
    });
  });

  it("`aud` como array (GoTrue lo admite) → ok", () => {
    expect(verify(hs256(claims({ aud: ["authenticated"] }))).kind).toBe("ok");
  });

  it("vencido → reject (sin red), aun con firma buena; dentro de los 30 s de tolerancia → ok", () => {
    expect(verify(hs256(claims({ exp: NOW - 31 })))).toEqual({ kind: "reject", reason: "expired" });
    expect(verify(hs256(claims({ exp: NOW - 5 }))).kind).toBe("ok");
    expect(verify(hs256(claims({ exp: undefined })))).toEqual({ kind: "reject", reason: "expired" });
    expect(verify(hs256(claims({ nbf: NOW + 600 })))).toEqual({ kind: "reject", reason: "expired" });
  });

  it("payload alterado (otro sub con la firma vieja) → fallback signature: NUNCA ok", () => {
    const good = hs256(claims());
    const [h, , s] = good.split(".");
    const forged = `${h}.${b64(claims({ sub: "11111111-2222-4333-8444-555555555555" }))}.${s}`;
    expect(verify(forged)).toEqual({ kind: "fallback", reason: "signature" });
  });

  it("firmado con otra clave → fallback signature (GoTrue decide; nunca ok)", () => {
    expect(verify(hs256(claims(), "otra-clave-de-otro-proyecto-xxxxxxxx"))).toEqual({ kind: "fallback", reason: "signature" });
  });

  it("firma vacía o recortada → reject malformed / fallback signature", () => {
    const [h, p] = hs256(claims()).split(".");
    expect(verify(`${h}.${p}.`)).toEqual({ kind: "reject", reason: "malformed" });
    expect(verify(`${h}.${p}.abc`)).toEqual({ kind: "fallback", reason: "signature" });
  });

  it("de otro proyecto (`iss` distinto) con el mismo secreto → fallback issuer", () => {
    expect(verify(hs256(claims({ iss: "https://otro.supabase.co/auth/v1" })))).toEqual({ kind: "fallback", reason: "issuer" });
    // Sin URL configurada no hay contra qué comparar: tampoco ok.
    expect(verify(hs256(claims()), { issuer: null })).toEqual({ kind: "fallback", reason: "issuer" });
  });

  it("sin secreto configurado → fallback no_secret (se queda `getUser()`, como antes de PF-0b)", () => {
    expect(verify(hs256(claims()), { secret: null })).toEqual({ kind: "fallback", reason: "no_secret" });
  });

  it("`alg: none` u otro algoritmo → fallback alg (nunca ok)", () => {
    const p = b64(claims());
    expect(verify(`${b64({ alg: "none", typ: "JWT" })}.${p}.x`)).toEqual({ kind: "fallback", reason: "alg" });
    expect(verify(hs256(claims(), SECRET, { alg: "HS512", typ: "JWT" }))).toEqual({ kind: "fallback", reason: "alg" });
  });

  it("ES256 con kid → asymmetric (lo verifica `getClaims()` con el JWKS)", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const input = `${b64({ alg: "ES256", typ: "JWT", kid: "k1" })}.${b64(claims())}`;
    const sig = cryptoSign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
    expect(verify(`${input}.${sig}`).kind).toBe("asymmetric");
  });

  it("el token del canal realtime (mismo secreto) no sirve de sesión: reject subject", () => {
    const { token } = signRealtimeToken({ tenantId: "t1", now: new Date(NOW * 1000), secret: SECRET });
    expect(verify(token)).toEqual({ kind: "reject", reason: "subject" });
  });

  it("`sub` vacío → reject subject; un id que no es UUID (perfil de dev) con firma e iss buenos → ok", () => {
    expect(verify(hs256(claims({ sub: "" })))).toEqual({ kind: "reject", reason: "subject" });
    expect(verify(hs256(claims({ sub: "demo-lucia" }))).kind).toBe("ok");
  });

  it("anon/service key (sin sub, mismo secreto) → reject subject", () => {
    const anon = { iss: "supabase", ref: "abcd1234", role: "anon", iat: NOW - 10, exp: NOW + 3600 };
    expect(verify(hs256(anon))).toEqual({ kind: "reject", reason: "subject" });
    expect(verify(hs256({ ...anon, role: "service_role" }))).toEqual({ kind: "reject", reason: "subject" });
  });

  it("claims que GoTrue no emite para una sesión (role, aud, session_id) → fallback claims, nunca ok", () => {
    expect(verify(hs256(claims({ role: "service_role" })))).toEqual({ kind: "fallback", reason: "claims" });
    expect(verify(hs256(claims({ aud: "otra" })))).toEqual({ kind: "fallback", reason: "claims" });
    expect(verify(hs256(claims({ session_id: undefined })))).toEqual({ kind: "fallback", reason: "claims" });
  });

  it("malformado → reject malformed", () => {
    expect(verify("no-es-un-jwt")).toEqual({ kind: "reject", reason: "malformed" });
    expect(verify("a.b.c")).toEqual({ kind: "reject", reason: "malformed" });
    expect(verify(undefined as unknown as string)).toEqual({ kind: "reject", reason: "malformed" });
  });
});

describe("[PF-0b] checkSessionClaims / supabaseIssuer", () => {
  it("issuer = <url>/auth/v1, sin barras dobles", () => {
    expect(supabaseIssuer(URL_PUB)).toBe(ISS);
    expect(supabaseIssuer(`${URL_PUB}/`)).toBe(ISS);
    expect(supabaseIssuer(undefined)).toBeNull();
  });

  it("email vacío → null; sin user_metadata → nombre y avatar null", () => {
    const r = checkSessionClaims(claims({ email: "", user_metadata: undefined }), NOW);
    expect(r).toMatchObject({ ok: true, claims: { email: null, fullName: null, avatarUrl: null } });
  });
});
