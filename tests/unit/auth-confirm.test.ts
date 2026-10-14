/**
 * IAM-2c · `/auth/confirm` resistente a escáneres: la lógica pura del GET → `continuar` → POST
 * (`lib/auth-confirm-internal.ts`).
 *
 * Por qué: Outlook Safe Links (y otros escáneres de correo) ABREN cada link antes que la persona. Si el
 * GET canjeaba el token, el escáner lo gastaba y la persona llegaba a «El link venció o ya se usó». Ahora
 * el GET solo valida la forma y manda a una página intermedia que canjea por POST; acá se fija:
 *  - qué parámetros pasan (forma del token, tipos cerrados, `next` saneado, sin open redirect);
 *  - la URL de la página intermedia (lleva los parámetros YA saneados);
 *  - el chequeo de origen del POST (un form de otro sitio no puede loguear a nadie con un link ajeno).
 */
import { describe, expect, it } from "vitest";
import {
  CONFIRM_TYPES,
  confirmContinuePath,
  isConfirmPostAllowed,
  parseConfirmParams,
} from "@/lib/auth-confirm-internal";

const APP = "https://app.kinesoft.test";
const ORIGINS = [APP, "http://localhost:3000"];
const HASH = "a".repeat(56);

const fromQuery = (q: string) => {
  const sp = new URLSearchParams(q);
  return parseConfirmParams((k) => sp.get(k), ORIGINS);
};

describe("parseConfirmParams", () => {
  it("token_hash + type válidos + next propio → pasa tal cual", () => {
    expect(fromQuery(`token_hash=${HASH}&type=signup&next=/onboarding`)).toEqual({
      tokenHash: HASH,
      type: "signup",
      next: "/onboarding",
    });
  });

  it("los tipos aceptados son exactamente los que emite la app o las plantillas viejas", () => {
    expect([...CONFIRM_TYPES].sort()).toEqual(["email", "invite", "magiclink", "recovery", "signup"]);
    for (const t of CONFIRM_TYPES) expect(fromQuery(`token_hash=${HASH}&type=${t}`)?.type).toBe(t);
  });

  it("sin token_hash, sin type, o type desconocido → null (link inválido)", () => {
    expect(fromQuery(`type=signup`)).toBeNull();
    expect(fromQuery(`token_hash=${HASH}`)).toBeNull();
    expect(fromQuery(`token_hash=${HASH}&type=email_change`)).toBeNull();
    expect(fromQuery(`token_hash=${HASH}&type=`)).toBeNull();
  });

  it("token_hash con forma rara (espacios, comillas, larguísimo, cortito) → null", () => {
    expect(fromQuery(`token_hash=${encodeURIComponent("abc def ghi jkl")}&type=signup`)).toBeNull();
    expect(fromQuery(`token_hash=${encodeURIComponent('"><script>')}&type=signup`)).toBeNull();
    expect(fromQuery(`token_hash=${"a".repeat(600)}&type=signup`)).toBeNull();
    expect(fromQuery(`token_hash=abc&type=signup`)).toBeNull();
  });

  it("acepta el token_hash con prefijo pkce_ de las plantillas viejas", () => {
    expect(fromQuery(`token_hash=pkce_${HASH}&type=recovery`)?.tokenHash).toBe(`pkce_${HASH}`);
  });

  it("next: default /reset para recovery y /dashboard para el resto", () => {
    expect(fromQuery(`token_hash=${HASH}&type=recovery`)?.next).toBe("/reset");
    expect(fromQuery(`token_hash=${HASH}&type=signup`)?.next).toBe("/dashboard");
  });

  it("next: open redirects → fallback; URL absoluta propia → path", () => {
    for (const evil of ["//evil.com", "https://evil.com/x", "/\\evil.com", "@evil.com", "javascript:alert(1)"]) {
      expect(fromQuery(`token_hash=${HASH}&type=signup&next=${encodeURIComponent(evil)}`)?.next).toBe("/dashboard");
    }
    expect(fromQuery(`token_hash=${HASH}&type=signup&next=${encodeURIComponent(`${APP}/invite/abc`)}`)?.next).toBe(
      "/invite/abc"
    );
  });

  it("next que vuelve a /auth/confirm se desenvuelve (bug signup-confirm-doble-salto)", () => {
    expect(
      fromQuery(`token_hash=${HASH}&type=signup&next=${encodeURIComponent("/auth/confirm?next=/onboarding")}`)?.next
    ).toBe("/onboarding");
  });
});

describe("confirmContinuePath", () => {
  it("lleva a /auth/confirm/continuar con los parámetros ya saneados", () => {
    const p = confirmContinuePath({ tokenHash: HASH, type: "recovery", next: "/reset" });
    const u = new URL(p, APP);
    expect(u.pathname).toBe("/auth/confirm/continuar");
    expect(Object.fromEntries(u.searchParams)).toEqual({ token_hash: HASH, type: "recovery", next: "/reset" });
  });
});

describe("isConfirmPostAllowed", () => {
  const h = (init: Record<string, string>) => new Headers(init);

  it("Origin propio → sí; Origin ajeno → no", () => {
    expect(isConfirmPostAllowed(h({ origin: APP }), ORIGINS)).toBe(true);
    expect(isConfirmPostAllowed(h({ origin: "https://evil.com" }), ORIGINS)).toBe(false);
    expect(isConfirmPostAllowed(h({ origin: "https://app.kinesoft.test.evil.com" }), ORIGINS)).toBe(false);
  });

  it("Origin: null solo pasa si Sec-Fetch-Site dice same-origin (política de referrer estricta)", () => {
    expect(isConfirmPostAllowed(h({ origin: "null", "sec-fetch-site": "same-origin" }), ORIGINS)).toBe(true);
    expect(isConfirmPostAllowed(h({ origin: "null", "sec-fetch-site": "cross-site" }), ORIGINS)).toBe(false);
    expect(isConfirmPostAllowed(h({ origin: "null" }), ORIGINS)).toBe(false);
  });

  it("sin Origin: decide Sec-Fetch-Site (cross-site/same-site no)", () => {
    expect(isConfirmPostAllowed(h({ "sec-fetch-site": "same-origin" }), ORIGINS)).toBe(true);
    expect(isConfirmPostAllowed(h({ "sec-fetch-site": "cross-site" }), ORIGINS)).toBe(false);
    expect(isConfirmPostAllowed(h({ "sec-fetch-site": "same-site" }), ORIGINS)).toBe(false);
  });
});
