/**
 * BO2-C · salud de la plataforma (`lib/platform-health-read.ts`, plan §19.5; §19.1 «cuentas muertas»). Símbolo
 * REAL contra Postgres en los dos roles; se reemplazan la sesión (integration-setup) y el puerto de Auth (fake).
 *
 * Cada detector tiene su caso armado acá y se busca POR ID en la lista corta. La base es compartida (otras
 * sesiones, el seed del Docker), así que los conteos se afirman como «al menos» y las fechas del fixture se
 * corren a los extremos (2000 / 2100) para quedar primeros en el orden de cada lista corta.
 *
 * Auth: el puerto lista usuarios (`listUsers`, el fake estándar también) → los detectores de huérfanos de Auth y de
 * emails distintos corren; si Auth falla, vuelven `available: false` (no inventan un «todo bien»).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { getPlatformHealth } from "@/lib/platform-health-read";
import { healthCountsCore } from "@/lib/cron-jobs-internal";
import { ForbiddenError } from "@/lib/session";
import { __setAuthAdminForTests } from "@/lib/identity/auth-admin";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { GotrueFake } from "@/tests/helpers/gotrue-fake";
import { ownerClient, createEphemeralTenant, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";
const PHI_MARK = "Zqxphihealth";
const OLD = new Date("2000-01-01T00:00:00Z");
const FUTURE = new Date("2100-01-01T00:00:00Z");

describe.skipIf(!RUN)("[BO2-C] salud de la plataforma", () => {
  let db: PrismaClient;
  const tenants: EphemeralTenant[] = [];
  const users: string[] = [];
  let S: string;
  let H: EphemeralTenant; // consultorio con miembro sin profesional, profesional sin membresía e invitación vencida
  let noOwner: EphemeralTenant;
  let stalled: EphemeralTenant;
  let kineSinProf: string;
  let pracSinMembresia: string;
  let invitationId: string;
  let perfilHuerfano: string;
  /** PL-1d: Titular que NO atiende (clinical=false, sin Practitioner a propósito): no es un caso de salud. */
  let titularNoClinico: EphemeralTenant;
  /** PL-1d: Admin que atiende sin profesional (sí es un caso) y Admin que no atiende (no lo es). */
  let adminClinico: string;
  let adminNoClinico: string;

  async function profile(o: { admin?: boolean; createdAt?: Date } = {}): Promise<string> {
    const id = `test-user-${uniqueSuffix()}`;
    await db.userProfile.create({
      data: { id, email: `${id}@test.local`, fullName: `Salud ${id}`, isPlatformAdmin: o.admin ?? false, createdAt: o.createdAt },
    });
    users.push(id);
    return id;
  }

  beforeAll(async () => {
    db = ownerClient();
    S = await profile({ admin: true });

    H = await createEphemeralTenant(db);
    tenants.push(H);
    await db.patient.create({
      data: { tenantId: H.tenantId, firstName: PHI_MARK, lastName: PHI_MARK, documentId: `DNI-${uniqueSuffix()}`, notes: PHI_MARK },
    });

    kineSinProf = await profile();
    await db.membership.create({ data: { userId: kineSinProf, tenantId: H.tenantId, role: "PRACTITIONER", acceptedAt: FUTURE } });
    // La Secretaria sin profesional es NORMAL desde IAM-4a: no tiene que aparecer.
    const secre = await profile();
    await db.membership.create({ data: { userId: secre, tenantId: H.tenantId, role: "ASSISTANT", acceptedAt: FUTURE } });

    const sinMembresia = await profile();
    pracSinMembresia = (await db.practitioner.create({ data: { tenantId: H.tenantId, userId: sinMembresia, createdAt: FUTURE } })).id;

    invitationId = (
      await db.invitation.create({
        data: {
          tenantId: H.tenantId,
          email: `inv-${uniqueSuffix()}@test.local`,
          firstName: "Inv",
          lastName: "Vencida",
          token: `tok-${uniqueSuffix()}`,
          invitedById: H.userId,
          expiresAt: OLD,
        },
      })
    ).id;

    noOwner = await createEphemeralTenant(db, { role: "ADMIN" });
    tenants.push(noOwner);
    await db.tenant.update({ where: { id: noOwner.tenantId }, data: { createdAt: FUTURE } });

    stalled = await createEphemeralTenant(db);
    tenants.push(stalled);
    await db.tenant.update({ where: { id: stalled.tenantId }, data: { onboardingCompletedAt: null, createdAt: OLD } });

    perfilHuerfano = await profile({ createdAt: FUTURE });

    // PL-1d (C-PL5): «miembro clínico» = isClinicalMember. Fixture directa con el owner (no es el código bajo test).
    titularNoClinico = await createEphemeralTenant(db);
    tenants.push(titularNoClinico);
    await db.membership.update({
      where: { userId_tenantId: { userId: titularNoClinico.userId, tenantId: titularNoClinico.tenantId } },
      data: { clinical: false },
    });
    await db.practitioner.deleteMany({ where: { tenantId: titularNoClinico.tenantId, userId: titularNoClinico.userId } });
    adminClinico = await profile();
    await db.membership.create({ data: { userId: adminClinico, tenantId: H.tenantId, role: "ADMIN", clinical: true, acceptedAt: FUTURE } });
    adminNoClinico = await profile();
    await db.membership.create({ data: { userId: adminNoClinico, tenantId: H.tenantId, role: "ADMIN", clinical: false, acceptedAt: FUTURE } });
  });

  afterAll(async () => {
    if (!db) return;
    for (const t of tenants) await t.cleanup();
    await db.practitioner.deleteMany({ where: { userId: { in: users } } });
    await db.membership.deleteMany({ where: { userId: { in: users } } });
    await db.userProfile.deleteMany({ where: { id: { in: users } } });
    await db.$disconnect();
  });

  beforeEach(() => {
    __rateLimitInternals.reset();
    __setAuthAdminForTests(new GotrueFake());
    asUser(S);
  });
  afterEach(() => __setAuthAdminForTests(null));

  it("quien no es superadmin rebota", async () => {
    asUser(H.userId);
    await expect(getPlatformHealth()).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("detecta cada caso del fixture, sin PHI", async () => {
    const h = await getPlatformHealth();

    expect(h.clinicalWithoutPractitioner.available).toBe(true);
    const missing = h.clinicalWithoutPractitioner.sample.filter((r) => r.tenantId === H.tenantId);
    // PL-1d: el Admin que atiende sin profesional sí; el que no atiende y la Secretaria (clinical=true por default de
    // la columna, pero ASSISTANT nunca es clínico) no.
    expect(missing.map((r) => r.userId).sort()).toEqual([adminClinico, kineSinProf].sort());
    expect(missing.find((r) => r.userId === kineSinProf)).toMatchObject({ role: "PRACTITIONER", email: `${kineSinProf}@test.local` });
    expect(missing.find((r) => r.userId === adminClinico)).toMatchObject({ role: "ADMIN" });
    // PL-1d: un Titular que no atiende no es un detector de salud (no se le ofrece «Crear profesional»).
    expect(h.clinicalWithoutPractitioner.sample.map((r) => r.tenantId)).not.toContain(titularNoClinico.tenantId);
    // El digest del cron (copia del criterio, lib/cron-jobs-internal.ts) cuenta lo mismo que la pantalla.
    expect((await healthCountsCore(new Date())).clinicalWithoutPractitioner).toBe(h.clinicalWithoutPractitioner.count);

    expect(h.practitionersWithoutMembership.sample.map((r) => r.practitionerId)).toContain(pracSinMembresia);
    expect(h.tenantsWithoutOwner.sample.map((r) => r.tenantId)).toContain(noOwner.tenantId);
    expect(h.tenantsWithoutOwner.sample.map((r) => r.tenantId)).not.toContain(H.tenantId);
    expect(h.expiredInvitations.sample.map((r) => r.invitationId)).toContain(invitationId);
    expect(h.stalledOnboarding.sample.map((r) => r.tenantId)).toContain(stalled.tenantId);
    expect(h.stalledOnboarding.sample.map((r) => r.tenantId)).not.toContain(H.tenantId);
    expect(h.profilesWithoutAccess.sample.map((r) => r.userId)).toContain(perfilHuerfano);
    expect(h.profilesWithoutAccess.sample.map((r) => r.userId)).not.toContain(S); // superadmin sin consultorio no es huérfano

    for (const d of [
      h.clinicalWithoutPractitioner,
      h.practitionersWithoutMembership,
      h.tenantsWithoutOwner,
      h.expiredInvitations,
      h.stalledOnboarding,
      h.profilesWithoutAccess,
    ]) {
      expect(d.available).toBe(true);
      expect(d.count).toBeGreaterThanOrEqual(d.sample.length);
      expect(d.sample.length).toBeLessThanOrEqual(10);
    }
    expect(JSON.stringify(h)).not.toContain(PHI_MARK);

    // Auth vacío (fake recién creado): los detectores de Auth corren y no encuentran nada.
    expect(h.authOrphans).toEqual({ available: true, count: 0, sample: [] });
    expect(h.emailMismatches).toEqual({ available: true, count: 0, sample: [] });
  });

  it("anular la invitación o reparar al miembro lo saca del detector", async () => {
    await db.invitation.update({ where: { id: invitationId }, data: { revokedAt: new Date() } });
    await db.practitioner.create({ data: { tenantId: H.tenantId, userId: kineSinProf } });
    const h = await getPlatformHealth();
    expect(h.expiredInvitations.sample.map((r) => r.invitationId)).not.toContain(invitationId);
    expect(h.clinicalWithoutPractitioner.sample.map((r) => r.userId)).not.toContain(kineSinProf);
  });

  it("Auth falla al listar → los detectores de Auth no corren (no inventan un «todo bien»)", async () => {
    const fake = new GotrueFake();
    __setAuthAdminForTests(fake);
    fake.failNext("error", "listUsers");
    const h = await getPlatformHealth();
    expect(h.authOrphans).toEqual({ available: false, count: null, sample: [] });
    expect(h.emailMismatches).toEqual({ available: false, count: null, sample: [] });
  });

  it("con usuarios en Auth: huérfanos de Auth (con canDelete) y emails distintos", async () => {
    const fake = new GotrueFake();
    __setAuthAdminForTests(fake);
    const zombie = await fake.createUser({ email: `zombie-${uniqueSuffix()}@test.local`, emailConfirm: false });
    const usado = await fake.createUser({ email: `usado-${uniqueSuffix()}@test.local`, emailConfirm: true });
    if (!zombie.ok || !usado.ok) throw new Error("fake");
    const now = new Date().toISOString();
    const base = { emailConfirmedAt: now, lastSignInAt: now, createdAt: now, bannedUntil: null, password: null, fullName: null };
    fake.users.set(perfilHuerfano, { ...base, id: perfilHuerfano, email: `cambiado-${perfilHuerfano}@test.local` });
    fake.users.set(S, { ...base, id: S, email: `${S}@test.local` });

    const h = await getPlatformHealth();
    expect(h.authOrphans.available).toBe(true);
    const orphans = new Map(h.authOrphans.sample.map((o) => [o.authUserId, o]));
    expect(orphans.get(zombie.data.id)?.canDelete).toBe(true);
    expect(orphans.get(usado.data.id)?.canDelete).toBe(false);
    expect(orphans.has(S)).toBe(false);
    expect(h.emailMismatches.sample).toEqual([
      { userId: perfilHuerfano, profileEmail: `${perfilHuerfano}@test.local`, authEmail: `cambiado-${perfilHuerfano}@test.local` },
    ]);
  });
});
