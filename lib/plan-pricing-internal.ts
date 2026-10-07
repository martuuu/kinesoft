import "server-only";

/**
 * Plata de Planes del lado server (S16b, ES2b P2.2; PLANES.md C5 y C2 (3)).
 *
 * `lib/plan-pricing.ts` (puro, ES1) decide QUÉ se escribe (`repricePlan`,
 * `distributePackage`, `repriceLockReason`); acá vive el CÓMO dentro de la tx:
 *   - `lockProgramRowsInTx`: C2 (3) "toda escritura multi-fila (reprecio,
 *     redistribución, desestampado, cancelar futuros) hace antes `SELECT … FOR
 *     UPDATE ORDER BY id` de las candidatas", en el orden global Booking →
 *     Session → TreatmentProgram. Se lockean TODOS los turnos de TODAS las
 *     sesiones del plan (también cancelados y ausentes): un turno previo
 *     cobrado bloquea su fila igual que el activo, y un plan tiene ≤ 60
 *     sesiones, así que "todas" es barato y no deja huecos.
 *   - `writeRepriceInTx`: el CAS por fila con conteo esperado conjunto de C5
 *     (ramas (a) re-estampar, (b) primer estampado y desestampado) y el CAS de
 *     la cuota de cada sesión. `count` ≠ esperado → `PlanPricingConflict` →
 *     rollback total (el caller lo traduce a "el plan cambió").
 *
 * Por qué se vuelve a leer DESPUÉS de los locks (y no se decide con lo leído
 * antes): en READ COMMITTED un "Cobrado" (`setBookingCopagoPaid`, que no toma
 * el lock del paciente) puede commitear entre la lectura y el `FOR UPDATE`. Con
 * la relectura bajo lock, ese turno ya se ve con plata → fila bloqueada → su
 * monto no se toca ("reprecio ∥ Cobrado → el cobrado conserva su monto"). El
 * CAS por fila queda como cinturón: si algo se coló igual, rollback.
 *
 * No toma cupo (C2 (1)): el reprecio no mueve turnos de horario. Así no hay
 * ciclo contra `applyDayLock` (cupo → Booking id asc): los dos lockean Booking
 * en orden de id y este camino nunca pide un lock de cupo con filas tomadas.
 *
 * `lib/copago.ts` no se toca (AUDIT §5.5): la cuota de plan es otra fuente.
 */
import type { DbClient } from "@/lib/rls";
import type { BookingChangeRef } from "@/lib/booking-events-internal";
import {
  distributePackage,
  // Alias: `repricePlan` es también el nombre de la action de `lib/plans-edit.ts`.
  repricePlan as repricePlanPure,
  repriceLockReason,
  type PlanPricing,
  type RepriceResult,
  type RepriceSessionRow,
  type RepriceStamp,
} from "@/lib/plan-pricing";
import type { ProgramEngineRow } from "@/lib/plans-load-internal";

/** El CAS de plata perdió (una fila cambió bajo los pies): rollback total. */
export class PlanPricingConflict extends Error {
  constructor(detail: string) {
    super(`plan-pricing: conflicto de escritura (${detail})`);
    this.name = "PlanPricingConflict";
  }
}

// ─── Locks (C2 (3)) ──────────────────────────────────────────────────────────

/**
 * Booking (`FOR UPDATE`, id asc) → Session (id asc) → TreatmentProgram, de
 * todo el plan. Precondición: el caller ya tomó `lockPlanPatient` (C2 (0)) y,
 * si corresponde, los cupos y las sedes del motor. 3 sentencias fijas.
 *
 * Por qué los turnos se buscan por `Session.programId` y no por
 * `Booking.programId`: un turno vinculado tiene los dos (CHECK
 * `Booking_plan_link_check`), y así un JOIN con el tenant del plan basta
 * (`Session` no tiene `tenantId`).
 */
export async function lockProgramRowsInTx(tx: DbClient, o: { tenantId: string; programId: string }): Promise<void> {
  await tx.$queryRaw`
    SELECT b."id" FROM "Booking" b
    WHERE b."tenantId" = ${o.tenantId}
      AND b."sessionId" IN (
        SELECT s."id" FROM "Session" s
        JOIN "TreatmentProgram" p ON p."id" = s."programId"
        WHERE s."programId" = ${o.programId} AND p."tenantId" = ${o.tenantId}
      )
    ORDER BY b."id"
    FOR UPDATE OF b`;
  await tx.$queryRaw`
    SELECT s."id" FROM "Session" s
    JOIN "TreatmentProgram" p ON p."id" = s."programId"
    WHERE s."programId" = ${o.programId} AND p."tenantId" = ${o.tenantId}
    ORDER BY s."id"
    FOR UPDATE OF s`;
  await tx.$queryRaw`
    SELECT "id" FROM "TreatmentProgram"
    WHERE "id" = ${o.programId} AND "tenantId" = ${o.tenantId}
    FOR UPDATE`;
}

