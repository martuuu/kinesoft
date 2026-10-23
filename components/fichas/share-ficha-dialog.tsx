"use client";

/**
 * [FC-3e2] «Compartir con el paciente» (C-FC6, §24.5). DIFERIDO (§24.9): la tarjeta lo monta solo abierto, con
 * `next/dynamic`, así que cada apertura es una instancia nueva.
 *
 * - Clave de idempotencia POR INSTANCIA del diálogo (`useState(newIdempotencyKey)`): un doble click o un reintento
 *   dentro de la misma apertura es replay del server (no dos documentos ni dos mails); cerrar y abrir genera otra.
 * - Variantes: `first` (nunca compartida o revocada) y `reshare` (el documento vivo quedó desactualizado: se reemplaza
 *   por la versión actual, el server lo marca `REPLACED`).
 * - Antes de confirmar (T4-Z A2/M-3, `shareConfirmView`): sin email del paciente ni cuenta del portal conocida, la
 *   casilla del mail no aparece, se avisa antes y se comparte sin aviso; con la cuenta del portal se muestra su email
 *   ENMASCARADO (`getPatientPortalShareInfo` al abrir; el completo nunca viaja), para que se vea a quién le llega. Si
 *   esa lectura falla o tarda, el diálogo funciona igual con lo que sabe del paciente.
 * - Después de compartir: con portal, listo (+ aviso aparte si el mail falló); sin portal (`patientPortal:
 *   "not-linked"`) se ofrece «Invitar al portal» (`sendPatientPortalInvite`, que ya existía); sin email cargado, se
 *   dice cómo seguir. El documento ya quedó compartido en los dos casos: el paciente lo ve al entrar.
 * - «Dejar de compartir» está en el menú de la tarjeta (FC-UI-D6), con `useConfirm`.
 *
 * Copy: `SHARE_COPY` (= SHARE_FICHA_COPY + las claves pendientes de handoff) y los rechazos tal cual los manda la
 * action (`PATIENT_DOCUMENT_COPY`).
 *
 * WA-U3 (T6, brief §26.5 «Compartir ficha»): «Enviar también por WhatsApp», solo si el consultorio tiene WhatsApp
 * activo y el paciente tiene el consentimiento vigente (`getPatientWhatsAppShareInfo`, leída al abrir junto con la del
 * portal; con `WHATSAPP_MODE=off` el server no lee nada). Tildarla exige la casilla «El paciente pidió recibirlo por
 * WhatsApp»: el documento es clínico y la plantilla no lo dice, así que el staff deja constancia de que lo pidió (el
 * server lo audita y falla cerrado). La action se importa diferida: el diálogo ya es diferido y la lectura es rara.
 * Mismo gate que compartir: la Secretaría no llega a este diálogo (no tiene «Compartir») y la lectura lo re-chequea.
 */
import { useEffect, useState } from "react";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { newIdempotencyKey } from "@/components/clinical-notes/clinical-notes-ui";
import type { ShareFichaDialogProps } from "@/components/fichas/fichas-ui-types";
import { SHARE_FICHA_COPY as SHARE_COPY } from "@/components/fichas/fichas-copy";
import {
  shareConfirmView,
  sharedDocumentAfterShare,
  shareDialogVariant,
  shareOutcomeView,
  type PortalShareInfo,
  type ShareOutcomeView,
} from "@/components/fichas/ficha-share-download-logic";
import { getPatientPortalShareInfo, shareClinicalNoteWithPatient } from "@/lib/patient-documents";
import { sendPatientPortalInvite } from "@/lib/patients";
import type { DocumentDeliveryOutcome } from "@/lib/patient-documents-types";
import { WA_COPY } from "@/lib/whatsapp/copy";

/**
 * WA-E (T6, X8): el import diferido de la action va a NIVEL DE MÓDULO y no adentro del `useEffect`. Next 14 borra los
 * `useEffect` del build de SSR (optimizeServerReact), y el registro de Server Actions recorre ESE grafo: con el
 * `import()` adentro del efecto, `lib/whatsapp-patient-ui` no quedaba en el manifest y el server contestaba «Failed to
 * find Server Action» (la fila de WhatsApp decía «No pudimos leer el estado…» y compartir nunca ofrecía WhatsApp).
 * Lo fija `tests/unit/server-action-dynamic-imports.test.ts`.
 */
const loadWhatsAppPatientUi = () => import("@/lib/whatsapp-patient-ui");

