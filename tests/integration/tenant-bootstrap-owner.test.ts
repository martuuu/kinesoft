/**
 * [PL-1c] `bootstrapTenant({ ownerClinical })` (C-PL5, decisiones 7 y 8 de Martin): el Titular puede ser
 * «Administrador/a sin agenda». Sin `Practitioner` ni franjas; la sede «Principal» sí (es del consultorio); los
 * servicios iniciales nacen sin profesional habilitado; la membresía OWNER queda `clinical = false` y ocupa el lugar
 * no clínico del plan (`getSeatUsageInTx`).
 *
 * Símbolo REAL contra Postgres (canal owner, como el alta: el Tenant todavía no existe y no hay GUC posible).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { bootstrapTenant } from "@/lib/tenant-bootstrap";
import { starterServicesFor } from "@/lib/tenant-starter-services";
import { getSeatUsageInTx } from "@/lib/team-internal";
import { ownerClient, deleteTenantDeep, uniqueSuffix } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("[PL-1c] bootstrap con Titular que no atiende", () => {
  let db: PrismaClient;
  const created: string[] = [];
  const users: string[] = [];

  beforeAll(() => {
    db = ownerClient();
  });
  afterAll(async () => {
    for (const id of created) await deleteTenantDeep(db, id);
    if (db) {
      if (users.length) {
        await db.userPreferences.deleteMany({ where: { userId: { in: users } } });
        await db.userProfile.deleteMany({ where: { id: { in: users }, practitioners: { none: {} } } });
      }
      await db.$disconnect();
    }
  });

  async function boot(ownerClinical?: boolean) {
    const s = uniqueSuffix();
    const userId = `test-user-boot-${s}`;
    users.push(userId);
    const r = await db.$transaction((tx) =>
      bootstrapTenant(tx, {
        userId,
        email: `${userId}@test.local`,
        fullName: "Titular Boot",
        clinicName: `Boot ${s}`,
        slug: `test-boot-${s}`,
        onboardingCompleted: true,
        source: "tenant-bootstrap-owner.test",
        starterServices: starterServicesFor("KINESIOLOGY"),
        ...(ownerClinical === undefined ? {} : { ownerClinical }),
      })
    );
    created.push(r.tenantId);
    return { r, userId };
  }

  it("ownerClinical: false → sin Practitioner ni franjas, sede sí, servicios sin profesional, OWNER no clínico", async () => {
    const { r, userId } = await boot(false);
    expect(r.practitionerId).toBeNull();
    expect(r.serviceIds.length).toBeGreaterThan(0);
    expect(await db.practitioner.count({ where: { tenantId: r.tenantId } })).toBe(0);
    expect(await db.practitionerSchedule.count({ where: { tenantId: r.tenantId } })).toBe(0);
    expect(await db.practitionerService.count({ where: { tenantId: r.tenantId } })).toBe(0);
    expect(await db.location.count({ where: { tenantId: r.tenantId, isPrimary: true } })).toBe(1);
    expect(r.locationId).toBeTruthy();
    expect(await db.membership.findFirstOrThrow({ where: { tenantId: r.tenantId, userId } })).toMatchObject({
      role: "OWNER",
      clinical: false,
    });
    const u = await db.$transaction((tx) => getSeatUsageInTx(tx, r.tenantId, { now: new Date() }));
    expect(u!.professional.used).toBe(0);
    expect(u!.staff.used).toBe(1);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { tenantId: r.tenantId, action: "tenant.create" } });
    expect(audit.payload).toMatchObject({ practitionerId: null, ownerClinical: false });
  });

  it("default (sin ownerClinical) = el Titular atiende, como siempre", async () => {
    const { r, userId } = await boot();
    expect(r.practitionerId).toEqual(expect.any(String));
    expect(await db.membership.findFirstOrThrow({ where: { tenantId: r.tenantId, userId } })).toMatchObject({ clinical: true });
    expect(await db.practitionerService.count({ where: { tenantId: r.tenantId, practitionerId: r.practitionerId! } })).toBe(
      r.serviceIds.length
    );
  });

  it("[PL-Z] A1: el Titular que atiende nace con SU turnero prendido; el del consultorio, apagado", async () => {
    const { r } = await boot();
    expect(await db.practitioner.findUniqueOrThrow({ where: { id: r.practitionerId! } })).toMatchObject({
      publicBookingEnabled: true,
    });
    expect(await db.tenant.findUniqueOrThrow({ where: { id: r.tenantId } })).toMatchObject({ publicBookingEnabled: false });
  });
});
