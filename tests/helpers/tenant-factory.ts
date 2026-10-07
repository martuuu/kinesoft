import { PrismaClient, type Role, type TenantPlan, type TenantVertical } from "@prisma/client";

/**
 * Ephemeral-tenant factory for integration tests (.docs/TESTING.md capa 3).
 *
 * Each suite creates its own isolated tenant with real rows against the local
 * Docker Postgres and removes it afterwards. All fixture writes go through the
 * OWNER client (`DIRECT_URL`, bypasses RLS) — the app role could never create
 * cross-tenant fixtures, and the code under test must not be the one seeding.
 *
 * A1.1 (2026-09-29) rewrote the cleanup: `Service`, `Patient`, `Booking`,
 * `TreatmentProgram`, `ClinicalCase` and `AuditEvent` do NOT cascade from
 * `Tenant`, so the old `tenant.delete().catch(() => {})` failed EVERY time a
 * service existed and silently leaked every ephemeral tenant. Deletion is now
 * explicit and ordered by FK dependencies, and a failure throws.
 *
 * NOT a `.test.ts`: the unit run never imports it.
 */

let seq = 0;
/** Monotonic, collision-resistant suffix for unique slugs/ids within a run. */
export function uniqueSuffix(): string {
  seq += 1;
  return `${Date.now().toString(36)}-${seq}`;
}

/** Owner connection (BYPASSRLS) for fixtures and teardown. */
export function ownerClient(): PrismaClient {
  return new PrismaClient({
    datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } },
  });
}

export type TenantRole = Role;

export interface EphemeralTenant {
  tenantId: string;
  slug: string;
  /** OWNER user (UserProfile id = the Supabase user id the actor mock returns). */
  userId: string;
  practitionerId: string;
  /** Default service: 45 min, $50, maxConcurrent null (ilimitado, kinesio). */
  serviceId: string;
  particularInsurerId: string;
  /** Removes the tenant and every row hanging from it; throws on failure. */
  cleanup: () => Promise<void>;
}

/** Ordered teardown of everything that references the tenant (see header). */
export async function deleteTenantDeep(db: PrismaClient, tenantId: string): Promise<void> {
  const users = await db.membership.findMany({ where: { tenantId }, select: { userId: true } });
  await db.payment.deleteMany({ where: { booking: { tenantId } } });
  // Planes M1: Booking → TreatmentProgram/Session es RESTRICT; los turnos se
  // borran antes que los planes (ya era así).
  await db.booking.deleteMany({ where: { tenantId } });
  // Planes M1: ProgramAuthorization → TreatmentProgram es RESTRICT (FK
  // compuesta): va antes que los planes o el deleteMany de abajo falla con 23503.
  await db.programAuthorization.deleteMany({ where: { tenantId } });
  // Planes M1: PatientChangeRequest cascadea de Patient y de Tenant, pero se
  // borra explícito para no depender del orden de cascadas (y que un fallo tire).
  await db.patientChangeRequest.deleteMany({ where: { tenantId } });
  // Session → TreatmentProgram cascades; SessionExercise → Session cascades.
  // TreatmentProgram → Practitioner/Service/Location es RESTRICT (M1): por eso
  // los planes van antes que Service y que el cascade de Tenant.
  await db.treatmentProgram.deleteMany({ where: { tenantId } });
  // Diagnosis → ClinicalCase cascades.
  await db.clinicalCase.deleteMany({ where: { tenantId } });
  // Coverage, EmergencyContact, EvaScore, PatientFile/Share/TenantLink cascade.
  await db.patient.deleteMany({ where: { tenantId } });
  await db.service.deleteMany({ where: { tenantId } });
  await db.auditEvent.deleteMany({ where: { tenantId } });
  await db.notification.deleteMany({ where: { tenantId } });
  await db.dismissedReminder.deleteMany({ where: { tenantId } });
  await db.userPreferences.deleteMany({ where: { tenantId } });
  // Membership, Practitioner, Insurer, Invitation, custom Condition/Exercise,
  // Favorite and PlanTemplate cascade from Tenant.
  await db.tenant.delete({ where: { id: tenantId } });
  const ids = users.map((u) => u.userId).filter((id) => id.startsWith("test-user-"));
  if (ids.length) {
    await db.userPreferences.deleteMany({ where: { userId: { in: ids } } });
    await db.userProfile.deleteMany({ where: { id: { in: ids } } });
  }
}

