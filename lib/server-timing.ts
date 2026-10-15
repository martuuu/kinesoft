/**
 * PF-0a · medición de la lentitud general (H-SLOW, plan §20.4).
 *
 * Por qué existe: Martin nota lentitud en TODAS las páginas y los sospechosos (la llamada a Supabase Auth por request,
 * una tx interactiva por lectura en `runWithRls`, cantidad de queries, render) solo se pueden ordenar con números por
 * request de la app real (`next start`), no con el harness de `tests/perf` (que llama a los loaders sueltos y no ve
 * el costo de auth/actor ni el del render).
 *
 * Con `PERF_TIMING=1`:
 *   - cada request/action acumula marcas (`auth`, `access`, `actor`, `tx`, ops de Prisma con su duración);
 *   - al quedar quieto (sin tx abiertas y sin marcas por `FLUSH_IDLE_MS`) imprime UNA línea
 *     `[perf] {"route":…,"spanMs":…,"authMs":…,"actorMs":…,"txCount":…,"stmtCount":…,"dbMs":…}`;
 *   - `serverTimingHeader()` arma la cabecera `Server-Timing` para quien pueda escribir headers (hoy solo el
 *     middleware la emite, con su propio tiempo: un server component no puede setear cabeceras de respuesta).
 * Apagado (el default, y SIEMPRE en prod salvo que alguien lo prenda a mano): `PERF_ON` es `false` en la carga del
 * módulo y cada función pública sale en la primera línea, sin leer el ALS ni tomar tiempos.
 *
 * Dónde vive el acumulador: en el marco por request. Se probó el ALS de `lib/request-context.ts`, pero ese marco recién
 * se abre en `getActor()` (después de que empezó el request) y un `enterWith` hecho dentro de un layout no llega a la
 * rama async de la página (React las renderiza en paralelo), así que las tx de la página quedaban sin dueño. El
 * `requestAsyncStorage` de Next sí envuelve TODO el request (layout, página y server actions): se usa su store como
 * clave de un `WeakMap` (no se escribe nada en él). Fuera de Next (unit tests, scripts) se usa `withTimingScope`.
 *
 * "Sentencias": son operaciones de Prisma (`$use`), no SQL crudo; un `include` puede ser más de una sentencia. Cada tx
 * interactiva suma además 3 idas y vueltas que no se cuentan como op (BEGIN, `set_config`, COMMIT): por eso la línea
 * trae `roundTrips = stmtCount + 3·txCount`, que es lo que se multiplica por la latencia de red real (N × RTT).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { requestAsyncStorage } from "next/dist/client/components/request-async-storage.external";

/** Se lee una vez: el flag se fija al arrancar el server (`PERF_TIMING=1 next start`). */
let PERF_ON = process.env.PERF_TIMING === "1";

/**
 * Tiempo sin actividad (y sin nada medido en vuelo) después del cual el request se da por terminado y se imprime su
 * línea. Con latencia de red simulada alta (`scripts/perf/ttfb.mjs --db-rtt=120`) abrir una conexión tarda más que
 * 150 ms sin ninguna marca: el script lo sube con `PERF_TIMING_IDLE_MS`.
 */
export const FLUSH_IDLE_MS = Number(process.env.PERF_TIMING_IDLE_MS) > 0 ? Number(process.env.PERF_TIMING_IDLE_MS) : 150;

export type TimingSummary = {
  route: string;
  /** Desde la primera marca del request hasta el fin de la última op/tx (trabajo de servidor medido; sin render). */
  spanMs: number;
  /** `getSessionUser` (local desde PF-0b; `auth-strict` = GoTrue). */
  authMs: number;
  /** `loadAccessMemberships` (canal service, sin GUC). */
  accessMs: number;
  /** Armado completo del actor (`resolveActor`: incluye auth + access). */
  actorMs: number;
  txCount: number;
  /** Suma de la duración de las tx (pueden correr en paralelo: puede superar `spanMs`). */
  txMs: number;
  stmtCount: number;
  /** Suma de la duración de las ops de Prisma (paralelas incluidas). */
  dbMs: number;
  roundTrips: number;
  marks: Record<string, { ms: number; count: number }>;
};

