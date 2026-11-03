/**
 * Caja por profesional (CF2 · P.2, plan §29: D-CF2-16/17/18 + decisión 4) · lógica PURA.
 *
 * Sin DB, sin reloj propio (`todayKey` / `now` entran por parámetro), client-safe. El server (`lib/caja-internal.ts`
 * → `loadCajaPage`, y `lib/dashboard.ts` para la tarjeta «Cobrado hoy») trae los `CollectedGroup` con UNA sentencia y
 * todo lo demás se arma acá: scope, período, liquidación con reparto, medios de pago y la proyección por scope.
 * Tests: `tests/unit/cf2-caja-logic.test.ts` (TZ=UTC y TZ=AR).
 */
import type { DayKey } from "@/lib/availability/types";
import { addDays, dayWindow, instantAt, isDayKey } from "@/lib/availability/day";
import type { Capability } from "@/lib/capabilities";
import {
  CAJA_PATH,
  type CajaPageData,
  type CajaPeriod,
  type CajaPeriodWire,
  type CajaRosterEntry,
  type CajaScope,
  type CajaSearchParams,
  type CajaView,
  type CashTodaySummary,
  type CollectedGroup,
  type CollectedMethod,
  type MethodTotal,
  type PractitionerSettlement,
  type SourceCounts,
  type SettlementResult,
  type SettlementTotals,
  type ShareFlow,
  type SourceCents,
} from "@/lib/caja-types";
import { revenuePeriod } from "@/lib/dashboard-revenue";
import { PAYMENT_METHODS } from "@/lib/payment-method";
import { shareOfCents } from "@/lib/revenue-share-logic";
import { REVENUE_SOURCES, type RevenueShareRuleView, type RevenueSource } from "@/lib/revenue-share-types";

// ─── Scope ───────────────────────────────────────────────────────────────────

/**
 * Quién ve qué (D-CF2-16). Mismo espíritu que `revenueScopeFor` (falla cerrado: caps vacías → `none`) pero con un
 * scope más (`desk`) y por eso aparte: `revenueScopeFor` gobierna el widget de ingresos del Inicio, que a la
 * Secretaria le sigue oculto (SR-D5I), y no se toca.
 *   - `billing.manage` → `tenant` (Titular, Admin, Facturación).
 *   - `billing.collect` → `desk` (Secretaria). Va ANTES que `own`: un OWNER/ADMIN tiene collect y collectOwn pero
 *     ya salió por manage.
 *   - `billing.collectOwn` + `clinical.read` + profesional → `own`. Sin profesional, `none` (nunca `own` con null,
 *     que en la SQL sería «los cobros sin profesional»).
 *   - el resto → `none`; el soporte cae acá porque `SUPPORT_CAPS` filtra todo `billing.*`.
 */
export function cajaScopeFor(caps: ReadonlySet<Capability>, practitionerId: string | null): CajaScope {
  if (caps.has("billing.manage")) return { kind: "tenant" };
  if (caps.has("billing.collect")) return { kind: "desk" };
  if (caps.has("billing.collectOwn") && caps.has("clinical.read") && practitionerId) {
    return { kind: "own", practitionerId };
  }
  return { kind: "none" };
}

const DESK_SOURCES = ["manual", "online"] as const satisfies readonly RevenueSource[];

/** Columnas de fuente que ve el scope (la Secretaria no ve la OS: D-CF2-16). Es también el `includeInsurer` de la SQL. */
export function cajaSourcesFor(scope: CajaScope): readonly RevenueSource[] {
  switch (scope.kind) {
    case "tenant":
    case "own":
      return REVENUE_SOURCES;
    case "desk":
      return DESK_SOURCES;
    case "none":
      return [];
  }
}

// ─── Search params y período ─────────────────────────────────────────────────

const MONTH_KEY_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

type SearchParamsLike = URLSearchParams | Readonly<Record<string, string | readonly string[] | undefined>> | null | undefined;

function firstParam(sp: SearchParamsLike, key: string): string | undefined {
  if (!sp) return undefined;
  if (sp instanceof URLSearchParams) return sp.get(key) ?? undefined;
  const v = sp[key];
  return typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : undefined;
}

/**
 * `?vista=dia|mes&fecha=YYYY-MM-DD&mes=YYYY-MM` de `/caja` (los `searchParams` de Next o un `URLSearchParams`).
 * Lo inválido queda `null` y no tira (como `parseLastVisitBound`): una URL vieja o tipeada a mano abre hoy.
 * `vista` desconocida → Día. Valores repetidos → el primero.
 */
