/**
 * PL-2a · step-up (C-PL6): la decisión de `requireStepUp` y que el error que viaja al cliente (con el mensaje tapado
 * por Next en prod) lo reconozca `useStepUpAction`. Clases REALES del server (`lib/two-factor-step-up.ts`); la
 * integración (`tests/integration/two-factor.test.ts`) cubre `requireStepUp` contra la sesión y la cookie.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

import { StepUpRequiredError, TwoFactorSetupRequiredError, requireStepUp, stepUpDecision } from "@/lib/two-factor-step-up";
import { getAccessSnapshot } from "@/lib/session";
import { getSessionUser } from "@/lib/session-user";
import { logger } from "@/lib/logger";
import { twoFactorBypassFor } from "@/lib/two-factor-bypass";
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

/**
 * HF-3 (D-HF7): `requireStepUp` REAL con la foto del request mockeada (lo único externo: sesión y cookie). La cookie
 * de step-up nunca está (el mock de `next/headers` devuelve undefined): sin el bypass, siempre pediría código.
 */
describe("[HF-3] requireStepUp con la 2FA del superadmin en pausa", () => {
  const U = "4f7c2a1e-9b3d-4c8e-a2f1-0d5e6b7c8a9f";
  const snap = (o: { admin?: boolean; methods?: { totp: boolean; email: boolean } } = {}) => ({
    userId: U,
    profile: { isPlatformAdmin: o.admin ?? true, disabledAt: null },
    twoFactor: { methods: o.methods ?? { totp: true, email: false }, state: "satisfied" },
  });
  // Hoy + 10 días en AR (el test no depende de la fecha del reloj).
  const inTenDays = () => new Date(Date.now() - 3 * 3600_000 + 10 * 86_400_000).toISOString().slice(0, 10);
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(getSessionUser).mockResolvedValue({ id: U, sessionId: "sess-1" } as never);
    warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    delete process.env.SUPERADMIN_2FA_BYPASS;
    delete process.env.PLATFORM_MFA_ENFORCEMENT;
    warn.mockRestore();
  });

  it("[HF-3] acción high con bypass pasa sin step-up y loguea", async () => {
    vi.mocked(getAccessSnapshot).mockResolvedValue(snap() as never);
    // Sin bypass: con TOTP y sin cookie → step-up.
    await expect(requireStepUp({ userId: U })).rejects.toBeInstanceOf(StepUpRequiredError);
    process.env.SUPERADMIN_2FA_BYPASS = `${U}@${inTenDays()}`;
    await expect(requireStepUp({ userId: U })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("2fa.stepup_bypassed", { userId: U });
    // H-2FA: también sin ningún método (antes: «Activá la verificación en dos pasos»).
    vi.mocked(getAccessSnapshot).mockResolvedValue(snap({ methods: { totp: false, email: false } }) as never);
    await expect(requireStepUp({ userId: U })).resolves.toBeUndefined();
  });

  it("[HF-3] con enforce el bypass no aplica", async () => {
    vi.mocked(getAccessSnapshot).mockResolvedValue(snap() as never);
    process.env.SUPERADMIN_2FA_BYPASS = `${U}@${inTenDays()}`;
    process.env.PLATFORM_MFA_ENFORCEMENT = "enforce";
    await expect(requireStepUp({ userId: U })).rejects.toBeInstanceOf(StepUpRequiredError);
    expect(warn).not.toHaveBeenCalledWith("2fa.stepup_bypassed", expect.anything());
  });

  it("[HF-3] no-superadmin con su id en la lista → sin efecto", async () => {
    vi.mocked(getAccessSnapshot).mockResolvedValue(snap({ admin: false }) as never);
    process.env.SUPERADMIN_2FA_BYPASS = `${U}@${inTenDays()}`;
    await expect(requireStepUp({ userId: U })).rejects.toBeInstanceOf(StepUpRequiredError);
    vi.mocked(getAccessSnapshot).mockResolvedValue(snap({ admin: false, methods: { totp: false, email: false } }) as never);
    await expect(requireStepUp({ userId: U })).rejects.toBeInstanceOf(TwoFactorSetupRequiredError);
  });

  it("[HF-3] { allowBypass: false } (sumar un factor) sigue pidiendo step-up aunque haya pausa", async () => {
    vi.mocked(getAccessSnapshot).mockResolvedValue(snap() as never);
    process.env.SUPERADMIN_2FA_BYPASS = `${U}@${inTenDays()}`;
    await expect(requireStepUp({ userId: U })).resolves.toBeUndefined();
    await expect(requireStepUp({ userId: U }, { allowBypass: false })).rejects.toBeInstanceOf(StepUpRequiredError);
  });

  it("[HF-3] variable mal formada o a >30 días: se ignora con un warn por valor (sin el valor)", () => {
    const user = { id: U, isPlatformAdmin: true, disabledAt: null };
    process.env.SUPERADMIN_2FA_BYPASS = `${U}@31/10`;
    expect(twoFactorBypassFor(user)).toEqual({ active: false, reason: "malformed" });
    expect(twoFactorBypassFor(user)).toEqual({ active: false, reason: "malformed" });
    expect(warn.mock.calls.filter((c) => c[0] === "2fa.bypass_ignored")).toHaveLength(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(U);
    process.env.SUPERADMIN_2FA_BYPASS = `${U}@2099-12-31`;
    expect(twoFactorBypassFor(user)).toEqual({ active: false, reason: "too_far" });
    expect(warn).toHaveBeenLastCalledWith("2fa.bypass_ignored", expect.objectContaining({ reason: "too_far" }));
  });
});
