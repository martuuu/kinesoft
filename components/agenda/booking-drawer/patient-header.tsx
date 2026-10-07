"use client";

import { Avatar } from "@/components/ui/avatar";
import { paymentHoldState } from "@/lib/agenda-filters";
import { StatusTag } from "./status-tag";
import type { DrawerBooking } from "./types";

/**
 * Encabezado del drawer: avatar, nombre y pill de estado.
 *
 * S19c: se fue el subtítulo `patientCondition`. La agenda siempre trae la
 * proyección liviana, donde viene null (`AgendaBookingRow`), así que era código
 * muerto; y en la completa salía del "plan ACTIVE take 1" sin orderBy (plan
 * §3.4): un dato clínico elegido al azar que ahora cubre la fila Plan
 * (`plan-row.tsx`) con el chip, sin título. Mismo retiro que S19a en Lista.
 */
export function PatientHeader({ booking }: { booking: DrawerBooking }) {
  return (
    <div
      style={{
        padding: 14,
        borderRadius: 14,
        background: "rgba(255,255,255,0.6)",
        border: "1px solid rgba(15,30,51,0.06)",
        display: "flex",
        alignItems: "center",
        gap: 12,
      }}
    >
      <Avatar name={booking.patientName} size={44} tone="sky" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: "var(--navy-900)" }}>
          {booking.patientName}
        </div>
      </div>
      <StatusTag s={booking.status} hold={paymentHoldState(booking, new Date())} />
    </div>
  );
}
