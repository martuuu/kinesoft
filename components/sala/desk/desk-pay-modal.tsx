"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import type { BookingDTO } from "@/components/agenda/agenda-utils";
import { setBookingCopagoPaid } from "@/lib/bookings";
import { COLLECT_COPY, collectImputationLine, collectModalDescription, withCopagoPaid } from "@/lib/booking-collect";
import { formatARS } from "@/lib/format";
import { PAYMENT_METHOD_LABEL, type PaymentMethod } from "@/lib/payment-method";
import { isStaleError } from "@/lib/reception-view-state";
import { SALA_COPY, shortPatientName } from "@/lib/sala-board-state";
import { canCollectRow, type DeskViewer } from "@/lib/reception-desk-state";
import { rememberPaymentMethod } from "@/components/billing/payment-method-picker";
import { CollectForm, collectAmountFor } from "@/components/agenda/booking-drawer/collect-modal";

/** Estados de cobro que ya no deben nada (mismo criterio que `owesCopago`). */
const SETTLED: ReadonlySet<string> = new Set(["PAID", "AUTHORIZED", "REFUNDED"]);

/**
 * La fila después de registrar el cobro: PAID, el medio y el `updatedAt` nuevo que devolvió el server (la próxima
 * acción de Recepción sobre esta fila lo manda como `expectedUpdatedAt`; con el viejo, la acción rebotaría por
 * «cambió en otra sesión»). `setBookingCopagoPaid` no devuelve la fila: se arma acá.
 *
 * [CF2-SD] Delega en `withCopagoPaid` (`lib/booking-collect.ts`), la MISMA fila que arma Recepción de la agenda: antes
 * esta copia ponía PAID aunque el medio viniera null (deshacer), y las dos superficies podían divergir.
 */
export function applyCopagoPaid(row: BookingDTO, updatedAt: Date | string, method: PaymentMethod | null): BookingDTO {
  return withCopagoPaid(row, { updatedAt, method });
}

/**
 * Modal «Registrar cobro» del escritorio (RX-1b, prototipo `openPay()`; T3 C-AS2, plan §23.4). Importe y la
 * descripción única de los tres modales de cobro (`collectModalDescription`, T3-Z B2: paciente · servicio · día y
 * hora) y, desde T3-Y, SIEMPRE la línea «Se imputa a …» (`collectImputationLine`); el medio de pago es OBLIGATORIO (`PaymentMethodPicker`, sin preselección: decisión 5 del
 * 19-oct) y «Marcar pagado · $ X» llama a `setBookingCopagoPaid(id, { paid: true, method }, updatedAt)`; si sale,
 * `onSaved(fila)` → `live.replaceRow` y el medio queda como «último» del dispositivo.
 *
 * - **El monto es lo que FALTA** (TP-3f, C-TP10): `collectAmountFor` = copago − seña pagada por Mercado Pago
 *   (`row.onlineDepositCents`, la Σ que mantiene el trigger de M18 y viaja en la fila de la sala), la misma cuenta que
 *   valida `setBookingCopagoPaid`. Hasta T5 iba `deposits: []`: con seña, el modal ofrecía el copago entero y la
 *   Secretaría cobraba la seña dos veces. Con seña, el cuerpo lo dice («Seña pagada por Mercado Pago · $ X. Se cobra lo
 *   que falta.»): sin esa línea, «Importe $ 14.000» de un turno de $ 20.000 parecía un error de copago.
 * - **El cuerpo es `CollectForm`** (TP-3f), el mismo del drawer y de Facturación (T3-Z M1 los había unificado y la sala
 *   había quedado con su copia): la línea de la seña, el picker y los botones de 44 px no pueden divergir entre los tres
 *   modales. Este módulo ya es diferido (`ssr: false` desde `reception-desk.tsx`), así que `collect-modal` no entra al
 *   first load de /sala.
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
  /**
   * Nombre público del profesional del turno para «Se imputa a …» (T3-Y: siempre, aunque haya uno solo). null/"" = no
   * está en la lista de la sala: la línea dice «al profesional del turno».
   */
  practitionerName?: string | null;
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

  const { amountCents, depositCents } = row ? collectAmountFor(row) : { amountCents: 0, depositCents: 0 };

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
      res = { ok: false, error: "Revisá la conexión y reintentá." };
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
    // T3-Z (B3): el mismo título que el drawer y Facturación; antes el error del server salía pelado.
    toast.error(COLLECT_COPY.collectFailed, { description: res.error });
  }

  const description = row ? collectModalDescription(row) : undefined;

  return (
    <Modal open={row != null} onClose={close} title="Registrar cobro" description={description} width={460}>
      {row && (
        <CollectForm
          amountCents={amountCents}
          depositCents={depositCents}
          imputation={collectImputationLine({ practitionerId: row.practitionerId, practitionerName })}
          method={method}
          onMethod={(m) => {
            setMethod(m);
            setMethodError(null);
          }}
          error={methodError}
          saving={saving}
          onCancel={close}
          onConfirm={() => void confirm()}
        />
      )}
    </Modal>
  );
}
