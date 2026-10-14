/**
 * SV04b · token del canal realtime (C-SV5, SV-D6, SV-D15; plan §18.2 «Token»).
 *
 * Se prueba el firmador REAL (`signRealtimeToken` / `verifyRealtimeToken`) y, además,
 * se re-verifica la firma con `node:crypto` a mano: si el firmador produjera algo que
 * solo nuestro `verify` entiende (base64 en vez de base64url, HMAC sobre otro string),
 * el roundtrip daría verde y Supabase igual rechazaría el token en staging.
 */
import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  REALTIME_CLAIMS,
  signRealtimeToken,
  verifyRealtimeToken,
} from "@/lib/realtime-token-internal";
import { REALTIME_TOKEN_TTL_SEC } from "@/lib/realtime-constants";

const SECRET = "test-secret-only-for-unit-tests-0123456789abcdef";
const TENANT = "ckz9tenant00000000000001a";
const NOW = new Date("2026-10-13T15:00:00.000Z");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function part(token: string, i: 0 | 1): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[i], "base64url").toString("utf8"));
}
function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}
function hs256(signingInput: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(signingInput).digest("base64url");
}

describe("signRealtimeToken", () => {
  it("header sin kid es exactamente {alg:HS256, typ:JWT}", () => {
    const { token } = signRealtimeToken({ tenantId: TENANT, now: NOW, secret: SECRET });
    expect(part(token, 0)).toEqual({ alg: "HS256", typ: "JWT" });
  });

  it("con kid lo pone en el header (SV-D15)", () => {
    const { token } = signRealtimeToken({ tenantId: TENANT, now: NOW, secret: SECRET, kid: "kid-123" });
    expect(part(token, 0)).toEqual({ alg: "HS256", typ: "JWT", kid: "kid-123" });
  });

  it("kid vacío = sin kid (un SUPABASE_JWT_KID vacío en Vercel no puede mandar `kid:\"\"`)", () => {
    const { token } = signRealtimeToken({ tenantId: TENANT, now: NOW, secret: SECRET, kid: "" });
    expect(part(token, 0)).toEqual({ alg: "HS256", typ: "JWT" });
    const { token: t2 } = signRealtimeToken({ tenantId: TENANT, now: NOW, secret: SECRET, kid: "   " });
    expect(part(t2, 0)).toEqual({ alg: "HS256", typ: "JWT" });
  });

  it("claims exactos de SV-D6, sin ninguna clave de más", () => {
    const { token } = signRealtimeToken({ tenantId: TENANT, now: NOW, secret: SECRET });
    const p = part(token, 1);
    expect(Object.keys(p).sort()).toEqual(
      ["aud", "exp", "iat", "iss", "purpose", "role", "sub", "tenant_id"].sort()
    );
    expect(p).toMatchObject({
      iss: "kinesoft-realtime",
      aud: "authenticated",
      role: "authenticated",
      purpose: "kinesoft-realtime",
      tenant_id: TENANT,
    });
    expect(REALTIME_CLAIMS).toEqual({
      iss: "kinesoft-realtime",
      aud: "authenticated",
      role: "authenticated",
      purpose: "kinesoft-realtime",
    });
  });

  it("iat = segundos de `now`; exp - iat = 600; expiresAt = exp", () => {
    const { token, expiresAt } = signRealtimeToken({ tenantId: TENANT, now: NOW, secret: SECRET });
    const p = part(token, 1) as { iat: number; exp: number };
    expect(p.iat).toBe(Math.floor(NOW.getTime() / 1000));
    expect(p.exp - p.iat).toBe(600);
    expect(REALTIME_TOKEN_TTL_SEC).toBe(600);
    expect(expiresAt.getTime()).toBe(p.exp * 1000);
  });

  it("sub = rt:<uuid> y NO es un UUID (GoTrue no lo acepta como usuario)", () => {
    const a = signRealtimeToken({ tenantId: TENANT, now: NOW, secret: SECRET });
    const b = signRealtimeToken({ tenantId: TENANT, now: NOW, secret: SECRET });
    const subA = part(a.token, 1).sub as string;
    const subB = part(b.token, 1).sub as string;
    expect(subA).toMatch(/^rt:[0-9a-f-]{36}$/);
    expect(UUID_RE.test(subA)).toBe(false);
    expect(UUID_RE.test(subA.slice(3))).toBe(true);
    expect(subA).not.toBe(subB); // uno por token: no identifica al usuario
  });

  it("la firma es HS256 estándar (base64url de HMAC-SHA256 sobre header.payload)", () => {
    const { token } = signRealtimeToken({ tenantId: TENANT, now: NOW, secret: SECRET, kid: "k" });
    const [h, p, s] = token.split(".");
    expect(token.split(".")).toHaveLength(3);
    expect(token).not.toMatch(/[=+/]/);
    expect(s).toBe(hs256(`${h}.${p}`));
  });

  it("ttlSec explícito se respeta (solo para el script de verificación: token vencido)", () => {
    const { token } = signRealtimeToken({ tenantId: TENANT, now: NOW, secret: SECRET, ttlSec: 1 });
    const p = part(token, 1) as { iat: number; exp: number };
    expect(p.exp - p.iat).toBe(1);
  });

  it("rechaza secreto vacío y tenantId vacío (falla cerrado)", () => {
    expect(() => signRealtimeToken({ tenantId: TENANT, now: NOW, secret: "" })).toThrow();
    expect(() => signRealtimeToken({ tenantId: "", now: NOW, secret: SECRET })).toThrow();
  });
});

