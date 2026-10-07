/**
 * S13 (ES2b · P2.0) · Servicios: disciplina + guarda de borrado, contra la DB
 * real con el `getActor()` real (solo se mockea la sesión de Supabase). Corre
 * con los dos roles: `kinesoft_app` (RLS) y owner BYPASSRLS (= prod).
 *
 * Lo que se protege:
 *  - `deleteService`: M1 dejó `TreatmentProgram.serviceId` en RESTRICT. Antes
 *    la guarda contaba solo turnos, así que un servicio con planes (y sin
 *    turnos) llegaba al DELETE y Postgres lo rechazaba con P2003 → 500 genérico.
 *    Ahora se cuenta también `programs` (incluidos archivados/cancelados: la
 *    FK no mira el estado) con un mensaje accionable. `PlanTemplate.serviceId`
 *    es SET NULL: una plantilla no bloquea y queda sin servicio.
 *  - Enmienda EV0 literal: "**S13**: disciplina del servicio solo con `planes`
 *    (UI y server)." → `createService`/`updateService` rechazan `discipline`
 *    no nula sin el módulo `planes` (consultorio General). Limpiarla (null) se
 *    deja: no habilita nada.
 * Cada caso afirma el efecto observable (la fila quedó / no quedó así).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createService, updateService, deleteService, listServicesWithCounts } from "@/lib/services";
import { MODULE_DENIED_COPY } from "@/lib/tenant-modules";
import { matchKey } from "@/lib/catalog/normalize";
import {
  ownerClient,
  createEphemeralTenant,
  addService,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { createPlan } from "@/tests/helpers/plan-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

describe.skipIf(!RUN)("S13 · servicios: disciplina con `planes` y guarda de borrado", () => {
  let db: PrismaClient;
  let K: EphemeralTenant; // Kinesiología (FREE): tiene `planes`
  let G: EphemeralTenant; // General: sin `planes`
  const catalogIds = { practices: [] as string[], specialties: [] as string[] };

  beforeAll(async () => {
    db = ownerClient();
    K = await createEphemeralTenant(db, { vertical: "KINESIOLOGY" });
    G = await createEphemeralTenant(db, { vertical: "GENERAL" });
  });

  afterAll(async () => {
    await K?.cleanup();
    await G?.cleanup();
    if (catalogIds.practices.length) {
      await db.practice.deleteMany({ where: { id: { in: catalogIds.practices } } });
    }
    if (catalogIds.specialties.length) {
      await db.specialty.deleteMany({ where: { id: { in: catalogIds.specialties } } });
    }
  });

  // ── deleteService ────────────────────────────────────────────────────────

  it("[P2-S13] deleteService con planes o plantillas → mensaje claro, no P2003", async () => {
    const serviceId = await addService(db, K, { name: `Con plan ${uniqueSuffix()}` });
    await createPlan(db, K, { sessions: 1, data: { serviceId } });
    asUser(K.userId);
    const r = await deleteService(serviceId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/planes de tratamiento/);
    expect(await db.service.findUnique({ where: { id: serviceId } })).not.toBeNull();
  });

  it("un plan archivado/cancelado también bloquea (la FK no mira el estado)", async () => {
    const serviceId = await addService(db, K, { name: `Plan archivado ${uniqueSuffix()}` });
    await createPlan(db, K, {
      sessions: 1,
      data: { serviceId, status: "CANCELLED", archivedAt: new Date() },
    });
    asUser(K.userId);
    const r = await deleteService(serviceId);
    expect(r.ok).toBe(false);
    expect(await db.service.findUnique({ where: { id: serviceId } })).not.toBeNull();
  });

  it("solo una plantilla → se borra y la plantilla queda sin servicio (SET NULL)", async () => {
    const serviceId = await addService(db, K, { name: `Con plantilla ${uniqueSuffix()}` });
    const tpl = await db.planTemplate.create({
      data: {
        tenantId: K.tenantId,
        authorId: K.practitionerId,
        name: `Plantilla ${uniqueSuffix()}`,
        exerciseIds: [],
        serviceId,
      },
    });
    asUser(K.userId);
    const r = await deleteService(serviceId);
    expect(r).toEqual({ ok: true, data: undefined });
    expect(await db.service.findUnique({ where: { id: serviceId } })).toBeNull();
    expect((await db.planTemplate.findUniqueOrThrow({ where: { id: tpl.id } })).serviceId).toBeNull();
  });

  it("control: servicio sin turnos ni planes se borra", async () => {
    const serviceId = await addService(db, K, { name: `Libre ${uniqueSuffix()}` });
    asUser(K.userId);
    expect((await deleteService(serviceId)).ok).toBe(true);
    expect(await db.service.findUnique({ where: { id: serviceId } })).toBeNull();
  });

  // ── disciplina con/sin `planes` ───────────────────────────────────────────

  it("Kine: createService guarda la disciplina; updateService la cambia y la limpia", async () => {
    asUser(K.userId);
    const created = await createService({ name: `Osteo ${uniqueSuffix()}`, discipline: "OSTEOPATHY" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.data.id;
    expect((await db.service.findUniqueOrThrow({ where: { id } })).discipline).toBe("OSTEOPATHY");

    expect((await updateService(id, { discipline: "KINESIOLOGY" })).ok).toBe(true);
    expect((await db.service.findUniqueOrThrow({ where: { id } })).discipline).toBe("KINESIOLOGY");

    // "" (select vacío del form) = sin disciplina.
    expect((await updateService(id, { discipline: "" })).ok).toBe(true);
    expect((await db.service.findUniqueOrThrow({ where: { id } })).discipline).toBeNull();

    // Un update sin `discipline` no la toca.
    await db.service.update({ where: { id }, data: { discipline: "OSTEOPATHY" } });
    expect((await updateService(id, { priceCents: 1234 })).ok).toBe(true);
    expect((await db.service.findUniqueOrThrow({ where: { id } })).discipline).toBe("OSTEOPATHY");
  });

  it("General: createService con disciplina → rechazo y no crea la fila", async () => {
    asUser(G.userId);
    const name = `General osteo ${uniqueSuffix()}`;
    const r = await createService({ name, discipline: "OSTEOPATHY" });
    expect(r).toEqual({ ok: false, error: MODULE_DENIED_COPY.planes });
    expect(await db.service.count({ where: { tenantId: G.tenantId, name } })).toBe(0);
  });

  it("General: updateService con disciplina → rechazo y la fila queda igual; null pasa", async () => {
    const id = await addService(db, G, { name: `General ${uniqueSuffix()}` });
    asUser(G.userId);
    const r = await updateService(id, { discipline: "KINESIOLOGY", priceCents: 999 });
    expect(r).toEqual({ ok: false, error: MODULE_DENIED_COPY.planes });
    const row = await db.service.findUniqueOrThrow({ where: { id } });
    expect(row.discipline).toBeNull();
    expect(row.priceCents).toBe(8000);

    expect((await updateService(id, { discipline: null, priceCents: 999 })).ok).toBe(true);
    expect((await db.service.findUniqueOrThrow({ where: { id } })).priceCents).toBe(999);
  });

  it("General: createService sin disciplina sigue andando (control)", async () => {
    asUser(G.userId);
    const r = await createService({ name: `General libre ${uniqueSuffix()}` });
    expect(r.ok).toBe(true);
  });

  // ── listado: disciplina + sugerencia desde el catálogo (PQ-11) ───────────

  it("listServicesWithCounts devuelve la disciplina y la sugerida por la práctica", async () => {
    const s = uniqueSuffix().replace(/[^a-z0-9]/g, "");
    // La sugerencia se resuelve por slug de especialidad (`osteopatia`). El slug
    // real puede existir ya (import del catálogo): se reusa o se crea.
    let spec = await db.specialty.findUnique({ where: { slug: "osteopatia" } });
    if (!spec) {
      spec = await db.specialty.create({
        data: {
          slug: "osteopatia",
          name: "Osteopatía",
          matchKey: matchKey(`Osteopatía ${s}`),
          aliases: [],
          source: "CURATED",
          sourceDate: new Date("2026-09-01"),
        },
      });
      catalogIds.specialties.push(spec.id);
    }
    const practice = await db.practice.create({
      data: {
        slug: `test-practice-${s}`,
        name: `Practica osteo ${s}`,
        matchKey: matchKey(`Practica osteo ${s}`),
        aliases: [],
        source: "CURATED",
        sourceDate: new Date("2026-09-01"),
        specialties: { create: [{ specialtyId: spec.id }] },
      },
    });
    catalogIds.practices.push(practice.id);
    const id = await addService(db, K, { name: `Con practica ${s}` });
    await db.service.update({ where: { id }, data: { practiceId: practice.id } });

    asUser(K.userId);
    const row = (await listServicesWithCounts()).find((r) => r.id === id);
    expect(row).toMatchObject({ discipline: null, suggestedDiscipline: "OSTEOPATHY" });
  });
});
