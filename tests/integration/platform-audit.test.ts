/**
 * BO1-B · registro de auditoría de plataforma (C-BO5), contra Postgres real y con
 * los dos roles (`test:integration` = kinesoft_app; `:owner` = BYPASSRLS = prod).
 *
 * Por qué hay DOS filas: `AuditEvent.tenantId` es NOT NULL y el superadmin deja de
 * necesitar un consultorio «casa» (plan §19.5). Cada acción de plataforma sobre un
 * consultorio escribe el `platform.*` en el log de ESE consultorio (lo ve su OWNER)
 * y la fila global `PlatformAuditEvent` (el visor de Plataforma); las acciones sin
 * consultorio (dar superadmin, deshabilitar un usuario) solo la global. Se fija:
 *   - las dos filas en la MISMA tx: si la tx hace rollback, no queda ninguna;
 *   - `idempotencyKey` repetida → no duplica ninguna de las dos y avisa `inserted: false`;
 *   - actor sin email → se toma la foto de `UserProfile`; actor sin usuario (script) → null;
 *   - `auditSecurityEvent`/`auditInTx` estampan `supportSessionId` del contexto del request (PL-A: `audit()` se borró).
 *
 * `PlatformAuditEvent` es SERVICE_ONLY (M7): se escribe por `prismaService`, como
 * lo hace /plataforma. Es solo inserción: la limpieza de las filas globales (sin
 * tenant) de este archivo usa el modo réplica, igual que `deleteTenantDeep`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { runWithRls } from "@/lib/rls";
import { runWithRequestContext, type RequestContext } from "@/lib/request-context";
import { auditSecurityEvent, auditInTx, auditPlatformInTx, auditPlatformGlobalInTx, type PlatformActorRef } from "@/lib/audit";
import { ownerClient, createEphemeralTenant, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("platform audit · doble registro (BO1-B, C-BO5)", () => {
  let db: PrismaClient;
  /** Home del superadmin (su perfil da el email). */
  let S: EphemeralTenant;
  /** Consultorio afectado. */
  let T: EphemeralTenant;
  /** Ids de filas globales (tenantId null) para limpiar al final. */
  const globalIds: string[] = [];

  beforeAll(async () => {
    db = ownerClient();
    S = await createEphemeralTenant(db);
    T = await createEphemeralTenant(db);
  });
  afterAll(async () => {
    if (globalIds.length && db) {
      await db.$transaction([
        db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
        db.$executeRaw`DELETE FROM "PlatformAuditEvent" WHERE "id" = ANY(${globalIds})`,
      ]);
    }
    await S?.cleanup();
    await T?.cleanup();
    await db?.$disconnect();
  });

  const actor = (over: Partial<PlatformActorRef> = {}): PlatformActorRef => ({
    userId: S.userId,
    email: null,
    homeTenantId: S.tenantId,
    ...over,
  });
  const key = () => `test-idem-${uniqueSuffix()}`;
  const platformRows = (where: { idempotencyKey?: string; entityId?: string }) =>
    db.platformAuditEvent.findMany({ where });
  const tenantRows = (entityId: string) => db.auditEvent.findMany({ where: { tenantId: T.tenantId, entityId } });

  it("sobre un consultorio: escribe el AuditEvent del afectado Y la fila global, enlazados", async () => {
    const entityId = `ent-${uniqueSuffix()}`;
    const idem = key();
    const res = await prismaService.$transaction((tx) =>
      auditPlatformInTx(tx, {
        actor: actor(),
        affectedTenantId: T.tenantId,
        action: "platform.tenant.status",
        entity: "Tenant",
        entityId,
        payload: { changed: ["status"], before: { status: "ACTIVE" }, after: { status: "SUSPENDED" } },
        idempotencyKey: idem,
      })
    );
    expect(res.inserted).toBe(true);
    if (!res.inserted) return;

    const profile = await db.userProfile.findUniqueOrThrow({ where: { id: S.userId }, select: { email: true } });
    const [g] = await platformRows({ idempotencyKey: idem });
    expect(g).toMatchObject({
      id: res.platformEventId,
      actorId: S.userId,
      actorEmail: profile.email,
      action: "platform.tenant.status",
      tenantId: T.tenantId,
      targetUserId: null,
      entity: "Tenant",
      entityId,
      idempotencyKey: idem,
    });
    expect(g.payload).toEqual({
      changed: ["status"],
      before: { status: "ACTIVE" },
      after: { status: "SUSPENDED" },
      platform: { actorHomeTenantId: S.tenantId },
    });

    const local = await tenantRows(entityId);
    expect(local).toHaveLength(1);
    expect(local[0]).toMatchObject({ tenantId: T.tenantId, actorId: S.userId, action: "platform.tenant.status", entity: "Tenant" });
    expect(local[0].payload).toEqual({
      changed: ["status"],
      before: { status: "ACTIVE" },
      after: { status: "SUSPENDED" },
      platform: { actorHomeTenantId: S.tenantId, platformEventId: res.platformEventId },
    });
    // Nada en el home del superadmin.
    expect(await db.auditEvent.count({ where: { tenantId: S.tenantId } })).toBe(0);
  });

  it("rollback de la tx → no queda ninguna de las dos filas", async () => {
    const entityId = `ent-${uniqueSuffix()}`;
    const idem = key();
    await expect(
      prismaService.$transaction(async (tx) => {
        await auditPlatformInTx(tx, {
          actor: actor(),
          affectedTenantId: T.tenantId,
          action: "platform.tenant.rollback",
          entity: "Tenant",
          entityId,
          idempotencyKey: idem,
        });
        throw new Error("boom después del audit");
      })
    ).rejects.toThrow(/boom/);
    expect(await platformRows({ idempotencyKey: idem })).toHaveLength(0);
    expect(await tenantRows(entityId)).toHaveLength(0);
  });

  it("idempotencyKey repetida → inserted:false, sin duplicar ninguna fila (la tx sigue viva)", async () => {
    const entityId = `ent-${uniqueSuffix()}`;
    const idem = key();
    const write = () =>
      prismaService.$transaction(async (tx) => {
        const r = await auditPlatformInTx(tx, {
          actor: actor({ email: "foto@test.local" }),
          affectedTenantId: T.tenantId,
          action: "platform.tenant.idem",
          entity: "Tenant",
          entityId,
          idempotencyKey: idem,
        });
        // Un statement más: si el duplicado hubiera abortado la tx (23505), esto tira.
        await tx.tenant.count({ where: { id: T.tenantId } });
        return r;
      });
    const first = await write();
    const second = await write();
    expect(first.inserted).toBe(true);
    expect(second).toEqual({ inserted: false });
    const rows = await platformRows({ idempotencyKey: idem });
    expect(rows).toHaveLength(1);
    // Email explícito: se usa tal cual, sin buscar el perfil.
    expect(rows[0].actorEmail).toBe("foto@test.local");
    expect(await tenantRows(entityId)).toHaveLength(1);
  });

  it("dos txs simultáneas con la misma idempotencyKey → una sola fila (la segunda espera y no inserta)", async () => {
    const entityId = `ent-${uniqueSuffix()}`;
    const idem = key();
    const write = () =>
      prismaService.$transaction((tx) =>
        auditPlatformInTx(tx, {
          actor: actor(),
          affectedTenantId: T.tenantId,
          action: "platform.tenant.race",
          entity: "Tenant",
          entityId,
          idempotencyKey: idem,
        })
      );
    const results = await Promise.all([write(), write()]);
    expect(results.filter((r) => r.inserted)).toHaveLength(1);
    expect(await platformRows({ idempotencyKey: idem })).toHaveLength(1);
    expect(await tenantRows(entityId)).toHaveLength(1);
  });

  it("sin idempotencyKey → cada llamada escribe (NULL no choca en el único)", async () => {
    const entityId = `ent-${uniqueSuffix()}`;
    for (let i = 0; i < 2; i++) {
      const r = await prismaService.$transaction((tx) =>
        auditPlatformInTx(tx, {
          actor: actor(),
          affectedTenantId: T.tenantId,
          action: "platform.tenant.noidem",
          entity: "Tenant",
          entityId,
        })
      );
      expect(r.inserted).toBe(true);
    }
    expect(await platformRows({ entityId })).toHaveLength(2);
    expect(await tenantRows(entityId)).toHaveLength(2);
  });

  it("action sin el prefijo platform. → tira antes de escribir", async () => {
    const entityId = `ent-${uniqueSuffix()}`;
    await expect(
      prismaService.$transaction((tx) =>
        auditPlatformInTx(tx, {
          actor: actor(),
          affectedTenantId: T.tenantId,
          // @ts-expect-error — a propósito: el tipo exige `platform.${string}`.
          action: "tenant.status",
          entity: "Tenant",
          entityId,
        })
      )
    ).rejects.toThrow(/platform\./);
    expect(await platformRows({ entityId })).toHaveLength(0);
  });

  it("global (sin consultorio): solo la fila de plataforma, con targetUserId; actor script sin usuario", async () => {
    const entityId = `ent-${uniqueSuffix()}`;
    const idem = key();
    const auditsBefore = await db.auditEvent.count({ where: { entityId } });
    const res = await prismaService.$transaction((tx) =>
      auditPlatformGlobalInTx(tx, {
        actor: { userId: null, email: null, homeTenantId: null },
        action: "platform.user.disable",
        entity: "UserProfile",
        entityId,
        targetUserId: S.userId,
        payload: { changed: ["disabledAt"] },
        idempotencyKey: idem,
      })
    );
    expect(res.inserted).toBe(true);
    if (res.inserted) globalIds.push(res.platformEventId);
    const [g] = await platformRows({ idempotencyKey: idem });
    expect(g).toMatchObject({
      actorId: null,
      actorEmail: null,
      tenantId: null,
      targetUserId: S.userId,
      action: "platform.user.disable",
      entity: "UserProfile",
      entityId,
    });
    expect(g.payload).toEqual({ changed: ["disabledAt"], platform: { actorHomeTenantId: null } });
    // Ningún AuditEvent: no hay consultorio afectado.
    expect(await db.auditEvent.count({ where: { entityId } })).toBe(auditsBefore);

    // Repetida → no duplica.
    const again = await prismaService.$transaction((tx) =>
      auditPlatformGlobalInTx(tx, {
        actor: { userId: null, email: null, homeTenantId: null },
        action: "platform.user.disable",
        entity: "UserProfile",
        entityId,
        targetUserId: S.userId,
        idempotencyKey: idem,
      })
    );
    expect(again).toEqual({ inserted: false });
    expect(await platformRows({ idempotencyKey: idem })).toHaveLength(1);
  });

  it("global con tenantId de referencia: la fila lo lleva, pero no escribe en el log del consultorio", async () => {
    const entityId = `ent-${uniqueSuffix()}`;
    const res = await prismaService.$transaction((tx) =>
      auditPlatformGlobalInTx(tx, {
        actor: actor(),
        action: "platform.repair.orphan",
        entity: "UserProfile",
        entityId,
        tenantId: T.tenantId,
      })
    );
    expect(res.inserted).toBe(true);
    const [g] = await platformRows({ entityId });
    expect(g).toMatchObject({ tenantId: T.tenantId, actorId: S.userId });
    expect(await tenantRows(entityId)).toHaveLength(0);
  });

  describe("supportSessionId del contexto", () => {
    const ctx = (supportSessionId?: string | null) =>
      ({ tenantId: T.tenantId, userId: S.userId, practitionerId: null, supportSessionId }) as RequestContext;

    it("auditSecurityEvent lo estampa en el payload cuando hay sesión de soporte (y no se puede pisar)", async () => {
      const entityId = `ent-${uniqueSuffix()}`;
      await runWithRequestContext(ctx("ss-123"), () =>
        auditSecurityEvent({
          tenantId: T.tenantId,
          actorId: S.userId,
          action: "patient.export",
          entity: "Tenant",
          entityId,
          payload: { changed: ["phone"], supportSessionId: "pisado" },
        })
      );
      const [row] = await tenantRows(entityId);
      expect(row.payload).toEqual({ changed: ["phone"], supportSessionId: "ss-123" });
    });

    it("[PL-A] auditSecurityEvent rechaza una acción fuera de la allowlist sin escribir", async () => {
      const entityId = `ent-${uniqueSuffix()}`;
      await expect(
        auditSecurityEvent({ tenantId: T.tenantId, action: "patient.update" as never, entity: "Patient", entityId })
      ).rejects.toThrow(/SECURITY_EVENT_ACTIONS/);
      expect(await tenantRows(entityId)).toHaveLength(0);
    });

    it("auditInTx lo estampa también sin payload del caller", async () => {
      const entityId = `ent-${uniqueSuffix()}`;
      await runWithRequestContext(ctx("ss-456"), () =>
        runWithRls(T.tenantId, (tx) =>
          auditInTx(tx, { tenantId: T.tenantId, actorId: S.userId, action: "insurer.create", entity: "Insurer", entityId })
        )
      );
      const [row] = await tenantRows(entityId);
      expect(row.payload).toEqual({ supportSessionId: "ss-456" });
    });

    it("sin sesión de soporte (o sin contexto) el payload queda como lo pasó el caller", async () => {
      const a = `ent-${uniqueSuffix()}`;
      const b = `ent-${uniqueSuffix()}`;
      await runWithRequestContext(ctx(null), () =>
        runWithRls(T.tenantId, (tx) =>
          auditInTx(tx, { tenantId: T.tenantId, action: "x.y", entity: "Tenant", entityId: a, payload: { k: 1 } })
        )
      );
      await runWithRls(T.tenantId, (tx) => auditInTx(tx, { tenantId: T.tenantId, action: "x.y", entity: "Tenant", entityId: b }));
      expect((await tenantRows(a))[0].payload).toEqual({ k: 1 });
      expect((await tenantRows(b))[0].payload).toBeNull();
    });
  });
});
