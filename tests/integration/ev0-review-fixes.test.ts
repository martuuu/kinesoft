/**
 * EV0 · V.Z (revisor a) — fixes de seguridad de la ola, sobre los símbolos
 * REALES de `lib/**` y el `getActor()` real (se mockea solo la sesión de
 * Supabase y `next/cache`, ver integration-setup).
 *
 *  - N1: `lib/programs.ts` no gateaba el módulo `planes` (C-EV4): un consultorio
 *    General podía crear/editar/borrar planes por RPC aunque la UI no los muestre.
 *    Escrituras → `ForbiddenError(MODULE_DENIED_COPY.planes)`; lecturas del perfil
 *    del paciente → `[]`.
 *  - N2: `createExercise` / `ensureTag` (lib/exercises.ts) sin `gate.canCreate`:
 *    General creaba ejercicios propios y tags globales.
 *  - P1 (preexistente, bloque A): `loadFilterFacets` leía `Condition` sin where
 *    → con BYPASSRLS (prod) devolvía las condiciones custom de TODOS los
 *    consultorios. Solo se ve con `test:integration:owner`.
 *  - P2 (preexistente, PD-14): el prefill del turnero buscaba la ficha por email
 *    en TODOS los consultorios (canal de servicio): DNI, nacimiento, cobertura y
 *    contacto de emergencia de la ficha de OTRO consultorio.
 *
 * Se afirma el efecto observable: filas que quedan (o no), qué devuelve la lista.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { ForbiddenError } from "@/lib/session";
import { MODULE_DENIED_COPY } from "@/lib/tenant-modules";
import {
  createProgram,
  updateProgram,
  setProgramStatus,
  deleteProgram,
  deleteSession,
  getPatientProgramsLite,
  getPatientProgramsFull,
} from "@/lib/programs";
import { createExercise, ensureTag, loadFilterFacets } from "@/lib/exercises";
import { loadPublicBookingPage } from "@/lib/public-booking-internal";
import {
  ownerClient,
  createEphemeralTenant,
  addPatient,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser, asAnonymous } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("EV0-Z · fixes de seguridad del revisor (a)", () => {
  let db: PrismaClient;
  let K: EphemeralTenant; // Kine FREE: tiene planes, ejercicios y diagnóstico
  let K2: EphemeralTenant; // otro Kine (vecino para la fuga de P1/P2)
  let G: EphemeralTenant; // consultorio General (PRO: el plan no le da módulos de Kine)
  let gPatient: string;
  let gProgram: { id: string; sessionId: string };

  beforeAll(async () => {
    db = ownerClient();
    K = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "FREE" });
    K2 = await createEphemeralTenant(db, { vertical: "KINESIOLOGY", plan: "FREE" });
    G = await createEphemeralTenant(db, { vertical: "GENERAL", plan: "PRO" });
    gPatient = await addPatient(db, G);
    // Un plan legacy en G (de antes de que el consultorio fuera General, o
    // creado por la vía que N1 cierra): las escrituras no lo pueden tocar.
    const p = await db.treatmentProgram.create({
      data: {
        tenantId: G.tenantId,
        patientId: gPatient,
        title: "Plan legacy",
        totalSessions: 2,
        frequency: 2,
        startDate: new Date(),
        status: "ACTIVE",
        sessions: {
          create: [
            { practitionerId: G.practitionerId, index: 1, scheduledFor: new Date() },
            { practitionerId: G.practitionerId, index: 2, scheduledFor: new Date() },
          ],
        },
      },
      include: { sessions: { orderBy: { index: "asc" } } },
    });
    gProgram = { id: p.id, sessionId: p.sessions[0].id };
  });

  afterAll(async () => {
    asAnonymous();
    // `Tag` es global (no cascadea con el tenant): si N2 vuelve a fugar, que el
    // run no deje basura en el catálogo local.
    await db?.tag.deleteMany({ where: { slug: { startsWith: "evz-" } } });
    for (const t of [K, K2, G]) await t?.cleanup();
    await db?.$disconnect();
  });

  // ── N1 ──────────────────────────────────────────────────────────────
  describe("N1 · planes sin el módulo", () => {
    it("[EV0-Z] General: createProgram tira Forbidden y no escribe", async () => {
      asUser(G.userId);
      const before = await db.treatmentProgram.count({ where: { tenantId: G.tenantId } });
      await expect(
        createProgram({ patientId: gPatient, title: "Nuevo", totalSessions: 3, frequency: 2, startDate: "2026-11-02" }),
      ).rejects.toThrow(new ForbiddenError(MODULE_DENIED_COPY.planes));
      expect(await db.treatmentProgram.count({ where: { tenantId: G.tenantId } })).toBe(before);
    });

    it("[EV0-Z] General: update/status/delete de plan y sesión tiran y no tocan filas", async () => {
      asUser(G.userId);
      await expect(updateProgram({ id: gProgram.id, title: "Cambiado" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(setProgramStatus({ id: gProgram.id, status: "PAUSED" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(deleteSession(gProgram.sessionId)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(deleteProgram(gProgram.id)).rejects.toBeInstanceOf(ForbiddenError);
      const row = await db.treatmentProgram.findUnique({
        where: { id: gProgram.id },
        include: { _count: { select: { sessions: true } } },
      });
      expect(row?.title).toBe("Plan legacy");
      expect(row?.status).toBe("ACTIVE");
      expect(row?.totalSessions).toBe(2);
      expect(row?._count.sessions).toBe(2);
    });

    it("[EV0-Z] General: las lecturas del perfil devuelven [] aunque haya filas", async () => {
      asUser(G.userId);
      expect(await getPatientProgramsLite(gPatient)).toEqual([]);
      expect(await getPatientProgramsFull(gPatient)).toEqual([]);
    });

    it("control: Kine crea y lee su plan", async () => {
      const patientId = await addPatient(db, K);
      asUser(K.userId);
      const res = await createProgram({ patientId, title: "Kine", totalSessions: 2, frequency: 2, startDate: "2026-11-02" });
      expect(res.ok).toBe(true);
      const lite = await getPatientProgramsLite(patientId);
      expect(lite.map((p) => p.title)).toEqual(["Kine"]);
    });
  });

  // ── N2 ──────────────────────────────────────────────────────────────
  describe("N2 · ejercicios y tags sin el módulo", () => {
    it("[EV0-Z] General: createExercise devuelve el copy del módulo y no crea la fila", async () => {
      asUser(G.userId);
      const name = `EVZ ejercicio ${uniqueSuffix()}`;
      const res = await createExercise({ name, muscleGroups: `evz-musculo-${uniqueSuffix()}` });
      expect(res).toEqual({ ok: false, error: MODULE_DENIED_COPY.ejercicios });
      expect(await db.exercise.count({ where: { tenantId: G.tenantId } })).toBe(0);
      expect(await db.exercise.count({ where: { name } })).toBe(0);
    });

    it("[EV0-Z] General: ensureTag tira y no crea el tag global", async () => {
      asUser(G.userId);
      const label = `evz-tag-${uniqueSuffix()}`;
      await expect(ensureTag(label)).rejects.toBeInstanceOf(ForbiddenError);
      expect(await db.tag.count({ where: { label } })).toBe(0);
    });
  });

  // ── P1 ──────────────────────────────────────────────────────────────
  describe("P1 · facetas de la biblioteca sin fuga de condiciones", () => {
    it("[EV0-Z] Kine no ve las condiciones custom de otro consultorio; General no ve ninguna", async () => {
      const s = uniqueSuffix();
      const foreign = await db.condition.create({
        data: { tenantId: K2.tenantId, slug: `evz-ajena-${s}`, name: `EVZ ajena ${s}` },
      });
      const mine = await db.condition.create({
        data: { tenantId: K.tenantId, slug: `evz-propia-${s}`, name: `EVZ propia ${s}` },
      });
      try {
        asUser(K.userId);
        const slugs = (await loadFilterFacets()).conditions.map((c) => c.slug);
        expect(slugs).toContain(mine.slug);
        expect(slugs).not.toContain(foreign.slug);

        asUser(G.userId);
        expect((await loadFilterFacets()).conditions).toEqual([]);
      } finally {
        await db.condition.deleteMany({ where: { id: { in: [foreign.id, mine.id] } } });
      }
    });
  });

  // ── P2 ──────────────────────────────────────────────────────────────
  describe("P2 · prefill del turnero solo con fichas del consultorio", () => {
    const visitorId = () => `visitor-${randomUUID().slice(0, 8)}`;

    it("[EV0-Z] ficha en otro consultorio con el mismo email: prefill null en este", async () => {
      const visitor = visitorId();
      await addPatient(db, K2, { firstName: "Ajena", documentId: "39111222", email: `${visitor}@test.local` });
      asUser(visitor);
      const page = await loadPublicBookingPage(K.slug);
      expect(page?.state).toBe("open");
      if (page?.state !== "open") return;
      expect(page.session?.email).toBe(`${visitor}@test.local`);
      expect(page.prefill).toBeNull();
      expect(JSON.stringify(page)).not.toContain("39111222");
    });

    it("[EV0-Z] la ficha vinculada al usuario gana sobre otra con el mismo email", async () => {
      const visitor = visitorId();
      // Ficha vinculada por userId (portal) con otro email, y otra ficha con el
      // email de la sesión: manda el vínculo, que prueba identidad.
      await db.userProfile.create({ data: { id: visitor, email: `${visitor}@test.local` } });
      try {
        const linked = await addPatient(db, K, { firstName: "Vinculada", email: `otro-${visitor}@test.local` });
        await db.patient.update({ where: { id: linked }, data: { userId: visitor } });
        await addPatient(db, K, { firstName: "PorEmail", email: `${visitor}@test.local` });
        asUser(visitor);
        const page = await loadPublicBookingPage(K.slug);
        if (page?.state !== "open") throw new Error("turnero cerrado");
        expect(page.prefill?.firstName).toBe("Vinculada");
      } finally {
        await db.patient.updateMany({ where: { userId: visitor }, data: { userId: null } });
        await db.userProfile.delete({ where: { id: visitor } });
      }
    });

    it("[EV0-Z] dos fichas del consultorio con el email (mayúsculas distintas): sin prefill", async () => {
      const visitor = visitorId();
      await addPatient(db, K, { firstName: "Uno", email: `${visitor}@test.local` });
      await addPatient(db, K, { firstName: "Dos", email: `${visitor.toUpperCase()}@TEST.LOCAL` });
      asUser(visitor);
      const page = await loadPublicBookingPage(K.slug);
      if (page?.state !== "open") throw new Error("turnero cerrado");
      expect(page.prefill).toBeNull();
    });

    it("control: una sola ficha del consultorio con el email → prefill", async () => {
      const visitor = visitorId();
      await addPatient(db, K, { firstName: "Unica", documentId: "39111333", email: `${visitor}@test.local` });
      asUser(visitor);
      const page = await loadPublicBookingPage(K.slug);
      if (page?.state !== "open") throw new Error("turnero cerrado");
      expect(page.prefill?.firstName).toBe("Unica");
      expect(page.prefill?.documentId).toBe("39111333");
    });
  });
});
