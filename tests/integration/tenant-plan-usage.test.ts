/**
 * [BO3-F] Configuración → «Plan y uso»: `getTenantPlanUsage` (lib/tenant-plan-usage.ts) contra Postgres en los dos
 * roles (kinesoft_app con RLS y owner BYPASSRLS, que reproduce prod: ahí el `where: { tenantId }` a mano es la única
 * barrera).
 *
 * Contrato (BO-D7, lib/plan-catalog.ts): ocupan lugar los miembros clínicos ACTIVOS + las invitaciones clínicas
 * pendientes y vigentes; Secretaria y Facturación no ocupan; un suspendido no ocupa. La pantalla tiene que decir el
 * MISMO número que frena la invitación (`getSeatUsageInTx`). Se mockea solo la sesión.
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
    T = await createEphemeralTenant(db, { plan: "STARTER", publicBookingEnabled: true });
    U = await createEphemeralTenant(db, { plan: "STARTER" });

    practitionerUserId = (await addPractitioner(db, T, "PRACTITIONER")).userId;
    assistantUserId = (await addPractitioner(db, T, "ASSISTANT")).userId;
    await addPractitioner(db, T, "BILLING");
    const suspended = await addPractitioner(db, T, "PRACTITIONER");
    await db.membership.update({
      where: { userId_tenantId: { userId: suspended.userId, tenantId: T.tenantId } },
      data: { disabledAt: new Date() },
    });
    await invite(T, "PRACTITIONER"); // reserva lugar
    await invite(T, "ASSISTANT"); // no ocupa
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

  it("OWNER: cupos «3 de 3» (OWNER + profesional + 1 invitación clínica), Secretaria y Facturación no ocupan", async () => {
    asUser(T.userId);
    const v = await getTenantPlanUsage();
    expect(v.planLabel).toBe("Base");
    expect(v.seats).toMatchObject({ value: "3 de 3", used: 3, limit: 3, full: true, custom: false });
    expect(v.seats.detail).toContain("Incluye 1 invitación pendiente");
    expect(v.nonSeatMembers).toBe(2);
    expect(v.publicBookingEnabled).toBe(true);
    expect(v.subscription).toEqual({ label: "Activa", tone: "ok", detail: null, contact: null });
  });

  it("cupo a medida (seatLimitOverride) gana sobre el del plan", async () => {
    await db.tenant.update({ where: { id: T.tenantId }, data: { seatLimitOverride: 5 } });
    try {
      asUser(T.userId);
      const v = await getTenantPlanUsage();
      expect(v.seats).toMatchObject({ value: "3 de 5", full: false, custom: true });
    } finally {
      await db.tenant.update({ where: { id: T.tenantId }, data: { seatLimitOverride: null } });
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
    expect(v.seats).toMatchObject({ value: "4 de 3", used: 4 });
    expect(v.nonSeatMembers).toBe(0);
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
});
