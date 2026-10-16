"use client";

/**
 * Pestaña «Facturación» del detalle de un consultorio en /plataforma (PL-3c, plan §20.5.6 sin Mercado Pago): estado
 * de cuenta, precio a medida, comprobantes a revisar, cargos (condonar / anular) y pagos, más «Registrar pago».
 *
 * Todas las escrituras van por `usePlatformAction` (las de plata son `high`: re-verificación con MFA en enforce y
 * rate limit) y piden confirmación (`useConfirm`; anular, con la palabra tipeada). Las actions hacen `revalidatePath` al
 * guardar, así que su respuesta ya trae el ledger nuevo (sin `router.refresh()` extra, PF-0d): acá no se recalcula
 * ningún saldo (la cuenta la hace el núcleo, `readLedger`).
 *
 * Los comprobantes se abren con una URL firmada de 60 s (`getPlatformReceiptUrl`). La pestaña se abre ANTES del
 * await (en el click): abrirla después la bloquea el navegador como popup.
 */
import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { MoneyInput } from "@/components/ui/money-input";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { formatARS, formatDateAR } from "@/lib/format";
import { SAAS_PLAN_LABEL } from "@/lib/tenant-modules";
import { getPlatformReceiptUrl, reviewPayment, setCustomPrice, voidCharge, waiveCharge } from "@/lib/platform-billing";
import { paymentMethodLabel, type BillingChargeRow, type BillingPaymentRow } from "@/lib/saas-billing-types";
import { payableChargesNewestFirst } from "@/lib/saas-billing-logic";
import type { PlatformTenantLedger } from "@/lib/platform-billing-types";
import { usePlatformAction } from "@/components/plataforma/reauth-modal";
import { ErrorBox, Facts, Section, muted } from "@/components/plataforma/tenants/detail-ui";
import { SUBSCRIPTION_STATUS_LABEL, formatDayKeyAR } from "@/components/plataforma/tenants/labels";
import { RecordPaymentDrawer } from "@/components/plataforma/billing/record-payment-drawer";
import { ReviewPaymentDialog, VoidChargeDialog, type ReviewState } from "@/components/plataforma/billing/ledger-dialogs";
import {
  CHARGE_STATUS_LABEL,
  PAYMENT_STATUS_LABEL,
  balanceText,
} from "@/components/plataforma/billing/billing-logic";

/**
 * Cargos pendientes con saldo, del más reciente al más viejo (PL-F1a): el primero es el sugerido para imputar (el
 * último impago, decisión de Martin del 16-oct). Lo que se imputa «a cuenta» el núcleo lo aplica del más viejo.
 */
export function openChargesOf(charges: readonly BillingChargeRow[]): BillingChargeRow[] {
  return payableChargesNewestFirst(charges);
}

const rowStyle = {
  display: "flex",
  flexWrap: "wrap" as const,
  alignItems: "center",
  gap: "6px 14px",
  padding: "12px 0",
  borderTop: "1px solid rgba(15,30,51,0.06)",
  fontSize: 13,
  color: "var(--navy-700)",
};

const linkBtn = {
  background: "none",
  border: "none",
  padding: 0,
  fontSize: 12.5,
  fontWeight: 600,
  color: "var(--sky-700)",
  cursor: "pointer",
};

function Money({ cents, strong }: { cents: number; strong?: boolean }) {
  return <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: strong ? 700 : 500, color: "var(--navy-900)" }}>{formatARS(cents)}</span>;
}

// ── Vistas sin estado (render test) ─────────────────────────────────────────────────────────────────────────────

