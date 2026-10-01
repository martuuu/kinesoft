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
import { localToARIso, toARDateKey, toARDow } from "@/lib/datetime-ar";

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

// ─────────────────────────────────────────────────────────────────────────────
// B4.6 PERF — agenda multi-profesional con volumen de Secretaria
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tenant EFÍMERO con la forma de un consultorio con gimnasio (el caso que
 * motivó B-pre): 6 profesionales, 2 sedes, franjas mañana/tarde Lun-Vie,
 * reglas por profesional × servicio (PractitionerService), coberturas por
 * profesional (PractitionerPayer), bloqueos y una excepción.
 *
 *   · 3 profesionales de GIMNASIO (servicio "Gimnasio", 60', cupo null =
 *     ilimitado) con ~40 turnos por franja: 80 por día cada uno.
 *   · 3 osteópatas (servicio "Osteopatía", 60', cupo 1): un turno por hora
 *     de franja (~11 por día). Uno con override de duración y cupo.
 *   → ~273 turnos por día hábil, ~1.365 en la semana medida (la actual, AR)
 *     + 4 semanas antes y 4 después a media densidad (~5.500) como volumen
 *     de fondo para la selectividad de los índices.
 *   · 1.000 pacientes (la mitad con cobertura); los 900 primeros tienen
 *     turnos, los 100 últimos quedan LIBRES para los write-paths.
 *
 * Igual que `createVolumeTenant`: no es un seed, se crea y se borra en cada
 * corrida (`cleanup`; Location/PractitionerSchedule/TimeBlock/… cascadean
 * desde el Tenant, PractitionerService desde Service).
 */
export type AgendaMultiTenant = EphemeralTenant & {
  patientIds: string[];
  /** Índices 900..999 de `patientIds`: sin turnos (para createBooking/batch). */
  freePatientIds: string[];
  practitionerIds: string[];
  gymPractitionerIds: string[];
  osteoPractitionerIds: string[];
  gymServiceId: string;
  osteoServiceId: string;
  primaryLocationId: string;
  northLocationId: string;
  insurerIds: string[];
  /** Lunes AR de la semana medida (YYYY-MM-DD). */
  weekMondayKey: string;
  /** Turnos creados en la semana medida (incluye cancelados). */
  weekBookingCount: number;
  totalBookingCount: number;
};

/** YYYY-MM-DD + n días (calendario puro, sin reloj del host). */
function addDayKey(dayKey: string, n: number): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}
const at = (dayKey: string, minOfDay: number) =>
  new Date(
    localToARIso(`${dayKey}T${String(Math.floor(minOfDay / 60)).padStart(2, "0")}:${String(minOfDay % 60).padStart(2, "0")}:00`),
  );

/** Franjas Lun-Vie: mañana 08-13 y tarde 14-20 (en minutos AR). */
const FRANJAS = [
  { startMin: 8 * 60, endMin: 13 * 60 },
  { startMin: 14 * 60, endMin: 20 * 60 },
] as const;
const GYM_PER_FRANJA = 40;

