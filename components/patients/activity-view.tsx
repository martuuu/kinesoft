"use client";

/**
 * Patient activity timeline — read-only view of every AuditEvent that
 * touched the patient or any of its child entities (bookings, programs,
 * sessions, files). Grouped by day for a clean timeline.
 *
 * Lazy-loaded: only fetches `getPatientActivity` when the tab opens.
 */
import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { getPatientActivity } from "@/lib/patients";
import type { ActivityEvent } from "@/lib/patients-types";

export function ActivityView({ patientId }: { patientId: string }) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getPatientActivity(patientId, { limit: 80 })
      .then((rows) => {
        if (cancelled) return;
        setEvents(rows);
        setLoading(false);
      })
      .catch(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [patientId]);

  if (loading) {
    return (
      <Card style={{ padding: 18, textAlign: "center", color: "var(--navy-500)" }}>
        Cargando actividad…
      </Card>
    );
  }
  if (events.length === 0) {
    return (
      <Card style={{ padding: 18, textAlign: "center", color: "var(--navy-500)" }}>
        Todavía no hay actividad registrada para este paciente.
      </Card>
    );
  }

  // Group by date for a clean timeline.
  const groups = new Map<string, ActivityEvent[]>();
  for (const ev of events) {
    const k = ev.createdAt.toLocaleDateString("es-AR", {
      day: "2-digit",
      month: "long",
      year: "numeric",
      timeZone: "America/Argentina/Buenos_Aires",
    });
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(ev);
  }

  return (
    <Card style={{ padding: 0, overflow: "hidden" }}>
      <div
        style={{
          padding: "14px 18px",
          borderBottom: "1px solid rgba(15,30,51,0.06)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: "var(--navy-300)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            Actividad
          </div>
          <div style={{ fontSize: 12, color: "var(--navy-500)" }}>
            {events.length} eventos · todo cambio sobre la HC queda registrado.
          </div>
        </div>
      </div>
      <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 18 }}>
        {Array.from(groups.entries()).map(([date, items]) => (
          <div key={date}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: "var(--navy-300)",
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                marginBottom: 8,
              }}
            >
              {date}
            </div>
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
              {items.map((ev) => (
                <li
                  key={ev.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "60px 1fr auto",
                    gap: 12,
                    alignItems: "center",
                    padding: "8px 12px",
                    borderRadius: 10,
                    background: "rgba(246,249,253,0.6)",
                    border: "1px solid rgba(15,30,51,0.04)",
                  }}
                >
                  <span className="k-mono" style={{ fontSize: 11, color: "var(--navy-500)" }}>
                    {ev.createdAt.toLocaleTimeString("es-AR", {
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                      timeZone: "America/Argentina/Buenos_Aires",
                    })}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--navy-900)" }}>
                      {humanizeAction(ev.action)}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--navy-500)" }}>
                      {ev.entity}
                      {ev.actorName ? ` · ${ev.actorName}` : ""}
                    </div>
                  </div>
                  {ev.payload && Object.keys(ev.payload).length > 0 && (
                    <details>
                      <summary
                        style={{
                          fontSize: 11,
                          color: "var(--sky-700)",
                          cursor: "pointer",
                          fontWeight: 600,
                        }}
                      >
                        ver detalle
                      </summary>
                      <pre
                        style={{
                          marginTop: 6,
                          padding: 8,
                          background: "rgba(15,30,51,0.05)",
                          borderRadius: 8,
                          fontSize: 11,
                          maxWidth: 280,
                          overflow: "auto",
                        }}
                      >
                        {JSON.stringify(ev.payload, null, 2)}
                      </pre>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Card>
  );
}

function humanizeAction(action: string): string {
  const map: Record<string, string> = {
    "patient.read": "HC consultada",
    "patient.read.basic": "Datos básicos consultados",
    "patient.update": "Datos actualizados",
    "patient.create": "Paciente creado",
    "patient.delete": "Paciente eliminado",
    "patient.archive": "Paciente archivado",
    "patient.unarchive": "Paciente restaurado",
    "patient.coverage.update": "Cobertura actualizada",
    "patient.reassign": "Re-asignado a otro kine",
    "patient.bulk_archive": "Archivado en lote",
    "patient.bulk_unarchive": "Restaurado en lote",
    "patient.portal_invite": "Invitado al portal",
    "patient.portal_invite.resend": "Invitación al portal reenviada",
    "patient.share.update": "Permisos de acceso actualizados",
    "booking.create": "Turno creado",
    "booking.update": "Turno actualizado",
    "booking.delete": "Turno eliminado",
    "booking.series.create": "Serie de turnos creada",
    "booking.plan.create": "Plan creado desde la agenda",
    "booking.public.create": "Reserva pública creada",
    "program.create": "Plan creado",
    "program.update": "Plan editado",
    "program.delete": "Plan eliminado",
    "program.status": "Estado del plan cambiado",
    "session.complete": "Sesión cerrada",
    "session.reschedule": "Sesión reprogramada",
    "session.delete": "Sesión eliminada",
    "sessionExercise.bulkCreate": "Ejercicios asignados en lote",
    "patientFile.upload": "Archivo subido",
    "patientFile.delete": "Archivo eliminado",
    "patientFile.download": "Archivo descargado",
  };
  return map[action] ?? action;
}
