/**
 * [BO4] Lógica pura del segundo paso de Plataforma (lib/platform-mfa-logic.ts) y de la cookie de re-verificación
 * (lib/platform-reauth.ts, firma HMAC real con node:crypto). Sin red ni Next.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined, set: () => undefined }) }));

import {
  PLATFORM_ERROR_DIGEST,
  PLATFORM_REAUTH_TTL_S,
  classifyPlatformActionError,
  decidePlatformMfa,
  mfaStatusOf,
  normalizeTotpCode,
  platformMfaRedirect,
  platformNextOrDefault,
  platformRateLimitedCopy,
  type MfaAssurance,
} from "@/lib/platform-mfa-logic";
import { rateLimitedMessage } from "@/lib/rate-limit";
import { makePlatformReauthValue, verifyPlatformReauthValue } from "@/lib/platform-reauth";
import { makeRecoveryCookieValue } from "@/lib/recovery-cookie";
import { qrDataUri } from "@/lib/platform-mfa";
import { parseEnv, platformMfaEnforcement } from "@/lib/env";

const A = (currentLevel: MfaAssurance["currentLevel"], nextLevel: MfaAssurance["nextLevel"]): MfaAssurance => ({
  currentLevel,
  nextLevel,
});
const NONE = A("aal1", "aal1");
const PENDING = A("aal1", "aal2");
const VERIFIED = A("aal2", "aal2");

describe("[BO4] mfaStatusOf", () => {
  it("aal1/aal1 = sin factor; aal1/aal2 = pendiente; aal2 = verificada", () => {
    expect(mfaStatusOf(NONE)).toBe("none");
    expect(mfaStatusOf(PENDING)).toBe("pending");
    expect(mfaStatusOf(VERIFIED)).toBe("verified");
  });
  it("sesión aal2 cuyo factor se borró después (GoTrue: nextLevel = currentLevel) sigue verificada", () => {
    expect(mfaStatusOf(A("aal2", "aal2"))).toBe("verified");
    expect(mfaStatusOf(A(null, null))).toBe("none");
  });
});

describe("[BO4] decidePlatformMfa", () => {
  const base = { risk: null, reauthFresh: false } as const;

  it("off: nunca bloquea; mfa refleja la lectura (o false sin lectura)", () => {
    for (const a of [NONE, PENDING, null]) {
      expect(decidePlatformMfa({ ...base, enforcement: "off", assurance: a, risk: "high" })).toEqual({ kind: "ok", mfa: false });
    }
    expect(decidePlatformMfa({ ...base, enforcement: "off", assurance: VERIFIED, risk: "high" })).toEqual({ kind: "ok", mfa: true });
  });

  it("enforce: sin lectura → unavailable (falla cerrado)", () => {
    expect(decidePlatformMfa({ ...base, enforcement: "enforce", assurance: null })).toEqual({ kind: "unavailable" });
  });

  it("enforce: sin factor → configurar; con factor y AAL1 → verificar (aunque sea high y tenga cookie)", () => {
    expect(decidePlatformMfa({ ...base, enforcement: "enforce", assurance: NONE })).toEqual({ kind: "setup_required" });
    expect(decidePlatformMfa({ enforcement: "enforce", assurance: PENDING, risk: "high", reauthFresh: true })).toEqual({
      kind: "verify_required",
    });
  });

  it("enforce + AAL2: low/medium/sin acción pasan; high sin re-verificación → reauth; con re-verificación ok", () => {
    for (const risk of [null, "low", "medium"] as const) {
      expect(decidePlatformMfa({ enforcement: "enforce", assurance: VERIFIED, risk, reauthFresh: false })).toEqual({ kind: "ok", mfa: true });
    }
    expect(decidePlatformMfa({ enforcement: "enforce", assurance: VERIFIED, risk: "high", reauthFresh: false })).toEqual({
      kind: "reauth_required",
    });
    expect(decidePlatformMfa({ enforcement: "enforce", assurance: VERIFIED, risk: "high", reauthFresh: true })).toEqual({
      kind: "ok",
      mfa: true,
    });
  });
});

describe("[BO4] errores que cruzan al cliente por digest", () => {
  it("reconoce cada digest; otro error → null", () => {
    expect(classifyPlatformActionError({ digest: PLATFORM_ERROR_DIGEST.reauth })).toEqual({ kind: "reauth" });
    expect(classifyPlatformActionError({ digest: PLATFORM_ERROR_DIGEST.mfaSetup })).toEqual({ kind: "mfa_setup" });
    expect(classifyPlatformActionError({ digest: PLATFORM_ERROR_DIGEST.mfaVerify })).toEqual({ kind: "mfa_verify" });
    expect(classifyPlatformActionError({ digest: PLATFORM_ERROR_DIGEST.mfaUnavailable })).toEqual({ kind: "mfa_unavailable" });
    expect(classifyPlatformActionError({ digest: "KINE_PLATFORM_RATE_LIMITED:42" })).toEqual({ kind: "rate_limited", seconds: 42 });
    expect(classifyPlatformActionError({ digest: "KINE_PLATFORM_RATE_LIMITED:nope" })).toEqual({ kind: "rate_limited", seconds: 1 });
    expect(classifyPlatformActionError({ digest: "1234567" })).toBeNull();
    expect(classifyPlatformActionError(new Error("reauth_required"))).toBeNull();
    expect(classifyPlatformActionError(null)).toBeNull();
  });

  it("el copy de rate limit del cliente es el mismo que el del server (uniforme)", () => {
    for (const ms of [1, 999, 1000, 1001, 59_500, 600_000]) {
      expect(platformRateLimitedCopy(Math.ceil(ms / 1000))).toBe(rateLimitedMessage(ms));
    }
  });
});

describe("[BO4] código y destinos", () => {
  it("normalizeTotpCode: 6 dígitos, tolera espacios y guión", () => {
    expect(normalizeTotpCode("123456")).toBe("123456");
    expect(normalizeTotpCode(" 123 456 ")).toBe("123456");
    expect(normalizeTotpCode("123-456")).toBe("123456");
    for (const bad of ["12345", "1234567", "abcdef", "", null, 123456]) expect(normalizeTotpCode(bad)).toBeNull();
  });

  it("next solo de Plataforma (sin open redirect a la app ni afuera)", () => {
    expect(platformNextOrDefault("/plataforma/consultorios")).toBe("/plataforma/consultorios");
    expect(platformNextOrDefault("/plataforma")).toBe("/plataforma");
    expect(platformNextOrDefault("/plataforma?x=1")).toBe("/plataforma?x=1");
    expect(platformNextOrDefault("/plataforma-mfa/verificar")).toBe("/plataforma");
    expect(platformNextOrDefault("/dashboard")).toBe("/plataforma");
    expect(platformNextOrDefault("/plataformaevil")).toBe("/plataforma");
    expect(platformMfaRedirect("verify", "/plataforma/usuarios")).toBe(
      `/plataforma-mfa/verificar?next=${encodeURIComponent("/plataforma/usuarios")}`
    );
    expect(platformMfaRedirect("setup", "/dashboard")).toBe(`/plataforma-mfa/configurar?next=${encodeURIComponent("/plataforma")}`);
  });

  it("qrDataUri: re-encodea el SVG que auth-js prefija sin encodear ([M4])", () => {
    const svg = '<svg fill="#000"><path d="M0 0"/></svg>';
    const out = qrDataUri(`data:image/svg+xml;utf-8,${svg}`);
    expect(out).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    expect(out).not.toContain("#");
    expect(qrDataUri(svg)).toBe(out);
    expect(qrDataUri(out)).toBe(out);
  });

  it("boot: PLATFORM_MFA_ENFORCEMENT default off, acepta off|enforce, vacío = off y un typo frena el deploy", () => {
    expect(parseEnv({}).PLATFORM_MFA_ENFORCEMENT).toBe("off");
    expect(parseEnv({ PLATFORM_MFA_ENFORCEMENT: "" }).PLATFORM_MFA_ENFORCEMENT).toBe("off");
    expect(parseEnv({ PLATFORM_MFA_ENFORCEMENT: "enforce" }).PLATFORM_MFA_ENFORCEMENT).toBe("enforce");
    expect(() => parseEnv({ PLATFORM_MFA_ENFORCEMENT: "on" })).toThrow(/PLATFORM_MFA_ENFORCEMENT/);
  });

  it("flag PLATFORM_MFA_ENFORCEMENT: default off; solo `enforce` prende", () => {
    const prev = process.env.PLATFORM_MFA_ENFORCEMENT;
    try {
      delete process.env.PLATFORM_MFA_ENFORCEMENT;
      expect(platformMfaEnforcement()).toBe("off");
      process.env.PLATFORM_MFA_ENFORCEMENT = "enforce";
      expect(platformMfaEnforcement()).toBe("enforce");
      process.env.PLATFORM_MFA_ENFORCEMENT = " ";
      expect(platformMfaEnforcement()).toBe("off");
    } finally {
      if (prev === undefined) delete process.env.PLATFORM_MFA_ENFORCEMENT;
      else process.env.PLATFORM_MFA_ENFORCEMENT = prev;
    }
  });
});

describe("[BO4] cookie de re-verificación (kine_platform_reauth)", () => {
  const now = Date.UTC(2026, 9, 14, 15, 0, 0);
  const uid = "8d0c7a52-5f4e-4b0b-9a57-3c1f2d9e0a11";

  it("vale para su usuario dentro de los 10 minutos", () => {
    const v = makePlatformReauthValue(uid, now);
    expect(verifyPlatformReauthValue(v, uid, now)).toBe(true);
    expect(verifyPlatformReauthValue(v, uid, now + (PLATFORM_REAUTH_TTL_S - 1) * 1000)).toBe(true);
  });

  it("vencida → no vale", () => {
    const v = makePlatformReauthValue(uid, now);
    expect(verifyPlatformReauthValue(v, uid, now + PLATFORM_REAUTH_TTL_S * 1000)).toBe(false);
    expect(verifyPlatformReauthValue(v, uid, now + 3600_000)).toBe(false);
  });

  it("de otro usuario → no vale (ni cambiándole el id adelante)", () => {
    const v = makePlatformReauthValue(uid, now);
    const other = "00000000-0000-4000-8000-000000000000";
    expect(verifyPlatformReauthValue(v, other, now)).toBe(false);
    const [, exp, mac] = v.split(".");
    expect(verifyPlatformReauthValue(`${other}.${exp}.${mac}`, other, now)).toBe(false);
  });

  it("firma adulterada, vencimiento estirado, formato roto o vacía → no vale", () => {
    const v = makePlatformReauthValue(uid, now);
    const [u, exp, mac] = v.split(".");
    expect(verifyPlatformReauthValue(`${u}.${exp}.${mac.slice(0, -2)}xx`, uid, now)).toBe(false);
    expect(verifyPlatformReauthValue(`${u}.${Number(exp) + 3600}.${mac}`, uid, now)).toBe(false);
    expect(verifyPlatformReauthValue(`${u}.${exp}`, uid, now)).toBe(false);
    expect(verifyPlatformReauthValue("1", uid, now)).toBe(false);
    expect(verifyPlatformReauthValue("", uid, now)).toBe(false);
    expect(verifyPlatformReauthValue(undefined, uid, now)).toBe(false);
  });

  it("una cookie de recovery (misma forma, otra etiqueta de HMAC) no sirve como re-verificación", () => {
    expect(verifyPlatformReauthValue(makeRecoveryCookieValue(uid, now), uid, now)).toBe(false);
  });
});
