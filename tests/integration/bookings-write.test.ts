/**
 * Caracterización de los write-paths de turnos (A1.1, 2026-09-29).
 *
 * Congela el comportamiento REAL de lib/bookings.ts contra Postgres antes de
 * que A2 y el Bloque B los toquen. Corre con `getActor()` real (solo se mockea
 * la sesión de Supabase, ver tests/helpers/integration-setup.ts) y en los dos
 * modos: `kinesoft_app` (RLS) y owner BYPASSRLS (= prod hoy).
 *
 * Convención: un bug CONOCIDO se escribe como `it.fails("[<sesión>] …")` con la
 * expectativa CORRECTA. Hoy falla (y por eso pasa); la sesión que lo arregla lo
 * da vuelta a `it(...)`. Si un `it.fails` empieza a "fallar", alguien arregló el
 * bug sin darlo vuelta — o lo rompió de otra forma: mirarlo.
 * Contrato con A2: ver la lista en .docs/TESTING.md §Contrato A2.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  createBooking,
  createBookingsBatch,
  updateBooking,
  setBookingStatus,
  deleteBooking,
  setBookingCopagoPaid,
  setBookingInsurerPaid,
  listBookingsInRange,
} from "@/lib/bookings";
import { exportBookingsIcs } from "@/lib/bookings-export-internal";
import { getActor } from "@/lib/session";
import { localToARIso } from "@/lib/datetime-ar";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  addService,
  sweepOrphanTestTenants,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { appRoleBypassesRls } from "@/tests/helpers/db-role";

const RUN = process.env.INTEGRATION === "1";
/** true = owner BYPASSRLS (prod hoy); false = kinesoft_app con RLS. */
const BYPASS = RUN ? await appRoleBypassesRls() : true;

/** "2027-03-10", "10:00" → instante ISO del reloj AR (sin depender del host). */
const ar = (day: string, hhmm: string) => new Date(localToARIso(`${day}T${hhmm}:00`)).toISOString();
const key = () => randomUUID();

