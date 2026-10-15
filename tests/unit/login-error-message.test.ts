import { describe, it, expect } from "vitest";
import {
  FORGOT_SENT,
  RESEND_COOLDOWN_S,
  cooldownSecondsLeft,
  loginErrorFeedback,
  loginErrorMessage,
  parseConfirmLinkKind,
  resendButtonLabel,
} from "@/components/screens/auth-feedback";

/**
 * [IAM-2d] Lógica pura de las pantallas de auth: mensaje + salida por código de error del login y cooldown
 * de los botones de reenvío.
 */
describe("[IAM-2d] loginErrorMessage", () => {
  it("sin código no hay aviso", () => {
    expect(loginErrorMessage(undefined)).toBeNull();
    expect(loginErrorMessage("")).toBeNull();
  });

  it("código conocido → su texto; desconocido → genérico (nunca el valor de la query)", () => {
    expect(loginErrorMessage("invalid_credentials")).toBe("Email o contraseña incorrectos.");
    const crafted = "Tu cuenta fue suspendida, llamá al 11-5555-5555";
    expect(loginErrorMessage(crafted)).toBe("No pudimos iniciar sesión. Probá de nuevo.");
    // Claves heredadas de Object.prototype no son códigos.
    expect(loginErrorMessage("toString")).toBe("No pudimos iniciar sesión. Probá de nuevo.");
    expect(loginErrorMessage("__proto__")).toBe("No pudimos iniciar sesión. Probá de nuevo.");
  });
});

describe("[PL-2e] errores de OAuth (Google y Facebook)", () => {
  it("textos sin nombrar al proveedor; sin email y proveedor apagado tienen el suyo", () => {
    expect(loginErrorMessage("oauth_failed")).toBe("No pudimos completar el ingreso. Probá de nuevo.");
    expect(loginErrorMessage("oauth_no_email")).toContain("No recibimos tu email");
    expect(loginErrorMessage("provider_disabled")).toBe(
      "Ese método de ingreso no está disponible por ahora. Entrá con tu email y contraseña."
    );
  });
});

describe("[IAM-2d] loginErrorFeedback (salidas)", () => {
  it("email_not_confirmed → reenviar confirmación", () => {
    const f = loginErrorFeedback("email_not_confirmed");
    expect(f?.message).toContain("Todavía no confirmaste tu email");
    expect(f?.ctas).toEqual(["resend_verification"]);
  });

  it("link_invalid sin tipo → las dos salidas (contraseña y confirmación)", () => {
    const f = loginErrorFeedback("link_invalid");
    expect(f?.message).toBe("El link venció o ya se usó. Pedí uno nuevo.");
    expect(f?.ctas).toEqual(["forgot", "resend_verification"]);
  });

  it("link_invalid de recovery → solo «olvidé mi contraseña»", () => {
    const f = loginErrorFeedback("link_invalid", "recovery");
    expect(f?.message).toContain("crear tu contraseña venció o ya se usó");
    expect(f?.ctas).toEqual(["forgot"]);
  });

  it("link_invalid de signup → solo reenviar confirmación", () => {
    const f = loginErrorFeedback("link_invalid", "signup");
    expect(f?.message).toContain("confirmar tu email venció o ya se usó");
    expect(f?.ctas).toEqual(["resend_verification"]);
  });

  it("errores sin arreglo propio no ofrecen salidas", () => {
    for (const code of [
      "invalid_credentials",
      "rate_limited",
      "oauth_failed",
      "oauth_no_email",
      "provider_disabled",
      "missing_code",
      "missing_credentials",
      "otro",
    ]) {
      expect(loginErrorFeedback(code)?.ctas).toEqual([]);
    }
    expect(loginErrorFeedback(undefined)).toBeNull();
  });

  it("parseConfirmLinkKind acota ?link= (email = alta)", () => {
    expect(parseConfirmLinkKind("recovery")).toBe("recovery");
    expect(parseConfirmLinkKind("signup")).toBe("signup");
    expect(parseConfirmLinkKind("email")).toBe("signup");
    expect(parseConfirmLinkKind("invite")).toBeUndefined();
    expect(parseConfirmLinkKind("<script>")).toBeUndefined();
    expect(parseConfirmLinkKind(undefined)).toBeUndefined();
    expect(parseConfirmLinkKind(null)).toBeUndefined();
  });
});

describe("[IAM-2d] cooldown de reenvío", () => {
  it("60 s, redondeado hacia arriba y nunca negativo", () => {
    expect(RESEND_COOLDOWN_S).toBe(60);
    const t0 = 1_000_000;
    const until = t0 + RESEND_COOLDOWN_S * 1000;
    expect(cooldownSecondsLeft(null, t0)).toBe(0);
    expect(cooldownSecondsLeft(until, t0)).toBe(60);
    expect(cooldownSecondsLeft(until, t0 + 100)).toBe(60);
    expect(cooldownSecondsLeft(until, t0 + 59_001)).toBe(1);
    expect(cooldownSecondsLeft(until, until)).toBe(0);
    expect(cooldownSecondsLeft(until, until + 5_000)).toBe(0);
  });

  it("el botón dice cuánto falta, o «Enviando…» mientras manda", () => {
    expect(resendButtonLabel("Reenviar el email", 0, false)).toBe("Reenviar el email");
    expect(resendButtonLabel("Reenviar el email", 42, false)).toBe("Podés reenviarlo en 42 s");
    expect(resendButtonLabel("Reenviar el email", 42, true)).toBe("Enviando…");
  });

  it("copy genérico del forgot (sin oráculo de cuentas, vence en 1 hora)", () => {
    expect(FORGOT_SENT).toBe(
      "Si existe una cuenta con ese email, te mandamos un link para crear una contraseña nueva. Vence en 1 hora."
    );
  });
});
