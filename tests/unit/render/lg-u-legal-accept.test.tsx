import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * [LG-U] PV (§27, LG): la UI manda la casilla de Términos y Privacidad que el server (LG-S) ya exige.
 *
 * Render real sin jsdom (`renderToStaticMarkup`) de las pantallas y los forms; el submit no se puede disparar sin DOM,
 * así que lo que viaja al server se afirma con las funciones puras que usa el submit (`signupFormAction` con FormData,
 * `clinicInputFrom`, `activationInputFrom`, `acceptInviteLegalFrom`). Se mockea solo la red: las actions de abajo
 * (`lib/auth`, `lib/onboarding`, las de la invitación), la sesión, la base y `next/navigation`.
 */
const form = vi.hoisted(() => ({ state: null as unknown }));
vi.mock("react-dom", async (orig) => ({
  ...(await orig<typeof import("react-dom")>()),
  useFormState: () => [form.state, "/"],
  useFormStatus: () => ({ pending: false, data: null, method: null, action: null }),
}));
class RedirectSignal extends Error {}
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(""),
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
}));
const calls = vi.hoisted(() => ({ signup: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  signUpPractitioner: calls.signup,
  sendPasswordReset: async () => ({ ok: true, data: undefined }),
  resendVerification: async () => ({ ok: true, data: undefined }),
  updatePasswordWithRecoverySession: async () => ({ ok: false, error: "x" }),
}));
vi.mock("@/lib/onboarding-internal", () => ({ getSessionUser: async () => null }));
vi.mock("@/lib/oauth-providers-public", () => ({ visibleOAuthProviders: async () => ["google", "facebook"] }));
vi.mock("@/lib/saas-plans-public", () => ({ getPublicPlanCatalog: async () => [] }));
vi.mock("@/lib/onboarding", () => ({
  saveOnboardingClinic: vi.fn(),
  completeOnboarding: vi.fn(),
  saveOnboardingLocation: vi.fn(),
  openPendingInvitation: vi.fn(),
}));
vi.mock("@/lib/tenant-settings", () => ({ setBusinessHours: vi.fn() }));
vi.mock("@/app/invite/[token]/activate-action", () => ({ activateInvitationAction: vi.fn() }));
vi.mock("@/app/invite/[token]/accept-action", () => ({ acceptInvite: vi.fn() }));
// La página de la invitación: lo que lee (invitación, sesión, «¿ya aceptó?») se fija acá.
const inv = vi.hoisted(() => ({ legalAccepted: false, legalCalls: [] as string[] }));
vi.mock("@/lib/invitations-internal", () => ({
  findInvitationByRawToken: async () => ({
    id: "i1",
    tenantId: "t1",
    email: "ana@x.test",
    firstName: "Ana",
    lastName: "Paz",
    role: "PRACTITIONER",
    specialty: null,
    invitedById: "u0",
    invitedAt: new Date("2026-10-20T12:00:00Z"),
    expiresAt: new Date("2026-11-20T12:00:00Z"),
    acceptedAt: null,
    revokedAt: null,
    acceptedByUserId: null,
    tenant: { id: "t1", name: "Consultorio Norte", slug: "norte", vertical: "KINESIOLOGY" },
    status: "pending",
    matchedPrior: false,
  }),
}));
vi.mock("@/lib/session-user", () => ({
  getVerifiedSessionUser: async () => ({ id: "u-ana", email: "ana@x.test" }),
}));
vi.mock("@/lib/legal-acceptance-internal", () => ({
  hasAcceptedCurrentLegal: async (userId: string) => {
    inv.legalCalls.push(userId);
    return inv.legalAccepted;
  },
}));
vi.mock("@/lib/db", () => ({ prismaService: { userProfile: { findFirst: async () => null } } }));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { SignupScreen, SignupAssisted } from "@/components/screens/signup-screen";
import { signupFormAction } from "@/components/auth/auth-form-actions";
import { clinicInputFrom, StepClinic } from "@/components/onboarding/steps-basic";
import { ActivateForm, activationInputFrom } from "@/app/invite/[token]/activate-form";
import { AcceptInviteButton, acceptInviteLegalFrom } from "@/app/invite/[token]/accept-button";
import InvitePage from "@/app/invite/[token]/page";
import { LegalAcceptCheckbox } from "@/components/legal/legal-accept";
import { LEGAL_ACCEPT_ERROR, PRIVACY_PATH, TERMS_PATH } from "@/lib/legal";

