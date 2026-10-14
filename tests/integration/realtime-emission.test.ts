/**
 * SV08 · «Emisión por write-path» (plan §18.8 fila SV08, §18.10 punto 9).
 *
 * Por qué: la Sala de Espera en tiempo real (SV) depende de que TODO cambio de
 * un turno commiteado se publique una vez, después del commit, con los refs
 * exactos (`bookingId`, `practitionerId`, `roomId`, `kind` y `prev` en los
 * movimientos). Antes de SV el hook tenía un early return con
 * `invalidateCaches:false` (Recepción «llegó» no avisaba) y había write-paths
 * que ni pasaban por el hook (turnero, webhook, candado). El guard (c) de
 * `scripts/guard-realtime.mjs` mira que cada action LLAME al hook; este archivo
 * mira el efecto: la llamada al publisher que de verdad sale, por action.
 *
 * Cómo: corre las actions REALES (getActor real; el setup mockea solo la sesión
 * de Supabase, `next/headers`, el runtime de cache y el publisher, que es la
 * red). `realtimeFake` (tests/helpers/realtime-fake.ts) registra cada publish:
 *   - «una llamada = un publish»: `realtimeFake.calls` tiene exactamente 1 por
 *     action (y 1 con 20 refs para el batch de 20);
 *   - post-commit: `realtimeFake.onCall` corre ANTES de que el publish
 *     responda y lee la fila con el cliente OWNER (otra conexión): si el hook
 *     se llamara dentro de la tx, la fila todavía no sería visible ahí;
 *   - refs exactos: se comparan contra la fila que quedó en la base.
 * Corre con los dos roles (`kinesoft_app` con RLS y el owner BYPASSRLS = prod).
 *
 * Convención: un write-path que hoy no cumple va como
 * `it.fails("[SV08-gap] …")` con la expectativa CORRECTA (lo da vuelta quien
 * lo arregle). Los casos que dependen de sesiones paralelas de SV1.2 (SV05
 * `llamar`, SV06a turnero/webhook, SV06b candado) van en
 * `[post-integración SV1.2]`: SV08 los escribió contra el contrato mientras
 * esas sesiones corrían; desde la integración de SV1.2 corren siempre.
 *
 * Fechas: futuras (2030+) salvo Recepción, que exige HOY; TZ=UTC lo fija el
 * script, así un `getDay`/`setHours` del host correría los días.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

vi.hoisted(() => {
  // Turnero y webhook (solo en el bloque post-integración): `client()` de MP
  // exige el token y el webhook verifica la firma con este secreto. Nunca sale
  // a la red: el SDK está mockeado abajo.
  process.env.MP_ACCESS_TOKEN = "TEST-access-token";
  process.env.MP_WEBHOOK_SECRET = "test-webhook-secret-sv08";
});

/** Detalle que "devuelve MP" por payment id (webhook). */
const mpPayments = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock("mercadopago", () => {
  class MercadoPagoConfig {
    constructor(public opts: unknown) {}
  }
  class Preference {
    async create({ body }: { body: { external_reference: string } }) {
      return { id: `pref-${body.external_reference}`, init_point: `https://mp.test/checkout/${body.external_reference}` };
    }
  }
  class Payment {
    async get({ id }: { id: string }) {
      const d = mpPayments.get(String(id));
      if (!d) throw new Error(`payment ${id} desconocido`);
      return d;
    }
  }
  return { MercadoPagoConfig, Preference, Payment };
});
// El bucket in-memory por IP "unknown" cortaría los submits del turnero.
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: async () => ({ ok: true, remaining: 99, retryAfterMs: 0 }),
}));

import crypto, { randomUUID } from "node:crypto";
import type { BookingStatus, PrismaClient } from "@prisma/client";
import {
  createBooking,
  createBookingsBatch,
  deleteBooking,
  markReceptionAction,
  setBookingCopagoPaid,
  updateBooking,
} from "@/lib/bookings";
import { createPlan, previewPlan } from "@/lib/plans";
import { movePlanSeries, previewMovePlanSeries } from "@/lib/plans-move";
import { adoptBookingSeries, generatePlanBookings, previewGeneratePlanBookings, removeBookingFromPlan } from "@/lib/plans-adopt";
import { changePlanStatus } from "@/lib/plans-lifecycle";
import { completeSessionFromSeguimiento, rescheduleSession } from "@/lib/sessions";
import { createPlanFromDiagnosis } from "@/lib/diagnosis";
import { setPatientArchived } from "@/lib/patients";
import { submitPublicBooking } from "@/lib/public-booking";
import { applyDayLock, previewDayLock } from "@/lib/time-blocks";
import { POST as mpWebhookPOST } from "@/app/api/webhooks/mercadopago/route";
import type { BookingChangeRef } from "@/lib/booking-events-internal";
import type { PlanCreateInput, PlanPreview, PlanRowResolution } from "@/lib/plans-types";
import { localToARIso, toARDateKey, toARDow } from "@/lib/datetime-ar";
import { realtimeFake, revalidateTagSpy } from "@/tests/helpers/integration-setup";
import type { RealtimeFakeCall } from "@/tests/helpers/realtime-fake";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  addRoom,
  uniqueSuffix,
  sweepOrphanTestTenants,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { addPlanBooking, createPlan as createPlanFixture } from "@/tests/helpers/plan-factory";