export function parseCajaSearchParams(sp: SearchParamsLike): CajaSearchParams {
  const vista = firstParam(sp, "vista");
  const fecha = firstParam(sp, "fecha");
  const mes = firstParam(sp, "mes");
  return {
    view: vista === "mes" ? "mes" : "dia",
    date: fecha && isDayKey(fecha) ? fecha : null,
    month: mes && MONTH_KEY_RE.test(mes) ? mes : null,
  };
}

/** Link de `/caja` (Día/Mes y las flechas): sin clave = hoy / el mes en curso. Round-trip con `parseCajaSearchParams`. */
export function cajaHref(view: CajaView, key?: string | null): string {
  const q = new URLSearchParams();
  if (view === "mes") {
    q.set("vista", "mes");
    if (key) q.set("mes", key);
  } else if (key) {
    q.set("vista", "dia");
    q.set("fecha", key);
  }
  const s = q.toString();
  return s ? `${CAJA_PATH}?${s}` : CAJA_PATH;
}

/** "YYYY-MM" desplazado `delta` meses (cruza años). */
function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const abs = y * 12 + (m - 1) + delta;
  const ny = Math.floor(abs / 12);
  return `${ny}-${String(abs - ny * 12 + 1).padStart(2, "0")}`;
}

/**
 * Período de la caja. `todayKey` = `toARDateKey(now)` del server (nunca el día del host: a las 23:30 AR un host UTC
 * ya está en el día siguiente).
 *   - Día: `dayWindow` (medianoche AR → la siguiente).
 *   - Mes: `revenuePeriod("month", …)` (el mismo borde que el widget de ingresos), anclado al mediodía AR del día 1
 *     para quedar lejos de cualquier borde. Sin `mes`, el de `fecha`; sin las dos, el de hoy.
 *   - `desk` (Secretaria): SIEMPRE hoy, sin navegar (D-CF2-16), ignore lo que diga la URL.
 *   - `none`: `null` (la página redirige).
 */
export function cajaPeriodFor(params: CajaSearchParams, todayKey: DayKey, scope: CajaScope): CajaPeriod | null {
  if (scope.kind === "none") return null;
  const todayMonth = todayKey.slice(0, 7);
  if (scope.kind === "desk") {
    const { start, end } = dayWindow(todayKey);
    return { view: "dia", dayKey: todayKey, monthKey: todayMonth, start, end, isCurrent: true, canNavigate: false, prev: null, next: null };
  }
  if (params.view === "mes") {
    const monthKey = params.month ?? params.date?.slice(0, 7) ?? todayMonth;
    const { start, end } = revenuePeriod("month", instantAt(`${monthKey}-01`, 12 * 60));
    return {
      view: "mes",
      dayKey: null,
      monthKey,
      start,
      end,
      isCurrent: monthKey === todayMonth,
      canNavigate: true,
      prev: shiftMonth(monthKey, -1),
      next: shiftMonth(monthKey, 1),
    };
  }
  const dayKey = params.date ?? todayKey;
  const { start, end } = dayWindow(dayKey);
  return {
    view: "dia",
    dayKey,
    monthKey: dayKey.slice(0, 7),
    start,
    end,
    isCurrent: dayKey === todayKey,
    canNavigate: true,
    prev: addDays(dayKey, -1),
    next: addDays(dayKey, 1),
  };
}

/** Para el cliente: los instantes en ISO. */
export function cajaPeriodWire(period: CajaPeriod): CajaPeriodWire {
  const { start, end, ...rest } = period;
  return { ...rest, startIso: start.toISOString(), endIso: end.toISOString() };
}

// ─── Liquidación ─────────────────────────────────────────────────────────────

const zeroSources = (): SourceCents => ({ manual: 0, online: 0, insurer: 0 });
const sumSources = (s: SourceCents) => s.manual + s.online + s.insurer;

function appliesFlag(g: CollectedGroup): boolean {
  // `=== true`: con regla pero flags null (no debería pasar, son NOT NULL en M21) no se destina nada: si algo
  // falla, la plata se queda con quien la cobró, nunca se le acredita a otro de más.
  if (g.source === "manual") return g.appliesManual === true;
  if (g.source === "online") return g.appliesOnline === true;
  return g.appliesInsurer === true;
}

type MutableFlow = { practitionerId: string; practitionerName: string; bySource: SourceCents };

