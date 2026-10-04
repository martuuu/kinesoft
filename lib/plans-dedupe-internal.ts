import "server-only";
import { Prisma, type PrismaClient } from "@prisma/client";
import { planSessionIndexDedupe, type SessionIndexDedupePlan, type SessionIndexRow } from "./plans-dedupe";

/**
 * S02x · Lado con base del dedupe de `Session(programId, index)` (el plan puro
 * vive en `lib/plans-dedupe.ts`). Lo usa SOLO `scripts/plans-dedupe-session-index.ts`
 * y su test de integración; ninguna superficie de la app lo importa.
 *
 * Decisiones (PLANES.md S02x):
 *  - SQL crudo con columnas EXPLÍCITAS del schema PREVIO a M1 (`Session.id`,
 *    `programId`, `index`; `TreatmentProgram.id`, `tenantId`). El script corre
 *    ANTES de M1 con el cliente Prisma que sea: no puede depender de que el
 *    cliente generado conozca (o no) las columnas nuevas de Planes.
 *  - `db` y `tenantIds` inyectados: el test usa su tenant efímero y prueba que
 *    otro tenant queda intacto; el wrapper pasa `"all"` o los de `--tenant=`.
 *  - Todo en UNA tx con `SET LOCAL row_security = off`. Con BYPASSRLS eso no
 *    cambia nada; con un rol sujeto a RLS, Postgres TIRA error en vez de
 *    devolver 0 filas. Es la segunda barrera contra el falso verde "0
 *    repetidos" (la primera es `assertDedupeBypassRls`).
 *  - Dry-run: la tx es `READ ONLY`, así que "no escribe" lo garantiza Postgres,
 *    no la disciplina del código.
 *  - Apply: `LOCK TABLE "Session" IN SHARE ROW EXCLUSIVE MODE` (con
 *    `lock_timeout` de 5 s) ANTES de leer. Bloquea solo escrituras concurrentes
 *    a Session durante la tx (milisegundos: la tabla es chica), así un alta de
 *    sesión de la app no puede meter un `max+1` entre la lectura y el UPDATE.
 *    Las lecturas de la app siguen. Si no consigue el lock, aborta sin tocar
 *    nada y se reintenta.
 *  - Post-M1 (P1.Z): M1 agrega `Session.archivedAt` y el único es PARCIAL
 *    (`WHERE "archivedAt" IS NULL`). Una archivada puede repetir el index de
 *    una viva legítimamente (archivar no renumera), así que, si la columna
 *    existe, solo se agrupan y se mueven sesiones vivas. Se detecta con
 *    `information_schema` DENTRO de la misma tx (no con el cliente generado):
 *    pre-M1 la columna no existe y el comportamiento sigue idéntico.
 *  - El UPDATE lleva `index = from` y `programId` en el WHERE y se exige que
 *    afecte exactamente las filas planificadas; al final se re-verifica que no
 *    quede ningún repetido en el alcance. Cualquier desvío → rollback.
 */

export type DedupeTenantScope = readonly string[] | "all";

export type SessionIndexDedupeResult = {
  applied: boolean;
  plan: SessionIndexDedupePlan;
  /** Filas actualizadas (0 en dry-run). */
  updated: number;
};

type Tx = Prisma.TransactionClient;

/** Con el rol de la app, RLS esconde todas las sesiones: el dedupe exige BYPASSRLS. */
export async function assertDedupeBypassRls(db: PrismaClient | Tx): Promise<void> {
  const [role] = await db.$queryRaw<{ bypass: boolean }[]>`
    SELECT (rolbypassrls OR rolsuper) AS bypass FROM pg_roles WHERE rolname = current_user`;
  if (!role?.bypass) {
    throw new Error(
      "[plans-dedupe] la conexión no tiene BYPASSRLS: bajo RLS no se ve ninguna sesión y el dry-run diría \"0 repetidos\". Usá la URL owner (DIRECT_URL).",
    );
  }
}

function tenantFilter(tenantIds: DedupeTenantScope): Prisma.Sql {
  if (tenantIds === "all") return Prisma.empty;
  if (tenantIds.length === 0) {
    // Un array vacío no es "todos": es casi seguro un bug del llamador.
    throw new Error("[plans-dedupe] tenantIds vacío: pasá \"all\" o al menos un tenant.");
  }
  return Prisma.sql`AND p."tenantId" = ANY(${[...tenantIds]}::text[])`;
}

