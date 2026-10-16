"use client";

/**
 * «Registrar pago» desde Plataforma (PL-3c; decisión de Martin: imputar pagos manuales ADJUNTANDO el recibo). Drawer
 * con dirty-guard: monto (`MoneyInput`, centavos), a qué cargo se imputa (PL-F1a: por defecto el ÚLTIMO impago,
 * decisión de Martin del 16-oct; «A cuenta» = sin cargo, el núcleo lo aplica a los pendientes del más viejo), fecha (no
 * futura), medio (`SaasPaymentMethod`, su columna desde M8c), nota y el comprobante, obligatorio.
 *
 * `recordManualPayment` (FormData) valida tamaño y magic bytes ANTES de Storage y deja el pago APPROVED con audit
 * doble y mail; esto corre por `usePlatformAction` (`billing.write` es `high`: re-verificación y rate limit).
 */
import { useRef, useState, type FormEvent } from "react";
import { Drawer } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { MoneyInput } from "@/components/ui/money-input";
import { useToast } from "@/components/ui/toast";
import { formatARS } from "@/lib/format";
import { recordManualPayment } from "@/lib/platform-billing";
import type { SaasPaymentMethod } from "@prisma/client";
import { SAAS_PAYMENT_METHODS, SAAS_PAYMENT_METHOD_LABEL, type BillingChargeRow } from "@/lib/saas-billing-types";
import { suggestedChargeId } from "@/lib/saas-billing-logic";
import { usePlatformAction } from "@/components/plataforma/reauth-modal";
import { ErrorBox } from "@/components/plataforma/tenants/detail-ui";
import { formatDayKeyAR } from "@/components/plataforma/tenants/labels";
import {
  NOTE_MAX,
  RECEIPT_ACCEPT,
  buildPaymentFormData,
  emptyRecordPayment,
  isRecordPaymentDirty,
  validateRecordPayment,
  type RecordPaymentState,
} from "@/components/plataforma/billing/billing-logic";

export function chargeOptionLabel(c: BillingChargeRow): string {
  return `${formatDayKeyAR(c.periodStart)} al ${formatDayKeyAR(c.periodEnd)} · falta ${formatARS(c.remainingCents)}`;
}

