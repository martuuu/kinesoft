"use client";

import type { BookingStatus } from "@prisma/client";
import { Card } from "@/components/ui/card";
import { Avatar } from "@/components/ui/avatar";
import { Tag } from "@/components/ui/tag";
import { IconCheck } from "@/components/ui/icons";
import { fmtHour, fmtMoney, osLabel, statusPill, type BookingDTO } from "../agenda-utils";

/** Shared column track for the Lista view header + rows (kept in one
 *  place so the two grids never drift): Hora · Paciente · Servicio ·
 *  Obra social · Copago · Duración · Estado. */
const LIST_COLS = "70px 1.4fr 1.2fr 1fr 90px 80px 80px";

export function ListView({
  bookings,
  onEdit,
}: {
  bookings: BookingDTO[];
  onEdit: (b: BookingDTO) => void;
}) {
  if (!bookings.length) {
    return (
      <Card style={{ padding: 28, textAlign: "center", color: "var(--navy-500)" }}>
        No hay turnos para este día.
      </Card>
    );
  }
  return (
    <Card style={{ padding: 0, overflow: "hidden" }}>
      <div
        style={{
          padding: "12px 18px",
          display: "grid",
          gridTemplateColumns: LIST_COLS,
          gap: 14,
          fontSize: 10,
          fontWeight: 700,
          color: "var(--navy-300)",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          borderBottom: "1px solid rgba(15,30,51,0.06)",
        }}
      >
        <span>Hora</span>
        <span>Paciente</span>
        <span>Servicio</span>
        <span>Obra social</span>
        <span>Copago</span>
        <span>Duración</span>
        <span style={{ textAlign: "right" }}>Estado</span>
      </div>
      {bookings.map((b) => {
        const date = new Date(b.scheduledFor);
        return (
          <button
            key={b.id}
            onClick={() => onEdit(b)}
            style={{
              padding: "14px 18px",
              display: "grid",
              gap: 14,
              gridTemplateColumns: LIST_COLS,
              alignItems: "center",
              fontSize: 13,
              width: "100%",
              border: "none",
              background: "transparent",
              borderBottom: "1px solid rgba(15,30,51,0.04)",
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            <div className="k-mono" style={{ fontSize: 13, fontWeight: 700, color: "var(--navy-700)" }}>
              {fmtHour(date)}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Avatar name={b.patientName} size={32} tone="sky" />
              <div>
                <div style={{ fontWeight: 600, color: "var(--navy-900)" }}>{b.patientName}</div>
                {b.patientCondition && (
                  <div style={{ fontSize: 11, color: "var(--navy-300)" }}>{b.patientCondition}</div>
                )}
              </div>
            </div>
            <div style={{ color: "var(--navy-700)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.serviceName}</div>
            <div style={{ color: "var(--navy-500)", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {osLabel(b.obraSocial) || "—"}
            </div>
            <div className="k-mono" style={{ fontSize: 12, color: "var(--navy-700)", fontWeight: 600 }}>
              {fmtMoney(b.copagoCents)}
            </div>
            <div className="k-mono" style={{ fontSize: 12, color: "var(--navy-500)" }}>
              {b.durationMin} min
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <StatusTag s={b.status} />
            </div>
          </button>
        );
      })}
    </Card>
  );
}

export function StatusTag({ s }: { s: BookingStatus }) {
  switch (s) {
    case "CONFIRMED":
      return <Tag tone="sky">Confirmado</Tag>;
    case "COMPLETED":
      return (
        <span style={statusPill("rgba(54,179,126,0.14)", "#1F7A52")}>
          <IconCheck size={10} stroke={3} /> Hecho
        </span>
      );
    case "CANCELLED":
      return <Tag tone="soft">Cancelado</Tag>;
    case "NO_SHOW":
      return <span style={statusPill("rgba(255,176,32,0.18)", "#9A5B00")}>Ausente</span>;
    case "PENDING":
      return <Tag tone="lime">Pendiente</Tag>;
    default: {
      // Exhaustiveness guard: adding a BookingStatus without a branch here
      // fails the build instead of silently rendering nothing / "Pendiente".
      const _exhaustive: never = s;
      return _exhaustive;
    }
  }
}
