/**
 * INF-S · núcleo de `scripts/prod-precheck.ts` (plan §26.7, decisión 1 de Martin del 22-oct): prechecks y postchecks
 * de SOLO LECTURA del día del push, para las 6 migraciones que todavía no están en prod (orden de timestamp
 * M12 → M14 → M18 → M17 → M15 → M16 → M19).
 *
 * Por qué existe: hasta T5 cada migración tenía su bloque de SQL suelto en el RUNBOOK y Martin lo copiaba a mano en el
 * SQL editor de Supabase, uno por uno, comparando a ojo contra el comentario («-- 0 filas», «-- = el md5 de M9»). Con
 * seis migraciones juntas eso son ~60 queries y un error de lectura deja pasar justo lo que el precheck tenía que frenar
 * (el md5 de `clinical_note_guard` que M14 reemplaza línea por línea, un `mpCheckoutPreferenceId` que rompería el CHECK
 * nuevo de M16, una tx larga sobre `Booking` que hace caer el deploy por `lock_timeout`). Acá cada query trae su
 * veredicto (PASS / WARN / FAIL / SKIP) y el script sale con código ≠ 0 si hay un FAIL.
 *
 * Reglas:
 *  - UNA transacción `READ ONLY` (`withReadOnlyTx`): Postgres rechaza cualquier write, aunque una query de acá
 *    estuviera mal escrita. Cada chequeo va en su SAVEPOINT: un error de una consulta (permiso de `pg_stat_activity`,
 *    un objeto que no existe) marca ESA fila en FAIL y el resto sigue, en vez de abortar la tx entera.
 *  - Nunca `'"X"'::regclass` (tira si no existe y aborta): siempre `to_regclass`.
 *  - No imprime valores secretos: conteos, nombres de objetos, ids, versiones y el NOMBRE del rol. Ni la URL, ni
 *    passwords, ni texto de queries ajenas (`pg_stat_activity.query` puede traer PHI de un INSERT de paciente).
 *  - Los valores esperados salen del RUNBOOK (M12, M14, M18) y de la verificación local de MIG (M17, M15, M16, ver
 *    `wip-20/t6t7-handoffs.md`). Si el código real cambia un objeto, cambia acá también: el test de integración
 *    (`tests/integration/inf-prod-precheck.test.ts`) corre `--post` contra el Docker y exige PASS en todo.
 *
 * Sin `server-only` y con imports relativos: lo corre `tsx` fuera de Next (mismo criterio que `lib/tenant-bootstrap.ts`).
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Prisma, PrismaClient } from "@prisma/client";

export type CheckStatus = "PASS" | "WARN" | "FAIL" | "SKIP";
export type CheckRow = { id: string; group: string; title: string; status: CheckStatus; detail: string };
export type PrecheckMode = "pre" | "post";

/**
 * Las 6 de la tanda, en el orden en que `migrate deploy` las aplica (timestamp). `sha256` = el checksum que Prisma
 * guarda en `_prisma_migrations` (sha256 del `migration.sql`): RUNBOOK para M12/M14/M18, handoff de MIG para el resto.
 */
export const T6T7_MIGRATIONS = [
  { key: "M12", name: "20261020120000_agenda_secretaria_config", sha256: "a0849c4d28c7154acb3b9a0cf47075bbbde608161d32d126d7ae9d85f9fd7485" },
  { key: "M14", name: "20261021120000_fichas_clinicas", sha256: "f7b12bab45002308751095ee12deb717c4f375ad39e9a3e8470f16afbe4967c9" },
  { key: "M18", name: "20261022120000_turnero_cobros_mp", sha256: "0ffc0c9157d5d9df71770f6d62019a6c916f673db7529eceaa00768d5c88006e" },
  { key: "M17", name: "20261023120000_reception_displays", sha256: "af7426dc3334f6aaa2fb1a9529d4acefc2e27b57f586212f2fffadd52748f430" },
  { key: "M15", name: "20261024120000_whatsapp_messaging", sha256: "e8637727af84b64b38c303be5dc0d762006baa402fdcd989bace81674471cf0d" },
  { key: "M16", name: "20261025120000_saas_mp_subscriptions", sha256: "b235454f0ceceef95394d752f1fe879ec2ec0baf6b7f052ae3e253e47f207798" },
  // PV (27-oct): tickets de Plataforma. Sumada a la misma tanda porque va en el mismo push (decisión de Martin).
  { key: "M19", name: "20261027120000_support_tickets", sha256: "7ac440677f5f80098b6245f1de70b556cc7ea9d4aeeb923b2c6eb9825803f7a2" },
] as const;
type MigKey = (typeof T6T7_MIGRATIONS)[number]["key"];

/** md5(prosrc) esperados después del deploy. `clinical_note_guard` = el de M14 (RUNBOOK «M14 en prod»). */
export const EXPECTED_MD5 = {
  clinical_note_guard: "d0164760670b55036a575042e945adcf",
  patient_document_guard: "677758023a72e44e21c8af18aa2c952b",
  online_charge_guard: "202110977dac927eb5957aa67f3de345",
  online_charge_sync_booking: "f98cc831211d6d5aa559900d3b82bccc",
  saas_adjustment_guard: "fd8790f4959e9f56ea743dead6bb6d2b",
} as const;
/** md5 de `clinical_note_guard` de M9: el que M14 reemplaza línea por línea. Otro valor en prod = frenar (RUNBOOK). */
export const M9_CLINICAL_NOTE_GUARD_MD5 = "0a87f3688a5002c59a7b5238e2ae8a44";

export type PrecheckOptions = {
  /** Conexión owner (DIRECT_URL): con BYPASSRLS, si no los conteos de tablas con RLS darían 0 falsos. */
  db: PrismaClient;
  mode: PrecheckMode;
  /** `prisma/migrations` del repo (lo que el deploy va a aplicar). */
  migrationsDir: string;
  /** Salida de `pg_dump --version` local (la de `db:prod:backup`); null = no está en el PATH. */
  pgDumpVersion: string | null;
  /** `--post`: el relfilenode de `Booking` que anotó el `--pre` (M18 no tiene que reescribir la tabla). */
  bookingRelfilenode?: number | null;
  /**
   * Solo tests: corre los prechecks de `--pre` también para las migraciones YA aplicadas. En el Docker las 6 están
   * aplicadas y sin esto su SQL no se ejecutaría nunca antes del día del push (los «no existe» dan FAIL, que es lo
   * esperado; lo que se valida es que ninguna consulta tire).
   */
  evaluateApplied?: boolean;
};
export type PrecheckResult = { mode: PrecheckMode; rows: CheckRow[]; failed: boolean };

type Tx = Prisma.TransactionClient;
type Verdict = { status: CheckStatus; detail: string };

/**
 * Corre `fn` en una tx READ ONLY con timeouts cortos. `SET TRANSACTION READ ONLY` es la primera sentencia de la tx
 * (Postgres lo exige antes de cualquier query). El `lock_timeout` evita que el precheck MISMO se quede esperando un
 * lock de un deploy en curso: un precheck colgado es peor que uno que falla.
 */
