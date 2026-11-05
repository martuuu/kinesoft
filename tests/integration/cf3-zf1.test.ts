/**
 * CF3 ZF1 (fixer del cierre de CF3, §30) — hallazgos de plata y permisos de los revisores, contra Postgres real en los
 * dos roles (`kinesoft_app` con RLS y owner BYPASSRLS = prod). Actions REALES con `getActor()` real (solo se mockea la
 * sesión y next/cache, tests/helpers/integration-setup.ts).
 *
 *   • M1: un turno INVITADO (sin paciente) se mostraba en la agenda al precio del servicio, pero al cobrarlo
 *     `toggleBilling` congelaba la escalera del particular (precio del profesional → «Particular» → servicio): la
 *     recepción veía un monto y se estampaba otro. Ahora lo mostrado = lo congelado (agenda liviana, completa y
 *     «Próximos turnos» del dashboard).
 *   • M2: por el camino propio («Mi agenda», `via: "self"`) el profesional cambiaba el cupo por horario
 *     (`concurrencyOverride`/`maxConcurrent`), la anticipación y el horizonte del servicio. D-CF3-7 deja la capacidad
 *     en el consultorio; la anticipación propia ya vive en «Mi agenda» (por profesional, no por servicio).
 *   • B4: la escritura propia de un servicio se filtraba por dueño solo en la LECTURA: una reasignación del Titular
 *     commiteada entre la lectura y el UPDATE dejaba pisar el servicio que ya era de otro.
 *   • Copy: «Solo OWNER/ADMIN…» (roles en inglés) → voseo con el permiso «Configuración».
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { listAgendaBookings, listBookingsInRange, setBookingCopagoPaid } from "@/lib/bookings";
import { getDashboardData } from "@/lib/dashboard";
import { upsertPractitionerService } from "@/lib/practitioner-services";
import { updateService, deleteService } from "@/lib/services";
import { formatARS } from "@/lib/format";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  addStaff,
  sweepOrphanTestTenants,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

const PRICE_A = 12_000;
const PARTICULAR = 3_000;

describe.skipIf(!RUN)("[CF3-ZF1] fixes de plata y permisos del cierre de CF3", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let kineB: { userId: string; practitionerId: string };
  let ana: { userId: string; practitionerId: string };
  let admin: { userId: string; practitionerId: string };
  let secre: { userId: string };
  let serviceName: string;
  let slot = 0;
  const base = Date.now() + 2 * 86_400_000;

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    T = await createEphemeralTenant(db);
    kineB = await addPractitioner(db, T, "PRACTITIONER");
    ana = await addPractitioner(db, T, "PRACTITIONER");
    admin = await addPractitioner(db, T, "ADMIN"); // con «Configuración»
    secre = await addStaff(db, T, "ASSISTANT");
    await db.practitionerService.create({
      data: { tenantId: T.tenantId, practitionerId: T.practitionerId, serviceId: T.serviceId, priceCents: PRICE_A },
    });
    await db.insurer.update({ where: { id: T.particularInsurerId }, data: { copagoCents: PARTICULAR } });
    serviceName = (await db.service.findUniqueOrThrow({ where: { id: T.serviceId } })).name;
  });

  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });

  async function guest(practitionerId: string) {
    return db.booking.create({
      data: {
        tenantId: T.tenantId,
        practitionerId,
        serviceId: T.serviceId,
        patientId: null,
        guestName: "Invitado ZF1",
        scheduledFor: new Date(base + slot++ * 3_600_000),
        durationMin: 45,
        status: "CONFIRMED",
        idempotencyKey: randomUUID(),
      },
    });
  }

  // ── M1 ─────────────────────────────────────────────────────────────────────
  it("[CF3-ZF1-1] invitado: la agenda (liviana y completa) y el dashboard cotizan lo que después se congela", async () => {
    const gA = await guest(T.practitionerId); // A con precio propio → 12000
    const gB = await guest(kineB.practitionerId); // B sin fila → «Particular» 3000
    asUser(T.userId);
    const range = { from: new Date(base - 3_600_000), to: new Date(base + 10 * 3_600_000) };
    const [light, full, dash] = await Promise.all([listAgendaBookings(range), listBookingsInRange(range), getDashboardData()]);
    for (const [bk, want] of [
      [gA, PRICE_A],
      [gB, PARTICULAR],
    ] as const) {
      expect(light.find((r) => r.id === bk.id)?.copagoCents).toBe(want);
      expect(full.find((r) => r.id === bk.id)?.copagoCents).toBe(want);
      expect(dash.next.find((r) => r.id === bk.id)?.tag).toBe(`${serviceName} - ${formatARS(want)}`);
    }
    // Lo que se muestra es lo que se estampa al cobrar.
    for (const [bk, want] of [
      [gA, PRICE_A],
      [gB, PARTICULAR],
    ] as const) {
      const r = await setBookingCopagoPaid(bk.id, { paid: true, method: "CASH" }, bk.updatedAt.toISOString());
      expect(r.ok).toBe(true);
      expect((await db.booking.findUniqueOrThrow({ where: { id: bk.id } })).copagoCents).toBe(want);
    }
  });

  it("[CF3-ZF1-2] invitado con monto propio del turno: se muestra ese monto (no la escalera)", async () => {
    const g = await guest(T.practitionerId);
    await db.booking.update({ where: { id: g.id }, data: { copagoCents: 777 } });
    asUser(T.userId);
    const range = { from: new Date(base - 3_600_000), to: new Date(base + 10 * 3_600_000) };
    const [light, full] = await Promise.all([listAgendaBookings(range), listBookingsInRange(range)]);
    expect(light.find((r) => r.id === g.id)?.copagoCents).toBe(777);
    expect(full.find((r) => r.id === g.id)?.copagoCents).toBe(777);
  });

  // ── M2 ─────────────────────────────────────────────────────────────────────
  it("[CF3-ZF1-3] «Mi agenda» no cambia la capacidad ni la anticipación/horizonte del servicio; «Configuración» sí", async () => {
    const svc = (await db.service.create({ data: { tenantId: T.tenantId, name: "Gimnasio ZF1", durationMin: 60, priceCents: 1000, maxConcurrent: 4 } })).id;
    await db.practitionerService.create({
      data: {
        tenantId: T.tenantId,
        practitionerId: ana.practitionerId,
        serviceId: svc,
        concurrencyOverride: true,
        maxConcurrent: 3,
        minLeadMinutes: 120,
        maxLeadDays: 30,
      },
    });
    const row = () => db.practitionerService.findUniqueOrThrow({ where: { practitionerId_serviceId: { practitionerId: ana.practitionerId, serviceId: svc } } });

    asUser(ana.userId);
    const r = await upsertPractitionerService(ana.practitionerId, svc, {
      enabled: true,
      visibility: "PRIVATE",
      durationMin: 30,
      concurrencyOverride: false,
      maxConcurrent: null,
      minLeadMinutes: 0,
      maxLeadDays: 365,
      notifyOnBooking: true,
      priceCents: 2000,
    });
    expect(r.ok).toBe(true);
    // Lo suyo se guarda (visibilidad, duración, precio, aviso); la capacidad y las ventanas siguen como estaban.
    expect(await row()).toMatchObject({
      visibility: "PRIVATE",
      durationMin: 30,
      priceCents: 2000,
      notifyOnBooking: true,
      concurrencyOverride: true,
      maxConcurrent: 3,
      minLeadMinutes: 120,
      maxLeadDays: 30,
    });

    // Sin fila previa: nace con los defaults (sin cupo propio), aunque el pedido traiga uno.
    const svc2 = (await db.service.create({ data: { tenantId: T.tenantId, name: "Pileta ZF1", durationMin: 60, priceCents: 1000 } })).id;
    const r2 = await upsertPractitionerService(ana.practitionerId, svc2, {
      enabled: true,
      visibility: "PUBLIC",
      concurrencyOverride: true,
      maxConcurrent: 9,
      minLeadMinutes: 10,
      maxLeadDays: 5,
      notifyOnBooking: false,
    });
    expect(r2.ok).toBe(true);
    expect(await db.practitionerService.findUniqueOrThrow({ where: { practitionerId_serviceId: { practitionerId: ana.practitionerId, serviceId: svc2 } } })).toMatchObject({
      concurrencyOverride: false,
      maxConcurrent: null,
      minLeadMinutes: null,
      maxLeadDays: null,
    });

    // Con «Configuración» (otro profesional del consultorio) sí se cambia.
    asUser(admin.userId);
    const r3 = await upsertPractitionerService(ana.practitionerId, svc, {
      enabled: true,
      visibility: "PUBLIC",
      concurrencyOverride: true,
      maxConcurrent: 2,
      minLeadMinutes: 60,
      maxLeadDays: 10,
      notifyOnBooking: false,
    });
    expect(r3.ok).toBe(true);
    expect(await row()).toMatchObject({ concurrencyOverride: true, maxConcurrent: 2, minLeadMinutes: 60, maxLeadDays: 10, priceCents: 2000 });
  });

  // ── B4 ─────────────────────────────────────────────────────────────────────
  it("[CF3-ZF1-4] reasignación commiteada entre la lectura y el UPDATE: el propio no pisa el servicio ajeno", async () => {
    const svc = (await db.service.create({ data: { tenantId: T.tenantId, practitionerId: ana.practitionerId, name: "RPG ZF1", durationMin: 45, priceCents: 1000 } })).id;
    asUser(ana.userId);
    let pending: ReturnType<typeof updateService> | null = null;
    // El Titular reasigna en una tx abierta (tiene el lock de la fila). La edición propia lee el servicio todavía
    // de Ana (lo commiteado), llega al UPDATE y espera el lock; recién ahí se commitea la reasignación.
    await db.$transaction(
      async (t) => {
        await t.service.update({ where: { id: svc }, data: { practitionerId: kineB.practitionerId } });
        const [{ pid }] = await t.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        pending = updateService(svc, { priceCents: 99_999 });
        const deadline = Date.now() + 15_000;
        for (;;) {
          const [{ n }] = await db.$queryRaw<{ n: number }[]>`
            SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`;
          if (n > 0) break;
          if (Date.now() > deadline) throw new Error("la edición propia nunca llegó a esperar el lock del servicio");
          await new Promise((r) => setTimeout(r, 50));
        }
      },
      { timeout: 20_000 }
    );
    const r = await pending!;
    expect(r.ok).toBe(false);
    const after = await db.service.findUniqueOrThrow({ where: { id: svc } });
    expect(after.practitionerId).toBe(kineB.practitionerId);
    expect(after.priceCents).toBe(1000);
  });

  // ── Copy ───────────────────────────────────────────────────────────────────
  it("[CF3-ZF1-5] sin «Configuración»: el rechazo habla en voseo, sin roles en inglés", async () => {
    asUser(secre.userId);
    const msg = "Solo el titular o quien tenga el permiso «Configuración» puede modificar los servicios del consultorio.";
    await expect(updateService(T.serviceId, { priceCents: 1 })).rejects.toThrow(msg);
    await expect(deleteService(T.serviceId)).rejects.toThrow(msg);
  });
});
