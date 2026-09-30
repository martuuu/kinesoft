/**
 * Volume fixture for the perf suite (A1.2): an EPHEMERAL tenant with months of
 * realistic usage, created with `createMany` by the owner client and deleted
 * after the run. It is a test fixture, not a seed — nothing persists.
 *
 * Shape (≈ a busy single-site kinesiology practice after ~1 year):
 *   · 1.000 pacientes (la mitad con cobertura), 2 profesionales
 *   · 10.000 turnos (±35 días alrededor de hoy, con cancelados y completados)
 *   · 200 planes × 20 sesiones × 6 ejercicios (con sesiones vencidas abiertas)
 *   · 50.000 AuditEvent
 */
import type { PrismaClient } from "@prisma/client";
import {
  createEphemeralTenant,
  addPractitioner,
  addService,
  addInsurer,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

export type VolumeTenant = EphemeralTenant & { patientIds: string[]; secondServiceId: string };

const CHUNK = 5_000;
async function inChunks<T>(rows: T[], write: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += CHUNK) await write(rows.slice(i, i + CHUNK));
}

export async function createVolumeTenant(db: PrismaClient): Promise<VolumeTenant> {
  const t = await createEphemeralTenant(db, { sharedPatientView: false });
  const kine2 = await addPractitioner(db, t);
  const secondServiceId = await addService(db, t, { name: "Osteopatía", durationMin: 60, maxConcurrent: 1 });
  const insurers = await Promise.all([addInsurer(db, t, { copagoCents: 150000 }), addInsurer(db, t, { copagoCents: 90000 })]);
  const s = uniqueSuffix();

  const patients = await db.patient.createManyAndReturn({
    data: Array.from({ length: 1000 }, (_, i) => ({
      tenantId: t.tenantId,
      firstName: `Nombre${i}`,
      lastName: `Apellido${i}`,
      documentId: `P${s}-${i}`,
      email: `p${i}-${s}@perf.local`,
      phone: `11${s.replace(/\D/g, "").slice(0, 4)}${String(i).padStart(4, "0")}`,
      assignedPractitionerId: i % 2 === 0 ? t.practitionerId : kine2.practitionerId,
    })),
    select: { id: true },
  });
  const patientIds = patients.map((p) => p.id);

  await db.coverage.createMany({
    data: patientIds
      .filter((_, i) => i % 2 === 0)
      .map((patientId, i) => ({ patientId, insurer: "OS", insurerId: insurers[i % 2], memberId: `M${i}` })),
  });

  // 10k bookings, 10-minute steps from 35 days ago → every (patient, instant)
  // is unique, so the partial unique index is never hit by the fixture.
  const start = Date.now() - 35 * 86_400_000;
  await inChunks(
    Array.from({ length: 10_000 }, (_, i) => ({
      tenantId: t.tenantId,
      patientId: patientIds[i % patientIds.length],
      practitionerId: i % 2 === 0 ? t.practitionerId : kine2.practitionerId,
      serviceId: i % 3 === 0 ? secondServiceId : t.serviceId,
      scheduledFor: new Date(start + i * 10 * 60_000),
      durationMin: 45,
      status: (i % 17 === 0 ? "CANCELLED" : start + i * 600_000 < Date.now() ? "COMPLETED" : "CONFIRMED") as
        | "CANCELLED"
        | "COMPLETED"
        | "CONFIRMED",
      idempotencyKey: `perf-${s}-${i}`,
    })),
    (chunk) => db.booking.createMany({ data: chunk }),
  );

  const exercises = await db.exercise.createManyAndReturn({
    data: Array.from({ length: 30 }, (_, i) => ({
      slug: `perf-${s}-ex-${i}`,
      name: `Ejercicio perf ${i}`,
      tenantId: t.tenantId,
      defaultSets: 3,
      defaultReps: 12,
    })),
    select: { id: true },
  });

  const programs = await db.treatmentProgram.createManyAndReturn({
    data: Array.from({ length: 200 }, (_, i) => ({
      tenantId: t.tenantId,
      patientId: patientIds[i],
      title: `Plan perf ${i}`,
      totalSessions: 20,
      frequency: 2,
      startDate: new Date(start),
      status: "ACTIVE" as const,
    })),
    select: { id: true },
  });

  const sessions = await db.session.createManyAndReturn({
    data: programs.flatMap((p, pi) =>
      Array.from({ length: 20 }, (_, k) => ({
        programId: p.id,
        practitionerId: pi % 2 === 0 ? t.practitionerId : kine2.practitionerId,
        index: k + 1,
        scheduledFor: new Date(start + (k * 3 + (pi % 3)) * 86_400_000),
        // Past sessions mostly closed; some left open (the Seguimiento "vencidas" case).
        completedAt: k < 8 && k % 5 !== 0 ? new Date(start + k * 3 * 86_400_000) : null,
      })),
    ),
    select: { id: true },
  });

  await inChunks(
    sessions.flatMap((ss, si) =>
      Array.from({ length: 6 }, (_, o) => ({
        sessionId: ss.id,
        exerciseId: exercises[(si + o) % exercises.length].id,
        order: o,
        sets: 3,
        reps: 12,
      })),
    ),
    (chunk) => db.sessionExercise.createMany({ data: chunk }),
  );

  await inChunks(
    Array.from({ length: 50_000 }, (_, i) => ({
      tenantId: t.tenantId,
      actorId: t.userId,
      action: i % 3 === 0 ? "booking.create" : "patient.read",
      entity: i % 3 === 0 ? "Booking" : "Patient",
      entityId: patientIds[i % patientIds.length],
    })),
    (chunk) => db.auditEvent.createMany({ data: chunk }),
  );

  // Fresh bulk inserts leave planner statistics empty (it estimates 1 row
  // where there are 10k) and prod tables are analyzed by autovacuum: without
  // this the baseline measures a stale-stats artifact, not the real plan.
  await db.$executeRawUnsafe(
    `ANALYZE "Patient", "Coverage", "Booking", "Payment", "TreatmentProgram", "Session", "SessionExercise", "AuditEvent", "Exercise"`,
  );

  return { ...t, patientIds, secondServiceId };
}
