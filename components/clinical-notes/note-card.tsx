"use client";

/**
 * Tarjeta de una ficha (raíz con sus enmiendas debajo). La usan la HC del perfil (timeline), el drawer del turno y
 * Seguimiento. EV2-2e la creó; FC-3e2 (T4, §24.7 «Tarjeta y menú») le sumó:
 *
 * - Chips «Importada», «Carga tardía», «Compartida», «Compartida · desactualizada» (`fichaChips`).
 * - Diagnósticos congelados (el primero es el principal) y el autor con matrícula («Lic. Pérez · MN 1234»).
 * - Cuerpo con formato (`HcBody` → `HcDocView` si hay `bodyDoc`, texto plano si no), PLEGABLE cuando es largo:
 *   se pinta completo en el SSR y se recorta con CSS, así el texto está en el DOM (buscador del navegador, lector de
 *   pantalla) y «Ver todo» no espera un fetch.
 * - Menú «⋯» (PDF · Word · Guardar en la carpeta · Compartir / Compartir la versión actual / Dejar de compartir ·
 *   Enmendar · Versiones · Anular). El botón es estático; el PANEL, el diálogo de compartir y los de EV2 se bajan
 *   recién al usarlos (§24.9: el first load de `/pacientes/[id]` tiene tope de 175 kB). «Editar» queda a la vista:
 *   dentro de las 24 h es lo que el autor hace casi siempre (EV2-D14).
 *
 * Reglas que siguen de EV2 (no se tocan): botones según `note.permissions` (la UI solo esconde, la barrera es la
 * action); «Editar» se esconde si la pantalla quedó abierta más allá de `editableUntil`; anulada colapsada en un
 * `<details>` nativo con el motivo, sin menú. El estado lo maneja el caller con `onNoteChange` (reemplazar por id,
 * raíz o enmienda, también cuando cambia `sharedDocument`) y `onAmendmentAdded`.
 */