/**
 * `true` si `Session.archivedAt` existe (M1 aplicada). Se consulta en la tx del
 * dedupe para que la decisión y la lectura vean el mismo schema.
 */
async function sessionHasArchivedAt(tx: Tx): Promise<boolean> {
  const [r] = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'Session' AND column_name = 'archivedAt'`;
  return Number(r?.n ?? 0) > 0;
}

/** Filtro "solo vivas" para el alias dado; vacío pre-M1 (la columna no existe). */
function liveFilter(live: boolean, alias: "s" | "d"): Prisma.Sql {
  if (!live) return Prisma.empty;
  return alias === "s" ? Prisma.sql`AND s."archivedAt" IS NULL` : Prisma.sql`AND d."archivedAt" IS NULL`;
}

/** Todas las sesiones (vivas, post-M1) de los programas que tienen al menos un `(programId, index)` repetido. */
async function loadAffectedRows(tx: Tx, tenantIds: DedupeTenantScope, live: boolean): Promise<SessionIndexRow[]> {
  return tx.$queryRaw<SessionIndexRow[]>`
    SELECT s."id" AS "id", s."programId" AS "programId", p."tenantId" AS "tenantId", s."index" AS "index"
    FROM "Session" s
    JOIN "TreatmentProgram" p ON p."id" = s."programId"
    WHERE s."programId" IN (
      SELECT d."programId" FROM "Session" d WHERE TRUE ${liveFilter(live, "d")}
      GROUP BY d."programId", d."index" HAVING count(*) > 1
    )
    ${liveFilter(live, "s")}
    ${tenantFilter(tenantIds)}`;
}

async function countDuplicateGroups(tx: Tx, tenantIds: DedupeTenantScope, live: boolean): Promise<number> {
  const [r] = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM (
      SELECT s."programId", s."index"
      FROM "Session" s
      JOIN "TreatmentProgram" p ON p."id" = s."programId"
      WHERE TRUE ${liveFilter(live, "s")} ${tenantFilter(tenantIds)}
      GROUP BY s."programId", s."index"
      HAVING count(*) > 1
    ) x`;
  return Number(r?.n ?? 0);
}

export async function runSessionIndexDedupe(opts: {
  db: PrismaClient;
  tenantIds: DedupeTenantScope;
  apply: boolean;
}): Promise<SessionIndexDedupeResult> {
  const { db, tenantIds, apply } = opts;
  tenantFilter(tenantIds); // valida el alcance antes de abrir la tx
  await assertDedupeBypassRls(db);

  return db.$transaction(
    async (tx) => {
      if (!apply) await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await tx.$executeRaw`SET LOCAL row_security = off`;
      if (apply) {
        await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
        await tx.$executeRaw`LOCK TABLE "Session" IN SHARE ROW EXCLUSIVE MODE`;
      }

      const live = await sessionHasArchivedAt(tx);
      const plan = planSessionIndexDedupe(await loadAffectedRows(tx, tenantIds, live));
      if (!apply || plan.moves.length === 0) return { applied: apply, plan, updated: 0 };

      const ids = plan.moves.map((m) => m.sessionId);
      const programIds = plan.moves.map((m) => m.programId);
      const froms = plan.moves.map((m) => m.from);
      const tos = plan.moves.map((m) => m.to);
      const updated = await tx.$executeRaw`
        UPDATE "Session" AS s
        SET "index" = m.to_idx
        FROM unnest(${ids}::text[], ${programIds}::text[], ${froms}::int[], ${tos}::int[])
          AS m(id, program_id, from_idx, to_idx)
        WHERE s."id" = m.id AND s."programId" = m.program_id AND s."index" = m.from_idx`;
      if (updated !== plan.moves.length) {
        throw new Error(
          `[plans-dedupe] se esperaban ${plan.moves.length} filas actualizadas y fueron ${updated}. Rollback: no se escribió nada.`,
        );
      }
      const left = await countDuplicateGroups(tx, tenantIds, live);
      if (left !== 0) {
        throw new Error(`[plans-dedupe] después del UPDATE quedan ${left} grupos repetidos. Rollback: no se escribió nada.`);
      }
      return { applied: true, plan, updated };
    },
    { maxWait: 10_000, timeout: 60_000 },
  );
}
