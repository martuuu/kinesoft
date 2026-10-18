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
import { buildSystemStatus, buildRecentEmailFailures, emailFailureLabel, type SystemConfigInput } from "@/lib/platform-system-logic";

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
  // HF-1a: un kid sin forma de UUID y una anon key no reconocida no salen tal cual.
  SUPABASE_JWT_KID: "SECRETO-KID",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "SECRETO-ANON",
  // Ya descripto (el builder nunca recibe el secreto); `load()` no lo pasa a process.env.
  realtimeSecret: { length: 40, edgeWhitespace: false, fingerprint: "abcd1234" },
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
    // HF-1a: del secreto de realtime, huella y largo (nunca el valor); kid y anon con forma rara → no salen.
    expect(byKey.SUPABASE_JWT_SECRET).toMatchObject({ state: "ok", value: "huella abcd1234" });
    expect(byKey.SUPABASE_JWT_SECRET.detail).toMatch(/40 caracteres · espacios o saltos de línea al borde: no/);
    expect(byKey.SUPABASE_JWT_KID).toMatchObject({ state: "warn", value: "no es UUID" });
    expect(byKey.NEXT_PUBLIC_SUPABASE_ANON_KEY).toMatchObject({ state: "warn", value: "no reconocida" });
  });

  it("[HF-1a] kid UUID sale tal cual; anon JWT legacy / publishable / secreta; sin secreto con supabase → falta", () => {
    const kid = "3f0c2d1e-9a8b-4c7d-8e6f-5a4b3c2d1e0f";
    const s1 = buildSystemStatus(
      { REALTIME_DRIVER: "supabase", SUPABASE_JWT_KID: kid, NEXT_PUBLIC_SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.c2ln" },
      { available: false },
      { up: true, ms: 1 }
    );
    const k1 = Object.fromEntries(allChecks(s1).map((c) => [c.key, c]));
    expect(k1.SUPABASE_JWT_KID).toMatchObject({ state: "value", value: kid });
    expect(k1.NEXT_PUBLIC_SUPABASE_ANON_KEY).toMatchObject({ value: "JWT legacy" });
    expect(k1.SUPABASE_JWT_SECRET).toMatchObject({ state: "missing", value: null });
    expect(JSON.stringify(s1)).not.toContain("eyJyb2xl");

    const s2 = buildSystemStatus({ NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_secret_SECRETO" }, { available: false }, { up: true, ms: 1 });
    const k2 = Object.fromEntries(allChecks(s2).map((c) => [c.key, c]));
    expect(k2.NEXT_PUBLIC_SUPABASE_ANON_KEY).toMatchObject({ state: "missing", value: "es secreta" });
    expect(k2.SUPABASE_JWT_KID).toMatchObject({ value: "sin kid" });
    expect(k2.SUPABASE_JWT_SECRET.state).toBe("warn"); // driver off: avisa, no «falta»
    expect(JSON.stringify(s2)).not.toMatch(/SECRETO/);
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

  const emailLogFindMany = vi.fn(async (_args: unknown) => [
    {
      createdAt: new Date("2026-10-17T13:00:00Z"),
      kind: "staff_invite",
      status: "failed",
      transport: "resend",
      reason: "provider_error:validation_error:403",
      toMasked: "j***@gmail.com",
    },
  ]);

  async function load(requireImpl: () => Promise<unknown>) {
    vi.resetModules();
    // VERCEL_ENV no se setea: el fail-fast de Production de `lib/env.ts` no aplica (no es lo que se prueba acá).
    for (const [k, v] of Object.entries(MARKED)) if (k !== "VERCEL_ENV" && typeof v === "string") vi.stubEnv(k, v);
    const requirePlatformAdmin = vi.fn(requireImpl);
    vi.doMock("@/lib/platform-actor", () => ({ requirePlatformAdmin }));
    vi.doMock("@/lib/db", () => ({
      prisma: {},
      prismaService: {
        $queryRaw: vi.fn(async () => [{ applied: BigInt(42), last: "20261014000000_identity_access" }]),
        // OPS-1a: la tarjeta de mails que no salieron lee EmailLog por el canal service.
        emailLog: { findMany: emailLogFindMany },
      },
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
    // OPS-1a: la tarjeta trae el motivo y el dominio, nunca el usuario enmascarado.
    expect(s.emailFailures).toMatchObject({ available: true, items: [{ kind: "staff_invite", reason: "provider_error:validation_error:403", recipientDomain: "gmail.com" }] });
    expect(JSON.stringify(s)).not.toContain("j***");
    const args = emailLogFindMany.mock.calls[0][0] as { take: number; orderBy: unknown; select: Record<string, boolean> };
    expect(args.take).toBe(10);
    expect(args.orderBy).toEqual({ createdAt: "desc" });
    expect(Object.keys(args.select).sort()).toEqual(["createdAt", "kind", "reason", "status", "toMasked", "transport"]);
  });

  it("[OPS-1a] si EmailLog no se puede leer, la página no se cae (tarjeta «no disponible»)", async () => {
    emailLogFindMany.mockRejectedValueOnce(new Error("permission denied"));
    const { mod } = await load(async () => ({ userId: "u", email: "e", homeTenantId: null }));
    const s = await mod.getPlatformSystemStatus();
    expect(s.emailFailures).toEqual({ available: false });
  });

  it("sin superadmin → tira y no lee nada", async () => {
    const { mod } = await load(async () => {
      throw new Error("platform_admin_required");
    });
    await expect(mod.getPlatformSystemStatus()).rejects.toThrow("platform_admin_required");
  });
});

describe("[OPS-1a] buildRecentEmailFailures · «Últimos mails que no salieron»", () => {
  const row = (over: Partial<Parameters<typeof buildRecentEmailFailures>[0][number]> = {}) => ({
    createdAt: new Date("2026-10-17T13:00:00Z"),
    kind: "password_reset",
    status: "failed",
    transport: "resend",
    reason: "provider_error:validation_error:403",
    toMasked: "j***@gmail.com",
    ...over,
  });

  it("[OPS-1a] fecha, tipo, motivo y dominio del destinatario; nunca el usuario", () => {
    const out = buildRecentEmailFailures([row()]);
    expect(out).toEqual([
      {
        at: "2026-10-17T13:00:00.000Z",
        kind: "password_reset",
        status: "failed",
        reason: "provider_error:validation_error:403",
        label: emailFailureLabel("provider_error:validation_error:403"),
        recipientDomain: "gmail.com",
      },
    ]);
    expect(JSON.stringify(out)).not.toContain("j***");
  });

  it("[OPS-1a] reason, kind o dominio con forma rara no salen tal cual (alguien metió otra cosa en la fila)", () => {
    const [x] = buildRecentEmailFailures([row({ reason: "provider_error: SECRETO ana@x.com", kind: "SECRETO kind", toMasked: "SECRETO sin arroba" })]);
    expect(JSON.stringify(x)).not.toMatch(/SECRETO|ana@x\.com/);
    expect(x).toMatchObject({ reason: "desconocido", kind: "desconocido", recipientDomain: null });
  });

  it("[OPS-1a] techo de 10 filas", () => {
    expect(buildRecentEmailFailures(Array.from({ length: 15 }, () => row()))).toHaveLength(10);
  });

  it("[OPS-1a] los motivos más comunes del rechazo se leen en castellano", () => {
    expect(emailFailureLabel("provider_error:validation_error:403")).toMatch(/dominio/i);
    expect(emailFailureLabel("provider_error:unknown:401")).toMatch(/clave/i);
    expect(emailFailureLabel("provider_error:invalid_from_address:422")).toMatch(/remitente/i);
    expect(emailFailureLabel("rate_limited:rate_limit_exceeded:429")).toMatch(/límite/i);
    expect(emailFailureLabel("no_api_key")).toMatch(/clave/i);
    expect(emailFailureLabel("no_from")).toMatch(/remitente/i);
    expect(emailFailureLabel("unsafe_link_host")).toMatch(/localhost|local/i);
    expect(emailFailureLabel("timeout")).toMatch(/5 s/);
    expect(emailFailureLabel("desconocido")).toBeTruthy();
  });
});
