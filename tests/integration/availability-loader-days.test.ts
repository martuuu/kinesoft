/**
 * `loadAvailabilityInputsForDays` (P0.1 S07L) contra Postgres real.
 *
 * Qué se fija:
 *   1. Contrato de equivalencia: para una lista de días sueltos, el resultado
 *      es el de la ventana contigua `loadAvailabilityInputs(min..max)` con
 *      excepciones, bloqueos y turnos filtrados a los que tocan algún día
 *      pedido (turnos con el lookback de 240 min). Plantillas, servicios,
 *      reglas y coberturas idénticos. Se compara contra el símbolo real de la
 *      ventana, no contra una copia de la regla.
 *   2. Costo: un plan mensual ×20 (≈ 20 meses) hace la MISMA cantidad de
 *      statements que un día solo y que la ventana contigua (constante, no
 *      crece con los días), y trae solo las filas de esos días.
 *
 * Los dos canales (tx de `runWithRls` y `prismaService`) tienen que devolver
 * lo mismo: el aislamiento no depende de RLS.
 *
 * `@/lib/db` se instrumenta con `installQueryCounter` (mismo patrón que
 * `tests/perf/loaders.perf.test.ts`): solo se le suma un listener de `query` a
 * los clientes; el loader corre tal cual.
 *
 * Fechas en 2028-2029, lejos de "hoy": nada depende del reloj.
 */
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db")>();
  const { installQueryCounter } = await import("@/tests/helpers/query-counter");
  return { ...actual, ...installQueryCounter() };
});

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  addPatient,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { measure } from "@/tests/helpers/query-counter";
import { runWithRls } from "@/lib/rls";
import { prismaService } from "@/lib/db";
import {
  FOR_DAYS_MAX,
  loadAvailabilityInputs,
  loadAvailabilityInputsForDays,
  type LoadAvailabilityForDaysParams,
  type LoadedAvailabilityInput,
  type LoadedAvailabilityInputForDays,
} from "@/lib/availability-loader";
import { addDays, dayWindow } from "@/lib/availability/day";
import { BOOKING_LOOKBACK_MIN, type DayKey } from "@/lib/availability/types";

const RUN = process.env.INTEGRATION === "1";

const ar = (local: string) => new Date(`${local}:00-03:00`);

