/**
 * S11v (ES2b P2.1) · verificador de invariantes de un plan
 * (`lib/plan-invariants-internal.ts`, PLANES.md §2.3, I1-I8 con R-LEGACY).
 *
 * Dos capas, las dos contra el símbolo real:
 *   1. `checkProgramInvariants` (puro) sobre snapshots armados a mano: cubre lo
 *      que la base hoy hace IMPOSIBLE (I1, I2, I8 están garantizados por FKs
 *      compuestas, el único parcial y CHECKs). El verificador los re-chequea
 *      igual porque `migrate dev` puede proponer borrar los parciales (drift
 *      aceptado de M1) y en prod la conexión es BYPASSRLS: si un día falta el
 *      objeto de la base, el verificador es la red.
 *   2. `assertProgramInvariantsInTx` contra Postgres (kinesoft_app y owner):
 *      el loader trae lo que el puro necesita, filtra por `tenantId` a mano,
 *      tira `ProgramInvariantViolation`, reporta el diff a Sentry y la tx
 *      entera hace rollback. Las violaciones se siembran por INSERT/UPDATE
 *      directo con el owner (lo que el código "debería" impedir).
 *
 * Lo único mockeado es `captureException` (el transporte a Sentry), para
 * afirmar el evento con el diff; el verificador corre real.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

const captureSpy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/observability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/observability")>();
  return { ...actual, captureException: (...a: unknown[]) => captureSpy(...a) };
});

import { runWithRls } from "@/lib/rls";
import {
  assertProgramInvariantsInTx,
  checkProgramInvariants,
  ProgramInvariantViolation,
  type ProgramInvariantSnapshot,
} from "@/lib/plan-invariants-internal";
import { ownerClient, createEphemeralTenant, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { createPlan, createLegacyPlan, addPlanBooking, addPlanSession } from "@/tests/helpers/plan-factory";

const RUN = process.env.INTEGRATION === "1";

// ─── 1 · puro ────────────────────────────────────────────────────────────────

const T0 = "tenant-a";
const P0 = "prog-1";
const D = (iso: string) => new Date(iso);

/** Plan vinculado y sano: 3 sesiones vivas, paquete 300 = 100×3, un turno por sesión en su misma fecha. */
function base(): ProgramInvariantSnapshot {
  const at = ["2026-10-05T13:00:00Z", "2026-10-08T13:00:00Z", "2026-10-12T13:00:00Z"];
  return {
    tenantId: T0,
    programId: P0,
    program: {
      patientId: "pat-1",
      status: "ACTIVE",
      archivedAt: null,
      hasSchedule: true,
      totalSessions: 3,
      pricingMode: "PACKAGE",
      totalPriceCents: 30_000,
      refs: [
        { field: "patientId", id: "pat-1", tenantId: T0 },
        { field: "practitionerId", id: "pr-1", tenantId: T0 },
        { field: "serviceId", id: "sv-1", tenantId: T0 },
      ],
      foreignBookings: 0,
    },
    sessions: at.map((iso, i) => ({
      id: `s${i + 1}`,
      index: i + 1,
      scheduledFor: D(iso),
      completedAt: null,
      archivedAt: null,
      priceCents: 10_000,
      practitionerTenantId: T0,
    })),
    bookings: at.map((iso, i) => ({
      id: `b${i + 1}`,
      programId: P0,
      sessionId: `s${i + 1}`,
      patientId: "pat-1",
      status: "CONFIRMED",
      scheduledFor: D(iso),
      copagoCents: 10_000,
      pricedByPlan: true,
    })),
  };
}

/** Legacy (R-LEGACY): sin schedule ni turnos, totalSessions ≠ filas, 00:00Z, sin precio. */
function legacy(): ProgramInvariantSnapshot {
  const s = base();
  return {
    ...s,
    program: { ...s.program!, hasSchedule: false, totalSessions: 8, pricingMode: null, totalPriceCents: null },
    sessions: s.sessions.map((x, i) => ({ ...x, scheduledFor: D(`2026-09-0${1 + i}T00:00:00Z`), priceCents: null })),
    bookings: [],
  };
}

