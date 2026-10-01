import Link from "next/link";
import { listOpenSessions } from "@/lib/sessions";
import type { OpenSessionBucket, OpenSessionRow } from "@/lib/sessions-types";
import { Card } from "@/components/ui/card";
import { Avatar } from "@/components/ui/avatar";
import { Tag } from "@/components/ui/tag";
import { IconActivity, IconCheck } from "@/components/ui/icons";

export const metadata = { title: "Seguimiento · KineSoft" };
export const dynamic = "force-dynamic";

export default async function SeguimientoPage() {
  // Los buckets (y el corte del día AR) los arma el servidor: acá solo se
  // renderizan. Ver `listOpenSessions` para el porqué de cada bucket.
  const { overdue, today, upcoming, recent } = await listOpenSessions();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <header>
        <div style={{ fontSize: 12, color: "var(--navy-300)", fontWeight: 500 }}>Seguimiento</div>
        <h1 className="k-display" style={{ fontSize: 30, margin: "2px 0 0" }}>
          Sesiones del plan
        </h1>
      </header>

      {overdue.total > 0 && (
        <Section
          title="Vencidas sin cerrar"
          hint="Sesiones de planes activos con fecha pasada que nunca se cerraron."
          bucket={overdue}
        >
          <SessionList items={overdue.rows} overdue />
        </Section>
      )}
      <Section title="Hoy" bucket={today}>
        <SessionList items={today.rows} emphasize />
      </Section>
      <Section title="Próximas" bucket={upcoming}>
        <SessionList items={upcoming.rows} />
      </Section>
      <Section title="Realizadas · últimos 14 días" bucket={recent}>
        <SessionList items={recent.rows} completed />
      </Section>
    </div>
  );
}

function Section({
  title,
  hint,
  bucket,
  children,
}: {
  title: string;
  hint?: string;
  bucket: OpenSessionBucket;
  children: React.ReactNode;
}) {
  const truncated = bucket.total > bucket.rows.length;
  return (
    <section>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <div>
          <div className="k-display" style={{ fontSize: 16, fontWeight: 700 }}>
            {title}
          </div>
          {hint && <div style={{ fontSize: 11.5, color: "var(--navy-500)" }}>{hint}</div>}
        </div>
        <Tag tone="soft">{truncated ? `${bucket.rows.length} de ${bucket.total}` : bucket.total}</Tag>
      </div>
      {children}
      {truncated && (
        <div style={{ marginTop: 6, fontSize: 11.5, color: "var(--navy-500)" }}>
          Se muestran las primeras {bucket.rows.length}. Las demás están en la pestaña Plan de cada paciente.
        </div>
      )}
    </section>
  );
}

function SessionList({
  items,
  emphasize,
  completed,
  overdue,
}: {
  items: OpenSessionRow[];
  emphasize?: boolean;
  completed?: boolean;
  overdue?: boolean;
}) {
  if (items.length === 0) {
    return (
      <Card style={{ padding: 18, color: "var(--navy-300)", fontSize: 13 }}>
        Nada por acá.
      </Card>
    );
  }
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
        gap: 10,
      }}
    >
      {items.map((s) => (
        <Link
          key={s.id}
          href={`/seguimiento/${s.id}`}
          style={{
            textDecoration: "none",
            color: "inherit",
            padding: 14,
            borderRadius: 14,
            background: emphasize
              ? "linear-gradient(135deg, rgba(31,79,190,0.06), rgba(255,255,255,0.6))"
              : "#fff",
            border: emphasize ? "1px solid rgba(31,79,190,0.2)" : "1px solid rgba(15,30,51,0.06)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Avatar name={s.patientName} size={36} tone={emphasize ? "lime" : "sky"} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--navy-900)" }}>
                {s.patientName}
              </div>
              <div style={{ fontSize: 11, color: "var(--navy-500)" }}>{s.programTitle}</div>
            </div>
            {completed && (
              <Tag tone="soft">
                <IconCheck size={10} stroke={3} /> Hecho
              </Tag>
            )}
            {overdue && <Tag tone="soft">Sin cerrar</Tag>}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              fontSize: 12,
              color: "var(--navy-500)",
            }}
          >
            <span className="k-mono">
              Sesión {s.index} / {s.totalSessions}
            </span>
            <span>
              {s.scheduledFor.toLocaleString("es-AR", {
                day: "2-digit",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
                timeZone: "America/Argentina/Buenos_Aires",
              })}
            </span>
          </div>
          <div
            style={{
              height: 6,
              borderRadius: 3,
              overflow: "hidden",
              background: "rgba(15,30,51,0.06)",
            }}
          >
            <div
              style={{
                width: `${s.exerciseCount ? (s.doneCount / s.exerciseCount) * 100 : 0}%`,
                height: "100%",
                background: "linear-gradient(90deg, var(--sky-500), var(--lime-400))",
              }}
            />
          </div>
          <div className="k-mono" style={{ fontSize: 11, color: "var(--sky-700)" }}>
            <IconActivity size={11} style={{ verticalAlign: -1 }} /> {s.doneCount} / {s.exerciseCount}{" "}
            ejercicios
          </div>
        </Link>
      ))}
    </div>
  );
}
