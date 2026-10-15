/**
 * PF-0b · `getSessionUser` (lib/session-user.ts): la lectura de CADA request ya no va a GoTrue.
 *
 * Símbolo real. Se mockea solo la red/cookie de Supabase (`@/lib/supabase/server`: `getSession` lee la cookie,
 * `getUser` es la ida y vuelta a GoTrue, `getClaims` el JWKS) y el ENV. Se afirma lo observable: qué usuario sale y
 * cuántas veces se llamó a GoTrue.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHmac } from "node:crypto";

// `next start` instala `globalThis.AsyncLocalStorage` al arrancar; el store de Next lo necesita para `run`.
vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  (globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage;
});
import { requestAsyncStorage } from "next/dist/client/components/request-async-storage.external";

const SECRET = "unit-test-jwt-secret-0123456789abcdef";
const URL_PUB = "https://abcd1234.supabase.co";
const SUB = "7f9c2b1e-3a4d-4e5f-8a6b-1c2d3e4f5a6b";

const sb = vi.hoisted(() => ({
  token: null as string | null,
  sessionError: null as unknown,
  noGetSession: false,
  getUserCalls: 0,
  lastGetUserArg: undefined as unknown,
  getClaimsCalls: 0,
  gotrueUser: null as Record<string, unknown> | null,
  claims: null as Record<string, unknown> | null,
}));
vi.mock("@/lib/supabase/server", () => ({
  getSupabaseServerClient: () => ({
    auth: {
      ...(sb.noGetSession
        ? {}
        : {
            getSession: async () =>
              sb.sessionError
                ? { data: { session: null }, error: sb.sessionError }
                : { data: { session: sb.token ? { access_token: sb.token } : null }, error: null },
          }),
      getUser: async (jwt?: string) => {
        sb.getUserCalls++;
        sb.lastGetUserArg = jwt;
        return sb.gotrueUser ? { data: { user: sb.gotrueUser }, error: null } : { data: { user: null }, error: { message: "invalid JWT" } };
      },
      getClaims: async () => {
        sb.getClaimsCalls++;
        return sb.claims ? { data: { claims: sb.claims }, error: null } : { data: null, error: { message: "Invalid JWT signature" } };
      },
    },
  }),
}));

const over = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));
vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  const env = new Proxy(actual.env, {
    get: (t, k: string) => (k in over.values ? over.values[k] : (t as Record<string, unknown>)[k]),
  });
  return { ...actual, env };
});

import { getSessionUser, getStrictSessionUser } from "@/lib/session-user";

const NOW = () => Math.floor(Date.now() / 1000);
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function claims(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: `${URL_PUB}/auth/v1`,
    sub: SUB,
    aud: "authenticated",
    exp: NOW() + 3600,
    iat: NOW() - 10,
    email: "kine@consultorio.test",
    user_metadata: { full_name: "Ana Kine" },
    role: "authenticated",
    aal: "aal1",
    session_id: "0b5f6c7d-1111-4222-8333-944455556666",
    ...over,
  };
}
function hs256(payload: Record<string, unknown>, secret = SECRET, header: Record<string, unknown> = { alg: "HS256", typ: "JWT" }) {
  const input = `${b64(header)}.${b64(payload)}`;
  return `${input}.${createHmac("sha256", secret).update(input).digest("base64url")}`;
}
const GOTRUE_USER = {
  id: SUB,
  email: "kine@consultorio.test",
  email_confirmed_at: "2026-01-01T00:00:00Z",
  user_metadata: { full_name: "Ana Kine" },
};

/** Corre `fn` dentro de un «request» de Next (el store que usa la memo). */
function inRequest<T>(fn: () => Promise<T>): Promise<T> {
  return requestAsyncStorage.run({} as never, fn);
}