export function LedgerSummary({ ledger, action }: { ledger: PlatformTenantLedger; action?: ReactNode }) {
  const price =
    ledger.customPriceCents != null
      ? `${formatARS(ledger.customPriceCents)}/mes · a medida (lista: ${ledger.planPriceCents == null ? "Consultá" : formatARS(ledger.planPriceCents)})`
      : ledger.planPriceCents != null
        ? `${formatARS(ledger.planPriceCents)}/mes · de lista`
        : "Consultá: no se cobra";
  return (
    <Section title="Estado de cuenta" description="Saldo, próximo cargo y día de cobro. La cuenta la hace el sistema con los cargos y los pagos aprobados." action={action}>
      <Facts
        items={[
          ["Plan", SAAS_PLAN_LABEL[ledger.plan]],
          ["Precio", price],
          ["Suscripción", SUBSCRIPTION_STATUS_LABEL[ledger.subscriptionStatus]],
          ["Saldo", <span key="b" data-balance style={{ fontWeight: 700 }}>{balanceText(ledger.balanceCents)}</span>],
          [
            "Próximo cargo",
            ledger.nextCharge
              ? `${formatDayKeyAR(ledger.nextCharge.periodStart)} · ${ledger.nextCharge.amountCents == null ? "no se cobra" : formatARS(ledger.nextCharge.amountCents)}`
              : muted("Sin próximo cargo"),
          ],
          ["Día de cobro", ledger.anchorDay ? `El ${ledger.anchorDay} de cada mes` : muted("Todavía sin suscripción")],
          ["Prueba", ledger.trialEndsAt ? `Hasta el ${formatDateAR(ledger.trialEndsAt, "short")}` : muted("Sin prueba")],
          ["A cuenta", ledger.creditCents > 0 ? formatARS(ledger.creditCents) : muted("—")],
        ]}
      />
    </Section>
  );
}