export async function withReadOnlyTx<T>(db: PrismaClient, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET TRANSACTION READ ONLY`);
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '20s'`);
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '3s'`);
      return fn(tx);
    },
    { maxWait: 15_000, timeout: 180_000 }
  );
}

// ─── helpers de consulta ────────────────────────────────────────────────────

function num(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : Number(v ?? 0);
}

async function rows<T = Record<string, unknown>>(tx: Tx, sql: string, ...params: unknown[]): Promise<T[]> {
  return tx.$queryRawUnsafe<T[]>(sql, ...params);
}

async function scalar(tx: Tx, sql: string, ...params: unknown[]): Promise<number> {
  const r = await rows<{ n: unknown }>(tx, sql, ...params);
  return num(r[0]?.n);
}

const pass = (detail: string): Verdict => ({ status: "PASS", detail });
const warn = (detail: string): Verdict => ({ status: "WARN", detail });
const fail = (detail: string): Verdict => ({ status: "FAIL", detail });
const skip = (detail: string): Verdict => ({ status: "SKIP", detail });

/** Varios sub-chequeos en una fila: el primero que no da PASS manda; si todos pasan, se suman los detalles. */
async function allOf(...steps: (() => Promise<Verdict>)[]): Promise<Verdict> {
  const details: string[] = [];
  for (const step of steps) {
    const v = await step();
    if (v.status !== "PASS") return v;
    details.push(v.detail);
  }
  return pass(details.join(" · "));
}

function list(xs: readonly string[], max = 12): string {
  if (xs.length === 0) return "—";
  return xs.length <= max ? xs.join(", ") : `${xs.slice(0, max).join(", ")} … (+${xs.length - max})`;
}

/** Primera línea del error de Postgres, sin la query (Prisma la repite con parámetros). */
function errLine(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  const db = /(?:Code: `\w+`\. )?Message: `([^`]+)`/.exec(m);
  return (db?.[1] ?? m).split("\n").map((s) => s.trim()).filter(Boolean).slice(-1)[0]?.slice(0, 200) ?? "error";
}

class Collector {
  readonly rows: CheckRow[] = [];
  constructor(private tx: Tx) {}
  /** Un chequeo = un SAVEPOINT: si la consulta tira, la fila queda en FAIL y la tx sigue viva. */
  async check(id: string, group: string, title: string, fn: () => Promise<Verdict>): Promise<void> {
    await this.tx.$executeRawUnsafe(`SAVEPOINT inf_s_check`);
    try {
      const v = await fn();
      await this.tx.$executeRawUnsafe(`RELEASE SAVEPOINT inf_s_check`);
      this.rows.push({ id, group, title, ...v });
    } catch (e) {
      await this.tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT inf_s_check`);
      this.rows.push({ id, group, title, status: "FAIL", detail: `la consulta falló: ${errLine(e)}` });
    }
  }
  add(id: string, group: string, title: string, v: Verdict): void {
    this.rows.push({ id, group, title, ...v });
  }
}

/** Tablas de `public` que existen, de la lista. */
async function existingTables(tx: Tx, names: readonly string[]): Promise<string[]> {
  const r = await rows<{ n: string }>(
    tx,
    `SELECT n FROM unnest($1::text[]) AS n WHERE to_regclass('public.' || quote_ident(n)) IS NOT NULL ORDER BY n`,
    names
  );
  return r.map((x) => x.n);
}
async function existingTypes(tx: Tx, names: readonly string[]): Promise<string[]> {
  const r = await rows<{ n: string }>(
    tx,
    `SELECT t.typname AS n FROM pg_type t JOIN pg_namespace s ON s.oid = t.typnamespace
      WHERE s.nspname = 'public' AND t.typname = ANY($1::text[]) ORDER BY 1`,
    names
  );
  return r.map((x) => x.n);
}
/** «Tabla.columna» existentes de la lista. */
async function existingColumns(tx: Tx, pairs: readonly string[]): Promise<string[]> {
  const r = await rows<{ n: string }>(
    tx,
    `SELECT table_name || '.' || column_name AS n FROM information_schema.columns
      WHERE table_schema = 'public' AND (table_name || '.' || column_name) = ANY($1::text[]) ORDER BY 1`,
    pairs
  );
  return r.map((x) => x.n);
}
async function existingProcs(tx: Tx, names: readonly string[]): Promise<string[]> {
  const r = await rows<{ n: string }>(
    tx,
    `SELECT DISTINCT p.proname AS n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
      WHERE s.nspname = 'public' AND p.proname = ANY($1::text[]) ORDER BY 1`,
    names
  );
  return r.map((x) => x.n);
}
async function md5Of(tx: Tx, proname: string): Promise<string[]> {
  const r = await rows<{ m: string }>(
    tx,
    `SELECT md5(p.prosrc) AS m FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
      WHERE s.nspname = 'public' AND p.proname = $1`,
    proname
  );
  return r.map((x) => x.m);
}

/** Nada de esto existe todavía (precheck de «objetos inexistentes»). */
async function absent(
  tx: Tx,
  o: { tables?: readonly string[]; types?: readonly string[]; columns?: readonly string[]; procs?: readonly string[] }
): Promise<Verdict> {
  const found = [
    ...(o.tables ? await existingTables(tx, o.tables) : []).map((t) => `tabla ${t}`),
    ...(o.types ? await existingTypes(tx, o.types) : []).map((t) => `enum ${t}`),
    ...(o.columns ? await existingColumns(tx, o.columns) : []).map((c) => `columna ${c}`),
    ...(o.procs ? await existingProcs(tx, o.procs) : []).map((p) => `función ${p}`),
  ];
  const total = (o.tables?.length ?? 0) + (o.types?.length ?? 0) + (o.columns?.length ?? 0) + (o.procs?.length ?? 0);
  return found.length === 0
    ? pass(`ninguno de los ${total} objetos existe todavía`)
    : fail(`ya existen (alguien los creó a mano o la migración quedó a medias): ${list(found)}`);
}

/** Todo esto existe (postcheck). */
async function present(
  tx: Tx,
  o: { tables?: readonly string[]; types?: readonly string[]; columns?: readonly string[]; procs?: readonly string[] }
): Promise<Verdict> {
  const missing: string[] = [];
  if (o.tables) {
    const f = new Set(await existingTables(tx, o.tables));
    missing.push(...o.tables.filter((t) => !f.has(t)).map((t) => `tabla ${t}`));
  }
  if (o.types) {
    const f = new Set(await existingTypes(tx, o.types));
    missing.push(...o.types.filter((t) => !f.has(t)).map((t) => `enum ${t}`));
  }
  if (o.columns) {
    const f = new Set(await existingColumns(tx, o.columns));
    missing.push(...o.columns.filter((c) => !f.has(c)).map((c) => `columna ${c}`));
  }
  if (o.procs) {
    const f = new Set(await existingProcs(tx, o.procs));
    missing.push(...o.procs.filter((p) => !f.has(p)).map((p) => `función ${p}`));
  }
  const total = (o.tables?.length ?? 0) + (o.types?.length ?? 0) + (o.columns?.length ?? 0) + (o.procs?.length ?? 0);
  return missing.length === 0 ? pass(`los ${total} objetos existen`) : fail(`faltan: ${list(missing)}`);
}

/** RLS ENABLE + FORCE y el set EXACTO de policies (nombre:cmd) de cada tabla. */
async function rlsAndPolicies(tx: Tx, expected: Record<string, readonly string[]>): Promise<Verdict> {
  const tables = Object.keys(expected);
  const rls = await rows<{ relname: string; e: boolean; f: boolean }>(
    tx,
    `SELECT c.relname, c.relrowsecurity AS e, c.relforcerowsecurity AS f FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname = ANY($1::text[])`,
    tables
  );
  const pol = await rows<{ tablename: string; p: string }>(
    tx,
    `SELECT tablename, policyname || ':' || cmd AS p FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY($1::text[])`,
    tables
  );
  const problems: string[] = [];
  for (const t of tables) {
    const r = rls.find((x) => x.relname === t);
    if (!r) {
      problems.push(`${t}: no existe`);
      continue;
    }
    if (!r.e || !r.f) problems.push(`${t}: RLS ${r.e ? "" : "sin ENABLE "}${r.f ? "" : "sin FORCE"}`.trim());
    const got = pol.filter((x) => x.tablename === t).map((x) => x.p).sort();
    const want = [...expected[t]].sort();
    if (got.join("|") !== want.join("|")) problems.push(`${t}: policies [${got.join(", ") || "ninguna"}] ≠ [${want.join(", ") || "ninguna"}]`);
  }
  const nPol = tables.reduce((a, t) => a + expected[t].length, 0);
  return problems.length === 0
    ? pass(`${tables.length} tablas con ENABLE + FORCE; ${nPol} policies exactas`)
    : fail(list(problems, 8));
}

/** Índices que existen Y son parciales (llevan WHERE): drift aceptado, `migrate dev` los propondría borrar. */
async function partialIndexes(tx: Tx, names: readonly string[]): Promise<Verdict> {
  const r = await rows<{ indexname: string; partial: boolean }>(
    tx,
    `SELECT indexname, indexdef ILIKE '% WHERE %' AS partial FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1::text[])`,
    names
  );
  const bad = names.filter((n) => !r.find((x) => x.indexname === n && x.partial));
  return bad.length === 0 ? pass(`${names.length} índices parciales presentes`) : fail(`faltan o no son parciales: ${list(bad)}`);
}

async function constraintsByName(tx: Tx, names: readonly string[], contype: "c" | "f"): Promise<Verdict> {
  const r = await rows<{ conname: string; v: boolean }>(
    tx,
    `SELECT conname, convalidated AS v FROM pg_constraint WHERE contype = $2 AND conname = ANY($1::text[])`,
    names,
    contype
  );
  const bad = names.filter((n) => !r.find((x) => x.conname === n && x.v));
  const what = contype === "c" ? "CHECK" : "FK";
  return bad.length === 0 ? pass(`${names.length} ${what} validados`) : fail(`${what} faltantes o sin validar: ${list(bad)}`);
}

/** Cantidad de CHECK validados sobre un set de tablas nuevas (los nombres los generó la migración). */
async function checkCount(tx: Tx, tables: readonly string[], expected: number): Promise<Verdict> {
  const n = await scalar(
    tx,
    `SELECT count(*) AS n FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      WHERE c.contype = 'c' AND c.convalidated AND t.relnamespace = 'public'::regnamespace AND t.relname = ANY($1::text[])`,
    tables
  );
  return n === expected ? pass(`${n} CHECK validados`) : fail(`${n} CHECK validados (se esperaban ${expected})`);
}

async function triggers(tx: Tx, table: string, expected: readonly string[]): Promise<Verdict> {
  const r = await rows<{ tgname: string }>(
    tx,
    `SELECT tgname FROM pg_trigger WHERE tgrelid = to_regclass('public.' || quote_ident($1)) AND NOT tgisinternal AND tgenabled <> 'D' ORDER BY 1`,
    table
  );
  const got = r.map((x) => x.tgname).sort();
  const want = [...expected].sort();
  return got.join("|") === want.join("|")
    ? pass(`${table}: ${want.join(", ")}`)
    : fail(`${table}: triggers [${got.join(", ") || "ninguno"}] ≠ [${want.join(", ")}]`);
}

async function md5Check(tx: Tx, proname: keyof typeof EXPECTED_MD5): Promise<Verdict> {
  const got = await md5Of(tx, proname);
  if (got.length === 0) return fail(`${proname}() no existe`);
  if (got.length > 1) return fail(`${proname}() tiene ${got.length} sobrecargas`);
  return got[0] === EXPECTED_MD5[proname]
    ? pass(`md5 = ${got[0]}`)
    : fail(`md5 = ${got[0]} (se esperaba ${EXPECTED_MD5[proname]}): la función de prod no es la del repo`);
}

async function invokerWithSearchPath(tx: Tx, names: readonly string[]): Promise<Verdict> {
  const r = await rows<{ proname: string; prosecdef: boolean; cfg: string | null }>(
    tx,
    `SELECT p.proname, p.prosecdef, array_to_string(p.proconfig, ';') AS cfg FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY($1::text[])`,
    names
  );
  const bad = names.filter((n) => {
    const x = r.find((y) => y.proname === n);
    return !x || x.prosecdef || !(x.cfg ?? "").includes("search_path=pg_catalog, public");
  });
  return bad.length === 0 ? pass(`INVOKER con search_path fijo: ${names.join(", ")}`) : fail(`sin INVOKER o sin search_path fijo: ${list(bad)}`);
}

async function enumLabels(tx: Tx, typname: string): Promise<string[]> {
  const r = await rows<{ l: string }>(
    tx,
    `SELECT e.enumlabel AS l FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typnamespace = 'public'::regnamespace AND t.typname = $1 ORDER BY e.enumsortorder`,
    typname
  );
  return r.map((x) => x.l);
}

async function roleExists(tx: Tx, name: string): Promise<boolean> {
  return (await scalar(tx, `SELECT count(*) AS n FROM pg_roles WHERE rolname = $1`, name)) > 0;
}

// ─── objetos por migración ──────────────────────────────────────────────────

const M12_COLUMNS = [
  "Tenant.moduleGrants",
  "Tenant.moduleRevokes",
  "Tenant.bookingCapCount",
  "Tenant.bookingCapIntervalMin",
  "Booking.copagoPaymentMethod",
  "Booking.copagoCollectedById",
] as const;
const M12_CHECKS = [
  "Tenant_moduleOverrides_check",
  "Tenant_bookingCap_check",
  "Practitioner_bookingCap_check",
  "Booking_copago_method_check",
  "Booking_copago_collector_check",
] as const;

const M14_TABLES = ["PatientDocument", "DiagnosisCode", "TenantDiagnosis", "DiagnosisFavorite"] as const;
const M14_TYPES = ["DiagnosisSystem", "PatientDocumentKind", "PatientDocumentRevokeReason"] as const;
const M14_COLUMNS = [
  "ClinicalNote.bodyDoc",
  "ClinicalNote.diagnoses",
  "ClinicalNote.authorLicense",
  "ClinicalNote.importSource",
  "ClinicalNoteRevision.bodyDoc",
  "ClinicalNoteRevision.diagnoses",
  "Practitioner.honorific",
  "Practitioner.signatureStorageKey",
  "Practitioner.signatureUpdatedAt",
  "Tenant.logoStorageKey",
  "Tenant.logoUpdatedAt",
] as const;
const M14_CHECKS = [
  "ClinicalNote_authorLicense_check", "ClinicalNote_bodyDoc_check", "ClinicalNote_diagnoses_check", "ClinicalNote_importSource_check",
  "DiagnosisCode_code_check", "DiagnosisCode_language_check", "DiagnosisCode_release_check", "DiagnosisCode_retired_check",
  "DiagnosisCode_searchText_check", "DiagnosisCode_title_check", "DiagnosisCode_uri_check", "DiagnosisFavorite_target_check",
  "PatientDocument_digests_check", "PatientDocument_idempotencyKey_check", "PatientDocument_noteRevision_check",
  "PatientDocument_pdf_check", "PatientDocument_revoke_check", "PatientDocument_snapshotVersion_check",
  "PatientDocument_snapshot_check", "PatientDocument_title_check", "Practitioner_honorific_check",
  "Practitioner_signature_check", "TenantDiagnosis_code_check", "TenantDiagnosis_searchText_check",
  "TenantDiagnosis_title_check", "Tenant_logo_check",
] as const;

const M18_TABLES = ["OnlineCharge", "MpAccount", "MpCredential", "BookingPaymentPolicy"] as const;
const M18_TYPES = [
  "BookingPaymentMode", "BookingChargeKind", "MpAccountKind", "MpAccountStatus", "OnlineChargeOrigin", "OnlineChargeKind", "OnlineChargeStatus",
] as const;
const M18_PARTIAL = [
  "MpAccount_tenant_practitioner_live_key", "MpAccount_tenant_clinic_live_key", "MpCredential_purgeAfter_idx",
  "OnlineCharge_bookingId_turnero_key", "OnlineCharge_bookingId_live_link_key", "OnlineCharge_tenantId_approvedAt_paid_idx",
] as const;
const M18_FKS = [
  "MpAccount_practitioner_tenant_fkey", "MpCredential_account_tenant_fkey", "OnlineCharge_account_tenant_fkey",
  "OnlineCharge_practitioner_tenant_fkey", "OnlineCharge_patient_tenant_fkey", "OnlineCharge_booking_tenant_patient_fkey",
] as const;

const M17_TYPES = ["DisplayNameMode", "DisplayTheme", "DisplayMediaKind", "DisplayMediaLayout", "DisplayMediaDuringCall"] as const;
const M17_PARTIAL = ["ReceptionDisplay_pairingCodeHash_key", "ReceptionDisplay_tenant_name_live_key"] as const;

const M15_TABLES = ["WhatsAppAccount", "WhatsAppCredential", "WhatsAppTemplate", "WhatsAppMessage", "WhatsAppInbound"] as const;
const M15_TYPES = [
  "WhatsAppAccountStatus", "WhatsAppSetupStep", "WhatsAppTemplateKey", "WhatsAppTemplateStatus", "WhatsAppMessageKind",
  "WhatsAppMessageTrigger", "WhatsAppMessageStatus", "WhatsAppInboundKind", "WhatsAppConsentStatus", "WhatsAppConsentSource",
] as const;
const M15_COLUMNS = [
  "Patient.waConsent", "Patient.waConsentAt", "Patient.waConsentSource", "Patient.waConsentByUserId", "Patient.waConsentVersion",
  "Patient.waPhoneE164", "Booking.patientConfirmedAt", "Booking.patientCancelRequestedAt", "Booking.patientReplyFor",
] as const;
const M15_PARTIAL = [
  "WhatsAppAccount_tenant_live_key", "WhatsAppAccount_phone_live_key", "WhatsAppAccount_waba_live_key",
  "WhatsAppMessage_due_idx", "Patient_tenantId_waPhoneE164_idx",
] as const;

const M16_TYPES = ["SaasCollectionMethod", "SaasAdjustmentKind"] as const;
// M19 (PV · tickets): RUNBOOK «M19 en prod».
const M19_TYPES = ["SupportTicketSource"] as const;
const M19_COLUMNS = ["SupportThread.source", "SupportThread.platformTakenAt", "SupportThread.platformTakenById"] as const;
const M16_COLUMNS = [
  ...[
    "collectionMethod", "billableFrom", "cancelAtPeriodEnd", "cancelEffectiveOn", "cancelRequestedAt", "cancelRequestedById",
    "pendingPlan", "pendingPlanEffectiveOn", "pendingPlanDisableIds", "pendingPlanRequestedById", "pendingPlanRequestedAt",
    "customPricePlan", "mpPendingPreapprovalId", "mpPendingInitPoint", "mpPendingPayerEmail", "mpPendingCreatedAt",
    "mpRetiredPreapprovalId", "mpPreapprovalNextAt", "mpPreapprovalSyncedAt",
  ].map((c) => `SaasSubscription.${c}`),
  ...["baseAmountCents", "adjustmentsCents", "mpCheckoutExpectedCents", "mpCheckoutCreatedAt"].map((c) => `SaasCharge.${c}`),
  ...["mpPreapprovalId", "splitFromId", "mpPayload"].map((c) => `SaasPayment.${c}`),
];
const M16_CHECKS_EXISTING = [
  "SaasSubscription_cancel_check", "SaasSubscription_pendingPlan_check", "SaasSubscription_mpPending_check",
  "SaasCharge_breakdown_check", "SaasCharge_checkout_check", "SaasPayment_mpPayload_check", "SaasPayment_source_mp_check",
] as const;
const M16_PARTIAL = ["SaasSubscription_pendingPlan_idx", "SaasSubscription_cancel_idx", "SaasAdjustment_pending_idx"] as const;

/** Tablas nuevas de la tanda: las que el rol de la app tiene que poder leer (DEFAULT PRIVILEGES) y anon nunca. */
const NEW_TABLES = [...M14_TABLES, ...M18_TABLES, "ReceptionDisplay", ...M15_TABLES, "SaasAdjustment"] as const;

/** Buckets privados que el código usa (EXTERNAL-CONFIG §0.11 y PL-2b). Límites solo donde el RUNBOOK los fija. */
const BUCKETS: readonly { id: string; limit?: number; mimes?: readonly string[] }[] = [
  { id: "patient-documents", limit: 10 * 1024 * 1024, mimes: ["application/pdf"] },
  { id: "practice-assets", limit: 1024 * 1024, mimes: ["image/jpeg", "image/png"] },
  { id: "patient-files", limit: 25 * 1024 * 1024 },
  { id: "billing-receipts" },
];

// ─── estado de migraciones ──────────────────────────────────────────────────

type MigRow = { migration_name: string; finished_at: Date | null; rolled_back_at: Date | null; checksum: string };

/** Carpetas de `prisma/migrations` con `migration.sql` (lo que `migrate deploy` conoce), en orden. */
export function repoMigrations(dir: string): string[] {
  if (!existsSync(dir)) throw new Error(`no existe ${dir}`);
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(dir, d.name, "migration.sql")))
    .map((d) => d.name)
    .sort();
}

export function fileSha256(dir: string, name: string): string {
  return createHash("sha256").update(readFileSync(path.join(dir, name, "migration.sql"))).digest("hex");
}

/** Mayor de `pg_dump --version` («pg_dump (PostgreSQL) 17.2 (Homebrew)» → 17). */
export function parsePgDumpMajor(v: string | null): number | null {
  const m = v ? /pg_dump \(PostgreSQL\) (\d+)/.exec(v) : null;
  return m ? Number(m[1]) : null;
}

type MigState = {
  repo: string[];
  db: MigRow[];
  applied: Set<string>;
  failed: MigRow[];
  rolledBack: MigRow[];
  pending: string[];
  unknownInDb: string[];
};

async function loadMigState(tx: Tx, dir: string): Promise<MigState> {
  const repo = repoMigrations(dir);
  const exists = (await scalar(tx, `SELECT count(*) AS n FROM pg_class WHERE oid = to_regclass('public._prisma_migrations')`)) > 0;
  const db = exists
    ? await rows<MigRow>(tx, `SELECT migration_name, finished_at, rolled_back_at, checksum FROM _prisma_migrations ORDER BY started_at`)
    : [];
  const applied = new Set(db.filter((r) => r.finished_at && !r.rolled_back_at).map((r) => r.migration_name));
  const failed = db.filter((r) => !r.finished_at && !r.rolled_back_at);
  const rolledBack = db.filter((r) => r.rolled_back_at && !applied.has(r.migration_name));
  const pending = repo.filter((n) => !applied.has(n));
  const repoSet = new Set(repo);
  const unknownInDb = [...applied].filter((n) => !repoSet.has(n)).sort();
  return { repo, db, applied, failed, rolledBack, pending, unknownInDb };
}

// ─── chequeos comunes ───────────────────────────────────────────────────────

async function commonChecks(c: Collector, tx: Tx, o: PrecheckOptions, phase: string): Promise<void> {
  await c.check(`${phase}.role.bypassrls`, "base", "Rol de la conexión y BYPASSRLS", async () => {
    const r = await rows<{ u: string; b: boolean; s: boolean }>(
      tx,
      `SELECT current_user AS u, r.rolbypassrls AS b, r.rolsuper AS s FROM pg_roles r WHERE r.rolname = current_user`
    );
    const x = r[0];
    if (!x) return fail("no se pudo leer el rol actual");
    // Sin BYPASSRLS las tablas con FORCE RLS se ven vacías: los conteos de abajo darían 0 «buenos» que no son ciertos.
    return x.b || x.s
      ? pass(`rol ${x.u}: ${x.s ? "superusuario" : "BYPASSRLS"} (conteos reales)`)
      : fail(`rol ${x.u} sin BYPASSRLS: usá la conexión owner (DIRECT_URL); con RLS los conteos dan 0 falsos`);
  });
  await c.check(`${phase}.server.version`, "base", "Versión del server (≥ 13)", async () => {
    const n = await scalar(tx, `SELECT current_setting('server_version_num')::int AS n`);
    const major = Math.floor(n / 10000);
    return n >= 130000 ? pass(`PostgreSQL ${major} (${n})`) : fail(`PostgreSQL ${major}: M14 exige ≥ 13`);
  });
  await c.check("dataapi.anon", "base", "Data API: anon/authenticated sin privilegios sobre public", async () => {
    const roles = (await rows<{ r: string }>(tx, `SELECT rolname AS r FROM pg_roles WHERE rolname IN ('anon','authenticated') ORDER BY 1`)).map(
      (x) => x.r
    );
    if (roles.length === 0) return skip("no existen los roles anon/authenticated (no es Supabase)");
    // AUDIT `data-api-anon-sin-rls`: con la Data API exponiendo `public`, la anon key leía y escribía las tablas
    // sin RLS. M2 revocó los grants; esto confirma que ninguno volvió (un GRANT a mano, un DEFAULT PRIVILEGES).
    const r = await rows<{ x: string }>(
      tx,
      `SELECT r.rolname || ':' || c.relname AS x FROM pg_roles r CROSS JOIN pg_class c
        WHERE r.rolname = ANY($1::text[]) AND c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p','v','m','f')
          AND has_table_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        ORDER BY 1`,
      roles
    );
    return r.length === 0
      ? pass(`${roles.join(" y ")} sin privilegios sobre ninguna tabla de public`)
      : fail(`${r.length} privilegios de la Data API sobre public (revocalos / sacá public de la Data API): ${list(r.map((x) => x.x), 10)}`);
  });
}

// ─── --pre ──────────────────────────────────────────────────────────────────

async function preChecks(c: Collector, tx: Tx, o: PrecheckOptions, ms: MigState): Promise<void> {
  await c.check("pre.migrations.failed", "base", "_prisma_migrations: ninguna fallida", async () => {
    if (ms.failed.length > 0) {
      return fail(`fallidas sin resolver (P3009, el deploy no avanza): ${list(ms.failed.map((r) => r.migration_name))}`);
    }
    // Una rolled back que después se re-aplicó es historia (RUNBOOK §2.4, P3009 por lock_timeout): solo se avisa.
    return ms.rolledBack.length > 0
      ? warn(`rolled back sin re-aplicar: ${list(ms.rolledBack.map((r) => r.migration_name))}`)
      : pass(`${ms.applied.size} aplicadas, ninguna fallida ni rolled back`);
  });

  const expected = new Set<string>(T6T7_MIGRATIONS.map((m) => m.name));
  await c.check("pre.migrations.pending", "base", "Pendientes = las de la tanda (M12 → M14 → M18 → M17 → M15 → M16 → M19)", async () => {
    const unexpected = ms.pending.filter((n) => !expected.has(n));
    if (unexpected.length > 0) {
      return fail(`pendientes que NO son de esta tanda (revisar antes de deployar): ${list(unexpected)}`);
    }
    if (ms.unknownInDb.length > 0) {
      return warn(`${ms.pending.length} pendientes; la base tiene aplicadas migraciones que el repo no conoce: ${list(ms.unknownInDb)}`);
    }
    const keys = T6T7_MIGRATIONS.filter((m) => ms.pending.includes(m.name)).map((m) => m.key);
    return pass(`${ms.pending.length} pendientes${keys.length ? `: ${keys.join(" → ")}` : " (la base ya está al día)"}`);
  });

  await c.check("pre.repo.checksums", "base", "Repo: migration.sql de la tanda = el sha256 verificado en local", async () => {
    const bad = T6T7_MIGRATIONS.filter((m) => fileSha256(o.migrationsDir, m.name) !== m.sha256).map((m) => m.key);
    return bad.length === 0 ? pass("los 7 sha256 coinciden con el RUNBOOK y el handoff de MIG") : fail(`migration.sql cambiado: ${bad.join(", ")}`);
  });

  for (const m of T6T7_MIGRATIONS) {
    const isPending = ms.pending.includes(m.name);
    const row = ms.db.find((r) => r.migration_name === m.name && r.finished_at && !r.rolled_back_at);
    c.add(
      `pre.state.${m.key}`,
      m.key,
      `${m.key} ${m.name}`,
      isPending
        ? pass("pendiente: la aplica este deploy")
        : warn(`ya aplicada (${row?.finished_at ? new Date(row.finished_at).toISOString().slice(0, 16) + "Z" : "?"}): no hay nada que aplicar; sus prechecks se saltean`)
    );
  }
  const run = (key: MigKey) => o.evaluateApplied === true || ms.pending.includes(T6T7_MIGRATIONS.find((m) => m.key === key)!.name);
  const gate = async (id: string, key: MigKey, title: string, fn: () => Promise<Verdict>) => {
    if (!run(key)) c.add(id, key, title, skip(`${key} ya aplicada`));
    else await c.check(id, key, title, fn);
  };

  // M12 (RUNBOOK «M12 en prod»)
  await gate("pre.M12.absent", "M12", "M12: columnas y enums nuevos no existen", () =>
    absent(tx, { columns: M12_COLUMNS, types: ["BookingCapMode", "BookingPaymentMethod"] })
  );
  await gate("pre.M12.practitionerCap", "M12", "M12: Practitioner.bookingCap* no existe", async () => {
    const n = await scalar(
      tx,
      `SELECT count(*) AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Practitioner' AND column_name LIKE 'bookingCap%'`
    );
    return n === 0 ? pass("0 columnas") : fail(`${n} columnas bookingCap* ya existen`);
  });
  await gate("pre.M12.adminBackfill", "M12", "M12 (d): ADMIN sin «Planes y pagos» (guardá esta lista: es el rollback del backfill)", async () => {
    const r = await rows<{ id: string; tenantId: string; titular: boolean }>(
      tx,
      `SELECT m.id, m."tenantId",
              EXISTS (SELECT 1 FROM "AuditEvent" a WHERE a."tenantId" = m."tenantId" AND a."entityId" = m.id
                        AND a.entity = 'Membership'
                        AND a.action IN ('membership.grants.change','platform.membership.grants.change')
                        AND a.payload->'from'->>'grantBilling' = 'true'
                        AND a.payload->'to'->>'grantBilling' = 'false') AS titular
         FROM "Membership" m WHERE m.role = 'ADMIN' AND NOT m."grantBilling" ORDER BY m."tenantId", m.id`
    );
    const backfill = r.filter((x) => !x.titular).map((x) => x.id);
    const kept = r.filter((x) => x.titular).map((x) => x.id);
    return pass(
      `${r.length} ADMIN sin grantBilling · se backfillean a true (${backfill.length}): ${list(backfill, 30)} · el Titular se lo sacó (${kept.length}): ${list(kept, 30)}`
    );
  });
  await gate("pre.M12.staffBilling", "M12", "M12 (e): Secretaría/Facturación con «Configuración» o «Planes y pagos»", async () => {
    const r = await rows<{ role: string; s: unknown; b: unknown }>(
      tx,
      `SELECT m.role::text AS role, count(*) FILTER (WHERE m."grantSettings") AS s, count(*) FILTER (WHERE m."grantBilling") AS b
         FROM "Membership" m WHERE m.role IN ('ASSISTANT','BILLING') GROUP BY m.role ORDER BY 1`
    );
    const withBilling = r.reduce((a, x) => a + num(x.b), 0);
    const txt = r.map((x) => `${x.role}: ${num(x.s)} con Configuración, ${num(x.b)} con Planes y pagos`).join(" · ") || "sin Secretaría ni Facturación";
    // C-AS1: el código de T3 les saca lo delicado (no la migración). Con filas, avisarle al Titular.
    return withBilling > 0 ? warn(`${txt}: avisale al Titular (C-AS1 se los saca)`) : pass(txt);
  });
  await gate("pre.M12.paidBookings", "M12", "M12 (f): turnos PAID/REFUNDED (quedan «Sin informar» el medio)", async () =>
    pass(`${await scalar(tx, `SELECT count(*) AS n FROM "Booking" WHERE "paymentStatus" IN ('PAID','REFUNDED')`)} turnos (informativo)`)
  );

  // M14 (RUNBOOK «M14 en prod»)
  await gate("pre.M14.absent", "M14", "M14: tablas, columnas y enums nuevos no existen", () =>
    absent(tx, { tables: M14_TABLES, types: M14_TYPES, columns: M14_COLUMNS, procs: ["patient_document_guard"] })
  );
  await gate("pre.M14.clinicalNoteGuard", "M14", "M14: clinical_note_guard() es la de M9 (la que M14 reemplaza línea por línea)", async () => {
    const got = await md5Of(tx, "clinical_note_guard");
    if (got.length !== 1) return fail(`clinical_note_guard(): ${got.length} definiciones (se esperaba 1, la de M9)`);
    return got[0] === M9_CLINICAL_NOTE_GUARD_MD5
      ? pass(`md5 = ${got[0]} (M9)`)
      : fail(`md5 = ${got[0]} ≠ M9 ${M9_CLINICAL_NOTE_GUARD_MD5}: FRENAR, alguien tocó la función a mano (comparar antes de seguir)`);
  });
  await gate("pre.M14.counts", "M14", "M14: conteos (informativo; el --post tiene que dar lo mismo)", async () => {
    const notes = await scalar(tx, `SELECT count(*) AS n FROM "ClinicalNote"`);
    const tenants = await scalar(tx, `SELECT count(*) AS n FROM "Tenant"`);
    return pass(`ClinicalNote = ${notes} · Tenant = ${tenants}`);
  });

  // M18 (RUNBOOK «M18 en prod»)
  await gate("pre.M18.absent", "M18", "M18: tablas, enums, columna y funciones nuevas no existen", () =>
    absent(tx, {
      tables: M18_TABLES,
      types: M18_TYPES,
      columns: ["Booking.onlineDepositCents"],
      procs: ["online_charge_guard", "online_charge_sync_booking"],
    })
  );
  await gate("pre.M18.counts", "M18", "M18: turnos, checkout legado y holds en vuelo (informativo)", async () => {
    const bookings = await scalar(tx, `SELECT count(*) AS n FROM "Booking"`);
    const pay = await rows<{ status: string; n: unknown }>(tx, `SELECT status::text AS status, count(*) AS n FROM "Payment" GROUP BY 1 ORDER BY 1`);
    const holds = await scalar(tx, `SELECT count(*) AS n FROM "Booking" WHERE status = 'PENDING' AND "idempotencyKey" LIKE 'pub:%'`);
    return pass(
      `Booking = ${bookings} · Payment: ${pay.map((p) => `${p.status} ${num(p.n)}`).join(", ") || "0"} · holds del turnero en vuelo = ${holds}`
    );
  });
  await gate("pre.M18.relfilenode", "M18", "M18: relfilenode de Booking (ANOTALO: el --post tiene que dar el mismo)", async () => {
    const n = await scalar(tx, `SELECT relfilenode AS n FROM pg_class WHERE oid = to_regclass('public."Booking"')`);
    return pass(`relfilenode = ${n} → después: --post --booking-relfilenode=${n}`);
  });

  // M17 / M15 / M16 (Anexos A-C + handoff de MIG)
  await gate("pre.M17.absent", "M17", "M17: ReceptionDisplay y sus enums no existen", () =>
    absent(tx, { tables: ["ReceptionDisplay"], types: M17_TYPES })
  );
  await gate("pre.M15.absent", "M15", "M15: tablas, enums y columnas de WhatsApp no existen", () =>
    absent(tx, { tables: M15_TABLES, types: M15_TYPES, columns: M15_COLUMNS })
  );
  await gate("pre.M16.absent", "M16", "M16: SaasAdjustment, enums, columnas y guard no existen", () =>
    absent(tx, { tables: ["SaasAdjustment"], types: M16_TYPES, columns: M16_COLUMNS, procs: ["saas_adjustment_guard"] })
  );
  await gate("pre.M19.absent", "M19", "M19: SupportTicketNote, SupportTicketSource y las columnas de ticket no existen", () =>
    absent(tx, { tables: ["SupportTicketNote"], types: M19_TYPES, columns: M19_COLUMNS })
  );
  await gate("pre.M16.chargeUnique", "M16", "M16: SaasCharge(id, tenantId) único (destino de la FK compuesta)", async () => {
    const n = await scalar(tx, `SELECT count(*) AS n FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'SaasCharge_id_tenantId_key'`);
    return n === 1 ? pass("SaasCharge_id_tenantId_key presente (M8)") : fail("falta SaasCharge_id_tenantId_key: la FK de SaasAdjustment no se puede crear");
  });
  await gate("pre.M16.checkoutPreference", "M16", "M16: SaasCharge.mpCheckoutPreferenceId no null = 0", async () => {
    const n = await scalar(tx, `SELECT count(*) AS n FROM "SaasCharge" WHERE "mpCheckoutPreferenceId" IS NOT NULL`);
    // SaasCharge_checkout_check exige preferencia ⇔ monto esperado ⇔ fecha: una fila vieja con preferencia y sin los
    // otros dos hace fallar el ADD CONSTRAINT y la migración entera.
    return n === 0 ? pass("0 cargos con preferencia de checkout") : fail(`${n} cargos con mpCheckoutPreferenceId: el CHECK nuevo de M16 falla`);
  });
  await gate("pre.M16.mpPayments", "M16", "M16: SaasPayment con source ≠ MANUAL (se espera 0)", async () => {
    const n = await scalar(tx, `SELECT count(*) AS n FROM "SaasPayment" WHERE source <> 'MANUAL'`);
    return n === 0 ? pass("0 pagos de Mercado Pago") : warn(`${n} pagos no MANUAL: revisar contra SaasPayment_source_mp_check antes de seguir`);
  });
  await gate("pre.M16.anchorDay", "M16", "M16: distribución de anchorDay (lo re-ancla saas-reanchor después del deploy)", async () => {
    const r = await rows<{ d: number; n: unknown }>(tx, `SELECT "anchorDay" AS d, count(*) AS n FROM "SaasSubscription" GROUP BY 1 ORDER BY 1`);
    return pass(r.length ? r.map((x) => `día ${x.d}: ${num(x.n)}`).join(" · ") : "sin suscripciones");
  });
  await gate("pre.M16.customPrice", "M16", "M16: suscripciones con customPriceCents", async () => {
    const n = await scalar(tx, `SELECT count(*) AS n FROM "SaasSubscription" WHERE "customPriceCents" IS NOT NULL`);
    // MPS-D14: un precio a medida legado nace con customPricePlan NULL = vale para cualquier plan. Se avisa para que
    // Martin decida si lo ata a un plan después del deploy.
    return n === 0 ? pass("0 con precio a medida") : warn(`${n} con precio a medida: quedan con customPricePlan NULL (vale para cualquier plan, MPS-D14)`);
  });

  // Sesiones y locks: el deploy toma ACCESS EXCLUSIVE en Booking/Patient/Tenant (M14, M15, M18) con lock_timeout 5 s.
  await c.check("pre.activity.longTx", "base", "Transacciones de más de 30 s (pg_stat_activity)", async () => {
    const r = await rows<{ pid: number; u: string | null; app: string | null; state: string | null; age: unknown }>(
      tx,
      `SELECT pid, usename AS u, application_name AS app, state, extract(epoch FROM now() - xact_start)::int AS age
         FROM pg_stat_activity WHERE xact_start IS NOT NULL AND now() - xact_start > interval '30 seconds' AND pid <> pg_backend_pid()
        ORDER BY xact_start`
    );
    return r.length === 0
      ? pass("ninguna")
      : warn(`${r.length}: ${list(r.map((x) => `pid ${x.pid} ${x.u ?? "?"}/${x.app || "-"} ${x.state ?? "?"} ${num(x.age)} s`), 6)} (esperá a que terminen)`);
  });
  await c.check("pre.activity.locks", "base", "Locks sobre Booking, Patient y Tenant", async () => {
    const r = await rows<{ pid: number; rel: string; mode: string; granted: boolean; age: unknown }>(
      tx,
      `SELECT l.pid, c.relname AS rel, l.mode, l.granted, coalesce(extract(epoch FROM now() - a.xact_start)::int, 0) AS age
         FROM pg_locks l JOIN pg_class c ON c.oid = l.relation LEFT JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('Booking','Patient','Tenant') AND l.pid <> pg_backend_pid()
          AND (NOT l.granted OR l.mode IN ('ShareLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock')
               OR now() - a.xact_start > interval '30 seconds')
        ORDER BY 1`
    );
    return r.length === 0
      ? pass("sin locks fuertes, en espera ni de tx largas")
      : fail(`${r.length}: ${list(r.map((x) => `pid ${x.pid} ${x.rel} ${x.mode}${x.granted ? "" : " (esperando)"} ${num(x.age)} s`), 6)}: el deploy caería por lock_timeout`);
  });

  await c.check("pre.pgdump.version", "base", "pg_dump local ≥ versión del server (db:prod:backup)", async () => {
    const major = parsePgDumpMajor(o.pgDumpVersion);
    const n = await scalar(tx, `SELECT current_setting('server_version_num')::int AS n`);
    const serverMajor = Math.floor(n / 10000);
    if (major === null) return fail("no se encontró pg_dump en el PATH: db:prod:backup no va a andar");
    return major >= serverMajor
      ? pass(`pg_dump ${major} ≥ server ${serverMajor}`)
      : fail(
          `pg_dump ${major} < server ${serverMajor}: el backup aborta («server version mismatch»). ` +
            `Poné primero en el PATH el de la versión del server (p. ej. export PATH="/opt/homebrew/opt/postgresql@${Math.max(serverMajor, 17)}/bin:$PATH")`
        );
  });

  await c.check("storage.buckets", "base", "Storage: buckets privados que usa el código", async () => {
    const has = (await scalar(tx, `SELECT count(*) AS n FROM pg_class WHERE oid = to_regclass('storage.buckets')`)) > 0;
    if (!has) return skip("sin schema storage (no es Supabase)");
    const r = await rows<{ id: string; public: boolean; lim: unknown; mimes: string[] | null }>(
      tx,
      `SELECT id, public, file_size_limit AS lim, allowed_mime_types AS mimes FROM storage.buckets WHERE id = ANY($1::text[])`,
      BUCKETS.map((b) => b.id)
    );
    const failures: string[] = [];
    const warnings: string[] = [];
    for (const b of BUCKETS) {
      const x = r.find((y) => y.id === b.id);
      if (!x) {
        failures.push(`${b.id} no existe`);
        continue;
      }
      if (x.public) failures.push(`${b.id} es PÚBLICO`);
      if (b.limit !== undefined && num(x.lim) !== b.limit) warnings.push(`${b.id} límite ${x.lim ?? "sin límite"} (≠ ${b.limit})`);
      if (b.mimes && [...(x.mimes ?? [])].sort().join(",") !== [...b.mimes].sort().join(",")) {
        warnings.push(`${b.id} tipos [${(x.mimes ?? []).join(", ")}] (≠ ${b.mimes.join(", ")})`);
      }
    }
    if (failures.length) return fail(list([...failures, ...warnings]));
    if (warnings.length) return warn(list(warnings));
    return pass(`${BUCKETS.map((b) => b.id).join(", ")}: privados y con sus límites`);
  });
}

