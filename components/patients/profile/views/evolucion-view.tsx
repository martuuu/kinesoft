import { Card } from "@/components/ui/card";
import type { PatientWithRelations } from "../types";

export function EvolucionView({ patient }: { patient: PatientWithRelations }) {
  const scores = patient.evaScores;
  return (
    <Card style={{ padding: 24 }}>
      <div className="k-display" style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>
        Evolución · EVA dolor 0-10
      </div>
      {scores.length === 0 ? (
        <p style={{ color: "var(--navy-500)" }}>Aún no hay puntajes registrados.</p>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(80px, 1fr))", gap: 8 }}>
          {scores.map((s) => (
            <div
              key={s.id}
              style={{
                padding: 10,
                borderRadius: 10,
                background: "rgba(246,249,253,0.7)",
                textAlign: "center",
              }}
            >
              <div className="k-mono" style={{ fontSize: 18, fontWeight: 700, color: "var(--sky-700)" }}>
                {s.value}
              </div>
              <div style={{ fontSize: 10, color: "var(--navy-500)" }}>
                {s.takenAt.toLocaleDateString("es-AR", { day: "2-digit", month: "short", timeZone: "America/Argentina/Buenos_Aires" })}
              </div>
              {s.source && (
                <div style={{ fontSize: 9, color: "var(--navy-300)" }}>{s.source}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
