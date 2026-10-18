"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { setBookingCopagoPaid } from "@/lib/bookings";
import { COLLECT_COPY, collectImputationLine, collectModalDescription, copagoRemainingCents } from "@/lib/booking-collect";
import { formatARS } from "@/lib/format";
import { PAYMENT_METHOD_LABEL, type PaymentMethod } from "@/lib/payment-method";
import { isStaleError } from "@/lib/reception-view-state";
import { PaymentMethodPicker, rememberPaymentMethod } from "@/components/billing/payment-method-picker";
import type { DrawerBooking } from "./types";

/** Lo que el modal le devuelve a la fila del drawer: la versión nueva del turno y el medio que guardó el server. */
export type CollectResult = { updatedAt: string; method: PaymentMethod | null };

/** Marcar sin medio no existe (decisión 5 del 19-oct): el mismo copy que devuelve el server. Puro, para el test. */
export function validateCollect(
  method: PaymentMethod | null
): { ok: true; method: PaymentMethod } | { ok: false; error: string } {
  return method ? { ok: true, method } : { ok: false, error: COLLECT_COPY.methodRequired };
}

/**
 * Cuerpo del modal (exportado para el render test: el `Modal` monta por portal recién hidratado y en el render de
 * servidor no pinta nada). Mismo layout que «Registrar cobro» de /sala (`desk-pay-modal.tsx`), con `ModalActions`
 * para que bajo 640 px los botones se apilen a 44 px (los chips del picker ya miden 44).
 *
 * `imputation` (T3-Y): la línea «Se imputa a …» de `collectImputationLine`, obligatoria para que ningún caller (drawer
 * o Facturación) la pueda olvidar.
 */
export function CollectForm({
  amountCents,
  imputation,
  method,
  onMethod,
  error,
  saving,
  onCancel,
  onConfirm,
}: {
  amountCents: number;
  imputation: string;
  method: PaymentMethod | null;
  onMethod: (m: PaymentMethod) => void;
  error: string | null;
  saving: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
          padding: "14px 16px",
          borderRadius: 14,
          background: "var(--bg-panel)",
          color: "var(--navy-500)",
          fontSize: 14,
        }}
      >
        <span>Importe</span>
        <b style={{ fontSize: 28, fontWeight: 650, lineHeight: 1, color: "var(--navy-900)", fontVariantNumeric: "tabular-nums" }}>
          {formatARS(amountCents)}
        </b>
      </div>
      <p data-testid="collect-imputation" style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "var(--navy-900)" }}>
        {imputation}
      </p>
      <PaymentMethodPicker value={method} onChange={onMethod} disabled={saving} error={error} />
      <p style={{ margin: 0, fontSize: 13, color: "var(--navy-500)" }}>
        Queda registrado como pagado en el turno, con el medio que elegiste.
      </p>
      <ModalActions>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
          Cancelar
        </Button>
        <Button type="button" variant="primary" onClick={onConfirm} disabled={saving} aria-busy={saving || undefined}>
          {saving ? "Registrando…" : `Marcar pagado · ${formatARS(amountCents)}`}
        </Button>
      </ModalActions>
    </div>
  );
}

/**
 * Modal «Registrar cobro» del drawer del turno (T3d-1r, C-AS2; plan §23.4). Va en su propio chunk (`next/dynamic`
 * desde `billing-rows.tsx`): el picker y este modal solo bajan cuando alguien toca «Cobrar», así el first-load de
 * /agenda no crece (estaba en 172,2 de 180 kB).
 *
 * - El monto es `copagoRemainingCents` (copago − señas cobradas; en T3 sin señas = el copago entero), el mismo que
 *   valida el server.
 * - Medio OBLIGATORIO y sin preselección (`PaymentMethodPicker`); cada apertura arranca vacía: el medio del turno
 *   anterior no se arrastra a otro paciente.
 * - Lock optimista: manda el `updatedAt` que tiene la fila. Stale → toast y cierra (el turno cambió en otra sesión);
 *   Mercado Pago o permiso → toast con el error del server y el modal queda abierto (no hay nada que corregir acá,
 *   pero cerrar en silencio ocultaría el porqué).
 * - El Modal hace portal a `document.body` (PF1.0-b): montado desde el drawer queda arriba del panel.
 */
export function CollectModal({
  booking,
  practitionerName = null,
  onClose,
  onSaved,
}: {
  /** null = cerrado (el Modal queda montado para la animación de salida). */
  booking: DrawerBooking | null;
  /**
   * Nombre público del profesional del turno para «Se imputa a …» (T3-Y: siempre, aunque haya uno solo). null = no
   * está en la lista de la agenda (dado de baja): la línea dice «al profesional del turno».
   */
  practitionerName?: string | null;
  onClose: () => void;
  onSaved: (r: CollectResult) => void;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [method, setMethod] = useState<PaymentMethod | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openId = booking?.id ?? null;
  useEffect(() => {
    setMethod(null);
    setError(null);
  }, [openId]);

  const close = useCallback(() => {
    if (!saving) onClose();
  }, [saving, onClose]);

  const amountCents = booking ? copagoRemainingCents({ resolvedCopagoCents: booking.copagoCents, deposits: [] }) : 0;

  async function confirm() {
    if (!booking || saving) return;
    const v = validateCollect(method);
    if (!v.ok) {
      setError(v.error);
      return;
    }
    setSaving(true);
    let res: Awaited<ReturnType<typeof setBookingCopagoPaid>>;
    try {
      res = await setBookingCopagoPaid(booking.id, { paid: true, method: v.method }, booking.updatedAt);
    } catch {
      res = { ok: false, error: "Revisá la conexión y reintentá." };
    }
    setSaving(false);
    if (res.ok) {
      rememberPaymentMethod(v.method);
      onSaved({ updatedAt: res.data.updatedAt, method: res.data.method });
      toast.success(
        `Cobro registrado · ${formatARS(amountCents)} · ${PAYMENT_METHOD_LABEL[v.method]}`,
        res.data.notice ? { description: res.data.notice } : undefined
      );
      onClose();
      return;
    }
    if (isStaleError(res.error)) {
      toast.warning("El turno cambió en otra sesión", { description: "Cerrá el turno y abrilo de nuevo para ver lo último." });
      onClose();
      return;
    }
    toast.error(COLLECT_COPY.collectFailed, { description: res.error });
  }

  return (
    <Modal
      open={booking != null}
      onClose={close}
      title="Registrar cobro"
      description={booking ? collectModalDescription(booking) : undefined}
      width={460}
    >
      {booking && (
        <CollectForm
          amountCents={amountCents}
          imputation={collectImputationLine({ practitionerId: booking.practitionerId, practitionerName })}
          method={method}
          onMethod={(m) => {
            setMethod(m);
            setError(null);
          }}
          error={error}
          saving={saving}
          onCancel={close}
          onConfirm={() => void confirm()}
        />
      )}
    </Modal>
  );
}
