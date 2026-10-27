/**
 * PV ZF1a (ZA M1) · el titular dado de alta desde /plataforma acepta los Términos antes de entrar.
 *
 * El hallazgo: el alta por email, el onboarding y las invitaciones piden la casilla (LG-S), pero el alta asistida no.
 * El titular activaba la clave en `/reset` y caía en `/dashboard` (con `onboardingCompleted` true, el default) sin
 * haber aceptado nada: el consultorio quedaba operando datos de pacientes sin consentimiento registrado.
 *
 * El arreglo: el link de activación de un titular CREADO en esa alta lleva `/reset?next=/aceptar-terminos?next=/dashboard`;
 * `/aceptar-terminos` (fuera de `(app)`) pide la casilla y la action registra `legal.accepted {version, via:
 * "platform_activation"}`. Cuentas que ya existían: sin cambios (decisión: no se les pide).
 *
 * Símbolos reales contra Postgres en los dos roles: `createTenantWithOwner`, la página y la action. Se reemplazan solo
 * GoTrue (fake), el despacho del mail y la sesión (integration-setup + `asUser`). `UserSecurityEvent` es solo inserción
 * (trigger de M8): los eventos de estas identidades (UUID del fake) quedan, como en `lg-s-legal-acceptance.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { isValidElement } from "react";
import type { PrismaClient } from "@prisma/client";
import { createTenantWithOwner } from "@/lib/platform-provisioning";
import type { CreateTenantWithOwnerInputType } from "@/lib/platform-provisioning-schemas";
import { acceptLegalAndContinue } from "@/lib/legal-accept-action";
import AceptarTerminosPage from "@/app/aceptar-terminos/page";
import { LEGAL_VERSION } from "@/lib/legal";
import { __setEmailTransportForTests, type SendEmailInput, type SendEmailResult } from "@/lib/email";
import { __setAuthAdminForTests } from "@/lib/identity/auth-admin";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { GotrueFake } from "@/tests/helpers/gotrue-fake";
import { asAnonymous, asUser } from "@/tests/helpers/actor";
import {
  ownerClient,
  createEphemeralTenant,
  deleteTenantDeep,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

const mail = {
  sent: [] as SendEmailInput[],
  transport: async (i: SendEmailInput): Promise<SendEmailResult> => {
    mail.sent.push(i);
    return { ok: true, transport: "resend", providerId: `re_${mail.sent.length}` };
  },
};

function fd(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

/** Destino de un `redirect()` de Next (tira un error con digest `NEXT_REDIRECT;<tipo>;<url>;<status>;`), o null. */
async function redirectOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (e) {
    const digest = (e as { digest?: unknown }).digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT;")) return digest.split(";")[2];
    throw e;
  }
}

