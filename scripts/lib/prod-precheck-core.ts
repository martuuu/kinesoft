/**
 * INF-S · núcleo de `scripts/prod-precheck.ts` (plan §26.7, decisión 1 de Martin del 22-oct): prechecks y postchecks
 * de SOLO LECTURA del día del push. Nació para las 7 de T3..PV (M12 → M14 → M18 → M17 → M15 → M16 → M19); desde el
 * reset de prod (29/30-oct) esas 7 ya están aplicadas allá, M20 (CF) y M21 (CF2) se aplicaron el 02-nov con el push de
 * `c288e5d`, y las pendientes son **M22** (CF3, `cf3_precios_sede`, 04-nov), **M23** (CF3b, `cf3_co_titular`, 05-nov) y
 * **M24** (CF3b, `cf3_practitioner_photo`, 05-nov), que van en el MISMO `db:prod:deploy`: el `--pre` exige que M12..M21
 * estén PRESENTES (aplicadas con su checksum y con sus objetos) y corre los prechecks de M22, M23 y M24; el `--post`
 * verifica las 12 objeto por objeto.
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
 * Las 7 de T3..PV, en el orden en que `migrate deploy` las aplicó (timestamp). `sha256` = el checksum que Prisma
 * guarda en `_prisma_migrations` (sha256 del `migration.sql`): RUNBOOK para M12/M14/M18, handoff de MIG para el resto.
 * CF (30-oct): YA APLICADAS en prod (reset del 29/30-oct, las 47 del repo). Siguen acá porque su checksum y sus objetos
 * son contrato: el `--pre` las exige presentes y el `--post` las re-verifica.
 * CF3 (04-nov): M20 y M21 también (push de CF2 del 02-nov, `c288e5d`); sus prechecks de «no existe» y de Booking se
 * borraron (ya no hay nada que aplicar: con M20/M21 exigidas, un «pendiente» es FAIL de `pre.state.*`).
 */
export const APPLIED_MIGRATIONS = [
  { key: "M12", name: "20261020120000_agenda_secretaria_config", sha256: "a0849c4d28c7154acb3b9a0cf47075bbbde608161d32d126d7ae9d85f9fd7485" },
  { key: "M14", name: "20261021120000_fichas_clinicas", sha256: "f7b12bab45002308751095ee12deb717c4f375ad39e9a3e8470f16afbe4967c9" },
  { key: "M18", name: "20261022120000_turnero_cobros_mp", sha256: "0ffc0c9157d5d9df71770f6d62019a6c916f673db7529eceaa00768d5c88006e" },
  { key: "M17", name: "20261023120000_reception_displays", sha256: "af7426dc3334f6aaa2fb1a9529d4acefc2e27b57f586212f2fffadd52748f430" },
  { key: "M15", name: "20261024120000_whatsapp_messaging", sha256: "e8637727af84b64b38c303be5dc0d762006baa402fdcd989bace81674471cf0d" },
  { key: "M16", name: "20261025120000_saas_mp_subscriptions", sha256: "b235454f0ceceef95394d752f1fe879ec2ec0baf6b7f052ae3e253e47f207798" },
  // PV (27-oct): tickets de Plataforma. Sumada a la misma tanda porque va en el mismo push (decisión de Martin).
  { key: "M19", name: "20261027120000_support_tickets", sha256: "7ac440677f5f80098b6245f1de70b556cc7ea9d4aeeb923b2c6eb9825803f7a2" },
  { key: "M20", name: "20261030120000_cf_agenda_rules", sha256: "e5d84eec9eba6f11ed6181fc0e18e34b5d220a637808906d445381207ea5b032" },
  { key: "M21", name: "20261102120000_cf2_profesional_caja", sha256: "48aee329bf97404613044f0ce239e1186ca88f21eae16943448091c8130e588b" },
] as const;
/**
 * Las pendientes en prod de esta salida (CF3): M22 (04-nov), M23 (CF3b, 05-nov, co-titular y matrícula) y M24 (CF3b,
 * 05-nov, foto de la persona), en ese orden y en un solo `db:prod:deploy`. sha256 verificado en local (MIG, MIG2 y MIG3
 * de CF3, `migrate deploy` sobre el Docker; = `_prisma_migrations.checksum`).
 */
export const PENDING_MIGRATIONS = [
  { key: "M22", name: "20261104120000_cf3_precios_sede", sha256: "82ac0f6fdc7d8998264720f1b0347b4a69c77a5dcb4c995032f2bd557fb2c238" },
  { key: "M23", name: "20261105120000_cf3_co_titular", sha256: "35ddd0dc4e658a72bdf1a4f617f93f367e492edde6ce6067e9e765eb2c41efa6" },
  { key: "M24", name: "20261105130000_cf3_practitioner_photo", sha256: "cbb3d8383ff96e0d1afdf8c957aa3bded28fc8ba2cfb0d11f73b7fbb6ffd0e30" },
] as const;
/** Todas las que el precheck conoce, en orden de aplicación (checksums del --pre/--post y orden de la tabla impresa). */
export const TRACKED_MIGRATIONS = [...APPLIED_MIGRATIONS, ...PENDING_MIGRATIONS] as const;
type MigKey = (typeof TRACKED_MIGRATIONS)[number]["key"];
type AppliedKey = (typeof APPLIED_MIGRATIONS)[number]["key"];
type PendingKey = (typeof PENDING_MIGRATIONS)[number]["key"];

