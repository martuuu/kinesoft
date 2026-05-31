"use client";

/**
 * Rendered for practitioners with BASIC access to a patient — i.e. they
 * are not the owner, haven't been explicitly shared into, and the
 * tenant isn't in shared-view mode. Shows the bare minimum needed to
 * coordinate (name + DNI + next appointment) and an affordance to ask
 * the owner for access.
 *
 * No PHI fields, no plan, no clinical history.
 */
import { Card } from "@/components/ui/card";
import { Avatar } from "@/components/ui/avatar";
import { Tag } from "@/components/ui/tag";

export function PatientBasicView({
  patient,
}: {
  patient: {
    id: string;
    firstName: string;
    lastName: string;
    documentId: string | null;
    nextBookingAt: Date | null;
  };
}) {
  const fullName = `${patient.firstName} ${patient.lastName}`;
  return (
    <Card glass style={{ padding: 28 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 18 }}>
        <Avatar name={fullName} size={56} tone="sky" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, color: "var(--navy-300)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>
            Paciente del consultorio
          </div>
          <div className="k-display" style={{ fontSize: 22, fontWeight: 700, marginTop: 2 }}>
            {fullName}
          </div>
          {patient.documentId && (
            <div style={{ fontSize: 12.5, color: "var(--navy-500)", marginTop: 2 }}>
              DNI {patient.documentId}
            </div>
          )}
        </div>
        <Tag tone="soft">Sin acceso</Tag>
      </div>

      <div
        style={{
          padding: 14,
          borderRadius: 12,
          background: "rgba(246,249,253,0.7)",
          border: "1px solid rgba(15,30,51,0.06)",
          marginBottom: 18,
        }}
      >
        <div style={{ fontSize: 10, color: "var(--navy-300)", fontWeight: 700, textTransform: "uppercase" }}>
          Próximo turno
        </div>
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--navy-900)", marginTop: 4 }}>
          {patient.nextBookingAt
            ? patient.nextBookingAt.toLocaleString("es-AR", {
                weekday: "long",
                day: "2-digit",
                month: "long",
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
                timeZone: "America/Argentina/Buenos_Aires",
              })
            : "Sin turnos agendados"}
        </div>
      </div>

      <p style={{ fontSize: 13, color: "var(--navy-700)", lineHeight: 1.5, margin: 0 }}>
        Este paciente está asignado a otro kinesiólogo del consultorio. Para
        ver su historia clínica, plan de tratamiento o evolución, pedile al
        responsable que use el botón <strong>Compartir</strong> desde el
        perfil del paciente.
      </p>
    </Card>
  );
}
