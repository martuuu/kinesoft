"use client";

import { useEffect, useId, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { IconArrow, IconPlus } from "@/components/ui/icons";
import { getTemplatePrefill, listPlanTemplates } from "@/lib/plan-templates";
import type { PlanTemplateRow } from "@/lib/plan-templates-types";
import type { PlanEditorRequest } from "@/components/planes/plan-editor-types";

/**
 * "Aplicar plantilla" del tab Planes del perfil.
 *
 * S22a (ES3 P3.2): aplicar una plantilla ya NO crea el plan. Antes llamaba
 * la aplicación legacy de plantillas, la puerta vieja que salteaba el motor (sin turnos, sin
 * locks, sin idempotencia, y con una fecha de inicio propia). Ahora se elige
 * la plantilla, se pide su borrador con `getTemplatePrefill(templateId)`
 * (S17t: valida que siga viva y del consultorio, descarta ejercicios
 * archivados) y se abre el editor único prellenado:
 * `onOpenEditor({mode:'create', patientId, prefill, templateId})`. Inicio,
 * horario y "Revisá los turnos" se resuelven en el editor.
 *
 * P0-S02u-plan (se preserva): sin plantillas en el plan SaaS el botón queda
 * deshabilitado con el aviso visible al lado (un `title` solo no lo ve nadie
 * en mobile). El server sigue gateando: esto es UX, no barrera.
 */
export function PlanTemplateApplyButton({
  patientId,
  disabled = false,
  onOpenEditor,
}: {
  patientId: string;
  disabled?: boolean;
  onOpenEditor: (req: PlanEditorRequest) => void;
}) {
  const [open, setOpen] = useState(false);
  const hintId = useId();
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <Button
        variant="ghost"
        onClick={() => setOpen(true)}
        disabled={disabled}
        aria-describedby={disabled ? hintId : undefined}
      >
        Aplicar plantilla
      </Button>
      {disabled && (
        <span id={hintId} style={{ fontSize: 11.5, color: "var(--navy-500)" }}>
          Las plantillas no están incluidas en tu plan.
        </span>
      )}
      {open && !disabled && (
        <PlanTemplateApplyModal patientId={patientId} onClose={() => setOpen(false)} onOpenEditor={onOpenEditor} />
      )}
    </span>
  );
}

/** Exportado para el render test; en la app lo monta el botón. */
export function PlanTemplateApplyModal({
  patientId,
  onClose,
  onOpenEditor,
}: {
  patientId: string;
  onClose: () => void;
  onOpenEditor: (req: PlanEditorRequest) => void;
}) {
  const [templates, setTemplates] = useState<PlanTemplateRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    listPlanTemplates()
      .then((rows) => {
        if (!alive) return;
        setTemplates(rows);
        if (rows[0]) setSelected(rows[0].id);
      })
      .catch(() => {
        if (alive) setError("No pudimos cargar las plantillas. Probá de nuevo.");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const submit = () => {
    if (!selected) {
      setError("Elegí una plantilla.");
      return;
    }
    setError(null);
    start(async () => {
      // Validar ANTES de abrir el editor: una plantilla archivada o ajena se
      // rechaza acá con su copy, en vez de abrir un editor que falla al cargar.
      const r = await getTemplatePrefill(selected);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      onClose();
      onOpenEditor({ mode: "create", patientId, prefill: r.data.prefill, templateId: r.data.templateId });
    });
  };

  return (
    <Modal open onClose={pending ? () => {} : onClose} title="Aplicar plantilla de plan" width={540}>
      <div style={{ display: "grid", gap: 14 }}>
        <p style={{ fontSize: 12.5, color: "var(--navy-500)", margin: 0 }}>
          La plantilla completa el editor del plan: después revisás inicio, horarios y turnos antes de crearlo.
        </p>

        {loading ? (
          <div role="status" style={{ fontSize: 13, color: "var(--navy-300)", padding: 16 }}>
            Cargando…
          </div>
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
          </div>
        ) : (
          <div role="radiogroup" aria-label="Plantillas" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {templates.map((t) => {
              const on = t.id === selected;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setSelected(t.id)}
                  disabled={pending}
                  style={{
                    textAlign: "left",
                    padding: "10px 12px",
                    borderRadius: 12,
                    border: on ? "1px solid var(--sky-700)" : "1px solid rgba(15,30,51,0.06)",
                    background: on ? "rgba(31,79,190,0.06)" : "#fff",
                    cursor: "pointer",
                  }}
                >
                  <div style={{ fontSize: 14, fontWeight: 700, overflowWrap: "anywhere" }}>{t.name}</div>
                  {t.description && <div style={{ fontSize: 11.5, color: "var(--navy-500)" }}>{t.description}</div>}
                  <div className="k-mono" style={{ fontSize: 11, color: "var(--sky-700)", marginTop: 4 }}>
                    {t.totalSessions} sesiones · {t.exerciseCount} {t.exerciseCount === 1 ? "ejercicio" : "ejercicios"}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {error && (
          <div role="alert" style={{ padding: 10, borderRadius: 10, background: "rgba(228,70,70,0.1)", color: "#9F1F1F", fontSize: 12 }}>
            {error}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={submit} disabled={pending || !selected || templates.length === 0}>
            {pending ? "Abriendo…" : "Usar plantilla"} <IconArrow size={12} />
          </Button>
        </div>
      </div>
    </Modal>
  );
}
