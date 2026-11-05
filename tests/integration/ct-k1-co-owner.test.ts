/**
 * CT-K1 (CF3b, contrato de Martin del 05-nov) — «Co-titular» (`Membership.grantCoOwner`, M23) visto desde la
 * autorización: capacidades del Actor real, export completo, «Planes y pagos» de la suscripción y titularidad.
 *
 *   [CT-K1-8]  la foto (`loadAccessMemberships`) y el Actor traen `grantCoOwner`: co-titular = lo del Titular que
 *              atiende + `account.manage` + `account.export`, sin `account.billing` (aunque la fila tenga
 *              `grantBilling`) ni `account.owner`.
 *   [CT-K1-9]  `GET /api/consultorio/export`: el co-titular baja SU consultorio (200, nada de otro); un profesional
 *              común, el co-titular de A pidiendo B y el co-titular suspendido → 403 sin datos.
 *   [CT-K1-10] `billingRecipients` (los mails de cobro de la suscripción): Titular y quien tenga `account.billing`;
 *              nunca el co-titular ni la Secretaria aunque su fila diga `grantBilling` (antes los recibían).
 *   [CT-K1-11] el co-titular no abre Facturación, no cambia el plan ni transfiere la titularidad.
 *
 * Corre en los dos roles: `npm run test:integration -- ct-k1` (kinesoft_app, RLS) y `:owner -- ct-k1` (BYPASSRLS =
 * prod). Símbolos REALES (ruta, actions, `getActor`); se mockea solo el step-up de 2FA (frontera externa: TOTP), así
 * cada rechazo de [CT-K1-11] es de la capacidad y no del segundo factor (anti-falso-verde).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { cookies } from "next/headers";
import type { PrismaClient } from "@prisma/client";
import { GET as exportTenant } from "@/app/api/consultorio/export/route";
import { getActor, ForbiddenError } from "@/lib/session";
import { capabilitiesForActor, memberCapabilitiesForActor } from "@/lib/authz";
import { billingRecipients } from "@/lib/saas-billing-internal";
import { getBillingOverview, applyPlanChange } from "@/lib/saas-billing";
import { transferOwnership } from "@/lib/invitations";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { SUPPORT_COOKIE } from "@/lib/support-session-internal";
import { asUser } from "@/tests/helpers/actor";
import { ownerClient, createEphemeralTenant, addPatient, addPractitioner, addStaff, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

vi.mock("@/lib/two-factor-step-up", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/two-factor-step-up")>()),
  requireStepUp: async () => {},
}));

const RUN = process.env.INTEGRATION === "1";
const URL_ = "http://localhost/api/consultorio/export";

/** Rechazo por capacidad: `ForbiddenError` tirado o `{ ok: false }`. Cualquier otro error se propaga. */
async function settle(p: Promise<{ ok: boolean }>): Promise<{ ok: boolean }> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false };
    throw e;
  }
}

