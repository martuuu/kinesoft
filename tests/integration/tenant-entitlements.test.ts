/**
 * EV0 · EV-C2 — escritor único de entitlements (C-EV5) + audit de plataforma
 * (C-EV6), contra Postgres real y con los dos roles (`test:integration` =
 * kinesoft_app con RLS; `:owner` = BYPASSRLS = prod).
 *
 * Por qué importa: `vertical`, `plan`, `subscriptionStatus`, `trialEndsAt` y
 * `publicBookingEnabled` deciden qué módulos ve un consultorio (y si su turnero
 * acepta reservas). Después de `bootstrapTenant` los escribe SOLO
 * `applyTenantEntitlementsInTx`; acá se fija que:
 *   - el CAS sobre `updatedAt` no pisa un cambio ajeno (stale → nada escrito),
 *     tampoco con dos escritores simultáneos (FOR UPDATE los serializa);
 *   - cada `source` solo toca sus columnas (una key ajena es bug → tira);
 *   - el onboarding solo cambia la vertical mientras el alta siga abierta;
 *   - el audit queda en el tenant AFECTADO, en la misma tx (y nunca en el home
 *     del superadmin); sin cambios no hay audit;
 *   - `getTenantModulesById` (superficies sin Actor) refleja vertical/plan/switch.
 *
 * BO1-B (C-BO6): `platform` además escribe `status` y `seatLimitOverride` (ninguna
 * otra source: `status` suspende o da de baja un consultorio), el escritor estampa
 * `statusChangedAt` / `subscriptionStatusChangedAt` solo cuando el valor cambia de
 * verdad (la gracia de PAST_DUE se cuenta desde ahí, C-BO1), y el audit de
 * plataforma es DOBLE (C-BO5): `platform.tenant.entitlements` en el afectado + la
 * fila global `PlatformAuditEvent`. Como esa tabla es SERVICE_ONLY (M7), la source
 * `platform` corre en una tx del canal service (`platformTx`), igual que
 * `lib/platform-tenants.ts`; las demás, con `runWithRls` del propio consultorio.
 *
 * Se afirma el efecto observable leyendo con una conexión owner aparte.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Prisma, PrismaClient } from "@prisma/client";
import { runWithRls } from "@/lib/rls";
import { prismaService } from "@/lib/db";
import {
  applyTenantEntitlementsInTx,
  getTenantModulesById,
  ENTITLEMENT_KEYS_BY_SOURCE,
} from "@/lib/tenant-entitlements-internal";
import { modulesFor } from "@/lib/tenant-modules";
import { ownerClient, createEphemeralTenant, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("tenant entitlements — escritor único (EV-C2)", () => {
  let db: PrismaClient;
  /** Home del superadmin (actor de /plataforma). */
  let H: EphemeralTenant;
  /** Consultorio afectado. */
  let T: EphemeralTenant;

  beforeAll(async () => {
    db = ownerClient();
    H = await createEphemeralTenant(db);
    T = await createEphemeralTenant(db, { plan: "FREE", vertical: "KINESIOLOGY", publicBookingEnabled: false });
  });
  afterAll(async () => {
    await H?.cleanup();
    await T?.cleanup();
    await db?.$disconnect();
  });

  const row = (id: string) =>
    db.tenant.findUniqueOrThrow({
      where: { id },
      select: {
        vertical: true,
        plan: true,
        subscriptionStatus: true,
        trialEndsAt: true,
        publicBookingEnabled: true,
        updatedAt: true,
      },
    });
  const entAudits = (tenantId: string) =>
    db.auditEvent.findMany({
      where: { tenantId, action: { in: ["tenant.entitlements", "platform.tenant.entitlements"] } },
      orderBy: { createdAt: "asc" },
    });
  const platformActor = () => ({ userId: H.userId, email: null, homeTenantId: H.tenantId });
  /** /plataforma escribe por el canal service: `PlatformAuditEvent` no admite al rol app (SERVICE_ONLY). */
  const platformTx = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => prismaService.$transaction(fn);
  const globalRows = (tenantId: string, action: string) =>
    db.platformAuditEvent.findMany({ where: { tenantId, action }, orderBy: { createdAt: "asc" } });
  const ownerActor = () => ({ userId: T.userId, homeTenantId: T.tenantId });

  it("allowlist literal por source (C-EV5)", () => {
    expect([...ENTITLEMENT_KEYS_BY_SOURCE.platform].sort()).toEqual(
      [
        "plan",
        "publicBookingEnabled",
        "seatLimitOverride",
        "status",
        "statusReason", // BO2-D (handoff BO1-B)
        "subscriptionStatus",
        "trialEndsAt",
        "vertical",
      ].sort()
    );
    expect([...ENTITLEMENT_KEYS_BY_SOURCE.billing].sort()).toEqual(["plan", "subscriptionStatus", "trialEndsAt"].sort());
    expect([...ENTITLEMENT_KEYS_BY_SOURCE.onboarding]).toEqual(["vertical"]);
    expect([...ENTITLEMENT_KEYS_BY_SOURCE["tenant-settings"]]).toEqual(["publicBookingEnabled"]);
  });

  it("CAS stale: expectedUpdatedAt viejo → {ok:false, stale} y nada escrito (ni audit)", async () => {
    const before = await row(T.tenantId);
    const auditsBefore = (await entAudits(T.tenantId)).length;
    const r = await platformTx((tx) =>
      applyTenantEntitlementsInTx(tx, {
        tenantId: T.tenantId,
        source: "platform",
        patch: { plan: "PRO" },
        expectedUpdatedAt: new Date(before.updatedAt.getTime() - 1_000),
        actor: platformActor(),
      })
    );
    expect(r).toEqual({ ok: false, reason: "stale" });
    expect(await row(T.tenantId)).toEqual(before);
    expect((await entAudits(T.tenantId)).length).toBe(auditsBefore);
    expect((await entAudits(H.tenantId)).length).toBe(0);
  });

  it("source tenant-settings intentando `plan` → tira (bug de programación) y no escribe", async () => {
    const before = await row(T.tenantId);
    await expect(
      runWithRls(T.tenantId, (tx) =>
        applyTenantEntitlementsInTx(tx, {
          tenantId: T.tenantId,
          source: "tenant-settings",
          // @ts-expect-error — a propósito: `plan` no está permitido para tenant-settings.
          patch: { plan: "PRO" },
          actor: ownerActor(),
        })
      )
    ).rejects.toThrow(/plan/);
    expect(await row(T.tenantId)).toEqual(before);
  });

  it("source billing intentando `vertical` → tira", async () => {
    await expect(
      runWithRls(T.tenantId, (tx) =>
        applyTenantEntitlementsInTx(tx, {
          tenantId: T.tenantId,
          source: "billing",
          // @ts-expect-error — a propósito: `vertical` no está permitido para billing.
          patch: { vertical: "GENERAL" },
          actor: null,
        })
      )
    ).rejects.toThrow(/vertical/);
  });

  it("tenant-settings con un actor de OTRO consultorio → tira (solo platform cruza tenants)", async () => {
    const before = await row(T.tenantId);
    await expect(
      runWithRls(T.tenantId, (tx) =>
        applyTenantEntitlementsInTx(tx, {
          tenantId: T.tenantId,
          source: "tenant-settings",
          patch: { publicBookingEnabled: true },
          actor: platformActor(),
        })
      )
    ).rejects.toThrow();
    expect(await row(T.tenantId)).toEqual(before);
  });

  it("onboarding con el alta cerrada → onboarding-closed, nada escrito", async () => {
    const before = await row(T.tenantId);
    const r = await runWithRls(T.tenantId, (tx) =>
      applyTenantEntitlementsInTx(tx, {
        tenantId: T.tenantId,
        source: "onboarding",
        patch: { vertical: "GENERAL" },
        actor: ownerActor(),
      })
    );
    expect(r).toEqual({ ok: false, reason: "onboarding-closed" });
    expect(await row(T.tenantId)).toEqual(before);
  });

  it("onboarding con el alta abierta → cambia la vertical y audita tenant.entitlements en el propio tenant", async () => {
    const O = await createEphemeralTenant(db);
    try {
      await db.tenant.update({ where: { id: O.tenantId }, data: { onboardingCompletedAt: null } });
      const r = await runWithRls(O.tenantId, (tx) =>
        applyTenantEntitlementsInTx(tx, {
          tenantId: O.tenantId,
          source: "onboarding",
          patch: { vertical: "GENERAL" },
          actor: { userId: O.userId, homeTenantId: O.tenantId },
        })
      );
      expect(r).toMatchObject({ ok: true, changed: ["vertical"] });
      expect((await row(O.tenantId)).vertical).toBe("GENERAL");
      const audits = await entAudits(O.tenantId);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ action: "tenant.entitlements", actorId: O.userId, entity: "Tenant", entityId: O.tenantId });
      expect(audits[0].payload).toEqual({
        source: "onboarding",
        changed: ["vertical"],
        before: { vertical: "KINESIOLOGY" },
        after: { vertical: "GENERAL" },
      });
    } finally {
      await O.cleanup();
    }
  });

  it("platform, cambio real → escribe, devuelve el updatedAt nuevo y audita en el AFECTADO (ninguno en el home del actor)", async () => {
    const before = await row(T.tenantId);
    const trial = new Date("2026-11-30T03:00:00.000Z");
    const r = await platformTx((tx) =>
      applyTenantEntitlementsInTx(tx, {
        tenantId: T.tenantId,
        source: "platform",
        patch: { vertical: "KINESIOLOGY", plan: "PRO", subscriptionStatus: "TRIALING", trialEndsAt: trial },
        expectedUpdatedAt: before.updatedAt,
        actor: platformActor(),
      })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // `vertical` ya era KINESIOLOGY: no figura como cambio.
    expect([...r.changed].sort()).toEqual(["plan", "subscriptionStatus", "trialEndsAt"]);
    const after = await row(T.tenantId);
    expect(after).toMatchObject({ plan: "PRO", subscriptionStatus: "TRIALING", trialEndsAt: trial, vertical: "KINESIOLOGY" });
    expect(after.updatedAt.getTime()).toBe(r.updatedAt.getTime());
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());

    const audits = await entAudits(T.tenantId);
    const last = audits[audits.length - 1];
    expect(last).toMatchObject({
      tenantId: T.tenantId,
      actorId: H.userId,
      action: "platform.tenant.entitlements",
      entity: "Tenant",
      entityId: T.tenantId,
    });
    expect(last.payload).toEqual({
      source: "platform",
      changed: expect.arrayContaining(["plan", "subscriptionStatus", "trialEndsAt"]),
      before: { plan: "FREE", subscriptionStatus: "ACTIVE", trialEndsAt: null },
      after: { plan: "PRO", subscriptionStatus: "TRIALING", trialEndsAt: trial.toISOString() },
      platform: { actorHomeTenantId: H.tenantId, platformEventId: expect.any(String) },
    });
    expect(await db.auditEvent.count({ where: { tenantId: H.tenantId } })).toBe(0);
    // C-BO5: la fila global, enlazada con la del consultorio.
    const global = (await globalRows(T.tenantId, "platform.tenant.entitlements")).at(-1)!;
    expect(global).toMatchObject({ actorId: H.userId, tenantId: T.tenantId, entity: "Tenant", entityId: T.tenantId });
    expect(global.id).toBe((last.payload as { platform: { platformEventId: string } }).platform.platformEventId);

    // El updatedAt devuelto sirve de expectedUpdatedAt del próximo cambio.
    const r2 = await runWithRls(T.tenantId, (tx) =>
      applyTenantEntitlementsInTx(tx, {
        tenantId: T.tenantId,
        source: "tenant-settings",
        patch: { publicBookingEnabled: true },
        expectedUpdatedAt: r.updatedAt,
        actor: ownerActor(),
      })
    );
    expect(r2).toMatchObject({ ok: true, changed: ["publicBookingEnabled"] });
    const lastOwn = (await entAudits(T.tenantId)).at(-1)!;
    expect(lastOwn).toMatchObject({ action: "tenant.entitlements", actorId: T.userId });
    expect(lastOwn.payload).toEqual({
      source: "tenant-settings",
      changed: ["publicBookingEnabled"],
      before: { publicBookingEnabled: false },
      after: { publicBookingEnabled: true },
    });
  });

  it("sin cambios → ok, changed vacío, mismo updatedAt y sin audit", async () => {
    const before = await row(T.tenantId);
    const n = (await entAudits(T.tenantId)).length;
    const r = await platformTx((tx) =>
      applyTenantEntitlementsInTx(tx, {
        tenantId: T.tenantId,
        source: "platform",
        patch: { plan: before.plan, vertical: before.vertical, trialEndsAt: before.trialEndsAt },
        expectedUpdatedAt: before.updatedAt,
        actor: platformActor(),
      })
    );
    expect(r).toEqual({ ok: true, changed: [], updatedAt: before.updatedAt });
    expect(await row(T.tenantId)).toEqual(before);
    expect((await entAudits(T.tenantId)).length).toBe(n);
  });

  it("billing sin actor (webhook futuro) → audita con actorId null en el tenant", async () => {
    const r = await runWithRls(T.tenantId, (tx) =>
      applyTenantEntitlementsInTx(tx, {
        tenantId: T.tenantId,
        source: "billing",
        patch: { subscriptionStatus: "PAST_DUE" },
        actor: null,
      })
    );
    expect(r).toMatchObject({ ok: true, changed: ["subscriptionStatus"] });
    const last = (await entAudits(T.tenantId)).at(-1)!;
    expect(last).toMatchObject({ action: "tenant.entitlements", actorId: null });
  });

  it("platform sin actor → tira (toda escritura de /plataforma tiene un superadmin)", async () => {
    await expect(
      platformTx((tx) =>
        // @ts-expect-error — a propósito: la source platform exige un PlatformActorRef.
        applyTenantEntitlementsInTx(tx, { tenantId: T.tenantId, source: "platform", patch: { plan: "STARTER" }, actor: null })
      )
    ).rejects.toThrow();
  });

  it("tenant inexistente → not-found", async () => {
    const ghost = `no-existe-${uniqueSuffix()}`;
    const r = await platformTx((tx) =>
      applyTenantEntitlementsInTx(tx, { tenantId: ghost, source: "platform", patch: { plan: "PRO" }, actor: platformActor() })
    );
    expect(r).toEqual({ ok: false, reason: "not-found" });
  });

  it("dos escritores simultáneos con el mismo expectedUpdatedAt → uno gana, el otro stale (FOR UPDATE + CAS)", async () => {
    const before = await row(T.tenantId);
    const attempt = (plan: "STARTER" | "ENTERPRISE") =>
      platformTx((tx) =>
        applyTenantEntitlementsInTx(tx, {
          tenantId: T.tenantId,
          source: "platform",
          patch: { plan },
          expectedUpdatedAt: before.updatedAt,
          actor: platformActor(),
        })
      );
    const [a, b] = await Promise.all([attempt("STARTER"), attempt("ENTERPRISE")]);
    const oks = [a, b].filter((x) => x.ok);
    const stales = [a, b].filter((x) => !x.ok && x.reason === "stale");
    expect(oks).toHaveLength(1);
    expect(stales).toHaveLength(1);
    const winner = a.ok ? "STARTER" : "ENTERPRISE";
    expect((await row(T.tenantId)).plan).toBe(winner);
  });

  // ── BO1-B (C-BO6): status, cupos y fechas derivadas ─────────────────────────
  describe("BO1-B · status, seatLimitOverride y fechas derivadas", () => {
    let X: EphemeralTenant;
    beforeAll(async () => {
      X = await createEphemeralTenant(db, { plan: "PRO" });
    });
    afterAll(async () => {
      await X?.cleanup();
    });
    const xRow = () =>
      db.tenant.findUniqueOrThrow({
        where: { id: X.tenantId },
        select: {
          status: true,
          statusChangedAt: true,
          subscriptionStatus: true,
          subscriptionStatusChangedAt: true,
          seatLimitOverride: true,
          updatedAt: true,
        },
      });

    it.each(["onboarding", "tenant-settings", "billing"] as const)(
      "status desde %s → tira (bug de programación) y no escribe",
      async (source) => {
        if (source === "onboarding") await db.tenant.update({ where: { id: X.tenantId }, data: { onboardingCompletedAt: null } });
        const before = await xRow();
        try {
          await expect(
            runWithRls(X.tenantId, (tx) =>
              applyTenantEntitlementsInTx(tx, {
                tenantId: X.tenantId,
                source,
                // @ts-expect-error — a propósito: `status` es solo de la source platform.
                patch: { status: "SUSPENDED" },
                actor: source === "billing" ? null : { userId: X.userId, homeTenantId: X.tenantId },
              })
            )
          ).rejects.toThrow(/status/);
          expect(await xRow()).toEqual(before);
        } finally {
          if (source === "onboarding") await db.tenant.update({ where: { id: X.tenantId }, data: { onboardingCompletedAt: new Date() } });
        }
      }
    );

    it("seatLimitOverride desde tenant-settings o billing → tira", async () => {
      for (const source of ["tenant-settings", "billing"] as const) {
        await expect(
          runWithRls(X.tenantId, (tx) =>
            applyTenantEntitlementsInTx(tx, {
              tenantId: X.tenantId,
              source,
              // @ts-expect-error — a propósito: los cupos son solo de la source platform.
              patch: { seatLimitOverride: 50 },
              actor: source === "billing" ? null : { userId: X.userId, homeTenantId: X.tenantId },
            })
          )
        ).rejects.toThrow(/seatLimitOverride/);
      }
    });

    it("seatLimitOverride inválido (0, decimal, string) → tira antes de tocar la base", async () => {
      for (const bad of [0, 1.5, "3"]) {
        await expect(
          platformTx((tx) =>
            applyTenantEntitlementsInTx(tx, {
              tenantId: X.tenantId,
              source: "platform",
              patch: { seatLimitOverride: bad as number },
              actor: platformActor(),
            })
          )
        ).rejects.toThrow(/seatLimitOverride/);
      }
      await expect(
        platformTx((tx) =>
          applyTenantEntitlementsInTx(tx, {
            tenantId: X.tenantId,
            source: "platform",
            patch: { status: "BORRADO" as "CLOSED" },
            actor: platformActor(),
          })
        )
      ).rejects.toThrow(/status/);
    });

    it("platform suspende y fija cupo: estampa statusChangedAt, no toca subscriptionStatusChangedAt, audita doble", async () => {
      const before = await xRow();
      expect(before).toMatchObject({ status: "ACTIVE", statusChangedAt: null, seatLimitOverride: null });
      const r = await platformTx((tx) =>
        applyTenantEntitlementsInTx(tx, {
          tenantId: X.tenantId,
          source: "platform",
          patch: { status: "SUSPENDED", seatLimitOverride: 25 },
          expectedUpdatedAt: before.updatedAt,
          // Superadmin sin consultorio «casa» (C-BO2): homeTenantId null.
          actor: { userId: H.userId, email: null, homeTenantId: null },
        })
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect([...r.changed].sort()).toEqual(["seatLimitOverride", "status"]);
      const after = await xRow();
      expect(after).toMatchObject({ status: "SUSPENDED", seatLimitOverride: 25, subscriptionStatusChangedAt: null });
      // Mismo instante que el updatedAt de la escritura.
      expect(after.statusChangedAt?.getTime()).toBe(r.updatedAt.getTime());

      const local = (await entAudits(X.tenantId)).at(-1)!;
      expect(local).toMatchObject({ action: "platform.tenant.entitlements", actorId: H.userId });
      expect(local.payload).toEqual({
        source: "platform",
        changed: expect.arrayContaining(["status", "seatLimitOverride"]),
        before: { status: "ACTIVE", seatLimitOverride: null },
        after: { status: "SUSPENDED", seatLimitOverride: 25 },
        platform: { actorHomeTenantId: null, platformEventId: expect.any(String) },
      });
      const global = (await globalRows(X.tenantId, "platform.tenant.entitlements")).at(-1)!;
      expect(global).toMatchObject({ actorId: H.userId, tenantId: X.tenantId });
      expect(global.payload).toMatchObject({ after: { status: "SUSPENDED", seatLimitOverride: 25 } });
    });

    it("cambio sin efecto en status → no mueve statusChangedAt; cambio de suscripción → estampa subscriptionStatusChangedAt", async () => {
      const before = await xRow();
      const noop = await platformTx((tx) =>
        applyTenantEntitlementsInTx(tx, {
          tenantId: X.tenantId,
          source: "platform",
          patch: { status: before.status, subscriptionStatus: before.subscriptionStatus },
          actor: platformActor(),
        })
      );
      expect(noop).toEqual({ ok: true, changed: [], updatedAt: before.updatedAt });
      expect(await xRow()).toEqual(before);

      // Otro campo cambia, status repetido: statusChangedAt queda como estaba.
      const r = await platformTx((tx) =>
        applyTenantEntitlementsInTx(tx, {
          tenantId: X.tenantId,
          source: "platform",
          patch: { status: before.status, seatLimitOverride: null },
          actor: platformActor(),
        })
      );
      expect(r).toMatchObject({ ok: true, changed: ["seatLimitOverride"] });
      const mid = await xRow();
      expect(mid.statusChangedAt?.getTime()).toBe(before.statusChangedAt?.getTime());
      expect(mid.seatLimitOverride).toBeNull();

      // billing (webhook) cambia la suscripción: estampa su fecha, no la del status.
      const b = await runWithRls(X.tenantId, (tx) =>
        applyTenantEntitlementsInTx(tx, {
          tenantId: X.tenantId,
          source: "billing",
          patch: { subscriptionStatus: "PAST_DUE" },
          actor: null,
        })
      );
      expect(b.ok).toBe(true);
      if (!b.ok) return;
      const after = await xRow();
      expect(after.subscriptionStatus).toBe("PAST_DUE");
      expect(after.subscriptionStatusChangedAt?.getTime()).toBe(b.updatedAt.getTime());
      expect(after.statusChangedAt?.getTime()).toBe(before.statusChangedAt?.getTime());

      // Repetir PAST_DUE no reinicia la gracia (C-BO1 cuenta desde subscriptionStatusChangedAt).
      await runWithRls(X.tenantId, (tx) =>
        applyTenantEntitlementsInTx(tx, { tenantId: X.tenantId, source: "billing", patch: { subscriptionStatus: "PAST_DUE" }, actor: null })
      );
      expect((await xRow()).subscriptionStatusChangedAt?.getTime()).toBe(b.updatedAt.getTime());
    });

    it("CAS stale con status → rechaza sin escribir ni auditar en ningún registro", async () => {
      const before = await xRow();
      const nLocal = (await entAudits(X.tenantId)).length;
      const nGlobal = (await globalRows(X.tenantId, "platform.tenant.entitlements")).length;
      const r = await platformTx((tx) =>
        applyTenantEntitlementsInTx(tx, {
          tenantId: X.tenantId,
          source: "platform",
          patch: { status: "CLOSED" },
          expectedUpdatedAt: new Date(before.updatedAt.getTime() - 1_000),
          actor: platformActor(),
        })
      );
      expect(r).toEqual({ ok: false, reason: "stale" });
      expect(await xRow()).toEqual(before);
      expect((await entAudits(X.tenantId)).length).toBe(nLocal);
      expect((await globalRows(X.tenantId, "platform.tenant.entitlements")).length).toBe(nGlobal);
    });

    it("platform bajo el rol app (runWithRls) no deja nada a medias: el registro global es SERVICE_ONLY", async () => {
      // Solo tiene sentido con kinesoft_app; con :owner (BYPASSRLS) el insert pasa.
      if (process.env.DATABASE_URL === process.env.DIRECT_URL) return;
      const before = await xRow();
      await expect(
        runWithRls(X.tenantId, (tx) =>
          applyTenantEntitlementsInTx(tx, {
            tenantId: X.tenantId,
            source: "platform",
            patch: { status: "ACTIVE" },
            actor: platformActor(),
          })
        )
      ).rejects.toThrow();
      // La tx entera hizo rollback: ni el status ni el audit del consultorio.
      expect(await xRow()).toEqual(before);
    });
  });

  // Ejecuta `modulesFor` de EV-C1 (misma ola): post-integración si C1 no terminó.
  it("getTenantModulesById refleja vertical, plan y switch del turnero", async () => {
    const G = await createEphemeralTenant(db, { vertical: "GENERAL", plan: "PRO", publicBookingEnabled: false });
    const P = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "PRO", publicBookingEnabled: true });
    const F = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "FREE", publicBookingEnabled: true });
    try {
      const g = await getTenantModulesById(G.tenantId);
      const p = await getTenantModulesById(P.tenantId);
      const f = await getTenantModulesById(F.tenantId);
      expect([...g].sort()).toEqual(
        [...modulesFor({ vertical: "GENERAL", plan: "PRO", publicBookingEnabled: false })].sort()
      );
      expect(g.has("agenda")).toBe(true);
      expect(g.has("planes")).toBe(false);
      expect(g.has("turneroPublico")).toBe(false);
      expect(p.has("ejerciciosGlobales")).toBe(true);
      expect(p.has("turneroPublico")).toBe(true);
      expect(f.has("planes")).toBe(true);
      expect(f.has("ejerciciosGlobales")).toBe(false);

      // Tras un cambio por el escritor único, la lectura sin Actor lo ve.
      await platformTx((tx) =>
        applyTenantEntitlementsInTx(tx, {
          tenantId: G.tenantId,
          source: "platform",
          patch: { vertical: "KINESIOLOGY", publicBookingEnabled: true },
          actor: platformActor(),
        })
      );
      const g2 = await getTenantModulesById(G.tenantId);
      expect(g2.has("planes")).toBe(true);
      expect(g2.has("turneroPublico")).toBe(true);

      expect((await getTenantModulesById(`no-existe-${uniqueSuffix()}`)).size).toBe(0);
    } finally {
      await G.cleanup();
      await P.cleanup();
      await F.cleanup();
    }
  });
});
