/**
 * S02x · planificador puro del dedupe de `Session(programId, index)`
 * (`lib/plans-dedupe.ts`). El efecto en la base lo cubre
 * `tests/integration/plans-dedupe.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { planSessionIndexDedupe, type SessionIndexRow } from "@/lib/plans-dedupe";

const row = (id: string, index: number, programId = "prog-a", tenantId = "t1"): SessionIndexRow => ({
  id,
  programId,
  tenantId,
  index,
});

/** Aplica el plan sobre las filas (lo que haría el UPDATE). */
const applyPlan = (rows: SessionIndexRow[]) => {
  const plan = planSessionIndexDedupe(rows);
  const to = new Map(plan.moves.map((m) => [m.sessionId, m.to]));
  return rows.map((r) => ({ ...r, index: to.get(r.id) ?? r.index }));
};

describe("planSessionIndexDedupe", () => {
  it("sin repetidos → plan vacío", () => {
    const plan = planSessionIndexDedupe([row("a", 1), row("b", 2), row("c", 3)]);
    expect(plan).toEqual({ duplicateGroups: 0, programs: 0, moves: [] });
  });

  it("conserva el id menor y manda el resto, en id asc, a max+1, +2…", () => {
    const plan = planSessionIndexDedupe([row("c2", 2), row("a1", 1), row("c3", 2), row("c1", 2), row("z", 5)]);
    expect(plan.duplicateGroups).toBe(1);
    expect(plan.programs).toBe(1);
    expect(plan.moves).toEqual([
      { sessionId: "c2", programId: "prog-a", tenantId: "t1", from: 2, to: 6 },
      { sessionId: "c3", programId: "prog-a", tenantId: "t1", from: 2, to: 7 },
    ]);
  });

  it("varios grupos en un programa: numeración de corrido (index menor primero), sin choques", () => {
    const rows = [row("b", 3), row("a", 3), row("d", 1), row("c", 1), row("e", 1), row("f", 4)];
    const plan = planSessionIndexDedupe(rows);
    expect(plan.duplicateGroups).toBe(2);
    expect(plan.moves.map((m) => [m.sessionId, m.from, m.to])).toEqual([
      ["d", 1, 5],
      ["e", 1, 6],
      ["b", 3, 7],
    ]);
    const after = applyPlan(rows).map((r) => r.index);
    expect(new Set(after).size).toBe(after.length);
  });

  it("programas independientes: cada uno usa su propio max", () => {
    const plan = planSessionIndexDedupe([
      row("a", 1, "p1"),
      row("b", 1, "p1"),
      row("c", 8, "p2", "t2"),
      row("d", 8, "p2", "t2"),
      row("e", 9, "p2", "t2"),
    ]);
    expect(plan.programs).toBe(2);
    expect(plan.moves).toEqual([
      { sessionId: "b", programId: "p1", tenantId: "t1", from: 1, to: 2 },
      { sessionId: "d", programId: "p2", tenantId: "t2", from: 8, to: 10 },
    ]);
  });

  it("determinístico: el orden de entrada no cambia el plan", () => {
    const rows = [row("x9", 2), row("x1", 2), row("x5", 2), row("y", 1), row("y0", 1)];
    const a = planSessionIndexDedupe(rows);
    const b = planSessionIndexDedupe([...rows].reverse());
    expect(b).toEqual(a);
  });

  it("idempotente: re-planificar después de aplicar da vacío", () => {
    const rows = [row("a", 1), row("b", 1), row("c", 1), row("d", 2), row("e", 2)];
    const once = applyPlan(rows);
    expect(planSessionIndexDedupe(once).moves).toEqual([]);
    expect(applyPlan(once)).toEqual(once);
  });

  it("compara ids por unidades de código (no locale)", () => {
    // "B" (0x42) < "a" (0x61): con localeCompare ganaría "a".
    const plan = planSessionIndexDedupe([row("a", 1), row("B", 1)]);
    expect(plan.moves.map((m) => m.sessionId)).toEqual(["a"]);
  });
});
