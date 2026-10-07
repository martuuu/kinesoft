/**
 * S14 · Dashboard sobre Planes (`lib/dashboard.ts`, ES2b P2.0).
 *
 *   - `[P2-S14] dashboard muestra s.index crudo`: "Pacientes recientes" mostraba
 *     `Session.index` / `totalSessions`; con sesiones archivadas (index fijo,
 *     M13) eso da "2 / 3" donde el chip de la agenda dice "1/2". Ahora: ordinal
 *     por fecha entre las vivas / sesiones vivas (C13b).
 *   - `liveProgramWhere`: un plan archivado no cuenta como activo ni aparece
 *     en recientes.
 *   - Título y condición vacíos sin `clinical.read` (la Secretaria).
 *   - Enmiendas EV0 (literal): "sin `planes`, `getDashboardData` no consulta
 *     planes/sesiones y devuelve 0" y "`getSessionsChart` sin `sesiones`
 *     devuelve 0 sin consultar". El "no consulta" se mide con el contador de
 *     queries (`tests/helpers/query-counter.ts`), no se supone: el tenant
 *     General TIENE un plan y un turno sembrados por insert directo, así que
 *     si el gate faltara los números no darían 0 (anti-falso-verde).
 *
 * Corre con `kinesoft_app` y con el owner BYPASSRLS.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { getDashboardData, getSessionsChart } from "@/lib/dashboard";
import { measure, type QueryEvent } from "@/tests/helpers/query-counter";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { addPlanSession } from "@/tests/helpers/plan-factory";
import { asUser, asAnonymous } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";
const DAY = 86_400_000;

/** Todas las sentencias que registró el contador en la última `measure`. */
function recorded(): QueryEvent[] {
  return (globalThis as unknown as { __kineQueryRecorder: { events: QueryEvent[] } }).__kineQueryRecorder.events;
}
const touches = (table: string) => recorded().filter((e) => e.query.includes(`"${table}"`));

