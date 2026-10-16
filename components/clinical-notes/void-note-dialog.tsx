"use client";

/**
 * EV2-2e · Anular una evolución (EV2-D15): `Modal` con motivo obligatorio (3..500), nunca `window.confirm`. Anular no
 * borra: la nota queda colapsada con el motivo y quién la anuló. `expectedRevision` = la revisión que se ve en
 * pantalla: si otro la editó en el medio, la action responde `stale` y se muestra tal cual.
 *
 * El form vive dentro del Modal, que lo desmonta al cerrar: cada apertura empieza con el motivo vacío.
 */
import { useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { useToast } from "@/components/ui/toast";
import {
  CLINICAL_NOTES_UI_COPY as COPY,
  noteDateLabel,
  voidReasonCounter,
  voidReasonError,
} from "@/components/clinical-notes/clinical-notes-ui";
import { voidClinicalNote } from "@/lib/clinical-notes";
import { CLINICAL_NOTE_KIND_LABEL, type ClinicalNoteDTO } from "@/lib/clinical-notes-types";

export function VoidNoteDialog({
  open,
  onClose,
  note,
  onVoided,
}: {
  open: boolean;
  onClose: () => void;
  note: ClinicalNoteDTO;
  onVoided: (note: ClinicalNoteDTO) => void;
}) {
  return (
    // lockBackdrop: un click de más afuera no tira el motivo escrito (Esc y la X siguen cerrando).
    <Modal open={open} onClose={onClose} title={COPY.voidTitle} description={COPY.voidDescription} lockBackdrop>
      <VoidNoteForm note={note} onCancel={onClose} onVoided={onVoided} />
    </Modal>
  );
}

export function VoidNoteForm({
  note,
  onCancel,
  onVoided,
}: {
  note: ClinicalNoteDTO;
  onCancel: () => void;
  onVoided: (note: ClinicalNoteDTO) => void;
}) {
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    const err = voidReasonError(reason);
    setError(err);
    if (err) return;
    setServerError(null);
    setSaving(true);
    try {
      const res = await voidClinicalNote({ noteId: note.id, expectedRevision: note.revision, reason: reason.trim() });
      if (!res.ok) return setServerError(res.error);
      toast.success(COPY.voided);
      onVoided(res.data.note);
      onCancel();
    } catch {
      setServerError("No se pudo anular. Revisá la conexión y probá de nuevo.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate style={{ display: "grid", gap: 12 }}>
      <p style={{ margin: 0, fontSize: 13, color: "var(--navy-700)" }}>
        {CLINICAL_NOTE_KIND_LABEL[note.kind]} del {noteDateLabel(note.occurredAt)} · {note.author.name}
      </p>
      <div>
        <FormField
          as="textarea"
          label={COPY.voidReasonLabel}
          required
          rows={3}
          value={reason}
          onChange={(v) => {
            setReason(v);
            if (error) setError(null);
          }}
          placeholder={COPY.voidReasonPlaceholder}
          error={error ?? undefined}
          disabled={saving}
          autoFocus
        />
        <div
          data-testid="void-counter"
          style={{ textAlign: "right", fontSize: 11, marginTop: 4, color: "var(--navy-300)", fontVariantNumeric: "tabular-nums" }}
        >
          {voidReasonCounter(reason)}
        </div>
      </div>
      {serverError && (
        <div
          role="alert"
          style={{
            padding: "10px 12px",
            borderRadius: "var(--r-sm)",
            background: "var(--danger-bg)",
            border: "1px solid var(--danger-border)",
            fontSize: 13,
          }}
        >
          {serverError}
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
          {COPY.cancel}
        </Button>
        <Button
          type="submit"
          disabled={saving}
          // Mismo rojo que el `useConfirm` con tone="danger": anular es irreversible.
          style={{ background: "var(--danger-fg)", boxShadow: "0 4px 14px rgba(159,31,31,0.3)" }}
        >
          {saving ? COPY.voiding : COPY.voidConfirm}
        </Button>
      </div>
    </form>
  );
}
