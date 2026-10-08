/**
 * Turnos y Facturación del perfil agrupados por plan (S22f, ES3 P3.1) — lógica
 * pura, sin React ni server: la consumen `turnos-view.tsx` y
 * `facturacion-view.tsx` y se testea en `tests/unit/render/facturacion-plan.test.tsx`.
 *
 * Reglas (PLANES §11 S22f + plan §16.2):
 *  - Un grupo por plan al que apunta algún turno (`Booking.programId`) más
 *    "Turnos sueltos". Sin módulo `planes` o sin ningún turno de plan → la
 *    vista de siempre (`shouldGroupByPlan` = false): un consultorio General no
 *    ve nada de Planes.
 *  - El saldo es el del SERVER (`getPatientPlanBalances` / `PlanDTO.balance`,
 *    P7 agregado en `lib/plans-read.ts`). Acá no se suma ni se recorta nada:
 *    el pactado de un plan cancelado (S14r: = devengado) llega ya resuelto.
 *  - El título del plan es PHI (PD-11/PD-13): sale solo si el caller lo
 *    habilita (`showPlanTitles`, acceso full + `clinical.read`) Y el server lo
 *    mandó (nivel `full`; en `admin` ya viene null por `planTitleFor`). Las dos
 *    barreras a propósito: si un día el server mandara el título por error, la
 *    Secretaria igual no lo ve.
 */
import { bookingHasMoney } from "@/lib/plan-pricing";
import type { Discipline } from "@/lib/plans-constants";
import type {
  PatientPlanBalances,
  PlanBalanceDTO,
  PlanDTO,
  ProgramStatusValue,
} from "@/lib/plans-read-types";

/** Lo mínimo de un turno que necesita el agrupado (lo cumple `PatientBookingFull`). */
export type GroupableBooking = {
  id: string;
  programId: string | null;
  sessionId: string | null;
};

export type PlanGroupMeta = {
  programId: string;
  discipline: Discipline | null;
  status: ProgramStatusValue | null;
  /** null = no se muestra (sin permiso, o el server no lo mandó). */
  title: string | null;
  archived: boolean;
  /** Sesiones vivas (el N de "Sesión n de N"); null si el plan no vino en `plans` (p. ej. archivado). */
  totalLive: number | null;
  /** Saldo P7 del server; null si no llegó (no se inventa). */
  balance: PlanBalanceDTO | null;
  /** sessionId → ordinal (M13: el que se muestra, no `index`). */
  ordinals: ReadonlyMap<string, number>;
};

export type BookingGroup<B> =
  | { kind: "plan"; key: string; plan: PlanGroupMeta; bookings: B[] }
  | { kind: "loose"; key: "loose"; bookings: B[] };

export type PlanGroupSources = {
  plans?: readonly PlanDTO[] | null;
  planBalances?: PatientPlanBalances | null;
  showPlanTitles?: boolean;
};

/**
 * Metadatos por plan: `plans` (getPatientPlans, sin archivados) manda para
 * disciplina/estado/ordinales; `planBalances` (incluye archivados) completa
 * los planes que no vinieron en `plans` y es la fuente preferida del saldo
 * (la misma que el total de Facturación).
 */
export function planGroupMetas(src: PlanGroupSources): Map<string, PlanGroupMeta> {
  const out = new Map<string, PlanGroupMeta>();
  const balanceRows = new Map((src.planBalances?.plans ?? []).map((r) => [r.programId, r]));
  for (const p of src.plans ?? []) {
    const row = balanceRows.get(p.id);
    const ordinals = new Map<string, number>();
    for (const s of p.sessions) if (s.ordinal != null) ordinals.set(s.id, s.ordinal);
    out.set(p.id, {
      programId: p.id,
      discipline: p.discipline,
      status: p.status,
      title: src.showPlanTitles && p.level === "full" ? p.title : null,
      archived: p.archivedAt != null,
      totalLive: p.totalLive,
      balance: row?.balance ?? p.balance ?? null,
      ordinals,
    });
  }
  for (const row of src.planBalances?.plans ?? []) {
    if (out.has(row.programId)) continue;
    out.set(row.programId, {
      programId: row.programId,
      discipline: row.discipline,
      status: row.status,
      title: src.showPlanTitles ? row.title : null,
      // No vino en `getPatientPlans` (que excluye archivados): es archivado.
      archived: true,
      totalLive: null,
      balance: row.balance,
      ordinals: new Map(),
    });
  }
  return out;
}

