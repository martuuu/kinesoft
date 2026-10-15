/**
 * BO3-E · /plataforma/sistema NO filtra secretos (plan §19.5: «presencia, nunca valores»).
 *
 * Dos capas, las dos con valores MARCADOS (`SECRETO-…`) que no pueden aparecer en ningún lado del DTO:
 *  1. el builder puro `buildSystemStatus`;
 *  2. el export real `getPlatformSystemStatus` con `process.env` seteado (lee por `lib/env.ts`, que se congela al
 *     importar: por eso `vi.resetModules()` + import dinámico después de `vi.stubEnv`). Se mockean la sesión
 *     (`requirePlatformAdmin`), la base (`prismaService.$queryRaw`) y el ping; nunca la función bajo test.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { buildSystemStatus, type SystemConfigInput } from "@/lib/platform-system-logic";

const MARKED: Required<SystemConfigInput> = {
  RESEND_API_KEY: "re_SECRETO-RESEND-1234567890",
  EMAIL_FROM: "KineSoft <SECRETO-from@mail.ejemplo.com>",
  UPSTASH_REDIS_REST_URL: "https://SECRETO-upstash.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "SECRETO-UPSTASH-TOKEN",
  SENTRY_DSN: "https://SECRETO-sentry@o1.ingest.sentry.io/1",
  MP_ACCESS_TOKEN: "APP_USR-SECRETO-MP-TOKEN",
  MP_PUBLIC_KEY: "APP_USR-SECRETO-MP-PUBLIC",
  MP_WEBHOOK_SECRET: "SECRETO-MP-WEBHOOK",
  REALTIME_DRIVER: "supabase",
  TENANT_ACCESS_ENFORCEMENT: "enforce",
  CRON_SECRET: "SECRETO-CRON",
  NEXT_PUBLIC_APP_URL: "https://SECRETO-app.kinesoft.com.ar",
  VERCEL_ENV: "production",
};

const allChecks = (s: ReturnType<typeof buildSystemStatus>) => s.groups.flatMap((g) => g.checks);

describe("[BO3-E] buildSystemStatus · presencia sin valores", () => {
  it("con todo cargado: ningún valor marcado aparece; los secretos salen «ok» sin valor", () => {
    const s = buildSystemStatus(MARKED, { available: true, applied: 120, last: "20261014120000_platform_backoffice" }, { up: true, ms: 4 });
    const json = JSON.stringify(s);
    expect(json).not.toMatch(/SECRETO/);
    expect(json).not.toContain("kinesoft.com.ar");
    const byKey = Object.fromEntries(allChecks(s).map((c) => [c.key, c]));
    for (const k of ["RESEND_API_KEY", "EMAIL_FROM", "UPSTASH_REDIS_REST_TOKEN", "SENTRY_DSN", "MP_ACCESS_TOKEN", "MP_WEBHOOK_SECRET", "CRON_SECRET"]) {
      expect(byKey[k], k).toMatchObject({ state: "ok", value: null });
    }
    expect(byKey.REALTIME_DRIVER).toMatchObject({ state: "value", value: "supabase" });
    expect(byKey.TENANT_ACCESS_ENFORCEMENT).toMatchObject({ state: "value", value: "enforce" });
    expect(byKey.VERCEL_ENV).toMatchObject({ value: "production" });
    expect(byKey.NEXT_PUBLIC_APP_URL).toMatchObject({ state: "ok", value: "pública" });
    expect(byKey.migrations).toMatchObject({ value: "120", detail: "Última: 20261014120000_platform_backoffice" });
    expect(byKey.health).toMatchObject({ state: "ok" });
  });

  it("un secreto pegado en una variable de enum sale «inválido», no tal cual", () => {
    const s = buildSystemStatus(
      { REALTIME_DRIVER: "SECRETO-pegado", TENANT_ACCESS_ENFORCEMENT: "SECRETO-otro", VERCEL_ENV: "SECRETO-env" },
      { available: true, applied: 1, last: "SECRETO; DROP" },
      { up: false, ms: 2000 }
    );
    expect(JSON.stringify(s)).not.toMatch(/SECRETO/);
    const byKey = Object.fromEntries(allChecks(s).map((c) => [c.key, c]));
    expect(byKey.REALTIME_DRIVER).toMatchObject({ state: "warn", value: "inválido" });
    expect(byKey.TENANT_ACCESS_ENFORCEMENT).toMatchObject({ state: "warn", value: "inválido" });
    expect(byKey.health).toMatchObject({ state: "missing", value: "caída" });
  });

  it("vacío: todo «Falta», defaults de enums, localhost avisado; MP con token y sin secreto → falta el secreto", () => {
    const s = buildSystemStatus({ MP_ACCESS_TOKEN: "x", NEXT_PUBLIC_APP_URL: "http://localhost:3000" }, { available: false }, { up: true, ms: 1 });
    const byKey = Object.fromEntries(allChecks(s).map((c) => [c.key, c]));
    expect(byKey.RESEND_API_KEY.state).toBe("missing");
    expect(byKey.CRON_SECRET.state).toBe("missing");
    expect(byKey.REALTIME_DRIVER.value).toBe("off");
    expect(byKey.TENANT_ACCESS_ENFORCEMENT.value).toBe("banner");
    expect(byKey.VERCEL_ENV.value).toBe("local");
    expect(byKey.NEXT_PUBLIC_APP_URL).toMatchObject({ state: "warn", value: "localhost" });
    expect(byKey.MP_WEBHOOK_SECRET.state).toBe("missing");
    expect(byKey.MP_WEBHOOK_SECRET.detail).toMatch(/503/);
    expect(byKey.migrations.state).toBe("warn");
  });
});

describe("[BO3-E] getPlatformSystemStatus · el export real con env marcado", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.doUnmock("@/lib/platform-actor");
    vi.doUnmock("@/lib/db");
    vi.doUnmock("@/lib/db-ping");
  });

  async function load(requireImpl: () => Promise<unknown>) {
    vi.resetModules();
    // VERCEL_ENV no se setea: el fail-fast de Production de `lib/env.ts` no aplica (no es lo que se prueba acá).
    for (const [k, v] of Object.entries(MARKED)) if (k !== "VERCEL_ENV") vi.stubEnv(k, v);
    const requirePlatformAdmin = vi.fn(requireImpl);
    vi.doMock("@/lib/platform-actor", () => ({ requirePlatformAdmin }));
    vi.doMock("@/lib/db", () => ({
      prisma: {},
      prismaService: { $queryRaw: vi.fn(async () => [{ applied: BigInt(42), last: "20261014000000_identity_access" }]) },
    }));
    vi.doMock("@/lib/db-ping", () => ({ pingDb: vi.fn(async () => ({ up: true, ms: 3 })) }));
    const mod = await import("@/lib/platform-system-read");
    return { mod, requirePlatformAdmin };
  }

  it("no contiene ningún valor marcado y pide platform.read", async () => {
    const { mod, requirePlatformAdmin } = await load(async () => ({ userId: "u", email: "e", homeTenantId: null }));
    const s = await mod.getPlatformSystemStatus();
    expect(requirePlatformAdmin).toHaveBeenCalledWith("platform.read");
    expect(JSON.stringify(s)).not.toMatch(/SECRETO/);
    const byKey = Object.fromEntries(s.groups.flatMap((g) => g.checks).map((c) => [c.key, c]));
    expect(byKey.CRON_SECRET.state).toBe("ok");
    expect(byKey.RESEND_API_KEY.state).toBe("ok");
    expect(byKey.REALTIME_DRIVER.value).toBe("supabase");
    expect(byKey.TENANT_ACCESS_ENFORCEMENT.value).toBe("enforce");
    expect(byKey.migrations.value).toBe("42");
  });

  it("sin superadmin → tira y no lee nada", async () => {
    const { mod } = await load(async () => {
      throw new Error("platform_admin_required");
    });
    await expect(mod.getPlatformSystemStatus()).rejects.toThrow("platform_admin_required");
  });
});