export async function createEphemeralTenant(
  prisma: PrismaClient,
  opts: {
    role?: TenantRole;
    sharedPatientView?: boolean;
    /** EV0 (M2): sin valor → default de la base (KINESIOLOGY). */
    vertical?: TenantVertical;
    /** Sin valor → default de la base (FREE). */
    plan?: TenantPlan;
    /**
     * EV0 (M2): en la base el turnero nace APAGADO (opt-in, EV-D2), pero los
     * tests de antes de EV0 (turnero, webhook MP) asumen que la reserva pública
     * está abierta: por eso la factory lo prende salvo que se pida `false`.
     */
    publicBookingEnabled?: boolean;
  } = {}
): Promise<EphemeralTenant> {
  const s = uniqueSuffix();
  const slug = `test-${s}`;
  const userId = `test-user-${s}`;

  const tenant = await prisma.tenant.create({
    data: {
      slug,
      name: `Test ${s}`,
      sharedPatientView: opts.sharedPatientView ?? false,
      vertical: opts.vertical,
      plan: opts.plan,
      publicBookingEnabled: opts.publicBookingEnabled ?? true,
      // Como el backfill de tenant_onboarding: los tenants de test ya "terminaron" el alta.
      onboardingCompletedAt: new Date(),
    },
  });
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
  // Same shape the signup creates: one Particular insurer per tenant.
  const particular = await prisma.insurer.create({
    data: { tenantId: tenant.id, name: "Particular", isParticular: true },
  });

  return {
    tenantId: tenant.id,
    slug,
    userId,
    practitionerId: practitioner.id,
    serviceId: service.id,
    particularInsurerId: particular.id,
    cleanup: () => deleteTenantDeep(prisma, tenant.id),
  };
}

/** Second professional in the same tenant (for basic/full access cases). */
export async function addPractitioner(
  prisma: PrismaClient,
  t: EphemeralTenant,
  role: TenantRole = "PRACTITIONER"
): Promise<{ userId: string; practitionerId: string }> {
  const s = uniqueSuffix();
  const userId = `test-user-${s}`;
  await prisma.userProfile.create({ data: { id: userId, email: `${userId}@test.local`, fullName: `Kine ${s}` } });
  const p = await prisma.practitioner.create({ data: { tenantId: t.tenantId, userId, specialty: "Test" } });
  await prisma.membership.create({ data: { userId, tenantId: t.tenantId, role, acceptedAt: new Date() } });
  return { userId, practitionerId: p.id };
}

export async function addPatient(
  prisma: PrismaClient,
  t: EphemeralTenant,
  data: {
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    documentId?: string;
    assignedPractitionerId?: string | null;
    notes?: string;
  } = {}
): Promise<string> {
  const s = uniqueSuffix();
  const p = await prisma.patient.create({
    data: {
      tenantId: t.tenantId,
      firstName: data.firstName ?? "Paciente",
      lastName: data.lastName ?? `Test ${s}`,
      email: data.email,
      phone: data.phone,
      documentId: data.documentId ?? `DNI-${s}`,
      notes: data.notes,
      assignedPractitionerId:
        data.assignedPractitionerId === undefined ? t.practitionerId : data.assignedPractitionerId,
    },
  });
  return p.id;
}

export async function addService(
  prisma: PrismaClient,
  t: EphemeralTenant,
  data: { name?: string; durationMin?: number; priceCents?: number; maxConcurrent?: number | null } = {}
): Promise<string> {
  const svc = await prisma.service.create({
    data: {
      tenantId: t.tenantId,
      practitionerId: t.practitionerId,
      name: data.name ?? "Osteopatía",
      durationMin: data.durationMin ?? 60,
      priceCents: data.priceCents ?? 8000,
      maxConcurrent: data.maxConcurrent ?? null,
    },
  });
  return svc.id;
}

export async function addInsurer(
  prisma: PrismaClient,
  t: EphemeralTenant,
  data: { name?: string; copagoCents?: number; fixedFeeCents?: number } = {}
): Promise<string> {
  const ins = await prisma.insurer.create({
    data: {
      tenantId: t.tenantId,
      name: data.name ?? `OS ${uniqueSuffix()}`,
      copagoCents: data.copagoCents ?? 0,
      fixedFeeCents: data.fixedFeeCents ?? 0,
    },
  });
  return ins.id;
}

/**
 * Sweep orphan test tenants left by runs that crashed before cleanup. Call at
 * the start of an integration suite. Matches the `test-` slug prefix only.
 */
export async function sweepOrphanTestTenants(prisma: PrismaClient): Promise<number> {
  // Solo huérfanos VIEJOS (>30 min): con varias corridas de integración en
  // paralelo contra el mismo Docker (agentes de una ola), barrer todos los
  // `test-*` borraba los tenants de la corrida vecina a mitad de sus tests
  // (FK de Booking que desaparecen, datos que se esfuman — B-pre B1.0).
  const cutoff = new Date(Date.now() - 30 * 60_000);
  const orphans = await prisma.tenant.findMany({
    where: { slug: { startsWith: "test-" }, createdAt: { lt: cutoff } },
    select: { id: true },
  });
  for (const t of orphans) await deleteTenantDeep(prisma, t.id);
  await prisma.userProfile.deleteMany({
    where: { id: { startsWith: "test-user-" }, memberships: { none: {} }, createdAt: { lt: cutoff } },
  });
  return orphans.length;
}
