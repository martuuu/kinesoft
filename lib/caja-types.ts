/**
 * Caja por profesional (CF2 · P.2, plan §29: D-CF2-16/17) · tipos compartidos server ↔ UI.
 *
 * Client-safe (solo tipos y constantes): lo importan `lib/caja-logic.ts` (puro), `lib/caja-internal.ts` (la SQL),
 * `app/(app)/caja/*` y la tarjeta «Cobrado hoy» del Inicio (`lib/dashboard.ts` → `DashboardData.cashToday`).
 *
 * Plata en centavos `Int` (`*Cents` / `cents`), fechas en ISO o `DayKey` AR. Lo que cruza al cliente ya está
 * PROYECTADO al scope del actor (`projectCajaForScope`): un profesional nunca recibe el bruto de otro.
 */
import type { DayKey } from "@/lib/availability/types";
import type { PaymentMethod } from "@/lib/payment-method";
import type { RevenueShareRuleView, RevenueSource } from "@/lib/revenue-share-types";

export const CAJA_PATH = "/caja";

/** Medio de pago de un cobro. `UNKNOWN` = copago manual sin medio (cobros de antes de M12: columna NULL). */
export type CollectedMethod = PaymentMethod | "UNKNOWN";

/**
 * Una fila de la SQL de caja (`collectedGroupsInTx`, 1 sentencia): lo cobrado agrupado por (profesional, fuente,
 * medio, día AR, regla de reparto vigente al momento del cobro). Las columnas de la regla vienen del `LEFT JOIN
 * LATERAL` a `PractitionerRevenueShare` del profesional que cobró con `effectiveFrom ≤ at < COALESCE(effectiveTo, ∞)`:
 * todas `null` si no había regla en ese instante.
 */
export type CollectedGroup = {
  /** Profesional al que se atribuye el cobro (`Booking.practitionerId`; online: el de la carga). */
  practitionerId: string;
  /** Nombre visible (`displayMemberName`), nunca el email. */
  practitionerName: string;
  source: RevenueSource;
  /**
   * Medio: `manual` → `COALESCE(copagoPaymentMethod,'UNKNOWN')`; `online` → `MERCADO_PAGO` o `null` (se cuenta como
   * Mercado Pago); `insurer` → `null` (la OS no tiene medio).
   */
  method: CollectedMethod | null;
  /** Día AR del cobro (`("at" - INTERVAL '3 hours')::date`), "YYYY-MM-DD". */
  dayKey: DayKey;
  amountCents: number;
  /** Cantidad de cobros del grupo (`::int`). */
  count: number;
  /** Regla vigente al momento del cobro, o `null`. */
  ruleId: string | null;
  receiverPractitionerId: string | null;
  receiverName: string | null;
  shareBps: number | null;
  appliesManual: boolean | null;
  appliesOnline: boolean | null;
  appliesInsurer: boolean | null;
};

/** Centavos por fuente. */
export type SourceCents = Record<RevenueSource, number>;

/** Cantidad de cobros por fuente. */
export type SourceCounts = Record<RevenueSource, number>;

/** Plata que pasa entre dos profesionales (a quién destina / de quién recibe), con su apertura por fuente. */
export type ShareFlow = {
  /** El OTRO profesional (receptor en `givenTo`, el que destina en `receivedFrom`). */
  practitionerId: string;
  practitionerName: string;
  cents: number;
  bySource: SourceCents;
};

/**
 * Liquidación de un profesional en el período. `gross` = lo que cobró (Σ `bySource`); `given` = lo que destina
 * (Σ `givenTo`); `received` = lo que recibe (Σ `receivedFrom`); `net = gross − given + received`.
 */
export type PractitionerSettlement = {
  practitionerId: string;
  practitionerName: string;
  bySource: SourceCents;
  gross: number;
  /** Cantidad de cobros (Σ `count` de sus grupos) = Σ `countBySource`. */
  count: number;
  /**
   * Cobros por fuente (INT-P, handoff de P-S2): `projectCajaForScope` desk resta los de OS del `count` a partir de
   * acá. Antes la apertura viajaba en un WeakMap colgado de la fila, que se perdía con cualquier copia (spread,
   * `structuredClone`, el cruce a RSC) y la Secretaria volvía a ver los cobros de OS en el conteo.
   */
  countBySource: SourceCounts;
  given: number;
  givenTo: ShareFlow[];
  received: number;
  receivedFrom: ShareFlow[];
  net: number;
};

export type SettlementTotals = {
  bySource: SourceCents;
  gross: number;
  count: number;
  given: number;
  received: number;
  net: number;
};

/**
 * Resultado de `settleRevenueShares`. Sin proyectar (scope `tenant`/`desk`): Σ `net` = Σ `gross` (lo que uno
 * destina lo recibe otro). Proyectado a `own` ya no vale: queda la fila del actor sola.
 */
