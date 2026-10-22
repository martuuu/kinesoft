"use client";

/**
 * [TP-3g] /cobros, parte de cliente (§25.10): resumen, filtros, tabla/cards, «Ver más» y las acciones de cada fila.
 *
 * - **Filtros en la URL** (tipo, estado, período, profesional): cambiar uno navega a `cobrosHref(...)` y el server
 *   vuelve a leer con `listOnlineCharges`. La página monta este componente con `key` = los filtros, así el estado local
 *   (páginas cargadas, modales) arranca de cero con cada filtro.
 * - **Paginación por cursor**: «Ver más» pide la página siguiente a la MISMA action con el `nextCursor` y la suma
 *   abajo. El cursor no va a la URL: una URL con cursor abriría «la página 3» sin las dos primeras.
 * - **Acciones**: copiar el link, reenviarlo (`PaymentLinkShare`: copiar / WhatsApp / email), anularlo (con
 *   `useConfirm`, nunca `window.confirm`) y ver el comprobante en un Modal (`MpReceiptView` plain, TP-UI-D11).
 *   Después de anular se parchea la fila en el lugar (`afterCancel`, TP-ZF3) y se descuenta del «Por cobrar».
 * - Comprobante y compartir bajan por `next/dynamic` recién al abrirlos (techo de /cobros ≤165 kB, §25.11).
 *
 * `CobrosView` (sin estado ni red) está exportado para el render test: este componente usa `useConfirm`/`useToast`,
 * que exigen sus providers.
 */
