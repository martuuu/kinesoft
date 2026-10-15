/**
 * [PL-A] Recorte de auditoría (plan §20.5.9; PL-D13/D14). Decisión de Martin (15-oct): no se audita «quién hace
 * qué» al detalle. Queda seguridad y acceso, plata, integridad de HC y Plataforma; lo demás se borra.
 *
 *  1. Lecturas de PHI: abrir el perfil del paciente NO escribe `AuditEvent` (antes `patient.read*` en cada
 *     apertura: una fila por render, sin valor de control y con costo en cada request).
 *  2. Lo que queda va EN LA MISMA TX del write (`auditInTx`): el evento existe si y solo si el write existe. Antes
 *     `audit()` escribía por otra conexión y tragaba el error: si fallaba, el cambio de plata/acceso quedaba sin
 *     rastro. Se prueba al revés de lo obvio: un trigger temporal hace FALLAR el INSERT del audit de ESTA entidad y
 *     se afirma que el write del caller también se revirtió (con el audit aparte, el write quedaba commiteado).
 *  3. Sin tx de escritura (exports): `auditSecurityEvent()` por el canal service, y funciona con el consultorio en
 *     solo lectura (es justo cuando más se exporta).
 *
 * Símbolos reales contra Postgres, en los dos roles (`npm run test:integration -- audit-trim` y `:owner`).
 * El trigger se crea con el owner y filtra por `entityId`: no toca a otros tests que corran en paralelo.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { getPatientCore, setPatientDefaultCopago, setPatientShares, createPatient } from "@/lib/patients";
import { deleteBooking, setBookingCopagoPaid } from "@/lib/bookings";
import { exportPatientsCsv } from "@/lib/patients-export-internal";
import { GET as exportTenant } from "@/app/api/consultorio/export/route";
import { getActor } from "@/lib/session";
import { asUser } from "@/tests/helpers/actor";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("[PL-A] recorte de auditoría", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  const prevEnforcement = process.env.TENANT_ACCESS_ENFORCEMENT;

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db, { sharedPatientView: true });
  });

  afterAll(async () => {
    await A?.cleanup();
    await db?.$disconnect();
  });

  afterEach(() => {
    if (prevEnforcement === undefined) delete process.env.TENANT_ACCESS_ENFORCEMENT;
    else process.env.TENANT_ACCESS_ENFORCEMENT = prevEnforcement;
  });

  /**
   * Hace fallar el INSERT de `AuditEvent` de UNA entidad mientras corre `fn`. Los ids son cuid/uuid generados acá
   * (sin comillas posibles), por eso el SQL se arma con el valor literal.
   */
  async function withFailingAudit<T>(entityId: string, fn: () => Promise<T>): Promise<T> {
    const name = `pl_a_fail_${uniqueSuffix().replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
    if (!/^[A-Za-z0-9_-]+$/.test(entityId)) throw new Error(`id inesperado: ${entityId}`);
    await db.$executeRawUnsafe(`
      CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."entityId" = '${entityId}' THEN RAISE EXCEPTION 'pl-a: audit forzado a fallar'; END IF;
        RETURN NEW;
      END $$`);
    await db.$executeRawUnsafe(
      `CREATE TRIGGER ${name} BEFORE INSERT ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION ${name}()`
    );
    try {
      return await fn();
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON "AuditEvent"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${name}()`);
    }
  }

  async function seedBooking(patientId: string) {
    return db.booking.create({
      data: {
        tenantId: A.tenantId,
        patientId,
        practitionerId: A.practitionerId,
        serviceId: A.serviceId,
        // Día al azar en 2031: dos turnos del mismo paciente nunca chocan en el índice único parcial.
        scheduledFor: new Date(Date.UTC(2031, 0, 1 + Math.floor(Math.random() * 360), 13)),
        durationMin: 45,
        status: "CONFIRMED",
        idempotencyKey: randomUUID(),
      },
    });
  }

  const auditsOf = (entityId: string) => db.auditEvent.findMany({ where: { tenantId: A.tenantId, entityId } });

  // ── 1. Lecturas de PHI ─────────────────────────────────────────────────

  it("[PL-A] abrir el perfil escribe AuditEvent → ya no (full, admin y básico)", async () => {
    const assistant = await addPractitioner(db, A, "ASSISTANT");
    const p = await addPatient(db, A);
    asUser(A.userId);
    expect((await getPatientCore(p))?.access).toBe("full");
    asUser(assistant.userId);
    expect((await getPatientCore(p))?.access).toBe("admin");
    expect(await auditsOf(p)).toHaveLength(0);
  });

  it("[PL-A] ruido: el alta demográfica del paciente no audita", async () => {
    asUser(A.userId);
    const r = await createPatient({ firstName: "Ruido", lastName: `Alta ${uniqueSuffix()}`, documentId: `PLA-${uniqueSuffix()}` });
    if (!r.ok) throw new Error(r.error);
    expect(await auditsOf(r.data.id)).toHaveLength(0);
  });

  // ── 2. Plata y acceso en la misma tx ───────────────────────────────────

  it("[PL-A] copago del paciente: audit en la tx (si el audit falla, el copago no queda)", async () => {
    asUser(A.userId);
    const p = await addPatient(db, A);
    await expect(withFailingAudit(p, () => setPatientDefaultCopago({ patientId: p, copagoCents: 12345 }))).rejects.toThrow();
    expect(await db.coverage.count({ where: { patientId: p, copagoCents: 12345 } })).toBe(0);
    // Control: sin el trigger, escribe el copago Y su audit.
    expect((await setPatientDefaultCopago({ patientId: p, copagoCents: 12345 })).ok).toBe(true);
    expect(await db.coverage.count({ where: { patientId: p, copagoCents: 12345 } })).toBe(1);
    expect((await auditsOf(p)).map((e) => e.action)).toEqual(["patient.copago.update"]);
  });

  it("[PL-A] compartir paciente: audit en la tx (si el audit falla, no se comparte)", async () => {
    asUser(A.userId);
    const other = await addPractitioner(db, A, "PRACTITIONER");
    const p = await addPatient(db, A);
    await expect(
      withFailingAudit(p, () => setPatientShares({ patientId: p, practitionerIds: [other.practitionerId] }))
    ).rejects.toThrow();
    expect(await db.patientShare.count({ where: { patientId: p } })).toBe(0);
    expect((await setPatientShares({ patientId: p, practitionerIds: [other.practitionerId] })).ok).toBe(true);
    expect(await db.patientShare.count({ where: { patientId: p } })).toBe(1);
    expect((await auditsOf(p)).map((e) => e.action)).toEqual(["patient.share.update"]);
  });

  it("[PL-A] borrar turno: audit en la tx (si el audit falla, el turno sigue)", async () => {
    asUser(A.userId);
    const p = await addPatient(db, A);
    const b = await seedBooking(p);
    await expect(withFailingAudit(b.id, () => deleteBooking(b.id, b.updatedAt.toISOString()))).rejects.toThrow();
    expect(await db.booking.count({ where: { id: b.id } })).toBe(1);
    expect((await deleteBooking(b.id, b.updatedAt.toISOString())).ok).toBe(true);
    expect(await db.booking.count({ where: { id: b.id } })).toBe(0);
    expect((await auditsOf(b.id)).map((e) => e.action)).toEqual(["booking.delete"]);
  });

  it("[PL-A] cobro del copago del turno: audit en la tx (si el audit falla, no queda cobrado)", async () => {
    asUser(A.userId);
    const p = await addPatient(db, A);
    const b = await seedBooking(p);
    await expect(withFailingAudit(b.id, () => setBookingCopagoPaid(b.id, true, b.updatedAt.toISOString()))).rejects.toThrow();
    expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).paymentStatus).not.toBe("PAID");
    expect((await setBookingCopagoPaid(b.id, true, b.updatedAt.toISOString())).ok).toBe(true);
    expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).paymentStatus).toBe("PAID");
    expect((await auditsOf(b.id)).map((e) => e.action)).toEqual(["booking.copago_paid"]);
  });

  // ── 3. Exports en solo lectura ─────────────────────────────────────────

  it("[PL-A] export del consultorio y de pacientes en solo lectura: siguen auditados (auditSecurityEvent)", async () => {
    const R = await createEphemeralTenant(db);
    try {
      await addPatient(db, R);
      await db.tenant.update({ where: { id: R.tenantId }, data: { subscriptionStatus: "CANCELLED" } });
      process.env.TENANT_ACCESS_ENFORCEMENT = "enforce";
      asUser(R.userId);

      const res = await exportTenant(new Request("http://localhost/api/consultorio/export"));
      expect(res.status).toBe(200);
      await res.text();
      const actions = (await db.auditEvent.findMany({ where: { tenantId: R.tenantId, actorId: R.userId } })).map((e) => e.action);
      expect(actions).toEqual(expect.arrayContaining(["tenant.export.started", "tenant.export"]));

      await exportPatientsCsv(await getActor());
      expect(await db.auditEvent.count({ where: { tenantId: R.tenantId, action: "patient.export", actorId: R.userId } })).toBe(1);
    } finally {
      await R.cleanup();
    }
  });
});