/** WA-U3: textos del envío por WhatsApp de la ficha (voseo). */
export const SHARE_WA_COPY = {
  send: "Enviar también por WhatsApp",
  attestHint: "Marcá que el paciente lo pidió para poder mandarlo por WhatsApp.",
  sent: "También se lo mandamos por WhatsApp.",
  queued: "El WhatsApp quedó en cola: sale en unos minutos.",
  skipped:
    "No se mandó por WhatsApp: el paciente no tiene los avisos activos, la plantilla de documentos no está aprobada o ya se mandaron varios avisos hoy. El documento quedó compartido igual.",
  failed: "No se pudo mandar por WhatsApp. El documento quedó compartido igual; probá de nuevo más tarde.",
} as const;

/** WA-U3: qué pasó con el WhatsApp (`whatsappDelivery`). null = no se pidió (o fue un replay). */
export function waShareResultMessage(
  d: DocumentDeliveryOutcome | null | undefined,
): { tone: "success" | "info" | "warning" | "error"; text: string } | null {
  if (!d) return null;
  switch (d.status) {
    case "sent":
      return { tone: "success", text: SHARE_WA_COPY.sent };
    case "queued":
      return { tone: "info", text: SHARE_WA_COPY.queued };
    case "failed":
      return { tone: "error", text: SHARE_WA_COPY.failed };
    default:
      // `skipped` (y `no-portal-user`, que WhatsApp no devuelve): el server no dice el motivo exacto a propósito (el
      // cupo por paciente es compartido con el mail); se nombran los posibles.
      return { tone: "warning", text: SHARE_WA_COPY.skipped };
  }
}

/** WA-U3: estado de la opción de WhatsApp en el paso de confirmar. Ausente = sin WhatsApp. */
export type ShareWaOption = {
  available: boolean;
  send: boolean;
  attested: boolean;
  onSendChange: (v: boolean) => void;
  onAttestedChange: (v: boolean) => void;
};

export type ShareDialogPhase =
  | { step: "confirm"; error: string | null }
  | { step: "sharing" }
  | { step: "done"; view: ShareOutcomeView; wa?: ReturnType<typeof waShareResultMessage> }
  | { step: "inviting"; view: Extract<ShareOutcomeView, { kind: "not-linked" }>; wa?: ReturnType<typeof waShareResultMessage> };

