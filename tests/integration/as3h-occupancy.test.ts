/**
 * [AS-3h] Agenda → Ocupación (plan §23.9) contra Postgres real, en los dos roles (`kinesoft_app` con RLS y owner
 * BYPASSRLS, que reproduce prod: ahí el `where tenantId` a mano es la única barrera).
 *
 * Fija:
 *   - el bucket AR fijo −3 de la sentencia (`EXTRACT(ISODOW|HOUR FROM "scheduledFor" - INTERVAL '3 hours')`) en
 *     TZ=UTC: 23:30 del domingo AR es domingo 23 (en UTC ya es lunes 02:30) y 00:30 del lunes AR es lunes 00;
 *   - el promedio (turnos / semanas, también las semanas sin turnos);
 *   - el scope por rol: el Profesional ve SOLO lo suyo aunque mande `?pro=` de otro; la Secretaria y Facturación ven
 *     a todos y eligen; un `?pro=` de otro consultorio cae a «Todos»;
 *   - aislamiento entre consultorios;
 *   - reserva pública vencida afuera, guest PENDING de la recepción adentro, reserva pública vigente adentro
 *     (`isHoldingCapacity` en JS sobre las filas que la sentencia devuelve sueltas);
 *   - el tope: «x/tope» con intervalo 60 y «con intervalos topeados» con 15;
 *   - una sola sentencia sobre `Booking` por pestaña y el DTO sin claves de paciente ni de turno.
 *
 * Símbolo real (`loadAgendaOccupancy` con el `getActor()` real); se mockea la sesión de Supabase (integration-setup)
 * y se instrumenta el cliente de Prisma para contar sentencias (no se reemplaza nada del código bajo test).
 * `now` fijo: miércoles 10-nov-2027 15:00 AR.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { getActor } from "@/lib/session";
import { loadAgendaOccupancy } from "@/lib/agenda-occupancy-internal";
import type { OccupancyTable, OccupancyView } from "@/lib/agenda-occupancy";
import { measure } from "@/tests/helpers/query-counter";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  addPractitioner,
  addStaff,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";
const ar = (local: string) => new Date(`${local}:00-03:00`);
const NOW = ar("2027-11-10T15:00");

/** Celda por hora y clave de columna (ISODOW en el pasado, DayKey en lo próximo). */
function cell(t: OccupancyTable, hour: number, col: string) {
  const ci = t.columns.findIndex((c) => c.key === col);
  const row = t.rows.find((r) => r.hour === hour);
  if (ci < 0 || !row) return null;
  return row.cells[ci];
}

