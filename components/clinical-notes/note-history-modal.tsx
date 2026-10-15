"use client";

/**
 * EV2-2e · Versiones anteriores de una evolución (las guarda el trigger de ClinicalNote en ClinicalNoteRevision al
 * editar contenido; la app nunca las escribe). Se cargan al abrir con `getClinicalNoteHistory` (C-EV2-5, más nueva
 * primero); null = sin acceso, y no se distingue de «no existe».
 *
 * EV2-Z: un rechazo (red, server caído) es `error`, NO `forbidden`: antes decía «No tenés acceso» y el usuario no
 * reintentaba algo que sí podía ver. El `error` ofrece reintentar.
 */
import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { KindTag } from "@/components/clinical-notes/kind-tag";
import {
  CLINICAL_NOTES_UI_COPY as COPY,
  noteDateLabel,
  revisionLabel,
} from "@/components/clinical-notes/clinical-notes-ui";
import { getClinicalNoteHistory } from "@/lib/clinical-notes-read";
import type { ClinicalNoteDTO, ClinicalNoteRevisionDTO } from "@/lib/clinical-notes-types";

export type HistoryState =
  | { status: "loading" }
  | { status: "forbidden" }
  | { status: "error" }
  | { status: "ready"; revisions: ClinicalNoteRevisionDTO[] };

export function NoteHistoryModal({ open, onClose, note }: { open: boolean; onClose: () => void; note: ClinicalNoteDTO }) {
  const [state, setState] = useState<HistoryState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setState({ status: "loading" });
    getClinicalNoteHistory(note.id)
      .then((r) => {
        if (alive) setState(r ? { status: "ready", revisions: r } : { status: "forbidden" });
      })
      .catch(() => {
        if (alive) setState({ status: "error" });
      });
    return () => {
      alive = false;
    };
    // `note.revision`: si se editó con el modal cerrado, al reabrir trae la versión nueva.
  }, [open, note.id, note.revision, attempt]);

  return (
    <Modal open={open} onClose={onClose} title={COPY.historyTitle} width={640}>
      <NoteHistoryContent note={note} state={state} onRetry={() => setAttempt((a) => a + 1)} />
    </Modal>
  );
}

const blockStyle: React.CSSProperties = {
  padding: "12px 14px",
  borderRadius: "var(--r-md)",
  background: "var(--card-bg)",
  border: "1px solid rgba(15,30,51,0.08)",
  display: "grid",
  gap: 6,
};
const bodyStyle: React.CSSProperties = { margin: 0, fontSize: 13, whiteSpace: "pre-wrap", color: "var(--navy-900)" };
const metaStyle: React.CSSProperties = { fontSize: 11, color: "var(--navy-400)" };

/** Presentacional (lo prueba el render test sin red): versión actual arriba y las anteriores, más nueva primero. */
export function NoteHistoryContent({
  note,
  state,
  onRetry,
}: {
  note: ClinicalNoteDTO;
  state: HistoryState;
  onRetry?: () => void;
}) {
  if (state.status === "loading") {
    return (
      <p role="status" style={metaStyle}>
        {COPY.historyLoading}
      </p>
    );
  }
  if (state.status === "forbidden") return <p style={{ fontSize: 13 }}>{COPY.historyForbidden}</p>;
  if (state.status === "error") {
    return (
      <div role="alert" style={{ display: "grid", gap: 8, justifyItems: "start" }}>
        <p style={{ fontSize: 13, margin: 0 }}>{COPY.historyError}</p>
        {onRetry && (
          <Button type="button" variant="ghost" onClick={onRetry}>
            {COPY.historyRetry}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <section style={{ ...blockStyle, borderColor: "var(--sky-300)" }} aria-label={COPY.historyCurrent}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <KindTag kind={note.kind} />
          <strong style={{ fontSize: 12 }}>
            {COPY.historyCurrent} · versión {note.revision}
          </strong>
        </div>
        {note.title && <strong style={{ fontSize: 14 }}>{note.title}</strong>}
        <span style={metaStyle}>{noteDateLabel(note.occurredAt)}</span>
        <p style={bodyStyle}>{note.body}</p>
      </section>
      {state.revisions.length === 0 ? (
        <p style={{ fontSize: 13, color: "var(--navy-500)" }}>{COPY.historyEmpty}</p>
      ) : (
        <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
          {state.revisions.map((r) => (
            <li key={r.revision} style={blockStyle}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <KindTag kind={r.kind} />
                <span style={metaStyle}>{revisionLabel(r)}</span>
              </div>
              {r.title && <strong style={{ fontSize: 14 }}>{r.title}</strong>}
              <span style={metaStyle}>{noteDateLabel(r.occurredAt)}</span>
              <p style={bodyStyle}>{r.body}</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
