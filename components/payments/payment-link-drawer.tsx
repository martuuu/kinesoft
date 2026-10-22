"use client";

/**
 * [TP-K4] `PaymentLinkDrawer` compartido (§25.10: drawer del turno, Facturación, /cobros, Sala). Stub funcional de T5c
 * con las props CONGELADAS de `payments-ui-types.ts`; TP-3d lo completa (opciones deduplicadas, aviso del concepto con
 * `aria-describedby`, paso «Link listo» con WhatsApp y email, `lib/payment-link-form.ts`).
 *
 * Lo que ya cumple el stub, porque es contrato y no estilo:
 * - un `idempotencyKey` por instancia del drawer (AGENTS §4: UUID por instancia de modal) y un candado contra el doble
 *   click (una sola llamada a `createPaymentLink`);
 * - sin turno el monto es obligatorio (`FREE`); vence a los 7 días por default;
 * - concepto por default sin el servicio (TP-UI-D12) y dirty-guard del Drawer.
 *
 * Va diferido (§25.11): nadie lo importa estático desde `/agenda`; lo baja la sección de plata por `import()`.
 */
import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Drawer } from "@/components/ui/drawer";
import { MoneyInput } from "@/components/ui/money-input";
import { formatARS } from "@/lib/format";
import { BOOKING_MONEY_COPY, PAYMENT_LINK_COPY, defaultLinkConcept } from "@/lib/online-payments-copy";
import { createPaymentLink } from "@/lib/payment-links";
import {
  PAYMENT_LINK_DEFAULT_EXPIRY_DAYS,
  PAYMENT_LINK_EXPIRY_DAYS,
  type CreatePaymentLinkResult,
  type PaymentLinkExpiryDays,
  type PaymentLinkPurpose,
} from "@/lib/payment-links-types";
import type { PaymentLinkDrawerProps } from "./payments-ui-types";

function newKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `pl-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function PaymentLinkDrawer(props: PaymentLinkDrawerProps) {
  const { open, onClose, patient, booking, practitioners, defaultPractitionerId, onCreated } = props;
  const [idempotencyKey] = useState(newKey);
  const initialConcept = useMemo(() => (booking ? defaultLinkConcept(booking.startsAt) : ""), [booking]);
  const [purpose, setPurpose] = useState<PaymentLinkPurpose>(booking ? "REST" : "FREE");
  const [amountCents, setAmountCents] = useState<number | null>(null);
  const [concept, setConcept] = useState(initialConcept);
  const [expiresInDays, setExpiresInDays] = useState<PaymentLinkExpiryDays>(PAYMENT_LINK_DEFAULT_EXPIRY_DAYS);
  const [practitionerId, setPractitionerId] = useState<string>(
    booking?.practitionerId ?? defaultPractitionerId ?? practitioners[0]?.id ?? "",
  );
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatePaymentLinkResult | null>(null);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);

  const needsAmount = purpose === "DEPOSIT" || purpose === "FREE";
  const dirty = !created && (concept !== initialConcept || amountCents != null);

  async function submit() {
    if (inFlight.current) return;
    if (needsAmount && amountCents == null) {
      setError(PAYMENT_LINK_COPY.amountRange);
      return;
    }
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const res = await createPaymentLink({
        patientId: patient.id,
        ...(booking ? { bookingId: booking.id } : {}),
        practitionerId,
        purpose,
        ...(needsAmount && amountCents != null ? { amountCents } : {}),
        concept,
        expiresInDays,
        idempotencyKey,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setCreated(res.data);
      onCreated?.(res.data);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title={BOOKING_MONEY_COPY.generateLink} dirty={dirty}>
      {created ? (
        <div>
          <p>
            <strong>{BOOKING_MONEY_COPY.linkReady}</strong> · {formatARS(created.amountCents)}
          </p>
          <input readOnly value={created.url} aria-label={BOOKING_MONEY_COPY.linkReady} />
          <Button type="button" variant="ghost" onClick={() => void navigator.clipboard?.writeText(created.url)}>
            {BOOKING_MONEY_COPY.copy}
          </Button>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {booking ? (
            <fieldset>
              <legend>¿Cuánto?</legend>
              {(["REST", "TOTAL", "DEPOSIT"] as const).map((p) => (
                <label key={p}>
                  <input type="radio" name="purpose" checked={purpose === p} onChange={() => setPurpose(p)} />
                  {p === "REST" ? "Lo que falta" : p === "TOTAL" ? "El total" : "Una seña"}
                </label>
              ))}
            </fieldset>
          ) : (
            <label>
              Profesional
              <select value={practitionerId} onChange={(e) => setPractitionerId(e.target.value)}>
                {practitioners.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {needsAmount && <MoneyInput label="Monto" value={amountCents} onChange={setAmountCents} required />}
          <label>
            Concepto
            <input value={concept} onChange={(e) => setConcept(e.target.value)} aria-describedby="pl-concept-warning" />
          </label>
          <p id="pl-concept-warning">{PAYMENT_LINK_COPY.conceptWarning}</p>
          <label>
            Vence en
            <select value={expiresInDays} onChange={(e) => setExpiresInDays(Number(e.target.value) as PaymentLinkExpiryDays)}>
              {PAYMENT_LINK_EXPIRY_DAYS.map((d) => (
                <option key={d} value={d}>
                  {d === 1 ? "1 día" : `${d} días`}
                </option>
              ))}
            </select>
          </label>
          {error && <p role="alert">{error}</p>}
          <Button type="submit" disabled={pending || !practitionerId}>
            {BOOKING_MONEY_COPY.generateLink}
          </Button>
        </form>
      )}
    </Drawer>
  );
}
