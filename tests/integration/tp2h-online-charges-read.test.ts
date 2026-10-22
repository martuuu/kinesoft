/**
 * T5 · [TP-2h] Lecturas de cobros online del staff (plan §25, contrato C-TP9: `lib/online-charges-read.ts`).
 *
 * Nace en TP-K2 (tanda T5c) como `it.fails`: las tres lecturas son stubs que devuelven «todavía no disponible» sin
 * tocar la base. El Anexo C no trae títulos literales para estas lecturas (solo «[TP-3c] sin pistas no llama a
 * `getBookingOnlineCharges`», que es de UI): estos títulos los fija TP-K2 y TP-2h los da vuelta y completa (cobros
 * sembrados de los dos orígenes, aislamiento con `kinesoft_app`, DTO sin token ni `rawPayload`).
 *
 * Actions reales contra Postgres, en los dos roles. Se mockea la sesión de Supabase y `next/cache` (integration-setup).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { getBookingOnlineCharges, listOnlineCharges, listPatientOnlineCharges } from "@/lib/online-charges-read";
import { ownerClient, createEphemeralTenant, addPatient, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("[TP-2h] lecturas de cobros online", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let pat: string;

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
    pat = await addPatient(db, T);
  });

  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });

  it.fails("[TP-2h] getBookingOnlineCharges: un turno propio sin cobros devuelve una lista vacía", async () => {
    const b = await db.booking.create({
      data: {
        tenantId: T.tenantId,
        patientId: pat,
        practitionerId: T.practitionerId,
        serviceId: T.serviceId,
        scheduledFor: new Date(Date.now() + 86_400_000),
        durationMin: 45,
        status: "CONFIRMED",
        paymentStatus: "UNPAID",
        idempotencyKey: randomUUID(),
      },
    });
    asUser(T.userId);
    expect(await getBookingOnlineCharges({ bookingId: b.id })).toEqual({ ok: true, data: [] });
  });

  it.fails("[TP-2h] listOnlineCharges: consultorio sin cobros → sin filas, sin cursor y resumen en 0", async () => {
    asUser(T.userId);
    expect(await listOnlineCharges({})).toEqual({
      ok: true,
      data: { rows: [], nextCursor: null, summary: { paidCents: 0, liveCount: 0, liveCents: 0 } },
    });
  });

  it.fails("[TP-2h] listPatientOnlineCharges: paciente propio sin cobros devuelve una lista vacía", async () => {
    asUser(T.userId);
    expect(await listPatientOnlineCharges({ patientId: pat })).toEqual({ ok: true, data: [] });
  });
});