const invariantsOf = (s: ProgramInvariantSnapshot) => checkProgramInvariants(s).map((v) => v.invariant);

describe("S11v · checkProgramInvariants (puro)", () => {
  it("plan vinculado sano → sin violaciones", () => {
    expect(checkProgramInvariants(base())).toEqual([]);
  });

  it("legacy sano → sin violaciones", () => {
    expect(checkProgramInvariants(legacy())).toEqual([]);
  });

  it("plan no encontrado en el tenant → I4", () => {
    expect(invariantsOf({ ...base(), program: null, sessions: [], bookings: [] })).toEqual(["I4"]);
  });

  it("I1: turno de plan con otro paciente", () => {
    const s = base();
    s.bookings[0].patientId = "pat-2";
    const v = checkProgramInvariants(s);
    expect(v.map((x) => x.invariant)).toEqual(["I1"]);
    expect(v[0].detail).toContain("b1");
  });

  it("I1: turno con sesión de este plan pero sin programId / con otro plan, y turno con sesión ajena", () => {
    const s = base();
    s.bookings[0].programId = null;
    s.bookings[1].programId = "prog-x";
    s.bookings[2].sessionId = "s-de-otro-plan";
    // b1 además queda `pricedByPlan` sin vínculo → también I8.
    expect(invariantsOf(s)).toEqual(["I1", "I1", "I1", "I8"]);
  });

  it("I2: dos turnos activos en la misma sesión; CANCELLED/NO_SHOW no cuentan", () => {
    const s = base();
    s.bookings.push({ ...s.bookings[0], id: "b1-cancel", status: "CANCELLED" });
    s.bookings.push({ ...s.bookings[0], id: "b1-ns", status: "NO_SHOW" });
    expect(checkProgramInvariants(s)).toEqual([]);
    s.bookings.push({ ...s.bookings[0], id: "b1-dup", status: "PENDING" });
    const v = checkProgramInvariants(s);
    expect(v.map((x) => x.invariant)).toEqual(["I2"]);
    expect(v[0].detail).toMatch(/b1.*b1-dup|b1-dup.*b1/);
  });

  it("I3: fecha de la sesión ≠ fecha del turno activo (un COMPLETED también cuenta; uno cancelado no)", () => {
    const s = base();
    s.bookings[0].scheduledFor = D("2026-10-05T14:00:00Z");
    s.bookings[0].status = "COMPLETED";
    s.bookings[1].status = "CANCELLED";
    s.bookings[1].scheduledFor = D("2026-10-30T14:00:00Z");
    const v = checkProgramInvariants(s);
    expect(v.map((x) => x.invariant)).toEqual(["I3"]);
    expect(v[0].detail).toContain("s1");
  });

  it("I4: refs de otro consultorio (o invisibles bajo RLS) y turnos ajenos apuntando al plan", () => {
    const s = base();
    s.program!.refs = [
      { field: "patientId", id: "pat-1", tenantId: T0 },
      { field: "practitionerId", id: "pr-x", tenantId: "tenant-b" },
      { field: "locationId", id: "loc-x", tenantId: null },
      { field: "template.serviceId", id: "sv-x", tenantId: "tenant-b" },
    ];
    s.program!.foreignBookings = 2;
    expect(invariantsOf(s)).toEqual(["I4", "I4", "I4", "I4"]);
  });

  it("I4: profesional de una sesión de otro consultorio (solo en vinculados)", () => {
    const s = base();
    s.sessions[1].practitionerTenantId = "tenant-b";
    expect(invariantsOf(s)).toEqual(["I4"]);
    const l = legacy();
    l.sessions[0].practitionerTenantId = "tenant-b"; // el caso del fixture legacy: no se exige
    expect(checkProgramInvariants(l)).toEqual([]);
  });

  it("I5: totalSessions ≠ sesiones vivas (las archivadas no cuentan) e index vivo repetido", () => {
    const s = base();
    s.sessions.push({ ...s.sessions[0], id: "s-arch", index: 4, archivedAt: D("2026-10-01T00:00:00Z"), priceCents: 0 });
    expect(checkProgramInvariants(s)).toEqual([]);
    s.program!.totalSessions = 4;
    expect(invariantsOf(s)).toEqual(["I5"]);
    s.program!.totalSessions = 3;
    s.sessions[2].index = 2;
    expect(invariantsOf(s)).toEqual(["I5"]);
  });

  it("I6: PACKAGE con Σ cuotas vivas ≠ total, o una viva sin cuota; PER_SESSION no se suma", () => {
    const s = base();
    s.program!.totalPriceCents = 29_999;
    expect(invariantsOf(s)).toEqual(["I6"]);
    const n = base();
    n.sessions[0].priceCents = null;
    n.program!.totalPriceCents = 20_000;
    expect(invariantsOf(n)).toEqual(["I6"]);
    const p = base();
    p.program!.pricingMode = "PER_SESSION";
    p.program!.totalPriceCents = null;
    p.sessions[0].priceCents = 7_000; // fila bloqueada con precio viejo: legítimo
    expect(checkProgramInvariants(p)).toEqual([]);
  });

  it("I6 no compara el espejo turno↔cuota: copago manual y cobro previo ($0) son estados legítimos (C5)", () => {
    const s = base();
    s.bookings[0].copagoCents = 0;
    s.bookings[1].copagoCents = 12_345;
    expect(checkProgramInvariants(s)).toEqual([]);
  });

  it("I7: plan archivado ACTIVE/PAUSED; sesión archivada realizada o con turno activo", () => {
    const s = base();
    s.program!.archivedAt = D("2026-10-06T00:00:00Z");
    s.program!.status = "PAUSED";
    expect(invariantsOf(s)).toEqual(["I7"]);
    s.program!.status = "CANCELLED";
    expect(checkProgramInvariants(s)).toEqual([]);

    const a = base();
    a.program!.totalSessions = 2;
    a.program!.totalPriceCents = 20_000;
    a.sessions[2].archivedAt = D("2026-10-06T00:00:00Z");
    a.sessions[2].completedAt = D("2026-10-06T00:00:00Z");
    expect(invariantsOf(a)).toEqual(["I7", "I7"]); // realizada + turno CONFIRMED activo
    a.sessions[2].completedAt = null;
    a.bookings[2].status = "CANCELLED";
    expect(checkProgramInvariants(a)).toEqual([]);
  });

  it("I8: pricedByPlan sin copago", () => {
    const s = base();
    s.bookings[0].copagoCents = null;
    expect(invariantsOf(s)).toEqual(["I8"]);
  });

  it("R-LEGACY: un legacy con I3/I5/I6 rotos no falla; con I1/I2/I4/I7/I8 sí", () => {
    const l = legacy();
    l.program!.pricingMode = "PACKAGE";
    l.program!.totalPriceCents = 1; // Σ (null) ≠ total: sería I6
    l.sessions[1].index = 1; // index vivo repetido: sería I5
    expect(checkProgramInvariants(l)).toEqual([]);
    l.program!.refs.push({ field: "serviceId", id: "sv-x", tenantId: "tenant-b" });
    l.program!.archivedAt = D("2026-10-06T00:00:00Z"); // ACTIVE archivado
    expect(invariantsOf(l)).toEqual(["I4", "I7"]);
  });

  it("vinculado solo por un turno (sin schedule): corre I3/I5/I6", () => {
    const s = base();
    s.program!.hasSchedule = false;
    s.program!.totalSessions = 9;
    expect(invariantsOf(s)).toEqual(["I5"]);
  });

  it("orden estable I1..I8", () => {
    const s = base();
    s.bookings[0].copagoCents = null; // I8
    s.program!.totalSessions = 5; // I5
    s.bookings[1].patientId = "otro"; // I1
    expect(invariantsOf(s)).toEqual(["I1", "I5", "I8"]);
  });
});

