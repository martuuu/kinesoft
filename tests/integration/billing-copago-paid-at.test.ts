/**
 * P3.Z (F1, revisor b · B1) · re-marcar un copago ya PAID no mueve su fecha.
 *
 * `copagoPaidAt` (M3a) es la fecha con la que el widget de ingresos cuenta el
 * copago en la semana/mes (S14r). Antes `setBookingCopagoPaid(id, true)` la
 * reescribía con `new Date()` aunque el turno ya estuviera PAID: un segundo
 * "Cobrado" (otra pestaña, doble click con el `updatedAt` nuevo, la Facturación
 * agrupada) movía el cobro de mes. Ahora, si ya estaba PAID, la fecha queda.
 * Desmarcar la sigue limpiando.
 *
 * Actions reales contra Postgres, en los dos roles (`kinesoft_app` y owner
 * BYPASSRLS). Se mockea solo la sesión de Supabase y `next/cache`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { setBookingCopagoPaid, setBookingInsurerPaid } from "@/lib/bookings";
import { ownerClient, createEphemeralTenant, addPatient, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("[P3-Z] copagoPaidAt idempotente al re-marcar", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
  });

  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });

  async function booking(o: { paymentStatus?: "PAID" | "UNPAID"; copagoPaidAt?: Date | null; insurerPaidAt?: Date | null } = {}) {
    return db.booking.create({
      data: {
        tenantId: T.tenantId,
        patientId: await addPatient(db, T),
        practitionerId: T.practitionerId,
        serviceId: T.serviceId,
        scheduledFor: new Date(Date.now() - 40 * 86_400_000),
        durationMin: 45,
        idempotencyKey: randomUUID(),
        status: "COMPLETED",
        copagoCents: 300_000,
        paymentStatus: o.paymentStatus ?? "UNPAID",
        copagoPaidAt: o.copagoPaidAt ?? null,
        insurerPaidAt: o.insurerPaidAt ?? null,
      },
    });
  }
  const row = (id: string) => db.booking.findUniqueOrThrow({ where: { id } });

  it("marcar → re-marcar (más tarde) no cambia la fecha; desmarcar → null; volver a marcar → fecha nueva", async () => {
    asUser(T.userId);
    // Cobrado el mes pasado (la fila "avanzó" en el tiempo).
    const lastMonth = new Date(Date.now() - 35 * 86_400_000);
    const b = await booking({ paymentStatus: "PAID", copagoPaidAt: lastMonth });

    const again = await setBookingCopagoPaid(b.id, true, b.updatedAt.toISOString());
    expect(again).toMatchObject({ ok: true });
    const r1 = await row(b.id);
    expect(r1.paymentStatus).toBe("PAID");
    expect(r1.copagoPaidAt?.toISOString()).toBe(lastMonth.toISOString());

    const off = await setBookingCopagoPaid(b.id, false, r1.updatedAt.toISOString());
    expect(off).toMatchObject({ ok: true });
    expect(await row(b.id)).toMatchObject({ paymentStatus: "UNPAID", copagoPaidAt: null });

    const before = Date.now();
    const on = await setBookingCopagoPaid(b.id, true, (await row(b.id)).updatedAt.toISOString());
    expect(on).toMatchObject({ ok: true });
    const r3 = await row(b.id);
    expect(r3.paymentStatus).toBe("PAID");
    expect(r3.copagoPaidAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("marcar dos veces seguidas (sin expectedUpdatedAt) deja la fecha del primero", async () => {
    asUser(T.userId);
    const b = await booking();
    expect(await setBookingCopagoPaid(b.id, true)).toMatchObject({ ok: true });
    const first = (await row(b.id)).copagoPaidAt;
    expect(first).not.toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(await setBookingCopagoPaid(b.id, true)).toMatchObject({ ok: true });
    expect((await row(b.id)).copagoPaidAt?.toISOString()).toBe(first!.toISOString());
  });

  it("OS: re-marcar una OS ya cobrada no mueve `insurerPaidAt`; desmarcar → null; volver a marcar → fecha nueva", async () => {
    asUser(T.userId);
    const lastMonth = new Date(Date.now() - 35 * 86_400_000);
    const b = await booking({ insurerPaidAt: lastMonth });

    expect(await setBookingInsurerPaid(b.id, true, b.updatedAt.toISOString())).toMatchObject({ ok: true });
    const r1 = await row(b.id);
    expect(r1.insurerPaidAt?.toISOString()).toBe(lastMonth.toISOString());

    expect(await setBookingInsurerPaid(b.id, false, r1.updatedAt.toISOString())).toMatchObject({ ok: true });
    expect((await row(b.id)).insurerPaidAt).toBeNull();

    const before = Date.now();
    expect(await setBookingInsurerPaid(b.id, true, (await row(b.id)).updatedAt.toISOString())).toMatchObject({ ok: true });
    expect((await row(b.id)).insurerPaidAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });
});
