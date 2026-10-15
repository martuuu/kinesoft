import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * [IAM-2d] Pantallas de auth (render sin jsdom). Se montan los componentes reales; solo se mockean la red
 * (las server actions de `lib/auth`), `next/navigation` y la lectura de sesión de la page de signup.
 * `renderToStaticMarkup` pinta el estado inicial: los estados posteriores al envío («Revisá tu email») se
 * montan directo con sus componentes exportados (`SignupSent`, `ForgotSent`).
 */
const nav = { redirects: [] as string[] };
class RedirectSignal extends Error {}
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  redirect: (to: string) => {
    nav.redirects.push(to);
    throw new RedirectSignal(to);
  },
}));
vi.mock("@/lib/auth", () => ({
  signUpPractitioner: async () => ({ ok: false, error: "x" }),
  sendPasswordReset: async () => ({ ok: true, data: undefined }),
  resendVerification: async () => ({ ok: true, data: undefined }),
  updatePasswordWithRecoverySession: async () => ({ ok: false, error: "x" }),
}));
const session = { user: null as null | { id: string; email: string } };
vi.mock("@/lib/onboarding-internal", () => ({
  getSessionUser: async () => session.user,
}));

import { renderToStaticMarkup } from "react-dom/server";
import { LoginScreen } from "@/components/screens/login-screen";
import { SignupScreen, SignupSent } from "@/components/screens/signup-screen";
import { ForgotScreen, ForgotSent } from "@/components/screens/forgot-screen";
import { ResetScreen } from "@/components/screens/reset-screen";
import { ResendVerification } from "@/components/screens/resend-verification";
import SignupPage from "@/app/(auth)/signup/page";
import LoginPage from "@/app/(auth)/login/page";

beforeEach(() => {
  nav.redirects = [];
  session.user = null;
});

/** El contenido del aviso de error del login (role=alert), para no confundirlo con el resto de la página. */
function alertBlock(html: string): string {
  const i = html.indexOf('role="alert"');
  if (i < 0) return "";
  return html.slice(i, html.indexOf('<label', i));
}

describe("[IAM-2d] Login: mensaje y salida por código", () => {
  it("email_not_confirmed → texto + «Reenviar email de confirmación», dentro del form de login", () => {
    const html = renderToStaticMarkup(<LoginScreen error="email_not_confirmed" email="ana@x.test" />);
    const alert = alertBlock(html);
    expect(alert).toContain("Todavía no confirmaste tu email");
    expect(alert).toContain("Reenviar email de confirmación");
    expect(alert).not.toContain('href="/forgot"');
    // El aviso vive dentro del form: el botón lee el email tipeado (defaultValue = ?email=).
    const form = html.indexOf('action="/api/auth/sign-in"');
    expect(form).toBeGreaterThan(-1);
    expect(html.indexOf('role="alert"')).toBeGreaterThan(form);
    expect(html).toContain('value="ana@x.test"');
    // type=button: no dispara el login (que exige contraseña).
    expect(alert).toMatch(/<button[^>]*type="button"[^>]*>Reenviar email de confirmación<\/button>/);
  });

  it("link_invalid sin tipo → «El link venció o ya se usó. Pedí uno nuevo» con las dos salidas", () => {
    const alert = alertBlock(renderToStaticMarkup(<LoginScreen error="link_invalid" />));
    expect(alert).toContain("El link venció o ya se usó. Pedí uno nuevo.");
    expect(alert).toContain('href="/forgot"');
    expect(alert).toContain("Reenviar email de confirmación");
  });

  it("link_invalid de recovery (?link=recovery vía la page) → solo «olvidé mi contraseña»", () => {
    const alert = alertBlock(
      renderToStaticMarkup(<LoginPage searchParams={{ error: "link_invalid", link: "recovery" }} />)
    );
    expect(alert).toContain("crear tu contraseña venció");
    expect(alert).toContain('href="/forgot"');
    expect(alert).not.toContain("Reenviar email de confirmación");
  });

  it("link_invalid de signup → solo reenviar confirmación; un ?link= raro cae en las dos", () => {
    const signup = alertBlock(renderToStaticMarkup(<LoginPage searchParams={{ error: "link_invalid", link: "signup" }} />));
    expect(signup).toContain("Reenviar email de confirmación");
    expect(signup).not.toContain('href="/forgot"');
    const odd = alertBlock(renderToStaticMarkup(<LoginPage searchParams={{ error: "link_invalid", link: "<x>" }} />));
    expect(odd).toContain('href="/forgot"');
    expect(odd).toContain("Reenviar email de confirmación");
  });

  it("credenciales inválidas: aviso sin salidas; sin error, sin aviso; texto de la query nunca se pinta", () => {
    const bad = alertBlock(renderToStaticMarkup(<LoginScreen error="invalid_credentials" />));
    expect(bad).toContain("Email o contraseña incorrectos.");
    expect(bad).not.toContain("<button");
    expect(renderToStaticMarkup(<LoginScreen />)).not.toContain('role="alert"');
    const crafted = renderToStaticMarkup(<LoginScreen error="Llamá al 11-5555-5555" />);
    expect(crafted).not.toContain("11-5555-5555");
  });
});