describe.skipIf(!RUN)("[ZF1a] alta asistida → activación → aceptación legal (M1)", () => {
  let db: PrismaClient;
  let home: EphemeralTenant;
  let superId: string;
  let gotrue: GotrueFake;
  const createdTenants = new Set<string>();
  const owners = new Set<string>();

  beforeAll(async () => {
    db = ownerClient();
    home = await createEphemeralTenant(db);
    superId = home.userId;
    await db.userProfile.update({ where: { id: superId }, data: { isPlatformAdmin: true } });
  });

  afterAll(async () => {
    for (const id of createdTenants) await deleteTenantDeep(db, id).catch(() => {});
    await home?.cleanup();
    if (db) {
      const ids = [...owners];
      if (ids.length) {
        await db.userPreferences.deleteMany({ where: { userId: { in: ids } } });
        await db.userProfile.deleteMany({ where: { id: { in: ids }, practitioners: { none: {} }, memberships: { none: {} } } });
      }
      await db.$disconnect();
    }
  });

  beforeEach(() => {
    __rateLimitInternals.reset();
    mail.sent.length = 0;
    gotrue = new GotrueFake();
    __setAuthAdminForTests(gotrue);
    __setEmailTransportForTests(mail.transport);
    asUser(superId);
  });
  afterEach(() => {
    __setAuthAdminForTests(null);
    __setEmailTransportForTests(null);
  });

  function input(o: Partial<CreateTenantWithOwnerInputType> = {}): CreateTenantWithOwnerInputType {
    const s = uniqueSuffix();
    return {
      clinicName: `Consultorio ZF1a ${s}`,
      vertical: "KINESIOLOGY",
      plan: "INDIVIDUAL",
      ownerEmail: `zf1a-${s}@test.local`,
      ownerFirstName: "Ana",
      ownerLastName: "Titular",
      idempotencyKey: randomUUID(),
      ...o,
    };
  }

  /** Alta asistida real; devuelve el titular y el `next` del link de activación del mail. */
  async function provision(o: Partial<CreateTenantWithOwnerInputType> = {}): Promise<{ ownerUserId: string; next: string }> {
    const r = await createTenantWithOwner(input(o));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error);
    createdTenants.add(r.data.tenantId);
    owners.add(r.data.ownerUserId);
    const url = /https?:\/\/\S+\/auth\/confirm\?\S+/.exec(mail.sent[0]?.text ?? "")?.[0] ?? "";
    return { ownerUserId: r.data.ownerUserId, next: new URL(url).searchParams.get("next") ?? "" };
  }

  const legalEvents = (userId: string) =>
    db.userSecurityEvent.findMany({ where: { userId, kind: "legal.accepted" }, orderBy: { createdAt: "asc" } });

  it("[ZF1a] titular creado en el alta: /reset → /aceptar-terminos exige la casilla y registra via platform_activation", async () => {
    const { ownerUserId, next } = await provision();

    // El link: primero la contraseña, después los Términos, después el panel.
    const reset = new URL(next, "http://x");
    expect(reset.pathname).toBe("/reset");
    const terms = new URL(reset.searchParams.get("next") ?? "", "http://x");
    expect([terms.pathname, terms.searchParams.get("next")]).toEqual(["/aceptar-terminos", "/dashboard"]);

    // Ya activó la clave (sesión del titular): la página muestra la casilla, no redirige.
    asUser(ownerUserId);
    const page = await AceptarTerminosPage({ searchParams: { next: "/dashboard" } });
    expect(isValidElement(page)).toBe(true);
    const { renderToStaticMarkup } = await import("react-dom/server");
    const html = renderToStaticMarkup(page);
    expect(html).toContain('name="acceptLegal"');
    expect(html).toContain('name="next" value="/dashboard"');
    expect(html).toContain("Continuar");

    // Sin la casilla: vuelve a la página con el error y NO registra nada.
    const back = await redirectOf(() => acceptLegalAndContinue(fd({ next: "/dashboard" })));
    expect(back).not.toBeNull();
    const backUrl = new URL(back!, "http://x");
    expect(backUrl.pathname).toBe("/aceptar-terminos");
    expect(backUrl.searchParams.get("next")).toBe("/dashboard");
    expect(backUrl.searchParams.get("error")).toBe("legal");
    expect(await legalEvents(ownerUserId)).toHaveLength(0);
    // Con `?error=legal` la página muestra el error asociado a la casilla.
    const withError = renderToStaticMarkup(
      await AceptarTerminosPage({ searchParams: { next: "/dashboard", error: "legal" } })
    );
    expect(withError).toContain("Para seguir, aceptá los Términos y la Política de privacidad.");

    // Con la casilla: evento con la versión vigente y la vía nueva, y al panel.
    expect(await redirectOf(() => acceptLegalAndContinue(fd({ acceptLegal: "on", next: "/dashboard" })))).toBe("/dashboard");
    const ev = await legalEvents(ownerUserId);
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toEqual({ version: LEGAL_VERSION, via: "platform_activation" });

    // Ya aceptó: la página va directo a `next`, y un segundo envío no duplica el evento.
    expect(await redirectOf(() => AceptarTerminosPage({ searchParams: { next: "/dashboard" } }))).toBe("/dashboard");
    expect(await redirectOf(() => acceptLegalAndContinue(fd({ acceptLegal: "on", next: "/dashboard" })))).toBe("/dashboard");
    expect(await legalEvents(ownerUserId)).toHaveLength(1);
  });

  it("[ZF1a] `next` ajeno (open redirect) → /dashboard, en la página y en la action", async () => {
    const { ownerUserId } = await provision();
    asUser(ownerUserId);
    for (const bad of ["//evil.com", "https://evil.com/x", "/\\evil.com"]) {
      const html = (await import("react-dom/server")).renderToStaticMarkup(
        await AceptarTerminosPage({ searchParams: { next: bad } })
      );
      expect(html).toContain('name="next" value="/dashboard"');
    }
    expect(await redirectOf(() => acceptLegalAndContinue(fd({ acceptLegal: "on", next: "//evil.com" })))).toBe("/dashboard");
    expect(await redirectOf(() => AceptarTerminosPage({ searchParams: { next: "https://evil.com" } }))).toBe("/dashboard");
  });

  it("[ZF1a] sin sesión → login (la página vuelve a /aceptar-terminos después); la action no escribe", async () => {
    asAnonymous();
    const to = await redirectOf(() => AceptarTerminosPage({ searchParams: { next: "/dashboard" } }));
    expect(to).not.toBeNull();
    const u = new URL(to!, "http://x");
    expect(u.pathname).toBe("/login");
    expect(u.searchParams.get("next")).toBe("/aceptar-terminos?next=%2Fdashboard");
    expect(await redirectOf(() => acceptLegalAndContinue(fd({ acceptLegal: "on", next: "/dashboard" })))).toBe("/login");
  });

  it("[ZF1a] cuenta que ya existía (confirmada): el link no cambia, directo al panel", async () => {
    const u = `test-user-${uniqueSuffix()}`;
    const ownerEmail = `${u}@test.local`;
    await db.userProfile.create({ data: { id: u, email: ownerEmail } });
    owners.add(u);
    const now = new Date().toISOString();
    gotrue.users.set(u, {
      id: u,
      email: ownerEmail,
      emailConfirmedAt: now,
      lastSignInAt: now,
      createdAt: now,
      bannedUntil: null,
      password: "clave-de-siempre",
      fullName: "Existente",
    });
    const { next } = await provision({ ownerEmail });
    expect(next).toBe("/dashboard");
  });
});
