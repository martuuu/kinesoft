/**
 * [CF2-TK] CF2 (§29, D-CF2-8; M21) — `loadAvailabilityInputs` expone `practitionerMinLead` (la anticipación del
 * turnero de cada profesional, cruda) leyendo `Practitioner.publicMinLeadMinutes` en el select de profesionales que ya
 * corría. Dos roles: `npm run test:integration` (kinesoft_app, RLS) y `:owner` (BYPASSRLS, como prod).
 *
 * Se fija: una entrada por profesional reservable (los mismos de `templates`); null = hereda; 0 llega como 0; con ids
 * explícitos solo esos; el resultado entra directo en `resolvePublicOffer` con la precedencia PS > profesional >
 * consultorio; y 0 sentencias nuevas (mismo conteo con y sin la anticipación del profesional, y la columna viaja en
 * la MISMA sentencia que las reglas de agenda de M20).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { loadAvailabilityInputs } from "@/lib/availability-loader";
import { resolvePublicOffer } from "@/lib/public-booking-slots";
import { runWithRls } from "@/lib/rls";
import { serviceDbUrlForCounter } from "@/tests/helpers/query-counter";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const DAY = "2027-11-10";

describe.skipIf(!RUN)("[CF2-TK] loader: practitionerMinLead (M21)", () => {
  let db: PrismaClient;
  let T: EphemeralTenant;
  let own: string;
  let zero: string;

  beforeAll(async () => {
    db = ownerClient();
    T = await createEphemeralTenant(db);
    own = (await addPractitioner(db, T)).practitionerId;
    zero = (await addPractitioner(db, T)).practitionerId;
    await db.practitioner.update({ where: { id: own }, data: { publicMinLeadMinutes: 180 } });
    await db.practitioner.update({ where: { id: zero }, data: { publicMinLeadMinutes: 0 } });
    await db.tenant.update({ where: { id: T.tenantId }, data: { publicMinLeadMinutes: 1440 } });
    // El servicio de la factory es del titular: sin fila PractitionerService, el de otro profesional no se ofrece
    // (default de Configuración). Fila habilitada y SIN anticipación propia (null) para que mande la del profesional.
    await db.practitionerService.createMany({
      data: [own, zero].map((practitionerId) => ({ tenantId: T.tenantId, practitionerId, serviceId: T.serviceId, enabled: true })),
    });
  });
  afterAll(async () => {
    await T?.cleanup();
    await db?.$disconnect();
  });

  const load = (practitionerIds?: string[]) =>
    runWithRls(T.tenantId, (tx) =>
      loadAvailabilityInputs(tx, { tenantId: T.tenantId, from: DAY, to: DAY, ...(practitionerIds ? { practitionerIds } : {}) })
    );

  it("[CF2-TK5] una entrada por profesional reservable, cruda (null hereda, 0 es un valor)", async () => {
    const input = await load();
    expect(Object.keys(input.practitionerMinLead).sort()).toEqual(input.templates.map((t) => t.practitionerId).sort());
    expect(input.practitionerMinLead[T.practitionerId]).toBeNull();
    expect(input.practitionerMinLead[own]).toBe(180);
    expect(input.practitionerMinLead[zero]).toBe(0);
    expect(input.publicMinLeadMinutes).toBe(1440);
  });

  it("[CF2-TK5] con ids explícitos: solo esos; [] → mapa vacío", async () => {
    expect(Object.keys((await load([own])).practitionerMinLead)).toEqual([own]);
    expect((await load([])).practitionerMinLead).toEqual({});
  });

  it("[CF2-TK5] lo cargado entra en resolvePublicOffer: profesional > consultorio, y el PS manda", async () => {
    const input = await load();
    expect(resolvePublicOffer(input, own, T.serviceId)?.minLeadMinutes).toBe(180);
    expect(resolvePublicOffer(input, zero, T.serviceId)?.minLeadMinutes).toBe(0);
    expect(resolvePublicOffer(input, T.practitionerId, T.serviceId)?.minLeadMinutes).toBe(1440);
    const psKey = { practitionerId_serviceId: { practitionerId: own, serviceId: T.serviceId } };
    await db.practitionerService.update({ where: psKey, data: { minLeadMinutes: 45 } });
    try {
      expect(resolvePublicOffer(await load(), own, T.serviceId)?.minLeadMinutes).toBe(45);
    } finally {
      await db.practitionerService.update({ where: psKey, data: { minLeadMinutes: null } });
    }
  });

  it("[CF2-TK6] 0 sentencias nuevas: mismo conteo con y sin anticipación propia, en la sentencia de las reglas", async () => {
    // Owner (BYPASSRLS) para contar sin GUC de tenant: lo que se mide es el loader, no la policy (precedente CF-K).
    // URL con `serviceDbUrlForCounter` (HD-17): falla cerrado si no es el Docker local.
    const counted = new PrismaClient({
      datasources: { db: { url: serviceDbUrlForCounter(process.env) } },
      log: [{ emit: "event", level: "query" }],
    });
    let queries: string[] = [];
    counted.$on("query" as never, (e: { query: string }) => {
      queries.push(e.query);
    });
    try {
      const measure = async () => {
        queries = [];
        await counted.$transaction((tx) => loadAvailabilityInputs(tx, { tenantId: T.tenantId, from: DAY, to: DAY }));
        return queries.filter((q) => q.trim() !== "SELECT 1");
      };
      await measure(); // calentamiento: la 1.ª tx del cliente suma la sentencia de conexión
      await db.practitioner.updateMany({ where: { tenantId: T.tenantId }, data: { publicMinLeadMinutes: null } });
      const without = await measure();
      await db.practitioner.update({ where: { id: own }, data: { publicMinLeadMinutes: 180 } });
      await db.practitioner.update({ where: { id: zero }, data: { publicMinLeadMinutes: 0 } });
      const withLead = await measure();
      expect(withLead.length).toBe(without.length);
      // La columna viaja en la MISMA sentencia que `allowParallelServices` (el select de profesionales de M20).
      const pracSelect = withLead.filter((q) => /"allowParallelServices"/.test(q) && /FROM "public"\."Practitioner"/.test(q));
      expect(pracSelect).toHaveLength(1);
      expect(pracSelect[0]).toMatch(/"publicMinLeadMinutes"/);
    } finally {
      await counted.$disconnect();
    }
  });
});
