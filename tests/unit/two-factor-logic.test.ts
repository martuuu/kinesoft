/**
 * PL-1e · C-PL6: tabla de `twoFactorStateOf` y clasificación de errores de step-up (lib/two-factor-logic.ts, puro).
 */
import { describe, it, expect } from "vitest";
import {
  EMAIL_CODE_MAX_ATTEMPTS,
  EMAIL_CODE_TTL_S,
  STEP_UP_TTL_S,
  TWO_FACTOR_ERROR_DIGEST,
  classifyStepUpError,
  normalizeAal,
  twoFactorStateOf,
  type SessionAssurance,
  type TwoFactorMethods,
  type TwoFactorState,
} from "@/lib/two-factor-logic";

const NONE: TwoFactorMethods = { totp: false, email: false };
const TOTP: TwoFactorMethods = { totp: true, email: false };
const EMAIL: TwoFactorMethods = { totp: false, email: true };
const BOTH: TwoFactorMethods = { totp: true, email: true };

const s = (p: Partial<SessionAssurance>): SessionAssurance => ({ aal: "aal1", sessionId: "sess-1", sessionProofValid: false, ...p });

describe("[PL-1e] twoFactorStateOf", () => {
  const table: Array<[string, TwoFactorMethods, SessionAssurance, TwoFactorState]> = [
    ["sin métodos, sesión pelada", NONE, s({}), "not_enabled"],
    ["sin métodos, sin sessionId ni aal", NONE, s({ aal: null, sessionId: null }), "not_enabled"],
    ["sin métodos aunque haya aal2", NONE, s({ aal: "aal2" }), "not_enabled"],
    ["TOTP con aal1 y sin cookie", TOTP, s({}), "required"],
    ["TOTP con aal2", TOTP, s({ aal: "aal2" }), "satisfied"],
    ["TOTP con aal1 y prueba de sesión (código de recuperación)", TOTP, s({ sessionProofValid: true }), "satisfied"],
    ["email sin prueba", EMAIL, s({}), "required"],
    ["email con prueba de sesión", EMAIL, s({ sessionProofValid: true }), "satisfied"],
    ["email con aal2 (TOTP verificado igual)", EMAIL, s({ aal: "aal2" }), "satisfied"],
    ["ambos sin nada", BOTH, s({}), "required"],
    ["ambos con aal2", BOTH, s({ aal: "aal2" }), "satisfied"],
    ["ambos con prueba", BOTH, s({ sessionProofValid: true }), "satisfied"],
    // Sin `session_id` la prueba no está ligada a nada: aunque alguien la marque válida, no alcanza.
    ["email, prueba 'válida' pero sin sessionId", EMAIL, s({ sessionId: null, sessionProofValid: true }), "required"],
    ["email, aal null (fallback) y sin prueba", EMAIL, s({ aal: null, sessionId: null }), "required"],
  ];
  for (const [name, m, a, want] of table) {
    it(name, () => expect(twoFactorStateOf(m, a)).toBe(want));
  }
});

describe("[PL-1e] normalizeAal", () => {
  it("solo aal1/aal2; cualquier otra cosa → null", () => {
    expect(normalizeAal("aal1")).toBe("aal1");
    expect(normalizeAal("aal2")).toBe("aal2");
    for (const v of [undefined, null, "", "aal3", "AAL2", 2, {}]) expect(normalizeAal(v)).toBeNull();
  });
});

describe("[PL-1e] classifyStepUpError", () => {
  it("por digest (prod: Next oculta el mensaje)", () => {
    expect(classifyStepUpError(Object.assign(new Error("x"), { digest: TWO_FACTOR_ERROR_DIGEST.stepUp }))).toEqual({ kind: "step_up" });
    expect(classifyStepUpError(Object.assign(new Error("x"), { digest: TWO_FACTOR_ERROR_DIGEST.setup }))).toEqual({ kind: "setup" });
  });
  it("por mensaje (dev), aunque el digest sea el hash de Next", () => {
    expect(classifyStepUpError(Object.assign(new Error(TWO_FACTOR_ERROR_DIGEST.stepUp), { digest: "123456" }))).toEqual({ kind: "step_up" });
  });
  it("otro error / basura → null", () => {
    for (const e of [new Error("boom"), null, undefined, "KINE_STEP_UP_REQUIRED", 42, {}]) expect(classifyStepUpError(e)).toBeNull();
  });
  it("constantes del contrato", () => {
    expect(STEP_UP_TTL_S).toBe(600);
    expect(EMAIL_CODE_TTL_S).toBe(600);
    expect(EMAIL_CODE_MAX_ATTEMPTS).toBe(5);
  });
});
