/**
 * Reparto de % entre profesionales (CF2 · P.3, plan §29: decisión 4 + D-CF2-18) · lógica PURA.
 *
 * Client-safe (sin zod, sin DB, sin reloj): lo usan el editor de «Reparto» (validar el % y el grafo antes de
 * mandar), la action `setRevenueShare` (la misma validación, dentro de la tx con el lock `kinesoft:rshare:`) y la
 * caja (`shareOfCents` en `settleRevenueShares`). Tests: `tests/unit/cf2-revenue-share-logic.test.ts`.
 */
import {
  SHARE_BPS_MAX,
  SHARE_BPS_MIN,
  type RevenueShareRuleView,
  type RevenueShareSources,
  type RevenueSource,
  type ShareEdge,
  type ShareGraphError,
} from "@/lib/revenue-share-types";

/**
 * «12» / «12,5» / «12.5» / «12,50» / «15 %» → bps enteros (1200 / 1250 / 1250 / 1250 / 1500). `null` si no es un %
 * válido: vacío, ≤ 0, > 100, más de 2 decimales, signo, separador de miles, exponente o un no-string.
 *
 * Por qué con regex y suma de enteros y no `Math.round(parseFloat(x) * 100)`: `0.29 * 100` en float es
 * 28.999999999999996 y un `floor` lo vuelve 28 bps; con `round` se tapa ese caso pero el error de representación
 * queda en el camino de la plata. Separando parte entera y decimales del TEXTO no hay float en ningún paso.
 * Se acepta coma o punto (el teclado numérico del celular pone uno u otro) pero no los dos (no hay miles: ≤ 100).
 */
const SHARE_PCT_RE = /^(\d{1,3})(?:[.,](\d{1,2}))?\s*%?$/;

export function parseSharePct(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const m = SHARE_PCT_RE.exec(raw.trim());
  if (!m) return null;
  const whole = Number.parseInt(m[1], 10);
  const frac = m[2] ? Number.parseInt(m[2].padEnd(2, "0"), 10) : 0;
  const bps = whole * 100 + frac;
  return bps >= SHARE_BPS_MIN && bps <= SHARE_BPS_MAX ? bps : null;
}

/** bps → texto del input, con coma decimal y sin ceros de más («12», «12,5», «12,05»). Round-trip con `parseSharePct`. */
export function formatSharePctInput(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const frac = Math.abs(bps % 100);
  if (frac === 0) return String(whole);
  return `${whole},${String(frac).padStart(2, "0").replace(/0$/, "")}`;
}

/** bps → «12,5%» (sin espacio, como el resto de los % de la app). */
export function formatSharePct(bps: number): string {
  return `${formatSharePctInput(bps)}%`;
}

/**
 * Parte de `cents` que corresponde a `bps`, redondeada half-up al centavo: `floor((cents·bps + 5000) / 10000)`.
 * Es la ÚNICA regla de redondeo del reparto (D-CF2-18: «redondeo half-up por grupo»): la caja la aplica una vez por
 * grupo y acredita al receptor exactamente lo mismo que le descuenta al que destina, así Σ neto = Σ bruto.
 * Con bps ≤ 10000 nunca supera el monto. Simétrica para negativos (no deberían llegar: la caja suma cobros).
 * Si `cents·bps` se pasa de `Number.MAX_SAFE_INTEGER` (≈ $900 mil millones al 100 %) la cuenta va en BigInt.
 */
export function shareOfCents(cents: number, bps: number): number {
  if (!Number.isSafeInteger(cents)) throw new RangeError(`Centavos inválidos: ${cents}`);
  if (!Number.isInteger(bps) || bps < 0 || bps > SHARE_BPS_MAX) throw new RangeError(`bps inválidos: ${bps}`);
  const sign = cents < 0 ? -1 : 1;
  const abs = Math.abs(cents);
  const product = abs * bps;
  if (Number.isSafeInteger(product)) return sign * Math.floor((product + 5000) / 10_000);
  return sign * Number((BigInt(abs) * BigInt(bps) + 5000n) / 10_000n);
}

/**
 * ¿Se puede abrir la regla `next` con las vigentes `open`? (D-CF2-18: sin auto-reparto, sin mutuos, sin cadenas.)
 * Las vigentes del MISMO que destina se ignoran: guardar cierra la suya en el mismo instante (una vigente por
 * profesional, único parcial de M21), así que cambiar de receptor o de % no choca consigo misma.
 * Orden de los chequeos: `self` → `mutual` → `receiverGives` → `giverReceives` (el más específico primero).
 */
export function validateShareGraph(open: readonly ShareEdge[], next: ShareEdge): ShareGraphError | null {
  const giver = next.giverPractitionerId;
  const receiver = next.receiverPractitionerId;
  if (giver === receiver) return "self";
  const others = open.filter((e) => e.giverPractitionerId !== giver);
  if (others.some((e) => e.giverPractitionerId === receiver && e.receiverPractitionerId === giver)) return "mutual";
  if (others.some((e) => e.giverPractitionerId === receiver)) return "receiverGives";
  if (others.some((e) => e.receiverPractitionerId === giver)) return "giverReceives";
  return null;
}

/** ¿La regla destina sobre esta fuente? */
export function ruleAppliesTo(sources: RevenueShareSources, source: RevenueSource): boolean {
  return sources[source] === true;
}

const byFromDesc = (a: RevenueShareRuleView, b: RevenueShareRuleView) =>
  a.effectiveFrom < b.effectiveFrom ? 1 : a.effectiveFrom > b.effectiveFrom ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;

/** Aristas de las reglas VIGENTES (`effectiveTo === null`), para `validateShareGraph`. */
export function openShareEdges(rules: readonly RevenueShareRuleView[]): ShareEdge[] {
  return rules
    .filter((r) => r.effectiveTo === null)
    .map((r) => ({ giverPractitionerId: r.giverPractitionerId, receiverPractitionerId: r.receiverPractitionerId }));
}

/** Historial del que destina (vigente + cerradas), `effectiveFrom` desc. */
export function rulesForGiver(rules: readonly RevenueShareRuleView[], giverPractitionerId: string): RevenueShareRuleView[] {
  return rules.filter((r) => r.giverPractitionerId === giverPractitionerId).sort(byFromDesc);
}

/** La regla vigente del que destina, o `null`. Su `id` es el `expectedOpenId` del CAS al guardar o terminar. */
export function openRuleForGiver(
  rules: readonly RevenueShareRuleView[],
  giverPractitionerId: string,
): RevenueShareRuleView | null {
  return rules.find((r) => r.giverPractitionerId === giverPractitionerId && r.effectiveTo === null) ?? null;
}

/** «Recibe de» (solo lectura en el editor): las vigentes que tienen a este profesional como receptor. */
export function openRulesReceivedBy(
  rules: readonly RevenueShareRuleView[],
  receiverPractitionerId: string,
): RevenueShareRuleView[] {
  return rules.filter((r) => r.receiverPractitionerId === receiverPractitionerId && r.effectiveTo === null).sort(byFromDesc);
}
