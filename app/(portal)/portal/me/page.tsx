import Link from "next/link";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { getPortalAuth } from "@/lib/portal";

export const dynamic = "force-dynamic";
export const metadata = { title: "Mi cuenta · KineSoft" };

export default async function PortalMe() {
  const auth = await getPortalAuth();
  if (!auth.signedIn) redirect("/portal");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <h1 className="k-display" style={{ fontSize: 26, margin: 0 }}>
        Mi cuenta
      </h1>

      <Card glass style={{ padding: 18 }}>
        <div
          style={{
            fontSize: 11,
            color: "var(--sky-700)",
            fontWeight: 700,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
          }}
        >
          Email
        </div>
        <div style={{ fontSize: 16, fontWeight: 700 }}>{auth.email}</div>
        {auth.fullName && <div style={{ fontSize: 12, color: "var(--navy-500)" }}>{auth.fullName}</div>}
      </Card>

      <Card style={{ padding: 18 }}>
        <div className="k-display" style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>
          Tus consultorios
        </div>
        {auth.patients.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--navy-500)" }}>Ninguno todavía.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {auth.patients.map((p) => (
              <Link
                key={p.id}
                href={`/c/${p.tenantSlug}/booking`}
                style={{
                  padding: "10px 12px",
                  borderRadius: 12,
                  background: "rgba(246,249,253,0.7)",
                  border: "1px solid rgba(15,30,51,0.06)",
                  textDecoration: "none",
                  color: "inherit",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{p.tenantName}</div>
                  <div style={{ fontSize: 11, color: "var(--navy-500)" }}>
                    Ficha: {p.firstName} {p.lastName}
                  </div>
                </div>
                <span style={{ color: "var(--sky-700)", fontSize: 12, fontWeight: 600 }}>
                  Reservar turno →
                </span>
              </Link>
            ))}
          </div>
        )}
      </Card>

      <form action="/api/auth/sign-out?next=/portal" method="post">
        <Button variant="ghost" type="submit" style={{ width: "100%", justifyContent: "center" }}>
          Cerrar sesión
        </Button>
      </form>
    </div>
  );
}
