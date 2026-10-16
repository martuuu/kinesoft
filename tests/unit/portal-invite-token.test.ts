/**
 * ES4 S24t · token de invitación al portal (lib/portal-invite-token.ts, símbolo real; brief §3.3).
 * Se mockea solo el ENV (la service key de la que se deriva la clave), la cookie de `next/headers` (la importa
 * two-factor-cookie, que se usa para el cruce de etiquetas) y se espía `timingSafeEqual` sin reemplazarlo.
 * Corre en TZ=UTC (`npm test`) y en TZ=AR (`npm run test:tz-ar`): el vencimiento es epoch puro, no depende del huso.
 */
import { createHmac } from "node:crypto";
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
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined, set: () => {}, delete: () => {} }) }));
const over = vi.hoisted(() => ({ key: "service-key-A" as string | undefined }));
vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  const env = new Proxy(actual.env, {
    get: (t, k: string) => (k === "SUPABASE_SERVICE_ROLE_KEY" ? over.key : (t as Record<string, unknown>)[k]),
  });
  return { ...actual, env };
});

import {
  PORTAL_INVITE_TTL_S,
  makePortalInviteToken,
  portalEmailHash,
  readPortalInviteToken,
} from "@/lib/portal-invite-token";
import { makeRecoveryCookieValue, verifyRecoveryCookie } from "@/lib/recovery-cookie";
import { makeTwoFactorProofValue, verifySessionProof } from "@/lib/two-factor-cookie";

const P = "pat_7f9c2b1e3a4d";
const T = "ten_11112222";
const EMAIL = "ana.perez@example.com";
const NOW = Date.UTC(2026, 9, 15, 15, 0, 0);
const U = "7f9c2b1e-3a4d-4e5f-8a6b-1c2d3e4f5a6b";
const S = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

/** Firma un payload arbitrario con la clave derivada de `label` (reimplementa la derivación a mano). */
function signWithLabel(payload: string, label: string): string {
  const key = createHmac("sha256", over.key!).update(label).digest();
  return createHmac("sha256", key).update(payload).digest("base64url");
}
function payloadOf(o: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(o)).toString("base64url");
}

beforeEach(() => {
  over.key = "service-key-A";
  spy.calls = 0;
});

describe("[ES4-S24t] ida y vuelta", () => {
  it("lo que se firma se lee igual, con exp = ahora + 7 días", () => {
    const tok = makePortalInviteToken({ patientId: P, tenantId: T, email: EMAIL }, NOW);
    expect(readPortalInviteToken(tok, NOW)).toEqual({
      patientId: P,
      tenantId: T,
      emailHash: portalEmailHash(EMAIL),
      exp: Math.floor(NOW / 1000) + PORTAL_INVITE_TTL_S,
    });
  });

  it("el token es URL-safe (viaja en ?t=) y no lleva el email en claro", () => {
    const tok = makePortalInviteToken({ patientId: P, tenantId: T, email: EMAIL }, NOW);
    expect(tok).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(Buffer.from(tok.split(".")[0], "base64url").toString("utf8")).not.toContain("ana");
  });

  it("vacío, null, undefined o basura → null", () => {
    for (const v of [null, undefined, "", "x", "a.b.c", ".", "abc.", ".abc", "x".repeat(5000)]) {
      expect(readPortalInviteToken(v, NOW)).toBeNull();
    }
  });
});

describe("[ES4-S24t] vencimiento", () => {
  const tok = () => makePortalInviteToken({ patientId: P, tenantId: T, email: EMAIL }, NOW);

  it("vale a los 7 d − 1 s", () => {
    expect(readPortalInviteToken(tok(), NOW + (PORTAL_INVITE_TTL_S - 1) * 1000)).not.toBeNull();
  });
  it("vencido a los 7 d + 1 s", () => {
    expect(readPortalInviteToken(tok(), NOW + (PORTAL_INVITE_TTL_S + 1) * 1000)).toBeNull();
  });
  it("vencido justo en el exp", () => {
    expect(readPortalInviteToken(tok(), NOW + PORTAL_INVITE_TTL_S * 1000)).toBeNull();
  });
  it("un exp más lejos que el TTL (bien firmado) no lo emitimos nunca → null", () => {
    const pl = payloadOf({ p: P, t: T, e: portalEmailHash(EMAIL), x: Math.floor(NOW / 1000) + 30 * 24 * 3600 });
    expect(readPortalInviteToken(`${pl}.${signWithLabel(pl, "kinesoft:portal-invite:v1")}`, NOW)).toBeNull();
  });
});

