/**
 * Planes de tratamiento · server de `lib/programs.ts` (PLANES.md §8, P0.1 · S02a).
 *
 * Contrato de la sesión:
 *   - `createProgram` con zod y día AR: el `startDate` 'YYYY-MM-DD' del
 *     `<input type="date">` se anclaba a medianoche UTC (`new Date("2026-10-06")`
 *     = 21:00 del 05/10 en AR), así que la sesión 1 caía el día anterior;
 *   - `frequency` 0 hacía `7/0 = Infinity` → fecha inválida → 500 de Prisma;
 *   - `totalSessions` se aceptaba hasta 64, el tope de PD-04 es 60;
 *   - `updateProgram` y `setProgramStatus` validan con zod y escriben + auditan
 *     en UNA tx (antes: lectura en una tx, write en otra y audit por fuera);
 *   - `listPatients` con 2 planes ACTIVE elige el más reciente (antes `take: 1`
 *     sin `orderBy` = orden físico, no determinístico).
 *
 * Corre las actions REALES (getActor real, solo la sesión de Supabase
 * mockeada) y afirma la fila que quedó. Corre en TZ=UTC (script npm), que es
 * donde el corrimiento de día se ve: en un host AR se esconde.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createProgram, updateProgram, setProgramStatus, deleteSession } from "@/lib/programs";
import { listPatients } from "@/lib/patients";
import { toARDateKey } from "@/lib/datetime-ar";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("programas · server (P0-S02a)", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;

  async function makeProgram(patientId: string, data: { title?: string; createdAt?: Date } = {}) {
    return db.treatmentProgram.create({
      data: {
        tenantId: A.tenantId,
        patientId,
        title: data.title ?? `Plan ${uniqueSuffix()}`,
        totalSessions: 4,
        frequency: 2,
        startDate: new Date("2030-01-07T03:00:00.000Z"),
        status: "ACTIVE",
        ...(data.createdAt ? { createdAt: data.createdAt } : {}),
      },
    });
  }

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
  });

  afterAll(async () => {
    await A?.cleanup();
    await db?.$disconnect();
  });

  it("[P0-S02a] TZ=UTC startDate '2026-10-06' → sesión 1 el 06/10 AR, no el 05 a las 21:00", async () => {
    asUser(A.userId);
    const p = await addPatient(db, A);
    const r = await createProgram({ patientId: p, title: "Kine", totalSessions: 4, frequency: 2, startDate: "2026-10-06" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const prog = await db.treatmentProgram.findUniqueOrThrow({
      where: { id: r.data.id },
      include: { sessions: { orderBy: { index: "asc" } } },
    });
    // Medianoche AR (03:00Z), la misma convención que ya usaba `updateProgram`.
    expect(prog.startDate.toISOString()).toBe("2026-10-06T03:00:00.000Z");
    expect(toARDateKey(prog.startDate)).toBe("2026-10-06");
    // 2 por semana: floor(i·3,5) días → 06, 09, 13 y 16 de octubre, día AR.
    expect(prog.sessions.map((s) => toARDateKey(s.scheduledFor!))).toEqual([
      "2026-10-06",
      "2026-10-09",
      "2026-10-13",
      "2026-10-16",
    ]);
    expect(prog.sessions[0].scheduledFor!.toISOString()).toBe("2026-10-06T03:00:00.000Z");
    // El audit queda en la misma tx que el plan.
    const ev = await db.auditEvent.count({ where: { tenantId: A.tenantId, action: "program.create", entityId: r.data.id } });
    expect(ev).toBe(1);
  });

  it("[P0-S02a] frequency 0 → error de validación, no 500", async () => {
    asUser(A.userId);
    const p = await addPatient(db, A);
    const r = await createProgram({ patientId: p, title: "Kine", totalSessions: 4, frequency: 0, startDate: "2026-10-06" });
    expect(r).toMatchObject({ ok: false });
    expect(await db.treatmentProgram.count({ where: { patientId: p } })).toBe(0);
  });

  it("[P0-S02a] totalSessions 61 → rechazo", async () => {
    asUser(A.userId);
    const p = await addPatient(db, A);
    const r = await createProgram({ patientId: p, title: "Kine", totalSessions: 61, frequency: 2, startDate: "2026-10-06" });
    expect(r).toMatchObject({ ok: false });
    expect(await db.treatmentProgram.count({ where: { patientId: p } })).toBe(0);
  });

  it("createProgram: 60 sesiones es el tope válido; fecha inexistente o con hora → rechazo", async () => {
    asUser(A.userId);
    const p = await addPatient(db, A);
    const ok = await createProgram({ patientId: p, title: "Kine", totalSessions: 60, frequency: 7, startDate: "2026-10-06" });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(await db.session.count({ where: { programId: ok.data.id } })).toBe(60);
    }
    for (const startDate of ["2026-02-29", "2026-10-06T10:00", "", "06/10/2026"]) {
      const r = await createProgram({ patientId: p, title: "Kine", totalSessions: 2, frequency: 1, startDate });
      expect(r, startDate).toMatchObject({ ok: false });
    }
    expect(await db.treatmentProgram.count({ where: { patientId: p } })).toBe(1);
  });

  it("[P0-S02a] updateProgram inválido → zod, en una tx", async () => {
    asUser(A.userId);
    const p = await addPatient(db, A);
    const prog = await makeProgram(p, { title: "Original" });
    // NaN pasaba los `n < 1 || n > 64` a mano (las dos comparaciones dan false)
    // y llegaba a Prisma: 500 en lugar de un error de validación.
    const r = await updateProgram({ id: prog.id, title: "Cambiado", totalSessions: Number.NaN });
    expect(r).toMatchObject({ ok: false });
    const row = await db.treatmentProgram.findUniqueOrThrow({ where: { id: prog.id } });
    expect(row).toMatchObject({ title: "Original", totalSessions: 4 });
    expect(await db.auditEvent.count({ where: { tenantId: A.tenantId, action: "program.update", entityId: prog.id } })).toBe(0);
  });

  it("updateProgram válido: solo el título (P2-S15); frecuencia o inicio distintos → rechazo; inválidos → zod", async () => {
    asUser(A.userId);
    const p = await addPatient(db, A);
    const prog = await makeProgram(p, { title: "Original" });
    // El Drawer reenvía frecuencia e inicio actuales: iguales = sin cambio.
    const r = await updateProgram({ id: prog.id, title: "  Nuevo  ", frequency: 2, startDate: "2030-01-07", totalSessions: 4 });
    expect(r).toEqual({ ok: true, data: undefined });
    const row = await db.treatmentProgram.findUniqueOrThrow({ where: { id: prog.id } });
    expect(row).toMatchObject({ title: "Nuevo", frequency: 2, totalSessions: 4 });
    expect(row.startDate.toISOString()).toBe("2030-01-07T03:00:00.000Z");
    expect(await db.auditEvent.count({ where: { tenantId: A.tenantId, action: "program.update", entityId: prog.id } })).toBe(1);

    // P2-S15: horario → re-planificar (antes movía el plan sin mover sesiones).
    for (const bad of [{ frequency: 3 }, { startDate: "2030-02-04" }]) {
      const rr = await updateProgram({ id: prog.id, ...bad });
      expect(rr, JSON.stringify(bad)).toMatchObject({ ok: false });
    }
    for (const bad of [{ totalSessions: 0 }, { totalSessions: 61 }, { frequency: 8 }, { title: "   " }, { startDate: "2030-02-30" }]) {
      const rr = await updateProgram({ id: prog.id, ...bad });
      expect(rr, JSON.stringify(bad)).toMatchObject({ ok: false });
    }
    const after = await db.treatmentProgram.findUniqueOrThrow({ where: { id: prog.id } });
    expect(after).toMatchObject({ title: "Nuevo", frequency: 2, totalSessions: 4 });
    expect(after.startDate.toISOString()).toBe("2030-01-07T03:00:00.000Z");
  });

  it("updateProgram de un legacy con 64 sesiones: reenviar el mismo total no bloquea editar el título", async () => {
    // El Drawer de edición (plan-view) manda SIEMPRE `totalSessions`. Los
    // planes creados con el tope viejo (64) tienen que poder renombrarse sin
    // que el tope nuevo (60) los rechace; subir o fijar >60 sí se rechaza.
    asUser(A.userId);
    const p = await addPatient(db, A);
    const prog = await makeProgram(p, { title: "Legacy" });
    await db.treatmentProgram.update({ where: { id: prog.id }, data: { totalSessions: 64 } });
    const r = await updateProgram({ id: prog.id, title: "Legacy renombrado", totalSessions: 64 });
    expect(r).toEqual({ ok: true, data: undefined });
    expect(await db.treatmentProgram.findUniqueOrThrow({ where: { id: prog.id } })).toMatchObject({
      title: "Legacy renombrado",
      totalSessions: 64,
    });
    const r2 = await updateProgram({ id: prog.id, totalSessions: 63 });
    expect(r2).toMatchObject({ ok: false });
    expect((await db.treatmentProgram.findUniqueOrThrow({ where: { id: prog.id } })).totalSessions).toBe(64);
  });

  it("setProgramStatus: estado inválido → rechazo; válido → write + audit con from/to", async () => {
    asUser(A.userId);
    const p = await addPatient(db, A);
    const prog = await makeProgram(p);
    const bad = await setProgramStatus({ id: prog.id, status: "BORRADO" as never });
    expect(bad).toMatchObject({ ok: false });
    const r = await setProgramStatus({ id: prog.id, status: "PAUSED" });
    expect(r).toEqual({ ok: true, data: undefined });
    expect((await db.treatmentProgram.findUniqueOrThrow({ where: { id: prog.id } })).status).toBe("PAUSED");
    const evs = await db.auditEvent.findMany({ where: { tenantId: A.tenantId, action: "program.status", entityId: prog.id } });
    expect(evs).toHaveLength(1);
    // P2-S15: delega en el flujo nuevo; el legacy pausa con D7 = "keep".
    expect(evs[0].payload).toMatchObject({ from: "ACTIVE", to: "PAUSED", futureBookings: "keep" });
    // Mismo estado: no-op, sin audit nuevo.
    expect(await setProgramStatus({ id: prog.id, status: "PAUSED" })).toEqual({ ok: true, data: undefined });
    expect(await db.auditEvent.count({ where: { tenantId: A.tenantId, action: "program.status", entityId: prog.id } })).toBe(1);
  });

  // ── P2-S15 (ES2b): exports legacy que delegan en `lib/plans-lifecycle` ──

  it("[P2-S15] updateProgram con totalSessions → rechazo y sesiones vivas intactas", async () => {
    // PD-10: `updateProgram` edita SOLO título y notas. Antes un total nuevo
    // se escribía en `totalSessions` sin crear ni archivar sesiones (I5 roto:
    // "10 sesiones" con 4 filas). La cantidad va por `plans-edit` (S16b).
    asUser(A.userId);
    const p = await addPatient(db, A);
    const prog = await makeProgram(p, { title: "Kine" });
    for (let i = 1; i <= 4; i++) {
      await db.session.create({
        data: { programId: prog.id, practitionerId: A.practitionerId, index: i, scheduledFor: new Date(Date.UTC(2030, 0, 7 + i, 3)) },
      });
    }
    const r = await updateProgram({ id: prog.id, title: "Kine", totalSessions: 6 });
    expect(r).toMatchObject({ ok: false });
    expect(await db.treatmentProgram.findUniqueOrThrow({ where: { id: prog.id } })).toMatchObject({ totalSessions: 4 });
    expect(await db.session.count({ where: { programId: prog.id, archivedAt: null } })).toBe(4);
    expect(await db.auditEvent.count({ where: { tenantId: A.tenantId, action: "program.update", entityId: prog.id } })).toBe(0);
  });

  it("[P2-S15] deleteSession borra en duro → rechazo \"archivala\"", async () => {
    // I7: nada vinculado se borra en duro. `deleteSession` hacía DELETE + el
    // decremento de `totalSessions`; ahora rechaza con "archivala".
    asUser(A.userId);
    const p = await addPatient(db, A);
    const prog = await makeProgram(p);
    const s = await db.session.create({
      data: { programId: prog.id, practitionerId: A.practitionerId, index: 1, scheduledFor: new Date("2030-01-07T03:00:00.000Z") },
    });
    const r = await deleteSession(s.id);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toMatch(/archivala/i);
    expect(await db.session.count({ where: { id: s.id } })).toBe(1);
    expect((await db.treatmentProgram.findUniqueOrThrow({ where: { id: prog.id } })).totalSessions).toBe(4);
  });

  it("[P0-S02a] listPatients con 2 ACTIVE elige el más reciente", async () => {
    asUser(A.userId);
    const lastName = `Doble ${uniqueSuffix()}`;
    const p = await addPatient(db, A, { lastName });
    // Se inserta primero el VIEJO: sin `orderBy`, el `take: 1` devuelve el
    // orden físico (el primero insertado) y elegía este.
    await makeProgram(p, { title: "Viejo", createdAt: new Date("2030-01-01T12:00:00Z") });
    await makeProgram(p, { title: "Nuevo", createdAt: new Date("2030-03-01T12:00:00Z") });
    const rows = await listPatients({ q: lastName });
    const row = rows.find((r) => r.id === p);
    expect(row?.activeProgramTitle).toBe("Nuevo");
  });
});
