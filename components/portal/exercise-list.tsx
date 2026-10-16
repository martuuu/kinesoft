/**
 * ES4 S24e · lista de ejercicios del plan en el portal. Server component (sin `"use client"`): cero JS al bundle del
 * portal (presupuesto 125 kB, D-VX22).
 *
 * El visor es INLINE con `<details>`: superficie pública, sin Modal/Drawer (importan framer, C-F3 + guard
 * `public-surface-imports`). El HTML del iframe/video ya viene en la página aunque el `<details>` esté cerrado, por
 * eso `loading="lazy"` en iframe e imagen y `preload="none"` en el video: abrir la lista no descarga media que el
 * paciente no pidió (datos móviles).
 *
 * Fechas con `timeZone` de Buenos Aires (AGENTS §4: en Vercel el host es UTC).
 */
import type { TenantVertical } from "@prisma/client";
import { Card } from "@/components/ui/card";
import type { PortalExerciseDTO, PortalExercisesDTO } from "@/lib/portal-exercises-types";
import { portalSessionOfTotal } from "@/lib/portal-copy";

type Props = { data: NonNullable<PortalExercisesDTO>; vertical: TenantVertical };

const eyebrow: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: "var(--navy-300)",
  letterSpacing: "0.06em",
  textTransform: "uppercase",
};

/** «3 series × 12 repeticiones» / «3 series × 30 s». Con tiempo, el tiempo manda (isométricos, planchas). */
export function exerciseDose(e: Pick<PortalExerciseDTO, "sets" | "reps" | "durationSeconds">): string {
  const sets = `${e.sets} ${e.sets === 1 ? "serie" : "series"}`;
  if (e.durationSeconds && e.durationSeconds > 0) {
    const s = e.durationSeconds;
    const t = s >= 60 && s % 60 === 0 ? `${s / 60} min` : `${s} s`;
    return `${sets} × ${t}`;
  }
  return `${sets} × ${e.reps} ${e.reps === 1 ? "repetición" : "repeticiones"}`;
}

function MediaViewer({ media, name }: { media: NonNullable<PortalExerciseDTO["media"]>; name: string }) {
  const label = media.kind === "image" ? "Ver imagen" : "Ver video";
  return (
    <details style={{ marginTop: 8 }}>
      <summary
        className="k-link"
        style={{ cursor: "pointer", fontSize: 14, minHeight: 44, display: "inline-flex", alignItems: "center" }}
      >
        {label}
      </summary>
      <div style={{ marginTop: 8, borderRadius: "var(--r-md)", overflow: "hidden", background: "rgba(15,30,51,0.06)" }}>
        {media.kind === "youtube" ? (
          <div style={{ position: "relative", paddingTop: "56.25%" }}>
            <iframe
              src={media.url}
              title={`Video: ${name}`}
              loading="lazy"
              referrerPolicy="strict-origin-when-cross-origin"
              allow="accelerometer; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: 0 }}
            />
          </div>
        ) : media.kind === "video" ? (
          <video controls preload="none" playsInline src={media.url} style={{ width: "100%", display: "block" }} />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- URL firmada de Storage (10 min): next/image la cachearía
          <img src={media.url} alt={name} loading="lazy" style={{ width: "100%", display: "block" }} />
        )}
      </div>
    </details>
  );
}

export function PortalExerciseList({ data, vertical }: Props) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {data.sessions.map((s) => (
        <Card key={s.index} style={{ padding: 0, overflow: "hidden" }}>
          <div
            style={{
              padding: "12px 16px",
              borderBottom: "1px solid rgba(15,30,51,0.06)",
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <span style={eyebrow}>{portalSessionOfTotal(vertical, s.ordinal, data.totalSessions)}</span>
            <span className="k-mono" style={{ fontSize: 12, color: "var(--navy-500)" }}>
              {new Date(s.date).toLocaleDateString("es-AR", {
                weekday: "short",
                day: "2-digit",
                month: "short",
                timeZone: "America/Argentina/Buenos_Aires",
              })}
            </span>
          </div>
          <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {s.exercises.map((e, i) => (
              <li key={i} style={{ padding: "12px 16px", borderBottom: "1px solid rgba(15,30,51,0.04)" }}>
                <div style={{ fontSize: 15, fontWeight: 700 }}>{e.name}</div>
                <div className="k-mono" style={{ fontSize: 13, color: "var(--sky-700)", marginTop: 2 }}>
                  {exerciseDose(e)}
                </div>
                {e.instructions && (
                  <p style={{ fontSize: 14, color: "var(--navy-500)", margin: "6px 0 0", whiteSpace: "pre-line" }}>
                    {e.instructions}
                  </p>
                )}
                {e.media && <MediaViewer media={e.media} name={e.name} />}
              </li>
            ))}
          </ol>
        </Card>
      ))}
    </div>
  );
}