describe("[ES4-S24t] firma", () => {
  it("cambiar el paciente, el consultorio o estirar el exp con la firma vieja → null", () => {
    const [, mac] = makePortalInviteToken({ patientId: P, tenantId: T, email: EMAIL }, NOW).split(".");
    const base = { p: P, t: T, e: portalEmailHash(EMAIL), x: Math.floor(NOW / 1000) + PORTAL_INVITE_TTL_S };
    for (const forged of [
      { ...base, p: "pat_otro" },
      { ...base, t: "ten_otro" },
      { ...base, x: base.x + 3600 },
      { ...base, e: portalEmailHash("otro@example.com") },
    ]) {
      expect(readPortalInviteToken(`${payloadOf(forged)}.${mac}`, NOW)).toBeNull();
    }
  });

  it("un byte del MAC alterado → null", () => {
    const tok = makePortalInviteToken({ patientId: P, tenantId: T, email: EMAIL }, NOW);
    const last = tok.at(-1)!;
    expect(readPortalInviteToken(tok.slice(0, -1) + (last === "A" ? "B" : "A"), NOW)).toBeNull();
  });

  it("otra service key (otro entorno / rotación) → null", () => {
    const tok = makePortalInviteToken({ patientId: P, tenantId: T, email: EMAIL }, NOW);
    over.key = "service-key-B";
    expect(readPortalInviteToken(tok, NOW)).toBeNull();
  });

  it("payload bien firmado pero con forma inválida → null (no tira)", () => {
    for (const o of [
      { p: "", t: T, e: portalEmailHash(EMAIL), x: Math.floor(NOW / 1000) + 60 },
      { p: P, t: T, e: "no-es-hash", x: Math.floor(NOW / 1000) + 60 },
      { p: P, t: T, e: portalEmailHash(EMAIL), x: "mañana" },
      { p: P, t: 7, e: portalEmailHash(EMAIL), x: Math.floor(NOW / 1000) + 60 },
    ]) {
      const pl = payloadOf(o);
      expect(readPortalInviteToken(`${pl}.${signWithLabel(pl, "kinesoft:portal-invite:v1")}`, NOW)).toBeNull();
    }
    const notJson = Buffer.from("{nope").toString("base64url");
    expect(readPortalInviteToken(`${notJson}.${signWithLabel(notJson, "kinesoft:portal-invite:v1")}`, NOW)).toBeNull();
  });

  it("make rechaza ids vacíos o email vacío", () => {
    expect(() => makePortalInviteToken({ patientId: "", tenantId: T, email: EMAIL }, NOW)).toThrow();
    expect(() => makePortalInviteToken({ patientId: P, tenantId: T, email: "  " }, NOW)).toThrow();
  });
});

describe("[ES4-S24t] etiqueta propia: no se cruza con las otras cookies firmadas", () => {
  it("control: el helper de la prueba reproduce la clave del portal (si no, los rechazos de abajo no prueban nada)", () => {
    const pl = payloadOf({ p: P, t: T, e: portalEmailHash(EMAIL), x: Math.floor(NOW / 1000) + 60 });
    expect(readPortalInviteToken(`${pl}.${signWithLabel(pl, "kinesoft:portal-invite:v1")}`, NOW)).not.toBeNull();
  });

  it("el mismo payload firmado con la etiqueta de recovery o de 2FA → null", () => {
    const pl = payloadOf({ p: P, t: T, e: portalEmailHash(EMAIL), x: Math.floor(NOW / 1000) + 60 });
    for (const label of ["kinesoft:recovery-cookie:v1", "kinesoft:two-factor:v1"]) {
      expect(readPortalInviteToken(`${pl}.${signWithLabel(pl, label)}`, NOW)).toBeNull();
    }
  });

  it("valores reales de recovery y de 2FA no valen como invitación", () => {
    expect(readPortalInviteToken(makeRecoveryCookieValue(U, NOW), NOW)).toBeNull();
    expect(readPortalInviteToken(makeTwoFactorProofValue("session", U, S, NOW), NOW)).toBeNull();
    expect(readPortalInviteToken(makeTwoFactorProofValue("step_up", U, S, NOW), NOW)).toBeNull();
  });

  it("una invitación no vale como recovery ni como 2FA", () => {
    const tok = makePortalInviteToken({ patientId: P, tenantId: T, email: EMAIL }, NOW);
    expect(verifyRecoveryCookie(tok, P, NOW)).toBe(false);
    expect(verifySessionProof(tok, P, T, "session", NOW)).toBe(false);
    // Aun acomodando el formato de recovery (`<id>.<exp>.<mac>`) con el MAC de la invitación: no cierra.
    const [, mac] = tok.split(".");
    const exp = Math.floor(NOW / 1000) + 600;
    expect(verifyRecoveryCookie(`${U}.${exp}.${mac}`, U, NOW)).toBe(false);
  });
});

describe("[ES4-S24t] portalEmailHash", () => {
  it("mayúsculas y espacios → mismo hash (sha256 hex de lower(trim))", () => {
    const h = portalEmailHash("ana.perez@example.com");
    expect(portalEmailHash("Ana.Perez@EXAMPLE.com")).toBe(h);
    expect(portalEmailHash("  ANA.PEREZ@example.com \n")).toBe(h);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(portalEmailHash("otra@example.com")).not.toBe(h);
  });

  it("el token firmado con el email en mayúsculas lleva el mismo hash", () => {
    const tok = makePortalInviteToken({ patientId: P, tenantId: T, email: "ANA.Perez@Example.COM" }, NOW);
    expect(readPortalInviteToken(tok, NOW)?.emailHash).toBe(portalEmailHash(EMAIL));
  });
});

describe("[ES4-S24t] comparación en tiempo constante", () => {
  it("el MAC se compara con timingSafeEqual (válido y alterado de igual largo)", () => {
    const tok = makePortalInviteToken({ patientId: P, tenantId: T, email: EMAIL }, NOW);
    spy.calls = 0;
    expect(readPortalInviteToken(tok, NOW)).not.toBeNull();
    expect(spy.calls).toBe(1);
    const last = tok.at(-1)!;
    expect(readPortalInviteToken(tok.slice(0, -1) + (last === "A" ? "B" : "A"), NOW)).toBeNull();
    expect(spy.calls).toBe(2);
  });

  it("no hay `===` sobre el MAC en el fuente", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("lib/portal-invite-token.ts", "utf8");
    expect(src).toMatch(/timingSafeEqual\(expected, got\)/);
    expect(src).not.toMatch(/(mac|got|expected)\s*[!=]==\s*(mac|got|expected|sign)/);
  });
});
