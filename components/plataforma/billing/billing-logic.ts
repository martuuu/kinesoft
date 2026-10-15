/**
 * Lógica pura de /plataforma → Facturación, Precios y el cambio de plan desde Plataforma (PL-3c, plan §20.5.6 sin
 * Mercado Pago). Sin React, sin `next/*`, sin DB: la usan las páginas (server), los componentes cliente y el render
 * test.
 *
 * Plata: todo en centavos `Int`. Fechas: los períodos y vencimientos llegan como clave civil AR «YYYY-MM-DD» y se
 * formatean con `formatDayKeyAR` (mediodía AR: ningún host los corre un día); los instantes (ISO) con `formatDateAR`.
 */
import type {
  SaasChargeStatus,
  SaasPaymentSource,
  SaasPaymentStatus,
  SaasPlan,
  SubscriptionStatus,
} from "@prisma/client";
import { formatARS, formatMoneyInput } from "@/lib/format";
import { toARDateKey } from "@/lib/datetime-ar";
import { mustDisableFor, seatKindOf, type SeatTally } from "@/lib/plan-catalog";
import { RECEIPT_MAX_BYTES, RECEIPT_MIME_TYPES, isDateKey } from "@/lib/saas-billing-logic";
import { SAAS_PLANS } from "@/lib/saas-plans-logic";
import type { PlatformAccountRow, PlatformAccountsFilter } from "@/lib/platform-billing-types";
import type { PlanChangePreview } from "@/lib/saas-plan-change-types";

// ── Lista de cuentas ────────────────────────────────────────────────────────────────────────────────────────────

export const BILLING_PATH = "/plataforma/facturacion";
export const PRICES_PATH = "/plataforma/precios";

export type AccountsView = NonNullable<PlatformAccountsFilter["view"]>;
const SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = ["TRIALING", "ACTIVE", "PAST_DUE", "CANCELLED"];

/** Filtros de la lista, en la URL (`?ver=deuda|revisar|vencidas&plan=&estado=&q=&desde=`), como Mensajes y Usuarios. */
export type AccountsQuery = {
  view: AccountsView;
  plan: SaasPlan | "";
  status: SubscriptionStatus | "";
  q: string;
  cursor: string | null;
};

type RawParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const VIEW_PARAM: Record<string, AccountsView> = { deuda: "debt", revisar: "to_review", vencidas: "past_due" };
const VIEW_SLUG: Record<AccountsView, string | null> = { all: null, debt: "deuda", to_review: "revisar", past_due: "vencidas" };

export const VIEW_FILTERS: ReadonlyArray<{ value: AccountsView; label: string }> = [
  { value: "all", label: "Todas" },
  { value: "debt", label: "Con deuda" },
  { value: "to_review", label: "Comprobantes a revisar" },
  { value: "past_due", label: "Vencidas" },
];

/** Valor de `?ver=` de una vista (null = todas). */
export function viewParam(v: AccountsView): string | null {
  return VIEW_SLUG[v];
}

export function parseAccountsQuery(sp: RawParams): AccountsQuery {
  const ver = first(sp.ver);
  const plan = first(sp.plan);
  const estado = first(sp.estado);
  const q = (first(sp.q) ?? "").trim().slice(0, 100);
  const desde = first(sp.desde);
  return {
    view: (ver && VIEW_PARAM[ver]) || "all",
    plan: plan && (SAAS_PLANS as readonly string[]).includes(plan) ? (plan as SaasPlan) : "",
    status: estado && (SUBSCRIPTION_STATUSES as readonly string[]).includes(estado) ? (estado as SubscriptionStatus) : "",
    q,
    cursor: desde && desde.length <= 64 ? desde : null,
  };
}

export function accountsHref(q: Omit<AccountsQuery, "cursor">, cursor?: string | null): string {
  const p = new URLSearchParams();
  const v = viewParam(q.view);
  if (v) p.set("ver", v);
  if (q.plan) p.set("plan", q.plan);
  if (q.status) p.set("estado", q.status);
  if (q.q) p.set("q", q.q);
  if (cursor) p.set("desde", cursor);
  const s = p.toString();
  return s ? `${BILLING_PATH}?${s}` : BILLING_PATH;
}

/** Lo que entiende `listAccounts`: vista, búsqueda, plan, estado de la suscripción y cursor (todo server-side). */
export function accountsFilterOf(q: AccountsQuery): PlatformAccountsFilter {
  return {
    view: q.view,
    ...(q.q ? { q: q.q } : {}),
    ...(q.plan ? { plan: q.plan } : {}),
    ...(q.status ? { subscriptionStatus: q.status } : {}),
    cursor: q.cursor,
  };
}