describe.skipIf(!RUN)("S14 · dashboard sobre Planes", () => {
  let db: PrismaClient;
  let K: EphemeralTenant;
  let G: EphemeralTenant;
  let assistantUserId: string;
  let patientId: string;
  let archivedPatientId: string;

  /** Un plan con N sesiones; `done` = index de la sesión cerrada (la "reciente"). */
  async function plan(
    t: EphemeralTenant,
    o: { patientId: string; title: string; archived?: boolean; completedAt: Date }
  ): Promise<{ programId: string; sessionIds: string[] }> {
    const p = await db.treatmentProgram.create({
      data: {
        tenantId: t.tenantId,
        patientId: o.patientId,
        title: o.title,
        totalSessions: 3,
        startDate: new Date(Date.now() - 10 * DAY),
        status: "ACTIVE",
        archivedAt: o.archived ? new Date() : null,
      },
    });
    const ids: string[] = [];
    for (const index of [1, 2, 3]) {
      ids.push(
        await addPlanSession(db, p.id, {
          index,
          practitionerId: t.practitionerId,
          scheduledFor: new Date(Date.now() - (5 - index) * DAY),
        })
      );
    }
    // index 1 archivada; index 2 cerrada (la reciente); index 3 pendiente.
    await db.session.update({ where: { id: ids[0] }, data: { archivedAt: new Date() } });
    await db.session.update({ where: { id: ids[1] }, data: { completedAt: o.completedAt } });
    return { programId: p.id, sessionIds: ids };
  }

  beforeAll(async () => {
    db = ownerClient();
    K = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "FREE" });
    G = await createEphemeralTenant(db, { vertical: "GENERAL", plan: "PRO", publicBookingEnabled: false });
    assistantUserId = (await addPractitioner(db, K, "ASSISTANT")).userId;

    patientId = await addPatient(db, K, { firstName: "Reciente", lastName: "Ordinal" });
    await plan(K, { patientId, title: "Cervicalgia S14", completedAt: new Date(Date.now() - DAY) });
    // Plan ARCHIVADO (aunque diga ACTIVE): no cuenta ni aparece, aunque su sesión sea la más reciente.
    archivedPatientId = await addPatient(db, K, { firstName: "Archivado", lastName: "Plan" });
    await plan(K, { patientId: archivedPatientId, title: "Archivado S14", archived: true, completedAt: new Date() });

    // General: un plan y un turno de esta semana por insert directo (datos que
    // un dashboard sin gate SÍ contaría).
    const gPatient = await addPatient(db, G);
    await plan(G, { patientId: gPatient, title: "No debería verse", completedAt: new Date() });
    await db.booking.create({
      data: {
        tenantId: G.tenantId,
        patientId: gPatient,
        practitionerId: G.practitionerId,
        serviceId: G.serviceId,
        scheduledFor: new Date(),
        durationMin: 45,
        idempotencyKey: randomUUID(),
        status: "CONFIRMED",
      },
    });
  });

  afterAll(async () => {
    asAnonymous();
    await K?.cleanup();
    await G?.cleanup();
    await db?.$disconnect();
  });

  it("[P2-S14] dashboard muestra s.index crudo", async () => {
    asUser(K.userId);
    const d = await getDashboardData();
    const row = d.recent.find((r) => r.id === patientId);
    expect(row).toBeDefined();
    // Vivas: index 2 (cerrada) e index 3. Ordinal de la cerrada = 1 de 2 (antes: 2 / 3).
    expect(row).toMatchObject({ access: "full", cond: "Cervicalgia S14", sessionsDone: 1, sessionsTotal: 2 });
  });

  it("liveProgramWhere: el plan archivado no cuenta como activo ni aparece en recientes", async () => {
    asUser(K.userId);
    const d = await getDashboardData();
    expect(d.recent.some((r) => r.id === archivedPatientId)).toBe(false);
    expect(d.pinned.activePrograms).toBe(1);
    expect(d.pinned.activePatients).toBe(1);
    expect(d.pinned.nearingDischarge).toBe(1);
  });

  it("la Secretaria (sin clinical.read) ve la fila sin condición ni progreso", async () => {
    asUser(assistantUserId);
    const d = await getDashboardData();
    const row = d.recent.find((r) => r.id === patientId);
    expect(row).toMatchObject({ access: "basic", cond: "", sessionsDone: 0, sessionsTotal: 0, nextBookingId: null });
    expect(JSON.stringify(d.recent)).not.toContain("Cervicalgia S14");
  });

  it("GENERAL (sin `planes`): getDashboardData no consulta planes/sesiones y devuelve 0", async () => {
    asUser(G.userId);
    const { result: d } = await measure(() => getDashboardData());
    expect(d.pinned).toMatchObject({ activePatients: 0, activePrograms: 0, nearingDischarge: 0 });
    expect(d.recent).toEqual([]);
    expect(touches("TreatmentProgram")).toEqual([]);
    expect(touches("Session")).toEqual([]);
    // Lo que no es de planes sigue: el turno de hoy cuenta.
    expect(d.todayCount).toBe(1);
  });

  it("GENERAL (sin `sesiones`): getSessionsChart devuelve 0 sin consultar", async () => {
    asUser(G.userId);
    for (const range of ["week", "month", "3m"] as const) {
      const { result: bars } = await measure(() => getSessionsChart(range));
      expect(bars.length).toBeGreaterThan(0);
      expect(bars.every((b) => b.done === 0 && b.missed === 0)).toBe(true);
      expect(touches("Booking")).toEqual([]);
    }
  });

  it("control: con `sesiones`, getSessionsChart sí cuenta (el gate no apaga todo)", async () => {
    asUser(K.userId);
    await db.booking.create({
      data: {
        tenantId: K.tenantId,
        patientId,
        practitionerId: K.practitionerId,
        serviceId: K.serviceId,
        scheduledFor: new Date(),
        durationMin: 45,
        idempotencyKey: randomUUID(),
        status: "CONFIRMED",
      },
    });
    const bars = await getSessionsChart("week");
    expect(bars.reduce((a, b) => a + b.done, 0)).toBe(1);
  });
});
