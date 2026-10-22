"use client";

import { useEffect, useState } from "react";
import { Tag } from "@/components/ui/tag";
import { ButtonLink } from "@/components/ui/button";
import { IconArrow, IconCheck, IconClock, IconX } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import { formatARS } from "@/lib/format";
import type { PublicBookingStatus } from "@/lib/public-booking-types";
import { BookAgainLink, BookingFrame } from "./booking-unavailable";
import s from "./booking-result.module.css";

/**
 * `ok` / `pending` / `failed` vienen de la URL (back_urls de Mercado Pago). El resto sale del estado: `reserved` (TP-0,
 * turno sin cobro online) y, con el cobro de T5 (TP-3h, C-TP8 `onlineCharge`), `paid` (pagado total), `deposit` (seña
 * pagada), `failed-optional` (OPTIONAL «Pagar ahora» rechazado: el turno sigue reservado) y `refunded`.
 */
export type BookingResultVariant = "ok" | "pending" | "failed" | "reserved" | "paid" | "deposit" | "failed-optional" | "refunded";

/**
 * Literales de `TURNERO_PAYMENT_COPY` y `RECEIPT_COPY` (`lib/online-payments-copy.ts`, TP-P5), copiados con paridad
 * fijada por `tests/unit/render/booking-result.test.tsx`. No se importa: webpack no recorta exports de un módulo
 * compartido entre rutas y el módulo de copy entero sumaba ~2 kB gz a `/booking/[id]/*` (techo +0,5, §25.11).
 */
export const RESULT_MONEY_COPY = {
  depositPaid: "Seña pagada",
  paid: "Pagado",
  refunded: "Reintegrado",
  restAtClinic: "Resto en el consultorio",
  operation: "N° de operación",
  date: "Fecha",
  method: "Medio de pago",
} as const;

/** 60 consultas cada 3 s ≈ 3 min: después se deja de consultar y se dice qué hacer, sin prometer nada. */
export const MAX_POLL_ATTEMPTS = 60;
const POLL_MS = 3000;

/**
 * Variante efectiva: el estado real del turno manda sobre la URL (MP vuelve a `/ok` antes de que llegue el webhook, y el
 * poller promueve pending → ok cuando el webhook lo marca PAID).
 *
 * TP-3h: con un cobro de T5 manda el COBRO (la seña no toca `paymentStatus`, TP-D7: con la regla vieja una seña pagada
 * se leía «Confirmado» sin decir cuánto falta, y un OPTIONAL rechazado decía «El turno no quedó confirmado» cuando sí
 * quedó). Un cobro vivo (ACTIVE/AUTHORIZED) es «procesando» salvo que MP haya vuelto por `/failed`: ahí el turno
 * reservado (OPTIONAL, CONFIRMED) sigue en pie y el hold de REQUIRED (PENDING) no. Vencido/anulado con el turno
 * CONFIRMED (Mercado Pago caído en OPTIONAL, o las 48 h) = reservado sin pago.
 */
export function effectiveVariantFor(status: PublicBookingStatus, variant: BookingResultVariant): BookingResultVariant {
  const c = status.onlineCharge;
  if (c) {
    if (c.status === "REFUNDED") return "refunded";
    if (c.status === "PAID") return c.kind === "DEPOSIT" ? "deposit" : "paid";
    const reserved = status.status === "CONFIRMED";
    if (c.status === "ACTIVE" || c.status === "AUTHORIZED") {
      if (variant !== "failed") return "pending";
      return reserved ? "failed-optional" : "failed";
    }
    if (!reserved) return "failed";
    return variant === "failed" ? "failed-optional" : "reserved";
  }
  if (status.paymentStatus === "PAID") return "ok";
  // TP-0: sin cobro online el turno nace CONFIRMED/UNPAID y no hay pago que esperar. Sin esta rama, el wizard llevaba a
  // `/ok` y se leía «¡Turno confirmado!» con «Monto $ 0», y un `/failed` abierto a mano decía «El pago no se completó».
  // Solo con `onlinePayment === false` explícito: los fixtures/payloads viejos (sin el campo) siguen como antes.
  if (status.onlinePayment === false && status.status === "CONFIRMED") return "reserved";
  if (status.paymentStatus === "FAILED") return "failed";
  if (status.paymentStatus === "AUTHORIZED" || status.status === "PENDING") return "pending";
  return variant;
}

