"use client";

/**
 * [TP-3c] Sección de plata online del drawer del turno (§25.10 «Drawer del turno»; props CONGELADAS en
 * `payments-ui-types.ts`, TP-K4). La monta `booking-drawer/index.tsx` por `next/dynamic` debajo de la fila Copago.
 *
 * Qué muestra:
 * - «Seña pagada · $X» y, con seña, «Por cobrar · $Y» (lo que falta = copago − seña; el «Cobrar» de la fila Copago
 *   abre el modal por ese monto). Sin seña NO repite «Por cobrar»: ya lo dice la fila Copago y dos «Por cobrar» en el
 *   mismo turno se leían como dos cobros. «Pagado por Mercado Pago» / «Reintegrado por Mercado Pago» tampoco van acá:
 *   los dice la fila Copago (sin «Deshacer cobro», `billing-rows.tsx`).
 * - Los pagos de Mercado Pago del turno con su comprobante plegable (TP-UI-D11), armado con `buildMpReceipt` (la misma
 *   función que /pagar y el turnero: 7 filas con «Acreditado en»).
 * - El link de pago activo con Copiar / WhatsApp / Anular.
 * - «Generar link de pago», o la pista del server si falta cuenta o delegación (`getPaymentLinkSuggestions.blocked`).
 *
 * Costo:
 * - **sin pistas no llama a `getBookingOnlineCharges`** (test 3c): un turno sin plata online es la enorme mayoría y
 *   no puede costar un round-trip al abrir el drawer. Pista = seña (`od`), pagado online (`po`), un estado que solo
 *   deja Mercado Pago (AUTHORIZED/REFUNDED), o un link creado/pedido desde esta misma sección. Hallazgo de TP-K4: el
 *   cable no avisa de un link vivo sin seña; por eso «Generar link de pago» pregunta primero al server, y si ya hay
 *   uno vivo lo muestra en vez de abrir el formulario.
 * - el comprobante y el `PaymentLinkDrawer` bajan por `next/dynamic` recién cuando hacen falta (§25.11; lo fija
 *   `tests/unit/online-payments-first-load-guard.test.ts`).
 */
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { bookingMoneyLines, type BookingMoneyLines } from "@/lib/booking-money-view";
import { formatARS } from "@/lib/format";
import { buildMpReceipt } from "@/lib/mp-receipt";
import { getBookingOnlineCharges } from "@/lib/online-charges-read";
import { BOOKING_MONEY_COPY, PAYMENT_LINK_COPY } from "@/lib/online-payments-copy";
import type { OnlineChargeView } from "@/lib/online-payments-types";
import { cancelPaymentLink, getPaymentLinkShare, getPaymentLinkSuggestions } from "@/lib/payment-links";
import type { ActionResult } from "@/lib/validation";
import type { BookingMoneySectionBooking, BookingMoneySectionProps, MpReceiptData } from "./payments-ui-types";

const PaymentLinkDrawer = dynamic(() => import("./payment-link-drawer").then((m) => m.PaymentLinkDrawer), { ssr: false });
const MpReceiptView = dynamic(() => import("./mp-receipt-view").then((m) => m.MpReceiptView), { ssr: false });

/**
 * ¿Vale la pena preguntar por los cobros online del turno? Solo con alguna pista: seña (`od`), pagado online (`po`),
 * un estado de pago que solo deja Mercado Pago (AUTHORIZED/REFUNDED) o la pista explícita del caller. `index.tsx`
 * repite esta cuenta (sin importarla: el drawer no puede llevar este módulo estático) para decidir si monta la sección.
 */
export function onlineMoneyHint(
  b: Pick<BookingMoneySectionBooking, "onlineDepositCents" | "paidOnline" | "paymentStatus">,
  extra?: boolean
): boolean {
  return Boolean(extra) || b.onlineDepositCents > 0 || b.paidOnline || b.paymentStatus === "AUTHORIZED" || b.paymentStatus === "REFUNDED";
}

type ChargesResult = ActionResult<OnlineChargeView[]>;

/**
 * La lectura que hace la sección al montar, aparte del componente para testearla sin DOM: sin pistas devuelve `null`
 * SIN llamar al server (test 3c). `load` es la action real; el test mockea solo el módulo de red.
 */
export function loadOnlineChargesIfHinted(
  b: Pick<BookingMoneySectionBooking, "id" | "onlineDepositCents" | "paidOnline" | "paymentStatus">,
  extra: boolean | undefined,
  load: (input: { bookingId: string }) => Promise<ChargesResult> = getBookingOnlineCharges
): Promise<ChargesResult> | null {
  if (!onlineMoneyHint(b, extra)) return null;
  return load({ bookingId: b.id });
}

/**
 * Comprobante de un cobro con `buildMpReceipt` (lib/mp-receipt.ts): TP-2h manda en `receipt` los datos crudos (cuotas,
 * medio, estado de MP y la cuenta) y acá se arman las 7 filas, igual que en /pagar y el turnero. Antes había un
 * adaptador PROVISORIO de TP-K4 (`receiptDataOf`) que daba 6 filas sin «Cuotas».
 */