/** md5(prosrc) esperados después del deploy. `clinical_note_guard` = el de M14 (RUNBOOK «M14 en prod»). */
export const EXPECTED_MD5 = {
  clinical_note_guard: "d0164760670b55036a575042e945adcf",
  patient_document_guard: "677758023a72e44e21c8af18aa2c952b",
  online_charge_guard: "202110977dac927eb5957aa67f3de345",
  online_charge_sync_booking: "f98cc831211d6d5aa559900d3b82bccc",
  saas_adjustment_guard: "fd8790f4959e9f56ea743dead6bb6d2b",
  // CF2 M21: trigger de solo cierre del reparto (md5 del Docker local tras `migrate deploy`).
  practitioner_revenue_share_guard: "dceb9da5179967d39f6b6b0132e96f7a",
  // CF3b M23: la base estampa UserProfile.licenseUpdatedAt (md5 del Docker local tras `migrate deploy`).
  user_profile_license_stamp: "112d2ddbe23470c7762896c6987f721f",
} as const;

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
   * Solo tests: corre los prechecks de `--pre` de las PENDIENTES (M22, M23, M24) aunque ya estén aplicadas. En el Docker
   * están aplicadas y sin esto su SQL no se ejecutaría nunca antes del día del push (el «no existe» da FAIL, que es lo
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
// M20 (CF · reglas de agenda): RUNBOOK «M20 en prod». Sin tablas, sin índices, sin tocar Booking.
const M20_COLUMNS = [
  "Tenant.agendaSlotStepMin",
  "Tenant.publicSlotStepMin",
  "Tenant.publicMinLeadMinutes",
  "Practitioner.allowParallelServices",
  "Practitioner.agendaSlotStepMin",
  "Practitioner.publicSlotStepMin",
] as const;
const M20_CHECKS = [
  "Tenant_agendaSlotStepMin_check",
  "Tenant_publicSlotStepMin_check",
  "Tenant_publicMinLeadMinutes_check",
  "Practitioner_agendaSlotStepMin_check",
  "Practitioner_publicSlotStepMin_check",
] as const;
// M21 (CF2 · profesional y caja, §29.4): RUNBOOK «M21 en prod». 7 columnas en Practitioner, 2 tablas, 12 CHECK, 1 único
// parcial + 2 parciales en Booking (tabla caliente: CREATE INDEX en la tx toma SHARE, frena las escrituras mientras
// dura), 1 trigger y RLS (PushSubscription SERVICE_ONLY).
const M21_TABLES = ["PushSubscription", "PractitionerRevenueShare"] as const;
const M21_COLUMNS = [
  "Practitioner.publicMinLeadMinutes",
  "Practitioner.contactWhatsapp",
  "Practitioner.showContactInLeadWindow",
  "Practitioner.contactConsentAt",
  "Practitioner.contactConsentVersion",
  "Practitioner.notifyBookingEmail",
  "Practitioner.notifyBookingPush",
] as const;
/** «tipo NULLABLE default» esperado de cada columna (information_schema), como el SQL del Anexo D. */
const M21_COLUMN_SHAPE: Record<(typeof M21_COLUMNS)[number], string> = {
  "Practitioner.publicMinLeadMinutes": "integer YES -",
  "Practitioner.contactWhatsapp": "text YES -",
  "Practitioner.showContactInLeadWindow": "boolean NO false",
  "Practitioner.contactConsentAt": "timestamp without time zone YES -",
  "Practitioner.contactConsentVersion": "text YES -",
  "Practitioner.notifyBookingEmail": "boolean NO false",
  "Practitioner.notifyBookingPush": "boolean NO false",
};
const M21_CHECKS = [
  "Practitioner_publicMinLeadMinutes_check",
  "Practitioner_contactWhatsapp_check",
  "Practitioner_contactConsentVersion_check",
  "Practitioner_leadContact_check",
  "PushSubscription_endpoint_check",
  "PushSubscription_keys_check",
  "PushSubscription_label_check",
  "PushSubscription_failureCount_check",
  "PractitionerRevenueShare_bps_check",
  "PractitionerRevenueShare_sources_check",
  "PractitionerRevenueShare_not_self_check",
  "PractitionerRevenueShare_period_check",
] as const;
const M21_FKS = [
  "PushSubscription_userId_fkey",
  "PractitionerRevenueShare_tenantId_fkey",
  "PractitionerRevenueShare_giver_tenant_fkey",
  "PractitionerRevenueShare_receiver_tenant_fkey",
] as const;
const M21_BOOKING_INDEXES = ["Booking_tenantId_copagoPaidAt_idx", "Booking_tenantId_insurerPaidAt_idx"] as const;
const M21_PARTIAL = ["PractitionerRevenueShare_giver_open_key", ...M21_BOOKING_INDEXES] as const;
const M21_INDEXES = [
  ...M21_PARTIAL,
  "PractitionerRevenueShare_tenantId_giver_from_idx",
  "PractitionerRevenueShare_tenantId_receiver_idx",
  "PushSubscription_endpoint_key",
  "PushSubscription_userId_idx",
] as const;

// M22 (CF3 · precio por profesional y sede digital, §30.3): RUNBOOK «M22 en prod». 6 columnas, 3 CHECK; sin tablas,
// sin índices, sin tocar Booking (solo catálogo: ADD COLUMN NULL o con DEFAULT constante).
const M22_COLUMNS = [
  "PractitionerService.priceCents",
  "Practitioner.showPublicPrice",
  "Practitioner.showContactForInsured",
  "Tenant.siteEnabled",
  "Tenant.siteEnabledAt",
  "Tenant.siteTagline",
] as const;
const M22_COLUMN_SHAPE: Record<(typeof M22_COLUMNS)[number], string> = {
  "PractitionerService.priceCents": "integer YES -",
  "Practitioner.showPublicPrice": "boolean NO true",
  "Practitioner.showContactForInsured": "boolean NO false",
  "Tenant.siteEnabled": "boolean NO false",
  "Tenant.siteEnabledAt": "timestamp without time zone YES -",
  "Tenant.siteTagline": "text YES -",
};
const M22_CHECKS = ["PractitionerService_priceCents_check", "Practitioner_insuredContact_check", "Tenant_siteTagline_check"] as const;
/**
 * Slugs que CF3 (SD-R, `lib/onboarding-logic.ts`) pasa a reservar: rutas de primer nivel de `app/` y archivos de
 * metadata de Next. La sede digital vive en `/<slug>`, así que un consultorio (o un alias viejo de TenantSlugAlias) con
 * uno de estos dejaría de andar: la ruta fija de Next gana y su sede/turnero nunca se ve. FAIL, no WARN: hay que
 * renombrarlo (Plataforma → consultorio → slug, que deja el viejo como alias… que también cae acá) ANTES del deploy.
 * Literal y no importado de onboarding-logic: este script corre con tsx sin alias, y la lista es la de ESTA salida.
 */
export const M22_NEW_RESERVED_SLUGS = [
  "caja", "cobros", "planes", "sala", "pagar", "profesionales", "consultorios", "privacidad", "terminos", "contacto",
  "mantenimiento", "plataforma-mfa", "icons", "apple-icon", "opengraph-image", "icon", "favicon", "manifest", "robots",
  "sitemap", "offline",
  // CF3b (BR-H): `public/sede/` (fotos del encabezado de la sede) crea el segmento `/sede`.
  "sede",
] as const;

// M23 (CF3b · co-titular y matrícula de la persona, 05-nov): RUNBOOK «M23 en prod». 5 columnas, 4 CHECK, 1 función con
// su trigger; sin tablas, sin índices, sin tocar Booking (ADD COLUMN NULL o con DEFAULT constante: solo catálogo).
const M23_COLUMNS = [
  "Membership.grantCoOwner",
  "UserProfile.licenseKind",
  "UserProfile.licenseNumber",
  "UserProfile.licenseJurisdiction",
  "UserProfile.licenseUpdatedAt",
] as const;
const M23_COLUMN_SHAPE: Record<(typeof M23_COLUMNS)[number], string> = {
  "Membership.grantCoOwner": "boolean NO false",
  "UserProfile.licenseKind": "text YES -",
  "UserProfile.licenseNumber": "text YES -",
  "UserProfile.licenseJurisdiction": "text YES -",
  "UserProfile.licenseUpdatedAt": "timestamp without time zone YES -",
};
const M23_CHECKS = [
  "Membership_coOwner_role_check",
  "UserProfile_licenseNumber_check",
  "UserProfile_licenseJurisdiction_check",
  "UserProfile_license_check",
] as const;
const M23_PROCS = ["user_profile_license_stamp"] as const;
const M23_TRIGGER = "UserProfile_license_stamp";

// M24 (CF3b · foto de la persona, 05-nov): RUNBOOK «M24 en prod». 3 columnas, 2 CHECK; sin tablas, sin índices, sin
// trigger, sin tocar Booking (ADD COLUMN NULL o con DEFAULT constante: solo catálogo).
const M24_COLUMNS = ["UserProfile.photoStorageKey", "UserProfile.photoUpdatedAt", "Practitioner.showPhotoPublic"] as const;
const M24_COLUMN_SHAPE: Record<(typeof M24_COLUMNS)[number], string> = {
  "UserProfile.photoStorageKey": "text YES -",
  "UserProfile.photoUpdatedAt": "timestamp without time zone YES -",
  "Practitioner.showPhotoPublic": "boolean NO false",
};
/**
 * Definición EXACTA (`pg_get_constraintdef`, Docker local tras `migrate deploy`). No alcanza con el nombre: la forma de
 * la clave es lo que impide que una fila de UserProfile (sin RLS) apunte a la firma o al logo de un consultorio en el
 * mismo bucket y el turnero o la sede la publiquen como foto. Un CHECK homónimo más laxo (creado a mano) pasaría
 * `constraintsByName`.
 */
const M24_CHECK_DEFS = {
  UserProfile_photoStorageKey_check:
    `CHECK ((("photoStorageKey" IS NULL) OR ((char_length("photoStorageKey") <= 200) AND ` +
    `starts_with("photoStorageKey", (('users/'::text || id) || '/'::text)) AND ` +
    `("photoStorageKey" ~ '^users(/[A-Za-z0-9_-][A-Za-z0-9._-]*)+$'::text))))`,
  UserProfile_photo_check: `CHECK ((("photoStorageKey" IS NULL) = ("photoUpdatedAt" IS NULL)))`,
} as const;
const M24_CHECKS = Object.keys(M24_CHECK_DEFS) as (keyof typeof M24_CHECK_DEFS)[];

/** Objetos de cada migración ya aplicada: el `--pre` los exige presentes (mismo inventario que el `--post`). */
const APPLIED_OBJECTS: Record<AppliedKey, Parameters<typeof present>[1]> = {
  M12: { columns: M12_COLUMNS, types: ["BookingCapMode", "BookingPaymentMethod"] },
  M14: { tables: M14_TABLES, types: M14_TYPES, columns: M14_COLUMNS, procs: ["patient_document_guard"] },
  M18: { tables: M18_TABLES, types: M18_TYPES, columns: ["Booking.onlineDepositCents"], procs: ["online_charge_guard", "online_charge_sync_booking"] },
  M17: { tables: ["ReceptionDisplay"], types: M17_TYPES },
  M15: { tables: M15_TABLES, types: M15_TYPES, columns: M15_COLUMNS },
  M16: { tables: ["SaasAdjustment"], types: M16_TYPES, columns: M16_COLUMNS, procs: ["saas_adjustment_guard"] },
  M19: { tables: ["SupportTicketNote"], types: M19_TYPES, columns: M19_COLUMNS },
  M20: { columns: M20_COLUMNS },
  M21: { tables: M21_TABLES, columns: M21_COLUMNS, procs: ["practitioner_revenue_share_guard"] },
};

const M16_CHECKS_EXISTING = [
  "SaasSubscription_cancel_check", "SaasSubscription_pendingPlan_check", "SaasSubscription_mpPending_check",
  "SaasCharge_breakdown_check", "SaasCharge_checkout_check", "SaasPayment_mpPayload_check", "SaasPayment_source_mp_check",
] as const;
const M16_PARTIAL = ["SaasSubscription_pendingPlan_idx", "SaasSubscription_cancel_idx", "SaasAdjustment_pending_idx"] as const;

/** Tablas nuevas de la tanda: las que el rol de la app tiene que poder leer (DEFAULT PRIVILEGES) y anon nunca. */
const NEW_TABLES = [...M14_TABLES, ...M18_TABLES, "ReceptionDisplay", ...M15_TABLES, "SaasAdjustment", ...M21_TABLES] as const;

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

  const expected = new Set<string>(PENDING_MIGRATIONS.map((m) => m.name));
  await c.check("pre.migrations.pending", "base", "Pendientes ⊆ M22, M23, M24 (CF3; M12..M21 ya aplicadas)", async () => {
    const unexpected = ms.pending.filter((n) => !expected.has(n));
    if (unexpected.length > 0) {
      return fail(`pendientes que NO son de esta salida (revisar antes de deployar): ${list(unexpected)}`);
    }
    if (ms.unknownInDb.length > 0) {
      return warn(`${ms.pending.length} pendientes; la base tiene aplicadas migraciones que el repo no conoce: ${list(ms.unknownInDb)}`);
    }
    const keys = PENDING_MIGRATIONS.filter((m) => ms.pending.includes(m.name)).map((m) => m.key);
    return pass(`${ms.pending.length} pendientes${keys.length ? `: ${keys.join(" → ")}` : " (la base ya está al día)"}`);
  });

  await c.check("pre.repo.checksums", "base", "Repo: migration.sql de M12..M24 = el sha256 verificado en local", async () => {
    const bad = TRACKED_MIGRATIONS.filter((m) => fileSha256(o.migrationsDir, m.name) !== m.sha256).map((m) => m.key);
    return bad.length === 0
      ? pass(`los ${TRACKED_MIGRATIONS.length} sha256 coinciden con el RUNBOOK y los handoffs`)
      : fail(`migration.sql cambiado: ${bad.join(", ")}`);
  });

  // Ya aplicadas (M12..M21): el reset de prod (M12..M19) y el push de CF2 (M20, M21). Pendiente o con otro checksum =
  // prod no es lo que creemos.
  for (const m of APPLIED_MIGRATIONS) {
    const row = ms.db.find((r) => r.migration_name === m.name && r.finished_at && !r.rolled_back_at);
    c.add(
      `pre.state.${m.key}`,
      m.key,
      `${m.key} ${m.name}`,
      !row
        ? fail("pendiente: tenía que estar aplicada (reset del 29/30-oct o push de CF2 del 02-nov); frená y revisá _prisma_migrations")
        : row.checksum !== m.sha256
          ? fail(`ya aplicada pero con otro checksum (${row.checksum.slice(0, 12)}… ≠ ${m.sha256.slice(0, 12)}…): el SQL de prod no es el del repo`)
          : pass(`ya aplicada (${row.finished_at ? new Date(row.finished_at).toISOString().slice(0, 16) + "Z" : "?"}) con el checksum verificado`)
    );
    await c.check(`pre.${m.key}.present`, m.key, `${m.key}: sus objetos existen`, () => present(tx, APPLIED_OBJECTS[m.key]));
  }

  // Pendientes (M22, M23, M24): si ya está aplicada, no hay nada que aplicar y sus prechecks se saltean.
  for (const m of PENDING_MIGRATIONS) {
    const row = ms.db.find((r) => r.migration_name === m.name && r.finished_at && !r.rolled_back_at);
    c.add(
      `pre.state.${m.key}`,
      m.key,
      `${m.key} ${m.name}`,
      ms.pending.includes(m.name)
        ? pass("pendiente: la aplica este deploy")
        : warn(`ya aplicada (${row?.finished_at ? new Date(row.finished_at).toISOString().slice(0, 16) + "Z" : "?"}): no hay nada que aplicar; sus prechecks se saltean`)
    );
  }
  const run = (key: PendingKey) => o.evaluateApplied === true || ms.pending.includes(PENDING_MIGRATIONS.find((m) => m.key === key)!.name);
  const gate = async (id: string, key: PendingKey, title: string, fn: () => Promise<Verdict>) => {
    if (!run(key)) c.add(id, key, title, skip(`${key} ya aplicada`));
    else await c.check(id, key, title, fn);
  };

  // M22 (RUNBOOK «M22 en prod»)
  await gate("pre.M22.absent", "M22", "M22: las 6 columnas nuevas de PractitionerService/Practitioner/Tenant y sus 3 CHECK no existen", () =>
    allOf(
      () => absent(tx, { columns: M22_COLUMNS }),
      async () => {
        const r = await rows<{ n: string }>(
          tx,
          `SELECT conname AS n FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conname = ANY($1::text[]) ORDER BY 1`,
          [...M22_CHECKS]
        );
        return r.length === 0 ? pass("ni los 3 CHECK") : fail(`ya existen (a mano o la migración quedó a medias): ${list(r.map((x) => `CHECK ${x.n}`))}`);
      }
    )
  );
  // M23 (RUNBOOK «M23 en prod»). Sin precheck de datos: los 4 CHECK son sobre columnas nuevas (todas false / NULL al
  // crearse), así que ninguna fila existente los puede violar.
  await gate("pre.M23.absent", "M23", "M23: las 5 columnas nuevas de Membership/UserProfile, sus 4 CHECK, la función y su trigger no existen", () =>
    allOf(
      () => absent(tx, { columns: M23_COLUMNS, procs: M23_PROCS }),
      async () => {
        const r = await rows<{ n: string }>(
          tx,
          `SELECT 'CHECK ' || conname AS n FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conname = ANY($1::text[])
           UNION ALL
           SELECT 'trigger ' || tgname FROM pg_trigger WHERE tgrelid = to_regclass('public."UserProfile"') AND tgname = $2
           ORDER BY 1`,
          [...M23_CHECKS],
          M23_TRIGGER
        );
        return r.length === 0
          ? pass("ni los 4 CHECK ni el trigger")
          : fail(`ya existen (a mano o la migración quedó a medias): ${list(r.map((x) => x.n))}`);
      }
    )
  );
  // M24 (RUNBOOK «M24 en prod»). Sin precheck de datos: los 2 CHECK son sobre columnas nuevas (todas NULL al crearse),
  // así que ninguna fila existente los puede violar; showPhotoPublic nace false sin CHECK.
  await gate("pre.M24.absent", "M24", "M24: las 3 columnas nuevas de UserProfile/Practitioner y sus 2 CHECK no existen", () =>
    allOf(
      () => absent(tx, { columns: M24_COLUMNS }),
      async () => {
        const r = await rows<{ n: string }>(
          tx,
          `SELECT conname AS n FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conname = ANY($1::text[]) ORDER BY 1`,
          [...M24_CHECKS]
        );
        return r.length === 0 ? pass("ni los 2 CHECK") : fail(`ya existen (a mano o la migración quedó a medias): ${list(r.map((x) => `CHECK ${x.n}`))}`);
      }
    )
  );

  // No depende de M22 (la lista la reserva el CÓDIGO de CF3) pero va el mismo día y la consecuencia es de M22 (la sede
  // en /<slug>): corre siempre, aunque M22 ya esté aplicada.
  await c.check("pre.M22.reservedSlugs", "M22", "CF3: consultorios o alias cuyo slug pasa a estar reservado (tiene que dar 0)", async () => {
    const r = await rows<{ src: string; slug: string; tenantId: string }>(
      tx,
      `SELECT 'Tenant' AS src, slug, id AS "tenantId" FROM "Tenant" WHERE lower(slug) = ANY($1::text[])
       UNION ALL
       SELECT 'TenantSlugAlias' AS src, slug, "tenantId" FROM "TenantSlugAlias" WHERE lower(slug) = ANY($1::text[])
       ORDER BY 1, 2`,
      [...M22_NEW_RESERVED_SLUGS]
    );
    return r.length === 0
      ? pass(`ninguno de los ${M22_NEW_RESERVED_SLUGS.length} slugs nuevos reservados está en uso`)
      : fail(
          `${r.length} en uso (dejarían de andar con el código de CF3): ${list(r.map((x) => `${x.src} «${x.slug}» → ${x.tenantId}`), 20)} → renombralos antes del deploy`
        );
  });

  // Sesiones y locks: M22 toma ACCESS EXCLUSIVE en Tenant, Practitioner y PractitionerService, M23 en Membership y
  // UserProfile, y M24 de nuevo en UserProfile y Practitioner (ALTER TABLE, solo catálogo), cada una con lock_timeout 5 s.
  // Las cinco se leen en cada request (M23/M24: la foto de acceso de CADA request): una tx larga sobre ellas hace caer el
  // deploy con P3009.
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
  await c.check("pre.activity.locks", "base", "Locks sobre Tenant, Practitioner, PractitionerService, Membership y UserProfile (las que alteran M22, M23 y M24)", async () => {
    const r = await rows<{ pid: number; rel: string; mode: string; granted: boolean; age: unknown }>(
      tx,
      `SELECT l.pid, c.relname AS rel, l.mode, l.granted, coalesce(extract(epoch FROM now() - a.xact_start)::int, 0) AS age
         FROM pg_locks l JOIN pg_class c ON c.oid = l.relation LEFT JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('Tenant','Practitioner','PractitionerService','Membership','UserProfile')
          AND l.pid <> pg_backend_pid()
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
  await c.check("post.migrate.checksums", "base", "Checksum de M12..M24 en _prisma_migrations = sha256 del repo", async () => {
    const bad: string[] = [];
    for (const m of TRACKED_MIGRATIONS) {
      const r = ms.db.find((x) => x.migration_name === m.name && x.finished_at && !x.rolled_back_at);
      if (!r) bad.push(`${m.key} sin aplicar`);
      else if (r.checksum !== m.sha256 || fileSha256(o.migrationsDir, m.name) !== m.sha256) bad.push(`${m.key} checksum distinto`);
    }
    return bad.length === 0 ? pass(`${TRACKED_MIGRATIONS.map((m) => m.key).join(", ")} con el checksum verificado`) : fail(list(bad));
  });

  await c.check("post.grants.app", "base", `Rol de la app: SELECT sobre las ${NEW_TABLES.length} tablas nuevas (DEFAULT PRIVILEGES)`, async () => {
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

  // M20 (CF · reglas de agenda): 6 columnas y 5 CHECK; el interruptor nace apagado para todos (sin backfill, CF-D1).
  await c.check("post.M20.objects", "M20", "M20: 6 columnas en Tenant/Practitioner", () => present(tx, { columns: M20_COLUMNS }));
  await c.check("post.M20.columns", "M20", "M20: allowParallelServices boolean NOT NULL DEFAULT false; las otras 5 integer NULL sin DEFAULT", async () => {
    const r = await rows<{ n: string; t: string; nullable: string; d: string | null }>(
      tx,
      `SELECT table_name || '.' || column_name AS n, data_type AS t, is_nullable AS nullable, column_default AS d
         FROM information_schema.columns WHERE table_schema = 'public' AND (table_name || '.' || column_name) = ANY($1::text[])`,
      [...M20_COLUMNS]
    );
    const bad: string[] = [];
    for (const col of M20_COLUMNS) {
      const x = r.find((y) => y.n === col);
      const want = col === "Practitioner.allowParallelServices" ? "boolean NO false" : "integer YES -";
      const got = x ? `${x.t} ${x.nullable} ${x.d ?? "-"}` : "no existe";
      if (got !== want) bad.push(`${col}: ${got} (≠ ${want})`);
    }
    return bad.length === 0 ? pass("tipos, nulabilidad y DEFAULT como el SQL de M20") : fail(list(bad));
  });
  await c.check("post.M20.checks", "M20", "M20: 5 CHECK (paso 15/30/45/60, anticipación 0..80 640)", () => constraintsByName(tx, M20_CHECKS, "c"));
  await c.check("post.M20.parallel", "M20", "M20: profesionales con «Atiende servicios distintos a la vez» prendido (informativo)", async () => {
    const on = await scalar(tx, `SELECT count(*) AS n FROM "Practitioner" WHERE "allowParallelServices"`);
    const total = await scalar(tx, `SELECT count(*) AS n FROM "Practitioner"`);
    // Recién migrado da 0 de N (nadie lo tiene): prenderlo a los que listó pre.M20.crossService es tarea del día.
    return pass(`${on} de ${total} profesionales`);
  });

  // M21 (CF2 · profesional y caja): RUNBOOK «M21 en prod».
  await c.check("post.M21.objects", "M21", "M21: 7 columnas en Practitioner, PushSubscription, PractitionerRevenueShare y el guard", () =>
    present(tx, { tables: M21_TABLES, columns: M21_COLUMNS, procs: ["practitioner_revenue_share_guard"] })
  );
  await c.check("post.M21.columns", "M21", "M21: 3 boolean NOT NULL DEFAULT false; las otras 4 NULL sin DEFAULT", async () => {
    const r = await rows<{ n: string; t: string; nullable: string; d: string | null }>(
      tx,
      `SELECT table_name || '.' || column_name AS n, data_type AS t, is_nullable AS nullable, column_default AS d
         FROM information_schema.columns WHERE table_schema = 'public' AND (table_name || '.' || column_name) = ANY($1::text[])`,
      [...M21_COLUMNS]
    );
    const bad: string[] = [];
    for (const col of M21_COLUMNS) {
      const x = r.find((y) => y.n === col);
      const got = x ? `${x.t} ${x.nullable} ${x.d ?? "-"}` : "no existe";
      if (got !== M21_COLUMN_SHAPE[col]) bad.push(`${col}: ${got} (≠ ${M21_COLUMN_SHAPE[col]})`);
    }
    return bad.length === 0 ? pass("tipos, nulabilidad y DEFAULT como el SQL de M21") : fail(list(bad));
  });
  await c.check("post.M21.checks", "M21", "M21: 12 CHECK por nombre (4 Practitioner, 4 PushSubscription, 4 reparto)", () =>
    constraintsByName(tx, M21_CHECKS, "c")
  );
  await c.check("post.M21.fks", "M21", "M21: FK del dispositivo al usuario + 3 del reparto (2 compuestas a Practitioner(id, tenantId))", () =>
    constraintsByName(tx, M21_FKS, "f")
  );
  await c.check("post.M21.indexes", "M21", "M21: 3 parciales (vigente única + 2 de Booking) y los 7 índices válidos (indisvalid)", () =>
    allOf(
      () => partialIndexes(tx, M21_PARTIAL),
      async () => {
        const r = await rows<{ n: string; v: boolean; u: boolean }>(
          tx,
          `SELECT c.relname AS n, i.indisvalid AS v, i.indisunique AS u FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
            WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1::text[])`,
          [...M21_INDEXES]
        );
        const bad = M21_INDEXES.filter((n) => !r.find((x) => x.n === n && x.v));
        const uniq = ["PractitionerRevenueShare_giver_open_key", "PushSubscription_endpoint_key"];
        const notUnique = uniq.filter((n) => !r.find((x) => x.n === n && x.u));
        if (bad.length) return fail(`faltan o quedaron inválidos (indisvalid = false): ${list(bad)}`);
        return notUnique.length ? fail(`no son únicos: ${list(notUnique)}`) : pass(`${M21_INDEXES.length} índices válidos; 2 únicos`);
      }
    )
  );
  await c.check("post.M21.trigger", "M21", "M21: trigger de solo cierre del reparto + md5 de practitioner_revenue_share_guard()", () =>
    allOf(
      () => triggers(tx, "PractitionerRevenueShare", ["PractitionerRevenueShare_guard"]),
      () => md5Check(tx, "practitioner_revenue_share_guard")
    )
  );
  await c.check("post.M21.rls", "M21", "M21: RLS ENABLE + FORCE; PushSubscription sin policies (SERVICE_ONLY), reparto con la de tenant", () =>
    rlsAndPolicies(tx, {
      PushSubscription: [],
      PractitionerRevenueShare: ["PractitionerRevenueShare_tenant_isolation:ALL"],
    })
  );
  await c.check("post.M21.optIn", "M21", "M21: profesionales con avisos o contacto prendidos (informativo: nacen apagados)", async () => {
    const r = await rows<{ mail: unknown; push: unknown; contact: unknown; total: unknown }>(
      tx,
      `SELECT count(*) FILTER (WHERE "notifyBookingEmail") AS mail, count(*) FILTER (WHERE "notifyBookingPush") AS push,
              count(*) FILTER (WHERE "showContactInLeadWindow") AS contact, count(*) AS total FROM "Practitioner"`
    );
    const x = r[0];
    // Recién migrado da 0: cada profesional los prende en Configuración → «Mi agenda» (tarea de Martin: avisarles).
    return pass(`de ${num(x?.total)} profesionales: mail ${num(x?.mail)}, push ${num(x?.push)}, contacto ${num(x?.contact)}`);
  });

  // M22 (CF3 · precio por profesional y sede digital): RUNBOOK «M22 en prod».
  await c.check("post.M22.objects", "M22", "M22: 6 columnas en PractitionerService/Practitioner/Tenant", () => present(tx, { columns: M22_COLUMNS }));
  await c.check("post.M22.columns", "M22", "M22: priceCents integer NULL; showPublicPrice DEFAULT true; showContactForInsured y siteEnabled DEFAULT false; siteEnabledAt y siteTagline NULL", async () => {
    const r = await rows<{ n: string; t: string; nullable: string; d: string | null }>(
      tx,
      `SELECT table_name || '.' || column_name AS n, data_type AS t, is_nullable AS nullable, column_default AS d
         FROM information_schema.columns WHERE table_schema = 'public' AND (table_name || '.' || column_name) = ANY($1::text[])`,
      [...M22_COLUMNS]
    );
    const bad: string[] = [];
    for (const col of M22_COLUMNS) {
      const x = r.find((y) => y.n === col);
      const got = x ? `${x.t} ${x.nullable} ${x.d ?? "-"}` : "no existe";
      if (got !== M22_COLUMN_SHAPE[col]) bad.push(`${col}: ${got} (≠ ${M22_COLUMN_SHAPE[col]})`);
    }
    return bad.length === 0 ? pass("tipos, nulabilidad y DEFAULT como el SQL de M22") : fail(list(bad));
  });
  await c.check("post.M22.checks", "M22", "M22: 3 CHECK por nombre (precio 0..100 000 000, contacto OS con consentimiento, frase 1..120)", () =>
    constraintsByName(tx, M22_CHECKS, "c")
  );
  await c.check("post.M22.optIn", "M22", "M22: precios propios, precio oculto, contacto OS y sedes encendidas (informativo)", async () => {
    const r = await rows<{ prices: unknown; hidden: unknown; insured: unknown; total: unknown; sites: unknown }>(
      tx,
      `SELECT (SELECT count(*) FROM "PractitionerService" WHERE "priceCents" IS NOT NULL) AS prices,
              count(*) FILTER (WHERE NOT "showPublicPrice") AS hidden, count(*) FILTER (WHERE "showContactForInsured") AS insured,
              count(*) AS total, (SELECT count(*) FROM "Tenant" WHERE "siteEnabled") AS sites FROM "Practitioner"`
    );
    const x = r[0];
    // Recién migrado: 0 precios propios, 0 ocultos, 0 contacto OS, 0 sedes (todo nace con la conducta de hoy).
    return pass(
      `de ${num(x?.total)} profesionales: ${num(x?.prices)} precios propios, ${num(x?.hidden)} con precio oculto, ${num(x?.insured)} con contacto OS; ${num(x?.sites)} sedes encendidas`
    );
  });

  // M23 (CF3b · co-titular y matrícula de la persona): RUNBOOK «M23 en prod».
  await c.check("post.M23.objects", "M23", "M23: 5 columnas en Membership/UserProfile y la función user_profile_license_stamp()", () =>
    present(tx, { columns: M23_COLUMNS, procs: M23_PROCS })
  );
  await c.check("post.M23.columns", "M23", "M23: grantCoOwner boolean NOT NULL DEFAULT false; las 4 de matrícula NULL sin DEFAULT", async () => {
    const r = await rows<{ n: string; t: string; nullable: string; d: string | null }>(
      tx,
      `SELECT table_name || '.' || column_name AS n, data_type AS t, is_nullable AS nullable, column_default AS d
         FROM information_schema.columns WHERE table_schema = 'public' AND (table_name || '.' || column_name) = ANY($1::text[])`,
      [...M23_COLUMNS]
    );
    const bad: string[] = [];
    for (const col of M23_COLUMNS) {
      const x = r.find((y) => y.n === col);
      const got = x ? `${x.t} ${x.nullable} ${x.d ?? "-"}` : "no existe";
      if (got !== M23_COLUMN_SHAPE[col]) bad.push(`${col}: ${got} (≠ ${M23_COLUMN_SHAPE[col]})`);
    }
    return bad.length === 0 ? pass("tipos, nulabilidad y DEFAULT como el SQL de M23") : fail(list(bad));
  });
  await c.check("post.M23.checks", "M23", "M23: 4 CHECK por nombre (co-titular solo PRACTITIONER; número, provincia y coherencia de la matrícula)", () =>
    constraintsByName(tx, M23_CHECKS, "c")
  );
  await c.check("post.M23.trigger", "M23", "M23: trigger de UserProfile + md5 de user_profile_license_stamp() + INVOKER/search_path", () =>
    allOf(
      () => triggers(tx, "UserProfile", [M23_TRIGGER]),
      () => md5Check(tx, "user_profile_license_stamp"),
      () => invokerWithSearchPath(tx, M23_PROCS)
    )
  );
  await c.check("post.M23.optIn", "M23", "M23: co-titulares y matrículas cargadas (informativo)", async () => {
    const r = await rows<{ co: unknown; lic: unknown; users: unknown }>(
      tx,
      `SELECT (SELECT count(*) FROM "Membership" WHERE "grantCoOwner") AS co,
              count(*) FILTER (WHERE "licenseNumber" IS NOT NULL) AS lic, count(*) AS users FROM "UserProfile"`
    );
    const x = r[0];
    // Recién migrado da 0 y 0: el Titular nombra co-titulares desde Usuarios y cada persona carga su matrícula.
    return pass(`${num(x?.co)} co-titulares; de ${num(x?.users)} usuarios, ${num(x?.lic)} con matrícula`);
  });

  // M24 (CF3b · foto de la persona): RUNBOOK «M24 en prod».
  await c.check("post.M24.objects", "M24", "M24: 3 columnas en UserProfile/Practitioner", () => present(tx, { columns: M24_COLUMNS }));
  await c.check("post.M24.columns", "M24", "M24: photoStorageKey text NULL; photoUpdatedAt timestamp NULL; showPhotoPublic boolean NOT NULL DEFAULT false", async () => {
    const r = await rows<{ n: string; t: string; nullable: string; d: string | null }>(
      tx,
      `SELECT table_name || '.' || column_name AS n, data_type AS t, is_nullable AS nullable, column_default AS d
         FROM information_schema.columns WHERE table_schema = 'public' AND (table_name || '.' || column_name) = ANY($1::text[])`,
      [...M24_COLUMNS]
    );
    const bad: string[] = [];
    for (const col of M24_COLUMNS) {
      const x = r.find((y) => y.n === col);
      const got = x ? `${x.t} ${x.nullable} ${x.d ?? "-"}` : "no existe";
      if (got !== M24_COLUMN_SHAPE[col]) bad.push(`${col}: ${got} (≠ ${M24_COLUMN_SHAPE[col]})`);
    }
    return bad.length === 0 ? pass("tipos, nulabilidad y DEFAULT como el SQL de M24") : fail(list(bad));
  });
  await c.check("post.M24.checks", "M24", "M24: 2 CHECK por nombre y con su definición exacta (clave bajo users/<id>/; clave y fecha juntas)", () =>
    allOf(
      () => constraintsByName(tx, M24_CHECKS, "c"),
      async () => {
        const r = await rows<{ n: string; def: string }>(
          tx,
          `SELECT conname AS n, pg_get_constraintdef(oid) AS def FROM pg_constraint
            WHERE contype = 'c' AND conrelid = to_regclass('public."UserProfile"') AND conname = ANY($1::text[])`,
          [...M24_CHECKS]
        );
        const bad = M24_CHECKS.filter((n) => r.find((x) => x.n === n)?.def !== M24_CHECK_DEFS[n]);
        return bad.length === 0
          ? pass("definiciones = las del SQL de M24")
          : fail(`definición distinta a la del repo (¿creado a mano?): ${list(bad)}`);
      }
    )
  );
  await c.check("post.M24.optIn", "M24", "M24: fotos subidas y profesionales que la publican (informativo)", async () => {
    const r = await rows<{ photos: unknown; users: unknown; pub: unknown; pracs: unknown }>(
      tx,
      `SELECT count(*) FILTER (WHERE "photoStorageKey" IS NOT NULL) AS photos, count(*) AS users,
              (SELECT count(*) FROM "Practitioner" WHERE "showPhotoPublic") AS pub, (SELECT count(*) FROM "Practitioner") AS pracs
         FROM "UserProfile"`
    );
    const x = r[0];
    // Recién migrado da 0 y 0: cada persona sube su foto y la publica por consultorio desde «Mi agenda».
    return pass(`de ${num(x?.users)} usuarios, ${num(x?.photos)} con foto; de ${num(x?.pracs)} profesionales, ${num(x?.pub)} la publican`);
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
  // Agrupado por bloque (Base y después M12 → M24 en orden de aplicación), estable dentro de cada uno: los chequeos
  // se ejecutan en el orden que conviene a la tx, pero se leen por migración.
  const rank = (g: string) => (g === "base" ? 0 : 1 + TRACKED_MIGRATIONS.findIndex((m) => m.key === g));
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