import { useCallback, useId, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/tag";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { KindTag } from "@/components/clinical-notes/kind-tag";
import { HcBody } from "@/components/hc/hc-doc-view";
import {
  CARD_COPY,
  SHARE_COPY,
  diagnosisChips,
  fichaAuthorLine,
  fichaBackupTarget,
  fichaChips,
  fichaMenuItems,
  fichaRootId,
  isFoldableBody,
  type FichaCardContext,
  type FichaMenuItemId,
} from "@/components/fichas/ficha-card-logic";
import { BACKUP_COPY, DIAGNOSIS_FIELD_COPY } from "@/components/fichas/fichas-copy";
import { downloadFicha } from "@/components/fichas/download";

/*
 * PF1.1 (C-PF2): editor, anular e historial se bajan recién al abrirlos (solo existen después de un click; por eso
 * `ssr: false` y se montan solo abiertos). FC-3e2: lo mismo para el panel del menú y `ShareFichaDialog`.
 */
const NoteEditorDrawer = dynamic(
  () => import("@/components/clinical-notes/note-editor-drawer").then((m) => m.NoteEditorDrawer),
  { ssr: false, loading: () => null }
);
const VoidNoteDialog = dynamic(
  () => import("@/components/clinical-notes/void-note-dialog").then((m) => m.VoidNoteDialog),
  { ssr: false, loading: () => null }
);
const NoteHistoryModal = dynamic(
  () => import("@/components/clinical-notes/note-history-modal").then((m) => m.NoteHistoryModal),
  { ssr: false, loading: () => null }
);
/** Se precarga al pasar el mouse o enfocar «⋯»: así el primer click abre sin esperar el chunk. */
const loadFichaMenu = () => import("@/components/fichas/ficha-menu");
const FichaMenu = dynamic(() => loadFichaMenu().then((m) => m.FichaMenu), { ssr: false, loading: () => null });
const ShareFichaDialog = dynamic(
  () => import("@/components/fichas/share-ficha-dialog").then((m) => m.ShareFichaDialog),
  { ssr: false, loading: () => null }
);
import {
  CLINICAL_NOTES_UI_COPY as COPY,
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
  /** Una nota cambió (editada, anulada, compartida o dejada de compartir): reemplazarla por id. Raíz o enmienda. */
  onNoteChange?: (note: ClinicalNoteDTO) => void;
  /** Se agregó una enmienda a esta raíz. */
  onAmendmentAdded?: (amendment: ClinicalNoteDTO) => void;
  /** Esconde la línea «Turno del …» (p. ej. dentro del drawer del turno, donde es redundante). */
  hideBooking?: boolean;
  /**
   * [FC-3e2] Paciente y respaldo. Lo pasa la HC del perfil; sin él (drawer del turno, Seguimiento) no se ofrecen
   * «Compartir» ni «Guardar en la carpeta» (hacen falta nombre, email y DNI).
   */
  context?: FichaCardContext | null;
  /** Solo tests: reloj fijo. */
  now?: Date;
  /** Interno: la tarjeta de una enmienda (sin enmiendas propias, más compacta). */
  variant?: "root" | "amendment";
  /** Interno: la raíz de una enmienda (el respaldo se sobrescribe por la raíz, que incluye sus enmiendas). */
  root?: ClinicalNoteDTO;
};

const metaStyle: React.CSSProperties = { fontSize: 12, color: "var(--navy-400)" };
const bodyColor: React.CSSProperties = { color: "var(--navy-900)" };

export function NoteCard({
  note,
  amendments = [],
  onNoteChange,
  onAmendmentAdded,
  hideBooking = false,
  context = null,
  now: nowProp,
  variant = "root",
  root,
}: NoteCardProps) {
  const [editor, setEditor] = useState<"edit" | "amend" | null>(null);
  const [voidOpen, setVoidOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();
  const toast = useToast();
  const confirm = useConfirm();
  const now = nowProp ?? new Date();
  const isAmendment = variant === "amendment";
  const rootNote = isAmendment ? root ?? null : note;
  const backup = context?.backup ?? null;

  /**
   * §24.6: el respaldo se sobrescribe al editar, enmendar o anular EN ESTE dispositivo. Solo con la carpeta ya
   * `ready`: acá no hay gesto del usuario para pedir permiso (pasó un await de la action), y si caducó se re-pide la
   * próxima vez que elija «Guardar en la carpeta». Falla en silencio salvo un toast: la ficha ya quedó guardada.
   */
  const refreshBackup = useCallback(
    (changedRoot: ClinicalNoteDTO | null) => {
      if (!changedRoot || !context || backup?.status !== "ready") return;
      void backup.save(fichaBackupTarget(changedRoot, context.patient)).then((o) => {
        if (!o.ok) toast.error(BACKUP_COPY.failed);
      });
    },
    [backup, context, toast]
  );

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
          <NoteCard
            key={a.id}
            note={a}
            variant="amendment"
            root={note}
            context={context}
            onNoteChange={onNoteChange}
            now={nowProp}
            hideBooking
          />
        ))}
      </div>
    ) : null;

  if (note.voided) {
    // EV2-Z bajo: las versiones anteriores de una anulada también son HC; se ofrecen dentro del details.
    const voidedHistory = note.revision > 1;
    return (
      <article style={{ ...shellStyle, opacity: 0.85 }} data-note-id={note.id} data-voided="">
        <details>
          <summary style={{ cursor: "pointer", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {isAmendment ? (
              <strong style={{ fontSize: 12 }}>{COPY.amendmentLabel}</strong>
            ) : (
              <KindTag kind={note.kind} />
            )}
            {/* vx-note-card-tag (PF1.1): la primitiva, como `KindTag` (antes borde inline). */}
            <Tag tone="soft" variant="outline">
              {COPY.voidedBadge}
            </Tag>
            <span style={metaStyle}>
              {noteDateLabel(note.occurredAt)} · {note.author.name}
            </span>
            {/* EV2-Z M9: sin esto el summary no decía que se despliega ni qué hay adentro. */}
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--sky-700)" }}>{COPY.voidedShowText}</span>
          </summary>
          <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
            <p style={{ margin: 0, fontSize: 13 }}>
              <strong>Motivo:</strong> {note.voided.reason}
            </p>
            <span style={metaStyle}>{voidedSummary(note)}</span>
            {note.title && <strong style={{ fontSize: 14, color: "var(--navy-500)" }}>{note.title}</strong>}
            {/* Atenuado y sin tachar: sigue siendo HC. */}
            <div style={{ color: "var(--navy-500)" }}>
              <HcBody doc={note.bodyDoc} text={note.body} headingOffset={1} />
            </div>
            {voidedHistory && (
              <div>
                <Button type="button" variant="ghost" onClick={() => setHistoryOpen(true)}>
                  {COPY.history}
                </Button>
              </div>
            )}
          </div>
        </details>
        {amendmentList}
        {voidedHistory && historyOpen && <NoteHistoryModal open onClose={() => setHistoryOpen(false)} note={note} />}
      </article>
    );
  }

  const actions = noteActions(note, now);
  const until = editableUntilLabel(note, now);
  const booking = hideBooking ? null : bookingLabel(note.booking);
  const chips = fichaChips(note);
  const diagnoses = diagnosisChips(note.diagnoses);
  const items = fichaMenuItems(note, {
    now,
    isRoot: !isAmendment,
    shareAvailable: Boolean(context?.patient),
    backupStatus: backup?.status ?? null,
  });

  const closeMenu = (restoreFocus: boolean) => {
    setMenuOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  const unshare = async () => {
    const sd = note.sharedDocument;
    if (!sd || sd.status === "none") return;
    const ok = await confirm({
      title: CARD_COPY.unshare,
      message: SHARE_COPY.unshareConfirm,
      confirmLabel: CARD_COPY.unshare,
      tone: "danger",
    });
    if (!ok) return;
    try {
      // La referencia a la action se carga recién acá (después del confirm): desde la tarjeta estática es un import
      // del módulo `"use server"` entero en el grafo de tests y del drawer del turno, por una acción que casi nadie usa.
      const { revokePatientDocument } = await import("@/lib/patient-documents");
      const r = await revokePatientDocument({ documentId: sd.documentId });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
    } catch {
      toast.error(CARD_COPY.unshareFailed);
      return;
    }
    onNoteChange?.({ ...note, sharedDocument: { status: "none" } });
    toast.success(SHARE_COPY.unshared);
  };

  /** Corre SINCRÓNICO dentro del click del ítem: «Guardar en la carpeta» no puede tener un await antes (§24.6). */
  const onSelect = (id: FichaMenuItemId) => {
    setMenuOpen(false);
    switch (id) {
      case "pdf":
      case "docx":
        void downloadFicha({ patientId: note.patientId, rootId: fichaRootId(note), format: id }, toast);
        return;
      case "saveToFolder": {
        if (!backup || !context) return;
        void backup.save(fichaBackupTarget(note, context.patient)).then((o) => {
          if (!o.ok) toast.error(o.error || BACKUP_COPY.failed);
          else toast.success(o.via === "folder" ? BACKUP_COPY.savedToFolder(o.path) : BACKUP_COPY.downloaded);
        });
        return;
      }
      case "share":
      case "shareCurrent":
        setShareOpen(true);
        return;
      case "unshare":
        void unshare();
        return;
      case "amend":
        setEditor("amend");
        return;
      case "versions":
        setHistoryOpen(true);
        return;
      case "void":
        setVoidOpen(true);
        return;
    }
  };

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
          {chips.map((c) => (
            <span key={c.key} title={c.title} data-chip={c.key}>
              <Tag tone={c.key === "shared" ? "lime" : "soft"} variant={c.key === "shared" ? "fill" : "outline"}>
                {c.label}
              </Tag>
            </span>
          ))}
          {items.length > 0 && (
            <div style={{ position: "relative", marginLeft: "auto" }}>
              <button
                ref={triggerRef}
                type="button"
                aria-label={CARD_COPY.menuLabel}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-controls={menuOpen ? menuId : undefined}
                data-testid="ficha-menu-trigger"
                onPointerEnter={() => void loadFichaMenu()}
                onFocus={() => void loadFichaMenu()}
                onClick={() => setMenuOpen((v) => !v)}
                style={{
                  minWidth: 40,
                  minHeight: 40,
                  borderRadius: 8,
                  border: "none",
                  background: menuOpen ? "rgba(31,79,190,0.1)" : "transparent",
                  color: "var(--navy-500)",
                  cursor: "pointer",
                  fontSize: 18,
                  fontWeight: 700,
                  lineHeight: 1,
                }}
              >
                <span aria-hidden="true">⋯</span>
              </button>
              {menuOpen && (
                <FichaMenu
                  id={menuId}
                  label={CARD_COPY.menuLabel}
                  items={items}
                  onSelect={onSelect}
                  onClose={closeMenu}
                  triggerRef={triggerRef}
                />
              )}
            </div>
          )}
        </div>
        {note.title && <strong style={{ fontSize: isAmendment ? 14 : 15 }}>{note.title}</strong>}
        <span style={metaStyle}>
          {fichaAuthorLine(note)}
          {booking ? ` · ${booking}` : ""}
        </span>
      </header>

      {diagnoses.length > 0 && (
        <ul
          aria-label={DIAGNOSIS_FIELD_COPY.label}
          style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", gap: 6, flexWrap: "wrap" }}
        >
          {diagnoses.map((d) => (
            <li
              key={d.key}
              title={d.hint}
              style={{
                fontSize: 12.5,
                lineHeight: 1.35,
                padding: "3px 8px",
                borderRadius: "var(--r-sm)",
                background: d.principal ? "var(--sky-50)" : "transparent",
                border: `1px solid ${d.principal ? "var(--sky-200)" : "var(--navy-100)"}`,
                color: "var(--navy-700)",
                maxWidth: "100%",
                overflowWrap: "anywhere",
              }}
            >
              {d.code && <strong style={{ marginRight: 4 }}>{d.code}</strong>}
              {d.title}
              {d.principal && diagnoses.length > 1 && (
                <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 600, color: "var(--sky-700)" }}>
                  · {DIAGNOSIS_FIELD_COPY.principal}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      <FoldableHcBody note={note} />

      {until && (
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--sky-700)" }} data-testid="editable-until">
          {until}
        </span>
      )}

      {actions.edit && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Button type="button" variant="ghost" onClick={() => setEditor("edit")}>
            {COPY.edit}
          </Button>
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
            refreshBackup(isAmendment ? rootNote : info.type === "amend" ? note : saved);
          }}
        />
      )}
      {actions.void && voidOpen && (
        <VoidNoteDialog
          open
          onClose={() => setVoidOpen(false)}
          note={note}
          onVoided={(n) => {
            onNoteChange?.(n);
            refreshBackup(isAmendment ? rootNote : n);
          }}
        />
      )}
      {actions.history && historyOpen && <NoteHistoryModal open onClose={() => setHistoryOpen(false)} note={note} />}
      {shareOpen && context && (
        <ShareFichaDialog
          open
          onClose={() => setShareOpen(false)}
          note={note}
          patient={{ id: context.patient.id, name: context.patient.name, email: context.patient.email }}
          onChanged={(sharedDocument) => onNoteChange?.({ ...note, sharedDocument })}
        />
      )}
    </article>
  );
}

/** Alto del cuerpo plegado: ~8 renglones de 14 px con interlineado 1.5. */
const FOLDED_MAX_HEIGHT = "12em";

/**
 * Cuerpo plegable. Plegado = recortado con CSS (el texto completo está en el DOM desde el SSR); sin animación, así con
 * reducedMotion el estado final es el mismo. Corto → sin botón.
 */
export function FoldableHcBody({ note, defaultExpanded = false }: { note: Pick<ClinicalNoteDTO, "id" | "body" | "bodyDoc">; defaultExpanded?: boolean }) {
  const foldable = isFoldableBody(note.body);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const bodyId = `ficha-body-${note.id}`;
  const folded = foldable && !expanded;
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <div
        id={bodyId}
        data-folded={folded ? "" : undefined}
        style={{
          ...bodyColor,
          fontSize: 14,
          ...(folded
            ? {
                maxHeight: FOLDED_MAX_HEIGHT,
                overflow: "hidden",
                WebkitMaskImage: "linear-gradient(to bottom, #000 70%, transparent)",
                maskImage: "linear-gradient(to bottom, #000 70%, transparent)",
              }
            : null),
        }}
      >
        <HcBody doc={note.bodyDoc} text={note.body} headingOffset={1} />
      </div>
      {foldable && (
        <div>
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={bodyId}
            onClick={() => setExpanded((v) => !v)}
            style={{
              background: "transparent",
              border: "none",
              padding: "6px 0",
              minHeight: 32,
              fontSize: 13,
              fontWeight: 600,
              color: "var(--sky-700)",
              cursor: "pointer",
            }}
          >
            {expanded ? CARD_COPY.showLess : CARD_COPY.showMore}
          </button>
        </div>
      )}
    </div>
  );
}
