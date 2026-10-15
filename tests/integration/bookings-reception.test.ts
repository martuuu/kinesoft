/**
 * B4.1 AV-bookings-2 — recepción, proyección liviana de la agenda y
 * cancelación en lote (para el candado de B4.4), contra Postgres real.
 *
 * Corre las actions REALES de lib/bookings.ts con `getActor()` real (solo se
 * mockea la sesión de Supabase, tests/helpers/integration-setup.ts), en los
 * dos modos: `kinesoft_app` (RLS) y owner BYPASSRLS (= prod hoy). Afirma el
 * efecto observable: la fila quedó así, el audit salió, la otra no cambió.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { BookingStatus, PrismaClient } from "@prisma/client";
import { markReceptionAction, listAgendaBookings, listBookingsInRange, updateBooking } from "@/lib/bookings";
import { cancelBookingsInTx } from "@/lib/bookings-cancel-internal";
import { runWithRls } from "@/lib/rls";
import { localToARIso } from "@/lib/datetime-ar";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  addService,
  addInsurer,
  addRoom,
  sweepOrphanTestTenants,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
// El mismo registro que instala integration-setup como mock del publisher.
import { realtimeFake } from "@/tests/helpers/realtime-fake";
import { toBookingDTO } from "@/components/agenda/agenda-utils";

const RUN = process.env.INTEGRATION === "1";
const ar = (day: string, hhmm: string) => new Date(localToARIso(`${day}T${hhmm}:00`));

describe.skipIf(!RUN)("B4.1 · recepción, proyección liviana y cancelación en lote", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let assistant: { userId: string; practitionerId: string };
  let billing: { userId: string; practitionerId: string };
  let kine: { userId: string; practitionerId: string };

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    // PL-2f (C-PL1): salas y Sala de Espera son de Clínica / Libre; sin el plan, el motor ignora las salas.
    A = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    B = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    assistant = await addPractitioner(db, A, "ASSISTANT");
    billing = await addPractitioner(db, A, "BILLING");
    kine = await addPractitioner(db, A, "PRACTITIONER");
  });

  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await db?.$disconnect();
  });

  /** Turno directo en la base (fixture), por defecto HOY ahora y CONFIRMED. */
  async function seed(
    t: EphemeralTenant,
    o: {
      patientId?: string | null;
      when?: Date;
      status?: BookingStatus;
      practitionerId?: string;
      serviceId?: string;
      locationId?: string | null;
      notes?: string | null;
      title?: string | null;
      description?: string | null;
      arrivedAt?: Date | null;
      calledAt?: Date | null;
      roomId?: string | null;
      paymentStatus?: "UNPAID" | "PAID" | "FAILED";
      insurerPaidAt?: Date | null;
      idempotencyKey?: string;
    } = {}
  ) {
    return db.booking.create({
      data: {
        tenantId: t.tenantId,
        practitionerId: o.practitionerId ?? t.practitionerId,
        serviceId: o.serviceId ?? t.serviceId,
        patientId: o.patientId === undefined ? await addPatient(db, t) : o.patientId,
        guestName: o.patientId === null ? "Reserva externa" : null,
        scheduledFor: o.when ?? new Date(),
        durationMin: 45,
        status: o.status ?? "CONFIRMED",
        idempotencyKey: o.idempotencyKey ?? randomUUID(),
        locationId: o.locationId ?? null,
        notes: o.notes ?? null,
        title: o.title ?? null,
        description: o.description ?? null,
        arrivedAt: o.arrivedAt ?? null,
        calledAt: o.calledAt ?? null,
        roomId: o.roomId ?? null,
        paymentStatus: o.paymentStatus ?? "UNPAID",
        insurerPaidAt: o.insurerPaidAt ?? null,
      },
    });
  }

  // ── Recepción ──────────────────────────────────────────────────────────
  describe("markReceptionAction", () => {
    it("flujo completo: llegó → en atención → atendido → deshacer; cada paso devuelve el updatedAt nuevo (sin audit, PL-A)", async () => {
      asUser(A.userId);
      const b = await seed(A);
      const r1 = await markReceptionAction(b.id, "llego", b.updatedAt.toISOString());
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      expect(r1.data.state).toBe("en-sala");
      let row = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
      expect(row.arrivedAt).not.toBeNull();
      expect(row.updatedAt.toISOString()).toBe(r1.data.updatedAt);
      expect(r1.data.arrivedAt).toBe(row.arrivedAt!.toISOString());

      const r2 = await markReceptionAction(b.id, "en-atencion", r1.data.updatedAt);
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      row = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
      expect(row.attendingAt).not.toBeNull();
      expect(r2.data.state).toBe("en-atencion");

      const r3 = await markReceptionAction(b.id, "atendido", r2.data.updatedAt);
      expect(r3.ok).toBe(true);
      if (!r3.ok) return;
      row = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
      expect(row.status).toBe("COMPLETED");
      expect(r3.data.status).toBe("COMPLETED");

      const r4 = await markReceptionAction(b.id, "deshacer", r3.data.updatedAt);
      expect(r4.ok).toBe(true);
      row = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
      // Deshacer "atendido" vuelve a CONFIRMED conservando los timestamps.
      expect(row.status).toBe("CONFIRMED");
      expect(row.arrivedAt).not.toBeNull();
      expect(row.attendingAt).not.toBeNull();

      // PL-A (plan §20.5.9): la recepción (check-in) es ruido operativo y ya no se audita.
      expect(await db.auditEvent.count({ where: { tenantId: A.tenantId, entityId: b.id } })).toBe(0);
    });

    it("ausente → NO_SHOW; deshacer → CONFIRMED", async () => {
      asUser(A.userId);
      const b = await seed(A);
      const r = await markReceptionAction(b.id, "ausente", b.updatedAt.toISOString());
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("NO_SHOW");
      const u = await markReceptionAction(b.id, "deshacer", r.data.updatedAt);
      expect(u.ok).toBe(true);
      expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("CONFIRMED");
    });

    it("expectedUpdatedAt viejo → error de concurrencia, la fila no cambia", async () => {
      asUser(A.userId);
      const b = await seed(A);
      const r = await markReceptionAction(b.id, "llego", new Date(b.updatedAt.getTime() - 1000).toISOString());
      expect(r.ok).toBe(false);
      expect(r.ok ? "" : r.error).toMatch(/cambió en otra sesión/);
      const row = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
      expect(row.arrivedAt).toBeNull();
      expect(+row.updatedAt).toBe(+b.updatedAt);
    });

    it("dos clicks concurrentes con la misma versión → uno ok y el otro stale (lock optimista atómico)", async () => {
      asUser(A.userId);
      const b = await seed(A);
      const v = b.updatedAt.toISOString();
      const [x, y] = await Promise.all([markReceptionAction(b.id, "llego", v), markReceptionAction(b.id, "ausente", v)]);
      expect([x.ok, y.ok].filter(Boolean)).toHaveLength(1);
      const row = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
      // Quedó exactamente UNA de las dos transiciones, no una mezcla.
      const llego = row.arrivedAt != null && row.status === "CONFIRMED";
      const ausente = row.arrivedAt == null && row.status === "NO_SHOW";
      expect(llego !== ausente).toBe(true);
    });

    it("transición inválida (en atención sin llegada) y turno de otro día → error, sin escribir", async () => {
      asUser(A.userId);
      const b = await seed(A);
      const r = await markReceptionAction(b.id, "en-atencion", b.updatedAt.toISOString());
      expect(r.ok).toBe(false);
      expect(r.ok ? "" : r.error).toMatch(/No se puede marcar «En atención»/);

      const tomorrow = await seed(A, { when: new Date(Date.now() + 26 * 3600_000) });
      const t = await markReceptionAction(tomorrow.id, "llego", tomorrow.updatedAt.toISOString());
      expect(t.ok).toBe(false);
      expect(t.ok ? "" : t.error).toMatch(/turnos de hoy/);

      const cancelled = await seed(A, { status: "CANCELLED" });
      const c = await markReceptionAction(cancelled.id, "llego", cancelled.updatedAt.toISOString());
      expect(c.ok).toBe(false);

      for (const id of [b.id, tomorrow.id, cancelled.id]) {
        const row = await db.booking.findUniqueOrThrow({ where: { id } });
        expect(row.arrivedAt).toBeNull();
        expect(row.attendingAt).toBeNull();
      }
    });

    it("acción fuera del enum o fecha inválida → Datos inválidos", async () => {
      asUser(A.userId);
      const b = await seed(A);
      // @ts-expect-error — action inválida a propósito (input del cliente)
      const r = await markReceptionAction(b.id, "borrar", b.updatedAt.toISOString());
      expect(r.ok).toBe(false);
      const r2 = await markReceptionAction(b.id, "llego", "ayer");
      expect(r2.ok).toBe(false);
      expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).arrivedAt).toBeNull();
    });

    it("ASSISTANT (Secretaria) con acceso BÁSICO al paciente: la recepción es administrativa → puede", async () => {
      // El paciente es del OWNER; el ASSISTANT no es dueño ni tiene share → basic.
      asUser(assistant.userId);
      const b = await seed(A);
      const r = await markReceptionAction(b.id, "llego", b.updatedAt.toISOString());
      expect(r.ok).toBe(true);
      expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).arrivedAt).not.toBeNull();
    });

    it("[revisión B-pre] PRACTITIONER: sus turnos sí (aunque el paciente sea básico), guest ajeno sí, turno ajeno de paciente básico NO", async () => {
      asUser(kine.userId);
      // Turno PROPIO con paciente del OWNER (acceso básico): es su agenda → puede.
      const own = await seed(A, { practitionerId: kine.practitionerId });
      expect((await markReceptionAction(own.id, "llego", own.updatedAt.toISOString())).ok).toBe(true);
      // Guest de un colega: sin paciente no hay nada clínico que proteger → puede.
      const g = await seed(A, { patientId: null });
      expect((await markReceptionAction(g.id, "llego", g.updatedAt.toISOString())).ok).toBe(true);
      // Turno de un colega con paciente que solo ve en básico → rechazo sin escribir.
      const foreign = await seed(A);
      const r = await markReceptionAction(foreign.id, "ausente", foreign.updatedAt.toISOString());
      expect(r.ok).toBe(false);
      expect(r.ok ? "" : r.error).toMatch(/tus turnos/);
      const row = await db.booking.findUniqueOrThrow({ where: { id: foreign.id } });
      expect(row.status).toBe("CONFIRMED");
      expect(+row.updatedAt).toBe(+foreign.updatedAt);
      expect(await db.auditEvent.count({ where: { entityId: foreign.id } })).toBe(0);
    });

    it("[revisión B-pre] PRACTITIONER con acceso FULL al paciente de un colega (share) → puede", async () => {
      const pat = await addPatient(db, A);
      await db.patientShare.create({
        data: { tenantId: A.tenantId, patientId: pat, practitionerId: kine.practitionerId, sharedById: A.userId },
      });
      asUser(kine.userId);
      const b = await seed(A, { patientId: pat });
      expect((await markReceptionAction(b.id, "llego", b.updatedAt.toISOString())).ok).toBe(true);
    });

    it("[revisión B-pre] deshacer vuelve al status de origen: guest y reserva pública impaga → PENDING; pública paga → CONFIRMED", async () => {
      asUser(A.userId);
      const cases = [
        { o: { patientId: null, status: "PENDING" as const }, back: "PENDING" },
        {
          o: { status: "PENDING" as const, paymentStatus: "UNPAID" as const, idempotencyKey: `pub:${A.tenantId}:${randomUUID()}` },
          back: "PENDING",
        },
        {
          o: { status: "PENDING" as const, paymentStatus: "FAILED" as const, idempotencyKey: `pub:${A.tenantId}:${randomUUID()}` },
          back: "PENDING",
        },
        {
          o: { status: "CONFIRMED" as const, paymentStatus: "PAID" as const, idempotencyKey: `pub:${A.tenantId}:${randomUUID()}` },
          back: "CONFIRMED",
        },
      ];
      for (const c of cases) {
        const b = await seed(A, c.o);
        const r = await markReceptionAction(b.id, "ausente", b.updatedAt.toISOString());
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const u = await markReceptionAction(b.id, "deshacer", r.data.updatedAt);
        expect(u.ok).toBe(true);
        if (!u.ok) return;
        expect(u.data.status).toBe(c.back);
        const row = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
        expect(row.status).toBe(c.back);
        // El cobro no se toca.
        expect(row.paymentStatus).toBe(b.paymentStatus);
      }
    });

    it("BILLING (sin agenda.reception) → rechazo sin escribir", async () => {
      asUser(billing.userId);
      const b = await seed(A);
      const r = await markReceptionAction(b.id, "llego", b.updatedAt.toISOString());
      expect(r.ok).toBe(false);
      expect(r.ok ? "" : r.error).toMatch(/permiso/);
      expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).arrivedAt).toBeNull();
    });

    it("IDOR: un turno de OTRO tenant → no encontrado, la fila ajena no cambia", async () => {
      asUser(A.userId);
      const foreign = await seed(B);
      const r = await markReceptionAction(foreign.id, "llego", foreign.updatedAt.toISOString());
      expect(r.ok).toBe(false);
      expect(r.ok ? "" : r.error).toMatch(/no encontrado/);
      const row = await db.booking.findUniqueOrThrow({ where: { id: foreign.id } });
      expect(row.arrivedAt).toBeNull();
      expect(+row.updatedAt).toBe(+foreign.updatedAt);
    });
  });

  // ── SV05 · «Llamar» y `calledAt` (§18.4, SV-D2/D5) ──────────────────────
  // Antes de SV05 `markReceptionAction` no leía `calledAt`: la fila llamada se
  // derivaba como «en-sala» (Llamar dos veces pasaba, Deshacer desde llamado
  // borraba también la llegada) y el ref salía con `kind:"reception"`, así que
  // la sala de espera no podía avisar el llamado.
  describe("[SV05] llamar y calledAt", () => {
    let salaLocation: string;
    beforeAll(async () => {
      // Sede NO principal a propósito: `addRoom` sin sede crearía la principal y
      // el `beforeAll` de listAgendaBookings crea la suya (único parcial).
      salaLocation = (await db.location.create({ data: { tenantId: A.tenantId, name: "Sala SV05" } })).id;
    });

    /** Turno de HOY en sala (llegó hace 5'), con sala y sede (SR). */
    async function inSala(o: { practitionerId?: string } = {}) {
      const { roomId, locationId } = await addRoom(db, A, { locationId: salaLocation });
      const b = await seed(A, { arrivedAt: new Date(Date.now() - 5 * 60_000), roomId, locationId, ...o });
      return { b, roomId };
    }

    it("[SV05] llamar: en-sala → llamado escribe calledAt, emite 1 vez kind 'called' con roomId (sin audit, PL-A)", async () => {
      asUser(A.userId);
      const { b, roomId } = await inSala();
      realtimeFake.reset();
      const r = await markReceptionAction(b.id, "llamar", b.updatedAt.toISOString());
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data.state).toBe("llamado");
      const row = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
      expect(row.calledAt).not.toBeNull();
      expect(row.arrivedAt?.toISOString()).toBe(b.arrivedAt!.toISOString());
      expect(r.data.calledAt).toBe(row.calledAt!.toISOString());
      expect(r.data.updatedAt).toBe(row.updatedAt.toISOString());

      expect(realtimeFake.calls).toHaveLength(1);
      const call = realtimeFake.calls[0];
      expect(call.tenantId).toBe(A.tenantId);
      expect(call.refs).toHaveLength(1);
      expect(call.refs![0]).toMatchObject({
        bookingId: b.id,
        practitionerId: b.practitionerId,
        roomId,
        kind: "called",
      });

      // PL-A: «Llamar» ya no se audita (recepción = ruido operativo).
      expect(await db.auditEvent.count({ where: { tenantId: A.tenantId, entityId: b.id } })).toBe(0);
    });

    it("llamar desde por-llegar → error («Primero marcá Llegó»), sin escribir ni emitir", async () => {
      asUser(A.userId);
      const b = await seed(A);
      realtimeFake.reset();
      const r = await markReceptionAction(b.id, "llamar", b.updatedAt.toISOString());
      expect(r.ok).toBe(false);
      expect(r.ok ? "" : r.error).toMatch(/Primero marcá «Llegó»/);
      const row = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
      expect(row.calledAt).toBeNull();
      expect(+row.updatedAt).toBe(+b.updatedAt);
      expect(realtimeFake.calls).toHaveLength(0);
      expect(await db.auditEvent.count({ where: { entityId: b.id } })).toBe(0);
    });

    it("llamar dos veces → el segundo es error (ya está llamado) y no pisa calledAt", async () => {
      asUser(A.userId);
      const { b } = await inSala();
      const r1 = await markReceptionAction(b.id, "llamar", b.updatedAt.toISOString());
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      realtimeFake.reset();
      const r2 = await markReceptionAction(b.id, "llamar", r1.data.updatedAt);
      expect(r2.ok).toBe(false);
      expect(r2.ok ? "" : r2.error).toMatch(/No se puede llamar a/);
      const row = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
      expect(row.calledAt?.toISOString()).toBe(r1.data.calledAt);
      expect(row.updatedAt.toISOString()).toBe(r1.data.updatedAt);
      expect(realtimeFake.calls).toHaveLength(0);
    });

    it("la Secretaria (ASSISTANT) llama en nombre del profesional (SV-D2): turno de otro profesional", async () => {
      asUser(assistant.userId);
      const { b } = await inSala({ practitionerId: kine.practitionerId });
      realtimeFake.reset();
      const r = await markReceptionAction(b.id, "llamar", b.updatedAt.toISOString());
      expect(r.ok).toBe(true);
      expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).calledAt).not.toBeNull();
      expect(realtimeFake.calls[0]?.refs?.[0]).toMatchObject({ practitionerId: kine.practitionerId, kind: "called" });
      // PL-A: sin audit de recepción; lo observable es `calledAt` y el evento realtime de arriba.
      expect(await db.auditEvent.count({ where: { entityId: b.id } })).toBe(0);
    });

    it("BILLING → forbidden, sin escribir ni emitir", async () => {
      asUser(billing.userId);
      const { b } = await inSala();
      realtimeFake.reset();
      const r = await markReceptionAction(b.id, "llamar", b.updatedAt.toISOString());
      expect(r.ok).toBe(false);
      expect(r.ok ? "" : r.error).toMatch(/permiso/);
      expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).calledAt).toBeNull();
      expect(realtimeFake.calls).toHaveLength(0);
    });

    it("deshacer en llamado → limpia calledAt (vuelve a en-sala, conserva la llegada) y emite kind 'reception'", async () => {
      asUser(A.userId);
      const { b, roomId } = await inSala();
      const r1 = await markReceptionAction(b.id, "llamar", b.updatedAt.toISOString());
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      realtimeFake.reset();
      const u = await markReceptionAction(b.id, "deshacer", r1.data.updatedAt);
      expect(u.ok).toBe(true);
      if (!u.ok) return;
      expect(u.data.state).toBe("en-sala");
      expect(u.data.calledAt).toBeNull();
      const row = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
      expect(row.calledAt).toBeNull();
      expect(row.arrivedAt).not.toBeNull();
      expect(realtimeFake.calls).toHaveLength(1);
      expect(realtimeFake.calls[0].refs).toEqual([
        expect.objectContaining({ bookingId: b.id, practitionerId: b.practitionerId, roomId, kind: "reception" }),
      ]);
    });

    it("deshacer en en-sala → limpia arrivedAt y calledAt (CHECK de M5)", async () => {
      asUser(A.userId);
      const { b } = await inSala();
      const u = await markReceptionAction(b.id, "deshacer", b.updatedAt.toISOString());
      expect(u.ok).toBe(true);
      if (!u.ok) return;
      expect(u.data.state).toBe("por-llegar");
      expect(u.data.arrivedAt).toBeNull();
      expect(u.data.calledAt).toBeNull();
      const row = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
      expect(row.arrivedAt).toBeNull();
      expect(row.calledAt).toBeNull();
    });

    it("en-atencion desde llamado; deshacer vuelve a llamado (conserva calledAt)", async () => {
      asUser(A.userId);
      const { b } = await inSala();
      const r1 = await markReceptionAction(b.id, "llamar", b.updatedAt.toISOString());
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      const r2 = await markReceptionAction(b.id, "en-atencion", r1.data.updatedAt);
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      expect(r2.data.state).toBe("en-atencion");
      expect(r2.data.calledAt).toBe(r1.data.calledAt);
      let row = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
      expect(row.attendingAt).not.toBeNull();
      expect(row.calledAt?.toISOString()).toBe(r1.data.calledAt);
      const u = await markReceptionAction(b.id, "deshacer", r2.data.updatedAt);
      expect(u.ok).toBe(true);
      if (!u.ok) return;
      expect(u.data.state).toBe("llamado");
      row = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
      expect(row.attendingAt).toBeNull();
      expect(row.calledAt?.toISOString()).toBe(r1.data.calledAt);
    });
  });

  // ── FX1b: estampas de Recepción al mover un turno ──────────────────────
  // Un turno «llamado» movido a mañana seguía con `arrivedAt`/`calledAt` de
  // hoy: mañana aparecía en la Sala de Espera como ya llegado. Cambiar de día
  // AR las limpia (las tres, en el mismo UPDATE: CHECK de M5); mover dentro
  // del mismo día AR no las toca. Por `updateBooking` real (el core de la
  // edición, el mismo que usan Planes y «reprogramar sesión»).
  describe("[FX1b] updateBooking y las estampas de Recepción", () => {
    const DAY = "2027-08-10"; // martes, lejos de los días de los otros bloques
    const FORCE = { allowOutOfHours: true, allowBlocked: true, allowOverbooking: true } as const;

    /** Turno «llamado» y «en atención» (las tres estampas puestas). */
    async function called(hhmm: string) {
      const when = ar(DAY, hhmm);
      const b = await seed(A, {
        when,
        arrivedAt: new Date(when.getTime() - 10 * 60_000),
        calledAt: new Date(when.getTime() - 2 * 60_000),
      });
      return db.booking.update({ where: { id: b.id }, data: { attendingAt: when } });
    }

    it("mover un turno llamado a MAÑANA → arrivedAt, calledAt y attendingAt en null", async () => {
      asUser(A.userId);
      const b = await called("10:00");
      const r = await updateBooking({
        id: b.id,
        scheduledFor: ar("2027-08-11", "10:00").toISOString(),
        expectedUpdatedAt: b.updatedAt.toISOString(),
        ...FORCE,
      });
      expect(r.ok, r.ok ? "" : r.error).toBe(true);
      const row = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
      expect(row.scheduledFor.toISOString()).toBe(ar("2027-08-11", "10:00").toISOString());
      expect(row.arrivedAt).toBeNull();
      expect(row.calledAt).toBeNull();
      expect(row.attendingAt).toBeNull();
    });

    it("mover 30 min el mismo día → las estampas se conservan", async () => {
      asUser(A.userId);
      const b = await called("12:00");
      const r = await updateBooking({
        id: b.id,
        scheduledFor: ar(DAY, "12:30").toISOString(),
        expectedUpdatedAt: b.updatedAt.toISOString(),
        ...FORCE,
      });
      expect(r.ok, r.ok ? "" : r.error).toBe(true);
      const row = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
      expect(row.scheduledFor.toISOString()).toBe(ar(DAY, "12:30").toISOString());
      expect(row.arrivedAt?.toISOString()).toBe(b.arrivedAt!.toISOString());
      expect(row.calledAt?.toISOString()).toBe(b.calledAt!.toISOString());
      expect(row.attendingAt?.toISOString()).toBe(b.attendingAt!.toISOString());
    });

    it("mover a las 22:30 AR del mismo día (= otro día en UTC) → se conservan: el día es el AR, no el del host", async () => {
      asUser(A.userId);
      const b = await called("14:00");
      const r = await updateBooking({
        id: b.id,
        scheduledFor: ar(DAY, "22:30").toISOString(),
        expectedUpdatedAt: b.updatedAt.toISOString(),
        ...FORCE,
      });
      expect(r.ok, r.ok ? "" : r.error).toBe(true);
      const row = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
      expect(row.arrivedAt).not.toBeNull();
      expect(row.calledAt).not.toBeNull();
      expect(row.attendingAt).not.toBeNull();
    });

    it("editar sin mover (notas) → no toca las estampas", async () => {
      asUser(A.userId);
      const b = await called("16:00");
      const r = await updateBooking({ id: b.id, notes: "trae estudios", expectedUpdatedAt: b.updatedAt.toISOString() });
      expect(r.ok, r.ok ? "" : r.error).toBe(true);
      const row = await db.booking.findUniqueOrThrow({ where: { id: b.id } });
      expect(row.arrivedAt?.toISOString()).toBe(b.arrivedAt!.toISOString());
      expect(row.calledAt?.toISOString()).toBe(b.calledAt!.toISOString());
    });
  });

  // ── Proyección liviana ─────────────────────────────────────────────────
  describe("listAgendaBookings", () => {
    const DAY = "2027-05-11";
    let primary: string;
    let second: string;
    let ids: { nullLoc: string; primaryLoc: string; secondLoc: string; other: string; guest: string };
    const range = { from: ar(DAY, "00:00"), to: ar("2027-05-12", "00:00") };

    beforeAll(async () => {
      primary = (
        await db.location.create({ data: { tenantId: A.tenantId, name: "Principal", isPrimary: true } })
      ).id;
      second = (await db.location.create({ data: { tenantId: A.tenantId, name: "Norte" } })).id;
      const ins = await addInsurer(db, A, { name: "OSDE test", copagoCents: 1500 });
      const pat = await addPatient(db, A);
      await db.coverage.create({ data: { patientId: pat, insurer: "OSDE test", insurerId: ins } });
      const clinical = { notes: "Dolor lumbar", title: "Lumbalgia", description: "Irradia a pierna" };
      ids = {
        nullLoc: (await seed(A, { patientId: pat, when: ar(DAY, "09:00"), ...clinical })).id,
        primaryLoc: (await seed(A, { when: ar(DAY, "10:00"), locationId: primary, ...clinical })).id,
        secondLoc: (
          await seed(A, {
            when: ar(DAY, "11:00"),
            locationId: second,
            arrivedAt: ar(DAY, "10:55"),
            calledAt: ar(DAY, "11:02"),
            ...clinical,
          })
        ).id,
        other: (await seed(A, { when: ar(DAY, "12:00"), practitionerId: kine.practitionerId, ...clinical })).id,
        guest: (await seed(A, { patientId: null, when: ar(DAY, "13:00"), notes: "Llamar al 1140001000" })).id,
      };
      await db.booking.update({
        where: { id: ids.nullLoc },
        data: { isOverbooked: true, isTelemedicine: true, telemedicineUrl: "https://meet.test/abc" },
      });
      // Turno de B el mismo día: nunca aparece.
      await seed(B, { when: ar(DAY, "09:00") });
    });

    it("trae los campos nuevos y, para el OWNER (clinical.read), el contenido clínico; billing igual que la proyección completa", async () => {
      asUser(A.userId);
      const rows = await listAgendaBookings(range);
      expect(rows.map((r) => r.id).sort()).toEqual(Object.values(ids).sort());
      const r = rows.find((x) => x.id === ids.nullLoc)!;
      expect(r.isOverbooked).toBe(true);
      expect(r.isTelemedicine).toBe(true);
      expect(r.telemedicineUrl).toBe("https://meet.test/abc");
      expect(r.locationId).toBeNull();
      expect(r.title).toBe("Lumbalgia");
      expect(r.notes).toBe("Dolor lumbar");
      expect(r.clinicalHidden).toBe(false);
      expect(r.patientCondition).toBeNull();
      const arrived = rows.find((x) => x.id === ids.secondLoc)!;
      expect(arrived.arrivedAt?.toISOString()).toBe(ar(DAY, "10:55").toISOString());
      expect(arrived.attendingAt).toBeNull();
      // SV05: `calledAt` viaja en la proyección liviana (null si no se llamó).
      expect(arrived.calledAt?.toISOString()).toBe(ar(DAY, "11:02").toISOString());
      expect(r.calledAt).toBeNull();

      // Paridad de billing con la proyección completa (precedencia de copago §5.5).
      const full = await listBookingsInRange(range);
      for (const f of full) {
        const l = rows.find((x) => x.id === f.id)!;
        expect({ obraSocial: l.obraSocial, copagoCents: l.copagoCents, patientAccess: l.patientAccess }).toEqual({
          obraSocial: f.obraSocial,
          copagoCents: f.copagoCents,
          patientAccess: f.patientAccess,
        });
      }
      expect(r.obraSocial).toBe("OSDE test");

      // Mapeo al DTO del cliente: fechas a ISO; la proyección completa no
      // inventa los campos nuevos (ausentes, no null).
      const dto = toBookingDTO(arrived);
      expect(dto.arrivedAt).toBe(ar(DAY, "10:55").toISOString());
      expect(dto.calledAt).toBe(ar(DAY, "11:02").toISOString());
      expect(dto.locationId).toBe(second);
      expect(dto.locationName).toBe("Norte");
      expect(toBookingDTO(r).locationName).toBe("Principal");
      const fullDto = toBookingDTO(full.find((f) => f.id === ids.nullLoc)!);
      expect("arrivedAt" in fullDto).toBe(false);
      expect(fullDto.scheduledFor).toBe(ar(DAY, "09:00").toISOString());
    });

    it("ASSISTANT (sin clinical.read): sin title/description/notas clínicas; la nota de un turno sin paciente queda", async () => {
      asUser(assistant.userId);
      const rows = await listAgendaBookings(range);
      expect(rows).toHaveLength(Object.keys(ids).length);
      for (const r of rows.filter((x) => x.patientId)) {
        expect(r.title).toBeNull();
        expect(r.description).toBeNull();
        expect(r.notes).toBeNull();
        expect(r.clinicalHidden).toBe(true);
      }
      const guest = rows.find((x) => x.id === ids.guest)!;
      expect(guest.notes).toBe("Llamar al 1140001000");
      expect(guest.title).toBeNull();
    });

    it("filtros: practitionerIds[] y sede (la principal incluye los turnos con locationId null)", async () => {
      asUser(A.userId);
      const byPrac = await listAgendaBookings({ ...range, practitionerIds: [kine.practitionerId] });
      expect(byPrac.map((r) => r.id)).toEqual([ids.other]);

      const atPrimary = await listAgendaBookings({ ...range, locationId: primary });
      expect(atPrimary.map((r) => r.id).sort()).toEqual([ids.nullLoc, ids.primaryLoc, ids.other, ids.guest].sort());

      const atSecond = await listAgendaBookings({ ...range, locationId: second });
      expect(atSecond.map((r) => r.id)).toEqual([ids.secondLoc]);

      // Sede de otro tenant / inexistente → vacío (no "sin filtro").
      const foreignLoc = await db.location.create({ data: { tenantId: B.tenantId, name: "Ajena" } });
      expect(await listAgendaBookings({ ...range, locationId: foreignLoc.id })).toEqual([]);
      // Profesional de otro tenant → vacío.
      expect(await listAgendaBookings({ ...range, practitionerIds: [B.practitionerId] })).toEqual([]);
    });

    it("rango inválido (to <= from o más de 62 días) → error", async () => {
      asUser(A.userId);
      await expect(listAgendaBookings({ from: range.to, to: range.from })).rejects.toThrow();
      await expect(
        listAgendaBookings({ from: range.from, to: new Date(range.from.getTime() + 63 * 86_400_000) })
      ).rejects.toThrow();
    });
  });

  // ── Cancelación en lote (candado de B4.4) ──────────────────────────────
  describe("cancelBookingsInTx", () => {
    it("cancela solo los activos; NO cancela los que tienen cobro registrado (H1) y los reporta; audita con el motivo", async () => {
      const osteo = await addService(db, A, { name: `Osteo ${randomUUID().slice(0, 6)}` });
      const when = ar("2027-06-01", "10:00");
      const pending = await seed(A, { when, status: "PENDING", serviceId: osteo });
      const confirmed = await seed(A, { when, serviceId: osteo });
      const completed = await seed(A, { when, status: "COMPLETED", serviceId: osteo });
      const already = await seed(A, { when, status: "CANCELLED", serviceId: osteo });
      const copagoPaid = await seed(A, { when, paymentStatus: "PAID", serviceId: osteo });
      const osPaid = await seed(A, { when, insurerPaidAt: new Date(), serviceId: osteo });
      const mpPaid = await seed(A, { when, serviceId: osteo });
      await db.payment.create({ data: { bookingId: mpPaid.id, status: "PAID", amountCents: 5000 } });
      const foreign = await seed(B, { when });

      const all = [pending, confirmed, completed, already, copagoPaid, osPaid, mpPaid, foreign].map((b) => b.id);
      const res = await runWithRls(A.tenantId, (tx) =>
        cancelBookingsInTx(tx, { tenantId: A.tenantId, bookingIds: all, reason: "Feriado", actorId: A.userId })
      );

      expect(res.cancelled.map((c) => c.id).sort()).toEqual([pending.id, confirmed.id].sort());
      const skipped = Object.fromEntries(res.skipped.map((s) => [s.id, s.reason]));
      expect(skipped).toEqual({
        [completed.id]: "not-active",
        [already.id]: "not-active",
        [copagoPaid.id]: "has-payment",
        [osPaid.id]: "has-payment",
        [mpPaid.id]: "has-payment",
        [foreign.id]: "not-found",
      });

      const statuses = await db.booking.findMany({ where: { id: { in: all } }, select: { id: true, status: true, updatedAt: true } });
      const st = Object.fromEntries(statuses.map((s) => [s.id, s.status]));
      expect(st[pending.id]).toBe("CANCELLED");
      expect(st[confirmed.id]).toBe("CANCELLED");
      expect(st[completed.id]).toBe("COMPLETED");
      expect(st[copagoPaid.id]).toBe("CONFIRMED");
      expect(st[osPaid.id]).toBe("CONFIRMED");
      expect(st[mpPaid.id]).toBe("CONFIRMED");
      expect(st[foreign.id]).toBe("CONFIRMED");
      // updatedAt se movió: una vista vieja del drawer queda stale.
      const upd = statuses.find((s) => s.id === confirmed.id)!.updatedAt;
      expect(+upd).toBeGreaterThan(+confirmed.updatedAt);

      const audits = await db.auditEvent.findMany({
        where: { tenantId: A.tenantId, action: "booking.cancel.bulk", entityId: { in: all } },
        select: { entityId: true, actorId: true, payload: true },
      });
      expect(audits.map((a) => a.entityId).sort()).toEqual([pending.id, confirmed.id].sort());
      expect(audits[0].actorId).toBe(A.userId);
      expect((audits[0].payload as { reason: string }).reason).toBe("Feriado");
    });

    it("si la tx del caller se revierte, no queda nada cancelado ni auditado (todo en la misma tx)", async () => {
      const b = await seed(A, { when: ar("2027-06-02", "10:00") });
      await expect(
        runWithRls(A.tenantId, async (tx) => {
          await cancelBookingsInTx(tx, { tenantId: A.tenantId, bookingIds: [b.id], reason: "x", actorId: A.userId });
          throw new Error("rollback");
        })
      ).rejects.toThrow("rollback");
      expect((await db.booking.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("CONFIRMED");
      expect(await db.auditEvent.count({ where: { entityId: b.id, action: "booking.cancel.bulk" } })).toBe(0);
    });

    it("lista vacía → sin queries de escritura ni errores", async () => {
      const res = await runWithRls(A.tenantId, (tx) =>
        cancelBookingsInTx(tx, { tenantId: A.tenantId, bookingIds: [], reason: "x", actorId: null })
      );
      expect(res).toEqual({ cancelled: [], skipped: [] });
    });
  });
});
