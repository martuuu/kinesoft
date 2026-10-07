/**
 * P2-Z (cierre ES2b, revisor b) · plata y menores:
 *   - B-M3: marcar/desmarcar el cobro (copago u OS) de un turno de plan
 *     CANCELLED/NO_SHOW re-sincroniza el turno que reemplaza a la sesión
 *     (cobro previo, `priorPaidStamp`) en la misma tx, o avisa si ya no se
 *     puede tocar.
 *   - B-L1: `listAllTags` sin `ejercicios` → []; sin tags de texto libre de
 *     otros consultorios (Tag es global, sin tenantId).
 *   - B-L2: `listPlanTemplates` → [] sin `plantillas`.
 *   - B-L3: "usadas" de la autorización en el motor con el mismo criterio que
 *     el detalle (`sessionDayKey`: excepción legacy 00:00Z).
 *
 * Base real + `getActor()` real (integration-setup). Estado de partida por
 * insert directo con el owner (plan-factory): es lo que dejaría la agenda o el
 * motor, no lo que se testea. Dos roles (app + owner BYPASSRLS). TZ=UTC.
 * Fechas de turnos en 2030 (futuro).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { setBookingCopagoPaid, setBookingInsurerPaid } from "@/lib/bookings";
import { listAllTags } from "@/lib/exercises";
import { listPlanTemplates } from "@/lib/plan-templates";
import { authorizationInputOf } from "@/lib/plans-load-internal";
import { sessionDayKey } from "@/lib/plans-read-internal";
import { createPlan, addPlanBooking } from "@/tests/helpers/plan-factory";
import { ownerClient, createEphemeralTenant, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("P2-Z · cobro previo ↔ reemplazo (B-M3)", () => {
  let db: PrismaClient;
  let K: EphemeralTenant;

  beforeAll(async () => {
    db = ownerClient();
    K = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "PRO" });
    asUser(K.userId);
  });
  afterAll(async () => {
    await K?.cleanup();
    await db?.$disconnect();
  });

  let day = 0;
  /** Sesión de $5.000 con un turno previo cancelado (cobrado o no) y su reemplazo activo futuro. */
  async function fixture(o: { priorPaid: "copago" | "insurer" | null; replacementCopago: number; status?: "CANCELLED" | "NO_SHOW" }) {
    day += 1;
    const plan = await createPlan(db, K, { sessions: 1 });
    const sessionId = plan.sessionIds[0];
    const oldAt = new Date(Date.UTC(2030, 0, day, 13));
    const newAt = new Date(Date.UTC(2030, 1, day, 13));
    await db.session.update({ where: { id: sessionId }, data: { scheduledFor: newAt } });
    const oldId = await addPlanBooking(db, K, {
      patientId: plan.patientId, programId: plan.programId, sessionId,
      status: o.status ?? "CANCELLED", scheduledFor: oldAt, copagoCents: 500_000, pricedByPlan: true,
    });
    if (o.priorPaid === "copago") await db.booking.update({ where: { id: oldId }, data: { paymentStatus: "PAID" } });
    if (o.priorPaid === "insurer") await db.booking.update({ where: { id: oldId }, data: { insurerPaidAt: oldAt } });
    const newId = await addPlanBooking(db, K, {
      patientId: plan.patientId, programId: plan.programId, sessionId,
      status: "CONFIRMED", scheduledFor: newAt, copagoCents: o.replacementCopago, pricedByPlan: true,
    });
    return { oldId, newId };
  }
  const get = (id: string) => db.booking.findUniqueOrThrow({ where: { id } });

  it("[P2-Z] (a) desmarcar el cobro previo re-estampa el reemplazo a la cuota", async () => {
    const { oldId, newId } = await fixture({ priorPaid: "copago", replacementCopago: 0 });
    const r = await setBookingCopagoPaid(oldId, false);
    expect(r.ok).toBe(true);
    expect(r.ok && r.data.notice).toMatch(/vuelve a la cuota del plan/);
    expect(await get(oldId)).toMatchObject({ paymentStatus: "UNPAID" });
    expect(await get(newId)).toMatchObject({ copagoCents: 500_000, pricedByPlan: true, paymentStatus: "UNPAID" });
  });

  it("[P2-Z] (b) marcar cobrado un previo con reemplazo a precio pleno → reemplazo a $0", async () => {
    const { oldId, newId } = await fixture({ priorPaid: null, replacementCopago: 500_000, status: "NO_SHOW" });
    const r = await setBookingCopagoPaid(oldId, true);
    expect(r.ok && r.data.notice).toMatch(/ya quedó paga/);
    expect(await get(newId)).toMatchObject({ copagoCents: 0, pricedByPlan: true });
    // Y de vuelta: desmarcar lo devuelve a la cuota (ida y vuelta sin pagar dos veces ni nunca).
    const back = await setBookingCopagoPaid(oldId, false);
    expect(back.ok).toBe(true);
    expect(await get(newId)).toMatchObject({ copagoCents: 500_000, pricedByPlan: true });
  });

  it("[P2-Z] (b') OS pagada en el previo también cuenta como cobro previo", async () => {
    const { oldId, newId } = await fixture({ priorPaid: null, replacementCopago: 500_000 });
    const r = await setBookingInsurerPaid(oldId, true);
    expect(r.ok).toBe(true);
    expect(await get(newId)).toMatchObject({ copagoCents: 0 });
    expect((await setBookingInsurerPaid(oldId, false)).ok).toBe(true);
    expect(await get(newId)).toMatchObject({ copagoCents: 500_000 });
  });

  it("[P2-Z] reemplazo ya cobrado: no se toca su plata, solo notice", async () => {
    const { oldId, newId } = await fixture({ priorPaid: null, replacementCopago: 500_000 });
    await db.booking.update({ where: { id: newId }, data: { paymentStatus: "PAID" } });
    const before = await get(newId);
    const r = await setBookingCopagoPaid(oldId, true);
    expect(r.ok).toBe(true);
    expect(r.ok && r.data.notice).toMatch(/revisá su cobro a mano/);
    expect(await get(oldId)).toMatchObject({ paymentStatus: "PAID" });
    expect(await get(newId)).toMatchObject({ copagoCents: 500_000, paymentStatus: "PAID", updatedAt: before.updatedAt });
  });

  it("sin cambio necesario (reemplazo ya en la cuota correcta) → sin notice; un turno suelto no se ve afectado", async () => {
    const { oldId } = await fixture({ priorPaid: "copago", replacementCopago: 0 });
    // Marcarlo cobrado otra vez por OS: el reemplazo ya está en $0.
    const r = await setBookingInsurerPaid(oldId, true);
    expect(r.ok && r.data.notice).toBeUndefined();
    const loose = await addPlanBooking(db, K, { patientId: null, status: "CANCELLED", scheduledFor: new Date(Date.UTC(2030, 5, 1, 13)), copagoCents: 100 });
    const l = await setBookingCopagoPaid(loose, true);
    expect(l.ok && l.data.notice).toBeUndefined();
  });
});