describe.skipIf(!RUN)("turnos · write-paths (caracterización)", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  /** Servicio con cupo 1 (osteopatía) en A. */
  let osteoId: string;

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
    osteoId = await addService(db, A, { name: "Osteopatía", durationMin: 60, maxConcurrent: 1 });
    asUser(A.userId);
  });

  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await db?.$disconnect();
  });

  const base = (patientId: string, when: string, extra: Record<string, unknown> = {}) => ({
    patientId,
    serviceId: A.serviceId,
    practitionerId: A.practitionerId,
    scheduledFor: when,
    durationMin: 45,
    ...extra,
  });

  // ── Idempotencia e índice único parcial ───────────────────────────────
  it("la misma idempotencyKey dos veces → una sola fila", async () => {
    const p = await addPatient(db, A);
    const k = key();
    const r1 = await createBooking({ ...base(p, ar("2027-03-01", "10:00")), idempotencyKey: k });
    const r2 = await createBooking({ ...base(p, ar("2027-03-01", "10:00")), idempotencyKey: k });
    expect(r1.ok && r2.ok).toBe(true);
    expect(await db.booking.count({ where: { patientId: p } })).toBe(1);
  });

  // Bajo RLS Postgres no expone qué índice violó el INSERT (P2002 con
  // `meta.target === null`); el catch caía al genérico "Turno duplicado."
  // (hallazgo A1.1). A2a-S06: resolveUniqueViolation decide por los datos.
  it("[A2-S06 · p2002-target-null-bajo-rls] keys distintas, mismo paciente e instante → error accionable, no un segundo turno", async () => {
    const p = await addPatient(db, A);
    await createBooking({ ...base(p, ar("2027-03-02", "10:00")), idempotencyKey: key() });
    const r = await createBooking({
      ...base(p, ar("2027-03-02", "10:00")),
      idempotencyKey: key(),
      allowSamePatientDay: true,
      allowPatientOverlap: true,
    });
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(/exactamente a esa hora/);
    expect(await db.booking.count({ where: { patientId: p } })).toBe(1);
  });

  it("un CANCELLED libera el horario (se puede volver a reservar)", async () => {
    const p = await addPatient(db, A);
    const r1 = await createBooking({ ...base(p, ar("2027-03-03", "10:00")), idempotencyKey: key() });
    if (!r1.ok) throw new Error(r1.error);
    expect((await setBookingStatus(r1.data.id, "CANCELLED")).ok).toBe(true);
    const r2 = await createBooking({ ...base(p, ar("2027-03-03", "10:00")), idempotencyKey: key() });
    expect(r2.ok).toBe(true);
    expect(await db.booking.count({ where: { patientId: p, status: { not: "CANCELLED" } } })).toBe(1);
  });

  it("[A2-S06] dos upserts concurrentes con la MISMA key → una fila y las dos respuestas ok", async () => {
    const p = await addPatient(db, A);
    const k = key();
    const payload = { ...base(p, ar("2027-03-04", "16:00")), idempotencyKey: k };
    const [r1, r2] = await Promise.all([createBooking(payload), createBooking(payload)]);
    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok && r2.ok) expect(r1.data.id).toBe(r2.data.id);
    expect(await db.booking.count({ where: { patientId: p } })).toBe(1);
  });

  it("dos creates concurrentes (keys distintas) al mismo instante → exactamente un turno", async () => {
    const p = await addPatient(db, A);
    const when = ar("2027-03-04", "10:00");
    const [r1, r2] = await Promise.all([
      createBooking({ ...base(p, when), idempotencyKey: key(), allowSamePatientDay: true, allowPatientOverlap: true }),
      createBooking({ ...base(p, when), idempotencyKey: key(), allowSamePatientDay: true, allowPatientOverlap: true }),
    ]);
    expect([r1.ok, r2.ok].filter(Boolean)).toHaveLength(1);
    expect(await db.booking.count({ where: { patientId: p } })).toBe(1);
  });

  // ── Optimistic lock ────────────────────────────────────────────────────
  it("updateBooking con expectedUpdatedAt viejo → rechaza sin escribir", async () => {
    const p = await addPatient(db, A);
    const r = await createBooking({ ...base(p, ar("2027-03-05", "10:00")), idempotencyKey: key() });
    if (!r.ok) throw new Error(r.error);
    const stale = new Date(0).toISOString();
    const u = await updateBooking({ id: r.data.id, notes: "pisado", expectedUpdatedAt: stale });
    expect(u.ok).toBe(false);
    expect(u.ok ? "" : u.error).toMatch(/cambió en otra sesión/);
    expect((await db.booking.findUnique({ where: { id: r.data.id } }))?.notes).not.toBe("pisado");
  });

  it("[A2-S06] toggle de cobro con expectedUpdatedAt viejo → rechaza sin escribir", async () => {
    const p = await addPatient(db, A);
    const r = await createBooking({ ...base(p, ar("2027-03-06", "10:00")), idempotencyKey: key() });
    if (!r.ok) throw new Error(r.error);
    const stale = new Date(0).toISOString();
    const res = await setBookingCopagoPaid(r.data.id, true, stale);
    expect(res.ok).toBe(false);
    expect(res.ok ? "" : res.error).toMatch(/cambió en otra sesión/);
    expect((await db.booking.findUnique({ where: { id: r.data.id } }))?.paymentStatus).toBe("UNPAID");
  });

  it("[A2-S06] dos toggles seguidos encadenando el updatedAt devuelto → ambos pasan", async () => {
    const p = await addPatient(db, A);
    const r = await createBooking({ ...base(p, ar("2027-03-06", "15:00")), idempotencyKey: key() });
    if (!r.ok) throw new Error(r.error);
    const row = await db.booking.findUniqueOrThrow({ where: { id: r.data.id } });
    const t1 = await setBookingInsurerPaid(r.data.id, true, row.updatedAt.toISOString());
    if (!t1.ok) throw new Error(t1.error);
    // Con la versión VIEJA el segundo rebota (es lo que parchea facturacion-view).
    expect((await setBookingCopagoPaid(r.data.id, true, row.updatedAt.toISOString())).ok).toBe(false);
    const t2 = await setBookingCopagoPaid(r.data.id, true, new Date(t1.data.updatedAt).toISOString());
    expect(t2.ok).toBe(true);
    const after = await db.booking.findUniqueOrThrow({ where: { id: r.data.id } });
    expect(after.paymentStatus).toBe("PAID");
    expect(after.insurerPaidAt).not.toBeNull();
  });

  // ── Reprogramar ─────────────────────────────────────────────────────────
  it("reprogramar sobre el instante de otro turno del mismo paciente → error de solape", async () => {
    const p = await addPatient(db, A);
    await createBooking({ ...base(p, ar("2027-03-08", "10:00")), idempotencyKey: key() });
    const second = await createBooking({
      ...base(p, ar("2027-03-08", "15:00")),
      idempotencyKey: key(),
      allowSamePatientDay: true,
    });
    if (!second.ok) throw new Error(second.error);
    const u = await updateBooking({ id: second.data.id, scheduledFor: ar("2027-03-08", "10:00") });
    expect(u.ok).toBe(false);
    expect(u.ok ? "" : u.error).toMatch(/se superpone/);
  });

  // ── Capacidad (Service.maxConcurrent) ──────────────────────────────────
  it("cupo ilimitado (kinesio, null): dos pacientes a la misma hora conviven", async () => {
    const [p1, p2] = [await addPatient(db, A), await addPatient(db, A)];
    const when = ar("2027-03-09", "10:00");
    expect((await createBooking({ ...base(p1, when), idempotencyKey: key() })).ok).toBe(true);
    expect((await createBooking({ ...base(p2, when), idempotencyKey: key() })).ok).toBe(true);
  });

  it("cupo 1 (osteo): el segundo pide sobreturno; forzado queda marcado [SOBRETURNO]", async () => {
    const [p1, p2] = [await addPatient(db, A), await addPatient(db, A)];
    const when = ar("2027-03-10", "10:00");
    const osteo = (p: string, extra = {}) => ({ ...base(p, when), serviceId: osteoId, durationMin: 60, ...extra });
    expect((await createBooking({ ...osteo(p1), idempotencyKey: key() })).ok).toBe(true);
    const blocked = await createBooking({ ...osteo(p2), idempotencyKey: key() });
    expect(blocked.ok).toBe(false);
    expect("conflict" in blocked && blocked.conflict).toBeTruthy();
    const forced = await createBooking({ ...osteo(p2), idempotencyKey: key(), allowOverbooking: true });
    if (!forced.ok) throw new Error(forced.error);
    expect((await db.booking.findUnique({ where: { id: forced.data.id } }))?.notes).toMatch(/^\[SOBRETURNO\]/);
  });

  it("[A2-S06] reactivar un CANCELLED sobre cupo lleno → pide confirmar sobreturno", async () => {
    const [p1, p2] = [await addPatient(db, A), await addPatient(db, A)];
    const when = ar("2027-03-11", "10:00");
    const osteo = (p: string) => ({ ...base(p, when), serviceId: osteoId, durationMin: 60, idempotencyKey: key() });
    const x = await createBooking(osteo(p1));
    if (!x.ok) throw new Error(x.error);
    await setBookingStatus(x.data.id, "CANCELLED");
    expect((await createBooking(osteo(p2))).ok).toBe(true); // ocupa el único cupo
    const reactivate = await updateBooking({ id: x.data.id, status: "CONFIRMED" });
    expect(reactivate.ok).toBe(false);
  });

  it("[A2-S06] alargar la duración sobre cupo lleno → pide confirmar sobreturno", async () => {
    const [p1, p2] = [await addPatient(db, A), await addPatient(db, A)];
    const x = await createBooking({ ...base(p1, ar("2027-03-12", "10:00")), serviceId: osteoId, durationMin: 60, idempotencyKey: key() });
    if (!x.ok) throw new Error(x.error);
    expect((await createBooking({ ...base(p2, ar("2027-03-12", "11:00")), serviceId: osteoId, durationMin: 60, idempotencyKey: key() })).ok).toBe(true);
    const longer = await updateBooking({ id: x.data.id, durationMin: 120 });
    expect(longer.ok).toBe(false);
    expect("conflict" in longer && longer.conflict).toBeTruthy();
    expect((await db.booking.findUnique({ where: { id: x.data.id } }))?.durationMin).toBe(60);
    // Forzado (mismo flag que createBooking) → pasa.
    expect((await updateBooking({ id: x.data.id, durationMin: 120, allowOverbooking: true })).ok).toBe(true);
  });

  it("[A2-S06] reprogramar encima de otro turno del paciente (sin mismo instante) → pide confirmar; forzado pasa", async () => {
    const p = await addPatient(db, A);
    await createBooking({ ...base(p, ar("2027-03-13", "10:00")), idempotencyKey: key() });
    const second = await createBooking({ ...base(p, ar("2027-03-13", "15:00")), idempotencyKey: key(), allowSamePatientDay: true });
    if (!second.ok) throw new Error(second.error);
    const u = await updateBooking({ id: second.data.id, scheduledFor: ar("2027-03-13", "10:30") });
    expect(u.ok).toBe(false);
    expect("patientOverlap" in u && u.patientOverlap).toBeTruthy();
    const forced = await updateBooking({ id: second.data.id, scheduledFor: ar("2027-03-13", "10:30"), allowPatientOverlap: true });
    expect(forced.ok).toBe(true);
  });

  it("[A2-S06] el conflicto nombra al profesional del tenant y nunca su email", async () => {
    const [p1, p2] = [await addPatient(db, A), await addPatient(db, A)];
    const when = ar("2027-03-14", "10:00");
    const osteo = (p: string) => ({ ...base(p, when), serviceId: osteoId, durationMin: 60, idempotencyKey: key() });
    expect((await createBooking(osteo(p1))).ok).toBe(true);
    const blocked = await createBooking(osteo(p2));
    const name = "conflict" in blocked ? blocked.conflict?.practitionerName : undefined;
    expect(name).toBeTruthy();
    expect(name).not.toMatch(/@/);
  });

  it("[A2-S06] pendiente pública impaga vencida (>30 min) no bloquea el cupo; una fresca sí", async () => {
    const [pub, pubFresh, p] = [await addPatient(db, A), await addPatient(db, A), await addPatient(db, A)];
    const when = new Date(ar("2027-03-19", "10:00"));
    const pending = (patientId: string, createdAt: Date) =>
      db.booking.create({
        data: {
          tenantId: A.tenantId,
          patientId,
          practitionerId: A.practitionerId,
          serviceId: osteoId,
          scheduledFor: when,
          durationMin: 60,
          status: "PENDING",
          paymentStatus: "UNPAID",
          // Formato del turnero público: el discriminante de isHoldingCapacity.
          idempotencyKey: `pub:${A.tenantId}:${key()}`,
          createdAt,
        },
      });
    const expired = await pending(pub, new Date(Date.now() - 31 * 60_000));
    const ok = await createBooking({ ...base(p, when.toISOString()), serviceId: osteoId, durationMin: 60, idempotencyKey: key() });
    expect(ok.ok).toBe(true);
    // Una pendiente fresca (recién creada) sí sostiene el cupo.
    await db.booking.delete({ where: { id: expired.id } });
    if (ok.ok) await db.booking.delete({ where: { id: ok.data.id } });
    await pending(pubFresh, new Date());
    const blocked = await createBooking({ ...base(p, when.toISOString()), serviceId: osteoId, durationMin: 60, idempotencyKey: key() });
    expect(blocked.ok).toBe(false);
    expect("conflict" in blocked && blocked.conflict).toBeTruthy();
  });

  it("[revisión A2] guest de la agenda al que se le asigna paciente → CONFIRMED y sigue reteniendo el cupo", async () => {
    const [p, other] = [await addPatient(db, A), await addPatient(db, A)];
    const when = ar("2027-03-22", "10:00");
    const g = await createBooking({
      patientId: undefined,
      guestName: "Invitado",
      serviceId: osteoId,
      practitionerId: A.practitionerId,
      scheduledFor: when,
      durationMin: 60,
      idempotencyKey: key(),
    });
    if (!g.ok) throw new Error(g.error);
    // El guest nace PENDING/UNPAID; se envejece para que, si se confundiera con
    // una reserva pública, ya estuviera "vencido".
    await db.booking.update({ where: { id: g.data.id }, data: { createdAt: new Date(Date.now() - 2 * 3600_000) } });
    const u = await updateBooking({ id: g.data.id, patientId: p });
    expect(u.ok).toBe(true);
    const row = await db.booking.findUniqueOrThrow({ where: { id: g.data.id } });
    expect(row.patientId).toBe(p);
    expect(row.status).toBe("CONFIRMED");
    // Cupo 1: otro paciente en el mismo horario choca.
    const blocked = await createBooking({ ...base(other, when), serviceId: osteoId, durationMin: 60, idempotencyKey: key() });
    expect(blocked.ok).toBe(false);
    expect("conflict" in blocked && blocked.conflict).toBeTruthy();
    // Y la agenda no lo rotula como reserva pública.
    const [listed] = (await listBookingsInRange({
      from: new Date(when),
      to: new Date(new Date(when).getTime() + 60_000),
    })).filter((b) => b.id === g.data.id);
    expect(listed.publicReservation).toBe(false);
  });

  it("[revisión A2] aunque quede PENDING/UNPAID con paciente (fila vieja), un turno de la agenda no vence", async () => {
    const [p, other] = [await addPatient(db, A), await addPatient(db, A)];
    const when = ar("2027-03-23", "10:00");
    await db.booking.create({
      data: {
        tenantId: A.tenantId,
        patientId: p,
        practitionerId: A.practitionerId,
        serviceId: osteoId,
        scheduledFor: new Date(when),
        durationMin: 60,
        status: "PENDING",
        paymentStatus: "UNPAID",
        idempotencyKey: key(), // UUID de modal de la agenda
        createdAt: new Date(Date.now() - 2 * 3600_000),
      },
    });
    const blocked = await createBooking({ ...base(other, when), serviceId: osteoId, durationMin: 60, idempotencyKey: key() });
    expect(blocked.ok).toBe(false);
  });

  it("[revisión A2] updateBooking ya no acepta volver un turno a PENDING", async () => {
    const p = await addPatient(db, A);
    const r = await createBooking({ ...base(p, ar("2027-03-24", "10:00")), idempotencyKey: key() });
    if (!r.ok) throw new Error(r.error);
    const u = await updateBooking({ id: r.data.id, status: "PENDING" as never });
    expect(u.ok).toBe(false);
    expect((await db.booking.findUniqueOrThrow({ where: { id: r.data.id } })).status).toBe("CONFIRMED");
  });

  it("[revisión A2] una key de cliente con prefijo pub: no se usa (el turno de la agenda no puede parecer público)", async () => {
    const p = await addPatient(db, A);
    const k = `pub:${A.tenantId}:x`;
    const r = await createBooking({ ...base(p, ar("2027-03-25", "10:00")), idempotencyKey: k });
    if (!r.ok) throw new Error(r.error);
    const row = await db.booking.findUniqueOrThrow({ where: { id: r.data.id } });
    expect(row.idempotencyKey.startsWith("pub:")).toBe(false);
  });

  // ── Borrado y cobros ───────────────────────────────────────────────────
  it("deleteBooking con Payment PAID (MP) → rechaza; con Payment FAILED borra turno y pago", async () => {
    const [p1, p2] = [await addPatient(db, A), await addPatient(db, A)];
    const paid = await createBooking({ ...base(p1, ar("2027-03-15", "10:00")), idempotencyKey: key() });
    const failed = await createBooking({ ...base(p2, ar("2027-03-15", "10:00")), idempotencyKey: key() });
    if (!paid.ok || !failed.ok) throw new Error("setup");
    await db.payment.create({ data: { bookingId: paid.data.id, status: "PAID", amountCents: 5000, externalId: `t-${key()}` } });
    await db.payment.create({ data: { bookingId: failed.data.id, status: "FAILED", amountCents: 5000, externalId: `t-${key()}` } });
    const d1 = await deleteBooking(paid.data.id);
    expect(d1.ok).toBe(false);
    expect(d1.ok ? "" : d1.error).toMatch(/pago registrado/);
    expect((await deleteBooking(failed.data.id)).ok).toBe(true);
    expect(await db.payment.count({ where: { bookingId: failed.data.id } })).toBe(0);
  });

  it("[A2-S06 · H1] deleteBooking de un turno con copago cobrado a mano → rechaza", async () => {
    const p = await addPatient(db, A);
    const r = await createBooking({ ...base(p, ar("2027-03-16", "10:00")), idempotencyKey: key() });
    if (!r.ok) throw new Error(r.error);
    await setBookingCopagoPaid(r.data.id, true); // paymentStatus=PAID, sin fila Payment
    const d = await deleteBooking(r.data.id);
    expect(d.ok).toBe(false);
    expect(d.ok ? "" : d.error).toMatch(/cobro registrado \(copago u OS\)/);
    expect(await db.booking.count({ where: { id: r.data.id } })).toBe(1);
  });

  it("[A2-S06 · H1] deleteBooking de un turno con la OS confirmada → rechaza", async () => {
    const p = await addPatient(db, A);
    const r = await createBooking({ ...base(p, ar("2027-03-17", "10:00")), idempotencyKey: key() });
    if (!r.ok) throw new Error(r.error);
    await setBookingInsurerPaid(r.data.id, true);
    const d = await deleteBooking(r.data.id);
    expect(d.ok).toBe(false);
    expect(await db.booking.count({ where: { id: r.data.id } })).toBe(1);
  });

  // ── Múltiples turnos (batch con preflight) ─────────────────────────────
  it("batch: dryRun no escribe y clasifica libre / sobreturno / duplicado", async () => {
    const [p, other] = [await addPatient(db, A), await addPatient(db, A)];
    // Lunes 2027-04-05 10:00 AR. Ocupamos el cupo del 2º lunes con otro paciente
    // (osteo, cupo 1) y dejamos al propio paciente en el 3º lunes (duplicado).
    await createBooking({ ...base(other, ar("2027-04-12", "10:00")), serviceId: osteoId, durationMin: 60, idempotencyKey: key() });
    await createBooking({ ...base(p, ar("2027-04-19", "10:00")), serviceId: osteoId, durationMin: 60, idempotencyKey: key() });
    const before = await db.booking.count({ where: { tenantId: A.tenantId } });
    const pre = await createBookingsBatch({
      ...base(p, ar("2027-04-05", "10:00")),
      serviceId: osteoId,
      durationMin: 60,
      count: 4,
      daysOfWeek: [0],
      dryRun: true,
    });
    if (!pre.ok) throw new Error(pre.error);
    expect(pre.data.dates.map((d) => d.status)).toEqual(["libre", "sobreturno", "duplicado", "libre"]);
    expect(await db.booking.count({ where: { tenantId: A.tenantId } })).toBe(before);

    const run = await createBookingsBatch({
      ...base(p, ar("2027-04-05", "10:00")),
      serviceId: osteoId,
      durationMin: 60,
      count: 4,
      daysOfWeek: [0],
      allowOverbooking: false,
      idempotencyKey: key(),
    });
    if (!run.ok) throw new Error(run.error);
    expect(run.data).toMatchObject({ created: 2, omitted: 1, duplicates: 1 });
  });

  it("batch: fechas en reloj AR aunque el host esté en UTC (22:30 AR = 01:30Z del día siguiente)", async () => {
    const p = await addPatient(db, A);
    const pre = await createBookingsBatch({
      ...base(p, ar("2027-05-03", "22:30")), // lunes 22:30 AR
      count: 2,
      daysOfWeek: [0, 3], // lunes y jueves
      dryRun: true,
    });
    if (!pre.ok) throw new Error(pre.error);
    expect(pre.data.dates.map((d) => d.iso)).toEqual([
      "2027-05-04T01:30:00.000Z", // lunes 3 22:30 AR
      "2027-05-07T01:30:00.000Z", // jueves 6 22:30 AR
    ]);
  });

  // ── Lecturas de agenda en reloj AR ──────────────────────────────────────
  it("un turno 22:30 AR cae en el día AR correcto de la agenda", async () => {
    const p = await addPatient(db, A);
    const r = await createBooking({ ...base(p, ar("2027-06-07", "22:30")), idempotencyKey: key() });
    if (!r.ok) throw new Error(r.error);
    const day = (k: string) => ({ from: new Date(`${k}T03:00:00.000Z`), to: new Date(new Date(`${k}T03:00:00.000Z`).getTime() + 86_400_000) });
    const on7 = await listBookingsInRange(day("2027-06-07"));
    const on8 = await listBookingsInRange(day("2027-06-08"));
    expect(on7.map((b) => b.id)).toContain(r.data.id);
    expect(on8.map((b) => b.id)).not.toContain(r.data.id);
  });

  // ── Aislamiento de ids de entrada (IDOR) ───────────────────────────────
  it("createBooking con un paciente de OTRO tenant → rechaza", async () => {
    const foreign = await addPatient(db, B);
    const r = await createBooking({ ...base(foreign, ar("2027-07-01", "10:00")), idempotencyKey: key() });
    expect(r.ok).toBe(false);
    expect(await db.booking.count({ where: { patientId: foreign } })).toBe(0);
  });

  it("[A2-S06] createBookingsBatch con un paciente de OTRO tenant → rechaza sin escribir", async () => {
    const foreign = await addPatient(db, B);
    const r = await createBookingsBatch({ ...base(foreign, ar("2027-07-05", "10:00")), count: 1, idempotencyKey: key() });
    expect(r.ok).toBe(false);
    expect(await db.booking.count({ where: { patientId: foreign } })).toBe(0);
  });

  it("[A2-S06] createBooking con un profesional de OTRO tenant → rechaza sin escribir", async () => {
    const p = await addPatient(db, A);
    const r = await createBooking({ ...base(p, ar("2027-07-06", "10:00")), practitionerId: B.practitionerId, idempotencyKey: key() });
    expect(r.ok).toBe(false);
    expect(await db.booking.count({ where: { patientId: p } })).toBe(0);
  });
});

