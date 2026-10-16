/**
 * ES4 S26s · Soak de turnos de plan: N rondas concurrentes de alta y
 * reprogramación sobre las MISMAS claves de cupo, sin deadlocks ni P2002 crudos.
 *
 * Por qué: S11x (plans-concurrency) prueba cada carrera de a dos o tres con
 * barreras deterministas y un orden de llegada fijo. Lo que no cubría es el
 * régimen sostenido: varias rondas seguidas donde el alta de plan (lock de
 * paciente + cupo por día, en orden), el doble clic del mismo alta (misma
 * `idempotencyKey`), la reprogramación de un turno de plan desde la agenda
 * (`updateBooking`), la de una sesión desde Seguimiento (`rescheduleSession`) y
 * un turno suelto (`createBooking`) piden las mismas claves de cupo en órdenes
 * CRUZADOS (una reprogramación va del día 1 al 11 y la otra del 11 al 1). Un
 * orden de locks inconsistente se ve acá como 40P01; un único sin traducir,
 * como un P2002 que llega al cliente o un "No pudimos …" genérico.
 *
 * Qué afirma, por ronda y al final (efecto observable en la base):
 *   - ninguna action TIRA (todas devuelven un resultado de dominio) y ningún
 *     error es genérico, P2002, "Unique constraint" ni deadlock;
 *   - el doble clic del alta da UN plan (el otro: idempotente o stale);
 *   - cupo 1: ningún instante con dos turnos activos sin sobreturno;
 *   - los planes creados quedan completos (sesiones vivas = total, un turno
 *     activo por sesión) y el plan reprogramado conserva sus 2 turnos;
 *   - `pg_stat_database.deadlocks` no sube en toda la corrida (cuenta también
 *     los 40P01 que `withTxConflictRetry` absorbe en silencio).
 *
 * Símbolos reales con el `getActor()` real; solo se mockea la sesión de
 * Supabase y `next/cache` (integration-setup). Dos roles de DB. Fechas en 2032
 * (futuro), TZ=UTC: 10:00 AR = 13:00Z.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createPlan, previewPlan } from "@/lib/plans";
import type { PlanCreateInput, PlanPreview, PlanRowResolution } from "@/lib/plans-types";
import { createBooking, updateBooking } from "@/lib/bookings";
import { rescheduleSession } from "@/lib/sessions";
import { addDays } from "@/lib/availability/day";
import { ownerClient, createEphemeralTenant, addPatient, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { createPlan as seedPlan, addPlanBooking } from "@/tests/helpers/plan-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

/** Rondas del soak. Cada una lanza 7 escrituras a la vez sobre las mismas 4 claves de cupo. */
const ROUNDS = 6;
/** Primer lunes del soak (2032-01-05 es lunes); cada ronda corre 3 semanas para no pisar la anterior. */
const FIRST_MONDAY = "2032-01-05";

/** Lunes y jueves 10:00 AR (C6: 0=Dom). */
const LUN_JUE_10 = {
  v: 1 as const,
  frequency: "weekly" as const,
  slots: [
    { dow: 1 as const, startMin: 600 },
    { dow: 4 as const, startMin: 600 },
  ],
};
/** hh:00 AR del día → instante (AR = UTC-3 sin DST). */
const atAR = (dayKey: string, hour: number) => new Date(`${dayKey}T${String(hour + 3).padStart(2, "0")}:00:00.000Z`);

/** Errores que NO pueden llegar al cliente: excepción enmascarada, único crudo o deadlock. */
const FORBIDDEN = /No pudimos|P2002|Unique constraint|40P01|deadlock|P2034|Transaction failed/i;

function acceptDefaults(p: PlanPreview): PlanRowResolution[] {
  return p.rows.map((r) =>
    r.defaultResolution === "move"
      ? { index: r.index, kind: "move", at: r.suggestion }
      : r.defaultResolution === "adopt"
        ? { index: r.index, kind: "adopt", bookingId: r.flags.duplicate!.bookingId, expectedUpdatedAt: r.flags.duplicate!.updatedAt }
        : { index: r.index, kind: r.defaultResolution }
  ) as PlanRowResolution[];
}

/** Texto de un resultado `{ ok:false }` (error o kind) para el reporte y el chequeo de `FORBIDDEN`. */
function failText(r: unknown): string {
  const x = r as { ok?: boolean; error?: string; kind?: string };
  if (x?.ok) return "";
  return `${x?.kind ?? ""} ${x?.error ?? ""}`.trim() || JSON.stringify(r).slice(0, 200);
}

