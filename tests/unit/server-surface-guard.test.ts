/**
 * PV-W1a (HD-1) · superficie RPC de los `"use server"`.
 *
 * Por qué: Next 14.2.35 expone como server action TODO export de un módulo `"use server"` alcanzable desde el grafo
 * del cliente (no hay DCE de actions sin llamador). Un export que nadie usa sigue siendo un endpoint POST que recibe
 * lo que el atacante quiera: así `listBookingsInRange` (0 llamadores desde B4.1) aceptaba rangos de años sin tope,
 * y `getDayCounts` / `isReminderDismissed` eran endpoints muertos. Este guard hace visible cada export sin llamador:
 *
 *  (a) cada export de un `"use server"` (directiva como PRIMER statement) tiene ≥1 llamador no-test —un archivo de
 *      app/ components/ lib/ scripts/ o middleware.ts que importa el módulo y REFERENCIA el identificador en código
 *      (no en comentarios ni en posiciones de tipo: `typeof x` no llama a nada), o una referencia desde el mismo
 *      módulo (auto-llamada desde otro export)— o está en `ALLOWLIST` con un motivo de ≥20 caracteres;
 *  (b) una entrada del allowlist que ya tiene llamadores, o cuyo export ya no existe, falla: el allowlist no se
 *      pudre (cuando llega la UI de un export, se saca la entrada);
 *  (c) todo `lib/**\/*-internal.ts` lleva `import "server-only"` (los helpers internos no pueden terminar en el
 *      bundle del cliente).
 *
 * El análisis es estático con el compilador de `typescript` (AST, sin type-check). Limitaciones asumidas: no sigue
 * re-exports en cadena ni resuelve shadowing (un identificador local con el mismo nombre cuenta como referencia).
 * Para no dar un verde falso, el bloque «analizador» prueba el algoritmo con fuentes sintéticas antes de correrlo
 * sobre el árbol.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

/**
 * Exports de `"use server"` SIN llamador de producción, con su motivo. Clave: `<ruta relativa al repo>#<export>`.
 * Una entrada por línea y ordenadas: Q2 suma exports cuya UI llega en Q3 (sacarlas cuando la UI los use; el guard
 * (b) lo exige). El motivo dice por qué el endpoint queda expuesto igual y qué lo protege.
 */
