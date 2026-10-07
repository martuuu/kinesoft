import Link from "next/link";
import type { DischargeSuggestionRow, OpenSessionBucket, OpenSessionBuckets, OpenSessionRow } from "@/lib/sessions-types";
import { planDeepLinkHref } from "@/lib/plans-deeplink";
import { Card } from "@/components/ui/card";
import { Avatar } from "@/components/ui/avatar";
import { Tag } from "@/components/ui/tag";
import { IconActivity, IconCheck } from "@/components/ui/icons";
import { DisciplineChip } from "@/components/planes/discipline-chip";
import {
  SEGUIMIENTO_COPY,
  dischargeCopy,
  landingLenses,
  sessionCounterLabel,
  sessionHref,
} from "@/components/seguimiento/seguimiento-model";

/**
 * Landing de Seguimiento (S20, ES3). Presentacional y sin hooks: la página
 * (server) trae los buckets y esto los pinta; así el render test lo cubre con
 * `renderToStaticMarkup` sin mockear la página.
 *
 * Buckets (los arma el server, ver `listOpenSessions`):
 *   - "Para dar el alta" (D22): banner por plan con todas sus sesiones vivas
 *     realizadas. Se SUGIERE, nunca se autocompleta: el alta (con la pregunta
 *     D7 por los turnos que queden) vive en la tab Planes, adonde lleva el
 *     link; acá no hay `expectedUpdatedAt` para hacerla en el lugar;
 *   - "Sin turno" (C4) con "Agendar" (solo con el módulo `planes`): abre el
 *     detalle con el modal de agendar, que verifica `plans.schedule`;
 *   - "Sin evolución" con "Cargar evolución" (S12b);
 *   - los cuatro de siempre, con el tag "Sin evolución" / "Sin turno" en las
 *     tarjetas que también están en esos lentes.
 */
export function SeguimientoLanding({
  buckets,
  plansEnabled,
}: {
  buckets: OpenSessionBuckets;
  /** Módulo `planes`: sin él no se ofrece "Agendar" (el server igual rechaza). */
  plansEnabled: boolean;
}) {
  const { overdue, today, upcoming, recent, sinTurno, realizadasSinEvolucion, suggestDischarge } = buckets;
  const lenses = landingLenses(buckets);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
      <header>
        <div style={{ fontSize: 12, color: "var(--navy-300)", fontWeight: 500 }}>Seguimiento</div>
        <h1 className="k-display" style={{ fontSize: 30, margin: "2px 0 0" }}>
          Sesiones del plan
        </h1>
      </header>

      {suggestDischarge && suggestDischarge.rows.length > 0 && <DischargeBanner rows={suggestDischarge.rows} />}

      {overdue.total > 0 && (
        <Section
          id="vencidas"
          title="Vencidas sin cerrar"
          hint="Sesiones de planes activos con fecha pasada que nunca se cerraron."
          bucket={overdue}
        >
          <SessionList items={overdue.rows} variant="overdue" lenses={lenses} plansEnabled={plansEnabled} />
        </Section>
      )}
      {sinTurno && sinTurno.total > 0 && (
        <Section id="sin-turno" title={SEGUIMIENTO_COPY.sinTurnoTitle} hint={SEGUIMIENTO_COPY.sinTurnoHint} bucket={sinTurno}>
          <SessionList items={sinTurno.rows} variant="sinTurno" lenses={lenses} plansEnabled={plansEnabled} />
        </Section>
      )}
      {realizadasSinEvolucion && realizadasSinEvolucion.total > 0 && (
        <Section
          id="sin-evolucion"
          title={SEGUIMIENTO_COPY.sinEvolucionTitle}
          hint={SEGUIMIENTO_COPY.sinEvolucionHint}
          bucket={realizadasSinEvolucion}
        >
          <SessionList items={realizadasSinEvolucion.rows} variant="sinEvolucion" lenses={lenses} plansEnabled={plansEnabled} />
        </Section>
      )}
      <Section id="hoy" title="Hoy" bucket={today}>
        <SessionList items={today.rows} variant="today" lenses={lenses} plansEnabled={plansEnabled} />
      </Section>
      <Section id="proximas" title="Próximas" bucket={upcoming}>
        <SessionList items={upcoming.rows} variant="upcoming" lenses={lenses} plansEnabled={plansEnabled} />
      </Section>
      <Section id="realizadas" title="Realizadas · últimos 14 días" bucket={recent}>
        <SessionList items={recent.rows} variant="completed" lenses={lenses} plansEnabled={plansEnabled} />
      </Section>
    </div>
  );
}

function DischargeBanner({ rows }: { rows: DischargeSuggestionRow[] }) {
  return (
    <section aria-labelledby="seg-alta-title">
      <div id="seg-alta-title" className="k-display" style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>
        {SEGUIMIENTO_COPY.dischargeTitle}
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {rows.map((p) => {
          const href = planDeepLinkHref({ kind: "program", patientId: p.patientId, programId: p.programId });
          return (
            <Card
              key={p.programId}
              style={{ padding: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}
            >
              <Avatar name={p.patientName} size={32} tone="lime" />
              <div style={{ flex: 1, minWidth: 180 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: "var(--navy-900)" }}>
                  {p.patientName}{" "}
                  <DisciplineChip discipline={p.discipline} size="xs" style={{ marginLeft: 4 }} />
                </div>
                <div role="status" style={{ fontSize: 12.5, color: "var(--navy-700)" }}>
                  {dischargeCopy(p.totalLive)}
                </div>
              </div>
              {href && (
                <Link href={href} style={linkButton}>
                  {SEGUIMIENTO_COPY.dischargeAction}
                </Link>
              )}
            </Card>
          );
        })}
      </div>
    </section>
  );
}

const linkButton: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  padding: "6px 12px",
  borderRadius: 999,
  border: "1px solid rgba(31,79,190,0.25)",
  color: "var(--sky-700)",
  textDecoration: "none",
  whiteSpace: "nowrap",
};

