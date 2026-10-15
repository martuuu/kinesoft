/**
 * PF-0d (§20.4) · acciones sin doble render.
 *
 * El cliente de agenda, pacientes y Recepción ya NO hace `router.refresh()`
 * después de estas actions: la vista nueva llega SOLO porque la action llama
 * `revalidatePath` (en Next 14.2 eso hace que la respuesta de la action traiga
 * el árbol RSC de la página actual; ver el canario en
 * tests/unit/refresh-ratchet.test.ts). Si una rama OK deja de revalidar, la
 * pantalla queda vieja sin que ningún test de UI lo note: por eso se afirma acá,
 * con las actions reales contra Postgres (solo `next/cache` mockeado).
 *
 * Se afirma también el reverso donde importa: "cambió en otra sesión" NO
 * revalida, y por eso Recepción conserva un `router.refresh()` en esa rama.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createBooking, markReceptionAction } from "@/lib/bookings";
import { bulkArchivePatients, setPatientArchived } from "@/lib/patients";
import { STALE_ERROR } from "@/lib/bookings-constants";
import { localToARIso } from "@/lib/datetime-ar";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  sweepOrphanTestTenants,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { createPlan } from "@/tests/helpers/plan-factory";
import { revalidatePathSpy } from "@/tests/helpers/integration-setup";

const RUN = process.env.INTEGRATION === "1";
const ar = (day: string, hhmm: string) => new Date(localToARIso(`${day}T${hhmm}:00`)).toISOString();

describe.skipIf(!RUN)("PF-0d · las actions sin refresh del cliente revalidan en todo OK", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    A = await createEphemeralTenant(db);
    asUser(A.userId);
  });

  afterAll(async () => {
    await A?.cleanup();
    await db?.$disconnect();
  });

  it("[PF-0d] reintento de createBooking (misma key) → revalida /agenda", async () => {
    asUser(A.userId);
    const p = await addPatient(db, A);
    const payload = {
      patientId: p,
      serviceId: A.serviceId,
      practitionerId: A.practitionerId,
      scheduledFor: ar("2027-05-03", "10:00"),
      durationMin: 45,
      idempotencyKey: randomUUID(),
    };
    const r1 = await createBooking(payload);
    expect(r1.ok).toBe(true);
    revalidatePathSpy.mockClear();
    // La respuesta del primero "se perdió": el cliente reintenta con la misma key.
    const r2 = await createBooking(payload);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) expect(r2.data.id).toBe(r1.data.id);
    expect(revalidatePathSpy).toHaveBeenCalledWith("/agenda");
    expect(await db.booking.count({ where: { tenantId: A.tenantId, patientId: p } })).toBe(1);
  });

  it("[PF-0d] reintento de un alta que ya adoptó un plan (rama `adopted`, no escribe) → revalida /agenda igual", async () => {
    asUser(A.userId);
    const plan = await createPlan(db, A, { sessions: 1 });
    const payload = {
      patientId: plan.patientId,
      serviceId: A.serviceId,
      practitionerId: A.practitionerId,
      scheduledFor: ar("2027-05-04", "10:00"),
      durationMin: 45,
      idempotencyKey: randomUUID(),
    };
    const r1 = await createBooking(payload);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    // Un plan adoptó el turno (C3) antes de que llegara el reintento.
    await db.booking.update({ where: { id: r1.data.id }, data: { programId: plan.programId, sessionId: plan.sessionIds[0] } });
    const before = await db.booking.findUniqueOrThrow({ where: { id: r1.data.id } });
    revalidatePathSpy.mockClear();
    const r2 = await createBooking(payload);
    expect(r2).toEqual({ ok: true, data: { id: r1.data.id } });
    expect(revalidatePathSpy).toHaveBeenCalledWith("/agenda");
    // Sigue sin escribir: la fila es la misma versión.
    const after = await db.booking.findUniqueOrThrow({ where: { id: r1.data.id } });
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
  });

  it("[PF-0d] Recepción OK revalida /agenda; «cambió en otra sesión» no revalida (el cliente refresca)", async () => {
    asUser(A.userId);
    const b = await db.booking.create({
      data: {
        tenantId: A.tenantId,
        practitionerId: A.practitionerId,
        serviceId: A.serviceId,
        patientId: await addPatient(db, A),
        scheduledFor: new Date(),
        durationMin: 45,
        status: "CONFIRMED",
        idempotencyKey: randomUUID(),
      },
    });
    revalidatePathSpy.mockClear();
    const ok = await markReceptionAction(b.id, "llego", b.updatedAt.toISOString());
    expect(ok.ok).toBe(true);
    expect(revalidatePathSpy).toHaveBeenCalledWith("/agenda");

    revalidatePathSpy.mockClear();
    // Mismo `updatedAt` viejo: otra pestaña ya lo cambió.
    const stale = await markReceptionAction(b.id, "llego", b.updatedAt.toISOString());
    expect(stale).toEqual({ ok: false, error: STALE_ERROR });
    expect(revalidatePathSpy).not.toHaveBeenCalled();
  });

  it("[PF-0d] archivar (fila y en lote) revalida la lista y la ficha", async () => {
    asUser(A.userId);
    const p1 = await addPatient(db, A);
    const p2 = await addPatient(db, A);
    revalidatePathSpy.mockClear();
    expect((await setPatientArchived({ id: p1, archived: true })).ok).toBe(true);
    expect(revalidatePathSpy).toHaveBeenCalledWith("/pacientes");
    expect(revalidatePathSpy).toHaveBeenCalledWith(`/pacientes/${p1}`);

    revalidatePathSpy.mockClear();
    expect((await bulkArchivePatients({ ids: [p2], archived: true })).ok).toBe(true);
    expect(revalidatePathSpy).toHaveBeenCalledWith("/pacientes");
    const rows = await db.patient.findMany({ where: { id: { in: [p1, p2] } }, select: { archivedAt: true } });
    expect(rows.every((r) => r.archivedAt !== null)).toBe(true);
  });
});
