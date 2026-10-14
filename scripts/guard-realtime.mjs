#!/usr/bin/env node
/**
 * Guard estático de la Sala de Espera en tiempo real (SV08, plan §18.9).
 *
 * Por qué existe: SV publica cada cambio de turno por un canal Broadcast privado
 * (`tenant:<id>:agenda`). Lo que protege ese canal y lo que garantiza que todos
 * los write-paths avisen vive repartido en SQL, en `lib/env.ts`, en los
 * drivers del cliente y en cada action. Un cambio chico en cualquiera de esos
 * lugares (una policy `FOR ALL`, un `SECURITY DEFINER`, un `NEXT_PUBLIC_` en el
 * secreto, un write-path nuevo que no llama al hook, un import estático de
 * realtime-js) rompe la seguridad o la «una sola realidad» de la sala sin que
 * ningún test lo note. Este script lo hace fallar en `guard:isolation`.
 *
 * Reglas (cada falla con `archivo:línea` y exit 1):
 *   (a) policy de `realtime.messages`: después de reproducir TODAS las
 *       migraciones (CREATE/DROP en orden), exactamente una; FOR SELECT, TO
 *       authenticated, USING con `public.kinesoft_realtime_can_read(realtime.topic()`
 *       y `extension = 'broadcast'`, sin WITH CHECK. Cualquier CREATE POLICY …
 *       ON realtime.messages con FOR INSERT|UPDATE|DELETE|ALL o sin FOR (= ALL)
 *       falla, aunque una migración posterior la borre (nunca tuvo que existir).
 *       Cualquier ALTER POLICY sobre realtime.messages falla (cambiaría la
 *       policy por fuera de este análisis).
 *   (b) `public.kinesoft_realtime_can_read(topic text, claims jsonb)`: definida
 *       una sola vez, LANGUAGE sql, IMMUTABLE, SET search_path, sin SECURITY
 *       DEFINER; ningún GRANT sobre ella a anon/authenticated (complementa el 3c
 *       de guard-tenant-isolation, que mira cualquier GRANT); ningún ALTER
 *       FUNCTION que la vuelva SECURITY DEFINER.
 *   (c) «todo write-path de Booking emite»: W = archivos de `lib/**` que
 *       escriben `Booking` con el cliente de Prisma. Todo archivo `"use server"`
 *       que está en W o importa de un archivo de W algún `\w+InTx` tiene que
 *       llamar `afterBookingsCommitted(` (o un wrapper post-commit que lo llama,
 *       detectado acá mismo). Además, los archivos de W que no son
 *       `*-internal`/`*-core` ni `"use server"` (hoy: el webhook de MP,
 *       `lib/mercadopago.ts`) también tienen que emitir: §18.1 lo lista entre los
 *       write-paths que no pasaban por el hook.
 *   (d) secretos: ninguna clave JWT/SECRET/SERVICE_ROLE de `lib/env.ts` con
 *       prefijo NEXT_PUBLIC_; `SUPABASE_JWT_SECRET`/`SUPABASE_SERVICE_ROLE_KEY`
 *       no aparecen en `components/**`, `app/**\/*.tsx` ni en los drivers del
 *       cliente; el publisher y el firmador del token llevan `import
 *       "server-only"`; ningún `console.log(` ni `logger.*(…token|secret|
 *       serviceKey…)` en `lib/realtime-*.ts` y `app/api/realtime/**`.
 *   (e) `@supabase/realtime-js` solo con `import(` dinámico y solo en
 *       `lib/realtime-client-supabase.ts` (así no entra a ningún first-load).
 *
 * Node puro, sin dependencias. Uso: node scripts/guard-realtime.mjs
 * (`npm run guard:isolation` lo corre después del guard de aislamiento).
 * `GUARD_REALTIME_ROOT=<dir>` lo corre sobre otra copia del árbol (así se
 * prueba cada regla por mutación sin tocar el repo).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.GUARD_REALTIME_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(ROOT, "prisma", "migrations");

const RED = (s) => `\x1b[31m${s}\x1b[0m`;
const GREEN = (s) => `\x1b[32m${s}\x1b[0m`;

let failures = 0;
function report(rule, title, items) {
  if (items.length) {
    failures += items.length;
    console.error(RED(`✗ (${rule}) ${title}:`));
    for (const it of items) console.error(`    ${it}`);
  } else {
    console.log(GREEN(`✓ (${rule}) ${title}.`));
  }
}

const rel = (abs) => relative(ROOT, abs).split(sep).join("/");
const lineAt = (text, idx) => text.slice(0, idx).split("\n").length;

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

/** SQL sin comentarios `-- …` (conserva los saltos de línea para reportar la línea real). */
const stripSqlComments = (sql) => sql.replace(/--[^\n]*/g, "");

