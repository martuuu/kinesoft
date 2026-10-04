/**
 * Plata de Planes, pura (PLANES.md C5 · P4 · P7; sesión S16p, ES1).
 *
 * Sin DB, sin reloj propio (`now` entra por parámetro) y sin `"use server"`:
 * lo consumen el motor server-only (`plan-pricing-internal`, S11e/S16a), la
 * proyección de lecturas (S14) y el portal (S24p), y se testea unit en TZ=UTC
 * y TZ=AR. Todo en centavos `Int`; jamás `Number()*100`.
 *
 * Reglas de C5 que este módulo encarna:
 *   - `Session.priceCents` es la fuente y `Booking.copagoCents` su espejo
 *     cuando `pricedByPlan`. Este módulo decide QUÉ escribir; el caller hace
 *     el `FOR UPDATE ORDER BY id`, el CAS por fila con conteo esperado conjunto
 *     y el rollback total si `count` ≠ esperado.
 *   - `lib/copago.ts` no se toca (AUDIT §5.5): la precedencia del copago de
 *     turnos sueltos sigue allá; acá solo vive la cuota de plan.
 */
import { formatARS } from "@/lib/format";

export type PricingBookingStatus = "PENDING" | "CONFIRMED" | "CANCELLED" | "NO_SHOW" | "COMPLETED";
export type PricingPaymentStatus = "UNPAID" | "AUTHORIZED" | "PAID" | "REFUNDED" | "FAILED";

/** Lo mínimo de un Booking para decidir plata. Fechas como Date o ISO. */
export type PricingBooking = {
  id: string;
  status: PricingBookingStatus;
  paymentStatus: PricingPaymentStatus;
  insurerPaidAt: Date | string | null;
  payment: { status: PricingPaymentStatus } | null;
  copagoCents: number | null;
  pricedByPlan: boolean;
  scheduledFor: Date | string;
};

/**
 * Una sesión VIVA del plan (no archivada) con TODOS sus turnos, incluidos los
 * cancelados y ausentes: un turno previo cobrado bloquea la fila igual que el
 * activo (es la plata de esa cuota).
 */
export type RepriceSessionRow = {
  id: string;
  index: number;
  scheduledFor: Date | string;
  completedAt: Date | string | null;
  priceCents: number | null;
  bookings: PricingBooking[];
};

export type PlanPricing =
  | null
  | { mode: "PER_SESSION"; pricePerSessionCents: number }
  | { mode: "PACKAGE"; totalPriceCents: number };

const MONEY = new Set<PricingPaymentStatus>(["PAID", "AUTHORIZED", "REFUNDED"]);
/** I2: un turno "activo" ocupa la sesión; CANCELLED y NO_SHOW la liberan. */
const ACTIVE = new Set<PricingBookingStatus>(["PENDING", "CONFIRMED", "COMPLETED"]);

const ms = (d: Date | string) => (typeof d === "string" ? Date.parse(d) : d.getTime());
const iso = (d: Date | string) => (typeof d === "string" ? new Date(d).toISOString() : d.toISOString());
const isCents = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

// ─── Criterio canónico de "tiene plata" ──────────────────────────────────────

/**
 * Mismo criterio que `cancelBookingsInTx` (`lib/bookings-cancel-internal.ts`,
 * MONEY_SET + `insurerPaidAt` + `payment.status`): un turno con PAID,
 * AUTHORIZED o REFUNDED, con la OS ya pagada, o con un `Payment` de MP en esos
 * estados. AUTHORIZED cuenta porque la plata está retenida; REFUNDED porque
 * hubo un movimiento que no se puede pisar. Se repite acá (puro) en vez de
 * importar el módulo server-only; `bookingHasPaymentWhere` (S14) es su espejo
 * en Prisma y los tres tienen que decir lo mismo.
 */
export function bookingHasMoney(
  b: Pick<PricingBooking, "paymentStatus" | "insurerPaidAt" | "payment">
): boolean {
  return (
    MONEY.has(b.paymentStatus) ||
    b.insurerPaidAt != null ||
    (b.payment != null && MONEY.has(b.payment.status))
  );
}

/**
 * "Cobrado de verdad" (PD-08 · cobro previo): copago PAID, OS pagada o un
 * `Payment` de MP PAID. Más estricto que `bookingHasMoney` a propósito:
 * REFUNDED se devolvió y AUTHORIZED está retenido (puede no capturarse), así
 * que ninguno de los dos paga la cuota. Coincide con lo que `planBalance`
 * suma como cobrado (más la OS, que esa función no ve).
 */
export function bookingWasCollected(
  b: Pick<PricingBooking, "paymentStatus" | "insurerPaidAt" | "payment">
): boolean {
  return b.paymentStatus === "PAID" || b.insurerPaidAt != null || b.payment?.status === "PAID";
}