type MutableRow = {
  practitionerId: string;
  practitionerName: string;
  bySource: SourceCents;
  countBySource: SourceCents;
  givenTo: Map<string, MutableFlow>;
  receivedFrom: Map<string, MutableFlow>;
};

const byName = <T extends { practitionerName: string; practitionerId: string }>(a: T, b: T) =>
  a.practitionerName.localeCompare(b.practitionerName, "es") || (a.practitionerId < b.practitionerId ? -1 : a.practitionerId > b.practitionerId ? 1 : 0);

function freezeFlows(m: Map<string, MutableFlow>): ShareFlow[] {
  return [...m.values()]
    .map((f) => ({ practitionerId: f.practitionerId, practitionerName: f.practitionerName, cents: sumSources(f.bySource), bySource: { ...f.bySource } }))
    .filter((f) => f.cents !== 0)
    .sort(byName);
}

function totalsOf(rows: readonly PractitionerSettlement[]): SettlementTotals {
  const t: SettlementTotals = { bySource: zeroSources(), gross: 0, count: 0, given: 0, received: 0, net: 0 };
  for (const r of rows) {
    for (const s of REVENUE_SOURCES) t.bySource[s] += r.bySource[s];
    t.gross += r.gross;
    t.count += r.count;
    t.given += r.given;
    t.received += r.received;
    t.net += r.net;
  }
  return t;
}

function finalizeRow(r: {
  practitionerId: string;
  practitionerName: string;
  bySource: SourceCents;
  countBySource: SourceCounts;
  givenTo: ShareFlow[];
  receivedFrom: ShareFlow[];
}): PractitionerSettlement {
  const gross = sumSources(r.bySource);
  const given = r.givenTo.reduce((s, f) => s + f.cents, 0);
  const received = r.receivedFrom.reduce((s, f) => s + f.cents, 0);
  return {
    practitionerId: r.practitionerId,
    practitionerName: r.practitionerName,
    bySource: r.bySource,
    gross,
    count: sumSources(r.countBySource),
    countBySource: r.countBySource,
    given,
    givenTo: r.givenTo,
    received,
    receivedFrom: r.receivedFrom,
    net: gross - given + received,
  };
}

/**
 * Liquida el período: bruto por fuente, lo que cada uno destina y recibe, y el neto (D-CF2-18, decisión 4).
 *
 *   1. Pliega los medios de pago: el redondeo es por grupo (profesional × fuente × día AR × regla), no por medio,
 *      para que partir el cobro en efectivo y transferencia no sume centavos.
 *   2. Por grupo con regla que aplica a SU fuente: `shareOfCents(monto, bps)` half-up, que se descuenta del que
 *      destina y se acredita, idéntico, al que recibe ⇒ Σ neto = Σ bruto al centavo. Cada grupo trae la regla
 *      vigente AL COBRAR (el LATERAL por `effectiveFrom ≤ at < effectiveTo`): un cambio de regla no reescribe lo ya
 *      cobrado. Redondear por día hace que el Mes sea la suma exacta de sus Días.
 *   3. Regla a sí mismo o bps 0 (los CHECK de M21 lo impiden): se ignora.
 *
 * `roster` suma a los profesionales sin cobros (filas en $0). El receptor aparece aunque no haya cobrado nada.
 */
