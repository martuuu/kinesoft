import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * PV ZF1a (ZA M1) · `/reset` respeta `?next=` (saneado) después de guardar la contraseña.
 *
 * Por qué: el link de activación del titular creado desde /plataforma es `/reset?next=/aceptar-terminos?next=/dashboard`
 * (`PLATFORM_ACTIVATION_NEXT`). `/reset` iba siempre a `/dashboard`, así que el paso de los Términos se salteaba. Sin
 * `next`, o con uno ajeno (open redirect), sigue yendo al panel como siempre.
 *
 * Se mockean `useFormState` (para pintar el estado «hecho» sin JS), el router, la sesión y la cookie de recovery; la
 * page y la pantalla son las reales.
 */
const form = vi.hoisted(() => ({ state: null as unknown }));
vi.mock("react-dom", async (orig) => ({
  ...(await orig<typeof import("react-dom")>()),
  useFormState: () => [form.state, "/"],
  useFormStatus: () => ({ pending: false, data: null, method: null, action: null }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));
vi.mock("next/headers", () => ({ cookies: () => ({ get: () => ({ value: "firmada" }) }) }));
vi.mock("@/lib/recovery-cookie", () => ({ RECOVERY_COOKIE: "ks_recovery", verifyRecoveryCookie: () => true }));
vi.mock("@/lib/onboarding-internal", () => ({ getSessionUser: async () => ({ id: "u-1", email: "ana@x.test" }) }));
vi.mock("@/lib/auth", () => ({
  updatePasswordWithRecoverySession: async () => ({ ok: true, data: undefined }),
  signUpPractitioner: async () => ({ ok: false, error: "x" }),
  sendPasswordReset: async () => ({ ok: true, data: undefined }),
}));

import { renderToStaticMarkup } from "react-dom/server";
import ResetPage from "@/app/(auth)/reset/page";
import { PLATFORM_ACTIVATION_NEXT } from "@/lib/platform-provisioning-schemas";

const nextOf = (path: string) => new URL(path, "http://x").searchParams.get("next") ?? undefined;

describe("[ZF1a] /reset con next", () => {
  beforeEach(() => {
    form.state = { status: "done" };
  });

  it("[ZF1a] el link de activación del alta asistida sigue a /aceptar-terminos; sin next o con uno ajeno, al panel", async () => {
    const chained = renderToStaticMarkup(await ResetPage({ searchParams: { next: nextOf(PLATFORM_ACTIVATION_NEXT) } }));
    // `&` del query se escapa en el atributo.
    expect(chained).toContain('href="/aceptar-terminos?next=/dashboard"');
    expect(chained).not.toContain('href="/dashboard"');

    for (const next of [undefined, "//evil.com", "https://evil.com"]) {
      const html = renderToStaticMarkup(await ResetPage({ searchParams: { next } }));
      expect(html).toMatch(/<a[^>]*href="\/dashboard"[^>]*>Ir a tu panel<\/a>/);
      expect(html).not.toContain("evil.com");
    }
  });
});