const ALLOWLIST: Record<string, string> = {
  "lib/bookings.ts#listBookingsInRange": "Proyección completa vieja: la agenda usa listAgendaBookings desde B4.1; la usan 8 tests de integración y 3 de perf. Gate getActor + BookingsRangeQuery (≤62 días, HD-1) + bookingFieldAccess.",
  "lib/catalog.ts#suggestPayerForInsurer": "Sugerencia «Vincular a <Payer>» de M-cat cuya UI nunca se construyó (solo la usa catalog-tenant.test). Gate getActor + CatalogQuery; devuelve solo el payer del catálogo global.",
  "lib/conditions.ts#listCustomConditions": "PF2-d: /configuracion lo lee dentro de la tx única de configuracion-page-loader; la action queda para tests. Gate getActor + módulo diagnostico, where tenantId.",
  "lib/dashboard.ts#getDashboardData": "PF2-a: /dashboard usa getDashboardPageData (≤2 tx); esta queda como lectura sin días del mes para los tests de dashboard. Gate getActor (misma loadDashboard).",
  "lib/invitations.ts#listPendingInvitations": "PF2-d: /configuracion lee las invitaciones en su tx única (invitations-read); la action queda con su barrera requireTeamManager para tests.",
  "lib/invitations.ts#listTeamMembers": "PF2-d: /configuracion lee el equipo en su tx única (invitations-read); la action queda con su barrera requireTeamManager para tests.",
  "lib/mp-connect-actions.ts#getMyMpAccount": "Contrato C-TP4 (T5): /configuracion arma la vista en su loader (una tx); la action queda para tests. Gate getActor, sin soporte y solo el profesional propio.",
  "lib/mp-connect-actions.ts#getOnlinePaymentsSettings": "Contrato C-TP4: wrapper sin llamador de la lectura de booking-payment-policy (el loader de /configuracion la hace en su tx). Hallazgo PV-W1a: no es auto-llamada como decía el brief.",
  "lib/patients.ts#getPatientBillableCount": "PF2-b: el perfil del paciente lo carga patient-profile-loader en una tx (patients-profile-internal); la action queda para tests. Gate patientAccessFor + seesBookings.",
  "lib/patients.ts#getPatientCore": "PF2-b: el perfil del paciente usa patientCoreInTx desde su loader; la action queda para tests. Gate patientAccessFor (none → null) y escribe el audit patient.read.",
  "lib/patients.ts#getPatientEvaScores": "PF2-b: la curva EVA la carga el loader del perfil en su tx; la action queda para tests. Gate módulo evaluaciones + patientAccessFor full.",
  "lib/plans-adopt.ts#adoptBookingSeries": "Adoptar una serie de turnos a un plan (todo o nada): motor listo y testeado, su UI no llegó. Gate getActor + safeParse + capacidades del actor en la tx (adoptSeriesInTx), withReadOnlyResult.",
  "lib/platform-support.ts#listSupportSessionsForTenant": "PF2-d: la pestaña «Accesos de soporte» la carga configuracion-page-loader en su tx única; la action queda para tests. Gate getActor, rechaza soporte.",
  "lib/portal-vincular.ts#linkPortalByInvite": "Contrato §3.4 del portal (devuelve el slug); la página usa submitPortalInvite. Gate token firmado + getPortalUser no-staff + rate limit 10/h (linkByInvite).",
  "lib/practitioner-schedule.ts#getPractitionerScheduleSummary": "PF2-d: el resumen de horarios lo arma configuracion-page-loader en su tx única; la action queda para tests. Gate requireCapability agenda.viewAll.",
  "lib/programs.ts#deleteProgram": "«Eliminar plan» legacy (P2-S15: archiva, no borra); su UI se borró con el Tab Plan viejo. Gate requireModule planes + rol OWNER/ADMIN, withReadOnlyResult.",
  "lib/programs.ts#deleteSession": "Legacy de P2-S15: ya no borra nada, siempre devuelve el copy LEGACY_EDIT_COPY.deleteSession. Gate requireModule planes; sin escritura.",
  "lib/programs.ts#setProgramStatus": "Cambio de estado legacy del Tab Plan viejo (borrado en S27a); la UI nueva usa el ciclo de vida de plans-lifecycle. Gate requireModule planes + zod, withReadOnlyResult.",
  "lib/public-booking.ts#listPublicSlots": "Turnero público: el wizard usa listPublicSlotWindow/findFirstPublicSlot (TP-1); esta queda para ~18 tests del motor. Rate limit por IP + zod; sin Actor.",
  "lib/rooms.ts#listRooms": "SR/PF2-d: /configuracion lee las salas en su tx única (rooms-read); la action queda para tests. safeParse (inválido → []) y archivadas solo con schedule.configure.",
  "lib/services.ts#listServicesWithCounts": "PF2-d: /configuracion lee los servicios con conteos en su tx única (services-read); la action queda con su cache por tag para tests. Gate getActor.",
  "lib/sessions.ts#substituteSessionExercise": "Reemplazar un ejercicio de una sesión: sin UI hoy (solo sessions.test). Gate getActor + módulo + sessionExerciseForWrite + ejercicio asignable, withReadOnlyResult.",
  "lib/tenant-settings.ts#getTenantSettings": "PF2-d: /configuracion lee estos datos en su tx única (configuracion-page-loader); la action queda para tests. Gate getActor, where id = tenant del actor.",
  "lib/time-blocks.ts#deleteTimeBlock": "Borrado soft de un bloqueo o su grupo: la agenda solo usa createTimeBlock y el bloqueo de día (removeDayLock); sin botón. safeParse + permiso por fila (todas o ninguna), withReadOnlyResult.",
  "lib/time-blocks.ts#listTimeBlocks": "Lista de bloqueos sin UI (la agenda los lee por availability-loader); la usan los tests de time-blocks. Gate requireCapability agenda.viewAll + safeParse.",
};

