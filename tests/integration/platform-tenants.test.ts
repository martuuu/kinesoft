/**
 * EV0 · EV-P1 — /plataforma consultorios (server), contra Postgres real y con los
 * dos roles (`test:integration` = kinesoft_app; `:owner` = BYPASSRLS = prod).
 *
 * Todo `lib/platform-tenants*` corre sobre `prismaService` (cruza tenants), así
 * que la ÚNICA barrera es `requireSuperAdmin()` en cada export. Se fija:
 *   - un OWNER que no es superadmin rebota con `ForbiddenError` en la action y en
 *     las tres lecturas, sin escribir nada ni auditar;
 *   - el superadmin S edita el consultorio B → B cambia, el audit
 *     `platform.tenant.entitlements` queda en B con actorId = S, y nada en el home
 *     de S; se revalidan los tags de entitlements de B;
 *   - CAS stale → sin cambios; strict → sin cambios; tenant inexistente → error;
 *   - contrato PHI: los DTOs son un allowlist de keys sin datos de pacientes
 *     (se lista cada key; y el nombre/notas de un paciente fixture no aparecen
 *     en ningún DTO serializado).
 *
 * Se llaman los símbolos reales con el getActor real (solo se mockea la sesión de
 * Supabase, `next/headers` y `next/cache`; ver integration-setup.ts).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { updatePlatformTenant } from "@/lib/platform-tenants";
import {
  getPlatformOverview,
  listPlatformTenants,
  getPlatformTenantDetail,
} from "@/lib/platform-tenants-read";
import { ForbiddenError } from "@/lib/session";
import { tenantEntitlementTags } from "@/lib/cache-tags";
import { revalidatePathSpy, revalidateTagSpy } from "@/tests/helpers/integration-setup";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

// PL-Z (a2#4): con PLATFORM_MFA_ENFORCEMENT != enforce, las acciones `high` de Plataforma piden el step-up de la 2FA
// por usuario. Este archivo prueba otra cosa: el step-up se da por hecho (el corte real se prueba en
// tests/integration/two-factor.test.ts, «Plataforma»). Se reemplaza la dependencia, no la action bajo test.
vi.mock("@/lib/two-factor-step-up", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/two-factor-step-up")>()),
  requireStepUp: async () => {},
}));

const RUN = process.env.INTEGRATION === "1";
const STALE_COPY = "Otro cambio se guardó antes. Recargá y revisá.";
const PHI_MARK = "Zqxphimark";

const ROW_KEYS = [
  "access", // BO2-D
  "createdAt",
  "effectiveAccessMode", // BO2-D
  "id",
  "isPlatformHome",
  "memberCount",
  "name",
  "onboardingCompleted",
  "ownerEmails",
  "ownerNames", // VX0-b
  "patientCount",
  "saasPlan", // PL-1d (antes `plan`)
  "publicBookingEnabled",
  // PL-1d: cupos a medida por tipo + límites efectivos (antes `seatLimitOverride`, BO2-D).
  "maxUsersOverride",
  "maxProfessionalsOverride",
  "maxStaffOverride",
  "limits",
  "slug",
  "slugAliases", // BO2-D
  "status", // BO2-D
  "statusChangedAt", // BO2-D
  "statusReason", // BO2-D
  "subscriptionStatus",
  "trialEndsOn",
  "vertical",
].sort();
const DETAIL_KEYS = [
  ...ROW_KEYS,
  "counts",
  "lastActivityAt",
  "legalName", // BO3-B
  "modules",
  "phone",
  "publicBookingPath",
  "publicEmail",
  "recentPlatformEvents",
  "sharedPatientView",
  "taxId", // BO3-B
  "updatedAt",
  "whatsapp",
].sort();
const COUNT_KEYS = [
  "bookingsLast30Days",
  "bookingsTotal",
  "bookingsUpcoming",
  "locations",
  "members",
  "patients",
  "pendingInvitations",
  "practitioners",
  "services",
];
const EVENT_KEYS = ["action", "actorEmail", "changes", "createdAt", "id"];
const OVERVIEW_KEYS = [
  "byStatus", // BO3-B
  "byVerticalPlan",
  "onboardingPending",
  "onboardingPendingCount",
  "publicBookingEnabledCount",
  "totalTenants",
  "trialsEndingSoon",
  "trialsEndingSoonCount",
];

const keysOf = (o: object) => Object.keys(o).sort();

describe.skipIf(!RUN)("platform-tenants · /plataforma consultorios (EV-P1)", () => {
  let db: PrismaClient;
  /** Superadmin (su home). */
  let S: EphemeralTenant;
  /** OWNER sin superadmin. */
  let A: EphemeralTenant;
  /** Consultorio afectado. */
  let B: EphemeralTenant;

  const tenantRow = (id: string) =>
    db.tenant.findUniqueOrThrow({
      where: { id },
      select: {
        vertical: true,
        saasPlan: true,
        plan: true,
        subscriptionStatus: true,
        trialEndsAt: true,
        publicBookingEnabled: true,
        name: true,
        slug: true,
        sharedPatientView: true,
        updatedAt: true,
      },
    });
  const platformAudits = (tenantId: string) =>
    db.auditEvent.findMany({ where: { tenantId, action: { startsWith: "platform." } } });

  beforeAll(async () => {
    db = ownerClient();
    S = await createEphemeralTenant(db);
    await db.userProfile.update({ where: { id: S.userId }, data: { isPlatformAdmin: true } });
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "FREE", publicBookingEnabled: false });

    // Fixtures de B con PHI (para afirmar que NO se filtra) y para los conteos.
    const patientId = await addPatient(db, B, { firstName: PHI_MARK, lastName: PHI_MARK, notes: `${PHI_MARK} notas` });
    await addPatient(db, B);
    await addPractitioner(db, B);
    const now = Date.now();
    const mk = (offsetDays: number) =>
      db.booking.create({
        data: {
          tenantId: B.tenantId,
          patientId,
          practitionerId: B.practitionerId,
          serviceId: B.serviceId,
          scheduledFor: new Date(now + offsetDays * 86_400_000),
          durationMin: 45,
          idempotencyKey: `ev-p1-${uniqueSuffix()}`,
          notes: `${PHI_MARK} turno`,
        },
      });
    await mk(-90); // fuera de los últimos 30 días
    await mk(-3); // últimos 30 días
    await mk(5); // futuro
    await db.invitation.create({
      data: {
        tenantId: B.tenantId,
        email: `inv-${uniqueSuffix()}@test.local`,
        firstName: "Inv",
        lastName: "Pendiente",
        token: `tok-${uniqueSuffix()}`,
        invitedById: B.userId,
        expiresAt: new Date(now + 7 * 86_400_000),
      },
    });
  });

  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await S?.cleanup();
    await db?.$disconnect();
  });

  beforeEach(() => {
    revalidateTagSpy.mockClear();
    revalidatePathSpy.mockClear();
  });

  it("OWNER no superadmin: Forbidden en la action y en las 3 lecturas, sin cambios ni audit", async () => {
    const before = await tenantRow(B.tenantId);
    asUser(A.userId);
    const calls: [string, () => Promise<unknown>][] = [
      [
        "updatePlatformTenant",
        () =>
          updatePlatformTenant({
            tenantId: B.tenantId,
            expectedUpdatedAt: before.updatedAt.toISOString(),
            saasPlan: "CLINICA",
          }),
      ],
      ["getPlatformOverview", () => getPlatformOverview()],
      ["listPlatformTenants", () => listPlatformTenants({})],
      ["getPlatformTenantDetail", () => getPlatformTenantDetail(B.tenantId)],
    ];
    for (const [name, call] of calls) {
      const err = await call().then(
        () => null,
        (e) => e
      );
      expect(err, name).toBeInstanceOf(ForbiddenError);
    }
    expect(await tenantRow(B.tenantId)).toEqual(before);
    expect(await platformAudits(B.tenantId)).toHaveLength(0);
    expect(revalidateTagSpy).not.toHaveBeenCalled();
  });

  it("superadmin edita B: B cambia, audit en B con actorId = S, nada en el home de S, tags revalidados", async () => {
    asUser(S.userId);
    const before = await tenantRow(B.tenantId);
    const res = await updatePlatformTenant({
      tenantId: B.tenantId,
      expectedUpdatedAt: before.updatedAt.toISOString(),
      vertical: "GENERAL",
      saasPlan: "CLINICA",
      subscriptionStatus: "TRIALING",
      trialEndsOn: "2026-10-21",
      publicBookingEnabled: true,
    });
    expect(res.ok).toBe(true);
    const after = await tenantRow(B.tenantId);
    expect(after).toMatchObject({
      vertical: "GENERAL",
      saasPlan: "CLINICA",
      // PL-D1: el escritor espeja el enum legado.
      plan: "PRO",
      subscriptionStatus: "TRIALING",
      publicBookingEnabled: true,
      // Solo lectura desde /plataforma: intactos.
      name: before.name,
      slug: before.slug,
      sharedPatientView: before.sharedPatientView,
    });
    // Fin del día AR del 21/10.
    expect(after.trialEndsAt?.toISOString()).toBe("2026-10-22T02:59:59.999Z");
    if (res.ok) expect(res.data.updatedAt).toBe(after.updatedAt.toISOString());

    const audits = await platformAudits(B.tenantId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      tenantId: B.tenantId,
      actorId: S.userId,
      action: "platform.tenant.entitlements",
      entity: "Tenant",
      entityId: B.tenantId,
    });
    expect(await platformAudits(S.tenantId)).toHaveLength(0);
    expect(await db.auditEvent.count({ where: { tenantId: S.tenantId, actorId: S.userId } })).toBe(0);

    for (const tag of tenantEntitlementTags(B.tenantId)) expect(revalidateTagSpy).toHaveBeenCalledWith(tag);
    expect(revalidatePathSpy).toHaveBeenCalledWith("/plataforma", "layout");

    // Borrar el trial con null.
    const res2 = await updatePlatformTenant({
      tenantId: B.tenantId,
      expectedUpdatedAt: after.updatedAt.toISOString(),
      trialEndsOn: null,
    });
    expect(res2.ok).toBe(true);
    expect((await tenantRow(B.tenantId)).trialEndsAt).toBeNull();
  });

  it("sin cambios reales: ok, sin audit nuevo ni revalidación", async () => {
    asUser(S.userId);
    const before = await tenantRow(B.tenantId);
    const n = (await platformAudits(B.tenantId)).length;
    const res = await updatePlatformTenant({
      tenantId: B.tenantId,
      expectedUpdatedAt: before.updatedAt.toISOString(),
      saasPlan: before.saasPlan,
    });
    expect(res).toEqual({ ok: true, data: { updatedAt: before.updatedAt.toISOString() } });
    expect(await platformAudits(B.tenantId)).toHaveLength(n);
    expect(revalidateTagSpy).not.toHaveBeenCalled();
  });

  it("CAS stale → error con el copy y sin cambios", async () => {
    asUser(S.userId);
    const before = await tenantRow(B.tenantId);
    const n = (await platformAudits(B.tenantId)).length;
    const res = await updatePlatformTenant({
      tenantId: B.tenantId,
      expectedUpdatedAt: new Date(before.updatedAt.getTime() - 1).toISOString(),
      saasPlan: before.saasPlan === "LIBRE" ? "CLINICA" : "LIBRE",
    });
    expect(res).toMatchObject({ ok: false, error: STALE_COPY });
    expect(await tenantRow(B.tenantId)).toEqual(before);
    expect(await platformAudits(B.tenantId)).toHaveLength(n);
    expect(revalidateTagSpy).not.toHaveBeenCalled();
  });

  it("[PL-1d] bajar el plan por debajo del equipo actual se rechaza sin escribir; subir y cupos de Libre sí", async () => {
    asUser(S.userId);
    const before = await tenantRow(B.tenantId);
    expect(before.saasPlan).toBe("CLINICA");
    const n = (await platformAudits(B.tenantId)).length;
    // B: 2 miembros + 1 invitación pendiente (reserva lugar, PL-D3) → no entra en Individual (1 usuario).
    const down = await updatePlatformTenant({
      tenantId: B.tenantId,
      expectedUpdatedAt: before.updatedAt.toISOString(),
      saasPlan: "INDIVIDUAL",
    });
    expect(down).toMatchObject({ ok: false });
    if (!down.ok) {
      expect(down.error).toMatch(/límite es de 1 usuario y hoy hay 3/);
      expect(down.error).toContain("Cambiar de plan");
    }
    expect(await tenantRow(B.tenantId)).toEqual(before);
    expect(await platformAudits(B.tenantId)).toHaveLength(n);

    // Libre con cupos a medida que entran: escribe y audita como números; achicar por debajo del uso rebota.
    const libre = await updatePlatformTenant({
      tenantId: B.tenantId,
      expectedUpdatedAt: before.updatedAt.toISOString(),
      saasPlan: "LIBRE",
      maxUsersOverride: 20,
      maxProfessionalsOverride: 15,
    });
    expect(libre.ok).toBe(true);
    const t = await db.tenant.findUniqueOrThrow({
      where: { id: B.tenantId },
      select: { saasPlan: true, plan: true, maxUsersOverride: true, maxProfessionalsOverride: true, maxStaffOverride: true, updatedAt: true },
    });
    expect(t).toMatchObject({ saasPlan: "LIBRE", plan: "ENTERPRISE", maxUsersOverride: 20, maxProfessionalsOverride: 15, maxStaffOverride: null });
    const ev = (await platformAudits(B.tenantId)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    expect(ev.payload).toMatchObject({ after: { saasPlan: "LIBRE", maxUsersOverride: 20, maxProfessionalsOverride: 15 } });
    const row = (await listPlatformTenants({ q: B.slug })).rows[0];
    expect(row.limits).toEqual({ maxUsers: 20, maxProfessionals: 15, maxStaff: null });

    const tooSmall = await updatePlatformTenant({
      tenantId: B.tenantId,
      expectedUpdatedAt: t.updatedAt.toISOString(),
      maxUsersOverride: 2,
    });
    expect(tooSmall).toMatchObject({ ok: false });
    expect((await db.tenant.findUniqueOrThrow({ where: { id: B.tenantId }, select: { maxUsersOverride: true } })).maxUsersOverride).toBe(20);

    // Volver al estado del resto de la suite (Clínica sin overrides).
    const back = await updatePlatformTenant({
      tenantId: B.tenantId,
      expectedUpdatedAt: t.updatedAt.toISOString(),
      saasPlan: "CLINICA",
      maxUsersOverride: null,
      maxProfessionalsOverride: null,
    });
    expect(back.ok).toBe(true);
  });

  it("strict (key de solo lectura) e inexistente → error sin cambios", async () => {
    asUser(S.userId);
    const before = await tenantRow(B.tenantId);
    const strict = await updatePlatformTenant({
      tenantId: B.tenantId,
      expectedUpdatedAt: before.updatedAt.toISOString(),
      name: "Renombrado desde plataforma",
    });
    expect(strict.ok).toBe(false);
    const missing = await updatePlatformTenant({
      tenantId: `no-existe-${uniqueSuffix()}`,
      expectedUpdatedAt: before.updatedAt.toISOString(),
      saasPlan: "CLINICA",
    });
    expect(missing).toMatchObject({ ok: false });
    if (!missing.ok) expect(missing.error).toMatch(/no encontramos/i);
    expect(await tenantRow(B.tenantId)).toEqual(before);
  });

  it("lecturas del superadmin: lista, detalle y resumen con allowlist de keys y sin PHI", async () => {
    asUser(S.userId);

    const page = await listPlatformTenants({ q: B.slug });
    expect(page.total).toBe(1);
    expect(page.rows).toHaveLength(1);
    const row = page.rows[0];
    expect(keysOf(row)).toEqual(ROW_KEYS);
    expect(row).toMatchObject({
      id: B.tenantId,
      slug: B.slug,
      patientCount: 2,
      memberCount: 2,
      isPlatformHome: false,
      onboardingCompleted: true,
    });
    expect(row.ownerEmails).toEqual([`${B.userId}@test.local`]);
    // BO2-D: estado y acceso calculado (B ACTIVE + ACTIVE → full) sin alias.
    expect(row).toMatchObject({ status: "ACTIVE", statusReason: null, slugAliases: [], effectiveAccessMode: "full" });
    expect(keysOf(row.access)).toEqual(["daysLeft", "mode", "reason"]);

    const home = await listPlatformTenants({ q: S.slug });
    expect(home.rows[0]?.isPlatformHome).toBe(true);

    const filtered = await listPlatformTenants({ q: B.slug, vertical: "KINESIOLOGY" });
    expect(filtered.total).toBe(0); // B quedó GENERAL

    const detail = await getPlatformTenantDetail(B.tenantId);
    expect(detail).not.toBeNull();
    if (!detail) return;
    expect(keysOf(detail)).toEqual(DETAIL_KEYS);
    expect(keysOf(detail.counts)).toEqual(COUNT_KEYS);
    expect(detail.counts).toEqual({
      members: 2,
      pendingInvitations: 1,
      practitioners: 2,
      patients: 2,
      services: 1,
      locations: 0,
      bookingsTotal: 3,
      bookingsLast30Days: 1,
      bookingsUpcoming: 1,
    });
    expect(detail.publicBookingPath).toBe(`/c/${B.slug}/booking`);
    expect(detail.lastActivityAt).not.toBeNull();
    expect(detail.recentPlatformEvents.length).toBeGreaterThan(0);
    for (const ev of detail.recentPlatformEvents) {
      expect(keysOf(ev)).toEqual(EVENT_KEYS);
      expect(ev.action.startsWith("platform.")).toBe(true);
    }
    expect(detail.recentPlatformEvents[detail.recentPlatformEvents.length - 1].actorEmail).toBe(
      `${S.userId}@test.local`
    );
    // GENERAL → sin módulos Kine.
    expect(detail.modules).not.toContain("planes");
    expect(detail.modules).toContain("agenda");
    expect(detail.updatedAt).toBe((await tenantRow(B.tenantId)).updatedAt.toISOString());

    expect(await getPlatformTenantDetail(`no-existe-${uniqueSuffix()}`)).toBeNull();

    const overview = await getPlatformOverview();
    expect(keysOf(overview)).toEqual(OVERVIEW_KEYS);
    expect(overview.totalTenants).toBeGreaterThanOrEqual(3);
    const sum = overview.byVerticalPlan.reduce((acc, r) => acc + r.count, 0);
    expect(sum).toBe(overview.totalTenants);
    for (const r of overview.byVerticalPlan) expect(keysOf(r)).toEqual(["count", "saasPlan", "vertical"]);

    // Contrato PHI: nada del paciente/turno fixture en ningún DTO.
    const blob = JSON.stringify({ page, detail, overview });
    expect(blob).not.toContain(PHI_MARK);
  });

  it("[EV1-D] buscar consultorio: `%` y `_` son literales (Prisma no escapa ILIKE en `contains`)", async () => {
    const tag = uniqueSuffix().replace(/[^a-z0-9]/gi, "");
    const C1 = await createEphemeralTenant(db);
    const C2 = await createEphemeralTenant(db);
    try {
      await db.tenant.update({ where: { id: C1.tenantId }, data: { name: `Consultorio 100%_${tag}` } });
      // Matchea `100%_` si `%`/`_` fueran comodines.
      await db.tenant.update({ where: { id: C2.tenantId }, data: { name: `Consultorio 1000x${tag}` } });
      asUser(S.userId);
      const page = await listPlatformTenants({ q: `100%_${tag}` });
      expect(page.rows.map((r) => r.id)).toEqual([C1.tenantId]);
      // `%` solo: sin escape traía todos los consultorios.
      const pct = await listPlatformTenants({ q: `%${tag}%` });
      expect(pct.rows).toHaveLength(0);
    } finally {
      await C1.cleanup();
      await C2.cleanup();
    }
  });

  it("resumen: trial por vencer y onboarding pendiente", async () => {
    asUser(S.userId);
    const soon = new Date(Date.now() + 3 * 86_400_000);
    // Fixture directa con el owner (no es el código bajo test).
    await db.tenant.update({
      where: { id: B.tenantId },
      data: { subscriptionStatus: "TRIALING", trialEndsAt: soon, onboardingCompletedAt: null },
    });
    const overview = await getPlatformOverview();
    const trial = overview.trialsEndingSoon.find((t) => t.id === B.tenantId);
    expect(trial).toBeDefined();
    expect(trial?.daysLeft).toBeGreaterThanOrEqual(2);
    expect(trial?.daysLeft).toBeLessThanOrEqual(4);
    expect(keysOf(trial!)).toEqual(["daysLeft", "id", "name", "saasPlan", "slug", "trialEndsOn", "vertical"]);
    const pending = overview.onboardingPending.find((t) => t.id === B.tenantId);
    expect(pending).toBeDefined();
    expect(keysOf(pending!)).toEqual(["createdAt", "id", "name", "saasPlan", "slug", "vertical"]);
    expect(overview.onboardingPendingCount).toBeGreaterThanOrEqual(1);
    expect(overview.trialsEndingSoonCount).toBeGreaterThanOrEqual(1);
  });
});
