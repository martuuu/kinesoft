"use client";

import { Card } from "@/components/ui/card";
import { Avatar } from "@/components/ui/avatar";
import { StatusTag } from "@/components/ui/status-tag";
import { SERVICE_COLOR_FALLBACK } from "@/lib/service-colors";
import { paymentHoldState } from "@/lib/agenda-filters";
import { receptionCardBadge } from "@/lib/agenda-client-state";
import { fmtHour, fmtMoney, osLabel, type BookingDTO } from "../agenda-utils";
import { PractitionerBadge } from "../grid/practitioner-badge";

/** Shared column track for the Lista view header + rows (kept in one
 *  place so the two grids never drift): Hora · Paciente · Servicio ·
 *  Obra social · Copago · Duración · Estado. */
const LIST_COLS = "70px 1.4fr 1.2fr 1fr 90px 80px 80px";

/**
 * B4.3: con más de un profesional en pantalla (`practitionerById`), la hora
 * lleva las iniciales del profesional (canal no cromático). Debajo del
 * paciente: "Sobreturno", recepción ("En sala 12′") y telemedicina, en texto.
 * Sin `clinical.read` (`clinicalHidden`) no hay subtítulo clínico.
 */
export function ListView({
  bookings,
  onEdit,
  highlightedServiceId,
  practitionerById = null,
  now,
}: {
  bookings: BookingDTO[];
  onEdit: (b: BookingDTO) => void;
  /** When set, rows of this service lift above the rest (legend "filter"). */
  highlightedServiceId: string | null;
  practitionerById?: Readonly<Record<string, { initials: string; name: string }>> | null;
  now?: Date;
}) {
  const clock = now ?? new Date();
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
        const isHighlighted =
          highlightedServiceId != null && b.serviceId === highlightedServiceId;
        const dimmed =
          highlightedServiceId != null && b.serviceId !== highlightedServiceId;
        // Per-turno diagnosis (title → description), falling back to the
        // program condition — surfaced under the patient name for consistency.
        const sub = b.clinicalHidden ? null : b.title || b.description || b.patientCondition;
        const prac = practitionerById?.[b.practitionerId] ?? null;
        const reception = receptionCardBadge(b, clock);
        const marks = [
          b.isOverbooked ? "Sobreturno" : null,
          reception?.label ?? null,
          b.isTelemedicine ? "Telemedicina" : null,
        ].filter(Boolean);
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
              background: isHighlighted ? "rgba(31,79,190,0.05)" : "transparent",
              borderBottom: "1px solid rgba(15,30,51,0.04)",
              cursor: "pointer",
              textAlign: "left",
              position: "relative",
              zIndex: isHighlighted ? 2 : undefined,
              boxShadow: isHighlighted ? "var(--shadow-card-lg)" : undefined,
              opacity: dimmed ? 0.5 : 1,
              transition: "box-shadow 0.12s ease, opacity 0.12s ease, background 0.12s ease",
            }}
          >
            <div className="k-mono" style={{ fontSize: 13, fontWeight: 700, color: "var(--navy-700)", display: "flex", alignItems: "center", gap: 6 }}>
              {fmtHour(date)}
              {prac && <PractitionerBadge initials={prac.initials} name={prac.name} size={20} />}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Avatar name={b.patientName} size={32} tone="sky" />
              <div>
                <div style={{ fontWeight: 600, color: "var(--navy-900)" }}>{b.patientName}</div>
                {sub && (
                  <div style={{ fontSize: 11, color: "var(--navy-300)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 220 }}>{sub}</div>
                )}
                {marks.length > 0 && (
                  <div style={{ fontSize: 10.5, fontWeight: 700, color: b.isOverbooked ? "#9A5B00" : "var(--navy-500)" }}>
                    {marks.join(" · ")}
                  </div>
                )}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--navy-700)", minWidth: 0 }}>
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 999,
                  background: b.serviceColor ?? SERVICE_COLOR_FALLBACK,
                  flexShrink: 0,
                }}
              />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.serviceName}</span>
            </div>
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
              <StatusTag s={b.status} hold={paymentHoldState(b, clock)} />
            </div>
          </button>
        );
      })}
    </Card>
  );
}

// El pill de estado vive en `components/ui/status-tag.tsx` (P0-S04b: una sola
// paleta `--st-*` para Lista, drawer, perfil y semana). Se re-exporta para no
// romper los imports existentes desde esta vista.
export { StatusTag };
