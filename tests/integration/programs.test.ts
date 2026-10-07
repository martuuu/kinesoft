/**
 * Planes de tratamiento · server de `lib/programs.ts` (PLANES.md §8, P0.1 · S02a)
 * y su retiro (P3.Z.0 · S27a).
 *
 * Contrato de S02a, que S27a RE-AFIRMA sobre la puerta nueva antes de borrar la
 * vieja (alta legacy → `createPlan`, `updateProgram` → `updatePlanDetails`; el
 * nombre del alta vieja no se escribe: el gate de P3.Z.0 lo greppea):
 *   - día AR: el alta legacy anclaba el inicio 'YYYY-MM-DD' a medianoche UTC
 *     (`new Date("2026-10-06")` = 21:00 del 05/10 en AR) y la sesión 1 caía el
 *     día anterior. `createPlan` lo resuelve con `startDayKey` + slots en
 *     minutos AR: se afirma en TZ=UTC, donde el corrimiento se ve;
 *   - entradas inválidas son rechazo de validación, no 500 (antes `frequency`
 *     0 → `7/0 = Infinity` → Invalid Date); tope de 60 sesiones (PD-04);
 *   - edición del plan valida con zod, escribe y audita en UNA tx; la cantidad
 *     y el horario NO se editan por ahí (PD-10: solo título y notas);
 *   - `setProgramStatus` / `deleteSession` (legacy que sobreviven) siguen igual;
 *   - `listPatients` con 2 planes ACTIVE elige el más reciente.
 *
 * Corre las actions REALES (getActor real, solo la sesión de Supabase
 * mockeada) y afirma la fila que quedó. TZ=UTC (script npm).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import * as programsModule from "@/lib/programs";
import { setProgramStatus, deleteSession } from "@/lib/programs";
import { createPlan, previewPlan } from "@/lib/plans";
import { updatePlanDetails } from "@/lib/plans-lifecycle";
import type { PlanCreateInput, PlanPreview, PlanRowResolution } from "@/lib/plans-types";
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

  /**
   * P3-S27a: borrador de `createPlan` (lunes y jueves; sin precio ni sede). El
   * `stateToken` real sale del preview: un token inventado haría que el commit
   * devuelva `stale-preview`, que también es `ok: false` y taparía un rechazo
   * que no ocurrió.
   */
  const draft = (patientId: string, over: Partial<PlanCreateInput> = {}): PlanCreateInput => ({
    idempotencyKey: randomUUID(),
    patientId,
    discipline: "KINESIOLOGY",
    practitionerId: A.practitionerId,
    serviceId: A.serviceId,
    locationId: null,
    schedule: { v: 1, frequency: "weekly", slots: [{ dow: 1, startMin: 600 }, { dow: 4, startMin: 600 }] },
    startDayKey: "2030-01-07",
    totalSessions: 4,
    pricing: null,
    rows: [],
    stateToken: "x",
    ...over,
  });

  /** Resoluciones por defecto del preview, como las manda el editor. */
  const acceptDefaults = (p: PlanPreview): PlanRowResolution[] =>
    p.rows.map((r) =>
      r.defaultResolution === "move"
        ? { index: r.index, kind: "move", at: r.suggestion }
        : r.defaultResolution === "adopt"
          ? { index: r.index, kind: "adopt", bookingId: r.flags.duplicate!.bookingId, expectedUpdatedAt: r.flags.duplicate!.updatedAt }
          : { index: r.index, kind: r.defaultResolution }
    ) as PlanRowResolution[];

  async function previewAndCreate(input: PlanCreateInput) {
    const pv = await previewPlan(input);
    if (!pv.ok) throw new Error(`preview falló: ${pv.error}`);
    return createPlan({ ...input, stateToken: pv.preview.stateToken, rows: acceptDefaults(pv.preview) });
  }

  const updatedAtOf = async (id: string) =>
    (await db.treatmentProgram.findUniqueOrThrow({ where: { id } })).updatedAt.toISOString();

  it("[P3-S27a] las puertas viejas ya no son actions: no hay action-id que invocar", () => {
    // `lib/programs.ts` es "use server": toda export es un endpoint POST. El
    // nombre del alta vieja se arma por partes para que el gate de P3.Z.0
    // (grep del símbolo en app/components/lib/tests) quede en 0.
    for (const name of [["create", "Program"].join(""), "updateProgram", "getPatientProgramsLite", "getPatientProgramsFull"]) {
      expect(name in programsModule, name).toBe(false);
    }
  });

  it("[P0-S02a → P3-S27a] TZ=UTC: inicio '2030-01-07' → sesión 1 el 07/01 AR; un slot de 21:00 AR no cae al día siguiente", async () => {
    asUser(A.userId);
    const p = await addPatient(db, A);
    // 21:00 AR = 00:00Z del día siguiente: en TZ=UTC un `getDay`/`slice(0,10)`
    // del host correría cada sesión un día (el bug original era el inverso:
    // medianoche UTC = 21:00 del día anterior en AR).
    // 21:00 queda fuera del horario del profesional: el preview sugiere mover.
    // Se fuerza "fuera de horario" (lo que haría el usuario en el editor) para
    // que la sesión quede a las 21:00 AR y el borde de día UTC se vea.
    const input = draft(p, { schedule: { v: 1, frequency: "weekly", slots: [{ dow: 1, startMin: 1260 }, { dow: 4, startMin: 1260 }] } });
    const pv = await previewPlan(input);
    if (!pv.ok) throw new Error(`preview falló: ${pv.error}`);
    expect(pv.preview.rows.map((row) => row.at)).toEqual(
      ["2030-01-08", "2030-01-11", "2030-01-15", "2030-01-18"].map((d) => `${d}T00:00:00.000Z`)
    );
    const r = await createPlan({
      ...input,
      stateToken: pv.preview.stateToken,
      rows: pv.preview.rows.map((row) => ({ index: row.index, kind: "force" as const, force: { outOfHours: true as const } })),
    });
    expect(r).toMatchObject({ ok: true, idempotent: false });
    if (!r.ok) return;

    const prog = await db.treatmentProgram.findUniqueOrThrow({
      where: { id: r.programId },
      include: { sessions: { orderBy: { index: "asc" } } },
    });
    // Inicio = medianoche AR (03:00Z) del día pedido.
    expect(prog.startDate.toISOString()).toBe("2030-01-07T03:00:00.000Z");
    expect(toARDateKey(prog.startDate)).toBe("2030-01-07");
    expect(prog.sessions.map((s) => toARDateKey(s.scheduledFor!))).toEqual(["2030-01-07", "2030-01-10", "2030-01-14", "2030-01-17"]);
    expect(prog.sessions[0].scheduledFor!.toISOString()).toBe("2030-01-08T00:00:00.000Z");
    // El audit queda en la misma tx que el plan.
    const ev = await db.auditEvent.count({ where: { tenantId: A.tenantId, action: "program.create", entityId: r.programId } });
    expect(ev).toBe(1);
  });

  it("[P0-S02a → P3-S27a] entradas inválidas → rechazo de validación (no 500) y nada escrito", async () => {
    asUser(A.userId);
    const p = await addPatient(db, A);
    const bad: Partial<PlanCreateInput>[] = [
      { totalSessions: 0 },
      { totalSessions: 61 }, // tope de PD-04
      { totalSessions: Number.NaN },
      { schedule: { v: 1, frequency: "weekly", slots: [] } }, // ex `frequency: 0`
      ...["2026-02-29", "2026-10-06T10:00", "", "06/10/2026"].map((startDayKey) => ({ startDayKey })),
    ];
    for (const over of bad) {
      const r = await createPlan(draft(p, over));
      expect(r, JSON.stringify(over)).toMatchObject({ ok: false });
      expect(r, JSON.stringify(over)).not.toHaveProperty("kind", "stale-preview");
    }
    expect(await db.treatmentProgram.count({ where: { patientId: p } })).toBe(0);
  });

  it("[P0-S02a → P3-S27a] 60 sesiones es el tope válido", async () => {
    asUser(A.userId);
    const p = await addPatient(db, A);
    const ok = await previewAndCreate(
      draft(p, { totalSessions: 60, schedule: { v: 1, frequency: "weekly", slots: [1, 2, 3, 4, 5].map((dow) => ({ dow: dow as 1, startMin: 600 })) } })
    );
    expect(ok).toMatchObject({ ok: true });
    if (ok.ok) expect(await db.session.count({ where: { programId: ok.programId } })).toBe(60);
  });

  it("[P0-S02a → P3-S27a] updatePlanDetails inválido → zod, sin write ni audit", async () => {
    asUser(A.userId);
    const p = await addPatient(db, A);
    const prog = await makeProgram(p, { title: "Original" });
    const expectedUpdatedAt = await updatedAtOf(prog.id);
    for (const bad of [{ title: "   " }, { title: "x".repeat(121) }, {}]) {
      const r = await updatePlanDetails({ programId: prog.id, expectedUpdatedAt, ...bad });
      expect(r, JSON.stringify(bad)).toMatchObject({ ok: false });
    }
    expect(await db.treatmentProgram.findUniqueOrThrow({ where: { id: prog.id } })).toMatchObject({ title: "Original", totalSessions: 4 });
    expect(await db.auditEvent.count({ where: { tenantId: A.tenantId, action: "program.update", entityId: prog.id } })).toBe(0);
  });

  it("[P2-S15 → P3-S27a] updatePlanDetails: solo título y notas; cantidad, frecuencia o inicio → rechazo (strict) y sesiones intactas", async () => {
    // PD-10: la rama estructural de la edición vieja se retiró. Antes un total
    // nuevo se escribía en `totalSessions` sin crear ni archivar sesiones (I5
    // roto: "10 sesiones" con 4 filas). Cantidad → `plans-edit` (S16b);
    // horario → re-planificar (L7).
    asUser(A.userId);
    const p = await addPatient(db, A);
    const prog = await makeProgram(p, { title: "Original" });
    for (let i = 1; i <= 4; i++) {
      await db.session.create({
        data: { programId: prog.id, practitionerId: A.practitionerId, index: i, scheduledFor: new Date(Date.UTC(2030, 0, 7 + i, 13)) },
      });
    }
    const expectedUpdatedAt = await updatedAtOf(prog.id);
    for (const bad of [{ totalSessions: 6 }, { frequency: 3 }, { startDate: "2030-02-04" }]) {
      const r = await updatePlanDetails({ programId: prog.id, expectedUpdatedAt, title: "Pisado", ...bad } as never);
      expect(r, JSON.stringify(bad)).toMatchObject({ ok: false });
    }
    let row = await db.treatmentProgram.findUniqueOrThrow({ where: { id: prog.id } });
    expect(row).toMatchObject({ title: "Original", frequency: 2, totalSessions: 4 });
    expect(row.startDate.toISOString()).toBe("2030-01-07T03:00:00.000Z");
    expect(await db.session.count({ where: { programId: prog.id, archivedAt: null } })).toBe(4);
    expect(await db.auditEvent.count({ where: { tenantId: A.tenantId, action: "program.update", entityId: prog.id } })).toBe(0);

    const r = await updatePlanDetails({ programId: prog.id, expectedUpdatedAt, title: "  Nuevo  " });
    expect(r).toMatchObject({ ok: true, data: { changed: true } });
    row = await db.treatmentProgram.findUniqueOrThrow({ where: { id: prog.id } });
    expect(row).toMatchObject({ title: "Nuevo", frequency: 2, totalSessions: 4 });
    expect(await db.auditEvent.count({ where: { tenantId: A.tenantId, action: "program.update", entityId: prog.id } })).toBe(1);
  });

  it("[P3-S27a] updatePlanDetails con un updatedAt viejo → stale, sin write (la edición vieja no tenía CAS)", async () => {
    asUser(A.userId);
    const p = await addPatient(db, A);
    const prog = await makeProgram(p, { title: "Original" });
    const stale = await updatedAtOf(prog.id);
    await db.treatmentProgram.update({ where: { id: prog.id }, data: { notes: "otro guardó antes" } });
    const r = await updatePlanDetails({ programId: prog.id, expectedUpdatedAt: stale, title: "Pisado" });
    expect(r).toMatchObject({ ok: false });
    expect((await db.treatmentProgram.findUniqueOrThrow({ where: { id: prog.id } })).title).toBe("Original");
  });

  it("[P3-S27a] un plan viejo con 64 sesiones (tope previo) se puede renombrar", async () => {
    // La edición vieja reenviaba SIEMPRE `totalSessions`; con el tope nuevo
    // (60) un plan de 64 no podía renombrarse. La puerta nueva no recibe la
    // cantidad: renombrar no depende de ella.
    asUser(A.userId);
    const p = await addPatient(db, A);
    const prog = await makeProgram(p, { title: "Legacy" });
    await db.treatmentProgram.update({ where: { id: prog.id }, data: { totalSessions: 64 } });
    const r = await updatePlanDetails({ programId: prog.id, expectedUpdatedAt: await updatedAtOf(prog.id), title: "Legacy renombrado" });
    expect(r).toMatchObject({ ok: true });
    expect(await db.treatmentProgram.findUniqueOrThrow({ where: { id: prog.id } })).toMatchObject({
      title: "Legacy renombrado",
      totalSessions: 64,
    });
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

  // ── P2-S15 (ES2b): exports legacy que sobreviven (sin callers de la app) ──

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
