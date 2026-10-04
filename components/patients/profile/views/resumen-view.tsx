"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { IconPlus } from "@/components/ui/icons";
import { recordEvaScore } from "@/lib/patients";
import { CreateProgramModal } from "./plan-view";
import type { PatientWithRelations } from "../types";

const STATUS_LABEL: Record<PatientWithRelations["programs"][number]["status"], string> = {
  ACTIVE: "Activo",
  PAUSED: "Pausado",
  COMPLETED: "Completado",
  CANCELLED: "Cancelado",
};

/**
 * P0-S02u-perfil: `program` es el plan en foco (`pickProfilePrograms`): el
 * ACTIVE más reciente o, si no hay, el último plan. Antes un plan terminado se
 * mostraba como si fuera el vigente y "Crear plan" desaparecía; ahora lleva su
 * estado y, sin plan activo, se ofrece crear uno.
 */
export function ResumenView({
  patient,
  program,
  otherActiveCount = 0,
  diagnosisName,
  done,
}: {
  patient: PatientWithRelations;
  program: PatientWithRelations["programs"][number] | null;
  otherActiveCount?: number;
  diagnosisName: string | null;
  done: number;
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const isActive = program?.status === "ACTIVE";
  return (
    <div style={{ display: "grid", gridTemplateColumns: "260px 1fr 320px", gap: 14 }}>
      <Card style={{ padding: 16 }}>
        <div className="k-display" style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>
          Plan
        </div>
        {program && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 13, color: "var(--navy-700)" }}>{program.title}</span>
              {!isActive && <Tag tone="soft">{STATUS_LABEL[program.status]}</Tag>}
            </div>
            <div className="k-mono" style={{ fontSize: 12, color: "var(--sky-700)", marginTop: 4 }}>
              {done} / {program.totalSessions}
            </div>
            <div
              style={{
                height: 6,
                borderRadius: 3,
                background: "rgba(15,30,51,0.06)",
                overflow: "hidden",
                marginTop: 10,
              }}
            >
              <div
                style={{
                  width: `${program.totalSessions ? Math.min((done / program.totalSessions) * 100, 100) : 0}%`,
                  height: "100%",
                  background: isActive
                    ? "linear-gradient(90deg, var(--sky-500), var(--lime-400))"
                    : "var(--navy-300)",
                }}
              />
            </div>
            {isActive && otherActiveCount > 0 && (
              <p style={{ fontSize: 12, color: "var(--navy-500)", margin: "10px 0 0" }}>
                +{otherActiveCount}{" "}
                {otherActiveCount === 1 ? "plan activo más" : "planes activos más"} en el tab Plan.
              </p>
            )}
          </>
        )}
        {!isActive && (
          <>
            <p style={{ fontSize: 12.5, color: "var(--navy-500)", marginTop: program ? 12 : undefined }}>
              {program
                ? "No tiene un plan activo."
                : "Este paciente todavía no tiene un plan de tratamiento."}
            </p>
            <Button variant="primary" onClick={() => setCreating(true)} style={{ width: "100%", justifyContent: "center" }}>
              <IconPlus size={14} /> Crear plan
            </Button>
          </>
        )}
      </Card>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Card style={{ padding: 18 }}>
          <div style={{ fontSize: 10, color: "var(--navy-300)", fontWeight: 700, textTransform: "uppercase" }}>
            Diagnóstico principal
          </div>
          <div className="k-display" style={{ fontSize: 18, fontWeight: 700, marginTop: 4 }}>
            {diagnosisName ?? "Aún no asignado"}
          </div>
        </Card>
        <Card style={{ padding: 18 }}>
          <div className="k-display" style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>
            Notas clínicas
          </div>
          <p style={{ fontSize: 13, color: "var(--navy-700)", margin: 0, whiteSpace: "pre-wrap" }}>
            {patient.notes ?? "Sin notas. Editá el paciente para agregar antecedentes relevantes."}
          </p>
        </Card>
      </div>

      <EvaScoreSide patient={patient} />

      {creating && (
        <CreateProgramModal
          patientId={patient.id}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function EvaScoreSide({ patient }: { patient: PatientWithRelations }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const submit = (formData: FormData) => {
    start(async () => {
      const result = await recordEvaScore({
        patientId: patient.id,
        value: Number(formData.get("value")),
        source: "manual",
      });
      if (result.ok) router.refresh();
    });
  };
  const scores = patient.evaScores;
  const max = 10;
  return (
    <Card glass style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="k-display" style={{ fontSize: 14, fontWeight: 700 }}>
        EVA · dolor
      </div>
      <div style={{ height: 90, position: "relative", padding: "4px 0" }}>
        {scores.length ? (
          <svg viewBox="0 0 100 40" width="100%" height="100%" preserveAspectRatio="none">
            <polyline
              fill="none"
              stroke="var(--sky-700)"
              strokeWidth="1.5"
              points={scores
                .map((s, i) => `${(i / Math.max(scores.length - 1, 1)) * 100},${40 - (s.value / max) * 40}`)
                .join(" ")}
            />
            {scores.map((s, i) => (
              <circle
                key={s.id}
                cx={(i / Math.max(scores.length - 1, 1)) * 100}
                cy={40 - (s.value / max) * 40}
                r="1.6"
                fill="var(--sky-700)"
              />
            ))}
          </svg>
        ) : (
          <div style={{ fontSize: 12, color: "var(--navy-300)", textAlign: "center", paddingTop: 24 }}>
            Sin registros aún
          </div>
        )}
      </div>
      <form action={submit} style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <label style={{ fontSize: 11, color: "var(--navy-500)", fontWeight: 600 }}>EVA hoy</label>
        <input
          name="value"
          type="number"
          min={0}
          max={10}
          defaultValue={4}
          style={{
            width: 56,
            padding: "6px 8px",
            borderRadius: 8,
            border: "1px solid rgba(15,30,51,0.08)",
            fontSize: 13,
            textAlign: "center",
          }}
        />
        <Button type="submit" variant="primary" disabled={pending} style={{ fontSize: 12, padding: "8px 12px" }}>
          {pending ? "…" : "Registrar"}
        </Button>
      </form>
    </Card>
  );
}