/**
 * Plan y estado ya los filtra `listAccounts` en el server (PL-3); esto queda como no-op idempotente sobre la página
 * (defensa por si la vista `past_due` pisa el estado elegido: la lista no muestra filas que contradigan el filtro).
 */
export function filterAccountRows(rows: readonly PlatformAccountRow[], q: Pick<AccountsQuery, "plan" | "status">): PlatformAccountRow[] {
  return rows.filter((r) => (!q.plan || r.saasPlan === q.plan) && (!q.status || r.subscriptionStatus === q.status));
}

export function hasAccountFilters(q: AccountsQuery): boolean {
  return q.view !== "all" || !!q.plan || !!q.status || !!q.q;
}

/**
 * Estado contable en palabras. El color no es el único canal (AGENTS §5): el texto dice lo mismo.
 *
 * PL-Z (B9): «N cargos vencidos» salía con `soft`, el tono MÁS apagado, por debajo de «Con deuda» (`sky`): lo más
 * urgente de la lista era lo que menos se veía. Ahora vencido = `sky` + `urgent` (la lista lo pinta como aviso) y
 * «Con deuda» (saldo sin vencer) baja a `soft`. `urgent` es el único que pide atención ya.
 */
export type AccountState = { label: string; tone: "lime" | "sky" | "soft"; urgent: boolean };

export function accountStateOf(r: Pick<PlatformAccountRow, "balanceCents" | "overdueCharges" | "subscriptionStatus">): AccountState {
  if (r.subscriptionStatus === "CANCELLED") return { label: "Cancelada", tone: "soft", urgent: false };
  if (r.overdueCharges > 0) {
    return { label: r.overdueCharges === 1 ? "1 cargo vencido" : `${r.overdueCharges} cargos vencidos`, tone: "sky", urgent: true };
  }
  if (r.balanceCents > 0) return { label: "Con deuda", tone: "soft", urgent: false };
  if (r.balanceCents < 0) return { label: "Saldo a favor", tone: "lime", urgent: false };
  return { label: "Al día", tone: "lime", urgent: false };
}

/** «Debe $ 15.000» / «A favor $ 2.000» / «$ 0». */
export function balanceText(cents: number): string {
  if (cents > 0) return `Debe ${formatARS(cents)}`;
  if (cents < 0) return `A favor ${formatARS(-cents)}`;
  return formatARS(0);
}

/** Precio que se cobra por mes: a medida (se rotula), de lista, o «Consultá» (no se cobra). */
export function priceText(p: { effectivePriceCents: number | null; customPriceCents: number | null }): { text: string; custom: boolean } {
  if (p.customPriceCents != null) return { text: `${formatARS(p.customPriceCents)}/mes`, custom: true };
  if (p.effectivePriceCents == null) return { text: "Consultá (no se cobra)", custom: false };
  return { text: `${formatARS(p.effectivePriceCents)}/mes`, custom: false };
}

// ── Ledger ──────────────────────────────────────────────────────────────────────────────────────────────────────

export const CHARGE_STATUS_LABEL: Record<SaasChargeStatus, string> = {
  OPEN: "Pendiente",
  PAID: "Pagado",
  VOID: "Anulado",
  WAIVED: "Condonado",
};

export const PAYMENT_STATUS_LABEL: Record<SaasPaymentStatus, string> = {
  PENDING_REVIEW: "A revisar",
  APPROVED: "Aprobado",
  REJECTED: "Rechazado",
  REFUNDED: "Devuelto",
};

export const PAYMENT_SOURCE_LABEL: Record<SaasPaymentSource, string> = {
  MANUAL: "Manual",
  MP_AUTO: "Débito de Mercado Pago",
  MP_CHECKOUT: "Mercado Pago",
};

// ── Registrar pago ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Medio de pago. El schema no tiene columna (M8): viaja como prefijo de la nota («Medio: Transferencia. …»), que es
 * lo que ve Plataforma en el ledger y queda en el pago. Default PL3c-D1.
 */
export const PAYMENT_METHODS = [
  { value: "transfer", label: "Transferencia" },
  { value: "cash", label: "Efectivo" },
  { value: "deposit", label: "Depósito" },
  { value: "mp_link", label: "Mercado Pago (link o QR)" },
  { value: "other", label: "Otro" },
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]["value"];

