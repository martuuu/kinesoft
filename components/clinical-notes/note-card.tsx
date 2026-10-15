"use client";

/**
 * EV2-2e · Tarjeta de una evolución (raíz con sus enmiendas debajo). La usan el perfil (línea de tiempo), el drawer
 * del turno y Seguimiento (EV2-3).
 *
 * - Botones según `note.permissions` (los calcula el server con `permissionsFor`; la UI solo esconde, la barrera es la
 *   action). «Editar» se esconde solo si la pantalla quedó abierta más allá de `editableUntil` (`noteActions`).
 * - Anulada (EV2-D23): colapsada en un `<details>` nativo (sin animación: con reducedMotion el estado final es el
 *   mismo) con el motivo, quién la anuló y el autor; el texto queda adentro, atenuado y sin tachar: sigue siendo HC.
 * - El estado lo maneja el caller: `onNoteChange` (reemplazar por id, raíz o enmienda) y `onAmendmentAdded`.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { KindTag } from "@/components/clinical-notes/kind-tag";
import { NoteEditorDrawer } from "@/components/clinical-notes/note-editor-drawer";
import { VoidNoteDialog } from "@/components/clinical-notes/void-note-dialog";
import { NoteHistoryModal } from "@/components/clinical-notes/note-history-modal";
import {
  CLINICAL_NOTES_UI_COPY as COPY,
  authorLine,
  bookingLabel,
  editableUntilLabel,
  noteActions,
  noteDateLabel,
  voidedSummary,
} from "@/components/clinical-notes/clinical-notes-ui";
import type { ClinicalNoteDTO } from "@/lib/clinical-notes-types";

export type NoteCardProps = {
  note: ClinicalNoteDTO;
  amendments?: ClinicalNoteDTO[];
  /** Una nota cambió (editada o anulada): reemplazarla por id. Vale para la raíz y para sus enmiendas. */
  onNoteChange?: (note: ClinicalNoteDTO) => void;
  /** Se agregó una enmienda a esta raíz. */
  onAmendmentAdded?: (amendment: ClinicalNoteDTO) => void;
  /** Esconde la línea «Turno del …» (p. ej. dentro del drawer del turno, donde es redundante). */
  hideBooking?: boolean;
  /** Solo tests: reloj fijo. */
  now?: Date;
  /** Interno: la tarjeta de una enmienda (sin enmiendas propias, más compacta). */
  variant?: "root" | "amendment";
};

const metaStyle: React.CSSProperties = { fontSize: 12, color: "var(--navy-400)" };
const bodyStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 14,
  lineHeight: 1.5,
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
  color: "var(--navy-900)",
};

export function NoteCard({
  note,
  amendments = [],
  onNoteChange,
  onAmendmentAdded,
  hideBooking = false,
  now: nowProp,
  variant = "root",
}: NoteCardProps) {
  const [editor, setEditor] = useState<"edit" | "amend" | null>(null);
  const [voidOpen, setVoidOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const now = nowProp ?? new Date();
  const isAmendment = variant === "amendment";

  const shellStyle: React.CSSProperties = isAmendment
    ? { paddingLeft: 12, borderLeft: "3px solid var(--sky-200)", display: "grid", gap: 6 }
    : {
        padding: 16,
        borderRadius: "var(--r-md)",
        background: "var(--card-bg)",
        border: "1px solid rgba(15,30,51,0.08)",
        display: "grid",
        gap: 8,
      };

  const amendmentList =
    amendments.length > 0 ? (
      <div style={{ display: "grid", gap: 10, marginTop: 4 }}>
        {amendments.map((a) => (
          <NoteCard key={a.id} note={a} variant="amendment" onNoteChange={onNoteChange} now={nowProp} hideBooking />
        ))}
      </div>
    ) : null;

  if (note.voided) {
    return (
      <article style={{ ...shellStyle, opacity: 0.85 }} data-note-id={note.id} data-voided="">
        <details>
          <summary style={{ cursor: "pointer", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {isAmendment ? (
              <strong style={{ fontSize: 12 }}>{COPY.amendmentLabel}</strong>
            ) : (
              <KindTag kind={note.kind} />
            )}
            <span className="k-tag k-tag-soft" style={{ textTransform: "none" }}>
              {COPY.voidedBadge}
            </span>
            <span style={metaStyle}>
              {noteDateLabel(note.occurredAt)} · {note.author.name}
            </span>
          </summary>
          <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
            <p style={{ margin: 0, fontSize: 13 }}>
              <strong>Motivo:</strong> {note.voided.reason}
            </p>
            <span style={metaStyle}>{voidedSummary(note)}</span>
            {note.title && <strong style={{ fontSize: 14, color: "var(--navy-500)" }}>{note.title}</strong>}
            <p style={{ ...bodyStyle, color: "var(--navy-500)" }}>{note.body}</p>
          </div>
        </details>
        {amendmentList}
      </article>
    );
  }

  const actions = noteActions(note, now);
  const until = editableUntilLabel(note, now);
  const booking = hideBooking ? null : bookingLabel(note.booking);
  const anyAction = actions.edit || actions.amend || actions.void || actions.history;

  return (
    <article style={shellStyle} data-note-id={note.id}>
      <header style={{ display: "grid", gap: 4 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {isAmendment ? (
            <strong style={{ fontSize: 12, color: "var(--sky-700)" }}>{COPY.amendmentLabel}</strong>
          ) : (
            <KindTag kind={note.kind} />
          )}
          <span style={metaStyle}>{noteDateLabel(isAmendment ? note.createdAt : note.occurredAt)}</span>
        </div>
        {note.title && <strong style={{ fontSize: isAmendment ? 14 : 15 }}>{note.title}</strong>}
        <span style={metaStyle}>
          {authorLine(note)}
          {booking ? ` · ${booking}` : ""}
        </span>
      </header>

      <p style={bodyStyle}>{note.body}</p>

      {until && (
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--sky-700)" }} data-testid="editable-until">
          {until}
        </span>
      )}

      {anyAction && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {actions.edit && (
            <Button type="button" variant="ghost" onClick={() => setEditor("edit")}>
              {COPY.edit}
            </Button>
          )}
          {actions.amend && (
            <Button type="button" variant="ghost" onClick={() => setEditor("amend")}>
              {COPY.amend}
            </Button>
          )}
          {actions.history && (
            <Button type="button" variant="ghost" onClick={() => setHistoryOpen(true)}>
              {COPY.history}
            </Button>
          )}
          {actions.void && (
            <Button type="button" variant="ghost" onClick={() => setVoidOpen(true)} style={{ color: "#9F1F1F" }}>
              {COPY.void}
            </Button>
          )}
        </div>
      )}

      {amendmentList}

      {editor && (
        <NoteEditorDrawer
          open
          onClose={() => setEditor(null)}
          mode={{ type: editor, note }}
          onSaved={(saved, info) => {
            if (info.type === "amend") onAmendmentAdded?.(saved);
            else onNoteChange?.(saved);
          }}
        />
      )}
      {actions.void && (
        <VoidNoteDialog open={voidOpen} onClose={() => setVoidOpen(false)} note={note} onVoided={(n) => onNoteChange?.(n)} />
      )}
      {actions.history && <NoteHistoryModal open={historyOpen} onClose={() => setHistoryOpen(false)} note={note} />}
    </article>
  );
}
