/**
 * [BO3-A] Guard del grupo `(platform)` (plan §19.5 «Superadmin sin consultorio casa»).
 *
 * Corre el layout real con el `requirePlatformAdmin` real (`lib/platform-actor.ts`). Se mockea solo la foto de la
 * sesión (`getAccessSnapshot`: cookie + Auth + perfil), la cookie de soporte (`resolveSupportTarget`: cookie + una
 * lectura) y las primitivas de Next (`notFound`/`redirect` tiran como en el runtime, `headers` trae `x-pathname`).
 * Nunca el guard. BO4: el segundo paso va por el puerto MFA con el fake inyectado (`__setPlatformMfaForTests`).
 *
 * El bug que fija: `/plataforma` colgaba de `(app)/layout.tsx`, que exige un Actor de consultorio; un superadmin sin
 * consultorio propio no podía entrar al panel desde el que se arregla justamente eso.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactElement } from "react";

const h = vi.hoisted(() => ({
  snapshot: null as unknown,
  support: null as unknown,
  path: "/plataforma/consultorios" as string | null,
  snapshotError: null as Error | null,
}));

vi.mock("@/lib/session", () => {
  class ForbiddenError extends Error {}
  class UnauthenticatedError extends Error {}
  return {
    ForbiddenError,
    UnauthenticatedError,
    getAccessSnapshot: vi.fn(async () => {
      if (h.snapshotError) throw h.snapshotError;
      return h.snapshot;
    }),
  };
});
vi.mock("@/lib/support-session-internal", () => ({
  resolveSupportTarget: vi.fn(async () => h.support),
}));
// "use server" con prisma detrás: el layout solo pasa la referencia al shell.
vi.mock("@/lib/platform-support", () => ({ endSupport: vi.fn() }));
vi.mock("@/lib/platform-mfa-actions", () => ({ verifyPlatformReauth: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: () => ({ get: (k: string) => (k === "x-pathname" ? h.path : null) }),
  cookies: () => ({ get: () => undefined }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
}));

import PlatformLayout from "@/app/(platform)/layout";
import { PlatformShell } from "@/components/plataforma/platform-shell";
import { PlatformReauthProvider } from "@/components/plataforma/reauth-modal";
import { __setPlatformMfaForTests } from "@/lib/platform-mfa";
import { PlatformMfaFake } from "@/tests/helpers/platform-mfa-fake";

type ShellProps = { email: string; hasHome: boolean; support: { tenantName: string } | null };

/** El layout devuelve `<PlatformReauthProvider><PlatformShell …/></…>` (BO4): se desenvuelve el shell. */
async function run(): Promise<ReactElement<ShellProps>> {
  const root = (await PlatformLayout({ children: "x" })) as ReactElement<{ children: ReactElement<ShellProps> }>;
  expect(root.type).toBe(PlatformReauthProvider);
  return root.props.children;
}

function snap(p: { admin: boolean; disabled?: boolean; home: string | null }) {
  return {
    userId: "u-admin",
    profile: { email: "admin@kinesoft.app", isPlatformAdmin: p.admin, disabledAt: p.disabled ? new Date() : null },
    state: p.home ? { kind: "ok", tenantId: p.home } : { kind: "needs_onboarding" },
  };
}

