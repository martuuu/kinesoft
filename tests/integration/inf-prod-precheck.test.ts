/**
 * [INF-S] Núcleo de `scripts/prod-precheck.ts` (§26.7) contra el Docker local, en los dos roles de la suite (el núcleo
 * siempre conecta con el owner, como el script con DIRECT_URL). El SCRIPT no se corre: lo corre Martin contra prod.
 *
 * Qué se fija:
 *  - `--post` sobre la base local (las 46 migraciones aplicadas) da PASS en todo; el único SKIP admitido es el de la
 *    Data API (en el Docker no existen los roles `anon`/`authenticated` de Supabase) y el de Storage.
 *  - `--pre` sobre la misma base dice, migración por migración, que las 6 de la tanda YA están aplicadas (no
 *    pendientes) y saltea sus prechecks en vez de dar FAIL por «el objeto ya existe».
 *  - Todo corre en UNA transacción READ ONLY: un write adentro rebota (25006).
 *  - El chequeo de `pg_dump` compara la versión local contra la del server (el backup con un pg_dump viejo falla).
 *  - La tabla impresa no lleva la URL de conexión.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { ownerClient } from "@/tests/helpers/tenant-factory";
import {
  T6T7_MIGRATIONS,
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
    for (const m of T6T7_MIGRATIONS) {
      expect(post.rows.some((r) => r.group === m.key && r.status === "PASS"), m.key).toBe(true);
    }
  });

  it("[INF-S] --pre en local: las 7 figuran YA aplicadas (no pendientes) y sus prechecks se saltean", () => {
    expect(T6T7_MIGRATIONS.map((m) => m.key)).toEqual(["M12", "M14", "M18", "M17", "M15", "M16", "M19"]);
    const pending = pre.rows.find((r) => r.id === "pre.migrations.pending");
    expect(pending?.status).toBe("PASS");
    expect(pending?.detail).toMatch(/0 pendientes/);
    for (const m of T6T7_MIGRATIONS) {
      const st = pre.rows.find((r) => r.id === `pre.state.${m.key}`);
      expect(st?.status, m.key).toBe("WARN");
      expect(st?.detail, m.key).toMatch(/ya aplicada/);
      expect(st?.detail, m.key).not.toMatch(/pendiente/);
      // Ningún precheck de objeto de esa migración da FAIL por «ya existe»: van todos SKIP.
      const objs = pre.rows.filter((r) => r.group === m.key && r.id !== `pre.state.${m.key}`);
      expect(objs.length, m.key).toBeGreaterThan(0);
      expect(objs.every((r) => r.status === "SKIP"), m.key).toBe(true);
    }
    expect(pre.rows.find((r) => r.id === "pre.migrations.failed")?.status).toBe("PASS");
    expect(pre.rows.find((r) => r.id === "pre.role.bypassrls")?.status).toBe("PASS");
    expect(pre.rows.find((r) => r.id === "pre.server.version")?.status).toBe("PASS");
    // Las filas de actividad (tx largas, locks) dependen de quién más usa el Docker en este momento (otras sesiones
    // corren sus integraciones en paralelo): fuera de esas, ningún FAIL.
    const fails = pre.rows.filter((r) => r.status === "FAIL" && !r.id.startsWith("pre.activity."));
    expect(fails, JSON.stringify(fails, null, 2)).toEqual([]);
  });

  it("[INF-S] el SQL de los prechecks de --pre corre sin errores (evaluado sobre las ya aplicadas)", async () => {
    const forced = await runProdPrecheck({
      db,
      mode: "pre",
      migrationsDir: MIGRATIONS_DIR,
      pgDumpVersion: "pg_dump (PostgreSQL) 17.2",
      evaluateApplied: true,
    });
    const broken = forced.rows.filter((r) => /la consulta falló/.test(r.detail));
    expect(broken, JSON.stringify(broken, null, 2)).toEqual([]);
    // Con los objetos ya creados, los «no existe» dan FAIL nombrando lo que encontró (el veredicto de verdad).
    for (const id of ["pre.M12.absent", "pre.M14.absent", "pre.M18.absent", "pre.M17.absent", "pre.M15.absent", "pre.M16.absent"]) {
      const row = forced.rows.find((r) => r.id === id);
      expect(row?.status, id).toBe("FAIL");
      expect(row?.detail, id).toMatch(/ya existen/);
    }
    // El md5 de M14 no es el de M9: el precheck de M14 frena (lo que tiene que pasar si prod tuviera otra función).
    expect(forced.rows.find((r) => r.id === "pre.M14.clinicalNoteGuard")?.status).toBe("FAIL");
    // Los informativos y los de datos sí corren y pasan sobre la base local.
    for (const id of ["pre.M12.adminBackfill", "pre.M14.counts", "pre.M18.counts", "pre.M18.relfilenode", "pre.M16.chargeUnique", "pre.M16.anchorDay"]) {
      expect(forced.rows.find((r) => r.id === id)?.status, id).toBe("PASS");
    }
    const rfn = forced.rows.find((r) => r.id === "pre.M18.relfilenode")!.detail.match(/relfilenode = (\d+)/)?.[1];
    expect(rfn).toBeTruthy();
    // El --post compara el relfilenode que anotó el --pre: igual → PASS; otro → FAIL (la tabla se reescribió).
    const same = await runProdPrecheck({ db, mode: "post", migrationsDir: MIGRATIONS_DIR, pgDumpVersion: null, bookingRelfilenode: Number(rfn) });
    expect(same.rows.find((r) => r.id === "post.M18.depositColumn")?.status).toBe("PASS");
    const other = await runProdPrecheck({ db, mode: "post", migrationsDir: MIGRATIONS_DIR, pgDumpVersion: null, bookingRelfilenode: 1 });
    expect(other.rows.find((r) => r.id === "post.M18.depositColumn")?.status).toBe("FAIL");
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
