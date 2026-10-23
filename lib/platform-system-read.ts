import "server-only";
/**
 * BO3-E · `/plataforma/sistema`: presencia de la configuración externa, migraciones aplicadas y salud de la base.
 *
 * Seguridad: cada export llama a `requirePlatformAdmin` (guard estático de BO2). El DTO lo arma
 * `buildSystemStatus` (puro, `lib/platform-system-logic.ts`), que recibe las variables y devuelve SOLO presencia o
 * enums re-validados; el unit test `platform-system.test.ts` setea valores marcados y verifica que ninguno sale.
 *
 * Las claves se leen de `env` (`lib/env.ts`, el objeto validado al boot; `CRON_SECRET` incluido desde el integrador
 * de BO3), salvo `TENANT_ACCESS_ENFORCEMENT`: por `tenantAccessEnforcement()`, que es lo que leen los cortes en cada
 * request (el `env` se congela al importar; mostrar el congelado podría no ser lo que se aplica).
 *
 * HF-1a: el secreto de firma de realtime se describe con `describeRealtimeSecret` (largo, bordes, huella) leyendo el
 * CRUDO de `process.env`: `env` ya viene recortado y no podría decir si Vercel lo tenía con un `\n` al borde (H-RT1).
 * Al builder llega solo esa descripción, nunca el valor.
 *
 * Migraciones: `_prisma_migrations` por `prismaService`. En prod el canal service es un rol BYPASSRLS que puede no
 * tener SELECT sobre esa tabla (la crea el owner): si falla, el panel dice «no se pudo leer», no se cae.
 *
 * OPS-1a: «Últimos mails que no salieron» lee los últimos 10 EmailLog fallidos de TODOS los consultorios (y los sin
 * consultorio: auth, Plataforma) por `prismaService`; es la vista del superadmin, la misma barrera
 * `requirePlatformAdmin`. El `select` trae solo fecha, tipo, estado, transporte, motivo y la máscara (de la que la
 * lógica pura se queda con el dominio). Sin índice por `createdAt` solo: hoy EmailLog es chica y la página es de
 * consulta ocasional; si crece, un índice `(status, createdAt)` va en una migración propia (no en esta tanda).
 *
 * PEND-b (AUDIT «Ronda T5», B4): «Cobros en proceso trabados» cuenta los OnlineCharge AUTHORIZED con más de 7 días
 * desde `expiresAt`, por consultorio, por `prismaService` (cruza consultorios). Un `groupBy` que usa el índice
 * `(status, expiresAt)` de M18 (agregado, sin filas: guard de BO2) + nombre y slug del consultorio; el conteo y el vencimiento más viejo, nada del
 * paciente ni del cobro. Y la presencia (sí/no) de las variables nuevas de T6/T7 (`ENV_PRESENCE_VARS`), leída CRUDA de
 * `process.env`: varias tienen default en `lib/env.ts`, y el `env` validado no distingue «no está» de «vale el default».
 */
import { createHash } from "node:crypto";
import { prismaService } from "@/lib/db";
import { env, mpConnectMode, mpConnectSignatureMode, saasBillingMode, tenantAccessEnforcement, whatsappMode } from "@/lib/env";
import { secretBoxStatus } from "@/lib/secret-box";
import { pingDb } from "@/lib/db-ping";
import { logger } from "@/lib/logger";
import { requirePlatformAdmin } from "@/lib/platform-actor";
import { describeRealtimeSecret } from "@/lib/realtime-token-internal";
import {
  buildRecentEmailFailures,
  buildStuckCharges,
  buildSystemStatus,
  EMAIL_FAILURE_SKIP_REASONS,
  ENV_PRESENCE_VARS,
  STUCK_AUTHORIZED_DAYS,
  STUCK_AUTHORIZED_LIMIT,
  type StuckChargeRow,
  type StuckChargesInfo,
  EMAIL_FAILURES_LIMIT,
  type EmailFailuresInfo,
  type MigrationsInfo,
  type MpConnectSystemInfo,
  type PlatformSystemStatus,
} from "@/lib/platform-system-logic";

export type { PlatformSystemStatus } from "@/lib/platform-system-logic";

