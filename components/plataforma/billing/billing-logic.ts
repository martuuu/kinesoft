/**
 * Lógica pura de /plataforma → Facturación, Precios y el cambio de plan desde Plataforma (PL-3c, plan §20.5.6 sin
 * Mercado Pago). Sin React, sin `next/*`, sin DB: la usan las páginas (server), los componentes cliente y el render
 * test.
 *
 * Plata: todo en centavos `Int`. Fechas: los períodos y vencimientos llegan como clave civil AR «YYYY-MM-DD» y se
 * formatean con `formatDayKeyAR` (mediodía AR: ningún host los corre un día); los instantes (ISO) con `formatDateAR`.
 */
import type {
  SaasAdjustmentKind,
  SaasChargeStatus,
  SaasCollectionMethod,
  SaasPaymentMethod,
  SaasPaymentStatus,
  SaasPlan,
  SubscriptionStatus,
} from "@prisma/client";
import { formatARS, formatMoneyInput } from "@/lib/format";
import { toARDateKey } from "@/lib/datetime-ar";
import { mustDisableFor, seatKindOf, type SeatTally } from "@/lib/plan-catalog";
import { RECEIPT_MAX_BYTES, RECEIPT_MIME_TYPES, isDateKey } from "@/lib/saas-billing-logic";
import { SAAS_PLANS } from "@/lib/saas-plans-logic";
import type { PlatformAccountRow, PlatformAccountsFilter, PlatformReanchorPreview } from "@/lib/platform-billing-types";
import type {
  AddAdjustmentInput,
  BillingAdjustmentRow,
  BillingAutoDebitStatus,
  PlatformMpSubscriptionStatus,
} from "@/lib/saas-billing-types";
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

// ── Registrar pago ──────────────────────────────────────────────────────────────────────────────────────────────

// PL-F1a: se quitaron `PAYMENT_SOURCE_LABEL` («Manual» / «Débito de Mercado Pago» / «Mercado Pago»: sin cobro por MP
// todo pago es MANUAL, la columna no decía nada) y los medios de pago propios con `composePaymentNote` (el medio iba
// como prefijo de la nota porque M8 no tenía columna). El medio ahora es `SaasPayment.method` (M8c) con
// `SAAS_PAYMENT_METHODS` / `SAAS_PAYMENT_METHOD_LABEL` de lib/saas-billing-types.ts, los mismos que el consultorio.

export const NOTE_MAX = 500;

export type RecordPaymentState = {
  amountCents: number | null;
  /** «YYYY-MM-DD» del `<input type="date">`. */
  paidOn: string;
  method: SaasPaymentMethod;
  note: string;
  /** Cargo a imputar. Default (PL-F1a): el último impago. "" = a cuenta (el núcleo lo aplica del más viejo). */
  chargeId: string;
  file: { name: string; size: number; type: string } | null;
};

