import Link from "next/link";
import { notFound } from "next/navigation";
import { getPortalAuth, getPortalPlan } from "@/lib/portal";
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { Button } from "@/components/ui/button";
import { IconArrow, IconCheck } from "@/components/ui/icons";
import { PortalCheckInForm } from "@/components/portal/check-in-form";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: { slug: string } }) {
  return { title: `Mi plan · ${params.slug} · KineSoft` };
}

export default async function PortalTenantPage({ params }: { params: { slug: string } }) {
  const auth = await getPortalAuth();
  if (!auth.signedIn) {
    return (
      <Card glass style={{ padding: 22 }}>
        <p style={{ fontSize: 14, color: "var(--navy-500)" }}>
          Iniciá sesión para ver tu plan.
        </p>
        <Link href="/portal">
          <Button variant="primary" style={{ marginTop: 8 }}>
            Ir al portal <IconArrow size={14} />
          </Button>
        </Link>
      </Card>
    );
  }
  const me = auth.patients.find((p) => p.tenantSlug === params.slug);
  if (!me) notFound();
  const plan = await getPortalPlan(params.slug);
  const now = Date.now();
  const nextSession = plan?.sessions.find(
    (s) => !s.completedAt && new Date(s.scheduledFor).getTime() >= now - 60_000
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Link
        href="/portal"
        style={{ fontSize: 12, color: "var(--sky-700)", fontWeight: 600, textDecoration: "none" }}
      >
        ← Mis consultorios
      </Link>

      <header>
        <Tag tone="lime">{me.tenantName}</Tag>
        <h1 className="k-display" style={{ fontSize: 26, margin: "10px 0 4px", letterSpacing: "-0.02em" }}>
          Tu plan
        </h1>
        <p style={{ fontSize: 13, color: "var(--navy-500)", margin: 0 }}>
          Hola {me.firstName}. Acá ves cómo viene tu recuperación, sesión por sesión.
        </p>
      </header>

      {!plan ? (
        <Card glass style={{ padding: 22 }}>
          <p style={{ fontSize: 14, color: "var(--navy-500)" }}>
            Todavía no tenés un plan activo en este centro. Cuando tu kinesiólogo lo arme va a
            aparecer acá.
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
              {plan.completedSessions} / {plan.totalSessions} sesiones
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
                  Próxima sesión · #{nextSession.index}
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
                  <IconCheck size={11} stroke={3} /> Check-in registrado
                </Tag>
              ) : (
                <PortalCheckInForm slug={params.slug} sessionId={nextSession.id} />
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
              Timeline
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
                      Sesión {s.index}
                      {done ? " · realizada" : ""}
                    </div>
                    <div className="k-mono" style={{ fontSize: 11, color: "var(--navy-500)" }}>
                      {new Date(s.scheduledFor).toLocaleDateString("es-AR", {
                        day: "2-digit",
                        month: "short",
                        weekday: "short",
                        timeZone: "America/Argentina/Buenos_Aires",
                      })}
                    </div>
                  </div>
                  {!done && s.hasCheckIn && <Tag tone="sky">Check-in</Tag>}
                </div>
              );
            })}
          </Card>
        </>
      )}
    </div>
  );
}
