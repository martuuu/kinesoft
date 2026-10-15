/**
 * [BO3-F] Configuración → «Plan y uso»: `getTenantPlanUsage` (lib/tenant-plan-usage.ts) contra Postgres en los dos
 * roles (kinesoft_app con RLS y owner BYPASSRLS, que reproduce prod: ahí el `where: { tenantId }` a mano es la única
 * barrera).
 *
 * Contrato (PL-1c, C-PL3, lib/plan-catalog.ts; antes BO-D7): ocupan lugar TODOS los miembros ACTIVOS (profesionales
 * y no clínicos, cada uno en su tipo) + las invitaciones pendientes y vigentes; un suspendido no ocupa. La pantalla
 * tiene que decir el MISMO número que frena la invitación (`getSeatUsageInTx`). Se mockea solo la sesión.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import type { PrismaClient, Role } from "@prisma/client";
import { getTenantPlanUsage } from "@/lib/tenant-plan-usage";
import { updateTenantBasics, getTenantSettings } from "@/lib/tenant-settings";
import { TENANT_BASICS_STALE_ERROR } from "@/components/configuracion/config-copy";
import { asUser } from "@/tests/helpers/actor";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const DAY = 86_400_000;

describe.skipIf(!RUN)("[BO3-F] getTenantPlanUsage", () => {
  let db: PrismaClient;
  /** Base (3 lugares): OWNER + PRACTITIONER + Secretaria + Facturación + suspendido + invitaciones. */
  let T: EphemeralTenant;
  /** Otro consultorio con miembros clínicos: no se tiene que colar en la cuenta de T. */
  let U: EphemeralTenant;
  let practitionerUserId: string;
  let assistantUserId: string;

  async function invite(t: EphemeralTenant, role: Role, opts: { expired?: boolean; revoked?: boolean } = {}) {
    await db.invitation.create({
      data: {
        tenantId: t.tenantId,
        email: `inv-${randomBytes(4).toString("hex")}@test.local`,
        firstName: "Inv",
        lastName: "Itado",
        role,
        token: randomBytes(16).toString("hex"),
        invitedById: t.userId,
        expiresAt: new Date(Date.now() + (opts.expired ? -DAY : 7 * DAY)),
        revokedAt: opts.revoked ? new Date() : null,
      },
    });
  }

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db, { saasPlan: "CONSULTORIO", plan: "STARTER", publicBookingEnabled: true });
    U = await createEphemeralTenant(db, { saasPlan: "CONSULTORIO", plan: "STARTER" });

    practitionerUserId = (await addPractitioner(db, T, "PRACTITIONER")).userId;
    assistantUserId = (await addPractitioner(db, T, "ASSISTANT")).userId;
    await addPractitioner(db, T, "BILLING");
    const suspended = await addPractitioner(db, T, "PRACTITIONER");
    await db.membership.update({
      where: { userId_tenantId: { userId: suspended.userId, tenantId: T.tenantId } },
      data: { disabledAt: new Date() },
    });
    await invite(T, "PRACTITIONER"); // reserva lugar
    await invite(T, "ASSISTANT"); // reserva lugar no clínico (PL-1c)
    await invite(T, "PRACTITIONER", { expired: true }); // vencida: no reserva
    await invite(T, "PRACTITIONER", { revoked: true }); // revocada: no reserva

    await addPractitioner(db, U, "PRACTITIONER");
    await addPractitioner(db, U, "ADMIN");
    await invite(U, "PRACTITIONER");
  }, 60_000);

  afterAll(async () => {
    if (db) {
      for (const t of [T, U]) await t?.cleanup();
      await db.$disconnect();
    }
  });

  it("[PL-1c] OWNER: cupos por tipo (miembros activos + invitaciones vigentes de cada tipo)", async () => {
    asUser(T.userId);
    const v = await getTenantPlanUsage();
    expect(v.plan).toBe("CONSULTORIO");
    expect(v.planLabel).toBe("Consultorio");
    // Titular + kine + invitación de kine = 3 profesionales; Secretaria + Facturación + invitación de Secretaria = 3.
    expect(v.seats).toMatchObject({
      // M8b (§20.17): Consultorio = 5 usuarios de cualquier tipo, sin tope por tipo; solo el total frena.
      value: "Profesionales 3 (sin límite) · Secretaría/administración 3 (sin límite) · Total 6 de 5",
      used: 6,
      limit: 5,
      full: true,
      custom: false,
    });
    expect(v.seats.detail).toContain("Incluye 2 invitaciones pendientes");
    expect(v.seats.detail).toContain("las que están siguen");
    expect(v.nonSeatMembers).toBe(2);
    expect(v.publicBookingEnabled).toBe(true);
    expect(v.subscription).toEqual({ label: "Activa", tone: "ok", detail: null, contact: null });
  });

  it("[PL-1c → PL-Z a3#1] los overrides ganan sobre el plan solo en Libre; en otro plan quedan inertes", async () => {
    await db.tenant.update({ where: { id: T.tenantId }, data: { maxUsersOverride: 8, maxStaffOverride: 3 } });
    try {
      asUser(T.userId);
      // Consultorio con overrides (legado de M8): rige el plan (5 en total, sin tope por tipo).
      expect((await getTenantPlanUsage()).seats.value).toBe(
        "Profesionales 3 (sin límite) · Secretaría/administración 3 (sin límite) · Total 6 de 5"
      );
      await db.tenant.update({ where: { id: T.tenantId }, data: { saasPlan: "LIBRE", plan: "ENTERPRISE" } });
      const v = await getTenantPlanUsage();
      expect(v.seats).toMatchObject({
        value: "Profesionales 3 (sin límite) · Secretaría/administración 3 de 3 · Total 6 de 8",
        custom: true,
      });
    } finally {
      await db.tenant.update({
        where: { id: T.tenantId },
        data: { maxUsersOverride: null, maxStaffOverride: null, saasPlan: "CONSULTORIO", plan: "STARTER" },
      });
    }
  });

  it("prueba: días AR que quedan", async () => {
    const now = new Date("2026-10-14T13:00:00Z"); // 10:00 AR
    await db.tenant.update({
      where: { id: T.tenantId },
      data: { subscriptionStatus: "TRIALING", trialEndsAt: new Date("2026-10-20T15:00:00Z") },
    });
    try {
      asUser(T.userId);
      const v = await getTenantPlanUsage(now);
      expect(v.subscription.label).toBe("En prueba");
      expect(v.subscription.detail).toBe("Te quedan 7 días de prueba (hasta el 20 de octubre).");
    } finally {
      await db.tenant.update({ where: { id: T.tenantId }, data: { subscriptionStatus: "ACTIVE", trialEndsAt: null } });
    }
  });

  it("otro consultorio cuenta lo suyo (aislamiento)", async () => {
    asUser(U.userId);
    const v = await getTenantPlanUsage();
    // Titular + kine + invitación de kine = 3 profesionales; el Administrador/a no atiende (§20.17, PL-Z M1) = 1 no clínico.
    expect(v.seats).toMatchObject({ value: "Profesionales 3 (sin límite) · Secretaría/administración 1 (sin límite) · Total 4 de 5", used: 4 });
    expect(v.nonSeatMembers).toBe(1);
  });

  it("[BO2-D → BO3-F] General manda expectedUpdatedAt: un cambio en el medio vuelve con el copy que la UI reconoce", async () => {
    asUser(T.userId);
    const before = await getTenantSettings();
    // Otro (p. ej. el superadmin desde Plataforma) guarda en el medio.
    await db.tenant.update({ where: { id: T.tenantId }, data: { legalName: "Otro SRL" } });
    const stale = await updateTenantBasics({ name: "Pisado", expectedUpdatedAt: before.updatedAt });
    expect(stale).toEqual({ ok: false, error: TENANT_BASICS_STALE_ERROR });
    expect((await db.tenant.findUniqueOrThrow({ where: { id: T.tenantId } })).name).not.toBe("Pisado");
    // Con el updatedAt fresco, guarda.
    const fresh = await getTenantSettings();
    expect(await updateTenantBasics({ name: "Nombre nuevo", expectedUpdatedAt: fresh.updatedAt })).toEqual({ ok: true, data: undefined });
    expect((await db.tenant.findUniqueOrThrow({ where: { id: T.tenantId } })).name).toBe("Nombre nuevo");
  });

  it("PRACTITIONER y Secretaria no la ven (tenant.admin)", async () => {
    for (const u of [practitionerUserId, assistantUserId]) {
      asUser(u);
      await expect(getTenantPlanUsage()).rejects.toThrow("Solo OWNER/ADMIN ven el plan del consultorio.");
    }
  });

  it("[PL-3] la Secretaria con «Planes y pagos» (grantBilling → account.billing) sí ve el plan y los cupos", async () => {
    await db.membership.update({
      where: { userId_tenantId: { userId: assistantUserId, tenantId: T.tenantId } },
      data: { grantBilling: true },
    });
    try {
      asUser(assistantUserId);
      const view = await getTenantPlanUsage();
      expect(view.seats).toBeTruthy();
    } finally {
      await db.membership.update({
        where: { userId_tenantId: { userId: assistantUserId, tenantId: T.tenantId } },
        data: { grantBilling: false },
      });
    }
  });
});
