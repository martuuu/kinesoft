/**
 * [TK-U2] `/contacto` (PV §27, TK): la entrada pública única de contacto decide por la SESIÓN.
 *
 * Render real de la página (server component async llamado como función, sin jsdom) y de los forms. Se mockea solo lo
 * de afuera, como `vx2-b1-status.test.tsx`: la sesión (`getAccessSnapshot` / `getSessionUser`: cookie + base),
 * `redirect` de Next, `useFormState`/`useFormStatus` (el react-dom 18 de node no los trae) y las dos server actions
 * (red/base). `sessionBlockOf`, `ticketSourceFromMotivo`, `TICKET_PAGE_COPY`, `ContactForm`, `SessionTicketForm` y
 * `AuthShell` son los reales.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// `lib/session` usa `react.cache` (solo existe en el runtime RSC de Next): identidad fuera de él.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, default: actual, cache: <T,>(fn: T) => fn };
});

const h = vi.hoisted(() => ({
  snapshot: null as unknown,
  snapshotThrows: false,
  sessionUser: null as unknown,
  formState: null as unknown,
}));

vi.mock("react-dom", async (orig) => ({
  ...(await orig<typeof import("react-dom")>()),
  useFormState: () => [h.formState, "/contacto"],
  useFormStatus: () => ({ pending: false, data: null, method: null, action: null }),
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));

vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return {
    ...actual,
    getAccessSnapshot: vi.fn(async () => {
      if (h.snapshotThrows) throw new Error("db down");
      return h.snapshot;
    }),
  };
});

vi.mock("@/lib/session-user", () => ({
  getSessionUser: vi.fn(async () => h.sessionUser),
  getVerifiedSessionUser: vi.fn(async () => h.sessionUser),
  getStrictSessionUser: vi.fn(async () => h.sessionUser),
}));

vi.mock("@/lib/leads", () => ({ submitLeadForm: vi.fn() }));
vi.mock("@/lib/tickets", () => ({ submitSessionTicket: vi.fn() }));

import ContactoPage, { generateMetadata } from "@/app/contacto/page";
import { sessionTicketFeedback } from "@/components/contact/session-ticket-form";
import { TICKET_ERROR_COPY } from "@/lib/tickets-types";

const text = (s: string) =>
  s
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
const h1s = (html: string) => html.match(/<h1[\s>][\s\S]*?<\/h1>/g) ?? [];

async function render(sp: Record<string, string | string[] | undefined> = {}): Promise<string> {
  const el = (await ContactoPage({ searchParams: sp })) as ReactElement;
  return renderToStaticMarkup(el);
}

async function redirectOf(sp: Record<string, string> = {}): Promise<string | null> {
  try {
    await ContactoPage({ searchParams: sp });
    return null;
  } catch (e) {
    const m = /^REDIRECT:(.*)$/.exec((e as Error).message);
    if (!m) throw e;
    return m[1];
  }
}

type Block = { tenantId: string; tenantName: string; role: string; kind: "suspended" | "closed" };

function snap(opts: {
  state?: { kind: "ok"; tenantId: string } | { kind: "needs_onboarding" } | { kind: "no_access"; reason: string };
  tenantBlocks?: Block[];
  disabled?: boolean;
  email?: string;
}) {
  return {
    userId: "u1",
    profile: {
      fullName: "Ana Kine",
      email: opts.email ?? "ana@consultorio.test",
      isPlatformAdmin: false,
      disabledAt: opts.disabled ? new Date("2026-10-01T00:00:00Z") : null,
      twoFactor: { totp: false, email: false },
    },
    memberships: [],
    usable: [],
    cookieTenantId: null,
    preferredTenantId: null,
    cookieValid: false,
    state: opts.state ?? { kind: "no_access", reason: "all_disabled" },
    now: new Date("2026-10-27T12:00:00Z"),
    tenantBlocks: opts.tenantBlocks ?? [],
    twoFactor: { methods: { totp: false, email: false }, state: "not_enabled" },
  };
}

beforeEach(() => {
  h.snapshot = null;
  h.snapshotThrows = false;
  h.sessionUser = null;
  h.formState = null;
  vi.stubEnv("NEXT_PUBLIC_SUPPORT_EMAIL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("[TK-20] /contacto sin sesión → form de lead (hilo LEAD)", () => {
  it("default: «Escribinos», form de la landing, source LANDING oculto, una sola h1", async () => {
    const html = await render();
    expect(html).toContain('data-variant="centered"');
    expect(h1s(html)).toHaveLength(1);
    expect(text(h1s(html)[0] ?? "")).toBe("Escribinos");
    expect(html).toContain('name="website"'); // honeypot del form de lead
    expect(html).toContain('name="email"');
    expect(html).toMatch(/<input type="hidden" name="source" value="LANDING"\/>/);
    expect(html).not.toContain("mailto:");
  });

  it.each([
    ["precio", "Pedinos el precio", "PRICING"],
    ["plan-libre", "Armemos tu plan Libre", "PLAN_LIBRE"],
    ["alta", "Sumá tu consultorio", "SIGNUP_ASSISTED"],
    ["onboarding", "¿Necesitás ayuda con el alta?", "ONBOARDING"],
    ["privacidad", "Tus datos personales", "PRIVACY"],
    ["cuenta", "Escribinos por tu cuenta", "ACCOUNT_DISABLED"],
  ])("motivo=%s → título «%s» y source %s oculto", async (motivo, title, source) => {
    const html = await render({ motivo });
    expect(text(h1s(html)[0] ?? "")).toBe(title);
    expect(html).toContain(`<input type="hidden" name="source" value="${source}"/>`);
  });

  it("motivo de un origen solo-TENANT (suspendido) → título por motivo pero SIN source (el lead cae en LANDING)", async () => {
    const html = await render({ motivo: "suspendido" });
    expect(text(h1s(html)[0] ?? "")).toBe("Escribinos por tu consultorio");
    expect(html).not.toContain('name="source"');
  });

  it("motivo desconocido → default (nunca un error)", async () => {
    const html = await render({ motivo: "constructor" });
    expect(text(h1s(html)[0] ?? "")).toBe("Escribinos");
    expect(html).toContain('name="source" value="LANDING"');
  });

  it("plan=LIBRE preselecciona el plan; un plan inválido no preselecciona nada", async () => {
    const libre = await render({ motivo: "plan-libre", plan: "LIBRE" });
    expect(libre).toMatch(/<option value="LIBRE" selected="">/);
    const bad = await render({ motivo: "precio", plan: "GRATIS" });
    expect(bad).not.toMatch(/<option value="[A-Z]+" selected/);
  });

  it("la base caída al leer la sesión no tumba la página: form de lead", async () => {
    h.snapshotThrows = true;
    const html = await render({ motivo: "precio" });
    expect(text(h1s(html)[0] ?? "")).toBe("Pedinos el precio");
    expect(html).toContain('name="website"');
  });

  it("noindex salvo el default", () => {
    expect(generateMetadata({ searchParams: {} }).robots).toBeUndefined();
    expect(generateMetadata({ searchParams: { motivo: "precio" } }).robots).toMatchObject({ index: false });
    expect(String(generateMetadata({ searchParams: { motivo: "precio" } }).title)).toContain("Pedinos el precio");
  });
});

describe("[TK-20] /contacto con consultorio usable → Configuración → Soporte", () => {
  it("redirect a /configuracion?tab=soporte&nuevo=<slug>", async () => {
    h.snapshot = snap({ state: { kind: "ok", tenantId: "t1" } });
    expect(await redirectOf({ motivo: "precio" })).toBe("/configuracion?tab=soporte&nuevo=precio");
    expect(await redirectOf({})).toBe("/configuracion?tab=soporte&nuevo=contacto");
    expect(await redirectOf({ motivo: "x" })).toBe("/configuracion?tab=soporte&nuevo=contacto");
  });
});

describe("[TK-20] /contacto con sesión bloqueada o sin consultorio → form de sesión", () => {
  it("OWNER de un consultorio suspendido: identidad de la sesión, sin campo email, mail de soporte como segunda opción", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPPORT_EMAIL", "soporte@ejemplo.com");
    h.snapshot = snap({
      tenantBlocks: [{ tenantId: "t1", tenantName: "Movare", role: "OWNER", kind: "suspended" }],
    });
    h.sessionUser = { id: "u1", email: "ana@consultorio.test" };
    const html = await render({ motivo: "suspendido" });
    expect(h1s(html)).toHaveLength(1);
    expect(text(h1s(html)[0] ?? "")).toBe("Escribinos por tu consultorio");
    expect(text(html)).toContain("Te respondemos a ana@consultorio.test.");
    expect(html).toContain('name="message"');
    expect(html).toContain('<input type="hidden" name="motivo" value="suspendido"/>');
    // La identidad sale de la sesión: el form no tiene email ni nombre, ni el honeypot del lead.
    expect(html).not.toContain('name="email"');
    expect(html).not.toContain('name="name"');
    expect(html).not.toContain('name="website"');
    // Un solo consultorio bloqueado: no hay selector.
    expect(html).not.toContain('name="tenantId"');
    expect(html).toMatch(/¿Preferís el mail\? Escribinos a <a href="mailto:soporte@ejemplo\.com"[^>]*>soporte@ejemplo\.com<\/a>\./);
  });

  it("titular de dos consultorios bloqueados: elige cuál (tenantId), el suspendido primero", async () => {
    h.snapshot = snap({
      tenantBlocks: [
        { tenantId: "t2", tenantName: "Cerrado SA", role: "OWNER", kind: "closed" },
        { tenantId: "t1", tenantName: "Movare", role: "ADMIN", kind: "suspended" },
      ],
    });
    const html = await render({ motivo: "suspendido" });
    expect(html).toContain('name="tenantId"');
    expect(html.indexOf('value="t1"')).toBeLessThan(html.indexOf('value="t2"'));
  });

  it("sin mail de soporte configurado: no hay segunda opción", async () => {
    h.snapshot = snap({
      tenantBlocks: [{ tenantId: "t1", tenantName: "Movare", role: "OWNER", kind: "suspended" }],
    });
    const html = await render({ motivo: "suspendido" });
    expect(text(html)).not.toContain("¿Preferís el mail?");
    expect(html).not.toContain("mailto:");
  });

  it("miembro sin rol de titular de un consultorio suspendido: «Avisale al titular…» y sin form", async () => {
    h.snapshot = snap({
      tenantBlocks: [{ tenantId: "t1", tenantName: "Movare", role: "ASSISTANT", kind: "suspended" }],
    });
    const html = await render({ motivo: "suspendido" });
    expect(text(html)).toContain(TICKET_ERROR_COPY.notAdmin);
    expect(html).not.toContain('name="message"');
  });

  it("usuario deshabilitado → «Escribinos por tu cuenta» con el email de la sesión", async () => {
    h.snapshot = snap({ disabled: true, email: "beto@x.test" });
    const html = await render({ motivo: "cuenta" });
    expect(text(h1s(html)[0] ?? "")).toBe("Escribinos por tu cuenta");
    expect(text(html)).toContain("Te respondemos a beto@x.test.");
    expect(html).toContain('name="message"');
  });

  it("sin consultorio (alta a medio hacer) → «¿Necesitás ayuda con el alta?»", async () => {
    h.snapshot = snap({ state: { kind: "needs_onboarding" } });
    const html = await render({ motivo: "onboarding" });
    expect(text(h1s(html)[0] ?? "")).toBe("¿Necesitás ayuda con el alta?");
    expect(html).toContain('name="message"');
  });

  it("[INT-c] sin membresías (paciente del portal) y motivo=privacidad → form de lead con source PRIVACY, no el de alta", async () => {
    // Hallazgo TK-U2: un paciente del portal con sesión no tiene membresías (`needs_onboarding`, igual que un alta a
    // medio hacer) y veía «¿Necesitás ayuda con el alta?»; `submitSessionTicket` abría un LEAD ONBOARDING aunque
    // viniera por sus datos personales.
    h.snapshot = snap({ state: { kind: "needs_onboarding" } });
    const html = await render({ motivo: "privacidad" });
    expect(text(h1s(html)[0] ?? "")).toBe("Tus datos personales");
    expect(html).toContain('<input type="hidden" name="source" value="PRIVACY"/>');
    expect(html).toContain('name="website"'); // honeypot: es el form de lead
    expect(text(html)).not.toContain("¿Necesitás ayuda con el alta?");
  });

  it("[INT-c] sin membresías y sin motivo → form de lead LANDING", async () => {
    h.snapshot = snap({ state: { kind: "needs_onboarding" } });
    const html = await render();
    expect(text(h1s(html)[0] ?? "")).toBe("Escribinos");
    expect(html).toContain('<input type="hidden" name="source" value="LANDING"/>');
  });

  it("[INT-c] sin membresías y motivo=alta → sigue el form de sesión del alta (identidad de la sesión)", async () => {
    h.snapshot = snap({ state: { kind: "needs_onboarding" } });
    const html = await render({ motivo: "alta" });
    expect(text(h1s(html)[0] ?? "")).toBe("¿Necesitás ayuda con el alta?");
    expect(html).not.toContain('name="website"');
    expect(html).toContain('name="message"');
  });

  it("éxito: «Recibimos tu mensaje. Te respondemos a {email}.» y el form ya no está", async () => {
    h.snapshot = snap({ state: { kind: "needs_onboarding" } });
    h.formState = { ok: true, data: { received: true, email: "ana@consultorio.test" } };
    const html = await render({ motivo: "onboarding" });
    expect(text(html)).toContain("Recibimos tu mensaje. Te respondemos a ana@consultorio.test.");
    expect(html).toMatch(/role="status"/);
    expect(html).not.toContain('name="message"');
  });

  it("error de la action: alerta con el texto del server", async () => {
    h.snapshot = snap({ state: { kind: "needs_onboarding" } });
    h.formState = { ok: false, error: TICKET_ERROR_COPY.dailyCap };
    const html = await render({ motivo: "onboarding" });
    expect(html).toMatch(/role="alert"/);
    expect(text(html)).toContain(TICKET_ERROR_COPY.dailyCap);
    expect(html).toContain('name="message"');
  });

  it("sessionTicketFeedback: null / ok / error", () => {
    expect(sessionTicketFeedback(null)).toBeNull();
    expect(sessionTicketFeedback({ ok: true, data: { received: true, email: "a@b.c" } })).toEqual({
      kind: "success",
      text: "Recibimos tu mensaje. Te respondemos a a@b.c.",
    });
    expect(sessionTicketFeedback({ ok: false, error: "" })?.kind).toBe("error");
  });
});
