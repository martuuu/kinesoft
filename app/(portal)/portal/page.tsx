import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { SocialButtons } from "@/components/auth/social-buttons";
import { IconCal, IconCheck, IconHeart } from "@/components/ui/icons";
import { getPortalAuth, searchMyPortalPatients } from "@/lib/portal";
import { loginErrorMessage } from "@/components/screens/auth-feedback";
import { greetingFirstName } from "@/lib/display-name";
import { visibleOAuthProviders } from "@/lib/oauth-providers-public";
import {
  PORTAL_HOME,
  PORTAL_SEARCH,
  portalLinkedCount,
  portalNoLinkCopy,
  portalPatientCardCopy,
  portalPlanProgress,
  type PortalSearchOutcome,
} from "@/lib/portal-copy";
import type { PortalPatient } from "@/lib/portal-types";
import { PortalTabs } from "@/components/portal/portal-tabs";
import { PortalEmailForm } from "./portal-email-form";

export const dynamic = "force-dynamic";

/** `?c=<slug>`: viene del CTA de `/portal/c/<slug>` sin sesión; el link (Google o email) vuelve a ese consultorio. */
function slugParam(raw: string | string[] | undefined): string | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v && /^[a-z0-9-]{1,64}$/.test(v) ? v : null;
}

/** `?buscar=`: resultado de «Buscar mis fichas» (solo los tres códigos conocidos; nunca texto libre). */
function searchParam(raw: string | string[] | undefined): PortalSearchOutcome | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v === "ok" || v === "nada" || v === "limite" ? v : null;
}

/**
 * ES4-D2 (ES4-Z b1): form POST (anda sin JS) que corre el auto-vínculo del login sin salir y volver a entrar.
 */
function SearchMyPatients({ outcome }: { outcome: PortalSearchOutcome | null }) {
  return (
    <form action={searchMyPortalPatients} style={{ display: "grid", gap: 6, justifyItems: "start" }}>
      {outcome && (
        <p role="status" style={{ margin: 0, fontSize: 13, color: outcome === "ok" ? "var(--sky-700)" : "var(--navy-500)" }}>
          {PORTAL_SEARCH[outcome]}
        </p>
      )}
      <button type="submit" className="k-link" style={{ background: "none", border: 0, padding: 0, minHeight: 44, cursor: "pointer", font: "inherit", fontSize: 14 }}>
        {PORTAL_SEARCH.cta}
      </button>
    </form>
  );
}

export default async function PortalHome({
  searchParams,
}: {
  searchParams?: { [k: string]: string | string[] | undefined };
}) {
  const auth = await getPortalAuth();

  if (!auth.signedIn) {
    // VX-Z (D-VX16): Google apagado en Supabase no se ofrece (antes el botón terminaba en `provider_disabled`).
    const google = (await visibleOAuthProviders()).includes("google");
    const rawError = searchParams?.error;
    const error = loginErrorMessage(Array.isArray(rawError) ? rawError[0] : rawError);
    return <PortalSignIn slug={slugParam(searchParams?.c)} google={google} error={error} />;
  }

  const searched = searchParam(searchParams?.buscar);
  if (auth.patients.length === 0) {
    return <NoLinkedPatient email={auth.email} searched={searched} />;
  }
  const firstName = greetingFirstName(auth.fullName);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <header>
        <Tag tone="lime">Hola{firstName ? `, ${firstName}` : ""}</Tag>
        <h1 className="k-display" style={{ fontSize: 28, margin: "10px 0 4px", letterSpacing: "-0.02em" }}>
          {PORTAL_HOME.title}
        </h1>
        <p style={{ fontSize: 14, color: "var(--navy-500)", margin: 0 }}>
          {/* S24a: el portal muestra las fichas VINCULADAS a la cuenta (no las que coinciden por email). */}
          {portalLinkedCount(auth.patients.length)}
        </p>
      </header>

      {auth.patients.map((p) => (
        <PatientCard key={p.id} p={p} />
      ))}

      <SearchMyPatients outcome={searched} />
    </div>
  );
}

