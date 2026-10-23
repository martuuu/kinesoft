"use client";

/**
 * Diálogos del ledger de Plataforma (PL-3c): revisar un comprobante (aprobar imputando a un cargo / rechazar con
 * motivo) y anular un cargo con la palabra tipeada. MPS-4b suma «Sumar saldo a favor» / «Cargo extra» (Drawer con
 * dirty-guard, una clave de idempotencia por apertura) y el preview de «Re-anclar al 4». Los cuerpos (`ReviewPaymentForm`, `VoidChargeForm`) son sin
 * estado y se exportan para el render test; los diálogos solo guardan lo tipeado.
 *
 * Por qué anular pide tipear y condonar no: anular saca el cargo de la cuenta como si nunca hubiera existido (para un
 * cargo que no correspondía) y no tiene vuelta atrás desde la UI; condonar deja el cargo y perdona lo que falta, que
 * es lo habitual y se confirma con `useConfirm`.
 */
import { useRef, useState, type FormEvent } from "react";
import { Modal } from "@/components/ui/modal";
import { Drawer } from "@/components/ui/drawer";
import { MoneyInput } from "@/components/ui/money-input";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { addAdjustment } from "@/lib/platform-billing";
import type { PlatformReanchorPreview } from "@/lib/platform-billing-types";
import { usePlatformAction } from "@/components/plataforma/reauth-modal";
import { WarnBox } from "@/components/plataforma/tenants/detail-ui";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { formatARS, formatDateAR } from "@/lib/format";
import type { BillingChargeRow, BillingPaymentRow } from "@/lib/saas-billing-types";
import { ErrorBox } from "@/components/plataforma/tenants/detail-ui";
import { formatDayKeyAR } from "@/components/plataforma/tenants/labels";
import { chargeOptionLabel } from "@/components/plataforma/billing/record-payment-drawer";
import { suggestedChargeId } from "@/lib/saas-billing-logic";
import {
  ADJUSTMENT_COPY,
  ADJUSTMENT_DESCRIPTION_MAX,
  NOTE_MAX,
  VOID_CONFIRM_WORD,
  buildAdjustmentPayload,
  emptyAdjustment,
  isAdjustmentDirty,
  newAdjustmentKey,
  reanchorRows,
  reanchorStubText,
  validateAdjustment,
  voidConfirmMatches,
  type AdjustmentFormState,
  type ManualAdjustmentKind,
} from "@/components/plataforma/billing/billing-logic";

// ── Revisar comprobante ─────────────────────────────────────────────────────────────────────────────────────────

export type ReviewDecision = "approve" | "reject";
export type ReviewState = { decision: ReviewDecision; chargeId: string; reason: string };

/**
 * Default de «imputar a»: el cargo que eligió el consultorio al subirlo, si sigue pendiente; si no, el último impago
 * (PL-F1a, decisión de Martin del 16-oct; antes era el más viejo).
 */
