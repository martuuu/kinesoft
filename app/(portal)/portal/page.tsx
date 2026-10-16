import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { GoogleIcon } from "@/components/ui/brand-icons";
import { IconCal, IconCheck, IconHeart } from "@/components/ui/icons";
import { getPortalAuth } from "@/lib/portal";
import { PORTAL_HOME, portalPatientCardCopy, portalPlanProgress } from "@/lib/portal-copy";
import type { PortalPatient } from "@/lib/portal-types";
import { PortalEmailForm } from "./portal-email-form";

export const dynamic = "force-dynamic";

/** `?c=<slug>`: viene del CTA de `/portal/c/<slug>` sin sesión; el link (Google o email) vuelve a ese consultorio. */
function slugParam(raw: string | string[] | undefined): string | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v && /^[a-z0-9-]{1,64}$/.test(v) ? v : null;
}

export default async function PortalHome({
  searchParams,
}: {
  searchParams?: { [k: string]: string | string[] | undefined };
}) {
  const auth = await getPortalAuth();

  if (!auth.signedIn) {
    return <PortalSignIn slug={slugParam(searchParams?.c)} />;
  }

  if (auth.patients.length === 0) {
    return <NoLinkedPatient email={auth.email} />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <header>
        <Tag tone="lime">Hola{auth.fullName ? `, ${auth.fullName.split(" ")[0]}` : ""}</Tag>
        <h1 className="k-display" style={{ fontSize: 28, margin: "10px 0 4px", letterSpacing: "-0.02em" }}>
          {PORTAL_HOME.title}
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
  // VX2-f: copy por vertical de ESTA ficha (lib/portal-copy.ts): «sesiones» y «sin plan» solo en Kinesiología.
  const copy = portalPatientCardCopy(p.tenantVertical);
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
              {copy.planLabel}
            </div>
            <span style={{ fontSize: 12, color: "var(--sky-700)", fontWeight: 700 }}>
              {copy.planCta} →
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
            {portalPlanProgress(p.tenantVertical, program.completedSessions, program.totalSessions)}
          </div>
        </Link>
      ) : copy.noPlan ? (
        <div style={{ fontSize: 13, color: "var(--navy-500)" }}>{copy.noPlan}</div>
      ) : null}

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
          {PORTAL_HOME.upcomingTitle}
        </div>
        {p.upcoming.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--navy-500)" }}>
            {PORTAL_HOME.noUpcoming}{" "}
            <Link href={`/c/${p.tenantSlug}/booking`} className="k-link">
              {PORTAL_HOME.bookCta} →
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
                  <div style={{ fontSize: 12, color: "var(--navy-500)" }}>
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

function PortalSignIn({ slug }: { slug: string | null }) {
  // IAM-3c: además de Google, «Entrar con tu email» (magic link propio; IAM-D5). El `next` de Google vuelve
  // al consultorio del CTA si vino con `?c=`.
  // VX2-f (D-VX28): copy neutral (sin saber el consultorio no se sabe la vertical: nada de «recuperación» ni «la
  // evolución de tu dolor», que solo vale en Kinesiología) y el botón de Google con la primitiva de auth
  // (`.k-btn-social` + `GoogleIcon`, la misma del login). La ruta `/api/auth/google` no cambia.
  const next = slug ? `/portal/c/${slug}` : "/portal";
  return (
    <Card glass style={{ padding: "clamp(20px, 5vw, 32px)", display: "flex", flexDirection: "column", gap: 16 }}>
      <div
        aria-hidden
        style={{
          width: 56,
          height: 56,
          borderRadius: 16,
          margin: "0 auto",
          background: "linear-gradient(135deg, var(--sky-400), var(--sky-700))",
          color: "#fff",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <IconHeart size={26} />
      </div>
      <div style={{ textAlign: "center", display: "grid", gap: 6 }}>
        <h1 className="k-display" style={{ fontSize: 26, margin: 0, letterSpacing: "-0.02em" }}>
          {PORTAL_HOME.title}
        </h1>
        <p style={{ fontSize: 15, color: "var(--navy-500)", margin: 0 }}>{PORTAL_HOME.signInLead}</p>
      </div>
      <form action={`/api/auth/google?next=${encodeURIComponent(next)}`} method="post">
        <button type="submit" className="k-btn-social">
          <GoogleIcon />
          Continuar con Google
        </button>
      </form>
      <div className="k-divider">o con tu email</div>
      <PortalEmailForm slug={slug} />
      <p className="k-hint" style={{ margin: 0, textAlign: "center" }}>
        {PORTAL_HOME.signInFootnote}
      </p>
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
        {/* EV1-C2: sin ficha vinculada no sabemos de qué consultorio viene (puede ser de Clínica general):
            «tu consultorio» vale para las dos verticales. */}
        Pedile a tu consultorio que cargue tu email exacto en tu ficha clínica, o sacá tu primer
        turno y nosotros la creamos.
      </p>
    </Card>
  );
}