export function settleRevenueShares(
  groups: readonly CollectedGroup[],
  roster: readonly CajaRosterEntry[] = [],
): SettlementResult {
  const rows = new Map<string, MutableRow>();
  const rowOf = (id: string, name: string): MutableRow => {
    let r = rows.get(id);
    if (!r) {
      r = { practitionerId: id, practitionerName: name, bySource: zeroSources(), countBySource: zeroSources(), givenTo: new Map(), receivedFrom: new Map() };
      rows.set(id, r);
    }
    return r;
  };
  for (const e of roster) rowOf(e.practitionerId, e.practitionerName);

  // 1. Plegado de medios.
  const folded = new Map<string, CollectedGroup>();
  for (const g of groups) {
    const key = [g.practitionerId, g.source, g.dayKey, g.ruleId ?? "", g.receiverPractitionerId ?? "", g.shareBps ?? "", appliesFlag(g) ? 1 : 0].join("\u0000");
    const prev = folded.get(key);
    if (prev) folded.set(key, { ...prev, amountCents: prev.amountCents + g.amountCents, count: prev.count + g.count });
    else folded.set(key, g);
  }

  // 2. Bruto y reparto por grupo.
  for (const g of folded.values()) {
    const giver = rowOf(g.practitionerId, g.practitionerName);
    giver.bySource[g.source] += g.amountCents;
    giver.countBySource[g.source] += g.count;
    const receiverId = g.receiverPractitionerId;
    if (!g.ruleId || !receiverId || receiverId === g.practitionerId || !g.shareBps || !appliesFlag(g)) continue;
    const cents = shareOfCents(g.amountCents, g.shareBps);
    if (cents === 0) continue;
    const receiverName = g.receiverName ?? "";
    const receiver = rowOf(receiverId, receiverName);
    if (!receiver.practitionerName && receiverName) receiver.practitionerName = receiverName;

    let out = giver.givenTo.get(receiverId);
    if (!out) giver.givenTo.set(receiverId, (out = { practitionerId: receiverId, practitionerName: receiverName, bySource: zeroSources() }));
    out.bySource[g.source] += cents;

    let inn = receiver.receivedFrom.get(g.practitionerId);
    if (!inn) receiver.receivedFrom.set(g.practitionerId, (inn = { practitionerId: g.practitionerId, practitionerName: g.practitionerName, bySource: zeroSources() }));
    inn.bySource[g.source] += cents;
  }

  const out = [...rows.values()]
    .map((r) =>
      finalizeRow({
        practitionerId: r.practitionerId,
        practitionerName: r.practitionerName,
        bySource: r.bySource,
        countBySource: r.countBySource,
        givenTo: freezeFlows(r.givenTo),
        receivedFrom: freezeFlows(r.receivedFrom),
      }),
    )
    .sort(byName);
  return { rows: out, totals: totalsOf(out) };
}

// ─── Medios de pago ──────────────────────────────────────────────────────────

const METHOD_ORDER: readonly CollectedMethod[] = [...PAYMENT_METHODS, "UNKNOWN"];

/**
 * «Por medio de pago» (sin OS: la obra social no tiene medio). Un cobro online sin medio cuenta como Mercado Pago
 * (es por donde entra); un copago manual sin medio, `UNKNOWN` («Sin informar»). Sin filas en cero.
 */
export function methodBreakdown(groups: readonly CollectedGroup[]): MethodTotal[] {
  const acc = new Map<CollectedMethod, MethodTotal>();
  for (const g of groups) {
    if (g.source === "insurer") continue;
    const method: CollectedMethod = g.method ?? (g.source === "online" ? "MERCADO_PAGO" : "UNKNOWN");
    const t = acc.get(method) ?? { method, cents: 0, count: 0 };
    t.cents += g.amountCents;
    t.count += g.count;
    acc.set(method, t);
  }
  return METHOD_ORDER.flatMap((m) => {
    const t = acc.get(m);
    return t && t.cents !== 0 ? [t] : [];
  });
}

// ─── Proyección por scope ────────────────────────────────────────────────────

const EMPTY: SettlementResult = { rows: [], totals: totalsOf([]) };

function withoutInsurer(flows: readonly ShareFlow[]): ShareFlow[] {
  return flows
    .map((f) => {
      const bySource = { ...f.bySource, insurer: 0 };
      return { ...f, bySource, cents: sumSources(bySource) };
    })
    .filter((f) => f.cents !== 0);
}

/**
 * Lo que puede ver el scope de una liquidación (lo que cruza al cliente).
 *   - `tenant`: todo.
 *   - `desk`: sin OS en NINGÚN lado (bruto, destina, recibe, ni sus cobros en `count`), por si la SQL la trajo. Se
 *     resta por fuente (cada flujo trae su apertura), así la conservación sigue valiendo y no se recalcula ningún
 *     redondeo.
 *   - `own`: SOLO la fila del actor (lo que cobró, lo que destina y lo que recibe). La SQL de `own` trae también los
 *     grupos de quien le destina (para calcular lo que recibe); su bruto no sale de acá. Los totales son los suyos.
 *   - `none`: vacío.
 */
export function projectCajaForScope(result: SettlementResult, scope: CajaScope): SettlementResult {
  switch (scope.kind) {
    case "tenant":
      return result;
    case "none":
      return EMPTY;
    case "own": {
      const rows = result.rows.filter((r) => r.practitionerId === scope.practitionerId);
      return { rows, totals: totalsOf(rows) };
    }
    case "desk": {
      const rows = result.rows.map((r) =>
        finalizeRow({
          practitionerId: r.practitionerId,
          practitionerName: r.practitionerName,
          bySource: { ...r.bySource, insurer: 0 },
          // Sin los cobros de OS (no se ven): la Secretaria veía «10 cobros» con 8 visibles (hallazgo de P-X).
          countBySource: { ...r.countBySource, insurer: 0 },
          givenTo: withoutInsurer(r.givenTo),
          receivedFrom: withoutInsurer(r.receivedFrom),
        }),
      );
      return { rows, totals: totalsOf(rows) };
    }
  }
}

