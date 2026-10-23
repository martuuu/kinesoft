/**
 * TV-2d (T7, §26.4 C-TV, D12/D13) · `mintDisplayRealtimeToken`: el token del canal para la PANTALLA de la sala.
 *
 * Se corre la action REAL con el firmador real y el rate limit real (memoria). Lo único reemplazado es la sesión del
 * dispositivo (`resolveDisplaySession`, que lee la cookie y la base: su comportamiento real se prueba en
 * `tests/integration/tv-feed.test.ts`, incluidos revocada y módulo revocado contra Postgres) y el ENV.
 *
 * Qué se fija: claims verificables con `verifyRealtimeToken` y re-verificados a mano con `node:crypto` (mismo
 * `signRealtimeToken({tenantId})` que el staff → mismo topic, M5 sin cambios); denegado si la pantalla no está
 * vinculada, revocada, el módulo está apagado, el driver no es `supabase`, falta el secreto o se pasó el rate limit
 * `rt:display:<id>` (30 cada 10 min); nunca tira; y el logger NUNCA recibe el token ni el secreto.
 */
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const over = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));
vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  const env = new Proxy(actual.env, {
    get: (t, k: string) => (k in over.values ? over.values[k] : (t as Record<string, unknown>)[k]),
  });
  return { ...actual, env };
});

type Session =
  | { state: "paired"; displayId: string; tenantId: string }
  | { state: "unpaired" | "revoked" }
  | { state: "unavailable"; reason: "access_closed" | "no_module" }
  | { state: "throw" };
const sess = vi.hoisted(() => ({ current: { state: "unpaired" } as Session }));
vi.mock("@/lib/display-device-internal", () => ({
  resolveDisplaySession: async () => {
    if (sess.current.state === "throw") throw new Error("base caída");
    return sess.current.state === "paired"
      ? {
          ...sess.current,
          locationId: null,
          isPrimaryLocation: false,
          clinicName: "X",
          locationName: null,
          config: {},
          renewCookie: false,
        }
      : sess.current;
  },
}));

import { mintDisplayRealtimeToken } from "@/lib/realtime-display-token";
import { verifyRealtimeToken } from "@/lib/realtime-token-internal";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { __resetMintDeniedLogForTests } from "@/lib/realtime-mint-log";
import { logger } from "@/lib/logger";

const SECRET = "unit-test-secret-tv-display-0123456789abcdef";
const TENANT = "ckz9tenant00000000000tv01";
const PAIRED: Session = { state: "paired", displayId: "disp_123", tenantId: TENANT };

function setEnv(v: Record<string, unknown> = {}) {
  over.values = {
    UPSTASH_REDIS_REST_URL: undefined,
    UPSTASH_REDIS_REST_TOKEN: undefined,
    REALTIME_DRIVER: "supabase",
    SUPABASE_JWT_SECRET: SECRET,
    SUPABASE_JWT_KID: undefined,
    ...v,
  };
}

const logCalls: unknown[][] = [];
beforeEach(() => {
  setEnv();
  sess.current = PAIRED;
  __rateLimitInternals.reset();
  __resetMintDeniedLogForTests();
  logCalls.length = 0;
  for (const m of ["debug", "info", "warn", "error"] as const) {
    vi.spyOn(logger, m).mockImplementation((...args: unknown[]) => void logCalls.push([m, ...args]));
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  over.values = {};
});

describe("[TV-2d] mintDisplayRealtimeToken", () => {
  it("[TV-2d] vinculada + supabase + secreto → token verificable, mismos claims y tenant de la pantalla", async () => {
    const r = await mintDisplayRealtimeToken();
    if (!r.ok) throw new Error(r.error);
    const claims = verifyRealtimeToken(r.data.token, SECRET);
    expect(claims).toMatchObject({
      iss: "kinesoft-realtime",
      aud: "authenticated",
      role: "authenticated",
      purpose: "kinesoft-realtime",
      tenant_id: TENANT,
    });
    expect(Object.keys(claims!).sort()).toEqual(["aud", "exp", "iat", "iss", "purpose", "role", "sub", "tenant_id"]);
    expect(new Date(r.data.expiresAt).getTime()).toBe(claims!.exp * 1000);
    // A mano, como Supabase: si el firmador hiciera algo que solo nuestro verify entiende, esto cae.
    const [h, p, s] = r.data.token.split(".");
    expect(s).toBe(createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url"));
    expect(logCalls).toEqual([]);
  });

  it("[TV-2d] denegado: sin vincular, revocada, módulo/acceso apagado, driver off/local, sin secreto", async () => {
    for (const s of [
      { state: "unpaired" },
      { state: "revoked" },
      { state: "unavailable", reason: "no_module" },
      { state: "unavailable", reason: "access_closed" },
    ] as Session[]) {
      sess.current = s;
      const r = await mintDisplayRealtimeToken();
      expect(r.ok, s.state).toBe(false);
    }
    sess.current = PAIRED;
    for (const driver of ["off", "local"]) {
      setEnv({ REALTIME_DRIVER: driver });
      expect(await mintDisplayRealtimeToken()).toEqual({ ok: false, error: "realtime-off" });
    }
    setEnv({ SUPABASE_JWT_SECRET: undefined });
    expect(await mintDisplayRealtimeToken()).toEqual({ ok: false, error: "realtime-unconfigured" });
  });

  it("[TV-2d] rate limit rt:display:<id>: 30 cada 10 min por pantalla; otra pantalla sigue", async () => {
    for (let i = 0; i < 30; i++) expect((await mintDisplayRealtimeToken()).ok).toBe(true);
    const r = await mintDisplayRealtimeToken();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Demasiados intentos/);
    sess.current = { state: "paired", displayId: "disp_otra", tenantId: TENANT };
    expect((await mintDisplayRealtimeToken()).ok).toBe(true);
  });

  it("[TV-2d] nunca tira: un error de la sesión → {ok:false, error:'realtime-error'}", async () => {
    sess.current = { state: "throw" };
    expect(await mintDisplayRealtimeToken()).toEqual({ ok: false, error: "realtime-error" });
  });

  it("[TV-2d] el logger nunca recibe el token ni el secreto (éxitos, rechazos y errores)", async () => {
    const tokens: string[] = [];
    for (let i = 0; i < 31; i++) {
      const r = await mintDisplayRealtimeToken();
      if (r.ok) tokens.push(r.data.token);
    }
    sess.current = { state: "revoked" };
    await mintDisplayRealtimeToken();
    sess.current = { state: "unavailable", reason: "no_module" };
    await mintDisplayRealtimeToken();
    sess.current = { state: "throw" };
    await mintDisplayRealtimeToken();
    sess.current = PAIRED;
    setEnv({ SUPABASE_JWT_SECRET: undefined });
    await mintDisplayRealtimeToken();

    expect(tokens.length).toBe(30);
    expect(logCalls.length).toBeGreaterThan(0); // los rechazos sí se loguean (con código de motivo)
    const logged = JSON.stringify(logCalls);
    for (const t of tokens) {
      expect(logged).not.toContain(t);
      expect(logged).not.toContain(t.split(".")[2]);
    }
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toMatch(/eyJ/);
    const deny = logCalls.filter((c) => c[1] === "realtime.mint_denied");
    expect(deny.map((c) => (c[2] as { reason: string }).reason).sort()).toEqual(
      ["no_capability", "rate_limited", "unauthenticated", "unconfigured"].sort()
    );
  });
});
