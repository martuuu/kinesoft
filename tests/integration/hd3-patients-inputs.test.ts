/**
 * HD-3 (PV §27, sesión W1h) — topes y zod de entrada en las actions del paciente.
 *
 * Next expone todo export de un archivo `"use server"` como RPC: el cliente no es solo nuestro form. Sin tope, se podía
 * guardar una EVA fuera de 0..10 (o con decimales), un diagnóstico de megas, o pedir miles de turnos/eventos de
 * auditoría en una sola llamada. Se prueba sobre las actions reales (`recordEvaScore`, `setPatientDiagnosis`,
 * `getPatientBookingsSummary` → `patientBookingsSummaryInTx`, `getPatientActivity`) con el actor real; solo se mockea
 * la sesión (`asUser`). Efecto observable: la fila (no) quedó, la lista tiene ≤ N.
 *
 * Controles contra el falso verde: EVA 7 se guarda, un diagnóstico dentro del tope se guarda, `take` y `limit`
 * normales (5 y 80, lo que mandan el perfil y la pestaña Actividad) devuelven exactamente eso.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  recordEvaScore,
  setPatientDiagnosis,
  getPatientBookingsSummary,
  getPatientActivity,
} from "@/lib/patients";
import { ownerClient, createEphemeralTenant, addPatient, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { asUser, asAnonymous } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("HD-3 · topes de entrada en pacientes", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "PRO" });
  });

  afterAll(async () => {
    asAnonymous();
    await A?.cleanup();
    await db?.$disconnect();
  });

  it("[HD-3] EVA 11 / −1 / 7.5 rechazada sin fila nueva; EVA 7 ok", async () => {
    const p = await addPatient(db, A);
    asUser(A.userId);
    for (const value of [11, -1, 7.5]) {
      const r = await recordEvaScore({ patientId: p, value });
      expect(r).toEqual({ ok: false, error: "La EVA va de 0 a 10." });
    }
    // patientId de más de 64 → mismo rechazo, sin tocar la base.
    expect((await recordEvaScore({ patientId: "x".repeat(65), value: 5 })).ok).toBe(false);
    expect(await db.evaScore.count({ where: { patientId: p } })).toBe(0);

    const ok = await recordEvaScore({ patientId: p, value: 7 });
    expect(ok.ok).toBe(true);
    expect((await db.evaScore.findMany({ where: { patientId: p } })).map((e) => e.value)).toEqual([7]);
  });

  it("[HD-3] diagnóstico: título de 201 rechazado y diagnóstico intacto; nota de 4001 rechazada", async () => {
    const p = await addPatient(db, A);
    await db.patient.update({ where: { id: p }, data: { diagnosisTitle: "Original", diagnosisNote: "Nota" } });
    asUser(A.userId);

    expect((await setPatientDiagnosis(p, "t".repeat(201), "")).ok).toBe(false);
    expect((await setPatientDiagnosis(p, "Nuevo", "n".repeat(4001))).ok).toBe(false);
    // Por RPC puede llegar cualquier cosa: un no-string ya no rompe con TypeError en `.trim()`.
    expect((await setPatientDiagnosis(p, 123 as unknown as string, "")).ok).toBe(false);
    expect((await setPatientDiagnosis("x".repeat(65), "Nuevo", "")).ok).toBe(false);
    expect(await db.patient.findUniqueOrThrow({ where: { id: p } })).toMatchObject({
      diagnosisTitle: "Original",
      diagnosisNote: "Nota",
    });

    // Control: en el tope exacto se guarda.
    const ok = await setPatientDiagnosis(p, "t".repeat(200), "n".repeat(4000));
    expect(ok.ok).toBe(true);
    const row = await db.patient.findUniqueOrThrow({ where: { id: p } });
    expect(row.diagnosisTitle).toHaveLength(200);
    expect(row.diagnosisNote).toHaveLength(4000);
  });

  it("[HD-3] getPatientBookingsSummary con take: 10_000 devuelve ≤50", async () => {
    const p = await addPatient(db, A);
    const base = Date.UTC(2026, 0, 5, 13);
    await db.booking.createMany({
      data: Array.from({ length: 60 }, (_, i) => ({
        tenantId: A.tenantId,
        patientId: p,
        practitionerId: A.practitionerId,
        serviceId: A.serviceId,
        // Un día por turno: sin choques con el índice único parcial.
        scheduledFor: new Date(base + i * 86_400_000),
        durationMin: 45,
        status: "COMPLETED" as const,
        idempotencyKey: randomUUID(),
      })),
    });
    asUser(A.userId);
    expect(await getPatientBookingsSummary(p, 10_000)).toHaveLength(50);
    // Basura por RPC → default 5 (no NaN a Prisma); negativo → 1 (Prisma con take negativo lee desde el final).
    expect(await getPatientBookingsSummary(p, Number.NaN)).toHaveLength(5);
    expect(await getPatientBookingsSummary(p, -3)).toHaveLength(1);
    // Control: el valor del perfil y del drawer pasa tal cual, y sigue el orden desc.
    const five = await getPatientBookingsSummary(p, 5);
    expect(five).toHaveLength(5);
    expect(new Date(five[0].scheduledFor).getTime()).toBe(base + 59 * 86_400_000);
  });

  it("[HD-3] getPatientActivity con limit 0 / 500 → clamp a 1..200, sin romper el llamador real (80)", async () => {
    const p = await addPatient(db, A);
    const t0 = Date.now() - 86_400_000;
    await db.auditEvent.createMany({
      data: Array.from({ length: 250 }, (_, i) => ({
        tenantId: A.tenantId,
        actorId: A.userId,
        action: "patient.update",
        entity: "Patient",
        entityId: p,
        createdAt: new Date(t0 + i * 1000),
      })),
    });
    asUser(A.userId);
    expect(await getPatientActivity(p, { limit: 500 })).toHaveLength(200);
    // 0 / NaN = "no vino" → default 60; negativo → 1 (con el más reciente, no el más viejo).
    expect(await getPatientActivity(p, { limit: 0 })).toHaveLength(60);
    expect(await getPatientActivity(p, { limit: Number.NaN })).toHaveLength(60);
    const one = await getPatientActivity(p, { limit: -5 });
    expect(one).toHaveLength(1);
    expect(new Date(one[0].createdAt).getTime()).toBe(t0 + 249 * 1000);
    // Control: la pestaña Actividad pide 80 (components/patients/activity-view.tsx) y el default sigue en 60.
    expect(await getPatientActivity(p, { limit: 80 })).toHaveLength(80);
    expect(await getPatientActivity(p)).toHaveLength(60);
  });
});