describe.skipIf(!RUN)("[CT-K1] co-titular: capacidades, export, Planes y pagos y titularidad", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  /** Co-titular de A con un `grantBilling` VIEJO (era Profesional con «Planes y pagos» antes de ser co-titular). */
  let co: { userId: string; practitionerId: string };
  /** Profesional común de A con «Planes y pagos» delegado (sí recibe los mails de cobro). */
  let proBilling: { userId: string; practitionerId: string };
  /** Profesional común de A, sin nada. */
  let pro: { userId: string; practitionerId: string };
  let adminBilling: { userId: string };
  /** Secretaria con `grantBilling` en la fila (dato viejo: el corte de staff le saca la capacidad). */
  let secretaryBilling: { userId: string };
  let patientB = "";

  const membership = (userId: string, tenantId: string) =>
    db.membership.findUniqueOrThrow({ where: { userId_tenantId: { userId, tenantId } } });

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db, { saasPlan: "CONSULTORIO" });
    B = await createEphemeralTenant(db);
    co = await addPractitioner(db, A, "PRACTITIONER");
    await db.membership.update({
      where: { userId_tenantId: { userId: co.userId, tenantId: A.tenantId } },
      data: { grantCoOwner: true, grantBilling: true },
    });
    proBilling = await addPractitioner(db, A, "PRACTITIONER");
    await db.membership.update({ where: { userId_tenantId: { userId: proBilling.userId, tenantId: A.tenantId } }, data: { grantBilling: true } });
    pro = await addPractitioner(db, A, "PRACTITIONER");
    adminBilling = await addStaff(db, A, "ADMIN", { grantSettings: true, grantBilling: true });
    secretaryBilling = await addStaff(db, A, "ASSISTANT", { grantBilling: true });
    await addPatient(db, A);
    patientB = await addPatient(db, B);
  }, 60_000);

  afterAll(async () => {
    if (db) {
      for (const t of [A, B]) await t?.cleanup();
      await db.$disconnect();
    }
  });

  beforeEach(() => {
    cookies().delete(SUPPORT_COOKIE);
    cookies().delete("kine_tenant");
    __rateLimitInternals.reset();
  });

  it("[CT-K1-8] el Actor del co-titular trae grantCoOwner y sus capacidades son las del Titular menos la suscripción y la titularidad", async () => {
    asUser(co.userId);
    const actor = await getActor();
    expect(actor.tenantId).toBe(A.tenantId);
    expect(actor.membership).toMatchObject({ role: "PRACTITIONER", grantCoOwner: true, grantBilling: true });
    // Atiende (es profesional): sigue teniendo su agenda.
    expect(actor.practitionerId).toBe(co.practitionerId);
    for (const caps of [await capabilitiesForActor(actor), await memberCapabilitiesForActor(actor)]) {
      for (const c of ["account.manage", "account.export", "tenant.sensitive", "tenant.admin", "billing.manage", "billing.collect", "agenda.operateAll", "clinical.read"] as const) {
        expect(caps.has(c), c).toBe(true);
      }
      expect(caps.has("account.billing"), "nunca account.billing (contrato (d))").toBe(false);
      expect(caps.has("account.owner"), "nunca account.owner (contrato (a)-(c))").toBe(false);
    }
    // Un profesional común no gana nada de eso.
    asUser(pro.userId);
    const proCaps = await capabilitiesForActor(await getActor());
    expect(proCaps.has("account.manage")).toBe(false);
    expect(proCaps.has("account.export")).toBe(false);
  });

  it("[CT-K1-9] GET /api/consultorio/export como co-titular → 200 con los datos de A, nada de B, y el audit a su nombre", async () => {
    asUser(co.userId);
    const res = await exportTenant(new Request(URL_));
    expect(res.status).toBe(200);
    const text = await res.text();
    const json = JSON.parse(text) as { manifest: { tenant: { id: string } } };
    expect(json.manifest.tenant.id).toBe(A.tenantId);
    expect(text).not.toContain(B.tenantId);
    expect(text).not.toContain(patientB);
    expect(await db.auditEvent.count({ where: { tenantId: A.tenantId, action: "tenant.export.started", actorId: co.userId } })).toBe(1);
  });

  it("[CT-K1-9] profesional común → 403; co-titular de A pidiendo ?tenant=B → 403 (sin datos en ninguno)", async () => {
    asUser(pro.userId);
    const r1 = await exportTenant(new Request(URL_));
    expect(r1.status).toBe(403);
    expect(await r1.text()).toBe("Solo el titular o un co-titular del consultorio puede descargar el export completo.");
    asUser(co.userId);
    const r2 = await exportTenant(new Request(`${URL_}?tenant=${B.tenantId}`));
    expect(r2.status).toBe(403);
    expect(await r2.text()).not.toContain(patientB);
  });

  it("[CT-K1-9] co-titular suspendido en el consultorio → 403 (una membresía deshabilitada nunca exporta)", async () => {
    await db.membership.update({ where: { userId_tenantId: { userId: co.userId, tenantId: A.tenantId } }, data: { disabledAt: new Date() } });
    try {
      asUser(co.userId);
      const res = await exportTenant(new Request(URL_));
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain(A.tenantId);
    } finally {
      await db.membership.update({ where: { userId_tenantId: { userId: co.userId, tenantId: A.tenantId } }, data: { disabledAt: null } });
    }
  });

  it("[CT-K1-10] billingRecipients: Titular, Admin y Profesional con «Planes y pagos»; nunca el co-titular ni la Secretaria aunque su fila tenga grantBilling", async () => {
    const got = (await billingRecipients(A.tenantId)).map((r) => r.userId).sort();
    expect(got).toEqual([A.userId, adminBilling.userId, proBilling.userId].sort());
    expect(got).not.toContain(co.userId);
    expect(got).not.toContain(secretaryBilling.userId);
    expect(got).not.toContain(pro.userId);
    // Nada de otro consultorio.
    expect(got).not.toContain(B.userId);
  });

  it("[CT-K1-11] el co-titular no abre Facturación ni cambia el plan (requireAccountBilling), aunque su fila tenga grantBilling", async () => {
    asUser(co.userId);
    await expect(getBillingOverview()).rejects.toBeInstanceOf(ForbiddenError);
    const before = await db.tenant.findUniqueOrThrow({ where: { id: A.tenantId } });
    const r = await settle(
      applyPlanChange({ to: "CLINICA", disableMembershipIds: [], reactivateMembershipIds: [], expectedUpdatedAt: before.updatedAt.toISOString() })
    );
    expect(r.ok).toBe(false);
    const after = await db.tenant.findUniqueOrThrow({ where: { id: A.tenantId } });
    expect(after.saasPlan).toBe(before.saasPlan);
    expect(+after.updatedAt).toBe(+before.updatedAt);
  });

  it("[CT-K1-11] el co-titular no transfiere la titularidad (account.owner es solo del principal)", async () => {
    asUser(co.userId);
    const target = await membership(pro.userId, A.tenantId);
    const self = await membership(co.userId, A.tenantId);
    for (const id of [target.id, self.id]) {
      const r = await settle(transferOwnership(id));
      expect(r.ok, id).toBe(false);
    }
    expect((await membership(A.userId, A.tenantId)).role).toBe("OWNER");
    expect((await membership(pro.userId, A.tenantId)).role).toBe("PRACTITIONER");
    expect(await membership(co.userId, A.tenantId)).toMatchObject({ role: "PRACTITIONER", grantCoOwner: true });
    expect(await db.membership.count({ where: { tenantId: A.tenantId, role: "OWNER" } })).toBe(1);
  });
});