import { asUser } from "@/tests/helpers/actor";
import { tags } from "@/lib/cache-tags";

const RUN = process.env.INTEGRATION === "1";

/** "2031-03-10", "10:00" → instante del reloj AR (sin depender del host). */
const ar = (day: string, hhmm: string) => new Date(localToARIso(`${day}T${hhmm}:00`));

/** Lunes 10:00 AR (C6: 0=Dom). */
const LUN_10 = { v: 1 as const, frequency: "weekly" as const, slots: [{ dow: 1 as const, startMin: 600 }] };
/** Forzar todo lo forzable: lo que se mide es la emisión, no los avisos del motor. */
const FORCE = { allowOverbooking: true, allowPatientOverlap: true, allowOutOfHours: true, allowBlocked: true, allowRoomConflict: true };

function acceptDefaults(p: PlanPreview): PlanRowResolution[] {
  return p.rows.map((r) => {
    switch (r.defaultResolution) {
      case "move":
        return { index: r.index, kind: "move", at: r.suggestion };
      case "adopt":
        return { index: r.index, kind: "adopt", bookingId: r.flags.duplicate!.bookingId, expectedUpdatedAt: r.flags.duplicate!.updatedAt };
      default:
        return { index: r.index, kind: r.defaultResolution };
    }
  });
}
const allNone = (p: PlanPreview): PlanRowResolution[] => p.rows.map((r) => ({ index: r.index, kind: "none" }));

/** Un día hábil (no domingo) entre 7 y 13 días adelante, en calendario AR (turnero). */
function futureWeekday(offset = 0): string {
  for (let d = 7 + offset; ; d++) {
    const key = toARDateKey(new Date(Date.now() + d * 86_400_000));
    if (toARDow(new Date(localToARIso(`${key}T12:00:00`))) !== 0) return key;
  }
}

/** Las llamadas de turnos (no las de disponibilidad del candado/bloqueos). */
const bookingCalls = () => realtimeFake.calls.filter((c): c is RealtimeFakeCall & { refs: BookingChangeRef[] } => !!c.refs);

/**
 * Forma canónica de un ref: `kind` ausente = "booking" (default del hook) y
 * `prev: null` = sin `prev`. `roomId` NO se normaliza: ausente significa «este
 * write-path no informa la sala», que es justamente un gap.
 */
function norm(r: BookingChangeRef): BookingChangeRef {
  const { prev, kind, ...rest } = r;
  return { ...rest, kind: kind ?? "booking", ...(prev ? { prev } : {}) };
}

/** Exactamente una llamada de turnos, del tenant: sus refs normalizados y ordenados por bookingId. */
function onlyCall(tenantId: string): BookingChangeRef[] {
  const calls = bookingCalls();
  expect(calls).toHaveLength(1);
  expect(calls[0].tenantId).toBe(tenantId);
  return calls[0].refs!.map(norm).sort((a, b) => a.bookingId.localeCompare(b.bookingId));
}

/**
 * Post-commit: al publicar, `check` lee con el OWNER (otra conexión). Lo que
 * tire se guarda y se afirma después (un throw dentro del publish lo tragaría
 * el hook, que nunca tira, y el test quedaría verde sin mirar nada).
 */
function assertOnPublish(check: (call: RealtimeFakeCall) => Promise<void>): { done: () => void } {
  const errors: unknown[] = [];
  let ran = 0;
  realtimeFake.onCall = async (call) => {
    if (!call.refs) return; // `availability` del candado: no es un turno
    ran++;
    try {
      await check(call);
    } catch (e) {
      errors.push(e);
    }
  };
  return {
    done: () => {
      expect(ran).toBeGreaterThan(0);
      if (errors.length) throw errors[0];
    },
  };
}

