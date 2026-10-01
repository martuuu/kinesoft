/**
 * B2.4b CFG-api-2 — servicios y coberturas por profesional contra la DB real
 * (rol app con RLS y owner BYPASSRLS = prod).
 *
 * Lo que se protege:
 *   - authz: `schedule.configure` (OWNER/ADMIN); un PRACTITIONER no lee ni
 *     escribe la config (ni la propia);
 *   - IDOR: las FK de PractitionerService/PractitionerPayer SALTEAN RLS, así
 *     que la única barrera para colgar el servicio / la obra social de OTRO
 *     consultorio es la validación de la action. Se afirma el efecto
 *     observable: la fila no se creó / quedó igual.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { listPractitionerServices, upsertPractitionerService } from "@/lib/practitioner-services";
import { listPractitionerPayers, setPractitionerPayers } from "@/lib/practitioner-payers";
import { ForbiddenError } from "@/lib/session";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  addInsurer,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

const BASE = {
  enabled: true,
  visibility: "PUBLIC" as const,
  concurrencyOverride: false,
  notifyOnBooking: false,
};

describe.skipIf(!RUN)("config por profesional · servicios y coberturas (B2.4b)", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let prac2: { userId: string; practitionerId: string };
  let sharedServiceId: string;
  let osX: string;
  let osY: string;

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
    prac2 = await addPractitioner(db, A, "PRACTITIONER");
    // Servicio compartido (practitionerId null) además del "Consulta" del OWNER.
    sharedServiceId = (
      await db.service.create({
        data: { tenantId: A.tenantId, practitionerId: null, name: "Gimnasio", durationMin: 60 },
      })
    ).id;
    osX = await addInsurer(db, A, { name: "OS X" });
    osY = await addInsurer(db, A, { name: "OS Y" });
  });
  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await db?.$disconnect();
  });

  describe("servicios", () => {
    it("PRACTITIONER: ni lista ni guarda (ni su propia config); no se crea fila", async () => {
      asUser(prac2.userId);
      await expect(listPractitionerServices(prac2.practitionerId)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        upsertPractitionerService(prac2.practitionerId, sharedServiceId, BASE)
      ).rejects.toBeInstanceOf(ForbiddenError);
      expect(await db.practitionerService.count({ where: { practitionerId: prac2.practitionerId } })).toBe(0);
    });

    it("lista todos los servicios del tenant con el default si no hay fila", async () => {
      asUser(A.userId);
      const r = await listPractitionerServices(prac2.practitionerId);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const byId = new Map(r.data.map((x) => [x.serviceId, x]));
      expect(r.data).toHaveLength(2);
      // "Consulta" es del OWNER → para prac2, sin fila = deshabilitado (como el backfill).
      expect(byId.get(A.serviceId)).toMatchObject({ hasRow: false, enabled: false, visibility: "PUBLIC" });
      // Compartido → habilitado para todos (decisión 7).
      expect(byId.get(sharedServiceId)).toMatchObject({ hasRow: false, enabled: true, serviceDurationMin: 60 });
      // Para el OWNER su propio servicio sí está habilitado por defecto.
      const own = await listPractitionerServices(A.practitionerId);
      expect(own.ok && own.data.find((x) => x.serviceId === A.serviceId)?.enabled).toBe(true);
    });

    it("upsert crea y después actualiza la fila (una sola por profesional+servicio)", async () => {
      asUser(A.userId);
      const c = await upsertPractitionerService(prac2.practitionerId, sharedServiceId, {
        ...BASE,
        durationMin: 30,
        visibility: "PRIVATE",
        minLeadMinutes: 120,
        maxLeadDays: 60,
        concurrencyOverride: true,
        maxConcurrent: 2,
        notifyOnBooking: true,
      });
      expect(c.ok).toBe(true);
      const u = await upsertPractitionerService(prac2.practitionerId, sharedServiceId, {
        ...BASE,
        durationMin: 45,
        // Sin override el cupo propio se descarta (no queda un "cupo fantasma").
        maxConcurrent: 3,
      });
      expect(u.ok).toBe(true);
      const rows = await db.practitionerService.findMany({
        where: { practitionerId: prac2.practitionerId, serviceId: sharedServiceId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tenantId: A.tenantId,
        enabled: true,
        durationMin: 45,
        visibility: "PUBLIC",
        minLeadMinutes: null,
        maxLeadDays: null,
        concurrencyOverride: false,
        maxConcurrent: null,
        notifyOnBooking: false,
      });
      const ev = await db.auditEvent.findFirst({
        where: { tenantId: A.tenantId, action: "practitionerService.upsert", entityId: rows[0].id },
      });
      expect(ev).not.toBeNull();
    });

    it("override + null = ilimitado; override con 0 se rechaza", async () => {
      asUser(A.userId);
      expect(
        (await upsertPractitionerService(A.practitionerId, A.serviceId, {
          ...BASE,
          concurrencyOverride: true,
          maxConcurrent: null,
        })).ok
      ).toBe(true);
      const row = await db.practitionerService.findUniqueOrThrow({
        where: { practitionerId_serviceId: { practitionerId: A.practitionerId, serviceId: A.serviceId } },
      });
      expect(row).toMatchObject({ concurrencyOverride: true, maxConcurrent: null });

      const bad = await upsertPractitionerService(A.practitionerId, A.serviceId, {
        ...BASE,
        concurrencyOverride: true,
        maxConcurrent: 0,
      });
      expect(bad.ok).toBe(false);
    });

    it.each([
      ["duración no múltiplo de 5", { durationMin: 47 }],
      ["duración < 5", { durationMin: 0 }],
      ["duración > 480", { durationMin: 485 }],
      ["anticipación negativa", { minLeadMinutes: -1 }],
      ["horizonte negativo", { maxLeadDays: -1 }],
    ])("valida: %s (no escribe)", async (_label, patch) => {
      asUser(A.userId);
      const before = await db.practitionerService.findMany({ where: { tenantId: A.tenantId } });
      const r = await upsertPractitionerService(prac2.practitionerId, A.serviceId, { ...BASE, ...patch });
      expect(r.ok).toBe(false);
      expect(await db.practitionerService.findMany({ where: { tenantId: A.tenantId } })).toEqual(before);
    });

    it("IDOR: servicio de otro tenant → rechazo, sin fila", async () => {
      asUser(A.userId);
      const r = await upsertPractitionerService(prac2.practitionerId, B.serviceId, BASE);
      expect(r).toEqual({ ok: false, error: "Servicio no encontrado." });
      expect(await db.practitionerService.count({ where: { serviceId: B.serviceId } })).toBe(0);
    });

    it("IDOR: profesional de otro tenant → rechazo en upsert y en list", async () => {
      asUser(A.userId);
      const r = await upsertPractitionerService(B.practitionerId, A.serviceId, BASE);
      expect(r).toEqual({ ok: false, error: "Profesional no encontrado." });
      expect(await db.practitionerService.count({ where: { practitionerId: B.practitionerId } })).toBe(0);
      expect(await listPractitionerServices(B.practitionerId)).toEqual({
        ok: false,
        error: "Profesional no encontrado.",
      });
    });
  });

  describe("coberturas", () => {
    it("PRACTITIONER: rechazo; no se escribe nada", async () => {
      asUser(prac2.userId);
      await expect(listPractitionerPayers(prac2.practitionerId)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(setPractitionerPayers(prac2.practitionerId, [osX])).rejects.toBeInstanceOf(ForbiddenError);
      expect(await db.practitionerPayer.count({ where: { practitionerId: prac2.practitionerId } })).toBe(0);
    });

    it("sin filas: todas activas por defecto, Particular primero", async () => {
      asUser(A.userId);
      const r = await listPractitionerPayers(prac2.practitionerId);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data[0]).toMatchObject({ insurerId: A.particularInsurerId, isParticular: true, active: true });
      expect(r.data.every((x) => x.active && !x.hasRow)).toBe(true);
      expect(r.data).toHaveLength(3);
    });

    it("reemplazo: lo elegido activo, el resto inactivo, Particular siempre activa", async () => {
      asUser(A.userId);
      const r = await setPractitionerPayers(prac2.practitionerId, [osX, osX]);
      expect(r).toEqual({ ok: true, data: { active: 2, inactive: 1 } });
      const rows = await db.practitionerPayer.findMany({ where: { practitionerId: prac2.practitionerId } });
      const active = Object.fromEntries(rows.map((x) => [x.insurerId, x.active]));
      expect(active).toEqual({ [A.particularInsurerId]: true, [osX]: true, [osY]: false });
      expect(rows.every((x) => x.tenantId === A.tenantId)).toBe(true);

      // Set vacío: Particular no se puede apagar.
      expect((await setPractitionerPayers(prac2.practitionerId, [])).ok).toBe(true);
      const after = await listPractitionerPayers(prac2.practitionerId);
      expect(after.ok && after.data.filter((x) => x.active).map((x) => x.insurerId)).toEqual([
        A.particularInsurerId,
      ]);
      expect(after.ok && after.data.every((x) => x.hasRow)).toBe(true);
    });

    it("IDOR: un insurer de otro tenant rechaza el set entero (nada cambia)", async () => {
      asUser(A.userId);
      await setPractitionerPayers(prac2.practitionerId, [osY]);
      const before = await db.practitionerPayer.findMany({
        where: { practitionerId: prac2.practitionerId },
        orderBy: { insurerId: "asc" },
      });
      const r = await setPractitionerPayers(prac2.practitionerId, [osX, B.particularInsurerId]);
      expect(r).toEqual({ ok: false, error: "Obra social no encontrada." });
      const after = await db.practitionerPayer.findMany({
        where: { practitionerId: prac2.practitionerId },
        orderBy: { insurerId: "asc" },
      });
      expect(after).toEqual(before);
      expect(await db.practitionerPayer.count({ where: { insurerId: B.particularInsurerId } })).toBe(0);
    });

    it("IDOR: profesional de otro tenant → rechazo, sin filas", async () => {
      asUser(A.userId);
      expect(await setPractitionerPayers(B.practitionerId, [])).toEqual({
        ok: false,
        error: "Profesional no encontrado.",
      });
      expect(await db.practitionerPayer.count({ where: { practitionerId: B.practitionerId } })).toBe(0);
    });
  });
});
