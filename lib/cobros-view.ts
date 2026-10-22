/**
 * [TP-3g] Lógica pura de `/cobros` (§25.10 «/cobros», C-TP9 `listOnlineCharges`): filtros ↔ URL, opciones de período,
 * input de la action y la fila ya lista para pintar (tabla desde 768 px, cards a 390).
 *
 * Por qué fuera de los componentes: la página (server) y el cliente leen los MISMOS filtros de la URL, y un filtro que
 * se arma distinto en cada lado es una página que muestra «Pagados» con la lista de los vencidos. Se prueba suelto en
 * `tests/unit/tp3g-cobros-view.test.ts`, en TZ=UTC y AR (el mes del filtro es el de Argentina).
 *
 * Client-safe: sin Prisma, sin `Buffer`, sin `server-only`. Por eso NO importa `lib/online-charges-view.ts` (el cursor
 * de ese módulo usa `Buffer` y arrastra el armado del DTO): la validación del período se repite acá con la misma regla
 * (`isChargePeriod`), y el test afirma que cada opción que ofrece la UI la acepta el server.
 *
 * Una URL vieja o tipeada a mano nunca termina en «Filtro inválido»: lo que no se reconoce cae al default. La action
 * igual valida todo con zod (la URL es input del usuario).
 */
import { toARDateKey } from "@/lib/datetime-ar";
import { formatARS } from "@/lib/format";
import { formatArDateTime } from "@/lib/mp-receipt";
import { CHARGE_KIND_LABEL, CHARGE_ORIGIN_LABEL, RECEIPT_COPY } from "@/lib/online-payments-copy";
import {
  CHARGE_STATUSES,
  type ChargeStatus,
  type ListOnlineChargesInput,
  type OnlineChargeNotice,
  type OnlineChargeView,
} from "@/lib/online-payments-types";

// ── Filtros ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** «live» = lo que el paciente todavía puede pagar o está en proceso (ACTIVE + AUTHORIZED), como en la action. */
export type CobrosStatusFilter = ChargeStatus | "live";

export type CobrosFilters = {
  origin: "TURNERO" | "LINK" | null;
  status: CobrosStatusFilter | null;
  /** `7d|30d|90d|YYYY-MM` (mes AR) o `todo` (sin período). */
  period: string;
  practitionerId: string | null;
};

/**
 * Default: los últimos 30 días, todos los estados. No «Pendientes» (el comentario de la action lo sugería): quien
 * entra a /cobros quiere ver qué se pagó y qué falta, y el resumen de arriba ya separa «Cobrado» de «Por cobrar».
 */
export const COBROS_DEFAULT_PERIOD = "30d";
export const COBROS_ALL_PERIOD = "todo";

/** Claves de la URL en castellano (se ven en la barra y se comparten por WhatsApp entre la Secretaría y el Titular). */
const KEY = { origin: "tipo", status: "estado", period: "periodo", practitioner: "profesional" } as const;

type SearchParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" ? s.trim() : null;
}

