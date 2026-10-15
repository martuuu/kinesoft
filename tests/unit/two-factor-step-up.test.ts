/**
 * PL-2a · step-up (C-PL6): la decisión de `requireStepUp` y que el error que viaja al cliente (con el mensaje tapado
 * por Next en prod) lo reconozca `useStepUpAction`. Clases REALES del server (`lib/two-factor-step-up.ts`); la
 * integración (`tests/integration/two-factor.test.ts`) cubre `requireStepUp` contra la sesión y la cookie.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: () => ({ get: () => undefined }), headers: () => new Headers() }));
vi.mock("@/lib/session", () => {
  class ForbiddenError extends Error {
    constructor(public reason = "forbidden") {
      super(reason);
    }
  }
  class UnauthenticatedError extends Error {}
  return { ForbiddenError, UnauthenticatedError, getAccessSnapshot: vi.fn() };
});
vi.mock("@/lib/session-user", () => ({ getSessionUser: vi.fn(), getStrictSessionUser: vi.fn() }));
// El modal importa las actions ("use server"); acá solo se prueba su traducción de errores.
vi.mock("@/lib/two-factor", () => ({ getStepUpOptions: vi.fn() }));

import { StepUpRequiredError, TwoFactorSetupRequiredError, stepUpDecision } from "@/lib/two-factor-step-up";
import { classifyStepUpError } from "@/lib/two-factor-logic";
import { STEP_UP_SETUP_REQUIRED, stepUpFailureOf } from "@/components/account/step-up-modal";

function asProd(err: Error & { digest?: string }) {
  return Object.assign(new Error("An error occurred in the Server Components render."), { digest: err.digest });
}

describe("[PL-2a] step-up", () => {
  it("decisión: sin método → setup; con método sin cookie → step_up; con cookie → ok", () => {
    expect(stepUpDecision({ totp: false, email: false }, true)).toBe("setup");
    expect(stepUpDecision({ totp: true, email: false }, false)).toBe("step_up");
    expect(stepUpDecision({ totp: false, email: true }, false)).toBe("step_up");
    expect(stepUpDecision({ totp: false, email: true }, true)).toBe("ok");
  });

  it("los digests sobreviven a prod y el cliente los distingue", () => {
    expect(classifyStepUpError(asProd(new StepUpRequiredError()))).toEqual({ kind: "step_up" });
    expect(classifyStepUpError(asProd(new TwoFactorSetupRequiredError()))).toEqual({ kind: "setup" });
    // En dev viaja el mensaje.
    expect(classifyStepUpError(new Error(new StepUpRequiredError().message))).toEqual({ kind: "step_up" });
    expect(classifyStepUpError(new Error("otra cosa"))).toBeNull();
  });

  it("sin provider: setup → copy de activar; step_up → error legible; otro error → null (se re-tira)", () => {
    expect(stepUpFailureOf(asProd(new TwoFactorSetupRequiredError()))).toEqual({ ok: false, error: STEP_UP_SETUP_REQUIRED });
    expect(stepUpFailureOf(asProd(new StepUpRequiredError()))).toMatchObject({ ok: false });
    expect(stepUpFailureOf(new Error("x"))).toBeNull();
  });
});