describe.skipIf(!RUN)("P2-Z · gates de módulo y tags (B-L1, B-L2)", () => {
  let db: PrismaClient;
  let K: EphemeralTenant; // KINESIOLOGY FREE: ejercicios sí, plantillas no
  let B: EphemeralTenant; // otro consultorio KINESIOLOGY PRO
  let G: EphemeralTenant; // GENERAL: sin ejercicios ni plantillas
  const s = uniqueSuffix();
  const slugs = { foreign: `zz-p2z-ajeno-${s}`, own: `zz-p2z-propio-${s}`, orphan: `zz-p2z-huerfano-${s}`, global: `zz-p2z-global-${s}` };
  let globalExerciseId = "";

  async function exercise(tenantId: string | null, tagSlug: string): Promise<string> {
    const tag = await db.tag.create({ data: { slug: tagSlug, label: tagSlug, kind: "GOAL" } });
    const e = await db.exercise.create({ data: { slug: `zz-p2z-ex-${randomUUID()}`, name: "Ejercicio P2Z", tenantId } });
    await db.exerciseTag.create({ data: { exerciseId: e.id, tagId: tag.id } });
    return e.id;
  }

  beforeAll(async () => {
    db = ownerClient();
    K = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "FREE" });
    B = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "PRO" });
    G = await createEphemeralTenant(db, { vertical: "GENERAL" });
    await exercise(B.tenantId, slugs.foreign); // texto libre de OTRO consultorio
    await exercise(K.tenantId, slugs.own);
    globalExerciseId = await exercise(null, slugs.global); // curado de la plataforma
    await db.tag.create({ data: { slug: slugs.orphan, label: slugs.orphan, kind: "EQUIPMENT" } }); // creado y nunca usado
    for (const t of [K, G]) {
      await db.planTemplate.create({
        data: { tenantId: t.tenantId, authorId: t.practitionerId, name: "Plantilla P2Z", exerciseIds: [] },
      });
    }
  });
  afterAll(async () => {
    await K?.cleanup();
    await B?.cleanup();
    await G?.cleanup();
    if (globalExerciseId) await db.exercise.delete({ where: { id: globalExerciseId } }).catch(() => undefined);
    await db.exerciseTag.deleteMany({ where: { tag: { slug: { in: Object.values(slugs) } } } });
    await db.tag.deleteMany({ where: { slug: { in: Object.values(slugs) } } });
    await db?.$disconnect();
  });

  it("[P2-Z] B-L1: sin `ejercicios` → []", async () => {
    asUser(G.userId);
    expect(await listAllTags()).toEqual([]);
  });

  it("[P2-Z] B-L1: no expone tags de texto libre de otros consultorios ni huérfanos; sí los propios y los curados", async () => {
    asUser(K.userId);
    const got = new Set((await listAllTags()).map((t) => t.slug));
    expect(got.has(slugs.own)).toBe(true);
    expect(got.has(slugs.global)).toBe(true);
    expect(got.has(slugs.foreign)).toBe(false);
    expect(got.has(slugs.orphan)).toBe(false);
    asUser(B.userId);
    const gotB = new Set((await listAllTags()).map((t) => t.slug));
    expect(gotB.has(slugs.foreign)).toBe(true);
    expect(gotB.has(slugs.own)).toBe(false);
  });

  it("[P2-Z] B-L2: listPlanTemplates sin `plantillas` → [] (FREE y GENERAL), aunque haya filas", async () => {
    asUser(K.userId);
    expect(await listPlanTemplates()).toEqual([]);
    asUser(G.userId);
    expect(await listPlanTemplates()).toEqual([]);
  });
});

