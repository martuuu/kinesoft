/**
 * EV1-E2 · Configuración en solo lectura devuelve el copy, no tira (AUDIT `readonly-residual-actions`, clase A).
 *
 * El bug: con el consultorio en solo lectura (`enforce`) las actions de Configuración TIRABAN el `ReadOnlyModeError`
 * de la tx (en prod Next redacta el mensaje: «An error occurred…») o lo tapaban con su copy genérico («No pudimos
 * crear la sede.»). Ahora van envueltas en `withReadOnlyResult` (lib/read-only-result.ts) y sus catch-all miran
 * `readOnlyFailure` primero. Con soporte el orden es `withReadOnlyResult(() => withSupportWritable(…))`: la allowlist
 * sigue escribiendo y lo de afuera (p. ej. «Consultorio común») devuelve el copy de soporte en vez de tirar.
 *
 * Símbolos REALES contra Postgres en los dos roles. Se mockea solo lo externo: la sesión de Supabase y `next/cache`
 * (integration-setup), el despacho del mail y el puerto de Auth (GoTrue fake).
 *
 * Fuera de este archivo: `resolveInsurerName` (lib/insurers-internal.ts) con nombres que traen comodines de ILIKE.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { cookies } from "next/headers";
import type { PrismaClient } from "@prisma/client";
import { READ_ONLY_MESSAGE, SUPPORT_READ_ONLY_MESSAGE } from "@/lib/tenant-access";
import { createService, updateService, deleteService } from "@/lib/services";
import {
  createInsurer,
  updateInsurer,
  deleteInsurer,
  addInsurerFromCatalog,
  linkInsurerToPayer,
} from "@/lib/insurers";
import { createLocation, updateLocation, setPrimaryLocation, archiveLocation, restoreLocation } from "@/lib/locations";
import { createRoom, updateRoom, archiveRoom, restoreRoom } from "@/lib/rooms";
import { savePractitionerWeek, upsertException, deleteException } from "@/lib/practitioner-schedule";
import {
  setBusinessHours,
  setSharedPatientView,
  setPublicBookingEnabled,
  updateTenantBasics,
} from "@/lib/tenant-settings";
import { upsertPractitionerService } from "@/lib/practitioner-services";
import { setPractitionerPayers } from "@/lib/practitioner-payers";
import {
  createInvitation,
  resendInvitation,
  regenerateInvitationUrl,
  revokeInvitation,
  changeMemberRole,
  suspendMember,
  reactivateMember,
  sendMemberPasswordReset,
  removeMember,
} from "@/lib/invitations";
import { startSupport } from "@/lib/platform-support";
import { SUPPORT_COOKIE } from "@/lib/support-session-internal";
import { resolveInsurerName } from "@/lib/insurers-internal";
import { __setEmailTransportForTests, type SendEmailInput, type SendEmailResult } from "@/lib/email";
import { __setAuthAdminForTests } from "@/lib/identity/auth-admin";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { GotrueFake } from "@/tests/helpers/gotrue-fake";
import { asUser } from "@/tests/helpers/actor";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  addInsurer,
  addRoom,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

// PL-Z (a2#4): con PLATFORM_MFA_ENFORCEMENT != enforce, las acciones `high` de Plataforma piden el step-up de la 2FA
// por usuario. Este archivo prueba otra cosa: el step-up se da por hecho (el corte real se prueba en
// tests/integration/two-factor.test.ts, «Plataforma»). Se reemplaza la dependencia, no la action bajo test.
vi.mock("@/lib/two-factor-step-up", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/two-factor-step-up")>()),
  requireStepUp: async () => {},
}));

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("[EV1-E2] Configuración en solo lectura → { ok:false, error } sin escribir", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  const payerIds: string[] = [];
  const mails: SendEmailInput[] = [];
  const prevEnforcement = process.env.TENANT_ACCESS_ENFORCEMENT;
  // Fixtures (todas del consultorio A, sembradas con la conexión owner antes de pasarlo a solo lectura).
  let insurerId: string;
  let locA: string;
  let locB: string;
  let locArchived: string;
  let roomId: string;
  let roomArchived: string;
  let exceptionId: string;
  let payerId: string;
  let invitationId: string;
  let memberId: string;
  let suspendedMemberId: string;
  let memberPractitionerId: string;

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db, { plan: "PRO" });
    insurerId = await addInsurer(db, A, { name: `OS ro ${uniqueSuffix()}` });
    const r = await addRoom(db, A);
    roomId = r.roomId;
    locA = r.locationId;
    locB = (await db.location.create({ data: { tenantId: A.tenantId, name: `Sede B ${uniqueSuffix()}` } })).id;
    locArchived = (await db.location.create({ data: { tenantId: A.tenantId, name: `Sede vieja ${uniqueSuffix()}`, active: false } })).id;
    roomArchived = (await addRoom(db, A, { locationId: locA, active: false })).roomId;
    exceptionId = (
      await db.scheduleException.create({
        data: { tenantId: A.tenantId, practitionerId: A.practitionerId, date: new Date("2031-03-03T00:00:00Z"), kind: "CLOSED", createdById: A.userId },
      })
    ).id;
    const p = await db.payer.create({
      data: {
        slug: `test-payer-${uniqueSuffix()}`,
        name: `Prestadora RO ${uniqueSuffix()}`,
        kind: "OBRA_SOCIAL",
        matchKey: `prestadora ro ${uniqueSuffix()}`,
        aliases: [],
        source: "CURATED",
        sourceDate: new Date("2026-09-01"),
      },
    });
    payerId = p.id;
    payerIds.push(p.id);
    const kine = await addPractitioner(db, A);
    memberPractitionerId = kine.practitionerId;
    memberId = (await db.membership.findFirstOrThrow({ where: { tenantId: A.tenantId, userId: kine.userId } })).id;
    const sec = await addPractitioner(db, A, "ASSISTANT");
    suspendedMemberId = (await db.membership.findFirstOrThrow({ where: { tenantId: A.tenantId, userId: sec.userId } })).id;
    await db.membership.update({ where: { id: suspendedMemberId }, data: { disabledAt: new Date(), disabledById: A.userId } });
  }, 60_000);

  afterAll(async () => {
    if (prevEnforcement === undefined) delete process.env.TENANT_ACCESS_ENFORCEMENT;
    else process.env.TENANT_ACCESS_ENFORCEMENT = prevEnforcement;
    __setEmailTransportForTests(null);
    __setAuthAdminForTests(null);
    await A?.cleanup();
    if (db) {
      if (payerIds.length) await db.payer.deleteMany({ where: { id: { in: payerIds } } });
      await db.$disconnect();
    }
  });

  beforeEach(() => {
    __rateLimitInternals.reset();
    mails.length = 0;
    __setAuthAdminForTests(new GotrueFake());
    __setEmailTransportForTests(async (i): Promise<SendEmailResult> => {
      mails.push(i);
      return { ok: true, transport: "resend", providerId: `fake-${mails.length}` };
    });
    asUser(A.userId);
  });

  afterEach(() => {
    delete process.env.TENANT_ACCESS_ENFORCEMENT;
  });

  /** Foto de todo lo que estas actions pueden tocar (incluido el audit del consultorio). */
  const snapshot = async () => {
    const t = A.tenantId;
    const [tenant, services, insurers, locations, rooms, schedules, exceptions, pServices, pPayers, invitations, memberships, audits] =
      await Promise.all([
        db.tenant.findUniqueOrThrow({ where: { id: t } }),
        db.service.findMany({ where: { tenantId: t }, orderBy: { id: "asc" } }),
        db.insurer.findMany({ where: { tenantId: t }, orderBy: { id: "asc" } }),
        db.location.findMany({ where: { tenantId: t }, orderBy: { id: "asc" } }),
        db.room.findMany({ where: { tenantId: t }, orderBy: { id: "asc" } }),
        db.practitionerSchedule.count({ where: { tenantId: t } }),
        db.scheduleException.findMany({ where: { tenantId: t }, orderBy: { id: "asc" } }),
        db.practitionerService.findMany({ where: { tenantId: t }, orderBy: { id: "asc" } }),
        db.practitionerPayer.findMany({ where: { tenantId: t }, orderBy: { id: "asc" } }),
        db.invitation.findMany({ where: { tenantId: t }, orderBy: { id: "asc" } }),
        db.membership.findMany({ where: { tenantId: t }, orderBy: { id: "asc" } }),
        db.auditEvent.count({ where: { tenantId: t } }),
      ]);
    return { tenant, services, insurers, locations, rooms, schedules, exceptions, pServices, pPayers, invitations, memberships, audits };
  };

  it("[EV1-E2] OWNER con el consultorio en solo lectura: las 35 actions de Configuración devuelven el copy y no escriben", async () => {
    // Una invitación pendiente (con el consultorio todavía escribible) para resend/regenerate/revoke.
    const inv = await createInvitation({ email: `ro-${uniqueSuffix()}@test.local`, firstName: "Ro", lastName: "Invitada", role: "ASSISTANT" });
    expect(inv, JSON.stringify(inv)).toMatchObject({ ok: true });
    invitationId = (await db.invitation.findFirstOrThrow({ where: { tenantId: A.tenantId, revokedAt: null }, orderBy: { invitedAt: "desc" } })).id;
    const tenantRow = await db.tenant.findUniqueOrThrow({ where: { id: A.tenantId } });

    // Suscripción cancelada → `read_only` con el modo efectivo `enforce`.
    await db.tenant.update({ where: { id: A.tenantId }, data: { subscriptionStatus: "CANCELLED" } });
    process.env.TENANT_ACCESS_ENFORCEMENT = "enforce";
    mails.length = 0;
    try {
      const before = await snapshot();
      const actions: Array<[string, () => Promise<unknown>]> = [
        ["createService", () => createService({ name: `Serv ${uniqueSuffix()}`, durationMin: 30, priceCents: 0 })],
        ["updateService", () => updateService(A.serviceId, { priceCents: 1234 })],
        ["deleteService", () => deleteService(A.serviceId)],
        ["createInsurer", () => createInsurer({ name: `OS ${uniqueSuffix()}`, copagoCents: 0, fixedFeeCents: 0 })],
        ["updateInsurer", () => updateInsurer(insurerId, { copagoCents: 999 } as never)],
        ["deleteInsurer", () => deleteInsurer(insurerId)],
        ["addInsurerFromCatalog", () => addInsurerFromCatalog(payerId)],
        ["linkInsurerToPayer", () => linkInsurerToPayer(insurerId, payerId)],
        ["createLocation", () => createLocation({ name: `Sede ${uniqueSuffix()}` })],
        ["updateLocation", () => updateLocation(locB, { city: "CABA" })],
        ["setPrimaryLocation", () => setPrimaryLocation(locB)],
        ["archiveLocation", () => archiveLocation(locB)],
        ["restoreLocation", () => restoreLocation(locArchived)],
        ["createRoom", () => createRoom({ locationId: locA, name: `Box ${uniqueSuffix()}` })],
        ["updateRoom", () => updateRoom({ id: roomId, capacity: 3 })],
        ["archiveRoom", () => archiveRoom({ id: roomId })],
        ["restoreRoom", () => restoreRoom({ id: roomArchived })],
        ["savePractitionerWeek", () => savePractitionerWeek(A.practitionerId, [{ dow: 1, startMin: 540, endMin: 780, locationId: locA }], null)],
        ["upsertException", () => upsertException({ practitionerId: A.practitionerId, date: "2031-03-10", kind: "CLOSED" })],
        ["deleteException", () => deleteException(exceptionId)],
        ["setBusinessHours", () => setBusinessHours({ start: 9, end: 18 })],
        ["setSharedPatientView", () => setSharedPatientView(!tenantRow.sharedPatientView)],
        ["setPublicBookingEnabled", () => setPublicBookingEnabled(!tenantRow.publicBookingEnabled)],
        ["updateTenantBasics", () => updateTenantBasics({ name: `Consultorio ${uniqueSuffix()}` })],
        ["upsertPractitionerService", () => upsertPractitionerService(A.practitionerId, A.serviceId, { enabled: true, visibility: "PUBLIC", concurrencyOverride: false, notifyOnBooking: true })],
        ["setPractitionerPayers", () => setPractitionerPayers(A.practitionerId, [insurerId])],
        ["createInvitation", () => createInvitation({ email: `ro2-${uniqueSuffix()}@test.local`, firstName: "Otra", lastName: "Invitada", role: "ASSISTANT" })],
        ["resendInvitation", () => resendInvitation(invitationId)],
        ["regenerateInvitationUrl", () => regenerateInvitationUrl(invitationId)],
        ["revokeInvitation", () => revokeInvitation(invitationId)],
        ["changeMemberRole", () => changeMemberRole(memberId, "ADMIN")],
        ["suspendMember", () => suspendMember(memberId)],
        ["reactivateMember", () => reactivateMember(suspendedMemberId)],
        ["sendMemberPasswordReset", () => sendMemberPasswordReset(memberId)],
        ["removeMember", () => removeMember(memberId)],
      ];
      const results: Record<string, unknown> = {};
      for (const [name, act] of actions) {
        // resend y regenerate comparten el cupo por invitación (va antes del write): cada action con el suyo.
        __rateLimitInternals.reset();
        try {
          results[name] = await act();
        } catch (e) {
          results[name] = { threw: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
        }
      }
      // Cada una DEVUELVE el copy del modo lectura (ni tira, ni el genérico «No pudimos…»).
      const wrong = Object.entries(results).filter(([, r]) => JSON.stringify(r) !== JSON.stringify({ ok: false, error: READ_ONLY_MESSAGE }));
      expect(wrong, JSON.stringify(wrong, null, 2)).toEqual([]);
      expect(Object.keys(results)).toHaveLength(actions.length);
      // Nada escrito (ni audit) y ningún mail (invitaciones / reset).
      expect(await snapshot()).toEqual(before);
      expect(mails).toEqual([]);
    } finally {
      delete process.env.TENANT_ACCESS_ENFORCEMENT;
      await db.tenant.update({ where: { id: A.tenantId }, data: { subscriptionStatus: tenantRow.subscriptionStatus } });
    }
  });

  describe("con soporte (allowlist C-BO4)", () => {
    let H: EphemeralTenant;
    let S: string;

    beforeAll(async () => {
      H = await createEphemeralTenant(db);
      S = H.userId;
      await db.userProfile.update({ where: { id: S }, data: { isPlatformAdmin: true } });
    });
    afterAll(async () => {
      if (db) await db.supportSession.deleteMany({ where: { superadminId: S } });
      await H?.cleanup();
    });
    beforeEach(async () => {
      cookies().delete(SUPPORT_COOKIE);
      await db.supportSession.updateMany({ where: { superadminId: S, endedAt: null }, data: { endedAt: new Date(), endedReason: "test" } });
      asUser(S);
      const r = await startSupport(A.tenantId, "El OWNER pidió ayuda con la configuración");
      if (!r.ok) throw new Error(r.error);
    });
    afterEach(() => {
      cookies().delete(SUPPORT_COOKIE);
    });

    it("[EV1-E2] las de la allowlist con el doble wrapper SÍ escriben (horario, excepción, datos del consultorio)", async () => {
      const hours = await setBusinessHours({ start: 8, end: 20 });
      expect(hours, JSON.stringify(hours)).toEqual({ ok: true, data: undefined });

      const ex = await upsertException({ practitionerId: A.practitionerId, date: "2031-04-14", kind: "CLOSED" });
      expect(ex, JSON.stringify(ex)).toMatchObject({ ok: true });
      if (ex.ok) {
        expect(await db.scheduleException.count({ where: { id: ex.data.id, tenantId: A.tenantId } })).toBe(1);
        expect(await deleteException(ex.data.id)).toMatchObject({ ok: true });
        expect(await db.scheduleException.count({ where: { id: ex.data.id } })).toBe(0);
      }

      const name = `Consultorio soporte ${uniqueSuffix()}`;
      expect(await updateTenantBasics({ name })).toMatchObject({ ok: true });
      expect((await db.tenant.findUniqueOrThrow({ where: { id: A.tenantId } })).name).toBe(name);
    });

    it("[EV1-E2] fuera de la allowlist DEVUELVE el copy de soporte (antes tiraba) y no escribe", async () => {
      const before = await db.tenant.findUniqueOrThrow({ where: { id: A.tenantId }, select: { sharedPatientView: true } });
      const payersBefore = await db.practitionerPayer.findMany({ where: { practitionerId: memberPractitionerId }, orderBy: { id: "asc" } });
      expect(await setSharedPatientView(!before.sharedPatientView)).toEqual({ ok: false, error: SUPPORT_READ_ONLY_MESSAGE });
      expect(await setPractitionerPayers(memberPractitionerId, [A.particularInsurerId])).toEqual({ ok: false, error: SUPPORT_READ_ONLY_MESSAGE });
      expect((await db.tenant.findUniqueOrThrow({ where: { id: A.tenantId } })).sharedPatientView).toBe(before.sharedPatientView);
      expect(await db.practitionerPayer.findMany({ where: { practitionerId: memberPractitionerId }, orderBy: { id: "asc" } })).toEqual(payersBefore);
    });
  });
});

describe.skipIf(!RUN)("[EV1-E2] resolveInsurerName: el nombre libre no se interpreta como patrón de ILIKE", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let osde: string;

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    osde = await addInsurer(db, A, { name: "OSDE" });
  });
  afterAll(async () => {
    await A?.cleanup();
    await db?.$disconnect();
  });

  it("«O_DE» y «OS%» quedan como texto libre; «osde» (sin mayúsculas) sí linkea", async () => {
    // Prisma compila `equals` + `mode: "insensitive"` a `ILIKE` sin escapar: antes «O_DE» linkeaba a OSDE.
    expect(await resolveInsurerName(A.tenantId, "O_DE")).toEqual({ insurerId: null, name: "O_DE" });
    expect(await resolveInsurerName(A.tenantId, "OS%")).toEqual({ insurerId: null, name: "OS%" });
    expect(await resolveInsurerName(A.tenantId, "  osde ")).toEqual({ insurerId: osde, name: "OSDE" });
  });
});