export function receiptOf(c: OnlineChargeView): MpReceiptData | null {
  const r = c.receipt;
  return r ? buildMpReceipt({ mpPaymentId: r.operationId, ...r }) : null;
}

/** El link que el paciente todavía puede pagar (uno por turno, TP-UI-D9). */
export function liveLinkOf(charges: readonly OnlineChargeView[] | null): OnlineChargeView | null {
  return charges?.find((c) => c.origin === "LINK" && c.status === "ACTIVE" && c.link) ?? null;
}

/** Lo que vale la pena listar en el drawer: lo cobrado (con comprobante) y lo que está en proceso. Lo vencido o
 *  anulado es historia: vive en Facturación del paciente y en /cobros. */
function shownCharges(charges: readonly OnlineChargeView[] | null): OnlineChargeView[] {
  return (charges ?? []).filter((c) => c.status === "PAID" || c.status === "REFUNDED" || c.status === "AUTHORIZED");
}

const KIND_LABEL: Record<OnlineChargeView["kind"], string> = { DEPOSIT: "Seña", FULL: "Pago", FREE: "Pago" };

export const LINK_CANCEL_CONFIRM = {
  title: "¿Anular el link de pago?",
  message: "El paciente ya no va a poder pagar con este link.",
  confirmLabel: "Anular link",
  tone: "danger",
} as const;

const NETWORK_ERROR = "Revisá la conexión y reintentá.";

