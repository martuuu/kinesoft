/**
 * BO3-E · `getPlatformSystemStatus` contra Postgres real, dos roles: la lectura de `_prisma_migrations` por el canal
 * service funciona (count > 0 y nombre con forma de migración), el ping es el mismo de /api/health y un no
 * superadmin rebota. La garantía de «sin secretos» está en el unit `platform-system.test.ts` (env marcado).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { ForbiddenError } from "@/lib/session";
import { getPlatformSystemStatus } from "@/lib/platform-system-read";
import { asUser } from "@/tests/helpers/actor";
import { ownerClient, createEphemeralTenant, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { sendEmail } from "@/lib/email/index";
import { emailToHash } from "@/lib/email/log"; // también registra el sink de EmailLog
import { makeEmailFetchFake } from "@/tests/helpers/email-fetch-fake";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("[BO3-E] getPlatformSystemStatus", () => {
  let db: PrismaClient;
  let superId: string;
  let A: EphemeralTenant;

  beforeAll(async () => {
    db = ownerClient();
    superId = `test-user-${uniqueSuffix()}`;
    await db.userProfile.create({
      data: { id: superId, email: `${superId}@test.local`, fullName: "Super BO3E", isPlatformAdmin: true },
    });
    A = await createEphemeralTenant(db);
  });
  afterAll(async () => {
    if (!db) return;
    await A?.cleanup();
    await db.userProfile.deleteMany({ where: { id: superId } });
    await db.$disconnect();
  });

  it("[BO3-E] migraciones aplicadas y base OK", async () => {
    asUser(superId);
    const s = await getPlatformSystemStatus();
    const byKey = Object.fromEntries(s.groups.flatMap((g) => g.checks).map((c) => [c.key, c]));
    expect(byKey.health.state).toBe("ok");
    expect(byKey.migrations.state).toBe("value");
    expect(Number(byKey.migrations.value)).toBeGreaterThan(10);
    expect(byKey.migrations.detail).toMatch(/^Última: \d{14}_[a-z0-9_]+$/);
  });

  it("[OPS-1a] un 403 de Resend queda en EmailLog con el name y sale en «Últimos mails que no salieron» sin el usuario", async () => {
    const domain = `ops1a${uniqueSuffix().toLowerCase().replace(/[^a-z0-9]/g, "")}.test`;
    const to = `juana.perez@${domain}`;
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("RESEND_API_KEY", "re_fake_integration");
    vi.stubEnv("EMAIL_FROM", "KineSoft <no-reply@mail.kinesoft.com.ar>");
    vi.stubGlobal(
      "fetch",
      makeEmailFetchFake({ status: 403, json: { name: "validation_error", message: `The domain is not verified ${to}` } }).fetch
    );
    try {
      const r = await sendEmail({ kind: "password_reset", to, subject: "s", html: '<a href="https://app.kinesoft.com.ar/reset">x</a>', text: "" });
      expect(r).toMatchObject({ ok: false, reason: "provider_error", status: 403, errorName: "validation_error" });
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
    try {
      const row = await db.emailLog.findFirstOrThrow({ where: { toHash: emailToHash(to) } });
      expect(row).toMatchObject({ status: "failed", transport: "resend", reason: "provider_error:validation_error:403" });

      asUser(superId);
      const s = await getPlatformSystemStatus();
      expect(s.emailFailures.available).toBe(true);
      const items = s.emailFailures.available ? s.emailFailures.items : [];
      expect(items.length).toBeLessThanOrEqual(10);
      const mine = items.find((i) => i.recipientDomain === domain);
      expect(mine).toMatchObject({ kind: "password_reset", status: "failed", reason: "provider_error:validation_error:403" });
      expect(mine!.label).toMatch(/dominio/);
      const json = JSON.stringify(s);
      expect(json).not.toContain("juana");
      expect(json).not.toContain("j***");
      expect(json).not.toContain("not verified");
    } finally {
      await db.emailLog.deleteMany({ where: { toHash: emailToHash(to) } });
    }
  });

  it("[BO3-E] no superadmin → ForbiddenError", async () => {
    asUser(A.userId);
    await expect(getPlatformSystemStatus()).rejects.toBeInstanceOf(ForbiddenError);
  });
});
