/**
 * INF-S · Prechecks y postchecks de SOLO LECTURA del día del push (plan §26.7, `.docs/PUSH-DIA.md` paso D) —
 * wrapper fino del CLI. La lógica vive en `scripts/lib/prod-precheck-core.ts` (con su test de integración contra el
 * Docker, `tests/integration/inf-prod-precheck.test.ts`).
 *
 * Lo corre Martin, nunca un agente (decisión 1 del 22-oct). Pega la salida en el chat y el agente la verifica antes
 * de cada paso:
 *   1. `--pre`  → backup (`db:prod:backup`) → `db:prod:deploy`. Desde el reset del 29-oct, M12..M19 ya están en prod y
 *      las pendientes son M20 `cf_agenda_rules` (CF, 30-oct; si todavía no se aplicó) y M21 `cf2_profesional_caja`
 *      (CF2, 02-nov); MIGRACIONES-RUNBOOK «M20 en prod» y «M21 en prod».
 *   2. `--post` → push. `--booking-relfilenode=<el que imprimió el --pre>` es opcional: confirma que ninguna migración
 *      reescribió "Booking" (M20 no lo toca; M21 le agrega 2 índices, que no reescriben la tabla).
 *
 * Seguridad:
 *  - Una sola tx `READ ONLY`: Postgres rechaza cualquier write.
 *  - Conexión: DIRECT_URL (owner, BYPASSRLS) si está, si no DATABASE_URL; se imprime el NOMBRE de la variable, nunca
 *    el valor. Sin fallback a localhost.
 *  - `assertSafeTarget`: local libre; remoto solo con KINESOFT_CONFIRM_PROD=<project ref>.
 *  - La tabla no lleva valores secretos (conteos, nombres de objetos, ids, versiones, el nombre del rol).
 *  - `pg_dump --version` se lee del PATH local (el mismo binario que usa `db:prod:backup`); no se conecta a nada.
 *  - Exit code 1 si hay algún FAIL (o si el script no pudo correr), 0 si no.
 *
 * Uso:
 *   npm run db:prod:precheck -- --pre                      (= dotenv -e .env.prod.local -- tsx scripts/prod-precheck.ts)
 *   KINESOFT_CONFIRM_PROD=<ref> npm run db:prod:precheck -- --pre
 *   KINESOFT_CONFIRM_PROD=<ref> npm run db:prod:precheck -- --post [--booking-relfilenode=<n>]
 * Local (Docker :5433, para ensayar):
 *   npx dotenv -e .env.local -- npx tsx scripts/prod-precheck.ts --post
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { formatPrecheckTable, runProdPrecheck, type PrecheckMode } from "./lib/prod-precheck-core";
import { assertSafeTarget } from "./lib/assert-safe-target";

const NAME = "prod-precheck";

function arg(name: string): string | undefined {
  const pref = `--${name}=`;
  return process.argv.find((a) => a.startsWith(pref))?.slice(pref.length);
}

function pgDumpVersion(): string | null {
  try {
    return execFileSync("pg_dump", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

async function main(): Promise<number> {
  const pre = process.argv.includes("--pre");
  const post = process.argv.includes("--post");
  if (pre === post) {
    console.error(`[${NAME}] Indicá UNO: --pre (antes del backup y el deploy) o --post (después del deploy).`);
    return 1;
  }
  const mode: PrecheckMode = pre ? "pre" : "post";
  const rfnArg = arg("booking-relfilenode");
  const bookingRelfilenode = rfnArg !== undefined ? Number(rfnArg) : null;
  if (rfnArg !== undefined && !(Number.isInteger(bookingRelfilenode) && (bookingRelfilenode ?? 0) > 0)) {
    console.error(`[${NAME}] --booking-relfilenode tiene que ser un entero positivo (el que imprimió el --pre).`);
    return 1;
  }

  const envName = process.env.DIRECT_URL ? "DIRECT_URL" : "DATABASE_URL";
  const url = process.env[envName];
  console.log(`[${NAME}] conexión: ${envName} · modo --${mode} · tx READ ONLY`);
  assertSafeTarget({ url, allowRemote: true, confirm: process.env.KINESOFT_CONFIRM_PROD, scriptName: NAME });

  const pgDump = pgDumpVersion();
  console.log(`[${NAME}] pg_dump local: ${pgDump ?? "no encontrado en el PATH"}`);

  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    const r = await runProdPrecheck({
      db,
      mode,
      migrationsDir: path.join(process.cwd(), "prisma", "migrations"),
      pgDumpVersion: pgDump,
      bookingRelfilenode,
    });
    console.log(formatPrecheckTable(r));
    return r.failed ? 1 : 0;
  } finally {
    await db.$disconnect();
  }
}

// Importable sin disparar el CLI (mismo patrón que saas-reanchor).
if (!process.env.VITEST) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`[${NAME}] ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    });
}
