/**
 * S32 (ES4 P4.1 tanda B) · directorio de pacientes con planes por disciplina.
 *
 * Contrato (PLANES §P4 S32 + enmienda EV0, literal): «Chips por disciplina con
 * `liveProgramWhere`» · «columna y chips de plan solo con `planes`».
 *
 *  - `PatientRow.activePlans`: un chip por plan ACTIVE **y** vivo
 *    (`{ ...liveProgramWhere, status: "ACTIVE" }`), con disciplina (null = plan
 *    sin disciplina), realizadas y sesiones vivas (`liveSessionWhere`: una
 *    sesión archivada no cuenta ni en el total ni en las realizadas, igual que
 *    el hero del perfil). Un plan ACTIVE archivado (drift) no aparece.
 *  - «Con plan» / «Sin plan» usan el mismo predicado que la columna: antes
 *    «Con plan» miraba `status: ACTIVE` sin `archivedAt` y «Sin plan» era
 *    "nunca tuvo un plan", mientras el contador del pill (`page.tsx`) contaba
 *    "sin plan activo": el número y la lista no coincidían.
 *  - Sin N+1: las sesiones se cuentan con UNA consulta agregada por página
 *    (un `groupBy` sobre `Session`), no un include de sesiones por plan. Se
 *    mide con el contador de queries: duplicar los pacientes con plan no suma
 *    sentencias.
 *  - Sin `planes` (General) no se consulta ni `TreatmentProgram` ni `Session`
 *    (el tenant TIENE un plan sembrado: si el gate faltara, aparecería).
 *  - Fila `basic` (otro kine sin asignación ni share): sin chips (PHI).
 *
 * Símbolo real (`listPatients`) contra la DB; solo se mockea la sesión y se
 * instrumentan los clientes Prisma. Corre con `kinesoft_app` y con el owner.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});

import type { PrismaClient, Discipline } from "@prisma/client";
import { listPatients } from "@/lib/patients";
import { measure, type QueryEvent } from "@/tests/helpers/query-counter";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { addPlanSession } from "@/tests/helpers/plan-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";
const DAY = 86_400_000;

function recorded(): QueryEvent[] {
  return (globalThis as unknown as { __kineQueryRecorder: { events: QueryEvent[] } }).__kineQueryRecorder.events;
}
const touches = (table: string) => recorded().filter((e) => e.query.includes(`"${table}"`));
const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe.skipIf(!RUN)("S32 · listado de pacientes con planes por disciplina", () => {
  let db: PrismaClient;
  let K: EphemeralTenant;
  let G: EphemeralTenant;
  let other: { userId: string; practitionerId: string };
  /** Kine ACTIVE (3 vivas, 1 hecha + 1 archivada hecha) + Osteo ACTIVE (2 vivas, 0 hechas). */
  let pBoth: string;
  /** Plan ACTIVE pero archivado (drift): no es "activo". */
  let pArchivedActive: string;
  /** Solo un plan COMPLETED: sin plan activo. */
  let pCompleted: string;
  /** Plan ACTIVE sin disciplina (legacy). */
  let pNoDisc: string;
  /** Sin ningún plan. */
  let pPlain: string;
  let kineDoneAt: Date;
  let gPatient: string;
  let sfx: string;

  async function plan(
    t: EphemeralTenant,
    o: {
      patientId: string;
      title: string;
      discipline: Discipline | null;
      status?: "ACTIVE" | "COMPLETED";
      archived?: boolean;
      createdAt?: Date;
      sessions?: { completedAt?: Date; archived?: boolean }[];
    }
  ): Promise<string> {
    const p = await db.treatmentProgram.create({
      data: {
        tenantId: t.tenantId,
        patientId: o.patientId,
        title: o.title,
        totalSessions: 10,
        discipline: o.discipline,
        startDate: new Date(Date.now() - 20 * DAY),
        status: o.status ?? "ACTIVE",
        archivedAt: o.archived ? new Date() : null,
        ...(o.createdAt ? { createdAt: o.createdAt } : {}),
      },
    });
    let index = 0;
    for (const s of o.sessions ?? []) {
      index += 1;
      const id = await addPlanSession(db, p.id, {
        index,
        practitionerId: t.practitionerId,
        archivedAt: s.archived ? new Date() : null,
      });
      if (s.completedAt) await db.session.update({ where: { id }, data: { completedAt: s.completedAt } });
    }
    return p.id;
  }

  beforeAll(async () => {
    db = ownerClient();
    K = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "PRO", sharedPatientView: false });
    G = await createEphemeralTenant(db, { vertical: "GENERAL" });
    other = await addPractitioner(db, K, "PRACTITIONER");
    sfx = uniqueSuffix();

    pBoth = await addPatient(db, K, { lastName: `Both ${sfx}` });
    pArchivedActive = await addPatient(db, K, { lastName: `ArchAct ${sfx}` });
    pCompleted = await addPatient(db, K, { lastName: `Completed ${sfx}` });
    pNoDisc = await addPatient(db, K, { lastName: `NoDisc ${sfx}` });
    pPlain = await addPatient(db, K, { lastName: `Plain ${sfx}` });

    kineDoneAt = new Date(Date.now() - 3 * DAY);
    await plan(K, {
      patientId: pBoth,
      title: "Plan rodilla",
      discipline: "KINESIOLOGY",
      createdAt: new Date(Date.now() - 10 * DAY),
      sessions: [
        { completedAt: kineDoneAt },
        {},
        {},
        // Archivada y "hecha": no cuenta ni en el total ni en las realizadas,
        // ni para «última visita» (más nueva a propósito).
        { completedAt: new Date(Date.now() - 1 * DAY), archived: true },
      ],
    });
    await plan(K, {
      patientId: pBoth,
      title: "Plan cervical",
      discipline: "OSTEOPATHY",
      createdAt: new Date(Date.now() - 5 * DAY),
      sessions: [{}, {}],
    });
    await plan(K, { patientId: pArchivedActive, title: "Plan archivado", discipline: "KINESIOLOGY", archived: true, sessions: [{}] });
    await plan(K, { patientId: pCompleted, title: "Plan cerrado", discipline: "KINESIOLOGY", status: "COMPLETED", sessions: [{ completedAt: kineDoneAt }] });
    await plan(K, { patientId: pNoDisc, title: "Plan viejo", discipline: null, sessions: [{}] });

    gPatient = await addPatient(db, G, { lastName: `Gen ${sfx}` });
    await plan(G, { patientId: gPatient, title: "Plan heredado", discipline: "KINESIOLOGY", sessions: [{}] });
  });

  afterAll(async () => {
    await K?.cleanup();
    await G?.cleanup();
    await db?.$disconnect();
  });

  it("[S32] chips por disciplina: uno por plan ACTIVE vivo, con realizadas / sesiones vivas", async () => {
    asUser(K.userId);
    const rows = await listPatients({ q: sfx });
    const both = rows.find((r) => r.id === pBoth)!;
    // Más reciente primero (Osteo se creó después), igual que «Plan activo».
    expect(both.activePlans).toEqual([
      { discipline: "OSTEOPATHY", done: 0, totalLive: 2 },
      { discipline: "KINESIOLOGY", done: 1, totalLive: 3 },
    ]);
    expect(both.activeProgramTitle).toBe("Plan cervical");
    expect(both.sessionsDone).toBe(0);
    expect(both.sessionsTotal).toBe(2);
    // «Última visita» = última sesión viva realizada de los planes activos (la archivada no).
    expect(both.lastVisit?.toISOString()).toBe(kineDoneAt.toISOString());

    expect(rows.find((r) => r.id === pNoDisc)!.activePlans).toEqual([{ discipline: null, done: 0, totalLive: 1 }]);
  });

  it("[S32] `liveProgramWhere`: un plan ACTIVE archivado y un COMPLETED no son plan activo", async () => {
    asUser(K.userId);
    const rows = await listPatients({ q: sfx });
    for (const id of [pArchivedActive, pCompleted, pPlain]) {
      const r = rows.find((x) => x.id === id)!;
      expect(r.activePlans).toEqual([]);
      expect(r.activeProgramTitle).toBeNull();
    }
  });

  it("[S32] «Con plan» / «Sin plan» usan el mismo predicado que la columna", async () => {
    asUser(K.userId);
    expect(ids(await listPatients({ q: sfx, filter: "active" })).sort()).toEqual([pBoth, pNoDisc].sort());
    expect(ids(await listPatients({ q: sfx, filter: "no-program" })).sort()).toEqual(
      [pArchivedActive, pCompleted, pPlain].sort()
    );
  });

  it("[S32] sin N+1: una sola consulta agregada sobre Session, constante con más pacientes", async () => {
    asUser(K.userId);
    const { m: before } = await measure(() => listPatients({ q: sfx }));
    expect(touches("Session")).toHaveLength(1);
    expect(touches("Session")[0].query).toMatch(/GROUP BY/i);

    // Tres pacientes más con dos planes cada uno: las sentencias no crecen.
    for (let i = 0; i < 3; i++) {
      const p = await addPatient(db, K, { lastName: `More${i} ${sfx}` });
      await plan(K, { patientId: p, title: `Plan K${i}`, discipline: "KINESIOLOGY", sessions: [{}, {}] });
      await plan(K, { patientId: p, title: `Plan O${i}`, discipline: "OSTEOPATHY", sessions: [{}] });
    }
    const { result, m: after } = await measure(() => listPatients({ q: sfx }));
    expect(result.length).toBe(8);
    expect(after.statements).toBe(before.statements);
    expect(touches("Session")).toHaveLength(1);
  });

  it("[S32] fila basic (otro kine sin asignación ni share): sin chips", async () => {
    asUser(other.userId);
    const row = (await listPatients({ q: sfx })).find((r) => r.id === pBoth)!;
    expect(row.access).toBe("basic");
    expect(row.activePlans).toEqual([]);
    expect(row.activeProgramTitle).toBeNull();
  });

  it("[S32] GENERAL (sin `planes`): no consulta planes ni sesiones y no hay chips", async () => {
    asUser(G.userId);
    const { result } = await measure(() => listPatients({}));
    const row = result.find((r) => r.id === gPatient)!;
    expect(row.activePlans).toEqual([]);
    expect(touches("TreatmentProgram")).toEqual([]);
    expect(touches("Session")).toEqual([]);
  });
});
