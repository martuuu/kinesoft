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
 *
 * MPS-4b (§26.6): tarjeta «Suscripción y cobro» (`subscription-mp-card.tsx`), desglose base + ajustes de cada cargo,
 * lista de ajustes con «Sumar saldo a favor» / «Cargo extra», y el precio a medida atado a un plan (MPS-D14). Todo
 * eso depende de `SAAS_BILLING_MODE` (`mpsUiFor`): con `off` la pantalla queda como en PL-3c.
 */
import { useEffect, useState, type ReactNode } from "react";
import type { SaasPlan } from "@prisma/client";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { MoneyInput } from "@/components/ui/money-input";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { FormField } from "@/components/ui/form-field";
import { formatARS, formatDateAR } from "@/lib/format";
import { SAAS_PLAN_LABEL } from "@/lib/tenant-modules";
import { SAAS_PLANS } from "@/lib/saas-plans-logic";
import { getPlatformReceiptUrl, reviewPayment, setCustomPrice, voidCharge, waiveCharge } from "@/lib/platform-billing";
import {
  paymentMethodLabel,
  type BillingAdjustmentRow,
  type BillingChargeBreakdown,
  type BillingChargeRow,
  type BillingPaymentRow,
  type SaasBillingMode,
} from "@/lib/saas-billing-types";
import { payableChargesNewestFirst } from "@/lib/saas-billing-logic";
import type { PlatformTenantLedger } from "@/lib/platform-billing-types";
import { usePlatformAction } from "@/components/plataforma/reauth-modal";
import { ErrorBox, Facts, Section, muted } from "@/components/plataforma/tenants/detail-ui";
import { SUBSCRIPTION_STATUS_LABEL, formatDayKeyAR } from "@/components/plataforma/tenants/labels";
import { RecordPaymentDrawer } from "@/components/plataforma/billing/record-payment-drawer";
import { AdjustmentDrawer, ReviewPaymentDialog, VoidChargeDialog, type ReviewState } from "@/components/plataforma/billing/ledger-dialogs";
import { SubscriptionMpCard } from "@/components/plataforma/billing/subscription-mp-card";
import {
  CHARGE_STATUS_LABEL,
  PAYMENT_STATUS_LABEL,
  adjustmentTitle,
  balanceText,
  dayMonthAR,
  mpsUiFor,
  signedARS,
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

/**
 * «base $ 55.000 · ajustes − $ 5.000 · a favor − $ 2.000» del próximo cargo (C-MPS5 `nextCharge.breakdown`). null si
 * no hay desglose (ledger previo a M16) o si no hay nada que desglosar (solo la base): repetir el monto no informa.
 */
export function nextChargeBreakdownText(b: NonNullable<PlatformTenantLedger["nextCharge"]>["breakdown"]): string | null {
  if (!b || b.baseCents == null) return null;
  if (b.adjustmentsCents === 0 && b.creditCents === 0) return null;
  const parts = [`base ${formatARS(b.baseCents)}`];
  if (b.adjustmentsCents !== 0) parts.push(`ajustes ${signedARS(b.adjustmentsCents)}`);
  if (b.creditCents !== 0) parts.push(`a favor ${signedARS(b.creditCents)}`);
  return parts.join(" · ");
}

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
            ledger.nextCharge ? (
              <span key="n">
                {formatDayKeyAR(ledger.nextCharge.periodStart)} ·{" "}
                {ledger.nextCharge.amountCents == null ? "no se cobra" : formatARS(ledger.nextCharge.amountCents)}
                {nextChargeBreakdownText(ledger.nextCharge.breakdown) && (
                  <span data-next-breakdown style={{ display: "block", fontSize: 12, color: "var(--navy-500)" }}>
                    {nextChargeBreakdownText(ledger.nextCharge.breakdown)}
                  </span>
                )}
              </span>
            ) : (
              muted("Sin próximo cargo")
            ),
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
  breakdown,
  onWaive,
  onVoid,
  disabled,
}: {
  charges: readonly BillingChargeRow[];
  /** MPS-4b: desglose por id de cargo (`chargeBreakdown` de `readLedger`); ausente = como en PL-3c. */
  breakdown?: Record<string, BillingChargeBreakdown>;
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
              {breakdown?.[c.id] && <ChargeBreakdownLine b={breakdown[c.id]} />}
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

/**
 * Desglose de un cargo: base del plan + cada ajuste imputado, con signo. Un cargo previo a M16 (base null) no tiene
 * desglose y no se muestra nada: inventar una «base» = monto sería mentir si tuvo descuentos a mano.
 */
function ChargeBreakdownLine({ b }: { b: BillingChargeBreakdown }) {
  if (b.baseAmountCents == null) return null;
  return (
    <span data-breakdown style={{ flexBasis: "100%", display: "grid", gap: 2, fontSize: 12.5, color: "var(--navy-500)" }}>
      <span style={{ fontVariantNumeric: "tabular-nums" }}>
        Base {formatARS(b.baseAmountCents)}
        {b.adjustmentsCents !== 0 ? ` · ajustes ${signedARS(b.adjustmentsCents)}` : ""}
      </span>
      {b.adjustments.map((a) => (
        <span key={a.id} style={{ overflowWrap: "anywhere", minWidth: 0 }}>
          {adjustmentTitle(a, (p) => SAAS_PLAN_LABEL[p])} {signedARS(a.amountCents)}
          {a.description ? ` · ${a.description}` : ""}
        </span>
      ))}
      {b.hasCheckout && <span>Link de pago de Mercado Pago vigente</span>}
    </span>
  );
}

function AdjustmentItem({ a, charges }: { a: BillingAdjustmentRow; charges: readonly BillingChargeRow[] }) {
  const applied = a.appliedChargeId ? charges.find((c) => c.id === a.appliedChargeId) : undefined;
  return (
    <li data-adjustment={a.id} data-kind={a.kind} style={rowStyle}>
      <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 700, color: a.amountCents < 0 ? "var(--lime-700)" : "var(--navy-900)" }}>
        {signedARS(a.amountCents)}
      </span>
      <span style={{ fontWeight: 600, color: "var(--navy-900)" }}>{adjustmentTitle(a, (p) => SAAS_PLAN_LABEL[p])}</span>
      {a.description && <span style={{ color: "var(--navy-500)", overflowWrap: "anywhere", minWidth: 0 }}>{a.description}</span>}
      <span style={{ marginLeft: "auto", fontSize: 12.5, color: "var(--navy-500)" }}>
        {a.appliedChargeId
          ? applied
            ? `Imputado al cargo del ${dayMonthAR(applied.periodStart)}`
            : `Imputado${a.appliedAt ? ` el ${formatDateAR(a.appliedAt, "short")}` : ""}`
          : `Entra en el cargo del ${dayMonthAR(a.effectiveOn)}`}
      </span>
    </li>
  );
}

