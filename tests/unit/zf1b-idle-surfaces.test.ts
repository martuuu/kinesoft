/**
 * [ZF1b] PV-Z · ZA M2: el cierre por inactividad (IN, §27) también fuera del grupo `(app)`.
 *
 * El hallazgo: `readIdleShellState` solo se consultaba en `app/(app)/layout.tsx` y en el login. Con la cookie
 * `kine_idle` de ESTA sesión vencida (más la gracia), la PC compartida que Chrome reabrió seguía pudiendo:
 *   - bajar el CSV de pacientes y el ICS de la agenda (`GET /api/pacientes/export`, `GET /api/agenda/export`): PHI en
 *     bloque con un solo GET;
 *   - entrar a `/cuenta/*` (seguridad, perfil público) y a `/plataforma` (el panel del superadmin).
 *
 * Se corren los handlers y layouts REALES con el `readIdleShellState` real. Se mockea solo la cookie store y los
 * headers de Next, la lectura del token (`getSessionUser`: JWT/red), el actor (`tryGetActor`), el rate limit y el
 * armado del CSV/ICS (DB). `redirect`/`notFound` tiran como en el runtime.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";

const req = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  sessionId: null as string | null,
  path: "/cuenta/seguridad" as string | null,
  actorReads: 0,
  csvCalls: 0,
  icsCalls: 0,
  platformReads: 0,
}));

vi.mock("next/headers", () => ({
  cookies: () => ({ get: (n: string) => (req.cookies.has(n) ? { name: n, value: req.cookies.get(n)! } : undefined) }),
  headers: () => ({ get: (k: string) => (k === "x-pathname" ? req.path : null) }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
}));
vi.mock("@/lib/session-user", () => ({
  getSessionUser: async () => (req.sessionId ? { id: "u-zf1b", sessionId: req.sessionId } : null),
  getStrictSessionUser: async () => (req.sessionId ? { id: "u-zf1b", sessionId: req.sessionId } : null),
}));
vi.mock("@/lib/session", () => {
  class ForbiddenError extends Error {}
  class UnauthenticatedError extends Error {}
  return {
    ForbiddenError,
    UnauthenticatedError,
    tryGetActor: async () => {
      req.actorReads++;
      return { tenantId: "t-zf1b", userId: "u-zf1b", support: null };
    },
    getAccessSnapshot: async () => null,
  };
});
vi.mock("@/lib/rate-limit", () => ({ rateLimit: async () => ({ ok: true, remaining: 1, retryAfterMs: 0 }) }));
vi.mock("@/lib/patients-export-internal", () => ({
  exportPatientsCsv: async () => {
    req.csvCalls++;
    return "id,nombre\n1,Ana\n";
  },
}));
vi.mock("@/lib/bookings-export-internal", () => ({
  exportBookingsIcs: async () => {
    req.icsCalls++;
    return "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n";
  },
}));
// Plataforma: el guard real (`requirePlatformAdmin`) lo cubre `platform-layout.test.ts`; acá solo importa si se llega
// a él o no. En el caso vigente tira un centinela: «pasó el chequeo de inactividad y siguió como hoy».
vi.mock("@/lib/platform-actor", async (orig) => ({
  ...(await orig<typeof import("@/lib/platform-actor")>()),
  requirePlatformAdmin: async () => {
    req.platformReads++;
    throw new Error("REACHED_PLATFORM_GUARD");
  },
}));
vi.mock("@/lib/support-session-internal", () => ({ resolveSupportTarget: async () => null }));
vi.mock("@/lib/platform-support", () => ({ endSupport: vi.fn() }));
vi.mock("@/lib/platform-mfa-actions", () => ({ verifyPlatformReauth: vi.fn() }));

import { GET as exportPatients } from "@/app/api/pacientes/export/route";
import { GET as exportAgenda } from "@/app/api/agenda/export/route";
import CuentaLayout from "@/app/cuenta/layout";
import PlatformLayout from "@/app/(platform)/layout";
import { UIProviders } from "@/components/providers/ui-providers";
import { IDLE_COOKIE, IDLE_DEFAULT_MINUTES, serializeIdleCookie } from "@/lib/idle-logout";
import { idleLoginHref, idleSessionTag } from "@/lib/idle-logout-internal";
import { SESSION_MODE_COOKIE } from "@/lib/supabase/session-mode";

const SID = "7a1b2c3d-2222-4b6c-9d1e-0a0b0c0d0e0f";

/** Sesión «de navegador» con la cookie de ESTA sesión: `lastMs` = última actividad. */
function browserSession(lastMs: number) {
  req.sessionId = SID;
  req.cookies.set(SESSION_MODE_COOKIE, "ephemeral");
  req.cookies.set(IDLE_COOKIE, serializeIdleCookie(lastMs, IDLE_DEFAULT_MINUTES, idleSessionTag(SID)));
}
const expired = () => browserSession(Date.now() - 2 * 3_600_000);
const fresh = () => browserSession(Date.now());

