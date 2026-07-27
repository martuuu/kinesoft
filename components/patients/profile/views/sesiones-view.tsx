import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { IconCheck } from "@/components/ui/icons";
import type { PatientWithRelations } from "../types";

export function SesionesView({
  patient,
  sessions,
}: {
  patient: PatientWithRelations;
  sessions: PatientWithRelations["programs"][number]["sessions"];
}) {
  return (
    <Card style={{ padding: 0, overflow: "hidden" }}>
      <div
        style={{
          padding: "12px 18px",
          display: "grid",
          gridTemplateColumns: "70px 1fr 120px 1fr 90px",
          fontSize: 10,
          fontWeight: 700,
          color: "var(--navy-300)",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          borderBottom: "1px solid rgba(15,30,51,0.06)",
        }}
      >
        <span>#</span>
        <span>Fecha</span>
        <span>Estado</span>
        <span>Notas</span>
        <span style={{ textAlign: "right" }}>Acción</span>
      </div>
      {sessions.length === 0 ? (
        <div style={{ padding: 24, textAlign: "center", color: "var(--navy-500)", fontSize: 13 }}>
          Este paciente todavía no tiene sesiones. Creá un plan desde Resumen.
        </div>
      ) : (
        sessions.map((s) => (
          <SessionRow key={s.id} session={s} patientId={patient.id} />
        ))
      )}
    </Card>
  );
}

function SessionRow({
  session,
}: {
  session: PatientWithRelations["programs"][number]["sessions"][number];
  patientId: string;
}) {
  const completed = !!session.completedAt;
  const exerciseCount = session._count.exercises;
  return (
    <a
      href={`/seguimiento/${session.id}`}
      style={{
        textDecoration: "none",
        color: "inherit",
        padding: "14px 18px",
        display: "grid",
        gridTemplateColumns: "70px 1fr 120px 1fr 110px",
        alignItems: "center",
        gap: 12,
        fontSize: 13,
        borderBottom: "1px solid rgba(15,30,51,0.04)",
        opacity: completed ? 0.85 : 1,
      }}
    >
      <span className="k-mono" style={{ fontWeight: 700, color: "var(--sky-700)" }}>
        {String(session.index).padStart(2, "0")}
      </span>
      <span style={{ color: "var(--navy-700)" }}>
        {session.scheduledFor.toLocaleString("es-AR", {
          day: "2-digit",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
          timeZone: "America/Argentina/Buenos_Aires",
        })}
      </span>
      <span>
        {completed ? (
          <Tag tone="lime">
            <IconCheck size={10} stroke={3} /> Hecho
          </Tag>
        ) : (
          <Tag tone="soft">Programada</Tag>
        )}
      </span>
      <span
        style={{
          color: "var(--navy-500)",
          fontSize: 12,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {session.notes ?? (completed ? "—" : `${exerciseCount} ejercicios asignados`)}
      </span>
      <span
        style={{
          display: "flex",
          justifyContent: "flex-end",
          fontSize: 12,
          fontWeight: 600,
          color: "var(--sky-700)",
        }}
      >
        Editar sesión →
      </span>
    </a>
  );
}