/** «Reparto vigente» por scope: `own` ve solo las reglas donde destina o recibe; `none`, ninguna. */
export function projectRulesForScope(rules: readonly RevenueShareRuleView[], scope: CajaScope): RevenueShareRuleView[] {
  switch (scope.kind) {
    case "tenant":
    case "desk":
      return [...rules];
    case "own":
      return rules.filter((r) => r.giverPractitionerId === scope.practitionerId || r.receiverPractitionerId === scope.practitionerId);
    case "none":
      return [];
  }
}

/** Grupos cuyo BRUTO puede ver el scope (para «Por medio de pago»): `own` solo lo suyo, `desk` sin OS. */
function grossVisibleGroups(groups: readonly CollectedGroup[], scope: CajaScope): readonly CollectedGroup[] {
  switch (scope.kind) {
    case "tenant":
      return groups;
    case "desk":
      return groups.filter((g) => g.source !== "insurer");
    case "own":
      return groups.filter((g) => g.practitionerId === scope.practitionerId);
    case "none":
      return [];
  }
}

// ─── Armado ──────────────────────────────────────────────────────────────────

/**
 * Tarjeta «Cobrado hoy» del Inicio de la Secretaria (D-CF2-17): copagos + online de hoy por profesional con lo que
 * destina y recibe. Sin OS aunque la SQL la trajera. Solo los profesionales con movimiento. `now` = hora del cálculo.
 */
export function cashTodayFrom(groups: readonly CollectedGroup[], now: Date): CashTodaySummary {
  const settled = projectCajaForScope(settleRevenueShares(groups.filter((g) => g.source !== "insurer")), { kind: "desk" });
  const rows = settled.rows
    .filter((r) => r.gross !== 0 || r.given !== 0 || r.received !== 0)
    .map((r) => ({
      practitionerId: r.practitionerId,
      practitionerName: r.practitionerName,
      grossCents: r.gross,
      givenCents: r.given,
      // `freezeFlows`/`withoutInsurer` ya sacan los flujos en $0: Σ = `givenCents`.
      givenTo: r.givenTo.map((f) => ({ practitionerId: f.practitionerId, practitionerName: f.practitionerName, cents: f.cents })),
      receivedCents: r.received,
      netCents: r.net,
    }));
  return { rows, totalCents: settled.totals.gross, computedAt: now.toISOString() };
}

export type BuildCajaPageInput = {
  scope: CajaScope;
  period: CajaPeriod;
  /** De `collectedGroupsInTx` con `includeInsurer = cajaSourcesFor(scope).includes("insurer")`. */
  groups: readonly CollectedGroup[];
  /** Profesionales del consultorio (filas en $0); en `own`, solo cuenta el del actor. */
  roster: readonly CajaRosterEntry[];
  /** De `revenueSharesForPeriodInTx` (las que tocan el período). */
  rules: readonly RevenueShareRuleView[];
  now: Date;
};

/**
 * `CajaPageData` listo para `/caja` (lo llama `loadCajaPage` después de sus 2 sentencias). `none` → `null`.
 * La liquidación se hace con TODOS los grupos (el receptor necesita los del que destina) y después se proyecta.
 */
export function buildCajaPageData(input: BuildCajaPageInput): CajaPageData | null {
  const { scope, period, groups, roster, rules, now } = input;
  if (scope.kind === "none") return null;
  const scoped = scope.kind === "desk" ? groups.filter((g) => g.source !== "insurer") : groups;
  // En `own` el roster se reduce al actor: su fila aparece en $0 aunque no haya cobrado, sin filas ajenas.
  const visibleRoster = scope.kind === "own" ? roster.filter((e) => e.practitionerId === scope.practitionerId) : roster;
  const settlement = projectCajaForScope(settleRevenueShares(scoped, visibleRoster), scope);
  return {
    scope: scope.kind,
    period: cajaPeriodWire(period),
    sources: cajaSourcesFor(scope),
    settlement,
    methods: period.view === "dia" ? methodBreakdown(grossVisibleGroups(scoped, scope)) : [],
    rules: projectRulesForScope(rules, scope),
    computedAt: now.toISOString(),
  };
}
