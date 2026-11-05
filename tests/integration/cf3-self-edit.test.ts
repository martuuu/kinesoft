/**
 * CF3 AU-S (§30, D-CF3-7) — el profesional edita SU agenda sin «Configuración», contra la DB real (rol app con RLS y
 * owner BYPASSRLS = prod).
 *
 * Lo que se protege (D-CF3-7; decisión de Martin del 04-nov «Todo + crear servicios»):
 *   • propio → ok: servicios (habilitar, duración, visibilidad, precio), semana y excepciones (vacaciones);
 *   • ajeno sin permiso → `ForbiddenError` y NADA escrito (efecto observable en la base);
 *   • Secretaria y Facturación sin «Configuración» → rechazo (no tienen agenda propia);
 *   • con «Configuración» → lo ajeno sigue andando (`via: "config"`);
 *   • los mismos validadores para todos: choque de sala con otro profesional, sede del tenant, servicio del tenant;
 *   • lo que sigue siendo del consultorio: el tope de turnos por intervalo, las reglas de agenda (pasos) y las
 *     excepciones de TODO el consultorio;
 *   • el precio por profesional (`priceCents`, M22): 0..100 000 000, `null` = hereda, omitido = no se toca;
 *   • audit en la tx con `via` (ver la cabecera de `lib/practitioner-self-scope.ts` por qué solo `self` y plata).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { listPractitionerServices, upsertPractitionerService } from "@/lib/practitioner-services";
import {
  deleteException,
  getPractitionerSchedule,
  listExceptions,
  savePractitionerWeek,
  setPractitionerAgendaRules,
  setPractitionerBookingCap,
  upsertException,
} from "@/lib/practitioner-schedule";
import { ForbiddenError } from "@/lib/session";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  addStaff,
  addRoom,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";

const RUN = process.env.INTEGRATION === "1";

const PS = { enabled: true, visibility: "PUBLIC" as const, concurrencyOverride: false, notifyOnBooking: false };

describe.skipIf(!RUN)("[CF3-AUS] autoedición de la agenda del profesional (D-CF3-7)", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let loc: string;
  let ana: { userId: string; practitionerId: string };
  let beto: { userId: string; practitionerId: string };
  let admin: { userId: string; practitionerId: string };
  let secre: { userId: string };
  let fact: { userId: string };
  let shared: string;
  let betoOwn: string;

  beforeAll(async () => {
    db = ownerClient();
    // Clínica: con salas, para probar el choque de sala entre profesionales con el actor propio.
    A = await createEphemeralTenant(db, { saasPlan: "CLINICA" });
    B = await createEphemeralTenant(db);
    loc = (await db.location.create({ data: { tenantId: A.tenantId, name: "Centro", isPrimary: true } })).id;
    ana = await addPractitioner(db, A, "PRACTITIONER");
    beto = await addPractitioner(db, A, "PRACTITIONER");
    await db.userProfile.update({ where: { id: beto.userId }, data: { fullName: "Beto Gómez" } });
    admin = await addPractitioner(db, A, "ADMIN"); // con «Configuración» (grantSettings)
    secre = await addStaff(db, A, "ASSISTANT");
    fact = await addStaff(db, A, "BILLING");
    shared = (await db.service.create({ data: { tenantId: A.tenantId, practitionerId: null, name: "Gimnasio", durationMin: 60, priceCents: 900_000 } })).id;
    betoOwn = (await db.service.create({ data: { tenantId: A.tenantId, practitionerId: beto.practitionerId, name: "RPG de Beto", durationMin: 45 } })).id;
  });
  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await db?.$disconnect();
  });

  const psRow = (practitionerId: string, serviceId: string) =>
    db.practitionerService.findUnique({ where: { practitionerId_serviceId: { practitionerId, serviceId } } });

  // ── servicios ──────────────────────────────────────────────────────────────
  it("[CF3-AUS1] propio: lista sus servicios con precio y guarda habilitar/duración/visibilidad/precio", async () => {
    asUser(ana.userId);
    const list = await listPractitionerServices(ana.practitionerId);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const gim = list.data.find((r) => r.serviceId === shared);
    expect(gim).toMatchObject({ priceCents: null, servicePriceCents: 900_000, enabled: true });
    // El servicio propio de OTRO profesional no se le ofrece (no puede habilitárselo: ver AUS3).
    expect(list.data.some((r) => r.serviceId === betoOwn)).toBe(false);

    const r = await upsertPractitionerService(ana.practitionerId, shared, {
      ...PS,
      durationMin: 30,
      visibility: "PRIVATE",
      priceCents: 1_250_000,
    });
    expect(r.ok).toBe(true);
    expect(await psRow(ana.practitionerId, shared)).toMatchObject({
      tenantId: A.tenantId,
      durationMin: 30,
      visibility: "PRIVATE",
      priceCents: 1_250_000,
    });
    const audit = await db.auditEvent.findMany({
      where: { tenantId: A.tenantId, action: "practitionerService.update", entityId: r.ok ? r.data.id : "" },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorId).toBe(ana.userId);
    expect(audit[0]!.payload).toMatchObject({ via: "self", serviceId: shared, practitionerId: ana.practitionerId });

    // Omitir `priceCents` no lo pisa (el editor de Profesionales de hoy no lo manda); `null` vuelve a heredar.
    expect((await upsertPractitionerService(ana.practitionerId, shared, { ...PS, visibility: "PUBLIC" })).ok).toBe(true);
    expect((await psRow(ana.practitionerId, shared))?.priceCents).toBe(1_250_000);
    expect((await upsertPractitionerService(ana.practitionerId, shared, { ...PS, priceCents: null })).ok).toBe(true);
    expect((await psRow(ana.practitionerId, shared))?.priceCents).toBeNull();
    // 0 es válido (sesión sin cargo).
    expect((await upsertPractitionerService(ana.practitionerId, shared, { ...PS, priceCents: 0 })).ok).toBe(true);
    expect((await psRow(ana.practitionerId, shared))?.priceCents).toBe(0);
  });

  it("[CF3-AUS2] precio fuera de rango o no entero → rechazo con fieldErrors y sin escribir", async () => {
    asUser(ana.userId);
    const before = await psRow(ana.practitionerId, shared);
    for (const priceCents of [-1, 100_000_001, 12.5]) {
      const r = await upsertPractitionerService(ana.practitionerId, shared, { ...PS, priceCents });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.fieldErrors?.priceCents?.length).toBeTruthy();
    }
    expect((await upsertPractitionerService(ana.practitionerId, shared, { ...PS, priceCents: 100_000_000 })).ok).toBe(true);
    expect((await psRow(ana.practitionerId, shared))?.priceCents).toBe(100_000_000);
    expect(before).not.toBeNull();
  });

  it("[CF3-AUS3] propio: no se habilita el servicio propio de OTRO profesional ni uno de otro consultorio", async () => {
    asUser(ana.userId);
    expect(await upsertPractitionerService(ana.practitionerId, betoOwn, PS)).toEqual({
      ok: false,
      error: "Ese servicio es de otro profesional.",
    });
    expect(await psRow(ana.practitionerId, betoOwn)).toBeNull();
    expect(await upsertPractitionerService(ana.practitionerId, B.serviceId, PS)).toEqual({
      ok: false,
      error: "Servicio no encontrado.",
    });
    expect(await psRow(ana.practitionerId, B.serviceId)).toBeNull();
    // Con «Configuración» sí (como hasta hoy): el Administrador/a le puede habilitar a Ana el servicio de Beto.
    asUser(admin.userId);
    expect((await upsertPractitionerService(ana.practitionerId, betoOwn, { ...PS, enabled: false })).ok).toBe(true);
  });

  it("[CF3-AUS4] ajeno sin permiso, Secretaria y Facturación → ForbiddenError y nada escrito", async () => {
    const before = await psRow(beto.practitionerId, shared);
    for (const u of [ana.userId, secre.userId, fact.userId]) {
      asUser(u);
      await expect(listPractitionerServices(beto.practitionerId)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(upsertPractitionerService(beto.practitionerId, shared, { ...PS, priceCents: 1 })).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await psRow(beto.practitionerId, shared)).toEqual(before);
  });

  it("[CF3-AUS5] con «Configuración»: lo ajeno anda; precio auditado con via config, el resto sin audit (PL-A2)", async () => {
    asUser(admin.userId);
    const r = await upsertPractitionerService(beto.practitionerId, shared, { ...PS, priceCents: 700_000 });
    expect(r.ok).toBe(true);
    expect((await psRow(beto.practitionerId, shared))?.priceCents).toBe(700_000);
    const id = r.ok ? r.data.id : "";
    const ev = await db.auditEvent.findMany({ where: { tenantId: A.tenantId, action: "practitionerService.update", entityId: id } });
    expect(ev).toHaveLength(1);
    // Sin fila previa: `from` null (la fila nace con el precio).
    expect(ev[0]!.payload).toMatchObject({ via: "config", from: null, to: { priceCents: 700_000 } });
    // Sin cambio de precio por config: ruido operativo, sin audit (§20.5.9).
    expect((await upsertPractitionerService(beto.practitionerId, shared, { ...PS, durationMin: 50 })).ok).toBe(true);
    expect(await db.auditEvent.count({ where: { tenantId: A.tenantId, action: "practitionerService.update", entityId: id } })).toBe(1);
  });

  // ── semana ─────────────────────────────────────────────────────────────────
  it("[CF3-AUS6] semana propia: lee, guarda (audit via self) y respeta el choque de sala con otro profesional", async () => {
    const { roomId } = await addRoom(db, A, { locationId: loc, name: "Consultorio 1", capacity: 1 });
    asUser(admin.userId);
    expect((await savePractitionerWeek(beto.practitionerId, [{ dow: 1, startMin: 540, endMin: 780, locationId: loc, roomId }])).ok).toBe(true);

    asUser(ana.userId);
    expect(await getPractitionerSchedule(ana.practitionerId)).toMatchObject({ practitionerId: ana.practitionerId, ranges: [] });
    const clash = await savePractitionerWeek(ana.practitionerId, [{ dow: 1, startMin: 600, endMin: 660, locationId: loc, roomId }]);
    expect(clash).toMatchObject({ ok: false, fieldErrors: { "ranges.0": [expect.stringContaining("Esa sala ya la usa Beto Gómez")] } });
    expect(await db.practitionerSchedule.count({ where: { practitionerId: ana.practitionerId } })).toBe(0);
    // Sede de otro consultorio: el mismo validador que para Configuración.
    const locB = (await db.location.create({ data: { tenantId: B.tenantId, name: "Ajena" } })).id;
    expect((await savePractitionerWeek(ana.practitionerId, [{ dow: 2, startMin: 540, endMin: 600, locationId: locB }])).ok).toBe(false);
    expect(await db.practitionerSchedule.count({ where: { practitionerId: ana.practitionerId } })).toBe(0);

    const ok = await savePractitionerWeek(ana.practitionerId, [{ dow: 2, startMin: 540, endMin: 780, locationId: loc, roomId }], null);
    expect(ok.ok).toBe(true);
    expect(await db.practitionerSchedule.findMany({ where: { practitionerId: ana.practitionerId }, select: { dow: true, roomId: true } })).toEqual([
      { dow: 2, roomId },
    ]);
    const ev = await db.auditEvent.findMany({ where: { tenantId: A.tenantId, action: "practitionerSchedule.replace", entityId: ana.practitionerId } });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ via: "self", from: [], to: [{ dow: 2, startMin: 540, endMin: 780, locationId: loc }] });
  });

  it("[CF3-AUS7] semana ajena sin permiso, Secretaria y Facturación → ForbiddenError sin escribir; con «Configuración» ok", async () => {
    const before = await db.practitionerSchedule.findMany({ where: { practitionerId: beto.practitionerId } });
    for (const u of [ana.userId, secre.userId, fact.userId]) {
      asUser(u);
      await expect(savePractitionerWeek(beto.practitionerId, [{ dow: 3, startMin: 540, endMin: 600, locationId: loc }])).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await db.practitionerSchedule.findMany({ where: { practitionerId: beto.practitionerId } })).toEqual(before);
    asUser(admin.userId);
    expect((await savePractitionerWeek(beto.practitionerId, [{ dow: 3, startMin: 540, endMin: 600, locationId: loc }])).ok).toBe(true);
    // Por config no se audita la semana (ruido operativo, §20.5.9).
    expect(await db.auditEvent.count({ where: { tenantId: A.tenantId, action: "practitionerSchedule.replace", entityId: beto.practitionerId } })).toBe(0);
  });

  // ── excepciones (vacaciones) ───────────────────────────────────────────────
  it("[CF3-AUS8] excepciones propias: crear, editar, listar y borrar; audit via self", async () => {
    asUser(ana.userId);
    const c = await upsertException({ practitionerId: ana.practitionerId, date: "2031-01-06", kind: "CLOSED", reason: "Vacaciones" });
    expect(c.ok).toBe(true);
    const e = await upsertException({ practitionerId: ana.practitionerId, date: "2031-01-06", kind: "CUSTOM_HOURS", ranges: [{ startMin: 540, endMin: 600, locationId: loc }] });
    expect(e.ok).toBe(true);
    const id = c.ok ? c.data.id : "";
    expect((await db.scheduleException.findUniqueOrThrow({ where: { id } })).kind).toBe("CUSTOM_HOURS");
    const listed = await listExceptions({ from: "2031-01-01", to: "2031-01-31", practitionerId: ana.practitionerId });
    expect(listed.ok && listed.data.map((x) => x.id)).toEqual([id]);
    expect((await deleteException(id)).ok).toBe(true);
    expect(await db.scheduleException.count({ where: { id } })).toBe(0);
    const ev = await db.auditEvent.findMany({ where: { tenantId: A.tenantId, entityId: id }, orderBy: { createdAt: "asc" } });
    expect(ev.map((x) => [x.action, (x.payload as { via?: string }).via])).toEqual([
      ["scheduleException.upsert", "self"],
      ["scheduleException.upsert", "self"],
      ["scheduleException.delete", "self"],
    ]);
  });

  it("[CF3-AUS9] excepciones ajenas o de todo el consultorio sin permiso → ForbiddenError y nada escrito ni borrado", async () => {
    asUser(admin.userId);
    const betoExc = await upsertException({ practitionerId: beto.practitionerId, date: "2031-02-03", kind: "CLOSED" });
    const tenantExc = await upsertException({ practitionerId: null, date: "2031-02-04", kind: "CLOSED" });
    expect(betoExc.ok && tenantExc.ok).toBe(true);
    const ids = [betoExc.ok ? betoExc.data.id : "", tenantExc.ok ? tenantExc.data.id : ""];
    for (const u of [ana.userId, secre.userId, fact.userId]) {
      asUser(u);
      await expect(upsertException({ practitionerId: beto.practitionerId, date: "2031-02-05", kind: "CLOSED" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(upsertException({ practitionerId: null, date: "2031-02-06", kind: "CLOSED" })).rejects.toBeInstanceOf(ForbiddenError);
      for (const id of ids) await expect(deleteException(id)).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await db.scheduleException.count({ where: { id: { in: ids } } })).toBe(2);
    expect(await db.scheduleException.count({ where: { tenantId: A.tenantId, date: { in: [new Date("2031-02-05"), new Date("2031-02-06")] } } })).toBe(0);
    // Una excepción de OTRO consultorio: «no encontrada» (no se distingue de un id inexistente), también con permiso.
    asUser(B.userId);
    const foreign = await upsertException({ practitionerId: B.practitionerId, date: "2031-02-07", kind: "CLOSED" });
    asUser(admin.userId);
    expect(await deleteException(foreign.ok ? foreign.data.id : "x")).toEqual({ ok: false, error: "Excepción no encontrada." });
    expect(await db.scheduleException.count({ where: { tenantId: B.tenantId } })).toBe(1);
  });

  // ── lo que sigue siendo del consultorio ────────────────────────────────────
  it("[CF3-AUS10] tope de turnos y reglas de agenda propias: siguen pidiendo «Configuración»", async () => {
    asUser(ana.userId);
    await expect(setPractitionerBookingCap(ana.practitionerId, { mode: "NONE" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setPractitionerAgendaRules(ana.practitionerId, { allowParallelServices: true, agendaSlotStepMin: null, publicSlotStepMin: null })).rejects.toBeInstanceOf(ForbiddenError);
  });
});
