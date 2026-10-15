"use client";

/**
 * Facturación → «Informar pago» (PL-3a; PL-D22). El consultorio pagó por transferencia (o como haya acordado) y sube
 * el comprobante: queda «En revisión» hasta que Plataforma lo apruebe o lo rechace con un motivo.
 *
 * - Campos: cargo (PL-F1a: por defecto el ÚLTIMO impago, decisión de Martin del 16-oct; «A cuenta» = sin cargo, y al
 *   aprobarse se aplica a los pendientes del más viejo), monto (`MoneyInput`, centavos; por defecto lo que falta del
 *   cargo), fecha (hoy en AR), medio (`method`, su columna desde M8c; Transferencia por defecto), nota y archivo.
 * - Validación en el cliente (`validateReceiptForm`, lib/saas-billing-view.ts): tipo PDF/JPG/PNG/WEBP y ≤ 4 MB ANTES
 *   de mandar 4 MB al server para que rebote. La barrera es el server (`readReceiptFile`: tamaño + magic bytes).
 * - Una foto pesada se achica en el navegador (canvas → JPEG, lado mayor 2000 px) antes de validarla: las fotos de
 *   celular pesan 3-8 MB y el tope es 4. Un PDF no se toca.
 * - El monto viaja como TEXTO canónico (`formatMoneyInput`) porque el server lo lee con `parseMoneyInput`, no como
 *   centavos (el `name` del `MoneyInput` manda centavos y el server los leería como pesos: ×100).
 * - Se puede usar en modo lectura (`withAccountWritable`): justo es cuando hay que pagar.
 */
import { useEffect, useMemo, useState } from "react";
import { Drawer } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { MoneyInput } from "@/components/ui/money-input";
import { useToast } from "@/components/ui/toast";
import { formatARS, formatMoneyInput } from "@/lib/format";
import { toARDateKey } from "@/lib/datetime-ar";
import { submitPaymentReceipt } from "@/lib/saas-billing";
import type { SaasPaymentMethod } from "@prisma/client";
import { SAAS_PAYMENT_METHODS, SAAS_PAYMENT_METHOD_LABEL, type BillingChargeRow } from "@/lib/saas-billing-types";
import { payableChargesNewestFirst, suggestedChargeId } from "@/lib/saas-billing-logic";
import {
  formatBytes,
  periodLabel,
  shouldCompressReceipt,
  validateReceiptForm,
  type ReceiptFormErrors,
} from "@/lib/saas-billing-view";

const NETWORK_ERROR = "No pudimos conectarnos. Revisá la conexión y probá de nuevo.";
export const RECEIPT_ACCEPT = ".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp";

/**
 * Achica una foto (canvas → JPEG 0,82, lado mayor ≤ 2000 px, fondo blanco para los PNG con transparencia). `null` si
 * el navegador no puede o si no achicó: se manda el original y decide la validación.
 */
async function compressImage(file: File): Promise<File | null> {
  try {
    if (typeof createImageBitmap !== "function") return null;
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.82));
    if (!blob || blob.size >= file.size) return null;
    return new File([blob], `${file.name.replace(/\.[^.]+$/, "") || "comprobante"}.jpg`, { type: "image/jpeg" });
  } catch {
    return null;
  }
}