type Acc = {
  route: string;
  firstAt: number;
  lastAt: number;
  /** false en `withTimingScope`: ese scope imprime al terminar `fn`, no por inactividad. */
  auto: boolean;
  /** Tx abiertas + `timeAsync` en curso: mientras sea > 0 la línea no sale. */
  inflight: number;
  marks: Map<string, { ms: number; count: number }>;
  txCount: number;
  txMs: number;
  stmtCount: number;
  dbMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  flushed: boolean;
  sink: (s: TimingSummary) => void;
};

const scopeAls = new AsyncLocalStorage<Acc>();
const byRequest = new WeakMap<object, Acc>();

function now(): number {
  return performance.now();
}

function defaultSink(s: TimingSummary): void {
  // console y no `logger`: es diagnóstico local detrás de un flag y no tiene que depender de LOG_LEVEL ni de la
  // validación de `lib/env.ts`.
  // eslint-disable-next-line no-console
  console.log(`[perf] ${JSON.stringify(s)}`);
}

function newAcc(route: string, sink: (s: TimingSummary) => void, auto = true): Acc {
  const t = now();
  return {
    route,
    auto,
    firstAt: t,
    lastAt: t,
    inflight: 0,
    marks: new Map(),
    txCount: 0,
    txMs: 0,
    stmtCount: 0,
    dbMs: 0,
    timer: null,
    flushed: false,
    sink,
  };
}

function routeOf(store: { headers?: { get(name: string): string | null } }): string {
  try {
    const h = store.headers;
    const path = h?.get("x-pathname") ?? "?";
    const action = h?.get("next-action");
    return action ? `action ${path}` : `GET ${path}`;
  } catch {
    return "?";
  }
}

/** El acumulador del request en curso, o null (apagado o fuera de un request). */
function currentAcc(): Acc | null {
  if (!PERF_ON) return null;
  const scoped = scopeAls.getStore();
  if (scoped) return scoped.flushed ? null : scoped;
  let store: object | undefined;
  try {
    store = requestAsyncStorage.getStore() as object | undefined;
  } catch {
    store = undefined;
  }
  if (!store) return null;
  let acc = byRequest.get(store);
  if (!acc) {
    acc = newAcc(routeOf(store as never), defaultSink);
    byRequest.set(store, acc);
  }
  return acc.flushed ? null : acc;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function summarize(acc: Acc): TimingSummary {
  const m = (k: string) => round(acc.marks.get(k)?.ms ?? 0);
  const marks: TimingSummary["marks"] = {};
  for (const [k, v] of acc.marks) marks[k] = { ms: round(v.ms), count: v.count };
  return {
    route: acc.route,
    spanMs: round(acc.lastAt - acc.firstAt),
    authMs: m("auth"),
    accessMs: m("access"),
    actorMs: m("actor"),
    txCount: acc.txCount,
    txMs: round(acc.txMs),
    stmtCount: acc.stmtCount,
    dbMs: round(acc.dbMs),
    roundTrips: acc.stmtCount + 3 * acc.txCount,
    marks,
  };
}

function flush(acc: Acc): void {
  if (acc.flushed) return;
  acc.flushed = true;
  if (acc.timer) clearTimeout(acc.timer);
  acc.timer = null;
  acc.sink(summarize(acc));
}

/** Re-arma el temporizador de inactividad: la línea sale cuando el request deja de hacer trabajo medido. */
function touch(acc: Acc): void {
  acc.lastAt = now();
  if (acc.timer) clearTimeout(acc.timer);
  acc.timer = null;
  if (acc.inflight > 0 || !acc.auto) return;
  const t = setTimeout(() => flush(acc), FLUSH_IDLE_MS);
  // Que un temporizador de diagnóstico nunca mantenga vivo el proceso (tests, scripts).
  (t as { unref?: () => void }).unref?.();
  acc.timer = t;
}

export function perfTimingEnabled(): boolean {
  return PERF_ON;
}

/** Suma `ms` a la marca `name` del request en curso. No-op apagado o fuera de un request. */
export function mark(name: string, ms: number): void {
  const acc = currentAcc();
  if (!acc) return;
  const cur = acc.marks.get(name) ?? { ms: 0, count: 0 };
  cur.ms += ms;
  cur.count += 1;
  acc.marks.set(name, cur);
  touch(acc);
}

/**
 * Mide `fn` como la marca `name`. Apagado es exactamente `fn()` (mismo valor, mismas excepciones, sin envolver la
 * promesa en otra).
 */
export function timeAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const acc = PERF_ON ? currentAcc() : null;
  if (!acc) return fn();
  const t0 = now();
  acc.inflight += 1;
  if (acc.timer) clearTimeout(acc.timer);
  acc.timer = null;
  return fn().finally(() => {
    acc.inflight = Math.max(0, acc.inflight - 1);
    mark(name, now() - t0);
  });
}

