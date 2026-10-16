import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { getPortalAuth, getPortalPlan } from "@/lib/portal";
import { resolveSlugAlias } from "@/lib/public-booking-internal";
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { ButtonLink } from "@/components/ui/button";
import { IconArrow, IconCheck } from "@/components/ui/icons";
import { PortalCheckInForm } from "@/components/portal/check-in-form";
import { BRAND_NAME } from "@/lib/brand";
import {
  portalCheckInCopy,
  portalNextSessionLabel,
  portalNoPlanCopy,
  portalPlanProgress,
  portalSessionLabel,
  portalTenantHeader,
} from "@/lib/portal-copy";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: { slug: string } }) {
  // VX2-f: «Mi plan» no vale para Clínica general (no tiene planes) y acá no se lee la vertical (sería una query más).
  return { title: `${params.slug} · Mi portal · ${BRAND_NAME}` };
}

/*
 * EV1-C2: el copy depende de la vertical del consultorio de la ficha (`PortalPatient.tenantVertical`, de
 * `getPortalAuth`): Clínica general no tiene planes (lib/tenant-modules.ts), así que «tu plan / cuando tu kinesiólogo
 * lo arme» le promete algo que no existe. VX2-f lo movió a `lib/portal-copy.ts` (puro, testeado, punto de extensión
 * de ES4), que además deja «sesión» solo para Kinesiología.
 */

