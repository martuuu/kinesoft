"use client";

/**
 * [TP-K4] Sección de plata del drawer del turno (§25.10 «Drawer del turno»). Stub funcional de T5c con las props
 * CONGELADAS de `payments-ui-types.ts`; TP-3c la completa y la monta en `booking-drawer/index.tsx` por `import()`.
 *
 * Contrato que ya cumple el stub:
 * - las líneas («Seña pagada · $X», «Por cobrar · $Y», «Pagado por Mercado Pago», «Reintegrado por Mercado Pago») salen
 *   de `bookingMoneyLines` (lib/booking-money-view.ts), la misma cuenta que la card y el modal;
 * - **sin pistas no llama a `getBookingOnlineCharges`** (test 3c): un turno sin plata online es la enorme mayoría y
 *   no puede costar un round-trip al abrir el drawer (`onlineMoneyHint`);
 * - el comprobante y el `PaymentLinkDrawer` bajan por `next/dynamic` recién cuando hacen falta (§25.11: «drawer,
 *   sección, comprobante y link diferidos»; lo fija `tests/unit/online-payments-first-load-guard.test.ts`).
 */
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { Button } from "@/components/ui/button";
import { bookingMoneyLines } from "@/lib/booking-money-view";
import { formatARS } from "@/lib/format";
import { getBookingOnlineCharges } from "@/lib/online-charges-read";
import { BOOKING_MONEY_COPY, RECEIPT_COPY } from "@/lib/online-payments-copy";
import type { OnlineChargeView } from "@/lib/online-payments-types";
import type { BookingMoneySectionBooking, BookingMoneySectionProps, MpReceiptData } from "./payments-ui-types";

const PaymentLinkDrawer = dynamic(() => import("./payment-link-drawer").then((m) => m.PaymentLinkDrawer), { ssr: false });
const MpReceiptView = dynamic(() => import("./mp-receipt-view").then((m) => m.MpReceiptView), { ssr: false });

/**
 * ¿Vale la pena preguntar por los cobros online del turno? Solo con alguna pista: seña (`od`), pagado online (`po`),
 * un estado de pago que solo deja Mercado Pago (AUTHORIZED/REFUNDED) o la pista explícita del caller.
 */
export function onlineMoneyHint(b: Pick<BookingMoneySectionBooking, "onlineDepositCents" | "paidOnline" | "paymentStatus">, extra?: boolean): boolean {
  return Boolean(extra) || b.onlineDepositCents > 0 || b.paidOnline || b.paymentStatus === "AUTHORIZED" || b.paymentStatus === "REFUNDED";
}

/**
 * PROVISORIO (TP-K4): `OnlineChargeView.receipt` (C-TP9) no trae cuotas ni filas, así que acá salen 6 filas como mucho
 * (sin «Cuotas»). El test 3c pide 7: ver el hallazgo del reporte de TP-K4 (el server tiene que mandar las filas de
 * `buildMpReceipt` con `account`). TP-3c borra este adaptador cuando eso llegue.
 */
function receiptDataOf(c: OnlineChargeView): MpReceiptData | null {
  const r = c.receipt;
  if (!r) return null;
  const amountLabel = formatARS(r.paidAmountCents);
  const account =
    c.accountKind === "PRACTITIONER" && c.practitionerName
      ? RECEIPT_COPY.practitionerAccount(c.practitionerName)
      : RECEIPT_COPY.clinicAccount;
  return {
    operationId: r.operationId,
    approvedAt: r.approvedAt,
    approvedAtLabel: r.approvedAtLabel,
    paidAmountCents: r.paidAmountCents,
    amountLabel,
    methodLabel: r.methodLabel,
    installmentsLabel: "",
    statusLabel: r.statusLabel,
    refundedAt: r.refundedAt,
    refundedAtLabel: null,
    rows: [
      { key: "operation", label: RECEIPT_COPY.operation, value: r.operationId },
      { key: "date", label: RECEIPT_COPY.date, value: r.approvedAtLabel },
      { key: "amount", label: RECEIPT_COPY.amount, value: amountLabel },
      { key: "method", label: RECEIPT_COPY.method, value: r.methodLabel },
      { key: "status", label: RECEIPT_COPY.status, value: r.statusLabel },
      { key: "account", label: RECEIPT_COPY.account, value: account },
    ],
  };
}

export function BookingMoneySection({ booking, canCollect, onlineHint, onCollectRemaining, onChanged }: BookingMoneySectionProps) {
  const lines = bookingMoneyLines({
    onlineDepositCents: booking.onlineDepositCents,
    paidOnline: booking.paidOnline,
    copagoCents: booking.copagoCents,
    paymentStatus: booking.paymentStatus,
    refundedOnline: booking.paymentStatus === "REFUNDED" && booking.paidOnline,
  });
  const shouldFetch = onlineMoneyHint(booking, onlineHint);
  const [charges, setCharges] = useState<OnlineChargeView[] | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);

  useEffect(() => {
    if (!shouldFetch) return;
    let alive = true;
    void getBookingOnlineCharges({ bookingId: booking.id }).then((res) => {
      if (alive && res.ok) setCharges(res.data);
    });
    return () => {
      alive = false;
    };
  }, [booking.id, shouldFetch]);

  const remaining = lines.remainingCents;
  return (
    <section aria-label="Plata del turno" data-money-section>
      {lines.depositLine && <p>{lines.depositLine}</p>}
      {lines.remainingLine && (
        <p>
          {lines.remainingLine}
          {canCollect && remaining != null && remaining > 0 && onCollectRemaining && (
            <Button type="button" variant="ghost" size="sm" onClick={() => onCollectRemaining(remaining)}>
              Cobrar
            </Button>
          )}
        </p>
      )}
      {lines.onlineLine && <p>{lines.onlineLine}</p>}
      {charges?.map((c) => {
        const data = receiptDataOf(c);
        return data ? <MpReceiptView key={c.id} receipt={data} variant="collapsible" /> : null;
      })}
      {canCollect && booking.patientId && !booking.paidOnline && (
        <Button type="button" variant="ghost" size="sm" onClick={() => setLinkOpen(true)}>
          {BOOKING_MONEY_COPY.generateLink}
        </Button>
      )}
      {linkOpen && booking.patientId && (
        <PaymentLinkDrawer
          open
          onClose={() => setLinkOpen(false)}
          surface="agenda"
          patient={{ id: booking.patientId, name: booking.patientName }}
          booking={{
            id: booking.id,
            startsAt: booking.startsAt,
            practitionerId: booking.practitionerId,
            practitionerName: booking.practitionerName,
          }}
          practitioners={[]}
          onCreated={() => onChanged?.()}
        />
      )}
    </section>
  );
}