/** Misma regla que `isChargePeriod` (lib/online-charges-view.ts); el test afirma que coinciden. */
function isPeriod(p: string): boolean {
  return p === "7d" || p === "30d" || p === "90d" || /^\d{4}-(0[1-9]|1[0-2])$/.test(p);
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function parseCobrosFilters(sp: SearchParams): CobrosFilters {
  const origin = first(sp[KEY.origin]);
  const status = first(sp[KEY.status]);
  const period = first(sp[KEY.period]);
  const practitioner = first(sp[KEY.practitioner]);
  const upper = status?.toUpperCase() ?? "";
  return {
    origin: origin === "turnero" ? "TURNERO" : origin === "link" ? "LINK" : null,
    status:
      status === "live"
        ? "live"
        : status === status?.toLowerCase() && (CHARGE_STATUSES as readonly string[]).includes(upper)
          ? (upper as ChargeStatus)
          : null,
    period: period && (period === COBROS_ALL_PERIOD || isPeriod(period)) ? period : COBROS_DEFAULT_PERIOD,
    practitionerId: practitioner && ID_RE.test(practitioner) ? practitioner : null,
  };
}

export function hasActiveCobrosFilters(f: CobrosFilters): boolean {
  return f.origin !== null || f.status !== null || f.period !== COBROS_DEFAULT_PERIOD || f.practitionerId !== null;
}

/** `/cobros?…` con solo lo que no es default. Cambiar un filtro descarta la paginación (vuelve a la primera página). */
export function cobrosHref(f: CobrosFilters, patch: Partial<CobrosFilters> = {}): string {
  const n = { ...f, ...patch };
  const q = new URLSearchParams();
  if (n.origin) q.set(KEY.origin, n.origin.toLowerCase());
  if (n.status) q.set(KEY.status, n.status === "live" ? "live" : n.status.toLowerCase());
  if (n.period !== COBROS_DEFAULT_PERIOD) q.set(KEY.period, n.period);
  if (n.practitionerId) q.set(KEY.practitioner, n.practitionerId);
  const s = q.toString();
  return s ? `/cobros?${s}` : "/cobros";
}

/** Input de `listOnlineCharges` (C-TP9). `todo` = sin período. */
export function cobrosActionInput(f: CobrosFilters, cursor?: string): ListOnlineChargesInput {
  const out: ListOnlineChargesInput = {};
  if (f.origin) out.origin = f.origin;
  if (f.status) out.status = f.status;
  if (f.period !== COBROS_ALL_PERIOD) out.period = f.period;
  if (f.practitionerId) out.practitionerId = f.practitionerId;
  if (cursor) out.cursor = cursor;
  return out;
}

export type CobrosOption = { value: string; label: string };

export const COBROS_ORIGIN_OPTIONS: readonly CobrosOption[] = [
  { value: "", label: "Todos los tipos" },
  { value: "TURNERO", label: CHARGE_ORIGIN_LABEL.TURNERO },
  { value: "LINK", label: CHARGE_ORIGIN_LABEL.LINK },
];

/** Estados en el orden en que se leen: lo que falta, lo pagado, lo que ya no se puede pagar. Texto = el de la fila. */
export const COBROS_STATUS_OPTIONS: readonly CobrosOption[] = [
  { value: "", label: "Todos los estados" },
  { value: "live", label: "Pendientes y en proceso" },
  { value: "ACTIVE", label: "Pendiente de pago" },
  { value: "AUTHORIZED", label: "En proceso" },
  { value: "PAID", label: "Pagado" },
  { value: "REFUNDED", label: "Reintegrado" },
  { value: "EXPIRED", label: "Vencido" },
  { value: "CANCELLED", label: "Anulado" },
];

const MONTHS = [
  "Enero",
  "Febrero",
  "Marzo",
  "Abril",
  "Mayo",
  "Junio",
  "Julio",
  "Agosto",
  "Septiembre",
  "Octubre",
  "Noviembre",
  "Diciembre",
] as const;

/** Cuántos meses calendario ofrece el filtro (el actual incluido). Más atrás, «Todo». */
const MONTHS_BACK = 12;

/**
 * 7/30/90 días, los últimos 12 meses en hora AR y «Todo». El mes sale de `toARDateKey` (no del host): en Vercel (UTC)
 * el 31/10 a las 22:00 AR ya es noviembre y el filtro ofrecería un mes que en Argentina no empezó.
 */
export function cobrosPeriodOptions(now: Date): CobrosOption[] {
  const [y, m] = toARDateKey(now).split("-").map(Number);
  const months: CobrosOption[] = [];
  for (let i = 0; i < MONTHS_BACK; i++) {
    const idx = y * 12 + (m - 1) - i;
    const yy = Math.floor(idx / 12);
    const mm = (idx % 12) + 1;
    months.push({ value: `${yy}-${String(mm).padStart(2, "0")}`, label: `${MONTHS[mm - 1]} ${yy}` });
  }
  return [
    { value: "7d", label: "Últimos 7 días" },
    { value: "30d", label: "Últimos 30 días" },
    { value: "90d", label: "Últimos 90 días" },
    ...months,
    { value: COBROS_ALL_PERIOD, label: "Todo" },
  ];
}

// ── Filas ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Tono del estado. El color nunca es el único canal (AGENTS §5): el texto del estado va siempre. */
export type CobroStatusTone = "live" | "paid" | "refunded" | "closed";

const STATUS_TONE: Record<ChargeStatus, CobroStatusTone> = {
  ACTIVE: "live",
  AUTHORIZED: "live",
  PAID: "paid",
  REFUNDED: "refunded",
  EXPIRED: "closed",
  CANCELLED: "closed",
};

export const COBRO_NOTICE_LABEL: Readonly<Record<OnlineChargeNotice, string>> = {
  duplicate: "Pago duplicado",
  "late-after-cancel": "Pagado después de anulado",
  "partial-refund": "Reintegro parcial",
  disputed: "En disputa",
  "amount-mismatch": "Monto distinto",
};

export type CobroRowView = {
  id: string;
  /** Concepto del link, o qué cobró el turnero (el turnero no tiene concepto: C-TP9 lo manda en null). */
  title: string;
  originLabel: string;
  kindLabel: string;
  amountLabel: string;
  statusLabel: string;
  statusTone: CobroStatusTone;
  createdLabel: string;
  /** Solo mientras se puede pagar: «Vence 27/10/2026, 10:30». */
  expiresLabel: string | null;
  practitionerLabel: string;
  accountLabel: string;
  noticeLabels: string[];
  actions: {
    /** La URL del link (solo viene para quien puede re-compartirlo, C-TP9). */
    copyUrl: string | null;
    resend: boolean;
    cancel: boolean;
    receipt: boolean;
  };
};

const TURNERO_TITLE: Record<OnlineChargeView["kind"], string> = {
  DEPOSIT: "Seña del turnero",
  FULL: "Turno pagado en el turnero",
  FREE: "Pago del turnero",
};

export function cobroRowView(v: OnlineChargeView): CobroRowView {
  const live = v.status === "ACTIVE" || v.status === "AUTHORIZED";
  return {
    id: v.id,
    title: v.origin === "LINK" ? v.concept?.trim() || CHARGE_ORIGIN_LABEL.LINK : TURNERO_TITLE[v.kind],
    originLabel: CHARGE_ORIGIN_LABEL[v.origin],
    kindLabel: CHARGE_KIND_LABEL[v.kind],
    amountLabel: formatARS(v.amountCents),
    statusLabel: v.statusLabel,
    statusTone: STATUS_TONE[v.status],
    createdLabel: formatArDateTime(v.createdAt),
    expiresLabel: v.status === "ACTIVE" ? `Vence ${formatArDateTime(v.expiresAt)}` : null,
    practitionerLabel: v.practitionerName ?? "—",
    accountLabel:
      v.accountKind === "CLINIC" ? RECEIPT_COPY.clinicAccount : RECEIPT_COPY.practitionerAccount(v.practitionerName ?? "el profesional"),
    noticeLabels: v.notices.map((n) => COBRO_NOTICE_LABEL[n]),
    actions: {
      copyUrl: live && v.link ? v.link.url : null,
      resend: Boolean(v.link?.canResend),
      cancel: Boolean(v.link?.canCancel),
      receipt: v.receipt !== null,
    },
  };
}

// ── Copy de la página ───────────────────────────────────────────────────────────────────────────────────────────────

export const COBROS_COPY = {
  title: "Cobros",
  description: "Los pagos por Mercado Pago del turnero y de los links de pago.",
  summaryPaid: "Cobrado",
  summaryLive: "Por cobrar",
  summaryLiveCount: (n: number) => (n === 1 ? "1 pendiente" : `${n} pendientes`),
  filtersLabel: "Filtros",
  originLabel: "Tipo",
  statusLabel: "Estado",
  periodLabel: "Período",
  practitionerLabel: "Profesional",
  allPractitioners: "Todos los profesionales",
  clearFilters: "Ver todos",
  /** TP-UI-D7: /cobros está siempre en el nav; sin cobros, esto en vez de una tabla vacía. */
  emptyTitle: "Todavía no hay cobros online",
  emptyBody:
    "Acá vas a ver las señas y los pagos del turnero, y los links de pago que generes desde un turno o desde Facturación del paciente.",
  emptyFilteredTitle: "No hay cobros con estos filtros",
  emptyFilteredBody: "Probá con otro período o estado.",
  more: "Ver más",
  loadingMore: "Cargando…",
  loadMoreFailed: "No pudimos traer más cobros. Revisá la conexión y reintentá.",
  colConcept: "Concepto",
  colPractitioner: "Profesional",
  colAmount: "Monto",
  colStatus: "Estado",
  colDate: "Fecha",
  colActions: "Acciones",
  receipt: "Comprobante",
  copy: "Copiar",
  resend: "Reenviar",
  cancel: "Anular",
  copied: "Link copiado",
  copyFailed: "No pudimos copiar el link",
  cancelled: "Link de pago anulado",
  cancelFailed: "No pudimos anular el link",
  resendTitle: "Reenviar el link de pago",
  networkError: "Revisá la conexión y reintentá.",
} as const;

/** Misma confirmación que el drawer del turno (`LINK_CANCEL_CONFIRM` de booking-money-section): copia, no import, para
 *  no arrastrar la sección del drawer al chunk de /cobros. */
export const COBROS_CANCEL_CONFIRM = {
  title: "¿Anular el link de pago?",
  message: "El paciente ya no va a poder pagar con este link.",
  confirmLabel: "Anular link",
  tone: "danger",
} as const;