export default async function PortalTenantPage({ params }: { params: { slug: string } }) {
  const auth = await getPortalAuth();
  if (!auth.signedIn) {
    return (
      <Card glass style={{ padding: 22, display: "grid", gap: 12, justifyItems: "start" }}>
        {/* VX2-f: sin sesión no se sabe la vertical → copy neutral («tu plan» no vale para Clínica general). */}
        <p style={{ fontSize: 15, color: "var(--navy-500)", margin: 0 }}>
          Iniciá sesión para ver tus turnos y tu tratamiento.
        </p>
        {/* IAM-3c: `?c=` hace que Google o el link por email vuelvan a este consultorio. VX2-f: `ButtonLink` en vez
            de un Link que envolvía un Button (interactivo anidado, ratchet de ui-ratchets). */}
        <ButtonLink href={`/portal?c=${encodeURIComponent(params.slug)}`} variant="primary" size="md">
          Entrar con Google o con tu email <IconArrow size={14} />
        </ButtonLink>
      </Card>
    );
  }
  const me = auth.patients.find((p) => p.tenantSlug === params.slug);
  if (!me) {
    // BO2-D (BO-D9): slug viejo (el consultorio cambió de slug) → 308 al vigente, misma regla que el turnero. Solo
    // se mira el alias cuando no hay match (cero queries en el camino normal) y solo se redirige si el paciente es
    // de ese consultorio: a cualquier otro, el mismo 404 de siempre.
    const moved = await resolveSlugAlias(params.slug);
    if (moved && auth.patients.some((p) => p.tenantSlug === moved.slug)) {
      permanentRedirect(`/portal/c/${encodeURIComponent(moved.slug)}`);
    }
    notFound();
  }
  const vertical = me.tenantVertical;
  const plan = await getPortalPlan(params.slug);
  const header = portalTenantHeader({ vertical, hasPlan: !!plan, firstName: me.firstName });
  const noPlan = portalNoPlanCopy(vertical);
  const now = Date.now();
  const nextSession = plan?.sessions.find(
    (s) => !s.completedAt && new Date(s.scheduledFor).getTime() >= now - 60_000
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Link
        href="/portal"
        className="k-link"
        style={{ fontSize: 14, display: "inline-flex", alignItems: "center", minHeight: 44, alignSelf: "flex-start" }}
      >
        ← Mis consultorios
      </Link>

      <header>
        <Tag tone="lime">{me.tenantName}</Tag>
        <h1 className="k-display" style={{ fontSize: 26, margin: "10px 0 4px", letterSpacing: "-0.02em" }}>
          {header.title}
        </h1>
        <p style={{ fontSize: 14, color: "var(--navy-500)", margin: 0 }}>{header.lead}</p>
      </header>

      {!plan ? (
        <Card glass style={{ padding: 22 }}>
          <p style={{ fontSize: 14, color: "var(--navy-500)", margin: 0 }}>
            {noPlan.linkToHome ? (
              <>
                {noPlan.text}{" "}
                <Link href="/portal" className="k-link">
                  Mis consultorios
                </Link>
                .
              </>
            ) : (
              noPlan.text
            )}
          </p>
        </Card>
      ) : (
        <>
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
              Plan en curso
            </div>
            <div className="k-display" style={{ fontSize: 18, fontWeight: 700, marginTop: 4 }}>
              {plan.title}
            </div>
            <div
              style={{
                marginTop: 10,
                height: 8,
                borderRadius: 4,
                background: "rgba(15,30,51,0.06)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${(plan.completedSessions / Math.max(plan.totalSessions, 1)) * 100}%`,
                  height: "100%",
                  background: "linear-gradient(90deg, var(--sky-500), var(--lime-400))",
                }}
              />
            </div>
            <div
              className="k-mono"
              style={{ marginTop: 8, fontSize: 13, fontWeight: 700, color: "var(--sky-700)" }}
            >
              {portalPlanProgress(vertical, plan.completedSessions, plan.totalSessions)}
            </div>
          </Card>

          {nextSession && (
            <Card style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--navy-300)",
                    fontWeight: 700,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                  }}
                >
                  {portalNextSessionLabel(vertical, nextSession.index)}
                </div>
                <div style={{ fontSize: 15, fontWeight: 700, marginTop: 4 }}>
                  {new Date(nextSession.scheduledFor).toLocaleString("es-AR", {
                    weekday: "long",
                    day: "2-digit",
                    month: "long",
                    hour: "2-digit",
                    minute: "2-digit",
                    timeZone: "America/Argentina/Buenos_Aires",
                  })}
                </div>
              </div>
              {nextSession.hasCheckIn ? (
                <Tag tone="lime">
                  <IconCheck size={11} stroke={3} /> {portalCheckInCopy(vertical).done}
                </Tag>
              ) : (
                <PortalCheckInForm slug={params.slug} sessionId={nextSession.id} vertical={vertical} />
              )}
            </Card>
          )}

          <Card style={{ padding: 0, overflow: "hidden" }}>
            <div
              style={{
                padding: "12px 16px",
                fontSize: 11,
                fontWeight: 700,
                color: "var(--navy-300)",
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                borderBottom: "1px solid rgba(15,30,51,0.06)",
              }}
            >
              {/* VX2-f: «Timeline» era jerga; es la lista de citas del plan. */}
              Recorrido del plan
            </div>
            {plan.sessions.map((s) => {
              const done = !!s.completedAt;
              return (
                <div
                  key={s.id}
                  style={{
                    padding: "12px 16px",
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    borderBottom: "1px solid rgba(15,30,51,0.04)",
                  }}
                >
                  <span
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: "50%",
                      background: done ? "var(--lime-300)" : "rgba(31,79,190,0.08)",
                      color: done ? "var(--navy-900)" : "var(--sky-700)",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 11,
                      fontWeight: 700,
                      flexShrink: 0,
                    }}
                  >
                    {done ? <IconCheck size={12} stroke={3} /> : s.index}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      {portalSessionLabel(vertical, s.index)}
                      {done ? " · realizada" : ""}
                    </div>
                    <div className="k-mono" style={{ fontSize: 12, color: "var(--navy-500)" }}>
                      {new Date(s.scheduledFor).toLocaleDateString("es-AR", {
                        day: "2-digit",
                        month: "short",
                        weekday: "short",
                        timeZone: "America/Argentina/Buenos_Aires",
                      })}
                    </div>
                  </div>
                  {!done && s.hasCheckIn && <Tag tone="sky">{portalCheckInCopy(vertical).done}</Tag>}
                </div>
              );
            })}
          </Card>
        </>
      )}
    </div>
  );
}