// ── Acceso básico = solo ver (decisión del dueño 30-sep, A2a-S06) ───────────
// Un PRACTITIONER sin acceso completo al paciente (no asignado ni compartido)
// VE el turno y no puede modificar nada; lo hace cumplir el servidor.
describe.skipIf(!RUN)("turnos · actor con acceso básico al paciente", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let kine: { userId: string; practitionerId: string };
  let patient: string;
  let bookingId: string;
  let guestBookingId: string;

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    kine = await addPractitioner(db, A, "PRACTITIONER");
    // Asignado al OWNER → el kine nuevo lo ve en modo basic.
    patient = await addPatient(db, A);
    const mk = (extra: Record<string, unknown>) =>
      db.booking.create({
        data: {
          tenantId: A.tenantId,
          practitionerId: A.practitionerId,
          serviceId: A.serviceId,
          scheduledFor: new Date(ar("2027-08-02", "10:00")),
          durationMin: 45,
          status: "CONFIRMED",
          idempotencyKey: key(),
          notes: "nota clínica",
          title: "Lumbalgia",
          description: "detalle clínico",
          ...extra,
        },
      });
    bookingId = (await mk({ patientId: patient })).id;
    guestBookingId = (await mk({ patientId: null, guestName: "Invitado", status: "PENDING", notes: null, title: null, description: null })).id;
    asUser(kine.userId);
  });

  afterAll(async () => {
    await A?.cleanup();
    await db?.$disconnect();
  });

  const snapshot = () => db.booking.findUniqueOrThrow({ where: { id: bookingId } });

  it("update / estado / delete / toggles → rechazan sin escribir", async () => {
    const before = await snapshot();
    const v = before.updatedAt.toISOString();
    const results = [
      await updateBooking({ id: bookingId, notes: "pisado", expectedUpdatedAt: v }),
      await setBookingStatus(bookingId, "CANCELLED", v),
      await deleteBooking(bookingId, v),
      await setBookingCopagoPaid(bookingId, true, v),
      await setBookingInsurerPaid(bookingId, true, v),
    ];
    for (const r of results) {
      expect(r.ok).toBe(false);
      expect(r.ok ? "" : r.error).toMatch(/acceso básico/);
    }
    const after = await snapshot();
    expect(after).toEqual(before);
  });

  it("createBooking y createBookingsBatch para ese paciente → rechazan sin escribir", async () => {
    const base = {
      patientId: patient,
      serviceId: A.serviceId,
      practitionerId: kine.practitionerId,
      scheduledFor: ar("2027-08-03", "10:00"),
      idempotencyKey: key(),
    };
    const c = await createBooking(base);
    const b = await createBookingsBatch({ ...base, count: 2, idempotencyKey: key() });
    expect(c.ok).toBe(false);
    expect(b.ok).toBe(false);
    expect(await db.booking.count({ where: { patientId: patient } })).toBe(1);
  });

  it("un turno guest (sin paciente) sí se opera", async () => {
    const r = await updateBooking({ id: guestBookingId, notes: "ok" });
    expect(r.ok).toBe(true);
  });

  it("la agenda enmascara notas, título y descripción de la fila básica", async () => {
    const rows = await listBookingsInRange({
      from: new Date(ar("2027-08-02", "00:00")),
      to: new Date(ar("2027-08-03", "00:00")),
    });
    const row = rows.find((r) => r.id === bookingId);
    expect(row).toMatchObject({ patientAccess: "basic", notes: null, title: null, description: null });
    const guest = rows.find((r) => r.id === guestBookingId);
    expect(guest?.notes).toBe("ok");
  });

  it("el ICS enmascara las filas básicas (nombre/hora/servicio sí, clínica no)", async () => {
    const actor = await getActor();
    const out = await exportBookingsIcs(actor, {
      from: new Date(ar("2027-08-02", "00:00")),
      to: new Date(ar("2027-08-03", "00:00")),
    });
    expect(out).toContain(`UID:${bookingId}@kinesoft`);
    expect(out).toContain("SUMMARY:Consulta · Paciente");
    expect(out).not.toMatch(/nota clínica|Lumbalgia|detalle clínico/);
    // El OWNER (acceso full) sí ve el detalle.
    asUser(A.userId);
    const full = await exportBookingsIcs(await getActor(), {
      from: new Date(ar("2027-08-02", "00:00")),
      to: new Date(ar("2027-08-03", "00:00")),
    });
    asUser(kine.userId);
    expect(full).toMatch(/Lumbalgia/);
    expect(full).toMatch(/nota clínica/);
  });
});