export function emptyRecordPayment(now: Date, amountCents: number | null = null, chargeId = ""): RecordPaymentState {
  return { amountCents, paidOn: toARDateKey(now), method: "TRANSFER", note: "", chargeId, file: null };
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
  if (s.note.trim().length > NOTE_MAX) e.note = `La nota puede tener hasta ${NOTE_MAX} caracteres.`;
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
  fd.set("method", s.method);
  // PL-F1a: la nota va tal cual (sin el «Medio: …» de antes de M8c).
  if (s.note.trim()) fd.set("note", s.note.trim());
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

// ── MPS-4b (§26.6 UI de Plataforma): suscripción con Mercado Pago, ajustes y re-anclaje ─────────────────────────────

/**
 * Qué partes de la UI de MPS se muestran según `SAAS_BILLING_MODE` (regla de Martin: con el cobro apagado no aparece
 * nada a medio hacer).
 *  - `off`: nada nuevo. El cron no genera cargos, así que un ajuste quedaría pendiente para siempre y una baja o una
 *    bajada programada no la aplica nadie: mostrar los botones sería prometer algo que no pasa.
 *  - `manual`: ajustes, re-anclar, deshacer baja y anular bajada (los aplica el cron), pero nada de Mercado Pago (el
 *    puerto está apagado: «Consultar en Mercado Pago» no tendría a quién preguntar).
 *  - `mp`: todo.
 */
export type MpsUi = { subscription: boolean; adjustments: boolean; mercadoPago: boolean };
export function mpsUiFor(mode: "off" | "manual" | "mp"): MpsUi {
  if (mode === "off") return { subscription: false, adjustments: false, mercadoPago: false };
  return { subscription: true, adjustments: true, mercadoPago: mode === "mp" };
}

/**
 * «4/12» (día/mes sin ceros) desde una clave civil AR «YYYY-MM-DD», el formato del copy de §26.6 («próximo 4/12 por
 * $X»). Corta el string: una clave civil no tiene zona, así que no pasa por `Date` (ningún host la corre un día).
 */
export function dayMonthAR(key: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return key;
  return `${Number(m[3])}/${Number(m[2])}`;
}

/** Lo mismo para un instante ISO: primero el día civil en Argentina (`toARDateKey`), después «d/m». */
export function instantDayMonthAR(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : dayMonthAR(toARDateKey(d));
}

/** Mismos rótulos que «Cómo pagás» del consultorio (§26.6 UI), para que Plataforma y el titular hablen igual. */
export const COLLECTION_METHOD_LABEL: Record<SaasCollectionMethod, string> = {
  AUTO_DEBIT: "Débito automático con Mercado Pago",
  MP_CHECKOUT: "Mercado Pago cada mes",
  TRANSFER: "Transferencia",
};

export function collectionMethodText(m: SaasCollectionMethod | null | undefined): string {
  return m ? COLLECTION_METHOD_LABEL[m] : "Sin elegir";
}

export const ADJUSTMENT_KIND_LABEL: Record<SaasAdjustmentKind, string> = {
  PRORATION: "Proporcional",
  CREDIT: "Saldo a favor",
  DEBIT: "Cargo extra",
  CARRYOVER: "Saldo del cargo anterior",
};

/** Monto con signo: «+ $ 1.500» (suma al cargo) / «− $ 1.500» (resta). El ajuste ya viene con signo del núcleo. */
export function signedARS(cents: number): string {
  if (cents < 0) return `− ${formatARS(-cents)}`;
  return `+ ${formatARS(cents)}`;
}

/** «Proporcional · 12 de 30 días», «Saldo a favor»… (los días solo existen en PRORATION). */
export function adjustmentTitle(a: Pick<BillingAdjustmentRow, "kind" | "days" | "periodDays" | "planFrom" | "planTo">, planLabel: (p: SaasPlan) => string): string {
  const base = ADJUSTMENT_KIND_LABEL[a.kind];
  if (a.kind !== "PRORATION") return base;
  const plans = a.planFrom && a.planTo ? ` ${planLabel(a.planFrom)} → ${planLabel(a.planTo)}` : "";
  const days = a.days != null && a.periodDays != null ? ` · ${a.days} de ${a.periodDays} días` : "";
  return `${base}${plans}${days}`;
}

export const AUTO_DEBIT_STATUS_LABEL: Record<BillingAutoDebitStatus, string> = {
  none: "Sin débito automático",
  pending_authorization: "Falta que el titular autorice el débito",
  active: "Débito activo",
  paused: "Débito en pausa este mes",
  failed: "No pudimos debitar",
  cancelled: "Débito cancelado",
  blocked: "Débito bloqueado desde Plataforma",
};

/**
 * Estado del preapproval tal como lo devuelve Mercado Pago (`authorized`, `pending`, `paused`, `cancelled`). Un valor
 * desconocido se muestra crudo: es Plataforma y sirve más el dato real que un «Otro».
 */
export function mpPreapprovalStatusText(s: string | null): string {
  if (s == null) return "Sin dato";
  const map: Record<string, string> = { authorized: "Autorizado", pending: "Pendiente de autorización", paused: "Pausado", cancelled: "Cancelado" };
  return map[s] ?? s;
}

/**
 * Por qué hay desvío (`drift` de `getMpSubscriptionStatus`): MP dice otro estado u otro monto que lo guardado. Lo
 * corrige la conciliación diaria (etapa 4b del cron); acá solo se explica qué difiere. null = sin desvío.
 */
export function mpDriftText(s: Pick<PlatformMpSubscriptionStatus, "drift" | "storedStatus" | "liveStatus" | "amountCents" | "liveAmountCents">): string | null {
  if (!s.drift) return null;
  const parts: string[] = [];
  if (s.liveStatus !== s.storedStatus) {
    parts.push(`Mercado Pago dice «${mpPreapprovalStatusText(s.liveStatus)}» y acá figura «${mpPreapprovalStatusText(s.storedStatus)}»`);
  }
  if (s.liveAmountCents != null && s.liveAmountCents !== s.amountCents) {
    parts.push(`el monto en Mercado Pago es ${formatARS(s.liveAmountCents)} y acá figura ${s.amountCents == null ? "sin monto" : formatARS(s.amountCents)}`);
  }
  const what = parts.length ? parts.join("; ") : "Mercado Pago no coincide con lo guardado";
  return `${what.charAt(0).toUpperCase()}${what.slice(1)}. La conciliación diaria lo corrige sola; si sigue mañana, revisalo.`;
}

// ── Ajustes manuales (CREDIT / DEBIT) ───────────────────────────────────────────────────────────────────────────

export const ADJUSTMENT_DESCRIPTION_MAX = 300;
export type ManualAdjustmentKind = "CREDIT" | "DEBIT";
export type AdjustmentFormState = { amountCents: number | null; description: string };

/**
 * UUID v4 por apertura del diálogo (el server lo valida con `z.uuid()`). Copia del de `new-tenant-drawer.tsx` y no un
 * import: ese módulo arrastra la action de alta de consultorios al chunk del ledger. `randomUUID` exige contexto
 * seguro (localhost/https); el fallback arma el v4 con `getRandomValues`.
 */
export function newAdjustmentKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function emptyAdjustment(): AdjustmentFormState {
  return { amountCents: null, description: "" };
}

export function isAdjustmentDirty(s: AdjustmentFormState): boolean {
  return s.amountCents != null || s.description.trim() !== "";
}

export function validateAdjustment(s: AdjustmentFormState): Record<string, string> {
  const e: Record<string, string> = {};
  if (s.amountCents == null || s.amountCents <= 0) e.amount = "Ingresá un monto mayor a cero.";
  if (!s.description.trim()) e.description = "Contá el motivo: lo ve el consultorio en su cargo.";
  else if (s.description.trim().length > ADJUSTMENT_DESCRIPTION_MAX) e.description = `Hasta ${ADJUSTMENT_DESCRIPTION_MAX} caracteres.`;
  return e;
}

/**
 * Payload de `addAdjustment`: el monto va POSITIVO (el signo lo pone el tipo en el server, CHECK de M16) y la clave es
 * la del diálogo abierto (un reintento o un doble clic devuelven el mismo ajuste). Sin `effectiveOn`: el server lo
 * pone en el próximo cobro guardado.
 */
export function buildAdjustmentPayload(tenantId: string, kind: ManualAdjustmentKind, s: AdjustmentFormState, idempotencyKey: string): AddAdjustmentInput {
  return { tenantId, kind, amountCents: s.amountCents ?? 0, description: s.description.trim(), idempotencyKey };
}

export const ADJUSTMENT_COPY: Record<ManualAdjustmentKind, { button: string; title: string; intro: string; ok: string; confirm: (cents: number) => string }> = {
  CREDIT: {
    button: "Sumar saldo a favor",
    title: "Sumar saldo a favor",
    intro: "Se descuenta del próximo cargo. Si es más que el cargo, lo que sobra pasa al siguiente: el cargo nunca queda en negativo.",
    ok: "Saldo a favor sumado",
    confirm: (c) => `Se descuentan ${formatARS(c)} del próximo cargo del consultorio.`,
  },
  DEBIT: {
    button: "Cargo extra",
    title: "Cargo extra",
    intro: "Se suma al próximo cargo del consultorio, con la descripción que escribas.",
    ok: "Cargo extra sumado",
    confirm: (c) => `Se suman ${formatARS(c)} al próximo cargo del consultorio.`,
  },
};

// ── Re-anclar al 4 ──────────────────────────────────────────────────────────────────────────────────────────────

const dayKeyText = (k: string | null) => (k ? dayMonthAR(k) : "—");

/** Filas «antes → después» del preview de re-anclaje (tabla del diálogo). */
export function reanchorRows(p: PlatformReanchorPreview): Array<{ label: string; before: string; after: string }> {
  return [
    { label: "Día de cobro", before: `El ${p.fromAnchorDay}`, after: `El ${p.toAnchorDay}` },
    { label: "Próximo cobro", before: dayKeyText(p.oldNextChargeOn), after: dayKeyText(p.newNextChargeOn) },
  ];
}

/** Texto del cargo proporcional que arma el primer cargo después de re-anclar (stub). */
export function reanchorStubText(p: PlatformReanchorPreview): string {
  if (p.stubCents <= 0) return `Se factura desde el ${dayKeyText(p.stubFrom)}. No hay proporcional: el período arranca justo el ${p.toAnchorDay} o el plan no tiene precio.`;
  return `Se factura desde el ${dayKeyText(p.stubFrom)}. El primer cargo suma un proporcional de ${formatARS(p.stubCents)} (${p.days} de ${p.periodDays} días, hasta el ${dayKeyText(p.stubTo)}).`;
}
