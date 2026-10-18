/**
 * T3b-1k2 (plan §23.6) · módulos a medida por consultorio (`Tenant.moduleGrants` / `moduleRevokes`, M12), contra
 * Postgres real en los dos roles (`test:integration` = kinesoft_app con RLS; `:owner` = BYPASSRLS = prod).
 *
 * Qué se fija:
 *   - el escritor único (`applyTenantEntitlementsInTx`, source `platform`) escribe las dos listas ordenadas, con CAS y
 *     audit doble (el del consultorio + la fila global `PlatformAuditEvent`); sin cambios reales (mismo contenido en
 *     otro orden) no escribe ni audita;
 *   - rechaza SIN ESCRIBIR (tira: bug del caller, zod ya filtró) la intersección grant ∩ revoke (también contra la
 *     lista guardada), el núcleo, el turnero, módulos de otra vertical, duplicados y claves desconocidas; ninguna otra
 *     source escribe las listas;
 *   - lo leen todas las superficies: `getTenantModulesById` (sin Actor) y `getActor().entitlements` (con Actor), y
 *     `buildActor` las trae en la MISMA sentencia de acceso (0 sentencias nuevas: el escenario de sesión no cambia).
 *
 * El efecto se afirma leyendo con una conexión owner aparte. Se mockea solo lo externo (sesión de Supabase, en
 * integration-setup) y los clientes de `@/lib/db` se instrumentan para contar sentencias (no se reemplaza código).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});

import type { Prisma, PrismaClient } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { runWithRls } from "@/lib/rls";
import { applyTenantEntitlementsInTx, getTenantModulesById } from "@/lib/tenant-entitlements-internal";
import { getActor, ForbiddenError } from "@/lib/session";
import { requireModule } from "@/lib/authz";
import { measure } from "@/tests/helpers/query-counter";
import { asUser, asAnonymous } from "@/tests/helpers/actor";
import { ownerClient, createEphemeralTenant, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import type { TenantModule } from "@/lib/tenant-modules";

const RUN = process.env.INTEGRATION === "1";

const rec = (globalThis as unknown as { __kineQueryRecorder: { events: Array<{ query: string; client: string }> } })
  .__kineQueryRecorder;

describe.skipIf(!RUN)("[AS-1k2] módulos a medida (moduleGrants / moduleRevokes)", () => {
  let db: PrismaClient;
  /** Home del superadmin (actor de /plataforma). */
  let H: EphemeralTenant;
  /** Kine Individual: le falta plantillas (Consultorio) y salas (Clínica). */
  let K: EphemeralTenant;
  /** General Clínica: tiene salas/salaEspera; Diagnóstico no existe en la vertical. */
  let G: EphemeralTenant;

  beforeAll(async () => {
    db = ownerClient();
    H = await createEphemeralTenant(db);
    K = await createEphemeralTenant(db, { saasPlan: "INDIVIDUAL", vertical: "KINESIOLOGY", publicBookingEnabled: false });
    G = await createEphemeralTenant(db, { saasPlan: "CLINICA", vertical: "GENERAL", publicBookingEnabled: false });
  });
  afterAll(async () => {
    asAnonymous();
    await H?.cleanup();
    await K?.cleanup();
    await G?.cleanup();
    await db?.$disconnect();
  });

  const row = (id: string) =>
    db.tenant.findUniqueOrThrow({ where: { id }, select: { moduleGrants: true, moduleRevokes: true, updatedAt: true } });
  const audits = (tenantId: string) =>
    db.auditEvent.findMany({
      where: { tenantId, action: { in: ["tenant.entitlements", "platform.tenant.entitlements"] } },
      orderBy: { createdAt: "asc" },
    });
  const globalRows = (tenantId: string) =>
    db.platformAuditEvent.findMany({ where: { tenantId, action: "platform.tenant.entitlements" }, orderBy: { createdAt: "asc" } });
  const platformActor = () => ({ userId: H.userId, email: null, homeTenantId: H.tenantId });
  /** /plataforma escribe por el canal service: `PlatformAuditEvent` es SERVICE_ONLY. */
  const platformTx = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => prismaService.$transaction(fn);
  const writeModules = (
    tenantId: string,
    patch: { moduleGrants?: TenantModule[]; moduleRevokes?: TenantModule[]; vertical?: "GENERAL" | "KINESIOLOGY" },
    expectedUpdatedAt?: Date
  ) =>
    platformTx((tx) =>
      applyTenantEntitlementsInTx(tx, { tenantId, source: "platform", patch, expectedUpdatedAt, actor: platformActor() })
    );
  const reset = (id: string) => db.tenant.update({ where: { id }, data: { moduleGrants: [], moduleRevokes: [] } });

  it("[AS-1k2] platform escribe las dos listas ordenadas, con CAS y audit doble (consultorio + global)", async () => {
    await reset(K.tenantId);
    const before = await row(K.tenantId);
    const auditsBefore = (await audits(K.tenantId)).length;
    const globalBefore = (await globalRows(K.tenantId)).length;

    const r = await writeModules(
      K.tenantId,
      { moduleGrants: ["salas", "plantillas"], moduleRevokes: ["diagnostico"] },
      before.updatedAt
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changed.sort()).toEqual(["moduleGrants", "moduleRevokes"]);

    const after = await row(K.tenantId);
    expect(after.moduleGrants).toEqual(["plantillas", "salas"]); // normalizada: orden alfabético
    expect(after.moduleRevokes).toEqual(["diagnostico"]);
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    expect(r.updatedAt.getTime()).toBe(after.updatedAt.getTime());

    const ev = (await audits(K.tenantId)).slice(auditsBefore);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ action: "platform.tenant.entitlements", actorId: H.userId, entityId: K.tenantId });
    expect(ev[0].payload).toMatchObject({
      source: "platform",
      before: { moduleGrants: [], moduleRevokes: [] },
      after: { moduleGrants: ["plantillas", "salas"], moduleRevokes: ["diagnostico"] },
    });
    // Nunca en el home del superadmin.
    expect((await db.auditEvent.findMany({ where: { tenantId: H.tenantId, entityId: K.tenantId } })).length).toBe(0);
    const g = (await globalRows(K.tenantId)).slice(globalBefore);
    expect(g).toHaveLength(1);
    expect(g[0].payload).toMatchObject({ after: { moduleGrants: ["plantillas", "salas"], moduleRevokes: ["diagnostico"] } });

    // Lo ve la superficie sin Actor (portal, turnero, ICS).
    const mods = await getTenantModulesById(K.tenantId);
    expect(mods.has("plantillas")).toBe(true);
    expect(mods.has("salas")).toBe(true);
    expect(mods.has("diagnostico")).toBe(false);
    expect(mods.has("agenda")).toBe(true);
  });

  it("[AS-1k2] mismo contenido en otro orden → no-op (ni write ni audit)", async () => {
    const before = await row(K.tenantId);
    const n = (await audits(K.tenantId)).length;
    const r = await writeModules(K.tenantId, { moduleGrants: ["salas", "plantillas"], moduleRevokes: ["diagnostico"] });
    expect(r).toEqual({ ok: true, changed: [], updatedAt: before.updatedAt });
    expect((await row(K.tenantId)).updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect((await audits(K.tenantId)).length).toBe(n);
  });

  it("[AS-1k2] CAS stale: expectedUpdatedAt viejo → stale y nada escrito (ni audit)", async () => {
    const before = await row(K.tenantId);
    const n = (await audits(K.tenantId)).length;
    const r = await writeModules(K.tenantId, { moduleGrants: [] }, new Date(before.updatedAt.getTime() - 1_000));
    expect(r).toEqual({ ok: false, reason: "stale" });
    expect(await row(K.tenantId)).toEqual(before);
    expect((await audits(K.tenantId)).length).toBe(n);
  });

  it("[AS-1k2] rechaza sin escribir: intersección (también contra lo guardado), núcleo, turnero, otra vertical, duplicados, desconocidos", async () => {
    const before = await row(K.tenantId); // grants [plantillas, salas], revokes [diagnostico]
    const n = (await audits(K.tenantId)).length;
    const bad: Array<[string, Parameters<typeof writeModules>[1]]> = [
      ["intersección en el patch", { moduleGrants: ["salas"], moduleRevokes: ["salas"] }],
      ["intersección con el revoke guardado", { moduleGrants: ["diagnostico"] }],
      ["intersección con el grant guardado", { moduleRevokes: ["salas"] }],
      ["núcleo revocado", { moduleRevokes: ["agenda"] }],
      ["núcleo concedido", { moduleGrants: ["pacientes"] }],
      ["turnero", { moduleGrants: ["turneroPublico"] }],
      ["turnero revocado", { moduleRevokes: ["turneroPublico"] }],
      ["duplicado", { moduleGrants: ["salas", "salas"] }],
      ["desconocido", { moduleGrants: ["noexiste" as TenantModule] }],
      ["no es lista", { moduleGrants: "salas" as unknown as TenantModule[] }],
      // Cambiar a General con un grant Kine en el MISMO patch: la vertical final manda.
      ["otra vertical (vertical en el patch)", { vertical: "GENERAL", moduleGrants: ["plantillas"] }],
    ];
    for (const [label, patch] of bad) {
      await expect(writeModules(K.tenantId, patch), label).rejects.toThrow(/\[tenant-entitlements\] (moduleGrants|moduleRevokes)/);
    }
    // General: Diagnóstico no existe en la vertical (ni para conceder ni para revocar).
    await expect(writeModules(G.tenantId, { moduleGrants: ["diagnostico"] })).rejects.toThrow(/no existe en la vertical GENERAL/);
    await expect(writeModules(G.tenantId, { moduleRevokes: ["planes"] })).rejects.toThrow(/no existe en la vertical GENERAL/);
    expect(await row(K.tenantId)).toEqual(before);
    expect((await audits(K.tenantId)).length).toBe(n);
    expect((await row(G.tenantId)).moduleGrants).toEqual([]);
  });

  it("[AS-1k2] ninguna source fuera de platform escribe las listas", async () => {
    const ownerActor = { userId: K.userId, homeTenantId: K.tenantId };
    await expect(
      runWithRls(K.tenantId, (tx) =>
        applyTenantEntitlementsInTx(tx, {
          tenantId: K.tenantId,
          source: "tenant-settings",
          patch: { moduleGrants: ["salas"] } as never,
          actor: ownerActor,
        })
      )
    ).rejects.toThrow(/no puede escribir "moduleGrants"/);
    await expect(
      runWithRls(K.tenantId, (tx) =>
        applyTenantEntitlementsInTx(tx, {
          tenantId: K.tenantId,
          source: "billing",
          patch: { moduleRevokes: ["salas"] } as never,
          actor: null,
        })
      )
    ).rejects.toThrow(/no puede escribir "moduleRevokes"/);
  });

  it("[AS-1k2] getActor() trae los overrides en la misma sentencia de acceso (0 sentencias nuevas) y requireModule los aplica", async () => {
    // Base: sin overrides.
    await reset(K.tenantId);
    asUser(K.userId);
    const { result: plain, m: m0 } = await measure(() => getActor());
    expect(plain.entitlements).toEqual({
      vertical: "KINESIOLOGY",
      plan: "INDIVIDUAL",
      publicBookingEnabled: false,
      moduleGrants: [],
      moduleRevokes: [],
    });

    await db.tenant.update({
      where: { id: K.tenantId },
      data: { moduleGrants: ["salas", "plantillas"], moduleRevokes: ["diagnostico"] },
    });
    const { result: actor, m: m1 } = await measure(() => getActor());
    const access = rec.events.filter((e) => /FROM "UserProfile" u\s/.test(e.query));
    expect(access).toHaveLength(1);
    expect(access[0].query).toMatch(/t\."moduleGrants"/);
    expect(access[0].query).toMatch(/t\."moduleRevokes"/);
    // El escenario de sesión no cambia: mismas sentencias con y sin overrides.
    expect(m1.statements).toBe(m0.statements);
    expect(m1.transactions).toBe(m0.transactions);
    expect(actor.entitlements).toEqual({
      vertical: "KINESIOLOGY",
      plan: "INDIVIDUAL",
      publicBookingEnabled: false,
      moduleGrants: ["plantillas", "salas"],
      moduleRevokes: ["diagnostico"],
    });

    // La barrera de las actions los respeta: el concedido pasa, el revocado no.
    await expect(requireModule("plantillas")).resolves.toMatchObject({ tenantId: K.tenantId });
    await expect(requireModule("salas")).resolves.toMatchObject({ tenantId: K.tenantId });
    await expect(requireModule("diagnostico")).rejects.toBeInstanceOf(ForbiddenError);
    await reset(K.tenantId);
    await expect(requireModule("diagnostico")).resolves.toMatchObject({ tenantId: K.tenantId });
    await expect(requireModule("plantillas")).rejects.toBeInstanceOf(ForbiddenError);
  });
});