describe("[IAM-2d] Signup", () => {
  it("/signup?invite=<token> redirige del lado del server a /invite/<token> (con o sin sesión)", async () => {
    await expect(SignupPage({ searchParams: { invite: "tok_123" } })).rejects.toBeInstanceOf(RedirectSignal);
    expect(nav.redirects).toEqual(["/invite/tok_123"]);

    nav.redirects = [];
    session.user = { id: "u1", email: "a@x.test" };
    await expect(SignupPage({ searchParams: { invite: "a/b c" } })).rejects.toBeInstanceOf(RedirectSignal);
    expect(nav.redirects).toEqual(["/invite/a%2Fb%20c"]);
  });

  it("sin invitación y sin sesión pinta el form; con sesión va al dashboard", async () => {
    const el = await SignupPage({ searchParams: {} });
    const html = renderToStaticMarkup(el);
    expect(html).toContain("Creá tu cuenta en KineSoft");
    expect(html).toContain('name="email"');
    expect(html).not.toContain("readonly");
    expect(nav.redirects).toEqual([]);

    session.user = { id: "u1", email: "a@x.test" };
    await expect(SignupPage({ searchParams: {} })).rejects.toBeInstanceOf(RedirectSignal);
    expect(nav.redirects).toEqual(["/dashboard"]);
  });

  it("[BO-Z] SIGNUP_MODE=assisted: sin form, con «escribinos» y la salida para invitados y para quien ya tiene cuenta", async () => {
    const prev = { m: process.env.SIGNUP_MODE, e: process.env.NEXT_PUBLIC_SUPPORT_EMAIL };
    try {
      process.env.SIGNUP_MODE = "assisted";
      process.env.NEXT_PUBLIC_SUPPORT_EMAIL = "soporte@kinesoft.test";
      const html = renderToStaticMarkup(await SignupPage({ searchParams: {} }));
      expect(html).toContain("Por ahora damos de alta los consultorios nosotros: escribinos a soporte@kinesoft.test");
      expect(html).not.toContain('name="email"');
      expect(html).not.toContain("Crear mi cuenta");
      expect(html).toContain("link del mail de invitación");
      expect(html).toContain('href="/login"');
      // Con invitación sigue yendo a /invite (unirse a un equipo no crea consultorio).
      await expect(SignupPage({ searchParams: { invite: "tok_9" } })).rejects.toBeInstanceOf(RedirectSignal);
      expect(nav.redirects).toEqual(["/invite/tok_9"]);
    } finally {
      if (prev.m === undefined) delete process.env.SIGNUP_MODE;
      else process.env.SIGNUP_MODE = prev.m;
      if (prev.e === undefined) delete process.env.NEXT_PUBLIC_SUPPORT_EMAIL;
      else process.env.NEXT_PUBLIC_SUPPORT_EMAIL = prev.e;
    }
  });

  it("form inicial: sin modo invitación", () => {
    const html = renderToStaticMarkup(<SignupScreen />);
    expect(html).toContain("Crear mi cuenta");
    expect(html).not.toContain("invitación");
  });

  it("«Revisá tu email»: el email, reenviar con cooldown de 60 s y «¿Email equivocado? Volver»", () => {
    const html = renderToStaticMarkup(
      <SignupSent email="ana@x.test" message="Te mandamos un email para confirmar tu cuenta." onBack={() => {}} />
    );
    expect(html).toContain("Te mandamos un email para confirmar tu cuenta.");
    expect(html).toContain("<strong>ana@x.test</strong>");
    // Recién mandado: el reenvío arranca en cooldown, deshabilitado y diciendo cuánto falta.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Podés reenviarlo en 60 s<\/button>/);
    expect(html).toContain("¿Email equivocado?");
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>Volver<\/button>/);
  });
});

describe("[IAM-2d] Forgot y reset", () => {
  it("forgot: form inicial con el blurb de 1 hora", () => {
    const html = renderToStaticMarkup(<ForgotScreen />);
    expect(html).toContain("Vence en 1 hora.");
    expect(html).toContain("Enviar link de recuperación");
  });

  it("forgot enviado: respuesta genérica + reenviar con cooldown + volver", () => {
    const html = renderToStaticMarkup(<ForgotSent email="ana@x.test" onBack={() => {}} />);
    expect(html).toContain(
      "Si existe una cuenta con ese email, te mandamos un link para crear una contraseña nueva. Vence en 1 hora."
    );
    expect(html).toContain("<strong>ana@x.test</strong>");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Podés reenviarlo en 60 s<\/button>/);
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>Volver<\/button>/);
  });

  it("reset expired: «Pedir un link nuevo» → /forgot, sin form de contraseña", () => {
    const html = renderToStaticMarkup(<ResetScreen mode="expired" />);
    expect(html).toContain("El link venció o ya se usó.");
    expect(html).toMatch(/<a[^>]*href="\/forgot"[^>]*>Pedir un link nuevo<\/a>/);
    expect(html).not.toContain('name="password"');
  });

  it("reset recovery: el form sin contraseña actual", () => {
    const html = renderToStaticMarkup(<ResetScreen mode="recovery" />);
    expect(html).toContain('name="password"');
    expect(html).not.toContain('name="currentPassword"');
  });
});

describe("[IAM-2d] ResendVerification (onboarding no verificado)", () => {
  it("sin cooldown arranca habilitado con su etiqueta", () => {
    const html = renderToStaticMarkup(<ResendVerification email="ana@x.test" label="Reenviar el email" />);
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>Reenviar el email<\/button>/);
    expect(html).not.toContain("disabled");
  });
});
