#!/usr/bin/env node
/**
 * PF-0a · TTFB y tiempo total de las páginas del workspace contra `next start` local (H-SLOW, plan §20.4).
 *
 * Uso (siempre con el Docker local; el script se niega si DATABASE_URL no es localhost):
 *
 *   npx dotenv -e .env.local -- node scripts/perf/ttfb.mjs [--no-build] [--auth-latency=0] [--db-rtt=0] [--runs=5]
 *     [--json=out.json] [--log=server.log]
 *
 *   --auth-latency=ms  demora del GoTrue falso por `getUser()` (≈ RTT + proceso de GoTrue en prod).
 *   --db-rtt=ms        ida y vuelta simulada a Postgres: un proxy TCP en 127.0.0.1:5499 demora cada paquete
 *                      rtt/2 en cada sentido. Con esto el wall-clock incluye el camino crítico real (las tx en
 *                      paralelo se solapan, las en serie se suman), que el conteo de round-trips solo no da.
 *
 * Qué hace:
 *   1. Levanta un GoTrue FALSO en 127.0.0.1:3199 (solo `GET /auth/v1/user`, con `--auth-latency` ms de demora para
 *      simular la ida y vuelta real a Supabase Auth; todo lo demás → 200 `{}`). Por qué no el actor demo
 *      (`KINESOFT_ALLOW_DEMO_ACTOR=1`): `lib/session.ts` lo habilita solo con `NODE_ENV !== "production"` y `next
 *      start` corre en production, así que con el demo `next start` no tiene sesión. Con el GoTrue falso el camino es
 *      el REAL de prod: middleware con cookie `sb-…` → `getUser()` HTTP → membresías → actor.
 *   2. `next build` + `next start -p 3100` con `PERF_TIMING=1` y las URLs de Supabase pisadas por el GoTrue falso
 *      (así el `.env`, que puede apuntar a PRODUCCIÓN, no aporta ninguna clave: las 7 que tiene se pisan acá).
 *   3. Para cada ruta: 1 request de calentamiento (se descarta) + `--runs` medidos, en serie. TTFB = hasta los
 *      headers; total = hasta el último byte. Junta la línea `[perf]` que imprime `lib/server-timing.ts` de cada
 *      request y el `Server-Timing: mw-session` del middleware.
 *   4. Una server action de lectura típica (`listAgendaBookings`, la navegación de semana de la agenda) invocada como
 *      lo hace el cliente (POST con `Next-Action`), si se encuentra su id en el build.
 *
 * No escribe en la base (solo lecturas: GET de páginas y una action de lectura). No corre seeds.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createTcpServer, connect as tcpConnect } from "node:net";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  })
);
const PORT = Number(args.port ?? 3100);
const AUTH_PORT = 3199;
const RUNS = Number(args.runs ?? 5);
const AUTH_LATENCY = Number(args["auth-latency"] ?? 0);
const DB_RTT = Number(args["db-rtt"] ?? 0);
const DB_PROXY_PORT = 5499;
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Guardas -------------------------------------------------------------------------------------------------
function isLocalDb(u) {
  try {
    const h = new URL(u).hostname;
    return h === "localhost" || h === "127.0.0.1";
  } catch {
    return false;
  }
}
if (!isLocalDb(process.env.DATABASE_URL) || !isLocalDb(process.env.DIRECT_URL ?? process.env.DATABASE_URL)) {
  console.error("ttfb: DATABASE_URL/DIRECT_URL no son locales. Correlo con `npx dotenv -e .env.local -- …`. Nada hecho.");
  process.exit(2);
}

// --- Datos del Docker local (solo lectura) ---------------------------------------------------------------------
const { PrismaClient } = await import("@prisma/client");
const db = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } } });
const slug = args.tenant ?? "movare";
const tenant = await db.tenant.findFirst({ where: { slug }, select: { id: true, slug: true } });
if (!tenant) {
  console.error(`ttfb: no hay tenant «${slug}» en el Docker local.`);
  process.exit(2);
}
const member = await db.membership.findFirst({
  where: { tenantId: tenant.id, acceptedAt: { not: null }, disabledAt: null, role: { in: ["OWNER", "ADMIN", "PRACTITIONER"] } },
  orderBy: { role: "asc" },
  select: { userId: true, role: true, user: { select: { email: true, fullName: true } } },
});
const patient = await db.patient.findFirst({ where: { tenantId: tenant.id }, select: { id: true } });
const counts = {
  patients: await db.patient.count({ where: { tenantId: tenant.id } }),
  bookings: await db.booking.count({ where: { tenantId: tenant.id } }),
};
await db.$disconnect();
if (!member) {
  console.error("ttfb: el tenant no tiene un miembro clínico aceptado.");
  process.exit(2);
}

// --- GoTrue falso ------------------------------------------------------------------------------------------------
const authUser = {
  id: member.userId,
  aud: "authenticated",
  role: "authenticated",
  email: member.user.email,
  email_confirmed_at: "2026-01-01T00:00:00Z",
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: { full_name: member.user.fullName ?? "Perf" },
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};
let authCalls = 0;
const authServer = createServer(async (req, res) => {
  if (req.url?.startsWith("/auth/v1/user")) {
    authCalls += 1;
    if (AUTH_LATENCY) await sleep(AUTH_LATENCY);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(authUser));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
});
await new Promise((r) => authServer.listen(AUTH_PORT, "127.0.0.1", r));

const b64url = (s) => Buffer.from(s).toString("base64url");
const nowS = Math.floor(Date.now() / 1000);
const jwt = [
  b64url(JSON.stringify({ alg: "HS256", typ: "JWT" })),
  b64url(JSON.stringify({ sub: member.userId, aud: "authenticated", role: "authenticated", email: member.user.email, iat: nowS, exp: nowS + 86400, session_id: "perf" })),
  b64url("perf-signature"),
].join(".");
const session = {
  access_token: jwt,
  token_type: "bearer",
  expires_in: 86400,
  expires_at: nowS + 86400,
  refresh_token: "perf-refresh",
  user: authUser,
};
// Storage key de supabase-js: `sb-<primer label del host>-auth-token` → para 127.0.0.1 es `sb-127-auth-token`.
const cookie = [
  `sb-127-auth-token=base64-${b64url(JSON.stringify(session))}`,
  `kine_tenant=${tenant.id}`,
].join("; ");

// --- Proxy TCP con latencia hacia el Postgres local ---------------------------------------------------------------
/**
 * Demora constante por sentido (rtt/2): preserva el orden de los bytes y no limita el ancho de banda. Modela una red
 * con RTT fijo, sin jitter; alcanza para ver cuánto pesa la cantidad de idas y vueltas EN SERIE.
 */
