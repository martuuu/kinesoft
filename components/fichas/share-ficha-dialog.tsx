"use client";

/**
 * [FC-3e2] «Compartir con el paciente» (C-FC6, §24.5). DIFERIDO (§24.9): la tarjeta lo monta solo abierto, con
 * `next/dynamic`, así que cada apertura es una instancia nueva.
 *
 * - Clave de idempotencia POR INSTANCIA del diálogo (`useState(newIdempotencyKey)`): un doble click o un reintento
 *   dentro de la misma apertura es replay del server (no dos documentos ni dos mails); cerrar y abrir genera otra.
 * - Variantes: `first` (nunca compartida o revocada) y `reshare` (el documento vivo quedó desactualizado: se reemplaza
 *   por la versión actual, el server lo marca `REPLACED`).
 * - Después de compartir: con portal, listo (+ aviso aparte si el mail falló); sin portal (`patientPortal:
 *   "not-linked"`) se ofrece «Invitar al portal y compartir» (`sendPatientPortalInvite`, que ya existía); sin email
 *   cargado, se dice cómo seguir. El documento ya quedó compartido en los dos casos: el paciente lo ve al entrar.
 * - «Dejar de compartir» está en el menú de la tarjeta (FC-UI-D6), con `useConfirm`.
 *
 * Copy: `SHARE_COPY` (= SHARE_FICHA_COPY + las claves pendientes de handoff) y los rechazos tal cual los manda la
 * action (`PATIENT_DOCUMENT_COPY`).
 */
import { useState } from "react";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { newIdempotencyKey } from "@/components/clinical-notes/clinical-notes-ui";
import type { ShareFichaDialogProps } from "@/components/fichas/fichas-ui-types";
import {
  SHARE_COPY,
  sharedDocumentAfterShare,
  shareDialogVariant,
  shareOutcomeView,
  type ShareOutcomeView,
} from "@/components/fichas/ficha-card-logic";
import { shareClinicalNoteWithPatient } from "@/lib/patient-documents";
import { sendPatientPortalInvite } from "@/lib/patients";

export type ShareDialogPhase =
  | { step: "confirm"; error: string | null }
  | { step: "sharing" }
  | { step: "done"; view: ShareOutcomeView }
  | { step: "inviting"; view: Extract<ShareOutcomeView, { kind: "not-linked" }> };

export function ShareFichaDialog({ open, onClose, note, patient, onChanged }: ShareFichaDialogProps) {
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [notify, setNotify] = useState(true);
  const [phase, setPhase] = useState<ShareDialogPhase>({ step: "confirm", error: null });
  const toast = useToast();

  const share = async () => {
    setPhase({ step: "sharing" });
    let r: Awaited<ReturnType<typeof shareClinicalNoteWithPatient>>;
    try {
      r = await shareClinicalNoteWithPatient({ noteId: note.id, idempotencyKey, notify });
    } catch {
      setPhase({ step: "confirm", error: SHARE_COPY.shareNetwork });
      return;
    }
    if (!r.ok) {
      setPhase({ step: "confirm", error: r.error });
      return;
    }
    onChanged(sharedDocumentAfterShare(r.data.document));
    const view = shareOutcomeView(r.data, patient.email);
    if (view.kind === "linked") {
      toast.success(SHARE_COPY.shared, { description: view.message });
      if (view.warning) toast.warning(view.warning);
      onClose();
      return;
    }
    setPhase({ step: "done", view });
  };

  const invite = async (view: Extract<ShareOutcomeView, { kind: "not-linked" }>) => {
    setPhase({ step: "inviting", view });
    try {
      const r = await sendPatientPortalInvite({ patientId: patient.id });
      if (!r.ok) {
        toast.error(r.error);
        setPhase({ step: "done", view });
        return;
      }
      if (!r.data.emailSent) {
        toast.error(SHARE_COPY.inviteFailed);
        setPhase({ step: "done", view });
        return;
      }
      toast.success(SHARE_COPY.invited);
      onClose();
    } catch {
      toast.error(SHARE_COPY.inviteFailed);
      setPhase({ step: "done", view });
    }
  };

  const busy = phase.step === "sharing" || phase.step === "inviting";
  return (
    <Modal open={open} onClose={busy ? () => {} : onClose} title={SHARE_COPY.title} width={480} lockBackdrop={busy}>
      <ShareFichaContent
        variant={shareDialogVariant(note)}
        patientName={patient.name}
        notify={notify}
        onNotifyChange={setNotify}
        phase={phase}
        onShare={share}
        onInvite={invite}
        onClose={onClose}
      />
    </Modal>
  );
}

