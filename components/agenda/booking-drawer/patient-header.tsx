"use client";

import { Avatar } from "@/components/ui/avatar";
import { paymentHoldState } from "@/lib/agenda-filters";
import { StatusTag } from "./status-tag";
import type { DrawerBooking } from "./types";

/** Encabezado del drawer: avatar, nombre, condición y pill de estado. */
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
        {booking.patientCondition && (
          <div style={{ fontSize: 11.5, color: "var(--navy-500)" }}>{booking.patientCondition}</div>
        )}
      </div>
      <StatusTag s={booking.status} hold={paymentHoldState(booking, new Date())} />
    </div>
  );
}