/** Ajustes de la suscripción (C-MPS5): los que esperan su cargo y los que ya entraron en uno. */
export function AdjustmentsList({
  pending,
  applied,
  charges,
  action,
}: {
  pending: readonly BillingAdjustmentRow[];
  applied: readonly BillingAdjustmentRow[];
  charges: readonly BillingChargeRow[];
  action?: ReactNode;
}) {
  const sub = (t: string) => <h3 style={{ margin: "10px 0 0", fontSize: 13, fontWeight: 700, color: "var(--navy-700)" }}>{t}</h3>;
  return (
    <Section
      title="Ajustes"
      description="Saldo a favor, cargos extra y proporcionales. Entran en el primer cargo desde su fecha; un cargo nunca queda en negativo."
      action={action}
    >
      {pending.length === 0 && applied.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, color: "var(--navy-500)" }}>Todavía no hay ajustes.</p>
      ) : (
        <>
          {pending.length > 0 && (
            <>
              {sub("Pendientes")}
              <ul aria-label="Ajustes pendientes" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {pending.map((a) => (
                  <AdjustmentItem key={a.id} a={a} charges={charges} />
                ))}
              </ul>
            </>
          )}
          {applied.length > 0 && (
            <>
              {sub("Aplicados")}
              <ul aria-label="Ajustes aplicados" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {applied.map((a) => (
                  <AdjustmentItem key={a.id} a={a} charges={charges} />
                ))}
              </ul>
            </>
          )}
        </>
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

/**
 * Precio a medida: vacío = el de lista. Rige desde el próximo cargo (los cargos ya generados no cambian). MPS-D14:
 * queda atado a un plan (default: el actual). Si el consultorio cambia de plan paga la lista del plan nuevo: un
 * descuento pactado para Consultorio no viaja a Clínica. Con `onPlanChange` ausente (uso previo) no se muestra.
 */
export function CustomPriceForm({
  value,
  saved,
  planPriceCents,
  plan,
  savedPlan,
  pending,
  onChange,
  onPlanChange,
  onSave,
}: {
  value: number | null;
  saved: number | null;
  planPriceCents: number | null;
  /** Plan al que queda atado el precio (MPS-D14). */
  plan?: SaasPlan;
  /** Plan con el que se abrió el form (el actual del consultorio): cambiarlo solo también es un cambio. */
  savedPlan?: SaasPlan;
  pending: boolean;
  onChange: (v: number | null) => void;
  onPlanChange?: (p: SaasPlan) => void;
  onSave: () => void;
}) {
  const withPlan = plan !== undefined && onPlanChange !== undefined;
  const dirty = value !== saved || (withPlan && value != null && savedPlan !== undefined && plan !== savedPlan);
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
        {withPlan && value != null && (
          <div style={{ flex: "1 1 180px", maxWidth: 240 }}>
            <FormField
              as="select"
              label="Para el plan"
              value={plan}
              options={SAAS_PLANS.map((p) => ({ value: p, label: SAAS_PLAN_LABEL[p] }))}
              onChange={(v) => onPlanChange((SAAS_PLANS as readonly string[]).includes(v) ? (v as SaasPlan) : plan)}
              disabled={pending}
            />
          </div>
        )}
        <Button type="submit" variant="primary" disabled={!dirty || pending}>
          {pending ? "Guardando…" : "Guardar precio"}
        </Button>
        {value != null && (
          <button type="button" style={linkBtn} onClick={() => onChange(null)} disabled={pending}>
            Usar el de lista
          </button>
        )}
      </form>
      {withPlan && value != null && (
        <p style={{ margin: "10px 0 0", fontSize: 12.5, color: "var(--navy-500)", lineHeight: 1.45 }}>
          Vale solo para {SAAS_PLAN_LABEL[plan]}: si el consultorio cambia de plan, paga el precio de lista del plan nuevo.
        </p>
      )}
    </Section>
  );
}