const textStyle: React.CSSProperties = { margin: 0, fontSize: 14, lineHeight: 1.5, color: "var(--navy-700)" };

/** Presentacional (lo prueba el render test sin red): cada variante y cada paso. */
export function ShareFichaContent({
  variant,
  patientName,
  notify,
  onNotifyChange,
  phase,
  onShare,
  onInvite,
  onClose,
}: {
  variant: "first" | "reshare";
  patientName: string;
  notify: boolean;
  onNotifyChange: (v: boolean) => void;
  phase: ShareDialogPhase;
  onShare: () => void;
  onInvite: (view: Extract<ShareOutcomeView, { kind: "not-linked" }>) => void;
  onClose: () => void;
}) {
  if (phase.step === "done" || phase.step === "inviting") {
    const view = phase.view;
    if (view.kind === "linked") return null; // con portal el diálogo se cierra con un toast
    const inviting = phase.step === "inviting";
    return (
      <div style={{ display: "grid", gap: 12 }} data-share-step="no-portal">
        <p role="status" style={{ ...textStyle, fontWeight: 600 }}>
          {view.message}
        </p>
        <p style={textStyle}>{SHARE_COPY.noPortal}</p>
        {view.noEmail && <p style={{ ...textStyle, color: "var(--warn-fg)" }}>{view.noEmail}</p>}
        <ModalActions>
          <Button type="button" variant="ghost" onClick={onClose} disabled={inviting}>
            {SHARE_COPY.close}
          </Button>
          {view.canInvite && (
            <Button type="button" variant="primary" onClick={() => onInvite(view)} disabled={inviting} aria-busy={inviting || undefined}>
              {inviting ? SHARE_COPY.inviting : SHARE_COPY.invite}
            </Button>
          )}
        </ModalActions>
      </div>
    );
  }
  const sharing = phase.step === "sharing";
  const error = phase.step === "confirm" ? phase.error : null;
  return (
    <div style={{ display: "grid", gap: 12 }} data-share-step={variant}>
      {patientName && <p style={{ ...textStyle, fontWeight: 600, color: "var(--navy-900)" }}>{patientName}</p>}
      <p style={textStyle}>{variant === "reshare" ? SHARE_COPY.reshareBody : SHARE_COPY.body}</p>
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, minHeight: 44, cursor: "pointer" }}>
        <input type="checkbox" checked={notify} onChange={(e) => onNotifyChange(e.target.checked)} disabled={sharing} />
        {SHARE_COPY.notify}
      </label>
      {error && (
        <p role="alert" style={{ ...textStyle, color: "var(--danger-fg)" }}>
          {error}
        </p>
      )}
      <ModalActions>
        <Button type="button" variant="ghost" onClick={onClose} disabled={sharing}>
          {SHARE_COPY.cancel}
        </Button>
        <Button type="button" variant="primary" onClick={onShare} disabled={sharing} aria-busy={sharing || undefined}>
          {sharing ? SHARE_COPY.sharing : variant === "reshare" ? SHARE_COPY.reshareConfirm : SHARE_COPY.confirm}
        </Button>
      </ModalActions>
    </div>
  );
}