// ─── P4 · reparto ────────────────────────────────────────────────────────────

/**
 * Reparte un paquete en `n` cuotas (P4). En pesos enteros con el resto en las
 * primeras: 100.000/3 = 33.334 + 33.333 + 33.333, porque nadie quiere cobrar
 * "$33.333,33". Si el total no es un número redondo de pesos, el reparto es en
 * centavos (mismo criterio: resto a las primeras). Σ = total siempre: es el
 * CHECK de I6 (`TreatmentProgram_pricing_check`).
 *
 * Tira en vez de "arreglar" entradas que no son plata: un float acá es un bug
 * del caller (un `Number()*100` en algún lado) y redondear lo escondería.
 */
export function distributePackage(totalCents: number, n: number): number[] {
  if (!isCents(totalCents)) throw new RangeError(`distributePackage: total inválido (${totalCents})`);
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`distributePackage: cantidad inválida (${n})`);
  const unit = totalCents % 100 === 0 ? 100 : 1;
  const units = totalCents / unit;
  const base = Math.floor(units / n);
  const rest = units - base * n;
  return Array.from({ length: n }, (_, i) => (base + (i < rest ? 1 : 0)) * unit);
}

// ─── C5 · fila bloqueada ─────────────────────────────────────────────────────

/**
 * Por qué una fila no se re-precia (C5 · "Fila bloqueada", que no se
 * re-estampa nunca). El orden importa solo para el mensaje:
 *   - `completed`: realizada = devengado (P7). Su cuota es lo que se debe.
 *   - `money`: algún turno de la sesión (activo o previo cancelado/ausente)
 *     tiene plata. Cubre el "cobro previo": esa cuota ya se cobró.
 *   - `manual-copago`: el turno activo tiene un copago que no es el espejo de
 *     la cuota (cargado sin plan, o estampado y después editado a mano).
 *   - `payment-state`: `paymentStatus` FAILED en la fila. No es plata, pero el
 *     CAS de re-estampado exige `paymentStatus:'UNPAID'` y fallaría siempre
 *     (stale eterno): se deja quieta y se avisa.
 *   - `past`: `scheduledFor ≤ now` (comparación de instantes: "medianoche AR"
 *     no depende del huso del host).
 */
export type RepriceLockReason = "completed" | "money" | "manual-copago" | "payment-state" | "past";

function activeBooking(s: Pick<RepriceSessionRow, "bookings">): PricingBooking | null {
  return s.bookings.find((b) => ACTIVE.has(b.status)) ?? null;
}

export function repriceLockReason(s: RepriceSessionRow, now: Date): RepriceLockReason | null {
  if (s.completedAt != null) return "completed";
  if (s.bookings.some(bookingHasMoney)) return "money";
  const active = activeBooking(s);
  if (active) {
    const manual = active.pricedByPlan
      ? active.copagoCents !== s.priceCents
      : active.copagoCents != null;
    if (manual) return "manual-copago";
    if (active.paymentStatus !== "UNPAID") return "payment-state";
    if (active.status === "COMPLETED") return "completed";
  }
  // I3: con turno activo, la fecha de la sesión es la del turno; igual se
  // mira el turno por si la sesión todavía no se escribió (write-through).
  const at = Math.min(ms(s.scheduledFor), active ? ms(active.scheduledFor) : Infinity);
  if (at <= now.getTime()) return "past";
  return null;
}

export function isLockedForReprice(s: RepriceSessionRow, now: Date): boolean {
  return repriceLockReason(s, now) !== null;
}

// ─── Reprecio ────────────────────────────────────────────────────────────────

/**
 * Escritura de un turno que el caller hace por CAS (C5 · "Reprecio y
 * estampado"). `expectedCopagoCents` va en el WHERE junto con el resto de las
 * condiciones de la rama; el conteo esperado conjunto es `stamps.length`.
 *   - `restamp` (a): `pricedByPlan:true, copagoCents: esperado`.
 *   - `first` (b): `pricedByPlan:false, copagoCents:null` (el plan pasa de
 *     "sin precio" a "con precio").
 *   - `unstamp`: el plan pasa a "sin precio"; vuelve a `copagoCents:null,
 *     pricedByPlan:false` (C5 · "Sin precio"), el desestampado de C2.
 */
export type RepriceStamp = {
  bookingId: string;
  sessionId: string;
  branch: "restamp" | "first" | "unstamp";
  expectedCopagoCents: number | null;
  copagoCents: number | null;
  pricedByPlan: boolean;
};

