/**
 * S02x · Dedupe de `Session(programId, index)` — wrapper fino del CLI.
 *
 * Por qué (PLANES.md §8, P0.1): M1 (`plans_booking_link`) crea el único parcial
 * `Session_programId_index_live_key`; si en prod hay sesiones repetidas dentro
 * de un programa, el `CREATE UNIQUE INDEX` aborta el build. Este script las
 * renumera ANTES de M1: en cada grupo repetido conserva el id menor y manda el
 * resto, en id asc, a `max+1`, `+2`… del programa. No borra nada; no toca
 * SessionExercise, EvaScore, totalSessions ni Booking. Idempotente. La lógica
 * vive en `lib/plans-dedupe.ts` (pura) y `lib/plans-dedupe-internal.ts` (base).
 *
 * Seguridad:
 *  - DRY-RUN por defecto (tx READ ONLY). Para escribir: `--apply`.
 *  - Conexión: DIRECT_URL (owner) si está, si no DATABASE_URL; se imprime el
 *    NOMBRE de la variable, nunca el valor. Sin fallback a localhost.
 *  - `assertSafeTarget`: local libre; remoto solo con
 *    KINESOFT_CONFIRM_PROD=<project ref>.
 *  - Aborta sin BYPASSRLS (bajo RLS se ven 0 sesiones = falso verde).
 *  - `--tenant=<id>[,<id>…]` limita el alcance; sin él, todos los tenants.
 *  - Imprime el mapeo viejo→nuevo con ids (sin PHI).
 *
 * `lib/plans-dedupe-internal.ts` es `server-only`: tsx tiene que correr con la
 * condición `react-server` (si no, el import tira "This module cannot be
 * imported from a Client Component module").
 *
 * Uso (local, Docker :5433):
 *   npx dotenv -e .env.local -- npx tsx --conditions=react-server scripts/plans-dedupe-session-index.ts
 *   npx dotenv -e .env.local -- npx tsx --conditions=react-server scripts/plans-dedupe-session-index.ts --apply
 * Prod (lo corre Martin, antes de M1): backup → dry-run → revisar el mapeo →
 *   --apply → dry-run otra vez (tiene que dar 0), con `.env.prod.local` y
 *   KINESOFT_CONFIRM_PROD=<ref>.
 */
import { PrismaClient } from "@prisma/client";
import { runSessionIndexDedupe, type DedupeTenantScope } from "../lib/plans-dedupe-internal";
import { assertSafeTarget } from "./lib/assert-safe-target";

const NAME = "plans-dedupe-session-index";

function arg(name: string): string | undefined {
  const pref = `--${name}=`;
  return process.argv.find((a) => a.startsWith(pref))?.slice(pref.length);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const tenantArg = arg("tenant");
  const tenantIds: DedupeTenantScope = tenantArg
    ? tenantArg.split(",").map((s) => s.trim()).filter(Boolean)
    : "all";

  const envName = process.env.DIRECT_URL ? "DIRECT_URL" : "DATABASE_URL";
  const url = process.env[envName];
  console.log(`[${NAME}] conexión: ${envName}`);
  assertSafeTarget({ url, allowRemote: true, confirm: process.env.KINESOFT_CONFIRM_PROD, scriptName: NAME });
  console.log(
    `[${NAME}] modo: ${apply ? "APPLY (escribe)" : "DRY-RUN (no escribe)"} · alcance: ${
      tenantIds === "all" ? "todos los tenants" : tenantIds.join(", ")
    }`,
  );

  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    const r = await runSessionIndexDedupe({ db, tenantIds, apply });
    const { plan } = r;
    console.log(
      `[${NAME}] programas con repetidos: ${plan.programs} · grupos repetidos: ${plan.duplicateGroups} · sesiones a renumerar: ${plan.moves.length}`,
    );
    for (const m of plan.moves) {
      console.log(`  • tenant ${m.tenantId} · programa ${m.programId} · sesión ${m.sessionId}: index ${m.from} → ${m.to}`);
    }
    if (!apply) {
      console.log(
        plan.moves.length === 0
          ? `[${NAME}] Dry-run: no hay repetidos. No hace falta --apply.`
          : `[${NAME}] Dry-run: no se escribió nada. Repetí con --apply para renumerar.`,
      );
    } else {
      console.log(`[${NAME}] Renumeradas: ${r.updated}/${plan.moves.length}. Corré el dry-run otra vez: tiene que dar 0.`);
    }
  } finally {
    await db.$disconnect();
  }
}

// Importable sin disparar el CLI (mismo patrón que catalog-import).
if (!process.env.VITEST) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
