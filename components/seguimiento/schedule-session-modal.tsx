"use client";

import { useEffect, useState, useTransition } from "react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { generatePlanBookings, previewGeneratePlanBookings } from "@/lib/plans-adopt";
import type { PlanPreview, PlanPreviewRow, PlanRowResolution } from "@/lib/plans-types";
import {
  effectiveRowResolution,
  planRowDateLabel,
  planRowStatus,
  resolutionOptions,
} from "@/components/planes/plan-preview-table";
import { SEGUIMIENTO_COPY, scheduleOutcome } from "@/components/seguimiento/seguimiento-model";

/**
 * "Agendar" de una sesión "sin turno" desde Seguimiento (S20, C13).
 *
 * Camino del motor (S25a), sin reglas propias: `previewGeneratePlanBookings
 * ({programId, sessionIds:[id]})` clasifica la fecha planificada (libre,
 * sobreturno, fuera de horario, ya pasó…) y propone las resoluciones
 * permitidas; `generatePlanBookings` commitea con el `stateToken`. Si la
 * agenda cambió → `stale-preview` con un preview fresco y el aviso C13.
 * Estados y opciones salen de los builders puros de "Revisá los turnos"
 * (`plan-preview-table.tsx`, S18p), así el copy es el mismo que en el editor.
 *
 * Es una sola fila: no se monta el editor entero (Drawer de 600 px) para
 * elegir un horario. El gate es `plans.schedule` en el server; la página
 * solo ofrece el botón si `listSchedulablePlanSessions` la devolvió.
 */
export function ScheduleSessionModal({
  open,
  onClose,
  onScheduled,
  programId,
  sessionId,
  sessionLabel,
}: {
  open: boolean;
  onClose: () => void;
  onScheduled: () => void;
  programId: string;
  sessionId: string;
  /** "Sesión 3 de 10". */
  sessionLabel: string;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [choice, setChoice] = useState<PlanRowResolution | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setPreview(null);
    setChoice(null);
    setError(null);
    setStale(false);
    setLoading(true);
    previewGeneratePlanBookings({ programId, sessionIds: [sessionId] })
      .then((r) => {
        if (!alive) return;
        if (r.ok) setPreview(r.preview);
        else setError(r.error);
      })
      .catch(() => alive && setError("No pudimos revisar la agenda. Reintentá en un momento."))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [open, programId, sessionId]);

  const row: PlanPreviewRow | null = preview?.rows[0] ?? null;
  const options = row ? resolutionOptions(row) : [];
  const resolution = row ? (choice ?? effectiveRowResolution(row, {})) : null;
  const canSubmit = !!row && !!resolution && resolution.kind !== "none" && !pending && !loading;

  const submit = () => {
    if (!preview || !resolution) return;
    setError(null);
    start(async () => {
      const r = await generatePlanBookings({
        programId,
        sessionIds: [sessionId],
        rows: [resolution],
        stateToken: preview.stateToken,
      });
      const o = scheduleOutcome(r);
      if (o.kind === "done") {
        toast.success(o.message, o.notice ? { description: o.notice } : undefined);
        onScheduled();
        return;
      }
      if (o.kind === "stale") {
        setStale(true);
        setChoice(null);
        if (o.preview) setPreview(o.preview);
        return;
      }
      if (o.kind === "confirm") {
        // Hoy generar no pide confirmaciones; si el server empieza a pedirla,
        // se muestra y no se reenvía a ciegas.
        await confirm({ title: o.message, confirmLabel: "Entendido" });
        return;
      }
      setError(o.message);
    });
  };

  const status = row ? planRowStatus(row) : null;
  const date = row ? planRowDateLabel(row.at) : null;

  return (
    <Modal open={open} onClose={onClose} title={SEGUIMIENTO_COPY.scheduleTitle} description={sessionLabel} width={480}>
      <div style={{ display: "grid", gap: 12 }}>
        {stale && (
          <p role="alert" style={notice}>
            {SEGUIMIENTO_COPY.scheduleStale}
          </p>
        )}
        {loading && <div style={{ fontSize: 13, color: "var(--navy-500)" }}>Revisando la agenda…</div>}
        {row && status && date && (
          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ fontSize: 13, color: "var(--navy-900)" }}>
              <span style={{ fontWeight: 700 }}>
                {date.day} · {date.time}
              </span>{" "}
              <span style={{ color: "var(--navy-500)" }}>
                <span aria-hidden="true">{status.glyph} </span>
                {status.label}
              </span>
            </div>
            {options.length === 0 || (options.length === 1 && options[0].value === "none") ? (
              <p style={notice}>{SEGUIMIENTO_COPY.scheduleNoSlot}</p>
            ) : (
              <label style={{ display: "grid", gap: 4, fontSize: 12, fontWeight: 600, color: "var(--navy-500)" }}>
                Qué hacemos
                <select
                  value={resolution?.kind ?? ""}
                  onChange={(e) => {
                    const o = options.find((x) => x.value === e.target.value);
                    if (o) setChoice(o.resolution);
                  }}
                  disabled={pending}
                  style={{
                    padding: "8px 10px",
                    borderRadius: 10,
                    border: "1px solid rgba(15,30,51,0.12)",
                    fontSize: 13,
                    background: "#fff",
                    color: "var(--navy-900)",
                  }}
                >
                  {options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}
        {error && (
          <div role="alert" style={{ ...notice, background: "rgba(228,70,70,0.1)", color: "#9F1F1F", border: "none" }}>
            {error}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
            Cancelar
          </Button>
          <Button type="button" variant="primary" onClick={submit} disabled={!canSubmit}>
            {pending ? "Agendando…" : SEGUIMIENTO_COPY.scheduleConfirm}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const notice: React.CSSProperties = {
  margin: 0,
  padding: "8px 12px",
  borderRadius: 10,
  border: "1px solid var(--navy-200)",
  background: "var(--card-bg)",
  fontSize: 13,
  color: "var(--navy-900)",
};