// ─── Adaptadores puros ───────────────────────────────────────────────────────

/** El precio vigente del plan, en la forma de `repricePlan` / `PlanPricingSchema`. */
export function programPricingOf(
  p: Pick<ProgramEngineRow, "pricingMode" | "pricePerSessionCents" | "totalPriceCents">
): PlanPricing {
  if (p.pricingMode === "PER_SESSION" && p.pricePerSessionCents != null) {
    return { mode: "PER_SESSION", pricePerSessionCents: p.pricePerSessionCents };
  }
  if (p.pricingMode === "PACKAGE" && p.totalPriceCents != null) {
    return { mode: "PACKAGE", totalPriceCents: p.totalPriceCents };
  }
  return null;
}

/** Columnas del plan para un precio (espejo del CHECK `TreatmentProgram_pricing_check`). */
export function pricingColumns(pricing: PlanPricing): {
  pricingMode: "PER_SESSION" | "PACKAGE" | null;
  pricePerSessionCents: number | null;
  totalPriceCents: number | null;
} {
  return {
    pricingMode: pricing?.mode ?? null,
    pricePerSessionCents: pricing?.mode === "PER_SESSION" ? pricing.pricePerSessionCents : null,
    totalPriceCents: pricing?.mode === "PACKAGE" ? pricing.totalPriceCents : null,
  };
}

/** Sesiones vivas del loader del motor → filas de `repricePlan` (con TODOS sus turnos). */
export function repriceRowsOf(program: Pick<ProgramEngineRow, "sessions">): RepriceSessionRow[] {
  return program.sessions.map((s) => ({
    id: s.id,
    index: s.index,
    scheduledFor: s.scheduledFor,
    completedAt: s.completedAt,
    priceCents: s.priceCents,
    bookings: s.bookings.map((b) => ({
      id: b.id,
      status: b.status,
      paymentStatus: b.paymentStatus,
      insurerPaidAt: b.insurerPaidAt,
      payment: b.payment,
      copagoCents: b.copagoCents,
      pricedByPlan: b.pricedByPlan,
      scheduledFor: b.scheduledFor,
    })),
  }));
}

const msOf = (d: Date | string) => (typeof d === "string" ? Date.parse(d) : d.getTime());

/**
 * PACKAGE "mantener el total" al AGREGAR sesiones (C13 S22e): el total no
 * cambia; lo bloqueado (C5 · fila bloqueada) queda como está y la diferencia
 * se reparte (P4) entre las libres existentes + las nuevas, por fecha y
 * después `index` (el resto en las primeras, como `repricePlan`).
 *
 * Las filas NUEVAS siempre son libres (no tienen turnos ni plata), aunque una
 * "a medida" caiga en el pasado: si pasaran por `repriceLockReason` quedarían
 * "past" con cuota null y el paquete violaría I6 (Σ cuotas = total, toda
 * sesión viva con cuota).
 *
 * La parte de las existentes se re-calcula con el `repricePlan` puro (ES1,
 * testeado) sobre el sub-total que les toca, así sus estampados salen de la
 * misma función que el reprecio: Σ existentes = bloqueado + su parte, Σ nuevas
 * = el resto → Σ = total siempre. El reparto de un peso de resto puede caer
 * distinto que en un reparto único, pero nunca cambia la suma.
 */
export function packageKeepTotalWithNewRows(o: {
  totalCents: number;
  sessions: RepriceSessionRow[];
  newRows: ReadonlyArray<{ index: number; at: Date }>;
  now: Date;
}):
  | { ok: true; existing: Extract<RepriceResult, { ok: true }>; newPrices: Map<number, number> }
  | { ok: false; error: string } {
  const locks = o.sessions.map((s) => repriceLockReason(s, o.now));
  const lockedCents = o.sessions.reduce((a, s, i) => a + (locks[i] ? (s.priceCents ?? 0) : 0), 0);
  if (o.totalCents < lockedCents) {
    return { ok: false, error: "El total del paquete es menor que lo ya cobrado o realizado: cambiá el precio antes de agregar sesiones." };
  }
  type Free = { key: string; at: number; index: number };
  const free: Free[] = [
    ...o.sessions.filter((_, i) => locks[i] === null).map((s) => ({ key: `s:${s.id}`, at: msOf(s.scheduledFor), index: s.index })),
    ...o.newRows.map((r) => ({ key: `n:${r.index}`, at: r.at.getTime(), index: r.index })),
  ].sort((a, b) => a.at - b.at || a.index - b.index);
  const parts = distributePackage(o.totalCents - lockedCents, free.length);
  const share = new Map(free.map((f, i) => [f.key, parts[i]]));
  const existingFree = o.sessions.reduce((a, s, i) => a + (locks[i] === null ? (share.get(`s:${s.id}`) ?? 0) : 0), 0);
  const newPrices = new Map(o.newRows.map((r) => [r.index, share.get(`n:${r.index}`) ?? 0]));

  // `repricePlan` reparte `existingFree` entre las mismas libres existentes.
  const existing = repricePlanPure({ pricing: { mode: "PACKAGE", totalPriceCents: lockedCents + existingFree }, sessions: o.sessions, now: o.now });
  if (!existing.ok) return { ok: false, error: existing.error };
  return { ok: true, existing, newPrices };
}