const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const checkboxTag = (h: string) => h.match(/<input[^>]*name="acceptLegal"[^>]*>/)?.[0] ?? "";
const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

beforeEach(() => {
  form.state = null;
  calls.signup.mockReset();
  inv.legalAccepted = false;
  inv.legalCalls = [];
});

describe("[LG-U] la casilla", () => {
  it("copy literal, links a /terminos y /privacidad en pestaña nueva, sin tildar, required", () => {
    const h = renderToStaticMarkup(<LegalAcceptCheckbox id="x-legal" />);
    expect(text(h)).toContain("Acepto los Términos y condiciones y la Política de privacidad .");
    for (const href of [TERMS_PATH, PRIVACY_PATH]) {
      const a = h.match(new RegExp(`<a[^>]*href="${href}"[^>]*>`))?.[0] ?? "";
      expect(a).toContain('target="_blank"');
      expect(a).toContain('rel="noopener noreferrer"');
    }
    const box = checkboxTag(h);
    expect(box).toContain('type="checkbox"');
    expect(box).toContain('id="x-legal"');
    expect(box).toContain("required");
    expect(box).not.toContain("checked");
    expect(box).not.toContain("aria-invalid");
    expect(h).toMatch(/<label[^>]*for="x-legal"[^>]*min-height:44px/);
  });

  it("con error: visible y asociado (aria-describedby, aria-invalid, aria-errormessage)", () => {
    const h = renderToStaticMarkup(<LegalAcceptCheckbox id="x-legal" error={LEGAL_ACCEPT_ERROR} />);
    const box = checkboxTag(h);
    expect(box).toContain('aria-invalid="true"');
    expect(box).toContain('aria-describedby="x-legal-error"');
    expect(box).toContain('aria-errormessage="x-legal-error"');
    expect(h).toMatch(new RegExp(`<p id="x-legal-error"[^>]*>.*${LEGAL_ACCEPT_ERROR}`, "s"));
  });
});

describe("[LG-U] alta por email", () => {
  it("signup muestra la casilla y la nota legal bajo los sociales", () => {
    const h = renderToStaticMarkup(<SignupScreen providers={["google", "facebook"]} />);
    expect(checkboxTag(h)).toContain('id="signup-legal"');
    expect(text(h)).toContain(
      "Si continuás con Google o Facebook, aceptás los Términos y la Política de privacidad ."
    );
    // La nota va DESPUÉS de los botones sociales y ANTES del divisor «o con tu email».
    const iSocial = h.lastIndexOf("k-btn-social");
    const iNote = h.indexOf("Si continuás con");
    const iDivider = h.indexOf("o con tu email");
    expect(iSocial).toBeLessThan(iNote);
    expect(iNote).toBeLessThan(iDivider);
  });

  it("la nota nombra solo los proveedores visibles; sin sociales no hay nota", () => {
    expect(text(renderToStaticMarkup(<SignupScreen providers={["google"]} />))).toContain(
      "Si continuás con Google, aceptás los Términos"
    );
    expect(renderToStaticMarkup(<SignupScreen providers={[]} />)).not.toContain("Si continuás con");
  });

  it("signupFormAction manda `acceptLegal` tal cual lo manda el checkbox («on») o vacío si no se tildó", async () => {
    calls.signup.mockResolvedValue({ ok: true, data: { email: "ana@x.test", joining: false, message: "ok" } });
    await signupFormAction(null, fd({ fullName: "Ana", email: "ana@x.test", password: "abc12345", acceptLegal: "on" }));
    expect(calls.signup).toHaveBeenLastCalledWith({
      fullName: "Ana",
      email: "ana@x.test",
      password: "abc12345",
      inviteToken: "",
      acceptLegal: "on",
    });
    await signupFormAction(null, fd({ fullName: "Ana", email: "ana@x.test", password: "abc12345" }));
    expect(calls.signup.mock.lastCall?.[0]).toMatchObject({ acceptLegal: "" });
  });

  it("`fieldErrors.acceptLegal` se ve en la casilla, sin repetirlo en el aviso general", () => {
    form.state = {
      status: "error",
      error: LEGAL_ACCEPT_ERROR,
      fieldErrors: { acceptLegal: [LEGAL_ACCEPT_ERROR] },
      values: { fullName: "Ana", email: "ana@x.test" },
    };
    const h = renderToStaticMarkup(<SignupScreen />);
    expect(checkboxTag(h)).toContain('aria-invalid="true"');
    expect(h).toContain('id="signup-legal-error"');
    expect(h.split(LEGAL_ACCEPT_ERROR).length - 1).toBe(1);
  });

  it("alta asistida: link a /contacto?motivo=alta, sin mailto", () => {
    const h = renderToStaticMarkup(<SignupAssisted message="Por ahora damos de alta los consultorios nosotros." />);
    expect(h).toMatch(/<a[^>]*href="\/contacto\?motivo=alta"/);
    expect(h).not.toContain("mailto:");
  });
});