function Section({
  id,
  title,
  hint,
  bucket,
  children,
}: {
  id: string;
  title: string;
  hint?: string;
  bucket: OpenSessionBucket;
  children: React.ReactNode;
}) {
  const truncated = bucket.total > bucket.rows.length;
  const headingId = `seg-${id}`;
  return (
    <section aria-labelledby={headingId}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          marginBottom: 8,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div id={headingId} className="k-display" style={{ fontSize: 16, fontWeight: 700 }}>
            {title}
          </div>
          {hint && <div style={{ fontSize: 11.5, color: "var(--navy-500)" }}>{hint}</div>}
        </div>
        <Tag tone="soft">{truncated ? `${bucket.rows.length} de ${bucket.total}` : bucket.total}</Tag>
      </div>
      {children}
      {truncated && (
        <div style={{ marginTop: 6, fontSize: 11.5, color: "var(--navy-500)" }}>
          Se muestran las primeras {bucket.rows.length}. Las demás están en la pestaña Planes de cada paciente.
        </div>
      )}
    </section>
  );
}

type Variant = "overdue" | "sinTurno" | "sinEvolucion" | "today" | "upcoming" | "completed";

function SessionList({
  items,
  variant,
  lenses,
  plansEnabled,
}: {
  items: OpenSessionRow[];
  variant: Variant;
  lenses: ReturnType<typeof landingLenses>;
  plansEnabled: boolean;
}) {
  if (items.length === 0) {
    return <Card style={{ padding: 18, color: "var(--navy-300)", fontSize: 13 }}>Nada por acá.</Card>;
  }
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(min(280px, 100%), 1fr))",
        gap: 10,
      }}
    >
      {items.map((s) => (
        <SessionCard key={s.id} s={s} variant={variant} lenses={lenses} plansEnabled={plansEnabled} />
      ))}
    </div>
  );
}

function SessionCard({
  s,
  variant,
  lenses,
  plansEnabled,
}: {
  s: OpenSessionRow;
  variant: Variant;
  lenses: ReturnType<typeof landingLenses>;
  plansEnabled: boolean;
}) {
  const emphasize = variant === "today";
  const completed = variant === "completed" || variant === "sinEvolucion";
  const sinEvolucion = lenses.sinEvolucion.has(s.id);
  const sinTurno = !completed && lenses.sinTurno.has(s.id);
  const canAgendar = sinTurno && plansEnabled;
  const counter = sessionCounterLabel(s.ordinal, s.totalLive);
  const when = s.scheduledFor.toLocaleString("es-AR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "America/Argentina/Buenos_Aires",
  });

  return (
    <article
      aria-label={`${s.patientName} · ${counter}`}
      style={{
        padding: 14,
        borderRadius: 14,
        background: emphasize ? "linear-gradient(135deg, rgba(31,79,190,0.06), rgba(255,255,255,0.6))" : "#fff",
        border: emphasize ? "1px solid rgba(31,79,190,0.2)" : "1px solid rgba(15,30,51,0.06)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        minWidth: 0,
      }}
    >
      <Link
        href={sessionHref(s.id)}
        style={{ textDecoration: "none", color: "inherit", display: "flex", flexDirection: "column", gap: 8 }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Avatar name={s.patientName} size={36} tone={emphasize ? "lime" : "sky"} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "var(--navy-900)" }}>{s.patientName}</div>
            <div style={{ fontSize: 11, color: "var(--navy-500)", overflow: "hidden", textOverflow: "ellipsis" }}>
              {s.programTitle}
            </div>
          </div>
          {completed && !sinEvolucion && (
            <Tag tone="soft">
              <IconCheck size={10} stroke={3} /> Hecho
            </Tag>
          )}
          {sinEvolucion && <Tag tone="soft">{SEGUIMIENTO_COPY.sinEvolucionTag}</Tag>}
          {variant === "overdue" && <Tag tone="soft">Sin cerrar</Tag>}
          {sinTurno && variant !== "sinTurno" && <Tag tone="soft">Sin turno</Tag>}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            fontSize: 12,
            color: "var(--navy-500)",
          }}
        >
          <span className="k-mono">{counter}</span>
          <span>{when}</span>
        </div>
        <div style={{ height: 6, borderRadius: 3, overflow: "hidden", background: "rgba(15,30,51,0.06)" }}>
          <div
            style={{
              width: `${s.exerciseCount ? (s.doneCount / s.exerciseCount) * 100 : 0}%`,
              height: "100%",
              background: "linear-gradient(90deg, var(--sky-500), var(--lime-400))",
            }}
          />
        </div>
        <div className="k-mono" style={{ fontSize: 11, color: "var(--sky-700)" }}>
          <IconActivity size={11} style={{ verticalAlign: -1 }} /> {s.doneCount} / {s.exerciseCount} ejercicios
        </div>
      </Link>
      {(canAgendar || sinEvolucion) && (
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
          {sinEvolucion && (
            <Link href={sessionHref(s.id)} style={linkButton} aria-label={`${SEGUIMIENTO_COPY.cargarEvolucion} · ${s.patientName}`}>
              {SEGUIMIENTO_COPY.cargarEvolucion}
            </Link>
          )}
          {canAgendar && (
            <Link
              href={sessionHref(s.id, { agendar: true })}
              style={linkButton}
              aria-label={`${SEGUIMIENTO_COPY.agendar} · ${s.patientName} · ${counter}`}
            >
              {SEGUIMIENTO_COPY.agendar}
            </Link>
          )}
        </div>
      )}
    </article>
  );
}
