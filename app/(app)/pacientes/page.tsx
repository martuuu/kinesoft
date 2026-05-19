import Link from "next/link";
import { listPatients } from "@/lib/patients";
import { Card } from "@/components/ui/card";
import { Avatar } from "@/components/ui/avatar";
import { Tag } from "@/components/ui/tag";
import { IconSearch, IconUsers, IconPlus } from "@/components/ui/icons";
import { NewPatientButton } from "@/components/patients/new-patient-button";

export const metadata = { title: "Pacientes · KineSoft" };
export const dynamic = "force-dynamic";

type SP = { q?: string; filter?: "all" | "active" | "no-program" };

export default async function PacientesPage({ searchParams }: { searchParams: SP }) {
  const q = searchParams.q ?? "";
  const filter = (searchParams.filter ?? "all") as NonNullable<SP["filter"]>;
  const patients = await listPatients({ q, filter });
  const totals = {
    all: patients.length,
    withProgram: patients.filter((p) => p.activeProgramTitle).length,
    withoutProgram: patients.filter((p) => !p.activeProgramTitle).length,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ fontSize: 12, color: "var(--navy-300)", fontWeight: 500 }}>Pacientes</div>
          <h1 className="k-display" style={{ fontSize: 30, margin: "2px 0 0" }}>
            Directorio · <span style={{ color: "var(--sky-700)" }}>{totals.all}</span> pacientes
          </h1>
        </div>
        <NewPatientButton />
      </header>

      <Card glass style={{ padding: 14, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <form action="/pacientes" method="get" style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, minWidth: 240 }}>
          <span style={{ color: "var(--navy-300)" }}>
            <IconSearch size={15} />
          </span>
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Buscar por nombre, email o DNI…"
            style={{
              flex: 1,
              border: "none",
              outline: "none",
              background: "transparent",
              fontSize: 14,
              color: "var(--navy-900)",
            }}
          />
          <input type="hidden" name="filter" value={filter} />
        </form>
        <div style={{ display: "flex", gap: 4, padding: 3, borderRadius: 999, background: "rgba(15,30,51,0.04)" }}>
          {([
            ["all", `Todos · ${totals.all}`],
            ["active", `Con plan · ${totals.withProgram}`],
            ["no-program", `Sin plan · ${totals.withoutProgram}`],
          ] as const).map(([key, label]) => {
            const on = key === filter;
            return (
              <Link
                key={key}
                href={`/pacientes?filter=${key}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
                style={{
                  padding: "6px 12px",
                  borderRadius: 999,
                  fontSize: 12,
                  fontWeight: 600,
                  textDecoration: "none",
                  background: on ? "#fff" : "transparent",
                  color: on ? "var(--navy-900)" : "var(--navy-500)",
                  boxShadow: on ? "0 2px 6px rgba(15,30,51,0.08)" : "none",
                }}
              >
                {label}
              </Link>
            );
          })}
        </div>
      </Card>

      {patients.length === 0 ? (
        <EmptyState />
      ) : (
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <div
            style={{
              padding: "12px 18px",
              display: "grid",
              gridTemplateColumns: "1.6fr 1fr 1.2fr 100px 90px",
              gap: 14,
              fontSize: 10,
              fontWeight: 700,
              color: "var(--navy-300)",
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              borderBottom: "1px solid rgba(15,30,51,0.06)",
            }}
          >
            <span>Paciente</span>
            <span>Plan activo</span>
            <span>Próx. turno</span>
            <span>Última visita</span>
            <span style={{ textAlign: "right" }}>Estado</span>
          </div>
          {patients.map((p) => {
            const initials = `${p.firstName} ${p.lastName}`;
            const tone: "sky" | "lime" | "navy" = p.activeProgramTitle ? "lime" : "sky";
            return (
              <Link
                key={p.id}
                href={`/pacientes/${p.id}`}
                style={{
                  padding: "14px 18px",
                  display: "grid",
                  gridTemplateColumns: "1.6fr 1fr 1.2fr 100px 90px",
                  gap: 14,
                  alignItems: "center",
                  fontSize: 13,
                  textDecoration: "none",
                  color: "inherit",
                  borderBottom: "1px solid rgba(15,30,51,0.04)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <Avatar name={initials} size={36} tone={tone} />
                  <div>
                    <div style={{ fontWeight: 600, color: "var(--navy-900)" }}>
                      {p.lastName}, {p.firstName}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--navy-300)" }}>
                      {p.email ?? p.phone ?? p.documentId ?? "—"}
                    </div>
                  </div>
                </div>
                <div style={{ color: p.activeProgramTitle ? "var(--navy-700)" : "var(--navy-300)" }}>
                  {p.activeProgramTitle ?? "Sin plan asignado"}
                  {p.sessionsTotal > 0 && (
                    <div className="k-mono" style={{ fontSize: 11, color: "var(--sky-700)" }}>
                      {p.sessionsDone} / {p.sessionsTotal}
                    </div>
                  )}
                </div>
                <div style={{ color: "var(--navy-500)" }}>
                  {p.upcomingAt
                    ? p.upcomingAt.toLocaleString("es-AR", {
                        day: "2-digit",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                        timeZone: "America/Argentina/Buenos_Aires",
                      })
                    : "—"}
                </div>
                <div className="k-mono" style={{ fontSize: 12, color: "var(--navy-500)" }}>
                  {p.lastVisit
                    ? p.lastVisit.toLocaleDateString("es-AR", {
                        day: "2-digit",
                        month: "short",
                      })
                    : "—"}
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  {p.activeProgramTitle ? (
                    <Tag tone="lime">Activo</Tag>
                  ) : (
                    <Tag tone="soft">Inactivo</Tag>
                  )}
                </div>
              </Link>
            );
          })}
        </Card>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <Card style={{ padding: 40, textAlign: "center" }}>
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: "50%",
          background: "var(--sky-100)",
          color: "var(--sky-700)",
          margin: "0 auto 12px",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <IconUsers size={26} />
      </div>
      <div className="k-display" style={{ fontSize: 18, fontWeight: 700 }}>
        Todavía no hay pacientes
      </div>
      <p style={{ color: "var(--navy-500)", maxWidth: 360, margin: "8px auto 16px" }}>
        Empezá creando el primero — vas a poder armarle un plan de tratamiento
        y cargar sus sesiones.
      </p>
      <div style={{ display: "inline-flex", gap: 8 }}>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 13,
            color: "var(--sky-700)",
            fontWeight: 600,
          }}
        >
          <IconPlus size={14} /> Usá el botón “Nuevo paciente”
        </span>
      </div>
    </Card>
  );
}
