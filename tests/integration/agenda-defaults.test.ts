/**
 * Altas que nacen con la agenda configurada (B-pre B2.3 BOOT).
 *
 * Contrato: lo que crean `bootstrapTenant`, `acceptInvite`, `createInsurer`,
 * `addInsurerFromCatalog`, `updateInsurer` (reactivar), `createService` y
 * `updateService` (pasar a compartido) es EXACTAMENTE lo que el backfill de
 * `20261001090000_agenda_foundations` produciría para el mismo estado: mismas
 * filas, mismos valores y mismos ids determinísticos.
 *
 * Anti-false-green: la comparación no reescribe el backfill en TS. Se toma la
 * foto de lo que dejó la action, se borran las filas de agenda del tenant, se
 * ejecuta el SQL LITERAL del bloque de la migración (acotado con el GUC
 * `kinesoft.backfill_tenants`, como en agenda-backfill.test.ts) y se compara.
 * Actions REALES; solo se mockea la sesión de Supabase (actor.ts).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { bootstrapTenant } from "@/lib/tenant-bootstrap";
import { acceptInvite } from "@/app/invite/[token]/accept-action";
import { createInsurer, updateInsurer, addInsurerFromCatalog } from "@/lib/insurers";
import { createService, updateService } from "@/lib/services";
import {
  agendaDefaultIds,
  syncDefaultSchedulesToTenantHours,
  PRIMARY_LOCATION_NAME,
} from "@/lib/agenda-defaults";
import { hashInviteToken } from "@/lib/invitations-tokens";
import { matchKey } from "@/lib/catalog/normalize";
import { __rateLimitInternals } from "@/lib/rate-limit";
import {
  ownerClient,
  createEphemeralTenant,
  deleteTenantDeep,
  addPractitioner,
  addInsurer,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { asUser } from "@/tests/helpers/actor";
import { getActor } from "@/lib/session";

const RUN = process.env.INTEGRATION === "1";

const MIGRATION = join(
  process.cwd(),
  "prisma/migrations/20261001090000_agenda_foundations/migration.sql"
);

/** Sentencias del bloque de backfill de la migración, tal cual (ver agenda-backfill.test.ts). */
function backfillStatements(): string[] {
  const sql = readFileSync(MIGRATION, "utf8");
  const m = sql.match(
    /^-- >>> BACKFILL agenda_foundations BEGIN$([\s\S]*?)^-- <<< BACKFILL agenda_foundations END$/m
  );
  if (!m) throw new Error("No encuentro el bloque BACKFILL en la migración");
  return m[1]
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function runBackfill(db: PrismaClient, tenantIds: string[]): Promise<void> {
  const stmts = backfillStatements();
  await db.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      `SELECT set_config('kinesoft.backfill_tenants', $1, true)`,
      tenantIds.join(",")
    );
    for (const s of stmts) await tx.$executeRawUnsafe(s);
  });
}

/** Foto de la agenda del tenant (sin timestamps), opcionalmente de algunos profesionales. */
async function snapshot(db: PrismaClient, tenantId: string, practitionerIds?: string[]) {
  const byPrac = practitionerIds ? { practitionerId: { in: practitionerIds } } : {};
  const [locations, schedules, services, payers] = await Promise.all([
    db.location.findMany({
      where: { tenantId },
      select: { id: true, name: true, isPrimary: true, active: true, sortOrder: true },
      orderBy: { id: "asc" },
    }),
    db.practitionerSchedule.findMany({
      where: { tenantId, ...byPrac },
      select: {
        id: true,
        practitionerId: true,
        locationId: true,
        dow: true,
        startMin: true,
        endMin: true,
        validFrom: true,
        validUntil: true,
      },
      orderBy: { id: "asc" },
    }),
    db.practitionerService.findMany({
      where: { tenantId, ...byPrac },
      select: {
        id: true,
        practitionerId: true,
        serviceId: true,
        enabled: true,
        visibility: true,
        durationMin: true,
        minLeadMinutes: true,
        maxLeadDays: true,
        concurrencyOverride: true,
        maxConcurrent: true,
        notifyOnBooking: true,
      },
      orderBy: { id: "asc" },
    }),
    db.practitionerPayer.findMany({
      where: { tenantId, ...byPrac },
      select: { id: true, practitionerId: true, insurerId: true, active: true },
      orderBy: { id: "asc" },
    }),
  ]);
  return { locations, schedules, services, payers };
}

