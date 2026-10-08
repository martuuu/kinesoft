/**
 * M4 `20261009120000_rooms` · corrida SR, ola SR0 (plan §17.1 y §17.5).
 *
 * Qué se prueba:
 *   1. Objeto por objeto: enum RoomKind, columnas de Room y los 3 `roomId` nuevos,
 *      las 11 FKs con su `confdeltype` / `confupdtype` y sus columnas, los 5 CHECKs,
 *      los índices (con el único PARCIAL + expresión literal), RLS ENABLE + FORCE +
 *      la policy, y los privilegios de kinesoft_app (por DEFAULT PRIVILEGES: la
 *      migración no tiene GRANT).
 *   2. Las garantías viven EN LA BASE, con el owner (BYPASSRLS = prod), por SQLSTATE:
 *      sala de B en sede de A, turno / franja / bloqueo con sala de otra sede o de
 *      otro tenant (23503); turno con sala sin sede (23514, SR-D6); bloqueo de sala
 *      con profesional o sin sede (23514, §17.5); capacity / name / sortOrder fuera
 *      de rango (23514); nombre repetido entre activas de la misma sede (23505), que
 *      una archivada libera.
 *   3. Acciones ON DELETE: sala con turno o con franja no se borra (RESTRICT / NO
 *      ACTION); sala con bloqueo sí y el bloqueo se va (CASCADE).
 *   4. La cascada multi-camino: borrar una sede y borrar el tenant (deleteTenantDeep,
 *      cuyo tenant.delete es la cascada real) con salas, franjas, bloqueos y turnos
 *      con sala NO falla (valida la elección NO ACTION / CASCADE de la cabecera).
 *   5. El SQL REAL de la migración (extraído del migration.sql) no escribe filas: se
 *      re-ejecuta en una transacción con ROLLBACK y `Booking.updatedAt` (optimistic
 *      lock, AUDIT §5.30) no se mueve.
 *   6. kinesoft_app (en `test:integration`) escribe salas, turnos, franjas y bloqueos
 *      con sala de SU tenant dentro de runWithRls, y los CHECK valen igual. En
 *      `:owner` el mismo caso corre con BYPASSRLS. La aislación de Room entre
 *      tenants está en rls-isolation.test.ts.
 *
 * Por qué así: los CHECK / FK / únicos se afirman por SQLSTATE con SQL crudo (el
 * cliente tipado de Prisma 5 no expone el SQLSTATE de un CHECK y un
 * `rejects.toThrow()` a secas daría verde ante cualquier otro error).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { runWithRls } from "@/lib/rls";
import {
  addRoom,
  createEphemeralTenant,
  deleteTenantDeep,
  ownerClient,
  sweepOrphanTestTenants,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";

const MIGRATION = join(process.cwd(), "prisma/migrations/20261009120000_rooms/migration.sql");

/**
 * Sentencias entre BEGIN; y COMMIT; del migration.sql, sin comentarios. Corta en
 * `;` FUERA de `$$` (el DO-block de RLS tiene `;` adentro).
 */
function migrationStatements(): string[] {
  const sql = readFileSync(MIGRATION, "utf8");
  const m = sql.match(/^BEGIN;\n([\s\S]*?)^COMMIT;/m);
  if (!m) throw new Error("No encontré el bloque BEGIN/COMMIT en el migration.sql de M4");
  const body = m[1]
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
  const out: string[] = [];
  let cur = "";
  let inDollar = false;
  for (let i = 0; i < body.length; i++) {
    if (body.startsWith("$$", i)) {
      inDollar = !inDollar;
      cur += "$$";
      i++;
      continue;
    }
    if (body[i] === ";" && !inDollar) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += body[i];
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * SQLSTATE de un error de Postgres que atraviesa Prisma (crudo → P2010 con
 * `meta.code`). Sin código devuelve el mensaje: el assert falla mostrándolo en vez
 * de dar verde por un error ajeno.
 */
async function sqlState(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      const code = (e.meta as { code?: string } | undefined)?.code;
      if (code) return code;
      const m = /SQLSTATE[: ]+([0-9A-Z]{5})|code: "([0-9A-Z]{5})"/.exec(e.message);
      if (m) return m[1] ?? m[2];
      return `${e.code}: ${e.message}`;
    }
    return String(e);
  }
  return "OK";
}

