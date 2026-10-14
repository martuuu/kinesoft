/**
 * IAM-4a · `Actor.practitionerId: string | null` (null = rol no clínico: Secretaria, Facturación).
 *
 * Lo que `tsc` NO ve: contra una columna nullable (`Patient.assignedPractitionerId`, `TimeBlock.practitionerId`
 * = «todos») `{ col: actor.practitionerId }` con `null` compila a `IS NULL`, y `row.col === actor.practitionerId`
 * da `null === null`: un actor sin profesional quedaría «dueño» de todo lo SIN asignar. Por eso:
 *   1. helpers puros (`ownPatientsWhere`, `isActorPractitioner`, `revenueScopeFor`, `canManageBlocksFor`) que nunca
 *      tratan `null` como un profesional;
 *   2. un guard estático: en app/lib/components ningún `where`/objeto toma `actor.practitionerId` crudo como valor
 *      de una clave, ninguna comparación `===`/`!==` lo usa contra algo que no sea `null`, y ningún SQL crudo lo
 *      interpola. Todo pasa por los helpers.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { isActorPractitioner, ownPatientsWhere } from "@/lib/practitioner-scope";
import { revenueScopeFor } from "@/lib/dashboard-revenue";
import { canManageBlocksFor, capabilitiesFor } from "@/lib/capabilities";

describe("[IAM-4a] helpers: un actor sin profesional nunca es dueño de lo sin asignar", () => {
  it("ownPatientsWhere: asignados + compartidos con su profesional; sin profesional → condición imposible", () => {
    expect(ownPatientsWhere({ practitionerId: "p1" })).toEqual({
      OR: [{ assignedPractitionerId: "p1" }, { shares: { some: { practitionerId: "p1" } } }],
    });
    const none = ownPatientsWhere({ practitionerId: null });
    expect(none).toEqual({ id: { in: [] } });
    // Nunca el atajo `IS NULL`.
    expect(JSON.stringify(none)).not.toContain("assignedPractitionerId");
  });

  it("isActorPractitioner: nunca `null === null`", () => {
    expect(isActorPractitioner({ practitionerId: "p1" }, "p1")).toBe(true);
    expect(isActorPractitioner({ practitionerId: "p1" }, "p2")).toBe(false);
    expect(isActorPractitioner({ practitionerId: "p1" }, null)).toBe(false);
    expect(isActorPractitioner({ practitionerId: null }, null)).toBe(false);
    expect(isActorPractitioner({ practitionerId: null }, undefined)).toBe(false);
    expect(isActorPractitioner({ practitionerId: null }, "p1")).toBe(false);
  });

  it("revenueScopeFor: Facturación sin profesional ve todo; un clínico sin profesional no ve «lo suyo» con null", () => {
    expect(revenueScopeFor(capabilitiesFor("BILLING"), null)).toEqual({ kind: "tenant" });
    expect(revenueScopeFor(capabilitiesFor("ASSISTANT"), null)).toEqual({ kind: "none" });
    expect(revenueScopeFor(capabilitiesFor("PRACTITIONER"), null)).toEqual({ kind: "none" });
    expect(revenueScopeFor(capabilitiesFor("PRACTITIONER"), "p1")).toEqual({ kind: "own", practitionerId: "p1" });
  });

  it("canManageBlocksFor: sin profesional no hay agenda propia (ni el candado «todos» por null === null)", () => {
    const own = new Set(["agenda.manageOwnBlocks"] as const);
    expect(canManageBlocksFor(own, null, null)).toBe(false);
    expect(canManageBlocksFor(own, null, "p1")).toBe(false);
    expect(canManageBlocksFor(own, "p1", "p1")).toBe(true);
    // La Secretaria bloquea la agenda de todos por `agenda.manageBlocks`, sin profesional.
    expect(canManageBlocksFor(capabilitiesFor("ASSISTANT"), null, "p1")).toBe(true);
    expect(canManageBlocksFor(capabilitiesFor("ASSISTANT"), null, null)).toBe(true);
  });
});

// ── Guard estático ──────────────────────────────────────────────────────────

const ROOT = process.cwd();
const ACTOR_PID = String.raw`(?:\b[\w.]*\.)?\bactor\.practitionerId\b`;

/** `clave: actor.practitionerId` (sin `??`/ternario después): el valor crudo como filtro o dato. */
const KEY_ASSIGN = new RegExp(String.raw`\b\w+\s*:\s*${ACTOR_PID}(?!\s*(?:\?\?|\?|&&|\|\|))`);
/** Comparación contra algo que no es `null`/`undefined` (esos son los chequeos de «tiene profesional»). */
const COMPARE_RIGHT = new RegExp(String.raw`(?:===|!==|==|!=)\s*${ACTOR_PID}`);
const COMPARE_LEFT = new RegExp(String.raw`${ACTOR_PID}\s*(?:===|!==|==|!=)(?!=)\s*(?!\s|null\b|undefined\b)`);
/** Interpolado en SQL crudo (`Prisma.sql` / `$queryRaw`): con null da `= NULL`. */
const SQL_INTERP = new RegExp(String.raw`\$\{\s*${ACTOR_PID}\s*\}`);