describe("[LG-U] onboarding, paso Consultorio", () => {
  it("la casilla solo si `legalAccepted === false`", () => {
    const off = renderToStaticMarkup(<StepClinic tenant={null} patientIdentity={false} legalAccepted={false} />);
    expect(checkboxTag(off)).toContain('id="onb-legal"');
    const on = renderToStaticMarkup(<StepClinic tenant={null} patientIdentity={false} legalAccepted />);
    expect(checkboxTag(on)).toBe("");
  });

  it("clinicInputFrom suma `acceptLegal` (tildada = true)", () => {
    const base = { vertical: "KINESIOLOGY" as const, ownerClinical: true, creating: true };
    expect(clinicInputFrom(fd({ name: "N", acceptLegal: "on" }), base).acceptLegal).toBe(true);
    expect(clinicInputFrom(fd({ name: "N" }), base).acceptLegal).toBe(false);
  });

  it("sin mailto: «escribinos» va a /contacto?motivo=onboarding", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPPORT_EMAIL", "soporte@ejemplo.com");
    try {
      const h = renderToStaticMarkup(<StepClinic tenant={null} patientIdentity={false} legalAccepted />);
      expect(h).not.toContain("mailto:");
      expect(h).toMatch(/<a[^>]*href="\/contacto\?motivo=onboarding"/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("[LG-U] invitaciones", () => {
  it("activar: la casilla siempre, y `acceptLegal` viaja a la action", () => {
    const h = renderToStaticMarkup(
      <ActivateForm token="tok" email="ana@x.test" firstName="Ana" lastName="Paz" tenantName="Norte" />
    );
    expect(checkboxTag(h)).toContain('id="invite-legal"');
    expect(
      activationInputFrom("tok", fd({ firstName: "Ana", lastName: "Paz", password: "a1", passwordConfirm: "a1", acceptLegal: "on" }))
    ).toEqual({ token: "tok", firstName: "Ana", lastName: "Paz", password: "a1", passwordConfirm: "a1", acceptLegal: true });
    expect(activationInputFrom("tok", fd({})).acceptLegal).toBe(false);
  });

  it("aceptar con sesión: casilla solo si no aceptó la versión vigente", () => {
    expect(checkboxTag(renderToStaticMarkup(<AcceptInviteButton token="t" tenantName="N" legalAccepted={false} />))).toContain(
      'id="invite-accept-legal"'
    );
    expect(checkboxTag(renderToStaticMarkup(<AcceptInviteButton token="t" tenantName="N" legalAccepted />))).toBe("");
    expect(acceptInviteLegalFrom(fd({ acceptLegal: "on" }))).toBe(true);
    expect(acceptInviteLegalFrom(fd({}))).toBe(false);
  });

  it("la página (estado join) pregunta `hasAcceptedCurrentLegal` del usuario de la sesión y se lo pasa al botón", async () => {
    inv.legalAccepted = false;
    const off = renderToStaticMarkup(await InvitePage({ params: { token: "tok_aaaaaaaaaaaaaaaa" } }));
    expect(inv.legalCalls).toEqual(["u-ana"]);
    expect(text(off)).toContain("Unirme a Consultorio Norte");
    expect(checkboxTag(off)).toContain('id="invite-accept-legal"');
    inv.legalAccepted = true;
    const on = renderToStaticMarkup(await InvitePage({ params: { token: "tok_aaaaaaaaaaaaaaaa" } }));
    expect(checkboxTag(on)).toBe("");
  });
});

describe("[LG-U] sin mailto en el alta y el onboarding", () => {
  it("los archivos del alta y del paso Consultorio no arman mailto", () => {
    for (const f of ["components/screens/signup-screen.tsx", "app/(auth)/signup/page.tsx", "components/onboarding/steps-basic.tsx"]) {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      expect(src, f).not.toMatch(/mailto|supportMailto|SupportContact/);
    }
  });
});
