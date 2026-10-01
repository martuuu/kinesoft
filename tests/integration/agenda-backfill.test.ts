/**
 * Backfill de `20261001090000_agenda_foundations` (B-pre B2.0, M-agenda).
 *
 * Qué se testea: el SQL LITERAL del bloque marcado de la migración
 * (`-- >>> BACKFILL agenda_foundations BEGIN` … `END`), leído del archivo y
 * ejecutado tal cual — el mismo texto que corre en prod (anti-false-green: no
 * se reescribe el backfill en TypeScript para testearlo).
 *
 * Por qué leído del archivo y no una función SQL persistente: una función
 * `agenda_foundations_backfill()` quedaría viva en prod (en Supabase, además,
 * expuesta por PostgREST como RPC salvo REVOKE explícito a anon/authenticated)
 * solo para poder testearla. El bloque del archivo no deja objetos y es lo que
 * Martin re-corre a mano si hace falta.
 *
 * Aislamiento: la base local es compartida (otros archivos y otras corridas en
 * paralelo crean tenants `test-*`). El bloque acepta el GUC opcional
 * `kinesoft.backfill_tenants` (ids separados por coma); sin setear = todos los
 * tenants (la migración). Acá se setea con `set_config(…, true)` dentro de la
 * transacción, así el backfill solo toca los tenants de este archivo — y un
 * tenant fuera de la lista prueba que el filtro funciona.
 *
 * Corre con el owner (BYPASSRLS), como la migración: vale en los dos modos.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  ownerClient,
  createEphemeralTenant,
  addPractitioner,
  addService,
  addInsurer,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";
import { agendaDefaultIds } from "@/lib/agenda-defaults";

const RUN = process.env.INTEGRATION === "1";

const MIGRATION = join(
  process.cwd(),
  "prisma/migrations/20261001090000_agenda_foundations/migration.sql"
);

/** Las sentencias del bloque de backfill, en orden, sin comentarios. */
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

type Counts = {
  location: number;
  schedule: number;
  practitionerService: number;
  practitionerServiceFromBookings: number;
  practitionerPayer: number;
  overbooked: number;
  bookingLocation: number;
};

/** Ejecuta el bloque acotado a `tenantIds` en UNA transacción (como la migración). */
async function runBackfill(db: PrismaClient, tenantIds: string[]): Promise<Counts> {
  const stmts = backfillStatements();
  const affected = await db.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(
      `SELECT set_config('kinesoft.backfill_tenants', $1, true)`,
      tenantIds.join(",")
    );
    const out: number[] = [];
    for (const s of stmts) out.push(await tx.$executeRawUnsafe(s));
    return out;
  });
  // [SET LOCAL row_security, (1), (2), (3), (3b), (4), (5), (6)]
  const [
    ,
    location,
    schedule,
    practitionerService,
    practitionerServiceFromBookings,
    practitionerPayer,
    overbooked,
    bookingLocation,
  ] = affected;
  return {
    location,
    schedule,
    practitionerService,
    practitionerServiceFromBookings,
    practitionerPayer,
    overbooked,
    bookingLocation,
  };
}