export function ReceiptUploadDrawer({
  open,
  onClose,
  charges,
  transferInfo,
  onSubmitted,
}: {
  open: boolean;
  onClose: () => void;
  /** PL-Z A2: a dónde transferir (`SAAS_BILLING_TRANSFER_INFO`). Va arriba del formulario: es lo primero que se busca. */
  transferInfo: string | null;
  /** Cargos del ledger: acá se quedan los pendientes con saldo, del más reciente al más viejo. */
  charges: readonly BillingChargeRow[];
  onSubmitted: () => void | Promise<void>;
}) {
  const toast = useToast();
  const payable = useMemo(() => payableChargesNewestFirst(charges), [charges]);
  // PL-F1a: el sugerido es el último impago (no el más viejo). No se puede deber dos meses: con uno vencido la cuenta
  // ya queda en solo lectura, así que en la práctica hay uno solo.
  const firstCharge = payable.find((c) => c.id === suggestedChargeId(payable)) ?? null;
  const today = () => toARDateKey(new Date());
  const [chargeId, setChargeId] = useState<string>(firstCharge?.id ?? "");
  const [amountCents, setAmountCents] = useState<number | null>(firstCharge?.remainingCents ?? null);
  const [amountInvalid, setAmountInvalid] = useState(false);
  const [paidOn, setPaidOn] = useState<string>(today);
  const [method, setMethod] = useState<SaasPaymentMethod>("TRANSFER");
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileInfo, setFileInfo] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [errors, setErrors] = useState<ReceiptFormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [fileKey, setFileKey] = useState(0);

  function reset() {
    setChargeId(firstCharge?.id ?? "");
    setAmountCents(firstCharge?.remainingCents ?? null);
    setAmountInvalid(false);
    setPaidOn(today());
    setMethod("TRANSFER");
    setNote("");
    setFile(null);
    setFileInfo(null);
    setErrors({});
    setFormError(null);
    setFileKey((k) => k + 1);
  }

  // Al abrir: el último impago del ledger (puede haber cambiado desde la última vez) y la fecha de hoy.
  useEffect(() => {
    if (open) reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const chargeOptions = useMemo(
    () => [
      ...payable.map((c) => ({ value: c.id, label: `${periodLabel(c.periodStart, c.periodEnd)} · faltan ${formatARS(c.remainingCents)}` })),
      { value: "", label: "A cuenta" },
    ],
    [payable]
  );

  // Lo que cuesta volver a cargar: el archivo y la nota (cargo, monto y fecha vienen sugeridos).
  const dirty = file !== null || note.trim() !== "";

  async function onPickFile(f: File | null) {
    setFormError(null);
    if (!f) {
      setFile(null);
      setFileInfo(null);
      return;
    }
    let chosen = f;
    let info: string | null = null;
    if (shouldCompressReceipt(f)) {
      setPreparing(true);
      const small = await compressImage(f);
      setPreparing(false);
      if (small) {
        chosen = small;
        info = `Achicamos la foto de ${formatBytes(f.size)} a ${formatBytes(small.size)}.`;
      }
    }
    setFile(chosen);
    setFileInfo(info ?? `${chosen.name} · ${formatBytes(chosen.size)}`);
    const e = validateReceiptForm({ file: chosen, amountCents, amountInvalid, paidOn, note }, new Date());
    setErrors((prev) => ({ ...prev, file: e.file }));
  }

  async function onSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    if (pending || preparing) return;
    const e = validateReceiptForm({ file, amountCents, amountInvalid, paidOn, note }, new Date());
    setErrors(e);
    setFormError(null);
    if (Object.keys(e).length > 0 || !file || amountCents === null) return;
    const fd = new FormData();
    fd.set("file", file);
    if (chargeId) fd.set("chargeId", chargeId);
    fd.set("amount", formatMoneyInput(amountCents));
    fd.set("paidOn", paidOn);
    fd.set("method", method);
    // PL-F1a: la nota va tal cual (antes llevaba «Medio: …» adelante porque M8 no tenía columna).
    if (note.trim()) fd.set("note", note.trim());
    setPending(true);
    try {
      const r = await submitPaymentReceipt(fd);
      if (!r.ok) {
        setFormError(r.error);
        const fe = r.fieldErrors ?? {};
        setErrors({ file: fe.file?.[0], amount: fe.amount?.[0], paidOn: fe.paidOn?.[0], note: fe.note?.[0], method: fe.method?.[0] });
        return;
      }
      toast.success("Comprobante enviado", { description: "Lo revisamos y te avisamos por mail." });
      reset();
      await onSubmitted();
    } catch {
      setFormError(NETWORK_ERROR);
    } finally {
      setPending(false);
    }
  }

  return (
    <Drawer
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Informar pago"
      dirty={dirty}
      dirtyMessage="Tenés un comprobante sin enviar. Si cerrás, se pierde."
    >
      <form onSubmit={onSubmit} noValidate style={{ display: "grid", gap: 14 }}>
        {transferInfo && (
          <p
            data-transfer-info
            style={{ margin: 0, padding: 12, borderRadius: "var(--r-sm)", background: "rgba(15,30,51,0.04)", fontSize: 13.5, color: "var(--navy-700)", lineHeight: 1.5, overflowWrap: "anywhere", whiteSpace: "pre-line" }}
          >
            <strong>Transferí a:</strong> {transferInfo}
          </p>
        )}
        <p style={{ margin: 0, fontSize: 13, color: "var(--navy-500)", lineHeight: 1.5 }}>
          Adjuntá el comprobante de la transferencia o del pago. Lo revisamos y, cuando lo aprobemos, se descuenta del
          saldo.
        </p>
        <FormField
          as="select"
          label="Cargo que pagás"
          name="chargeId"
          value={chargeId}
          onChange={(v) => {
            setChargeId(v);
            const c = payable.find((x) => x.id === v);
            if (c) setAmountCents(c.remainingCents);
          }}
          options={chargeOptions}
        />
        <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
          <MoneyInput
            label="Monto"
            required
            value={amountCents}
            onChange={(c) => {
              setAmountCents(c);
              setErrors((p) => ({ ...p, amount: undefined }));
            }}
            onInvalidChange={setAmountInvalid}
            error={errors.amount}
          />
          <FormField
            label="Fecha del pago"
            name="paidOn"
            type="date"
            required
            value={paidOn}
            onChange={(v) => {
              setPaidOn(v);
              setErrors((p) => ({ ...p, paidOn: undefined }));
            }}
            error={errors.paidOn}
          />
        </div>
        <FormField
          as="select"
          label="Medio de pago"
          name="method"
          required
          value={method}
          onChange={(v) => {
            setMethod(v as SaasPaymentMethod);
            setErrors((p) => ({ ...p, method: undefined }));
          }}
          options={SAAS_PAYMENT_METHODS.map((m) => ({ value: m, label: SAAS_PAYMENT_METHOD_LABEL[m] }))}
          error={errors.method}
        />
        <FormField
          as="textarea"
          label="Nota (opcional)"
          name="note"
          rows={3}
          value={note}
          onChange={(v) => {
            setNote(v);
            setErrors((p) => ({ ...p, note: undefined }));
          }}
          placeholder="Ej.: transferí desde la cuenta de la clínica"
          error={errors.note}
        />
        <label style={{ display: "block", fontSize: 12, minWidth: 0 }}>
          <span style={{ fontWeight: 600, color: "var(--navy-500)" }}>
            Comprobante <span style={{ color: "var(--sky-700)" }}>*</span>
          </span>
          <input
            key={fileKey}
            type="file"
            name="file"
            accept={RECEIPT_ACCEPT}
            onChange={(e) => void onPickFile(e.target.files?.[0] ?? null)}
            aria-invalid={errors.file ? true : undefined}
            style={{ display: "block", marginTop: 6, maxWidth: "100%", fontSize: 13 }}
          />
          <span style={{ display: "block", marginTop: 4, fontSize: 11, color: errors.file ? "#9F1F1F" : "var(--navy-300)" }} role={errors.file ? "alert" : undefined}>
            {preparing ? "Preparando la foto…" : (errors.file ?? fileInfo ?? "PDF, JPG, PNG o WEBP de hasta 4 MB.")}
          </span>
        </label>
        {formError && (
          <p role="alert" style={{ margin: 0, fontSize: 13.5, color: "#9F1F1F" }}>
            {formError}
          </p>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              reset();
              onClose();
            }}
          >
            Cancelar
          </Button>
          <Button type="submit" disabled={pending || preparing}>
            {pending ? "Enviando…" : "Enviar comprobante"}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
