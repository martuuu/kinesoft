/**
 * S12p (ES2b, P2.1) · proyección C9 de la agenda (`loadAgendaPlanProjection`,
 * `lib/agenda-plan-projection-internal.ts`).
 *
 * Contra la base real, con el `getActor()` real (solo se mockea la sesión de
 * Supabase) y dentro de `runWithRls` como la llama `listAgendaBookings`. Corre
 * con los dos roles: `kinesoft_app` (RLS) y owner BYPASSRLS
 * (`test:integration:owner`, reproduce prod): con BYPASSRLS el único filtro de
 * tenant es el `where { tenantId }` a mano, así que el caso "fila forjada de
 * otro consultorio" es el que prueba esa barrera.
 *
 * Qué se afirma (C9 + C13b + §5):
 *   - chip: disciplina del plan, ordinal M13 por fecha entre las sesiones
 *     vivas (archivadas fuera), `totalLive` = sesiones vivas;
 *   - `plan.title` solo con `clinical.read` + full (`planTitleFor`): ASSISTANT y
 *     PRACTITIONER básico reciben null, pero ven disciplina y contador;
 *   - `pricedByPlan` leído de la fila real del turno;
 *   - `serviceDiscipline` y `patientActiveLinkedPlanDisciplines` con R-LEGACY
 *     (legacy, PAUSED y archivado no cuentan; plan vinculado sin disciplina =
 *     "NONE"), y `isOutOfPlan` (V2) sobre esa salida;
 *   - nunca la autorización de la OS (E2);
 *   - tenant GENERAL (sin `planes`) → neutro;
 *   - queries planas: cantidad constante (no N+1) y medición de payload.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { getActor, type Actor } from "@/lib/session";
import { getMembershipRole } from "@/lib/authz";
import { capabilitiesFor, type Capability } from "@/lib/capabilities";
import { runWithRls, type DbClient } from "@/lib/rls";
import { isOutOfPlan, planChip } from "@/lib/plan-display";
import {
  loadAgendaPlanProjection,
  type AgendaPlanProjectionRow,
  type C9Fields,
} from "@/lib/agenda-plan-projection-internal";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  addService,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { addPlanBooking, addPlanSession, createLegacyPlan, createPlan } from "@/tests/helpers/plan-factory";
import { asUser, asAnonymous } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";
const DAY_MS = 24 * 60 * 60_000;
const BASE = Date.parse("2026-10-05T13:00:00Z");

/**
 * Cuenta las operaciones de modelo que la proyección dispara sobre la `tx`
 * (cada `findMany`/`findUnique`… = un statement). Envuelve la tx real: no
 * mockea nada de la función bajo test.
 */