/** Agrupar solo con el módulo `planes` y algún turno de plan cargado. */
export function shouldGroupByPlan(plansEnabled: boolean, bookings: readonly GroupableBooking[]): boolean {
  return plansEnabled && bookings.some((b) => b.programId != null);
}

const STATUS_ORDER: Record<ProgramStatusValue, number> = { ACTIVE: 0, PAUSED: 1, COMPLETED: 2, CANCELLED: 3 };

/**
 * Grupos en orden: planes vivos primero (activo → pausado → completado →
 * cancelado; archivados al final), en el orden en que el server los mandó
 * dentro de cada estado, y "Turnos sueltos" último. Un turno cuyo plan no
 * vino en ninguna fuente (carrera con un borrado) igual se agrupa bajo su
 * plan, con metadatos vacíos: nunca se lo hace pasar por suelto.
 *
 * `includeBalanceOnly`: Facturación muestra también los planes SIN turnos
 * cargados que tienen plata pendiente o a favor (la lista de turnos está
 * paginada; el saldo del server no).
 */
export function groupBookingsByPlan<B extends GroupableBooking>(
  bookings: readonly B[],
  metas: ReadonlyMap<string, PlanGroupMeta>,
  opts: { includeBalanceOnly?: boolean } = {}
): BookingGroup<B>[] {
  const byPlan = new Map<string, B[]>();
  const loose: B[] = [];
  for (const b of bookings) {
    if (b.programId == null) {
      loose.push(b);
      continue;
    }
    const list = byPlan.get(b.programId);
    if (list) list.push(b);
    else byPlan.set(b.programId, [b]);
  }
  if (opts.includeBalanceOnly) {
    for (const m of metas.values()) {
      if (byPlan.has(m.programId) || !m.balance) continue;
      if (m.balance.pendingCents > 0 || m.balance.creditCents > 0 || m.balance.inProcessCents > 0) {
        byPlan.set(m.programId, []);
      }
    }
  }
  const metaOrder = new Map([...metas.keys()].map((id, i) => [id, i]));
  const rank = (m: PlanGroupMeta) => (m.archived ? 10 : 0) + (m.status ? STATUS_ORDER[m.status] : 5);
  const groups: BookingGroup<B>[] = [...byPlan.entries()]
    .map(([programId, list]) => ({
      kind: "plan" as const,
      key: programId,
      plan: metas.get(programId) ?? emptyMeta(programId),
      bookings: list,
    }))
    .sort(
      (a, b) =>
        rank(a.plan) - rank(b.plan) ||
        (metaOrder.get(a.key) ?? Number.MAX_SAFE_INTEGER) - (metaOrder.get(b.key) ?? Number.MAX_SAFE_INTEGER)
    );
  if (loose.length > 0) groups.push({ kind: "loose", key: "loose", bookings: loose });
  return groups;
}

function emptyMeta(programId: string): PlanGroupMeta {
  return {
    programId,
    discipline: null,
    status: null,
    title: null,
    archived: false,
    totalLive: null,
    balance: null,
    ordinals: new Map(),
  };
}

/** Ordinal "n de N" de un turno de plan, si se conoce. */
export function bookingPlanOrdinal(
  b: GroupableBooking,
  meta: PlanGroupMeta
): { ordinal: number; totalLive: number } | null {
  if (!b.sessionId || meta.totalLive == null) return null;
  const ordinal = meta.ordinals.get(b.sessionId);
  return ordinal == null ? null : { ordinal, totalLive: meta.totalLive };
}

/**
 * Estado del plan, el MISMO copy en el perfil y en `/planes` (P3.Z: acá decía
 * "Completado" y en `/planes` "Finalizado"; C13 no lo fija → "Finalizado").
 * `planes-model.ts` lo re-exporta: una sola fuente.
 */
export const PLAN_STATUS_LABEL: Readonly<Record<ProgramStatusValue, string>> = {
  ACTIVE: "Activo",
  PAUSED: "Pausado",
  COMPLETED: "Finalizado",
  CANCELLED: "Cancelado",
};

/**
 * Encabezado del grupo SIN título clínico: "Plan de Kinesiología" lo pone el
 * chip; acá va el texto que acompaña. Con título habilitado, el título.
 */
export function planGroupHeading(meta: PlanGroupMeta): string {
  if (meta.title) return meta.title;
  return meta.totalLive != null ? `Plan de ${meta.totalLive} ${meta.totalLive === 1 ? "sesión" : "sesiones"}` : "Plan";
}

export const LOOSE_GROUP_LABEL = "Turnos sueltos";

// ─── Facturación ─────────────────────────────────────────────────────────────

