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

import { platformFailureOf } from "@/components/plataforma/reauth-modal";
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
