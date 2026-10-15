"use client";

/**
 * Diálogos del ledger de Plataforma (PL-3c): revisar un comprobante (aprobar imputando a un cargo / rechazar con
 * motivo) y anular un cargo con la palabra tipeada. Los cuerpos (`ReviewPaymentForm`, `VoidChargeForm`) son sin
 * estado y se exportan para el render test; los diálogos solo guardan lo tipeado.
 *
 * Por qué anular pide tipear y condonar no: anular saca el cargo de la cuenta como si nunca hubiera existido (para un
 * cargo que no correspondía) y no tiene vuelta atrás desde la UI; condonar deja el cargo y perdona lo que falta, que
 * es lo habitual y se confirma con `useConfirm`.
 */
import { useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { formatARS, formatDateAR } from "@/lib/format";
import type { BillingChargeRow, BillingPaymentRow } from "@/lib/saas-billing-types";
import { ErrorBox } from "@/components/plataforma/tenants/detail-ui";
import { formatDayKeyAR } from "@/components/plataforma/tenants/labels";
import { chargeOptionLabel } from "@/components/plataforma/billing/record-payment-drawer";
import { NOTE_MAX, VOID_CONFIRM_WORD, voidConfirmMatches } from "@/components/plataforma/billing/billing-logic";

// ── Revisar comprobante ─────────────────────────────────────────────────────────────────────────────────────────

export type ReviewDecision = "approve" | "reject";
export type ReviewState = { decision: ReviewDecision; chargeId: string; reason: string };

/** Default de «imputar a»: el cargo que eligió el consultorio al subirlo, si sigue pendiente; si no, el más viejo. */
export function defaultReviewCharge(p: BillingPaymentRow, openCharges: readonly BillingChargeRow[]): string {
  if (p.chargeId && openCharges.some((c) => c.id === p.chargeId)) return p.chargeId;
  return openCharges[0]?.id ?? "";
}

export function reviewCanSubmit(s: ReviewState): boolean {
  return s.decision === "approve" || s.reason.trim().length > 0;
}

export function ReviewPaymentForm({
  payment,
  openCharges,
  state,
  pending,
  error,
  onChange,
  onViewReceipt,
  onSubmit,
  onCancel,
}: {
  payment: BillingPaymentRow;
  openCharges: readonly BillingChargeRow[];
  state: ReviewState;
  pending: boolean;
  error: string | null;
  onChange: <K extends keyof ReviewState>(k: K, v: ReviewState[K]) => void;
  onViewReceipt: () => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const approve = state.decision === "approve";
  const chargeOptions = [
    ...openCharges.map((c) => ({ value: c.id, label: chargeOptionLabel(c) })),
    { value: "", label: "A cuenta (sin cargo)" },
  ];
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!pending && reviewCanSubmit(state)) onSubmit();
      }}
      style={{ display: "grid", gap: 14 }}
    >
      <div style={{ fontSize: 13.5, color: "var(--navy-700)", lineHeight: 1.5 }}>
        <strong style={{ fontVariantNumeric: "tabular-nums" }}>{formatARS(payment.amountCents)}</strong>
        {payment.paidAt ? ` · pagado el ${formatDateAR(payment.paidAt, "short")}` : ""}
        {payment.chargePeriodStart ? ` · para el período del ${formatDayKeyAR(payment.chargePeriodStart)}` : ""}
        {payment.note && <div style={{ fontSize: 12.5, color: "var(--navy-500)", marginTop: 4 }}>Nota del consultorio: {payment.note}</div>}
      </div>
      {payment.hasReceipt && (
        <Button type="button" variant="ghost" onClick={onViewReceipt} disabled={pending} style={{ justifySelf: "start" }}>
          Ver comprobante
        </Button>
      )}
      <div role="radiogroup" aria-label="Decisión" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {(
          [
            ["approve", "Aprobar e imputar"],
            ["reject", "Rechazar"],
          ] as const
        ).map(([v, label]) => (
          <label
            key={v}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 12px",
              borderRadius: 10,
              border: `1px solid ${state.decision === v ? "rgba(31,79,190,0.35)" : "rgba(15,30,51,0.1)"}`,
              background: state.decision === v ? "rgba(31,79,190,0.06)" : "transparent",
              fontSize: 13,
              fontWeight: 600,
              color: "var(--navy-900)",
              cursor: pending ? "not-allowed" : "pointer",
            }}
          >
            <input
              type="radio"
              name="decision"
              value={v}
              checked={state.decision === v}
              onChange={() => onChange("decision", v)}
              disabled={pending}
              style={{ accentColor: "var(--sky-700)" }}
            />
            {label}
          </label>
        ))}
      </div>
      {approve ? (
        <FormField
          as="select"
          label="Imputar a"
          value={state.chargeId}
          options={chargeOptions}
          onChange={(v) => onChange("chargeId", v)}
          hint="Si sobra, queda a cuenta. Al consultorio le llega un mail de pago acreditado."
          disabled={pending}
        />
      ) : (
        <FormField
          as="textarea"
          label="Motivo del rechazo"
          required
          rows={3}
          value={state.reason}
          onChange={(v) => onChange("reason", v.slice(0, NOTE_MAX))}
          hint="Lo ve el consultorio en el mail y en su historial."
          disabled={pending}
        />
      )}
      {error && <ErrorBox>{error}</ErrorBox>}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancelar
        </Button>
        <Button type="submit" variant="primary" disabled={pending || !reviewCanSubmit(state)}>
          {pending ? "Guardando…" : approve ? "Aprobar pago" : "Rechazar comprobante"}
        </Button>
      </div>
    </form>
  );
}