export const NOTE_MAX = 500;

export function composePaymentNote(method: PaymentMethod, note: string): string {
  const label = PAYMENT_METHODS.find((m) => m.value === method)?.label ?? "Otro";
  const rest = note.trim();
  return (rest ? `Medio: ${label}. ${rest}` : `Medio: ${label}.`).slice(0, NOTE_MAX);
}

export type RecordPaymentState = {
  amountCents: number | null;
  /** «YYYY-MM-DD» del `<input type="date">`. */
  paidOn: string;
  method: PaymentMethod;
  note: string;
  /** "" = el cargo pendiente más viejo (lo elige el server). */
  chargeId: string;
  file: { name: string; size: number; type: string } | null;
};

export function emptyRecordPayment(now: Date, amountCents: number | null = null): RecordPaymentState {
  return { amountCents, paidOn: toARDateKey(now), method: "transfer", note: "", chargeId: "", file: null };
}

export function isRecordPaymentDirty(s: RecordPaymentState, initial: RecordPaymentState): boolean {
  return (
    s.amountCents !== initial.amountCents ||
    s.paidOn !== initial.paidOn ||
    s.method !== initial.method ||
    s.note.trim() !== "" ||
    s.chargeId !== initial.chargeId ||
    s.file !== null
  );
}

export const RECEIPT_ACCEPT = RECEIPT_MIME_TYPES.join(",");

/**
 * Validación de cliente (la autoridad es el server: `parsePaymentForm` + magic bytes). El recibo es OBLIGATORIO
 * (decisión de Martin: todo pago manual se imputa con comprobante adjunto).
 */
export function validateRecordPayment(s: RecordPaymentState, now: Date): Record<string, string> {
  const e: Record<string, string> = {};
  if (s.amountCents == null || s.amountCents <= 0) e.amount = "Ingresá un monto mayor a cero.";
  if (!isDateKey(s.paidOn)) e.paidOn = "Revisá la fecha del pago.";
  else if (s.paidOn > toARDateKey(now)) e.paidOn = "La fecha del pago no puede ser futura.";
  if (!s.file) e.file = "Adjuntá el comprobante (PDF, JPG, PNG o WEBP de hasta 4 MB).";
  else if (s.file.size > RECEIPT_MAX_BYTES) e.file = "El comprobante pesa más de 4 MB.";
  else if (!(RECEIPT_MIME_TYPES as readonly string[]).includes(s.file.type)) e.file = "Subí un PDF, JPG, PNG o WEBP.";
  if (s.note.length > NOTE_MAX - 40) e.note = `La nota puede tener hasta ${NOTE_MAX - 40} caracteres.`;
  return e;
}

/**
 * FormData de `recordManualPayment`. OJO con el monto: el server lo lee con `parseMoneyInput` (TEXTO en pesos, «1.500»
 * o «1.500,50»), no en centavos. Mandar los centavos crudos (lo que deja el hidden de `MoneyInput name=`) cobraría
 * ×100. Por eso se re-formatea con `formatMoneyInput`, que es su inversa exacta.
 */
export function buildPaymentFormData(tenantId: string, s: RecordPaymentState, file: Blob): FormData {
  const fd = new FormData();
  fd.set("tenantId", tenantId);
  fd.set("amount", formatMoneyInput(s.amountCents));
  fd.set("paidOn", s.paidOn);
  if (s.chargeId) fd.set("chargeId", s.chargeId);
  fd.set("note", composePaymentNote(s.method, s.note));
  fd.set("file", file);
  return fd;
}

// ── Anular (confirmación tipeada) ───────────────────────────────────────────────────────────────────────────────

/**
 * Anular borra el cargo de la cuenta del consultorio (no «perdona lo que falta», eso es condonar): pide tipear la
 * palabra, como suspender pide el slug. Condonar va con `useConfirm` de un clic.
 */
export const VOID_CONFIRM_WORD = "ANULAR";
export function voidConfirmMatches(typed: string): boolean {
  return typed.trim().toUpperCase() === VOID_CONFIRM_WORD;
}

// ── Precios ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type PriceFormState = {
  /** «Consultá» = sin precio publicado (null): el plan no se cobra a quien no tenga precio a medida. */
  consulta: boolean;
  priceCents: number | null;
  effectiveFrom: string;
  note: string;
};