const ROOT = process.cwd();
const SOURCE_DIRS = ["app", "components", "lib", "scripts"];
const SOURCE_FILES = ["middleware.ts"];
const SKIP_DIRS = new Set(["node_modules", ".next", ".git"]);

// ─────────────────────────────────────────────────────────────────────────────
// Analizador (puro: recibe un mapa ruta → fuente)
// ─────────────────────────────────────────────────────────────────────────────

type Sources = Map<string, string>;

function parse(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
}

function isUseServer(sf: ts.SourceFile): boolean {
  const first = sf.statements[0];
  return (
    !!first &&
    ts.isExpressionStatement(first) &&
    ts.isStringLiteral(first.expression) &&
    first.expression.text === "use server"
  );
}

function hasExportModifier(node: ts.Node): boolean {
  return (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.some(
    (m) => m.kind === ts.SyntaxKind.ExportKeyword
  ) ?? false;
}

/** Exports de VALOR del módulo (los `export type` / `interface` se borran al compilar: no son endpoints). */
function valueExports(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && hasExportModifier(st)) {
      const isDefault = ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      out.push(isDefault ? "default" : st.name!.text);
    } else if (ts.isVariableStatement(st) && hasExportModifier(st)) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) out.push(d.name.text);
    } else if (ts.isExportDeclaration(st) && !st.isTypeOnly && st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) if (!el.isTypeOnly) out.push(el.name.text);
    } else if (ts.isExportAssignment(st)) {
      out.push("default");
    }
  }
  return out;
}

/** `@/x`, `./x`, `../x` → ruta relativa al repo del archivo existente (o null si es un paquete). */
function resolveSpecifier(fromFile: string, spec: string, sources: Sources): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = spec.slice(2);
  else if (spec.startsWith(".")) base = relative(ROOT, resolve(ROOT, dirname(fromFile), spec));
  else return null;
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (sources.has(cand)) return cand;
  }
  return null;
}

/**
 * Identificadores usados como VALOR en el archivo: se saltean declaraciones de import, posiciones de tipo
 * (`typeof x`, anotaciones) y nombres de propiedad (`obj.x`, `{ x: 1 }`). Los comentarios no son nodos.
 * `exclude`: nodos cuyo subárbol no cuenta (la propia declaración del export, para no contarse a sí mismo).
 */