function withDbProxy(url) {
  if (!DB_RTT || !url) return url;
  const u = new URL(url);
  u.hostname = "127.0.0.1";
  u.port = String(DB_PROXY_PORT);
  return u.toString();
}
let dbProxy = null;
if (DB_RTT) {
  const target = new URL(process.env.DIRECT_URL ?? process.env.DATABASE_URL);
  const half = DB_RTT / 2;
  const pipeDelayed = (from, to) =>
    from.on("data", (chunk) => setTimeout(() => to.writable && to.write(chunk), half));
  dbProxy = createTcpServer((client) => {
    const upstream = tcpConnect(Number(target.port || 5432), target.hostname);
    pipeDelayed(client, upstream);
    pipeDelayed(upstream, client);
    const end = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", end).on("close", () => setTimeout(end, half));
    upstream.on("error", end).on("close", () => setTimeout(end, half));
  });
  await new Promise((r) => dbProxy.listen(DB_PROXY_PORT, "127.0.0.1", r));
}

// --- Build + start ----------------------------------------------------------------------------------------------
const childEnv = {
  ...process.env,
  NODE_ENV: "production",
  PERF_TIMING: "1",
  // Con latencia alta, abrir una conexión pasa los 150 ms sin marcas: que la línea no salga partida.
  PERF_TIMING_IDLE_MS: String(Math.max(150, 8 * DB_RTT + AUTH_LATENCY)),
  NEXT_TELEMETRY_DISABLED: "1",
  NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${AUTH_PORT}`,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "perf-anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "perf-service-key",
  NEXT_PUBLIC_APP_URL: BASE,
  REALTIME_DRIVER: "off",
  EMAIL_TRANSPORT: "log",
  KINESOFT_ALLOW_DEMO_ACTOR: "0",
  DATABASE_URL: withDbProxy(process.env.DATABASE_URL),
  ...(process.env.DIRECT_URL ? { DIRECT_URL: withDbProxy(process.env.DIRECT_URL) } : {}),
  ...(process.env.DATABASE_URL_SERVICE ? { DATABASE_URL_SERVICE: withDbProxy(process.env.DATABASE_URL_SERVICE) } : {}),
};

function run(cmd, argv) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, argv, { cwd: ROOT, env: childEnv, stdio: ["ignore", "inherit", "inherit"] });
    p.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`${cmd} ${argv.join(" ")} → ${code}`))));
  });
}

if (args["no-build"] !== "1") {
  console.log("ttfb: next build (PERF_TIMING=1)…");
  await run("npx", ["next", "build"]);
}

const perfLines = [];
const server = spawn("npx", ["next", "start", "-p", String(PORT)], { cwd: ROOT, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
const onOut = (buf) => {
  const s = buf.toString();
  serverLog += s;
  for (const line of s.split("\n")) {
    const i = line.indexOf("[perf] ");
    if (i >= 0) {
      try {
        perfLines.push(JSON.parse(line.slice(i + 7)));
      } catch {
        /* línea cortada: se ignora */
      }
    }
  }
};
server.stdout.on("data", onOut);
server.stderr.on("data", onOut);
const shutdown = () => {
  try {
    server.kill("SIGTERM");
  } catch {}
  authServer.close();
  dbProxy?.close();
};
process.on("exit", shutdown);

for (let i = 0; i < 120; i++) {
  try {
    const r = await fetch(`${BASE}/login`, { redirect: "manual" });
    if (r.status < 500) break;
  } catch {}
  await sleep(500);
}

// --- Medición ---------------------------------------------------------------------------------------------------
async function timed(url, init = {}) {
  const t0 = performance.now();
  const res = await fetch(url, { redirect: "manual", ...init, headers: { cookie, ...(init.headers ?? {}) } });
  const ttfb = performance.now() - t0;
  const body = await res.arrayBuffer();
  const total = performance.now() - t0;
  const st = res.headers.get("server-timing") ?? "";
  const mw = Number((st.match(/mw-session;dur=([\d.]+)/) ?? [])[1] ?? NaN);
  return { status: res.status, location: res.headers.get("location"), ttfb, total, bytes: body.byteLength, mw };
}

async function measure(label, fn) {
  const samples = [];
  for (let i = 0; i <= RUNS; i++) {
    const before = perfLines.length;
    const authBefore = authCalls;
    const r = await fn();
    // `lib/server-timing.ts` imprime la línea tras PERF_TIMING_IDLE_MS sin actividad.
    await sleep(Math.max(150, 8 * DB_RTT + AUTH_LATENCY) + 200);
    const lines = perfLines.slice(before);
    if (i === 0) continue; // calentamiento
    samples.push({ ...r, lines, authCalls: authCalls - authBefore });
  }
  return { label, samples };
}

const median = (xs) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r1 = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : "—");

const routes = ["/dashboard", "/agenda", "/pacientes", patient ? `/pacientes/${patient.id}` : null, "/configuracion", "/sala", "/seguimiento"].filter(Boolean);
const results = [];
for (const path of routes) {
  results.push(await measure(`GET ${path}`, () => timed(`${BASE}${path}`)));
}

// --- router.refresh() --------------------------------------------------------------------------------------------
/**
 * Lo que cuesta un `router.refresh()` después de una action que ya hizo `revalidatePath` (doble render, PF-0d): un GET
 * con `RSC: 1` del árbol entero de la página (sin `Next-Router-State-Tree` el server lo renderiza completo, como un
 * refresh). Se mide en las dos páginas con más acciones.
 */
for (const path of ["/agenda", "/pacientes"]) {
  results.push(await measure(`RSC refresh ${path}`, () => timed(`${BASE}${path}`, { headers: { rsc: "1" } })));
}

// --- Server action típica (lectura) ------------------------------------------------------------------------------
/**
 * El id de una action en Next 14.2 es sha1(`<archivo relativo>:<export>`) (plugin SWC `server_actions`). Se busca
 * en `server-reference-manifest.json` el candidato que coincida; si el algoritmo cambia, se documenta como no medido.
 */
function findActionId(file, exportName) {
  const manifestPath = join(ROOT, ".next/server/server-reference-manifest.json");
  if (!existsSync(manifestPath)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const ids = new Set(Object.keys(manifest.node ?? {}));
  for (const f of [file, `./${file}`, join(ROOT, file)]) {
    const id = createHash("sha1").update(`${f}:${exportName}`).digest("hex");
    if (ids.has(id)) return { id, workers: Object.keys(manifest.node[id].workers ?? {}) };
  }
  // Fallback: el id aparece en el bundle server junto al nombre del export.
  const dir = join(ROOT, ".next/server/app");
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) stack.push(p);
      else if (p.endsWith(".js")) {
        const src = readFileSync(p, "utf8");
        if (!src.includes(exportName)) continue;
        for (const id of ids) {
          const at = src.indexOf(id);
          if (at >= 0 && src.slice(Math.max(0, at - 400), at + 400).includes(exportName)) {
            return { id, workers: Object.keys(manifest.node[id].workers ?? {}) };
          }
        }
      }
    }
  }
  return null;
}

const action = findActionId("lib/bookings.ts", "listAgendaBookings");
let actionResult = null;
if (action) {
  const from = new Date();
  from.setUTCHours(3, 0, 0, 0);
  const to = new Date(from.getTime() + 7 * 86_400_000);
  const body = JSON.stringify([{ from: from.toISOString(), to: to.toISOString() }]);
  actionResult = await measure("action listAgendaBookings (semana)", () =>
    timed(`${BASE}/agenda`, {
      method: "POST",
      headers: {
        "next-action": action.id,
        "content-type": "text/plain;charset=UTF-8",
        accept: "text/x-component",
        origin: BASE,
      },
      body,
    })
  );
  results.push(actionResult);
}

shutdown();

// --- Reporte ----------------------------------------------------------------------------------------------------
const rows = results.map(({ label, samples }) => {
  const pick = (k) => median(samples.map((s) => s[k]));
  const fromLine = (k) => median(samples.map((s) => (s.lines.length ? s.lines.reduce((a, l) => a + (l[k] ?? 0), 0) : NaN)));
  return {
    route: label,
    status: [...new Set(samples.map((s) => s.status))].join("/"),
    ttfbMs: r1(pick("ttfb")),
    totalMs: r1(pick("total")),
    kB: r1(pick("bytes") / 1024),
    mwMs: r1(pick("mw")),
    authMs: r1(fromLine("authMs")),
    accessMs: r1(fromLine("accessMs")),
    actorMs: r1(fromLine("actorMs")),
    actorCalls: median(samples.map((s) => s.lines.reduce((a, l) => a + (l.marks?.actor?.count ?? 0), 0))),
    authHttp: median(samples.map((s) => s.authCalls)),
    tx: median(samples.map((s) => s.lines.reduce((a, l) => a + (l.txCount ?? 0), 0))),
    txMs: r1(fromLine("txMs")),
    stmts: median(samples.map((s) => s.lines.reduce((a, l) => a + (l.stmtCount ?? 0), 0))),
    dbMs: r1(fromLine("dbMs")),
    roundTrips: median(samples.map((s) => s.lines.reduce((a, l) => a + (l.roundTrips ?? 0), 0))),
    spanMs: r1(fromLine("spanMs")),
    perfLines: median(samples.map((s) => s.lines.length)),
  };
});

console.log(`\nttfb: tenant ${tenant.slug} (${counts.patients} pacientes, ${counts.bookings} turnos), rol ${member.role}, ` +
  `auth-latency ${AUTH_LATENCY} ms, db-rtt ${DB_RTT} ms, mediana de ${RUNS} (1 de calentamiento descartada)`);
if (!action) console.log("ttfb: no se encontró el id de la action listAgendaBookings en el build (no medida).");
console.table(rows);
const bad = rows.filter((r) => r.status !== "200");
if (bad.length) {
  console.log("ttfb: rutas que no dieron 200 (¿sesión no reconocida?):", bad.map((r) => `${r.route} ${r.status}`).join(", "));
}
if (args.json) {
  writeFileSync(resolve(args.json), JSON.stringify({ authLatency: AUTH_LATENCY, dbRtt: DB_RTT, runs: RUNS, counts, rows, raw: results }, null, 2));
  console.log(`ttfb: crudo en ${args.json}`);
}
if (args.log) writeFileSync(resolve(args.log), serverLog);
process.exit(0);
