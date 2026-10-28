/**
 * LG-G (§27, decisión de Martin del 27-oct) · gate de aceptación legal del workspace `(app)`, con los símbolos reales.
 *
 * El hueco: ZF1a encadenó `/aceptar-terminos` solo en el link de activación del alta asistida. El reenvío del link de
 * acceso (`lib/platform-users.ts`), «olvidé mi contraseña» (`lib/auth.ts`) y entrar a `/dashboard` a mano después de
 * `/reset` llegaban al panel sin aceptación registrada. Martin: «Cuentas que ya existían: si, da igual. Tenemos que
 * resetar.» → el layout de `(app)` manda a `/aceptar-terminos?next=<path>&via=app_gate` a todo el que no aceptó la
 * versión vigente, y la página registra `legal.accepted {version, via: "app_gate"}`.
 *
 * Se corre el layout REAL (`app/(app)/layout.tsx`), la página y la action contra Postgres (los dos roles); se
 * reemplazan solo la sesión (integration-setup + `asUser`) y `next/headers` (sin `x-pathname` → `next=/dashboard`).
 * `UserSecurityEvent` es solo inserción (trigger de M8): `deleteTenantDeep` los borra en modo réplica.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { isValidElement } from "react";
import type { PrismaClient } from "@prisma/client";
import AppLayout from "@/app/(app)/layout";
import AceptarTerminosPage from "@/app/aceptar-terminos/page";
import { acceptLegalAndContinue } from "@/lib/legal-accept-action";
import { hasAcceptedCurrentLegal } from "@/lib/legal-acceptance-internal";
import { LEGAL_VERSION } from "@/lib/legal";
import { asUser } from "@/tests/helpers/actor";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  addStaff,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

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

const layout = () => AppLayout({ children: null });
const GATE = "/aceptar-terminos?next=%2Fdashboard&via=app_gate";

describe.skipIf(!RUN)("[LG-G] gate de aceptación legal en (app)", () => {
  let db: PrismaClient;
  let accepted: EphemeralTenant;
  let pending: EphemeralTenant;

  beforeAll(async () => {
    db = ownerClient();
    accepted = await createEphemeralTenant(db);
    pending = await createEphemeralTenant(db, { acceptLegal: false });
  });
  afterAll(async () => {
    await accepted?.cleanup();
    await pending?.cleanup();
    await db?.$disconnect();
  });

  const legalEvents = (userId: string) =>
    db.userSecurityEvent.findMany({ where: { userId, kind: "legal.accepted" }, orderBy: { createdAt: "asc" } });

  it("[LG-G] factory: los usuarios de staff nacen con la versión vigente aceptada; `acceptLegal: false` los deja sin", async () => {
    const pr = await addPractitioner(db, accepted);
    const st = await addStaff(db, accepted, "ASSISTANT");
    for (const u of [accepted.userId, pr.userId, st.userId]) expect(await hasAcceptedCurrentLegal(u), u).toBe(true);
    expect(await hasAcceptedCurrentLegal(pending.userId)).toBe(false);
    const prNo = await addPractitioner(db, pending, "PRACTITIONER", { acceptLegal: false });
    const stNo = await addStaff(db, pending, "ASSISTANT", {}, { acceptLegal: false });
    for (const u of [prNo.userId, stNo.userId]) expect(await hasAcceptedCurrentLegal(u), u).toBe(false);
  });

  it("[LG-G] sin aceptación → el layout redirige a /aceptar-terminos con next y via=app_gate", async () => {
    asUser(pending.userId);
    expect(await redirectOf(layout)).toBe(GATE);
  });

  it("[LG-G] con la versión vigente aceptada → el layout sigue (arma el shell)", async () => {
    asUser(accepted.userId);
    const out = await layout();
    expect(isValidElement(out)).toBe(true);
  });

  it("[LG-G] una aceptación de una versión vieja no cuenta: el layout la vuelve a pedir", async () => {
    const t = await createEphemeralTenant(db, { acceptLegal: false });
    try {
      await db.userSecurityEvent.create({
        data: { userId: t.userId, kind: "legal.accepted", payload: { version: "2020-01-01", via: "signup" } },
      });
      asUser(t.userId);
      expect(await redirectOf(layout)).toBe(GATE);
    } finally {
      await t.cleanup();
    }
  });

  it("[LG-G] /aceptar-terminos con via=app_gate → la action registra {version, via:\"app_gate\"} y el layout ya deja pasar", async () => {
    const t = await createEphemeralTenant(db, { acceptLegal: false });
    try {
      asUser(t.userId);
      const { renderToStaticMarkup } = await import("react-dom/server");
      const html = renderToStaticMarkup(await AceptarTerminosPage({ searchParams: { next: "/agenda", via: "app_gate" } }));
      expect(html).toContain('name="via" value="app_gate"');
      expect(html).toContain('name="next" value="/agenda"');

      // Sin la casilla: vuelve con el error y la MISMA vía; no registra.
      const back = await redirectOf(() => acceptLegalAndContinue(fd({ next: "/agenda", via: "app_gate" })));
      const u = new URL(back!, "http://x");
      expect([u.pathname, u.searchParams.get("next"), u.searchParams.get("via"), u.searchParams.get("error")]).toEqual([
        "/aceptar-terminos",
        "/agenda",
        "app_gate",
        "legal",
      ]);
      expect(await legalEvents(t.userId)).toHaveLength(0);

      expect(await redirectOf(() => acceptLegalAndContinue(fd({ acceptLegal: "on", next: "/agenda", via: "app_gate" })))).toBe(
        "/agenda"
      );
      const ev = await legalEvents(t.userId);
      expect(ev).toHaveLength(1);
      expect(ev[0].payload).toEqual({ version: LEGAL_VERSION, via: "app_gate" });
      expect(ev[0].tenantId).toBeNull();
      expect(await hasAcceptedCurrentLegal(t.userId)).toBe(true);

      expect(isValidElement(await layout())).toBe(true);
    } finally {
      await t.cleanup();
    }
  });

  it("[LG-G] sin `via` la página sigue registrando platform_activation (los links de activación ya mandados)", async () => {
    const t = await createEphemeralTenant(db, { acceptLegal: false });
    try {
      asUser(t.userId);
      const { renderToStaticMarkup } = await import("react-dom/server");
      const html = renderToStaticMarkup(await AceptarTerminosPage({ searchParams: { next: "/dashboard", via: "signup" } }));
      expect(html).toContain('name="via" value="platform_activation"');
      expect(await redirectOf(() => acceptLegalAndContinue(fd({ acceptLegal: "on", next: "/dashboard" })))).toBe("/dashboard");
      expect((await legalEvents(t.userId)).map((e) => (e.payload as { via: string }).via)).toEqual(["platform_activation"]);
    } finally {
      await t.cleanup();
    }
  });

  it("[LG-G] zod con enum cerrado: una vía forjada no registra nada", async () => {
    const t = await createEphemeralTenant(db, { acceptLegal: false });
    try {
      asUser(t.userId);
      for (const via of ["signup", "onboarding", "APP_GATE", "x"]) {
        await expect(acceptLegalAndContinue(fd({ acceptLegal: "on", next: "/dashboard", via }))).rejects.toThrow();
      }
      expect(await legalEvents(t.userId)).toHaveLength(0);
    } finally {
      await t.cleanup();
    }
  });
});