export function PendingReviewsList({
  payments,
  onReview,
  onViewReceipt,
  disabled,
}: {
  payments: readonly BillingPaymentRow[];
  onReview: (p: BillingPaymentRow) => void;
  onViewReceipt: (p: BillingPaymentRow) => void;
  disabled?: boolean;
}) {
  const pending = payments.filter((p) => p.status === "PENDING_REVIEW");
  if (pending.length === 0) return null;
  return (
    <Section
      title={pending.length === 1 ? "1 comprobante a revisar" : `${pending.length} comprobantes a revisar`}
      description="Los mandó el consultorio desde Configuración → Facturación. Aprobalo para imputarlo o rechazalo con el motivo."
    >
      <ul aria-label="Comprobantes a revisar" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {pending.map((p) => (
          <li key={p.id} data-review={p.id} style={rowStyle}>
            <Money cents={p.amountCents} strong />
            <span>{p.paidAt ? `Pagado el ${formatDateAR(p.paidAt, "short")}` : `Enviado el ${formatDateAR(p.createdAt, "short")}`}</span>
            <span data-payment-method={p.method ?? ""} style={{ color: "var(--navy-500)" }}>{paymentMethodLabel(p.method)}</span>
            {p.note && <span style={{ color: "var(--navy-500)", overflowWrap: "anywhere", minWidth: 0 }}>«{p.note}»</span>}
            <span style={{ marginLeft: "auto", display: "flex", gap: 12, flexWrap: "wrap" }}>
              {p.hasReceipt && (
                <button type="button" style={linkBtn} onClick={() => onViewReceipt(p)} disabled={disabled}>
                  Ver comprobante
                </button>
              )}
              <Button type="button" variant="primary" onClick={() => onReview(p)} disabled={disabled}>
                Revisar
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function ChargesList({
  charges,
  onWaive,
  onVoid,
  disabled,
}: {
  charges: readonly BillingChargeRow[];
  onWaive: (c: BillingChargeRow) => void;
  onVoid: (c: BillingChargeRow) => void;
  disabled?: boolean;
}) {
  return (
    <Section title="Cargos" description="Uno por período. Condonar perdona lo que falta; anular saca un cargo que no correspondía.">
      {charges.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, color: "var(--navy-500)" }}>Todavía no se generó ningún cargo.</p>
      ) : (
        <ul aria-label="Cargos" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {charges.map((c) => (
            <li key={c.id} data-charge={c.id} data-status={c.status} style={rowStyle}>
              <span style={{ fontWeight: 600, color: "var(--navy-900)", minWidth: 0 }}>
                {formatDayKeyAR(c.periodStart)} al {formatDayKeyAR(c.periodEnd)}
              </span>
              <span style={{ color: "var(--navy-500)" }}>{SAAS_PLAN_LABEL[c.plan]}</span>
              <Money cents={c.amountCents} />
              <Tag tone={c.status === "PAID" ? "lime" : c.status === "OPEN" ? "sky" : "soft"}>
                {c.overdue && c.status === "OPEN" ? "Vencido" : CHARGE_STATUS_LABEL[c.status]}
              </Tag>
              {c.status === "OPEN" && (
                <span style={{ fontSize: 12.5, color: c.overdue ? "var(--danger-fg)" : "var(--navy-500)" }}>
                  {c.overdue ? "Venció" : "Vence"} el {formatDayKeyAR(c.dueDate)} · falta {formatARS(c.remainingCents)}
                  {c.paidCents > 0 ? ` (pagó ${formatARS(c.paidCents)})` : ""}
                </span>
              )}
              {c.status === "PAID" && c.paidAt && <span style={{ fontSize: 12.5, color: "var(--navy-500)" }}>Pagado el {formatDateAR(c.paidAt, "short")}</span>}
              {c.note && <span style={{ fontSize: 12.5, color: "var(--navy-500)", overflowWrap: "anywhere", minWidth: 0 }}>Nota: {c.note}</span>}
              {c.status === "OPEN" && (
                <span style={{ marginLeft: "auto", display: "flex", gap: 14, flexWrap: "wrap" }}>
                  <button type="button" style={linkBtn} onClick={() => onWaive(c)} disabled={disabled}>
                    Condonar
                  </button>
                  <button
                    type="button"
                    style={{ ...linkBtn, color: c.paidCents > 0 ? "var(--navy-300)" : "var(--danger-fg)" }}
                    onClick={() => onVoid(c)}
                    disabled={disabled || c.paidCents > 0}
                    title={c.paidCents > 0 ? "Tiene pagos aprobados: condonalo en vez de anularlo." : undefined}
                  >
                    Anular
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export function PaymentsList({
  payments,
  onViewReceipt,
  disabled,
}: {
  payments: readonly BillingPaymentRow[];
  onViewReceipt: (p: BillingPaymentRow) => void;
  disabled?: boolean;
}) {
  return (
    <Section title="Pagos" description="Los imputados desde acá y los comprobantes que mandó el consultorio.">
      {payments.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, color: "var(--navy-500)" }}>Todavía no hay pagos.</p>
      ) : (
        <ul aria-label="Pagos" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {payments.map((p) => (
            <li key={p.id} data-payment={p.id} data-status={p.status} style={rowStyle}>
              <Money cents={p.amountCents} strong />
              <Tag tone={p.status === "APPROVED" ? "lime" : p.status === "PENDING_REVIEW" ? "sky" : "soft"}>{PAYMENT_STATUS_LABEL[p.status]}</Tag>
              <span>{p.paidAt ? formatDateAR(p.paidAt, "short") : formatDateAR(p.createdAt, "short")}</span>
              {/* PL-F1a: el medio (M8c) en lugar del `source` («Manual» siempre: sin cobro por MP). */}
              <span data-payment-method={p.method ?? ""} style={{ color: "var(--navy-500)" }}>{paymentMethodLabel(p.method)}</span>
              <span style={{ color: "var(--navy-500)" }}>
                {p.chargePeriodStart ? `Período del ${formatDayKeyAR(p.chargePeriodStart)}` : p.status === "APPROVED" ? "A cuenta" : ""}
              </span>
              {p.note && <span style={{ fontSize: 12.5, color: "var(--navy-500)", overflowWrap: "anywhere", minWidth: 0 }}>{p.note}</span>}
              {p.reviewNote && (
                <span style={{ fontSize: 12.5, color: p.status === "REJECTED" ? "var(--danger-fg)" : "var(--navy-500)", overflowWrap: "anywhere", minWidth: 0 }}>
                  {p.status === "REJECTED" ? "Motivo del rechazo" : "Revisión"}: {p.reviewNote}
                </span>
              )}
              {p.hasReceipt && (
                <button type="button" style={{ ...linkBtn, marginLeft: "auto" }} onClick={() => onViewReceipt(p)} disabled={disabled}>
                  Ver comprobante
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** Precio a medida: vacío = el de lista. Rige desde el próximo cargo (los cargos ya generados no cambian). */
export function CustomPriceForm({
  value,
  saved,
  planPriceCents,
  pending,
  onChange,
  onSave,
}: {
  value: number | null;
  saved: number | null;
  planPriceCents: number | null;
  pending: boolean;
  onChange: (v: number | null) => void;
  onSave: () => void;
}) {
  const dirty = value !== saved;
  return (
    <Section
      title="Precio a medida"
      description="Pisa el precio de lista para este consultorio desde el próximo cargo. Vacío = el de lista. Los cargos ya generados no cambian."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty && !pending) onSave();
        }}
        style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}
      >
        <div style={{ flex: "1 1 200px", maxWidth: 280 }}>
          <MoneyInput
            label="Precio por mes"
            value={value}
            onChange={onChange}
            placeholder={planPriceCents == null ? "Lista: Consultá" : `Lista: ${formatARS(planPriceCents).replace(/^\$\s?/, "")}`}
            disabled={pending}
          />
        </div>
        <Button type="submit" variant="primary" disabled={!dirty || pending}>
          {pending ? "Guardando…" : "Guardar precio"}
        </Button>
        {value != null && (
          <button type="button" style={linkBtn} onClick={() => onChange(null)} disabled={pending}>
            Usar el de lista
          </button>
        )}
      </form>
    </Section>
  );
}

// ── Contenedor ──────────────────────────────────────────────────────────────────────────────────────────────────

export function TenantLedgerView({ ledger }: { ledger: PlatformTenantLedger }) {
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  const runPlatform = usePlatformAction();
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState<BillingPaymentRow | null>(null);
  const [voiding, setVoiding] = useState<BillingChargeRow | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [customPrice, setCustomPriceValue] = useState<number | null>(ledger.customPriceCents);
  const [pageError, setPageError] = useState<string | null>(null);

  // El refresh trae el precio guardado (el propio o el de otro superadmin): el input lo refleja.
  useEffect(() => setCustomPriceValue(ledger.customPriceCents), [ledger.customPriceCents]);

  const openCharges = openChargesOf(ledger.charges);

  /** Corre una escritura: reauth/rate limit, error legible, refresh. Devuelve si salió bien. */
  const write = async (fn: () => Promise<{ ok: true } | { ok: false; error: string }>, okMessage: string, onError?: (e: string) => void) => {
    setBusy(true);
    try {
      const res = await runPlatform(fn);
      if (!res.ok) {
        (onError ?? setPageError)(res.error);
        // refresh-ok: la action falló y no revalida; el error suele ser «ya no está pendiente» y hay que ver lo vigente.
        router.refresh();
        return false;
      }
      setPageError(null);
      toast.success(okMessage);
      return true;
    } catch {
      (onError ?? setPageError)("No se pudo guardar el cambio. Revisá la conexión y probá de nuevo.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const viewReceipt = async (p: BillingPaymentRow) => {
    const w = window.open("", "_blank");
    try {
      const res = await runPlatform(() => getPlatformReceiptUrl(p.id));
      if (!res.ok) {
        w?.close();
        toast.error(res.error);
        return;
      }
      if (w) {
        w.opener = null;
        w.location.href = res.data.url;
      } else {
        window.open(res.data.url, "_blank", "noopener");
      }
    } catch {
      w?.close();
      toast.error("No se pudo abrir el comprobante. Probá de nuevo.");
    }
  };

  const onReview = async (s: ReviewState) => {
    if (!reviewing) return;
    const ok = await write(
      () =>
        reviewPayment({
          paymentId: reviewing.id,
          decision: s.decision,
          ...(s.decision === "approve" ? { chargeId: s.chargeId || null } : { reason: s.reason.trim() }),
        }),
      s.decision === "approve" ? "Pago aprobado e imputado" : "Comprobante rechazado",
      setDialogError
    );
    if (ok) setReviewing(null);
  };

  const onWaive = async (c: BillingChargeRow) => {
    const yes = await confirm({
      title: "¿Condonar lo que falta?",
      message: `Se perdonan ${formatARS(c.remainingCents)} del cargo del ${formatDayKeyAR(c.periodStart)}. El cargo queda en la cuenta como condonado.`,
      confirmLabel: "Condonar",
      cancelLabel: "Volver",
      tone: "danger",
    });
    if (!yes) return;
    await write(() => waiveCharge({ chargeId: c.id }), "Cargo condonado");
  };

  const onVoid = async (note: string) => {
    if (!voiding) return;
    const ok = await write(
      () => voidCharge({ chargeId: voiding.id, ...(note.trim() ? { note: note.trim() } : {}) }),
      "Cargo anulado",
      setDialogError
    );
    if (ok) setVoiding(null);
  };

  const onSavePrice = async () => {
    const yes = await confirm({
      title: customPrice == null ? "¿Volver al precio de lista?" : "¿Fijar este precio a medida?",
      message:
        customPrice == null
          ? "Desde el próximo cargo se cobra el precio de lista del plan."
          : `Desde el próximo cargo se cobran ${formatARS(customPrice)} por mes, aunque cambie el precio de lista.`,
      confirmLabel: "Guardar",
      cancelLabel: "Volver",
    });
    if (!yes) return;
    const ok = await write(() => setCustomPrice(ledger.tenantId, customPrice), "Precio guardado");
    if (!ok) setCustomPriceValue(ledger.customPriceCents);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {pageError && <ErrorBox>{pageError}</ErrorBox>}
      <LedgerSummary
        ledger={ledger}
        action={<RecordPaymentDrawer tenantId={ledger.tenantId} tenantName={ledger.tenantName} openCharges={openCharges} />}
      />
      <PendingReviewsList
        payments={ledger.payments}
        disabled={busy}
        onViewReceipt={(p) => void viewReceipt(p)}
        onReview={(p) => {
          setDialogError(null);
          setReviewing(p);
        }}
      />
      <ChargesList
        charges={ledger.charges}
        disabled={busy}
        onWaive={(c) => void onWaive(c)}
        onVoid={(c) => {
          setDialogError(null);
          setVoiding(c);
        }}
      />
      <PaymentsList payments={ledger.payments} disabled={busy} onViewReceipt={(p) => void viewReceipt(p)} />
      <CustomPriceForm
        value={customPrice}
        saved={ledger.customPriceCents}
        planPriceCents={ledger.planPriceCents}
        pending={busy}
        onChange={setCustomPriceValue}
        onSave={() => void onSavePrice()}
      />
      {reviewing && (
        <ReviewPaymentDialog
          payment={reviewing}
          openCharges={openCharges}
          pending={busy}
          error={dialogError}
          onViewReceipt={() => void viewReceipt(reviewing)}
          onCancel={() => setReviewing(null)}
          onConfirm={(s) => void onReview(s)}
        />
      )}
      {voiding && (
        <VoidChargeDialog
          charge={voiding}
          pending={busy}
          error={dialogError}
          onCancel={() => setVoiding(null)}
          onConfirm={(n) => void onVoid(n)}
        />
      )}
    </div>
  );
}