/**
 * [VX2-d2] Copy de cada variante. Sin promesas (§0.2, PL-F1c): no sale ningún email de confirmación, y no se promete
 * cancelación ni recordatorio. Antes la card mostraba `PENDING · UNPAID` y «Reintentos: 12 / 60» (jerga interna): el
 * paciente ve un estado en palabras. TP-3h: vocabulario de §25.10 (seña, pago, reintegro, «Mercado Pago» completo).
 */
export const RESULT_COPY: Record<BookingResultVariant, { title: string; lead: string; state: string }> = {
  ok: {
    title: "¡Turno confirmado!",
    lead: "Abajo tenés los detalles. También lo ves en «Mis turnos».",
    state: "Confirmado",
  },
  paid: {
    title: "¡Turno confirmado!",
    lead: "Recibimos tu pago. Abajo tenés los detalles y el comprobante.",
    state: RESULT_MONEY_COPY.paid,
  },
  deposit: {
    title: "¡Turno confirmado!",
    lead: "Recibimos tu seña. El resto lo pagás en el consultorio.",
    state: RESULT_MONEY_COPY.depositPaid,
  },
  pending: {
    title: "Procesando tu pago…",
    lead: "Apenas Mercado Pago lo confirme, esta pantalla se actualiza sola. No la cierres.",
    state: "Esperando el pago",
  },
  failed: {
    title: "El pago no se completó",
    lead: "El turno no quedó confirmado. Podés volver a reservar y elegir otra forma de pago.",
    state: "Pago no completado",
  },
  "failed-optional": {
    title: "El pago no se completó",
    lead: "No te preocupes: tu turno quedó reservado y lo pagás en el consultorio.",
    state: "Reservado",
  },
  reserved: {
    title: "¡Turno reservado!",
    lead: "Te esperamos. El pago lo hacés en el consultorio.",
    state: "Reservado",
  },
  refunded: {
    title: "Pago reintegrado",
    lead: "Mercado Pago te devolvió el pago de este turno. Si tenés dudas, consultá con el consultorio.",
    state: RESULT_MONEY_COPY.refunded,
  },
};

const DONE: ReadonlySet<BookingResultVariant> = new Set(["ok", "paid", "deposit", "reserved", "failed-optional"]);

/** Cuando el poller se queda sin consultas y Mercado Pago todavía no confirmó. */
export const PENDING_TIMEOUT_NOTE =
  "Mercado Pago todavía no nos confirmó el pago. Actualizá esta página en unos minutos para ver el estado del turno.";

/**
 * Página de resultado después de Mercado Pago (o de reservar sin cobro, TP-0: variante `reserved`, sin poller). Consulta
 * `/api/booking/:id/status` cada 3 s hasta `MAX_POLL_ATTEMPTS` veces o hasta un estado final. TP-3h: sin el botón
 * «Simular webhook PAID» de desarrollo (llamaba a `devMarkBookingPaid`, que TP-3z borra): en local se paga en el MP
 * falso (`MP_CONNECT_MODE=fake`, TP-D21), que manda el webhook de verdad.
 */
