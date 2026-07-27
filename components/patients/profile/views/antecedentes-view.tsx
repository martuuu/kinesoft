import { Card } from "@/components/ui/card";
import { Detail } from "../ui";
import type { PatientWithRelations } from "../types";

export function AntecedentesView({ patient }: { patient: PatientWithRelations }) {
  return (
    <Card style={{ padding: 18 }}>
      <div className="k-display" style={{ fontSize: 16, fontWeight: 700, marginBottom: 12 }}>
        Antecedentes y contacto
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Detail label="Coberturas">
          {patient.coverages.length ? (
            patient.coverages.map((c) => (
              <div key={c.id} style={{ fontSize: 13 }}>
                {c.insurer} {c.planName ? `· ${c.planName}` : ""}
              </div>
            ))
          ) : (
            <span style={{ fontSize: 12, color: "var(--navy-300)" }}>Sin coberturas cargadas</span>
          )}
        </Detail>
        <Detail label="Contacto de emergencia">
          {patient.emergency.length ? (
            patient.emergency.map((c) => (
              <div key={c.id} style={{ fontSize: 13 }}>
                {c.name} · {c.phone}
              </div>
            ))
          ) : (
            <span style={{ fontSize: 12, color: "var(--navy-300)" }}>No registrado</span>
          )}
        </Detail>
        <Detail label="Notas">
          <span style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>
            {patient.notes ?? "Sin notas"}
          </span>
        </Detail>
        <Detail label="Alta del paciente">
          <span style={{ fontSize: 13 }}>
            {patient.createdAt.toLocaleDateString("es-AR", { dateStyle: "long", timeZone: "America/Argentina/Buenos_Aires" })}
          </span>
        </Detail>
      </div>
    </Card>
  );
}