export function ShareFichaDialog({
  open,
  onClose,
  note,
  patient,
  onChanged,
}: ShareFichaDialogProps) {
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [notify, setNotify] = useState(true);
  const [phase, setPhase] = useState<ShareDialogPhase>({ step: "confirm", error: null });
  const toast = useToast();
  const [portalInfo, setPortalInfo] = useState<PortalShareInfo | null>(null);
  const confirmView = shareConfirmView(patient.email, portalInfo);
  // WA-U3: false hasta que la lectura diga que sí (si falla o tarda, se comparte como siempre, sin la opción).
  const [waAvailable, setWaAvailable] = useState(false);
  const [waOn, setWaOn] = useState(false);
  const [waAttested, setWaAttested] = useState(false);

  useEffect(() => {
    let alive = true;
    getPatientPortalShareInfo({ patientId: patient.id })
      .then((r) => {
        if (alive && r.ok) setPortalInfo({ portal: r.data.portal, maskedEmail: r.data.maskedEmail });
      })
      .catch(() => {});
    loadWhatsAppPatientUi()
      .then((m) => m.getPatientWhatsAppShareInfo({ patientId: patient.id }))
      .then((r) => {
        if (alive && r.ok) setWaAvailable(r.data.available);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [patient.id]);

  const share = async () => {
    setPhase({ step: "sharing" });
    let r: Awaited<ReturnType<typeof shareClinicalNoteWithPatient>>;
    try {
      r = await shareClinicalNoteWithPatient({
        noteId: note.id,
        idempotencyKey,
        notify: confirmView.showNotify && notify,
        whatsapp: waOn && waAttested ? { attested: true } : undefined,
      });
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
    const wa = waShareResultMessage(r.data.whatsappDelivery);
    if (view.kind === "linked") {
      toast.success(SHARE_COPY.shared, { description: view.message });
      if (view.warning) toast.warning(view.warning);
      if (wa) toast[wa.tone](wa.text);
      onClose();
      return;
    }
    setPhase({ step: "done", view, wa });
  };

  const invite = async (view: Extract<ShareOutcomeView, { kind: "not-linked" }>) => {
    const wa = phase.step === "done" ? phase.wa : undefined;
    setPhase({ step: "inviting", view, wa });
    try {
      const r = await sendPatientPortalInvite({ patientId: patient.id });
      if (!r.ok) {
        toast.error(r.error);
        setPhase({ step: "done", view, wa });
        return;
      }
      if (!r.data.emailSent) {
        toast.error(SHARE_COPY.inviteFailed);
        setPhase({ step: "done", view, wa });
        return;
      }
      toast.success(SHARE_COPY.invited);
      onClose();
    } catch {
      toast.error(SHARE_COPY.inviteFailed);
      setPhase({ step: "done", view, wa });
    }
  };

  const busy = phase.step === "sharing" || phase.step === "inviting";
  return (
    <Modal open={open} onClose={busy ? () => {} : onClose} title={SHARE_COPY.title} width={480} lockBackdrop={busy}>
      <ShareFichaContent
        variant={shareDialogVariant(note)}
        patientName={patient.name}
        confirmView={confirmView}
        notify={notify}
        onNotifyChange={setNotify}
        wa={
          waAvailable
            ? {
                available: true,
                send: waOn,
                attested: waAttested,
                onSendChange: (v) => {
                  setWaOn(v);
                  // Destildar el envío borra la constancia: volver a tildarlo la vuelve a pedir.
                  if (!v) setWaAttested(false);
                },
                onAttestedChange: setWaAttested,
              }
            : undefined
        }
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
  confirmView = { showNotify: true, noEmail: null, portalAccount: null },
  notify,
  onNotifyChange,
  wa,
  phase,
  onShare,
  onInvite,
  onClose,
}: {
  variant: "first" | "reshare";
  patientName: string;
  confirmView?: ReturnType<typeof shareConfirmView>;
  notify: boolean;
  onNotifyChange: (v: boolean) => void;
  /** WA-U3: ausente o `available: false` = sin la opción de WhatsApp. */
  wa?: ShareWaOption;
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
        {view.noEmail && <p style={{ ...textStyle, color: "var(--warn-fg)" }}>{view.noEmail}</p>}
        {phase.wa && (
          <p
            data-share-wa={phase.wa.tone}
            style={{ ...textStyle, color: phase.wa.tone === "warning" ? "var(--warn-fg)" : phase.wa.tone === "error" ? "var(--danger-fg)" : textStyle.color }}
          >
            {phase.wa.text}
          </p>
        )}
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
  const waShown = !!wa?.available;
  // Casilla obligatoria: con «Enviar también por WhatsApp» tildada, no se comparte sin la constancia.
  const waBlocks = waShown && wa!.send && !wa!.attested;
  return (
    <div style={{ display: "grid", gap: 12 }} data-share-step={variant}>
      {patientName && <p style={{ ...textStyle, fontWeight: 600, color: "var(--navy-900)" }}>{patientName}</p>}
      <p style={textStyle}>{variant === "reshare" ? SHARE_COPY.reshareBody : SHARE_COPY.body}</p>
      {confirmView.portalAccount && (
        <p style={textStyle} data-share-portal-account="">
          {confirmView.portalAccount}
        </p>
      )}
      {confirmView.noEmail && <p style={{ ...textStyle, color: "var(--warn-fg)" }}>{confirmView.noEmail}</p>}
      {confirmView.showNotify && (
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, minHeight: 44, cursor: "pointer" }}>
          <input type="checkbox" checked={notify} onChange={(e) => onNotifyChange(e.target.checked)} disabled={sharing} />
          {SHARE_COPY.notify}
        </label>
      )}
      {waShown && (
        <div style={{ display: "grid", gap: 4 }} data-share-wa-option="">
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, minHeight: 44, cursor: "pointer" }}>
            <input type="checkbox" checked={wa!.send} onChange={(e) => wa!.onSendChange(e.target.checked)} disabled={sharing} />
            {SHARE_WA_COPY.send}
          </label>
          {wa!.send && (
            <>
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, minHeight: 44, cursor: "pointer", paddingLeft: 24 }}>
                <input
                  type="checkbox"
                  required
                  aria-describedby={waBlocks ? "share-wa-attest-hint" : undefined}
                  checked={wa!.attested}
                  onChange={(e) => wa!.onAttestedChange(e.target.checked)}
                  disabled={sharing}
                />
                {WA_COPY.shareByWhatsApp}
              </label>
              {waBlocks && (
                <p id="share-wa-attest-hint" style={{ ...textStyle, fontSize: 12, color: "var(--navy-500)", paddingLeft: 24 }}>
                  {SHARE_WA_COPY.attestHint}
                </p>
              )}
            </>
          )}
        </div>
      )}
      {error && (
        <p role="alert" style={{ ...textStyle, color: "var(--danger-fg)" }}>
          {error}
        </p>
      )}
      <ModalActions>
        <Button type="button" variant="ghost" onClick={onClose} disabled={sharing}>
          {SHARE_COPY.cancel}
        </Button>
        <Button type="button" variant="primary" onClick={onShare} disabled={sharing || waBlocks} aria-busy={sharing || undefined}>
          {sharing ? SHARE_COPY.sharing : variant === "reshare" ? SHARE_COPY.reshareConfirm : SHARE_COPY.confirm}
        </Button>
      </ModalActions>
    </div>
  );
}
