/**
 * EV0 · V.Z (revisor a) — fixes de seguridad de la ola, sobre los símbolos
 * REALES de `lib/**` y el `getActor()` real (se mockea solo la sesión de
 * Supabase y `next/cache`, ver integration-setup).
 *
 *  - N1: `lib/programs.ts` no gateaba el módulo `planes` (C-EV4): un consultorio
 *    General podía crear/editar/borrar planes por RPC aunque la UI no los muestre.
 *    Escrituras → `ForbiddenError(MODULE_DENIED_COPY.planes)`; lecturas del perfil
 *    del paciente → `[]`. P3-S27a retiró el alta, la edición y las lecturas
 *    viejas: los mismos casos se re-afirman sobre las puertas que las
 *    reemplazan (`createPlan`, `updatePlanDetails`, `getPatientPlans`), que
 *    devuelven el copy del módulo como `{ ok: false }` en vez de tirar.
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
import { setProgramStatus, deleteProgram, deleteSession } from "@/lib/programs";
import { createPlan, previewPlan } from "@/lib/plans";
import { updatePlanDetails } from "@/lib/plans-lifecycle";
import { getPatientPlans } from "@/lib/plans-read";
import type { PlanCreateInput } from "@/lib/plans-types";
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

  /** Borrador de `createPlan` (P3-S27a): 2 sesiones los lunes 10:00 AR. */
  const draft = (t: EphemeralTenant, patientId: string, title: string): PlanCreateInput => ({
    idempotencyKey: randomUUID(),
    patientId,
    discipline: "KINESIOLOGY",
    practitionerId: t.practitionerId,
    serviceId: t.serviceId,
    locationId: null,
    title,
    schedule: { v: 1, frequency: "weekly", slots: [{ dow: 1, startMin: 600 }] },
    startDayKey: "2030-11-04",
    totalSessions: 2,
    pricing: null,
    rows: [],
    stateToken: "sin-preview",
  });

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
    it("[EV0-Z → P3-S27a] General: createPlan (y su preview) rechazan con el copy del módulo y no escriben", async () => {
      asUser(G.userId);
      const before = await db.treatmentProgram.count({ where: { tenantId: G.tenantId } });
      // El copy exacto del módulo: un `stale-preview` (token inventado) o un
      // rechazo de validación también serían `ok: false` sin probar el gate.
      expect(await createPlan(draft(G, gPatient, "Nuevo"))).toEqual({ ok: false, error: MODULE_DENIED_COPY.planes });
      expect(await previewPlan(draft(G, gPatient, "Nuevo"))).toMatchObject({ ok: false, error: MODULE_DENIED_COPY.planes });
      expect(await db.treatmentProgram.count({ where: { tenantId: G.tenantId } })).toBe(before);
      expect(await db.booking.count({ where: { tenantId: G.tenantId } })).toBe(0);
    });

    it("[EV0-Z] General: update/status/delete de plan y sesión tiran y no tocan filas", async () => {
      asUser(G.userId);
      const expectedUpdatedAt = (await db.treatmentProgram.findUniqueOrThrow({ where: { id: gProgram.id } })).updatedAt.toISOString();
      expect(await updatePlanDetails({ programId: gProgram.id, expectedUpdatedAt, title: "Cambiado" })).toMatchObject({
        ok: false,
        error: MODULE_DENIED_COPY.planes,
      });
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

    it("[EV0-Z → P3-S27a] General: getPatientPlans vacío aunque haya filas (incluidos archivados)", async () => {
      asUser(G.userId);
      expect(await getPatientPlans({ patientId: gPatient })).toEqual({ ok: true, data: [] });
      expect(await getPatientPlans({ patientId: gPatient, includeArchived: true })).toEqual({ ok: true, data: [] });
    });

    it("control: Kine crea (preview → commit) y lee su plan", async () => {
      const patientId = await addPatient(db, K);
      asUser(K.userId);
      const input = draft(K, patientId, "Kine");
      const pv = await previewPlan(input);
      expect(pv.ok).toBe(true);
      if (!pv.ok) return;
      const res = await createPlan({
        ...input,
        stateToken: pv.preview.stateToken,
        rows: pv.preview.rows.map((r) => ({ index: r.index, kind: "create" as const })),
      });
      expect(res).toMatchObject({ ok: true });
      const plans = await getPatientPlans({ patientId });
      expect(plans.ok && plans.data.map((p) => p.title)).toEqual(["Kine"]);
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
