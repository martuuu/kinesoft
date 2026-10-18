/**
 * [T3Z-s2] T3-Z, revisor (a) B1 y B3: dos carreras de concurrencia en el equipo y en los cobros.
 *
 *  - B1: `changeMemberRoleInTx` escribe las delegaciones que trae el rol destino (`grantsOnEnterRole`) calculadas
 *    sobre la fila LEÍDA. El CAS miraba solo `role` + `clinical`: un cambio de permisos del Titular commiteado entre
 *    la lectura y el UPDATE se pisaba en silencio. Ahora, si el rol toca las delegaciones, el CAS las incluye y la
 *    carrera da `RoleChangeRaceError`. La interleaving se arma con un tx que, justo después de la lectura del
 *    miembro, escribe el permiso (lo que vería el UPDATE si otra tx hubiera commiteado en el medio).
 *  - B3: el desmarcar del copago (`setBookingCopagoPaid`) leía el `Payment` sin tomar la fila del turno; el webhook de
 *    MP la toma (`SELECT … FOR UPDATE`) y, con un turno ya marcado a mano, escribe el `Payment` PAID sin tocar el
 *    turno. Carrera real con dos conexiones: una tx «webhook» tiene la fila y el pago sin commitear, el desmarcar
 *    espera, el webhook commitea → el desmarcar ve el pago y lo rechaza (antes: no esperaba en la lectura, el CAS por
 *    `updatedAt` pasaba y el turno quedaba «por cobrar» con la plata de MP acreditada).
 *
 * Símbolos reales contra Postgres, en los dos roles. Se mockean solo la sesión y `next/cache`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { RoleChangeRaceError, changeMemberRoleInTx, runTeamTx, type TeamActorCtx } from "@/lib/team-internal";
import type { DbClient } from "@/lib/rls";
import { setBookingCopagoPaid } from "@/lib/bookings";
import { COLLECT_COPY } from "@/lib/booking-collect";
import { ownerClient, createEphemeralTenant, addPatient, addPractitioner, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("[T3Z-s2] carreras del equipo y del cobro", () => {
  let db: PrismaClient;
  let webhookDb: PrismaClient;
  let T: EphemeralTenant;

  beforeAll(async () => {
    db = ownerClient();
    webhookDb = ownerClient();
    T = await createEphemeralTenant(db, { plan: "PRO", saasPlan: "LIBRE" });
  });

  afterAll(async () => {
    await T?.cleanup();
    await webhookDb?.$disconnect();
    await db?.$disconnect();
  });

  it("[T3Z-s2] B1: un cambio de permisos commiteado entre la lectura y el CAS del cambio de rol → RoleChangeRaceError, nada pisado", async () => {
    // Profesional con «Planes y pagos» delegado y sin «Configuración». Pasar a Secretaria le saca «Planes y pagos»
    // (grantsChanged): el UPDATE escribe { grantSettings: false, grantBilling: false } calculado sobre lo leído.
    const kine = await addPractitioner(db, T);
    const m = await db.membership.update({
      where: { userId_tenantId: { userId: kine.userId, tenantId: T.tenantId } },
      data: { grantSettings: false, grantBilling: true },
    });
    const ctx: TeamActorCtx = { via: "tenant", tenantId: T.tenantId, actorUserId: T.userId, actorRole: "OWNER", actorRef: null };

    let interleaved = false;
    const run = runTeamTx(ctx, (tx) => {
      // Entre la lectura del miembro (`findMemberInTx`) y el CAS, el Titular le delega «Configuración».
      const membership = new Proxy(tx.membership, {
        get(target, prop, recv) {
          const real = Reflect.get(target, prop, recv);
          if (prop !== "findFirst" || interleaved) return real;
          return async (args: { where?: { id?: unknown } }) => {
            const found = await real.call(target, args);
            if (args?.where?.id === m.id) {
              interleaved = true;
              await tx.membership.update({ where: { id: m.id }, data: { grantSettings: true } });
            }
            return found;
          };
        },
      });
      const racy = new Proxy(tx, {
        get: (target, prop, recv) => (prop === "membership" ? membership : Reflect.get(target, prop, recv)),
      }) as DbClient;
      return changeMemberRoleInTx(racy, ctx, { membershipId: m.id, role: "ASSISTANT" });
    });
    await expect(run).rejects.toBeInstanceOf(RoleChangeRaceError);
    expect(interleaved).toBe(true);
    // Rollback de toda la tx: ni el rol nuevo ni (en este armado) el permiso intercalado.
    expect(await db.membership.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({
      role: "PRACTITIONER",
      grantSettings: false,
      grantBilling: true,
    });
  });

  it("[T3Z-s2] B3: desmarcar el copago mientras el webhook de MP tiene la fila → espera y lo rechaza (pago de MP acreditado)", async () => {
    const paidAt = new Date(Date.now() - 2 * 86_400_000);
    const b = await db.booking.create({
      data: {
        tenantId: T.tenantId,
        patientId: await addPatient(db, T),
        practitionerId: T.practitionerId,
        serviceId: T.serviceId,
        scheduledFor: new Date(Date.now() - 3 * 86_400_000),
        durationMin: 45,
        status: "COMPLETED",
        copagoCents: 6_000_00,
        // Marcado a mano (efectivo) ANTES de que llegue el webhook «approved» del mismo turno.
        paymentStatus: "PAID",
        copagoPaidAt: paidAt,
        copagoPaymentMethod: "CASH",
        idempotencyKey: randomUUID(),
      },
    });
    asUser(T.userId);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let pidReady!: (pid: number) => void;
    const pidP = new Promise<number>((r) => (pidReady = r));
    // Lo que hace `consumeWebhook` con un turno ya PAID: FOR UPDATE del turno → crea el Payment PAID → no toca el
    // turno (`next === bk.paymentStatus`). Se queda abierta hasta que el desmarcar esté esperando.
    const webhook = webhookDb.$transaction(
      async (tx) => {
        const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        await tx.$queryRaw`SELECT "id" FROM "Booking" WHERE "id" = ${b.id} FOR UPDATE`;
        await tx.payment.create({
          data: { bookingId: b.id, status: "PAID", amountCents: 6_000_00, externalId: `mp-${randomUUID()}` },
        });
        pidReady(pid);
        await gate;
      },
      { timeout: 20_000 }
    );
    const holder = await pidP;
    const unmark = setBookingCopagoPaid(b.id, { paid: false }, b.updatedAt.toISOString());
    // Sin bloqueo probado, el test no probó la carrera (anti-false-green): esperar a que alguien espere al webhook.
    const deadline = Date.now() + 5_000;
    for (;;) {
      const [{ n }] = await db.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${holder}::int = ANY(pg_blocking_pids(pid))`;
      if (n > 0) break;
      if (Date.now() > deadline) throw new Error("el desmarcar nunca esperó la fila del webhook");
      await new Promise((r) => setTimeout(r, 25));
    }
    release();
    await webhook;
    expect(await unmark).toEqual({ ok: false, error: COLLECT_COPY.mercadoPagoLocked });
    expect(await db.booking.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({
      paymentStatus: "PAID",
      copagoPaymentMethod: "CASH",
      copagoPaidAt: paidAt,
    });
  });
});
