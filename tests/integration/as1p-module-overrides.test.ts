/**
 * [AS-1p] T3c-1p (plan §23.6) · módulos a medida desde Plataforma, contra Postgres real y con los DOS roles
 * (`test:integration` = kinesoft_app; `:owner` = BYPASSRLS = prod). La action corre por el canal service, así que lo
 * que se prueba en los dos es que la barrera (`requirePlatformAdmin("tenant.modules.update")`, high → step-up), el CAS,
 * las validaciones y la regla de dependencias valen igual, y que el consultorio ve el resultado por su propio camino
 * (`getActor` → `assertModule` / `moduleWall`).
 *
 * Símbolos reales: `setTenantModuleOverrides`, `applyTenantEntitlementsInTx`, `getPlatformTenantDetail`,
 * `getPlatformTenantActivity`, `requireModule`, `moduleWall`. Se mockean la sesión de Supabase, `next/headers` y
 * `next/cache` (integration-setup.ts) y `requireStepUp` (la dependencia del step-up: un spy que por default deja pasar;
 * el corte real del step-up está en tests/integration/two-factor.test.ts, «Plataforma»).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

const stepUp = vi.hoisted(() => ({ fn: vi.fn(async (_a: { userId: string }) => {}) }));
vi.mock("@/lib/two-factor-step-up", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/two-factor-step-up")>()),
  requireStepUp: (a: { userId: string }) => stepUp.fn(a),
}));

import { setTenantModuleOverrides } from "@/lib/platform-tenant-modules";
import { MODULE_OVERRIDE_COPY } from "@/lib/platform-tenant-modules-schemas";
import { applyTenantEntitlementsInTx } from "@/lib/tenant-entitlements-internal";
import { ModuleDependencyError } from "@/lib/tenant-module-deps";
import { PLATFORM_ACTION_POLICY } from "@/lib/platform-actor";
import { getPlatformTenantActivity, getPlatformTenantDetail } from "@/lib/platform-tenants-read";
import { requireModule } from "@/lib/authz";
import { moduleWall } from "@/lib/module-wall";
import { MODULE_DENIED_COPY, MODULE_REVOKED_COPY } from "@/lib/tenant-modules";
import { ForbiddenError } from "@/lib/session";
import { StepUpRequiredError } from "@/lib/two-factor-step-up";
import { prismaService } from "@/lib/db";
import { tenantEntitlementTags } from "@/lib/cache-tags";
import { LEGACY_PLAN_OF } from "@/lib/saas-plans-logic";
import { __rateLimitInternals } from "@/lib/rate-limit";
import { revalidatePathSpy, revalidateTagSpy } from "@/tests/helpers/integration-setup";
import { ownerClient, createEphemeralTenant, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";
const DEP_COPY = "Para deshabilitar Planes de tratamiento, deshabilitá también Sesiones y Plantillas de plan.";

describe.skipIf(!RUN)("[AS-1p] módulos a medida desde Plataforma", () => {
  let db: PrismaClient;
  /** Superadmin (su home). */
  let S: EphemeralTenant;
  /** Kine Clínica: el afectado. */
  let B: EphemeralTenant;
  /** General Individual. */
  let G: EphemeralTenant;

  const row = (id: string) =>
    db.tenant.findUniqueOrThrow({ where: { id }, select: { moduleGrants: true, moduleRevokes: true, updatedAt: true, saasPlan: true } });
  const v = async (id: string) => (await row(id)).updatedAt.toISOString();
  const counts = async (tenantId: string) => ({
    local: await db.auditEvent.count({ where: { tenantId, action: "platform.tenant.entitlements" } }),
    global: await db.platformAuditEvent.count({ where: { tenantId, action: "platform.tenant.entitlements" } }),
  });
  /** Deja B sin overrides (cada test arranca de la matriz del plan). */
  const reset = () => db.tenant.update({ where: { id: B.tenantId }, data: { moduleGrants: [], moduleRevokes: [] } });

  beforeAll(async () => {
    db = ownerClient();
    S = await createEphemeralTenant(db);
    await db.userProfile.update({ where: { id: S.userId }, data: { isPlatformAdmin: true } });
    B = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", saasPlan: "CLINICA" });
    G = await createEphemeralTenant(db, { vertical: "GENERAL", saasPlan: "INDIVIDUAL" });
  });
  afterAll(async () => {
    await B?.cleanup();
    await G?.cleanup();
    await S?.cleanup();
    await db?.$disconnect();
  });
  beforeEach(async () => {
    __rateLimitInternals.reset();
    revalidateTagSpy.mockClear();
    revalidatePathSpy.mockClear();
    stepUp.fn.mockReset();
    stepUp.fn.mockImplementation(async () => {});
    await reset();
  });

  it("[AS-1p] la clave es high (pide step-up) y la action la usa: sin step-up fresco → rebota sin escribir", async () => {
    expect(PLATFORM_ACTION_POLICY["tenant.modules.update"].risk).toBe("high");
    asUser(S.userId);
    stepUp.fn.mockImplementation(async () => {
      throw new StepUpRequiredError();
    });
    const before = await counts(B.tenantId);
    const err = await setTenantModuleOverrides({
      tenantId: B.tenantId,
      expectedUpdatedAt: await v(B.tenantId),
      grants: [],
      revokes: ["diagnostico"],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(StepUpRequiredError);
    expect(stepUp.fn).toHaveBeenCalledWith({ userId: S.userId });
    expect((await row(B.tenantId)).moduleRevokes).toEqual([]);
    expect(await counts(B.tenantId)).toEqual(before);
  });

  it("[AS-1p] un OWNER que no es superadmin → Forbidden, sin cambios", async () => {
    asUser(B.userId);
    await expect(
      setTenantModuleOverrides({ tenantId: B.tenantId, expectedUpdatedAt: await v(B.tenantId), grants: [], revokes: ["diagnostico"] })
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect((await row(B.tenantId)).moduleRevokes).toEqual([]);
  });

  it("[AS-1p] deshabilitar Planes con sus dependientes: escribe, audit doble con las listas, revalida; el consultorio ve el muro y el copy de Soporte", async () => {
    asUser(S.userId);
    const before = await counts(B.tenantId);
    const res = await setTenantModuleOverrides({
      tenantId: B.tenantId,
      expectedUpdatedAt: await v(B.tenantId),
      grants: [],
      // Desordenadas a propósito: el escritor guarda la forma canónica (ordenada).
      revokes: ["sesiones", "planes", "plantillas"],
    });
    expect(res).toMatchObject({ ok: true, data: { changed: true } });
    const r = await row(B.tenantId);
    expect(r.moduleRevokes).toEqual(["planes", "plantillas", "sesiones"]);
    expect(r.moduleGrants).toEqual([]);
    if (res.ok) expect(res.data.updatedAt).toBe(r.updatedAt.toISOString());

    // Audit doble en la misma tx: el del consultorio y el global, con las listas antes/después (sin PHI).
    expect(await counts(B.tenantId)).toEqual({ local: before.local + 1, global: before.global + 1 });
    const ev = await db.auditEvent.findFirstOrThrow({
      where: { tenantId: B.tenantId, action: "platform.tenant.entitlements" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    expect(ev.actorId).toBe(S.userId);
    expect(ev.payload).toMatchObject({
      source: "platform",
      changed: ["moduleRevokes"],
      before: { moduleRevokes: [] },
      after: { moduleRevokes: ["planes", "plantillas", "sesiones"] },
    });

    // Revalidate después del commit con los tags de entitlements del consultorio.
    for (const tag of tenantEntitlementTags(B.tenantId)) expect(revalidateTagSpy).toHaveBeenCalledWith(tag);
    expect(revalidatePathSpy).toHaveBeenCalledWith("/plataforma", "layout");

    // El consultorio, por su propio camino: muro «disabled» y el copy de Soporte en las actions.
    asUser(B.userId);
    expect(await moduleWall("planes")).toEqual({ disabled: true });
    expect(await moduleWall("sesiones")).toEqual({ disabled: true });
    expect(await moduleWall("diagnostico")).toBe("ok");
    const denied = await requireModule("planes").catch((e) => e);
    expect(denied).toBeInstanceOf(ForbiddenError);
    expect((denied as Error).message).toBe(MODULE_REVOKED_COPY);
    // Un módulo que el plan no trae y nadie revocó sigue con su copy de siempre.
    asUser(G.userId);
    expect(((await requireModule("salaEspera").catch((e) => e)) as Error).message).toBe(MODULE_DENIED_COPY.salaEspera);

    // Plataforma: el detalle y «Actividad» muestran las listas.
    asUser(S.userId);
    const d = await getPlatformTenantDetail(B.tenantId);
    expect(d?.moduleRevokes).toEqual(["planes", "plantillas", "sesiones"]);
    expect(d?.modules).not.toContain("planes");
    const listPrice = (await db.saasPlanConfig.findUnique({ where: { plan: "CLINICA" }, select: { priceCents: true } }))?.priceCents ?? null;
    expect(d?.price).toEqual({ planPriceCents: listPrice, customPriceCents: null, effectivePriceCents: listPrice });
    // Precio a medida (SaasSubscription, se cambia en Facturación): pisa al de lista.
    await db.saasSubscription.create({ data: { tenantId: B.tenantId, customPriceCents: 3_000_000 } });
    try {
      expect((await getPlatformTenantDetail(B.tenantId))?.price).toEqual({
        planPriceCents: listPrice,
        customPriceCents: 3_000_000,
        effectivePriceCents: 3_000_000,
      });
    } finally {
      await db.saasSubscription.delete({ where: { tenantId: B.tenantId } });
    }
    const act = await getPlatformTenantActivity(B.tenantId);
    const change = act?.events.flatMap((e) => e.changes).find((c) => c.key === "moduleRevokes");
    expect(change).toEqual({ key: "moduleRevokes", before: [], after: ["planes", "plantillas", "sesiones"] });
  });

  it("[AS-1p] mismas listas → no-op: ni UPDATE, ni audit, ni revalidate", async () => {
    asUser(S.userId);
    await db.tenant.update({ where: { id: B.tenantId }, data: { moduleRevokes: ["diagnostico"] } });
    const version = await v(B.tenantId);
    const before = await counts(B.tenantId);
    const res = await setTenantModuleOverrides({ tenantId: B.tenantId, expectedUpdatedAt: version, grants: [], revokes: ["diagnostico"] });
    expect(res).toEqual({ ok: true, data: { updatedAt: version, changed: false } });
    expect(await counts(B.tenantId)).toEqual(before);
    expect(revalidateTagSpy).not.toHaveBeenCalled();
  });

  it("[AS-1p] CAS: con la versión vieja → stale, sin cambios ni audit", async () => {
    asUser(S.userId);
    const old = await v(B.tenantId);
    const ok = await setTenantModuleOverrides({ tenantId: B.tenantId, expectedUpdatedAt: old, grants: [], revokes: ["diagnostico"] });
    expect(ok.ok).toBe(true);
    const before = await counts(B.tenantId);
    const stale = await setTenantModuleOverrides({ tenantId: B.tenantId, expectedUpdatedAt: old, grants: [], revokes: ["evaluaciones"] });
    expect(stale).toEqual({ ok: false, error: MODULE_OVERRIDE_COPY.stale });
    expect((await row(B.tenantId)).moduleRevokes).toEqual(["diagnostico"]);
    expect(await counts(B.tenantId)).toEqual(before);
  });

  it("[AS-1p] núcleo, turnero, otra vertical, cruzado y dependencia colgada → rechazo sin escribir ni auditar", async () => {
    asUser(S.userId);
    const cases: Array<[string, () => Promise<unknown>, string]> = [
      ["núcleo", async () => setTenantModuleOverrides({ tenantId: B.tenantId, expectedUpdatedAt: await v(B.tenantId), grants: [], revokes: ["agenda"] }), MODULE_OVERRIDE_COPY.core],
      ["turnero", async () => setTenantModuleOverrides({ tenantId: B.tenantId, expectedUpdatedAt: await v(B.tenantId), grants: ["turneroPublico"], revokes: [] }), MODULE_OVERRIDE_COPY.turnero],
      ["cruzado", async () => setTenantModuleOverrides({ tenantId: B.tenantId, expectedUpdatedAt: await v(B.tenantId), grants: ["diagnostico"], revokes: ["diagnostico"] }), MODULE_OVERRIDE_COPY.both],
      ["otra vertical", async () => setTenantModuleOverrides({ tenantId: G.tenantId, expectedUpdatedAt: await v(G.tenantId), grants: ["diagnostico"], revokes: [] }), MODULE_OVERRIDE_COPY.vertical],
      ["dependencia colgada", async () => setTenantModuleOverrides({ tenantId: B.tenantId, expectedUpdatedAt: await v(B.tenantId), grants: [], revokes: ["planes"] }), DEP_COPY],
      // Sacar Ejercicios dejando Favoritos y el catálogo global también cuelga.
      [
        "dependencia de Ejercicios",
        async () => setTenantModuleOverrides({ tenantId: B.tenantId, expectedUpdatedAt: await v(B.tenantId), grants: [], revokes: ["ejercicios"] }),
        "Para deshabilitar Ejercicios propios, deshabilitá también Favoritos y Catálogo de la plataforma.",
      ],
    ];
    for (const [name, call, copy] of cases) {
      const beforeB = { row: await row(B.tenantId), audit: await counts(B.tenantId) };
      const beforeG = { row: await row(G.tenantId), audit: await counts(G.tenantId) };
      const res = await call();
      expect(res, name).toEqual({ ok: false, error: copy });
      expect(await row(B.tenantId), name).toEqual(beforeB.row);
      expect(await counts(B.tenantId), name).toEqual(beforeB.audit);
      expect(await row(G.tenantId), name).toEqual(beforeG.row);
      expect(await counts(G.tenantId), name).toEqual(beforeG.audit);
    }
    expect(revalidateTagSpy).not.toHaveBeenCalled();
  });

  it("[AS-1p] el escritor (no solo la action) rechaza la dependencia colgada; un cambio de plan no queda bloqueado por overrides viejos", async () => {
    const actor = { userId: S.userId, email: `${S.userId}@test.local`, homeTenantId: S.tenantId };
    const version = (await row(B.tenantId)).updatedAt;
    await expect(
      prismaService.$transaction((tx) =>
        applyTenantEntitlementsInTx(tx, { tenantId: B.tenantId, source: "platform", patch: { moduleRevokes: ["planes", "sesiones"] }, expectedUpdatedAt: version, actor })
      )
    ).rejects.toBeInstanceOf(ModuleDependencyError);
    expect((await row(B.tenantId)).moduleRevokes).toEqual([]);

    // Overrides consistentes guardados → bajar a Individual (sin tocar las listas) pasa.
    await db.tenant.update({ where: { id: B.tenantId }, data: { moduleRevokes: ["planes", "plantillas", "sesiones"] } });
    const r = await prismaService.$transaction((tx) =>
      applyTenantEntitlementsInTx(tx, { tenantId: B.tenantId, source: "platform", patch: { saasPlan: "INDIVIDUAL" }, actor })
    );
    expect(r).toMatchObject({ ok: true, changed: ["saasPlan"] });
    await db.tenant.update({ where: { id: B.tenantId }, data: { saasPlan: "CLINICA", plan: LEGACY_PLAN_OF.CLINICA } });
  });
});
