/**
 * [TP-3i] Vista de `/pagar/[token]` (plan §25.7 «Página pública», §25.10; contrato C-TP9; TP-D23).
 *
 * Server component SIN "use client": la página entera es HTML. Lo único que corre en el browser es `PayLinkPoller`
 * (y solo al volver de Mercado Pago). Así `/pagar` queda en el grupo `public` (≤120 kB, §25.11) y el guard de
 * superficies públicas (`public-surface-imports.test.ts`: nada de framer, toast, drawer ni modal) pasa sin excepciones.
 *
 * Reglas:
 *   - **Sin datos del paciente.** Solo se pinta lo que trae `PublicPaymentLink` (consultorio, a nombre de quién entra la
 *     plata, monto, concepto, vencimiento, comprobante). El link circula por WhatsApp y mail y lo puede abrir cualquiera.
 *   - **Ir a Mercado Pago es un `<a>`** al `checkoutUrl`, en la misma pestaña (las `back_urls` vuelven acá con `?r=`):
 *     navegación pura, sin JS ni POST. Un botón con action escribiría en un GET y los antivirus de mail abren links.
 *     `rel="noreferrer"` además del `referrer: same-origin` de la página: el token viaja en la URL.
 *   - **`?r=` no manda sobre el server.** Mercado Pago vuelve con `?r=ok` antes de que llegue el webhook: con el link
 *     todavía «para pagar» se muestra «procesando» (sin botón, para no pagar dos veces) y se consulta 3 s × 60. Cuando el
 *     server dice un estado final, ese es el que se ve. `?r=failed` solo suma un aviso arriba del botón.
 *
 * Marco y estilos: `BookingFrame` + `booking-result.module.css`, los del resultado del turnero (VX2-d2). El paciente
 * llega desde el consultorio: arriba va la marca del consultorio y la de la app (`BRAND_NAME`) queda chica en el pie.
 */
import type { ReactNode } from "react";
import { BookingFrame } from "@/components/booking/booking-unavailable";
import { buttonClassName } from "@/components/ui/button";
import { IconArrow, IconCheck, IconClock, IconX } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import { formatARS } from "@/lib/format";
import { formatArDateTime } from "@/lib/mp-receipt";
import { RECEIPT_COPY } from "@/lib/online-payments-copy";
import type { PublicPaymentLink, PublicPaymentLinkStatus } from "@/lib/payment-links-types";
import s from "@/components/booking/booking-result.module.css";
import { PayLinkPoller } from "./pay-link-poller";

/** Los 8 estados de §25.7: los 7 de `PublicPaymentLink` + «inexistente» (`null`). */
export type PayLinkState = PublicPaymentLinkStatus | "missing";

/** `?r=` de las `back_urls` de la preferencia (C-TP9: `/pagar/<token>?r=ok|failed|pending`). */
export type PayLinkReturn = "ok" | "failed" | "pending";

/**
 * Copy de `/pagar`. Default de TP-3i (el brief fija solo «¡Pago recibido!» y «ya no está disponible»): para que Martin
 * lo confirme. Queda acá y no en `lib/online-payments-copy.ts` (TP-3z lo midió): ese módulo no se recorta por export y
 * cada ruta cliente que lo importa (/cobros, el perfil, los drawers) arrastraría este copy entero (+~0,4 kB en /cobros).
 */
export const PAY_LINK_COPY = {
  payable: {
    title: "Link de pago",
    lead: (clinic: string) => `${clinic} te mandó un link para pagar con Mercado Pago.`,
  },
  processing: {
    title: "Procesando tu pago…",
    lead: "Apenas Mercado Pago lo confirme, esta pantalla se actualiza sola.",
    leadLater: "Mercado Pago todavía está procesando el pago. Volvé a abrir este link en unos minutos para ver cómo sigue.",
  },
  paid: {
    title: "¡Pago recibido!",
    lead: (clinic: string) => `${clinic} ya tiene tu pago. Si querés, guardá el comprobante.`,
  },
  expired: {
    title: "Este link de pago venció",
    lead: (clinic: string) => `Si todavía tenés que pagar, pedile a ${clinic} un link nuevo.`,
  },
  cancelled: {
    title: "Este link de pago ya no está disponible",
    lead: (clinic: string) => `Se anuló o ya está cobrado. Si tenés dudas, consultalo con ${clinic}.`,
  },
  refunded: {
    title: "Pago reintegrado",
    lead: "Mercado Pago te devolvió este pago. El reintegro se ve en tu cuenta de Mercado Pago o en el resumen de la tarjeta.",
  },
  unavailable: {
    title: "Link de pago no disponible",
    lead: (clinic: string) => `${clinic} no está recibiendo pagos online en este momento. Comunicate con el consultorio.`,
  },
  missing: {
    title: "No encontramos este link de pago",
    lead: "Revisá que el link esté completo o pedile uno nuevo al consultorio.",
  },
  payCta: "Pagar con Mercado Pago",
  payHint: "Te llevamos a Mercado Pago para completar el pago.",
  returnFailed: "El pago no se completó. Podés intentarlo de nuevo.",
  amount: "Monto",
  concept: "Concepto",
  payee: "A nombre de",
  expires: "Vence",
} as const;

