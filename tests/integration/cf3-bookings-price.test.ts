/**
 * CF3 PR-C1 (§30, D-CF3-1 y D-CF3-2) — precio del profesional en las lecturas de la agenda y en el congelado al cobrar
 * de `lib/bookings.ts`, contra Postgres real y en los dos roles (`kinesoft_app` con RLS y owner BYPASSRLS = prod).
 *
 * Por qué: en TMP el Titular y el otro profesional atienden el mismo servicio y cobran distinto; la agenda le mostraba
 * a un particular el copago de la fila «Particular» (o el precio del servicio) sin importar quién lo atendía. La
 * escalera pura ya recibe `practitionerPriceCents` (PR-K, lib/copago.ts); acá se afirma que los callers de la agenda
 * se lo pasan (= `PractitionerService.priceCents` del par profesional × servicio del turno) junto con
 * `insurerIsParticular`, y que el cobro a mano estampa ese monto y después ya no se mueve.
 *
 * Actions REALES con `getActor()` real (solo se mockea la sesión, tests/helpers/integration-setup.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { listAgendaBookings, listBookingsInRange, setBookingCopagoPaid } from "@/lib/bookings";
import { localToARIso } from "@/lib/datetime-ar";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  addInsurer,
  sweepOrphanTestTenants,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";
const DAY = "2031-03-12";
const ar = (hhmm: string) => new Date(localToARIso(`${DAY}T${hhmm}:00`));
const range = { from: new Date(localToARIso(`${DAY}T00:00:00`)), to: new Date(localToARIso(`${DAY}T23:59:00`)) };

// Montos del fixture (centavos): servicio 5000 (factory), precio del profesional A 12000, «Particular» 3000, OS 2500.
const SERVICE = 5000;
const PRICE_A = 12000;
const PARTICULAR = 3000;
const OS_COPAGO = 2500;

describe.skipIf(!RUN)("CF3 PR-C1 · precio del profesional en la agenda y al cobrar", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let kineB: { userId: string; practitionerId: string };
  let osId: string;
  let minute = 0;

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    A = await createEphemeralTenant(db);
    kineB = await addPractitioner(db, A, "PRACTITIONER");
    // Profesional A (el titular) con precio propio para «Consulta»; B sin fila (hereda).
    await db.practitionerService.create({
      data: { tenantId: A.tenantId, practitionerId: A.practitionerId, serviceId: A.serviceId, priceCents: PRICE_A },
    });
    await db.insurer.update({ where: { id: A.particularInsurerId }, data: { copagoCents: PARTICULAR } });
    osId = await addInsurer(db, A, { name: "OSDE CF3", copagoCents: OS_COPAGO });
  });

  afterAll(async () => {
    await A?.cleanup();
    await db?.$disconnect();
  });

  /** Turno fixture: cada uno en su minuto (no chocan entre sí ni con el índice único parcial). */
  async function seed(practitionerId: string, patientId: string) {
    minute += 1;
    const hh = String(9 + Math.floor(minute / 60)).padStart(2, "0");
    const mm = String(minute % 60).padStart(2, "0");
    return db.booking.create({
      data: {
        tenantId: A.tenantId,
        practitionerId,
        serviceId: A.serviceId,
        patientId,
        scheduledFor: ar(`${hh}:${mm}`),
        durationMin: 45,
        status: "CONFIRMED",
        idempotencyKey: randomUUID(),
      },
    });
  }

  /** Copago del turno en las DOS proyecciones; tienen que coincidir siempre (paridad de bookings-reception:672). */
  async function copagoOf(bookingId: string): Promise<number> {
    asUser(A.userId);
    const [light, full] = await Promise.all([listAgendaBookings(range), listBookingsInRange(range)]);
    const l = light.find((r) => r.id === bookingId)!;
    const f = full.find((r) => r.id === bookingId)!;
    expect(l.copagoCents).toBe(f.copagoCents);
    expect(l.obraSocial).toBe(f.obraSocial);
    return l.copagoCents;
  }

  it("[CF3-PRC1] particular sin cobertura: A cobra su precio, B (sin fila) hereda «Particular»", async () => {
    const pat = await addPatient(db, A);
    const a = await seed(A.practitionerId, pat);
    const b = await seed(kineB.practitionerId, pat);
    expect(await copagoOf(a.id)).toBe(PRICE_A);
    expect(await copagoOf(b.id)).toBe(PARTICULAR);
  });

  it("[CF3-PRC2] cobertura a la fila «Particular»: gana el precio del profesional sobre el copago de esa fila", async () => {
    const pat = await addPatient(db, A);
    await db.coverage.create({ data: { patientId: pat, insurer: "Particular", insurerId: A.particularInsurerId } });
    const a = await seed(A.practitionerId, pat);
    const b = await seed(kineB.practitionerId, pat);
    expect(await copagoOf(a.id)).toBe(PRICE_A);
    expect(await copagoOf(b.id)).toBe(PARTICULAR);
  });

  it("[CF3-PRC3] OS real con copago: gana la OS para los dos profesionales", async () => {
    const pat = await addPatient(db, A);
    await db.coverage.create({ data: { patientId: pat, insurer: "OSDE CF3", insurerId: osId } });
    const a = await seed(A.practitionerId, pat);
    const b = await seed(kineB.practitionerId, pat);
    expect(await copagoOf(a.id)).toBe(OS_COPAGO);
    expect(await copagoOf(b.id)).toBe(OS_COPAGO);
  });

  it("[CF3-PRC4] OS de texto libre (sin fila del catálogo): el precio del profesional reemplaza al del servicio", async () => {
    const pat = await addPatient(db, A);
    await db.coverage.create({ data: { patientId: pat, insurer: "Mutual sin convenio", insurerId: null } });
    const a = await seed(A.practitionerId, pat);
    const b = await seed(kineB.practitionerId, pat);
    expect(await copagoOf(a.id)).toBe(PRICE_A);
    expect(await copagoOf(b.id)).toBe(SERVICE);
  });

  it("[CF3-PRC5] cobrar a mano congela el precio del profesional; después ni el precio ni reasignar lo mueven", async () => {
    const pat = await addPatient(db, A);
    const bk = await seed(A.practitionerId, pat);
    asUser(A.userId);
    const r = await setBookingCopagoPaid(bk.id, { paid: true, method: "CASH" }, bk.updatedAt.toISOString());
    expect(r.ok).toBe(true);
    const row = await db.booking.findUniqueOrThrow({ where: { id: bk.id } });
    expect(row.copagoCents).toBe(PRICE_A);
    // El audit lleva el monto congelado (lo que se cobró).
    const audit = await db.auditEvent.findFirst({
      where: { tenantId: A.tenantId, entityId: bk.id },
      orderBy: { createdAt: "desc" },
      select: { payload: true },
    });
    expect((audit?.payload as { copagoCents?: number } | null)?.copagoCents).toBe(PRICE_A);

    // D-CF3-2: una vez cobrado, ni el precio nuevo del profesional ni reasignar el turno cambian el monto.
    await db.practitionerService.update({
      where: { practitionerId_serviceId: { practitionerId: A.practitionerId, serviceId: A.serviceId } },
      data: { priceCents: PRICE_A + 1000 },
    });
    await db.booking.update({ where: { id: bk.id }, data: { practitionerId: kineB.practitionerId } });
    expect(await copagoOf(bk.id)).toBe(PRICE_A);
    await db.practitionerService.update({
      where: { practitionerId_serviceId: { practitionerId: A.practitionerId, serviceId: A.serviceId } },
      data: { priceCents: PRICE_A },
    });
  });

  it("[CF3-PRC6] reasignar ANTES de cobrar: el monto sigue al profesional actual y se congela el de B", async () => {
    const pat = await addPatient(db, A);
    const bk = await seed(A.practitionerId, pat);
    expect(await copagoOf(bk.id)).toBe(PRICE_A);
    const moved = await db.booking.update({ where: { id: bk.id }, data: { practitionerId: kineB.practitionerId } });
    expect(await copagoOf(bk.id)).toBe(PARTICULAR);
    asUser(A.userId);
    const r = await setBookingCopagoPaid(bk.id, { paid: true, method: "CASH" }, moved.updatedAt.toISOString());
    expect(r.ok).toBe(true);
    expect((await db.booking.findUniqueOrThrow({ where: { id: bk.id } })).copagoCents).toBe(PARTICULAR);
  });

  it("[CF3-PRC7] cobertura a la fila «Particular» al cobrar: estampa el precio del profesional (no el copago de la fila)", async () => {
    const pat = await addPatient(db, A);
    await db.coverage.create({ data: { patientId: pat, insurer: "Particular", insurerId: A.particularInsurerId } });
    const bk = await seed(A.practitionerId, pat);
    asUser(A.userId);
    const r = await setBookingCopagoPaid(bk.id, { paid: true, method: "TRANSFER" }, bk.updatedAt.toISOString());
    expect(r.ok).toBe(true);
    expect((await db.booking.findUniqueOrThrow({ where: { id: bk.id } })).copagoCents).toBe(PRICE_A);
  });

  it("[CF3-PRC8] con OS real al cobrar: estampa el copago de la OS aunque el profesional tenga precio", async () => {
    const pat = await addPatient(db, A);
    await db.coverage.create({ data: { patientId: pat, insurer: "OSDE CF3", insurerId: osId } });
    const bk = await seed(A.practitionerId, pat);
    asUser(A.userId);
    const r = await setBookingCopagoPaid(bk.id, { paid: true, method: "CASH" }, bk.updatedAt.toISOString());
    expect(r.ok).toBe(true);
    expect((await db.booking.findUniqueOrThrow({ where: { id: bk.id } })).copagoCents).toBe(OS_COPAGO);
  });
});
