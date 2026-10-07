"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import {
  DEFAULT_PATIENT_ARCHIVE_PLANS_ACTION,
  type PatientArchivePlansAction,
} from "@/lib/plans-lifecycle-state";

/**
 * L9 (PD-10, S22h · ES3): archivar un paciente con planes vivos pregunta qué
 * pasa con ellos. El server (`setPatientArchived` / `bulkArchivePatients`,
 * P2-S15) recibe `plansAction?: 'pause' | 'cancel'` con default `pause`:
 *   - `pause`: ACTIVE → PAUSED, los turnos quedan como están
 *     (`patientArchivePlanTarget`, lib/plans-lifecycle-state.ts);
 *   - `cancel`: ACTIVE/PAUSED → CANCELLED y se cancelan los turnos futuros
 *     impagos (`applyFutureBookingsInTx`).
 * El diálogo SOLO junta la elección: la action la llama el caller (hero,
 * `patient-row-actions` y bulk-select de S32a), porque cada uno usa una
 * distinta (single vs bulk). Sin planes vivos no se muestra
 * (`shouldAskArchivePlans`): el caller sigue con el `useConfirm` de siempre.
 */

export type ArchivePatientResult = { ok: true } | { ok: false; error: string };

export type ArchivePatientDialogProps = {
  open: boolean;
  onClose: () => void;
  /** Hero / fila: el nombre del paciente. Bulk: omitido y `count` > 1. */
  patientName?: string;
  /** Pacientes a archivar (default 1). */
  count?: number;
  /**
   * Planes vivos (ACTIVE/PAUSED, no archivados) entre esos pacientes.
   * `null` = el caller no lo sabe (bulk): el copy lo dice en condicional.
   */
  livePlanCount: number | null;
  /** Llama a la action con la elección; el diálogo muestra el error si vuelve `ok:false`. */
  onConfirm: (plansAction: PatientArchivePlansAction) => Promise<ArchivePatientResult>;
};

/**
 * ¿Hace falta la pregunta L9? Sin el módulo `planes` (consultorio General) no
 * hay planes; con 0 planes vivos tampoco. `null` (no se sabe) → se pregunta:
 * es más barato preguntar de más que cancelar o pausar sin avisar.
 */
export function shouldAskArchivePlans(input: { plansEnabled: boolean; livePlanCount: number | null }): boolean {
  if (!input.plansEnabled) return false;
  return input.livePlanCount == null || input.livePlanCount > 0;
}

export const ARCHIVE_PLANS_OPTIONS: ReadonlyArray<{
  value: PatientArchivePlansAction;
  label: string;
  hint: string;
}> = [
  {
    value: "pause",
    label: "Pausar los planes",
    hint: "Los planes activos quedan en pausa y los turnos ya agendados se mantienen. Los reactivás cuando vuelva.",
  },
  {
    value: "cancel",
    label: "Cancelar los planes y sus turnos futuros",
    hint: "Los planes quedan cancelados y se cancelan los turnos futuros que no estén cobrados. El historial y lo cobrado se conservan.",
  },
];

/** Título y texto del diálogo (puro, lo testea el render test). */
export function archivePatientDialogCopy(input: {
  patientName?: string;
  count?: number;
  livePlanCount: number | null;
}): { title: string; message: string; confirmLabel: string } {
  const count = input.count ?? 1;
  const many = count > 1;
  const who = many ? `${count} pacientes` : (input.patientName?.trim() || "El paciente");
  const n = input.livePlanCount;
  const plans =
    n == null
      ? many
        ? "Si alguno tiene planes activos, elegí qué hacer con ellos."
        : "Si tiene planes activos, elegí qué hacer con ellos."
      : `${many ? "Tienen" : "Tiene"} ${n} ${n === 1 ? "plan activo" : "planes activos"}. Elegí qué hacer con ${n === 1 ? "él" : "ellos"}.`;
  return {
    title: many ? `Archivar ${count} pacientes` : "Archivar paciente",
    message: `${who} ${many ? "dejan" : "deja"} de aparecer en el listado. La ficha, los turnos y el historial se conservan, y ${many ? "los" : "lo"} podés desarchivar cuando quieras. ${plans}`,
    confirmLabel: "Archivar",
  };
}

export function ArchivePatientDialog({
  open,
  onClose,
  patientName,
  count,
  livePlanCount,
  onConfirm,
}: ArchivePatientDialogProps) {
  const [choice, setChoice] = useState<PatientArchivePlansAction>(DEFAULT_PATIENT_ARCHIVE_PLANS_ACTION);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Cada apertura arranca en el default (pausar): una elección de "cancelar"
  // de una apertura anterior no se arrastra en silencio.
  useEffect(() => {
    if (open) {
      setChoice(DEFAULT_PATIENT_ARCHIVE_PLANS_ACTION);
      setError(null);
      setPending(false);
    }
  }, [open]);

  const copy = archivePatientDialogCopy({ patientName, count, livePlanCount });

  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      const r = await onConfirm(choice);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      onClose();
    } catch {
      setError("No pudimos archivar. Probá de nuevo.");
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal open={open} onClose={pending ? () => {} : onClose} title={copy.title} lockBackdrop={pending} width={480}>
      <p style={{ fontSize: 13, color: "var(--navy-700)", marginTop: 0, marginBottom: 14, lineHeight: 1.45 }}>
        {copy.message}
      </p>
      <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 8 }}>
        <legend style={{ fontSize: 11, fontWeight: 700, color: "var(--navy-500)", marginBottom: 8 }}>
          Qué pasa con los planes
        </legend>
        {ARCHIVE_PLANS_OPTIONS.map((o) => {
          const on = choice === o.value;
          const hintId = `archive-plans-${o.value}-hint`;
          return (
            <label
              key={o.value}
              data-option={o.value}
              style={{
                display: "grid",
                gridTemplateColumns: "18px 1fr",
                gap: 8,
                alignItems: "start",
                padding: "10px 12px",
                borderRadius: 12,
                cursor: pending ? "not-allowed" : "pointer",
                background: on ? "#fff" : "rgba(15,30,51,0.03)",
                border: on ? "1px solid var(--sky-500)" : "1px solid rgba(15,30,51,0.08)",
              }}
            >
              <input
                type="radio"
                name="archive-plans-action"
                value={o.value}
                checked={on}
                disabled={pending}
                aria-describedby={hintId}
                onChange={() => setChoice(o.value)}
                style={{ marginTop: 2 }}
              />
              <span>
                <span style={{ display: "block", fontSize: 13, fontWeight: 600, color: "var(--navy-900)" }}>
                  {o.label}
                </span>
                <span id={hintId} style={{ display: "block", fontSize: 12, color: "var(--navy-500)", marginTop: 2 }}>
                  {o.hint}
                </span>
              </span>
            </label>
          );
        })}
      </fieldset>
      {error && (
        <div
          role="alert"
          style={{
            marginTop: 12,
            padding: 8,
            borderRadius: 8,
            fontSize: 12,
            background: "rgba(228,70,70,0.1)",
            color: "#9F1F1F",
          }}
        >
          {error}
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
        <Button variant="ghost" onClick={onClose} disabled={pending}>
          Volver
        </Button>
        <Button variant="primary" onClick={submit} disabled={pending}>
          {pending ? "Archivando…" : copy.confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
