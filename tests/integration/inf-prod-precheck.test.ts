/**
 * [INF-S] Núcleo de `scripts/prod-precheck.ts` (§26.7) contra el Docker local, en los dos roles de la suite (el núcleo
 * siempre conecta con el owner, como el script con DIRECT_URL). El SCRIPT no se corre: lo corre Martin contra prod.
 *
 * Qué se fija:
 *  - `--post` sobre la base local (las 52 migraciones aplicadas) da PASS en todo; el único SKIP admitido es el de la
 *    Data API (en el Docker no existen los roles `anon`/`authenticated` de Supabase) y el de Storage.
 *  - `--pre` (CF3, 04/05-nov: M12..M21 ya están en prod —reset del 29/30-oct y push de CF2 del 02-nov—; las pendientes
 *    son M22, M23 y M24, en el mismo deploy): exige M12..M21 PRESENTES (aplicadas con su checksum y con sus objetos:
 *    PASS) y, como en el Docker M22, M23 y M24 también están aplicadas, las marca «ya aplicada» y saltea
 *    `pre.M22.absent`, `pre.M23.absent` y `pre.M24.absent` en vez de dar FAIL por «el objeto ya existe».
 *    `pre.M22.reservedSlugs` corre siempre (depende del código de CF3, no de la migración).
 *  - Con `evaluateApplied`, `pre.M22.absent`, `pre.M23.absent` y `pre.M24.absent` corren igual y dan FAIL nombrando lo
 *    que encontraron.
 *  - [CF3-MIG2-6] M23 en el `--post` objeto por objeto (columnas, 4 CHECK, trigger + md5 + INVOKER, informativo) y la
 *    pendiente permitida junto con M22.
 *  - [CF3-MIG3-6] M24 en el `--post` objeto por objeto (columnas, 2 CHECK con su definición exacta, informativo) y la
 *    pendiente permitida junto con M22 y M23.
 *  - [CF3-MIG6] `pre.M22.reservedSlugs` da FAIL si un consultorio o un alias usa un slug que CF3 reserva.
 *  (Los prechecks de M20 —crossService, y su caso del día AR de ZF1— y los de Booking de M21 se borraron con sus
 *  migraciones aplicadas: ya no hay nada que aplicar y su SQL no corre más.)
 *  - Todo corre en UNA transacción READ ONLY: un write adentro rebota (25006).
 *  - El chequeo de `pg_dump` compara la versión local contra la del server (el backup con un pg_dump viejo falla).
 *  - La tabla impresa no lleva la URL de conexión.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { createEphemeralTenant, ownerClient, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import {
  APPLIED_MIGRATIONS,
  M22_NEW_RESERVED_SLUGS,
  PENDING_MIGRATIONS,
  TRACKED_MIGRATIONS,
  formatPrecheckTable,
  runProdPrecheck,
  withReadOnlyTx,
  type PrecheckResult,
} from "@/scripts/lib/prod-precheck-core";

const RUN = process.env.INTEGRATION === "1";
const MIGRATIONS_DIR = path.join(process.cwd(), "prisma", "migrations");
/** SKIP admitidos en el Docker local: no hay roles de la Data API ni schema `storage` de Supabase. */
const LOCAL_SKIPS = new Set(["dataapi.anon", "storage.buckets"]);

