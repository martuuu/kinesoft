import { PrismaClient } from "@prisma/client";

/**
 * Ephemeral-tenant factory for integration tests (docs/TESTING.md capa 3).
 *
 * Each integration test creates its own isolated tenant with real rows
 * (tenant → userProfile → practitioner → membership → service) against the
 * local Docker Postgres, and cleans up after itself. This is the shared
 * factory the manual (4.3) calls for — extracted from the `seedDemoTenant`
 * pattern so suites don't copy-paste tenant creation.
 *
 * NOTE: this helper is NOT a `.test.ts`, so the capa-1 `npm test` run (pure,
 * no DB) never imports or executes it. It's consumed by the gated integration
 * suite, whose aislamiento-tripwire only becomes meaningful once the app
 * connects as a role WITHOUT BYPASSRLS (ROADMAP Ola B2b). Until then it still
 * works as a fixture; it just can't prove RLS isolation yet.
 */

let seq = 0;
/** Monotonic, collision-resistant suffix for unique slugs/ids within a run. */
export function uniqueSuffix(): string {
  seq += 1;
  return `${Date.now().toString(36)}-${seq}`;
}

export type TenantRole = "OWNER" | "ADMIN" | "PRACTITIONER" | "ASSISTANT" | "BILLING";

export interface EphemeralTenant {
  tenantId: string;
  slug: string;
  userId: string;
  practitionerId: string;
  serviceId: string;
  /** Removes the tenant and its user; safe to call in afterEach. */
  cleanup: () => Promise<void>;
}

export async function createEphemeralTenant(
  prisma: PrismaClient,
  opts: { role?: TenantRole } = {}
): Promise<EphemeralTenant> {
  const s = uniqueSuffix();
  const slug = `test-${s}`;
  const userId = `test-user-${s}`;

  const tenant = await prisma.tenant.create({ data: { slug, name: `Test ${s}` } });
  await prisma.userProfile.create({
    data: { id: userId, email: `${userId}@test.local`, fullName: `Test ${s}` },
  });
  const practitioner = await prisma.practitioner.create({
    data: { tenantId: tenant.id, userId, specialty: "Test" },
  });
  await prisma.membership.create({
    data: { userId, tenantId: tenant.id, role: opts.role ?? "OWNER", acceptedAt: new Date() },
  });
  const service = await prisma.service.create({
    data: {
      tenantId: tenant.id,
      practitionerId: practitioner.id,
      name: "Consulta",
      durationMin: 45,
      priceCents: 5000,
    },
  });

  const cleanup = async () => {
    // Payment→Booking is onDelete: Restrict, so clear payments before the
    // tenant cascade would try to remove their bookings.
    await prisma.payment.deleteMany({ where: { booking: { tenantId: tenant.id } } });
    await prisma.tenant.delete({ where: { id: tenant.id } }).catch(() => {});
    await prisma.userProfile.delete({ where: { id: userId } }).catch(() => {});
  };

  return {
    tenantId: tenant.id,
    slug,
    userId,
    practitionerId: practitioner.id,
    serviceId: service.id,
    cleanup,
  };
}

/**
 * Sweep orphan test tenants left by runs that crashed before cleanup. Call at
 * the start of an integration suite. Matches the `test-` slug prefix only.
 */
export async function sweepOrphanTestTenants(prisma: PrismaClient): Promise<number> {
  const orphans = await prisma.tenant.findMany({
    where: { slug: { startsWith: "test-" } },
    select: { id: true },
  });
  for (const t of orphans) {
    await prisma.payment.deleteMany({ where: { booking: { tenantId: t.id } } });
    await prisma.tenant.delete({ where: { id: t.id } }).catch(() => {});
  }
  return orphans.length;
}
