"use client";

import { SERVICE_COLOR_FALLBACK } from "@/lib/service-colors";
import type { DrawerBooking } from "./types";

/**
 * Cents → "$1.234" (AR pesos, no decimals).
 *
 * Ojo: no es el `fmtMoney` de `agenda-utils` (ese va por `formatARS`); se deja el
 * del drawer tal cual para no cambiar lo que se ve en esta pasada de refactor.
 */
function fmtMoney(cents: number) {
  return (cents / 100).toLocaleString("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

/** Obra social name to show, or "" when particular (never prints the
 *  literal "Particular" / "Obra social" words). */
function osLabel(obraSocial: string): string {
  return obraSocial && obraSocial.toLowerCase() !== "particular" ? obraSocial : "";
}

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
          hour12: false,
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
      <Row label="Copago">
        <span style={{ fontWeight: 700, color: "var(--navy-900)" }}>
          {fmtMoney(booking.copagoCents)}
        </span>
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