export function priceFormFor(current: number | null, now: Date): PriceFormState {
  return { consulta: current == null, priceCents: current, effectiveFrom: toARDateKey(now), note: "" };
}

export type PlanPricePayload = { plan: SaasPlan; priceCents: number | null; effectiveFrom: string; note: string | null };

export function validatePriceForm(s: PriceFormState): Record<string, string> {
  const e: Record<string, string> = {};
  if (!s.consulta && (s.priceCents == null || s.priceCents <= 0)) e.priceCents = "Ingresá el precio por mes o marcá «Consultá».";
  if (!isDateKey(s.effectiveFrom)) e.effectiveFrom = "Elegí desde qué día rige.";
  if (s.note.length > NOTE_MAX) e.note = `La nota puede tener hasta ${NOTE_MAX} caracteres.`;
  return e;
}

export function buildPlanPricePayload(plan: SaasPlan, s: PriceFormState): PlanPricePayload {
  return {
    plan,
    priceCents: s.consulta ? null : s.priceCents,
    effectiveFrom: s.effectiveFrom,
    note: s.note.trim() ? s.note.trim() : null,
  };
}

export function priceOrConsulta(cents: number | null): string {
  return cents == null ? "Consultá" : formatARS(cents);
}

/**
 * Aviso del editor: a quién le llega el mail del cambio (mismo criterio que el cron, `runSaasBilling`: consultorios
 * activos del plan, no cancelados, sin precio a medida; un cambio a «Consultá» no avisa).
 */
export function priceNoticeText(recipients: number, consulta: boolean): string {
  if (consulta) {
    return "Pasar a «Consultá» no manda aviso. Ojo: a los consultorios de este plan sin precio a medida se les deja de generar el cargo.";
  }
  if (recipients === 0) return "Ningún consultorio de este plan recibe aviso (no hay o todos tienen precio a medida).";
  return recipients === 1
    ? "1 consultorio sin precio a medida recibe un mail con el precio nuevo."
    : `${recipients} consultorios sin precio a medida reciben un mail con el precio nuevo.`;
}

// ── Cambio de plan desde Plataforma ─────────────────────────────────────────────────────────────────────────────

/** El Titular y quien está cambiando el plan nunca son candidatos (el núcleo los rechaza igual). */
export function isSelectable(c: PlanChangePreview["candidates"][number]): boolean {
  return !c.isOwner && !c.isSelf;
}

/** Miembros que quedan activos por tipo después de deshabilitar `disable` y reactivar `reactivate`. */
export function selectionTally(
  p: Pick<PlanChangePreview, "candidates" | "reactivatable">,
  disable: ReadonlySet<string>,
  reactivate: ReadonlySet<string>
): { professional: number; staff: number } {
  const t = { professional: 0, staff: 0 };
  for (const c of p.candidates) if (!disable.has(c.membershipId)) t[c.kind]++;
  for (const r of p.reactivatable) if (reactivate.has(r.membershipId)) t[seatKindOf(r)]++;
  return t;
}

/** Lo que todavía sobra con la selección (0 en todo = entra). Misma cuenta que el núcleo (`mustDisableFor`). */
export function selectionShortfall(
  p: Pick<PlanChangePreview, "candidates" | "reactivatable" | "limits">,
  disable: ReadonlySet<string>,
  reactivate: ReadonlySet<string>
): SeatTally {
  return mustDisableFor(selectionTally(p, disable, reactivate), p.limits);
}

export function selectionFits(
  p: Pick<PlanChangePreview, "candidates" | "reactivatable" | "limits">,
  disable: ReadonlySet<string>,
  reactivate: ReadonlySet<string>
): boolean {
  return selectionShortfall(p, disable, reactivate).total === 0;
}

/** «Elegí 1 persona más» / «Elegí 2 personas más (al menos 1 profesional)». */
export function shortfallText(s: SeatTally): string | null {
  if (s.total === 0) return null;
  const who = s.total === 1 ? "1 persona más" : `${s.total} personas más`;
  const parts: string[] = [];
  if (s.professional > 0) parts.push(s.professional === 1 ? "1 profesional" : `${s.professional} profesionales`);
  if (s.staff > 0) parts.push(s.staff === 1 ? "1 persona que no atiende" : `${s.staff} personas que no atienden`);
  return `Para entrar en el plan, elegí ${who} para deshabilitar${parts.length ? ` (al menos ${parts.join(" y ")})` : ""}.`;
}

export function limitText(n: number | null): string {
  return n == null ? "sin límite" : String(n);
}