function PatientCard({ p }: { p: PortalPatient }) {
  const program = p.programs[0];
  // VX2-f: copy por vertical de ESTA ficha (lib/portal-copy.ts): «sesiones» y «sin plan» solo en Kinesiología.
  const copy = portalPatientCardCopy(p.tenantVertical);
  // ES4 S24: lo que se ofrece sale de las secciones de la ficha (portalSectionsFor): «sin plan» solo si el consultorio
  // usa planes, «Sacar un turno» solo con el turnero abierto (antes se ofrecía siempre y terminaba en un turnero
  // cerrado).
  const usesPlans = p.sections.includes("plan");
  const canBook = p.sections.includes("reservar");
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
      ) : usesPlans && copy.noPlan ? (
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
            {PORTAL_HOME.noUpcoming}
            {canBook && (
              <>
                {" "}
                <Link href={`/c/${encodeURIComponent(p.tenantSlug)}/booking`} className="k-link">
                  {PORTAL_HOME.bookCta} →
                </Link>
              </>
            )}
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
                {b.confirmed ? (
                  <Tag tone="lime">
                    <IconCheck size={10} stroke={3} /> Confirmado
                  </Tag>
                ) : (
                  <Tag tone="soft">A confirmar</Tag>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ES4 S24: las secciones del consultorio (Tu plan / Tu consultorio, Ejercicios, Estado de cuenta, Sacar un
          turno). En General sin plan era la única forma de llegar a /portal/c/<slug>. */}
      <PortalTabs slug={p.tenantSlug} sections={p.sections} />
    </Card>
  );
}

function PortalSignIn({ slug, google, error }: { slug: string | null; google: boolean; error: string | null }) {
  // IAM-3c: además de Google, «Entrar con tu email» (magic link propio; IAM-D5). El `next` de Google vuelve
  // al consultorio del CTA si vino con `?c=`.
  // VX2-f (D-VX28): copy neutral (sin saber el consultorio no se sabe la vertical: nada de «recuperación» ni «la
  // evolución de tu dolor», que solo vale en Kinesiología) y el botón de Google con la primitiva de auth
  // (`.k-btn-social` + `GoogleIcon`, la misma del login).
  // VX-Z: `SocialButtons` (la misma primitiva del login) postea a la ruta canónica `/api/auth/oauth/google` (C-PL12) en
  // vez del alias viejo `/api/auth/google`; solo Google (IAM-D5: el portal no ofrece Facebook) y solo si está prendido.
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
      {/* ES4-Z (b): el callback de Google con destino en el portal vuelve acá con `?error=<código>` (antes, al login
          del equipo). `loginErrorMessage` da el copy del login (genérico para un código desconocido; nunca el texto crudo). */}
      {error && (
        <div role="alert" className="k-alert">
          {error}
        </div>
      )}
      {google && (
        <>
          <SocialButtons providers={["google"]} next={next} />
          <div className="k-divider">o con tu email</div>
        </>
      )}
      <PortalEmailForm slug={slug} />
      <p className="k-hint" style={{ margin: 0, textAlign: "center" }}>
        {PORTAL_HOME.signInFootnote}
      </p>
    </Card>
  );
}

function NoLinkedPatient({ email, searched }: { email: string; searched: PortalSearchOutcome | null }) {
  // EV1-C2: sin ficha vinculada no sabemos de qué consultorio viene (puede ser de Clínica general): «tu consultorio»
  // vale para las dos verticales. ES4 S24: el camino es la invitación (PD-15), no «cargá tu email exacto».
  const copy = portalNoLinkCopy(email);
  return (
    <Card glass style={{ padding: 24, display: "flex", flexDirection: "column", gap: 12 }}>
      <Tag tone="soft">{copy.tag}</Tag>
      <h1 className="k-display" style={{ fontSize: 22, margin: 0 }}>
        {copy.title}
      </h1>
      <p style={{ fontSize: 14, color: "var(--navy-500)", margin: 0 }}>{copy.text}</p>
      <SearchMyPatients outcome={searched} />
    </Card>
  );
}