describe.skipIf(!RUN)("[INF-S] prod-precheck (núcleo) contra el Docker local", () => {
  let db: PrismaClient;
  let post: PrecheckResult;
  let pre: PrecheckResult;

  beforeAll(async () => {
    db = ownerClient();
    // pg_dump 17: el local de la máquina puede ser otro; el chequeo de versión tiene su propio caso abajo.
    post = await runProdPrecheck({ db, mode: "post", migrationsDir: MIGRATIONS_DIR, pgDumpVersion: "pg_dump (PostgreSQL) 17.2" });
    pre = await runProdPrecheck({ db, mode: "pre", migrationsDir: MIGRATIONS_DIR, pgDumpVersion: "pg_dump (PostgreSQL) 17.2" });
    // INF_S_PRINT=1: muestra las dos tablas tal como las vería Martin (para revisar el copy sin correr el script).
    if (process.env.INF_S_PRINT === "1") console.log(`${formatPrecheckTable(pre)}\n\n${formatPrecheckTable(post)}`);
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  it("[INF-S] --post en local: PASS en todo (SKIP solo Data API y Storage, que no existen en el Docker)", () => {
    expect(post.rows.length).toBeGreaterThan(20);
    const bad = post.rows.filter((r) => !(r.status === "PASS" || (r.status === "SKIP" && LOCAL_SKIPS.has(r.id))));
    expect(bad, JSON.stringify(bad, null, 2)).toEqual([]);
    expect(post.failed).toBe(false);
    // Los md5 de las 4 funciones y el estado de migrate están entre lo chequeado.
    for (const id of [
      "post.md5.clinical_note_guard",
      "post.md5.online_charge_guard",
      "post.md5.online_charge_sync_booking",
      "post.md5.saas_adjustment_guard",
      "post.migrate.status",
      "post.migrate.checksums",
    ]) {
      expect(post.rows.find((r) => r.id === id)?.status, id).toBe("PASS");
    }
    for (const m of TRACKED_MIGRATIONS) {
      expect(post.rows.some((r) => r.group === m.key && r.status === "PASS"), m.key).toBe(true);
    }
    for (const id of ["post.M20.objects", "post.M20.columns", "post.M20.checks", "post.M20.parallel"]) {
      expect(post.rows.find((r) => r.id === id)?.status, id).toBe("PASS");
    }
    // [CF2-MIG] M21 objeto por objeto (incluido indisvalid de los 2 índices de Booking y el md5 del guard).
    const m21 = post.rows.filter((r) => r.group === "M21").map((r) => r.id).sort();
    expect(m21).toEqual([
      "post.M21.checks",
      "post.M21.columns",
      "post.M21.fks",
      "post.M21.indexes",
      "post.M21.objects",
      "post.M21.optIn",
      "post.M21.rls",
      "post.M21.trigger",
    ]);
    for (const id of m21) expect(post.rows.find((r) => r.id === id)?.status, id).toBe("PASS");
    // [CF3-MIG] M22 objeto por objeto.
    const m22 = post.rows.filter((r) => r.group === "M22").map((r) => r.id).sort();
    expect(m22).toEqual(["post.M22.checks", "post.M22.columns", "post.M22.objects", "post.M22.optIn"]);
    for (const id of m22) expect(post.rows.find((r) => r.id === id)?.status, id).toBe("PASS");
    // [CF3-MIG2-6] M23 objeto por objeto (el trigger incluye el md5 de user_profile_license_stamp y INVOKER/search_path).
    const m23 = post.rows.filter((r) => r.group === "M23").map((r) => r.id).sort();
    expect(m23).toEqual(["post.M23.checks", "post.M23.columns", "post.M23.objects", "post.M23.optIn", "post.M23.trigger"]);
    for (const id of m23) expect(post.rows.find((r) => r.id === id)?.status, id).toBe("PASS");
    expect(post.rows.find((r) => r.id === "post.M23.trigger")?.detail).toMatch(/UserProfile_license_stamp.*md5 = 112d2ddb.*INVOKER/);
    // [CF3-MIG3-6] M24 objeto por objeto (los 2 CHECK por nombre Y con la definición exacta del SQL).
    const m24 = post.rows.filter((r) => r.group === "M24").map((r) => r.id).sort();
    expect(m24).toEqual(["post.M24.checks", "post.M24.columns", "post.M24.objects", "post.M24.optIn"]);
    for (const id of m24) expect(post.rows.find((r) => r.id === id)?.status, id).toBe("PASS");
    expect(post.rows.find((r) => r.id === "post.M24.checks")?.detail).toMatch(/2 CHECK validados · definiciones = las del SQL de M24/);
    expect(post.rows.find((r) => r.id === "post.M24.optIn")?.detail).toMatch(/usuarios, \d+ con foto; de \d+ profesionales, \d+ la publican/);
    expect(post.rows.find((r) => r.id === "post.migrate.checksums")?.detail).toMatch(/M22, M23, M24 con el checksum verificado/);
  });

  it("[INF-S] --pre en local: M12..M21 PRESENTES (PASS, checksum y objetos); M22, M23 y M24 ya aplicadas y sus absent se saltean", () => {
    expect(APPLIED_MIGRATIONS.map((m) => m.key)).toEqual(["M12", "M14", "M18", "M17", "M15", "M16", "M19", "M20", "M21"]);
    // [CF3-MIG2-6] [CF3-MIG3-6] M23 y M24 van con M22 en el mismo deploy, en orden de timestamp.
    expect(PENDING_MIGRATIONS.map((m) => m.key)).toEqual(["M22", "M23", "M24"]);
    expect(PENDING_MIGRATIONS.map((m) => m.name)).toEqual([
      "20261104120000_cf3_precios_sede",
      "20261105120000_cf3_co_titular",
      "20261105130000_cf3_practitioner_photo",
    ]);
    const pending = pre.rows.find((r) => r.id === "pre.migrations.pending");
    expect(pending?.status).toBe("PASS");
    expect(pending?.detail).toMatch(/0 pendientes/);
    expect(pre.rows.find((r) => r.id === "pre.repo.checksums")?.status).toBe("PASS");
    for (const m of APPLIED_MIGRATIONS) {
      const st = pre.rows.find((r) => r.id === `pre.state.${m.key}`);
      expect(st?.status, m.key).toBe("PASS");
      expect(st?.detail, m.key).toMatch(/ya aplicada .*checksum verificado/);
      // Ya no se esperan ausentes: sus objetos tienen que estar.
      expect(pre.rows.find((r) => r.id === `pre.${m.key}.present`)?.status, m.key).toBe("PASS");
      expect(pre.rows.some((r) => r.id === `pre.${m.key}.absent`), m.key).toBe(false);
    }
    const st = pre.rows.find((r) => r.id === "pre.state.M22");
    expect(st?.status).toBe("WARN");
    expect(st?.detail).toMatch(/ya aplicada/);
    const objs = pre.rows.filter((r) => r.group === "M22" && r.id !== "pre.state.M22");
    expect(objs.map((r) => r.id).sort()).toEqual(["pre.M22.absent", "pre.M22.reservedSlugs"]);
    expect(pre.rows.find((r) => r.id === "pre.M22.absent")?.status).toBe("SKIP");
    // El Docker no tiene consultorios con slugs reservados: PASS (no se saltea aunque M22 esté aplicada).
    expect(pre.rows.find((r) => r.id === "pre.M22.reservedSlugs")?.status).toBe("PASS");
    const st23 = pre.rows.find((r) => r.id === "pre.state.M23");
    expect(st23?.status).toBe("WARN");
    expect(st23?.detail).toMatch(/ya aplicada/);
    const objs23 = pre.rows.filter((r) => r.group === "M23" && r.id !== "pre.state.M23");
    expect(objs23.map((r) => r.id)).toEqual(["pre.M23.absent"]);
    expect(objs23[0]?.status).toBe("SKIP");
    const st24 = pre.rows.find((r) => r.id === "pre.state.M24");
    expect(st24?.status).toBe("WARN");
    expect(st24?.detail).toMatch(/ya aplicada/);
    const objs24 = pre.rows.filter((r) => r.group === "M24" && r.id !== "pre.state.M24");
    expect(objs24.map((r) => r.id)).toEqual(["pre.M24.absent"]);
    expect(objs24[0]?.status).toBe("SKIP");
    expect(pre.rows.find((r) => r.id === "pre.migrations.failed")?.status).toBe("PASS");
    expect(pre.rows.find((r) => r.id === "pre.role.bypassrls")?.status).toBe("PASS");
    expect(pre.rows.find((r) => r.id === "pre.server.version")?.status).toBe("PASS");
    // Las filas de actividad (tx largas, locks) dependen de quién más usa el Docker en este momento (otras sesiones
    // corren sus integraciones en paralelo): fuera de esas, ningún FAIL.
    const fails = pre.rows.filter((r) => r.status === "FAIL" && !r.id.startsWith("pre.activity."));
    expect(fails, JSON.stringify(fails, null, 2)).toEqual([]);
  });

  it("[INF-S] el SQL de los prechecks de M22, M23 y M24 corre sin errores (evaluado sobre las ya aplicadas)", async () => {
    const forced = await runProdPrecheck({
      db,
      mode: "pre",
      migrationsDir: MIGRATIONS_DIR,
      pgDumpVersion: "pg_dump (PostgreSQL) 17.2",
      evaluateApplied: true,
    });
    const broken = forced.rows.filter((r) => /la consulta falló/.test(r.detail));
    expect(broken, JSON.stringify(broken, null, 2)).toEqual([]);
    // Con las columnas ya creadas, el «no existe» da FAIL nombrando lo que encontró (el veredicto de verdad).
    const absent = forced.rows.find((r) => r.id === "pre.M22.absent");
    expect(absent?.status).toBe("FAIL");
    expect(absent?.detail).toMatch(/ya existen/);
    expect(absent?.detail).toMatch(/PractitionerService\.priceCents/);
    expect(absent?.detail).toMatch(/Tenant\.siteTagline/);
    // `allOf` corta en el primer no-PASS: el ramal de los CHECK se ve solo si faltan las columnas (no en el Docker);
    // su SQL corre igual en el caso de abajo, que no lo puede ejercitar sin borrar columnas, así que se fija aparte.
    const checks = await db.$queryRaw<{ n: string }[]>`
      SELECT conname AS n FROM pg_constraint WHERE connamespace = 'public'::regnamespace
        AND conname = ANY(${["PractitionerService_priceCents_check", "Practitioner_insuredContact_check", "Tenant_siteTagline_check"]}) ORDER BY 1`;
    expect(checks.map((x) => x.n)).toEqual(["PractitionerService_priceCents_check", "Practitioner_insuredContact_check", "Tenant_siteTagline_check"]);
    // [CF3-MIG2-6] M23: mismo veredicto; el ramal de los CHECK y el trigger tampoco se ve con las columnas creadas.
    const absent23 = forced.rows.find((r) => r.id === "pre.M23.absent");
    expect(absent23?.status).toBe("FAIL");
    expect(absent23?.detail).toMatch(/ya existen/);
    expect(absent23?.detail).toMatch(/columna Membership\.grantCoOwner/);
    expect(absent23?.detail).toMatch(/columna UserProfile\.licenseUpdatedAt/);
    expect(absent23?.detail).toMatch(/función user_profile_license_stamp/);
    // [CF3-MIG3-6] M24: mismo veredicto, nombrando las 3 columnas.
    const absent24 = forced.rows.find((r) => r.id === "pre.M24.absent");
    expect(absent24?.status).toBe("FAIL");
    expect(absent24?.detail).toMatch(/ya existen/);
    for (const col of ["UserProfile.photoStorageKey", "UserProfile.photoUpdatedAt", "Practitioner.showPhotoPublic"]) {
      expect(absent24?.detail).toContain(`columna ${col}`);
    }
    // El ramal de los CHECK no se ve con las columnas creadas (allOf corta): sus nombres se fijan aparte.
    const checks24 = await db.$queryRaw<{ n: string }[]>`
      SELECT conname AS n FROM pg_constraint WHERE connamespace = 'public'::regnamespace
        AND conname = ANY(${["UserProfile_photoStorageKey_check", "UserProfile_photo_check"]}) ORDER BY 1`;
    expect(checks24.map((x) => x.n)).toEqual(["UserProfile_photoStorageKey_check", "UserProfile_photo_check"]);
  });

  it("[CF3-MIG6] pre.M22.reservedSlugs: FAIL si un consultorio o un alias usa un slug que CF3 reserva", async () => {
    // 21 de SD-R + `sede` (CF3b BR-H: la carpeta `public/sede/` crea el segmento `/sede`).
    expect(M22_NEW_RESERVED_SLUGS).toHaveLength(22);
    expect(M22_NEW_RESERVED_SLUGS).toEqual(expect.arrayContaining(["caja", "cobros", "sitemap", "plataforma-mfa", "offline", "sede"]));
    let T: EphemeralTenant | undefined;
    try {
      T = await createEphemeralTenant(db);
      // Un alias viejo (renombre de Plataforma) con un slug que pasa a ser ruta: también deja de resolver.
      await db.tenantSlugAlias.create({ data: { slug: "sitemap", tenantId: T.tenantId } });
      // Y el slug vigente de un consultorio (en mayúsculas: la comparación es case-insensitive).
      await db.tenant.update({ where: { id: T.tenantId }, data: { slug: "Caja" } });
      const r = await runProdPrecheck({ db, mode: "pre", migrationsDir: MIGRATIONS_DIR, pgDumpVersion: null });
      const row = r.rows.find((x) => x.id === "pre.M22.reservedSlugs");
      expect(row?.status).toBe("FAIL");
      expect(row?.detail).toMatch(/^2 en uso/);
      expect(row?.detail).toContain(`Tenant «Caja» → ${T.tenantId}`);
      expect(row?.detail).toContain(`TenantSlugAlias «sitemap» → ${T.tenantId}`);
      expect(r.failed).toBe(true);
    } finally {
      if (T) await db.tenant.update({ where: { id: T.tenantId }, data: { slug: T.slug } });
      await db.tenantSlugAlias.deleteMany({ where: { slug: "sitemap", tenantId: T?.tenantId ?? "-" } });
      await T?.cleanup();
    }
  });

  it("[INF-S] Data API: PASS (nada para anon/authenticated) o SKIP si los roles no existen", () => {
    for (const r of [pre, post]) {
      const row = r.rows.find((x) => x.id === "dataapi.anon");
      expect(["PASS", "SKIP"]).toContain(row?.status);
    }
  });

  it("[INF-S] pg_dump más viejo que el server → FAIL (y exit ≠ 0); igual o más nuevo → PASS; ausente → FAIL", async () => {
    const old = await runProdPrecheck({ db, mode: "pre", migrationsDir: MIGRATIONS_DIR, pgDumpVersion: "pg_dump (PostgreSQL) 12.1" });
    expect(old.rows.find((r) => r.id === "pre.pgdump.version")?.status).toBe("FAIL");
    expect(old.failed).toBe(true);
    const ok = pre.rows.find((r) => r.id === "pre.pgdump.version");
    expect(ok?.status).toBe("PASS");
    const none = await runProdPrecheck({ db, mode: "pre", migrationsDir: MIGRATIONS_DIR, pgDumpVersion: null });
    expect(none.rows.find((r) => r.id === "pre.pgdump.version")?.status).toBe("FAIL");
  });

  it("[INF-S] la transacción es READ ONLY: un write adentro rebota con 25006", async () => {
    await expect(
      withReadOnlyTx(db, (tx) => tx.$executeRawUnsafe(`CREATE TEMP TABLE inf_s_probe (x int)`))
    ).rejects.toThrow(/read-only|25006/i);
  });

  it("[INF-S] la tabla impresa trae PASS/WARN/FAIL/SKIP por fila y no la URL de conexión", () => {
    const out = formatPrecheckTable(post);
    expect(out).toMatch(/PASS/);
    expect(out).toMatch(/Resultado/);
    const url = process.env.DIRECT_URL ?? "";
    expect(url.length).toBeGreaterThan(0);
    expect(out).not.toContain(url);
    // La password local del Docker es igual al nombre del rol (que SÍ se imprime, no es secreto): solo se chequea
    // cuando es otra cosa (en prod es un -hex aleatorio).
    const u = new URL(url);
    const pwd = decodeURIComponent(u.password);
    if (pwd.length >= 4 && pwd !== decodeURIComponent(u.username)) expect(out).not.toContain(pwd);
  });
});
