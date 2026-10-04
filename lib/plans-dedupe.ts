/**
 * S02x · Planificador PURO del dedupe de `Session(programId, index)`.
 *
 * Por qué existe (PLANES.md §8, ola P0.1): M1 crea el único parcial
 * `Session_programId_index_live_key`. El schema previo nunca tuvo esa
 * restricción, así que en prod puede haber dos sesiones con el mismo `index`
 * dentro de un programa (doble click en "agregar sesión", carreras del alta
 * vieja). Si quedan repetidos, el `CREATE UNIQUE INDEX` de M1 aborta el build.
 *
 * Estrategia (literal de PLANES.md):
 *  - en cada grupo `(programId, index)` con más de una fila se conserva el id
 *    MENOR; las demás pasan, en id asc, a `max(index del programa)+1`, `+2`…;
 *  - no se borra nada; no se tocan SessionExercise, EvaScore, totalSessions ni
 *    Booking (los ejercicios y la evolución cuelgan del id, que no cambia);
 *  - idempotente: sin repetidos, el plan es vacío.
 *
 * "Id menor" se compara por unidades de código (`<` de JS), no con la collation
 * de Postgres: así el plan es determinístico sin importar el orden en que
 * llegan las filas ni el locale del servidor. Los ids son cuid (minúsculas y
 * dígitos), donde las dos órdenes coinciden igual.
 *
 * Si un programa tiene varios grupos repetidos, la numeración nueva sigue de
 * corrido entre grupos (grupo de index menor primero, id asc adentro), para que
 * dos movidas nunca caigan en el mismo `index`.
 */

export type SessionIndexRow = {
  id: string;
  programId: string;
  tenantId: string;
  index: number;
};

export type SessionIndexMove = {
  sessionId: string;
  programId: string;
  tenantId: string;
  from: number;
  to: number;
};

export type SessionIndexDedupePlan = {
  /** Grupos `(programId, index)` con más de una fila. */
  duplicateGroups: number;
  /** Programas con al menos un grupo repetido. */
  programs: number;
  /** Movidas, ordenadas por tenant, programa y `to`. */
  moves: SessionIndexMove[];
};

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function planSessionIndexDedupe(rows: readonly SessionIndexRow[]): SessionIndexDedupePlan {
  const byProgram = new Map<string, SessionIndexRow[]>();
  for (const r of rows) {
    const list = byProgram.get(r.programId);
    if (list) list.push(r);
    else byProgram.set(r.programId, [r]);
  }

  const moves: SessionIndexMove[] = [];
  let duplicateGroups = 0;
  let programs = 0;

  for (const programId of [...byProgram.keys()].sort(cmp)) {
    const list = byProgram.get(programId)!;
    // El max incluye TODAS las filas del programa (no solo las repetidas): una
    // movida nunca puede caer sobre un index que ya existe.
    let next = list.reduce((m, r) => Math.max(m, r.index), Number.NEGATIVE_INFINITY) + 1;

    const byIndex = new Map<number, SessionIndexRow[]>();
    for (const r of list) {
      const g = byIndex.get(r.index);
      if (g) g.push(r);
      else byIndex.set(r.index, [r]);
    }
    const dupIndexes = [...byIndex.entries()]
      .filter(([, g]) => g.length > 1)
      .map(([i]) => i)
      .sort((a, b) => a - b);
    if (dupIndexes.length === 0) continue;

    programs += 1;
    duplicateGroups += dupIndexes.length;
    for (const idx of dupIndexes) {
      const [, ...rest] = [...byIndex.get(idx)!].sort(byId);
      for (const r of rest) {
        moves.push({ sessionId: r.id, programId, tenantId: r.tenantId, from: r.index, to: next });
        next += 1;
      }
    }
  }

  moves.sort((a, b) => cmp(a.tenantId, b.tenantId) || cmp(a.programId, b.programId) || a.to - b.to);
  return { duplicateGroups, programs, moves };
}
