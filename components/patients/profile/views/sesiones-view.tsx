import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { IconCheck } from "@/components/ui/icons";
import type { PatientWithRelations } from "../types";

type SessionLite = PatientWithRelations["programs"][number]["sessions"][number];

/** Un grupo por plan; lo arma `pickProfilePrograms` (patient-profile.tsx). */
export type SessionGroup = {
  id: string;
  title: string;
  status: PatientWithRelations["programs"][number]["status"];
  sessions: SessionLite[];
};

const STATUS_LABEL: Record<SessionGroup["status"], string> = {
  ACTIVE: "Activo",
  PAUSED: "Pausado",
  COMPLETED: "Completado",
  CANCELLED: "Cancelado",
};

/**
 * P0-S02u-perfil: antes listaba solo las sesiones del primer plan mientras el
 * badge del tab contaba las de todos, y con dos planes activos las del segundo
 * no se veían en ningún lado. Ahora lista todas, agrupadas por plan (el número
 * de sesión reinicia en cada plan, sin el encabezado "03" sería ambiguo). Con un
 * solo plan no hay encabezado: se ve igual que antes.
 */
export function SesionesView({
  patient,
  groups,
}: {
  patient: PatientWithRelations;
  groups: SessionGroup[];
}) {
  const grouped = groups.length > 1;
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
      {groups.length === 0 ? (
        <div style={{ padding: 24, textAlign: "center", color: "var(--navy-500)", fontSize: 13 }}>
          Este paciente todavía no tiene sesiones. Creá un plan desde Resumen.
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.id} aria-label={grouped ? `Sesiones de ${g.title}` : undefined}>
            {grouped && (
              <div
                style={{
                  padding: "10px 18px",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 12,
                  fontWeight: 700,
                  color: "var(--navy-700)",
                  background: "rgba(15,30,51,0.03)",
                  borderBottom: "1px solid rgba(15,30,51,0.06)",
                }}
              >
                <span>{g.title}</span>
                <Tag tone={g.status === "ACTIVE" ? "lime" : "soft"}>{STATUS_LABEL[g.status]}</Tag>
                <span style={{ marginLeft: "auto", fontWeight: 500, color: "var(--navy-500)" }}>
                  {g.sessions.length} {g.sessions.length === 1 ? "sesión" : "sesiones"}
                </span>
              </div>
            )}
            {g.sessions.map((s) => (
              <SessionRow key={s.id} session={s} patientId={patient.id} />
            ))}
          </section>
        ))
      )}
    </Card>
  );
}

function SessionRow({
  session,
}: {
  session: SessionLite;
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