export type RepriceResult =
  | {
      ok: true;
      /** Mismo orden que la entrada. `changed` = la cuota cambia. */
      sessions: { sessionId: string; priceCents: number | null; locked: RepriceLockReason | null; changed: boolean }[];
      stamps: RepriceStamp[];
      program: {
        pricingMode: "PER_SESSION" | "PACKAGE" | null;
        pricePerSessionCents: number | null;
        totalPriceCents: number | null;
      };
      lockedCents: number;
    }
  | { ok: false; code: "invalid-amount" | "below-locked" | "no-free-rows"; error: string };

const fmt = (cents: number) => formatARS(cents);

/**
 * Calcula el reprecio de un plan sobre sus sesiones vivas (C5 · PACKAGE /
 * PER_SESSION / sin precio). Puro: el motor lo llama dentro de la tx, con las
 * filas ya lockeadas, y escribe lo que devuelve.
 *
 * PACKAGE: el monto de cada fila bloqueada queda como su cuota y la
 * diferencia (total − bloqueado) se reparte (P4) entre las libres ordenadas
 * por fecha y después por `index` (el "resto en las primeras" es por fecha,
 * que es lo que ve el paciente; el index puede tener huecos). Rechazos:
 *   - total nuevo < bloqueado (que incluye lo devengado) → `below-locked`;
 *   - sin filas libres y total ≠ bloqueado → `no-free-rows`, texto literal.
 */
export function repricePlan(input: {
  pricing: PlanPricing;
  sessions: RepriceSessionRow[];
  now: Date;
}): RepriceResult {
  const { pricing, sessions, now } = input;
  if (pricing) {
    const amount = pricing.mode === "PACKAGE" ? pricing.totalPriceCents : pricing.pricePerSessionCents;
    if (!isCents(amount)) {
      return { ok: false, code: "invalid-amount", error: "El monto no es válido" };
    }
  }

  const locks = sessions.map((s) => repriceLockReason(s, now));
  const lockedCents = sessions.reduce((acc, s, i) => acc + (locks[i] ? s.priceCents ?? 0 : 0), 0);
  const newPrice = new Map<string, number | null>();

  if (pricing?.mode === "PACKAGE") {
    const free = sessions
      .filter((_, i) => locks[i] === null)
      .sort((a, b) => ms(a.scheduledFor) - ms(b.scheduledFor) || a.index - b.index);
    if (pricing.totalPriceCents < lockedCents) {
      return {
        ok: false,
        code: "below-locked",
        error: `El total nuevo (${fmt(pricing.totalPriceCents)}) es menor que lo ya cobrado o realizado (${fmt(lockedCents)})`,
      };
    }
    if (free.length === 0) {
      if (pricing.totalPriceCents !== lockedCents) {
        return { ok: false, code: "no-free-rows", error: "No quedan sesiones sin cobrar para repartir la diferencia" };
      }
    } else {
      const parts = distributePackage(pricing.totalPriceCents - lockedCents, free.length);
      free.forEach((s, i) => newPrice.set(s.id, parts[i]));
    }
  } else {
    const p = pricing ? pricing.pricePerSessionCents : null;
    sessions.forEach((s, i) => {
      if (locks[i] === null) newPrice.set(s.id, p);
    });
  }

  const out: Extract<RepriceResult, { ok: true }>["sessions"] = [];
  const stamps: RepriceStamp[] = [];
  sessions.forEach((s, i) => {
    const locked = locks[i];
    const priceCents = locked ? s.priceCents : (newPrice.get(s.id) ?? null);
    out.push({ sessionId: s.id, priceCents, locked, changed: priceCents !== s.priceCents });
    if (locked) return;
    const b = activeBooking(s);
    // Una fila libre con turno activo: PENDING/CONFIRMED, futuro, UNPAID y
    // sin Payment con plata (lo garantiza `repriceLockReason`). Sin turno,
    // solo cambia la cuota y el próximo turno se estampa con ella.
    if (!b) return;
    if (b.pricedByPlan) {
      if (priceCents === null) {
        stamps.push({ bookingId: b.id, sessionId: s.id, branch: "unstamp", expectedCopagoCents: b.copagoCents, copagoCents: null, pricedByPlan: false });
      } else if (b.copagoCents !== priceCents) {
        stamps.push({ bookingId: b.id, sessionId: s.id, branch: "restamp", expectedCopagoCents: b.copagoCents, copagoCents: priceCents, pricedByPlan: true });
      }
    } else if (priceCents !== null) {
      // `copagoCents` es null acá (si no, sería copago manual y estaría bloqueada).
      stamps.push({ bookingId: b.id, sessionId: s.id, branch: "first", expectedCopagoCents: null, copagoCents: priceCents, pricedByPlan: true });
    }
  });

  return {
    ok: true,
    sessions: out,
    stamps,
    program: {
      pricingMode: pricing?.mode ?? null,
      pricePerSessionCents: pricing?.mode === "PER_SESSION" ? pricing.pricePerSessionCents : null,
      totalPriceCents: pricing?.mode === "PACKAGE" ? pricing.totalPriceCents : null,
    },
    lockedCents,
  };
}