describe.skipIf(!RUN)("ES4 S26s · soak de turnos de plan (alta ∥ doble clic ∥ reprogramaciones cruzadas ∥ turno suelto)", () => {
  let db: PrismaClient;
  let K: EphemeralTenant;
  /** Resumen de resultados por action y outcome, para el reporte del soak. */
  const tally = new Map<string, number>();
  const count = (key: string) => tally.set(key, (tally.get(key) ?? 0) + 1);

  const deadlocks = async () =>
    Number(
      (await db.$queryRaw<{ d: bigint }[]>`SELECT deadlocks AS d FROM pg_stat_database WHERE datname = current_database()`)[0].d
    );

  beforeAll(async () => {
    db = ownerClient();
    K = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "PRO" });
    // Cupo 1 en el único servicio: todas las escrituras compiten por la clave (profesional, servicio, día AR).
    await db.service.update({ where: { id: K.serviceId }, data: { maxConcurrent: 1 } });
    asUser(K.userId);
  });

  afterAll(async () => {
    console.log("[S26s soak] resultados:", Object.fromEntries([...tally].sort()));
    await K?.cleanup();
    await db?.$disconnect();
  });

  const planInput = (patientId: string, startDayKey: string): PlanCreateInput => ({
    idempotencyKey: randomUUID(),
    patientId,
    discipline: "KINESIOLOGY",
    practitionerId: K.practitionerId,
    serviceId: K.serviceId,
    locationId: null,
    schedule: LUN_JUE_10,
    startDayKey,
    totalSessions: 4,
    pricing: null,
    rows: [],
    stateToken: "x",
  });

  async function prepared(input: PlanCreateInput): Promise<PlanCreateInput> {
    const p = await previewPlan(input);
    if (!p.ok) throw new Error(`preview: ${p.error}`);
    expect(p.preview.rows.map((r) => r.defaultResolution)).toEqual(["create", "create", "create", "create"]);
    return { ...input, stateToken: p.preview.stateToken, rows: acceptDefaults(p.preview) };
  }

  it(
    `${ROUNDS} rondas concurrentes: sin deadlocks, sin P2002 crudos, cupo 1 respetado y planes enteros`,
    async () => {
      const before = await deadlocks();

      for (let r = 0; r < ROUNDS; r++) {
        const D1 = addDays(FIRST_MONDAY, 21 * r); // lunes
        const D4 = addDays(D1, 3); // jueves
        const D8 = addDays(D1, 7);
        const D11 = addDays(D1, 10);
        const slots = [D1, D4, D8, D11].map((d) => atAR(d, 10));

        // Dos altas que quieren las MISMAS 4 sesiones (Lun/Jue 10:00 de dos semanas).
        const pa = await addPatient(db, K);
        const pb = await addPatient(db, K);
        const commitA = await prepared(planInput(pa, D1));
        const commitB = await prepared(planInput(pb, D1));

        // Un plan existente con 2 turnos a las 12:00 del día 1 y del 11: se reprograman CRUZADOS hacia las 10:00
        // (uno 1→11 por la agenda, otro 11→1 por Seguimiento): piden las claves de cupo en órdenes opuestos.
        const seeded = await seedPlan(db, K, { sessions: 2 });
        const c1 = await addPlanBooking(db, K, {
          patientId: seeded.patientId,
          programId: seeded.programId,
          sessionId: seeded.sessionIds[0],
          scheduledFor: atAR(D1, 12),
        });
        const c2 = await addPlanBooking(db, K, {
          patientId: seeded.patientId,
          programId: seeded.programId,
          sessionId: seeded.sessionIds[1],
          scheduledFor: atAR(D11, 12),
        });
        await db.session.update({ where: { id: seeded.sessionIds[0] }, data: { scheduledFor: atAR(D1, 12) } });
        await db.session.update({ where: { id: seeded.sessionIds[1] }, data: { scheduledFor: atAR(D11, 12) } });
        const c1Row = await db.booking.findUniqueOrThrow({ where: { id: c1 }, select: { updatedAt: true } });
        const pd = await addPatient(db, K);

        const runs: Record<string, () => Promise<unknown>> = {
          planA: () => createPlan(commitA),
          planA2: () => createPlan(commitA), // doble clic: misma idempotencyKey
          planB: () => createPlan(commitB),
          moveAgenda: () =>
            updateBooking({
              id: c1,
              scheduledFor: slots[3].toISOString(),
              expectedUpdatedAt: c1Row.updatedAt.toISOString(),
              allowOutOfHours: true,
            }),
          moveSession: () =>
            rescheduleSession({ sessionId: seeded.sessionIds[1], scheduledFor: slots[0].toISOString(), force: { allowOutOfHours: true } }),
          loose: () =>
            createBooking({
              patientId: pd,
              serviceId: K.serviceId,
              practitionerId: K.practitionerId,
              scheduledFor: slots[1].toISOString(),
              durationMin: 45,
              idempotencyKey: randomUUID(),
              allowOutOfHours: true,
            }),
          looseAgain: () =>
            createBooking({
              patientId: pd,
              serviceId: K.serviceId,
              practitionerId: K.practitionerId,
              scheduledFor: slots[2].toISOString(),
              durationMin: 45,
              idempotencyKey: randomUUID(),
              allowOutOfHours: true,
            }),
        };
        const names = Object.keys(runs);
        const settled = await Promise.allSettled(names.map((n) => runs[n]()));

        // 1. Nadie tiró y ningún error es una excepción enmascarada / único crudo / deadlock.
        const thrown = settled
          .map((s, i) => (s.status === "rejected" ? `${names[i]}: ${String((s.reason as Error)?.message ?? s.reason)}` : null))
          .filter(Boolean);
        expect(thrown, `ronda ${r}`).toEqual([]);
        const results = Object.fromEntries(names.map((n, i) => [n, (settled[i] as PromiseFulfilledResult<unknown>).value]));
        for (const n of names) {
          const text = failText(results[n]);
          const idem = (results[n] as { idempotent?: boolean }).idempotent ? " (idempotente)" : "";
          count(`${n}:${text ? text.slice(0, 60) : `ok${idem}`}`);
          expect(text, `ronda ${r} · ${n}`).not.toMatch(FORBIDDEN);
        }

        // 2. Doble clic: UN plan con esa key; los dos resultados apuntan a él o son stale.
        const byKey = await db.treatmentProgram.findMany({
          where: { tenantId: K.tenantId, idempotencyKey: commitA.idempotencyKey },
          select: { id: true },
        });
        expect(byKey.length).toBeLessThanOrEqual(1);
        for (const n of ["planA", "planA2"] as const) {
          const x = results[n] as { ok: boolean; programId?: string; kind?: string };
          if (x.ok) expect(x.programId).toBe(byKey[0]?.id);
          else expect(x.kind, `ronda ${r} · ${n}`).toBe("stale-preview");
        }
        expect((results.planB as { ok: boolean; kind?: string }).ok || (results.planB as { kind?: string }).kind === "stale-preview").toBe(true);

        // 3. Las dos altas compiten por las mismas 4 sesiones con cupo 1: a lo sumo una entra.
        const plansAB = await db.treatmentProgram.findMany({
          where: { tenantId: K.tenantId, patientId: { in: [pa, pb] } },
          select: { id: true, totalSessions: true },
        });
        expect(plansAB.length).toBeLessThanOrEqual(1);
        // 4. Un plan creado queda entero: 4 sesiones vivas y un turno activo por sesión.
        for (const p of plansAB) {
          const live = await db.session.count({ where: { programId: p.id, archivedAt: null } });
          const active = await db.booking.findMany({
            where: { programId: p.id, status: { in: ["PENDING", "CONFIRMED", "COMPLETED"] } },
            select: { sessionId: true },
          });
          expect(live).toBe(p.totalSessions);
          expect(active).toHaveLength(p.totalSessions);
          expect(new Set(active.map((b) => b.sessionId)).size).toBe(active.length);
        }
        // 5. El plan reprogramado conserva sus 2 turnos vinculados (mover no desvincula).
        expect(
          await db.booking.count({ where: { programId: seeded.programId, status: { in: ["PENDING", "CONFIRMED", "COMPLETED"] } } })
        ).toBe(2);
        // 6. Lo que se movió quedó donde dice el resultado; lo que no, donde estaba.
        const moved1 = await db.booking.findUniqueOrThrow({ where: { id: c1 }, select: { scheduledFor: true } });
        expect(moved1.scheduledFor.toISOString()).toBe(((results.moveAgenda as { ok: boolean }).ok ? slots[3] : atAR(D1, 12)).toISOString());
        const moved2 = await db.booking.findUniqueOrThrow({ where: { id: c2 }, select: { scheduledFor: true } });
        expect(moved2.scheduledFor.toISOString()).toBe(((results.moveSession as { ok: boolean }).ok ? slots[0] : atAR(D11, 12)).toISOString());
      }

      // 7. Cupo 1 en TODA la corrida: ningún instante con dos turnos activos sin sobreturno.
      const doubled = await db.$queryRaw<{ at: Date; n: number }[]>`
        SELECT "scheduledFor" AS at, count(*)::int AS n FROM "Booking"
        WHERE "tenantId" = ${K.tenantId} AND status IN ('PENDING','CONFIRMED','COMPLETED') AND NOT "isOverbooked"
        GROUP BY "scheduledFor" HAVING count(*) > 1`;
      expect(doubled).toEqual([]);
      // Hubo carrera de verdad: en todas las rondas alguna escritura perdió contra otra.
      const losses = [...tally].filter(([k]) => !/:ok( \(idempotente\))?$/.test(k)).reduce((a, [, n]) => a + n, 0);
      expect(losses).toBeGreaterThanOrEqual(ROUNDS);

      // 8. Sin deadlocks, ni siquiera los que un reintento hubiera absorbido. El contador de
      // pg_stat_database lo publica el backend que detectó el 40P01 al quedar ocioso (PG ≥ 15: hasta
      // ~10 s después, PGSTAT_IDLE_INTERVAL); se espera ese intervalo UNA vez, al final.
      await new Promise((res) => setTimeout(res, 11_000));
      await db.$executeRaw`SELECT pg_stat_clear_snapshot()`;
      expect(await deadlocks()).toBe(before);
    },
    180_000
  );
});