function valueIdentifiers(sf: ts.SourceFile, exclude?: Set<ts.Node>): Set<string> {
  const out = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (exclude?.has(node)) return;
    if (ts.isImportDeclaration(node) || ts.isTypeNode(node)) return;
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
    if (ts.isIdentifier(node)) {
      const p = node.parent;
      const isPropName =
        (ts.isPropertyAccessExpression(p) && p.name === node) ||
        (ts.isPropertyAssignment(p) && p.name === node) ||
        (ts.isMethodDeclaration(p) && p.name === node) ||
        (ts.isPropertyDeclaration(p) && p.name === node) ||
        (ts.isBindingElement(p) && p.propertyName === node) ||
        (ts.isJsxAttribute(p) && p.name === node);
      const isDeclName =
        (ts.isFunctionDeclaration(p) || ts.isVariableDeclaration(p) || ts.isParameter(p)) && p.name === node;
      if (!isPropName && !isDeclName) out.add(node.text);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Nombres accedidos como `ns.x` / `ns["x"]` sobre un identificador dado (import namespace). */
function namespaceMembers(sf: ts.SourceFile, ns: string): Set<string> {
  const out = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node) || ts.isImportDeclaration(node)) return;
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === ns) {
      out.add(node.name.text);
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === ns &&
      ts.isStringLiteral(node.argumentExpression)
    ) {
      out.add(node.argumentExpression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Todos los nombres de propiedad / binding / identificador de valor del archivo (para `await import(...)`). */
function anyValueName(sf: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node) || ts.isImportDeclaration(node)) return;
    if (ts.isIdentifier(node)) out.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

type ParsedFile = { sf: ts.SourceFile; values: Set<string> };

/**
 * `{ "<archivo use server>#<export>": ["<archivo llamador>", …] }` para todo export de todo `"use server"`.
 * `isCallerFile` decide qué archivos cuentan como llamadores (fuera los tests).
 */
function computeCallers(sources: Sources, isCallerFile: (p: string) => boolean): Map<string, string[]> {
  const parsed = new Map<string, ParsedFile>();
  const get = (p: string): ParsedFile => {
    let f = parsed.get(p);
    if (!f) {
      const sf = parse(p, sources.get(p)!);
      f = { sf, values: valueIdentifiers(sf) };
      parsed.set(p, f);
    }
    return f;
  };

  const callers = new Map<string, string[]>();
  const serverModules = new Map<string, string[]>();
  for (const p of sources.keys()) {
    const { sf } = get(p);
    if (!isUseServer(sf)) continue;
    const names = valueExports(sf);
    serverModules.set(p, names);
    for (const n of names) callers.set(`${p}#${n}`, []);
    // Auto-llamada: el identificador aparece en el módulo FUERA de su propia declaración.
    for (const st of sf.statements) {
      let own: string | null = null;
      if (ts.isFunctionDeclaration(st) && hasExportModifier(st) && st.name) own = st.name.text;
      if (ts.isVariableStatement(st) && hasExportModifier(st) && st.declarationList.declarations.length === 1) {
        const d = st.declarationList.declarations[0];
        if (ts.isIdentifier(d.name)) own = d.name.text;
      }
      if (!own) continue;
      if (valueIdentifiers(sf, new Set([st])).has(own)) callers.get(`${p}#${own}`)!.push(p);
    }
  }

  for (const p of sources.keys()) {
    if (!isCallerFile(p)) continue;
    const f = get(p);
    const visitImports = (node: ts.Node): void => {
      // import { a as b } from "…" / import * as ns from "…" / export { a } from "…"
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const target = resolveSpecifier(p, node.moduleSpecifier.text, sources);
        const names = target ? serverModules.get(target) : undefined;
        const clause = node.importClause;
        if (target && target !== p && names && clause && !clause.isTypeOnly) {
          if (clause.name && names.includes("default") && f.values.has(clause.name.text)) {
            callers.get(`${target}#default`)!.push(p);
          }
          const nb = clause.namedBindings;
          if (nb && ts.isNamedImports(nb)) {
            for (const el of nb.elements) {
              if (el.isTypeOnly) continue;
              const imported = (el.propertyName ?? el.name).text;
              if (names.includes(imported) && f.values.has(el.name.text)) callers.get(`${target}#${imported}`)!.push(p);
            }
          } else if (nb && ts.isNamespaceImport(nb)) {
            const members = namespaceMembers(f.sf, nb.name.text);
            for (const n of names) if (members.has(n)) callers.get(`${target}#${n}`)!.push(p);
          }
        }
      } else if (
        ts.isExportDeclaration(node) &&
        !node.isTypeOnly &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const target = resolveSpecifier(p, node.moduleSpecifier.text, sources);
        const names = target ? serverModules.get(target) : undefined;
        if (target && names && node.exportClause && ts.isNamedExports(node.exportClause)) {
          for (const el of node.exportClause.elements) {
            const imported = (el.propertyName ?? el.name).text;
            if (!el.isTypeOnly && names.includes(imported)) callers.get(`${target}#${imported}`)!.push(p);
          }
        }
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        // `await import("@/lib/x")`: sin seguir el binding, cuenta cualquier uso del nombre en el archivo.
        const target = resolveSpecifier(p, (node.arguments[0] as ts.StringLiteral).text, sources);
        const names = target ? serverModules.get(target) : undefined;
        if (target && target !== p && names) {
          const all = anyValueName(f.sf);
          for (const n of names) if (all.has(n)) callers.get(`${target}#${n}`)!.push(p);
        }
      }
      ts.forEachChild(node, visitImports);
    };
    visitImports(f.sf);
  }
  for (const [k, v] of callers) callers.set(k, [...new Set(v)].sort());
  return callers;
}