// ─── C5 · cobro previo ───────────────────────────────────────────────────────

/**
 * Cómo se estampa el turno NUEVO de una sesión (C5 · "Cobro previo"). Si la
 * sesión tiene un turno previo CANCELLED/NO_SHOW COBRADO (`bookingWasCollected`),
 * la cuota ya se cobró: el nuevo va en `copagoCents=0` y `pricedByPlan=true`,
 * y el preview lo marca "Ya pagada en el turno del dd/mm" con `priorPaid.at`.
 * Si hay varios, se toma el más reciente (es el que el paciente recuerda). Sin
 * cobro previo: la cuota, o "sin precio" (`null` + `pricedByPlan=false`, que
 * deja que siga la cobertura).
 *
 * Ojo: NO usa `bookingHasMoney`. Ese criterio (con REFUNDED y AUTHORIZED) es
 * para BLOQUEAR filas del reprecio; acá se decide si la cuota está pagada, y
 * con él un previo devuelto o solo autorizado dejaba el reemplazo en $0
 * mientras `planBalance` no lo contaba como cobrado: la sesión no se cobraba
 * nunca (hallazgo A1 del cierre de ES1; PD-08 = "pago previo" cobrado de verdad).
 */
export function priorPaidStamp(
  session: { priceCents: number | null },
  bookings: readonly PricingBooking[]
): { copagoCents: number | null; pricedByPlan: boolean; priorPaid: { bookingId: string; at: string } | null } {
  const paid = bookings
    .filter((b) => (b.status === "CANCELLED" || b.status === "NO_SHOW") && bookingWasCollected(b))
    .sort((a, b) => ms(b.scheduledFor) - ms(a.scheduledFor))[0];
  if (paid) return { copagoCents: 0, pricedByPlan: true, priorPaid: { bookingId: paid.id, at: iso(paid.scheduledFor) } };
  if (session.priceCents == null) return { copagoCents: null, pricedByPlan: false, priorPaid: null };
  return { copagoCents: session.priceCents, pricedByPlan: true, priorPaid: null };
}

// ─── P7 · saldo ──────────────────────────────────────────────────────────────

export type PlanBalance = {
  /** Paquete, o precio × sesiones vivas. `null` = plan sin precio. */
  agreedCents: number | null;
  /** Σ cuotas de las sesiones realizadas. */
  accruedCents: number;
  /** Σ copagos PAID del plan, incluidos cancelados y ausentes. */
  collectedCents: number;
  /** Σ copagos AUTHORIZED: "en proceso", no cuenta como cobrado. */
  inProcessCents: number;
  /** devengado − cobrado, si es positivo. */
  pendingCents: number;
  /** cobrado − devengado, si es positivo. */
  creditCents: number;
};

/**
 * Saldo de un plan (P7). Se calcula en el server (S14 agrega las filas) y se
 * muestra tal cual. `sessions` = las vivas; `bookings` = TODOS los turnos del
 * plan, en cualquier estado: un cancelado o ausente cobrado sigue siendo plata
 * cobrada. REFUNDED no cuenta.
 *
 * pendiente y a favor se devuelven recortados en 0: son las dos caras de la
 * misma resta y la UI muestra la que no es cero.
 */
export function planBalance(input: {
  pricing: PlanPricing;
  sessions: readonly { priceCents: number | null; completed: boolean }[];
  bookings: readonly { status: PricingBookingStatus; paymentStatus: PricingPaymentStatus; copagoCents: number | null }[];
}): PlanBalance {
  const { pricing, sessions, bookings } = input;
  const agreedCents =
    pricing == null
      ? null
      : pricing.mode === "PACKAGE"
        ? pricing.totalPriceCents
        : pricing.pricePerSessionCents * sessions.length;
  const accruedCents = sessions.reduce((a, s) => a + (s.completed ? s.priceCents ?? 0 : 0), 0);
  let collectedCents = 0;
  let inProcessCents = 0;
  for (const b of bookings) {
    if (b.paymentStatus === "PAID") collectedCents += b.copagoCents ?? 0;
    else if (b.paymentStatus === "AUTHORIZED") inProcessCents += b.copagoCents ?? 0;
  }
  const diff = accruedCents - collectedCents;
  return {
    agreedCents,
    accruedCents,
    collectedCents,
    inProcessCents,
    pendingCents: Math.max(0, diff),
    creditCents: Math.max(0, -diff),
  };
}
