/**
 * [CF-K] CF (§28, M20) — `loadAvailabilityInputs` expone `agendaRules` (reglas efectivas por profesional) y
 * `publicMinLeadMinutes` (del consultorio, crudo) leyendo las columnas de M20 en los selects de tenant y profesional
 * que ya corrían. Dos roles: `npm run test:integration` (kinesoft_app, RLS) y `:owner` (BYPASSRLS, como prod).
 *
 * Se fija: sin nada configurado → exclusivo, agenda 15, turnero automático, anticipación null; el consultorio es el
 * default de cada profesional; el override del profesional gana campo por campo; `allowParallelServices` no hereda;
 * una entrada por profesional reservable (los mismos de `templates`); y 0 sentencias nuevas (mismo conteo con y sin
 * overrides).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { loadAvailabilityInputs } from "@/lib/availability-loader";
import { runWithRls } from "@/lib/rls";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const DAY = "2027-11-10";

describe.skipIf(!RUN)("[CF-K] loader: agendaRules + publicMinLeadMinutes (M20)", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let parallel: string;
  let ownSteps: string;

  const resetTenant = () =>
    db.tenant.update({
      where: { id: T.tenantId },
      data: { agendaSlotStepMin: null, publicSlotStepMin: null, publicMinLeadMinutes: null },
    });

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
    parallel = (await addPractitioner(db, T)).practitionerId;
    ownSteps = (await addPractitioner(db, T)).practitionerId;
    await db.practitioner.update({ where: { id: parallel }, data: { allowParallelServices: true } });
    await db.practitioner.update({ where: { id: ownSteps }, data: { agendaSlotStepMin: 60, publicSlotStepMin: 15 } });
  });
  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });

  const load = () =>
    runWithRls(T.tenantId, (tx) => loadAvailabilityInputs(tx, { tenantId: T.tenantId, from: DAY, to: DAY }));

  it("consultorio sin configurar: defaults; el profesional con overrides manda los suyos", async () => {
    await resetTenant();
    const input = await load();
    expect(Object.keys(input.agendaRules).sort()).toEqual(input.templates.map((t) => t.practitionerId).sort());
    expect(input.publicMinLeadMinutes).toBeNull();
    expect(input.agendaRules[T.practitionerId]).toEqual({ exclusiveService: true, agendaStepMin: 15, publicStepMin: null });
    expect(input.agendaRules[parallel]).toEqual({ exclusiveService: false, agendaStepMin: 15, publicStepMin: null });
    expect(input.agendaRules[ownSteps]).toEqual({ exclusiveService: true, agendaStepMin: 60, publicStepMin: 15 });
  });

  it("consultorio con pasos 30/45 y anticipación 0: lo heredan los que no tienen override", async () => {
    await db.tenant.update({
      where: { id: T.tenantId },
      data: { agendaSlotStepMin: 30, publicSlotStepMin: 45, publicMinLeadMinutes: 0 },
    });
    const input = await load();
    expect(input.publicMinLeadMinutes).toBe(0);
    expect(input.agendaRules[T.practitionerId]).toEqual({ exclusiveService: true, agendaStepMin: 30, publicStepMin: 45 });
    expect(input.agendaRules[parallel]).toEqual({ exclusiveService: false, agendaStepMin: 30, publicStepMin: 45 });
    expect(input.agendaRules[ownSteps]).toEqual({ exclusiveService: true, agendaStepMin: 60, publicStepMin: 15 });
  });

  it("con ids explícitos: solo esos profesionales en el mapa", async () => {
    const input = await runWithRls(T.tenantId, (tx) =>
      loadAvailabilityInputs(tx, { tenantId: T.tenantId, practitionerIds: [parallel], from: DAY, to: DAY })
    );
    expect(Object.keys(input.agendaRules)).toEqual([parallel]);
    const none = await runWithRls(T.tenantId, (tx) =>
      loadAvailabilityInputs(tx, { tenantId: T.tenantId, practitionerIds: [], from: DAY, to: DAY })
    );
    expect(none.agendaRules).toEqual({});
  });

  it("0 sentencias nuevas: el mismo conteo con y sin overrides del consultorio", async () => {
    // Owner (BYPASSRLS) para contar sin GUC de tenant: lo que se mide es el loader, no la policy (precedente AS-2k).
    const counted = new PrismaClient({
      datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } },
      log: [{ emit: "event", level: "query" }],
    });
    let n = 0;
    counted.$on("query" as never, () => {
      n++;
    });
    try {
      const measure = async () => {
        n = 0;
        await counted.$transaction((tx) => loadAvailabilityInputs(tx, { tenantId: T.tenantId, from: DAY, to: DAY }));
        return n;
      };
      await measure(); // calentamiento: la 1.ª tx del cliente suma la sentencia de conexión
      await resetTenant();
      const without = await measure();
      await db.tenant.update({
        where: { id: T.tenantId },
        data: { agendaSlotStepMin: 45, publicSlotStepMin: 30, publicMinLeadMinutes: 1440 },
      });
      const withRules = await measure();
      expect(withRules).toBe(without);
    } finally {
      await counted.$disconnect();
    }
  });
});
