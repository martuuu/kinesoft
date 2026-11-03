/**
 * [INF-S] Núcleo de `scripts/prod-precheck.ts` (§26.7) contra el Docker local, en los dos roles de la suite (el núcleo
 * siempre conecta con el owner, como el script con DIRECT_URL). El SCRIPT no se corre: lo corre Martin contra prod.
 *
 * Qué se fija:
 *  - `--post` sobre la base local (las 49 migraciones aplicadas) da PASS en todo; el único SKIP admitido es el de la
 *    Data API (en el Docker no existen los roles `anon`/`authenticated` de Supabase) y el de Storage.
 *  - `--pre` (CF, 30-oct: M12..M19 ya están en prod desde el reset; las pendientes son M20 y M21 de CF2): exige
 *    M12..M19 PRESENTES (aplicadas con su checksum y con sus objetos: PASS) y, como en el Docker M20 y M21 también
 *    están aplicadas, las marca «ya aplicada» y saltea sus prechecks en vez de dar FAIL por «el objeto ya existe».
 *  - Con `evaluateApplied`, los prechecks de M20 y M21 corren igual: `pre.M20.absent` / `pre.M21.absent` dan FAIL
 *    nombrando lo que encontraron, `pre.M20.crossService` (el SQL literal del brief) detecta un par de servicios
 *    distintos pisados armado a propósito y los de Booking de M21 (tx largas, tamaño) corren sin error.
 *  - Todo corre en UNA transacción READ ONLY: un write adentro rebota (25006).
 *  - El chequeo de `pg_dump` compara la versión local contra la del server (el backup con un pg_dump viejo falla).
 *  - La tabla impresa no lleva la URL de conexión.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { addService, createEphemeralTenant, ownerClient, uniqueSuffix, type EphemeralTenant } from "@/tests/helpers/tenant-factory";
import { localToARIso, toARDateKey } from "@/lib/datetime-ar";
import {
  APPLIED_MIGRATIONS,
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
  });

  it("[INF-S] --pre en local: M12..M19 PRESENTES (PASS, checksum y objetos); M20 y M21 ya aplicadas y sus prechecks se saltean", () => {
    expect(APPLIED_MIGRATIONS.map((m) => m.key)).toEqual(["M12", "M14", "M18", "M17", "M15", "M16", "M19"]);
    expect(PENDING_MIGRATIONS.map((m) => m.key)).toEqual(["M20", "M21"]);
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
    const PRE_IDS: Record<string, string[]> = {
      M20: ["pre.M20.absent", "pre.M20.crossService"],
      M21: ["pre.M21.absent", "pre.M21.bookingCount", "pre.M21.bookingTx"],
    };
    for (const key of ["M20", "M21"]) {
      const st = pre.rows.find((r) => r.id === `pre.state.${key}`);
      expect(st?.status, key).toBe("WARN");
      expect(st?.detail, key).toMatch(/ya aplicada/);
      const objs = pre.rows.filter((r) => r.group === key && r.id !== `pre.state.${key}`);
      expect(objs.map((r) => r.id).sort(), key).toEqual(PRE_IDS[key]);
      expect(objs.every((r) => r.status === "SKIP"), key).toBe(true);
    }
    expect(pre.rows.find((r) => r.id === "pre.migrations.failed")?.status).toBe("PASS");
    expect(pre.rows.find((r) => r.id === "pre.role.bypassrls")?.status).toBe("PASS");
    expect(pre.rows.find((r) => r.id === "pre.server.version")?.status).toBe("PASS");
    // Las filas de actividad (tx largas, locks) dependen de quién más usa el Docker en este momento (otras sesiones
    // corren sus integraciones en paralelo): fuera de esas, ningún FAIL.
    const fails = pre.rows.filter((r) => r.status === "FAIL" && !r.id.startsWith("pre.activity."));
    expect(fails, JSON.stringify(fails, null, 2)).toEqual([]);
  });

  it("[INF-S] el SQL de los prechecks de M20 y M21 corre sin errores (evaluado sobre las ya aplicadas)", async () => {
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
    const absent = forced.rows.find((r) => r.id === "pre.M20.absent");
    expect(absent?.status).toBe("FAIL");
    expect(absent?.detail).toMatch(/ya existen/);
    expect(absent?.detail).toMatch(/Practitioner\.allowParallelServices/);
    // El informativo corre: PASS (nadie) o WARN (lista), nunca FAIL.
    expect(["PASS", "WARN"]).toContain(forced.rows.find((r) => r.id === "pre.M20.crossService")?.status);
    // [CF2-MIG] M21: el «no existe» nombra columnas, tablas y función; Booking (tx > 5 s, tamaño) nunca da FAIL.
    const absent21 = forced.rows.find((r) => r.id === "pre.M21.absent");
    expect(absent21?.status).toBe("FAIL");
    expect(absent21?.detail).toMatch(/ya existen/);
    expect(absent21?.detail).toMatch(/tabla PractitionerRevenueShare/);
    expect(absent21?.detail).toMatch(/Practitioner\.notifyBookingPush/);
    for (const id of ["pre.M21.bookingTx", "pre.M21.bookingCount"]) {
      expect(["PASS", "WARN"], id).toContain(forced.rows.find((r) => r.id === id)?.status);
    }
    expect(forced.rows.find((r) => r.id === "pre.M21.bookingCount")?.detail).toMatch(/\d+ turnos \(\d+ con copagoPaidAt, \d+ con insurerPaidAt\)/);
  });

  it("[INF-S] pre.M20.crossService lista a quien tiene servicios distintos pisados (y no el mismo paciente ni cancelados)", async () => {
    let T: EphemeralTenant | undefined;
    try {
      T = await createEphemeralTenant(db);
      const other = await addService(db, T, { name: "Evaluación" });
      const at = new Date(Date.now() + 3 * 86_400_000);
      at.setUTCSeconds(0, 0);
      const plus = (min: number) => new Date(at.getTime() + min * 60_000);
      const [p1, p2] = await Promise.all(
        ["Uno", "Dos"].map((n) =>
          db.patient.create({ data: { tenantId: T!.tenantId, firstName: n, lastName: "CF-M" }, select: { id: true } })
        )
      );
      const mk = (serviceId: string, patientId: string, start: Date, status: "CONFIRMED" | "CANCELLED" = "CONFIRMED") =>
        db.booking.create({
          data: { tenantId: T!.tenantId, practitionerId: T!.practitionerId, serviceId, patientId, scheduledFor: start, durationMin: 45, status,
            idempotencyKey: `cfm-${uniqueSuffix()}` },
        });
      // El único par que cuenta: servicio A 45' (p1) a la hora y servicio B (p2) a la hora + 30' → se pisan 15'.
      await mk(T.serviceId, p1.id, at);
      await mk(other, p2.id, plus(30));
      // No suman pares: p2 en B cancelado encima de A; y p2 en B justo cuando termina el de A (+45', borde abierto,
      // pisa solo al de p2 en B, que es el MISMO servicio).
      await mk(other, p2.id, plus(5), "CANCELLED");
      await mk(other, p2.id, plus(45));
      const forced = await runProdPrecheck({ db, mode: "pre", migrationsDir: MIGRATIONS_DIR, pgDumpVersion: null, evaluateApplied: true });
      const row = forced.rows.find((r) => r.id === "pre.M20.crossService");
      expect(row?.status).toBe("WARN");
      expect(row?.detail).toContain(`${T.slug}:${T.practitionerId} 1 desde`);
    } finally {
      await T?.cleanup();
    }
  });

  it("[ZF1] pre.M20.crossService imprime el «desde» en día AR: un par a las 21:30 AR no sale con el día siguiente (UTC)", async () => {
    // El bug (B2 del revisor ZA): `toISOString().slice(0, 10)` del primer turno. 21:30 AR = 00:30 UTC del día
    // siguiente, así que Martin leía en el reporte un día que no es el del turno.
    let T: EphemeralTenant | undefined;
    try {
      T = await createEphemeralTenant(db);
      const other = await addService(db, T, { name: "Evaluación" });
      const day = toARDateKey(new Date(Date.now() + 3 * 86_400_000));
      const at = new Date(localToARIso(`${day}T21:30:00`));
      const utcDay = at.toISOString().slice(0, 10);
      expect(utcDay).not.toBe(day); // no vacuo: el turno cruza la medianoche UTC
      const [p1, p2] = await Promise.all(
        ["Uno", "Dos"].map((n) =>
          db.patient.create({ data: { tenantId: T!.tenantId, firstName: n, lastName: "ZF1" }, select: { id: true } })
        )
      );
      const mk = (serviceId: string, patientId: string, start: Date) =>
        db.booking.create({
          data: { tenantId: T!.tenantId, practitionerId: T!.practitionerId, serviceId, patientId, scheduledFor: start, durationMin: 45,
            status: "CONFIRMED", idempotencyKey: `zf1-${uniqueSuffix()}` },
        });
      await mk(T.serviceId, p1.id, at);
      await mk(other, p2.id, new Date(at.getTime() + 30 * 60_000));
      const forced = await runProdPrecheck({ db, mode: "pre", migrationsDir: MIGRATIONS_DIR, pgDumpVersion: null, evaluateApplied: true });
      const row = forced.rows.find((r) => r.id === "pre.M20.crossService");
      expect(row?.status).toBe("WARN");
      expect(row?.detail).toContain(`${T.slug}:${T.practitionerId} 1 desde ${day}`);
    } finally {
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
