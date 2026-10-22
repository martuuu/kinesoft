"use client";

/**
 * EV2-2e · Anular una ficha (EV2-D15): `Modal` con motivo obligatorio (3..500), nunca `window.confirm`. Anular no
 * borra: la nota queda colapsada con el motivo y quién la anuló. `expectedRevision` = la revisión que se ve en
 * pantalla: si otro la editó en el medio, la action responde `stale` y se muestra tal cual.
 *
 * El form vive dentro del Modal, que lo desmonta al cerrar: cada apertura empieza con el motivo vacío.
 *
 * T4-Z (revisor a):
 *   - M-1: anular (una raíz por trigger, una enmienda en la action) revoca lo compartido con el paciente. Si la ficha
 *     está compartida, el diálogo lo dice ANTES de confirmar. Una enmienda no trae `sharedDocument` (solo las raíces):
 *     quien abre el diálogo pasa `sharedWithPatient` con el estado de la raíz.
 *   - T4-Y: el aviso también dice que al paciente le llega un mail (sin contenido ni motivo) para pedirla de nuevo.
 *   - Mientras guarda, Esc y la X no cierran: cerrar en el medio dejaba la anulación corriendo sin que nadie viera el
 *     resultado (ni el `stale` ni el error).
 */
import { useCallback, useState } from "react";
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

/**
 * T4Z-M1: aviso de revocación (copy local: el de la UI de notas es de otra sesión). T4-Y: suma que al paciente le llega
 * un mail (`portal_document_revoked`). «Si tiene el portal vinculado» porque el diálogo no sabe si lo tiene y el mail va
 * solo a esa cuenta; «sin el contenido ni el motivo» para que quien anula sepa que lo que escribe abajo no le llega.
 */
export const VOID_SHARED_NOTICE = {
  root: "Esta ficha está compartida con el paciente: al anularla, deja de verla en su portal.",
  amendment:
    "Esta enmienda va en el documento compartido con el paciente: al anularla, deja de verlo en su portal. Para que vea la ficha sin la enmienda, compartila de nuevo.",
  mail: "Si tiene el portal vinculado, le avisamos por mail (sin el contenido ni el motivo) que el documento ya no está y que lo puede pedir de nuevo.",
} as const;

export function VoidNoteDialog({
  open,
  onClose,
  note,
  onVoided,
  sharedWithPatient,
}: {
  open: boolean;
  onClose: () => void;
  note: ClinicalNoteDTO;
  onVoided: (note: ClinicalNoteDTO) => void;
  /** Enmienda: ¿la raíz tiene un documento compartido vivo? (una raíz lo trae en `note.sharedDocument`). */
  sharedWithPatient?: boolean;
}) {
  const [saving, setSaving] = useState(false);
  // Esc y la X pasan por acá: guardando, no cierran (el botón «Cancelar» ya está deshabilitado).
  const guardedClose = useCallback(() => {
    if (!saving) onClose();
  }, [saving, onClose]);
  return (
    // lockBackdrop: un click de más afuera no tira el motivo escrito (Esc y la X cierran, salvo guardando).
    <Modal open={open} onClose={guardedClose} title={COPY.voidTitle} description={COPY.voidDescription} lockBackdrop>
      <VoidNoteForm note={note} onCancel={onClose} onVoided={onVoided} sharedWithPatient={sharedWithPatient} onSavingChange={setSaving} />
    </Modal>
  );
}

export function VoidNoteForm({
  note,
  onCancel,
  onVoided,
  sharedWithPatient,
  onSavingChange,
}: {
  note: ClinicalNoteDTO;
  onCancel: () => void;
  onVoided: (note: ClinicalNoteDTO) => void;
  sharedWithPatient?: boolean;
  onSavingChange?: (saving: boolean) => void;
}) {
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSavingState] = useState(false);
  const setSaving = (v: boolean) => {
    setSavingState(v);
    onSavingChange?.(v);
  };
  const isAmendment = note.amendsNoteId !== null;
  const shared = isAmendment
    ? sharedWithPatient === true
    : note.sharedDocument !== null && note.sharedDocument.status !== "none";

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
      {shared && (
        <p
          data-testid="void-shared-notice"
          style={{
            margin: 0,
            padding: "10px 12px",
            borderRadius: "var(--r-sm)",
            background: "var(--sky-50)",
            border: "1px solid var(--sky-200)",
            fontSize: 13,
            color: "var(--navy-700)",
          }}
        >
          {isAmendment ? VOID_SHARED_NOTICE.amendment : VOID_SHARED_NOTICE.root} {VOID_SHARED_NOTICE.mail}
        </p>
      )}
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
          style={{ textAlign: "right", fontSize: 11, marginTop: 4, color: "var(--navy-500)", fontVariantNumeric: "tabular-nums" }}
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
