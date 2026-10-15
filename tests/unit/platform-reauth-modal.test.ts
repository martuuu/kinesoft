/**
 * [BO4] Traducción de errores de Plataforma en el cliente (components/plataforma/reauth-modal.tsx). Los errores se
 * arman con las clases REALES del server (`lib/platform-actor.ts`) para fijar que el digest que viaja es el que el
 * cliente reconoce: si alguien cambia uno de los dos lados, esto se pone rojo.
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

import { composePlatformRun, platformFailureOf, type RunPlatformAction } from "@/components/plataforma/reauth-modal";
import { StepUpRequiredError, TwoFactorSetupRequiredError } from "@/lib/two-factor-step-up";
import { classifyStepUpError } from "@/lib/two-factor-logic";
import type { RunStepUpAction } from "@/components/account/step-up-modal";
import { PlatformMfaRequiredError, PlatformRateLimitedError, PlatformReauthRequiredError } from "@/lib/platform-actor";
import { PLATFORM_MFA_COPY, classifyPlatformActionError } from "@/lib/platform-mfa-logic";

/** Lo que llega al cliente en prod: mensaje tapado por Next, solo el digest. */
function asProd(err: Error & { digest?: string }) {
  return Object.assign(new Error("An error occurred in the Server Components render."), { digest: err.digest });
}

describe("[BO4] errores de Plataforma → cliente", () => {
  it("reauth: lo reconoce y NO lo traduce (abre el modal)", () => {
    const e = asProd(new PlatformReauthRequiredError());
    expect(classifyPlatformActionError(e)).toEqual({ kind: "reauth" });
    expect(platformFailureOf(e, () => undefined)).toBeNull();
  });

  it("rate limit: copy uniforme «Probá de nuevo en N s» aunque prod tape el mensaje", () => {
    const e = asProd(new PlatformRateLimitedError(12_300));
    expect(platformFailureOf(e, () => undefined)).toEqual({ ok: false, error: "Demasiados intentos. Probá de nuevo en 13 s." });
  });

  it("sin segundo paso (sesión vieja): copy + refresh para que el layout redirija", () => {
    const refresh = vi.fn();
    expect(platformFailureOf(asProd(new PlatformMfaRequiredError("verify")), refresh)).toEqual({ ok: false, error: PLATFORM_MFA_COPY.verify });
    expect(platformFailureOf(asProd(new PlatformMfaRequiredError("setup")), refresh)).toEqual({ ok: false, error: PLATFORM_MFA_COPY.setup });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(platformFailureOf(asProd(new PlatformMfaRequiredError("unavailable")), refresh)).toEqual({
      ok: false,
      error: PLATFORM_MFA_COPY.unavailable,
    });
  });

  it("cualquier otro error → null (el componente lo maneja como siempre)", () => {
    expect(platformFailureOf(new Error("boom"), () => undefined)).toBeNull();
    expect(platformFailureOf(Object.assign(new Error("x"), { digest: "98765" }), () => undefined)).toBeNull();
  });
});

describe("[PL-Z] a2#4 step-up de la 2FA por usuario en Plataforma (MFA != enforce)", () => {
  it("la capa de Plataforma no se traga el step-up: lo deja pasar al StepUpProvider", () => {
    for (const e of [asProd(new StepUpRequiredError()), asProd(new TwoFactorSetupRequiredError())]) {
      expect(platformFailureOf(e, () => undefined)).toBeNull();
      expect(classifyStepUpError(e)).not.toBeNull();
    }
  });

  it("composePlatformRun: el step-up envuelve la capa de Plataforma y el reintento repite la action entera", async () => {
    const order: string[] = [];
    let attempts = 0;
    const action = async () => {
      attempts++;
      if (attempts === 1) throw asProd(new StepUpRequiredError());
      return { ok: true as const, data: "hecho" };
    };
    // Plataforma real en forma: traduce lo suyo y re-tira lo ajeno.
    const platform: RunPlatformAction = async (fn) => {
      order.push("platform");
      try {
        return await fn();
      } catch (err) {
        const f = platformFailureOf(err, () => undefined);
        if (f) return f;
        throw err;
      }
    };
    // Step-up en forma: ante su digest «pide el código» y reintenta una vez.
    const stepUp: RunStepUpAction = async (fn) => {
      order.push("step-up");
      try {
        return await fn();
      } catch (err) {
        if (classifyStepUpError(err)?.kind !== "step_up") throw err;
        order.push("modal");
        return fn();
      }
    };
    const res = await composePlatformRun(stepUp, platform)(action);
    expect(res).toEqual({ ok: true, data: "hecho" });
    expect(attempts).toBe(2);
    expect(order).toEqual(["step-up", "platform", "modal", "platform"]);
  });
});
