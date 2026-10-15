/**
 * [PL-3c] `countPriceNoticeRecipients` (lib/platform-billing-read.ts) contra Postgres en los dos roles: el aviso del
 * editor de /plataforma/precios («N consultorios reciben mail») cuenta con el MISMO criterio que la etapa de mails del
 * cron (`runSaasBilling`): activos, no cancelados, sin precio a medida (sin fila de suscripción también cuenta).
 * Símbolos reales (`requirePlatformAdmin`, `prismaService`). La base es compartida: se mide el delta antes/después
 * (la suite de integración corre en serie, `fileParallelism: false`).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { ForbiddenError } from "@/lib/session";
import { countPriceNoticeRecipients } from "@/lib/platform-billing-read";
import { asUser } from "@/tests/helpers/actor";
import { ownerClient, createEphemeralTenant, type EphemeralTenant } from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("[PL-3c] Plataforma → Precios: destinatarios del aviso", () => {
  let db: PrismaClient;
  let S: EphemeralTenant;
  const extra: EphemeralTenant[] = [];

  beforeAll(async () => {
    db = ownerClient();
    S = await createEphemeralTenant(db);
    await db.userProfile.update({ where: { id: S.userId }, data: { isPlatformAdmin: true } });
  });

  afterAll(async () => {
    for (const t of extra) await t.cleanup();
    await S?.cleanup();
    await db?.$disconnect();
  });

  it("sin superadmin → 403", async () => {
    const T = await createEphemeralTenant(db);
    extra.push(T);
    asUser(T.userId);
    await expect(countPriceNoticeRecipients()).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("cuenta activos no cancelados sin precio a medida, por plan", async () => {
    asUser(S.userId);
    const before = await countPriceNoticeRecipients();

    const listed = await createEphemeralTenant(db, { saasPlan: "CLINICA" }); // sin suscripción → cuenta
    const listedWithSub = await createEphemeralTenant(db, { saasPlan: "CLINICA" }); // suscripción sin precio a medida → cuenta
    const custom = await createEphemeralTenant(db, { saasPlan: "CLINICA" }); // precio a medida → no
    const cancelled = await createEphemeralTenant(db, { saasPlan: "CLINICA" }); // cancelada → no
    const suspended = await createEphemeralTenant(db, { saasPlan: "CLINICA" }); // suspendido → no
    const other = await createEphemeralTenant(db, { saasPlan: "LIBRE" }); // otro plan
    extra.push(listed, listedWithSub, custom, cancelled, suspended, other);
    await db.saasSubscription.create({ data: { tenantId: listedWithSub.tenantId, anchorDay: 5, customPriceCents: null } });
    await db.saasSubscription.create({ data: { tenantId: custom.tenantId, anchorDay: 5, customPriceCents: 3_000_000 } });
    await db.tenant.update({ where: { id: cancelled.tenantId }, data: { subscriptionStatus: "CANCELLED" } });
    await db.tenant.update({ where: { id: suspended.tenantId }, data: { status: "SUSPENDED" } });

    const after = await countPriceNoticeRecipients();
    expect(after.CLINICA - before.CLINICA).toBe(2);
    expect(after.LIBRE - before.LIBRE).toBe(1);
    expect(after.INDIVIDUAL - before.INDIVIDUAL).toBe(0);
    expect(after.CONSULTORIO - before.CONSULTORIO).toBe(0);
  });
});