/** Una op de Prisma terminada (la llama el `$use` que instala `lib/rls.ts` con el flag prendido). */
export function recordStatement(ms: number): void {
  const acc = currentAcc();
  if (!acc) return;
  acc.stmtCount += 1;
  acc.dbMs += ms;
  touch(acc);
}

/**
 * Abre la cuenta de una tx de `runWithRls`. Devuelve la función que la cierra (o null apagado). Mientras haya tx
 * abiertas la línea no se imprime aunque pase `FLUSH_IDLE_MS` sin ops (una tx puede esperar conexión del pool).
 */
export function beginTx(): (() => void) | null {
  const acc = currentAcc();
  if (!acc) return null;
  const t0 = now();
  acc.txCount += 1;
  acc.inflight += 1;
  if (acc.timer) clearTimeout(acc.timer);
  acc.timer = null;
  return () => {
    acc.inflight = Math.max(0, acc.inflight - 1);
    acc.txMs += now() - t0;
    touch(acc);
  };
}

/** `Server-Timing` (RFC de W3C): `name;dur=ms` separados por coma. Nombres saneados a token. */
export function serverTimingHeader(entries: Record<string, number>): string {
  return Object.entries(entries)
    .map(([k, v]) => `${k.replace(/[^A-Za-z0-9_-]/g, "_")};dur=${round(v)}`)
    .join(", ");
}

/** La cabecera `Server-Timing` de un resumen (auth, actor, tx, db y el span del servidor). */
export function summaryServerTiming(s: TimingSummary): string {
  return serverTimingHeader({ auth: s.authMs, actor: s.actorMs, tx: s.txMs, db: s.dbMs, span: s.spanMs });
}

/**
 * Corre `fn` con un acumulador propio (fuera de Next: unit tests, scripts). Al terminar imprime/entrega el resumen
 * a `sink` (por defecto la línea `[perf]`) y lo devuelve. Apagado: corre `fn` y devuelve `summary: null`.
 */
export async function withTimingScope<T>(
  route: string,
  fn: () => Promise<T>,
  sink: (s: TimingSummary) => void = defaultSink
): Promise<{ result: T; summary: TimingSummary | null }> {
  if (!PERF_ON) return { result: await fn(), summary: null };
  const acc = newAcc(route, sink, false);
  let summary: TimingSummary | null = null;
  acc.sink = (s) => {
    summary = s;
    sink(s);
  };
  const result = await scopeAls.run(acc, fn);
  // Las tx ya cerraron (fn terminó): se imprime ya, sin esperar el temporizador.
  flush(acc);
  return { result, summary };
}

/** Solo tests: prende/apaga el flag sin re-importar el módulo. */
export function __setPerfTimingForTests(on: boolean): void {
  PERF_ON = on;
}