describe("verifyRealtimeToken", () => {
  const signed = () => signRealtimeToken({ tenantId: TENANT, now: NOW, secret: SECRET }).token;

  it("roundtrip con y sin kid devuelve los claims", () => {
    for (const kid of [undefined, "kid-1"]) {
      const { token } = signRealtimeToken({ tenantId: TENANT, now: NOW, secret: SECRET, kid });
      const c = verifyRealtimeToken(token, SECRET, NOW);
      expect(c).not.toBeNull();
      expect(c!.tenant_id).toBe(TENANT);
      expect(c!.purpose).toBe("kinesoft-realtime");
    }
  });

  it("manipular tenant_id rompe la firma", () => {
    const [h, , s] = signed().split(".");
    const p = part(signed(), 1);
    const forged = `${h}.${b64url({ ...p, tenant_id: "otrotenant0000000000000001" })}.${s}`;
    expect(verifyRealtimeToken(forged, SECRET, NOW)).toBeNull();
  });

  it("manipular el header rompe la firma", () => {
    const [, p, s] = signed().split(".");
    const forged = `${b64url({ alg: "HS256", typ: "JWT", kid: "otro" })}.${p}.${s}`;
    expect(verifyRealtimeToken(forged, SECRET, NOW)).toBeNull();
  });

  it("alg:none y alg distinto se rechazan aunque la firma 'cierre'", () => {
    const p = b64url(part(signed(), 1));
    const none = b64url({ alg: "none", typ: "JWT" });
    expect(verifyRealtimeToken(`${none}.${p}.`, SECRET, NOW)).toBeNull();
    const hs512 = b64url({ alg: "HS512", typ: "JWT" });
    expect(verifyRealtimeToken(`${hs512}.${p}.${hs256(`${hs512}.${p}`)}`, SECRET, NOW)).toBeNull();
  });

  it("otro secreto → null", () => {
    expect(verifyRealtimeToken(signed(), "otro-secreto-de-test", NOW)).toBeNull();
  });

  it("vencido → null (exp = ahora también es vencido)", () => {
    const t = signed();
    expect(verifyRealtimeToken(t, SECRET, new Date(NOW.getTime() + 599_000))).not.toBeNull();
    expect(verifyRealtimeToken(t, SECRET, new Date(NOW.getTime() + 600_000))).toBeNull();
    expect(verifyRealtimeToken(t, SECRET, new Date(NOW.getTime() + 3_600_000))).toBeNull();
  });

  it("claims fijos distintos (aunque firmados con el secreto) → null", () => {
    const h = b64url({ alg: "HS256", typ: "JWT" });
    const base = part(signed(), 1);
    for (const bad of [
      { ...base, purpose: "otra-cosa" },
      { ...base, role: "service_role" },
      { ...base, aud: "anon" },
      { ...base, iss: "supabase" },
      { ...base, sub: randomUUID() },
      { ...base, tenant_id: "" },
    ]) {
      const p = b64url(bad);
      expect(verifyRealtimeToken(`${h}.${p}.${hs256(`${h}.${p}`)}`, SECRET, NOW)).toBeNull();
    }
  });

  it("basura → null sin tirar", () => {
    for (const junk of ["", "a.b", "a.b.c", "....", "x.y.z.w", `${b64url({})}.${b64url({})}.`]) {
      expect(verifyRealtimeToken(junk, SECRET, NOW)).toBeNull();
    }
    expect(verifyRealtimeToken(signed(), "", NOW)).toBeNull();
  });
});