// ─── Escritura (C5 · CAS por fila, conteo esperado conjunto) ─────────────────

export type SessionPriceChange = { sessionId: string; from: number | null; to: number | null };

/** Turnos estampados: refs para `afterBookingsCommitted` (cambió el cobro). */
export type RepriceWriteResult = { refs: BookingChangeRef[]; stampedBookingIds: string[] };

/** Agrupa por clave para escribir N filas iguales en UN `updateMany` con conteo esperado. */
function groupBy<T>(xs: readonly T[], key: (x: T) => string): T[][] {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    const list = m.get(k);
    if (list) list.push(x);
    else m.set(k, [x]);
  }
  return Array.from(m.values());
}

/**
 * Escribe el resultado de un reprecio (o de una redistribución del paquete)
 * con las filas YA lockeadas (`lockProgramRowsInTx`) y releídas:
 *   1. cuotas de sesión: CAS `{id, programId, plan del tenant, viva, no
 *      realizada, priceCents: anterior}`;
 *   2. turnos, por rama (C5 literal):
 *      (a) re-estampar: `{id, tenantId, programId, pricedByPlan:true,
 *          copagoCents: esperado, paymentStatus:'UNPAID', status in
 *          [PENDING,CONFIRMED], scheduledFor > now, payment null|UNPAID|FAILED}`
 *          (+ `insurerPaidAt: null`, mismo criterio que `bookingHasMoney`);
 *      (b) primer estampado: lo mismo con `pricedByPlan:false, copagoCents:null`;
 *      desestampado: (a) con destino `copagoCents:null, pricedByPlan:false`.
 * Cualquier `count` ≠ esperado → `PlanPricingConflict` (rollback total).
 */
export async function writeRepriceInTx(
  tx: DbClient,
  o: {
    tenantId: string;
    programId: string;
    sessions: readonly SessionPriceChange[];
    stamps: readonly RepriceStamp[];
    now: Date;
  }
): Promise<RepriceWriteResult> {
  const { tenantId, programId, now } = o;
  for (const g of groupBy(o.sessions.filter((s) => s.from !== s.to), (s) => `${s.from}|${s.to}`)) {
    const res = await tx.session.updateMany({
      where: {
        id: { in: g.map((s) => s.sessionId) },
        programId,
        program: { tenantId },
        archivedAt: null,
        completedAt: null,
        priceCents: g[0].from,
      },
      data: { priceCents: g[0].to },
    });
    if (res.count !== g.length) throw new PlanPricingConflict(`sesiones ${res.count}/${g.length}`);
  }

  const stampedBookingIds: string[] = [];
  for (const g of groupBy(o.stamps, (s) => `${s.branch}|${s.expectedCopagoCents}|${s.copagoCents}`)) {
    const s0 = g[0];
    const ids = g.map((s) => s.bookingId);
    const res = await tx.booking.updateMany({
      where: {
        id: { in: ids },
        tenantId,
        programId,
        pricedByPlan: s0.branch !== "first",
        copagoCents: s0.expectedCopagoCents,
        paymentStatus: "UNPAID",
        insurerPaidAt: null,
        status: { in: ["PENDING", "CONFIRMED"] },
        scheduledFor: { gt: now },
        OR: [{ payment: { is: null } }, { payment: { is: { status: { in: ["UNPAID", "FAILED"] } } } }],
      },
      data: { copagoCents: s0.copagoCents, pricedByPlan: s0.pricedByPlan },
    });
    if (res.count !== g.length) throw new PlanPricingConflict(`turnos ${s0.branch} ${res.count}/${g.length}`);
    stampedBookingIds.push(...ids);
  }

  const refs: BookingChangeRef[] = stampedBookingIds.length
    ? (
        await tx.booking.findMany({
          where: { id: { in: stampedBookingIds }, tenantId },
          select: { id: true, practitionerId: true, scheduledFor: true },
          orderBy: { id: "asc" },
        })
      ).map((b) => ({ bookingId: b.id, practitionerId: b.practitionerId, scheduledFor: b.scheduledFor, prev: null, kind: "booking" as const }))
    : [];
  return { refs, stampedBookingIds };
}

/** Cambios de cuota de un `RepriceResult` ok, contra las filas de entrada. */
export function sessionChangesOf(
  rows: readonly RepriceSessionRow[],
  r: Extract<RepriceResult, { ok: true }>
): SessionPriceChange[] {
  const before = new Map(rows.map((s) => [s.id, s.priceCents]));
  return r.sessions
    .filter((s) => s.changed)
    .map((s) => ({ sessionId: s.sessionId, from: before.get(s.sessionId) ?? null, to: s.priceCents }));
}