beforeEach(() => {
  req.cookies.clear();
  req.sessionId = null;
  req.path = "/cuenta/seguridad";
  req.actorReads = 0;
  req.csvCalls = 0;
  req.icsCalls = 0;
  req.platformReads = 0;
});

describe("[ZF1b] exports con la sesión vencida por inactividad", () => {
  it("[ZF1b] GET /api/pacientes/export con kine_idle vencida → 401 sin datos y sin leer el actor", async () => {
    expired();
    const res = await exportPatients(new Request("http://localhost/api/pacientes/export"));
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).not.toContain("Ana");
    expect(res.headers.get("Content-Disposition")).toBeNull();
    expect(req.csvCalls).toBe(0);
    expect(req.actorReads).toBe(0);
  });

  it("[ZF1b] GET /api/agenda/export con kine_idle vencida → 401 sin datos y sin leer el actor", async () => {
    expired();
    const res = await exportAgenda(new Request("http://localhost/api/agenda/export"));
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain("VCALENDAR");
    expect(req.icsCalls).toBe(0);
    expect(req.actorReads).toBe(0);
  });

  it("control: con la cookie vigente (o sesión persistente) los dos exports responden como hoy", async () => {
    fresh();
    const p = await exportPatients(new Request("http://localhost/api/pacientes/export"));
    expect(p.status).toBe(200);
    expect(await p.text()).toContain("Ana");
    const a = await exportAgenda(new Request("http://localhost/api/agenda/export"));
    expect(a.status).toBe(200);
    // Persistente (sin `kine_session_mode`): sin política de inactividad, aunque quede una `kine_idle` vieja.
    req.cookies.delete(SESSION_MODE_COOKIE);
    req.cookies.set(IDLE_COOKIE, serializeIdleCookie(Date.now() - 2 * 3_600_000, IDLE_DEFAULT_MINUTES, idleSessionTag(SID)));
    expect((await exportPatients(new Request("http://localhost/api/pacientes/export"))).status).toBe(200);
    expect(req.csvCalls).toBe(2);
  });
});

describe("[ZF1b] /cuenta/* y /plataforma con la sesión vencida por inactividad", () => {
  it("[ZF1b] app/cuenta/layout con kine_idle vencida → redirect al login por inactividad con next", async () => {
    expired();
    req.path = "/cuenta/seguridad";
    await expect(CuentaLayout({ children: "x" })).rejects.toThrow(`NEXT_REDIRECT:${idleLoginHref("/cuenta/seguridad")}`);
    expect(idleLoginHref("/cuenta/seguridad")).toContain("reason=idle");
  });

  it("control: app/cuenta/layout con la cookie vigente renderiza como hoy (UIProviders + children)", async () => {
    fresh();
    const el = (await CuentaLayout({ children: "contenido" })) as ReactElement<{ children: unknown }>;
    expect(el.type).toBe(UIProviders);
    expect(el.props.children).toBe("contenido");
  });

  it("[ZF1b] app/(platform)/layout con kine_idle vencida → redirect ANTES del guard de Plataforma", async () => {
    expired();
    req.path = "/plataforma/consultorios";
    await expect(PlatformLayout({ children: "x" })).rejects.toThrow(
      `NEXT_REDIRECT:${idleLoginHref("/plataforma/consultorios")}`
    );
    expect(req.platformReads).toBe(0);
  });

  it("control: app/(platform)/layout con la cookie vigente sigue al guard como hoy", async () => {
    fresh();
    req.path = "/plataforma";
    await expect(PlatformLayout({ children: "x" })).rejects.toThrow("REACHED_PLATFORM_GUARD");
    expect(req.platformReads).toBe(1);
  });
});
