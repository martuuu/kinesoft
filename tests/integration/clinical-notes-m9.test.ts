/**
 * M9 `20261017120000_clinical_notes` · bloque EV2 del §20, ola EV2-0 (plan §20.6 y §20.12; brief EV2 §2 y §4).
 *
 * Qué se prueba (molde pl-m8.test.ts):
 *   1. Objetos (catálogo de Postgres, por el owner): enum, columnas con tipo/nulabilidad/default, los 2 únicos nuevos
 *      sobre Booking y Practitioner, el PARCIAL con su predicado, las FKs (5 compuestas EXACTAS, todas RESTRICT),
 *      CHECKs, los 5 triggers, RLS ENABLE + FORCE y la policy exacta en las 2 tablas, privilegios y el TimeZone de la
 *      sesión (riesgo 5 del brief: el default CURRENT_TIMESTAMP depende de él).
 *   2. Comportamiento: la HC no se borra (DELETE/TRUNCATE → P0001 también para el owner), identidad inmutable,
 *      edición de contenido → revisión con la versión anterior y `revision` + 1, anulada = congelada, la red de 24 h,
 *      la revisión solo nace del trigger y es solo inserción, FKs compuestas (23503), una raíz viva por turno (23505),
 *      el turno con evolución no se borra ni cambia de paciente (23503), aislamiento con el rol de la APP
 *      (`SET LOCAL ROLE kinesoft_app` dentro de una tx del owner: corre igual en `test:integration` y en `:owner`)
 *      y CHECKs (23514).
 *   3. `deleteTenantDeep` borra un consultorio con notas, enmiendas, anuladas y revisiones (modo réplica).
 *
 * Casi todo corre dentro de txs con ROLLBACK (`inTx`): ClinicalNote no se puede borrar después. Dentro de una tx,
 * `now()` es el inicio de la tx: las edades de `createdAt` se arman relativas a ese mismo `now()`.
 */
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addPatient,
  createEphemeralTenant,
  ownerClient,
  sweepOrphanTestTenants,
  uniqueSuffix,
  type EphemeralTenant,
} from "@/tests/helpers/tenant-factory";

const RUN = process.env.INTEGRATION === "1";
const TABLES = ["ClinicalNote", "ClinicalNoteRevision"] as const;

/** SQLSTATE (o mensaje) de un error de Postgres que atraviesa Prisma (molde pl-m8.test.ts). */
async function sqlError(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      const code = (e.meta as { code?: string } | undefined)?.code;
      const m = /SQLSTATE[: ]+([0-9A-Z]{5})|code: "([0-9A-Z]{5})"/.exec(e.message);
      return { code: code ?? m?.[1] ?? m?.[2] ?? e.code, message: e.message };
    }
    return { code: "?", message: String(e) };
  }
  return { code: "OK", message: "" };
}

class Done<T> extends Error {
  constructor(public value: T) {
    super("rollback intencional");
  }
}

/** Tx del owner que SIEMPRE termina en ROLLBACK; devuelve lo que `fn` devolvió y re-tira cualquier error de `fn`. */
async function inTx<T>(db: PrismaClient, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  let out: unknown;
  await db
    .$transaction(async (tx) => {
      throw new Done(await fn(tx));
    }, { timeout: 60_000 })
    .catch((e: unknown) => {
      out = e;
    });
  if (out instanceof Done) return out.value as T;
  throw out ?? new Error("la transacción commiteó (no debía)");
}

/** Baja la tx a `kinesoft_app` y fija el GUC como `runWithRls` (desde ahí, todo corre como la app). */
async function asApp(tx: Prisma.TransactionClient, tenantId: string | null) {
  await tx.$executeRawUnsafe(`SET LOCAL ROLE kinesoft_app`);
  if (tenantId) await tx.$queryRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
}

type Col = { column_name: string; udt_name: string; is_nullable: string; column_default: string | null };
async function columns(db: PrismaClient, table: string): Promise<Record<string, string>> {
  const rows = await db.$queryRaw<Col[]>`
    SELECT column_name, udt_name, is_nullable, column_default FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}`;
  return Object.fromEntries(
    rows.map((r) => [r.column_name, `${r.udt_name} ${r.is_nullable}${r.column_default ? ` ${r.column_default}` : ""}`])
  );
}

