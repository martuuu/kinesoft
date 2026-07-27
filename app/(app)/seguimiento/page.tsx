import Link from "next/link";
import { listOpenSessions } from "@/lib/sessions";
import { Card } from "@/components/ui/card";
import { Avatar } from "@/components/ui/avatar";
import { Tag } from "@/components/ui/tag";
import { IconActivity, IconCheck } from "@/components/ui/icons";
import { toARDateKey, localToARIso } from "@/lib/datetime-ar";

export const metadata = { title: "Seguimiento · KineSoft" };
export const dynamic = "force-dynamic";

export default async function SeguimientoPage() {
  const sessions = await listOpenSessions();
  // Anchor "today" to the AR business day, not the host tz (UTC on Vercel).
  const todayKey = toARDateKey(new Date());
  const todayStart = new Date(localToARIso(`${todayKey}T00:00:00`));
  const todayEnd = new Date(todayStart.getTime() + 86_400_000);

  const today = sessions.filter(
    (s) => s.scheduledFor >= todayStart && s.scheduledFor < todayEnd && !s.completedAt
  );
  const upcoming = sessions.filter(
    (s) => s.scheduledFor >= todayEnd && !s.completedAt
  );
  const past = sessions.filter((s) => s.completedAt);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <header>
        <div style={{ fontSize: 12, color: "var(--navy-300)", fontWeight: 500 }}>Seguimiento</div>
        <h1 className="k-display" style={{ fontSize: 30, margin: "2px 0 0" }}>
          Sesiones del plan
        </h1>
      </header>

      <Section title="Hoy" count={today.length}>
        <SessionList items={today} emphasize />
      </Section>
      <Section title="Próximas" count={upcoming.length}>
        <SessionList items={upcoming} />
      </Section>
      <Section title="Últimas completadas" count={past.length}>
        <SessionList items={past} completed />
      </Section>
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
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
        <div className="k-display" style={{ fontSize: 16, fontWeight: 700 }}>
          {title}
        </div>
        <Tag tone="soft">{count}</Tag>
      </div>
      {children}
    </section>
  );
}

function SessionList({
  items,
  emphasize,
  completed,
}: {
  items: Awaited<ReturnType<typeof listOpenSessions>>;
  emphasize?: boolean;
  completed?: boolean;
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
