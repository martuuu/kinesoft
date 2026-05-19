"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ModalCloseButton } from "@/components/ui/modal-close";
import { IconArrow, IconPlus } from "@/components/ui/icons";
import { applyPlanTemplate, listPlanTemplates } from "@/lib/plan-templates";
import type { PlanTemplateRow } from "@/lib/plan-templates-types";

/**
 * "Aplicar plantilla" button rendered on the patient profile Plan tab.
 * Only mounts when the active plan unlocks templates.
 */
export function PlanTemplateApplyButton({ patientId }: { patientId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)}>
        Aplicar plantilla
      </Button>
      {open && <PlanTemplateApplyModal patientId={patientId} onClose={() => setOpen(false)} />}
    </>
  );
}

function PlanTemplateApplyModal({
  patientId,
  onClose,
}: {
  patientId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [templates, setTemplates] = useState<PlanTemplateRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10));

  useEffect(() => {
    listPlanTemplates()
      .then((rows) => {
        setTemplates(rows);
        if (rows[0]) setSelected(rows[0].id);
      })
      .finally(() => setLoading(false));
  }, []);

  const submit = () => {
    if (!selected) {
      setError("Elegí una plantilla.");
      return;
    }
    setError(null);
    start(async () => {
      const r = await applyPlanTemplate({
        templateId: selected,
        patientId,
        startDate,
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      onClose();
      router.refresh();
    });
  };

  return (
    <div
      role="dialog"
      aria-modal
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,30,51,0.45)",
        backdropFilter: "blur(4px)",
        zIndex: 60,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="k-glass-strong k-scroll"
        style={{
          position: "relative",
          width: "min(540px, 100%)",
          maxHeight: "90vh",
          overflowY: "auto",
          borderRadius: 22,
          padding: 24,
        }}
      >
        <ModalCloseButton onClose={onClose} />
        <h2 className="k-display" style={{ fontSize: 22, margin: "0 40px 6px 0", fontWeight: 700 }}>
          Aplicar plantilla de plan
        </h2>
        <p style={{ fontSize: 12, color: "var(--navy-500)", margin: "0 0 16px" }}>
          Una plantilla genera el plan completo en segundos. Después podés editar las sesiones.
        </p>

        {loading ? (
          <div style={{ fontSize: 13, color: "var(--navy-300)", padding: 16 }}>Cargando…</div>
        ) : templates.length === 0 ? (
          <div
            style={{
              padding: 24,
              textAlign: "center",
              color: "var(--navy-500)",
              fontSize: 13,
              border: "1px dashed rgba(15,30,51,0.12)",
              borderRadius: 14,
            }}
          >
            <IconPlus size={16} /> Todavía no creaste plantillas.
            <div style={{ fontSize: 11.5, color: "var(--navy-300)", marginTop: 6 }}>
              Vas a poder crearlas desde la Biblioteca (próximamente).
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
            {templates.map((t) => {
              const on = t.id === selected;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setSelected(t.id)}
                  style={{
                    textAlign: "left",
                    padding: "10px 12px",
                    borderRadius: 12,
                    border: on
                      ? "1px solid var(--sky-700)"
                      : "1px solid rgba(15,30,51,0.06)",
                    background: on ? "rgba(31,79,190,0.06)" : "#fff",
                    cursor: "pointer",
                  }}
                >
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{t.name}</div>
                  {t.description && (
                    <div style={{ fontSize: 11.5, color: "var(--navy-500)" }}>{t.description}</div>
                  )}
                  <div
                    className="k-mono"
                    style={{ fontSize: 11, color: "var(--sky-700)", marginTop: 4 }}
                  >
                    {t.totalSessions} sesiones · {t.frequency}×/sem · {t.exerciseCount} ejercicios
                  </div>
                </button>
              );
            })}
          </div>
        )}

        <label style={{ display: "block", fontSize: 12, marginBottom: 14 }}>
          <span style={{ fontWeight: 600, color: "var(--navy-500)" }}>Primera sesión</span>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            style={{
              marginTop: 6,
              width: "100%",
              padding: "10px 12px",
              borderRadius: 12,
              border: "1px solid rgba(15,30,51,0.08)",
              background: "rgba(255,255,255,0.7)",
            }}
          />
        </label>

        {error && (
          <div
            style={{
              padding: 10,
              borderRadius: 10,
              background: "rgba(228,70,70,0.1)",
              color: "#9F1F1F",
              fontSize: 12,
              marginBottom: 12,
            }}
          >
            {error}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={pending || !selected || templates.length === 0}
          >
            {pending ? "Aplicando…" : "Aplicar plantilla"} <IconArrow size={12} />
          </Button>
        </div>
      </div>
    </div>
  );
}