// ── Contenedor ──────────────────────────────────────────────────────────────────────────────────────────────────

export function TenantLedgerView({ ledger, mode = "off" }: { ledger: PlatformTenantLedger; mode?: SaasBillingMode }) {
  const ui = mpsUiFor(mode);
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  const runPlatform = usePlatformAction();
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState<BillingPaymentRow | null>(null);
  const [voiding, setVoiding] = useState<BillingChargeRow | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [customPrice, setCustomPriceValue] = useState<number | null>(ledger.customPriceCents);
  const [customPlan, setCustomPlan] = useState<SaasPlan>(ledger.plan);
  const [pageError, setPageError] = useState<string | null>(null);

  // El refresh trae el precio guardado (el propio o el de otro superadmin): el input lo refleja.
  useEffect(() => setCustomPriceValue(ledger.customPriceCents), [ledger.customPriceCents]);
  useEffect(() => setCustomPlan(ledger.plan), [ledger.plan]);

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
          : `Desde el próximo cargo se cobran ${formatARS(customPrice)} por mes mientras esté en ${SAAS_PLAN_LABEL[customPlan]}, aunque cambie el precio de lista.`,
      confirmLabel: "Guardar",
      cancelLabel: "Volver",
    });
    if (!yes) return;
    const ok = await write(
      () => (customPrice == null ? setCustomPrice(ledger.tenantId, null) : setCustomPrice(ledger.tenantId, customPrice, customPlan)),
      "Precio guardado"
    );
    if (!ok) {
      setCustomPriceValue(ledger.customPriceCents);
      setCustomPlan(ledger.plan);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {pageError && <ErrorBox>{pageError}</ErrorBox>}
      <LedgerSummary
        ledger={ledger}
        action={<RecordPaymentDrawer tenantId={ledger.tenantId} tenantName={ledger.tenantName} openCharges={openCharges} />}
      />
      {ui.subscription && <SubscriptionMpCard ledger={ledger} ui={ui} />}
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
        breakdown={ui.adjustments ? ledger.chargeBreakdown : undefined}
        disabled={busy}
        onWaive={(c) => void onWaive(c)}
        onVoid={(c) => {
          setDialogError(null);
          setVoiding(c);
        }}
      />
      {ui.adjustments && (
        <AdjustmentsList
          pending={ledger.pendingAdjustments ?? []}
          applied={ledger.appliedAdjustments ?? []}
          charges={ledger.charges}
          action={
            <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <AdjustmentDrawer tenantId={ledger.tenantId} kind="CREDIT" disabled={busy} />
              <AdjustmentDrawer tenantId={ledger.tenantId} kind="DEBIT" disabled={busy} />
            </span>
          }
        />
      )}
      <PaymentsList payments={ledger.payments} disabled={busy} onViewReceipt={(p) => void viewReceipt(p)} />
      <CustomPriceForm
        value={customPrice}
        saved={ledger.customPriceCents}
        planPriceCents={ledger.planPriceCents}
        plan={customPlan}
        savedPlan={ledger.plan}
        pending={busy}
        onChange={setCustomPriceValue}
        onPlanChange={setCustomPlan}
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
