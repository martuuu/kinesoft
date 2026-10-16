"use client";

import { useEffect, useState, useTransition } from "react";
import { Tag } from "@/components/ui/tag";
import { Button, ButtonLink } from "@/components/ui/button";
import { IconArrow, IconCheck, IconClock, IconX } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import { formatARS } from "@/lib/format";
import { devMarkBookingPaid } from "@/lib/public-booking";
import type { PublicBookingStatus } from "@/lib/public-booking-types";
import { BookAgainLink, BookingFrame } from "./booking-unavailable";
import s from "./booking-result.module.css";

export type BookingResultVariant = "ok" | "pending" | "failed";

/** 60 consultas cada 3 s ≈ 3 min: después se deja de consultar y se dice qué hacer, sin prometer nada. */
export const MAX_POLL_ATTEMPTS = 60;
const POLL_MS = 3000;

/**
 * Variante efectiva: el estado real del turno manda sobre la URL (MP vuelve a `/ok` antes de que llegue el webhook, y el
 * poller promueve pending → ok cuando el webhook lo marca PAID).
 */
export function effectiveVariantFor(status: PublicBookingStatus, variant: BookingResultVariant): BookingResultVariant {
  if (status.paymentStatus === "PAID") return "ok";
  if (status.paymentStatus === "FAILED") return "failed";
  if (status.paymentStatus === "AUTHORIZED" || status.status === "PENDING") return "pending";
  return variant;
}

/**
 * [VX2-d2] Copy de cada variante. Sin promesas (§0.2, PL-F1c): no sale ningún email de confirmación, y no se promete
 * cancelación ni recordatorio. Antes la card mostraba `PENDING · UNPAID` y «Reintentos: 12 / 60» (jerga interna): el
 * paciente ve un estado en palabras.
 */
export const RESULT_COPY: Record<BookingResultVariant, { title: string; lead: string; state: string }> = {
  ok: {
    title: "¡Turno confirmado!",
    lead: "Abajo tenés los detalles. También lo ves en «Mis turnos».",
    state: "Confirmado",
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
};

/** Cuando el poller se queda sin consultas y Mercado Pago todavía no confirmó. */
export const PENDING_TIMEOUT_NOTE =
  "Mercado Pago todavía no nos confirmó el pago. Actualizá esta página en unos minutos para ver el estado del turno.";

/**
 * Página de resultado después de Mercado Pago. Consulta `/api/booking/:id/status` cada 3 s hasta
 * `MAX_POLL_ATTEMPTS` veces o hasta un estado final. En desarrollo hay un «Simular webhook PAID»: los webhooks de MP
 * no llegan a localhost.
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
    if (effective === "ok" || effective === "failed") return;
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

  const dev = process.env.NODE_ENV !== "production";
  const copy = RESULT_COPY[effective];
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
        {status.amountCents != null && <DetailRow label="Monto" value={formatARS(status.amountCents)} />}
        <div className={s.row}>
          <dt className={s.term}>Estado</dt>
          <dd className={s.value}>
            <Tag tone={effective === "ok" ? "lime" : effective === "pending" ? "sky" : "soft"} variant="outline">
              {copy.state}
            </Tag>
          </dd>
        </div>
      </dl>

      {effective === "ok" && (
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

      {dev && effective !== "ok" && <DevPaidStub bookingId={status.bookingId} onPaid={setStatus} />}
    </BookingFrame>
  );
}

function StatusIcon({ variant }: { variant: BookingResultVariant }) {
  const tone = variant === "ok" ? s.iconOk : variant === "pending" ? s.iconPending : s.iconFailed;
  return (
    <div className={cn(s.icon, tone)} aria-hidden="true">
      {variant === "ok" ? (
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

function DevPaidStub({
  bookingId,
  onPaid,
}: {
  bookingId: string;
  onPaid: (next: PublicBookingStatus) => void;
}) {
  const [pending, start] = useTransition();
  const click = () =>
    start(async () => {
      await devMarkBookingPaid(bookingId);
      const res = await fetch(`/api/booking/${bookingId}/status`, { cache: "no-store" });
      if (res.ok) onPaid((await res.json()) as PublicBookingStatus);
    });
  return (
    <div className={s.dev}>
      <strong>Solo en desarrollo</strong>: los webhooks de Mercado Pago no llegan a localhost.
      <Button type="button" variant="dark" size="sm" block onClick={click} disabled={pending} style={{ marginTop: 8 }}>
        {pending ? "Simulando…" : "Simular webhook PAID"}
      </Button>
    </div>
  );
}