/** `lib/**\/*-internal.ts` sin `import "server-only"` (import de efecto, sin cláusula). */
function internalWithoutServerOnly(sources: Sources): string[] {
  const out: string[] = [];
  for (const [p, text] of sources) {
    if (!/^lib\/.+-internal\.ts$/.test(p)) continue;
    const sf = parse(p, text);
    const ok = sf.statements.some(
      (st) =>
        ts.isImportDeclaration(st) &&
        !st.importClause &&
        ts.isStringLiteral(st.moduleSpecifier) &&
        st.moduleSpecifier.text === "server-only"
    );
    if (!ok) out.push(p);
  }
  return out.sort();
}

// ─────────────────────────────────────────────────────────────────────────────
// Árbol real
// ─────────────────────────────────────────────────────────────────────────────

const isTestPath = (p: string) => /(^|\/)(tests|__tests__)\//.test(p) || /\.(test|spec)\.tsx?$/.test(p);

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(abs);
  }
}

function loadTree(): Sources {
  const files: string[] = [];
  for (const d of SOURCE_DIRS) walk(join(ROOT, d), files);
  for (const f of SOURCE_FILES) if (existsSync(join(ROOT, f))) files.push(join(ROOT, f));
  const sources: Sources = new Map();
  for (const abs of files.sort()) {
    const rel = relative(ROOT, abs);
    if (!isTestPath(rel)) sources.set(rel, readFileSync(abs, "utf8"));
  }
  return sources;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("[HD-1] analizador de la superficie RPC (fuentes sintéticas: anti-falso-verde)", () => {
  const fixture: Sources = new Map([
    [
      "lib/acts.ts",
      [
        `"use server";`,
        `export type Row = { id: string };`,
        `export async function used() { return 1; }`,
        `export async function onlyComment() { return 2; }`,
        `export async function onlyTypeof() { return 3; }`,
        `export async function selfCalled() { return 4; }`,
        `export async function caller() { return selfCalled(); }`,
        `export async function viaNamespace() { return 5; }`,
        `export async function viaAlias() { return 6; }`,
        `export async function viaDynamic() { return 7; }`,
        `export async function recursive(n: number): Promise<number> { return n ? recursive(n - 1) : 0; }`,
        `export const arrow = async () => 8;`,
        `export async function onlyProp() { return 9; }`,
      ].join("\n"),
    ],
    [
      "lib/not-server.ts",
      `// "use server" en un comentario no cuenta\nexport async function free() { return 0; }`,
    ],
    [
      "components/a.tsx",
      [
        `"use client";`,
        `import { used, onlyComment, onlyTypeof, viaAlias as va, onlyProp, arrow } from "@/lib/acts";`,
        `// onlyComment() se menciona solo acá`,
        `type T = Awaited<ReturnType<typeof onlyTypeof>>;`,
        `const o = { onlyProp: 1 };`,
        `export function A() { const t: T | null = null; return <button onClick={() => { used(); va(); arrow(); }}>{String(t)}{o.onlyProp}</button>; }`,
      ].join("\n"),
    ],
    ["app/b.ts", `import * as acts from "../lib/acts";\nexport const run = () => acts.viaNamespace();`],
    ["lib/c.ts", `export async function go() { const m = await import("./acts"); return m.viaDynamic(); }`],
    ["tests/x.test.ts", `import { recursive } from "@/lib/acts";\nrecursive(1);`],
  ]);
  const callers = computeCallers(fixture, (p) => !isTestPath(p));
  const has = (name: string) => (callers.get(`lib/acts.ts#${name}`) ?? []).length > 0;

  it("detecta el `\"use server\"` solo como primer statement y lista exports de valor (no los `export type`)", () => {
    expect([...callers.keys()].filter((k) => k.startsWith("lib/not-server.ts"))).toEqual([]);
    expect(callers.has("lib/acts.ts#Row")).toBe(false);
    expect(callers.has("lib/acts.ts#arrow")).toBe(true);
  });

  it("cuenta import nombrado, alias, namespace, import() dinámico, auto-llamada y const exportada", () => {
    for (const n of ["used", "viaAlias", "viaNamespace", "viaDynamic", "selfCalled", "arrow"]) {
      expect(has(n), n).toBe(true);
    }
    expect(callers.get("lib/acts.ts#used")).toEqual(["components/a.tsx"]);
    expect(callers.get("lib/acts.ts#selfCalled")).toEqual(["lib/acts.ts"]);
  });

  it("NO cuenta comentarios, `typeof` en tipos, nombres de propiedad, la recursión propia ni los tests", () => {
    for (const n of ["onlyComment", "onlyTypeof", "onlyProp", "recursive", "caller"]) {
      expect(has(n), n).toBe(false);
    }
  });

  it("(c) detecta un `-internal.ts` sin `import \"server-only\"` (y no se engaña con un import con cláusula)", () => {
    const src: Sources = new Map([
      ["lib/ok-internal.ts", `import "server-only";\nexport const a = 1;`],
      ["lib/sub/bad-internal.ts", `import { x } from "server-only";\nexport const b = 1;`],
      ["lib/also-bad-internal.ts", `// import "server-only";\nexport const c = 1;`],
      ["app/x-internal.ts", `export const d = 1;`],
    ]);
    expect(internalWithoutServerOnly(src)).toEqual(["lib/also-bad-internal.ts", "lib/sub/bad-internal.ts"]);
  });
});

describe("[HD-1] superficie RPC de los `\"use server\"` del árbol", () => {
  const sources = loadTree();
  const callers = computeCallers(sources, () => true);
  const noCaller = [...callers].filter(([, c]) => c.length === 0).map(([k]) => k).sort();

  it("el análisis ve el árbol real (controles positivos)", () => {
    // Si estos se rompen, el guard dejó de ver el árbol y todo lo de abajo sería un verde falso.
    const modules = new Set([...callers.keys()].map((k) => k.split("#")[0]));
    expect(modules.size).toBeGreaterThan(50);
    expect(modules.has("lib/bookings.ts")).toBe(true);
    expect(modules.has("lib/notifications.ts")).toBe(true);
    expect(callers.get("lib/bookings.ts#listAgendaBookings")!.length).toBeGreaterThan(0);
    expect(callers.get("lib/notifications.ts#listNotifications")).toContain("components/dashboard/notifications-bell.tsx");
  });

  it("(a) todo export de un `\"use server\"` tiene llamador no-test o está en el allowlist", () => {
    const missing = noCaller.filter((k) => !(k in ALLOWLIST));
    expect(missing, "exports sin llamador: sumalos al ALLOWLIST con su motivo, o borralos").toEqual([]);
  });

  it("(b) el allowlist no se pudre: cada entrada existe, sigue sin llamadores y tiene motivo ≥20 caracteres", () => {
    const stale = Object.keys(ALLOWLIST).filter((k) => !callers.has(k));
    expect(stale, "entradas cuyo export ya no existe").toEqual([]);
    const nowCalled = Object.keys(ALLOWLIST)
      .filter((k) => (callers.get(k) ?? []).length > 0)
      .map((k) => `${k} ← ${callers.get(k)!.join(", ")}`);
    expect(nowCalled, "entradas que ya tienen llamador: sacalas del allowlist").toEqual([]);
    const short = Object.entries(ALLOWLIST)
      .filter(([, reason]) => reason.trim().length < 20)
      .map(([k]) => k);
    expect(short).toEqual([]);
  });

  it("(c) todo `lib/**/*-internal.ts` lleva `import \"server-only\"`", () => {
    expect(internalWithoutServerOnly(sources)).toEqual([]);
  });

  it("(b') `getDayCounts` e `isReminderDismissed` ya no son exports", () => {
    expect(callers.has("lib/bookings.ts#getDayCounts")).toBe(false);
    expect(callers.has("lib/notifications.ts#isReminderDismissed")).toBe(false);
  });
});