// ─── 2 · contra Postgres ─────────────────────────────────────────────────────

describe.skipIf(!RUN)("S11v · assertProgramInvariantsInTx (integración)", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let Other: EphemeralTenant;

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
    Other = await createEphemeralTenant(db);
  });

  afterAll(async () => {
    await T?.cleanup();
    await Other?.cleanup();
    await db?.$disconnect();
  });

  beforeEach(() => captureSpy.mockClear());

  const verify = (programId: string, tenantId = T.tenantId) =>
    runWithRls(tenantId, (tx) => assertProgramInvariantsInTx(tx, { tenantId, programId }));

  async function violationsOf(programId: string, tenantId = T.tenantId) {
    try {
      await verify(programId, tenantId);
    } catch (e) {
      expect(e).toBeInstanceOf(ProgramInvariantViolation);
      return (e as ProgramInvariantViolation).violations.map((v) => v.invariant);
    }
    return [];
  }

  /**
   * Plan vinculado y consistente: el fixture pone los turnos en `nextSlot()` y
   * las sesiones en BASE + i días, así que se alinea la fecha de cada sesión
   * con la de su turno (lo que hace el write-through de I3).
   */
  async function linkedPlan(o: { sessions?: number; bookings?: number } = {}) {
    const plan = await createPlan(db, T, {
      sessions: o.sessions ?? 3,
      bookings: o.bookings ?? 3,
      data: { schedule: { v: 1 } },
    });
    for (const [i, bookingId] of plan.bookingIds.entries()) {
      const b = await db.booking.findUniqueOrThrow({ where: { id: bookingId } });
      await db.session.update({ where: { id: plan.sessionIds[i] }, data: { scheduledFor: b.scheduledFor } });
    }
    return plan;
  }

  it("plan vinculado consistente → pasa y no reporta", async () => {
    const plan = await linkedPlan();
    await expect(verify(plan.programId)).resolves.toBeUndefined();
    expect(captureSpy).not.toHaveBeenCalled();
  });

  it("legacy del fixture (totalSessions 8 con 3 filas, 00:00Z, sin responsable) → pasa (R-LEGACY)", async () => {
    const l = await createLegacyPlan(db, T);
    await expect(verify(l.programId)).resolves.toBeUndefined();
  });

  it("legacy con la 1ª sesión de un profesional de otro consultorio → pasa (no es ref del plan)", async () => {
    const l = await createLegacyPlan(db, T, {
      sessionPractitionerIds: [Other.practitionerId, T.practitionerId, T.practitionerId],
    });
    await expect(verify(l.programId)).resolves.toBeUndefined();
  });

  it("I3: el turno se movió y la sesión no (write-through faltante) → viola, Sentry con el diff", async () => {
    const plan = await linkedPlan();
    await db.booking.update({
      where: { id: plan.bookingIds[1] },
      data: { scheduledFor: new Date(Date.parse("2027-01-04T13:00:00Z")) },
    });
    const err = await verify(plan.programId).catch((e) => e);
    expect(err).toBeInstanceOf(ProgramInvariantViolation);
    expect(err.programId).toBe(plan.programId);
    expect(err.violations).toHaveLength(1);
    expect(err.violations[0].invariant).toBe("I3");
    expect(err.violations[0].detail).toContain(plan.sessionIds[1]);
    expect(err.violations[0].detail).toContain(plan.bookingIds[1]);

    expect(captureSpy).toHaveBeenCalledTimes(1);
    const [reported, ctx] = captureSpy.mock.calls[0];
    expect(reported).toBe(err);
    expect(ctx).toMatchObject({
      scope: "plan-invariants",
      tenantId: T.tenantId,
      programId: plan.programId,
      linked: true,
      violations: err.violations,
    });
  });

  it("I3 en un turno cancelado no cuenta (la sesión queda sin turno con su fecha)", async () => {
    const plan = await linkedPlan();
    await db.booking.update({
      where: { id: plan.bookingIds[0] },
      data: { status: "CANCELLED", scheduledFor: new Date(Date.parse("2027-02-01T13:00:00Z")) },
    });
    await expect(verify(plan.programId)).resolves.toBeUndefined();
  });

  it("I5: totalSessions ≠ sesiones vivas en un vinculado; archivar una sin ajustar la caché viola", async () => {
    const plan = await linkedPlan({ sessions: 3, bookings: 2 });
    await db.session.update({ where: { id: plan.sessionIds[2] }, data: { archivedAt: new Date() } });
    expect(await violationsOf(plan.programId)).toEqual(["I5"]);
    await db.treatmentProgram.update({ where: { id: plan.programId }, data: { totalSessions: 2 } });
    await expect(verify(plan.programId)).resolves.toBeUndefined();
  });

  it("I5 vinculado SOLO por un turno (sin schedule) también se exige", async () => {
    const plan = await createPlan(db, T, { sessions: 2, bookings: 0, totalSessions: 5 });
    await expect(verify(plan.programId)).resolves.toBeUndefined(); // sin schedule ni turnos = legacy
    const s1 = await db.session.findUniqueOrThrow({ where: { id: plan.sessionIds[0] } });
    await addPlanBooking(db, T, {
      patientId: plan.patientId,
      programId: plan.programId,
      sessionId: plan.sessionIds[0],
      scheduledFor: s1.scheduledFor,
    });
    expect(await violationsOf(plan.programId)).toEqual(["I5"]);
  });

  it("I6: PACKAGE con Σ cuotas vivas ≠ total", async () => {
    const plan = await linkedPlan({ sessions: 3, bookings: 0 });
    await db.treatmentProgram.update({
      where: { id: plan.programId },
      data: { pricingMode: "PACKAGE", pricePerSessionCents: null, totalPriceCents: 1_500_000 },
    });
    await expect(verify(plan.programId)).resolves.toBeUndefined(); // 3 × 500.000
    await db.session.update({ where: { id: plan.sessionIds[0] }, data: { priceCents: 499_999 } });
    expect(await violationsOf(plan.programId)).toEqual(["I6"]);
  });

  it("I4: servicio, profesional, sede y plantilla del plan de otro consultorio (también en legacy)", async () => {
    const otherLocation = await db.location.create({ data: { tenantId: Other.tenantId, name: "Sede ajena" } });
    const otherTemplate = await db.planTemplate.create({
      data: { tenantId: Other.tenantId, authorId: Other.practitionerId, name: "Plantilla ajena", exerciseIds: [] },
    });
    const plan = await linkedPlan({ sessions: 1, bookings: 1 });
    await db.treatmentProgram.update({
      where: { id: plan.programId },
      data: {
        serviceId: Other.serviceId,
        practitionerId: Other.practitionerId,
        locationId: otherLocation.id,
        templateId: otherTemplate.id,
      },
    });
    const err = await verify(plan.programId).catch((e) => e);
    expect(err).toBeInstanceOf(ProgramInvariantViolation);
    expect(err.violations.map((v: { invariant: string }) => v.invariant)).toEqual(["I4", "I4", "I4", "I4"]);
    const details = err.violations.map((v: { detail: string }) => v.detail).join(" | ");
    for (const id of [Other.serviceId, Other.practitionerId, otherLocation.id, otherTemplate.id]) {
      expect(details).toContain(id);
    }

    const l = await createLegacyPlan(db, T);
    await db.treatmentProgram.update({ where: { id: l.programId }, data: { serviceId: Other.serviceId } });
    expect(await violationsOf(l.programId)).toEqual(["I4"]);
  });

  it("I4: plantilla propia cuyo servicio es de otro consultorio (PlanTemplate.serviceId)", async () => {
    const tpl = await db.planTemplate.create({
      data: { tenantId: T.tenantId, authorId: T.practitionerId, name: "Plantilla", exerciseIds: [], serviceId: Other.serviceId },
    });
    const plan = await linkedPlan({ sessions: 1, bookings: 1 });
    await db.treatmentProgram.update({ where: { id: plan.programId }, data: { templateId: tpl.id } });
    const err = await verify(plan.programId).catch((e) => e);
    expect(err.violations).toEqual([
      expect.objectContaining({ invariant: "I4", detail: expect.stringContaining("template.serviceId") }),
    ]);
  });

  it("I4: plan de OTRO consultorio (o inexistente) → violación, nunca lo lee", async () => {
    const foreign = await createPlan(db, Other, { sessions: 1 });
    expect(await violationsOf(foreign.programId)).toEqual(["I4"]);
    expect(await violationsOf("no-existe")).toEqual(["I4"]);
  });

  it("I7: plan archivado en ACTIVE; sesión archivada con turno activo", async () => {
    const plan = await linkedPlan({ sessions: 2, bookings: 2 });
    await db.treatmentProgram.update({ where: { id: plan.programId }, data: { archivedAt: new Date() } });
    expect(await violationsOf(plan.programId)).toEqual(["I7"]);
    await db.treatmentProgram.update({ where: { id: plan.programId }, data: { status: "CANCELLED" } });
    await expect(verify(plan.programId)).resolves.toBeUndefined();

    const p2 = await linkedPlan({ sessions: 2, bookings: 2 });
    await db.session.update({ where: { id: p2.sessionIds[1] }, data: { archivedAt: new Date() } });
    await db.treatmentProgram.update({ where: { id: p2.programId }, data: { totalSessions: 1 } });
    expect(await violationsOf(p2.programId)).toEqual(["I7"]);
    await db.booking.update({ where: { id: p2.bookingIds[1] }, data: { status: "CANCELLED" } });
    await expect(verify(p2.programId)).resolves.toBeUndefined();
  });

  it("dentro de la tx: una violación hace rollback de lo escrito antes en la misma tx", async () => {
    const plan = await linkedPlan({ sessions: 2, bookings: 2 });
    const before = await db.treatmentProgram.findUniqueOrThrow({ where: { id: plan.programId } });
    const err = await runWithRls(T.tenantId, async (tx) => {
      await tx.treatmentProgram.update({
        where: { id: plan.programId, tenantId: T.tenantId },
        data: { title: "cambio que no tiene que quedar", totalSessions: 7 },
      });
      await assertProgramInvariantsInTx(tx, { tenantId: T.tenantId, programId: plan.programId });
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ProgramInvariantViolation);
    expect(err.violations.map((v: { invariant: string }) => v.invariant)).toEqual(["I5"]);
    const after = await db.treatmentProgram.findUniqueOrThrow({ where: { id: plan.programId } });
    expect(after.title).toBe(before.title);
    expect(after.totalSessions).toBe(2);
  });

  it("ve lo escrito en la misma tx (corre al final del commit del motor)", async () => {
    const plan = await linkedPlan({ sessions: 2, bookings: 2 });
    await runWithRls(T.tenantId, async (tx) => {
      // Agregar una sesión y su caché en la misma tx: consistente.
      await tx.session.create({
        data: { programId: plan.programId, practitionerId: T.practitionerId, index: 3, scheduledFor: new Date(), priceCents: 500_000 },
      });
      await tx.treatmentProgram.update({ where: { id: plan.programId, tenantId: T.tenantId }, data: { totalSessions: 3 } });
      await assertProgramInvariantsInTx(tx, { tenantId: T.tenantId, programId: plan.programId });
    });
    expect(captureSpy).not.toHaveBeenCalled();
  });

  it("detalle sin PHI: ni nombre ni DNI del paciente ni título del plan", async () => {
    const plan = await linkedPlan({ sessions: 2, bookings: 1 });
    await db.treatmentProgram.update({ where: { id: plan.programId }, data: { totalSessions: 9 } });
    const err = await verify(plan.programId).catch((e) => e);
    const patient = await db.patient.findUniqueOrThrow({ where: { id: plan.patientId } });
    const program = await db.treatmentProgram.findUniqueOrThrow({ where: { id: plan.programId } });
    const blob = JSON.stringify(err.violations) + err.message;
    for (const phi of [patient.lastName, patient.documentId!, program.title]) expect(blob).not.toContain(phi);
  });

  it("archivar una sesión con el index repetido por otra viva nueva (restore sin renumerar) se ve en I5", async () => {
    const plan = await linkedPlan({ sessions: 2, bookings: 0 });
    await db.session.update({ where: { id: plan.sessionIds[1] }, data: { archivedAt: new Date() } });
    await addPlanSession(db, plan.programId, { index: 2, practitionerId: T.practitionerId, priceCents: 500_000 });
    await expect(verify(plan.programId)).resolves.toBeUndefined(); // index 2: una viva + una archivada = OK
  });
});