type BillingRow = {
  status: "PENDING" | "CONFIRMED" | "CANCELLED" | "NO_SHOW" | "COMPLETED";
  paymentStatus: "UNPAID" | "AUTHORIZED" | "PAID" | "REFUNDED" | "FAILED";
  insurerPaidAt: Date | string | null;
};

/** Lo de siempre: solo lo que efectivamente factura. */
export function isBillableBooking(b: BillingRow): boolean {
  return b.status === "CONFIRMED" || b.status === "COMPLETED";
}

/**
 * Cancelado o ausente CON plata (S22f: "cancelados con cobro visibles"). Un
 * turno de plan cancelado que se cobró sigue sumando en "cobrado" del saldo
 * (P7) y deja la sesión "Ya pagada" (C5); si Facturación lo escondiera, el
 * saldo diría "a favor" sin ninguna fila que lo explique. Criterio canónico
 * `bookingHasMoney` (PAID, AUTHORIZED, REFUNDED u OS pagada): el mismo que
 * bloquea su borrado y su reprecio. `PatientBookingFull` no trae el `Payment`
 * de MP; MP escribe `paymentStatus`, así que alcanza.
 */
export function isCancelledWithMoney(b: BillingRow): boolean {
  return (
    (b.status === "CANCELLED" || b.status === "NO_SHOW") &&
    bookingHasMoney({ paymentStatus: b.paymentStatus, insurerPaidAt: b.insurerPaidAt, payment: null })
  );
}

/**
 * Filas de Facturación: facturables + cancelados/ausentes con cobro, agrupada
 * o no (SR-D4F, Martin 08-oct). Antes la vista plana los escondía y un
 * cancelado cobrado de un consultorio General no figuraba en ningún lado.
 */
export function isBillingVisible(b: BillingRow): boolean {
  return isBillableBooking(b) || isCancelledWithMoney(b);
}

/** Turnos de plan no se eliminan desde la ficha (S22f): se cancelan o se sacan del plan. */
export function canDeleteFromProfile(b: { programId: string | null }): boolean {
  return b.programId == null;
}

export type BillingSummary = {
  osPaidCents: number;
  copagoPaidCents: number;
  pendingCents: number;
  /** Σ "a favor" de los planes (server); 0 sin planes. */
  creditCents: number;
  billableCount: number;
};

/**
 * Resumen de Facturación.
 *  - percibido (OS y copago) = Σ de las filas visibles, agrupada o no,
 *    incluidos los cancelados/ausentes cobrados (es plata que entró; SR-D4F).
 *    Copago: solo PAID; REFUNDED y AUTHORIZED se ven pero suman 0.
 *  - sin agrupar: pendiente = OS + copago impagos de los facturables.
 *  - agrupada: pendiente = OS pendiente de los facturables + copago pendiente de los
 *    turnos SUELTOS facturables + Σ pendiente de los planes DEL SERVER. El
 *    copago de un turno de plan no se suma fila por fila: lo que el paciente
 *    debe del plan es el saldo P7 (devengado − cobrado), y con paquete o
 *    cobro previo las dos cuentas no coinciden.
 */
export function billingSummary(
  bookings: readonly (BillingRow & { programId: string | null; copagoCents: number; osAmountCents: number })[],
  opts: { grouped: boolean; planBalances?: PatientPlanBalances | null }
): BillingSummary {
  const visible = bookings.filter(isBillingVisible);
  const billable = bookings.filter(isBillableBooking);
  const osPaidCents = visible.reduce((s, b) => s + (b.insurerPaidAt ? b.osAmountCents : 0), 0);
  const copagoPaidCents = visible.reduce((s, b) => s + (b.paymentStatus === "PAID" ? b.copagoCents : 0), 0);
  if (!opts.grouped) {
    const pendingCents = billable.reduce(
      (s, b) => s + (b.insurerPaidAt ? 0 : b.osAmountCents) + (b.paymentStatus === "PAID" ? 0 : b.copagoCents),
      0
    );
    return { osPaidCents, copagoPaidCents, pendingCents, creditCents: 0, billableCount: billable.length };
  }
  const osPending = billable.reduce((s, b) => s + (b.insurerPaidAt ? 0 : b.osAmountCents), 0);
  const loosePending = billable.reduce(
    (s, b) => s + (b.programId == null && b.paymentStatus !== "PAID" ? b.copagoCents : 0),
    0
  );
  const totals = opts.planBalances?.totals;
  return {
    osPaidCents,
    copagoPaidCents,
    pendingCents: osPending + loosePending + (totals?.pendingCents ?? 0),
    creditCents: totals?.creditCents ?? 0,
    billableCount: billable.length,
  };
}
