import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { getPortalAuth, getPortalPlan } from "@/lib/portal";
import { resolveSlugAlias } from "@/lib/public-booking-internal";
import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { ButtonLink } from "@/components/ui/button";
import { IconArrow, IconCheck } from "@/components/ui/icons";
import { PortalCheckInForm } from "@/components/portal/check-in-form";
import { PortalTabs } from "@/components/portal/portal-tabs";
import { BRAND_NAME } from "@/lib/brand";
import {
  PORTAL_HOME,
  PORTAL_PLAN_NO_BOOKING,
  portalCheckInCopy,
  portalNextSessionLabel,
  portalNoPlanCopy,
  portalPlanProgress,
  portalSessionOfTotal,
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
 *
 * ES4 S24: qué se ve lo deciden las secciones de la ficha (`me.sections` = `portalSectionsFor(modules)`): el plan solo
 * con `plan`, el check-in solo con `checkin`, y las tabs (Estado de cuenta, Ejercicios, Sacar un turno) con las suyas.
 * El recorrido muestra cada sesión viva como «Sesión n de N» (ordinal por fecha, M13) con su turno (fecha, servicio y
 * profesional; sin montos ni notas). El gate de verdad está en `getPortalPlan`/`submitCheckIn`; acá solo se pinta.
 */

const dateTime: Intl.DateTimeFormatOptions = {
  weekday: "long",
  day: "2-digit",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "America/Argentina/Buenos_Aires",
};
const shortDate: Intl.DateTimeFormatOptions = {
  day: "2-digit",
  month: "short",
  weekday: "short",
  timeZone: "America/Argentina/Buenos_Aires",
};
const shortDateTime: Intl.DateTimeFormatOptions = {
  ...shortDate,
  hour: "2-digit",
  minute: "2-digit",
};

export default async function PortalTenantPage({
  params,
  searchParams,
}: {
  params: { slug: string };
  searchParams?: { [k: string]: string | string[] | undefined };
}) {
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
  const sections = new Set(me.sections);
  const usesPlans = sections.has("plan");
  // Sin `planes` ni se pregunta (getPortalPlan devolvería null igual: el gate de verdad está ahí).
  const plan = usesPlans ? await getPortalPlan(params.slug) : null;
  const header = portalTenantHeader({ vertical, hasPlan: !!plan, firstName: me.firstName });
  const noPlan = portalNoPlanCopy(usesPlans);
  const canBook = sections.has("reservar");
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

      {/* ES4-Z (b): vuelta de /portal/vincular (`submitPortalInvite`). */}
      {searchParams?.vinculado === "1" && (
        <p role="status" className="k-alert k-alert-success" style={{ margin: 0 }}>
          Listo: vinculaste tu ficha de {me.tenantName}.
        </p>
      )}

      <header>
        <Tag tone="lime">{me.tenantName}</Tag>
        <h1 className="k-display" style={{ fontSize: 26, margin: "10px 0 4px", letterSpacing: "-0.02em" }}>
          {header.title}
        </h1>
        <p style={{ fontSize: 14, color: "var(--navy-500)", margin: 0 }}>{header.lead}</p>
      </header>

      <PortalTabs slug={params.slug} sections={me.sections} active="inicio" />

      {!plan && usesPlans ? (
        <Card glass style={{ padding: 22 }}>
          <p style={{ fontSize: 14, color: "var(--navy-500)", margin: 0 }}>{noPlan.text}</p>
        </Card>
      ) : !plan ? (
        // ES4-Z (b4): consultorio sin planes (Clínica general) → «Tu consultorio» con los próximos turnos acá mismo
        // (antes: «no usa planes… los ves en Mis consultorios», una vuelta para ver lo que ya teníamos leído).
        <Card glass style={{ padding: 18, display: "grid", gap: 10 }}>
          <p style={{ fontSize: 14, color: "var(--navy-500)", margin: 0 }}>{noPlan.text}</p>
          <div
            style={{
              fontSize: 11,
              color: "var(--navy-300)",
              fontWeight: 700,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
            }}
          >
            {PORTAL_HOME.upcomingTitle}
          </div>
          {me.upcoming.length === 0 ? (
            <p style={{ fontSize: 13, color: "var(--navy-500)", margin: 0 }}>
              {PORTAL_HOME.noUpcoming}
              {canBook && (
                <>
                  {" "}
                  <Link href={`/c/${encodeURIComponent(params.slug)}/booking`} className="k-link">
                    {PORTAL_HOME.bookCta} →
                  </Link>
                </>
              )}
            </p>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
              {me.upcoming.map((b) => (
                <li
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
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>
                      {b.scheduledFor.toLocaleString("es-AR", dateTime)}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--navy-500)" }}>
                      {b.serviceName} · {b.practitionerName} · {b.durationMin} min
                    </div>
                  </div>
                  {b.confirmed ? <Tag tone="lime">Confirmado</Tag> : <Tag tone="soft">A confirmar</Tag>}
                </li>
              ))}
            </ul>
          )}
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
                  {portalNextSessionLabel(vertical, nextSession.ordinal, plan.totalSessions)}
                </div>
                <div style={{ fontSize: 15, fontWeight: 700, marginTop: 4 }}>
                  {new Date(nextSession.scheduledFor).toLocaleString("es-AR", dateTime)}
                </div>
                <div style={{ fontSize: 13, color: "var(--navy-500)", marginTop: 2 }}>
                  {nextSession.booking
                    ? `${nextSession.booking.serviceName} · ${nextSession.booking.practitionerName} · ${nextSession.booking.durationMin} min`
                    : PORTAL_PLAN_NO_BOOKING}
                </div>
              </div>
              {/* S24: el check-in solo con la sección `checkin` (⇐ planes ∧ evaluaciones). */}
              {!sections.has("checkin") ? null : nextSession.hasCheckIn ? (
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
                    {done ? <IconCheck size={12} stroke={3} /> : s.ordinal}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      {portalSessionOfTotal(vertical, s.ordinal, plan.totalSessions)}
                      {done ? " · realizada" : ""}
                    </div>
                    <div className="k-mono" style={{ fontSize: 12, color: "var(--navy-500)" }}>
                      {/* Con turno: fecha y hora del turno. Sin turno: la fecha planificada (sin hora: no hay turno). */}
                      {s.booking
                        ? new Date(s.booking.scheduledFor).toLocaleString("es-AR", shortDateTime)
                        : new Date(s.scheduledFor).toLocaleDateString("es-AR", shortDate)}
                    </div>
                    {!done && (
                      <div style={{ fontSize: 12, color: "var(--navy-500)" }}>
                        {s.booking ? `${s.booking.serviceName} · ${s.booking.practitionerName}` : PORTAL_PLAN_NO_BOOKING}
                      </div>
                    )}
                  </div>
                  {!done && s.hasCheckIn && sections.has("checkin") && <Tag tone="sky">{portalCheckInCopy(vertical).done}</Tag>}
                </div>
              );
            })}
          </Card>
        </>
      )}
    </div>
  );
}