beforeEach(() => {
  over.values = { SUPABASE_JWT_SECRET: SECRET, NEXT_PUBLIC_SUPABASE_URL: URL_PUB };
  Object.assign(sb, {
    token: null,
    sessionError: null,
    noGetSession: false,
    getUserCalls: 0,
    getClaimsCalls: 0,
    gotrueUser: GOTRUE_USER,
    claims: null,
  });
});

describe("[PF-0b] getSessionUser", () => {
  it("token válido → el usuario del token, CERO llamadas a GoTrue", async () => {
    sb.token = hs256(claims());
    expect(await getSessionUser()).toEqual({
      id: SUB,
      email: "kine@consultorio.test",
      fullName: "Ana Kine",
      avatarUrl: null,
      sessionId: "0b5f6c7d-1111-4222-8333-944455556666",
      aal: "aal1",
      verifiedBy: "jwt",
    });
    expect(sb.getUserCalls).toBe(0);
  });

  it("sin cookie de sesión → null sin red; error al leer/refrescar la sesión → null", async () => {
    expect(await getSessionUser()).toBeNull();
    sb.sessionError = { message: "refresh_token_not_found" };
    expect(await getSessionUser()).toBeNull();
    expect(sb.getUserCalls).toBe(0);
  });

  it("token vencido → null, sin preguntarle a GoTrue", async () => {
    sb.token = hs256(claims({ exp: NOW() - 120 }));
    expect(await getSessionUser()).toBeNull();
    expect(sb.getUserCalls).toBe(0);
  });

  it("token alterado → decide GoTrue: lo rechaza → null (nunca se acepta por la cookie sola)", async () => {
    const [h, , s] = hs256(claims()).split(".");
    sb.token = `${h}.${b64(claims({ sub: "11111111-2222-4333-8444-555555555555" }))}.${s}`;
    sb.gotrueUser = null;
    expect(await getSessionUser()).toBeNull();
    expect(sb.getUserCalls).toBe(1);
  });

  it("firmado con otra clave → GoTrue lo rechaza → null", async () => {
    sb.token = hs256(claims(), "otra-clave-de-otro-proyecto-xxxxxxxx");
    sb.gotrueUser = null;
    expect(await getSessionUser()).toBeNull();
    expect(sb.getUserCalls).toBe(1);
  });

  it("de otro `iss` → GoTrue lo rechaza → null", async () => {
    sb.token = hs256(claims({ iss: "https://otro.supabase.co/auth/v1" }));
    sb.gotrueUser = null;
    expect(await getSessionUser()).toBeNull();
    expect(sb.getUserCalls).toBe(1);
  });

  it("secreto de Vercel distinto del de GoTrue (config) → cae a GoTrue y la sesión sigue andando", async () => {
    over.values.SUPABASE_JWT_SECRET = "secreto-desactualizado-xxxxxxxxxxxxxx";
    sb.token = hs256(claims());
    expect(await getSessionUser()).toMatchObject({ id: SUB, verifiedBy: "gotrue" });
    expect(sb.getUserCalls).toBe(1);
  });

  it("sin SUPABASE_JWT_SECRET → GoTrue, como antes de PF-0b", async () => {
    over.values.SUPABASE_JWT_SECRET = undefined;
    sb.token = hs256(claims());
    expect(await getSessionUser()).toMatchObject({ id: SUB, verifiedBy: "gotrue" });
    expect(sb.getUserCalls).toBe(1);
  });

  it("supabase-js sin `getSession` (API cambiada) → GoTrue, nunca tira", async () => {
    sb.noGetSession = true;
    expect(await getSessionUser()).toMatchObject({ id: SUB, verifiedBy: "gotrue" });
    sb.gotrueUser = null;
    expect(await getSessionUser()).toBeNull();
  });

  it("ES256: lo verifica getClaims (JWKS) y se repasan iss/claims; firma mala → null", async () => {
    sb.token = hs256(claims(), SECRET, { alg: "ES256", typ: "JWT", kid: "k1" }); // la firma la «prueba» el mock de getClaims
    sb.claims = claims();
    expect(await getSessionUser()).toMatchObject({ id: SUB, verifiedBy: "jwt" });
    sb.claims = claims({ iss: "https://otro.supabase.co/auth/v1" });
    sb.gotrueUser = null;
    expect(await getSessionUser()).toBeNull();
    sb.claims = null; // getClaims: firma inválida
    expect(await getSessionUser()).toBeNull();
    expect(sb.getClaimsCalls).toBe(3);
  });

  it("memo por request y por token: dos lecturas en el mismo request = una verificación; token nuevo = otra", async () => {
    over.values.SUPABASE_JWT_SECRET = undefined; // camino que llama a GoTrue: así se cuentan las verificaciones
    sb.token = hs256(claims());
    await inRequest(async () => {
      await getSessionUser();
      await getSessionUser();
      expect(sb.getUserCalls).toBe(1);
      sb.token = hs256(claims({ session_id: "otra-sesion" }));
      await getSessionUser();
      expect(sb.getUserCalls).toBe(2);
    });
    // Otro request: no reusa.
    await inRequest(() => getSessionUser());
    expect(sb.getUserCalls).toBe(3);
  });
});

