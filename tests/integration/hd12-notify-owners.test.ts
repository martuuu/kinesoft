/**
 * [HD-12] PV (§27, ola Q1, sesión W1d) — `notifyTenantOwners` avisa solo a miembros ACTIVOS.
 *
 * El bug: la consulta de OWNER/ADMIN no filtraba nada más que el rol, así que una membresía suspendida
 * (`Membership.disabledAt`), una invitación sin aceptar (`acceptedAt` null) o un usuario deshabilitado en Plataforma
 * (`UserProfile.disabledAt`, BO0) seguían recibiendo `Notification` (montos, nombres de pacientes) de un consultorio
 * al que ya no entran. Lo mismo con `alsoPractitionerId` (el profesional del turno; `findUnique` por id, sin tenant ni
 * estado), con los operadores de agenda y con `alsoUserId`. Arreglo: mismo número de sentencias, solo filtros.
 *
 * Símbolo real (`notifyTenantOwners`, fire-and-forget: por eso el test afirma también que los activos SÍ reciben,
 * para que un throw tragado no pase por verde). Corre en los dos roles.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { notifyTenantOwners } from "@/lib/notifications-internal";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  addStaff,
  sweepOrphanTestTenants,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("[HD-12] notifyTenantOwners: solo miembros activos", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let Other: EphemeralTenant;
  let adminActive: { userId: string; practitionerId: string };
  let adminDisabled: { userId: string; practitionerId: string };
  let adminInvited: { userId: string; practitionerId: string };
  let adminPlatformOff: { userId: string; practitionerId: string };
  let pracActive: { userId: string; practitionerId: string };
  let pracSuspended: { userId: string; practitionerId: string };
  let pracPlatformOff: { userId: string; practitionerId: string };
  let opActive: { userId: string };
  let opPlatformOff: { userId: string };
  let opInvited: { userId: string };
  let linkUserActive: { userId: string; practitionerId: string };
  let linkUserPlatformOff: { userId: string; practitionerId: string };

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    T = await createEphemeralTenant(db); // T.userId = OWNER activo
    Other = await createEphemeralTenant(db);
    const now = new Date();
    adminActive = await addPractitioner(db, T, "ADMIN");
    adminDisabled = await addPractitioner(db, T, "ADMIN");
    adminInvited = await addPractitioner(db, T, "ADMIN");
    adminPlatformOff = await addPractitioner(db, T, "ADMIN");
    pracActive = await addPractitioner(db, T, "PRACTITIONER");
    pracSuspended = await addPractitioner(db, T, "PRACTITIONER");
    pracPlatformOff = await addPractitioner(db, T, "PRACTITIONER");
    opActive = await addStaff(db, T, "ASSISTANT");
    opPlatformOff = await addStaff(db, T, "ASSISTANT");
    opInvited = await addStaff(db, T, "ASSISTANT");
    linkUserActive = await addPractitioner(db, T, "PRACTITIONER");
    linkUserPlatformOff = await addPractitioner(db, T, "PRACTITIONER");

    const membership = (userId: string) => ({ userId_tenantId: { userId, tenantId: T.tenantId } });
    await db.membership.update({ where: membership(adminDisabled.userId), data: { disabledAt: now } });
    await db.membership.update({ where: membership(adminInvited.userId), data: { acceptedAt: null } });
    await db.membership.update({ where: membership(pracSuspended.userId), data: { disabledAt: now } });
    await db.membership.update({ where: membership(opInvited.userId), data: { acceptedAt: null } });
    for (const u of [adminPlatformOff, pracPlatformOff, opPlatformOff, linkUserPlatformOff]) {
      await db.userProfile.update({ where: { id: u.userId }, data: { disabledAt: now, disabledReason: "HD-12" } });
    }
  });

  afterAll(async () => {
    await T?.cleanup();
    await Other?.cleanup();
    await db?.$disconnect();
  });

  async function recipientsOf(title: string): Promise<Set<string>> {
    const rows = await db.notification.findMany({ where: { tenantId: T.tenantId, title }, select: { userId: true } });
    return new Set(rows.map((r) => r.userId));
  }

  it("[HD-12] titulares: ADMIN suspendido, invitación sin aceptar y usuario deshabilitado en Plataforma no reciben; los activos sí", async () => {
    const title = `hd12-owners-${uniqueSuffix()}`;
    await notifyTenantOwners({ tenantId: T.tenantId, kind: "SYSTEM", title });
    const got = await recipientsOf(title);
    expect(got.has(T.userId)).toBe(true);
    expect(got.has(adminActive.userId)).toBe(true);
    expect(got.has(adminDisabled.userId)).toBe(false);
    expect(got.has(adminInvited.userId)).toBe(false);
    expect(got.has(adminPlatformOff.userId)).toBe(false);
    expect(got.size).toBe(2);
  });

  it("[HD-12] alsoPractitionerId: solo si el profesional es del consultorio y su usuario y membresía están activos", async () => {
    const run = async (practitionerId: string) => {
      const title = `hd12-prac-${uniqueSuffix()}`;
      await notifyTenantOwners({ tenantId: T.tenantId, kind: "PAYMENT_RECEIVED", title, alsoPractitionerId: practitionerId });
      return recipientsOf(title);
    };
    expect((await run(pracActive.practitionerId)).has(pracActive.userId)).toBe(true);
    expect((await run(pracSuspended.practitionerId)).has(pracSuspended.userId)).toBe(false);
    expect((await run(pracPlatformOff.practitionerId)).has(pracPlatformOff.userId)).toBe(false);
    // Un id de otro consultorio no avisa a nadie de afuera (el `findUnique` por id no miraba el tenant).
    const foreign = await run(Other.practitionerId);
    expect(foreign.has(Other.userId)).toBe(false);
    expect(foreign.has(T.userId)).toBe(true);
  });

  it("[HD-12] operadores de agenda y alsoUserId: el deshabilitado en Plataforma y la invitación pendiente no reciben", async () => {
    const title = `hd12-ops-${uniqueSuffix()}`;
    await notifyTenantOwners({ tenantId: T.tenantId, kind: "SYSTEM", title, alsoAgendaOperators: true });
    const ops = await recipientsOf(title);
    expect(ops.has(opActive.userId)).toBe(true);
    expect(ops.has(opPlatformOff.userId)).toBe(false);
    expect(ops.has(opInvited.userId)).toBe(false);

    const runUser = async (userId: string) => {
      const t = `hd12-user-${uniqueSuffix()}`;
      await notifyTenantOwners({ tenantId: T.tenantId, kind: "PAYMENT_RECEIVED", title: t, alsoUserId: userId });
      return recipientsOf(t);
    };
    expect((await runUser(linkUserActive.userId)).has(linkUserActive.userId)).toBe(true);
    expect((await runUser(linkUserPlatformOff.userId)).has(linkUserPlatformOff.userId)).toBe(false);
    expect((await runUser(adminInvited.userId)).has(adminInvited.userId)).toBe(false);
  });
});