/** Lo que se ve, según el estado del server y el `?r=` de la vuelta. Puro: lo fija el render test. */
export function payLinkDisplay(
  status: PublicPaymentLinkStatus | null,
  r: PayLinkReturn | null
): { state: PayLinkState; polling: boolean; returnFailed: boolean } {
  if (!status) return { state: "missing", polling: false, returnFailed: false };
  const back = r === "ok" || r === "pending";
  if (status === "payable") {
    if (back) return { state: "processing", polling: true, returnFailed: false };
    return { state: "payable", polling: false, returnFailed: r === "failed" };
  }
  // AUTHORIZED: Mercado Pago retiene el pago. Con cualquier `?r=` el paciente viene de pagar: se espera el webhook.
  if (status === "processing") return { state: "processing", polling: r !== null, returnFailed: false };
  return { state: status, polling: false, returnFailed: false };
}

export function PayLinkView({ link, r, resetHref }: { link: PublicPaymentLink | null; r: PayLinkReturn | null; resetHref: string }) {
  const { state, polling, returnFailed } = payLinkDisplay(link?.status ?? null, r);
  const clinic = link?.clinicName ?? "";
  const C = PAY_LINK_COPY;

  let lead: string;
  switch (state) {
    case "payable":
      lead = C.payable.lead(clinic);
      break;
    case "processing":
      lead = polling ? C.processing.lead : C.processing.leadLater;
      break;
    case "paid":
      lead = C.paid.lead(clinic);
      break;
    case "expired":
      lead = C.expired.lead(clinic);
      break;
    case "cancelled":
      lead = C.cancelled.lead(clinic);
      break;
    case "refunded":
      lead = C.refunded.lead;
      break;
    case "unavailable":
      lead = C.unavailable.lead(clinic);
      break;
    case "missing":
      lead = C.missing.lead;
      break;
  }

  // Inexistente: ni el consultorio (no se sabe cuál es; tampoco se confirma que el token exista).
  return (
    <BookingFrame clinicName={link ? clinic : null} narrow={!link}>
      {/* role=status: el lector de pantalla anuncia el cambio procesando → pagado que trae el poller. */}
      <div role="status" aria-live="polite" data-pay-state={state}>
        <StateIcon state={state} />
        <h1 className={cn("k-display", s.title)}>{C[state].title}</h1>
        <p className={s.lead}>{lead}</p>
      </div>

      {link && state !== "unavailable" && (
        <dl className={s.details}>
          <Row label={C.amount} value={formatARS(link.amountCents)} />
          {link.concept && <Row label={C.concept} value={link.concept} />}
          {link.practitionerName && <Row label={C.payee} value={link.practitionerName} />}
          {state === "payable" && <Row label={C.expires} value={formatArDateTime(link.expiresAt)} />}
        </dl>
      )}

      {link?.receipt && (state === "paid" || state === "refunded") && (
        // Las filas que el link expone (C-TP9): las arma `buildMpReceipt` en el server, en hora AR, igual que el
        // comprobante del drawer y de /cobros. El monto ya está arriba.
        <section aria-labelledby="pay-receipt">
          <h2 id="pay-receipt" className={s.term} style={{ margin: "24px 0 0", textAlign: "left" }}>
            {RECEIPT_COPY.title}
          </h2>
          <dl className={s.details} style={{ marginTop: 8 }}>
            <Row label={RECEIPT_COPY.operation} value={link.receipt.operationId} />
            <Row label={RECEIPT_COPY.date} value={link.receipt.approvedAtLabel} />
            <Row label={RECEIPT_COPY.method} value={link.receipt.methodLabel} />
          </dl>
        </section>
      )}

      {state === "payable" && link?.checkoutUrl && (
        <div className={s.actions}>
          {returnFailed && (
            <p className={s.note} style={{ marginTop: 0 }}>
              {C.returnFailed}
            </p>
          )}
          <a href={link.checkoutUrl} rel="noreferrer" className={buttonClassName({ size: "lg", block: true })}>
            {C.payCta} <IconArrow size={14} />
          </a>
          <p className={s.note} style={{ marginTop: 0 }}>
            {C.payHint}
          </p>
        </div>
      )}

      {polling && <PayLinkPoller active resetHref={resetHref} />}
    </BookingFrame>
  );
}

function StateIcon({ state }: { state: PayLinkState }) {
  const ok = state === "paid";
  const waiting = state === "payable" || state === "processing";
  const tone = ok ? s.iconOk : waiting ? s.iconPending : s.iconFailed;
  const icon: ReactNode = ok ? <IconCheck size={28} stroke={3} /> : waiting ? <IconClock size={28} /> : <IconX size={28} stroke={3} />;
  return (
    <div className={cn(s.icon, tone)} aria-hidden="true">
      {icon}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className={s.row}>
      <dt className={s.term}>{label}</dt>
      <dd className={s.value}>{value}</dd>
    </div>
  );
}