describe.skipIf(!RUN)("P2-Z · autorización: 'usadas' con el criterio del detalle (B-L3)", () => {
  type P = Parameters<typeof authorizationInputOf>[0];
  const auth = { id: "a1", authorizedSessions: 10, startsOn: new Date("2026-10-05T00:00:00Z"), expiresOn: null };
  // Legacy: sesión del alta vieja a 00:00Z del 05/10 (en AR sería el 04/10 21:00).
  const legacyMidnight = { completedAt: new Date("2026-10-05T12:00:00Z"), scheduledFor: new Date("2026-10-05T00:00:00Z"), bookings: [] };
  // Instante real 05/10 01:00Z = 04/10 22:00 AR: antes del inicio en un plan vinculado.
  const linkedNight = { completedAt: new Date("2026-10-05T12:00:00Z"), scheduledFor: new Date("2026-10-05T01:00:00Z"), bookings: [] };

  it("[P2-Z] plan legacy: la sesión a 00:00Z cuenta por su fecha UTC (igual que plans-read-internal)", () => {
    const p = { schedule: null, authorizations: [auth], sessions: [legacyMidnight] } as unknown as P;
    expect(sessionDayKey(legacyMidnight.scheduledFor, false)).toBe("2026-10-05");
    expect(authorizationInputOf(p)?.usedBefore).toBe(1);
  });

  it("plan vinculado: fecha AR siempre (la de las 22:00 AR del 04/10 no cuenta)", () => {
    const p = { schedule: { v: 1 }, authorizations: [auth], sessions: [linkedNight, legacyMidnight] } as unknown as P;
    expect(authorizationInputOf(p)?.usedBefore).toBe(0);
  });
});
