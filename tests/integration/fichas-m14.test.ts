/**
 * M14 `20261021120000_fichas_clinicas` · bloque FC, tanda T4b, sesión FC-0 (plan §24.3; brief T4 Anexo A y Anexo C).
 *
 * Qué se prueba (molde clinical-notes-m9.test.ts; corre igual en `test:integration` y en `:owner`, los 2 roles):
 *   1. Objetos (catálogo de Postgres, por el owner): 3 enums, 4 tablas nuevas y las columnas nuevas de ClinicalNote,
 *      ClinicalNoteRevision, Practitioner y Tenant con tipo/nulabilidad/default; los 2 PARCIALES con su predicado; las
 *      7 FKs de PatientDocument (RESTRICT) y las compuestas exactas; el favorito en CASCADE; CHECKs por nombre; los
 *      triggers de PatientDocument; `clinical_note_guard()` reemplazada (search_path fijo, sin SECURITY DEFINER); RLS.
 *   2. Comportamiento del trigger reemplazado: bodyDoc/diagnoses son CONTENIDO (revisión + 24 h), authorLicense/
 *      importSource son IDENTIDAD, y anular una raíz revoca EN LA BASE lo compartido (NOTE_VOIDED).
 *   3. `patient_document_guard()`: nunca se borra; nace vigente y solo de una raíz viva; solo se revoca, una vez.
 *   4. La carrera compartir/anular con DOS conexiones reales (hallazgo 8 del brief): orden nota → documentos en los dos
 *      caminos, sin 40P01 y nunca una anulada con documento vivo. La espera se comprueba en `pg_locks` (lock no
 *      otorgado del pid que espera), así que el test falla si la carrera no llegó a armarse.
 *   5. Aislamiento con el rol de la APP (`SET LOCAL ROLE kinesoft_app` + GUC dentro de una tx del owner) y
 *      `deleteTenantDeep` con fichas compartidas (modo réplica).
 *
 * Casi todo corre en txs con ROLLBACK (`inTx`): ClinicalNote y PatientDocument no se pueden borrar después. Dentro de
 * una tx `now()` es el inicio de la tx: las edades de `createdAt` son relativas a ese `now()`.
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
const NEW_TABLES = ["DiagnosisCode", "TenantDiagnosis", "DiagnosisFavorite", "PatientDocument"] as const;
const TENANT_TABLES = ["TenantDiagnosis", "DiagnosisFavorite", "PatientDocument"] as const;
const SHA = "a".repeat(64);
const SHA2 = "b".repeat(64);

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
async function columns(db: PrismaClient, table: string, only?: string[]): Promise<Record<string, string>> {
  const rows = await db.$queryRaw<Col[]>`
    SELECT column_name, udt_name, is_nullable, column_default FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}`;
  return Object.fromEntries(
    rows
      .filter((r) => !only || only.includes(r.column_name))
      .map((r) => [r.column_name, `${r.udt_name} ${r.is_nullable}${r.column_default ? ` ${r.column_default}` : ""}`])
  );
}

const count = async (tx: Prisma.TransactionClient, sql: string, ...args: unknown[]) =>
  Number((await tx.$queryRawUnsafe<{ n: bigint }[]>(sql, ...args))[0].n);

// ═════════════════════════════════════════════════════════════════════
// 1. Objetos
// ═════════════════════════════════════════════════════════════════════
describe.skipIf(!RUN)("M14 fichas_clinicas · objetos", () => {
  let db: PrismaClient;
  beforeAll(() => {
    db = ownerClient();
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it("[FC-0] objetos: 3 enums, columnas y tablas con tipo, nulabilidad y default", async () => {
    const enums = await db.$queryRaw<{ t: string; labels: string[] }[]>`
      SELECT t.typname AS t, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
      FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname IN ('DiagnosisSystem', 'PatientDocumentKind', 'PatientDocumentRevokeReason')
      GROUP BY t.typname ORDER BY t.typname`;
    expect(enums).toEqual([
      { t: "DiagnosisSystem", labels: ["ICD11_MMS"] },
      { t: "PatientDocumentKind", labels: ["FICHA"] },
      { t: "PatientDocumentRevokeReason", labels: ["REPLACED", "NOTE_VOIDED", "MANUAL"] },
    ]);

    expect(await columns(db, "DiagnosisCode")).toEqual({
      id: "text NO",
      system: `DiagnosisSystem NO 'ICD11_MMS'::"DiagnosisSystem"`,
      code: "text NO",
      title: "text NO",
      uri: "text NO",
      foundationUri: "text YES",
      chapter: "text YES",
      isLeaf: "bool NO true",
      isResidual: "bool NO false",
      release: "text NO",
      language: "text NO 'es'::text",
      searchText: "text NO",
      retiredAt: "timestamp YES",
      retiredInRelease: "text YES",
      createdAt: "timestamp NO CURRENT_TIMESTAMP",
      updatedAt: "timestamp NO",
    });
    expect(await columns(db, "TenantDiagnosis")).toEqual({
      id: "text NO",
      tenantId: "text NO",
      title: "text NO",
      code: "text YES",
      searchText: "text NO",
      createdByUserId: "text YES",
      archivedAt: "timestamp YES",
      createdAt: "timestamp NO CURRENT_TIMESTAMP",
      updatedAt: "timestamp NO",
    });
    expect(await columns(db, "DiagnosisFavorite")).toEqual({
      id: "text NO",
      tenantId: "text NO",
      userId: "text NO",
      diagnosisCodeId: "text YES",
      tenantDiagnosisId: "text YES",
      conditionId: "text YES",
      createdAt: "timestamp NO CURRENT_TIMESTAMP",
    });
    expect(await columns(db, "PatientDocument")).toEqual({
      id: "text NO",
      tenantId: "text NO",
      patientId: "text NO",
      kind: `PatientDocumentKind NO 'FICHA'::"PatientDocumentKind"`,
      noteId: "text NO",
      noteRevision: "int4 NO",
      sourceDigest: "text NO",
      title: "text NO",
      occurredAt: "timestamp NO",
      snapshot: "jsonb NO",
      snapshotVersion: "int4 NO 1",
      snapshotSha256: "text NO",
      pdfStorageKey: "text NO",
      pdfSha256: "text NO",
      pdfSizeBytes: "int4 NO",
      sharedByUserId: "text NO",
      sharedByPractitionerId: "text NO",
      sharedAt: "timestamp NO",
      revokedAt: "timestamp YES",
      revokedByUserId: "text YES",
      revokeReason: "PatientDocumentRevokeReason YES",
      idempotencyKey: "text NO",
      createdAt: "timestamp NO CURRENT_TIMESTAMP",
    });
    // Columnas nuevas en tablas existentes: NULLABLE y sin default (aditiva, sin backfill).
    expect(await columns(db, "ClinicalNote", ["bodyDoc", "diagnoses", "authorLicense", "importSource"])).toEqual({
      bodyDoc: "jsonb YES",
      diagnoses: "jsonb YES",
      authorLicense: "text YES",
      importSource: "jsonb YES",
    });
    expect(await columns(db, "ClinicalNoteRevision", ["bodyDoc", "diagnoses"])).toEqual({
      bodyDoc: "jsonb YES",
      diagnoses: "jsonb YES",
    });
    expect(await columns(db, "Practitioner", ["honorific", "signatureStorageKey", "signatureUpdatedAt"])).toEqual({
      honorific: "text YES",
      signatureStorageKey: "text YES",
      signatureUpdatedAt: "timestamp YES",
    });
    expect(await columns(db, "Tenant", ["logoStorageKey", "logoUpdatedAt"])).toEqual({
      logoStorageKey: "text YES",
      logoUpdatedAt: "timestamp YES",
    });
  });

  it("[FC-0] parciales con su predicado", async () => {
    const rows = await db.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = ANY(${[...NEW_TABLES]})`;
    const idx = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef.replace(/ ON public\./, " ON ")]));
    expect(Object.keys(idx).sort()).toEqual(
      [
        "DiagnosisCode_pkey",
        "DiagnosisCode_system_code_key",
        "TenantDiagnosis_pkey",
        "TenantDiagnosis_id_tenantId_key",
        "TenantDiagnosis_tenantId_idx",
        "TenantDiagnosis_tenantId_title_active_key",
        "DiagnosisFavorite_pkey",
        "DiagnosisFavorite_tenantId_userId_diagnosisCodeId_key",
        "DiagnosisFavorite_tenantId_userId_tenantDiagnosisId_key",
        "DiagnosisFavorite_tenantId_userId_conditionId_key",
        "DiagnosisFavorite_userId_idx",
        "DiagnosisFavorite_diagnosisCodeId_idx",
        "DiagnosisFavorite_tenantDiagnosisId_idx",
        "DiagnosisFavorite_conditionId_idx",
        "PatientDocument_pkey",
        "PatientDocument_tenantId_idempotencyKey_key",
        "PatientDocument_tenantId_patientId_sharedAt_idx",
        "PatientDocument_patientId_idx",
        "PatientDocument_noteId_idx",
        "PatientDocument_sharedByPractitionerId_idx",
        "PatientDocument_noteId_live_key",
      ].sort()
    );
    expect(idx.PatientDocument_noteId_live_key).toBe(
      `CREATE UNIQUE INDEX "PatientDocument_noteId_live_key" ON "PatientDocument" USING btree ("noteId") WHERE ("revokedAt" IS NULL)`
    );
    expect(idx.TenantDiagnosis_tenantId_title_active_key).toBe(
      `CREATE UNIQUE INDEX "TenantDiagnosis_tenantId_title_active_key" ON "TenantDiagnosis" USING btree ("tenantId", lower(btrim(title))) WHERE ("archivedAt" IS NULL)`
    );
    expect(idx.PatientDocument_tenantId_patientId_sharedAt_idx).toBe(
      `CREATE INDEX "PatientDocument_tenantId_patientId_sharedAt_idx" ON "PatientDocument" USING btree ("tenantId", "patientId", "sharedAt" DESC)`
    );
    expect(idx.DiagnosisCode_system_code_key).toBe(
      `CREATE UNIQUE INDEX "DiagnosisCode_system_code_key" ON "DiagnosisCode" USING btree (system, code)`
    );
  });

  it("[FC-0] 7 FKs de `PatientDocument` RESTRICT + las compuestas exactas; favorito CASCADE", async () => {
    const rows = await db.$queryRaw<{ rel: string; conname: string; def: string }[]>`
      SELECT conrelid::regclass::text AS rel, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE contype = 'f' AND conrelid IN ('"PatientDocument"'::regclass, '"DiagnosisFavorite"'::regclass,
                                           '"TenantDiagnosis"'::regclass, '"DiagnosisCode"'::regclass)`;
    const fk = Object.fromEntries(rows.map((r) => [r.conname, r.def]));
    const doc = rows.filter((r) => r.rel === '"PatientDocument"');
    expect(doc.map((r) => r.conname).sort()).toEqual(
      [
        "PatientDocument_tenantId_fkey",
        "PatientDocument_patientId_fkey",
        "PatientDocument_patient_tenant_fkey",
        "PatientDocument_noteId_fkey",
        "PatientDocument_note_tenant_patient_fkey",
        "PatientDocument_sharedByPractitionerId_fkey",
        "PatientDocument_sharer_tenant_fkey",
      ].sort()
    );
    // Lo compartido es HC: nada se borra ni se re-apunta en cascada.
    for (const r of doc) {
      expect(r.def, r.conname).toMatch(/ON DELETE RESTRICT$/);
      expect(r.def, r.conname).not.toMatch(/CASCADE|SET NULL/);
    }
    expect(fk.PatientDocument_patient_tenant_fkey).toBe(
      `FOREIGN KEY ("patientId", "tenantId") REFERENCES "Patient"(id, "tenantId") ON DELETE RESTRICT`
    );
    expect(fk.PatientDocument_note_tenant_patient_fkey).toBe(
      `FOREIGN KEY ("noteId", "tenantId", "patientId") REFERENCES "ClinicalNote"(id, "tenantId", "patientId") ON DELETE RESTRICT`
    );
    expect(fk.PatientDocument_sharer_tenant_fkey).toBe(
      `FOREIGN KEY ("sharedByPractitionerId", "tenantId") REFERENCES "Practitioner"(id, "tenantId") ON DELETE RESTRICT`
    );
    // Un favorito no es HC: cae con el consultorio, el usuario, el propio o la condición; el CIE-11 nunca se borra.
    expect(rows.filter((r) => r.rel === '"DiagnosisFavorite"').map((r) => r.conname).sort()).toEqual(
      [
        "DiagnosisFavorite_tenantId_fkey",
        "DiagnosisFavorite_userId_fkey",
        "DiagnosisFavorite_diagnosisCodeId_fkey",
        "DiagnosisFavorite_tenantDiagnosisId_fkey",
        "DiagnosisFavorite_tenantDiagnosis_tenant_fkey",
        "DiagnosisFavorite_conditionId_fkey",
      ].sort()
    );
    expect(fk.DiagnosisFavorite_tenantDiagnosis_tenant_fkey).toBe(
      `FOREIGN KEY ("tenantDiagnosisId", "tenantId") REFERENCES "TenantDiagnosis"(id, "tenantId") ON DELETE CASCADE`
    );
    expect(fk.DiagnosisFavorite_tenantDiagnosisId_fkey).toMatch(/ON DELETE CASCADE$/);
    expect(fk.DiagnosisFavorite_conditionId_fkey).toMatch(/ON DELETE CASCADE$/);
    expect(fk.DiagnosisFavorite_userId_fkey).toMatch(/ON DELETE CASCADE$/);
    expect(fk.DiagnosisFavorite_tenantId_fkey).toMatch(/ON DELETE CASCADE$/);
    expect(fk.DiagnosisFavorite_diagnosisCodeId_fkey).toMatch(/REFERENCES "DiagnosisCode"\(id\) .*ON DELETE RESTRICT$/);
    expect(fk.TenantDiagnosis_tenantId_fkey).toMatch(/ON DELETE CASCADE$/);
    expect(rows.filter((r) => r.rel === '"DiagnosisCode"')).toEqual([]);
  });

  it("[FC-0] CHECKs con su nombre", async () => {
    const rows = await db.$queryRaw<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE contype = 'c' AND conrelid IN ('"DiagnosisCode"'::regclass, '"TenantDiagnosis"'::regclass,
        '"DiagnosisFavorite"'::regclass, '"PatientDocument"'::regclass, '"ClinicalNote"'::regclass,
        '"ClinicalNoteRevision"'::regclass, '"Practitioner"'::regclass, '"Tenant"'::regclass)`;
    const names = rows.map((r) => r.conname);
    expect(names).toEqual(
      expect.arrayContaining([
        "DiagnosisCode_code_check",
        "DiagnosisCode_title_check",
        "DiagnosisCode_uri_check",
        "DiagnosisCode_release_check",
        "DiagnosisCode_language_check",
        "DiagnosisCode_searchText_check",
        "DiagnosisCode_retired_check",
        "TenantDiagnosis_title_check",
        "TenantDiagnosis_code_check",
        "TenantDiagnosis_searchText_check",
        "DiagnosisFavorite_target_check",
        "PatientDocument_noteRevision_check",
        "PatientDocument_title_check",
        "PatientDocument_snapshotVersion_check",
        "PatientDocument_snapshot_check",
        "PatientDocument_digests_check",
        "PatientDocument_pdf_check",
        "PatientDocument_revoke_check",
        "PatientDocument_idempotencyKey_check",
        "Practitioner_honorific_check",
        "Practitioner_signature_check",
        "Tenant_logo_check",
      ])
    );
    // ClinicalNote: los 7 de M9 + 4 de M14 (+ el de la revisión de M9 = 12 en las dos tablas de la HC).
    const hc = await db.$queryRaw<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
      WHERE contype = 'c' AND conrelid IN ('"ClinicalNote"'::regclass, '"ClinicalNoteRevision"'::regclass)`;
    expect(hc.map((r) => r.conname)).toEqual(
      expect.arrayContaining([
        "ClinicalNote_bodyDoc_check",
        "ClinicalNote_diagnoses_check",
        "ClinicalNote_authorLicense_check",
        "ClinicalNote_importSource_check",
      ])
    );
    expect(hc).toHaveLength(12);
  });

  it("[FC-0] triggers `PatientDocument_guard`/`_no_truncate`; `clinical_note_guard` con `search_path` fijo y sin SECURITY DEFINER", async () => {
    const trg = await db.$queryRaw<{ tgname: string; enabled: string; def: string }[]>`
      SELECT tgname, tgenabled::text AS enabled, pg_get_triggerdef(oid) AS def FROM pg_trigger
      WHERE NOT tgisinternal AND tgrelid = '"PatientDocument"'::regclass ORDER BY tgname`;
    expect(trg.map((t) => [t.tgname, t.enabled])).toEqual([
      ["PatientDocument_guard", "O"],
      ["PatientDocument_no_truncate", "O"],
    ]);
    const def = Object.fromEntries(trg.map((t) => [t.tgname, t.def]));
    expect(def.PatientDocument_guard).toMatch(
      /BEFORE INSERT OR DELETE OR UPDATE ON .* FOR EACH ROW EXECUTE FUNCTION patient_document_guard\(\)/
    );
    expect(def.PatientDocument_no_truncate).toMatch(
      /BEFORE TRUNCATE ON .* FOR EACH STATEMENT EXECUTE FUNCTION patient_document_guard\(\)/
    );
    // Los triggers de ClinicalNote siguen siendo los de M9 (CREATE OR REPLACE FUNCTION no los toca).
    const cn = await db.$queryRaw<{ tgname: string; def: string }[]>`
      SELECT tgname, pg_get_triggerdef(oid) AS def FROM pg_trigger
      WHERE NOT tgisinternal AND tgrelid = '"ClinicalNote"'::regclass ORDER BY tgname`;
    expect(cn.map((t) => t.tgname)).toEqual(["ClinicalNote_guard", "ClinicalNote_no_truncate"]);
    expect(cn[0].def).toMatch(/BEFORE DELETE OR UPDATE .* FOR EACH ROW EXECUTE FUNCTION clinical_note_guard\(\)/);

    const fns = await db.$queryRaw<{ proname: string; cfg: string[] | null; secdef: boolean; src: string }[]>`
      SELECT proname, proconfig AS cfg, prosecdef AS secdef, prosrc AS src FROM pg_proc
      WHERE proname IN ('clinical_note_guard', 'patient_document_guard') ORDER BY proname`;
    expect(fns.map(({ proname, cfg, secdef }) => ({ proname, cfg, secdef }))).toEqual([
      { proname: "clinical_note_guard", cfg: ["search_path=pg_catalog, public"], secdef: false },
      { proname: "patient_document_guard", cfg: ["search_path=pg_catalog, public"], secdef: false },
    ]);
    // Es la versión de M14 (la de M9 no conoce PatientDocument ni las columnas nuevas).
    expect(fns[0].src).toMatch(/"PatientDocument"/);
    expect(fns[0].src).toMatch(/NEW\."authorLicense" IS DISTINCT FROM OLD\."authorLicense"/);
    expect(fns[0].src).toMatch(/OLD\."bodyDoc", OLD\."diagnoses"/);
  });

  it("[FC-0] RLS: `DiagnosisCode` solo SELECT; `<T>_tenant_isolation` exacta", async () => {
    const rel = await db.$queryRaw<{ relname: string; rls: boolean; force: boolean }[]>`
      SELECT relname, relrowsecurity AS rls, relforcerowsecurity AS force FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relname = ANY(${[...NEW_TABLES]}) ORDER BY relname`;
    expect(rel).toEqual(
      [...NEW_TABLES].sort().map((relname) => ({ relname, rls: true, force: true }))
    );
    const pol = await db.$queryRaw<
      { tablename: string; policyname: string; cmd: string; qual: string | null; with_check: string | null }[]
    >`
      SELECT tablename, policyname, cmd, qual, with_check FROM pg_policies
      WHERE schemaname = 'public' AND tablename = ANY(${[...NEW_TABLES]}) ORDER BY tablename, policyname`;
    expect(pol).toEqual(
      [
        { tablename: "DiagnosisCode", policyname: "DiagnosisCode_read", cmd: "SELECT", qual: "true", with_check: null },
        ...TENANT_TABLES.map((t) => ({
          tablename: t,
          policyname: `${t}_tenant_isolation`,
          cmd: "ALL",
          qual: `("tenantId" = app_current_tenant_id())`,
          with_check: `("tenantId" = app_current_tenant_id())`,
        })),
      ].sort((a, b) => a.tablename.localeCompare(b.tablename))
    );
    // Sin GRANT propio: DEFAULT PRIVILEGES; anon/authenticated nada.
    const grants = await db.$queryRaw<{ grantee: string }[]>`
      SELECT grantee FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = ANY(${[...NEW_TABLES]}) AND grantee IN ('anon', 'authenticated')`;
    expect(grants).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════
// 2-3. Comportamiento (todo en txs con ROLLBACK)
// ═════════════════════════════════════════════════════════════════════
describe.skipIf(!RUN)("M14 fichas_clinicas · comportamiento", () => {
  let db: PrismaClient;
  let A: EphemeralTenant;
  let B: EphemeralTenant;
  let pA1: string;
  let pA2: string;
  let pB: string;

  type NoteOpts = {
    tenantId?: string;
    patientId?: string;
    amendsNoteId?: string | null;
    authorPractitionerId?: string;
    body?: string;
    bodyDoc?: unknown;
    diagnoses?: unknown;
    authorLicense?: string | null;
    importSource?: unknown;
    age?: string;
  };
  /** Inserta una ficha (por defecto: consultorio A, paciente pA1, sin turno, autor el titular de A). */
  const note = async (tx: Prisma.TransactionClient, o: NoteOpts = {}): Promise<string> => {
    const id = `m14-n-${uniqueSuffix()}`;
    const j = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));
    await tx.$executeRawUnsafe(
      `INSERT INTO "ClinicalNote" (id, "tenantId", "patientId", "amendsNoteId", body, "occurredAt",
                                   "authorUserId", "authorPractitionerId", "authorName", "idempotencyKey",
                                   "bodyDoc", diagnoses, "authorLicense", "importSource", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, now() AT TIME ZONE 'UTC', $6, $7, 'Kine Titular', $8,
               $9::jsonb, $10::jsonb, $11, $12::jsonb,
               (now() AT TIME ZONE 'UTC') - $13::interval, (now() AT TIME ZONE 'UTC') - $13::interval)`,
      id,
      o.tenantId ?? A.tenantId,
      o.patientId ?? pA1,
      o.amendsNoteId ?? null,
      o.body ?? "Dolor lumbar 6/10.",
      A.userId,
      o.authorPractitionerId ?? A.practitionerId,
      randomUUID(),
      j(o.bodyDoc),
      j(o.diagnoses),
      o.authorLicense ?? null,
      j(o.importSource),
      o.age ?? "0 seconds"
    );
    return id;
  };
  type DocOpts = {
    tenantId?: string;
    patientId?: string;
    sharedByPractitionerId?: string;
    revoked?: boolean;
    title?: string;
    snapshot?: unknown;
    sha?: string;
    pdfSizeBytes?: number;
    key?: string;
  };
  const doc = async (tx: Prisma.TransactionClient, noteId: string, o: DocOpts = {}): Promise<string> => {
    const id = `m14-d-${uniqueSuffix()}`;
    await tx.$executeRawUnsafe(
      `INSERT INTO "PatientDocument" (id, "tenantId", "patientId", "noteId", "noteRevision", "sourceDigest", title,
         "occurredAt", snapshot, "snapshotSha256", "pdfStorageKey", "pdfSha256", "pdfSizeBytes", "sharedByUserId",
         "sharedByPractitionerId", "sharedAt", "idempotencyKey", "revokedAt", "revokedByUserId", "revokeReason")
       VALUES ($1, $2, $3, $4, 1, $5, $6, now() AT TIME ZONE 'UTC', $7::jsonb, $5, $8, $5, $9, $10, $11,
               now() AT TIME ZONE 'UTC', $12,
               CASE WHEN $13 THEN now() AT TIME ZONE 'UTC' END, CASE WHEN $13 THEN $10 END,
               CASE WHEN $13 THEN 'MANUAL'::"PatientDocumentRevokeReason" END)`,
      id,
      o.tenantId ?? A.tenantId,
      o.patientId ?? pA1,
      noteId,
      o.sha ?? SHA,
      o.title ?? "Ficha del 18/10",
      JSON.stringify(o.snapshot ?? { v: 1, blocks: [] }),
      `stub:${id}`,
      o.pdfSizeBytes ?? 1234,
      A.userId,
      o.sharedByPractitionerId ?? A.practitionerId,
      o.key ?? randomUUID(),
      o.revoked ?? false
    );
    return id;
  };
  const voidNote = (tx: Prisma.TransactionClient, id: string) =>
    tx.$executeRaw`
      UPDATE "ClinicalNote" SET "voidedAt" = (now() AT TIME ZONE 'UTC') + interval '1 minute',
        "voidedByUserId" = ${A.userId}, "voidReason" = 'Cargada en el paciente equivocado' WHERE id = ${id}`;
  const revoke = (tx: Prisma.TransactionClient, id: string, reason = "REPLACED") =>
    tx.$executeRawUnsafe(
      `UPDATE "PatientDocument" SET "revokedAt" = TIMESTAMP '2026-01-01 00:00:00', "revokedByUserId" = $2,
         "revokeReason" = $3::"PatientDocumentRevokeReason" WHERE id = $1`,
      id,
      A.userId,
      reason
    );
  const docRow = async (tx: Prisma.TransactionClient, id: string) =>
    (
      await tx.$queryRaw<{ revokedAt: Date | null; revokedByUserId: string | null; revokeReason: string | null }[]>`
        SELECT "revokedAt", "revokedByUserId", "revokeReason"::text AS "revokeReason" FROM "PatientDocument" WHERE id = ${id}`
    )[0];

  beforeAll(async () => {
    db = ownerClient();
    await sweepOrphanTestTenants(db);
    A = await createEphemeralTenant(db);
    B = await createEphemeralTenant(db);
    pA1 = await addPatient(db, A);
    pA2 = await addPatient(db, A);
    pB = await addPatient(db, B);
  });
  afterAll(async () => {
    await A?.cleanup();
    await B?.cleanup();
    await db.$disconnect();
  });

  const DOC1 = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "v1" }] }] };
  const DOC2 = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "v2" }] }] };
  const DX1 = [{ source: "icd11", code: "ME84.2", title: "Dolor lumbar", uri: "http://id.who.int/icd/release/11/mms/1" }];
  const DX2 = [...DX1, { source: "tenant", title: "Contractura paravertebral" }];

  // ── Contenido → revisión ────────────────────────────────────────────
  it("[FC-0] editar `bodyDoc` dentro de 24 h → revisión con el doc y los diagnósticos anteriores (owner y app)", async () => {
    for (const role of ["owner", "app"] as const) {
      const out = await inTx(db, async (tx) => {
        const id = await note(tx, { body: "v1", bodyDoc: DOC1, diagnoses: DX1, age: "1 hour" });
        if (role === "app") await asApp(tx, A.tenantId);
        const n = await tx.$executeRawUnsafe(
          `UPDATE "ClinicalNote" SET body = 'v2', "bodyDoc" = $2::jsonb, "updatedAt" = now() AT TIME ZONE 'UTC' WHERE id = $1`,
          id,
          JSON.stringify(DOC2)
        );
        const revs = await tx.$queryRaw<{ revision: number; body: string; bodyDoc: unknown; diagnoses: unknown }[]>`
          SELECT revision, body, "bodyDoc", diagnoses FROM "ClinicalNoteRevision" WHERE "noteId" = ${id}`;
        const [row] = await tx.$queryRaw<{ revision: number; bodyDoc: unknown }[]>`
          SELECT revision, "bodyDoc" FROM "ClinicalNote" WHERE id = ${id}`;
        return { n, revs, row };
      });
      expect(out.n, role).toBe(1);
      expect(out.row, role).toEqual({ revision: 2, bodyDoc: DOC2 });
      expect(out.revs, role).toEqual([{ revision: 1, body: "v1", bodyDoc: DOC1, diagnoses: DX1 }]);
    }
  });

  it("[FC-0] editar solo `diagnoses` crea revisión; el mismo doc con otro orden de claves no", async () => {
    const out = await inTx(db, async (tx) => {
      const id = await note(tx, { bodyDoc: DOC1, diagnoses: DX1 });
      await tx.$executeRawUnsafe(`UPDATE "ClinicalNote" SET diagnoses = $2::jsonb WHERE id = $1`, id, JSON.stringify(DX2));
      const afterDx = await count(tx, `SELECT count(*) AS n FROM "ClinicalNoteRevision" WHERE "noteId" = $1`, id);
      // Mismo valor jsonb con las claves en otro orden: no es cambio de contenido.
      await tx.$executeRawUnsafe(
        `UPDATE "ClinicalNote" SET "bodyDoc" = '{"content":[{"content":[{"text":"v1","type":"text"}],"type":"paragraph"}],"type":"doc"}'::jsonb
         WHERE id = $1`,
        id
      );
      const afterReorder = await count(tx, `SELECT count(*) AS n FROM "ClinicalNoteRevision" WHERE "noteId" = $1`, id);
      const [row] = await tx.$queryRaw<{ revision: number }[]>`SELECT revision FROM "ClinicalNote" WHERE id = ${id}`;
      const [rev] = await tx.$queryRaw<{ diagnoses: unknown }[]>`
        SELECT diagnoses FROM "ClinicalNoteRevision" WHERE "noteId" = ${id} AND revision = 1`;
      return { afterDx, afterReorder, revision: row.revision, prevDx: rev.diagnoses };
    });
    expect(out).toEqual({ afterDx: 1, afterReorder: 1, revision: 2, prevDx: DX1 });
  });

  it("[FC-0] 25 h → P0001 «pasaron más de 24 h»", async () => {
    for (const set of [`"bodyDoc" = '{"type":"doc","content":[]}'::jsonb`, `diagnoses = '[{"source":"tenant","title":"Otro"}]'::jsonb`]) {
      const r = await sqlError(
        inTx(db, async (tx) =>
          tx.$executeRawUnsafe(`UPDATE "ClinicalNote" SET ${set} WHERE id = $1`, await note(tx, { bodyDoc: DOC1, age: "25 hours" }))
        )
      );
      expect(r.code, set).toBe("P0001");
      expect(r.message, set).toMatch(/pasaron más de 24 h, se enmienda o se anula/);
    }
  });

  it("[FC-0] `authorLicense`/`importSource` → P0001 «columnas de identidad inmutables»", async () => {
    const cases: [string, NoteOpts, string][] = [
      ["authorLicense NULL → valor", {}, `"authorLicense" = 'MN 1234'`],
      ["authorLicense valor → otro", { authorLicense: "MN 1234" }, `"authorLicense" = 'MN 9999'`],
      ["authorLicense valor → NULL", { authorLicense: "MN 1234" }, `"authorLicense" = NULL`],
      ["importSource NULL → valor", {}, `"importSource" = '{"kind":"docx"}'::jsonb`],
      ["importSource valor → NULL", { importSource: { kind: "docx", fileName: "a.docx" } }, `"importSource" = NULL`],
    ];
    for (const [name, o, set] of cases) {
      const r = await sqlError(
        inTx(db, async (tx) => tx.$executeRawUnsafe(`UPDATE "ClinicalNote" SET ${set} WHERE id = $1`, await note(tx, o)))
      );
      expect(r.code, name).toBe("P0001");
      expect(r.message, name).toMatch(/columnas de identidad inmutables/);
    }
  });

  // ── Anular revoca en la base ────────────────────────────────────────
  it("[FC-0] anular una raíz compartida revoca en la misma sentencia (NOTE_VOIDED, `revokedAt = voidedAt`); anular una enmienda no", async () => {
    const out = await inTx(db, async (tx) => {
      const root = await note(tx);
      const old = await doc(tx, root);
      await revoke(tx, old, "REPLACED");
      const live = await doc(tx, root);
      const n = await voidNote(tx, root);
      const [nr] = await tx.$queryRaw<{ voidedAt: Date; voidedByUserId: string }[]>`
        SELECT "voidedAt", "voidedByUserId" FROM "ClinicalNote" WHERE id = ${root}`;
      return { n, nr, old: await docRow(tx, old), live: await docRow(tx, live) };
    });
    expect(out.n).toBe(1);
    expect(out.live).toEqual({ revokedAt: out.nr.voidedAt, revokedByUserId: out.nr.voidedByUserId, revokeReason: "NOTE_VOIDED" });
    // El ya revocado no se toca (revocado = congelado).
    expect(out.old).toEqual({ revokedAt: new Date("2026-01-01T00:00:00.000Z"), revokedByUserId: A.userId, revokeReason: "REPLACED" });

    const amend = await inTx(db, async (tx) => {
      const root = await note(tx);
      const live = await doc(tx, root);
      const am = await note(tx, { amendsNoteId: root });
      await voidNote(tx, am);
      return docRow(tx, live);
    });
    expect(amend).toEqual({ revokedAt: null, revokedByUserId: null, revokeReason: null });
  });

  // ── PatientDocument: inalterable ────────────────────────────────────
  it("[FC-0] `PatientDocument`: DELETE/TRUNCATE → P0001 (también el owner)", async () => {
    const owner = await sqlError(
      inTx(db, async (tx) => tx.$executeRawUnsafe(`DELETE FROM "PatientDocument" WHERE id = $1`, await doc(tx, await note(tx))))
    );
    expect(owner.code).toBe("P0001");
    expect(owner.message).toMatch(/PatientDocument no se borra nunca \(se revoca\): DELETE rechazado/);
    const app = await sqlError(
      inTx(db, async (tx) => {
        const d = await doc(tx, await note(tx));
        await asApp(tx, A.tenantId);
        await tx.$executeRawUnsafe(`DELETE FROM "PatientDocument" WHERE id = $1`, d);
      })
    );
    expect(app.code).toBe("P0001");
    const t = await sqlError(
      inTx(db, async (tx) => {
        await doc(tx, await note(tx));
        await tx.$executeRawUnsafe(`TRUNCATE "PatientDocument"`);
      })
    );
    expect(t.code).toBe("P0001");
    expect(t.message).toMatch(/PatientDocument no se borra nunca \(se revoca\): TRUNCATE rechazado/);
  });

  it("[FC-0] `PatientDocument`: UPDATE fuera de la revocación → P0001; revocar una vez OK; re-revocar o des-revocar → P0001", async () => {
    const outside: [string, string, RegExp][] = [
      ["editar el título", `title = 'Otra'`, /solo se puede revocar/],
      ["revocar y editar el PDF", `"revokedAt" = now(), "revokedByUserId" = 'u', "revokeReason" = 'MANUAL', "pdfSha256" = '${SHA2}'`, /inalterable/],
      ["revocar y cambiar de paciente", `"revokedAt" = now(), "revokedByUserId" = 'u', "revokeReason" = 'MANUAL', "patientId" = '${"x"}'`, /inalterable/],
    ];
    for (const [name, set, msg] of outside) {
      const r = await sqlError(
        inTx(db, async (tx) => tx.$executeRawUnsafe(`UPDATE "PatientDocument" SET ${set} WHERE id = $1`, await doc(tx, await note(tx))))
      );
      expect(r.code, name).toBe("P0001");
      expect(r.message, name).toMatch(msg);
    }
    const once = await inTx(db, async (tx) => {
      const d = await doc(tx, await note(tx));
      const n = await revoke(tx, d, "MANUAL");
      return { n, row: await docRow(tx, d) };
    });
    expect(once.n).toBe(1);
    expect(once.row.revokeReason).toBe("MANUAL");
    for (const [name, set] of [
      ["re-revocar", `"revokeReason" = 'REPLACED'`],
      ["des-revocar", `"revokedAt" = NULL, "revokedByUserId" = NULL, "revokeReason" = NULL`],
    ] as const) {
      const r = await sqlError(
        inTx(db, async (tx) => {
          const d = await doc(tx, await note(tx));
          await revoke(tx, d);
          await tx.$executeRawUnsafe(`UPDATE "PatientDocument" SET ${set} WHERE id = $1`, d);
        })
      );
      expect(r.code, name).toBe("P0001");
      expect(r.message, name).toMatch(/revocado = congelado/);
    }
  });

  it("[FC-0] `PatientDocument`: INSERT revocado, de una enmienda, de una anulada o de otro paciente → P0001/23503", async () => {
    const p0001: [string, (tx: Prisma.TransactionClient) => Promise<unknown>, RegExp][] = [
      ["revocado", async (tx) => doc(tx, await note(tx), { revoked: true }), /nace vigente/],
      ["de una enmienda", async (tx) => doc(tx, await note(tx, { amendsNoteId: await note(tx) })), /no es una raíz vigente/],
      [
        "de una anulada",
        async (tx) => {
          const n = await note(tx);
          await voidNote(tx, n);
          return doc(tx, n);
        },
        /no es una raíz vigente/,
      ],
      ["de otro paciente", async (tx) => doc(tx, await note(tx), { patientId: pA2 }), /no es una raíz vigente/],
      ["de otro consultorio", async (tx) => doc(tx, await note(tx), { tenantId: B.tenantId, patientId: pB }), /no es una raíz vigente/],
    ];
    for (const [name, fn, msg] of p0001) {
      const r = await sqlError(inTx(db, fn));
      expect(r.code, name).toBe("P0001");
      expect(r.message, name).toMatch(msg);
    }
    // Profesional de otro consultorio como quien compartió: el trigger pasa (la nota es raíz viva), la FK compuesta no.
    const fk = await sqlError(
      inTx(db, async (tx) => doc(tx, await note(tx), { sharedByPractitionerId: B.practitionerId }))
    );
    expect(fk.code).toBe("23503");
  });

  it("[FC-0] dos vivos → 23505", async () => {
    const dup = await sqlError(
      inTx(db, async (tx) => {
        const n = await note(tx);
        await doc(tx, n);
        await doc(tx, n);
      })
    );
    expect(dup.code).toBe("23505");
    // Revocar el anterior y compartir de nuevo (REPLACED) sí entra; la misma clave de idempotencia no.
    const ok = await inTx(db, async (tx) => {
      const n = await note(tx);
      await revoke(tx, await doc(tx, n));
      await doc(tx, n);
      return count(tx, `SELECT count(*) AS n FROM "PatientDocument" WHERE "noteId" = $1`, n);
    });
    expect(ok).toBe(2);
    const key = randomUUID();
    const sameKey = await sqlError(
      inTx(db, async (tx) => {
        await doc(tx, await note(tx), { key });
        await doc(tx, await note(tx), { key });
      })
    );
    expect(sameKey.code).toBe("23505");
  });

  // ── CHECKs ──────────────────────────────────────────────────────────
  it("[FC-0] CHECKs inválidos → 23514", async () => {
    const noteCases: [string, NoteOpts][] = [
      ["bodyDoc array", { bodyDoc: [] }],
      ["bodyDoc sin type doc", { bodyDoc: { type: "paragraph" } }],
      ["bodyDoc escalar", { bodyDoc: "doc" }],
      ["bodyDoc > 400.000", { bodyDoc: { type: "doc", content: [{ type: "text", text: "x".repeat(400_001) }] } }],
      ["diagnoses vacío", { diagnoses: [] }],
      ["diagnoses > 5", { diagnoses: Array.from({ length: 6 }, (_, i) => ({ source: "tenant", title: `D${i}` })) }],
      ["diagnoses objeto", { diagnoses: { source: "tenant", title: "D" } }],
      ["diagnóstico no objeto", { diagnoses: ["Dolor lumbar"] }],
      ["diagnóstico sin título", { diagnoses: [{ source: "tenant" }] }],
      ["título no texto", { diagnoses: [{ source: "tenant", title: 5 }] }],
      ["CIE-11 sin URI", { diagnoses: [{ source: "icd11", code: "ME84.2", title: "Dolor lumbar" }] }],
      ["CIE-11 sin código", { diagnoses: [{ source: "icd11", title: "Dolor lumbar", uri: "http://id.who.int/icd/x" }] }],
      ["CIE-11 URI no texto", { diagnoses: [{ source: "icd11", code: "ME84.2", title: "Dolor", uri: 1 }] }],
      ["diagnoses > 10.000", { diagnoses: [{ source: "tenant", title: "x".repeat(10_001) }] }],
      ["matrícula en blanco", { authorLicense: "   " }],
      ["matrícula > 60", { authorLicense: "M".repeat(61) }],
      ["importSource no docx", { importSource: { kind: "pdf" } }],
      ["importSource array", { importSource: [] }],
    ];
    for (const [name, o] of noteCases) {
      const r = await sqlError(inTx(db, (tx) => note(tx, o)));
      expect(r.code, name).toBe("23514");
    }
    const importedAmend = await sqlError(
      inTx(db, async (tx) => note(tx, { amendsNoteId: await note(tx), importSource: { kind: "docx" } }))
    );
    expect(importedAmend.code, "importada que es enmienda").toBe("23514");

    const docCases: [string, DocOpts][] = [
      ["título en blanco", { title: "  " }],
      ["snapshot sin v", { snapshot: { blocks: [] } }],
      ["snapshot v distinta", { snapshot: { v: 2 } }],
      ["snapshot array", { snapshot: [] }],
      ["sha inválido", { sha: "A".repeat(64) }],
      ["PDF vacío", { pdfSizeBytes: 0 }],
      ["PDF > 10 MB", { pdfSizeBytes: 10_485_761 }],
      ["clave corta", { key: "1234567" }],
    ];
    for (const [name, o] of docCases) {
      const r = await sqlError(inTx(db, async (tx) => doc(tx, await note(tx), o)));
      expect(r.code, name).toBe("23514");
    }
    const halfRevoke = await sqlError(
      inTx(db, async (tx) =>
        tx.$executeRawUnsafe(`UPDATE "PatientDocument" SET "revokedAt" = now() WHERE id = $1`, await doc(tx, await note(tx)))
      )
    );
    expect(halfRevoke.code, "revocación a medias").toBe("23514");

    const code = (c: string, uri = "http://id.who.int/icd/release/11/2025-01/mms/1", extra = "") =>
      `INSERT INTO "DiagnosisCode" (id, code, title, uri, release, "searchText", "updatedAt"${extra ? ", \"retiredAt\"" : ""})
       VALUES ('m14-c-${uniqueSuffix()}', '${c}', 'Dolor lumbar', '${uri}', '2025-01', 'dolor lumbar', now()${extra})`;
    const sqlCases: [string, string][] = [
      ["código CIE-11 inválido", code("me84")],
      ["URI fuera de id.who.int", code("ME84.2", "https://example.com/icd/1")],
      ["retirado a medias", code("ME84.2", undefined, ", now()")],
      ["propio de 1 letra", `INSERT INTO "TenantDiagnosis" (id, "tenantId", title, "searchText", "updatedAt") VALUES ('m14-t-${uniqueSuffix()}', '${A.tenantId}', 'x', 'x', now())`],
      ["favorito sin destino", `INSERT INTO "DiagnosisFavorite" (id, "tenantId", "userId") VALUES ('m14-f-${uniqueSuffix()}', '${A.tenantId}', '${A.userId}')`],
      ["honorífico desconocido", `UPDATE "Practitioner" SET honorific = 'SR' WHERE id = '${A.practitionerId}'`],
      ["firma a medias", `UPDATE "Practitioner" SET "signatureStorageKey" = 'k' WHERE id = '${A.practitionerId}'`],
      ["logo a medias", `UPDATE "Tenant" SET "logoUpdatedAt" = now() WHERE id = '${A.tenantId}'`],
    ];
    for (const [name, sql] of sqlCases) {
      const r = await sqlError(inTx(db, (tx) => tx.$executeRawUnsafe(sql)));
      expect(r.code, name).toBe("23514");
    }

    // Bordes que entran: CIE-11 con código + URI, propio sin código, 5 diagnósticos, honorífico, firma y logo completos.
    const ok = await inTx(db, async (tx) => {
      await note(tx, { bodyDoc: DOC1, diagnoses: DX2, authorLicense: "MN 1234" });
      await note(tx, { diagnoses: Array.from({ length: 5 }, (_, i) => ({ source: "tenant", title: `D${i}` })) });
      await note(tx, { importSource: { kind: "docx", fileName: "ficha.docx" } });
      await tx.$executeRawUnsafe(code("ME84.2"));
      await tx.$executeRawUnsafe(
        `UPDATE "Practitioner" SET honorific = 'KLGA', "signatureStorageKey" = 'k', "signatureUpdatedAt" = now() WHERE id = $1`,
        A.practitionerId
      );
      await tx.$executeRawUnsafe(`UPDATE "Tenant" SET "logoStorageKey" = 'k', "logoUpdatedAt" = now() WHERE id = $1`, A.tenantId);
      return true;
    });
    expect(ok).toBe(true);
  });

  // ── Aislamiento ─────────────────────────────────────────────────────
  it("[FC-0] GUC de otro tenant no ve ni revoca", async () => {
    const out = await inTx(db, async (tx) => {
      const n = await note(tx);
      const d = await doc(tx, n);
      const td = `m14-t-${uniqueSuffix()}`;
      await tx.$executeRawUnsafe(
        `INSERT INTO "TenantDiagnosis" (id, "tenantId", title, "searchText", "updatedAt") VALUES ($1, $2, 'Propio A', 'propio a', now())`,
        td,
        A.tenantId
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "DiagnosisFavorite" (id, "tenantId", "userId", "tenantDiagnosisId") VALUES ($1, $2, $3, $4)`,
        `m14-f-${uniqueSuffix()}`,
        A.tenantId,
        A.userId,
        td
      );
      await asApp(tx, B.tenantId);
      const seen = [
        await count(tx, `SELECT count(*) AS n FROM "PatientDocument" WHERE id = $1`, d),
        await count(tx, `SELECT count(*) AS n FROM "TenantDiagnosis" WHERE "tenantId" = $1`, A.tenantId),
        await count(tx, `SELECT count(*) AS n FROM "DiagnosisFavorite" WHERE "tenantId" = $1`, A.tenantId),
      ];
      const revoked = await revoke(tx, d, "MANUAL");
      const voided = await voidNote(tx, n);
      const ins = await sqlError(
        tx.$executeRawUnsafe(
          `INSERT INTO "TenantDiagnosis" (id, "tenantId", title, "searchText", "updatedAt") VALUES ($1, $2, 'Colado', 'colado', now())`,
          `m14-t-${uniqueSuffix()}`,
          A.tenantId
        )
      );
      return { seen, revoked, voided, insCode: ins.code };
    });
    expect(out).toEqual({ seen: [0, 0, 0], revoked: 0, voided: 0, insCode: "42501" });

    // Y con el GUC propio sí: la app ve lo suyo, el catálogo global se lee pero no se escribe.
    const own = await inTx(db, async (tx) => {
      const d = await doc(tx, await note(tx));
      await tx.$executeRawUnsafe(
        `INSERT INTO "DiagnosisCode" (id, code, title, uri, release, "searchText", "updatedAt")
         VALUES ($1, 'ZZ99', 'Prueba', 'http://id.who.int/icd/release/11/mms/zz', '2025-01', 'prueba', now())`,
        `m14-c-${uniqueSuffix()}`
      );
      await asApp(tx, A.tenantId);
      const docs = await count(tx, `SELECT count(*) AS n FROM "PatientDocument" WHERE id = $1`, d);
      const codes = await count(tx, `SELECT count(*) AS n FROM "DiagnosisCode" WHERE code = 'ZZ99'`);
      const write = await tx.$executeRawUnsafe(`UPDATE "DiagnosisCode" SET title = 'Pisado' WHERE code = 'ZZ99'`);
      return { docs, codes, write };
    });
    expect(own).toEqual({ docs: 1, codes: 1, write: 0 });
    const codeIns = await sqlError(
      inTx(db, async (tx) => {
        await asApp(tx, A.tenantId);
        await tx.$executeRawUnsafe(
          `INSERT INTO "DiagnosisCode" (id, code, title, uri, release, "searchText", "updatedAt")
           VALUES ('m14-c-x', 'ZZ98', 'Prueba', 'http://id.who.int/icd/release/11/mms/zz', '2025-01', 'prueba', now())`
        );
      })
    );
    expect(codeIns.code).toBe("42501");
  });
});

// ═════════════════════════════════════════════════════════════════════
// 4. Carrera compartir/anular con dos conexiones (datos COMMITEADOS; limpia deleteTenantDeep)
// ═════════════════════════════════════════════════════════════════════
describe.skipIf(!RUN)("M14 fichas_clinicas · carrera compartir/anular", () => {
  let db: PrismaClient;
  let c1: PrismaClient;
  let c2: PrismaClient;
  let C: EphemeralTenant;
  let pC: string;

  beforeAll(async () => {
    db = ownerClient();
    c1 = ownerClient();
    c2 = ownerClient();
    C = await createEphemeralTenant(db);
    pC = await addPatient(db, C);
  });
  afterAll(async () => {
    await C?.cleanup();
    await Promise.all([db.$disconnect(), c1.$disconnect(), c2.$disconnect()]);
  });

  const commitNote = async () => {
    const id = `m14-race-${uniqueSuffix()}`;
    await db.$executeRaw`
      INSERT INTO "ClinicalNote" (id, "tenantId", "patientId", body, "occurredAt", "authorUserId", "authorPractitionerId",
                                  "authorName", "idempotencyKey", "createdAt", "updatedAt")
      VALUES (${id}, ${C.tenantId}, ${pC}, 'Ficha', now() AT TIME ZONE 'UTC', ${C.userId}, ${C.practitionerId}, 'Kine',
              ${randomUUID()}, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')`;
    return id;
  };
  const insertDoc = (tx: Prisma.TransactionClient | PrismaClient, noteId: string) => {
    const id = `m14-rd-${uniqueSuffix()}`;
    return tx.$executeRaw`
      INSERT INTO "PatientDocument" (id, "tenantId", "patientId", "noteId", "noteRevision", "sourceDigest", title,
        "occurredAt", snapshot, "snapshotSha256", "pdfStorageKey", "pdfSha256", "pdfSizeBytes", "sharedByUserId",
        "sharedByPractitionerId", "sharedAt", "idempotencyKey")
      VALUES (${id}, ${C.tenantId}, ${pC}, ${noteId}, 1, ${SHA}, 'Ficha', now() AT TIME ZONE 'UTC', '{"v":1}'::jsonb,
              ${SHA}, ${`stub:${id}`}, ${SHA}, 100, ${C.userId}, ${C.practitionerId}, now() AT TIME ZONE 'UTC', ${randomUUID()})`.then(() => id);
  };
  /** Camino de «compartir» (C-FC*): bloquea la NOTA primero y recién después toca documentos (hallazgo 8). */
  const share = async (tx: Prisma.TransactionClient, noteId: string) => {
    await tx.$queryRaw`SELECT 1 FROM "ClinicalNote" WHERE id = ${noteId} FOR SHARE`;
    await tx.$executeRaw`
      UPDATE "PatientDocument" SET "revokedAt" = now() AT TIME ZONE 'UTC', "revokedByUserId" = ${C.userId},
        "revokeReason" = 'REPLACED' WHERE "noteId" = ${noteId} AND "revokedAt" IS NULL`;
    return insertDoc(tx, noteId);
  };
  const voidSql = (tx: Prisma.TransactionClient, noteId: string) =>
    tx.$executeRaw`
      UPDATE "ClinicalNote" SET "voidedAt" = now() AT TIME ZONE 'UTC', "voidedByUserId" = ${C.userId},
        "voidReason" = 'Paciente equivocado' WHERE id = ${noteId}`;
  const pidOf = async (tx: Prisma.TransactionClient) => (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0].pid;
  /** Espera hasta que `pid` tenga un lock NO otorgado en pg_locks (la carrera quedó armada). */
  const waitBlocked = async (pid: number) => {
    for (let i = 0; i < 200; i++) {
      const [r] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_locks WHERE pid = ${pid} AND NOT granted`;
      if (r.n > 0) return;
      await new Promise((res) => setTimeout(res, 25));
    }
    throw new Error(`el pid ${pid} nunca quedó esperando un lock: la carrera no se armó`);
  };
  const deferred = <T,>() => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  };
  const liveOnVoided = () =>
    db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "PatientDocument" d JOIN "ClinicalNote" n ON n.id = d."noteId"
      WHERE d."tenantId" = ${C.tenantId} AND d."revokedAt" IS NULL AND n."voidedAt" IS NOT NULL`.then((r) => r[0].n);

  it("[FC-0] carrera compartir/anular con dos conexiones: sin deadlock y nunca una anulada con documento vivo (`pg_locks`)", async () => {
    // (a) Compartir primero (re-compartir: revoca el viejo e inserta el nuevo) ∥ anular espera la nota y revoca el nuevo.
    {
      const noteId = await commitNote();
      const first = await insertDoc(db, noteId);
      const shared = deferred<number>();
      const release = deferred<void>();
      let newDoc = "";
      const t1 = c1.$transaction(async (tx) => {
        await asApp(tx, C.tenantId);
        const pid = await pidOf(tx);
        newDoc = await share(tx, noteId);
        shared.resolve(pid);
        await release.promise;
      }, { timeout: 30_000 });
      await shared.promise;
      const started = deferred<number>();
      const t2 = c2.$transaction(async (tx) => {
        await asApp(tx, C.tenantId);
        started.resolve(await pidOf(tx));
        return voidSql(tx, noteId);
      }, { timeout: 30_000 });
      await waitBlocked(await started.promise);
      release.resolve();
      const [, voided] = await Promise.all([t1, t2]);
      expect(voided).toBe(1);
      const docs = await db.$queryRaw<{ id: string; reason: string | null }[]>`
        SELECT id, "revokeReason"::text AS reason FROM "PatientDocument" WHERE "noteId" = ${noteId}`;
      expect(Object.fromEntries(docs.map((d) => [d.id, d.reason]))).toEqual({ [first]: "REPLACED", [newDoc]: "NOTE_VOIDED" });
    }

    // (b) Anular primero ∥ compartir espera en el FOR SHARE de la nota y después el trigger lo rechaza (P0001, sin 40P01).
    {
      const noteId = await commitNote();
      const live = await insertDoc(db, noteId);
      const voidedHeld = deferred<void>();
      const release = deferred<void>();
      const t2 = c2.$transaction(async (tx) => {
        await asApp(tx, C.tenantId);
        await voidSql(tx, noteId);
        voidedHeld.resolve();
        await release.promise;
      }, { timeout: 30_000 });
      await voidedHeld.promise;
      const started = deferred<number>();
      const t1 = sqlError(
        c1.$transaction(async (tx) => {
          await asApp(tx, C.tenantId);
          started.resolve(await pidOf(tx));
          await share(tx, noteId);
        }, { timeout: 30_000 })
      );
      await waitBlocked(await started.promise);
      release.resolve();
      await t2;
      const r = await t1;
      expect(r.code).toBe("P0001");
      expect(r.message).toMatch(/no es una raíz vigente/);
      const docs = await db.$queryRaw<{ id: string; reason: string | null }[]>`
        SELECT id, "revokeReason"::text AS reason FROM "PatientDocument" WHERE "noteId" = ${noteId}`;
      expect(docs).toEqual([{ id: live, reason: "NOTE_VOIDED" }]);
    }

    // (c) INSERT sin el FOR SHARE previo de la app ∥ anular: el FOR SHARE del trigger igual serializa.
    {
      const noteId = await commitNote();
      const inserted = deferred<void>();
      const release = deferred<void>();
      const t1 = c1.$transaction(async (tx) => {
        await asApp(tx, C.tenantId);
        await insertDoc(tx, noteId);
        inserted.resolve();
        await release.promise;
      }, { timeout: 30_000 });
      await inserted.promise;
      const started = deferred<number>();
      const t2 = c2.$transaction(async (tx) => {
        await asApp(tx, C.tenantId);
        started.resolve(await pidOf(tx));
        return voidSql(tx, noteId);
      }, { timeout: 30_000 });
      await waitBlocked(await started.promise);
      release.resolve();
      await Promise.all([t1, t2]);
    }

    expect(await liveOnVoided()).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════
// 5. deleteTenantDeep
// ═════════════════════════════════════════════════════════════════════
describe.skipIf(!RUN)("M14 fichas_clinicas · deleteTenantDeep", () => {
  it("[FC-0] `deleteTenantDeep` OK", async () => {
    const db = ownerClient();
    try {
      const C = await createEphemeralTenant(db);
      const p = await addPatient(db, C);
      const s = uniqueSuffix();
      const root = `m14-del-${s}`;
      await db.$executeRaw`
        INSERT INTO "ClinicalNote" (id, "tenantId", "patientId", body, "bodyDoc", diagnoses, "authorLicense", "occurredAt",
                                    "authorUserId", "authorPractitionerId", "authorName", "idempotencyKey", "createdAt", "updatedAt")
        VALUES (${root}, ${C.tenantId}, ${p}, 'Ficha', '{"type":"doc","content":[]}'::jsonb,
                '[{"source":"tenant","title":"Lumbalgia"}]'::jsonb, 'MN 1', now() AT TIME ZONE 'UTC',
                ${C.userId}, ${C.practitionerId}, 'Kine', ${randomUUID()}, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')`;
      const ins = (id: string) =>
        db.$executeRaw`
          INSERT INTO "PatientDocument" (id, "tenantId", "patientId", "noteId", "noteRevision", "sourceDigest", title,
            "occurredAt", snapshot, "snapshotSha256", "pdfStorageKey", "pdfSha256", "pdfSizeBytes", "sharedByUserId",
            "sharedByPractitionerId", "sharedAt", "idempotencyKey")
          VALUES (${id}, ${C.tenantId}, ${p}, ${root}, 1, ${SHA}, 'Ficha', now() AT TIME ZONE 'UTC', '{"v":1}'::jsonb,
                  ${SHA}, ${`stub:${id}`}, ${SHA}, 100, ${C.userId}, ${C.practitionerId}, now() AT TIME ZONE 'UTC', ${randomUUID()})`;
      await ins(`m14-dd1-${s}`);
      await db.$executeRaw`
        UPDATE "PatientDocument" SET "revokedAt" = now(), "revokedByUserId" = ${C.userId}, "revokeReason" = 'REPLACED'
        WHERE id = ${`m14-dd1-${s}`}`;
      await ins(`m14-dd2-${s}`);
      await db.$executeRaw`
        INSERT INTO "TenantDiagnosis" (id, "tenantId", title, "searchText", "updatedAt")
        VALUES (${`m14-td-${s}`}, ${C.tenantId}, 'Lumbalgia mecánica', 'lumbalgia mecanica', now())`;
      await db.$executeRaw`
        INSERT INTO "DiagnosisFavorite" (id, "tenantId", "userId", "tenantDiagnosisId")
        VALUES (${`m14-fv-${s}`}, ${C.tenantId}, ${C.userId}, ${`m14-td-${s}`})`;
      // Anular con un documento vivo: el trigger lo revoca (NOTE_VOIDED) y el borrado igual tiene que pasar.
      await db.$executeRaw`
        UPDATE "ClinicalNote" SET "voidedAt" = now() AT TIME ZONE 'UTC', "voidedByUserId" = ${C.userId},
          "voidReason" = 'Duplicada' WHERE id = ${root}`;

      await C.cleanup();

      const left = await db.$queryRaw<{ t: string; n: number }[]>`
        SELECT 'doc' AS t, count(*)::int AS n FROM "PatientDocument" WHERE "tenantId" = ${C.tenantId}
        UNION ALL SELECT 'note', count(*)::int FROM "ClinicalNote" WHERE "tenantId" = ${C.tenantId}
        UNION ALL SELECT 'td', count(*)::int FROM "TenantDiagnosis" WHERE "tenantId" = ${C.tenantId}
        UNION ALL SELECT 'fav', count(*)::int FROM "DiagnosisFavorite" WHERE "tenantId" = ${C.tenantId}
        UNION ALL SELECT 'tenant', count(*)::int FROM "Tenant" WHERE id = ${C.tenantId}`;
      expect(Object.fromEntries(left.map((r) => [r.t, r.n]))).toEqual({ doc: 0, note: 0, td: 0, fav: 0, tenant: 0 });
    } finally {
      await db.$disconnect();
    }
  });
});