describe.skipIf(!RUN)("M9 clinical_notes · objetos", () => {
  let db: PrismaClient;
  beforeAll(() => {
    db = ownerClient();
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it("enum ClinicalNoteKind con sus valores en orden (EV2-D8)", async () => {
    const rows = await db.$queryRaw<{ labels: string[] }[]>`
      SELECT array_agg(enumlabel::text ORDER BY enumsortorder) AS labels FROM pg_enum
      WHERE enumtypid = '"ClinicalNoteKind"'::regtype`;
    expect(rows[0].labels).toEqual(["EVOLUTION", "FIRST_VISIT", "DISCHARGE"]);
  });

  it("columnas de ClinicalNote y ClinicalNoteRevision: tipo, nulabilidad y default", async () => {
    expect(await columns(db, "ClinicalNote")).toEqual({
      id: "text NO",
      tenantId: "text NO",
      patientId: "text NO",
      bookingId: "text YES",
      amendsNoteId: "text YES",
      kind: `ClinicalNoteKind NO 'EVOLUTION'::"ClinicalNoteKind"`,
      title: "text YES",
      body: "text NO",
      occurredAt: "timestamp NO",
      authorUserId: "text NO",
      authorPractitionerId: "text NO",
      authorName: "text NO",
      revision: "int4 NO 1",
      voidedAt: "timestamp YES",
      voidedByUserId: "text YES",
      voidReason: "text YES",
      idempotencyKey: "text NO",
      createdAt: "timestamp NO CURRENT_TIMESTAMP",
      updatedAt: "timestamp NO",
    });
    expect(await columns(db, "ClinicalNoteRevision")).toEqual({
      id: "text NO",
      tenantId: "text NO",
      noteId: "text NO",
      revision: "int4 NO",
      kind: "ClinicalNoteKind NO",
      title: "text YES",
      body: "text NO",
      occurredAt: "timestamp NO",
      savedAt: "timestamp NO",
      createdAt: "timestamp NO CURRENT_TIMESTAMP",
    });
  });

  it("índices: los 2 únicos nuevos sobre Booking/Practitioner, los de ClinicalNote y el PARCIAL con su predicado", async () => {
    const rows = await db.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
        AND (tablename = ANY(${[...TABLES]}) OR indexname IN ('Booking_id_tenantId_patientId_key', 'Practitioner_id_tenantId_key'))`;
    const idx = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef.replace(/ ON public\./, " ON ")]));
    expect(idx).toEqual({
      Booking_id_tenantId_patientId_key: `CREATE UNIQUE INDEX "Booking_id_tenantId_patientId_key" ON "Booking" USING btree (id, "tenantId", "patientId")`,
      Practitioner_id_tenantId_key: `CREATE UNIQUE INDEX "Practitioner_id_tenantId_key" ON "Practitioner" USING btree (id, "tenantId")`,
      ClinicalNote_pkey: `CREATE UNIQUE INDEX "ClinicalNote_pkey" ON "ClinicalNote" USING btree (id)`,
      ClinicalNote_id_tenantId_key: `CREATE UNIQUE INDEX "ClinicalNote_id_tenantId_key" ON "ClinicalNote" USING btree (id, "tenantId")`,
      ClinicalNote_id_tenantId_patientId_key: `CREATE UNIQUE INDEX "ClinicalNote_id_tenantId_patientId_key" ON "ClinicalNote" USING btree (id, "tenantId", "patientId")`,
      ClinicalNote_tenantId_idempotencyKey_key: `CREATE UNIQUE INDEX "ClinicalNote_tenantId_idempotencyKey_key" ON "ClinicalNote" USING btree ("tenantId", "idempotencyKey")`,
      ClinicalNote_tenantId_patientId_occurredAt_id_idx: `CREATE INDEX "ClinicalNote_tenantId_patientId_occurredAt_id_idx" ON "ClinicalNote" USING btree ("tenantId", "patientId", "occurredAt" DESC, id DESC)`,
      ClinicalNote_bookingId_idx: `CREATE INDEX "ClinicalNote_bookingId_idx" ON "ClinicalNote" USING btree ("bookingId")`,
      ClinicalNote_amendsNoteId_idx: `CREATE INDEX "ClinicalNote_amendsNoteId_idx" ON "ClinicalNote" USING btree ("amendsNoteId")`,
      ClinicalNote_authorPractitionerId_idx: `CREATE INDEX "ClinicalNote_authorPractitionerId_idx" ON "ClinicalNote" USING btree ("authorPractitionerId")`,
      ClinicalNote_bookingId_live_key: `CREATE UNIQUE INDEX "ClinicalNote_bookingId_live_key" ON "ClinicalNote" USING btree ("bookingId") WHERE (("bookingId" IS NOT NULL) AND ("amendsNoteId" IS NULL) AND ("voidedAt" IS NULL))`,
      ClinicalNoteRevision_pkey: `CREATE UNIQUE INDEX "ClinicalNoteRevision_pkey" ON "ClinicalNoteRevision" USING btree (id)`,
      ClinicalNoteRevision_noteId_revision_key: `CREATE UNIQUE INDEX "ClinicalNoteRevision_noteId_revision_key" ON "ClinicalNoteRevision" USING btree ("noteId", revision)`,
    });
  });

  it("FKs: las 9 de ClinicalNote y las 3 de la revisión, todas RESTRICT; las 5 compuestas exactas", async () => {
    const rows = await db.$queryRaw<{ rel: string; conname: string; def: string }[]>`
      SELECT conrelid::regclass::text AS rel, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE contype = 'f' AND conrelid IN ('"ClinicalNote"'::regclass, '"ClinicalNoteRevision"'::regclass)`;
    const fk = Object.fromEntries(rows.map((r) => [r.conname, r.def]));
    expect(Object.keys(fk).sort()).toEqual(
      [
        "ClinicalNote_tenantId_fkey",
        "ClinicalNote_patientId_fkey",
        "ClinicalNote_patient_tenant_fkey",
        "ClinicalNote_bookingId_fkey",
        "ClinicalNote_booking_tenant_patient_fkey",
        "ClinicalNote_authorPractitionerId_fkey",
        "ClinicalNote_author_tenant_fkey",
        "ClinicalNote_amendsNoteId_fkey",
        "ClinicalNote_amends_tenant_patient_fkey",
        "ClinicalNoteRevision_tenantId_fkey",
        "ClinicalNoteRevision_noteId_fkey",
        "ClinicalNoteRevision_note_tenant_fkey",
      ].sort()
    );
    expect(rows.filter((r) => r.rel === '"ClinicalNote"')).toHaveLength(9);
    // Nada clínico se borra ni se re-apunta en cascada: RESTRICT y sin ON UPDATE CASCADE.
    for (const [name, def] of Object.entries(fk)) {
      expect(def, name).toMatch(/ON DELETE RESTRICT$/);
      expect(def, name).not.toMatch(/CASCADE|SET NULL/);
    }
    expect(fk.ClinicalNote_patient_tenant_fkey).toBe(
      `FOREIGN KEY ("patientId", "tenantId") REFERENCES "Patient"(id, "tenantId") ON DELETE RESTRICT`
    );
    expect(fk.ClinicalNote_booking_tenant_patient_fkey).toBe(
      `FOREIGN KEY ("bookingId", "tenantId", "patientId") REFERENCES "Booking"(id, "tenantId", "patientId") ON DELETE RESTRICT`
    );
    expect(fk.ClinicalNote_author_tenant_fkey).toBe(
      `FOREIGN KEY ("authorPractitionerId", "tenantId") REFERENCES "Practitioner"(id, "tenantId") ON DELETE RESTRICT`
    );
    expect(fk.ClinicalNote_amends_tenant_patient_fkey).toBe(
      `FOREIGN KEY ("amendsNoteId", "tenantId", "patientId") REFERENCES "ClinicalNote"(id, "tenantId", "patientId") ON DELETE RESTRICT`
    );
    expect(fk.ClinicalNoteRevision_note_tenant_fkey).toBe(
      `FOREIGN KEY ("noteId", "tenantId") REFERENCES "ClinicalNote"(id, "tenantId") ON DELETE RESTRICT`
    );
  });

  it("CHECKs presentes con su nombre (drift aceptado)", async () => {
    const rows = await db.$queryRaw<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE contype = 'c' AND conrelid IN ('"ClinicalNote"'::regclass, '"ClinicalNoteRevision"'::regclass)`;
    expect(rows.map((r) => r.conname).sort()).toEqual(
      [
        "ClinicalNote_body_check",
        "ClinicalNote_title_check",
        "ClinicalNote_authorName_check",
        "ClinicalNote_revision_check",
        "ClinicalNote_void_check",
        "ClinicalNote_amends_self_check",
        "ClinicalNote_idempotencyKey_check",
        "ClinicalNoteRevision_revision_check",
      ].sort()
    );
  });

  it("los 5 triggers habilitados (O) con su definición; funciones con search_path fijo", async () => {
    const trg = await db.$queryRaw<{ tgname: string; enabled: string; def: string }[]>`
      SELECT tgname, tgenabled::text AS enabled, pg_get_triggerdef(oid) AS def FROM pg_trigger
      WHERE NOT tgisinternal AND tgrelid IN ('"ClinicalNote"'::regclass, '"ClinicalNoteRevision"'::regclass)
      ORDER BY tgname`;
    expect(trg.map((t) => [t.tgname, t.enabled])).toEqual([
      ["ClinicalNoteRevision_append_only", "O"],
      ["ClinicalNoteRevision_insert_guard", "O"],
      ["ClinicalNoteRevision_no_truncate", "O"],
      ["ClinicalNote_guard", "O"],
      ["ClinicalNote_no_truncate", "O"],
    ]);
    const def = Object.fromEntries(trg.map((t) => [t.tgname, t.def]));
    expect(def.ClinicalNote_guard).toMatch(/BEFORE DELETE OR UPDATE .* FOR EACH ROW EXECUTE FUNCTION clinical_note_guard\(\)/);
    expect(def.ClinicalNote_no_truncate).toMatch(/BEFORE TRUNCATE .* FOR EACH STATEMENT EXECUTE FUNCTION clinical_note_guard\(\)/);
    expect(def.ClinicalNoteRevision_insert_guard).toMatch(
      /BEFORE INSERT .* FOR EACH ROW EXECUTE FUNCTION clinical_note_revision_insert_guard\(\)/
    );
    expect(def.ClinicalNoteRevision_append_only).toMatch(/BEFORE DELETE OR UPDATE .* FOR EACH ROW EXECUTE FUNCTION kinesoft_append_only\(\)/);
    expect(def.ClinicalNoteRevision_no_truncate).toMatch(/BEFORE TRUNCATE .* FOR EACH STATEMENT EXECUTE FUNCTION kinesoft_append_only\(\)/);

    const fns = await db.$queryRaw<{ proname: string; cfg: string[] | null; secdef: boolean }[]>`
      SELECT proname, proconfig AS cfg, prosecdef AS secdef FROM pg_proc
      WHERE proname IN ('clinical_note_guard', 'clinical_note_revision_insert_guard') ORDER BY proname`;
    // Sin SECURITY DEFINER: el INSERT de la revisión corre con el rol y el GUC de quien edita (pasa por RLS).
    expect(fns).toEqual([
      { proname: "clinical_note_guard", cfg: ["search_path=pg_catalog, public"], secdef: false },
      { proname: "clinical_note_revision_insert_guard", cfg: ["search_path=pg_catalog, public"], secdef: false },
    ]);
  });

  it("RLS: ENABLE + FORCE en las 2; policy <T>_tenant_isolation exacta (ALL, USING = WITH CHECK)", async () => {
    const rel = await db.$queryRaw<{ relname: string; rls: boolean; force: boolean }[]>`
      SELECT relname, relrowsecurity AS rls, relforcerowsecurity AS force FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relname = ANY(${[...TABLES]}) ORDER BY relname`;
    expect(rel).toEqual([
      { relname: "ClinicalNote", rls: true, force: true },
      { relname: "ClinicalNoteRevision", rls: true, force: true },
    ]);
    const pol = await db.$queryRaw<{ tablename: string; policyname: string; cmd: string; qual: string; with_check: string }[]>`
      SELECT tablename, policyname, cmd, qual, with_check FROM pg_policies
      WHERE schemaname = 'public' AND tablename = ANY(${[...TABLES]}) ORDER BY tablename`;
    expect(pol).toEqual(
      TABLES.map((t) => ({
        tablename: t,
        policyname: `${t}_tenant_isolation`,
        cmd: "ALL",
        qual: `("tenantId" = app_current_tenant_id())`,
        with_check: `("tenantId" = app_current_tenant_id())`,
      }))
    );
  });

  it("privilegios: kinesoft_app por DEFAULT PRIVILEGES; anon/authenticated nada (guard 3c)", async () => {
    for (const t of TABLES) {
      const [p] = await db.$queryRaw<{ sel: boolean; ins: boolean; upd: boolean }[]>`
        SELECT has_table_privilege('kinesoft_app', format('public.%I', ${t}::text), 'SELECT') AS sel,
               has_table_privilege('kinesoft_app', format('public.%I', ${t}::text), 'INSERT') AS ins,
               has_table_privilege('kinesoft_app', format('public.%I', ${t}::text), 'UPDATE') AS upd`;
      expect(p, t).toEqual({ sel: true, ins: true, upd: true });
    }
    const rows = await db.$queryRaw<{ grantee: string }[]>`
      SELECT grantee FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = ANY(${[...TABLES]}) AND grantee IN ('anon', 'authenticated')`;
    expect(rows).toEqual([]);
  });

  it("la sesión corre en UTC (el default CURRENT_TIMESTAMP de createdAt depende de eso; riesgo 5 del brief)", async () => {
    const [r] = await db.$queryRaw<{ tz: string; skew: boolean }[]>`
      SELECT current_setting('TimeZone') AS tz,
             abs(extract(epoch FROM (CURRENT_TIMESTAMP::timestamp - (now() AT TIME ZONE 'UTC')))) < 1 AS skew`;
    expect(["UTC", "Etc/UTC"]).toContain(r.tz);
    expect(r.skew).toBe(true);
  });
});

describe.skipIf(!RUN)("M9 clinical_notes · comportamiento", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let pA1: string;
  let pA2: string;
  let pB: string;
  /** Turnos de A: dos de pA1, uno de pA2 y un guest (sin paciente). Uno de B (pB). */
  let bA1: string;
  let bA1b: string;
  let bA2: string;
  let bGuest: string;
  let bB: string;

  type NoteOpts = {
    tenantId?: string;
    patientId?: string;
    bookingId?: string | null;
    amendsNoteId?: string | null;
    authorPractitionerId?: string;
    authorName?: string;
    title?: string | null;
    body?: string;
    key?: string;
    /** Edad de createdAt/updatedAt relativa al now() de la tx (interval de Postgres). */
    age?: string;
    id?: string;
  };
  /** Inserta una nota (por defecto: consultorio A, paciente pA1, turno bA1, autor el titular de A). */
  const note = async (tx: Prisma.TransactionClient, o: NoteOpts = {}): Promise<string> => {
    const id = o.id ?? `m9-n-${uniqueSuffix()}`;
    await tx.$executeRawUnsafe(
      `INSERT INTO "ClinicalNote" (id, "tenantId", "patientId", "bookingId", "amendsNoteId", title, body, "occurredAt",
                                   "authorUserId", "authorPractitionerId", "authorName", "idempotencyKey",
                                   "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, now() AT TIME ZONE 'UTC', $8, $9, $10, $11,
               (now() AT TIME ZONE 'UTC') - $12::interval, (now() AT TIME ZONE 'UTC') - $12::interval)`,
      id,
      o.tenantId ?? A.tenantId,
      o.patientId ?? pA1,
      o.bookingId === undefined ? bA1 : o.bookingId,
      o.amendsNoteId ?? null,
      o.title ?? null,
      o.body ?? "Dolor lumbar 6/10, mejora con movilidad.",
      A.userId,
      o.authorPractitionerId ?? A.practitionerId,
      o.authorName ?? "Kine Titular",
      o.key ?? randomUUID(),
      o.age ?? "0 seconds"
    );
    return id;
  };
  const voidNote = (tx: Prisma.TransactionClient, id: string, reason = "Cargada en el paciente equivocado") =>
    tx.$executeRaw`
      UPDATE "ClinicalNote" SET "voidedAt" = now() AT TIME ZONE 'UTC', "voidedByUserId" = ${A.userId},
        "voidReason" = ${reason}, "updatedAt" = now() AT TIME ZONE 'UTC' WHERE id = ${id}`;
  const editBody = (tx: Prisma.TransactionClient, id: string, body: string) =>
    tx.$executeRaw`UPDATE "ClinicalNote" SET body = ${body}, "updatedAt" = now() AT TIME ZONE 'UTC' WHERE id = ${id}`;
  const revisions = (tx: Prisma.TransactionClient, noteId: string) =>
    tx.$queryRaw<{ revision: number; body: string; tenantId: string }[]>`
      SELECT revision, body, "tenantId" FROM "ClinicalNoteRevision" WHERE "noteId" = ${noteId} ORDER BY revision`;
  const noteRow = async (tx: Prisma.TransactionClient, id: string) =>
    (
      await tx.$queryRaw<{ revision: number; body: string; voided: boolean }[]>`
        SELECT revision, body, "voidedAt" IS NOT NULL AS voided FROM "ClinicalNote" WHERE id = ${id}`
    )[0];

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
    pA1 = await addPatient(db, A);
    pA2 = await addPatient(db, A);
    pB = await addPatient(db, B);
    const booking = async (t: EphemeralTenant, patientId: string | null, iso: string) =>
      (
        await db.booking.create({
          data: {
            tenantId: t.tenantId,
            patientId,
            guestName: patientId ? null : "Invitado",
            practitionerId: t.practitionerId,
            serviceId: t.serviceId,
            scheduledFor: new Date(iso),
            durationMin: 45,
            status: "CONFIRMED",
            idempotencyKey: randomUUID(),
          },
        })
      ).id;
    bA1 = await booking(A, pA1, "2026-10-01T13:00:00.000Z");
    bA1b = await booking(A, pA1, "2026-10-02T13:00:00.000Z");
    bA2 = await booking(A, pA2, "2026-10-03T13:00:00.000Z");
    bGuest = await booking(A, null, "2026-10-04T13:00:00.000Z");
    bB = await booking(B, pB, "2026-10-05T13:00:00.000Z");
  });
  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await db.$disconnect();
  });

  // ── Nunca se borra ──────────────────────────────────────────────────
  it("DELETE de ClinicalNote → P0001 para el owner y para la app; TRUNCATE → P0001 para el owner", async () => {
    const owner = await sqlError(
      inTx(db, async (tx) => tx.$executeRawUnsafe(`DELETE FROM "ClinicalNote" WHERE id = $1`, await note(tx)))
    );
    expect(owner.code).toBe("P0001");
    expect(owner.message).toMatch(/ClinicalNote no se borra nunca \(se anula con motivo\): DELETE rechazado/);
    const app = await sqlError(
      inTx(db, async (tx) => {
        const id = await note(tx);
        await asApp(tx, A.tenantId);
        await tx.$executeRawUnsafe(`DELETE FROM "ClinicalNote" WHERE id = $1`, id);
      })
    );
    expect(app.code).toBe("P0001");
    const t = await sqlError(
      inTx(db, async (tx) => {
        await note(tx);
        await tx.$executeRawUnsafe(`TRUNCATE "ClinicalNote" CASCADE`);
      })
    );
    expect(t.code).toBe("P0001");
    expect(t.message).toMatch(/TRUNCATE rechazado/);
  });

  // ── Identidad inmutable ─────────────────────────────────────────────
  it("UPDATE de cualquier columna de identidad → P0001 (owner)", async () => {
    const sets: [string, (id: string) => string][] = [
      ["id", () => `id = 'otro-id'`],
      ["tenantId", () => `"tenantId" = '${B.tenantId}'`],
      ["patientId", () => `"patientId" = '${pA2}'`],
      ["bookingId", () => `"bookingId" = '${bA1b}'`],
      ["amendsNoteId", () => `"amendsNoteId" = NULL`],
      ["authorUserId", () => `"authorUserId" = 'otro'`],
      ["authorPractitionerId", () => `"authorPractitionerId" = '${A.practitionerId}x'`],
      ["authorName", () => `"authorName" = 'Otro Nombre'`],
      ["idempotencyKey", () => `"idempotencyKey" = '${randomUUID()}'`],
      ["createdAt", () => `"createdAt" = "createdAt" - interval '1 second'`],
    ];
    for (const [col, set] of sets) {
      const r = await sqlError(
        inTx(db, async (tx) => {
          // amendsNoteId: se prueba des-enlazar una enmienda (NULL ← raíz).
          const root = await note(tx);
          const id = col === "amendsNoteId" ? await note(tx, { amendsNoteId: root }) : root;
          await tx.$executeRawUnsafe(`UPDATE "ClinicalNote" SET ${set(id)} WHERE id = $1`, id);
        })
      );
      expect(r.code, col).toBe("P0001");
      expect(r.message, col).toMatch(/columnas de identidad inmutables/);
    }
  });

  // ── Edición de contenido → revisión ─────────────────────────────────
  it("editar el contenido (owner) → revisión 1 con la versión anterior y revision = 2; otra edición → revisión 2", async () => {
    const out = await inTx(db, async (tx) => {
      const id = await note(tx, { body: "v1", age: "1 hour" });
      const [before] = await tx.$queryRaw<{ updatedAt: Date }[]>`SELECT "updatedAt" FROM "ClinicalNote" WHERE id = ${id}`;
      await editBody(tx, id, "v2");
      const afterFirst = await noteRow(tx, id);
      const [saved] = await tx.$queryRaw<{ savedAt: Date; kind: string }[]>`
        SELECT "savedAt", kind::text FROM "ClinicalNoteRevision" WHERE "noteId" = ${id} AND revision = 1`;
      await tx.$executeRaw`UPDATE "ClinicalNote" SET title = 'Control', kind = 'DISCHARGE' WHERE id = ${id}`;
      return { afterFirst, savedAt: +saved.savedAt === +before.updatedAt, kind: saved.kind, final: await noteRow(tx, id), revs: await revisions(tx, id) };
    });
    expect(out.afterFirst).toEqual({ revision: 2, body: "v2", voided: false });
    expect(out.savedAt).toBe(true);
    expect(out.kind).toBe("EVOLUTION");
    expect(out.final.revision).toBe(3);
    expect(out.revs.map((r) => [r.revision, r.body])).toEqual([
      [1, "v1"],
      [2, "v2"],
    ]);
  });

  it("editar el contenido como la APP (RLS): la revisión que inserta el trigger pasa el WITH CHECK y la app la ve", async () => {
    const out = await inTx(db, async (tx) => {
      const id = await note(tx, { body: "v1" });
      await asApp(tx, A.tenantId);
      const n = await editBody(tx, id, "v2");
      return { n, row: await noteRow(tx, id), revs: await revisions(tx, id) };
    });
    expect(out.n).toBe(1);
    expect(out.row.revision).toBe(2);
    expect(out.revs).toEqual([{ revision: 1, body: "v1", tenantId: A.tenantId }]);
  });

  it("la app no escribe `revision`: sola → P0001; con cambio de contenido el trigger la pisa (OLD + 1)", async () => {
    const alone = await sqlError(
      inTx(db, async (tx) => tx.$executeRaw`UPDATE "ClinicalNote" SET revision = 5 WHERE id = ${await note(tx)}`)
    );
    expect(alone.code).toBe("P0001");
    expect(alone.message).toMatch(/la revisión la sube solo el trigger/);
    const withContent = await inTx(db, async (tx) => {
      const id = await note(tx);
      await tx.$executeRaw`UPDATE "ClinicalNote" SET revision = 9, body = 'otra' WHERE id = ${id}`;
      return noteRow(tx, id);
    });
    expect(withContent.revision).toBe(2);
    // Sin cambio de contenido (solo updatedAt): pasa y no crea revisión.
    const touch = await inTx(db, async (tx) => {
      const id = await note(tx);
      await tx.$executeRaw`UPDATE "ClinicalNote" SET "updatedAt" = now() AT TIME ZONE 'UTC' WHERE id = ${id}`;
      return { row: await noteRow(tx, id), revs: await revisions(tx, id) };
    });
    expect(touch.row.revision).toBe(1);
    expect(touch.revs).toEqual([]);
  });

  it("red de 24 h (EV2-D17): createdAt de hace 25 h + editar → P0001; de hace 24 h → pasa; anular a las 25 h → pasa", async () => {
    const late = await sqlError(inTx(db, async (tx) => editBody(tx, await note(tx, { age: "25 hours" }), "tarde")));
    expect(late.code).toBe("P0001");
    expect(late.message).toMatch(/pasaron más de 24 h, se enmienda o se anula/);
    const inGrace = await inTx(db, async (tx) => {
      const id = await note(tx, { age: "24 hours" });
      await editBody(tx, id, "a tiempo (gracia de 10 min)");
      return noteRow(tx, id);
    });
    expect(inGrace.revision).toBe(2);
    const voided = await inTx(db, async (tx) => {
      const id = await note(tx, { age: "25 hours" });
      await voidNote(tx, id);
      return noteRow(tx, id);
    });
    expect(voided).toMatchObject({ voided: true, revision: 1 });
  });

  // ── Anulación ───────────────────────────────────────────────────────
  it("anular → sin revisión nueva; después, cualquier UPDATE (des-anular, editar, re-anular) → P0001", async () => {
    const ok = await inTx(db, async (tx) => {
      const id = await note(tx);
      const n = await voidNote(tx, id);
      return { n, row: await noteRow(tx, id), revs: await revisions(tx, id) };
    });
    expect(ok).toEqual({ n: 1, row: { revision: 1, body: "Dolor lumbar 6/10, mejora con movilidad.", voided: true }, revs: [] });
    for (const [name, sql] of [
      ["des-anular", `UPDATE "ClinicalNote" SET "voidedAt" = NULL, "voidedByUserId" = NULL, "voidReason" = NULL WHERE id = $1`],
      ["editar", `UPDATE "ClinicalNote" SET body = 'otra' WHERE id = $1`],
      ["re-anular", `UPDATE "ClinicalNote" SET "voidReason" = 'Otro motivo' WHERE id = $1`],
      ["solo updatedAt", `UPDATE "ClinicalNote" SET "updatedAt" = now() WHERE id = $1`],
    ] as const) {
      const r = await sqlError(
        inTx(db, async (tx) => {
          const id = await note(tx);
          await voidNote(tx, id);
          await tx.$executeRawUnsafe(sql, id);
        })
      );
      expect(r.code, name).toBe("P0001");
      expect(r.message, name).toMatch(/anulada = congelada/);
    }
  });

  it("anular y cambiar el body (o la revisión) en la misma sentencia → P0001", async () => {
    for (const extra of [`body = 'cambiado'`, `revision = 2`, `kind = 'DISCHARGE'`]) {
      const r = await sqlError(
        inTx(db, async (tx) =>
          tx.$executeRawUnsafe(
            `UPDATE "ClinicalNote" SET "voidedAt" = now(), "voidedByUserId" = 'u', "voidReason" = 'Motivo válido', ${extra}
             WHERE id = $1`,
            await note(tx)
          )
        )
      );
      expect(r.code, extra).toBe("P0001");
      expect(r.message, extra).toMatch(/anular no edita el contenido/);
    }
  });

  // ── ClinicalNoteRevision: solo la escribe el trigger, solo inserción ─
  it("INSERT directo en ClinicalNoteRevision → P0001 (owner y app)", async () => {
    const insert = (tx: Prisma.TransactionClient, noteId: string) =>
      tx.$executeRaw`
        INSERT INTO "ClinicalNoteRevision" (id, "tenantId", "noteId", revision, kind, body, "occurredAt", "savedAt")
        VALUES (${`m9-r-${uniqueSuffix()}`}, ${A.tenantId}, ${noteId}, 7, 'EVOLUTION', 'forjada', now(), now())`;
    const owner = await sqlError(inTx(db, async (tx) => insert(tx, await note(tx))));
    expect(owner.code).toBe("P0001");
    expect(owner.message).toMatch(/INSERT directo rechazado/);
    const app = await sqlError(
      inTx(db, async (tx) => {
        const id = await note(tx);
        await asApp(tx, A.tenantId);
        await insert(tx, id);
      })
    );
    expect(app.code).toBe("P0001");
  });

  it("UPDATE, DELETE y TRUNCATE de una revisión → P0001 (también el owner)", async () => {
    for (const [op, sql] of [
      ["UPDATE", `UPDATE "ClinicalNoteRevision" SET body = 'reescrita' WHERE "noteId" = $1`],
      ["DELETE", `DELETE FROM "ClinicalNoteRevision" WHERE "noteId" = $1`],
    ] as const) {
      const r = await sqlError(
        inTx(db, async (tx) => {
          const id = await note(tx);
          await editBody(tx, id, "v2");
          await tx.$executeRawUnsafe(sql, id);
        })
      );
      expect(r.code, op).toBe("P0001");
      expect(r.message, op).toMatch(new RegExp(`ClinicalNoteRevision es solo inserción: ${op} rechazado`));
    }
    const t = await sqlError(inTx(db, (tx) => tx.$executeRawUnsafe(`TRUNCATE "ClinicalNoteRevision"`)));
    expect(t.code).toBe("P0001");
    expect(t.message).toMatch(/ClinicalNoteRevision es solo inserción: TRUNCATE rechazado/);
  });

  // ── FKs compuestas ──────────────────────────────────────────────────
  it("turno de otro paciente / de otro consultorio / guest, paciente o profesional de otro consultorio, enmienda de otro paciente → 23503", async () => {
    const cases: [string, (tx: Prisma.TransactionClient) => Promise<unknown>][] = [
      ["turno de otro paciente", (tx) => note(tx, { patientId: pA2, bookingId: bA1 })],
      ["turno de otro consultorio", (tx) => note(tx, { bookingId: bB })],
      ["turno guest (sin paciente)", (tx) => note(tx, { bookingId: bGuest })],
      ["paciente de otro consultorio", (tx) => note(tx, { patientId: pB, bookingId: null })],
      ["profesional de otro consultorio", (tx) => note(tx, { authorPractitionerId: B.practitionerId })],
      ["enmienda de otro paciente", async (tx) => note(tx, { patientId: pA2, bookingId: bA2, amendsNoteId: await note(tx) })],
      [
        "enmienda de otro consultorio",
        async (tx) => note(tx, { tenantId: B.tenantId, patientId: pB, bookingId: null, authorPractitionerId: B.practitionerId, amendsNoteId: await note(tx) }),
      ],
      [
        "nota de otro consultorio sobre un paciente de este",
        (tx) => note(tx, { tenantId: B.tenantId, patientId: pA1, bookingId: null, authorPractitionerId: B.practitionerId }),
      ],
    ];
    for (const [name, fn] of cases) {
      const r = await sqlError(inTx(db, fn));
      expect(r.code, name).toBe("23503");
    }
    // Lo válido entra: sin turno, enmienda del mismo paciente (aunque la raíz siga viva en el turno).
    const ok = await inTx(db, async (tx) => {
      const root = await note(tx);
      await note(tx, { bookingId: null });
      await note(tx, { amendsNoteId: root });
      return Number((await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "ClinicalNote" WHERE "patientId" = ${pA1}`)[0].n);
    });
    expect(ok).toBeGreaterThanOrEqual(3);
  });

  // ── Una raíz viva por turno ─────────────────────────────────────────
  it("dos raíces vivas en el mismo turno → 23505; anulada + nueva → OK; enmiendas no cuentan", async () => {
    const dup = await sqlError(
      inTx(db, async (tx) => {
        await note(tx);
        await note(tx);
      })
    );
    expect(dup.code).toBe("23505");
    const ok = await inTx(db, async (tx) => {
      const first = await note(tx);
      await note(tx, { amendsNoteId: first });
      await voidNote(tx, first);
      await note(tx);
      await note(tx, { bookingId: bA1b });
      return Number(
        (await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "ClinicalNote" WHERE "bookingId" = ${bA1}`)[0].n
      );
    });
    expect(ok).toBe(3);
    // Idempotencia: misma clave en el mismo consultorio → 23505.
    const key = randomUUID();
    const sameKey = await sqlError(
      inTx(db, async (tx) => {
        await note(tx, { key });
        await note(tx, { key, bookingId: bA1b });
      })
    );
    expect(sameKey.code).toBe("23505");
  });

  // ── El turno con evolución ──────────────────────────────────────────
  it("DELETE FROM Booking con nota (viva o anulada) → 23503; cambiar Booking.patientId con nota → 23503", async () => {
    const del = await sqlError(
      inTx(db, async (tx) => {
        await note(tx);
        await tx.$executeRaw`DELETE FROM "Booking" WHERE id = ${bA1}`;
      })
    );
    expect(del.code).toBe("23503");
    const delVoided = await sqlError(
      inTx(db, async (tx) => {
        await voidNote(tx, await note(tx));
        await tx.$executeRaw`DELETE FROM "Booking" WHERE id = ${bA1}`;
      })
    );
    expect(delVoided.code).toBe("23503");
    const relink = await sqlError(
      inTx(db, async (tx) => {
        await note(tx);
        await tx.$executeRaw`UPDATE "Booking" SET "patientId" = ${pA2} WHERE id = ${bA1}`;
      })
    );
    expect(relink.code).toBe("23503");
    // Sin nota, el mismo re-vínculo pasa (M9 no cambia nada para los turnos sin evolución).
    const free = await inTx(db, (tx) => tx.$executeRaw`UPDATE "Booking" SET "patientId" = ${pA2} WHERE id = ${bA1b}`);
    expect(free).toBe(1);
  });

  // ── Aislamiento con el rol de la app ────────────────────────────────
  it("app: con su GUC inserta y ve; con el GUC de otro consultorio no ve, no edita y no inserta (42501); sin GUC no ve", async () => {
    const own = await inTx(db, async (tx) => {
      await asApp(tx, A.tenantId);
      const id = await note(tx);
      return Number((await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "ClinicalNote" WHERE id = ${id}`)[0].n);
    });
    expect(own).toBe(1);

    const cross = await inTx(db, async (tx) => {
      const id = await note(tx);
      await editBody(tx, id, "v2"); // deja una revisión de A
      await asApp(tx, B.tenantId);
      const seen = Number((await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "ClinicalNote" WHERE id = ${id}`)[0].n);
      const revs = Number(
        (await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "ClinicalNoteRevision" WHERE "noteId" = ${id}`)[0].n
      );
      const updated = await editBody(tx, id, "pisada desde B");
      return { seen, revs, updated };
    });
    expect(cross).toEqual({ seen: 0, revs: 0, updated: 0 });

    const ins = await sqlError(
      inTx(db, async (tx) => {
        await asApp(tx, B.tenantId);
        await note(tx);
      })
    );
    expect(ins.code).toBe("42501");

    const noGuc = await inTx(db, async (tx) => {
      const id = await note(tx);
      await asApp(tx, null);
      return Number((await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "ClinicalNote" WHERE id = ${id}`)[0].n);
    });
    expect(noGuc).toBe(0);
  });

  // ── CHECKs ──────────────────────────────────────────────────────────
  it("CHECKs: body vacío/en blanco/> 20.000, título en blanco, autor en blanco, clave corta, auto-enmienda → 23514", async () => {
    const cases: [string, NoteOpts][] = [
      ["body vacío", { body: "" }],
      ["body en blanco", { body: "   " }],
      ["body > 20.000", { body: "x".repeat(20_001) }],
      ["título en blanco", { title: "  " }],
      ["título > 200", { title: "t".repeat(201) }],
      ["autor en blanco", { authorName: " " }],
      ["clave corta", { key: "1234567" }],
      ["auto-enmienda", { id: "m9-self", amendsNoteId: "m9-self", bookingId: null }],
    ];
    for (const [name, o] of cases) {
      const r = await sqlError(inTx(db, (tx) => note(tx, o)));
      expect(r.code, name).toBe("23514");
    }
    // Bordes que entran.
    const ok = await inTx(db, async (tx) => [
      await note(tx, { body: "x".repeat(20_000), title: "t".repeat(200), key: "12345678" }),
    ]);
    expect(ok).toHaveLength(1);
  });

  it("CHECKs de anulación: motivo de 2 letras, en blanco o > 500, anulación a medias → 23514", async () => {
    const cases: [string, string][] = [
      ["motivo de 2 letras", `"voidedAt" = now(), "voidedByUserId" = 'u', "voidReason" = 'ab'`],
      ["motivo en blanco", `"voidedAt" = now(), "voidedByUserId" = 'u', "voidReason" = '     '`],
      ["motivo > 500", `"voidedAt" = now(), "voidedByUserId" = 'u', "voidReason" = repeat('m', 501)`],
      ["sin motivo", `"voidedAt" = now(), "voidedByUserId" = 'u'`],
      ["sin quién", `"voidedAt" = now(), "voidReason" = 'Motivo válido'`],
      ["motivo sin fecha", `"voidReason" = 'Motivo válido'`],
    ];
    for (const [name, set] of cases) {
      const r = await sqlError(
        inTx(db, async (tx) => tx.$executeRawUnsafe(`UPDATE "ClinicalNote" SET ${set} WHERE id = $1`, await note(tx)))
      );
      expect(r.code, name).toBe("23514");
    }
    const ok = await inTx(db, async (tx) => {
      const a = await voidNote(tx, await note(tx), "abc");
      const b = await voidNote(tx, await note(tx, { bookingId: bA1b }), "m".repeat(500));
      return [a, b];
    });
    expect(ok).toEqual([1, 1]);
  });
});