// ─── --post ─────────────────────────────────────────────────────────────────

async function postChecks(c: Collector, tx: Tx, o: PrecheckOptions, ms: MigState): Promise<void> {
  await c.check("post.migrate.status", "base", "migrate status al día", async () => {
    if (ms.failed.length) return fail(`fallidas: ${list(ms.failed.map((r) => r.migration_name))}`);
    if (ms.pending.length) return fail(`pendientes: ${list(ms.pending)}`);
    return ms.unknownInDb.length
      ? warn(`${ms.applied.size} aplicadas; la base tiene migraciones que el repo no conoce: ${list(ms.unknownInDb)}`)
      : pass(`${ms.applied.size} aplicadas = ${ms.repo.length} del repo («Database schema is up to date!»)`);
  });
  await c.check("post.migrate.checksums", "base", "Checksum de las 6 en _prisma_migrations = sha256 del repo", async () => {
    const bad: string[] = [];
    for (const m of T6T7_MIGRATIONS) {
      const r = ms.db.find((x) => x.migration_name === m.name && x.finished_at && !x.rolled_back_at);
      if (!r) bad.push(`${m.key} sin aplicar`);
      else if (r.checksum !== m.sha256 || fileSha256(o.migrationsDir, m.name) !== m.sha256) bad.push(`${m.key} checksum distinto`);
    }
    return bad.length === 0 ? pass("M12, M14, M18, M17, M15, M16 y M19 con el checksum verificado") : fail(list(bad));
  });

  await c.check("post.grants.app", "base", "Rol de la app: SELECT sobre las 15 tablas nuevas (DEFAULT PRIVILEGES)", async () => {
    const roles: string[] = [];
    for (const r of ["kinesoft_app", "kinesoft_service"]) if (await roleExists(tx, r)) roles.push(r);
    if (roles.length === 0) return skip("sin roles kinesoft_app/kinesoft_service (la app conecta como owner)");
    const r = await rows<{ x: string }>(
      tx,
      `SELECT r.rolname || ':' || t AS x FROM unnest($1::text[]) AS t CROSS JOIN pg_roles r
        WHERE r.rolname = ANY($2::text[]) AND to_regclass('public.' || quote_ident(t)) IS NOT NULL
          AND NOT has_table_privilege(r.oid, to_regclass('public.' || quote_ident(t)), 'SELECT')`,
      [...NEW_TABLES],
      roles
    );
    return r.length === 0 ? pass(`${roles.join(" y ")} leen las ${NEW_TABLES.length} tablas`) : fail(`sin SELECT: ${list(r.map((x) => x.x))}`);
  });

  // md5 de las funciones de inalterabilidad (el valor de prod tiene que ser el del repo).
  for (const p of ["clinical_note_guard", "online_charge_guard", "online_charge_sync_booking", "saas_adjustment_guard"] as const) {
    const group: MigKey = p === "clinical_note_guard" ? "M14" : p === "saas_adjustment_guard" ? "M16" : "M18";
    await c.check(`post.md5.${p}`, group, `md5 de ${p}()`, () => md5Check(tx, p));
  }

  // M12
  await c.check("post.M12.objects", "M12", "M12: columnas, enums y 5 CHECK", () =>
    allOf(
      () => present(tx, { columns: M12_COLUMNS, types: ["BookingCapMode", "BookingPaymentMethod"] }),
      () => constraintsByName(tx, M12_CHECKS, "c"),
      async () => {
        const cap = await enumLabels(tx, "BookingCapMode");
        return cap.join(",") === "INHERIT,NONE,CUSTOM"
          ? pass("BookingCapMode {INHERIT,NONE,CUSTOM}")
          : fail(`BookingCapMode = {${cap.join(",")}} (≠ {INHERIT,NONE,CUSTOM})`);
      },
      async () => {
        const fk = await scalar(
          tx,
          `SELECT count(*) AS n FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
            WHERE c.conrelid = to_regclass('public."Booking"') AND c.contype = 'f' AND a.attname = 'copagoCollectedById'`
        );
        return fk === 0 ? pass("copagoCollectedById sin FK") : fail("copagoCollectedById tiene una FK (no debería)");
      }
    )
  );

  // M14
  await c.check("post.M14.objects", "M14", "M14: tablas, enums, 11 columnas, función nueva", () =>
    present(tx, { tables: M14_TABLES, types: M14_TYPES, columns: M14_COLUMNS, procs: ["patient_document_guard"] })
  );
  await c.check("post.M14.patientDocumentGuard", "M14", "md5 de patient_document_guard() + INVOKER/search_path", () =>
    allOf(
      () => md5Check(tx, "patient_document_guard"),
      () => invokerWithSearchPath(tx, ["clinical_note_guard", "patient_document_guard"])
    )
  );
  await c.check("post.M14.triggers", "M14", "M14: triggers de PatientDocument", () =>
    triggers(tx, "PatientDocument", ["PatientDocument_guard", "PatientDocument_no_truncate"])
  );
  await c.check("post.M14.rls", "M14", "M14: RLS ENABLE + FORCE y policies", () =>
    rlsAndPolicies(tx, {
      DiagnosisCode: ["DiagnosisCode_read:SELECT"],
      TenantDiagnosis: ["TenantDiagnosis_tenant_isolation:ALL"],
      DiagnosisFavorite: ["DiagnosisFavorite_tenant_isolation:ALL"],
      PatientDocument: ["PatientDocument_tenant_isolation:ALL"],
    })
  );
  await c.check("post.M14.indexes", "M14", "M14: índices parciales + único de DiagnosisCode", async () => {
    const p = await partialIndexes(tx, ["PatientDocument_noteId_live_key", "TenantDiagnosis_tenantId_title_active_key"]);
    if (p.status !== "PASS") return p;
    const u = await scalar(tx, `SELECT count(*) AS n FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'DiagnosisCode_system_code_key'`);
    return u === 1 ? pass("2 parciales + DiagnosisCode_system_code_key") : fail("falta DiagnosisCode_system_code_key");
  });
  await c.check("post.M14.checks", "M14", "M14: 26 CHECK", () => constraintsByName(tx, M14_CHECKS, "c"));

  // M18
  await c.check("post.M18.objects", "M18", "M18: tablas, enums, columna y funciones", () =>
    present(tx, {
      tables: M18_TABLES,
      types: M18_TYPES,
      columns: ["Booking.onlineDepositCents"],
      procs: ["online_charge_guard", "online_charge_sync_booking"],
    })
  );
  await c.check("post.M18.functions", "M18", "M18: funciones INVOKER con search_path fijo", () =>
    invokerWithSearchPath(tx, ["online_charge_guard", "online_charge_sync_booking"])
  );
  await c.check("post.M18.triggers", "M18", "M18: triggers de OnlineCharge", () =>
    triggers(tx, "OnlineCharge", ["OnlineCharge_guard", "OnlineCharge_no_truncate", "OnlineCharge_sync_booking"])
  );
  await c.check("post.M18.rls", "M18", "M18: RLS ENABLE + FORCE y policies (ninguna en MpCredential)", () =>
    rlsAndPolicies(tx, {
      BookingPaymentPolicy: ["BookingPaymentPolicy_tenant_isolation:ALL"],
      MpAccount: ["MpAccount_tenant_read:SELECT"],
      MpCredential: [],
      OnlineCharge: ["OnlineCharge_tenant_isolation:ALL"],
    })
  );
  await c.check("post.M18.indexes", "M18", "M18: 6 índices parciales", () => partialIndexes(tx, M18_PARTIAL));
  await c.check("post.M18.fks", "M18", "M18: 6 FKs compuestas", () => constraintsByName(tx, M18_FKS, "f"));
  await c.check("post.M18.checks", "M18", "M18: 24 CHECK en las tablas nuevas + Booking_onlineDepositCents_check", () =>
    allOf(
      () => checkCount(tx, M18_TABLES, 24),
      () => constraintsByName(tx, ["Booking_onlineDepositCents_check"], "c")
    )
  );
  await c.check("post.M18.depositColumn", "M18", "M18: Booking.onlineDepositCents DEFAULT 0 NOT NULL, sin reescribir la tabla", async () => {
    const r = await rows<{ d: string | null; nullable: string; missing: boolean | null; rfn: unknown }>(
      tx,
      `SELECT col.column_default AS d, col.is_nullable AS nullable,
              (SELECT a.atthasmissing FROM pg_attribute a WHERE a.attrelid = to_regclass('public."Booking"') AND a.attname = 'onlineDepositCents') AS missing,
              (SELECT relfilenode FROM pg_class WHERE oid = to_regclass('public."Booking"')) AS rfn
         FROM information_schema.columns col
        WHERE col.table_schema = 'public' AND col.table_name = 'Booking' AND col.column_name = 'onlineDepositCents'`
    );
    const x = r[0];
    if (!x) return fail("no existe Booking.onlineDepositCents");
    if (x.d !== "0" || x.nullable !== "NO") return fail(`default ${x.d ?? "null"}, nullable ${x.nullable} (≠ 0, NO)`);
    const rfn = num(x.rfn);
    if (o.bookingRelfilenode != null && o.bookingRelfilenode !== rfn) {
      return fail(`relfilenode de Booking ${rfn} ≠ ${o.bookingRelfilenode} del --pre: la tabla se reescribió`);
    }
    // `atthasmissing` solo vale en la base donde se agregó la columna con filas: en una base vacía (o tras un
    // VACUUM FULL) puede dar f sin que haya pasado nada malo. Por eso es dato, no veredicto.
    return pass(
      `default 0, NOT NULL; atthasmissing ${x.missing ? "t" : "f"}; relfilenode ${rfn}${o.bookingRelfilenode != null ? " = el del --pre" : " (pasá --booking-relfilenode=<el del --pre> para compararlo)"}`
    );
  });

  // M17
  await c.check("post.M17.objects", "M17", "M17: ReceptionDisplay y 5 enums", () => present(tx, { tables: ["ReceptionDisplay"], types: M17_TYPES }));
  await c.check("post.M17.rls", "M17", "M17: RLS ENABLE + FORCE y policy por tenant", () =>
    rlsAndPolicies(tx, { ReceptionDisplay: ["ReceptionDisplay_tenant_isolation:ALL"] })
  );
  await c.check("post.M17.indexes", "M17", "M17: 2 índices parciales", () => partialIndexes(tx, M17_PARTIAL));
  await c.check("post.M17.constraints", "M17", "M17: 5 CHECK + FK compuesta a la sede", () =>
    allOf(
      () => checkCount(tx, ["ReceptionDisplay"], 5),
      () => constraintsByName(tx, ["ReceptionDisplay_location_tenant_fkey"], "f")
    )
  );

  // M15
  await c.check("post.M15.objects", "M15", "M15: 5 tablas, 10 enums, 9 columnas", () =>
    present(tx, { tables: M15_TABLES, types: M15_TYPES, columns: M15_COLUMNS })
  );
  await c.check("post.M15.notificationKind", "M15", "M15: NotificationKind += BOOKING_PATIENT_REPLY, WHATSAPP_ACCOUNT", async () => {
    const l = await enumLabels(tx, "NotificationKind");
    const miss = ["BOOKING_PATIENT_REPLY", "WHATSAPP_ACCOUNT"].filter((x) => !l.includes(x));
    return miss.length === 0 ? pass("2 valores nuevos") : fail(`faltan: ${miss.join(", ")}`);
  });
  await c.check("post.M15.rls", "M15", "M15: RLS ENABLE + FORCE; 4 de solo lectura por tenant, ninguna en WhatsAppCredential", () =>
    rlsAndPolicies(tx, {
      WhatsAppAccount: ["WhatsAppAccount_tenant_read:SELECT"],
      WhatsAppCredential: [],
      WhatsAppTemplate: ["WhatsAppTemplate_tenant_read:SELECT"],
      WhatsAppMessage: ["WhatsAppMessage_tenant_read:SELECT"],
      WhatsAppInbound: ["WhatsAppInbound_tenant_read:SELECT"],
    })
  );
  await c.check("post.M15.indexes", "M15", "M15: 5 índices parciales", () => partialIndexes(tx, M15_PARTIAL));
  await c.check("post.M15.checks", "M15", "M15: 11 CHECK en las tablas nuevas + Patient/Booking", () =>
    allOf(
      () => checkCount(tx, M15_TABLES, 11),
      () => constraintsByName(tx, ["Patient_wa_consent_check", "Booking_patient_reply_check"], "c")
    )
  );

  // M16
  await c.check("post.M16.objects", "M16", "M16: SaasAdjustment, 2 enums, 26 columnas, guard", () =>
    present(tx, { tables: ["SaasAdjustment"], types: M16_TYPES, columns: M16_COLUMNS, procs: ["saas_adjustment_guard"] })
  );
  await c.check("post.M16.rls", "M16", "M16: RLS ENABLE + FORCE y policy de solo lectura", () =>
    rlsAndPolicies(tx, { SaasAdjustment: ["SaasAdjustment_tenant_read:SELECT"] })
  );
  await c.check("post.M16.triggers", "M16", "M16: triggers de SaasAdjustment", () =>
    triggers(tx, "SaasAdjustment", ["SaasAdjustment_guard", "SaasAdjustment_no_truncate"])
  );
  await c.check("post.M16.indexes", "M16", "M16: 3 índices parciales", () => partialIndexes(tx, M16_PARTIAL));
  await c.check("post.M16.checks", "M16", "M16: 4 CHECK en SaasAdjustment + 7 en tablas existentes + 3 FKs compuestas", () =>
    allOf(
      () => checkCount(tx, ["SaasAdjustment"], 4),
      () => constraintsByName(tx, M16_CHECKS_EXISTING, "c"),
      () =>
        constraintsByName(
          tx,
          ["SaasAdjustment_charge_tenant_fkey", "SaasAdjustment_splitFrom_tenant_fkey", "SaasPayment_splitFrom_tenant_fkey"],
          "f"
        )
    )
  );
  await c.check("post.M16.defaults", "M16", "M16: anchorDay DEFAULT 4 y autoDebitAllowed DEFAULT true", async () => {
    const r = await rows<{ c: string; d: string | null }>(
      tx,
      `SELECT column_name AS c, column_default AS d FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'SaasSubscription' AND column_name IN ('anchorDay','autoDebitAllowed')`
    );
    const a = r.find((x) => x.c === "anchorDay")?.d;
    const b = r.find((x) => x.c === "autoDebitAllowed")?.d;
    return a === "4" && b === "true" ? pass("anchorDay 4, autoDebitAllowed true") : fail(`anchorDay ${a ?? "null"}, autoDebitAllowed ${b ?? "null"}`);
  });

  // M19 (PV · tickets): las notas internas son SERVICE_ONLY (ENABLE + FORCE, cero policies): el consultorio no las ve.
  await c.check("post.M19.objects", "M19", "M19: SupportTicketNote, SupportTicketSource y 3 columnas en SupportThread", () =>
    present(tx, { tables: ["SupportTicketNote"], types: M19_TYPES, columns: M19_COLUMNS })
  );
  await c.check("post.M19.rls", "M19", "M19: SupportTicketNote con RLS ENABLE + FORCE y ninguna policy", () =>
    rlsAndPolicies(tx, { SupportTicketNote: [] })
  );
  await c.check("post.M19.checks", "M19", "M19: CHECKs de origen y de «tomado» + cuerpo de la nota", () =>
    constraintsByName(tx, ["SupportThread_source_check", "SupportThread_taken_check", "SupportTicketNote_body_check"], "c")
  );
  await c.check("post.M19.backfill", "M19", "M19: ningún hilo sin origen", async () => {
    const n = await scalar(tx, `SELECT count(*) AS n FROM "SupportThread" WHERE "source" IS NULL`);
    return n === 0 ? pass("0 hilos con source NULL") : warn(`${n} hilos con source NULL (los escribió el código viejo entre M19 y el deploy; se leen con COALESCE)`);
  });

}