describe("[BO3-A] app/(platform)/layout.tsx", () => {
  beforeEach(() => {
    h.snapshot = null;
    h.support = null;
    h.path = "/plataforma/consultorios";
    h.snapshotError = null;
    delete process.env.PLATFORM_MFA_ENFORCEMENT;
    __setPlatformMfaForTests(null);
  });
  afterEach(() => {
    delete process.env.PLATFORM_MFA_ENFORCEMENT;
    __setPlatformMfaForTests(null);
  });

  it("superadmin SIN consultorio propio: renderiza el shell de Plataforma (sin «Volver a mi consultorio»)", async () => {
    h.snapshot = snap({ admin: true, home: null });
    const el = await run();
    expect(el.type).toBe(PlatformShell);
    expect(el.props).toMatchObject({ email: "admin@kinesoft.app", hasHome: false, support: null });
  });

  it("superadmin con consultorio propio: hasHome", async () => {
    h.snapshot = snap({ admin: true, home: "t-casa" });
    expect((await run()).props.hasHome).toBe(true);
  });

  it("con sesión de soporte abierta: el shell recibe el nombre del consultorio destino", async () => {
    h.snapshot = snap({ admin: true, home: "t-casa" });
    h.support = { sessionId: "s-1", tenantId: "t-dest", tenant: { name: "Kine Centro" } };
    expect((await run()).props.support).toEqual({ tenantName: "Kine Centro" });
  });

  it("usuario de consultorio (no superadmin) → notFound, no redirect (no revela que la sección existe)", async () => {
    h.snapshot = snap({ admin: false, home: "t-1" });
    await expect(run()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("superadmin deshabilitado → notFound", async () => {
    h.snapshot = snap({ admin: true, disabled: true, home: "t-1" });
    await expect(run()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("sin sesión → /login con next al path pedido", async () => {
    await expect(run()).rejects.toThrow(`NEXT_REDIRECT:/login?next=${encodeURIComponent("/plataforma/consultorios")}`);
  });

  it("sin sesión y x-pathname forjado (open redirect) → next cae a /plataforma", async () => {
    h.path = "//evil.example.com";
    await expect(run()).rejects.toThrow(`NEXT_REDIRECT:/login?next=${encodeURIComponent("/plataforma")}`);
  });

  it("un error que no es de autorización (DB caída) se propaga: no se disfraza de 404", async () => {
    h.snapshotError = new Error("db down");
    await expect(run()).rejects.toThrow("db down");
  });

  // ── BO4: segundo paso ──────────────────────────────────────────────────────

  it("[BO4] flag off (default): renderiza sin consultar a GoTrue aunque no tenga factor", async () => {
    const fake = new PlatformMfaFake();
    __setPlatformMfaForTests(fake);
    h.snapshot = snap({ admin: true, home: null });
    expect((await run()).type).toBe(PlatformShell);
    expect(fake.calls).toEqual([]);
  });

  it("[BO4] enforce sin factor → /plataforma-mfa/configurar con next", async () => {
    process.env.PLATFORM_MFA_ENFORCEMENT = "enforce";
    __setPlatformMfaForTests(new PlatformMfaFake());
    h.snapshot = snap({ admin: true, home: null });
    await expect(run()).rejects.toThrow(
      `NEXT_REDIRECT:/plataforma-mfa/configurar?next=${encodeURIComponent("/plataforma/consultorios")}`
    );
  });

  it("[BO4] enforce con factor y sesión AAL1 → /plataforma-mfa/verificar con next", async () => {
    process.env.PLATFORM_MFA_ENFORCEMENT = "enforce";
    __setPlatformMfaForTests(PlatformMfaFake.withVerifiedFactor("aal1"));
    h.snapshot = snap({ admin: true, home: "t-1" });
    await expect(run()).rejects.toThrow(
      `NEXT_REDIRECT:/plataforma-mfa/verificar?next=${encodeURIComponent("/plataforma/consultorios")}`
    );
  });

  it("[BO4] enforce y AAL2 → shell (el layout no pide re-verificación: no hay acción)", async () => {
    process.env.PLATFORM_MFA_ENFORCEMENT = "enforce";
    __setPlatformMfaForTests(PlatformMfaFake.withVerifiedFactor("aal2"));
    h.snapshot = snap({ admin: true, home: null });
    expect((await run()).type).toBe(PlatformShell);
  });

  it("[BO-Z B9] enforce y GoTrue caído → /plataforma-mfa/verificar con next (su «Reintentar»; ni 404 ni pasa)", async () => {
    process.env.PLATFORM_MFA_ENFORCEMENT = "enforce";
    const fake = PlatformMfaFake.withVerifiedFactor("aal2");
    fake.failAssurance = true;
    __setPlatformMfaForTests(fake);
    h.snapshot = snap({ admin: true, home: null });
    await expect(run()).rejects.toThrow(
      `NEXT_REDIRECT:/plataforma-mfa/verificar?next=${encodeURIComponent("/plataforma/consultorios")}`
    );
  });

  it("[BO4] enforce: un usuario de consultorio sigue viendo 404 (no se le revela el MFA de Plataforma)", async () => {
    process.env.PLATFORM_MFA_ENFORCEMENT = "enforce";
    const fake = new PlatformMfaFake();
    __setPlatformMfaForTests(fake);
    h.snapshot = snap({ admin: false, home: "t-1" });
    await expect(run()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(fake.calls).toEqual([]);
  });

  it("[BO4] enforce con x-pathname forjado → next cae a /plataforma", async () => {
    process.env.PLATFORM_MFA_ENFORCEMENT = "enforce";
    __setPlatformMfaForTests(new PlatformMfaFake());
    h.snapshot = snap({ admin: true, home: null });
    h.path = "/dashboard";
    await expect(run()).rejects.toThrow(`NEXT_REDIRECT:/plataforma-mfa/configurar?next=${encodeURIComponent("/plataforma")}`);
  });
});