async function readMigrations(): Promise<MigrationsInfo> {
  try {
    const [row] = await prismaService.$queryRaw<Array<{ applied: bigint; last: string | null }>>`
      SELECT COUNT(*)::bigint AS applied, MAX(migration_name) AS last
      FROM _prisma_migrations
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
    return { available: true, applied: Number(row?.applied ?? 0), last: row?.last ?? null };
  } catch (err) {
    logger.warn("platform.system.migrations_unavailable", { error: err instanceof Error ? err.name : "unknown" });
    return { available: false };
  }
}

async function readEmailFailures(): Promise<EmailFailuresInfo> {
  try {
    const rows = await prismaService.emailLog.findMany({
      where: {
        OR: [{ status: { in: ["failed", "blocked"] } }, { status: "skipped", reason: { in: [...EMAIL_FAILURE_SKIP_REASONS] } }],
      },
      orderBy: { createdAt: "desc" },
      take: EMAIL_FAILURES_LIMIT,
      select: { createdAt: true, kind: true, status: true, transport: true, reason: true, toMasked: true },
    });
    return { available: true, items: buildRecentEmailFailures(rows) };
  } catch (err) {
    logger.warn("platform.system.email_log_unavailable", { error: err instanceof Error ? err.name : "unknown" });
    return { available: false };
  }
}

/**
 * TP-2h (C-TP13): huella de un secreto de Mercado Pago (client secret, secreto del webhook) para comparar con el gestor
 * de contraseñas o la consola de MP sin mostrarlo. Mismo criterio que la huella del secreto de realtime (HF-1a):
 * sha256 con prefijo propio, 32 bits; no es un pedazo del valor ni sirve para adivinarlo. Sin `export`: el guard de BO
 * exige `requirePlatformAdmin` en cada export de `lib/platform-*` (lo replica el unit test).
 */
function mpSecretFingerprint(secret: string): string {
  return createHash("sha256").update(`kinesoft:system:mp-secret:v1|${secret.trim()}`).digest("hex").slice(0, 8);
}

/** Valor vigente de una variable (los tests la cambian en caliente; `env` se congela al importar). Vacía → null. */
function liveVar(name: string, frozen: string | undefined): string | null {
  const v = (process.env[name] ?? frozen ?? "").trim();
  return v ? v : null;
}

/**
 * Conteos del grupo «Cobros online» por el canal service (cruzan consultorios: vista del superadmin). Tres sentencias
 * chicas; si alguna falla (permisos del rol service sobre las tablas de M18), el grupo dice «no se pudo leer» y la
 * página no se cae.
 */
async function readMpConnectStats(): Promise<MpConnectSystemInfo["stats"]> {
  try {
    const [byStatus, lastWebhook, lastRefresh] = await Promise.all([
      prismaService.mpAccount.groupBy({ by: ["status"], _count: { _all: true } }),
      // Solo el webhook deja un cobro en AUTHORIZED/PAID/REFUNDED (el cron vence y anula; los links crean ACTIVE): su
      // último `updatedAt` es el último aviso de MP que cambió algo.
      prismaService.onlineCharge.aggregate({ where: { status: { in: ["AUTHORIZED", "PAID", "REFUNDED"] } }, _max: { updatedAt: true } }),
      prismaService.mpCredential.aggregate({ _max: { lastRefreshedAt: true } }),
    ]);
    const count = (st: string) => byStatus.find((r) => r.status === st)?._count._all ?? 0;
    return {
      available: true,
      accounts: { active: count("ACTIVE"), reauth: count("REAUTH_REQUIRED"), disconnected: count("DISCONNECTED") },
      lastWebhookAt: lastWebhook._max.updatedAt ?? null,
      lastRefreshAt: lastRefresh._max.lastRefreshedAt ?? null,
    };
  } catch (err) {
    logger.warn("platform.system.mp_connect_unavailable", { error: err instanceof Error ? err.name : "unknown" });
    return { available: false };
  }
}

async function readMpConnect(): Promise<MpConnectSystemInfo> {
  const clientSecret = liveVar("MP_OAUTH_CLIENT_SECRET", env.MP_OAUTH_CLIENT_SECRET);
  const webhookSecret = liveVar("MP_CONNECT_WEBHOOK_SECRET", env.MP_CONNECT_WEBHOOK_SECRET);
  return {
    mode: mpConnectMode(),
    signature: mpConnectSignatureMode(),
    clientIdPresent: liveVar("MP_OAUTH_CLIENT_ID", env.MP_OAUTH_CLIENT_ID) !== null,
    clientSecretFingerprint: clientSecret ? mpSecretFingerprint(clientSecret) : null,
    webhookSecretFingerprint: webhookSecret ? mpSecretFingerprint(webhookSecret) : null,
    secretBox: secretBoxStatus(),
    turneroCheckout: process.env.TURNERO_CHECKOUT,
    stats: await readMpConnectStats(),
  };
}

async function readStuckCharges(now: Date): Promise<StuckChargesInfo> {
  // Agregados y no SQL crudo: el guard de BO2 (tests/unit/platform-admin-guard.test.ts) no deja que un lib/platform-*
  // lea filas de OnlineCharge (PHI_MODELS); `groupBy` con `_count`/`_min` no trae filas. Dos sentencias chicas: el
  // agrupado por consultorio (índice `(status, expiresAt)` de M18) y nombre + slug de los consultorios del tope.
  const cutoff = new Date(now.getTime() - STUCK_AUTHORIZED_DAYS * 86_400_000);
  try {
    const groups = await prismaService.onlineCharge.groupBy({
      by: ["tenantId"],
      where: { status: "AUTHORIZED", expiresAt: { lt: cutoff } },
      _count: { _all: true },
      _min: { expiresAt: true },
    });
    if (!Array.isArray(groups) || groups.length === 0) return buildStuckCharges([]);
    const total = groups.reduce((acc, g) => acc + (g._count?._all ?? 0), 0);
    const top = [...groups]
      .sort(
        (x, y) =>
          (y._count?._all ?? 0) - (x._count?._all ?? 0) ||
          (x._min?.expiresAt?.getTime() ?? 0) - (y._min?.expiresAt?.getTime() ?? 0)
      )
      .slice(0, STUCK_AUTHORIZED_LIMIT);
    const tenants = await prismaService.tenant.findMany({
      where: { id: { in: top.map((g) => g.tenantId) } },
      select: { id: true, name: true, slug: true },
    });
    const byId = new Map(tenants.map((t) => [t.id, t]));
    const rows: StuckChargeRow[] = top.flatMap((g) => {
      const t = byId.get(g.tenantId);
      const oldest = g._min?.expiresAt;
      return t && oldest
        ? [{ tenantName: t.name, tenantSlug: t.slug, count: g._count?._all ?? 0, oldestExpiredAt: oldest, total, tenants: groups.length }]
        : [];
    });
    return buildStuckCharges(rows);
  } catch (err) {
    logger.warn("platform.system.stuck_charges_unavailable", { error: err instanceof Error ? err.name : "unknown" });
    return { available: false };
  }
}

/** Solo sí/no: el valor no sale de esta función. Vacía o solo espacios = no está (Vercel guarda «» como vacía). */
function envPresence(): Record<string, boolean> {
  return Object.fromEntries(ENV_PRESENCE_VARS.map(({ key }) => [key, (process.env[key] ?? "").trim() !== ""]));
}

export async function getPlatformSystemStatus(): Promise<PlatformSystemStatus> {
  await requirePlatformAdmin("platform.read");
  const now = new Date();
  const [migrations, ping, emailFailures, mpConnect, stuckCharges] = await Promise.all([
    readMigrations(),
    pingDb(),
    readEmailFailures(),
    readMpConnect(),
    readStuckCharges(now),
  ]);
  if (!ping.up) logger.error("platform.system.db_down", { reason: ping.reason });

  const config = buildSystemStatus(
    {
      RESEND_API_KEY: env.RESEND_API_KEY,
      EMAIL_FROM: env.EMAIL_FROM,
      UPSTASH_REDIS_REST_URL: env.UPSTASH_REDIS_REST_URL,
      UPSTASH_REDIS_REST_TOKEN: env.UPSTASH_REDIS_REST_TOKEN,
      SENTRY_DSN: env.SENTRY_DSN,
      MP_ACCESS_TOKEN: env.MP_ACCESS_TOKEN,
      MP_PUBLIC_KEY: env.MP_PUBLIC_KEY,
      MP_WEBHOOK_SECRET: env.MP_WEBHOOK_SECRET,
      REALTIME_DRIVER: env.REALTIME_DRIVER,
      TENANT_ACCESS_ENFORCEMENT: tenantAccessEnforcement(),
      CRON_SECRET: env.CRON_SECRET,
      NEXT_PUBLIC_APP_URL: env.NEXT_PUBLIC_APP_URL,
      VERCEL_ENV: env.VERCEL_ENV,
      SUPABASE_JWT_KID: env.SUPABASE_JWT_KID,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      realtimeSecret: describeRealtimeSecret(process.env.SUPABASE_JWT_SECRET),
      mpConnect,
      stuckCharges,
      envPresence: envPresence(),
      // INT: modos que APLICA este deploy (getters de lib/env, en cada request), no el crudo.
      appliedModes: { whatsapp: whatsappMode(), saasBilling: saasBillingMode() },
    },
    migrations,
    { up: ping.up, ms: ping.ms },
    now
  );
  return { ...config, emailFailures, stuckCharges };
}
