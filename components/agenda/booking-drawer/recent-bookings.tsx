"use client";

import Link from "next/link";
import type { PatientBookingSummary } from "@/lib/patients-types";
import { formatDateAR } from "@/lib/format";
import { toARDateKey } from "@/lib/datetime-ar";
import { sectionCard } from "./styles";

/**
 * "Últimos turnos": los dos turnos más recientes del paciente (sin el abierto),
 * cada uno linkea al día en la agenda. La carga la hace `index.tsx` al abrir.
 * No renderiza nada si la lista viene vacía.
 */
export function RecentBookings({
  recent,
  patientId,
}: {
  recent: PatientBookingSummary[];
  patientId: string | null;
}) {
  if (recent.length === 0) return null;
  return (
    <div style={{ ...sectionCard, display: "grid", gap: 8 }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--navy-300)" }}>
        Últimos turnos
      </div>
      {recent.map((r) => (
        <Link
          key={r.id}
          href={`/agenda?view=timeline&date=${toARDateKey(r.scheduledFor)}`}
          style={{
            display: "block",
            padding: "8px 10px",
            borderRadius: 10,
            background: "#fff",
            border: "1px solid rgba(15,30,51,0.06)",
            textDecoration: "none",
            color: "var(--navy-900)",
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 600 }}>
            {formatDateAR(r.scheduledFor, "weekdayDayMonth")}
            <span style={{ color: "var(--navy-300)", fontWeight: 500 }}> · {r.serviceName}</span>
          </div>
          {(r.title || r.notes) && (
            <div style={{ fontSize: 11, color: "var(--navy-500)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {r.title || r.notes}
            </div>
          )}
        </Link>
      ))}
      {patientId && (
        <Link
          href={`/pacientes/${patientId}`}
          style={{ fontSize: 11.5, fontWeight: 600, color: "var(--sky-700)", textDecoration: "none" }}
        >
          Ver historia clínica completa →
        </Link>
      )}
    </div>
  );
}
