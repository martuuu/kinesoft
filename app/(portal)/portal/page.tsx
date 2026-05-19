import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { Button } from "@/components/ui/button";
import { IconArrow, IconCal, IconCheck, IconHeart } from "@/components/ui/icons";
import { getPortalAuth } from "@/lib/portal";
import type { PortalPatient } from "@/lib/portal-types";

export const dynamic = "force-dynamic";

export default async function PortalHome() {
  const auth = await getPortalAuth();

  if (!auth.signedIn) {
    return <PortalSignIn />;
  }

  if (auth.patients.length === 0) {
    return <NoLinkedPatient email={auth.email} />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <header>
        <Tag tone="lime">Hola{auth.fullName ? `, ${auth.fullName.split(" ")[0]}` : ""}</Tag>
        <h1 className="k-display" style={{ fontSize: 28, margin: "10px 0 4px", letterSpacing: "-0.02em" }}>
          Tu recuperación, en un solo lugar
        </h1>
        <p style={{ fontSize: 14, color: "var(--navy-500)", margin: 0 }}>
          Vemos {auth.patients.length === 1 ? "tu ficha" : `${auth.patients.length} fichas`} vinculadas a tu email.
        </p>
      </header>

      {auth.patients.map((p) => (
        <PatientCard key={p.id} p={p} />
      ))}
    </div>
  );
}

function PatientCard({ p }: { p: PortalPatient }) {
  const program = p.programs[0];
  return (
    <Card glass style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div>
          <div
            style={{
              fontSize: 11,
              color: "var(--sky-700)",
              fontWeight: 700,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
            }}
          >
            {p.tenantName}
          </div>
          <div className="k-display" style={{ fontSize: 20, fontWeight: 700 }}>
            {p.firstName} {p.lastName}
          </div>
        </div>
        <span
          style={{
            width: 44,
            height: 44,
            borderRadius: "50%",
            background: "linear-gradient(135deg, var(--sky-400), var(--sky-600))",
            color: "#fff",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <IconHeart size={20} />
        </span>
      </div>

      {program ? (
        <Link
          href={`/portal/c/${p.tenantSlug}`}
          style={{
            padding: 14,
            borderRadius: 14,
            background: "rgba(246,249,253,0.7)",
            border: "1px solid rgba(15,30,51,0.06)",
            textDecoration: "none",
            color: "inherit",
            display: "block",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <div style={{ fontSize: 12, color: "var(--navy-300)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Tu plan
            </div>
            <span style={{ fontSize: 11, color: "var(--sky-700)", fontWeight: 700 }}>
              Ver timeline →
            </span>
          </div>
          <div style={{ fontSize: 14, fontWeight: 700, marginTop: 4 }}>{program.title}</div>
          <div
            style={{
              marginTop: 10,
              height: 6,
              borderRadius: 3,
              background: "rgba(15,30,51,0.06)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${(program.completedSessions / Math.max(program.totalSessions, 1)) * 100}%`,
                height: "100%",
                background: "linear-gradient(90deg, var(--sky-500), var(--lime-400))",
              }}
            />
          </div>
          <div
            className="k-mono"
            style={{ marginTop: 8, fontSize: 12, color: "var(--sky-700)", fontWeight: 700 }}
          >
            {program.completedSessions} / {program.totalSessions} sesiones
          </div>
        </Link>
      ) : (
        <div style={{ fontSize: 13, color: "var(--navy-500)" }}>
          Todavía no tenés un plan de tratamiento activo en este centro.
        </div>
      )}

      <div>
        <div
          style={{
            fontSize: 12,
            color: "var(--navy-300)",
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            marginBottom: 8,
          }}
        >
          Próximos turnos
        </div>
        {p.upcoming.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--navy-500)" }}>
            No tenés turnos próximos.{" "}
            <Link
              href={`/c/${p.tenantSlug}/booking`}
              style={{ color: "var(--sky-700)", fontWeight: 600 }}
            >
              Sacar uno →
            </Link>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {p.upcoming.map((b) => (
              <div
                key={b.id}
                style={{
                  padding: 12,
                  borderRadius: 12,
                  background: "rgba(255,255,255,0.6)",
                  border: "1px solid rgba(15,30,51,0.06)",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <span
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 10,
                    background: "var(--sky-100)",
                    color: "var(--sky-700)",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <IconCal size={16} />
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>
                    {b.scheduledFor.toLocaleString("es-AR", {
                      weekday: "long",
                      day: "2-digit",
                      month: "long",
                      hour: "2-digit",
                      minute: "2-digit",
                      timeZone: "America/Argentina/Buenos_Aires",
                    })}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--navy-500)" }}>
                    {b.serviceName} · {b.practitionerName} · {b.durationMin} min
                  </div>
                </div>
                <Tag tone="lime">
                  <IconCheck size={10} stroke={3} /> Confirmado
                </Tag>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

function PortalSignIn() {
  return (
    <Card glass style={{ padding: 32, textAlign: "center", display: "flex", flexDirection: "column", gap: 16 }}>
      <div
        style={{
          width: 64,
          height: 64,
          borderRadius: 18,
          margin: "0 auto",
          background: "linear-gradient(135deg, var(--sky-400), var(--sky-700))",
          color: "#fff",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <IconHeart size={28} />
      </div>
      <h1 className="k-display" style={{ fontSize: 26, margin: 0, letterSpacing: "-0.02em" }}>
        Tu recuperación al alcance de un toque
      </h1>
      <p style={{ fontSize: 14, color: "var(--navy-500)", margin: 0 }}>
        Ingresá con Google para ver tus próximos turnos, el plan de tratamiento y la evolución de tu dolor.
      </p>
      <form action="/api/auth/google?next=/portal" method="post">
        <Button
          variant="primary"
          type="submit"
          style={{ width: "100%", justifyContent: "center", padding: "14px 18px", fontSize: 14 }}
        >
          <span style={{ fontWeight: 700, color: "#FFFFFF" }}>G</span> Ingresar con Google{" "}
          <IconArrow size={14} />
        </Button>
      </form>
      <div style={{ fontSize: 11, color: "var(--navy-300)" }}>
        Usamos tu email para vincularte con tu ficha clínica. Nada se publica.
      </div>
    </Card>
  );
}

function NoLinkedPatient({ email }: { email: string }) {
  return (
    <Card glass style={{ padding: 24, display: "flex", flexDirection: "column", gap: 12 }}>
      <Tag tone="soft">Sin fichas vinculadas</Tag>
      <h1 className="k-display" style={{ fontSize: 22, margin: 0 }}>
        No encontramos una ficha asociada a {email}
      </h1>
      <p style={{ fontSize: 14, color: "var(--navy-500)", margin: 0 }}>
        Pedile a tu kinesiólogo/a que cargue tu email exacto en tu ficha clínica, o sacá tu primer
        turno y nosotros la creamos.
      </p>
    </Card>
  );
}