describe.skipIf(!RUN)("SV08 · emisión por write-path (realtime)", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let L1: string;
  let R1: string;
  let R2: string;
  let condSlug: string;
  /** La puerta de Diagnóstico exige al menos un ejercicio en el plan. */
  let exerciseId: string;

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    T = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "PRO" });
    ({ roomId: R1, locationId: L1 } = await addRoom(db, T, { name: "Consultorio 1", capacity: 3 }));
    R2 = (await addRoom(db, T, { locationId: L1, name: "Consultorio 2", capacity: 3 })).roomId;
    condSlug = `cond-sv08-${uniqueSuffix()}`;
    const cond = await db.condition.create({ data: { slug: condSlug, name: "Lumbalgia SV08", tenantId: T.tenantId } });
    exerciseId = (await db.exercise.create({ data: { slug: `ex-sv08-${uniqueSuffix()}`, name: "Activación SV08", tenantId: T.tenantId } })).id;
    await db.conditionExerciseLink.create({ data: { conditionId: cond.id, exerciseId, relation: "DIRECT", phase: "ACTIVATION" } });
  });

  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });

  beforeEach(() => {
    // El setup ya resetea `realtimeFake`; el actor vuelve al OWNER en cada caso.
    asUser(T.userId);
    revalidateTagSpy.mockClear();
  });

  /** Turno directo en la base (fixture, no pasa por el hook). */
  async function seed(o: {
    when: Date;
    roomId?: string | null;
    status?: BookingStatus;
    patientId?: string;
    practitionerId?: string;
    arrivedAt?: Date | null;
  }) {
    return db.booking.create({
      data: {
        tenantId: T.tenantId,
        practitionerId: o.practitionerId ?? T.practitionerId,
        serviceId: T.serviceId,
        patientId: o.patientId ?? (await addPatient(db, T)),
        scheduledFor: o.when,
        durationMin: 45,
        status: o.status ?? "CONFIRMED",
        idempotencyKey: randomUUID(),
        locationId: o.roomId ? L1 : null,
        roomId: o.roomId ?? null,
        arrivedAt: o.arrivedAt ?? null,
      },
    });
  }

  const planInput = (patientId: string, over: Partial<PlanCreateInput> = {}): PlanCreateInput => ({
    idempotencyKey: randomUUID(),
    patientId,
    discipline: "KINESIOLOGY",
    practitionerId: T.practitionerId,
    serviceId: T.serviceId,
    locationId: null,
    schedule: LUN_10,
    startDayKey: "2030-01-07",
    totalSessions: 3,
    pricing: null,
    rows: [],
    stateToken: "x",
    ...over,
  });

  /** Plan por el motor real (createPlan). Limpia el registro: el alta no es lo que se mide. */
  async function newPlan(patientId: string, over: Partial<PlanCreateInput> = {}, rowsOf = acceptDefaults) {
    const input = planInput(patientId, over);
    const p = await previewPlan(input);
    if (!p.ok) throw new Error(p.error);
    const r = await createPlan({ ...input, stateToken: p.preview.stateToken, rows: rowsOf(p.preview) });
    if (!r.ok) throw new Error(`createPlan: ${JSON.stringify(r)}`);
    const program = await db.treatmentProgram.findUniqueOrThrow({ where: { id: r.programId } });
    const sessions = await db.session.findMany({ where: { programId: r.programId }, orderBy: { index: "asc" } });
    realtimeFake.reset();
    return { programId: r.programId, sessions, updatedAt: program.updatedAt.toISOString() };
  }

  /** Ref esperado a partir de la fila que quedó en la base. */
  async function refOfRow(id: string, extra: Partial<BookingChangeRef> = {}): Promise<BookingChangeRef> {
    const b = await db.booking.findUniqueOrThrow({ where: { id } });
    return { bookingId: b.id, practitionerId: b.practitionerId, scheduledFor: b.scheduledFor, roomId: b.roomId, kind: "booking", ...extra };
  }

  // ── Turnos sueltos (lib/bookings.ts) ─────────────────────────────────────────

  it("createBooking: 1 publish post-commit con el ref exacto (sala incluida)", async () => {
    const patientId = await addPatient(db, T);
    const idempotencyKey = randomUUID();
    const probe = assertOnPublish(async (call) => {
      const row = await db.booking.findUnique({ where: { id: call.refs![0].bookingId } });
      expect(row).not.toBeNull();
    });
    const r = await createBooking({
      patientId,
      serviceId: T.serviceId,
      practitionerId: T.practitionerId,
      scheduledFor: ar("2031-03-03", "10:00").toISOString(),
      durationMin: 45,
      locationId: L1,
      roomId: R1,
      idempotencyKey,
      ...FORCE,
    });
    expect(r).toMatchObject({ ok: true });
    probe.done();
    const row = await db.booking.findUniqueOrThrow({ where: { idempotencyKey } });
    expect(row.roomId).toBe(R1);
    expect(onlyCall(T.tenantId)).toEqual([await refOfRow(row.id)]);
  });

  it("updateBooking moviendo hora y sala: 1 publish con `prev` (horario y sala de antes)", async () => {
    // El profesional no se cambia editando (BookingUpdate no lo trae, bookings-core.ts:1737):
    // `prev.practitionerId` es el mismo; se mueve hora y sala.
    const before = await seed({ when: ar("2031-03-04", "10:00"), roomId: R1 });
    const to = ar("2031-03-05", "11:30");
    const probe = assertOnPublish(async (call) => {
      const row = await db.booking.findUniqueOrThrow({ where: { id: call.refs![0].bookingId } });
      expect(row.scheduledFor.toISOString()).toBe(to.toISOString());
      expect(row.roomId).toBe(R2);
    });
    const r = await updateBooking({
      id: before.id,
      scheduledFor: to.toISOString(),
      locationId: L1,
      roomId: R2,
      expectedUpdatedAt: before.updatedAt.toISOString(),
      ...FORCE,
    });
    expect(r).toMatchObject({ ok: true });
    probe.done();
    expect(onlyCall(T.tenantId)).toEqual([
      await refOfRow(before.id, {
        prev: { practitionerId: before.practitionerId, scheduledFor: before.scheduledFor, roomId: R1 },
      }),
    ]);
  });

  it("createBookingsBatch de 20: UNA llamada con los 20 refs (no 20 publishes)", async () => {
    const patientId = await addPatient(db, T);
    const probe = assertOnPublish(async () => {
      expect(await db.booking.count({ where: { patientId } })).toBe(20);
    });
    const r = await createBookingsBatch({
      patientId,
      serviceId: T.serviceId,
      practitionerId: T.practitionerId,
      scheduledFor: ar("2031-04-07", "09:00").toISOString(),
      durationMin: 45,
      count: 20,
      daysOfWeek: [0, 2, 4],
      idempotencyKey: randomUUID(),
      allowOverbooking: true,
      allowRoomConflict: true,
    });
    expect(r).toMatchObject({ ok: true, data: { created: 20 } });
    probe.done();
    const refs = onlyCall(T.tenantId);
    expect(refs).toHaveLength(20);
    const rows = await db.booking.findMany({ where: { patientId }, orderBy: { id: "asc" } });
    expect(refs).toEqual(await Promise.all(rows.map((b) => refOfRow(b.id))));
  });

  it("deleteBooking: 1 publish post-commit (la fila ya no está) con el ref del turno borrado", async () => {
    const b = await seed({ when: ar("2031-03-06", "10:00"), roomId: R1 });
    const probe = assertOnPublish(async (call) => {
      expect(await db.booking.findUnique({ where: { id: call.refs![0].bookingId } })).toBeNull();
    });
    const r = await deleteBooking(b.id, b.updatedAt.toISOString());
    expect(r).toEqual({ ok: true, data: undefined });
    probe.done();
    expect(onlyCall(T.tenantId)).toEqual([
      { bookingId: b.id, practitionerId: b.practitionerId, scheduledFor: b.scheduledFor, roomId: R1, kind: "booking" },
    ]);
  });

  it("toggle de cobro (setBookingCopagoPaid → toggleBilling): 1 publish post-commit", async () => {
    const b = await seed({ when: ar("2031-03-07", "10:00"), roomId: R1 });
    const probe = assertOnPublish(async (call) => {
      expect((await db.booking.findUniqueOrThrow({ where: { id: call.refs![0].bookingId } })).paymentStatus).toBe("PAID");
    });
    const r = await setBookingCopagoPaid(b.id, true, b.updatedAt.toISOString());
    expect(r).toMatchObject({ ok: true });
    probe.done();
    expect(onlyCall(T.tenantId)).toEqual([await refOfRow(b.id)]);
  });

  it("Recepción «llegó»: 1 publish `kind:reception` aunque NO invalide caches; «atendido»: 1 más", async () => {
    const b = await seed({ when: new Date(), roomId: R1 });
    const probe = assertOnPublish(async (call) => {
      expect((await db.booking.findUniqueOrThrow({ where: { id: call.refs![0].bookingId } })).arrivedAt).not.toBeNull();
    });
    const llego = await markReceptionAction(b.id, "llego", b.updatedAt.toISOString());
    expect(llego).toMatchObject({ ok: true, data: { state: "en-sala" } });
    probe.done();
    expect(onlyCall(T.tenantId)).toEqual([await refOfRow(b.id, { kind: "reception" })]);
    // «llegó» no cambia nada cacheado (puntos de la agenda, KPIs): no invalida.
    expect(revalidateTagSpy).not.toHaveBeenCalledWith(tags.bookingDays(T.tenantId));

    realtimeFake.reset();
    const probe2 = assertOnPublish(async (call) => {
      expect((await db.booking.findUniqueOrThrow({ where: { id: call.refs![0].bookingId } })).status).toBe("COMPLETED");
    });
    const atendido = await markReceptionAction(b.id, "atendido", llego.ok ? llego.data.updatedAt : "");
    expect(atendido).toMatchObject({ ok: true, data: { status: "COMPLETED" } });
    probe2.done();
    expect(onlyCall(T.tenantId)).toEqual([await refOfRow(b.id, { kind: "reception" })]);
    // El estado sí cuenta en los caches derivados.
    expect(revalidateTagSpy).toHaveBeenCalledWith(tags.bookingDays(T.tenantId));
  });

  it("realtimeFake.fail = true: la action sigue ok, la fila quedó y el publish se intentó una vez", async () => {
    realtimeFake.fail = true;
    const patientId = await addPatient(db, T);
    const idempotencyKey = randomUUID();
    const r = await createBooking({
      patientId,
      serviceId: T.serviceId,
      practitionerId: T.practitionerId,
      scheduledFor: ar("2031-03-10", "10:00").toISOString(),
      durationMin: 45,
      idempotencyKey,
      ...FORCE,
    });
    expect(r).toMatchObject({ ok: true });
    expect(await db.booking.findUnique({ where: { idempotencyKey } })).not.toBeNull();
    expect(bookingCalls()).toHaveLength(1);
  });

  // ── Planes ────────────────────────────────────────────────────────────────────

  it("createPlan (alta + generar turnos en una tx): 1 publish con un ref por turno creado", async () => {
    const patientId = await addPatient(db, T);
    const input = planInput(patientId, { startDayKey: "2030-02-04", totalSessions: 4 });
    const p = await previewPlan(input);
    if (!p.ok) throw new Error(p.error);
    const probe = assertOnPublish(async () => {
      expect(await db.booking.count({ where: { patientId } })).toBe(4);
    });
    const r = await createPlan({ ...input, stateToken: p.preview.stateToken, rows: acceptDefaults(p.preview) });
    expect(r).toMatchObject({ ok: true, idempotent: false });
    probe.done();
    const rows = await db.booking.findMany({ where: { patientId }, orderBy: { id: "asc" } });
    expect(rows).toHaveLength(4);
    expect(onlyCall(T.tenantId)).toEqual(await Promise.all(rows.map((b) => refOfRow(b.id))));

    // Reenvío idempotente (misma key): no hay turno nuevo, no hay publish.
    realtimeFake.reset();
    const again = await createPlan({ ...input, stateToken: p.preview.stateToken, rows: acceptDefaults(p.preview) });
    expect(again).toMatchObject({ ok: true, idempotent: true });
    expect(bookingCalls()).toHaveLength(0);
  });

  it("generatePlanBookings (sesiones pendientes): 1 publish con los turnos generados", async () => {
    const patientId = await addPatient(db, T);
    const plan = await newPlan(patientId, { startDayKey: "2030-03-04" }, allNone);
    expect(await db.booking.count({ where: { programId: plan.programId } })).toBe(0);
    const pre = await previewGeneratePlanBookings({ programId: plan.programId });
    if (!pre.ok) throw new Error(pre.error);
    const probe = assertOnPublish(async () => {
      expect(await db.booking.count({ where: { programId: plan.programId } })).toBe(3);
    });
    const r = await generatePlanBookings({ programId: plan.programId, rows: acceptDefaults(pre.preview), stateToken: pre.preview.stateToken });
    expect(r).toMatchObject({ ok: true, data: { createdBookings: 3 } });
    probe.done();
    const rows = await db.booking.findMany({ where: { programId: plan.programId }, orderBy: { id: "asc" } });
    expect(onlyCall(T.tenantId)).toEqual(await Promise.all(rows.map((b) => refOfRow(b.id))));
  });

  it("movePlanSeries (mover un turno de plan y los siguientes): 1 publish con `prev` por turno movido", async () => {
    const patientId = await addPatient(db, T);
    const plan = await newPlan(patientId, { startDayKey: "2030-04-01" });
    const before = await db.booking.findMany({ where: { programId: plan.programId }, orderBy: { scheduledFor: "asc" } });
    const at = "2030-04-08T14:00:00.000Z"; // sesión 2: lunes 11:00 AR (era 10:00)
    const pre = await previewMovePlanSeries({ programId: plan.programId, fromSessionId: plan.sessions[1].id, at });
    if (!pre.ok) throw new Error(pre.error);
    const probe = assertOnPublish(async (call) => {
      for (const ref of call.refs!) {
        expect(+(await db.booking.findUniqueOrThrow({ where: { id: ref.bookingId } })).scheduledFor).toBe(+ref.scheduledFor);
      }
    });
    const r = await movePlanSeries({
      programId: plan.programId,
      fromSessionId: plan.sessions[1].id,
      at,
      rows: acceptDefaults(pre.preview),
      stateToken: pre.preview.stateToken,
    });
    expect(r).toMatchObject({ ok: true, data: { movedBookings: 2 } });
    probe.done();
    const moved = before.slice(1);
    const refs = onlyCall(T.tenantId);
    expect(refs.map((x) => x.bookingId)).toEqual(moved.map((b) => b.id).sort());
    for (const ref of refs) {
      const old = moved.find((b) => b.id === ref.bookingId)!;
      expect(ref).toMatchObject({ practitionerId: old.practitionerId, kind: "booking" });
      expect(ref.prev).toMatchObject({ practitionerId: old.practitionerId, scheduledFor: old.scheduledFor });
      expect(+ref.scheduledFor).toBe(+old.scheduledFor + 60 * 60_000);
    }
  });

  it("updateBooking de un turno de plan (mover uno solo desde la agenda): 1 publish con `prev`", async () => {
    const patientId = await addPatient(db, T);
    const plan = await newPlan(patientId, { startDayKey: "2030-05-06", totalSessions: 2 });
    const b = await db.booking.findFirstOrThrow({ where: { programId: plan.programId }, orderBy: { scheduledFor: "asc" } });
    const to = new Date(+b.scheduledFor + 2 * 60 * 60_000);
    const r = await updateBooking({ id: b.id, scheduledFor: to.toISOString(), expectedUpdatedAt: b.updatedAt.toISOString(), ...FORCE });
    expect(r).toMatchObject({ ok: true });
    expect(onlyCall(T.tenantId)).toEqual([
      await refOfRow(b.id, { prev: { practitionerId: b.practitionerId, scheduledFor: b.scheduledFor, roomId: b.roomId } }),
    ]);
  });

  /** Plan vinculado coherente (fixture): turnos futuros en el instante de su sesión, con sala. */
  async function linkedPlan(o: { sessions: number; bookings: number; base: string }) {
    const p = await createPlanFixture(db, T, { sessions: o.sessions });
    const bookingIds: string[] = [];
    for (const [i, sessionId] of p.sessionIds.slice(0, o.bookings).entries()) {
      const at = new Date(Date.parse(o.base) + i * 86_400_000);
      await db.session.update({ where: { id: sessionId }, data: { scheduledFor: at } });
      const id = await addPlanBooking(db, T, { programId: p.programId, sessionId, patientId: p.patientId, scheduledFor: at });
      await db.booking.update({ where: { id }, data: { locationId: L1, roomId: R1 } });
      bookingIds.push(id);
    }
    const prog = await db.treatmentProgram.findUniqueOrThrow({ where: { id: p.programId } });
    return { ...p, bookingIds, updatedAt: prog.updatedAt.toISOString() };
  }

  it("cancelar un plan con turnos: 1 publish con los turnos cancelados (post-commit)", async () => {
    const p = await linkedPlan({ sessions: 3, bookings: 2, base: "2031-05-05T13:00:00.000Z" });
    const probe = assertOnPublish(async (call) => {
      for (const ref of call.refs!) {
        expect((await db.booking.findUniqueOrThrow({ where: { id: ref.bookingId } })).status).toBe("CANCELLED");
      }
    });
    const r = await changePlanStatus({ programId: p.programId, expectedUpdatedAt: p.updatedAt, to: "CANCELLED" });
    expect(r).toMatchObject({ ok: true, data: { status: "CANCELLED", bookings: { cancelled: 2 } } });
    probe.done();
    const refs = onlyCall(T.tenantId);
    expect(refs.map((x) => x.bookingId)).toEqual([...p.bookingIds].sort());
    for (const ref of refs) {
      const row = await db.booking.findUniqueOrThrow({ where: { id: ref.bookingId } });
      expect(ref).toMatchObject({ practitionerId: row.practitionerId, scheduledFor: row.scheduledFor });
    }
  });

  // Era GAP (dado vuelta por FX1a): `applyFutureBookingsInTx` armaba los refs sin `roomId`
  // aunque `cancelBookingsInTx` ya la devolvía: la vista «Por sala» no sabía qué sala se liberó.
  it("[SV08-gap] cancelar un plan informa la sala de cada turno cancelado (roomId en el ref)", async () => {
    const p = await linkedPlan({ sessions: 1, bookings: 1, base: "2031-05-12T13:00:00.000Z" });
    const r = await changePlanStatus({ programId: p.programId, expectedUpdatedAt: p.updatedAt, to: "CANCELLED" });
    expect(r).toMatchObject({ ok: true });
    expect(onlyCall(T.tenantId)).toEqual([await refOfRow(p.bookingIds[0])]);
  });

  it("estado de plan sin turnos que cambien (pausar con «mantener», cancelar sin turnos): 0 publish", async () => {
    const keep = await linkedPlan({ sessions: 2, bookings: 1, base: "2031-05-19T13:00:00.000Z" });
    const r1 = await changePlanStatus({ programId: keep.programId, expectedUpdatedAt: keep.updatedAt, to: "PAUSED", futureBookings: "keep" });
    expect(r1).toMatchObject({ ok: true, data: { status: "PAUSED", bookings: { cancelled: 0 } } });
    const empty = await linkedPlan({ sessions: 2, bookings: 0, base: "2031-05-26T13:00:00.000Z" });
    const r2 = await changePlanStatus({ programId: empty.programId, expectedUpdatedAt: empty.updatedAt, to: "CANCELLED" });
    expect(r2).toMatchObject({ ok: true, data: { status: "CANCELLED" } });
    expect(realtimeFake.calls).toHaveLength(0);
  });

  it("adoptar una serie de turnos sueltos: 1 publish con los turnos adoptados", async () => {
    const patientId = await addPatient(db, T);
    const plan = await newPlan(patientId, { startDayKey: "2030-06-03" }, allNone);
    const loose = [];
    for (const at of ["2030-06-05T14:00:00.000Z", "2030-06-12T14:00:00.000Z"]) {
      loose.push(await seed({ when: new Date(at), patientId }));
    }
    const probe = assertOnPublish(async (call) => {
      for (const ref of call.refs!) {
        expect((await db.booking.findUniqueOrThrow({ where: { id: ref.bookingId } })).programId).toBe(plan.programId);
      }
    });
    const r = await adoptBookingSeries({
      programId: plan.programId,
      expectedUpdatedAt: plan.updatedAt,
      bookings: loose.map((b) => ({ bookingId: b.id, expectedUpdatedAt: b.updatedAt.toISOString() })),
    });
    expect(r).toMatchObject({ ok: true });
    probe.done();
    const refs = onlyCall(T.tenantId);
    expect(refs.map((x) => x.bookingId)).toEqual(loose.map((b) => b.id).sort());
    for (const ref of refs) {
      const row = await db.booking.findUniqueOrThrow({ where: { id: ref.bookingId } });
      expect(ref).toMatchObject({ practitionerId: row.practitionerId, scheduledFor: row.scheduledFor, kind: "booking" });
    }
  });

  // Era GAP (dado vuelta por FX1a): el motor armaba el ref de un turno adoptado con
  // `practitionerId: program.practitionerId` y sin `roomId`. Un turno suelto de OTRO profesional
  // que se adopta avisaba a la agenda equivocada (y un plan sin responsable mandaba `null`).
  it("[SV08-gap] adoptar el turno de otro profesional: el ref lleva el profesional y la sala DEL TURNO", async () => {
    const other = await addPractitioner(db, T, "PRACTITIONER");
    const patientId = await addPatient(db, T);
    const plan = await newPlan(patientId, { startDayKey: "2030-07-01", totalSessions: 1 }, allNone);
    const b = await seed({ when: new Date("2030-07-03T14:00:00.000Z"), patientId, practitionerId: other.practitionerId, roomId: R2 });
    const r = await adoptBookingSeries({
      programId: plan.programId,
      expectedUpdatedAt: plan.updatedAt,
      bookings: [{ bookingId: b.id, expectedUpdatedAt: b.updatedAt.toISOString() }],
    });
    expect(r).toMatchObject({ ok: true });
    expect(onlyCall(T.tenantId)).toEqual([await refOfRow(b.id)]);
  });

  // FX1a (GAP3): sacar un turno del plan no lo mueve; el ref lleva la sala para que la vista
  // «Por sala» repinte el chip de plan.
  it("sacar un turno del plan (removeBookingFromPlan): 1 publish post-commit con el ref exacto (sala incluida)", async () => {
    const p = await linkedPlan({ sessions: 1, bookings: 1, base: "2031-06-23T13:00:00.000Z" });
    const b = await db.booking.findUniqueOrThrow({ where: { id: p.bookingIds[0] } });
    const probe = assertOnPublish(async (call) => {
      expect((await db.booking.findUniqueOrThrow({ where: { id: call.refs![0].bookingId } })).programId).toBeNull();
    });
    const r = await removeBookingFromPlan({ bookingId: b.id, expectedUpdatedAt: b.updatedAt.toISOString() });
    expect(r).toMatchObject({ ok: true });
    probe.done();
    expect(onlyCall(T.tenantId)).toEqual([await refOfRow(b.id)]);
    expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).roomId).toBe(R1);
  });

  // FX1a (GAP3): cerrar la sesión desde Seguimiento completa el turno vinculado.
  it("Seguimiento · completar una sesión con turno: 1 publish post-commit con el ref exacto (sala incluida)", async () => {
    const p = await linkedPlan({ sessions: 2, bookings: 1, base: "2031-06-30T13:00:00.000Z" });
    const probe = assertOnPublish(async (call) => {
      expect((await db.booking.findUniqueOrThrow({ where: { id: call.refs![0].bookingId } })).status).toBe("COMPLETED");
    });
    const r = await completeSessionFromSeguimiento(p.sessionIds[0]);
    expect(r).toMatchObject({ ok: true });
    probe.done();
    expect(onlyCall(T.tenantId)).toEqual([await refOfRow(p.bookingIds[0])]);
    expect((await db.booking.findUniqueOrThrow({ where: { id: p.bookingIds[0] } })).roomId).toBe(R1);
  });

  it("Seguimiento · reprogramar una sesión con turno: 1 publish con `prev`", async () => {
    const p = await linkedPlan({ sessions: 1, bookings: 1, base: "2031-06-02T13:00:00.000Z" });
    const before = await db.booking.findUniqueOrThrow({ where: { id: p.bookingIds[0] } });
    const to = new Date(+before.scheduledFor + 26 * 60 * 60_000);
    const probe = assertOnPublish(async (call) => {
      expect(+(await db.booking.findUniqueOrThrow({ where: { id: call.refs![0].bookingId } })).scheduledFor).toBe(+to);
    });
    const r = await rescheduleSession({ sessionId: p.sessionIds[0], scheduledFor: to.toISOString(), force: FORCE });
    expect(r).toMatchObject({ ok: true });
    probe.done();
    expect(onlyCall(T.tenantId)).toEqual([
      await refOfRow(before.id, { prev: { practitionerId: before.practitionerId, scheduledFor: before.scheduledFor, roomId: R1 } }),
    ]);
  });

  it("puerta de Diagnóstico (createPlanFromDiagnosis): 1 publish con los turnos del plan", async () => {
    const patientId = await addPatient(db, T);
    const plan = planInput(patientId, { startDayKey: "2030-08-05", totalSessions: 2, exercises: [{ exerciseId, sets: 3, reps: 10 }] });
    const p = await previewPlan(plan);
    if (!p.ok) throw new Error(p.error);
    const probe = assertOnPublish(async () => {
      expect(await db.booking.count({ where: { patientId } })).toBe(2);
    });
    const r = await createPlanFromDiagnosis({
      plan: { ...plan, stateToken: p.preview.stateToken, rows: acceptDefaults(p.preview) },
      diagnosis: { conditionSlug: condSlug, selection: { regions: [], symptoms: [], triggers: [], phase: null, intensity: 5 } },
    });
    expect(r).toMatchObject({ ok: true, idempotent: false });
    probe.done();
    const rows = await db.booking.findMany({ where: { patientId }, orderBy: { id: "asc" } });
    expect(onlyCall(T.tenantId)).toEqual(await Promise.all(rows.map((b) => refOfRow(b.id))));
  });

  it("archivar un paciente con turnos futuros de plan («cancelar»): 1 publish con los cancelados", async () => {
    const p = await linkedPlan({ sessions: 2, bookings: 2, base: "2031-06-09T13:00:00.000Z" });
    const probe = assertOnPublish(async () => {
      expect((await db.patient.findUniqueOrThrow({ where: { id: p.patientId } })).archivedAt).not.toBeNull();
    });
    const r = await setPatientArchived({ id: p.patientId, archived: true, plansAction: "cancel" });
    expect(r).toEqual({ ok: true, data: undefined });
    probe.done();
    // FX1a: refs exactos, sala incluida (mismo `applyFutureBookingsInTx` que cancelar un plan).
    expect(onlyCall(T.tenantId)).toEqual(await Promise.all([...p.bookingIds].sort().map((id) => refOfRow(id))));
    for (const id of p.bookingIds) expect((await db.booking.findUniqueOrThrow({ where: { id } })).status).toBe("CANCELLED");
  });

  it("archivar un paciente con turnos futuros (default «pausar»): ningún turno cambia → 0 publish", async () => {
    const p = await linkedPlan({ sessions: 1, bookings: 1, base: "2031-06-16T13:00:00.000Z" });
    const r = await setPatientArchived({ id: p.patientId, archived: true });
    expect(r).toEqual({ ok: true, data: undefined });
    expect((await db.booking.findUniqueOrThrow({ where: { id: p.bookingIds[0] } })).status).toBe("CONFIRMED");
    expect(realtimeFake.calls).toHaveLength(0);
  });

  // ── Post-integración de SV1.2 (SV05, SV06a, SV06b) ──
  describe("[post-integración SV1.2]", () => {
    it("SV05 · Recepción «llamar»: 1 publish `kind:called` con la sala, post-commit", async () => {
      const b = await seed({ when: new Date(), roomId: R2 });
      const llego = await markReceptionAction(b.id, "llego", b.updatedAt.toISOString());
      if (!llego.ok) throw new Error(llego.error);
      realtimeFake.reset();
      const probe = assertOnPublish(async (call) => {
        const row = await db.booking.findUniqueOrThrow({ where: { id: call.refs![0].bookingId } });
        expect((row as unknown as { calledAt: Date | null }).calledAt).not.toBeNull();
      });
      const r = await markReceptionAction(b.id, "llamar", llego.data.updatedAt);
      expect(r).toMatchObject({ ok: true, data: { state: "llamado" } });
      probe.done();
      expect(onlyCall(T.tenantId)).toEqual([await refOfRow(b.id, { kind: "called" })]);
    });

    it("SV06a · turnero (submitPublicBooking): 1 publish post-commit con el turno nuevo", async () => {
      const day = futureWeekday();
      const probe = assertOnPublish(async (call) => {
        expect(await db.booking.findUnique({ where: { id: call.refs![0].bookingId } })).not.toBeNull();
      });
      const r = await submitPublicBooking({
        tenantSlug: T.slug,
        idempotencyKey: randomUUID(),
        practitionerId: T.practitionerId,
        serviceId: T.serviceId,
        scheduledFor: ar(day, "08:00").toISOString(),
        patient: {
          firstName: "Ana",
          lastName: "Turnero",
          documentId: `DNI-${uniqueSuffix()}`,
          email: `ana-${randomUUID().slice(0, 8)}@test.local`,
          phone: `11${Math.floor(Math.random() * 1e8).toString().padStart(8, "0")}`,
          dateOfBirth: "1990-05-10",
        },
      });
      expect(r).toMatchObject({ ok: true });
      if (!r.ok) return;
      probe.done();
      expect(onlyCall(T.tenantId)).toEqual([await refOfRow(r.data.bookingId)]);
    });

    it("SV06a · webhook de MP aprobado: 1 publish post-commit con el turno pagado", async () => {
      const b = await seed({ when: ar("2031-07-07", "10:00"), status: "PENDING", roomId: R1 });
      await db.payment.create({
        data: { bookingId: b.id, provider: "mercadopago", status: "UNPAID", expectedAmountCents: 5000, amountCents: 0 },
      });
      const payId = `sv08-${uniqueSuffix()}`;
      mpPayments.set(payId, {
        id: payId,
        status: "approved",
        status_detail: "accredited",
        transaction_amount: 50,
        currency_id: "ARS",
        external_reference: b.id,
      });
      const requestId = randomUUID();
      const ts = String(Math.floor(Date.now() / 1000));
      const v1 = crypto
        .createHmac("sha256", process.env.MP_WEBHOOK_SECRET!)
        .update(`id:${payId};request-id:${requestId};ts:${ts};`)
        .digest("hex");
      const probe = assertOnPublish(async (call) => {
        expect((await db.booking.findUniqueOrThrow({ where: { id: call.refs![0].bookingId } })).paymentStatus).toBe("PAID");
      });
      const res = await mpWebhookPOST(
        new Request(`http://localhost/api/webhooks/mercadopago?data.id=${payId}&type=payment`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-signature": `ts=${ts},v1=${v1}`, "x-request-id": requestId },
          body: JSON.stringify({ type: "payment", data: { id: payId } }),
        })
      );
      expect(res.status).toBe(200);
      probe.done();
      expect(onlyCall(T.tenantId)).toEqual([await refOfRow(b.id)]);
    });

    it("SV06b · candado del día con «cancelar»: 1 publish de turnos con los cancelados (con sala)", async () => {
      const DAY = "2031-08-12";
      const b1 = await seed({ when: ar(DAY, "09:00"), roomId: R1 });
      const b2 = await seed({ when: ar(DAY, "11:00"), roomId: R2 });
      const pre = await previewDayLock({ dayKey: DAY, practitionerIds: null, allDay: true });
      if (!pre.ok) throw new Error(pre.error);
      const probe = assertOnPublish(async (call) => {
        for (const ref of call.refs!) {
          expect((await db.booking.findUniqueOrThrow({ where: { id: ref.bookingId } })).status).toBe("CANCELLED");
        }
      });
      const r = await applyDayLock({
        dayKey: DAY,
        practitionerIds: null,
        allDay: true,
        reason: "SV08",
        bookingsDecision: "cancel",
        expectedAffectedIds: pre.data.affected.map((a) => a.id),
      });
      expect(r).toMatchObject({ ok: true });
      probe.done();
      expect(onlyCall(T.tenantId)).toEqual(
        (await Promise.all([b1.id, b2.id].map((id) => refOfRow(id)))).sort((a, b) => a.bookingId.localeCompare(b.bookingId))
      );
    });
  });
});