export type SettlementResult = {
  /** Ordenadas por nombre (es) y id. */
  rows: PractitionerSettlement[];
  totals: SettlementTotals;
};

/** «Por medio de pago» del día (sin OS). Orden: el de `PAYMENT_METHODS`, `UNKNOWN` al final; sin ceros. */
export type MethodTotal = {
  method: CollectedMethod;
  cents: number;
  count: number;
};

/** Fila de la tarjeta «Cobrado hoy» del Inicio de la Secretaria (sin OS, D-CF2-16). */
export type CashTodayRow = {
  practitionerId: string;
  practitionerName: string;
  grossCents: number;
  /** «destina $X» (0 si no tiene regla o no aplica a copagos/online). */
  givenCents: number;
  /**
   * A quién destina («destina $X a Ana P.»), sin OS ni flujos en $0, por nombre. Σ `cents` = `givenCents` (sale de la
   * misma liquidación `desk`). Lo agregó INT-P (handoff de P-D): antes lo recalculaba `lib/dashboard.ts` aparte.
   */
  givenTo: { practitionerId: string; practitionerName: string; cents: number }[];
  receivedCents: number;
  netCents: number;
};

/** Tarjeta «Cobrado hoy» (`DashboardData.cashToday`; `null` fuera del scope `desk`). */
export type CashTodaySummary = {
  /** Profesionales con movimiento hoy, por nombre. */
  rows: CashTodayRow[];
  /** Σ bruto (copagos + online) del día = Σ neto. */
  totalCents: number;
  /** ISO del momento del cálculo («actualizado a las …»). */
  computedAt: string;
};

/**
 * Quién ve qué en la caja (D-CF2-16). Aparte de `revenueScopeFor` (widget de ingresos del Inicio), que no cambia.
 *   - `tenant`: `billing.manage` (Titular, Admin, Facturación) → día y mes, cualquier fecha, las 3 fuentes;
 *   - `desk`: `billing.collect` sin manage (Secretaria) → solo hoy, copagos + online, sin OS; ve Destina/Recibe;
 *   - `own`: `billing.collectOwn` + `clinical.read` + profesional → día y mes, su fila y lo que recibe;
 *   - `none`: el resto (incluido el soporte, que no tiene `billing.*`) → `/caja` redirige a `/dashboard`.
 */
export type CajaScope =
  | { kind: "tenant" }
  | { kind: "desk" }
  | { kind: "own"; practitionerId: string }
  | { kind: "none" };
export type CajaScopeKind = CajaScope["kind"];

/** Vista de `/caja` (`?vista=`). */
export type CajaView = "dia" | "mes";

/** `?vista=dia|mes&fecha=YYYY-MM-DD&mes=YYYY-MM` ya validado; lo inválido queda `null` (no tira). */
export type CajaSearchParams = {
  view: CajaView;
  date: DayKey | null;
  /** "YYYY-MM". */
  month: string | null;
};

/**
 * Período resuelto (`cajaPeriodFor`). `[start, end)` en instantes reales, anclado al día/mes AR.
 * `prev`/`next` son la clave del período vecino de la MISMA vista (DayKey o "YYYY-MM"), `null` si el scope no
 * navega (Secretaria: siempre hoy).
 */
export type CajaPeriod = {
  view: CajaView;
  /** Día AR de la vista Día; `null` en Mes. */
  dayKey: DayKey | null;
  /** "YYYY-MM" del período (en Día, el mes del día: lo usa el link a Mes). */
  monthKey: string;
  start: Date;
  end: Date;
  /** ¿Es el día / mes de hoy? */
  isCurrent: boolean;
  /** ¿El actor puede cambiar de fecha o pasar a Mes? (`false` en `desk`). */
  canNavigate: boolean;
  prev: string | null;
  next: string | null;
};

/** `CajaPeriod` para el cliente: los instantes en ISO. */
export type CajaPeriodWire = Omit<CajaPeriod, "start" | "end"> & { startIso: string; endIso: string };

/** Profesional del consultorio para las filas en $0 (`listPractitioners()` cacheado). */
export type CajaRosterEntry = {
  practitionerId: string;
  practitionerName: string;
};

/** Lo que arma `loadCajaPage` (vía `buildCajaPageData`) para `/caja`; `null` = scope `none`. */
export type CajaPageData = {
  scope: CajaScopeKind;
  period: CajaPeriodWire;
  /** Columnas de fuente visibles (`desk`: sin `insurer`). */
  sources: readonly RevenueSource[];
  /** Ya proyectada al scope. */
  settlement: SettlementResult;
  /** «Por medio de pago» (solo en la vista Día; `[]` en Mes). En `own`, solo lo que cobró el actor. */
  methods: MethodTotal[];
  /** «Reparto vigente» (reglas que tocan el período; en `own`, solo las que lo involucran). */
  rules: RevenueShareRuleView[];
  computedAt: string;
};
