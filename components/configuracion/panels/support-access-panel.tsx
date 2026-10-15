import { Card } from "@/components/ui/card";
import { Tag } from "@/components/ui/tag";
import { EyebrowLabel } from "@/components/ui/eyebrow";
import { formatDateAR } from "@/lib/format";
import { toARMinutes } from "@/lib/datetime-ar";
import type { SupportSessionRow } from "@/lib/support-session-internal";

/**
 * Configuración → «Accesos de soporte» (BO3-F; decisión 3 de Martin, literal: «Entrar como soporte» abre el
 * consultorio con banda visible y registro en ese consultorio; sin vencimiento; solo lectura en todo salvo
 * Configuración; sin acceso clínico. Mail al OWNER al empezar. Lista en Configuración).
 *
 * Es la contracara del mail `support_access`: el mail lleva un motivo GENÉRICO a propósito (el que tipea el
 * superadmin es una nota interna que puede nombrar un paciente o un ticket) y remite acá, detrás del login, donde
 * cualquier miembro del consultorio (PL-F1b, decisión de Martin del 16-oct) ve quién entró, cuándo, por qué y cuándo
 * terminó. Sin estado ni acciones: desde el consultorio no se termina un acceso (termina cuando soporte sale o cierra
 * sesión; la RLS de M7 es FOR SELECT). Los datos llegan de la página (`listSupportSessionsForTenant`, cualquier
 * miembro + RLS del consultorio).
 */

/** Cómo terminó cada acceso (`SupportSession.endedReason`). Exportada para el test de render. */
export function supportEndedLabel(reason: string | null): string | null {
  switch (reason) {
    case "exit":
      return "Salió de soporte";
    case "logout":
      return "Cerró sesión";
    case "replaced":
      return "Pasó a otro consultorio";
    default:
      return null;
  }
}

/**
 * «14 oct 2026, 13:27» en hora AR, sea cual sea el TZ del host (Vercel corre en UTC). La hora se arma con
 * `toARMinutes` porque el preset `time` de `formatDateAR` usaba `hour12: false` y el ICU de Node imprimía «24:00» a la
 * medianoche (medido en el test de render). El integrador de BO3 lo pasó a `hourCycle: "h23"`; esto queda igual.
 */
export function supportWhen(iso: string): string {
  const m = toARMinutes(iso) % 1440;
  const hhmm = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return `${formatDateAR(iso, "short")}, ${hhmm}`;
}

export function SupportAccessPanel({ sessions }: { sessions: SupportSessionRow[] }) {
  return (
    <div style={{ display: "grid", gap: 14 }}>
      <Card style={{ padding: 20 }}>
        <EyebrowLabel>Qué puede hacer soporte</EyebrowLabel>
        <ul
          style={{
            margin: "10px 0 0",
            paddingLeft: 18,
            display: "grid",
            gap: 6,
            fontSize: 13.5,
            lineHeight: 1.5,
            color: "var(--navy-700)",
          }}
        >
          <li>
            Cuando nos pedís ayuda, el equipo de KineSoft puede entrar a tu consultorio <strong>como soporte</strong>.
            Cada vez que entra, le avisamos por mail al titular.
          </li>
          <li>
            Ve lo mismo que el rol Secretario/a: agenda, pacientes y turnos, <strong>sin historia clínica</strong>.
          </li>
          <li>
            Todo es <strong>solo lectura</strong>, salvo Configuración: ahí puede crear y modificar (equipo, obras
            sociales, servicios, sedes, horarios y datos del consultorio) para ayudarte.
          </li>
          <li>Cada acceso queda registrado acá, con el motivo, y termina cuando soporte sale o cierra sesión.</li>
        </ul>
      </Card>

      <Card style={{ padding: 20 }}>
        <EyebrowLabel>Accesos</EyebrowLabel>
        {sessions.length === 0 ? (
          <p data-support-empty style={{ margin: "10px 0 0", fontSize: 13.5, color: "var(--navy-500)" }}>
            Soporte todavía no entró a tu consultorio.
          </p>
        ) : (
          <ul style={{ listStyle: "none", margin: "10px 0 0", padding: 0, display: "grid" }}>
            {sessions.map((s) => {
              const ended = supportEndedLabel(s.endedReason);
              return (
                <li
                  key={s.id}
                  data-support-session={s.id}
                  style={{
                    display: "grid",
                    gap: 4,
                    padding: "12px 0",
                    borderTop: "1px solid rgba(15,30,51,0.06)",
                    minWidth: 0,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: "var(--navy-900)",
                        overflowWrap: "anywhere",
                      }}
                    >
                      {s.superadminEmail}
                    </span>
                    {s.open && <Tag tone="lime">En curso</Tag>}
                  </div>
                  <div style={{ fontSize: 12.5, color: "var(--navy-500)" }}>
                    Entró el {supportWhen(s.startedAt)}
                    {s.endedAt && (
                      <>
                        {" · "}terminó el {supportWhen(s.endedAt)}
                        {ended ? ` (${ended.toLowerCase()})` : ""}
                      </>
                    )}
                  </div>
                  <div style={{ fontSize: 13, color: "var(--navy-700)", lineHeight: 1.45, overflowWrap: "anywhere" }}>
                    <span style={{ fontWeight: 600 }}>Motivo:</span> {s.reason}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
