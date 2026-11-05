"use client";

/**
 * TP-3h · cobro online en el paso «Tus datos» del turnero (§25.10 «Turnero», C-TP8).
 *
 * - OPTIONAL: «Reservar y pagar en el consultorio» / «Pagar ahora con Mercado Pago», **sin preselección** (TP-UI-D5:
 *   el server trata `payNow` ausente como «no eligió» y no cobra; preseleccionar «pagar ahora» empujaría un pago que el
 *   consultorio declaró opcional). Radios nativos en un fieldset: teclado y lector de pantalla sin código extra.
 * - REQUIRED: solo el aviso (el paciente no elige).
 * - `PaymentInterstitial`: el monto real antes de ir a Mercado Pago cuando difiere del cotizado (TP-UI-D6: copago de la
 *   obra social, o particular por TP-D22), el aviso de Mercado Pago caído en OPTIONAL (el turno quedó reservado) y,
 *   desde TP-ZF2, el turno que el server reservó sin cobrar aunque el wizard había cotizado (copago $ 0).
 *
 * Markup mínimo y sin dependencias nuevas: entra al first load del turnero (techo ≤115 kB gz, §25.11).
 */
import { Button } from "@/components/ui/button";
import { IconAlert, IconArrow } from "@/components/ui/icons";
import { formatARS } from "@/lib/format";
import { paymentAmountText, type PayChoice, type WizardOnlinePayment } from "@/lib/public-wizard-state";
import s from "../public-booking.module.css";
import { StepHeader } from "./shared";

/**
 * Literales de `TURNERO_PAYMENT_COPY` (`lib/online-payments-copy.ts`, TP-P5), copiados con paridad fijada por
 * `tests/unit/render/public-booking-wizard.test.tsx`. No se importa: webpack no recorta exports de un módulo compartido
 * entre rutas y el módulo de copy entero pesaba +2 kB gz en el first load del turnero (medido en TP-3h, techo ≤115).
 */
export const PAY_COPY = {
  payLater: "Reservar y pagar en el consultorio",
  payNow: "Pagar ahora con Mercado Pago",
  depositNow: "Seña a pagar ahora",
  restAtClinic: "Resto en el consultorio",
  optionalUnavailable: "No pudimos abrir Mercado Pago: lo pagás en el consultorio.",
} as const;

export function PaymentChoice({
  payment,
  choice,
  onChange,
}: {
  payment: WizardOnlinePayment;
  choice: PayChoice;
  onChange: (c: "now" | "later") => void;
}) {
  if (payment.mode === "REQUIRED") {
    return (
      <p className={s.payNote}>
        Para confirmar el turno se paga con Mercado Pago{payment.coverageDependent || payment.amountHidden ? ". " : ": "}{paymentAmountText(payment)}.
      </p>
    );
  }
  const opt = (value: "later" | "now", label: string, sub: string) => (
    <label className={`${s.choice} ${s.choiceRow}`}>
      <input type="radio" name="payChoice" value={value} checked={choice === value} onChange={() => onChange(value)} />
      <span className={s.choiceMain}>
        <span className={s.choiceTitle}>{label}</span>
        <span className={s.choiceSub}>{sub}</span>
      </span>
    </label>
  );
  return (
    <fieldset className={s.payChoice}>
      <legend className={s.sectionLabel}>¿Cómo querés pagar?</legend>
      {/* ZB-11: sin preselección (TP-UI-D5) el botón queda deshabilitado; sin esta línea no se entiende por qué. */}
      {choice === null && <p className={s.choiceSub}>Elegí una opción para confirmar el turno.</p>}
      {opt("later", PAY_COPY.payLater, "Tu turno queda reservado.")}
      {opt("now", PAY_COPY.payNow, paymentAmountText(payment))}
    </fieldset>
  );
}

/** Título por caso: el interstitial reemplaza al paso «Tus datos», y el foco va a este título (ZB-2). */
const INTERSTITIAL_COPY = {
  amount: { title: "Antes de ir a Mercado Pago", subtitle: "El monto cambió con tus datos.", cta: "Continuar a Mercado Pago" },
  // CF3 (D-CF3-3): precio oculto del profesional. El wizard no mostró ningún número, así que no «cambió»: es la primera
  // vez que se ve, y se ve siempre antes de Mercado Pago (nunca un monto falso en el resumen).
  hidden: { title: "Antes de ir a Mercado Pago", subtitle: "Este es el monto a pagar.", cta: "Continuar a Mercado Pago" },
  unavailable: { title: "Tu turno quedó reservado", subtitle: "Ya está agendado.", cta: "Ver mi turno" },
  reserved: { title: "Tu turno quedó reservado", subtitle: "Con tus datos, este turno no se cobra online.", cta: "Ver mi turno" },
} as const;

export function PaymentInterstitial({
  kind,
  amountCents,
  onContinue,
}: {
  kind: "amount" | "hidden" | "unavailable" | "reserved";
  amountCents: number | null;
  onContinue: () => void;
}) {
  const copy = INTERSTITIAL_COPY[kind];
  return (
    <>
      <StepHeader title={copy.title} subtitle={copy.subtitle} />
      <div className="k-alert" role="alert">
        <IconAlert size={18} />
        <span>
          {kind === "unavailable"
            ? PAY_COPY.optionalUnavailable
            : kind === "reserved"
              ? "No hace falta pagar online: lo arreglás en el consultorio."
              : kind === "hidden"
                ? `El monto a pagar es ${formatARS(amountCents ?? 0)}. Lo vas a ver así en Mercado Pago.`
                : `Con tus datos, el monto a pagar es ${formatARS(amountCents ?? 0)}. Lo vas a ver así en Mercado Pago.`}
        </span>
      </div>
      <Button variant="primary" size="md" onClick={onContinue}>
        {copy.cta} <IconArrow size={14} />
      </Button>
    </>
  );
}
