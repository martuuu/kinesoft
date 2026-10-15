/**
 * PL-1e · C-PL6: cookies firmadas `kine_2fa` / `kine_stepup` (lib/two-factor-cookie.ts, símbolo real).
 * Se mockea solo la cookie (`next/headers`) y el ENV (la service key de la que se deriva la clave).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const jar = vi.hoisted(() => ({ map: new Map<string, string>(), opts: new Map<string, Record<string, unknown>>() }));
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (n: string) => (jar.map.has(n) ? { name: n, value: jar.map.get(n)! } : undefined),
    set: (n: string, v: string, o: Record<string, unknown>) => {
      jar.map.set(n, v);
      jar.opts.set(n, o);
    },
    delete: (n: string) => void jar.map.delete(n),
  }),
}));
const over = vi.hoisted(() => ({ key: "service-key-A" as string | undefined }));
vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  const env = new Proxy(actual.env, {
    get: (t, k: string) => (k === "SUPABASE_SERVICE_ROLE_KEY" ? over.key : (t as Record<string, unknown>)[k]),
  });
  return { ...actual, env };
});

import {
  STEP_UP_COOKIE,
  TWO_FACTOR_COOKIE,
  clearTwoFactorCookies,
  hasFreshStepUp,
  hasSessionProof,
  makeTwoFactorProofValue,
  setSessionProofCookie,
  setStepUpCookie,
  verifySessionProof,
} from "@/lib/two-factor-cookie";
import { SESSION_PROOF_TTL_S, STEP_UP_TTL_S } from "@/lib/two-factor-logic";

const U = "7f9c2b1e-3a4d-4e5f-8a6b-1c2d3e4f5a6b";
const U2 = "11111111-2222-4333-8444-555555555555";
const S1 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const S2 = "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const NOW = Date.UTC(2026, 9, 15, 15, 0, 0);

beforeEach(() => {
  jar.map.clear();
  jar.opts.clear();
  over.key = "service-key-A";
});

describe("[PL-1e] verifySessionProof", () => {
  it("vale para el mismo usuario, la misma sesión y el mismo tipo, antes de vencer", () => {
    const v = makeTwoFactorProofValue("session", U, S1, NOW);
    expect(verifySessionProof(v, U, S1, "session", NOW)).toBe(true);
    expect(verifySessionProof(v, U, S1, "session", NOW + (SESSION_PROOF_TTL_S - 1) * 1000)).toBe(true);
  });

  it("otra sesión del mismo usuario (nuevo login) → no", () => {
    expect(verifySessionProof(makeTwoFactorProofValue("session", U, S1, NOW), U, S2, "session", NOW)).toBe(false);
  });

  it("otro usuario en el mismo browser → no", () => {
    expect(verifySessionProof(makeTwoFactorProofValue("session", U, S1, NOW), U2, S1, "session", NOW)).toBe(false);
  });

  it("vencida → no (step-up a los 10 min, prueba de sesión a su TTL)", () => {
    const up = makeTwoFactorProofValue("step_up", U, S1, NOW);
    expect(verifySessionProof(up, U, S1, "step_up", NOW + (STEP_UP_TTL_S - 1) * 1000)).toBe(true);
    expect(verifySessionProof(up, U, S1, "step_up", NOW + STEP_UP_TTL_S * 1000)).toBe(false);
    const ses = makeTwoFactorProofValue("session", U, S1, NOW);
    expect(verifySessionProof(ses, U, S1, "session", NOW + SESSION_PROOF_TTL_S * 1000)).toBe(false);
  });

  it("alterada → no (mac, exp estirado, uid/sid cambiados, partes de más o de menos)", () => {
    const v = makeTwoFactorProofValue("session", U, S1, NOW);
    const [tag, uid, sid, exp, mac] = v.split(".");
    const flip = mac.slice(0, -1) + (mac.endsWith("A") ? "B" : "A");
    expect(verifySessionProof([tag, uid, sid, exp, flip].join("."), U, S1, "session", NOW)).toBe(false);
    expect(verifySessionProof([tag, uid, sid, String(Number(exp) + 60), mac].join("."), U, S1, "session", NOW)).toBe(false);
    expect(verifySessionProof([tag, U2, sid, exp, mac].join("."), U2, S1, "session", NOW)).toBe(false);
    expect(verifySessionProof([tag, uid, S2, exp, mac].join("."), U, S2, "session", NOW)).toBe(false);
    expect(verifySessionProof(`${v}.x`, U, S1, "session", NOW)).toBe(false);
    expect(verifySessionProof([tag, uid, sid, exp].join("."), U, S1, "session", NOW)).toBe(false);
    expect(verifySessionProof("1", U, S1, "session", NOW)).toBe(false);
    expect(verifySessionProof("", U, S1, "session", NOW)).toBe(false);
    expect(verifySessionProof(null, U, S1, "session", NOW)).toBe(false);
  });

  it("un exp más lejos que el TTL (bien firmado con la misma clave) → no", () => {
    // Firmada «en el futuro»: exp = ahora + 2×TTL. Nunca la emitimos así.
    const future = makeTwoFactorProofValue("step_up", U, S1, NOW + STEP_UP_TTL_S * 1000);
    expect(verifySessionProof(future, U, S1, "step_up", NOW)).toBe(false);
  });

  it("un tipo no vale como el otro (step-up ≠ prueba de sesión)", () => {
    const up = makeTwoFactorProofValue("step_up", U, S1, NOW);
    const ses = makeTwoFactorProofValue("session", U, S1, NOW);
    expect(verifySessionProof(up, U, S1, "session", NOW)).toBe(false);
    expect(verifySessionProof(ses, U, S1, "step_up", NOW)).toBe(false);
    // Aunque se le cambie la etiqueta, el mac no cierra.
    expect(verifySessionProof(up.replace(/^stepup\./, "2fa."), U, S1, "session", NOW)).toBe(false);
  });

  it("otra clave (service key rotada) → no", () => {
    const v = makeTwoFactorProofValue("session", U, S1, NOW);
    over.key = "service-key-B";
    expect(verifySessionProof(v, U, S1, "session", NOW)).toBe(false);
  });

  it("sin sessionId no hay prueba posible", () => {
    const v = makeTwoFactorProofValue("session", U, S1, NOW);
    expect(verifySessionProof(v, U, null, "session", NOW)).toBe(false);
    expect(() => makeTwoFactorProofValue("session", U, "a.b", NOW)).toThrow();
  });
});

describe("[PL-1e] cookies del request", () => {
  it("setSessionProofCookie / hasSessionProof: ida y vuelta, httpOnly, lax, path /", () => {
    setSessionProofCookie(U, S1);
    expect(hasSessionProof(U, S1)).toBe(true);
    expect(hasSessionProof(U, S2)).toBe(false);
    expect(hasSessionProof(U2, S1)).toBe(false);
    expect(jar.opts.get(TWO_FACTOR_COOKIE)).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", maxAge: SESSION_PROOF_TTL_S });
    // La prueba de sesión NO es un step-up.
    expect(hasFreshStepUp(U, S1)).toBe(false);
  });

  it("setStepUpCookie / hasFreshStepUp: strict y 10 min", () => {
    setStepUpCookie(U, S1);
    expect(hasFreshStepUp(U, S1)).toBe(true);
    expect(hasFreshStepUp(U, S2)).toBe(false);
    expect(jar.opts.get(STEP_UP_COOKIE)).toMatchObject({ httpOnly: true, sameSite: "strict", path: "/", maxAge: STEP_UP_TTL_S });
    expect(hasSessionProof(U, S1)).toBe(false);
  });

  it("clearTwoFactorCookies borra las dos", () => {
    setSessionProofCookie(U, S1);
    setStepUpCookie(U, S1);
    clearTwoFactorCookies();
    expect(hasSessionProof(U, S1)).toBe(false);
    expect(hasFreshStepUp(U, S1)).toBe(false);
  });
});