/**
 * TS/JS sin comentarios, conservando strings y saltos de línea. No es un parser
 * completo (regex literales con `//` adentro serían un falso comentario), pero
 * alcanza para el código de este repo; un `//` dentro de un string (URLs) NO se
 * toma como comentario, que era el error del strip ingenuo.
 */
function stripTsComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      out += c;
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === "\\") {
          out += src[i] + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += src[i];
        i++;
      }
      if (i < n) out += src[i];
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// ── Migraciones, en orden de timestamp ───────────────────────────────────────
const migrations = (existsSync(MIGRATIONS_DIR) ? readdirSync(MIGRATIONS_DIR) : [])
  .filter((d) => /^\d{14}_/.test(d) && statSync(join(MIGRATIONS_DIR, d)).isDirectory())
  .sort()
  .map((d) => join(MIGRATIONS_DIR, d, "migration.sql"))
  .filter((f) => existsSync(f))
  .map((f) => ({ file: rel(f), sql: stripSqlComments(readFileSync(f, "utf8")) }));

// ── (a) policy de realtime.messages ──────────────────────────────────────────
{
  const bad = [];
  const TARGET = String.raw`"?realtime"?\s*\.\s*"?messages"?`;
  // El cuerpo de la policy termina en `;` o en el cierre del dollar-quote del
  // EXECUTE (`$p$` en M5): así funciona con la forma directa y la guardada.
  const createRe = new RegExp(String.raw`CREATE\s+POLICY\s+"?(\w+)"?\s+ON\s+${TARGET}(?![\w"])([\s\S]*?)(?=;|\$\w*\$)`, "gi");
  const dropRe = new RegExp(String.raw`DROP\s+POLICY\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?\s+ON\s+${TARGET}(?![\w"])`, "gi");
  const alterRe = new RegExp(String.raw`ALTER\s+POLICY\s+"?(\w+)"?\s+ON\s+${TARGET}(?![\w"])`, "gi");
  /** @type {Map<string, {body: string, where: string}>} */
  const live = new Map();
  for (const { file, sql } of migrations) {
    const events = [];
    for (const m of sql.matchAll(createRe)) events.push({ at: m.index, kind: "create", name: m[1], body: m[2] });
    for (const m of sql.matchAll(dropRe)) events.push({ at: m.index, kind: "drop", name: m[1] });
    for (const m of sql.matchAll(alterRe)) events.push({ at: m.index, kind: "alter", name: m[1] });
    events.sort((x, y) => x.at - y.at);
    for (const ev of events) {
      const where = `${file}:${lineAt(sql, ev.at)}`;
      if (ev.kind === "drop") {
        live.delete(ev.name);
      } else if (ev.kind === "alter") {
        bad.push(`${where}  ALTER POLICY ${ev.name} ON realtime.messages: cambiala con DROP + CREATE (este guard no sigue ALTER)`);
      } else {
        const cmd = ev.body.match(/\bFOR\s+(ALL|SELECT|INSERT|UPDATE|DELETE)\b/i)?.[1]?.toUpperCase();
        if (cmd !== "SELECT") {
          bad.push(`${where}  CREATE POLICY ${ev.name} ON realtime.messages ${cmd ? `FOR ${cmd}` : "sin FOR (= ALL)"}: solo FOR SELECT (ningún cliente publica)`);
        }
        live.set(ev.name, { body: ev.body, where });
      }
    }
  }
  if (live.size !== 1) {
    bad.push(
      `después de reproducir las migraciones hay ${live.size} policies en realtime.messages (${[...live.keys()].join(", ") || "ninguna"}); tiene que haber exactamente una`
    );
  }
  for (const [name, { body, where }] of live) {
    const flat = body.replace(/\s+/g, " ");
    if (!/\bFOR\s+SELECT\b/i.test(flat)) bad.push(`${where}  ${name}: no es FOR SELECT`);
    const roles = flat.match(/\bTO\s+([\w\s,"]+?)\s+USING\b/i)?.[1]?.replace(/"/g, "").split(/\s*,\s*/) ?? [];
    if (roles.length !== 1 || roles[0].toLowerCase() !== "authenticated") {
      bad.push(`${where}  ${name}: tiene que ser TO authenticated (y solo ese rol); tiene TO ${roles.join(", ") || "(ninguno = PUBLIC)"}`);
    }
    if (!/public\.kinesoft_realtime_can_read\s*\(\s*realtime\.topic\(\)/i.test(flat)) {
      bad.push(`${where}  ${name}: el USING no llama public.kinesoft_realtime_can_read(realtime.topic(), …)`);
    }
    if (!/(?:\brealtime\.messages\.)?\bextension\s*=\s*'broadcast'/i.test(flat)) {
      bad.push(`${where}  ${name}: el USING no restringe extension = 'broadcast'`);
    }
    if (/\bWITH\s+CHECK\b/i.test(flat)) bad.push(`${where}  ${name}: tiene WITH CHECK (la policy es de lectura)`);
  }
  report("a", "policy de realtime.messages: una, FOR SELECT TO authenticated, USING con el predicado y broadcast, sin WITH CHECK", bad);
}

// ── (b) función kinesoft_realtime_can_read ──────────────────────────────────
{
  const bad = [];
  const defRe = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?public"?\s*\.\s*)?"?kinesoft_realtime_can_read"?\s*\(([^)]*)\)([\s\S]*?)\bAS\s+\$/gi;
  const defs = [];
  for (const { file, sql } of migrations) {
    for (const m of sql.matchAll(defRe)) {
      const where = `${file}:${lineAt(sql, m.index)}`;
      defs.push(where);
      const args = m[1].replace(/\s+/g, " ").trim().toLowerCase();
      if (args !== "topic text, claims jsonb") bad.push(`${where}  firma (${m[1].trim()}): tiene que ser (topic text, claims jsonb)`);
      if (!/^\s*public\s*\./i.test(m[0].replace(/^[\s\S]*?FUNCTION\s+/i, "").replace(/"/g, ""))) {
        bad.push(`${where}  la función tiene que estar calificada como public.kinesoft_realtime_can_read`);
      }
      const head = m[2];
      if (!/\bLANGUAGE\s+sql\b/i.test(head)) bad.push(`${where}  falta LANGUAGE sql`);
      if (!/\bIMMUTABLE\b/i.test(head)) bad.push(`${where}  falta IMMUTABLE`);
      if (!/\bSET\s+search_path\b/i.test(head)) bad.push(`${where}  falta SET search_path`);
      if (/\bSECURITY\s+DEFINER\b/i.test(head)) bad.push(`${where}  SECURITY DEFINER prohibido (correría con el rol del dueño)`);
    }
    // Por sentencia (`;`), como el 3c: GRANT sobre la función a los roles de la Data API.
    let offset = 0;
    for (const stmt of sql.split(";")) {
      if (/kinesoft_realtime_can_read/i.test(stmt)) {
        const where = `${file}:${lineAt(sql, offset + stmt.search(/\S|$/))}`;
        const g = stmt.match(/\bGRANT\b[\s\S]*?\bTO\b([\s\S]*)/i);
        if (g && /\b(anon|authenticated)\b/i.test(g[1])) {
          bad.push(`${where}  GRANT sobre kinesoft_realtime_can_read a anon/authenticated (se nombra PUBLIC a propósito)`);
        }
        if (/\bALTER\s+FUNCTION\b/i.test(stmt) && /\bSECURITY\s+DEFINER\b/i.test(stmt)) {
          bad.push(`${where}  ALTER FUNCTION … SECURITY DEFINER sobre kinesoft_realtime_can_read`);
        }
      }
      offset += stmt.length + 1;
    }
  }
  if (defs.length !== 1) {
    bad.push(`CREATE FUNCTION public.kinesoft_realtime_can_read aparece ${defs.length} veces (${defs.join(", ") || "ninguna"}); tiene que ser exactamente una`);
  }
  report("b", "public.kinesoft_realtime_can_read: una definición, sql IMMUTABLE con search_path, sin SECURITY DEFINER ni GRANT a anon/authenticated", bad);
}

// ── Código TS: lectura compartida por (c), (d) y (e) ─────────────────────────
const tsFiles = (dir) => walk(join(ROOT, dir)).filter((f) => /\.(ts|tsx|mts|mjs|js)$/.test(f) && !f.endsWith(".d.ts"));
/** @type {Map<string, {raw: string, code: string}>} */
const srcCache = new Map();
function source(abs) {
  let s = srcCache.get(abs);
  if (!s) {
    const raw = readFileSync(abs, "utf8");
    s = { raw, code: stripTsComments(raw) };
    srcCache.set(abs, s);
  }
  return s;
}
const isUseServer = (code) => /^\s*["']use server["']/.test(code);

// ── (c) todo write-path de Booking emite ─────────────────────────────────────
{
  const bad = [];
  // `upsert` y `createManyAndReturn` se suman a la lista de §18.9: el alta de
  // un turno (`bookings.ts`) y la del motor de planes (`plans-engine-internal`)
  // escriben así; sin ellos W no contenía esos archivos por ESAS escrituras.
  // Cualquier receptor (`tx`, `prisma`, `prismaService`, `db`…): solo se
  // escanea lib/, donde `.booking.<op>(` es siempre el delegate de Prisma.
  const WRITE = /\b\w+\.booking\.(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)\(/;
  // Exentos por nombre (§18.9): devuelven refs y nunca emiten adentro de la tx.
  const isInternalOrCore = (r) => /-(internal|core)\.ts$/.test(r);
  // Allowlist comentada, por (archivo, nombres `*InTx` importados). Cubre SOLO
  // esos imports: si el archivo importa otro `*InTx` de W, o pasa a escribir
  // Booking él mismo, vuelve a fallar.
  //   - lib/plan-templates.ts: importa `validatePlanRefsInTx` (C8, valida que
  //     servicio/sede/profesional/ejercicios sean del consultorio) para crear y
  //     editar PLANTILLAS; no escribe ni toca ningún Booking, no hay turno que
  //     avisar.
  // No hacen falta (§18.9 los preveía): `lib/programs.ts` (no importa `*InTx`
  // de W; delega en plans-lifecycle-internal y emite por `afterLifecycleCommit`)
  // ni `lib/plans-adopt.ts` (emite por `afterAdoptCommit`): los wrappers
  // post-commit se detectan abajo y se verifica que llamen al hook.
  /** @type {Map<string, {names: string[], why: string}>} */
  const ALLOW = new Map([
    ["lib/plan-templates.ts", { names: ["validatePlanRefsInTx"], why: "valida refs de una plantilla; no escribe Booking" }],
  ]);

  const libFiles = tsFiles("lib").filter((f) => /\.tsx?$/.test(f));
  const W = new Map(); // rel → primera línea de escritura
  for (const f of libFiles) {
    const { code } = source(f);
    const m = WRITE.exec(code);
    if (m) W.set(rel(f), lineAt(code, m.index));
  }

  // Wrappers post-commit: funciones exportadas de lib/ llamadas `after…`
  // (convención del repo: `afterAdoptCommit`, `afterLifecycleCommit`) cuyo
  // cuerpo llama `afterBookingsCommitted(`. Solo `after…`: si contara cualquier
  // action que emite (`createBooking`, `updateBooking`…), un archivo que solo
  // LLAMA a una de ellas pasaría aunque su propia escritura no emita. El cuerpo
  // es desde la declaración hasta la primera `}` en la columna 0 (prettier).
  const wrappers = new Set();
  for (const f of libFiles) {
    if (rel(f) === "lib/booking-events-internal.ts") continue;
    const { code } = source(f);
    for (const m of code.matchAll(/^export\s+async\s+function\s+(after\w+)\s*\(/gm)) {
      const end = code.indexOf("\n}", m.index);
      const body = code.slice(m.index, end === -1 ? undefined : end);
      if (/\bafterBookingsCommitted\(/.test(body)) wrappers.add(m[1]);
    }
  }
  const emitRe = new RegExp(String.raw`\b(?:afterBookingsCommitted${[...wrappers].map((w) => `|${w}`).join("")})\(`);

  const importRe = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']@\/(lib\/[\w./-]+)["']/g;
  /** Imports de VALOR `*InTx` (no `import type` ni `{ type X }`: no ejecutan nada). */
  const inTxImports = (code) =>
    [...code.matchAll(importRe)]
      .filter((m) => !m[1])
      .map((m) => ({
        from: `${m[3]}${m[3].endsWith(".ts") ? "" : ".ts"}`,
        line: lineAt(code, m.index),
        names: m[2]
          .split(",")
          .map((s) => s.trim())
          .filter((s) => !s.startsWith("type ") && /^\w+InTx$/.test(s.split(/\s+as\s+/)[0]))
          .map((s) => s.split(/\s+as\s+/)[0]),
      }))
      .filter((i) => i.names.length);

  // Clausura (desvío conservador de §18.9, que mira un solo nivel): un
  // `*-internal` que importa `*InTx` de W también escribe Booking a través de
  // ellos (p. ej. plans-lifecycle-internal → cancelBookingsInTx), así que entra
  // a W* y sus importadores `"use server"` (patients.ts) se verifican igual.
  // Los `"use server"` no propagan: son los que tienen que emitir.
  const Wstar = new Map([...W].map(([k, v]) => [k, `escribe Booking (línea ${v})`]));
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of libFiles) {
      const r = rel(f);
      const { code } = source(f);
      if (Wstar.has(r) || isUseServer(code)) continue;
      const hit = inTxImports(code).find((i) => Wstar.has(i.from));
      if (hit) {
        Wstar.set(r, `importa ${hit.names.join(", ")} de ${hit.from} (línea ${hit.line})`);
        grew = true;
      }
    }
  }

  const checked = [];
  for (const f of libFiles) {
    const r = rel(f);
    const { code } = source(f);
    const useServer = isUseServer(code);
    const inW = W.has(r);
    let reason = null;
    if (useServer && inW) reason = `escribe Booking (línea ${W.get(r)})`;
    if (useServer && !reason) {
      const allowed = ALLOW.get(r)?.names ?? [];
      for (const i of inTxImports(code)) {
        if (!Wstar.has(i.from)) continue;
        const uncovered = i.names.filter((n) => !allowed.includes(n));
        if (uncovered.length) {
          reason = `importa ${uncovered.join(", ")} de ${i.from} (línea ${i.line})`;
          break;
        }
      }
    }
    // Write-path en W que no es action ni interno (el webhook de MP).
    if (!useServer && Wstar.has(r) && !isInternalOrCore(r)) reason = `${Wstar.get(r)} fuera de un *-internal/*-core`;
    if (!reason) continue;
    checked.push(r);
    if (!emitRe.test(code)) {
      bad.push(`${r}:${reason.match(/línea (\d+)/)?.[1] ?? 1}  ${reason}, pero no llama afterBookingsCommitted( (ni un wrapper post-commit)`);
    }
  }
  console.log(
    `  W (${W.size}): ${[...W.keys()].sort().join(", ")}\n  W* (clausura, +${Wstar.size - W.size}): ${[...Wstar.keys()].filter((k) => !W.has(k)).sort().join(", ") || "—"}\n  wrappers post-commit: ${[...wrappers].sort().join(", ") || "ninguno"}\n  verificados (${checked.length}): ${checked.sort().join(", ")}`
  );
  report("c", "todo write-path de Booking llama afterBookingsCommitted después del commit", bad);
}

// ── (d) secretos ─────────────────────────────────────────────────────────────
{
  const bad = [];
  const SECRET_NAMES = /\b(SUPABASE_JWT_SECRET|SUPABASE_SERVICE_ROLE_KEY)\b/g;
  // Allowlist comentada: (archivo, texto exacto de la línea que lo menciona).
  // users-panel: es COPY para el admin («Configurá SUPABASE_SERVICE_ROLE_KEY en
  // el server…»): el nombre de la variable dentro de un string, no una lectura
  // de `process.env`/`env.` (que en un componente cliente valdría undefined
  // igual). Cualquier otra mención en ese archivo sigue fallando.
  const NAME_ALLOW = [["components/configuracion/panels/users-panel.tsx", "Configurá SUPABASE_SERVICE_ROLE_KEY en el server"]];

  const envFile = join(ROOT, "lib", "env.ts");
  if (existsSync(envFile)) {
    const { code } = source(envFile);
    for (const m of code.matchAll(/\bNEXT_PUBLIC_\w*(?:JWT|SECRET|SERVICE_ROLE)\w*/g)) {
      bad.push(`lib/env.ts:${lineAt(code, m.index)}  ${m[0]}: un secreto con prefijo NEXT_PUBLIC_ viaja al bundle del cliente`);
    }
  } else {
    bad.push("lib/env.ts no existe");
  }

  const clientFiles = [
    ...tsFiles("components"),
    ...tsFiles("app").filter((f) => f.endsWith(".tsx")),
    ...tsFiles("lib").filter((f) => /\/realtime-client-[^/]*\.ts$/.test(f)),
  ];
  for (const f of clientFiles) {
    const r = rel(f);
    const { code } = source(f);
    const lines = code.split("\n");
    for (const m of code.matchAll(SECRET_NAMES)) {
      const ln = lineAt(code, m.index);
      if (NAME_ALLOW.some(([af, txt]) => af === r && lines[ln - 1].includes(txt))) continue;
      bad.push(`${r}:${ln}  ${m[1]} en código de cliente`);
    }
  }

  for (const r of ["lib/realtime-token-internal.ts", "lib/realtime-publisher-internal.ts"]) {
    const f = join(ROOT, r);
    if (!existsSync(f)) {
      bad.push(`${r} no existe`);
      continue;
    }
    if (!/^\s*import\s+["']server-only["'];?/m.test(source(f).code)) bad.push(`${r}:1  falta import "server-only"`);
  }

  const logScope = [
    ...tsFiles("lib").filter((f) => /\/lib\/realtime-[^/]*\.ts$/.test(f.split(sep).join("/"))),
    ...tsFiles(join("app", "api", "realtime")),
  ];
  for (const f of logScope) {
    const r = rel(f);
    const { code } = source(f);
    for (const m of code.matchAll(/\bconsole\.log\(/g)) bad.push(`${r}:${lineAt(code, m.index)}  console.log( en código realtime`);
    for (const m of code.matchAll(/\blogger\.\w+\([^)]*\b(token|secret|serviceKey)\b/g)) {
      bad.push(`${r}:${lineAt(code, m.index + m[0].length - m[1].length)}  logger con «${m[1]}» en los argumentos`);
    }
  }
  report("d", "secretos: sin NEXT_PUBLIC_, fuera del cliente, server-only, sin console.log ni token/secret en logs", bad);
}

// ── (e) @supabase/realtime-js solo dinámico y solo en el driver ─────────────
{
  const bad = [];
  const ONLY = "lib/realtime-client-supabase.ts";
  let dynamicInDriver = 0;
  for (const f of [...tsFiles("lib"), ...tsFiles("app"), ...tsFiles("components"), ...tsFiles("hooks")]) {
    const r = rel(f);
    const { code } = source(f);
    for (const m of code.matchAll(/["']@supabase\/realtime-js(?:\/[^"']*)?["']/g)) {
      const before = code.slice(Math.max(0, m.index - 40), m.index);
      const dynamic = /\bimport\s*\(\s*$/.test(before);
      const ln = lineAt(code, m.index);
      if (r !== ONLY) bad.push(`${r}:${ln}  @supabase/realtime-js fuera de ${ONLY}`);
      else if (!dynamic) bad.push(`${r}:${ln}  @supabase/realtime-js con import estático (tiene que ser import( dinámico)`);
      // Solo cuenta como «el driver la carga» un `await import(` real: el
      // `typeof import("…")` de tipos (también válido para la regla) se borra al compilar.
      else if (/\bawait\s+import\s*\(\s*$/.test(before)) dynamicInDriver++;
    }
  }
  if (existsSync(join(ROOT, ONLY)) && dynamicInDriver === 0) {
    bad.push(`${ONLY}: no tiene ningún await import("@supabase/realtime-js") (¿se movió el driver?)`);
  }
  report("e", "@supabase/realtime-js solo con import( dinámico en lib/realtime-client-supabase.ts", bad);
}

if (failures) {
  console.error(RED(`\nguard-realtime: ${failures} falla(s).`));
  process.exit(1);
}
console.log(GREEN("guard-realtime: OK."));