/** Lo que dejó la app === lo que deja el backfill partiendo del mismo estado sin agenda. */
async function expectSameAsBackfill(db: PrismaClient, tenantId: string, practitionerIds?: string[]) {
  const mine = await snapshot(db, tenantId, practitionerIds);
  await db.practitionerPayer.deleteMany({ where: { tenantId } });
  await db.practitionerService.deleteMany({ where: { tenantId } });
  await db.practitionerSchedule.deleteMany({ where: { tenantId } });
  await db.booking.updateMany({ where: { tenantId }, data: { locationId: null } });
  await db.location.deleteMany({ where: { tenantId } });
  await runBackfill(db, [tenantId]);
  const backfilled = await snapshot(db, tenantId, practitionerIds);
  expect(mine).toEqual(backfilled);
  return mine;
}

async function newInvite(db: PrismaClient, t: EphemeralTenant, email: string): Promise<string> {
  const raw = randomBytes(24).toString("base64url");
  await db.invitation.create({
    data: {
      tenantId: t.tenantId,
      email,
      firstName: "Nuevo",
      lastName: "Kine",
      role: "PRACTITIONER",
      token: hashInviteToken(raw),
      invitedById: t.userId,
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  return raw;
}

describe.skipIf(!RUN)("agenda por defecto en las altas (B2.3)", () => {
  let db: PrismaClient;
  /** A: tenant "migrado" (backfill corrido) que recibe altas. C: tenant SIN sede (creado antes de B2.3). */
  let A: EphemeralTenant;
  let C: EphemeralTenant;
  let bootTenantId: string | null = null;
  let aShared: string;
  let aActiveOs: string;
  let aInactiveOs: string;
  let pendingPrac: string; // profesional con membresía SIN aceptar
  let invited: { userId: string; practitionerId: string };
  const payerIds: string[] = [];

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    C = await createEphemeralTenant(db);
    await db.tenant.update({ where: { id: A.tenantId }, data: { businessHoursStart: 9, businessHoursEnd: 18 } });
    aShared = (
      await db.service.create({
        data: { tenantId: A.tenantId, practitionerId: null, name: "Compartido", durationMin: 30, priceCents: 0 },
      })
    ).id;
    aActiveOs = await addInsurer(db, A, { name: `OS activa ${uniqueSuffix()}` });
    aInactiveOs = await addInsurer(db, A, { name: `OS inactiva ${uniqueSuffix()}` });
    await db.insurer.update({ where: { id: aInactiveOs }, data: { active: false } });
    const s = uniqueSuffix();
    const pendingUser = `test-user-pend-${s}`;
    await db.userProfile.create({ data: { id: pendingUser, email: `${pendingUser}@test.local` } });
    pendingPrac = (await db.practitioner.create({ data: { tenantId: A.tenantId, userId: pendingUser } })).id;
    await db.membership.create({ data: { tenantId: A.tenantId, userId: pendingUser, role: "PRACTITIONER" } });
    // A existía al migrar: la migración ya le corrió el backfill.
    await runBackfill(db, [A.tenantId]);
  });

  afterAll(async () => {
    await A?.cleanup();
    await C?.cleanup();
    if (bootTenantId) await deleteTenantDeep(db, bootTenantId);
    if (db) {
      await db.userProfile.deleteMany({ where: { id: { startsWith: "test-user-pend-" }, memberships: { none: {} } } });
      await db.insurer.updateMany({ where: { payerId: { in: payerIds } }, data: { payerId: null } });
      await db.payer.deleteMany({ where: { id: { in: payerIds } } });
    }
    await db?.$disconnect();
  });

  beforeEach(() => {
    __rateLimitInternals.reset();
    asUser(A.userId);
  });

  it("bootstrapTenant: el tenant nace con sede Principal, franjas lun-sáb del OWNER y Particular aceptado (= backfill)", async () => {
    const s = uniqueSuffix();
    const userId = `test-user-boot-${s}`;
    const r = await db.$transaction((tx) =>
      bootstrapTenant(tx, {
        userId,
        email: `${userId}@test.local`,
        fullName: "Dueña Boot",
        clinicName: `Boot ${s}`,
        slug: `test-boot-${s}`,
        onboardingCompleted: false,
        source: "agenda-defaults.test",
      })
    );
    bootTenantId = r.tenantId;

    const snap = await expectSameAsBackfill(db, r.tenantId);
    expect(snap.locations).toEqual([
      {
        id: agendaDefaultIds.location(r.tenantId),
        name: PRIMARY_LOCATION_NAME,
        isPrimary: true,
        active: true,
        sortOrder: 0,
      },
    ]);
    expect(r.locationId).toBe(agendaDefaultIds.location(r.tenantId));
    // Horario del tenant recién creado: defaults del schema (8 a 19).
    expect(snap.schedules.map((x) => [x.dow, x.startMin, x.endMin, x.locationId]).sort()).toEqual(
      [1, 2, 3, 4, 5, 6].map((d) => [d, 480, 1140, r.locationId])
    );
    expect(snap.schedules.every((x) => x.practitionerId === r.practitionerId)).toBe(true);
    expect(snap.payers).toEqual([
      {
        id: agendaDefaultIds.payer(r.practitionerId, r.particularInsurerId),
        practitionerId: r.practitionerId,
        insurerId: r.particularInsurerId,
        active: true,
      },
    ]);
    expect(snap.services).toEqual([]);
  });

  it("acceptInvite: el profesional nuevo nace con franjas, servicios compartidos y coberturas activas (= backfill)", async () => {
    const uid = `test-user-inv-${uniqueSuffix()}`;
    const raw = await newInvite(db, A, `${uid}@test.local`);
    asUser(uid);
    expect(await acceptInvite(raw)).toEqual({ ok: true, data: undefined });

    const prac = await db.practitioner.findUniqueOrThrow({
      where: { tenantId_userId: { tenantId: A.tenantId, userId: uid } },
      select: { id: true },
    });
    invited = { userId: uid, practitionerId: prac.id };
    const mine = await snapshot(db, A.tenantId, [prac.id]);
    expect(mine.schedules).toHaveLength(6);
    expect(mine.schedules.every((x) => x.startMin === 540 && x.endMin === 1080)).toBe(true);
    // Solo el compartido (el de la factory es del OWNER).
    expect(mine.services.map((x) => x.serviceId)).toEqual([aShared]);
    expect(mine.services[0]).toMatchObject({ enabled: true, visibility: "PUBLIC" });
    // Particular + la activa; la inactiva no.
    expect(mine.payers.map((x) => x.insurerId).sort()).toEqual([A.particularInsurerId, aActiveOs].sort());

    // Todo el tenant (OWNER del backfill, invitado de la action, pendiente sin nada) = backfill.
    const all = await expectSameAsBackfill(db, A.tenantId);
    expect(all.schedules.some((x) => x.practitionerId === pendingPrac)).toBe(false);
    expect(all.payers.some((x) => x.practitionerId === pendingPrac)).toBe(false);
  });

  it("acceptInvite es idempotente: una segunda invitación aceptada no duplica ni pisa franjas editadas", async () => {
    // El profesional editó su lunes (simula el editor de B2.4a).
    const monday = agendaDefaultIds.schedule(invited.practitionerId, 1);
    await db.practitionerSchedule.update({ where: { id: monday }, data: { startMin: 600 } });
    const before = await snapshot(db, A.tenantId);

    const raw = await newInvite(db, A, `${invited.userId}@test.local`);
    asUser(invited.userId);
    expect(await acceptInvite(raw)).toEqual({ ok: true, data: undefined });

    expect(await snapshot(db, A.tenantId)).toEqual(before);
    expect(await db.practitioner.count({ where: { userId: invited.userId, tenantId: A.tenantId } })).toBe(1);
    await db.practitionerSchedule.update({ where: { id: monday }, data: { startMin: 540 } });
  });

  it("acceptInvite en un tenant sin sede principal la crea (tenant creado entre la migración y B2.3)", async () => {
    expect(await db.location.count({ where: { tenantId: C.tenantId } })).toBe(0);
    const uid = `test-user-inv-${uniqueSuffix()}`;
    const raw = await newInvite(db, C, `${uid}@test.local`);
    asUser(uid);
    expect(await acceptInvite(raw)).toEqual({ ok: true, data: undefined });
    const prac = await db.practitioner.findUniqueOrThrow({
      where: { tenantId_userId: { tenantId: C.tenantId, userId: uid } },
      select: { id: true },
    });

    const loc = await db.location.findFirstOrThrow({ where: { tenantId: C.tenantId, isPrimary: true } });
    expect(loc).toMatchObject({ id: agendaDefaultIds.location(C.tenantId), name: PRIMARY_LOCATION_NAME });
    // Comparado solo para el invitado: el OWNER de C (sin backfill) no lo toca la invitación.
    await expectSameAsBackfill(db, C.tenantId, [prac.id]);
  });

  // IAM-1 (M6, decisión 6 de Martin): antes («membresía sí, agenda no») el kine de A quedaba con membresía en
  // C SIN Practitioner ahí y `buildActor` no lo dejaba entrar a C (bucle, §19.1). Ahora es profesional de los
  // dos consultorios con el mismo usuario, cada uno con su agenda.
  it("[IAM-1] acceptInvite de alguien que ya es profesional de OTRO consultorio: queda profesional acá, con su agenda (= backfill)", async () => {
    const raw = await newInvite(db, C, `${invited.userId}@test.local`);
    asUser(invited.userId);
    expect(await acceptInvite(raw)).toEqual({ ok: true, data: undefined });
    expect(await db.membership.count({ where: { userId: invited.userId, tenantId: C.tenantId } })).toBe(1);

    const pracs = await db.practitioner.findMany({ where: { userId: invited.userId }, select: { id: true, tenantId: true } });
    expect(pracs.map((p) => p.tenantId).sort()).toEqual([A.tenantId, C.tenantId].sort());
    const inC = pracs.find((p) => p.tenantId === C.tenantId)!;
    expect(inC.id).not.toBe(invited.practitionerId);

    // La agenda nueva es del Practitioner de C; la de A no se tocó ni se mudó.
    expect(await db.practitionerSchedule.count({ where: { tenantId: C.tenantId, practitionerId: inC.id } })).toBe(6);
    expect(await db.practitionerSchedule.count({ where: { tenantId: C.tenantId, practitionerId: invited.practitionerId } })).toBe(0);
    expect(await db.practitionerSchedule.count({ where: { tenantId: A.tenantId, practitionerId: invited.practitionerId } })).toBe(6);
    await expectSameAsBackfill(db, C.tenantId, [inC.id]);

    // Y entra a C: sin cookie `buildActor` elige la membresía más reciente (C) y antes tiraba no_membership
    // porque no había Practitioner suyo en C (el bucle de §19.1).
    const actor = await getActor();
    expect(actor).toMatchObject({ tenantId: C.tenantId, practitionerId: inC.id, userId: invited.userId });

    const inv = await db.invitation.findFirstOrThrow({ where: { tenantId: C.tenantId, email: `${invited.userId}@test.local` }, orderBy: { invitedAt: "desc" } });
    expect(inv.acceptedByUserId).toBe(invited.userId);
  });

  it("createInsurer activa → la aceptan todos los aceptados (no el pendiente); inactiva → nadie hasta reactivarla", async () => {
    const r = await createInsurer({ name: `OS nueva ${uniqueSuffix()}`, copagoCents: 0, fixedFeeCents: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rows = await db.practitionerPayer.findMany({ where: { tenantId: A.tenantId, insurerId: r.data.id } });
    expect(rows.map((x) => x.practitionerId).sort()).toEqual([A.practitionerId, invited.practitionerId].sort());

    const off = await createInsurer({ name: `OS apagada ${uniqueSuffix()}`, copagoCents: 0, fixedFeeCents: 0, active: false });
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(await db.practitionerPayer.count({ where: { insurerId: off.data.id } })).toBe(0);
    await expectSameAsBackfill(db, A.tenantId);

    // Editar sin reactivar no agrega nada; reactivar sí (y re-guardar no duplica).
    expect((await updateInsurer(off.data.id, { copagoCents: 100 })).ok).toBe(true);
    expect(await db.practitionerPayer.count({ where: { insurerId: off.data.id } })).toBe(0);
    expect((await updateInsurer(off.data.id, { active: true })).ok).toBe(true);
    expect((await updateInsurer(off.data.id, { active: true })).ok).toBe(true);
    expect(await db.practitionerPayer.count({ where: { insurerId: off.data.id } })).toBe(2);
    await expectSameAsBackfill(db, A.tenantId);
  });

  it("addInsurerFromCatalog → la aceptan todos los aceptados (= backfill)", async () => {
    const name = `Prestadora Boot ${uniqueSuffix()}`;
    const payer = await db.payer.create({
      data: {
        slug: `test-payer-${uniqueSuffix()}`,
        name,
        kind: "OBRA_SOCIAL",
        matchKey: matchKey(name),
        aliases: [],
        source: "CURATED",
        sourceDate: new Date("2026-09-01"),
      },
      select: { id: true },
    });
    payerIds.push(payer.id);
    const r = await addInsurerFromCatalog(payer.id);
    expect(r.ok).toBe(true);
    if (!r.ok || r.data.status !== "created") throw new Error("esperaba created");
    expect(await db.practitionerPayer.count({ where: { insurerId: r.data.insurerId } })).toBe(2);
    await expectSameAsBackfill(db, A.tenantId);
  });

  it("createService compartido → todos los aceptados; con profesional → solo ese (= backfill)", async () => {
    const shared = await createService({ name: `Comp ${uniqueSuffix()}`, durationMin: 45, priceCents: 0 });
    const own = await createService({
      name: `Propio ${uniqueSuffix()}`,
      durationMin: 45,
      priceCents: 0,
      practitionerId: invited.practitionerId,
    });
    expect(shared.ok && own.ok).toBe(true);
    if (!shared.ok || !own.ok) return;
    const ps = (serviceId: string) =>
      db.practitionerService
        .findMany({ where: { serviceId }, select: { practitionerId: true } })
        .then((rows) => rows.map((x) => x.practitionerId).sort());
    expect(await ps(shared.data.id)).toEqual([A.practitionerId, invited.practitionerId].sort());
    expect(await ps(own.data.id)).toEqual([invited.practitionerId]);
    await expectSameAsBackfill(db, A.tenantId);

    // Pasarlo a compartido habilita a todos (igual que el backfill para un compartido).
    expect((await updateService(own.data.id, { practitionerId: "" })).ok).toBe(true);
    expect(await ps(own.data.id)).toEqual([A.practitionerId, invited.practitionerId].sort());
    await expectSameAsBackfill(db, A.tenantId);
  });

  it("[revisión B-pre] updateService compartido → dueño: los demás quedan PRIVATE (siguen habilitados)", async () => {
    const svc = await createService({ name: `A dueño ${uniqueSuffix()}`, durationMin: 45, priceCents: 0 });
    expect(svc.ok).toBe(true);
    if (!svc.ok) return;
    const rows = () =>
      db.practitionerService
        .findMany({ where: { serviceId: svc.data.id }, select: { practitionerId: true, visibility: true, enabled: true } })
        .then((r) => r.sort((a, b) => a.practitionerId.localeCompare(b.practitionerId)));
    const expected = (owner: string) =>
      [A.practitionerId, invited.practitionerId]
        .sort()
        .map((p) => ({ practitionerId: p, enabled: true, visibility: p === owner ? "PUBLIC" : "PRIVATE" }));

    expect((await updateService(svc.data.id, { practitionerId: invited.practitionerId })).ok).toBe(true);
    // El turnero vuelve a ofrecerlo solo con el dueño; la agenda sigue
    // permitiendo al otro (enabled intacto: no le corta turnos que ya daba).
    expect(await rows()).toEqual(expected(invited.practitionerId));

    // Editar otra cosa (sin `practitionerId`) no toca la visibilidad.
    expect((await updateService(svc.data.id, { priceCents: 1000 })).ok).toBe(true);
    expect(await rows()).toEqual(expected(invited.practitionerId));

    // Volver a compartido no republica (la visibilidad es del editor por profesional).
    expect((await updateService(svc.data.id, { practitionerId: "" })).ok).toBe(true);
    expect(await rows()).toEqual(expected(invited.practitionerId));

    // Este servicio diverge a propósito del backfill (PRIVATE): fuera, para que
    // los `expectSameAsBackfill` que siguen comparen solo lo de las altas.
    await db.service.delete({ where: { id: svc.data.id } });
  });

  it("createService con un profesional de otro tenant se rechaza y no deja filas", async () => {
    const r = await createService({ name: `IDOR ${uniqueSuffix()}`, durationMin: 45, practitionerId: C.practitionerId });
    expect(r.ok).toBe(false);
    expect(await db.practitionerService.count({ where: { practitionerId: C.practitionerId, tenantId: A.tenantId } })).toBe(0);
  });

  it("syncDefaultSchedulesToTenantHours: arrastra la plantilla por defecto y respeta la editada", async () => {
    // A: OWNER e invitado con la plantilla 9-18. Se edita la del invitado.
    const monday = agendaDefaultIds.schedule(invited.practitionerId, 1);
    await db.practitionerSchedule.update({ where: { id: monday }, data: { endMin: 720 } });
    const synced = await db.$transaction((tx) =>
      syncDefaultSchedulesToTenantHours(tx, {
        tenantId: A.tenantId,
        from: { start: 9, end: 18 },
        to: { start: 10, end: 20 },
      })
    );
    expect(synced).toEqual([A.practitionerId]);
    const owner = await db.practitionerSchedule.findMany({ where: { practitionerId: A.practitionerId } });
    expect(owner.every((x) => x.startMin === 600 && x.endMin === 1200)).toBe(true);
    const inv = await db.practitionerSchedule.findMany({ where: { practitionerId: invited.practitionerId } });
    expect(inv.every((x) => x.startMin === 540)).toBe(true);
    expect(inv.find((x) => x.id === monday)?.endMin).toBe(720);
  });
});
