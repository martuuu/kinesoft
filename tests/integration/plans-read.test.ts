/**
 * S14 · Lecturas de Planes (`lib/plans-read.ts`, ES2b P2.0).
 *
 * Contra la base real con el `getActor()` real (solo se mockea la sesión de
 * Supabase y el runtime de cache de Next). Corre con los dos roles de DB:
 * `kinesoft_app` (RLS) y el owner BYPASSRLS (`test:integration:owner`,
 * reproduce prod): con BYPASSRLS el plan de otro consultorio tiene que seguir
 * sin salir por el `tenantId` a mano, no por RLS.
 *
 * Qué se prueba (§10 S14 + §5 "Lecturas" + E1/E2):
 *   - nivel `full` (DTO completo) vs `admin` (título, notas, cuotas y
 *     ejercicios en null) vs nada (Forbidden);
 *   - ASSISTANT pide `getPlanDetail` → Forbidden; `listSchedulablePlanSessions`
 *     sale con la ALLOWLIST exacta (sin título ni notas);
 *   - la autorización de la OS: sale para quien la puede ver, la clave no
 *     existe para el resto, nunca en `listPlans` ni en la agenda; vencimiento
 *     30/11 leído en TZ=UTC → 30/11;
 *   - "sin turno" derivado (= `sessionWithoutActiveBookingWhere`) y R-LEGACY;
 *   - ordinal M13 (no `index`), archivadas sin ordinal;
 *   - saldo P7 agregado en el server, con `insurerPaidAt` aparte;
 *   - cross-tenant y vertical General;
 *   - paridad `bookingHasMoney` ↔ `cancelBookingsInTx` ↔ `bookingHasPaymentWhere`.
 *
 * Fechas en 2030 (futuro) y 2020 (pasado): nada depende del reloj de hoy.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { BookingStatus, PaymentStatus, PrismaClient } from "@prisma/client";
import { runWithRls } from "@/lib/rls";
import { MODULE_DENIED_COPY } from "@/lib/tenant-modules";
import { PLAN_FORBIDDEN_COPY } from "@/lib/plan-authz-internal";
import {
  bookingHasPaymentWhere,
  linkedProgramWhere,
  liveProgramWhere,
  sessionWithoutActiveBookingWhere,
} from "@/lib/plan-predicates";
import { bookingHasMoney } from "@/lib/plan-pricing";
import { cancelBookingsInTx } from "@/lib/bookings-cancel-internal";
import {
  getPatientPlanBalances,
  getPatientPlans,
  getPlanDetail,
  getPlanHistory,
  listPlans,
  listSchedulablePlanSessions,
} from "@/lib/plans-read";
import { PLAN_READ_COPY, type PlanDTO } from "@/lib/plans-read-types";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { addPlanSession, createLegacyPlan, createPlan } from "@/tests/helpers/plan-factory";
import { asUser, asAnonymous } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

const SECRET_TITLE = "Lumbalgia secreta S14";
const SECRET_NOTES = "Nota clínica S14: no sale sin clinical.read";
const SECRET_SESSION_TITLE = "Sesión con título clínico S14";

function ok<T>(r: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(`esperaba ok y vino error: ${r.error}`);
  return r.data;
}

describe.skipIf(!RUN)("S14 · lecturas de Planes", () => {
  let db: PrismaClient;
  let K: EphemeralTenant;
  let Other: EphemeralTenant;
  let G: EphemeralTenant;
  let users: Record<"OWNER" | "PRO" | "PRO_BASIC" | "ASSISTANT" | "BILLING", string>;
  let proPractitionerId: string;
  let patientId: string;
  /** Plan vinculado principal. */
  let A: { programId: string; s: Record<"done" | "archived" | "booked" | "unbooked" | "overdue", string> };
  let bookedBookingId: string;
  let legacy: { programId: string; sessionIds: string[] };
  let archivedProgramId: string;
  let otherPlan: { programId: string; patientId: string };
  let authCurrentId: string;
  let authOldId: string;

  beforeAll(async () => {
    db = ownerClient();
    K = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "FREE" });
    Other = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "PRO" });
    G = await createEphemeralTenant(db, { vertical: "GENERAL", plan: "PRO", publicBookingEnabled: false });
    const pro = await addPractitioner(db, K, "PRACTITIONER");
    const proBasic = await addPractitioner(db, K, "PRACTITIONER");
    const assistant = await addPractitioner(db, K, "ASSISTANT");
    const billing = await addPractitioner(db, K, "BILLING");
    proPractitionerId = pro.practitionerId;
    users = {
      OWNER: K.userId,
      PRO: pro.userId,
      PRO_BASIC: proBasic.userId,
      ASSISTANT: assistant.userId,
      BILLING: billing.userId,
    };
    patientId = await addPatient(db, K, { assignedPractitionerId: pro.practitionerId });

    // ── Plan A (vinculado por turnos; PER_SESSION $5.000) ──
    const program = await db.treatmentProgram.create({
      data: {
        tenantId: K.tenantId,
        patientId,
        title: SECRET_TITLE,
        notes: SECRET_NOTES,
        totalSessions: 5,
        startDate: new Date("2030-01-01T03:00:00Z"),
        discipline: "KINESIOLOGY",
        practitionerId: pro.practitionerId,
        serviceId: K.serviceId,
        pricingMode: "PER_SESSION",
        pricePerSessionCents: 500_000,
      },
    });
    const sess = async (index: number, at: string, extra: { archivedAt?: Date } = {}) =>
      addPlanSession(db, program.id, {
        index,
        practitionerId: pro.practitionerId,
        scheduledFor: new Date(at),
        priceCents: 500_000,
        archivedAt: extra.archivedAt ?? null,
      });
    const book = async (
      sessionId: string,
      at: string,
      status: BookingStatus,
      pay: { paymentStatus?: PaymentStatus; copagoCents?: number | null; insurerPaidAt?: Date | null } = {}
    ) =>
      (
        await db.booking.create({
          data: {
            tenantId: K.tenantId,
            patientId,
            practitionerId: pro.practitionerId,
            serviceId: K.serviceId,
            scheduledFor: new Date(at),
            durationMin: 45,
            idempotencyKey: randomUUID(),
            status,
            paymentStatus: pay.paymentStatus ?? "UNPAID",
            copagoCents: pay.copagoCents === undefined ? 500_000 : pay.copagoCents,
            pricedByPlan: (pay.copagoCents === undefined ? 500_000 : pay.copagoCents) !== null,
            insurerPaidAt: pay.insurerPaidAt ?? null,
            programId: program.id,
            sessionId,
          },
        })
      ).id;

    // Fechas: overdue (2020) < unbooked (06/01) < done (07/01) < booked (09/01); archivada el 08/01.
    const sDone = await sess(1, "2030-01-07T13:00:00Z");
    const sArchived = await sess(2, "2030-01-08T13:00:00Z", { archivedAt: new Date() });
    const sBooked = await sess(3, "2030-01-09T13:00:00Z");
    const sUnbooked = await sess(4, "2030-01-06T13:00:00Z");
    const sOverdue = await sess(5, "2020-01-06T13:00:00Z");
    await db.session.update({ where: { id: sDone }, data: { completedAt: new Date("2030-01-07T14:00:00Z"), title: SECRET_SESSION_TITLE, notes: SECRET_NOTES } });
    await book(sDone, "2030-01-07T13:00:00Z", "COMPLETED", { paymentStatus: "PAID" });
    bookedBookingId = await book(sBooked, "2030-01-09T13:00:00Z", "CONFIRMED");
    // Sin turno: su turno se canceló, con la OS pagada (insurerPaidAt) y el copago impago.
    await book(sUnbooked, "2030-01-06T13:00:00Z", "CANCELLED", { insurerPaidAt: new Date("2030-01-10T12:00:00Z") });
    await book(sOverdue, "2020-01-06T13:00:00Z", "CONFIRMED");
    A = {
      programId: program.id,
      s: { done: sDone, archived: sArchived, booked: sBooked, unbooked: sUnbooked, overdue: sOverdue },
    };

    // Autorización: una vieja (superseded) y la vigente, que vence el 30/11.
    authOldId = (
      await db.programAuthorization.create({
        data: {
          tenantId: K.tenantId,
          programId: program.id,
          code: "AUT-VIEJA",
          authorizedSessions: 5,
          startsOn: new Date("2029-06-01T00:00:00Z"),
          expiresOn: new Date("2029-12-31T00:00:00Z"),
          supersededAt: new Date("2030-01-01T12:00:00Z"),
        },
      })
    ).id;
    authCurrentId = (
      await db.programAuthorization.create({
        data: {
          tenantId: K.tenantId,
          programId: program.id,
          code: "AUT-2030",
          authorizedSessions: 10,
          startsOn: new Date("2030-01-01T00:00:00Z"),
          expiresOn: new Date("2030-11-30T00:00:00Z"),
        },
      })
    ).id;

    // Historial: eventos del plan, de una sesión y de la autorización (con PHI en el payload).
    await db.auditEvent.createMany({
      data: [
        { tenantId: K.tenantId, actorId: K.userId, action: "program.create", entity: "TreatmentProgram", entityId: program.id, payload: { title: SECRET_TITLE, totalSessions: 5 } },
        { tenantId: K.tenantId, actorId: K.userId, action: "program.status", entity: "TreatmentProgram", entityId: program.id, payload: { from: "ACTIVE", to: "PAUSED" } },
        { tenantId: K.tenantId, actorId: pro.userId, action: "session.complete", entity: "Session", entityId: sDone, payload: { notes: SECRET_NOTES, index: 1 } },
        { tenantId: K.tenantId, actorId: K.userId, action: "program.authorization.renew", entity: "ProgramAuthorization", entityId: authCurrentId, payload: { from: authOldId } },
      ],
    });

    legacy = await createLegacyPlan(db, K, { patientId });
    archivedProgramId = (
      await createPlan(db, K, { patientId, sessions: 1, data: { status: "COMPLETED", archivedAt: new Date() } })
    ).programId;
    otherPlan = await createPlan(db, Other, { sessions: 2 });
  });

  afterAll(async () => {
    asAnonymous();
    await K?.cleanup();
    await Other?.cleanup();
    await G?.cleanup();
    await db?.$disconnect();
  });

  // ─── getPlanDetail ─────────────────────────────────────────────────────────

  it("OWNER: getPlanDetail completo — ordinal M13, estados derivados, saldo y autorización", async () => {
    asUser(users.OWNER);
    const d = ok(await getPlanDetail({ programId: A.programId }));
    expect(d.level).toBe("full");
    expect(d.title).toBe(SECRET_TITLE);
    expect(d.notes).toBe(SECRET_NOTES);
    expect(d.linked).toBe(true);
    expect(d.totalLive).toBe(4);
    expect(d.done).toBe(1);
    expect(d.sinTurno).toBe(1);
    const byId = new Map(d.sessions.map((s) => [s.id, s]));
    // Ordinal por fecha entre las vivas (no `index`): overdue(2020)=1, unbooked=2, done=3, booked=4.
    expect(byId.get(A.s.overdue)).toMatchObject({ ordinal: 1, state: "overdue", sinTurno: false });
    expect(byId.get(A.s.unbooked)).toMatchObject({ ordinal: 2, state: "unbooked", sinTurno: true, booking: null });
    expect(byId.get(A.s.done)).toMatchObject({ ordinal: 3, state: "done", title: SECRET_SESSION_TITLE, priceCents: 500_000 });
    expect(byId.get(A.s.booked)).toMatchObject({ ordinal: 4, state: "booked" });
    expect(byId.get(A.s.booked)?.booking?.id).toBe(bookedBookingId);
    expect(byId.get(A.s.archived)).toMatchObject({ ordinal: null, state: "archived", sinTurno: false });
    expect(d.nextSession).toEqual({ sessionId: A.s.booked, ordinal: 4, at: new Date("2030-01-09T13:00:00Z") });
    // P7: pactado 4 vivas × $5.000; devengado = la realizada; cobrado = su copago PAID.
    // La OS pagada del turno cancelado NO suma en cobrado (copago ≠ arancel): va aparte.
    expect(d.balance).toEqual({
      agreedCents: 2_000_000,
      accruedCents: 500_000,
      collectedCents: 500_000,
      inProcessCents: 0,
      pendingCents: 0,
      creditCents: 0,
      insurerPaidBookings: 1,
    });
    // E2: la vigente, con usadas (realizadas ≥ inicio) y agendadas (turno activo ≥ inicio).
    expect(d.authorization).toEqual({
      id: authCurrentId,
      code: "AUT-2030",
      authorizedSessions: 10,
      startsOn: "2030-01-01",
      expiresOn: "2030-11-30",
      used: 1,
      scheduled: 1,
    });
  });

  it("vencimiento 30/11 leído en TZ=UTC → 30/11 (dbDateToDayKey, no toARDateKey)", async () => {
    // El script de integración corre con TZ=UTC; con `toARDateKey` el @db.Date
    // a 00:00Z daría 29/11 (21:00 AR del día anterior).
    asUser(users.PRO);
    const d = ok(await getPlanDetail({ programId: A.programId }));
    expect(d.authorization?.expiresOn).toBe("2030-11-30");
  });

  it("PRACTITIONER asignado (full + clinical.read) → DTO completo", async () => {
    asUser(users.PRO);
    const d = ok(await getPlanDetail({ programId: A.programId }));
    expect(d.title).toBe(SECRET_TITLE);
    expect(d.practitionerId).toBe(proPractitionerId);
  });

  it("ASSISTANT pide getPlanDetail → Forbidden", async () => {
    asUser(users.ASSISTANT);
    expect(await getPlanDetail({ programId: A.programId })).toEqual({ ok: false, error: PLAN_READ_COPY.forbidden });
  });

  it("PRACTITIONER básico y BILLING piden getPlanDetail → Forbidden", async () => {
    for (const u of [users.PRO_BASIC, users.BILLING]) {
      asUser(u);
      expect(await getPlanDetail({ programId: A.programId })).toEqual({ ok: false, error: PLAN_READ_COPY.forbidden });
    }
  });

  it("cross-tenant: el plan de otro consultorio no existe (ni con BYPASSRLS)", async () => {
    asUser(users.OWNER);
    expect(await getPlanDetail({ programId: otherPlan.programId })).toEqual({ ok: false, error: PLAN_READ_COPY.notFound });
    expect(await getPlanHistory({ programId: otherPlan.programId })).toEqual({ ok: false, error: PLAN_READ_COPY.notFound });
    expect(await getPatientPlans({ patientId: otherPlan.patientId })).toEqual({ ok: false, error: PLAN_READ_COPY.forbidden });
    expect(await getPatientPlanBalances({ patientId: otherPlan.patientId })).toEqual({ ok: false, error: PLAN_READ_COPY.forbidden });
    const list = ok(await listPlans({}));
    expect(list.rows.some((r) => r.id === otherPlan.programId)).toBe(false);
  });

  // ─── getPatientPlans ───────────────────────────────────────────────────────

  it("ASSISTANT: getPatientPlans = proyección admin (título, notas y cuotas en null) + autorización", async () => {
    asUser(users.ASSISTANT);
    const plans = ok(await getPatientPlans({ patientId }));
    const a = plans.find((p) => p.id === A.programId)!;
    expect(a.level).toBe("admin");
    expect(a.title).toBeNull();
    expect(a.notes).toBeNull();
    for (const s of a.sessions) {
      expect(s.title).toBeNull();
      expect(s.notes).toBeNull();
      expect(s.priceCents).toBeNull();
      expect(s.exerciseCount).toBeNull();
    }
    // Lo administrativo sí: ordinal, "sin turno", saldo.
    expect(a.sinTurno).toBe(1);
    expect(a.balance.collectedCents).toBe(500_000);
    // E2: la Secretaria carga autorizaciones (plans.authorize + operateAll) → la ve.
    expect(a.authorization?.code).toBe("AUT-2030");
    const json = JSON.stringify(plans);
    expect(json).not.toContain(SECRET_TITLE);
    expect(json).not.toContain(SECRET_NOTES);
    expect(json).not.toContain(SECRET_SESSION_TITLE);
  });

  it("BILLING (billing.manage): proyección admin con la autorización", async () => {
    asUser(users.BILLING);
    const a = ok(await getPatientPlans({ patientId })).find((p) => p.id === A.programId)!;
    expect(a.level).toBe("admin");
    expect(a.title).toBeNull();
    expect(a.authorization?.expiresOn).toBe("2030-11-30");
  });

  it("la autorización no sale para un PRACTITIONER básico", async () => {
    asUser(users.PRO_BASIC);
    expect(await getPatientPlans({ patientId })).toEqual({ ok: false, error: PLAN_READ_COPY.forbidden });
    const list = ok(await listPlans({}));
    expect(list.rows.some((r) => r.patientId === patientId)).toBe(false);
    expect(await listSchedulablePlanSessions({ patientId })).toEqual({ ok: false, error: PLAN_FORBIDDEN_COPY.schedule });
  });

  it("OWNER: getPatientPlans excluye archivados salvo includeArchived; R-LEGACY en el legacy", async () => {
    asUser(users.OWNER);
    const live = ok(await getPatientPlans({ patientId }));
    const ids = live.map((p) => p.id);
    expect(ids).toContain(A.programId);
    expect(ids).toContain(legacy.programId);
    expect(ids).not.toContain(archivedProgramId);
    const l = live.find((p) => p.id === legacy.programId)!;
    expect(l.linked).toBe(false);
    expect(l.sinTurno).toBe(0);
    expect(l.sessions.every((s) => s.sinTurno === false)).toBe(true);
    const all = ok(await getPatientPlans({ patientId, includeArchived: true }));
    expect(all.map((p) => p.id)).toContain(archivedProgramId);
  });

  it("'sin turno' derivado = sessionWithoutActiveBookingWhere sobre planes vinculados", async () => {
    asUser(users.OWNER);
    const plans = ok(await getPatientPlans({ patientId }));
    const fromRead = plans.flatMap((p: PlanDTO) => p.sessions.filter((s) => s.sinTurno).map((s) => s.id)).sort();
    const fromPredicate = (
      await runWithRls(K.tenantId, (tx) =>
        tx.session.findMany({
          where: {
            AND: [
              sessionWithoutActiveBookingWhere,
              { program: { tenantId: K.tenantId, patientId, ...liveProgramWhere, AND: [linkedProgramWhere] } },
            ],
          },
          select: { id: true },
        })
      )
    )
      .map((s) => s.id)
      .sort();
    expect(fromRead).toEqual(fromPredicate);
    expect(fromRead).toEqual([A.s.unbooked]);
  });

  // ─── listSchedulablePlanSessions ───────────────────────────────────────────

  it("ASSISTANT pide listSchedulablePlanSessions → allowlist exacta, sin título ni notas", async () => {
    // `programId` (ES3, S19c): un id, no PHI; la UI elige la sesión del plan exacto.
    asUser(users.ASSISTANT);
    const rows = ok(await listSchedulablePlanSessions({ patientId }));
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(
        ["discipline", "locationId", "ordinal", "practitionerId", "programId", "serviceId", "sessionId", "sinTurno", "totalLive"].sort()
      );
    }
    // Vivas sin cerrar de planes ACTIVE vinculados: ni la realizada, ni la archivada, ni el legacy.
    expect(rows.map((r) => r.sessionId).sort()).toEqual([A.s.booked, A.s.overdue, A.s.unbooked].sort());
    const unbooked = rows.find((r) => r.sessionId === A.s.unbooked)!;
    expect(unbooked).toEqual({
      sessionId: A.s.unbooked,
      programId: A.programId,
      ordinal: 2,
      totalLive: 4,
      discipline: "KINESIOLOGY",
      serviceId: K.serviceId,
      practitionerId: proPractitionerId,
      locationId: null,
      sinTurno: true,
    });
    expect(rows.filter((r) => r.sinTurno).map((r) => r.sessionId)).toEqual([A.s.unbooked]);
    const json = JSON.stringify(rows);
    expect(json).not.toContain(SECRET_TITLE);
    expect(json).not.toContain(SECRET_NOTES);
    expect(json).not.toContain("AUT-2030");
    expect(json).not.toContain("500000");
  });

  it("BILLING no agenda: listSchedulablePlanSessions → Forbidden", async () => {
    asUser(users.BILLING);
    expect(await listSchedulablePlanSessions({ patientId })).toEqual({ ok: false, error: PLAN_FORBIDDEN_COPY.schedule });
  });

  // ─── listPlans ─────────────────────────────────────────────────────────────

  it("OWNER: listPlans por disciplina, filtro 'sin turno', sin autorización en las filas", async () => {
    asUser(users.OWNER);
    const all = ok(await listPlans({}));
    const ids = all.rows.map((r) => r.id);
    expect(ids).toContain(A.programId);
    expect(ids).toContain(legacy.programId);
    expect(ids).not.toContain(archivedProgramId);
    const a = all.rows.find((r) => r.id === A.programId)!;
    expect(a.title).toBe(SECRET_TITLE);
    expect(a.patientName).toMatch(/Paciente/);
    for (const r of all.rows) expect("authorization" in r).toBe(false);
    const kine = ok(await listPlans({ discipline: "KINESIOLOGY" }));
    expect(kine.rows.map((r) => r.id)).not.toContain(legacy.programId); // legacy sin disciplina
    const sinTurno = ok(await listPlans({ onlyWithSinTurno: true }));
    expect(sinTurno.rows.map((r) => r.id)).toEqual([A.programId]);
  });

  it("ASSISTANT: listPlans con título null", async () => {
    asUser(users.ASSISTANT);
    const rows = ok(await listPlans({})).rows;
    const a = rows.find((r) => r.id === A.programId)!;
    expect(a.level).toBe("admin");
    expect(a.title).toBeNull();
    expect(JSON.stringify(rows)).not.toContain(SECRET_TITLE);
  });

  // ─── getPatientPlanBalances ────────────────────────────────────────────────

  it("getPatientPlanBalances: saldo P7 por plan y totales, título según nivel", async () => {
    asUser(users.BILLING);
    const b = ok(await getPatientPlanBalances({ patientId }));
    const a = b.plans.find((p) => p.programId === A.programId)!;
    expect(a.title).toBeNull();
    expect(a.balance.insurerPaidBookings).toBe(1);
    expect(b.totals.collectedCents).toBe(b.plans.reduce((acc, p) => acc + p.balance.collectedCents, 0));
    asUser(users.OWNER);
    const o = ok(await getPatientPlanBalances({ patientId }));
    expect(o.plans.find((p) => p.programId === A.programId)?.title).toBe(SECRET_TITLE);
    // Incluye el archivado: un plan cerrado puede seguir debiendo plata.
    expect(o.plans.map((p) => p.programId)).toContain(archivedProgramId);
  });

  // ─── getPlanHistory ────────────────────────────────────────────────────────

  it("getPlanHistory: eventos del plan, sus sesiones y su autorización, payload por allowlist", async () => {
    asUser(users.OWNER);
    const h = ok(await getPlanHistory({ programId: A.programId }));
    const actions = h.events.map((e) => e.action).sort();
    expect(actions).toEqual(
      ["program.authorization.renew", "program.create", "program.status", "session.complete"].sort()
    );
    const status = h.events.find((e) => e.action === "program.status")!;
    expect(status.detail).toEqual({ from: "ACTIVE", to: "PAUSED" });
    expect(status.actorName).toBeTruthy();
    expect(JSON.stringify(h.events)).not.toContain(SECRET_TITLE);
    expect(JSON.stringify(h.events)).not.toContain(SECRET_NOTES);
    expect(h.authorizations?.map((a) => a.id)).toEqual([authCurrentId, authOldId]);
    expect(h.authorizations?.[1]).toMatchObject({ code: "AUT-VIEJA", startsOn: "2029-06-01", expiresOn: "2029-12-31" });
  });

  it("ASSISTANT pide getPlanHistory → Forbidden", async () => {
    asUser(users.ASSISTANT);
    expect(await getPlanHistory({ programId: A.programId })).toEqual({ ok: false, error: PLAN_READ_COPY.forbidden });
  });

  // ─── Vertical General ──────────────────────────────────────────────────────

  it("GENERAL (sin `planes`): listas vacías, detalle con el copy del módulo", async () => {
    asUser(G.userId);
    const gPatient = await addPatient(db, G);
    expect(ok(await listPlans({}))).toEqual({ rows: [], truncated: false });
    expect(ok(await getPatientPlans({ patientId: gPatient }))).toEqual([]);
    expect(ok(await listSchedulablePlanSessions({ patientId: gPatient }))).toEqual([]);
    expect(ok(await getPatientPlanBalances({ patientId: gPatient }))).toEqual({
      plans: [],
      totals: { pendingCents: 0, creditCents: 0, collectedCents: 0, inProcessCents: 0 },
    });
    expect(await getPlanDetail({ programId: A.programId })).toEqual({ ok: false, error: MODULE_DENIED_COPY.planes });
    expect(await getPlanHistory({ programId: A.programId })).toEqual({ ok: false, error: MODULE_DENIED_COPY.planes });
  });

  it("entrada inválida → error, sin tocar la base", async () => {
    asUser(users.OWNER);
    expect(await getPlanDetail({ programId: "" })).toEqual({ ok: false, error: PLAN_READ_COPY.invalid });
    expect(await getPatientPlans({ patientId: "x".repeat(65) })).toEqual({ ok: false, error: PLAN_READ_COPY.invalid });
    // `.strict()`: una clave de más (p. ej. un tenantId colado) se rechaza.
    expect(await listPlans({ tenantId: Other.tenantId } as never)).toEqual({ ok: false, error: PLAN_READ_COPY.invalid });
  });

  // ─── Paridad del criterio "tiene plata" (handoff de ES1) ───────────────────

  it("paridad bookingHasMoney ↔ cancelBookingsInTx ↔ bookingHasPaymentWhere", async () => {
    const statuses: PaymentStatus[] = ["UNPAID", "AUTHORIZED", "PAID", "REFUNDED", "FAILED"];
    const cases: { paymentStatus: PaymentStatus; insurerPaid: boolean; payment: PaymentStatus | null }[] = [];
    for (const paymentStatus of statuses)
      for (const insurerPaid of [false, true])
        for (const payment of [null, ...statuses]) cases.push({ paymentStatus, insurerPaid, payment });

    const patient = await addPatient(db, K);
    const ids: string[] = [];
    let i = 0;
    for (const c of cases) {
      i += 1;
      const b = await db.booking.create({
        data: {
          tenantId: K.tenantId,
          patientId: patient,
          practitionerId: K.practitionerId,
          serviceId: K.serviceId,
          // Un instante distinto por fila (índice paciente-instante).
          scheduledFor: new Date(Date.parse("2031-03-03T12:00:00Z") + i * 3_600_000),
          durationMin: 45,
          idempotencyKey: randomUUID(),
          status: "CONFIRMED",
          paymentStatus: c.paymentStatus,
          insurerPaidAt: c.insurerPaid ? new Date("2031-01-01T12:00:00Z") : null,
        },
      });
      if (c.payment) {
        await db.payment.create({ data: { bookingId: b.id, status: c.payment, amountCents: 0 } });
      }
      ids.push(b.id);
    }

    const matched = new Set(
      (
        await runWithRls(K.tenantId, (tx) =>
          tx.booking.findMany({ where: { AND: [{ tenantId: K.tenantId, id: { in: ids } }, bookingHasPaymentWhere] }, select: { id: true } })
        )
      ).map((r) => r.id)
    );
    const res = await runWithRls(K.tenantId, (tx) =>
      cancelBookingsInTx(tx, { tenantId: K.tenantId, bookingIds: ids, reason: "paridad S14", actorId: null })
    );
    const skippedForMoney = new Set(res.skipped.filter((s) => s.reason === "has-payment").map((s) => s.id));
    const cancelled = new Set(res.cancelled.map((c) => c.id));

    cases.forEach((c, k) => {
      const id = ids[k];
      const pure = bookingHasMoney({
        paymentStatus: c.paymentStatus,
        insurerPaidAt: c.insurerPaid ? new Date() : null,
        payment: c.payment ? { status: c.payment } : null,
      });
      const label = JSON.stringify(c);
      expect({ label, where: matched.has(id) }).toEqual({ label, where: pure });
      expect({ label, cancelSkips: skippedForMoney.has(id) }).toEqual({ label, cancelSkips: pure });
      expect({ label, cancelled: cancelled.has(id) }).toEqual({ label, cancelled: !pure });
    });
    // Control anti-falso-verde: la matriz tiene de los dos lados.
    expect(matched.size).toBeGreaterThan(0);
    expect(cancelled.size).toBeGreaterThan(0);
  });
});
