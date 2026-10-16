"use client";

/**
 * Historial del plan (S22a, ES3 P3.2): la bitácora de `getPlanHistory`
 * (S14, solo nivel `full`) en un Drawer de solo lectura.
 *
 * El server ya filtra el payload por allowlist (`from`, `to`, `auto`,
 * `index`, `fields`) y nombra al actor por el Practitioner del tenant; acá
 * solo se traduce la acción a copy. Lo que NO se muestra a propósito:
 *   - `index` crudo (M13: el número que se muestra es el ordinal, y el index
 *     de una sesión archivada no dice nada al usuario);
 *   - `from`/`to` de una reprogramación (son instantes ISO; se ve en la agenda).
 * Las órdenes de la OS (`authorizations`) solo llegan si el actor las puede
 * ver (E2: la clave no existe en otro caso).
 */
import { useEffect, useState } from "react";
import { Drawer } from "@/components/ui/drawer";
import { getPlanHistory } from "@/lib/plans-read";
import { PLAN_STATUS_LABEL } from "@/components/planes/plan-booking-groups";
import type { PlanHistory, PlanHistoryEvent, ProgramStatusValue } from "@/lib/plans-read-types";

const AR_TZ = "America/Argentina/Buenos_Aires";

const ACTION_LABEL: Readonly<Record<string, string>> = {
  "program.create": "Plan creado",
  "program.update": "Nombre o notas del plan editados",
  "program.archive": "Plan archivado",
  "program.restore": "Plan restaurado",
  "program.reprice": "Precio del plan cambiado",
  "program.sessions.add": "Sesiones agregadas",
  "program.sessions.archive": "Sesiones archivadas",
  "program.session.restore": "Sesión restaurada",
  "program.authorization.renew": "Autorización de la obra social renovada",
  "program.generate": "Turnos generados para sesiones pendientes",
  "program.link_booking": "Turno vinculado a una sesión",
  "program.adopt_series": "Turnos sueltos sumados al plan",
  "program.move_series": "Sesiones movidas en serie",
  "program.replan": "Plan re-planificado",
  "session.create": "Sesión agregada",
  "session.complete": "Sesión realizada",
  "session.evolution": "Sesión registrada",
  "session.meta.update": "Datos de la sesión editados",
  "session.reschedule": "Sesión reprogramada",
};

const isStatus = (v: unknown): v is ProgramStatusValue =>
  v === "ACTIVE" || v === "PAUSED" || v === "COMPLETED" || v === "CANCELLED";

/** Copy de un evento (puro: lo testea `plan-card.test.tsx`). Una acción desconocida no se inventa: "Cambio en el plan". */
export function planHistoryEventLabel(e: Pick<PlanHistoryEvent, "action" | "detail">): string {
  if (e.action === "program.status") {
    const { from, to } = e.detail;
    if (isStatus(from) && isStatus(to)) return `Estado: ${PLAN_STATUS_LABEL[from]} → ${PLAN_STATUS_LABEL[to]}`;
    return "Estado del plan cambiado";
  }
  return ACTION_LABEL[e.action] ?? "Cambio en el plan";
}

export function formatHistoryAt(at: Date | string): string {
  return new Date(at).toLocaleString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: AR_TZ,
  });
}

/** `YYYY-MM-DD` (etiqueta de día, `@db.Date`) → `dd/mm/aaaa`, sin pasar por `Date` (no hay instante que convertir). */
export function dayKeyToDisplay(key: string | null): string | null {
  if (!key) return null;
  const [y, m, d] = key.split("-");
  return y && m && d ? `${d}/${m}/${y}` : key;
}

export type PlanHistoryDrawerProps = {
  open: boolean;
  onClose: () => void;
  programId: string;
};

export type PlanHistoryState = { kind: "loading" } | { kind: "error"; error: string } | { kind: "ready"; history: PlanHistory };

export function PlanHistoryDrawer({ open, onClose, programId }: PlanHistoryDrawerProps) {
  const [state, setState] = useState<PlanHistoryState>({ kind: "loading" });

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setState({ kind: "loading" });
    getPlanHistory({ programId })
      .then((r) => {
        if (!alive) return;
        setState(r.ok ? { kind: "ready", history: r.data } : { kind: "error", error: r.error });
      })
      .catch(() => {
        if (alive) setState({ kind: "error", error: "No pudimos cargar el historial. Probá de nuevo." });
      });
    return () => {
      alive = false;
    };
  }, [open, programId]);

  return (
    <Drawer open={open} onClose={onClose} title="Historial del plan" width={480}>
      <PlanHistoryBody state={state} />
    </Drawer>
  );
}

/** Cuerpo del historial (exportado para el render test: el Drawer se monta igual). */
export function PlanHistoryBody({ state }: { state: PlanHistoryState }) {
  if (state.kind === "loading") {
    return (
      <p role="status" style={{ fontSize: 13, color: "var(--navy-500)" }}>
        Cargando…
      </p>
    );
  }
  if (state.kind === "error") {
    return (
      <p role="alert" style={{ fontSize: 13, color: "var(--danger-fg)" }}>
        {state.error}
      </p>
    );
  }
  const { events, authorizations } = state.history;
  return (
    <div data-testid="plan-history" style={{ display: "grid", gap: 16 }}>
      {events.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, color: "var(--navy-500)" }}>Todavía no hay movimientos registrados.</p>
      ) : (
        <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
          {events.map((e) => (
            <li key={e.id} style={{ display: "grid", gap: 2, paddingBottom: 10, borderBottom: "1px solid rgba(15,30,51,0.06)" }}>
              <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--navy-900)" }}>{planHistoryEventLabel(e)}</span>
              <span className="k-mono" style={{ fontSize: 11.5, color: "var(--navy-500)" }}>
                {formatHistoryAt(e.at)}
                {e.actorName ? ` · ${e.actorName}` : ""}
              </span>
            </li>
          ))}
        </ol>
      )}
      {authorizations && authorizations.length > 0 && (
        <section aria-labelledby="plan-history-auth" style={{ display: "grid", gap: 8 }}>
          <h3 id="plan-history-auth" style={{ margin: 0, fontSize: 12, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--navy-300)" }}>
            Autorizaciones de la obra social
          </h3>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
            {authorizations.map((a) => (
              <li key={a.id} style={{ fontSize: 12.5, color: "var(--navy-700)" }}>
                {[
                  a.code ? `Código ${a.code}` : null,
                  a.authorizedSessions != null ? `${a.authorizedSessions} sesiones` : null,
                  `desde ${dayKeyToDisplay(a.startsOn)}`,
                  a.expiresOn ? `vence ${dayKeyToDisplay(a.expiresOn)}` : null,
                  a.supersededAt ? "reemplazada" : "vigente",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