describe("[PF-0b] getStrictSessionUser", () => {
  it("siempre GoTrue y trae emailConfirmedAt (que el JWT no tiene)", async () => {
    sb.token = hs256(claims());
    expect(await getStrictSessionUser()).toEqual({
      id: SUB,
      email: "kine@consultorio.test",
      emailConfirmedAt: "2026-01-01T00:00:00Z",
      fullName: "Ana Kine",
      avatarUrl: null,
      // PL-1e: del token que GoTrue validó.
      aal: "aal1",
      sessionId: "0b5f6c7d-1111-4222-8333-944455556666",
    });
    expect(sb.getUserCalls).toBe(1);
  });

  it("[PL-1e] valida con GoTrue EL token de la cookie y le lee aal2/session_id", async () => {
    const tok = hs256(claims({ aal: "aal2", session_id: "sess-aal2" }));
    sb.token = tok;
    expect(await getStrictSessionUser()).toMatchObject({ id: SUB, aal: "aal2", sessionId: "sess-aal2" });
    expect(sb.lastGetUserArg).toBe(tok);
  });

  it("[PL-1e] GoTrue rechaza el token → null (los claims nunca se leen solos)", async () => {
    sb.token = hs256(claims({ aal: "aal2" }));
    sb.gotrueUser = null;
    expect(await getStrictSessionUser()).toBeNull();
  });

  it("[PL-1e] sin getSession (API cambiada): getUser() pelado, sin datos de 2FA", async () => {
    sb.noGetSession = true;
    expect(await getStrictSessionUser()).toMatchObject({ id: SUB, aal: null, sessionId: null });
    expect(sb.lastGetUserArg).toBeUndefined();
  });

  it("[PL-1e] aal desconocido → null", async () => {
    sb.token = hs256(claims({ aal: "aal3" }));
    expect(await getStrictSessionUser()).toMatchObject({ aal: null });
  });
});

describe("[PL-1e] getSessionUser trae aal/sessionId también por el camino de GoTrue", () => {
  it("fallback (secreto distinto) → aal y session_id del token que GoTrue validó", async () => {
    over.values.SUPABASE_JWT_SECRET = "secreto-desactualizado-xxxxxxxxxxxxxx";
    sb.token = hs256(claims({ aal: "aal2", session_id: "sess-fb" }));
    expect(await getSessionUser()).toMatchObject({ id: SUB, verifiedBy: "gotrue", aal: "aal2", sessionId: "sess-fb" });
  });

  it("JWT local: aal normalizado (valor raro → null)", async () => {
    sb.token = hs256(claims({ aal: "aal9" }));
    expect(await getSessionUser()).toMatchObject({ verifiedBy: "jwt", aal: null });
  });
});
