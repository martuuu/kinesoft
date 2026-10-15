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
 * Migraciones: `_prisma_migrations` por `prismaService`. En prod el canal service es un rol BYPASSRLS que puede no
 * tener SELECT sobre esa tabla (la crea el owner): si falla, el panel dice «no se pudo leer», no se cae.
 */
import { prismaService } from "@/lib/db";
import { env, tenantAccessEnforcement } from "@/lib/env";
import { pingDb } from "@/lib/db-ping";
import { logger } from "@/lib/logger";
import { requirePlatformAdmin } from "@/lib/platform-actor";
import { buildSystemStatus, type MigrationsInfo, type PlatformSystemStatus } from "@/lib/platform-system-logic";

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

export async function getPlatformSystemStatus(): Promise<PlatformSystemStatus> {
  await requirePlatformAdmin("platform.read");
  const [migrations, ping] = await Promise.all([readMigrations(), pingDb()]);
  if (!ping.up) logger.error("platform.system.db_down", { reason: ping.reason });

  return buildSystemStatus(
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
    },
    migrations,
    { up: ping.up, ms: ping.ms }
  );
}