export async function createAgendaMultiTenant(db: PrismaClient): Promise<AgendaMultiTenant> {
  const t = await createEphemeralTenant(db, { sharedPatientView: false });
  const s = uniqueSuffix();
  const others = [];
  for (let i = 0; i < 5; i++) others.push((await addPractitioner(db, t)).practitionerId);
  const practitionerIds = [t.practitionerId, ...others];
  const gymPractitionerIds = practitionerIds.slice(0, 3);
  const osteoPractitionerIds = practitionerIds.slice(3);

  const gymServiceId = await addService(db, t, { name: "Gimnasio", durationMin: 60, maxConcurrent: null });
  const osteoServiceId = await addService(db, t, { name: "Osteopatía", durationMin: 60, maxConcurrent: 1 });
  const insurerIds = [
    t.particularInsurerId,
    await addInsurer(db, t, { copagoCents: 150000 }),
    await addInsurer(db, t, { copagoCents: 90000 }),
  ];

  const primary = await db.location.create({ data: { tenantId: t.tenantId, name: "Principal", isPrimary: true } });
  const north = await db.location.create({ data: { tenantId: t.tenantId, name: "Norte", sortOrder: 1 } });

  // Franjas: Lun-Vie (dow 1..5, 0=Dom). Los osteópatas atienden la tarde en Norte.
  await db.practitionerSchedule.createMany({
    data: practitionerIds.flatMap((pid, pi) =>
      [1, 2, 3, 4, 5].flatMap((dow) =>
        FRANJAS.map((f, fi) => ({
          tenantId: t.tenantId,
          practitionerId: pid,
          locationId: pi >= 3 && fi === 1 ? north.id : primary.id,
          dow,
          startMin: f.startMin,
          endMin: f.endMin,
        })),
      ),
    ),
  });

  // Reglas por profesional × servicio: cada uno habilitado en lo suyo y
  // deshabilitado en lo del otro grupo; un osteópata con duración y cupo propios.
  await db.practitionerService.createMany({
    data: practitionerIds.flatMap((pid, pi) => {
      const gym = pi < 3;
      return [
        { tenantId: t.tenantId, practitionerId: pid, serviceId: gymServiceId, enabled: gym },
        {
          tenantId: t.tenantId,
          practitionerId: pid,
          serviceId: osteoServiceId,
          enabled: !gym,
          ...(pi === 5 ? { durationMin: 50, concurrencyOverride: true, maxConcurrent: 1 } : {}),
        },
      ];
    }),
  });
  await db.practitionerPayer.createMany({
    data: practitionerIds.flatMap((pid, pi) =>
      (pi < 3 ? insurerIds.slice(0, 2) : insurerIds).map((insurerId) => ({ tenantId: t.tenantId, practitionerId: pid, insurerId })),
    ),
  });

  const patients = await db.patient.createManyAndReturn({
    data: Array.from({ length: 1000 }, (_, i) => ({
      tenantId: t.tenantId,
      firstName: `Nombre${i}`,
      lastName: `Apellido${i}`,
      documentId: `AM${s}-${i}`,
      email: `am${i}-${s}@perf.local`,
      assignedPractitionerId: practitionerIds[i % practitionerIds.length],
    })),
    select: { id: true },
  });
  const patientIds = patients.map((p) => p.id);
  await db.coverage.createMany({
    data: patientIds
      .filter((_, i) => i % 2 === 0)
      .map((patientId, i) => ({ patientId, insurer: "OS", insurerId: insurerIds[1 + (i % 2)], memberId: `M${i}` })),
  });

  // Semana medida = la actual (lunes AR), como el baseline de A1.
  const today = toARDateKey(new Date());
  const weekMondayKey = addDayKey(today, -((toARDow(new Date()) + 6) % 7));
  const nowMs = Date.now();

  type Row = {
    tenantId: string;
    patientId: string;
    practitionerId: string;
    serviceId: string;
    scheduledFor: Date;
    durationMin: number;
    status: "CANCELLED" | "COMPLETED" | "CONFIRMED";
    idempotencyKey: string;
    locationId: string | null;
    isOverbooked: boolean;
    arrivedAt: Date | null;
  };
  const rows: Row[] = [];
  let weekBookingCount = 0;
  // El contador de paciente avanza por turno: los ~273 de un día son
  // consecutivos (< 900), así que (paciente, instante) nunca repite y el
  // índice único parcial no salta.
  let counter = 0;
  for (let w = -4; w <= 4; w++) {
    const stride = w === 0 ? 1 : 2; // fondo a media densidad
    for (let d = 0; d < 5; d++) {
      const dayKey = addDayKey(weekMondayKey, w * 7 + d);
      practitionerIds.forEach((pid, pi) => {
        FRANJAS.forEach((f, fi) => {
          const hours = (f.endMin - f.startMin) / 60;
          const isGym = pi < 3;
          const n = isGym ? GYM_PER_FRANJA : hours;
          for (let k = 0; k < n; k += stride) {
            const startMin = f.startMin + (k % hours) * 60;
            const when = at(dayKey, startMin);
            const idx = counter++;
            const past = when.getTime() < nowMs;
            rows.push({
              tenantId: t.tenantId,
              patientId: patientIds[idx % 900],
              practitionerId: pid,
              serviceId: isGym ? gymServiceId : osteoServiceId,
              scheduledFor: when,
              durationMin: isGym ? 60 : pi === 5 ? 50 : 60,
              status: idx % 17 === 0 ? "CANCELLED" : past ? "COMPLETED" : "CONFIRMED",
              idempotencyKey: `am-${s}-${idx}`,
              // Mitad de los de la principal con locationId null (contrato de M-agenda).
              locationId: pi >= 3 && fi === 1 ? north.id : idx % 2 === 0 ? null : primary.id,
              isOverbooked: isGym ? false : idx % 23 === 0,
              arrivedAt: past && idx % 3 === 0 ? when : null,
            });
            if (w === 0) weekBookingCount++;
          }
        });
      });
    }
  }
  await inChunks(rows, (chunk) => db.booking.createMany({ data: chunk }));

  // Bloqueos de la semana medida: un día entero de un osteópata, una reunión
  // de equipo (todos) y un bloqueo de sede; más uno por semana de fondo.
  const blocks = [
    { practitionerId: osteoPractitionerIds[2], locationId: null, startsAt: at(addDayKey(weekMondayKey, 2), 0), endsAt: at(addDayKey(weekMondayKey, 3), 0), allDay: true, reason: "Congreso" },
    { practitionerId: null, locationId: null, startsAt: at(addDayKey(weekMondayKey, 3), 12 * 60), endsAt: at(addDayKey(weekMondayKey, 3), 14 * 60), allDay: false, reason: "Reunión de equipo" },
    { practitionerId: gymPractitionerIds[1], locationId: primary.id, startsAt: at(addDayKey(weekMondayKey, 4), 18 * 60), endsAt: at(addDayKey(weekMondayKey, 4), 20 * 60), allDay: false, reason: "Trámite" },
    ...[-4, -3, -2, -1, 1, 2, 3, 4].map((w) => ({
      practitionerId: practitionerIds[(w + 8) % 6],
      locationId: null,
      startsAt: at(addDayKey(weekMondayKey, w * 7 + 1), 9 * 60),
      endsAt: at(addDayKey(weekMondayKey, w * 7 + 1), 11 * 60),
      allDay: false,
      reason: "Fondo",
    })),
  ];
  await db.timeBlock.createMany({ data: blocks.map((b) => ({ ...b, tenantId: t.tenantId, createdById: t.userId })) });
  await db.scheduleException.create({
    data: {
      tenantId: t.tenantId,
      practitionerId: gymPractitionerIds[2],
      date: new Date(`${addDayKey(weekMondayKey, 11)}T00:00:00.000Z`),
      kind: "CLOSED",
      reason: "Franco",
      createdById: t.userId,
    },
  });

  await db.$executeRawUnsafe(
    `ANALYZE "Patient", "Coverage", "Booking", "Location", "PractitionerSchedule", "PractitionerService", "PractitionerPayer", "TimeBlock", "ScheduleException", "Service", "Practitioner", "Membership"`,
  );

  return {
    ...t,
    patientIds,
    freePatientIds: patientIds.slice(900),
    practitionerIds,
    gymPractitionerIds,
    osteoPractitionerIds,
    gymServiceId,
    osteoServiceId,
    primaryLocationId: primary.id,
    northLocationId: north.id,
    insurerIds,
    weekMondayKey,
    weekBookingCount,
    totalBookingCount: rows.length,
  };
}