/**
 * Usos de `clave: actor.practitionerId` que NO son filtros ni datos de una columna: se listan con su porqué.
 * Una línea nueva acá es una decisión (revisar que la columna/prop acepte null con ese significado).
 */
const ALLOWED_KEY_ASSIGN: ReadonlyArray<{ file: string; line: string; why: string }> = [
  {
    file: "lib/session.ts",
    line: "practitionerId: actor.practitionerId,",
    why: "contexto de logs del request (`ensureRequestContext`): null = el actor no atiende",
  },
  {
    file: "app/(app)/agenda/page.tsx",
    line: "viewer={{ userId: actor.userId, practitionerId: actor.practitionerId }}",
    why: "prop del cliente de la agenda, ya tipada `string | null` (sin profesional por defecto)",
  },
];

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function walk(dir: string, out: string[]): void {
  for (const f of readdirSync(dir)) {
    if (f === "node_modules" || f.startsWith(".")) continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(f)) out.push(p);
  }
}

type Offense = { file: string; line: string; rule: string };

function offensesIn(file: string, src: string): Offense[] {
  const out: Offense[] = [];
  for (const raw of stripComments(src).split("\n")) {
    const line = raw.trim();
    if (!line.includes("practitionerId")) continue;
    const rules: [string, RegExp][] = [
      ["key-assign", KEY_ASSIGN],
      ["compare", COMPARE_RIGHT],
      ["compare", COMPARE_LEFT],
      ["sql", SQL_INTERP],
    ];
    for (const [rule, re] of rules) {
      if (!re.test(line)) continue;
      if (rule === "key-assign" && ALLOWED_KEY_ASSIGN.some((a) => a.file === file && a.line === line)) continue;
      out.push({ file, line, rule });
    }
  }
  return out;
}

describe("[IAM-4a] guard: `actor.practitionerId` nunca crudo contra una columna", () => {
  it("app/lib/components: sin `clave: actor.practitionerId`, sin `===`/`!==` contra él y sin interpolarlo en SQL", () => {
    const files: string[] = [];
    for (const d of ["app", "lib", "components"]) walk(join(ROOT, d), files);
    const offenses = files.flatMap((f) => {
      const rel = relative(ROOT, f).split("\\").join("/");
      // El helper es el único lugar donde se compara (con el chequeo de null adentro).
      if (rel === "lib/practitioner-scope.ts") return [];
      return offensesIn(rel, readFileSync(f, "utf8"));
    });
    expect(offenses).toEqual([]);
  });

  it("los usos permitidos siguen existiendo (si se van, la lista queda vieja)", () => {
    for (const a of ALLOWED_KEY_ASSIGN) {
      const lines = stripComments(readFileSync(join(ROOT, a.file), "utf8")).split("\n").map((l) => l.trim());
      expect(lines, `${a.file}: ${a.why}`).toContain(a.line);
    }
  });

  it("el detector agarra los patrones del bug y deja pasar los seguros", () => {
    const bad = [
      "{ assignedPractitionerId: actor.practitionerId },",
      "{ shares: { some: { practitionerId: actor.practitionerId } } },",
      "authorId: o.actor.practitionerId,",
      "if (patient.assignedPractitionerId === actor.practitionerId) return \"full\";",
      "if (!isAdmin && cur.authorId !== actor.practitionerId) throw x;",
      "row.practitionerId !== actor.practitionerId &&",
      "actor.practitionerId === b.practitionerId",
      'Prisma.sql`(pa."assignedPractitionerId" = ${actor.practitionerId})`',
    ];
    for (const l of bad) expect(offensesIn("x.ts", l), l).not.toEqual([]);
    const ok = [
      "const pid = actor.practitionerId;",
      "if (!actor.practitionerId) return \"basic\";",
      "return actor.practitionerId !== null && x;",
      "practitionerId: capSet.has(\"clinical.read\") ? actor.practitionerId : null,",
      "viewer={salaViewer(actor.practitionerId ?? null, caps)}",
      "const scope = revenueScopeFor(caps, actor.practitionerId);",
      "assertCanManageRoom(caps, actor.practitionerId);",
      "// { assignedPractitionerId: actor.practitionerId }",
      "isActorPractitioner(actor, patient.assignedPractitionerId)",
    ];
    for (const l of ok) expect(offensesIn("x.ts", l), l).toEqual([]);
  });
});