const labelStyle = {
  width: 80,
  fontSize: 10.5,
  color: "var(--navy-300)",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  paddingTop: 2,
} as const;
const muted = { margin: 0, fontSize: 12, color: "var(--navy-500)" } as const;
const actionsRow = { display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" } as const;

export type BookingMoneyBodyProps = {
  lines: BookingMoneyLines;
  /** null = no se consultó (sin pistas) o todavía no llegó. */
  charges: readonly OnlineChargeView[] | null;
  /** Mostrar «Generar link de pago» (quien cobra, turno por cobrar con paciente, sin link vivo). */
  canGenerate: boolean;
  /** Pista del server por la que no se puede generar (sin cuenta, sin delegación, Mercado Pago apagado…). */
  hint: string | null;
  busy: boolean;
  /** `wa.me` del link vivo (null = sin celular válido: solo Copiar). */
  waUrl: string | null;
  onGenerate: () => void;
  onCopy: (url: string) => void;
  onCancelLink: (chargeId: string) => void;
};

/**
 * Lo que se ve, sin estado ni red (exportado para el render test: el componente de arriba trae los datos en efectos,
 * que el render de servidor no corre). Devuelve `null` si no hay nada que mostrar: el drawer queda como antes de T5.
 */
export function BookingMoneyBody({ lines, charges, canGenerate, hint, busy, waUrl, onGenerate, onCopy, onCancelLink }: BookingMoneyBodyProps) {
  const live = liveLinkOf(charges);
  const shown = shownCharges(charges);
  const remainingLine = lines.depositLine ? lines.remainingLine : null;
  const generate = canGenerate && !live;
  if (!lines.depositLine && !remainingLine && shown.length === 0 && !live && !generate && !hint) return null;

  return (
    <div style={{ display: "flex", gap: 10 }} data-money-section>
      <div style={labelStyle}>Online</div>
      <section aria-label="Plata online del turno" style={{ flex: 1, display: "grid", gap: 6, color: "var(--navy-900)", fontWeight: 500 }}>
        {lines.depositLine && <p style={{ margin: 0, fontWeight: 600, color: "var(--lime-700)" }}>{lines.depositLine}</p>}
        {remainingLine && <p style={{ margin: 0, fontWeight: 600, color: "var(--navy-500)" }}>{remainingLine}</p>}
        {shown.map((c) => {
          const receipt = receiptOf(c);
          return (
            <div key={c.id} data-charge={c.id} style={{ display: "grid", gap: 4 }}>
              <p style={muted}>
                {KIND_LABEL[c.kind]} · {formatARS(c.amountCents)} · {c.statusLabel}
              </p>
              {receipt && <MpReceiptView receipt={receipt} variant="collapsible" />}
            </div>
          );
        })}
        {live?.link && (
          <div data-live-link style={{ display: "grid", gap: 4 }}>
            <p style={muted}>
              Link de pago activo · {formatARS(live.amountCents)} · {live.statusLabel}
            </p>
            <div style={actionsRow}>
              <Button type="button" variant="ghost" size="sm" onClick={() => onCopy(live.link!.url)}>
                {BOOKING_MONEY_COPY.copy}
              </Button>
              {live.link.canResend && waUrl && (
                <a href={waUrl} target="_blank" rel="noopener noreferrer" className="k-btn k-btn-ghost k-btn-sm">
                  {BOOKING_MONEY_COPY.whatsapp}
                </a>
              )}
              {live.link.canCancel && (
                <Button type="button" variant="ghost" size="sm" disabled={busy} aria-busy={busy || undefined} onClick={() => onCancelLink(live.id)}>
                  {BOOKING_MONEY_COPY.cancelLink}
                </Button>
              )}
            </div>
          </div>
        )}
        {generate && (
          <div style={actionsRow}>
            <Button type="button" variant="ghost" size="sm" disabled={busy} aria-busy={busy || undefined} onClick={onGenerate}>
              {BOOKING_MONEY_COPY.generateLink}
            </Button>
          </div>
        )}
        {hint && (
          <p role="status" data-link-hint style={muted}>
            {hint}
          </p>
        )}
      </section>
    </div>
  );
}

export function BookingMoneySection({ booking, canCollect, onlineHint, onChanged }: BookingMoneySectionProps) {
  const toast = useToast();
  const confirm = useConfirm();
  const lines = bookingMoneyLines({
    onlineDepositCents: booking.onlineDepositCents,
    paidOnline: booking.paidOnline,
    copagoCents: booking.copagoCents,
    paymentStatus: booking.paymentStatus,
    refundedOnline: booking.paymentStatus === "REFUNDED" && booking.paidOnline,
  });
  // `touched`: esta sección creó un link o el server avisó de uno vivo → ya hay pista aunque el cable no la traiga.
  const [touched, setTouched] = useState(false);
  const [reload, setReload] = useState(0);
  const [charges, setCharges] = useState<OnlineChargeView[] | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [share, setShare] = useState<{ chargeId: string; waUrl: string | null } | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    const pending = loadOnlineChargesIfHinted(booking, onlineHint || touched);
    if (!pending) return;
    let alive = true;
    pending
      .then((res) => {
        if (alive && res.ok) setCharges(res.data);
      })
      // Red caída o sesión vencida: la sección queda con lo que dice el cable (seña / por cobrar). Sin toast: no es
      // algo que la persona hizo.
      .catch(() => {});
    return () => {
      alive = false;
    };
    // `booking` entero no: cambia de identidad en cada render del drawer. Lo que decide la lectura son estos campos.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booking.id, booking.onlineDepositCents, booking.paidOnline, booking.paymentStatus, onlineHint, touched, reload]);

  // WhatsApp del link vivo: el texto y el `wa.me` los arma el server (C-TP9, con el celular solo si el actor lo ve).
  // Una lectura, y solo cuando hay un link vivo que se puede reenviar.
  const live = liveLinkOf(charges);
  const liveShareId = live?.link?.canResend ? live.id : null;
  useEffect(() => {
    if (!liveShareId) return;
    let alive = true;
    getPaymentLinkShare({ chargeId: liveShareId })
      .then((res) => alive && setShare({ chargeId: liveShareId, waUrl: res.ok ? res.data.waUrl : null }))
      .catch(() => alive && setShare({ chargeId: liveShareId, waUrl: null }));
    return () => {
      alive = false;
    };
  }, [liveShareId]);

  const settled = booking.paidOnline || booking.paymentStatus === "PAID" || booking.paymentStatus === "AUTHORIZED" || booking.paymentStatus === "REFUNDED";
  const canGenerate = canCollect && Boolean(booking.patientId) && !settled && booking.status !== "CANCELLED";

  async function generate() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setHint(null);
    try {
      // Antes de abrir el formulario: mismas reglas que `createPaymentLink`. Así la pista (sin cuenta, sin delegación,
      // Mercado Pago apagado) aparece en el turno y no recién al confirmar el formulario.
      const res = await getPaymentLinkSuggestions({ bookingId: booking.id });
      if (!res.ok) {
        setHint(res.error);
        return;
      }
      if (res.data.blocked) {
        setHint(res.data.blocked);
        // El cable no avisa de un link vivo sin seña (hallazgo de TP-K4): si el server dice que hay uno, se muestra.
        if (res.data.blocked === PAYMENT_LINK_COPY.liveLinkExists) {
          setTouched(true);
          setReload((n) => n + 1);
        }
        return;
      }
      setLinkOpen(true);
    } catch {
      setHint(NETWORK_ERROR);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copiado");
    } catch {
      toast.error("No pudimos copiar el link", { description: url });
    }
  }

  async function cancelLink(chargeId: string) {
    if (inFlight.current) return;
    if (!(await confirm(LINK_CANCEL_CONFIRM))) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const res = await cancelPaymentLink({ chargeId });
      if (!res.ok) {
        toast.error("No pudimos anular el link", { description: res.error });
        return;
      }
      toast.success("Link de pago anulado");
      setHint(null);
      setReload((n) => n + 1);
      onChanged?.();
    } catch {
      toast.error("No pudimos anular el link", { description: NETWORK_ERROR });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <BookingMoneyBody
        lines={lines}
        charges={charges}
        canGenerate={canGenerate}
        hint={hint}
        busy={busy}
        waUrl={share && share.chargeId === live?.id ? share.waUrl : null}
        onGenerate={() => void generate()}
        onCopy={(url) => void copy(url)}
        onCancelLink={(id) => void cancelLink(id)}
      />
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
          onCreated={() => {
            // El link nuevo se ve en el turno al cerrar el drawer del link (con Copiar / WhatsApp / Anular).
            setTouched(true);
            setReload((n) => n + 1);
            onChanged?.();
          }}
        />
      )}
    </>
  );
}
