import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { PatientWithRelations } from "../types";

/**
 * Pestaña «EVA» (curva de dolor). PF1.1 (D12 de VX0-b): el vacío era una card con «Aún no hay puntajes registrados»
 * y nada más. Ahora ofrece «Registrar EVA», que lleva a Resumen, donde vive la carga (`EvaScoreSide`): no se duplica
 * el formulario. El título dice «EVA» como la pestaña (EV2-D10: «Evolución» chocaba con las evoluciones de HC).
 */
export function EvolucionView({
  patient,
  onRegister,
}: {
  patient: PatientWithRelations;
  /** Lleva a donde se carga el EVA (Resumen). Sin él, el vacío no ofrece acción. */
  onRegister?: () => void;
}) {
  const scores = patient.evaScores;
  return (
    <Card style={{ padding: 24 }}>
      <div className="k-display" style={{ fontSize: 16, fontWeight: 700, marginBottom: 16 }}>
        EVA · dolor de 0 a 10
      </div>
      {scores.length === 0 ? (
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <p style={{ color: "var(--navy-500)", margin: 0 }}>Todavía no hay puntajes de EVA registrados.</p>
          {onRegister && (
            <Button type="button" variant="primary" onClick={onRegister} style={{ fontSize: 12 }}>
              Registrar EVA
            </Button>
          )}
        </div>
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
                <div style={{ fontSize: 10, color: "var(--navy-500)" }}>{s.source}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