function countingTx(tx: DbClient): { tx: DbClient; count: () => number } {
  let n = 0;
  const wrapDelegate = (d: object) =>
    new Proxy(d, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (typeof v !== "function") return v;
        return (...args: unknown[]) => {
          n += 1;
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  const proxied = new Proxy(tx as object, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (typeof prop === "string" && prop.startsWith("$")) {
        if (typeof v !== "function") return v;
        return (...args: unknown[]) => {
          n += 1;
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return v && typeof v === "object" ? wrapDelegate(v) : v;
    },
  });
  return { tx: proxied as DbClient, count: () => n };
}

async function ctxFor(userId: string): Promise<{ actor: Actor; caps: ReadonlySet<Capability> }> {
  asUser(userId);
  const actor = await getActor();
  return { actor, caps: capabilitiesFor(await getMembershipRole(actor)) };
}

describe.skipIf(!RUN)("S12p · loadAgendaPlanProjection (C9)", () => {
  let db: PrismaClient;
  let K: EphemeralTenant;
  let Other: EphemeralTenant;
  let G: EphemeralTenant;
  let users: Record<"OWNER" | "PRO" | "PRO_BASIC" | "ASSISTANT", string>;

  let osteoServiceId: string;
  let plainServiceId: string;

  // Paciente A: plan KINE vinculado con 3 vivas + 1 archivada.
  let planA: { programId: string; title: string; sessionIds: string[]; bookingIds: string[] };
  let looseA: { kine: string; osteo: string; plain: string; cancelledKine: string };
  // Paciente B: solo un legacy ACTIVE (R-LEGACY: no cuenta).
  let looseB: string;
  // Paciente C: OSTEO vinculado por schedule + sin disciplina vinculado + PAUSED + archivado.
  let looseC: string;
  // Paciente D: sin planes.
  let looseD: string;

  let rows: AgendaPlanProjectionRow[];
  let forged: AgendaPlanProjectionRow;
  let generalRows: AgendaPlanProjectionRow[];

  beforeAll(async () => {
    db = ownerClient();
    K = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "PRO" });
    Other = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "PRO" });
    G = await createEphemeralTenant(db, { vertical: "GENERAL", plan: "PRO", publicBookingEnabled: false });

    const pro = await addPractitioner(db, K, "PRACTITIONER");
    const proBasic = await addPractitioner(db, K, "PRACTITIONER");
    const assistant = await addPractitioner(db, K, "ASSISTANT");
    users = { OWNER: K.userId, PRO: pro.userId, PRO_BASIC: proBasic.userId, ASSISTANT: assistant.userId };

    // Servicios: el default de la factory pasa a Kine; uno Osteo; uno sin disciplina.
    await db.service.update({ where: { id: K.serviceId }, data: { discipline: "KINESIOLOGY" } });
    osteoServiceId = await addService(db, K, { name: "Osteo" });
    await db.service.update({ where: { id: osteoServiceId }, data: { discipline: "OSTEOPATHY" } });
    plainServiceId = await addService(db, K, { name: "Evaluación" });

    // ── A: asignado a `pro` (full para él, básico para `proBasic`).
    const patientA = await addPatient(db, K, { assignedPractitionerId: pro.practitionerId });
    const pa = await createPlan(db, K, { patientId: patientA, sessions: 3, bookings: 3 });
    // M13: el ordinal es por FECHA, no por index. index 2 cae después de index 3.
    await db.session.update({ where: { id: pa.sessionIds[0] }, data: { scheduledFor: new Date(BASE) } });
    await db.session.update({ where: { id: pa.sessionIds[1] }, data: { scheduledFor: new Date(BASE + 5 * DAY_MS) } });
    await db.session.update({ where: { id: pa.sessionIds[2] }, data: { scheduledFor: new Date(BASE + 2 * DAY_MS) } });
    // Archivada ANTES de todas: si contara, correría los ordinales y el total.
    await addPlanSession(db, pa.programId, {
      index: 4,
      practitionerId: K.practitionerId,
      scheduledFor: new Date(BASE - 3 * DAY_MS),
      archivedAt: new Date(),
    });
    // El turno de la sesión index 1 lo tasa el plan (I8: lo escribe el motor; acá, insert directo).
    await db.booking.update({ where: { id: pa.bookingIds[0] }, data: { pricedByPlan: true, copagoCents: 500_000 } });
    // Autorización de la OS cargada: NUNCA tiene que salir en C9 (E2).
    await db.programAuthorization.create({
      data: {
        tenantId: K.tenantId,
        programId: pa.programId,
        code: "AUTH-SECRETO-123",
        authorizedSessions: 10,
        startsOn: new Date("2026-10-01T00:00:00Z"),
      },
    });
    const progA = await db.treatmentProgram.findUniqueOrThrow({ where: { id: pa.programId }, select: { title: true } });
    planA = { programId: pa.programId, title: progA.title, sessionIds: pa.sessionIds, bookingIds: pa.bookingIds };
    looseA = {
      kine: await addPlanBooking(db, K, { patientId: patientA }),
      osteo: await addPlanBooking(db, K, { patientId: patientA }),
      plain: await addPlanBooking(db, K, { patientId: patientA }),
      cancelledKine: await addPlanBooking(db, K, { patientId: patientA, status: "CANCELLED" }),
    };
    await db.booking.update({ where: { id: looseA.osteo }, data: { serviceId: osteoServiceId } });
    await db.booking.update({ where: { id: looseA.plain }, data: { serviceId: plainServiceId } });

    // ── B: legacy ACTIVE (sin schedule ni turnos) → no cuenta.
    const patientB = await addPatient(db, K);
    await createLegacyPlan(db, K, { patientId: patientB });
    looseB = await addPlanBooking(db, K, { patientId: patientB });

    // ── C
    const patientC = await addPatient(db, K);
    // Vinculado por `schedule` (sin turnos), OSTEO, el más viejo.
    await createPlan(db, K, {
      patientId: patientC,
      sessions: 1,
      data: { discipline: "OSTEOPATHY", schedule: { v: 1 }, createdAt: new Date(BASE - 10 * DAY_MS) },
    });
    // Vinculado por turno, sin disciplina → "NONE".
    await createPlan(db, K, {
      patientId: patientC,
      sessions: 1,
      bookings: 1,
      data: { discipline: null, createdAt: new Date(BASE - 5 * DAY_MS) },
    });
    // PAUSED vinculado KINE → no cuenta.
    await createPlan(db, K, { patientId: patientC, sessions: 1, bookings: 1, data: { status: "PAUSED" } });
    // ACTIVE vinculado KINE pero archivado → no cuenta.
    await createPlan(db, K, { patientId: patientC, sessions: 1, bookings: 1, data: { archivedAt: new Date() } });
    looseC = await addPlanBooking(db, K, { patientId: patientC });

    // ── D: sin planes.
    const patientD = await addPatient(db, K);
    looseD = await addPlanBooking(db, K, { patientId: patientD });

    rows = await db.booking.findMany({
      where: { tenantId: K.tenantId },
      select: { id: true, patientId: true, serviceId: true, programId: true, sessionId: true },
      orderBy: { scheduledFor: "asc" },
    });

    // ── Otro consultorio: plan vinculado KINE con disciplina en el servicio.
    await db.service.update({ where: { id: Other.serviceId }, data: { discipline: "KINESIOLOGY" } });
    const po = await createPlan(db, Other, { sessions: 2, bookings: 1 });
    forged = {
      id: po.bookingIds[0],
      patientId: po.patientId,
      serviceId: Other.serviceId,
      programId: po.programId,
      sessionId: po.sessionIds[0],
    };

    // ── GENERAL (sin `planes`), con un plan vinculado insertado directo.
    await db.service.update({ where: { id: G.serviceId }, data: { discipline: "KINESIOLOGY" } });
    const pg = await createPlan(db, G, { sessions: 2, bookings: 1 });
    const looseG = await addPlanBooking(db, G, { patientId: pg.patientId });
    generalRows = await db.booking.findMany({
      where: { tenantId: G.tenantId, id: { in: [pg.bookingIds[0], looseG] } },
      select: { id: true, patientId: true, serviceId: true, programId: true, sessionId: true },
    });
  }, 120_000);

  afterAll(async () => {
    asAnonymous();
    await K?.cleanup();
    await Other?.cleanup();
    await G?.cleanup();
    await db?.$disconnect();
  });

  async function project(
    userId: string,
    input: ReadonlyArray<AgendaPlanProjectionRow> = rows
  ): Promise<{ map: Map<string, C9Fields>; queries: number }> {
    const { actor, caps } = await ctxFor(userId);
    return runWithRls(actor.tenantId, async (tx) => {
      const c = countingTx(tx);
      const map = await loadAgendaPlanProjection(c.tx, actor, input, caps);
      return { map, queries: c.count() };
    });
  }

  const chipOf = (m: Map<string, C9Fields>, id: string) => m.get(id)?.plan ?? null;

  it("chip: disciplina, ordinal M13 por fecha (archivadas fuera) y totalLive = vivas", async () => {
    const { map } = await project(users.OWNER);
    const [b1, b2, b3] = planA.bookingIds;
    expect(chipOf(map, b1)).toEqual({ discipline: "KINESIOLOGY", ordinal: 1, totalLive: 3, title: planA.title });
    // index 2 cae el día +5 → tercera por fecha; index 3 (día +2) → segunda.
    expect(chipOf(map, b2)).toMatchObject({ ordinal: 3, totalLive: 3 });
    expect(chipOf(map, b3)).toMatchObject({ ordinal: 2, totalLive: 3 });
    expect(planChip(chipOf(map, b3)!).label).toBe("Kine · 2/3");
    expect(map.get(b1)).toMatchObject({ programId: planA.programId, sessionId: planA.sessionIds[0] });
  });

  it("pricedByPlan sale de la fila del turno (solo el tasado por el plan)", async () => {
    const { map } = await project(users.OWNER);
    expect(map.get(planA.bookingIds[0])?.pricedByPlan).toBe(true);
    expect(map.get(planA.bookingIds[1])?.pricedByPlan).toBe(false);
    expect(map.get(looseA.kine)?.pricedByPlan).toBe(false);
  });

  it("título: OWNER y el PRACTITIONER full lo ven; ASSISTANT y básico reciben null pero ven el chip", async () => {
    const b = planA.bookingIds[2];
    expect(chipOf((await project(users.OWNER)).map, b)?.title).toBe(planA.title);
    expect(chipOf((await project(users.PRO)).map, b)?.title).toBe(planA.title);
    for (const u of [users.ASSISTANT, users.PRO_BASIC]) {
      const chip = chipOf((await project(u)).map, b);
      expect(chip).toEqual({ discipline: "KINESIOLOGY", ordinal: 2, totalLive: 3, title: null });
    }
  });

  it("serviceDiscipline del servicio del turno (null si no tiene)", async () => {
    const { map } = await project(users.OWNER);
    expect(map.get(looseA.kine)?.serviceDiscipline).toBe("KINESIOLOGY");
    expect(map.get(looseA.osteo)?.serviceDiscipline).toBe("OSTEOPATHY");
    expect(map.get(looseA.plain)?.serviceDiscipline).toBeNull();
  });

  it("patientActiveLinkedPlanDisciplines con R-LEGACY + 'Fuera de plan' (V2)", async () => {
    const { map } = await project(users.ASSISTANT);
    // A: su plan KINE (vinculado por turnos) cuenta.
    expect(map.get(looseA.kine)?.patientActiveLinkedPlanDisciplines).toEqual(["KINESIOLOGY"]);
    // B: legacy ACTIVE sin schedule ni turnos → no cuenta.
    expect(map.get(looseB)?.patientActiveLinkedPlanDisciplines).toEqual([]);
    // C: OSTEO por schedule + NONE por turno, en orden de alta; PAUSED y archivado fuera.
    expect(map.get(looseC)?.patientActiveLinkedPlanDisciplines).toEqual(["OSTEOPATHY", "NONE"]);
    expect(map.get(looseD)?.patientActiveLinkedPlanDisciplines).toEqual([]);

    const out = (id: string, status = "CONFIRMED") => {
      const f = map.get(id)!;
      return isOutOfPlan({ ...f, status, hasPatient: true });
    };
    expect(out(looseA.kine)).toBe(true); // misma disciplina
    expect(out(looseA.osteo)).toBe(false); // otra disciplina, sin "NONE"
    expect(out(looseA.plain)).toBe(true); // servicio sin disciplina: cualquier plan vinculado
    expect(out(looseA.cancelledKine, "CANCELLED")).toBe(false);
    expect(out(looseB)).toBe(false); // R-LEGACY
    expect(out(looseC)).toBe(true); // "NONE" cubre cualquier servicio
    expect(out(planA.bookingIds[0])).toBe(false); // turno del plan
  });

  it("nunca la autorización de la OS (E2) ni otra clave fuera de C9", async () => {
    const { map } = await project(users.OWNER);
    const json = JSON.stringify([...map.values()]);
    expect(json).not.toContain("AUTH-SECRETO-123");
    expect(json.toLowerCase()).not.toContain("authoriz");
    for (const v of map.values()) {
      expect(Object.keys(v).sort()).toEqual(
        ["patientActiveLinkedPlanDisciplines", "plan", "pricedByPlan", "programId", "serviceDiscipline", "sessionId"].sort()
      );
      if (v.plan) expect(Object.keys(v.plan).sort()).toEqual(["discipline", "ordinal", "title", "totalLive"]);
    }
  });

  it("fila forjada de otro consultorio: no filtra plan, disciplina ni pricedByPlan (tenantId a mano)", async () => {
    await db.booking.update({ where: { id: forged.id }, data: { pricedByPlan: true, copagoCents: 500_000 } });
    const { map } = await project(users.OWNER, [forged]);
    expect(map.get(forged.id)).toMatchObject({
      pricedByPlan: false,
      plan: null,
      serviceDiscipline: null,
      patientActiveLinkedPlanDisciplines: [],
    });
  });

  it("tenant GENERAL (sin `planes`): neutro y sin consultar", async () => {
    const { map, queries } = await project(G.userId, generalRows);
    expect(map.size).toBe(generalRows.length);
    for (const r of generalRows) {
      expect(map.get(r.id)).toEqual({
        programId: r.programId,
        sessionId: r.sessionId,
        pricedByPlan: false,
        plan: null,
        serviceDiscipline: null,
        patientActiveLinkedPlanDisciplines: [],
      });
    }
    expect(queries).toBe(0);
  });

  it("queries planas: cantidad acotada y constante (no N+1); vacío → 0", async () => {
    // PRACTITIONER básico: ningún paciente es suyo, así que `bulkPatientAccess`
    // siempre hace la consulta de shares y el conteo es comparable entre 1 y N filas.
    const all = await project(users.PRO_BASIC);
    const one = await project(users.PRO_BASIC, [rows.find((r) => r.id === planA.bookingIds[0])!]);
    const empty = await project(users.PRO, []);
    expect(all.map.size).toBe(rows.length);
    // 4 propias + las de `bulkPatientAccess` (paciente, settings, membresía, shares).
    expect(all.queries).toBeLessThanOrEqual(8);
    expect(all.queries).toBe(one.queries);
    expect(empty.queries).toBe(0);
    expect(empty.map.size).toBe(0);
    // ASSISTANT (sin clinical.read) no resuelve acceso: el título es null igual.
    const asst = await project(users.ASSISTANT);
    expect(asst.queries).toBeLessThan(all.queries);
  });

  it("payload: medición de bytes de C9 por turno (presupuesto semanal ≤ +5 %)", async () => {
    const { map } = await project(users.OWNER);
    const values = [...map.values()];
    const full = JSON.stringify(values).length;
    // Serialización compacta: se omiten los valores neutros (null / false / []).
    const compactOf = (v: C9Fields) =>
      Object.fromEntries(
        Object.entries(v).filter(([, x]) => x !== null && x !== false && !(Array.isArray(x) && x.length === 0))
      );
    const compact = JSON.stringify(values.map(compactOf)).length;
    const bytes = (id: string) => JSON.stringify(compactOf(map.get(id)!)).length;
    const neutral = JSON.stringify({
      programId: null,
      sessionId: null,
      pricedByPlan: false,
      plan: null,
      serviceDiscipline: null,
      patientActiveLinkedPlanDisciplines: [],
    }).length;
    console.log(
      `[S12p payload] ${values.length} turnos · C9 completo ${Math.round(full / values.length)} B/turno · ` +
        `compacto ${Math.round(compact / values.length)} B/turno · neutro ${neutral} B · ` +
        `compacto por tipo: turno de plan ${bytes(planA.bookingIds[1])} B, suelto con plan activo ${bytes(looseA.kine)} B, ` +
        `suelto sin plan ${bytes(looseD)} B`
    );
    expect(full).toBeGreaterThan(0);
  });
});
