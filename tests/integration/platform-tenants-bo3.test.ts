/**
 * BO3-B — lo que la UI de Plataforma suma al server de /plataforma consultorios, contra Postgres real y con los dos
 * roles (`test:integration` = kinesoft_app; `:owner` = BYPASSRLS = prod):
 *   - `getPlatformTenantActivity`: guard (`ForbiddenError` para un OWNER no superadmin), solo eventos `platform.*`
 *     del consultorio pedido, del más nuevo al más viejo, paginado con cursor sin repetir ni saltear, cursor ajeno
 *     o mal formado = desde el principio, DTO allowlist (las claves del payload sin sus valores);
 *   - `getPlatformOverview().byStatus`: conteo por estado del consultorio que suma el total;
 *   - `updatePlatformTenant` con `seatLimitOverride`: escribe, audita como número, null vuelve al del plan, 0 rebota
 *     sin escribir.
 *
 * Se llaman los símbolos reales (solo se mockean la sesión de Supabase, `next/headers` y `next/cache`; ver
 * integration-setup.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { updatePlatformTenant } from "@/lib/platform-tenants";
import { getPlatformOverview, getPlatformTenantActivity } from "@/lib/platform-tenants-read";
import { PLATFORM_ACTIVITY_PAGE_SIZE } from "@/lib/platform-tenants-types";
import { ForbiddenError } from "@/lib/session";
import { ownerClient, createEphemeralTenant, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";
const FREE_TEXT = "Zqxtextolibre";
const EVENT_KEYS = ["action", "actorEmail", "changes", "createdAt", "id", "payloadKeys"];
const keysOf = (o: object) => Object.keys(o).sort();

describe.skipIf(!RUN)("platform-tenants · BO3-B (actividad, por estado, cupo a medida)", () => {
  let db: PrismaClient;
  /** Superadmin. */
  let S: EphemeralTenant;
  /** OWNER sin superadmin. */
  let A: EphemeralTenant;
  /** Consultorio con actividad. */
  let B: EphemeralTenant;
  let Susp: EphemeralTenant;
  let Closed: EphemeralTenant;
  const TOTAL = PLATFORM_ACTIVITY_PAGE_SIZE + 5;

  beforeAll(async () => {
    db = ownerClient();
    S = await createEphemeralTenant(db);
    await db.userProfile.update({ where: { id: S.userId }, data: { isPlatformAdmin: true } });
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
    Susp = await createEphemeralTenant(db, { status: "SUSPENDED" });
    Closed = await createEphemeralTenant(db, { status: "CLOSED" });

    // Fixture directa (no es el código bajo test): TOTAL eventos platform.* en B con fechas distintas, uno con texto
    // libre en el payload, más ruido que no tiene que salir (evento propio del consultorio y platform.* de A).
    const t0 = Date.now() - 10 * 86_400_000;
    await db.auditEvent.createMany({
      data: Array.from({ length: TOTAL }, (_, i) => ({
        tenantId: B.tenantId,
        actorId: S.userId,
        action: i === 0 ? "platform.support.start" : "platform.tenant.entitlements",
        entity: "Tenant",
        entityId: B.tenantId,
        payload:
          i === 0
            ? { scope: "ADMIN_CONFIG", note: `${FREE_TEXT} libre` }
            : { changed: ["plan"], before: { plan: "FREE" }, after: { plan: "PRO" } },
        createdAt: new Date(t0 + i * 60_000),
      })),
    });
    await db.auditEvent.create({
      data: { tenantId: B.tenantId, actorId: B.userId, action: "patient.read", entity: "Patient", entityId: "p1" },
    });
    await db.auditEvent.create({
      data: { tenantId: A.tenantId, actorId: S.userId, action: "platform.tenant.profile", entity: "Tenant", payload: {} },
    });
  });

  afterAll(async () => {
    for (const t of [A, B, Susp, Closed, S]) await t?.cleanup();
    await db?.$disconnect();
  });

  it("OWNER no superadmin: Forbidden en la actividad", async () => {
    asUser(A.userId);
    const err = await getPlatformTenantActivity(B.tenantId).then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(ForbiddenError);
  });

  it("actividad: solo platform.* de B, más nuevo primero, cursor sin repetir ni saltear, sin valores del payload", async () => {
    asUser(S.userId);
    const p1 = await getPlatformTenantActivity(B.tenantId);
    expect(p1).not.toBeNull();
    expect(p1!.events).toHaveLength(PLATFORM_ACTIVITY_PAGE_SIZE);
    expect(p1!.nextCursor).toBe(p1!.events[p1!.events.length - 1].id);
    const p2 = await getPlatformTenantActivity(B.tenantId, p1!.nextCursor);
    expect(p2!.events).toHaveLength(TOTAL - PLATFORM_ACTIVITY_PAGE_SIZE);
    expect(p2!.nextCursor).toBeNull();

    const all = [...p1!.events, ...p2!.events];
    expect(new Set(all.map((e) => e.id)).size).toBe(TOTAL);
    for (const e of all) {
      expect(keysOf(e)).toEqual(EVENT_KEYS);
      expect(e.action.startsWith("platform.")).toBe(true);
      expect(e.actorEmail).toBe(`${S.userId}@test.local`);
    }
    const times = all.map((e) => Date.parse(e.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    const support = all.find((e) => e.action === "platform.support.start")!;
    expect(support.payloadKeys).toEqual(["note", "scope"]);
    expect(support.changes).toEqual([]);
    const ent = all.find((e) => e.action === "platform.tenant.entitlements")!;
    expect(ent.changes).toEqual([{ key: "plan", before: "FREE", after: "PRO" }]);
    expect(JSON.stringify(all)).not.toContain(FREE_TEXT);
  });

  it("cursor ajeno o mal formado arranca de cero; consultorio inexistente = null", async () => {
    asUser(S.userId);
    const first = await getPlatformTenantActivity(B.tenantId);
    const foreign = await db.auditEvent.findFirstOrThrow({ where: { tenantId: A.tenantId, action: { startsWith: "platform." } } });
    expect((await getPlatformTenantActivity(B.tenantId, foreign.id))!.events.map((e) => e.id)).toEqual(
      first!.events.map((e) => e.id)
    );
    expect((await getPlatformTenantActivity(B.tenantId, "'; DROP TABLE x"))!.events[0].id).toBe(first!.events[0].id);
    expect(await getPlatformTenantActivity("no-existe-bo3")).toBeNull();
  });

  it("resumen: byStatus con los tres estados y que suma el total", async () => {
    asUser(S.userId);
    const o = await getPlatformOverview();
    expect(keysOf(o.byStatus)).toEqual(["ACTIVE", "CLOSED", "SUSPENDED"]);
    expect(o.byStatus.SUSPENDED).toBeGreaterThanOrEqual(1);
    expect(o.byStatus.CLOSED).toBeGreaterThanOrEqual(1);
    expect(o.byStatus.ACTIVE + o.byStatus.SUSPENDED + o.byStatus.CLOSED).toBe(o.totalTenants);
  });

  it("cupo a medida: escribe y audita como número; null vuelve al del plan; 0 rebota sin escribir", async () => {
    asUser(S.userId);
    const row = () => db.tenant.findUniqueOrThrow({ where: { id: B.tenantId }, select: { seatLimitOverride: true, updatedAt: true } });
    const before = await row();
    const res = await updatePlatformTenant({
      tenantId: B.tenantId,
      expectedUpdatedAt: before.updatedAt.toISOString(),
      seatLimitOverride: 7,
    });
    expect(res.ok).toBe(true);
    const after = await row();
    expect(after.seatLimitOverride).toBe(7);
    const ev = await db.auditEvent.findFirstOrThrow({
      where: { tenantId: B.tenantId, action: "platform.tenant.entitlements", actorId: S.userId },
      orderBy: { createdAt: "desc" },
    });
    expect(ev.payload).toMatchObject({ changed: ["seatLimitOverride"], after: { seatLimitOverride: 7 } });

    const bad = await updatePlatformTenant({
      tenantId: B.tenantId,
      expectedUpdatedAt: after.updatedAt.toISOString(),
      seatLimitOverride: 0,
    });
    expect(bad.ok).toBe(false);
    expect((await row()).seatLimitOverride).toBe(7);

    const cleared = await updatePlatformTenant({
      tenantId: B.tenantId,
      expectedUpdatedAt: after.updatedAt.toISOString(),
      seatLimitOverride: null,
    });
    expect(cleared.ok).toBe(true);
    expect((await row()).seatLimitOverride).toBeNull();
  });
});
