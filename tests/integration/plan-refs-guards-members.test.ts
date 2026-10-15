/**
 * S13g (ES2b, P2.0) — guardas de sede y de miembro frente a Planes.
 *
 * Desde M1 (`plans_booking_link`) `TreatmentProgram.practitionerId` (responsable,
 * D17) y `TreatmentProgram.locationId` (1 sede por plan) son FK RESTRICT. Pero
 * ni archivar una sede ni quitar a un miembro BORRAN la fila referida (archivar
 * = `active=false`; quitar = borra la Membership, el Practitioner queda), así
 * que la FK no frena nada: sin estas guardas, un plan ACTIVO quedaba con una
 * sede archivada (el motor ya no ofrece slots ahí) o con un responsable que ya
 * no puede entrar ni gestionar el plan. I7 (§2.4): "guardas en
 * `archiveLocation`, `removeMember`".
 *
 * Lo que se afirma (efecto observable en la base, no solo el `ok`):
 *   • `archiveLocation` con planes ACTIVE vivos en la sede → rechazo con conteo
 *     y la sede sigue activa; CANCELLED / COMPLETED / archivados no bloquean;
 *   • `removeMember` del responsable de planes ACTIVE → rechazo con conteo y la
 *     membresía sigue; los bloqueos A2b (turnos futuros, pacientes asignados)
 *     se preservan y se suman en el mismo mensaje;
 *   • `changeMemberRole` a un rol que no puede gestionar planes (ASSISTANT,
 *     BILLING y, desde §20.17, ADMIN: el Administrador/a no atiende) del responsable de planes ACTIVE → rechazo
 *     con conteo.
 *
 * Corre en los dos roles (`kinesoft_app` con RLS y owner BYPASSRLS = prod).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { archiveLocation } from "@/lib/locations";
import { removeMember, changeMemberRole } from "@/lib/invitations";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  addPatient,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { createPlan } from "@/tests/helpers/plan-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("S13g · guardas de sede y miembro con planes activos", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;

  const membershipOf = (t: EphemeralTenant, userId: string) =>
    db.membership.findFirstOrThrow({ where: { tenantId: t.tenantId, userId }, select: { id: true } });

  const addLocation = async (t: EphemeralTenant) =>
    (
      await db.location.create({
        data: { tenantId: t.tenantId, name: `Sede ${uniqueSuffix()}`, isPrimary: false },
        select: { id: true },
      })
    ).id;

  /** Paciente sin profesional asignado: así el bloqueo A2b de "pacientes asignados" no se mezcla. */
  const loosePatient = (t: EphemeralTenant) => addPatient(db, t, { assignedPractitionerId: null });

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db, { saasPlan: "CLINICA" }); // PL-1: sala de espera y equipo son de Clínica
    B = await createEphemeralTenant(db, { saasPlan: "CLINICA" }); // PL-1: sala de espera y equipo son de Clínica
  });
  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await db?.$disconnect();
  });

  // ── sede ────────────────────────────────────────────────────────────────
  it("archiveLocation: planes ACTIVE en la sede → rechazo con conteo; la sede sigue activa", async () => {
    asUser(A.userId);
    const loc = await addLocation(A);
    // Sin turnos (`bookings: 0`): el bloqueo es SOLO por los planes.
    await createPlan(db, A, { patientId: await loosePatient(A), data: { locationId: loc } });
    await createPlan(db, A, { patientId: await loosePatient(A), data: { locationId: loc } });
    // No cuentan: cancelado, completado y activo pero archivado.
    await createPlan(db, A, { patientId: await loosePatient(A), data: { locationId: loc, status: "CANCELLED" } });
    await createPlan(db, A, { patientId: await loosePatient(A), data: { locationId: loc, status: "COMPLETED" } });
    await createPlan(db, A, {
      patientId: await loosePatient(A),
      data: { locationId: loc, status: "CANCELLED", archivedAt: new Date() },
    });

    const r = await archiveLocation(loc);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("2 planes activos");
      expect(r.error).not.toContain("turno");
      // Los conteos A2b/B-pre siguen saliendo en `blockers` (forma sin cambios).
      expect(r.blockers).toEqual({ activeSchedules: 0, futureBookings: 0, futureExceptions: 0 });
    }
    expect((await db.location.findUniqueOrThrow({ where: { id: loc } })).active).toBe(true);
    expect(
      await db.auditEvent.count({ where: { tenantId: A.tenantId, action: "location.archive", entityId: loc } })
    ).toBe(0);
  });

  it("archiveLocation: sin planes ACTIVE (solo cerrados) archiva", async () => {
    asUser(A.userId);
    const loc = await addLocation(A);
    await createPlan(db, A, { patientId: await loosePatient(A), data: { locationId: loc, status: "COMPLETED" } });
    const r = await archiveLocation(loc);
    expect(r).toEqual({ ok: true, data: undefined });
    expect((await db.location.findUniqueOrThrow({ where: { id: loc } })).active).toBe(false);
  });

  it("archiveLocation: un plan ACTIVE en la sede de OTRO tenant no cuenta (tenantId a mano)", async () => {
    asUser(A.userId);
    const locA = await addLocation(A);
    // Fila envenenada de B apuntando a la sede de A (la FK de M1 es simple, no
    // compuesta con tenantId, así que la base la acepta). El conteo de A no la
    // tiene que ver: en owner BYPASSRLS el `tenantId` a mano es la única barrera.
    const poisoned = await createPlan(db, B, { patientId: await loosePatient(B), data: { locationId: locA } });
    try {
      const r = await archiveLocation(locA);
      expect(r.ok).toBe(true);
      expect((await db.location.findUniqueOrThrow({ where: { id: locA } })).active).toBe(false);
    } finally {
      // Sin esto el cleanup de A choca con la FK RESTRICT del plan de B.
      await db.session.deleteMany({ where: { programId: poisoned.programId } });
      await db.treatmentProgram.delete({ where: { id: poisoned.programId } });
    }
  });

  // ── miembro ─────────────────────────────────────────────────────────────
  it("removeMember: responsable de planes ACTIVE → rechazo con conteo y la membresía queda", async () => {
    asUser(A.userId);
    const kine = await addPractitioner(db, A);
    await createPlan(db, A, { patientId: await loosePatient(A), practitionerId: kine.practitionerId });
    // No cuenta: plan cancelado del mismo responsable.
    await createPlan(db, A, {
      patientId: await loosePatient(A),
      practitionerId: kine.practitionerId,
      data: { status: "CANCELLED" },
    });
    const mem = await membershipOf(A, kine.userId);

    const r = await removeMember(mem.id);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("es responsable de 1 plan activo");
      expect(r.error).not.toContain("turno");
      expect(r.error).not.toContain("paciente");
    }
    expect(await db.membership.count({ where: { id: mem.id } })).toBe(1);
  });

  it("removeMember: preserva A2b — planes + pacientes asignados salen juntos en el mensaje", async () => {
    asUser(A.userId);
    const kine = await addPractitioner(db, A);
    await addPatient(db, A, { assignedPractitionerId: kine.practitionerId });
    await createPlan(db, A, { patientId: await loosePatient(A), practitionerId: kine.practitionerId });
    await createPlan(db, A, { patientId: await loosePatient(A), practitionerId: kine.practitionerId });
    const mem = await membershipOf(A, kine.userId);

    const r = await removeMember(mem.id);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("1 paciente asignado");
      expect(r.error).toContain("2 planes activos");
    }
    expect(await db.membership.count({ where: { id: mem.id } })).toBe(1);
  });

  it("removeMember: con planes solo CANCELLED/COMPLETED del responsable, quita", async () => {
    asUser(A.userId);
    const kine = await addPractitioner(db, A);
    await createPlan(db, A, {
      patientId: await loosePatient(A),
      practitionerId: kine.practitionerId,
      data: { status: "COMPLETED" },
    });
    const mem = await membershipOf(A, kine.userId);
    const r = await removeMember(mem.id);
    expect(r.ok).toBe(true);
    expect(await db.membership.count({ where: { id: mem.id } })).toBe(0);
  });

  it("changeMemberRole: responsable de planes ACTIVE no pasa a ASSISTANT, BILLING ni ADMIN (§20.17)", async () => {
    asUser(A.userId);
    const kine = await addPractitioner(db, A);
    await createPlan(db, A, { patientId: await loosePatient(A), practitionerId: kine.practitionerId });
    const mem = await membershipOf(A, kine.userId);

    for (const role of ["ASSISTANT", "BILLING", "ADMIN"] as const) {
      const r = await changeMemberRole(mem.id, role);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("es responsable de 1 plan activo");
      expect((await db.membership.findUniqueOrThrow({ where: { id: mem.id } })).role).toBe("PRACTITIONER");
    }
  });

  it("changeMemberRole: sin planes ACTIVE a cargo, pasa a ASSISTANT", async () => {
    asUser(A.userId);
    const kine = await addPractitioner(db, A);
    const mem = await membershipOf(A, kine.userId);
    const r = await changeMemberRole(mem.id, "ASSISTANT");
    expect(r.ok).toBe(true);
    expect((await db.membership.findUniqueOrThrow({ where: { id: mem.id } })).role).toBe("ASSISTANT");
  });
});