// ─── entrada ────────────────────────────────────────────────────────────────

export async function runProdPrecheck(o: PrecheckOptions): Promise<PrecheckResult> {
  const out = await withReadOnlyTx(o.db, async (tx) => {
    const c = new Collector(tx);
    const ms = await loadMigState(tx, o.migrationsDir);
    await commonChecks(c, tx, o, o.mode);
    if (o.mode === "pre") await preChecks(c, tx, o, ms);
    else await postChecks(c, tx, o, ms);
    return c.rows;
  });
  return { mode: o.mode, rows: out, failed: out.some((r) => r.status === "FAIL") };
}

/** Tabla de texto para pegar en el chat (sin colores: se copia tal cual). */
export function formatPrecheckTable(r: PrecheckResult): string {
  const lines: string[] = [];
  // Agrupado por bloque (Base y después M12 → M19 en orden de aplicación), estable dentro de cada uno: los chequeos
  // se ejecutan en el orden que conviene a la tx, pero se leen por migración.
  const rank = (g: string) => (g === "base" ? 0 : 1 + T6T7_MIGRATIONS.findIndex((m) => m.key === g));
  const sorted = r.rows.map((row, i) => ({ row, i })).sort((a, b) => rank(a.row.group) - rank(b.row.group) || a.i - b.i);
  const counts = { PASS: 0, WARN: 0, FAIL: 0, SKIP: 0 } as Record<CheckStatus, number>;
  let group = "";
  for (const { row } of sorted) {
    counts[row.status] += 1;
    if (row.group !== group) {
      group = row.group;
      lines.push("", `── ${group === "base" ? "Base" : group} ──`);
    }
    lines.push(`[${row.status}] ${row.title}`, `       ${row.detail}`);
  }
  lines.push(
    "",
    `Resultado --${r.mode}: ${counts.PASS} PASS · ${counts.WARN} WARN · ${counts.FAIL} FAIL · ${counts.SKIP} SKIP → ${
      r.failed ? "HAY FAIL: no sigas con el paso siguiente" : counts.WARN ? "sin FAIL (revisá los WARN)" : "todo en verde"
    }`
  );
  return lines.join("\n");
}
