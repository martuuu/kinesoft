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
// VX2-a: la red de las pages (GoTrue `/auth/v1/settings` y la base del catálogo). Lo real de cada uno lo cubren
// `social-buttons.test.tsx` y `saas-plans-public`; acá se fija qué devuelven para afirmar lo que pinta la pantalla.
const ext = vi.hoisted(() => ({
  providers: ["google", "facebook"] as ("google" | "facebook")[],
  catalog: [] as Array<{ plan: string; trialDays: number }>,
}));
vi.mock("@/lib/oauth-providers-public", () => ({
  visibleOAuthProviders: async () => ext.providers,
}));
vi.mock("@/lib/saas-plans-public", () => ({
  getPublicPlanCatalog: async () => ext.catalog,
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
  ext.providers = ["google", "facebook"];
  ext.catalog = [];
});

const h1Count = (html: string) => (html.match(/<h1[\s>]/g) ?? []).length;
/** El tag `<input …>` (o el del PasswordInput) con `name=<n>`. */
const inputTag = (html: string, name: string) => html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0] ?? "";

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

  it("link_invalid de recovery (?link=recovery vía la page) → solo «olvidé mi contraseña»", async () => {
    const alert = alertBlock(
      renderToStaticMarkup(await LoginPage({ searchParams: { error: "link_invalid", link: "recovery" } }))
    );
    expect(alert).toContain("crear tu contraseña venció");
    expect(alert).toContain('href="/forgot"');
    expect(alert).not.toContain("Reenviar email de confirmación");
  });

  it("link_invalid de signup → solo reenviar confirmación; un ?link= raro cae en las dos", async () => {
    const signup = alertBlock(
      renderToStaticMarkup(await LoginPage({ searchParams: { error: "link_invalid", link: "signup" } }))
    );
    expect(signup).toContain("Reenviar email de confirmación");
    expect(signup).not.toContain('href="/forgot"');
    const odd = alertBlock(renderToStaticMarkup(await LoginPage({ searchParams: { error: "link_invalid", link: "<x>" } })));
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

describe("[VX2-a] Login: botones sociales", () => {
  it("[VX2-a] el login no ofrece Facebook ni postea a /api/auth/oauth/google", async () => {
    const html = renderToStaticMarkup(await LoginPage({ searchParams: {} }));
    expect(html).toContain('action="/api/auth/oauth/google"');
    expect(html).toContain('action="/api/auth/oauth/facebook"');
    expect(html).toContain("Continuar con Facebook");
    // El alias viejo queda para el portal y el turnero, no para el login del consultorio.
    expect(html).not.toContain('action="/api/auth/google');
  });

  it("D-VX16: Facebook apagado no se ofrece ni se nombra; `next` viaja a los sociales", async () => {
    ext.providers = ["google"];
    const html = renderToStaticMarkup(await LoginPage({ searchParams: { next: "/agenda" } }));
    expect(html).toContain("Con Google o tu email.");
    expect(html).not.toContain("Facebook");
    expect(html).toContain('action="/api/auth/oauth/google?next=%2Fagenda"');
    expect(html).toContain('action="/api/auth/sign-in?next=%2Fagenda"');
  });

  it("sin proveedores: ni botones ni divisor, y la bajada no promete Google", async () => {
    ext.providers = [];
    const html = renderToStaticMarkup(await LoginPage({ searchParams: {} }));
    expect(html).toContain("Con tu email y tu contraseña.");
    expect(html).not.toContain("k-btn-social");
    expect(html).not.toContain("o con tu email");
  });

  it("product + una h1; sin «Matrícula» ni «recordarme»; autocomplete y foco del design system", async () => {
    const html = renderToStaticMarkup(await LoginPage({ searchParams: {} }));
    expect(html).toContain('data-variant="product"');
    expect(h1Count(html)).toBe(1);
    expect(html).toMatch(/<h1[^>]*>Ingresá a tu consultorio<\/h1>/);
    expect(html).toContain("Con Google, Facebook o tu email.");
    expect(html).not.toMatch(/Matr[íi]cula/);
    expect(html).not.toContain('name="remember"');
    expect(html).not.toMatch(/Mantenerme/);
    const email = inputTag(html, "email");
    expect(email).toContain('autoComplete="email"');
    expect(email).toContain('inputMode="email"');
    expect(email).toContain('placeholder="nombre@ejemplo.com"');
    expect(email).toContain('class="k-input k-input-lg"');
    const pass = inputTag(html, "password");
    expect(pass).toContain('autoComplete="current-password"');
    expect(pass).toContain('type="password"');
    // Label real asociado (Field) y mostrar/ocultar.
    expect(html).toContain('<label for="login-email" class="k-label">Email</label>');
    expect(html).toContain('aria-label="Mostrar contraseña"');
    expect(html).toMatch(/<a[^>]*href="\/forgot"[^>]*>¿Olvidaste tu contraseña\?<\/a>/);
    expect(html).toMatch(/<a[^>]*href="\/signup"[^>]*>Creá tu consultorio<\/a>/);
    expect(html).toMatch(/<button type="submit" class="k-btn k-btn-primary k-btn-lg k-btn-block"[^>]*>Ingresar<\/button>/);
    // Sin outline:none inline ni placeholders inventados (ratchets de C-F5).
    expect(html).not.toMatch(/outline:\s*none/);
    expect(html).not.toMatch(/movare|camila/i);
  });

  it("error OAuth traducido en el aviso (nunca el texto del proveedor)", () => {
    for (const [code, text] of [
      ["provider_disabled", "Ese método de ingreso no está disponible por ahora."],
      ["oauth_no_email", "No recibimos tu email"],
      ["oauth_failed", "No pudimos completar el ingreso."],
    ] as const) {
      const html = renderToStaticMarkup(<LoginScreen error={code} providers={["google"]} />);
      expect(alertBlock(html), code).toContain(text);
      expect(html, code).toContain('class="k-alert" role="alert" id="login-error"');
    }
  });

  // Field pisaba con `undefined` el aria-invalid/aria-errormessage que trae el control cuando no recibe `error`
  // (cloneElement). El login no le pasa `error` a propósito (el mensaje está en el aviso, no se repite por campo).
  // Lo dio vuelta el handoff de VX2-a sobre components/ui/field.tsx (spread condicional).
  it("[VX2-a] credenciales inválidas marcan los campos con aria-invalid → aviso (handoff field.tsx)", () => {
    const html = renderToStaticMarkup(<LoginScreen error="invalid_credentials" />);
    for (const name of ["email", "password"]) {
      const tag = inputTag(html, name);
      expect(tag, name).toContain('aria-invalid="true"');
      expect(tag, name).toContain('aria-errormessage="login-error"');
    }
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
    expect(html).toContain("Creá tu consultorio");
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
      expect(html).not.toContain("Crear cuenta");
      expect(html).not.toContain("k-btn-social");
      expect(html).toContain('data-variant="centered"');
      expect(h1Count(html)).toBe(1);
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
    expect(html).toContain("Crear cuenta");
    expect(html).not.toContain("invitación");
  });

  it("[VX2-a] split + una h1; sin radio de vertical (D-VX14); sociales a /onboarding; autocomplete", async () => {
    const html = renderToStaticMarkup(await SignupPage({ searchParams: {} }));
    expect(html).toContain('data-variant="split"');
    expect(h1Count(html)).toBe(1);
    expect(html).toMatch(/<h1[^>]*>Creá tu consultorio<\/h1>/);
    expect(html).toContain("Empezá hoy con tu consultorio.");
    expect(html).not.toContain('type="radio"');
    expect(html).not.toContain('name="vertical"');
    expect(html).not.toContain("Tu consultorio es de");
    expect(html).toContain('action="/api/auth/oauth/google?next=%2Fonboarding"');
    expect(html).toContain('action="/api/auth/oauth/facebook?next=%2Fonboarding"');
    expect(inputTag(html, "fullName")).toContain('autoComplete="name"');
    expect(inputTag(html, "email")).toContain('autoComplete="email"');
    const pass = inputTag(html, "password");
    expect(pass).toContain('autoComplete="new-password"');
    expect(pass).toContain('aria-describedby="signup-password-hint"');
    expect(html).toContain("Al menos 8 caracteres, con una letra y un número.");
    expect(html).toMatch(/<a[^>]*href="\/#contacto"[^>]*>Escribinos<\/a>/);
    expect(html).toContain("Quien crea la cuenta es titular del consultorio.");
    expect(html).not.toMatch(/movare|camila/i);
  });

  it("[VX2-a] los días de prueba salen del catálogo; sin catálogo, el default del código; con 0 no promete «gratis»", async () => {
    ext.catalog = [{ plan: "CONSULTORIO", trialDays: 0 }, { plan: "INDIVIDUAL", trialDays: 30 }];
    const html30 = renderToStaticMarkup(await SignupPage({ searchParams: {} }));
    expect(html30).toContain("Plan Individual · 30 días gratis");
    expect(html30).toContain("Plan Individual con 30 días gratis. No te pedimos medio de pago.");
    expect(html30).toContain("30 días gratis, sin medio de pago.");

    ext.catalog = [];
    const htmlDefault = renderToStaticMarkup(await SignupPage({ searchParams: {} }));
    expect(htmlDefault).toContain("Plan Individual · 14 días gratis");

    ext.catalog = [{ plan: "INDIVIDUAL", trialDays: 0 }];
    const html0 = renderToStaticMarkup(await SignupPage({ searchParams: {} }));
    expect(html0).not.toMatch(/gratis/);
    expect(html0).toContain("Sin medio de pago para empezar.");
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
    // VX2-a: centered, una h1, Field con autocomplete y placeholder neutro.
    expect(html).toContain('data-variant="centered"');
    expect(h1Count(html)).toBe(1);
    expect(inputTag(html, "email")).toContain('autoComplete="email"');
    expect(html).toContain('<label for="forgot-email" class="k-label">Email</label>');
    expect(html).not.toMatch(/movare|camila/i);
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
    expect(html).toContain('data-variant="centered"');
    expect(h1Count(html)).toBe(1);
    expect(inputTag(html, "password")).toContain('autoComplete="new-password"');
    expect(inputTag(html, "confirm")).toContain('autoComplete="new-password"');
  });

  it("[VX2-a] reset change: la actual con current-password (el gestor no pisa la vieja con la nueva)", () => {
    const html = renderToStaticMarkup(<ResetScreen mode="change" />);
    expect(inputTag(html, "currentPassword")).toContain('autoComplete="current-password"');
    expect(inputTag(html, "password")).toContain('autoComplete="new-password"');
  });
});

describe("[IAM-2d] ResendVerification (onboarding no verificado)", () => {
  it("sin cooldown arranca habilitado con su etiqueta", () => {
    const html = renderToStaticMarkup(<ResendVerification email="ana@x.test" label="Reenviar el email" />);
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>Reenviar el email<\/button>/);
    expect(html).not.toContain("disabled");
  });
});
