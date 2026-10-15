"use client";

import { useCallback, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { fmtHour, type BookingDTO } from "@/components/agenda/agenda-utils";
import { setBookingCopagoPaid } from "@/lib/bookings";
import { formatARS } from "@/lib/format";
import { isStaleError } from "@/lib/reception-view-state";
import { SALA_COPY, shortPatientName } from "@/lib/sala-board-state";
import type { DeskViewer } from "@/lib/reception-desk-state";

/** Estados de cobro que ya no deben nada (mismo criterio que `owesCopago`). */
const SETTLED: ReadonlySet<string> = new Set(["PAID", "AUTHORIZED", "REFUNDED"]);

/**
 * La fila después de registrar el cobro: PAID y el `updatedAt` nuevo que devolvió el server (la próxima acción de
 * Recepción sobre esta fila lo manda como `expectedUpdatedAt`; con el viejo, la acción rebotaría por «cambió en
 * otra sesión»). `setBookingCopagoPaid` no devuelve la fila: se arma acá.
 */
export function applyCopagoPaid(row: BookingDTO, updatedAt: Date | string): BookingDTO {
  return { ...row, paymentStatus: "PAID", updatedAt: new Date(updatedAt).toISOString() };
}

/**
 * Modal «Cobrar» del escritorio (RX-1b, prototipo `openPay()`; RX-D4). Importe del copago con `formatARS`, la
 * cobertura, el profesional y la hora; «Registrar cobro» llama a `setBookingCopagoPaid(id, true, updatedAt)` tal
 * cual está en `lib/bookings.ts` (no se toca) y, si sale, `onSaved(fila)` → `live.replaceRow`.
 *
 * - **Sin «Medio de pago»** (RX-D4): `Booking` no tiene columna para eso y sería migración; va a C0.
 * - **Solo con `billing.manage`**: el server no lo exige (`toggleBilling` pide acceso al paciente; hallazgo
 *   anotado para C0, brief §5.1.4), así que la UI es la que no ofrece Cobrar a la Secretaria. Este modal además se
 *   niega a llamar al server sin `canCollect`, por si alguna cara lo abre por error.
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

  const close = useCallback(() => {
    if (!saving) onClose();
  }, [saving, onClose]);

  async function confirm() {
    if (!row || saving || !viewer.canCollect) return;
    const name = shortPatientName(row.patientName);
    if (SETTLED.has(row.paymentStatus ?? "UNPAID")) {
      toast.info(`${name} ya tenía el cobro registrado`);
      onClose();
      return;
    }
    setSaving(true);
    let res: Awaited<ReturnType<typeof setBookingCopagoPaid>>;
    try {
      res = await setBookingCopagoPaid(row.id, true, row.updatedAt);
    } catch {
      res = { ok: false, error: "No pudimos registrar el cobro. Revisá la conexión y reintentá." };
    }
    setSaving(false);
    if (res.ok) {
      onSaved(applyCopagoPaid(row, res.data.updatedAt));
      toast.success(`Cobro registrado · ${name} · ${formatARS(row.copagoCents)}`, res.data.notice ? { description: res.data.notice } : undefined);
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
    <Modal open={row != null} onClose={close} title={row ? `Cobrar a ${row.patientName}` : "Cobrar"} description={description} width={420}>
      {row && (
        <div className="desk-pay">
          <div className="desk-pay-amt">
            <span>Importe</span>
            <b>{formatARS(row.copagoCents)}</b>
          </div>
          <p className="desk-pay-note">Queda registrado como cobrado en el turno.</p>
          <div className="desk-pay-f">
            <Button type="button" variant="ghost" onClick={close} disabled={saving}>
              Cancelar
            </Button>
            <Button type="button" variant="primary" onClick={() => void confirm()} disabled={saving} aria-busy={saving || undefined}>
              {saving ? "Registrando…" : "Registrar cobro"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
