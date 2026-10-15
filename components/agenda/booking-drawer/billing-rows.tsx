"use client";

import { SERVICE_COLOR_FALLBACK } from "@/lib/service-colors";
import { formatARS } from "@/lib/format";
import type { DrawerBooking } from "./types";

/** Obra social name to show, or "" when particular (never prints the
 *  literal "Particular" / "Obra social" words). */
function osLabel(obraSocial: string): string {
  return obraSocial && obraSocial.toLowerCase() !== "particular" ? obraSocial : "";
}

/**
 * C13 "Copago (plan)" (S19d): el turno lo estampó el motor con la cuota de su
 * sesión (`pricedByPlan`, C5: `Session.priceCents` es la fuente y
 * `Booking.copagoCents` su espejo). Ese monto no se edita en el turno: el
 * drawer no tiene editor de copago (`updateBooking` no acepta `copagoCents`) y
 * el precio cambia desde el plan (reprecio, `plans.manage`). Sin C9
 * (`pricedByPlan` ausente) es "Copago" como siempre: no se adivina.
 */
export function copagoLabel(booking: Pick<DrawerBooking, "pricedByPlan">): string {
  return booking.pricedByPlan === true ? "Copago (plan)" : "Copago";
}

export const COPAGO_PLAN_HINT = "Es la cuota de la sesión del plan: se cambia desde el precio del plan.";

/**
 * Filas de detalle del turno: Cuándo, Duración, Servicio, Obra social, Copago,
 * Diagnóstico, Descripción y Notas. Fragmento: el contenedor (y lo que va
 * debajo, como el aviso de acceso básico) lo pone `index.tsx`.
 */
export function BillingRows({ booking }: { booking: DrawerBooking }) {
  return (
    <>
      <Row label="Cuándo">
        {new Date(booking.scheduledFor).toLocaleString("es-AR", {
          weekday: "long",
          day: "2-digit",
          month: "long",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
          timeZone: "America/Argentina/Buenos_Aires",
        })}
      </Row>
      <Row label="Duración">{booking.durationMin} min</Row>
      <Row label="Servicio">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: 999,
              background: booking.serviceColor ?? SERVICE_COLOR_FALLBACK,
              flexShrink: 0,
            }}
          />
          {booking.serviceName}
        </span>
      </Row>
      {osLabel(booking.obraSocial) && (
        <Row label="Obra social">{osLabel(booking.obraSocial)}</Row>
      )}
      {/* `formatARS` (P0-S04b): el drawer tenía su propio `fmtMoney` con
          `toLocaleString`; ahora es el mismo formateo que Lista y semana. */}
      <Row label={copagoLabel(booking)}>
        <span style={{ fontWeight: 700, color: "var(--navy-900)" }}>
          {formatARS(booking.copagoCents)}
        </span>
        {booking.pricedByPlan === true && (
          <span style={{ display: "block", fontSize: 11.5, fontWeight: 500, color: "var(--navy-500)" }}>
            {COPAGO_PLAN_HINT}
          </span>
        )}
      </Row>
      {booking.title && <Row label="Diagnóstico">{booking.title}</Row>}
      {booking.description && <Row label="Descripción">{booking.description}</Row>}
      {booking.notes && <Row label="Notas">{booking.notes}</Row>}
    </>
  );
}

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 10 }}>
      <div
        style={{
          width: 80,
          fontSize: 10.5,
          color: "var(--navy-300)",
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          paddingTop: 2,
        }}
      >
        {label}
      </div>
      <div style={{ flex: 1, color: "var(--navy-900)", fontWeight: 500 }}>{children}</div>
    </div>
  );
}
