"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { fmtHour, type BookingDTO } from "@/components/agenda/agenda-utils";
import { setBookingCopagoPaid } from "@/lib/bookings";
import { COLLECT_COPY, copagoRemainingCents } from "@/lib/booking-collect";
import { formatARS } from "@/lib/format";
import { PAYMENT_METHOD_LABEL, type PaymentMethod } from "@/lib/payment-method";
import { isStaleError } from "@/lib/reception-view-state";
import { SALA_COPY, shortPatientName } from "@/lib/sala-board-state";
import { canCollectRow, type DeskViewer } from "@/lib/reception-desk-state";
import { PaymentMethodPicker, rememberPaymentMethod } from "@/components/billing/payment-method-picker";

/** Estados de cobro que ya no deben nada (mismo criterio que `owesCopago`). */
const SETTLED: ReadonlySet<string> = new Set(["PAID", "AUTHORIZED", "REFUNDED"]);

/**
 * La fila después de registrar el cobro: PAID, el medio y el `updatedAt` nuevo que devolvió el server (la próxima
 * acción de Recepción sobre esta fila lo manda como `expectedUpdatedAt`; con el viejo, la acción rebotaría por
 * «cambió en otra sesión»). `setBookingCopagoPaid` no devuelve la fila: se arma acá.
 */
export function applyCopagoPaid(row: BookingDTO, updatedAt: Date | string, method: PaymentMethod | null): BookingDTO {
  return { ...row, paymentStatus: "PAID", copagoPaymentMethod: method, updatedAt: new Date(updatedAt).toISOString() };
}

/**
 * Modal «Registrar cobro» del escritorio (RX-1b, prototipo `openPay()`; T3 C-AS2, plan §23.4). Importe, cobertura,
 * profesional y hora; el medio de pago es OBLIGATORIO (`PaymentMethodPicker`, sin preselección: decisión 5 del
 * 19-oct) y «Marcar pagado · $ X» llama a `setBookingCopagoPaid(id, { paid: true, method }, updatedAt)`; si sale,
 * `onSaved(fila)` → `live.replaceRow` y el medio queda como «último» del dispositivo.
 *
 * - **El monto es `copagoRemainingCents`** (copago − señas cobradas). En T3 no hay señas (`deposits: []`) y es el
 *   copago entero; T5 enchufa las señas de MP sin tocar este modal (decisión 5: «Pagado» cubre el resto).
 * - **Quién cobra ESTA fila:** `canCollectRow` (el mismo `canCollectCopago` del server). Desde T3 la Secretaria y
 *   Facturación cobran cualquier turno y el profesional solo los suyos; el modal se niega a llamar al server si el
 *   viewer no cobra esta fila, por si alguna cara lo abre por error. Antes miraba `billing.manage` y el server
 *   pedía acceso full al paciente: el Admin veía «Cobrar» y el server lo rechazaba (hallazgo §23.2).
 * - Turno que cambió en otra sesión → toast «El turno cambió en otra sesión» (el realtime trae la fila nueva).
 * - Se monta como HERMANO de `.desk`, nunca adentro: `.desk` es contenedor de container queries y anclaría el
 *   `position: fixed` del Modal.
 *
 * `row` es la fila vigente (el shell la busca en `live.rows` al abrir): su `updatedAt` es el de ahora.
 */
export function DeskPayModal({
  row,
  practitionerName,
  viewer,
  onClose,
  onSaved,
}: {
  /** null = cerrado (el Modal queda montado para la animación de salida). */
  row: BookingDTO | null;
  practitionerName: string;
  viewer: DeskViewer;
  onClose: () => void;
  onSaved: (row: BookingDTO) => void;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [method, setMethod] = useState<PaymentMethod | null>(null);
  const [methodError, setMethodError] = useState<string | null>(null);
  // Cada apertura (otra fila) arranca sin medio: el de la fila anterior no se arrastra a otro paciente.
  const rowId = row?.id ?? null;
  useEffect(() => {
    setMethod(null);
    setMethodError(null);
  }, [rowId]);

  const close = useCallback(() => {
    if (!saving) onClose();
  }, [saving, onClose]);

  const amountCents = row ? copagoRemainingCents({ resolvedCopagoCents: row.copagoCents, deposits: [] }) : 0;

  async function confirm() {
    if (!row || saving || !canCollectRow(viewer, row)) return;
    const name = shortPatientName(row.patientName);
    if (SETTLED.has(row.paymentStatus ?? "UNPAID")) {
      toast.info(`${name} ya tenía el cobro registrado`);
      onClose();
      return;
    }
    if (!method) {
      setMethodError(COLLECT_COPY.methodRequired);
      return;
    }
    setSaving(true);
    let res: Awaited<ReturnType<typeof setBookingCopagoPaid>>;
    try {
      res = await setBookingCopagoPaid(row.id, { paid: true, method }, row.updatedAt);
    } catch {
      res = { ok: false, error: "No pudimos registrar el cobro. Revisá la conexión y reintentá." };
    }
    setSaving(false);
    if (res.ok) {
      rememberPaymentMethod(method);
      onSaved(applyCopagoPaid(row, res.data.updatedAt, res.data.method));
      toast.success(
        `Cobro registrado · ${name} · ${formatARS(amountCents)} · ${PAYMENT_METHOD_LABEL[method]}`,
        res.data.notice ? { description: res.data.notice } : undefined
      );
      onClose();
      return;
    }
    if (isStaleError(res.error)) {
      toast.warning(SALA_COPY.stale, { description: `La sala se actualiza sola con lo último. Revisá a ${name} y reintentá.` });
      onClose();
      return;
    }
    toast.error(res.error);
  }

  const coverage = row ? (row.obraSocial === "Particular" ? "Sesión particular" : `Copago ${row.obraSocial}`) : "";
  const description = row ? `${coverage} · ${practitionerName} · ${fmtHour(new Date(row.scheduledFor))}` : undefined;

  return (
    <Modal open={row != null} onClose={close} title="Registrar cobro" description={row ? `${row.patientName} · ${description}` : undefined} width={460}>
      {row && (
        <div className="desk-pay">
          <div className="desk-pay-amt">
            <span>Importe</span>
            <b>{formatARS(amountCents)}</b>
          </div>
          <PaymentMethodPicker
            value={method}
            onChange={(m) => {
              setMethod(m);
              setMethodError(null);
            }}
            disabled={saving}
            error={methodError}
          />
          <p className="desk-pay-note">Queda registrado como pagado en el turno, con el medio que elegiste.</p>
          <div className="desk-pay-f">
            <Button type="button" variant="ghost" onClick={close} disabled={saving}>
              Cancelar
            </Button>
            <Button type="button" variant="primary" onClick={() => void confirm()} disabled={saving} aria-busy={saving || undefined}>
              {saving ? "Registrando…" : `Marcar pagado · ${formatARS(amountCents)}`}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