describe.skipIf(!RUN)("M9 clinical_notes · deleteTenantDeep", () => {
  it("borra un consultorio con notas, enmiendas, anuladas y revisiones (modo réplica: revisiones → notas → turnos)", async () => {
    const db = ownerClient();
    try {
      const C = await createEphemeralTenant(db);
      const p = await addPatient(db, C);
      const b = await db.booking.create({
        data: {
          tenantId: C.tenantId,
          patientId: p,
          practitionerId: C.practitionerId,
          serviceId: C.serviceId,
          scheduledFor: new Date("2026-10-06T13:00:00.000Z"),
          durationMin: 45,
          status: "COMPLETED",
          idempotencyKey: randomUUID(),
        },
      });
      const ins = (id: string, bookingId: string | null, amendsNoteId: string | null) =>
        db.$executeRaw`
          INSERT INTO "ClinicalNote" (id, "tenantId", "patientId", "bookingId", "amendsNoteId", body, "occurredAt",
                                      "authorUserId", "authorPractitionerId", "authorName", "idempotencyKey",
                                      "createdAt", "updatedAt")
          VALUES (${id}, ${C.tenantId}, ${p}, ${bookingId}, ${amendsNoteId}, 'Nota', now() AT TIME ZONE 'UTC',
                  ${C.userId}, ${C.practitionerId}, 'Kine', ${randomUUID()}, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')`;
      const s = uniqueSuffix();
      await ins(`m9-root-${s}`, b.id, null);
      await ins(`m9-amend-${s}`, b.id, `m9-root-${s}`);
      await ins(`m9-loose-${s}`, null, null);
      await db.$executeRaw`UPDATE "ClinicalNote" SET body = 'Nota editada' WHERE id = ${`m9-root-${s}`}`;
      await db.$executeRaw`
        UPDATE "ClinicalNote" SET "voidedAt" = now() AT TIME ZONE 'UTC', "voidedByUserId" = ${C.userId},
          "voidReason" = 'Duplicada' WHERE id = ${`m9-loose-${s}`}`;
      expect(await db.clinicalNoteRevision.count({ where: { tenantId: C.tenantId } })).toBe(1);

      await C.cleanup();

      expect(await db.tenant.count({ where: { id: C.tenantId } })).toBe(0);
      expect(await db.clinicalNote.count({ where: { tenantId: C.tenantId } })).toBe(0);
      expect(await db.clinicalNoteRevision.count({ where: { tenantId: C.tenantId } })).toBe(0);
      expect(await db.booking.count({ where: { id: b.id } })).toBe(0);
    } finally {
      await db.$disconnect();
    }
  });
});
