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
 * relies on: the public booking flow, the Mercado Pago webhook, and audit
 * writes from webhooks/jobs. It connects on a channel that BYPASSes RLS, so
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

// Audit extension is applied lazily on first import to avoid circular
// imports between `lib/db.ts` and `lib/audit-extension.ts` (which itself
// reads `prisma` for the AuditEvent write). Use `getAuditedPrisma()` from
// route handlers / server actions when you want auto-recorded PHI reads
// on top of the manual `audit(...)` calls.
let _auditedPrisma: ReturnType<PrismaClient["$extends"]> | null = null;
export async function getAuditedPrisma() {
  if (!_auditedPrisma) {
    const { auditExtension } = await import("@/lib/audit-extension");
    _auditedPrisma = prisma.$extends(auditExtension);
  }
  return _auditedPrisma;
}

const TENANT_SCOPED_MODELS = new Set<string>([
  "Practitioner",
  "Patient",
  "PatientTenantLink",
  "Service",
  "Booking",
  "TreatmentProgram",
  "Session",
  "ClinicalCase",
  "AuditEvent",
]);

const READ_OPS = new Set<string>([
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "findUnique",
  "findUniqueOrThrow",
  "count",
  "aggregate",
  "groupBy",
]);

/**
 * Returns a Prisma client scoped to a tenant.
 *
 * - Auto-injects `tenantId` into reads on tenant-scoped models
 *   (defense-in-depth on top of Postgres RLS).
 * - Use this anywhere you're acting on behalf of a logged-in member.
 *   For background jobs / webhooks / seeds use `prisma` directly.
 *
 * **Performance**: the `$extends()` object is memoised per tenantId on
 * the same `globalForPrisma` object that holds the base client. Building
 * a new extension per request adds GC pressure for nothing — the
 * extension closure is pure and tenantId-keyed, so we can hand back the
 * same instance for the lifetime of the process.
 */
const tenantClients =
  (globalForPrisma as typeof globalForPrisma & {
    tenantClients?: Map<string, ReturnType<PrismaClient["$extends"]>>;
  }).tenantClients ?? new Map<string, ReturnType<PrismaClient["$extends"]>>();
if (process.env.NODE_ENV !== "production") {
  (globalForPrisma as typeof globalForPrisma & {
    tenantClients?: Map<string, ReturnType<PrismaClient["$extends"]>>;
  }).tenantClients = tenantClients;
}

export function getTenantPrisma(tenantId: string) {
  const cached = tenantClients.get(tenantId);
  if (cached) return cached;
  const client = prisma.$extends({
    name: "tenant-scope",
    query: {
      $allModels: {
        $allOperations({ args, query, model, operation }) {
          if (
            model &&
            TENANT_SCOPED_MODELS.has(model) &&
            READ_OPS.has(operation)
          ) {
            const a = args as { where?: Record<string, unknown> };
            a.where = { ...(a.where ?? {}), tenantId };
          }
          return query(args);
        },
      },
    },
  });
  tenantClients.set(tenantId, client);
  return client;
}