describe.skipIf(!RUN)("agenda_foundations · backfill (B2.0)", () => {
  let db: PrismaClient;
  /** A: caso completo. B: horario inválido. C: ya configurado. D: fuera del filtro. */
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let C: EphemeralTenant;
  let D: EphemeralTenant;
  let a2: string; // segundo profesional aceptado de A
  let a3: string; // profesional de A con invitación SIN aceptar
  let aOwnService: string;
  let aShared: string;
  let aOs: string;
  let aInactive: string;
  let bkSobreturno: string;
  let bkNormal: string;
  let bkC: string;
  let bkA2Foreign: string; // a2 atendió un servicio "propio" del dueño (3b)
  let bkA2Cancelled: string; // cancelado: no habilita nada (3b)
  let cLocation: string;
  let firstRun: Counts;
  /** updatedAt de cada turno ANTES del backfill (es el optimistic lock). */
  const updatedBefore = new Map<string, number>();

  const booking = (t: EphemeralTenant, notes: string | null, at: string) =>
    db.booking.create({
      data: {
        tenantId: t.tenantId,
        practitionerId: t.practitionerId,
        serviceId: t.serviceId,
        scheduledFor: new Date(at),
        durationMin: 45,
        idempotencyKey: randomUUID(),
        notes,
      },
    });

  beforeAll(async () => {
    db = ownerClient();
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
    C = await createEphemeralTenant(db);
    D = await createEphemeralTenant(db);

    // A: 9 a 18 h; dueño + otro aceptado + uno pendiente; servicio propio del
    // dueño (factory) + otro propio + uno compartido; Particular + una OS activa
    // + una inactiva; un turno con prefijo de sobreturno y uno normal.
    await db.tenant.update({
      where: { id: A.tenantId },
      data: { businessHoursStart: 9, businessHoursEnd: 18 },
    });
    a2 = (await addPractitioner(db, A)).practitionerId;
    const s = uniqueSuffix();
    const pendingUser = `test-user-${s}`;
    await db.userProfile.create({ data: { id: pendingUser, email: `${pendingUser}@test.local` } });
    a3 = (await db.practitioner.create({ data: { tenantId: A.tenantId, userId: pendingUser } })).id;
    await db.membership.create({
      data: { userId: pendingUser, tenantId: A.tenantId, role: "PRACTITIONER", acceptedAt: null },
    });
    aOwnService = await addService(db, A);
    aShared = (
      await db.service.create({
        data: { tenantId: A.tenantId, practitionerId: null, name: "Compartido", durationMin: 30 },
      })
    ).id;
    aOs = await addInsurer(db, A);
    aInactive = (
      await db.insurer.create({ data: { tenantId: A.tenantId, name: `OS baja ${s}`, active: false } })
    ).id;
    bkSobreturno = (await booking(A, "[SOBRETURNO] pedido por el paciente", "2026-10-05T13:00:00Z")).id;
    bkNormal = (await booking(A, "nota común con [SOBRETURNO] en el medio", "2026-10-05T14:00:00Z")).id;
    // (3b) Hallazgo de la revisión: hoy el alta no mira Service.practitionerId,
    // así que a2 pudo dar turnos de `aOwnService` (del dueño). Ese par tiene que
    // quedar habilitado (PRIVATE). Un turno CANCELADO de a2 con el servicio del
    // factory NO habilita ese par.
    bkA2Foreign = (
      await db.booking.create({
        data: {
          tenantId: A.tenantId,
          practitionerId: a2,
          serviceId: aOwnService,
          scheduledFor: new Date("2026-09-20T13:00:00Z"),
          durationMin: 45,
          idempotencyKey: randomUUID(),
        },
      })
    ).id;
    bkA2Cancelled = (
      await db.booking.create({
        data: {
          tenantId: A.tenantId,
          practitionerId: a2,
          serviceId: A.serviceId,
          scheduledFor: new Date("2026-10-07T13:00:00Z"),
          durationMin: 45,
          idempotencyKey: randomUUID(),
          status: "CANCELLED",
        },
      })
    ).id;

    // B: horario inválido (start >= end) → sin franjas (el loader cae al tenant).
    await db.tenant.update({
      where: { id: B.tenantId },
      data: { businessHoursStart: 18, businessHoursEnd: 9 },
    });

    // C: ya configurado — sede principal propia y una franja del dueño.
    cLocation = (
      await db.location.create({
        data: { tenantId: C.tenantId, name: "Sede Centro", isPrimary: true },
      })
    ).id;
    await db.practitionerSchedule.create({
      data: {
        tenantId: C.tenantId,
        practitionerId: C.practitionerId,
        locationId: cLocation,
        dow: 2,
        startMin: 600,
        endMin: 720,
      },
    });
    bkC = (await booking(C, null, "2026-10-06T13:00:00Z")).id;

    // D: tiene un turno, pero NO está en la lista del GUC.
    await booking(D, "[SOBRETURNO] x", "2026-10-06T13:00:00Z");

    for (const b of await db.booking.findMany({ where: { id: { in: [bkSobreturno, bkNormal, bkC, bkA2Foreign, bkA2Cancelled] } } })) {
      updatedBefore.set(b.id, b.updatedAt.getTime());
    }
    firstRun = await runBackfill(db, [A.tenantId, B.tenantId, C.tenantId]);
  });

  afterAll(async () => {
    for (const t of [A, B, C, D]) await t?.cleanup();
    await db?.$disconnect();
  });

  it("el bloque del archivo tiene la guarda + las 7 sentencias, sin ';' internos", () => {
    const stmts = backfillStatements();
    expect(stmts).toHaveLength(8);
    expect(stmts[0]).toMatch(/^SET LOCAL row_security = off$/);
    expect(stmts.slice(1).map((s) => s.split(/\s+/)[0])).toEqual([
      "INSERT", "INSERT", "INSERT", "INSERT", "INSERT", "UPDATE", "UPDATE",
    ]);
  });

  it("conteos de la primera corrida", () => {
    expect(firstRun).toEqual({
      location: 2, // A y B (C ya tenía principal)
      schedule: 12, // A: 2 aceptados × lun-sáb (B horario inválido, C ya configurado)
      practitionerService: 6, // A: 2 propios + compartido × 2 aceptados; B: 1; C: 1
      practitionerServiceFromBookings: 1, // A: (a2, aOwnService); el cancelado no cuenta
      practitionerPayer: 6, // A: 2 activos × 2 aceptados; B: 1; C: 1
      overbooked: 1,
      bookingLocation: 5, // A: 4 (incluido el cancelado), C: 1
    });
  });

  it("(1) sede 'Principal' única por tenant; respeta la existente", async () => {
    const locsA = await db.location.findMany({ where: { tenantId: A.tenantId } });
    expect(locsA).toHaveLength(1);
    expect(locsA[0]).toMatchObject({ name: "Principal", isPrimary: true, active: true });
    expect(await db.location.count({ where: { tenantId: B.tenantId, isPrimary: true } })).toBe(1);
    const locsC = await db.location.findMany({ where: { tenantId: C.tenantId } });
    expect(locsC.map((l) => l.id)).toEqual([cLocation]);
    expect(await db.location.count({ where: { tenantId: D.tenantId } })).toBe(0);
  });

  it("(2) franjas lun-sáb con el horario del tenant, solo aceptados y sin pisar lo cargado", async () => {
    const primaryA = await db.location.findFirstOrThrow({ where: { tenantId: A.tenantId, isPrimary: true } });
    const rows = await db.practitionerSchedule.findMany({
      where: { tenantId: A.tenantId },
      orderBy: [{ practitionerId: "asc" }, { dow: "asc" }],
    });
    expect(rows).toHaveLength(12);
    for (const p of [A.practitionerId, a2]) {
      const mine = rows.filter((r) => r.practitionerId === p);
      // Convención toARDow: 0=Dom … 6=Sáb → domingo (0) afuera.
      expect(mine.map((r) => r.dow)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(mine.every((r) => r.startMin === 540 && r.endMin === 1080)).toBe(true);
      expect(mine.every((r) => r.locationId === primaryA.id && r.validFrom === null && r.validUntil === null)).toBe(true);
    }
    expect(rows.some((r) => r.practitionerId === a3)).toBe(false);
    expect(await db.practitionerSchedule.count({ where: { tenantId: B.tenantId } })).toBe(0);
    const c = await db.practitionerSchedule.findMany({ where: { tenantId: C.tenantId } });
    expect(c.map((r) => [r.dow, r.startMin, r.endMin])).toEqual([[2, 600, 720]]);
  });

  it("(3) PractitionerService: propio → solo su dueño; compartido → todos los aceptados; PUBLIC + enabled", async () => {
    const rows = (await db.practitionerService.findMany({ where: { tenantId: A.tenantId } })).filter(
      (r) => r.visibility === "PUBLIC"
    );
    const pairs = rows.map((r) => `${r.practitionerId}|${r.serviceId}`).sort();
    expect(pairs).toEqual(
      [
        `${A.practitionerId}|${A.serviceId}`,
        `${A.practitionerId}|${aOwnService}`,
        `${A.practitionerId}|${aShared}`,
        `${a2}|${aShared}`,
      ].sort()
    );
    expect(
      rows.every(
        (r) =>
          r.enabled &&
          r.visibility === "PUBLIC" &&
          r.durationMin === null &&
          r.maxConcurrent === null &&
          !r.concurrencyOverride
      )
    ).toBe(true);
  });

  it("(3b) lo que el profesional ya atendía (turno no cancelado) queda habilitado PRIVATE; lo cancelado no", async () => {
    const extra = await db.practitionerService.findMany({
      where: { tenantId: A.tenantId, visibility: "PRIVATE" },
    });
    expect(extra.map((r) => `${r.practitionerId}|${r.serviceId}`)).toEqual([`${a2}|${aOwnService}`]);
    expect(extra[0]).toMatchObject({ enabled: true, durationMin: null, maxConcurrent: null, concurrencyOverride: false });
    // Mismo id md5 que (3) para el par: altas y backfill no se duplican.
    expect(extra[0].id).toBe(agendaDefaultIds.service(a2, aOwnService));
    expect(
      await db.practitionerService.count({ where: { practitionerId: a2, serviceId: A.serviceId } })
    ).toBe(0);
    // Un par que (3) ya creó PUBLIC no se pisa con PRIVATE (el dueño atiende su servicio).
    const own = await db.practitionerService.findFirstOrThrow({
      where: { practitionerId: A.practitionerId, serviceId: A.serviceId },
    });
    expect(own.visibility).toBe("PUBLIC");
  });

  it("(4) PractitionerPayer: aceptados × Insurers activos (incl. Particular), no los inactivos", async () => {
    const rows = await db.practitionerPayer.findMany({ where: { tenantId: A.tenantId } });
    const pairs = rows.map((r) => `${r.practitionerId}|${r.insurerId}`).sort();
    expect(pairs).toEqual(
      [
        `${A.practitionerId}|${A.particularInsurerId}`,
        `${A.practitionerId}|${aOs}`,
        `${a2}|${A.particularInsurerId}`,
        `${a2}|${aOs}`,
      ].sort()
    );
    expect(rows.some((r) => r.insurerId === aInactive || r.practitionerId === a3)).toBe(false);
  });

  it("(5)(6) Booking: isOverbooked solo con el PREFIJO, sede principal, sin tocar updatedAt", async () => {
    const primaryA = await db.location.findFirstOrThrow({ where: { tenantId: A.tenantId, isPrimary: true } });
    const [s, n, c] = await Promise.all([
      db.booking.findUniqueOrThrow({ where: { id: bkSobreturno } }),
      db.booking.findUniqueOrThrow({ where: { id: bkNormal } }),
      db.booking.findUniqueOrThrow({ where: { id: bkC } }),
    ]);
    expect(s.isOverbooked).toBe(true);
    expect(s.notes).toBe("[SOBRETURNO] pedido por el paciente"); // el prefijo se conserva
    expect(n.isOverbooked).toBe(false);
    expect([s.locationId, n.locationId]).toEqual([primaryA.id, primaryA.id]);
    expect(c.locationId).toBe(cLocation);
    // updatedAt es el optimistic lock: el backfill no lo mueve (sin trigger,
    // @updatedAt lo pone el cliente Prisma, no la base).
    for (const b of [s, n, c]) expect(b.updatedAt.getTime()).toBe(updatedBefore.get(b.id));
    const d = await db.booking.findFirstOrThrow({ where: { tenantId: D.tenantId } });
    expect([d.isOverbooked, d.locationId]).toEqual([false, null]);
  });

  it("idempotente: la segunda corrida no cambia nada", async () => {
    const snapshot = async () => {
      const where = { tenantId: { in: [A.tenantId, B.tenantId, C.tenantId] } };
      return {
        loc: await db.location.findMany({ where, orderBy: { id: "asc" } }),
        sch: await db.practitionerSchedule.findMany({ where, orderBy: { id: "asc" } }),
        ps: await db.practitionerService.findMany({ where, orderBy: { id: "asc" } }),
        pp: await db.practitionerPayer.findMany({ where, orderBy: { id: "asc" } }),
        bk: await db.booking.findMany({ where, orderBy: { id: "asc" } }),
      };
    };
    const before = await snapshot();
    const again = await runBackfill(db, [A.tenantId, B.tenantId, C.tenantId]);
    expect(again).toEqual({
      location: 0,
      schedule: 0,
      practitionerService: 0,
      practitionerServiceFromBookings: 0,
      practitionerPayer: 0,
      overbooked: 0,
      bookingLocation: 0,
    });
    expect(await snapshot()).toEqual(before);
  });

  it("ids determinísticos (md5): re-crear una fila borrada da el mismo id", async () => {
    const row = await db.practitionerPayer.findFirstOrThrow({
      where: { practitionerId: a2, insurerId: aOs },
    });
    await db.practitionerPayer.delete({ where: { id: row.id } });
    const counts = await runBackfill(db, [A.tenantId]);
    expect(counts.practitionerPayer).toBe(1);
    const back = await db.practitionerPayer.findFirstOrThrow({
      where: { practitionerId: a2, insurerId: aOs },
    });
    expect(back.id).toBe(row.id);
  });
});