/** Mensual ×20: el 10 de cada mes desde ene-2028 hasta ago-2029. */
const MONTHLY_20: DayKey[] = Array.from({ length: 20 }, (_, i) => {
  const y = 2028 + Math.floor(i / 12);
  const m = (i % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}-10`;
});
const FIRST = MONTHLY_20[0];
const LAST = MONTHLY_20[MONTHLY_20.length - 1];

/** La regla de la ventana, aplicada a los días pedidos (para comparar). */
function restrictToDays(full: LoadedAvailabilityInput, days: ReadonlyArray<DayKey>): LoadedAvailabilityInputForDays {
  const sorted = Array.from(new Set(days)).sort();
  const wins = sorted.map((d) => dayWindow(d));
  const lookMs = BOOKING_LOOKBACK_MIN * 60_000;
  return {
    ...full,
    exceptions: full.exceptions.filter((e) => sorted.includes(e.date)),
    blocks: full.blocks.filter((b) => wins.some((w) => b.startsAt < w.end && b.endsAt > w.start)),
    bookings: full.bookings.filter((b) =>
      wins.some((w) => b.scheduledFor.getTime() >= w.start.getTime() - lookMs && b.scheduledFor < w.end)
    ),
    days: sorted,
  };
}

async function loadBothForDays(p: LoadAvailabilityForDaysParams): Promise<LoadedAvailabilityInputForDays> {
  const viaRls = await runWithRls(p.tenantId, (tx) => loadAvailabilityInputsForDays(tx, p));
  const viaService = await loadAvailabilityInputsForDays(prismaService, p);
  expect(viaService).toEqual(viaRls);
  return viaRls;
}

describe.skipIf(!RUN)("loadAvailabilityInputsForDays (P0.1 S07L)", () => {
  let owner: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let p2: string;
  let patientA: string;
  const ids: Record<string, string> = {};
  const bIds = new Set<string>();

  async function booking(
    t: EphemeralTenant,
    data: { practitionerId?: string; patientId: string | null; scheduledFor: Date; status?: "CONFIRMED" | "CANCELLED" }
  ): Promise<string> {
    const b = await owner.booking.create({
      data: {
        tenantId: t.tenantId,
        practitionerId: data.practitionerId ?? t.practitionerId,
        serviceId: t.serviceId,
        patientId: data.patientId,
        scheduledFor: data.scheduledFor,
        durationMin: 45,
        status: data.status ?? "CONFIRMED",
        idempotencyKey: randomUUID(),
      },
    });
    return b.id;
  }

  const block = (t: EphemeralTenant, startsAt: Date, endsAt: Date, practitionerId: string | null = null) =>
    owner.timeBlock
      .create({ data: { tenantId: t.tenantId, createdById: t.userId, practitionerId, startsAt, endsAt, reason: "Test" } })
      .then((b) => b.id);

  const exception = (t: EphemeralTenant, day: DayKey) =>
    owner.scheduleException
      .create({ data: { tenantId: t.tenantId, practitionerId: null, date: new Date(`${day}T00:00:00Z`), kind: "CLOSED", createdById: t.userId } })
      .then((e) => e.id);

  beforeAll(async () => {
    owner = ownerClient();
    A = await createEphemeralTenant(owner);
    B = await createEphemeralTenant(owner);
    p2 = (await addPractitioner(owner, A)).practitionerId;
    patientA = await addPatient(owner, A);
    const patientB = await addPatient(owner, B);
    bIds.add(patientB);

    const locA = (await owner.location.create({ data: { tenantId: A.tenantId, name: "Principal", isPrimary: true } })).id;
    // Lunes 9-13 desde mar-2028: vigencia dentro del rango → la poda por
    // from/to tiene que coincidir con la de la ventana.
    await owner.practitionerSchedule.create({
      data: { tenantId: A.tenantId, practitionerId: A.practitionerId, locationId: locA, dow: 1, startMin: 540, endMin: 780, validFrom: new Date("2028-03-01T00:00:00Z") },
    });
    await owner.practitionerService.create({ data: { tenantId: A.tenantId, practitionerId: A.practitionerId, serviceId: A.serviceId } });

    // ── Turnos ──
    ids.bIn = await booking(A, { patientId: patientA, scheduledFor: ar("2028-01-10T10:00") });
    ids.bLastMinute = await booking(A, { patientId: null, scheduledFor: ar("2028-03-10T23:30") });
    ids.bOffDay = await booking(A, { patientId: patientA, scheduledFor: ar("2028-01-20T10:00") });
    // 120 min antes del 10/02 00:00 AR: entra por el lookback del tramo.
    ids.bLookIn = await booking(A, { patientId: patientA, scheduledFor: ar("2028-02-09T22:00") });
    // Justo en el borde del lookback (240 min): entra, igual que la ventana.
    ids.bLookEdge = await booking(A, { patientId: null, scheduledFor: ar("2028-02-09T20:00") });
    // 300 min antes: afuera.
    ids.bLookOut = await booking(A, { patientId: patientA, scheduledFor: ar("2028-02-09T19:00") });
    // Fin del día pedido = exclusivo.
    ids.bNextMidnight = await booking(A, { patientId: null, scheduledFor: ar("2028-01-11T00:00") });
    ids.bCancelled = await booking(A, { patientId: patientA, scheduledFor: ar("2028-04-10T10:00"), status: "CANCELLED" });
    // Del paciente con otro profesional, en un día pedido: entra solo con patientId.
    ids.bPatientOther = await booking(A, { practitionerId: p2, patientId: patientA, scheduledFor: ar("2028-05-10T11:00") });
    ids.bLate = await booking(A, { patientId: null, scheduledFor: ar(`${LAST}T12:00`) });
    bIds.add(await booking(B, { patientId: patientB, scheduledFor: ar("2028-01-10T10:00") }));

    // ── Bloqueos ──
    ids.blkStraddle = await block(A, ar("2028-04-09T20:00"), ar("2028-04-10T08:00"));
    ids.blkOffDay = await block(A, ar("2028-04-20T10:00"), ar("2028-04-20T12:00"));
    // Licencia larga que cruza dos días pedidos (10/06 y 10/07).
    ids.blkLong = await block(A, ar("2028-06-05T00:00"), ar("2028-07-15T00:00"), A.practitionerId);
    // Termina justo a la medianoche del día pedido: no lo toca.
    ids.blkEdge = await block(A, ar("2028-08-09T10:00"), ar("2028-08-10T00:00"));
    bIds.add(await block(B, ar("2028-01-10T10:00"), ar("2028-01-10T12:00")));

    // ── Excepciones ──
    ids.exIn = await exception(A, "2028-05-10");
    ids.exOff = await exception(A, "2028-05-11");
    ids.exAdjacent = await exception(A, "2028-03-11");
    bIds.add(await exception(B, "2028-05-10"));
  });

  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await owner?.$disconnect();
  });

  it("ForDays ≡ ventana contigua restringida a los días (mensual ×20)", async () => {
    const got = await loadBothForDays({ tenantId: A.tenantId, practitionerIds: [A.practitionerId], days: MONTHLY_20 });
    const full = await runWithRls(A.tenantId, (tx) =>
      loadAvailabilityInputs(tx, { tenantId: A.tenantId, practitionerIds: [A.practitionerId], from: FIRST, to: LAST })
    );
    expect(got).toEqual(restrictToDays(full, MONTHLY_20));
    expect(got.from).toBe(FIRST);
    expect(got.to).toBe(LAST);

    // No vacuo: afirmaciones por fila.
    expect(got.bookings.map((b) => b.id)).toEqual([ids.bIn, ids.bLookEdge, ids.bLookIn, ids.bLastMinute, ids.bLate]);
    expect(full.bookings.map((b) => b.id)).toEqual(
      expect.arrayContaining([ids.bOffDay, ids.bLookOut, ids.bNextMidnight])
    );
    expect(got.blocks.map((b) => b.id)).toEqual([ids.blkStraddle, ids.blkLong]);
    expect(full.blocks.map((b) => b.id)).toEqual(expect.arrayContaining([ids.blkOffDay, ids.blkEdge]));
    expect(got.exceptions.map((e) => e.id)).toEqual([ids.exIn]);
    expect(full.exceptions.map((e) => e.id)).toEqual(expect.arrayContaining([ids.exOff, ids.exAdjacent]));
    // Plantilla con vigencia dentro del rango: igual que la ventana.
    expect(got.templates[0].ranges).toEqual([
      expect.objectContaining({ dow: 1, startMin: 540, endMin: 780, validFrom: "2028-03-01", validUntil: null }),
    ]);
    const json = JSON.stringify(got);
    for (const id of bIds) expect(json).not.toContain(id);
  });

  it("días desordenados, repetidos y contiguos: se normalizan y los tramos se unen", async () => {
    const days: DayKey[] = ["2028-05-10", "2028-03-11", "2028-01-10", "2028-03-10", "2028-05-10", "2028-02-10"];
    const got = await loadBothForDays({ tenantId: A.tenantId, patientId: patientA, days });
    expect(got.days).toEqual(["2028-01-10", "2028-02-10", "2028-03-10", "2028-03-11", "2028-05-10"]);
    const full = await runWithRls(A.tenantId, (tx) =>
      loadAvailabilityInputs(tx, { tenantId: A.tenantId, patientId: patientA, from: "2028-01-10", to: "2028-05-10" })
    );
    expect(got).toEqual(restrictToDays(full, days));
    expect(got.exceptions.map((e) => e.id)).toEqual([ids.exAdjacent, ids.exIn]);
    // patientId suma el turno con el otro profesional, como la ventana.
    expect(got.bookings.map((b) => b.id)).toContain(ids.bPatientOther);
  });

  it("un tramo contiguo da EXACTAMENTE lo mismo que loadAvailabilityInputs", async () => {
    const days: DayKey[] = [];
    for (let d: DayKey = "2028-04-05"; d <= "2028-04-12"; d = addDays(d, 1)) days.push(d);
    const got = await loadBothForDays({ tenantId: A.tenantId, days });
    const full = await runWithRls(A.tenantId, (tx) =>
      loadAvailabilityInputs(tx, { tenantId: A.tenantId, from: "2028-04-05", to: "2028-04-12" })
    );
    expect(got).toEqual({ ...full, days });
  });

  it("mensual ×20: cantidad de queries constante (= 1 día = ventana contigua) y en 1 tx", async () => {
    const params = { tenantId: A.tenantId, practitionerIds: [A.practitionerId], patientId: patientA };
    const many = await measure(() => runWithRls(A.tenantId, (tx) => loadAvailabilityInputsForDays(tx, { ...params, days: MONTHLY_20 })));
    const one = await measure(() => runWithRls(A.tenantId, (tx) => loadAvailabilityInputsForDays(tx, { ...params, days: [FIRST] })));
    const contiguous = await measure(() =>
      runWithRls(A.tenantId, (tx) => loadAvailabilityInputs(tx, { ...params, from: FIRST, to: LAST }))
    );
    expect(many.m.statements).toBe(one.m.statements);
    expect(many.m.statements).toBe(contiguous.m.statements);
    // Fase 1 (tenant, profesionales, principal, paciente) + fase 2 (franjas,
    // excepciones, bloqueos, turnos, PS, servicios, coberturas) = 11 con
    // estos params. Tope duro para que un N+1 futuro no pase callado.
    expect(many.m.statements).toBeLessThanOrEqual(13);
    expect(many.m.transactions).toBe(1);
    // Y trae menos filas que la ventana de 20 meses.
    expect(many.result.bookings.length).toBeLessThan(contiguous.result.bookings.length);
  });

  it("entrada inválida: vacío, día inexistente, más del tope", async () => {
    await expect(loadAvailabilityInputsForDays(prismaService, { tenantId: A.tenantId, days: [] })).rejects.toThrow(/days vacío/);
    await expect(
      loadAvailabilityInputsForDays(prismaService, { tenantId: A.tenantId, days: ["2028-02-30"] })
    ).rejects.toThrow(/día inválido/);
    const tooMany: DayKey[] = [];
    for (let i = 0, d: DayKey = "2028-01-01"; i <= FOR_DAYS_MAX; i++, d = addDays(d, 2)) tooMany.push(d);
    await expect(loadAvailabilityInputsForDays(prismaService, { tenantId: A.tenantId, days: tooMany })).rejects.toThrow(/máx\./);
  });
});