/** Cuerpo controlado y sin efectos (render test con props: con `renderToStaticMarkup` no se puede tipear). */
export function RecordPaymentForm({
  state,
  openCharges,
  errors,
  serverError,
  pending,
  onChange,
  onFile,
  onAmountInvalid,
  onSubmit,
  onCancel,
}: {
  state: RecordPaymentState;
  openCharges: readonly BillingChargeRow[];
  errors: Record<string, string>;
  serverError: string | null;
  pending: boolean;
  onChange: <K extends keyof RecordPaymentState>(k: K, v: RecordPaymentState[K]) => void;
  onFile: (f: File | null) => void;
  onAmountInvalid?: (invalid: boolean) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  // `openCharges` llega del más reciente al más viejo (`openChargesOf`): el primero es el sugerido.
  const chargeOptions = [
    ...openCharges.map((c) => ({ value: c.id, label: chargeOptionLabel(c) })),
    { value: "", label: openCharges.length ? "A cuenta" : "A cuenta (no hay cargos pendientes)" },
  ];
  return (
    <form onSubmit={onSubmit} style={{ display: "grid", gap: 16 }} noValidate>
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
        as="select"
        label="Imputar a"
        value={state.chargeId}
        options={chargeOptions}
        onChange={(v) => onChange("chargeId", v)}
        hint="Si sobra, queda a cuenta del consultorio. «A cuenta» se aplica a los pendientes, del más viejo."
        error={errors.chargeId}
        disabled={pending}
      />
      <FormField
        type="date"
        label="Fecha del pago"
        required
        value={state.paidOn}
        onChange={(v) => onChange("paidOn", v)}
        error={errors.paidOn}
        disabled={pending}
      />
      <FormField
        as="select"
        label="Medio de pago"
        required
        value={state.method}
        options={SAAS_PAYMENT_METHODS.map((m) => ({ value: m, label: SAAS_PAYMENT_METHOD_LABEL[m] }))}
        onChange={(v) => onChange("method", v as SaasPaymentMethod)}
        error={errors.method}
        disabled={pending}
      />
      <FormField
        as="textarea"
        label="Nota (opcional)"
        rows={3}
        value={state.note}
        onChange={(v) => onChange("note", v)}
        placeholder="Ej.: número de operación"
        hint={`La ve el consultorio en su historial. Hasta ${NOTE_MAX} caracteres.`}
        error={errors.note}
        disabled={pending}
      />
      <label style={{ display: "block", fontSize: 12, minWidth: 0 }}>
        <span style={{ fontWeight: 600, color: "var(--navy-500)" }}>
          Comprobante<span style={{ color: "var(--sky-700)" }}> *</span>
        </span>
        <input
          type="file"
          name="file"
          accept={RECEIPT_ACCEPT}
          required
          aria-invalid={errors.file ? true : undefined}
          disabled={pending}
          onChange={(e) => onFile(e.target.files?.[0] ?? null)}
          style={{ display: "block", marginTop: 6, width: "100%", fontSize: 13, color: "var(--navy-700)" }}
        />
        <span
          role={errors.file ? "alert" : undefined}
          style={{ display: "block", marginTop: 4, fontSize: 11, color: errors.file ? "var(--danger-fg)" : "var(--navy-300)" }}
        >
          {errors.file ?? (state.file ? state.file.name : "PDF, JPG, PNG o WEBP de hasta 4 MB. Es obligatorio.")}
        </span>
      </label>

      {serverError && <ErrorBox>{serverError}</ErrorBox>}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancelar
        </Button>
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Registrando…" : "Registrar pago"}
        </Button>
      </div>
    </form>
  );
}

export function RecordPaymentDrawer({
  tenantId,
  tenantName,
  openCharges,
}: {
  tenantId: string;
  tenantName: string;
  openCharges: readonly BillingChargeRow[];
}) {
  const toast = useToast();
  const runPlatform = usePlatformAction();
  const [open, setOpen] = useState(false);
  const initial = useRef<RecordPaymentState>(emptyRecordPayment(new Date()));
  const [state, setState] = useState<RecordPaymentState>(initial.current);
  const [file, setFile] = useState<File | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [amountInvalid, setAmountInvalid] = useState(false);
  const [pending, setPending] = useState(false);

  const openDrawer = () => {
    // PL-F1a: cargo sugerido = el último impago (no se puede deber dos meses: con uno vencido la cuenta queda en solo
    // lectura); monto sugerido = lo que le falta. Las dos cosas se pueden cambiar.
    const suggested = openCharges.find((c) => c.id === suggestedChargeId(openCharges));
    initial.current = emptyRecordPayment(new Date(), suggested ? suggested.remainingCents : null, suggested?.id ?? "");
    setState(initial.current);
    setFile(null);
    setErrors({});
    setServerError(null);
    setOpen(true);
  };

  const onChange = <K extends keyof RecordPaymentState>(k: K, v: RecordPaymentState[K]) => {
    // Al cambiar de cargo, el monto pasa a lo que le falta a ese cargo (como en «Informar pago» del consultorio).
    const picked = k === "chargeId" ? openCharges.find((c) => c.id === v) : undefined;
    setState((s) => ({ ...s, [k]: v, ...(picked ? { amountCents: picked.remainingCents } : {}) }));
    setErrors((e) => {
      const { [k === "amountCents" ? "amount" : (k as string)]: _drop, ...rest } = e;
      return rest;
    });
  };

  const onFile = (f: File | null) => {
    setFile(f);
    setState((s) => ({ ...s, file: f ? { name: f.name, size: f.size, type: f.type } : null }));
    setErrors(({ file: _drop, ...rest }) => rest);
  };

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    const v = validateRecordPayment(state, new Date());
    if (amountInvalid) v.amount = "Revisá el monto (por ejemplo, 15.000 o 15.000,50).";
    setErrors(v);
    if (Object.keys(v).length > 0 || !file) return;
    setPending(true);
    setServerError(null);
    try {
      const res = await runPlatform(() => recordManualPayment(buildPaymentFormData(tenantId, state, file)));
      if (!res.ok) {
        setServerError(res.error);
        const fe = res.fieldErrors ?? {};
        setErrors(Object.fromEntries(Object.entries(fe).map(([k, msgs]) => [k, msgs[0]])));
        return;
      }
      setOpen(false);
      // Sin refresh extra del router: `recordManualPayment` revalida el detalle (PF-0d).
      toast.success("Pago registrado e imputado");
    } catch {
      setServerError("No se pudo registrar el pago. Revisá la conexión y probá de nuevo.");
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <Button type="button" variant="primary" onClick={openDrawer}>
        Registrar pago
      </Button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Registrar pago"
        dirty={isRecordPaymentDirty(state, initial.current)}
        width={460}
      >
        <p style={{ marginTop: 0, marginBottom: 16, fontSize: 13, color: "var(--navy-500)", lineHeight: 1.45 }}>
          {tenantName}. El pago queda aprobado al guardarlo y al consultorio le llega un mail de pago acreditado.
        </p>
        <RecordPaymentForm
          state={state}
          openCharges={openCharges}
          errors={errors}
          serverError={serverError}
          pending={pending}
          onChange={onChange}
          onFile={onFile}
          onAmountInvalid={setAmountInvalid}
          onSubmit={(e) => void onSubmit(e)}
          onCancel={() => setOpen(false)}
        />
      </Drawer>
    </>
  );
}
