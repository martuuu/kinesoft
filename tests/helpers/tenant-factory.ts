import { PrismaClient, type Role, type RoomKind, type TenantPlan, type TenantVertical } from "@prisma/client";

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
  // Planes M1: las FKs simples TreatmentProgram → Location/Service/Practitioner
  // dejan que un test arme A PROPÓSITO un plan de OTRO tenant que apunta a algo
  // de este (para probar que el motor lo rechaza). Ese plan ajeno es RESTRICT y
  // bloquea el cascade de este tenant: el sweep de huérfanos fallaba para todos
  // los archivos que lo usan. Se borran primero (con sus turnos y autorizaciones).
  const foreignPrograms = await db.treatmentProgram.findMany({
    where: {
      tenantId: { not: tenantId },
      OR: [{ location: { tenantId } }, { service: { tenantId } }, { practitioner: { tenantId } }],
    },
    select: { id: true },
  });
  if (foreignPrograms.length) {
    const programIds = foreignPrograms.map((p) => p.id);
    await db.payment.deleteMany({ where: { booking: { programId: { in: programIds } } } });
    await db.booking.deleteMany({ where: { programId: { in: programIds } } });
    await db.programAuthorization.deleteMany({ where: { programId: { in: programIds } } });
    await db.treatmentProgram.deleteMany({ where: { id: { in: programIds } } });
  }
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
  // IAM-1 (M6): EmailLog cascadea de Tenant; explícito para que un fallo tire.
  await db.emailLog.deleteMany({ where: { tenantId } });
  // Membership, Practitioner, Insurer, Invitation, custom Condition/Exercise,
  // Favorite and PlanTemplate cascade from Tenant.
  // SR M4: Location → Room → TimeBlock cascadean; PractitionerSchedule → Room es
  // NO ACTION pero la franja cascadea DIRECTO desde Tenant y desde Location, y esas
  // cascadas quedan encoladas antes que el chequeo de la sala borrada: no hace
  // falta borrar nada a mano (lo prueba rooms-m4.test.ts por la cascada real).
  // Booking → Room es RESTRICT y los turnos ya se borraron arriba.
  await db.tenant.delete({ where: { id: tenantId } });
  // IAM-1 (M6): un usuario puede ser profesional en VARIOS consultorios.
  // Practitioner → UserProfile es RESTRICT, así que el perfil de quien sigue
  // siendo profesional de otro tenant de test se deja: lo borra la limpieza de
  // ese tenant (o el sweep de huérfanos).
  const ids = users.map((u) => u.userId).filter((id) => id.startsWith("test-user-"));
  if (ids.length) {
    const removable = (
      await db.userProfile.findMany({
        where: { id: { in: ids }, practitioners: { none: {} } },
        select: { id: true },
      })
    ).map((u) => u.id);
    if (removable.length) {
      await db.userPreferences.deleteMany({ where: { userId: { in: removable } } });
      await db.userProfile.deleteMany({ where: { id: { in: removable } } });
    }
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
 * SR M4: sala de una sede del tenant (owner, BYPASSRLS). Sin `locationId` usa la
 * sede principal y la crea si el tenant no tiene ("Principal", isPrimary): la
 * factory no crea sedes y un turno con sala exige sede EXPLÍCITA
 * (Booking_room_location_check), así que el caller necesita el id de vuelta.
 */
export async function addRoom(
  prisma: PrismaClient,
  t: EphemeralTenant,
  data: {
    locationId?: string;
    name?: string;
    kind?: RoomKind;
    capacity?: number;
    active?: boolean;
  } = {}
): Promise<{ roomId: string; locationId: string }> {
  let locationId = data.locationId;
  if (!locationId) {
    const primary = await prisma.location.findFirst({
      where: { tenantId: t.tenantId, isPrimary: true },
      select: { id: true },
    });
    locationId =
      primary?.id ??
      (await prisma.location.create({ data: { tenantId: t.tenantId, name: "Principal", isPrimary: true } })).id;
  }
  const room = await prisma.room.create({
    data: {
      tenantId: t.tenantId,
      locationId,
      name: data.name ?? `Consultorio ${uniqueSuffix()}`,
      kind: data.kind,
      capacity: data.capacity,
      active: data.active,
    },
  });
  return { roomId: room.id, locationId };
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
    // practitioners none: Practitioner → UserProfile es RESTRICT (IAM-1: un perfil puede quedar como
    // profesional de otro tenant de test todavía vivo).
    where: { id: { startsWith: "test-user-" }, memberships: { none: {} }, practitioners: { none: {} }, createdAt: { lt: cutoff } },
  });
  return orphans.length;
}