class Rollback extends Error {}

const byName = <T extends { name: string }>(a: T, b: T) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

describe.skipIf(!RUN)("M4 rooms · objetos, garantías en la base y migración sin escrituras", () => {
  const owner: PrismaClient = ownerClient();
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let locA1: string;
  let locA2: string;
  let locB1: string;
  let roomA1: string;
  let roomA2: string;
  let roomB1: string;
  let n = 0;
  /** Instantes distintos por turno (el índice paciente-instante no aplica a guests, pero se evita igual). */
  const nextWhen = () => new Date(Date.UTC(2027, 2, 1, 12, 0) + ++n * 3_600_000);

  function insRoom(
    tenantId: string,
    locationId: string,
    name: string,
    o: { id?: string; capacity?: number; sortOrder?: number; active?: boolean } = {}
  ) {
    return owner.$executeRaw`
      INSERT INTO "Room" ("id","tenantId","locationId","name","capacity","sortOrder","active","updatedAt")
      VALUES (${o.id ?? randomUUID()}, ${tenantId}, ${locationId}, ${name}, ${o.capacity ?? 1}::int,
              ${o.sortOrder ?? 0}::int, ${o.active ?? true}, now())`;
  }

  function insBooking(
    db: Prisma.TransactionClient | PrismaClient,
    t: EphemeralTenant,
    locationId: string | null,
    roomId: string | null,
    id: string = randomUUID()
  ) {
    return db.$executeRaw`
      INSERT INTO "Booking" ("id","tenantId","practitionerId","serviceId","scheduledFor","durationMin",
                             "idempotencyKey","guestName","locationId","roomId","updatedAt")
      VALUES (${id}, ${t.tenantId}, ${t.practitionerId}, ${t.serviceId}, ${nextWhen()}, 45,
              ${randomUUID()}, 'Invitado M4', ${locationId}::text, ${roomId}::text, now())`;
  }

  function insSchedule(
    db: Prisma.TransactionClient | PrismaClient,
    t: EphemeralTenant,
    locationId: string,
    roomId: string | null
  ) {
    return db.$executeRaw`
      INSERT INTO "PractitionerSchedule" ("id","tenantId","practitionerId","locationId","dow","startMin","endMin","roomId","updatedAt")
      VALUES (${randomUUID()}, ${t.tenantId}, ${t.practitionerId}, ${locationId}, 1, 540, 780, ${roomId}::text, now())`;
  }

  function insBlock(
    db: Prisma.TransactionClient | PrismaClient,
    t: EphemeralTenant,
    v: { locationId: string | null; roomId: string | null; practitionerId?: string | null }
  ) {
    const startsAt = nextWhen();
    return db.$executeRaw`
      INSERT INTO "TimeBlock" ("id","tenantId","practitionerId","locationId","roomId","startsAt","endsAt","reason","createdById","updatedAt")
      VALUES (${randomUUID()}, ${t.tenantId}, ${v.practitionerId ?? null}::text, ${v.locationId}::text, ${v.roomId}::text,
              ${startsAt}, ${new Date(startsAt.getTime() + 3_600_000)}, 'Mantenimiento', ${t.userId}, now())`;
  }

  beforeAll(async () => {
    await sweepOrphanTestTenants(owner);
    A = await createEphemeralTenant(owner);
    B = await createEphemeralTenant(owner);
    ({ roomId: roomA1, locationId: locA1 } = await addRoom(owner, A, { name: "Consultorio 1" }));
    locA2 = (await owner.location.create({ data: { tenantId: A.tenantId, name: "Sede Norte" } })).id;
    ({ roomId: roomA2 } = await addRoom(owner, A, { locationId: locA2, name: "Box 1", kind: "BOX" }));
    ({ roomId: roomB1, locationId: locB1 } = await addRoom(owner, B, { name: "Consultorio 1" }));
  });

  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await owner.$disconnect();
  });

  // ── 1. Objetos ──────────────────────────────────────────────────────
  describe("objetos", () => {
    it("enum RoomKind con los 4 valores, en orden", async () => {
      const r = await owner.$queryRaw<{ v: string[] }[]>`SELECT enum_range(NULL::"RoomKind")::text[] AS v`;
      expect(r[0].v).toEqual(["CONSULTORIO", "BOX", "GIMNASIO", "SALA"]);
    });

    it("columnas de Room y los roomId nuevos (TEXT nullable, sin default)", async () => {
      const cols = await owner.$queryRaw<
        { t: string; c: string; type: string; nullable: string; def: string | null }[]
      >`
        SELECT table_name AS t, column_name AS c, udt_name AS type, is_nullable AS nullable, column_default AS def
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (table_name = 'Room' OR (column_name = 'roomId' AND table_name IN ('Booking','PractitionerSchedule','TimeBlock')))
        ORDER BY table_name, ordinal_position`;
      expect(cols).toEqual([
        { t: "Booking", c: "roomId", type: "text", nullable: "YES", def: null },
        { t: "PractitionerSchedule", c: "roomId", type: "text", nullable: "YES", def: null },
        { t: "Room", c: "id", type: "text", nullable: "NO", def: null },
        { t: "Room", c: "tenantId", type: "text", nullable: "NO", def: null },
        { t: "Room", c: "locationId", type: "text", nullable: "NO", def: null },
        { t: "Room", c: "name", type: "text", nullable: "NO", def: null },
        { t: "Room", c: "kind", type: "RoomKind", nullable: "NO", def: `'CONSULTORIO'::"RoomKind"` },
        { t: "Room", c: "capacity", type: "int4", nullable: "NO", def: "1" },
        { t: "Room", c: "active", type: "bool", nullable: "NO", def: "true" },
        { t: "Room", c: "sortOrder", type: "int4", nullable: "NO", def: "0" },
        { t: "Room", c: "createdAt", type: "timestamp", nullable: "NO", def: "CURRENT_TIMESTAMP" },
        { t: "Room", c: "updatedAt", type: "timestamp", nullable: "NO", def: null },
        { t: "TimeBlock", c: "roomId", type: "text", nullable: "YES", def: null },
      ]);
    });

    it("las 11 FKs: nombre, tablas, columnas y acción ON DELETE / ON UPDATE", async () => {
      const fks = await owner.$queryRaw<
        { name: string; tbl: string; ref: string; del: string; upd: string; cols: string[]; refcols: string[] }[]
      >`
        SELECT c.conname::text AS name, c.conrelid::regclass::text AS tbl, c.confrelid::regclass::text AS ref,
               c.confdeltype::text AS del, c.confupdtype::text AS upd,
               (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(n, ord)
                  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n) AS cols,
               (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(n, ord)
                  JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n) AS refcols
        FROM pg_constraint c
        WHERE c.contype = 'f' AND (c.confrelid = '"Room"'::regclass OR c.conrelid = '"Room"'::regclass)`;
      // confdeltype: a = NO ACTION, r = RESTRICT, c = CASCADE.
      const fk = (name: string, tbl: string, ref: string, del: string, upd: string, cols: string[], refcols: string[]) => ({
        name, tbl, ref, del, upd, cols, refcols,
      });
      expect(fks.sort(byName)).toEqual(
        [
          fk("Booking_roomId_fkey", `"Booking"`, `"Room"`, "r", "c", ["roomId"], ["id"]),
          fk("Booking_room_tenant_fkey", `"Booking"`, `"Room"`, "r", "a", ["roomId", "tenantId"], ["id", "tenantId"]),
          fk("Booking_room_location_fkey", `"Booking"`, `"Room"`, "r", "a", ["roomId", "locationId"], ["id", "locationId"]),
          fk("PractitionerSchedule_roomId_fkey", `"PractitionerSchedule"`, `"Room"`, "a", "c", ["roomId"], ["id"]),
          fk("PractitionerSchedule_room_tenant_fkey", `"PractitionerSchedule"`, `"Room"`, "a", "a", ["roomId", "tenantId"], ["id", "tenantId"]),
          fk("PractitionerSchedule_room_location_fkey", `"PractitionerSchedule"`, `"Room"`, "a", "a", ["roomId", "locationId"], ["id", "locationId"]),
          fk("Room_tenantId_fkey", `"Room"`, `"Tenant"`, "c", "c", ["tenantId"], ["id"]),
          fk("Room_location_tenant_fkey", `"Room"`, `"Location"`, "c", "a", ["locationId", "tenantId"], ["id", "tenantId"]),
          fk("TimeBlock_roomId_fkey", `"TimeBlock"`, `"Room"`, "c", "c", ["roomId"], ["id"]),
          fk("TimeBlock_room_tenant_fkey", `"TimeBlock"`, `"Room"`, "c", "a", ["roomId", "tenantId"], ["id", "tenantId"]),
          fk("TimeBlock_room_location_fkey", `"TimeBlock"`, `"Room"`, "c", "a", ["roomId", "locationId"], ["id", "locationId"]),
        ].sort(byName)
      );
    });

    it("los 5 CHECKs con su definición", async () => {
      const chk = await owner.$queryRaw<{ name: string; def: string }[]>`
        SELECT conname::text AS name, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE contype = 'c' AND conname IN ('Room_name_check','Room_capacity_check','Room_sortOrder_check',
                                            'Booking_room_location_check','TimeBlock_room_scope_check')`;
      expect(chk.sort(byName)).toEqual(
        [
          { name: "Booking_room_location_check", def: `CHECK ((("roomId" IS NULL) OR ("locationId" IS NOT NULL)))` },
          { name: "Room_capacity_check", def: `CHECK (((capacity >= 1) AND (capacity <= 50)))` },
          { name: "Room_name_check", def: `CHECK (((char_length(btrim(name)) >= 1) AND (char_length(btrim(name)) <= 60)))` },
          { name: "Room_sortOrder_check", def: `CHECK (("sortOrder" >= 0))` },
          {
            name: "TimeBlock_room_scope_check",
            def: `CHECK ((("roomId" IS NULL) OR (("locationId" IS NOT NULL) AND ("practitionerId" IS NULL))))`,
          },
        ].sort(byName)
      );
    });

    it("índices: destinos de FK compuesta, de consulta y el único PARCIAL + expresión literal", async () => {
      const idx = await owner.$queryRaw<{ name: string; def: string }[]>`
        SELECT indexname::text AS name, indexdef AS def FROM pg_indexes
        WHERE schemaname = 'public' AND indexname IN (
          'Location_id_tenantId_key','Room_pkey','Room_id_tenantId_key','Room_id_locationId_key',
          'Room_tenantId_locationId_idx','Room_locationId_name_active_key','PractitionerSchedule_tenantId_roomId_idx',
          'Booking_tenantId_roomId_scheduledFor_idx','TimeBlock_tenantId_roomId_startsAt_idx')`;
      expect(idx.sort(byName)).toEqual(
        [
          { name: "Booking_tenantId_roomId_scheduledFor_idx", def: `CREATE INDEX "Booking_tenantId_roomId_scheduledFor_idx" ON public."Booking" USING btree ("tenantId", "roomId", "scheduledFor")` },
          { name: "Location_id_tenantId_key", def: `CREATE UNIQUE INDEX "Location_id_tenantId_key" ON public."Location" USING btree (id, "tenantId")` },
          { name: "PractitionerSchedule_tenantId_roomId_idx", def: `CREATE INDEX "PractitionerSchedule_tenantId_roomId_idx" ON public."PractitionerSchedule" USING btree ("tenantId", "roomId")` },
          { name: "Room_id_locationId_key", def: `CREATE UNIQUE INDEX "Room_id_locationId_key" ON public."Room" USING btree (id, "locationId")` },
          { name: "Room_id_tenantId_key", def: `CREATE UNIQUE INDEX "Room_id_tenantId_key" ON public."Room" USING btree (id, "tenantId")` },
          { name: "Room_locationId_name_active_key", def: `CREATE UNIQUE INDEX "Room_locationId_name_active_key" ON public."Room" USING btree ("locationId", lower(btrim(name))) WHERE active` },
          { name: "Room_pkey", def: `CREATE UNIQUE INDEX "Room_pkey" ON public."Room" USING btree (id)` },
          { name: "Room_tenantId_locationId_idx", def: `CREATE INDEX "Room_tenantId_locationId_idx" ON public."Room" USING btree ("tenantId", "locationId")` },
          { name: "TimeBlock_tenantId_roomId_startsAt_idx", def: `CREATE INDEX "TimeBlock_tenantId_roomId_startsAt_idx" ON public."TimeBlock" USING btree ("tenantId", "roomId", "startsAt")` },
        ].sort(byName)
      );
    });

    it("RLS: ENABLE + FORCE y una sola policy Room_tenant_isolation (ALL, USING y WITH CHECK por tenant)", async () => {
      const rel = await owner.$queryRaw<{ rls: boolean; force: boolean }[]>`
        SELECT relrowsecurity AS rls, relforcerowsecurity AS force FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relname = 'Room'`;
      expect(rel).toEqual([{ rls: true, force: true }]);
      const pol = await owner.$queryRaw<{ policyname: string; cmd: string; permissive: string; qual: string; with_check: string }[]>`
        SELECT policyname::text, cmd, permissive, qual, with_check FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'Room'`;
      expect(pol).toHaveLength(1);
      expect(pol[0].policyname).toBe("Room_tenant_isolation");
      expect(pol[0].cmd).toBe("ALL");
      expect(pol[0].permissive).toBe("PERMISSIVE");
      expect(pol[0].qual).toBe(`("tenantId" = app_current_tenant_id())`);
      expect(pol[0].with_check).toBe(`("tenantId" = app_current_tenant_id())`);
    });

    it("privilegios: kinesoft_app opera Room (DEFAULT PRIVILEGES), la migración no tiene GRANT ni anon/authenticated", async () => {
      const sql = readFileSync(MIGRATION, "utf8")
        .split("\n")
        .map((l) => l.replace(/--.*$/, ""))
        .join("\n");
      expect(sql).not.toMatch(/\bGRANT\b/i);
      expect(sql).not.toMatch(/\b(anon|authenticated)\b/i);

      const r = await owner.$queryRaw<{ s: boolean; i: boolean; u: boolean; d: boolean; svc: boolean | null }[]>`
        SELECT has_table_privilege('kinesoft_app', '"Room"', 'SELECT') AS s,
               has_table_privilege('kinesoft_app', '"Room"', 'INSERT') AS i,
               has_table_privilege('kinesoft_app', '"Room"', 'UPDATE') AS u,
               has_table_privilege('kinesoft_app', '"Room"', 'DELETE') AS d,
               CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kinesoft_service')
                    THEN has_table_privilege('kinesoft_service', '"Room"', 'SELECT') END AS svc`;
      expect(r[0]).toMatchObject({ s: true, i: true, u: true, d: true });
      // kinesoft_service solo existe en Supabase (roles.supabase.sql); si está, también hereda.
      if (r[0].svc !== null) expect(r[0].svc).toBe(true);
    });
  });

  // ── 2. Garantías en la base (owner = BYPASSRLS = prod) ───────────────
  describe("rechazos con el owner (BYPASSRLS)", () => {
    it("sala de B en una sede de A → 23503 (Room_location_tenant_fkey)", async () => {
      expect(await sqlState(insRoom(B.tenantId, locA1, `Cruzada ${randomUUID()}`))).toBe("23503");
      expect(await owner.room.count({ where: { tenantId: B.tenantId, locationId: locA1 } })).toBe(0);
    });

    it("capacity, name y sortOrder fuera de rango → 23514; los bordes pasan", async () => {
      const u = () => `Sala ${randomUUID().slice(0, 8)}`;
      expect(await sqlState(insRoom(A.tenantId, locA1, u(), { capacity: 0 }))).toBe("23514");
      expect(await sqlState(insRoom(A.tenantId, locA1, u(), { capacity: 51 }))).toBe("23514");
      expect(await sqlState(insRoom(A.tenantId, locA1, u(), { capacity: 1 }))).toBe("OK");
      expect(await sqlState(insRoom(A.tenantId, locA1, u(), { capacity: 50 }))).toBe("OK");
      expect(await sqlState(insRoom(A.tenantId, locA1, "   "))).toBe("23514");
      expect(await sqlState(insRoom(A.tenantId, locA1, ""))).toBe("23514");
      expect(await sqlState(insRoom(A.tenantId, locA1, "x".repeat(61)))).toBe("23514");
      expect(await sqlState(insRoom(A.tenantId, locA1, "y".repeat(60)))).toBe("OK");
      expect(await sqlState(insRoom(A.tenantId, locA1, u(), { sortOrder: -1 }))).toBe("23514");
    });

    it("nombre repetido entre activas de la misma sede → 23505 (sin mayúsculas ni bordes); archivada libera el nombre", async () => {
      const first = randomUUID();
      expect(await sqlState(insRoom(A.tenantId, locA1, "Gimnasio", { id: first }))).toBe("OK");
      expect(await sqlState(insRoom(A.tenantId, locA1, "  gimnasio "))).toBe("23505");
      // Otra sede del mismo tenant y otro tenant: libres.
      expect(await sqlState(insRoom(A.tenantId, locA2, "Gimnasio"))).toBe("OK");
      expect(await sqlState(insRoom(B.tenantId, locB1, "Gimnasio"))).toBe("OK");
      // Una archivada con el mismo nombre convive con la activa.
      expect(await sqlState(insRoom(A.tenantId, locA1, "GIMNASIO", { active: false }))).toBe("OK");
      // Archivar la primera libera el nombre para una nueva activa…
      await owner.room.update({ where: { id: first }, data: { active: false } });
      expect(await sqlState(insRoom(A.tenantId, locA1, "Gimnasio"))).toBe("OK");
      // …y restaurarla choca con la nueva.
      expect(await sqlState(owner.$executeRaw`UPDATE "Room" SET "active" = true WHERE "id" = ${first}`)).toBe("23505");
    });

    it("turno: sala de otra sede o de otro tenant → 23503; sala sin sede → 23514; sala de su sede pasa", async () => {
      expect(await sqlState(insBooking(owner, A, locA1, roomA2))).toBe("23503"); // Booking_room_location_fkey
      expect(await sqlState(insBooking(owner, B, locB1, roomA1))).toBe("23503"); // Booking_room_tenant_fkey
      expect(await sqlState(insBooking(owner, A, null, roomA1))).toBe("23514"); // Booking_room_location_check (SR-D6)
      const ok = randomUUID();
      expect(await sqlState(insBooking(owner, A, locA1, roomA1, ok))).toBe("OK");
      expect(await sqlState(insBooking(owner, A, null, null))).toBe("OK"); // sin sala, sede null = principal: como hoy
      // Contrato para SR2a: mudar la sede dejando la sala vieja viola la compuesta.
      expect(await sqlState(owner.$executeRaw`UPDATE "Booking" SET "locationId" = ${locA2} WHERE "id" = ${ok}`)).toBe("23503");
      expect(
        await sqlState(owner.$executeRaw`UPDATE "Booking" SET "locationId" = ${locA2}, "roomId" = ${roomA2} WHERE "id" = ${ok}`)
      ).toBe("OK");
    });

    it("franja: sala de otra sede o de otro tenant → 23503; de su sede pasa", async () => {
      expect(await sqlState(insSchedule(owner, A, locA1, roomA2))).toBe("23503");
      expect(await sqlState(insSchedule(owner, B, locB1, roomA1))).toBe("23503");
      expect(await sqlState(insSchedule(owner, A, locA1, roomA1))).toBe("OK");
      expect(await sqlState(insSchedule(owner, A, locA1, null))).toBe("OK");
    });

    it("bloqueo de sala: con profesional o sin sede → 23514; sala de otra sede / tenant → 23503; sala de su sede pasa", async () => {
      expect(await sqlState(insBlock(owner, A, { locationId: locA1, roomId: roomA1, practitionerId: A.practitionerId }))).toBe("23514");
      expect(await sqlState(insBlock(owner, A, { locationId: null, roomId: roomA1 }))).toBe("23514");
      expect(await sqlState(insBlock(owner, A, { locationId: locA1, roomId: roomA2 }))).toBe("23503");
      expect(await sqlState(insBlock(owner, B, { locationId: locB1, roomId: roomA1 }))).toBe("23503");
      expect(await sqlState(insBlock(owner, A, { locationId: locA1, roomId: roomA1 }))).toBe("OK");
      // Los bloqueos de hoy (sin sala) no cambian: con profesional y sin sede siguen pasando.
      expect(await sqlState(insBlock(owner, A, { locationId: null, roomId: null, practitionerId: A.practitionerId }))).toBe("OK");
      expect(await sqlState(insBlock(owner, A, { locationId: null, roomId: null }))).toBe("OK");
    });
  });

  // ── 3. ON DELETE de la sala ─────────────────────────────────────────
  describe("borrar una sala", () => {
    it("con turno → 23503 (RESTRICT); con franja → 23503 (NO ACTION); con bloqueo → se borra y el bloqueo se va (CASCADE)", async () => {
      const { roomId: withBooking } = await addRoom(owner, A, { locationId: locA1 });
      await insBooking(owner, A, locA1, withBooking);
      expect(await sqlState(owner.$executeRaw`DELETE FROM "Room" WHERE "id" = ${withBooking}`)).toBe("23503");

      const { roomId: withSchedule } = await addRoom(owner, A, { locationId: locA1 });
      await insSchedule(owner, A, locA1, withSchedule);
      expect(await sqlState(owner.$executeRaw`DELETE FROM "Room" WHERE "id" = ${withSchedule}`)).toBe("23503");

      const { roomId: withBlock } = await addRoom(owner, A, { locationId: locA1 });
      await insBlock(owner, A, { locationId: locA1, roomId: withBlock });
      expect(await owner.timeBlock.count({ where: { roomId: withBlock } })).toBe(1);
      expect(await sqlState(owner.$executeRaw`DELETE FROM "Room" WHERE "id" = ${withBlock}`)).toBe("OK");
      expect(await owner.timeBlock.count({ where: { roomId: withBlock } })).toBe(0);
    });
  });

  // ── 4. Cascada multi-camino ─────────────────────────────────────────
  describe("cascada multi-camino (Tenant / Location → Room → franja / bloqueo)", () => {
    it("borrar una sede sin turnos, con salas, franjas y bloqueos con sala, no falla y se lleva todo", async () => {
      const loc = (await owner.location.create({ data: { tenantId: A.tenantId, name: "Sede a borrar" } })).id;
      const { roomId: r1 } = await addRoom(owner, A, { locationId: loc, name: "S1" });
      const { roomId: r2 } = await addRoom(owner, A, { locationId: loc, name: "S2", capacity: 3, kind: "GIMNASIO" });
      await insSchedule(owner, A, loc, r1);
      await insSchedule(owner, A, loc, r2);
      await insBlock(owner, A, { locationId: loc, roomId: r1 });
      expect(await sqlState(owner.$executeRaw`DELETE FROM "Location" WHERE "id" = ${loc}`)).toBe("OK");
      expect(await owner.room.count({ where: { locationId: loc } })).toBe(0);
      expect(await owner.practitionerSchedule.count({ where: { locationId: loc } })).toBe(0);
      expect(await owner.timeBlock.count({ where: { locationId: loc } })).toBe(0);
    });

    it("borrar el tenant (deleteTenantDeep: turnos primero, después la cascada real de Tenant) con todo cargado no falla", async () => {
      const C = await createEphemeralTenant(owner);
      try {
        const { roomId: c1, locationId: cl1 } = await addRoom(owner, C, { name: "C1" });
        const cl2 = (await owner.location.create({ data: { tenantId: C.tenantId, name: "Sede 2" } })).id;
        const { roomId: c2 } = await addRoom(owner, C, { locationId: cl2, name: "C2" });
        await addRoom(owner, C, { locationId: cl2, name: "C2 archivada", active: false });
        for (const [loc, room] of [[cl1, c1], [cl2, c2]] as const) {
          expect(await sqlState(insSchedule(owner, C, loc, room))).toBe("OK");
          expect(await sqlState(insBlock(owner, C, { locationId: loc, roomId: room }))).toBe("OK");
          expect(await sqlState(insBooking(owner, C, loc, room))).toBe("OK");
        }
        expect(await owner.room.count({ where: { tenantId: C.tenantId } })).toBe(3);
      } catch (e) {
        await C.cleanup().catch(() => {});
        throw e;
      }
      await expect(deleteTenantDeep(owner, C.tenantId)).resolves.toBeUndefined();
      expect(await owner.tenant.count({ where: { id: C.tenantId } })).toBe(0);
      expect(await owner.room.count({ where: { tenantId: C.tenantId } })).toBe(0);
      expect(await owner.practitionerSchedule.count({ where: { tenantId: C.tenantId } })).toBe(0);
      expect(await owner.timeBlock.count({ where: { tenantId: C.tenantId } })).toBe(0);
      expect(await owner.location.count({ where: { tenantId: C.tenantId } })).toBe(0);
    });
  });

  // ── 5. La migración no escribe filas ────────────────────────────────
  it("el SQL de la migración no escribe filas: Booking.updatedAt intacto y sin backfill", async () => {
    const id = randomUUID();
    await insBooking(owner, A, null, null, id);
    const old = new Date("2026-01-02T03:04:05.678Z");
    await owner.$executeRaw`UPDATE "Booking" SET "updatedAt" = ${old} WHERE "id" = ${id}`;

    const stmts = migrationStatements();
    // Sin DML: ni UPDATE, ni INSERT, ni DELETE (el DO-block solo hace DDL de RLS).
    expect(stmts.filter((s) => /^(UPDATE|INSERT|DELETE)\b/i.test(s))).toEqual([]);
    expect(stmts[0]).toBe("SET LOCAL lock_timeout = '5s'");
    expect(stmts.at(-1)).toMatch(/^DO \$\$[\s\S]*ARRAY\['Room'\][\s\S]*END \$\$$/);

    let after: { updatedAt: Date; roomId: string | null } | undefined;
    let outcome: unknown;
    await owner
      .$transaction(
        async (tx) => {
          // Volver al estado previo a M4 dentro de la tx y correr el SQL real.
          await tx.$executeRawUnsafe(`DROP TABLE "Room" CASCADE`);
          await tx.$executeRawUnsafe(`ALTER TABLE "Booking" DROP COLUMN "roomId"`);
          await tx.$executeRawUnsafe(`ALTER TABLE "PractitionerSchedule" DROP COLUMN "roomId"`);
          await tx.$executeRawUnsafe(`ALTER TABLE "TimeBlock" DROP COLUMN "roomId"`);
          await tx.$executeRawUnsafe(`DROP TYPE "RoomKind"`);
          await tx.$executeRawUnsafe(`DROP INDEX "Location_id_tenantId_key"`);
          for (const s of stmts) await tx.$executeRawUnsafe(s);
          const r = await tx.$queryRaw<{ updatedAt: Date; roomId: string | null }[]>`
            SELECT "updatedAt", "roomId" FROM "Booking" WHERE "id" = ${id}`;
          after = r[0];
          throw new Rollback("rollback intencional: no tocar el schema real");
        },
        { timeout: 60_000 }
      )
      .catch((e: unknown) => {
        outcome = e;
      });
    if (!(outcome instanceof Rollback)) throw outcome ?? new Error("la transacción commiteó (no debía)");

    expect(after?.updatedAt.toISOString()).toBe(old.toISOString());
    expect(after?.roomId).toBeNull();
    // El ROLLBACK dejó el schema y las salas como estaban.
    expect(await owner.room.count({ where: { id: { in: [roomA1, roomA2, roomB1] } } })).toBe(3);
    const row = await owner.booking.findUniqueOrThrow({ where: { id } });
    expect(row.updatedAt.toISOString()).toBe(old.toISOString());
  });

  // ── 6. Conexión de la app (kinesoft_app en :integration, BYPASSRLS en :owner) ──
  it("la app escribe salas, turnos, franjas y bloqueos con sala de su tenant (runWithRls) y los CHECK valen igual", async () => {
    const roomId = randomUUID();
    const r = await runWithRls(A.tenantId, async (tx) => {
      await tx.room.create({ data: { id: roomId, tenantId: A.tenantId, locationId: locA1, name: `App ${roomId.slice(0, 6)}` } });
      return {
        booking: await sqlState(insBooking(tx, A, locA1, roomId)),
        schedule: await sqlState(insSchedule(tx, A, locA1, roomId)),
        block: await sqlState(insBlock(tx, A, { locationId: locA1, roomId })),
        seen: await tx.room.count({ where: { id: roomId } }),
      };
    });
    expect(r).toEqual({ booking: "OK", schedule: "OK", block: "OK", seen: 1 });
    // Cada rechazo en su propia tx: un error aborta la transacción.
    expect(await sqlState(runWithRls(A.tenantId, (tx) => insBooking(tx, A, null, roomId)))).toBe("23514");
    expect(
      await sqlState(runWithRls(A.tenantId, (tx) => insBlock(tx, A, { locationId: locA1, roomId, practitionerId: A.practitionerId })))
    ).toBe("23514");
    expect(
      await sqlState(
        runWithRls(A.tenantId, (tx) =>
          tx.$executeRaw`INSERT INTO "Room" ("id","tenantId","locationId","name","capacity","updatedAt")
                         VALUES (${randomUUID()}, ${A.tenantId}, ${locA1}, 'Cap cero', 0, now())`
        )
      )
    ).toBe("23514");
  });
});