export function defaultReviewCharge(p: BillingPaymentRow, openCharges: readonly BillingChargeRow[]): string {
  if (p.chargeId && openCharges.some((c) => c.id === p.chargeId)) return p.chargeId;
  return suggestedChargeId(openCharges);
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

// ── Sumar saldo a favor / Cargo extra (MPS-4b, C-MPS11 `addAdjustment`) ─────────────────────────────────────────

export function AdjustmentForm({
  kind,
  state,
  errors,
  serverError,
  pending,
  dirty,
  onChange,
  onAmountInvalid,
  onSubmit,
  onCancel,
}: {
  kind: ManualAdjustmentKind;
  state: AdjustmentFormState;
  errors: Record<string, string>;
  serverError: string | null;
  pending: boolean;
  dirty: boolean;
  onChange: <K extends keyof AdjustmentFormState>(k: K, v: AdjustmentFormState[K]) => void;
  onAmountInvalid?: (invalid: boolean) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  const copy = ADJUSTMENT_COPY[kind];
  return (
    <form onSubmit={onSubmit} style={{ display: "grid", gap: 14 }} noValidate>
      <p style={{ margin: 0, fontSize: 13, color: "var(--navy-500)", lineHeight: 1.45 }}>{copy.intro}</p>
      <MoneyInput
        label="Monto"
        required
        value={state.amountCents}
        onChange={(v) => onChange("amountCents", v)}
        onInvalidChange={onAmountInvalid}
        error={errors.amount}
        disabled={pending}
      />
      <FormField
        as="textarea"
        label="Descripción"
        required
        rows={3}
        value={state.description}
        onChange={(v) => onChange("description", v.slice(0, ADJUSTMENT_DESCRIPTION_MAX))}
        placeholder={kind === "CREDIT" ? "Ej.: compensación por la caída del servicio" : "Ej.: migración de datos"}
        hint="La ve el consultorio en el detalle de su cargo."
        error={errors.description}
        disabled={pending}
      />
      {serverError && <ErrorBox>{serverError}</ErrorBox>}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancelar
        </Button>
        <Button type="submit" variant="primary" disabled={!dirty || pending}>
          {pending ? "Guardando…" : kind === "CREDIT" ? "Sumar saldo a favor" : "Sumar cargo extra"}
        </Button>
      </div>
    </form>
  );
}

/**
 * Botón + Drawer de un ajuste manual. La clave de idempotencia nace al ABRIR (una por instancia del diálogo, AGENTS
 * §4): un reintento después de un error de red o un doble clic devuelve el mismo ajuste (UNIQUE de M16) en vez de
 * sumarlo dos veces. `addAdjustment` es `billing.write`: va por `usePlatformAction` (re-verificación/step-up y rate
 * limit, igual que «Registrar pago») y revalida el detalle, así que no hace falta refresh.
 */
export function AdjustmentDrawer({ tenantId, kind, disabled }: { tenantId: string; kind: ManualAdjustmentKind; disabled?: boolean }) {
  const confirm = useConfirm();
  const toast = useToast();
  const runPlatform = usePlatformAction();
  const copy = ADJUSTMENT_COPY[kind];
  const key = useRef<string>("");
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<AdjustmentFormState>(emptyAdjustment);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [amountInvalid, setAmountInvalid] = useState(false);
  const [pending, setPending] = useState(false);
  const dirty = isAdjustmentDirty(state);

  const openDrawer = () => {
    key.current = newAdjustmentKey();
    setState(emptyAdjustment());
    setErrors({});
    setServerError(null);
    setAmountInvalid(false);
    setOpen(true);
  };

  const onChange = <K extends keyof AdjustmentFormState>(k: K, v: AdjustmentFormState[K]) => {
    setState((s) => ({ ...s, [k]: v }));
    setErrors((e) => {
      const { [k === "amountCents" ? "amount" : (k as string)]: _drop, ...rest } = e;
      return rest;
    });
  };

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    const v = validateAdjustment(state);
    if (amountInvalid) v.amount = "Revisá el monto (por ejemplo, 15.000 o 15.000,50).";
    setErrors(v);
    if (Object.keys(v).length > 0 || state.amountCents == null) return;
    const yes = await confirm({
      title: `¿${copy.title}?`,
      message: `${copy.confirm(state.amountCents)} Motivo: «${state.description.trim()}».`,
      confirmLabel: copy.button,
      cancelLabel: "Volver",
    });
    if (!yes) return;
    setPending(true);
    setServerError(null);
    try {
      const res = await runPlatform(() => addAdjustment(buildAdjustmentPayload(tenantId, kind, state, key.current)));
      if (!res.ok) {
        setServerError(res.error);
        return;
      }
      setOpen(false);
      toast.success(res.data.created ? copy.ok : "Ese ajuste ya estaba cargado");
    } catch {
      setServerError("No se pudo guardar el ajuste. Revisá la conexión y probá de nuevo.");
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <Button type="button" variant="ghost" onClick={openDrawer} disabled={disabled}>
        {copy.button}
      </Button>
      <Drawer open={open} onClose={() => setOpen(false)} title={copy.title} dirty={dirty} width={440}>
        <AdjustmentForm
          kind={kind}
          state={state}
          errors={errors}
          serverError={serverError}
          pending={pending}
          dirty={dirty}
          onChange={onChange}
          onAmountInvalid={setAmountInvalid}
          onSubmit={(e) => void onSubmit(e)}
          onCancel={() => setOpen(false)}
        />
      </Drawer>
    </>
  );
}

// ── Re-anclar al 4 (MPS-4b, C-MPS11 `previewReanchor` / `applyReanchor`) ────────────────────────────────────────

const cellStyle = { padding: "8px 10px", borderTop: "1px solid rgba(15,30,51,0.06)", textAlign: "left" as const, fontSize: 13 };

/** Lo que va a pasar, sin efectos (render test): antes → después, desde cuándo se factura y el proporcional. */
export function ReanchorPreviewView({ preview }: { preview: PlatformReanchorPreview }) {
  if (preview.noop) {
    return (
      <p style={{ margin: 0, fontSize: 13.5, color: "var(--navy-700)", lineHeight: 1.5 }}>
        Ya cobra el 4: no hay nada que re-anclar.
      </p>
    );
  }
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", color: "var(--navy-700)" }}>
          <thead>
            <tr>
              <th scope="col" style={{ ...cellStyle, borderTop: "none", color: "var(--navy-500)", fontWeight: 600 }}>
                <span className="k-sr-only">Dato</span>
              </th>
              <th scope="col" style={{ ...cellStyle, borderTop: "none", color: "var(--navy-500)", fontWeight: 600 }}>Hoy</th>
              <th scope="col" style={{ ...cellStyle, borderTop: "none", color: "var(--navy-500)", fontWeight: 600 }}>Después</th>
            </tr>
          </thead>
          <tbody>
            {reanchorRows(preview).map((r) => (
              <tr key={r.label}>
                <th scope="row" style={{ ...cellStyle, fontWeight: 600, color: "var(--navy-900)" }}>{r.label}</th>
                <td style={cellStyle}>{r.before}</td>
                <td style={{ ...cellStyle, fontWeight: 700, color: "var(--navy-900)" }}>{r.after}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ margin: 0, fontSize: 13, color: "var(--navy-700)", lineHeight: 1.5 }}>{reanchorStubText(preview)}</p>
      {preview.hasCharges && (
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--navy-500)", lineHeight: 1.45 }}>
          Los cargos y pagos que ya existen no cambian.
        </p>
      )}
      {preview.reenablesAutoDebit && (
        <WarnBox>
          El débito automático de este consultorio está bloqueado. Re-anclar vuelve a permitir el débito automático: si
          querés que siga bloqueado, bloquealo de nuevo después.
        </WarnBox>
      )}
    </div>
  );
}

/** El diálogo ES la confirmación: muestra el preview y aplica con «Re-anclar al 4». */
export function ReanchorDialog({
  preview,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  preview: PlatformReanchorPreview;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal onClose={() => !pending && onCancel()} title="Re-anclar al 4" width={520} lockBackdrop={pending}>
      <div style={{ display: "grid", gap: 14 }}>
        <ReanchorPreviewView preview={preview} />
        {error && <ErrorBox>{error}</ErrorBox>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
            {preview.noop ? "Cerrar" : "Cancelar"}
          </Button>
          {!preview.noop && (
            <Button type="button" variant="primary" onClick={onConfirm} disabled={pending}>
              {pending ? "Re-anclando…" : "Re-anclar al 4"}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