export function BookingResult({
  initial,
  variant,
}: {
  initial: PublicBookingStatus;
  variant: BookingResultVariant;
}) {
  const [status, setStatus] = useState(initial);
  const [attempts, setAttempts] = useState(0);
  const effective = effectiveVariantFor(status, variant);

  useEffect(() => {
    // `reserved` también es final: no hay webhook que esperar.
    if (effective !== "pending") return;
    if (attempts >= MAX_POLL_ATTEMPTS) return;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/booking/${initial.bookingId}/status`, { cache: "no-store" });
        if (res.ok) setStatus((await res.json()) as PublicBookingStatus);
      } finally {
        setAttempts((a) => a + 1);
      }
    }, POLL_MS);
    return () => clearTimeout(t);
  }, [attempts, effective, initial.bookingId]);

  const copy = RESULT_COPY[effective];
  const c = status.onlineCharge;
  const timedOut = effective === "pending" && attempts >= MAX_POLL_ATTEMPTS;

  return (
    <BookingFrame clinicName={status.tenantName} topRight={<BookAgainLink slug={status.tenantSlug} />}>
      {/* role=status: el lector de pantalla anuncia el cambio pending → ok/failed que hace el poller. */}
      <div role="status" aria-live="polite">
        <StatusIcon variant={effective} />
        <h1 className={cn("k-display", s.title)}>{copy.title}</h1>
        <p className={s.lead}>{copy.lead}</p>
      </div>

      <dl className={s.details}>
        <DetailRow label="Profesional" value={status.practitionerName} />
        <DetailRow label="Servicio" value={status.serviceName} sub={`${status.durationMin} min`} />
        <DetailRow
          label="Fecha y hora"
          value={new Date(status.scheduledFor).toLocaleString("es-AR", {
            weekday: "long",
            day: "numeric",
            month: "long",
            hour: "2-digit",
            minute: "2-digit",
            // 24 h como el resto del turnero: «08:30 p. m.» se leía raro.
            hourCycle: "h23",
            timeZone: "America/Argentina/Buenos_Aires",
          })}
        />
        <MoneyRows status={status} variant={effective} />
        <div className={s.row}>
          <dt className={s.term}>Estado</dt>
          <dd className={s.value}>
            <Tag
              tone={DONE.has(effective) ? "lime" : effective === "pending" ? "sky" : "soft"}
              variant="outline"
            >
              {copy.state}
            </Tag>
          </dd>
        </div>
        {/* Comprobante resumido (C-TP8: solo con el cobro PAID/REFUNDED). */}
        {c?.receipt && (
          <>
            <DetailRow label={RESULT_MONEY_COPY.operation} value={c.receipt.operationId} />
            <DetailRow label={RESULT_MONEY_COPY.date} value={c.receipt.approvedAtLabel} />
            <DetailRow label={RESULT_MONEY_COPY.method} value={c.receipt.methodLabel} />
          </>
        )}
      </dl>

      {DONE.has(effective) && (
        <div className={s.actions}>
          <ButtonLink href="/portal" size="lg" block>
            Ver mis turnos <IconArrow size={14} />
          </ButtonLink>
        </div>
      )}
      {effective === "failed" && (
        <div className={s.actions}>
          <ButtonLink href={`/c/${status.tenantSlug}/booking`} size="lg" block>
            Volver a reservar <IconArrow size={14} />
          </ButtonLink>
        </div>
      )}
      {timedOut && <p className={s.note}>{PENDING_TIMEOUT_NOTE}</p>}
    </BookingFrame>
  );
}

function StatusIcon({ variant }: { variant: BookingResultVariant }) {
  const done = DONE.has(variant);
  const tone = done ? s.iconOk : variant === "pending" ? s.iconPending : s.iconFailed;
  return (
    <div className={cn(s.icon, tone)} aria-hidden="true">
      {done ? (
        <IconCheck size={28} stroke={3} />
      ) : variant === "pending" ? (
        <IconClock size={28} />
      ) : (
        <IconX size={28} stroke={3} />
      )}
    </div>
  );
}

function DetailRow({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className={s.row}>
      <dt className={s.term}>{label}</dt>
      <dd className={s.value}>
        {value}
        {sub && <span className={s.sub}>{sub}</span>}
      </dd>
    </div>
  );
}

/**
 * Filas de plata. Nunca «$ 0» (H-TP2): sin monto no hay fila.
 *   - seña pagada: la seña y el resto en el consultorio (`remainingCents`, copago − señas: la misma cuenta que la agenda);
 *   - reservado / OPTIONAL rechazado: lo que se paga en el consultorio (con cobro, lo que falta; sin cobro, el precio);
 *   - el resto: el monto del pago (o el legado).
 */
function MoneyRows({ status, variant }: { status: PublicBookingStatus; variant: BookingResultVariant }) {
  const c = status.onlineCharge;
  if (variant === "deposit" && c) {
    return (
      <>
        <DetailRow label={RESULT_MONEY_COPY.depositPaid} value={formatARS(c.amountCents)} />
        {c.remainingCents > 0 && <DetailRow label={RESULT_MONEY_COPY.restAtClinic} value={formatARS(c.remainingCents)} />}
      </>
    );
  }
  if (variant === "reserved" || variant === "failed-optional") {
    const atClinic = c ? c.remainingCents : status.amountCents;
    return atClinic != null && atClinic > 0 ? <DetailRow label="A pagar en el consultorio" value={formatARS(atClinic)} /> : null;
  }
  return status.amountCents != null && status.amountCents > 0 ? (
    <DetailRow label="Monto" value={formatARS(status.amountCents)} />
  ) : null;
}
