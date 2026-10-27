import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  prismaService: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/**
 * Service-role Prisma client for surfaces that run WITHOUT an Actor and can
 * therefore never set the `app.current_tenant_id` GUC that `runWithRls`
 * relies on: the public booking flow, the Mercado Pago webhook, and the
 * security events of `lib/audit.ts#auditSecurityEvent` (exports, descarga de adjunto). It connects on a channel that BYPASSes RLS, so
 * these paths keep working once RLS is forced on the Actor-facing `prisma`.
 *
 * Connection resolution (first defined wins):
 *   - DATABASE_URL_SERVICE → dedicated BYPASSRLS role (prod: `kinesoft_service`)
 *   - DIRECT_URL           → the migration/owner connection (local default:
 *                            `kinesoft`, the Docker superuser → bypasses RLS)
 *   - DATABASE_URL         → last-resort fallback
 *
 * Net effect: local needs zero extra config (falls back to the owner via
 * DIRECT_URL); prod sets DATABASE_URL_SERVICE to the `kinesoft_service`
 * connection string. Until RLS is forced, this behaves exactly like `prisma`.
 */
const serviceDbUrl =
  process.env.DATABASE_URL_SERVICE ??
  process.env.DIRECT_URL ??
  process.env.DATABASE_URL;

export const prismaService =
  globalForPrisma.prismaService ??
  new PrismaClient({
    ...(serviceDbUrl ? { datasources: { db: { url: serviceDbUrl } } } : {}),
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prismaService = prismaService;

// HD-17: acá vivía `getTenantPrisma` (un `$extends` que inyectaba `tenantId` en las lecturas de 9 modelos, con su
// cache `tenantClients`). No tenía ni un call site (AUDIT «gettenantprisma-dead-code») y su lista de modelos
// había quedado vieja: invitaba a creer que había un backstop que no existía. La barrera real es el `where: { tenantId }`
// a mano en cada action + `runWithRls` (AGENTS.md §4).