import { useRef, useState, useTransition } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { ButtonLink, Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import {
  COBROS_CANCEL_CONFIRM,
  COBROS_COPY as C,
  COBROS_ORIGIN_OPTIONS,
  COBROS_STATUS_OPTIONS,
  cobroRowView,
  cobrosActionInput,
  cobrosHref,
  hasActiveCobrosFilters,
  type CobrosFilters,
  type CobrosOption,
} from "@/lib/cobros-view";
import { formatARS } from "@/lib/format";
import { buildMpReceipt } from "@/lib/mp-receipt";
import { listOnlineCharges } from "@/lib/online-charges-read";
import { CHARGE_STATUS_LABEL } from "@/lib/online-payments-copy";
import type { ListOnlineChargesResult, OnlineChargeView } from "@/lib/online-payments-types";
import { cancelPaymentLink } from "@/lib/payment-links";
import { CobrosRow, type CobrosRowHandlers } from "./cobros-row";
import styles from "./cobros.module.css";

type OnlineChargeSummary = ListOnlineChargesResult["summary"];

const MpReceiptView = dynamic(() => import("@/components/payments/mp-receipt-view").then((m) => m.MpReceiptView), {
  ssr: false,
});
const PaymentLinkShare = dynamic(() => import("@/components/payments/payment-link-share").then((m) => m.PaymentLinkShare), {
  ssr: false,
});

export type CobrosPractitionerOption = { id: string; name: string };

export type CobrosViewProps = {
  filters: CobrosFilters;
  rows: readonly OnlineChargeView[];
  summary: ListOnlineChargesResult["summary"];
  hasMore: boolean;
  loadingMore: boolean;
  /** Error de la primera lectura o de «Ver más». */
  error: string | null;
  /** null = sin filtro de profesional (quien solo ve lo suyo, `billing.collectOwn`). */
  practitioners: readonly CobrosPractitionerOption[] | null;
  periodOptions: readonly CobrosOption[];
  navigating: boolean;
  busy: boolean;
  onFilter: (patch: Partial<CobrosFilters>) => void;
  onMore: () => void;
  handlers: CobrosRowHandlers;
};

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly CobrosOption[];
  onChange: (v: string) => void;
}) {
  return (
    <label className={styles.filter}>
      {label}
      <select className="k-input" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function CobrosView(p: CobrosViewProps) {
  const { filters: f } = p;
  const filtered = hasActiveCobrosFilters(f);
  const rows = p.rows.map(cobroRowView);
  return (
    <div className={styles.page}>
      <dl className={styles.summary} aria-label="Resumen del período">
        <div className={styles.summaryItem}>
          <dt>{C.summaryPaid}</dt>
          <dd data-summary="paid">{formatARS(p.summary.paidCents)}</dd>
        </div>
        <div className={styles.summaryItem}>
          <dt>{C.summaryLive}</dt>
          <dd data-summary="live">
            {formatARS(p.summary.liveCents)}
            <span className={styles.summaryHint}>{C.summaryLiveCount(p.summary.liveCount)}</span>
          </dd>
        </div>
      </dl>

      <fieldset className={styles.filters} aria-busy={p.navigating} aria-label={C.filtersLabel}>
        <FilterSelect
          label={C.originLabel}
          value={f.origin ?? ""}
          options={COBROS_ORIGIN_OPTIONS}
          onChange={(v) => p.onFilter({ origin: v === "TURNERO" || v === "LINK" ? v : null })}
        />
        <FilterSelect
          label={C.statusLabel}
          value={f.status ?? ""}
          options={COBROS_STATUS_OPTIONS}
          onChange={(v) => p.onFilter({ status: v ? (v as CobrosFilters["status"]) : null })}
        />
        <FilterSelect
          label={C.periodLabel}
          value={f.period}
          options={p.periodOptions}
          onChange={(v) => p.onFilter({ period: v })}
        />
        {p.practitioners && p.practitioners.length > 1 && (
          <FilterSelect
            label={C.practitionerLabel}
            value={f.practitionerId ?? ""}
            options={[{ value: "", label: C.allPractitioners }, ...p.practitioners.map((x) => ({ value: x.id, label: x.name }))]}
            onChange={(v) => p.onFilter({ practitionerId: v || null })}
          />
        )}
      </fieldset>

      {rows.length === 0 && !p.error ? (
        <section className={styles.empty} data-empty={filtered ? "filtered" : "none"}>
          <h2>{filtered ? C.emptyFilteredTitle : C.emptyTitle}</h2>
          <p>{filtered ? C.emptyFilteredBody : C.emptyBody}</p>
          {filtered && (
            <ButtonLink href="/cobros" variant="ghost" size="sm">
              {C.clearFilters}
            </ButtonLink>
          )}
        </section>
      ) : null}

      {rows.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{C.colConcept}</th>
                <th scope="col">{C.colPractitioner}</th>
                <th scope="col">{C.colAmount}</th>
                <th scope="col">{C.colStatus}</th>
                <th scope="col">{C.colDate}</th>
                <th scope="col">
                  <span className="k-sr-only">{C.colActions}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <CobrosRow key={r.id} row={r} busy={p.busy} handlers={p.handlers} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(p.hasMore || p.error) && (
        <div className={styles.more}>
          {p.error && (
            <p className={styles.error} role="alert">
              {p.error}
            </p>
          )}
          {p.hasMore && (
            <Button type="button" variant="ghost" onClick={p.onMore} disabled={p.loadingMore}>
              {p.loadingMore ? C.loadingMore : C.more}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * TP-ZF3: después de anular, la fila queda «Anulado» y sin link EN SU LUGAR, y si estaba viva sale del «Por cobrar».
 * Antes se releía solo la primera página: quien había cargado más páginas con «Ver más» las perdía (y el scroll), y
 * con un filtro de estado la fila anulada desaparecía sin que se viera qué pasó. El server ya la anuló: esto es lo
 * mismo que devolvería una relectura para esa fila (`link` solo viaja para cobros vivos, C-TP9).
 */
export function afterCancel(
  rows: readonly OnlineChargeView[],
  summary: OnlineChargeSummary,
  id: string
): { rows: OnlineChargeView[]; summary: OnlineChargeSummary } {
  const hit = rows.find((r) => r.id === id);
  if (!hit) return { rows: [...rows], summary };
  const wasLive = hit.status === "ACTIVE" || hit.status === "AUTHORIZED";
  return {
    rows: rows.map((r) => (r.id === id ? { ...r, status: "CANCELLED", statusLabel: CHARGE_STATUS_LABEL.CANCELLED, link: null } : r)),
    summary: wasLive
      ? {
          ...summary,
          liveCount: Math.max(0, summary.liveCount - 1),
          liveCents: Math.max(0, summary.liveCents - hit.amountCents),
        }
      : summary,
  };
}

export type CobrosClientProps = {
  filters: CobrosFilters;
  initial: ListOnlineChargesResult | null;
  initialError: string | null;
  practitioners: readonly CobrosPractitionerOption[] | null;
  periodOptions: readonly CobrosOption[];
};

export function CobrosClient({ filters, initial, initialError, practitioners, periodOptions }: CobrosClientProps) {
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [navigating, startNav] = useTransition();
  const [rows, setRows] = useState<OnlineChargeView[]>(initial?.rows ?? []);
  const [summary, setSummary] = useState(initial?.summary ?? { paidCents: 0, liveCount: 0, liveCents: 0 });
  const [cursor, setCursor] = useState<string | null>(initial?.nextCursor ?? null);
  const [error, setError] = useState<string | null>(initialError);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [resendId, setResendId] = useState<string | null>(null);
  // Doble click = una llamada (anular y «Ver más» no son idempotentes desde la UI).
  const inFlight = useRef(false);

  function onFilter(patch: Partial<CobrosFilters>) {
    startNav(() => router.push(cobrosHref(filters, patch)));
  }

  async function onMore() {
    if (!cursor || inFlight.current) return;
    inFlight.current = true;
    setLoadingMore(true);
    setError(null);
    try {
      const res = await listOnlineCharges(cobrosActionInput(filters, cursor));
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // Dedupe por id: un cobro nuevo entre dos páginas no corre el keyset (createdAt desc), pero es gratis cuidarlo.
      setRows((prev) => {
        const seen = new Set(prev.map((r) => r.id));
        return [...prev, ...res.data.rows.filter((r) => !seen.has(r.id))];
      });
      setCursor(res.data.nextCursor);
    } catch {
      setError(C.loadMoreFailed);
    } finally {
      inFlight.current = false;
      setLoadingMore(false);
    }
  }

  async function onCopy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success(C.copied);
    } catch {
      toast.error(C.copyFailed, { description: url });
    }
  }

  async function onCancel(id: string) {
    if (inFlight.current) return;
    if (!(await confirm(COBROS_CANCEL_CONFIRM))) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const res = await cancelPaymentLink({ chargeId: id });
      if (!res.ok) {
        toast.error(C.cancelFailed, { description: res.error });
        return;
      }
      toast.success(C.cancelled);
      const next = afterCancel(rows, summary, id);
      setRows(next.rows);
      setSummary(next.summary);
    } catch {
      toast.error(C.cancelFailed, { description: C.networkError });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const receiptCharge = receiptId ? rows.find((r) => r.id === receiptId) ?? null : null;
  const receipt = receiptCharge?.receipt
    ? buildMpReceipt({ mpPaymentId: receiptCharge.receipt.operationId, ...receiptCharge.receipt })
    : null;
  const resendCharge = resendId ? rows.find((r) => r.id === resendId) ?? null : null;

  return (
    <>
      <CobrosView
        filters={filters}
        rows={rows}
        summary={summary}
        hasMore={Boolean(cursor)}
        loadingMore={loadingMore}
        error={error}
        practitioners={practitioners}
        periodOptions={periodOptions}
        navigating={navigating}
        busy={busy}
        onFilter={onFilter}
        onMore={() => void onMore()}
        handlers={{
          onReceipt: setReceiptId,
          onCopy: (url) => void onCopy(url),
          onResend: setResendId,
          onCancel: (id) => void onCancel(id),
        }}
      />
      {receipt && (
        <Modal open onClose={() => setReceiptId(null)} title={C.receipt} width={440}>
          <MpReceiptView receipt={receipt} variant="plain" />
        </Modal>
      )}
      {resendCharge?.link && (
        <Modal open onClose={() => setResendId(null)} title={C.resendTitle} width={480}>
          {/* El nombre del paciente no viaja en `OnlineChargeView` (C-TP9): el aviso «sin email» lo reconoce igual por
              el final del mensaje (`isNoEmailError`). */}
          <PaymentLinkShare chargeId={resendCharge.id} url={resendCharge.link.url} patientName="" />
        </Modal>
      )}
    </>
  );
}
