import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * [VX-Z FX-auth] Actions con la forma de `useFormState` (signup, forgot, reset, email del portal). Corren las actions
 * reales y su mapeo puro (`auth-form-state.ts`); se mockean solo las actions de abajo (red, GoTrue, rate limit) y
 * `redirect` de Next. Se afirma QUÉ le llega a la action de abajo (lo que leyó del FormData) y el estado que vuelve.
 */
const calls = vi.hoisted(() => ({
  signup: vi.fn(),
  forgot: vi.fn(),
  reset: vi.fn(),
  portal: vi.fn(),
  redirects: [] as string[],
}));
class RedirectSignal extends Error {}
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    calls.redirects.push(to);
    throw new RedirectSignal(to);
  },
}));
vi.mock("@/lib/auth", () => ({
  signUpPractitioner: calls.signup,
  sendPasswordReset: calls.forgot,
  updatePasswordWithRecoverySession: calls.reset,
}));
vi.mock("@/lib/portal-auth", () => ({ requestPortalLink: calls.portal }));

import { forgotFormAction, resetFormAction, signupFormAction } from "@/components/auth/auth-form-actions";
import { portalLinkFormAction } from "@/app/(portal)/portal/portal-link-action";
import { PASSWORD_MISMATCH } from "@/components/auth/auth-form-state";

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

beforeEach(() => {
  calls.signup.mockReset();
  calls.forgot.mockReset();
  calls.reset.mockReset();
  calls.portal.mockReset();
  calls.redirects = [];
});

describe("signupFormAction", () => {
  it("lee el form, nunca manda invitación y devuelve «enviado» con lo tipeado", async () => {
    calls.signup.mockResolvedValue({ ok: true, data: { email: "ana@x.test", joining: false, message: "Te mandamos un email." } });
    const s = await signupFormAction(null, fd({ fullName: "Ana", email: "ana@x.test", password: "abc12345", inviteToken: "tok" }));
    expect(calls.signup).toHaveBeenCalledWith({ fullName: "Ana", email: "ana@x.test", password: "abc12345", inviteToken: "" });
    expect(s).toEqual({
      status: "sent",
      email: "ana@x.test",
      message: "Te mandamos un email.",
      values: { fullName: "Ana", email: "ana@x.test" },
    });
  });

  it("error: mensaje, errores por campo y lo tipeado (sin la contraseña)", async () => {
    calls.signup.mockResolvedValue({ ok: false, error: "Revisá los datos.", fieldErrors: { password: ["Muy corta"] } });
    const s = await signupFormAction(null, fd({ fullName: "Ana", email: "a@x.test", password: "1" }));
    expect(s).toEqual({
      status: "error",
      error: "Revisá los datos.",
      fieldErrors: { password: ["Muy corta"] },
      values: { fullName: "Ana", email: "a@x.test" },
    });
    expect(JSON.stringify(s)).not.toContain('"1"');
  });

  it("redirectTo (contrato IAM-2c) → redirect, nunca «te mandamos un email»", async () => {
    calls.signup.mockResolvedValue({ ok: true, data: { email: "", joining: true, message: "", redirectTo: "/invite/t" } });
    await expect(signupFormAction(null, fd({}))).rejects.toBeInstanceOf(RedirectSignal);
    expect(calls.redirects).toEqual(["/invite/t"]);
  });

  it("cada envío devuelve un objeto nuevo (la pantalla lo usa para «Volver»)", async () => {
    calls.signup.mockResolvedValue({ ok: true, data: { email: "a@x.test", joining: false, message: "m" } });
    const a = await signupFormAction(null, fd({ email: "a@x.test" }));
    const b = await signupFormAction(a, fd({ email: "a@x.test" }));
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});

describe("forgotFormAction", () => {
  it("recorta el email y devuelve el estado genérico de enviado", async () => {
    calls.forgot.mockResolvedValue({ ok: true, data: undefined });
    expect(await forgotFormAction(null, fd({ email: "  ana@x.test " }))).toEqual({ status: "sent", email: "ana@x.test" });
    expect(calls.forgot).toHaveBeenCalledWith({ email: "ana@x.test" });
  });

  it("rate limit → error con el email para repoblar", async () => {
    calls.forgot.mockResolvedValue({ ok: false, error: "Demasiados intentos." });
    expect(await forgotFormAction(null, fd({ email: "a@x.test" }))).toEqual({
      status: "error",
      error: "Demasiados intentos.",
      email: "a@x.test",
    });
  });
});

describe("resetFormAction", () => {
  it("no coinciden → error de campo SIN llamar al server (el chequeo vivía en el cliente: sin JS no corría)", async () => {
    const s = await resetFormAction(null, fd({ password: "abc12345", confirm: "abc12346" }));
    expect(s).toEqual({ status: "error", error: null, fieldErrors: { confirm: [PASSWORD_MISMATCH] } });
    expect(calls.reset).not.toHaveBeenCalled();
  });

  it("modo recovery (sin currentPassword en el form) manda '' y devuelve «hecho»", async () => {
    calls.reset.mockResolvedValue({ ok: true, data: undefined });
    expect(await resetFormAction(null, fd({ password: "abc12345", confirm: "abc12345" }))).toEqual({ status: "done" });
    expect(calls.reset).toHaveBeenCalledWith({ password: "abc12345", currentPassword: "" });
  });

  it("modo change: pasa la actual; el error del server vuelve con sus campos", async () => {
    calls.reset.mockResolvedValue({ ok: false, error: "La contraseña actual no es correcta.", fieldErrors: { currentPassword: ["x"] } });
    const s = await resetFormAction(null, fd({ currentPassword: "vieja123", password: "abc12345", confirm: "abc12345" }));
    expect(calls.reset).toHaveBeenCalledWith({ password: "abc12345", currentPassword: "vieja123" });
    expect(s).toEqual({ status: "error", error: "La contraseña actual no es correcta.", fieldErrors: { currentPassword: ["x"] } });
  });
});

describe("portalLinkFormAction", () => {
  it("pasa email (recortado) y slug a requestPortalLink y devuelve «enviado»", async () => {
    calls.portal.mockResolvedValue({ ok: true, data: { message: "Si tu email tiene ficha, te mandamos un link." } });
    const s = await portalLinkFormAction(null, fd({ email: " ana@x.test ", slug: "consultorio-sur" }));
    const sent = calls.portal.mock.calls[0][0] as FormData;
    expect(sent.get("email")).toBe("ana@x.test");
    expect(sent.get("slug")).toBe("consultorio-sur");
    expect(s).toEqual({ status: "sent", email: "ana@x.test", message: "Si tu email tiene ficha, te mandamos un link." });
  });

  it("sin slug no lo manda; el error de campo manda sobre el genérico", async () => {
    calls.portal.mockResolvedValue({ ok: false, error: "Ingresá un email válido.", fieldErrors: { email: ["Email inválido"] } });
    const s = await portalLinkFormAction(null, fd({ email: "x" }));
    expect((calls.portal.mock.calls[0][0] as FormData).has("slug")).toBe(false);
    expect(s).toEqual({ status: "error", error: "Email inválido", email: "x" });
  });
});
