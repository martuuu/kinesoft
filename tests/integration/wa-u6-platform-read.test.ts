/**
 * [WA-U6] `getPlatformWhatsAppOverview` contra Postgres real, dos roles (brief §26.5 «Plataforma → WhatsApp, sin
 * teléfonos»). La cuenta y las plantillas las arma el simulador (`connectFakeWhatsApp`); los mensajes se insertan a
 * mano por el canal owner con estados terminales conocidos para afirmar los agregados exactos (el outbox real ya tiene
 * sus tests: acá lo que se prueba es la LECTURA de Plataforma, no la cola).
 *
 * Qué se afirma:
 *  - un no superadmin rebota (ForbiddenError) antes de tocar nada;
 *  - con `WHATSAPP_MODE=off` devuelve solo modo + presencia de variables (que no consulta tablas lo prueba el unit);
 *  - los conteos de 7 días por estado, las plantillas aprobadas/total, los códigos de error más frecuentes y el último
 *    webhook global salen bien;
 *  - en el DTO serializado no aparece ningún teléfono (ni el E.164, ni el displayPhone, ni la máscara de los mensajes),
 *    ni el phoneNumberId, ni el wabaId completo, ni un valor de las variables de Meta.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { ForbiddenError } from "@/lib/session";
import { getPlatformWhatsAppOverview } from "@/lib/platform-whatsapp-read";
import { asUser } from "@/tests/helpers/actor";
import { ownerClient, createEphemeralTenant, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { installFakeGraph, connectFakeWhatsApp, FAKE_WA, FAKE_WA_PHONES, type FakeWhatsAppAccount, type InstalledFakeGraph } from "@/tests/helpers/whatsapp-fake";

const RUN = process.env.INTEGRATION === "1";
const DAY = 24 * 60 * 60 * 1000;
const HASH = "a".repeat(64);
const MASK = "+54 9 11 ****-0100";

describe.skipIf(!RUN)("[WA-U6] getPlatformWhatsAppOverview", () => {
  let db: PrismaClient;
  let superId: string;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let accA: FakeWhatsAppAccount;
  let accB: FakeWhatsAppAccount;
  let fake: InstalledFakeGraph;
  const webhookAt = new Date(Date.now() + 2 * DAY); // en el futuro: el máximo global es este aunque haya otras filas

  async function wipe(t: EphemeralTenant) {
    await db.whatsAppMessage.deleteMany({ where: { tenantId: t.tenantId } });
    await db.whatsAppTemplate.deleteMany({ where: { tenantId: t.tenantId } });
    await db.whatsAppCredential.deleteMany({ where: { tenantId: t.tenantId } });
    await db.whatsAppAccount.deleteMany({ where: { tenantId: t.tenantId } });
  }

  beforeAll(async () => {
    db = ownerClient();
    superId = `test-user-${uniqueSuffix()}`;
    await db.userProfile.create({
      data: { id: superId, email: `${superId}@test.local`, fullName: "Super WA-U6", isPlatformAdmin: true },
    });
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
  });
  afterAll(async () => {
    if (!db) return;
    for (const t of [A, B]) if (t) await wipe(t);
    await A?.cleanup();
    await B?.cleanup();
    await db.userProfile.deleteMany({ where: { id: superId } });
    await db.$disconnect();
  });

  beforeEach(async () => {
    fake = installFakeGraph();
    for (const t of [A, B]) await wipe(t);
    accA = await connectFakeWhatsApp(db, A);
    accB = await connectFakeWhatsApp(db, B, { status: "REAUTH_REQUIRED", templateStatus: "PENDING" });
    await db.whatsAppAccount.update({ where: { id: accA.accountId }, data: { lastWebhookAt: webhookAt, lastErrorCode: "rate_limit:131056" } });

    const now = Date.now();
    let n = 0;
    const msg = (status: string, extra: Record<string, unknown> = {}, ageMs = 60_000) => {
      n++;
      const createdAt = new Date(now - ageMs);
      return {
        tenantId: A.tenantId,
        accountId: accA.accountId,
        kind: "TEST" as const,
        trigger: "MANUAL" as const,
        status: status as never,
        idempotencyKey: `t:wau6-${A.tenantId}-${n}`,
        templateName: "hello_world",
        toHash: HASH,
        toMasked: MASK,
        expiresAt: new Date(now + DAY),
        createdAt,
        ...(["SENT", "DELIVERED", "READ"].includes(status) ? { wamid: `wamid.wau6.${A.tenantId}.${n}`, sentAt: createdAt } : {}),
        ...extra,
      };
    };
    await db.whatsAppMessage.createMany({
      data: [
        msg("READ"),
        msg("READ"),
        msg("DELIVERED"),
        msg("SENT"),
        msg("FAILED", { failedAt: new Date(), errorCode: "rate_limit:131056" }),
        msg("FAILED", { failedAt: new Date(), errorCode: "rate_limit:131056" }),
        msg("FAILED", { failedAt: new Date(), errorCode: "undeliverable:131026" }),
        msg("SKIPPED", { skipReason: "no_consent" }),
        msg("QUEUED"),
        // Fuera de la ventana de 7 días: no cuenta en nada.
        msg("SENT", {}, 8 * DAY),
        msg("FAILED", { failedAt: new Date(), errorCode: "old_error:1" }, 8 * DAY),
      ],
    });
  });
  afterEach(() => {
    fake?.uninstall();
  });

  it("[WA-U6] no superadmin → ForbiddenError", async () => {
    asUser(A.userId);
    await expect(getPlatformWhatsAppOverview()).rejects.toBeInstanceOf(ForbiddenError);
  });

  // «Sin consultar tablas» se afirma en el unit `wa-u6-platform.test.tsx` (prismaService que tira en cualquier acceso):
  // un `vi.spyOn` sobre un delegate de Prisma (proxy) lo rompe para el resto del archivo. Acá, contra la base real con
  // cuentas y mensajes cargados, la forma: solo modo y variables.
  it("[WA-U6] con WHATSAPP_MODE=off devuelve solo modo y variables", async () => {
    process.env.WHATSAPP_MODE = "off";
    asUser(superId);
    const o = await getPlatformWhatsAppOverview();
    expect(o.mode).toBe("off");
    expect(Object.keys(o).sort()).toEqual(["env", "mode"]);
    expect(o.env.map((e) => e.name)).toEqual([
      "WHATSAPP_APP_ID",
      "WHATSAPP_APP_SECRET",
      "WHATSAPP_CONFIG_ID",
      "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
    ]);
  });

  it("[WA-U6] agregados de 7 días, plantillas, errores y último webhook (modo fake)", async () => {
    asUser(superId);
    const o = await getPlatformWhatsAppOverview();
    expect(o.mode).toBe("fake");
    if (o.mode === "off" || !o.stats.available) throw new Error("se esperaba el detalle");
    expect(o.env.every((e) => e.present)).toBe(true);
    expect(o.stats.lastWebhookAt).toBe(webhookAt.toISOString());

    const a = o.stats.accounts.find((r) => r.tenantId === A.tenantId)!;
    expect(a).toMatchObject({
      tenantName: expect.stringMatching(/^Test /),
      status: "ACTIVE",
      qualityRating: "GREEN",
      messagingLimit: "TIER_250",
      templatesApproved: 5,
      templatesTotal: 5,
      lastWebhookAt: webhookAt.toISOString(),
      lastErrorCode: "rate_limit:131056",
      wabaIdTail: accA.wabaId.slice(-4),
      messages7d: { sent: 4, delivered: 3, read: 2, failed: 3, skipped: 1 },
    });
    expect(a.topErrors).toEqual([
      { code: "rate_limit:131056", count: 2 },
      { code: "undeliverable:131026", count: 1 },
    ]);

    const b = o.stats.accounts.find((r) => r.tenantId === B.tenantId)!;
    expect(b).toMatchObject({
      status: "REAUTH_REQUIRED",
      templatesApproved: 0,
      templatesTotal: 5,
      messages7d: { sent: 0, delivered: 0, read: 0, failed: 0, skipped: 0 },
      topErrors: [],
    });
  });

  it("[WA-U6] el DTO no trae teléfonos, ids de número, wabaId completo ni valores de las variables", async () => {
    asUser(superId);
    const json = JSON.stringify(await getPlatformWhatsAppOverview());
    for (const acc of [accA, accB]) {
      expect(json).not.toContain(acc.displayPhone);
      expect(json).not.toContain(acc.phoneNumberId);
      expect(json).not.toContain(acc.wabaId);
      expect(json).not.toContain(acc.token);
    }
    expect(json).not.toContain(MASK);
    expect(json).not.toContain(FAKE_WA_PHONES.ok);
    expect(json).not.toMatch(/displayPhone|phoneNumberId|toMasked|toHash|\+54/);
    for (const v of [FAKE_WA.WHATSAPP_APP_ID, FAKE_WA.WHATSAPP_APP_SECRET, FAKE_WA.WHATSAPP_CONFIG_ID, FAKE_WA.WHATSAPP_WEBHOOK_VERIFY_TOKEN]) {
      expect(json).not.toContain(v);
    }
  });
});