describe.skipIf(!RUN)("[AS-3h] Ocupación de la agenda", () => {
  let db: PrismaClient;
  let K: EphemeralTenant;
  let E: EphemeralTenant;
  let pb: { userId: string; practitionerId: string };
  let secretaria: string;
  let facturacion: string;
  let patientId: string;
  const secretKeys: string[] = [];

  async function book(o: {
    t?: EphemeralTenant;
    prac?: string;
    when: string;
    status?: "PENDING" | "CONFIRMED" | "CANCELLED" | "NO_SHOW" | "COMPLETED";
    paymentStatus?: "UNPAID" | "PAID";
    pub?: boolean;
    guest?: boolean;
    createdAt?: Date;
  }) {
    const t = o.t ?? K;
    const key = o.pub ? `pub:${t.tenantId}:${randomUUID()}` : randomUUID();
    secretKeys.push(key);
    await db.booking.create({
      data: {
        tenantId: t.tenantId,
        practitionerId: o.prac ?? t.practitionerId,
        serviceId: t.serviceId,
        patientId: o.guest ? null : t === K ? patientId : await addPatient(db, t),
        scheduledFor: ar(o.when),
        durationMin: 30,
        status: o.status ?? "CONFIRMED",
        paymentStatus: o.paymentStatus ?? "UNPAID",
        idempotencyKey: key,
        ...(o.createdAt ? { createdAt: o.createdAt } : {}),
      },
    });
  }

  async function view(userId: string, params: { tab: "pasado" | "proximo"; weeks: number; pro?: string | null }) {
    asUser(userId);
    const actor = await getActor();
    return loadAgendaOccupancy(actor, { tab: params.tab, weeks: params.weeks, pro: params.pro ?? null }, NOW);
  }

  beforeAll(async () => {
    db = ownerClient();
    K = await createEphemeralTenant(db);
    E = await createEphemeralTenant(db);
    pb = await addPractitioner(db, K);
    secretaria = (await addStaff(db, K, "ASSISTANT")).userId;
    facturacion = (await addStaff(db, K, "BILLING")).userId;
    patientId = await addPatient(db, K);
    // Topes: el titular 2 cada 15', el segundo profesional 1 cada 60'.
    await db.practitioner.update({
      where: { id: K.practitionerId },
      data: { bookingCapMode: "CUSTOM", bookingCapCount: 2, bookingCapIntervalMin: 15 },
    });
    await db.practitioner.update({
      where: { id: pb.practitionerId },
      data: { bookingCapMode: "CUSTOM", bookingCapCount: 1, bookingCapIntervalMin: 60 },
    });

    // ── Pasado (4 semanas completas: lun 11-oct → dom 07-nov 2027) ──
    await book({ when: "2027-11-07T23:30" }); // domingo 23:30 AR = lunes 02:30 UTC
    await book({ when: "2027-11-01T00:30" }); // lunes 00:30 AR = lunes 03:30 UTC
    await book({ when: "2027-10-19T10:00" }); // martes
    await book({ when: "2027-10-26T10:00" });
    await book({ when: "2027-10-26T10:15", status: "NO_SHOW" });
    await book({ when: "2027-10-26T10:30", status: "CANCELLED" }); // no cuenta
    await book({ when: "2027-11-03T11:00", status: "PENDING", pub: true, createdAt: ar("2027-11-01T09:00") }); // vencida
    await book({ when: "2027-10-28T09:00", prac: pb.practitionerId }); // jueves, del otro profesional
    await book({ when: "2027-11-08T10:00" }); // semana en curso: fuera de «Lo que pasó»
    await book({ t: E, when: "2027-10-19T10:00" }); // otro consultorio

    // ── Próximo (1 semana: mié 10-nov → mar 16-nov) ──
    await book({ when: "2027-11-11T10:00" });
    await book({ when: "2027-11-11T10:05" }); // intervalo 10:00-10:15 con 2 = en el tope
    await book({ when: "2027-11-11T10:30" });
    await book({ when: "2027-11-12T09:00", status: "PENDING", guest: true, createdAt: ar("2027-11-01T09:00") });
    await book({ when: "2027-11-12T09:15", status: "PENDING", pub: true, createdAt: ar("2027-11-10T14:50") }); // vigente
    await book({ when: "2027-11-12T09:30", status: "PENDING", pub: true, createdAt: ar("2027-11-10T13:00") }); // vencida
    await book({ when: "2027-11-11T14:00", prac: pb.practitionerId });
    await book({ t: E, when: "2027-11-11T10:00" });
  });

  afterAll(async () => {
    await K?.cleanup();
    await E?.cleanup();
  });

  it("[AS-3h] bucket AR fijo en TZ=UTC: domingo 23:30 → dom 23, lunes 00:30 → lun 00", async () => {
    const v = await view(K.userId, { tab: "pasado", weeks: 4, pro: K.practitionerId });
    const t = v.tables[0];
    expect(t.columns.map((c) => c.key)).toContain("7"); // hubo turnos el domingo → columna
    expect(cell(t, 23, "7")?.value).toBe(0.25);
    expect(cell(t, 0, "1")?.value).toBe(0.25);
    expect(cell(t, 2, "1")).toBeNull(); // no quedó en la hora UTC
  });

  it("[AS-3h] promedio por semana: 3 turnos del martes 10 en 4 semanas = 0,75 (el cancelado y la semana en curso no)", async () => {
    const v = await view(K.userId, { tab: "pasado", weeks: 4, pro: K.practitionerId });
    const c = cell(v.tables[0], 10, "2")!;
    expect(c.value).toBe(0.75);
    expect(c.text).toBe("0,8");
    expect(c.atCap).toBe(false);
    // Lunes 10:00 de la semana en curso (08-nov) no entra.
    expect(cell(v.tables[0], 10, "1")?.value).toBe(0);
  });

  it("[AS-3h] reserva pública vencida afuera (pasado)", async () => {
    const v = await view(K.userId, { tab: "pasado", weeks: 4, pro: K.practitionerId });
    expect(cell(v.tables[0], 11, "3")?.value).toBe(0);
  });

  it("[AS-3h] el Profesional ve solo lo suyo aunque mande ?pro= de otro", async () => {
    const v = await view(pb.userId, { tab: "pasado", weeks: 4, pro: K.practitionerId });
    expect(v.scope).toEqual({ kind: "own", practitionerId: pb.practitionerId });
    expect(v.practitioners).toEqual([]);
    expect(cell(v.tables[0], 10, "2")?.value).toBe(0);
    expect(cell(v.tables[0], 9, "4")?.value).toBe(0.25);
  });

  it("[AS-3h] Secretaria y Facturación ven a todos y eligen; un ?pro= ajeno cae a «Todos»", async () => {
    const all = await view(secretaria, { tab: "pasado", weeks: 4 });
    expect(all.scope).toEqual({ kind: "team", practitionerId: null });
    expect(all.practitioners.map((p) => p.id).sort()).toEqual([K.practitionerId, pb.practitionerId].sort());
    expect(cell(all.tables[0], 9, "4")?.value).toBe(0.25);
    expect(cell(all.tables[0], 10, "2")?.value).toBe(0.75);
    expect(all.cap).toBeNull();

    const one = await view(facturacion, { tab: "pasado", weeks: 4, pro: pb.practitionerId });
    expect(one.scope).toEqual({ kind: "team", practitionerId: pb.practitionerId });
    expect(cell(one.tables[0], 10, "2")?.value).toBe(0);

    const foreign = await view(secretaria, { tab: "pasado", weeks: 4, pro: E.practitionerId });
    expect(foreign.scope).toEqual({ kind: "team", practitionerId: null });
  });

  it("[AS-3h] aislamiento: el turno del martes 10 del otro consultorio no suma", async () => {
    const all = await view(K.userId, { tab: "pasado", weeks: 4 });
    expect(cell(all.tables[0], 10, "2")?.value).toBe(0.75); // 3 de K, no 4
    const fut = await view(K.userId, { tab: "proximo", weeks: 1 });
    expect(cell(fut.tables[0], 10, "2027-11-11")?.value).toBe(3);
  });

  it("[AS-3h] lo que viene: guest PENDING y pública vigente adentro, pública vencida afuera; tope 15' marca la hora", async () => {
    const v = await view(K.userId, { tab: "proximo", weeks: 1, pro: K.practitionerId });
    expect(v.cap).toEqual({ count: 2, intervalMin: 15 });
    const t = v.tables[0];
    expect(cell(t, 9, "2027-11-12")?.value).toBe(2);
    const thu10 = cell(t, 10, "2027-11-11")!;
    expect(thu10.text).toBe("3");
    expect(thu10.atCap).toBe(true);
    expect(thu10.note).toMatch(/intervalos topeados: 1 de 4/);
  });

  it("[AS-3h] tope de 60': la celda dice «x/tope» y marca el tope", async () => {
    const v = await view(pb.userId, { tab: "proximo", weeks: 1 });
    const c = cell(v.tables[0], 14, "2027-11-11")!;
    expect(c.text).toBe("1/1");
    expect(c.atCap).toBe(true);
    expect(cell(v.tables[0], 10, "2027-11-11")?.text).toBe("0/1");
  });

  it("[AS-3h] una sola sentencia sobre Booking por pestaña, en una transacción", async () => {
    // El recorder es global (tests/helpers/query-counter.ts) y conserva los eventos de la última medición.
    const rec = (globalThis as unknown as { __kineQueryRecorder: { events: { query: string }[] } }).__kineQueryRecorder;
    for (const [tab, weeks, pro] of [
      ["pasado", 12, null],
      ["proximo", 4, null],
      ["proximo", 2, "K"],
    ] as const) {
      asUser(secretaria);
      const actor = await getActor();
      const { m } = await measure(() =>
        loadAgendaOccupancy(actor, { tab, weeks, pro: pro ? K.practitionerId : null }, NOW)
      );
      const onBooking = rec.events.filter((e) => /FROM\s+"(public"\.")?Booking"/i.test(e.query));
      expect(onBooking, `${tab}/${weeks}`).toHaveLength(1);
      expect(m.transactions).toBe(1);
      // Además del agregado: el tope y el horario del consultorio, y los profesionales (con su nombre).
      expect(m.statements).toBeLessThanOrEqual(4);
    }
  });

  it("[AS-3h] el DTO no lleva claves de paciente ni de turno", async () => {
    const views: OccupancyView[] = [
      await view(secretaria, { tab: "pasado", weeks: 12 }),
      await view(secretaria, { tab: "proximo", weeks: 4 }),
    ];
    const json = JSON.stringify(views);
    expect(json).not.toContain(patientId);
    for (const k of secretKeys) expect(json).not.toContain(k);
    expect(json).not.toMatch(/patient|idempotency/i);
  });
});