export function ReviewPaymentDialog({
  payment,
  openCharges,
  pending,
  error,
  onViewReceipt,
  onCancel,
  onConfirm,
}: {
  payment: BillingPaymentRow;
  openCharges: readonly BillingChargeRow[];
  pending: boolean;
  error: string | null;
  onViewReceipt: () => void;
  onCancel: () => void;
  onConfirm: (s: ReviewState) => void;
}) {
  const [state, setState] = useState<ReviewState>(() => ({
    decision: "approve",
    chargeId: defaultReviewCharge(payment, openCharges),
    reason: "",
  }));
  return (
    <Modal onClose={() => !pending && onCancel()} title="Revisar comprobante" width={520} lockBackdrop={pending}>
      <ReviewPaymentForm
        payment={payment}
        openCharges={openCharges}
        state={state}
        pending={pending}
        error={error}
        onChange={(k, v) => setState((s) => ({ ...s, [k]: v }))}
        onViewReceipt={onViewReceipt}
        onSubmit={() => onConfirm(state)}
        onCancel={onCancel}
      />
    </Modal>
  );
}

// ── Anular cargo ────────────────────────────────────────────────────────────────────────────────────────────────

export function VoidChargeForm({
  charge,
  typed,
  note,
  pending,
  error,
  onTypedChange,
  onNoteChange,
  onSubmit,
  onCancel,
}: {
  charge: BillingChargeRow;
  typed: string;
  note: string;
  pending: boolean;
  error: string | null;
  onTypedChange: (v: string) => void;
  onNoteChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const ok = voidConfirmMatches(typed);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (ok && !pending) onSubmit();
      }}
      style={{ display: "grid", gap: 12 }}
    >
      <p style={{ margin: 0, fontSize: 13.5, color: "var(--navy-700)", lineHeight: 1.5 }}>
        El cargo del {formatDayKeyAR(charge.periodStart)} al {formatDayKeyAR(charge.periodEnd)} por{" "}
        <strong>{formatARS(charge.amountCents)}</strong> deja de contar en la cuenta del consultorio, como si no se hubiera
        generado. Usalo solo si el cargo no correspondía; para perdonar lo que falta, condonalo.
      </p>
      <FormField
        as="textarea"
        label="Motivo (opcional)"
        rows={2}
        value={note}
        onChange={(v) => onNoteChange(v.slice(0, NOTE_MAX))}
        disabled={pending}
      />
      <FormField
        label={`Para confirmar, escribí ${VOID_CONFIRM_WORD}`}
        name="confirmVoid"
        value={typed}
        onChange={onTypedChange}
        placeholder={VOID_CONFIRM_WORD}
        hint={typed && !ok ? `Escribí ${VOID_CONFIRM_WORD} tal cual.` : undefined}
        disabled={pending}
        autoFocus
      />
      {error && <ErrorBox>{error}</ErrorBox>}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancelar
        </Button>
        <Button type="submit" variant="primary" disabled={!ok || pending}>
          {pending ? "Anulando…" : "Anular cargo"}
        </Button>
      </div>
    </form>
  );
}

export function VoidChargeDialog({
  charge,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  charge: BillingChargeRow;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (note: string) => void;
}) {
  const [typed, setTyped] = useState("");
  const [note, setNote] = useState("");
  return (
    <Modal onClose={() => !pending && onCancel()} title="Anular cargo" width={500} lockBackdrop={pending}>
      <VoidChargeForm
        charge={charge}
        typed={typed}
        note={note}
        pending={pending}
        error={error}
        onTypedChange={setTyped}
        onNoteChange={setNote}
        onSubmit={() => onConfirm(note)}
        onCancel={onCancel}
      />
    </Modal>
  );
}
