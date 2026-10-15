"use client";

/**
 * EV2-2e · Editor de evoluciones (crear, editar dentro de las 24 h, enmendar) en un `Drawer` con dirty-guard.
 *
 * - Dirty-guard: el form es controlado, así que el «sucio» se calcula comparando el borrador con el inicial
 *   (`isDraftDirty`, mismo criterio que lib/form-dirty: escribir y borrar vuelve a limpio). `useFormDirty` no sirve
 *   acá: toma la foto del `<form>` al montar el componente de afuera, y el Drawer recién monta su contenido al abrir.
 * - Idempotencia: UUID por instancia del form (`useState(newIdempotencyKey)`). El form vive dentro del Drawer, que lo
 *   desmonta al cerrar: cada apertura es una clave nueva y un doble click / reintento en la misma apertura es replay.
 * - Llama a las actions de lib/clinical-notes.ts por su firma (C-EV2-4). La UI no refresca la ruta entera (doble render, H-SLOW):
 *   le pasa al caller el DTO que devolvió la action.
 * - Sin animaciones propias: Drawer/Modal ya respetan `MotionConfig reducedMotion="user"`.
 */
import { useEffect, useState } from "react";
import type { ClinicalNoteKind } from "@prisma/client";
import { Drawer } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { DateTime24Picker } from "@/components/ui/datetime-24-picker";
import { useToast } from "@/components/ui/toast";
import { KindTag } from "@/components/clinical-notes/kind-tag";
import {
  CLINICAL_NOTES_UI_COPY as COPY,
  KIND_OPTIONS,
  bodyCounter,
  bookingLabel,
  buildAmendInput,
  buildCreateInput,
  buildEditInput,
  editableUntilLabel,
  editorTitle,
  hasErrors,
  initialDraft,
  isDraftDirty,
  newIdempotencyKey,
  noteDateLabel,
  offersAmendAfterError,
  savedToast,
  submitLabel,
  validateDraft,
  type DraftErrors,
  type NoteDraft,
  type NoteEditorMode,
} from "@/components/clinical-notes/clinical-notes-ui";
import { amendClinicalNote, createClinicalNote, editClinicalNote } from "@/lib/clinical-notes";
import type { ClinicalNoteDTO } from "@/lib/clinical-notes-types";

export const NOTE_EDITOR_WIDTH = 560;

export type NoteSavedInfo = { type: NoteEditorMode["type"]; replayed: boolean };

export function NoteEditorDrawer({
  open,
  onClose,
  mode,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  mode: NoteEditorMode;
  /** El DTO que devolvió la action: el caller reemplaza (editar) o agrega (crear/enmendar) sin recargar. */
  onSaved: (note: ClinicalNoteDTO, info: NoteSavedInfo) => void;
}) {
  const [dirty, setDirty] = useState(false);
  // Pasó la ventana de 24 h mientras editaba: el mismo drawer pasa a «Agregar enmienda».
  const [override, setOverride] = useState<NoteEditorMode | null>(null);
  const active = override ?? mode;

  const close = () => {
    setOverride(null);
    setDirty(false);
    onClose();
  };

  return (
    <Drawer
      open={open}
      onClose={close}
      title={editorTitle(active)}
      width={NOTE_EDITOR_WIDTH}
      dirty={dirty}
      dirtyMessage={COPY.dirtyMessage}
    >
      <NoteEditorForm
        key={active.type}
        mode={active}
        onDirtyChange={setDirty}
        onCancel={close}
        onSaved={(note, replayed) => {
          onSaved(note, { type: active.type, replayed });
          close();
        }}
        onSwitchToAmend={
          // Solo una raíz se enmienda (EV2-D14): una enmienda vencida no ofrece nada más que anularla.
          active.type === "edit" && active.note.amendsNoteId == null
            ? () => setOverride({ type: "amend", note: active.note })
            : undefined
        }
      />
    </Drawer>
  );
}

const hintStyle: React.CSSProperties = { fontSize: 12, color: "var(--navy-500)", margin: 0 };
const errorStyle: React.CSSProperties = { fontSize: 12, color: "#9F1F1F", marginTop: 4 };

export function NoteEditorForm({
  mode,
  onCancel,
  onSaved,
  onDirtyChange,
  onSwitchToAmend,
  now: nowProp,
}: {
  mode: NoteEditorMode;
  onCancel: () => void;
  onSaved: (note: ClinicalNoteDTO, replayed: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onSwitchToAmend?: () => void;
  /** Solo tests: reloj fijo. */
  now?: Date;
}) {
  const toast = useToast();
  const [openedAt] = useState(() => nowProp ?? new Date());
  const [initial] = useState<NoteDraft>(() => initialDraft(mode, openedAt));
  const [draft, setDraft] = useState<NoteDraft>(initial);
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const dirty = isDraftDirty(initial, draft);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const set = <K extends keyof NoteDraft>(k: K, v: NoteDraft[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    if (k === "body" || k === "title" || k === "occurredAtLocal") {
      const field = k === "occurredAtLocal" ? "occurredAt" : k;
      setErrors((e) => (e[field as keyof DraftErrors] ? { ...e, [field]: undefined } : e));
    }
  };

  const counter = bodyCounter(draft.body);
  const note = mode.type === "create" ? null : mode.note;
  const context = mode.type === "create" ? bookingLabel(mode.booking) : bookingLabel(note?.booking);
  const until = mode.type === "edit" ? editableUntilLabel(mode.note, nowProp ?? new Date()) : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    const now = new Date();
    const v = validateDraft(mode, draft, now);
    setErrors(v);
    if (hasErrors(v)) return;
    setServerError(null);
    setSaving(true);
    try {
      if (mode.type === "create") {
        const res = await createClinicalNote(buildCreateInput(mode, initial, draft, idempotencyKey));
        if (!res.ok) return setServerError(res.error);
        toast.success(savedToast(mode));
        onSaved(res.data.note, res.data.replayed);
      } else if (mode.type === "edit") {
        const input = buildEditInput(mode.note, initial, draft);
        if (!input) return onCancel(); // nada cambió: no se escribe una revisión vacía
        const res = await editClinicalNote(input);
        if (!res.ok) return setServerError(res.error);
        toast.success(savedToast(mode));
        onSaved(res.data.note, false);
      } else {
        const res = await amendClinicalNote(buildAmendInput(mode.note, draft, idempotencyKey));
        if (!res.ok) return setServerError(res.error);
        toast.success(savedToast(mode));
        onSaved(res.data.note, res.data.replayed);
      }
    } catch {
      setServerError("No se pudo guardar. Revisá la conexión y probá de nuevo.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate style={{ display: "grid", gap: 14 }} aria-busy={saving || undefined}>
      {(context || until || mode.type === "amend") && (
        <div style={{ display: "grid", gap: 4 }}>
          {mode.type === "amend" && (
            <p style={hintStyle}>
              Enmienda a la evolución del {noteDateLabel(mode.note.occurredAt)} de {mode.note.author.name}.{" "}
              {COPY.amendHint}
            </p>
          )}
          {context && <p style={hintStyle}>{context}</p>}
          {until && (
            <p style={{ ...hintStyle, fontWeight: 600, color: "var(--sky-700)" }} data-testid="editable-until">
              {until}
            </p>
          )}
        </div>
      )}

      <div>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--navy-500)" }}>{COPY.kindLabel}</span>
        {mode.type === "amend" ? (
          <div style={{ marginTop: 6 }}>
            <KindTag kind={mode.note.kind} />
          </div>
        ) : (
          <div role="radiogroup" aria-label={COPY.kindLabel} style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
            {KIND_OPTIONS.map((o) => (
              <KindChoice
                key={o.value}
                kind={o.value}
                checked={draft.kind === o.value}
                disabled={saving}
                onSelect={() => set("kind", o.value)}
              />
            ))}
          </div>
        )}
      </div>

      <FormField
        label={COPY.titleLabel}
        value={draft.title}
        onChange={(v) => set("title", v)}
        placeholder={COPY.titlePlaceholder}
        error={errors.title}
        disabled={saving}
      />

      <div>
        <FormField
          as="textarea"
          label={mode.type === "amend" ? COPY.amendBodyLabel : COPY.bodyLabel}
          required
          rows={10}
          value={draft.body}
          onChange={(v) => set("body", v)}
          placeholder={COPY.bodyPlaceholder}
          error={errors.body}
          disabled={saving}
          autoFocus
        />
        <div
          aria-live="polite"
          data-testid="body-counter"
          style={{
            textAlign: "right",
            fontSize: 11,
            marginTop: 4,
            fontVariantNumeric: "tabular-nums",
            color: counter.over ? "#9F1F1F" : counter.near ? "var(--st-noshow-fg)" : "var(--navy-300)",
            fontWeight: counter.over ? 700 : 400,
          }}
        >
          {counter.label}
        </div>
      </div>

      {mode.type !== "amend" && (
        <div>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--navy-500)" }}>{COPY.occurredAtLabel}</span>
          <div style={{ marginTop: 6 }}>
            <DateTime24Picker
              value={draft.occurredAtLocal}
              onChange={(v) => set("occurredAtLocal", v)}
              disabled={saving}
              required
            />
          </div>
          {errors.occurredAt && <div style={errorStyle}>{errors.occurredAt}</div>}
        </div>
      )}

      {serverError && (
        <div
          role="alert"
          style={{
            padding: "10px 12px",
            borderRadius: "var(--r-sm)",
            background: "rgba(225,75,75,0.08)",
            border: "1px solid rgba(225,75,75,0.25)",
            fontSize: 13,
            color: "var(--navy-900)",
            display: "grid",
            gap: 8,
          }}
        >
          <span>{serverError}</span>
          {offersAmendAfterError(serverError) && onSwitchToAmend && (
            <div>
              <Button type="button" variant="ghost" onClick={onSwitchToAmend}>
                {COPY.amend}
              </Button>
            </div>
          )}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
        {/* «Cancelar» descarta sin preguntar: la intención es explícita (convención del Drawer). */}
        <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
          {COPY.cancel}
        </Button>
        <Button type="submit" disabled={saving || counter.over}>
          {saving ? COPY.saving : submitLabel(mode)}
        </Button>
      </div>
    </form>
  );
}

/** Opción de tipo: el `Tag` del tipo como radio (seleccionado = tono pleno; el resto, atenuado). */
function KindChoice({
  kind,
  checked,
  disabled,
  onSelect,
}: {
  kind: ClinicalNoteKind;
  checked: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      onClick={onSelect}
      style={{
        border: checked ? "2px solid var(--sky-700)" : "2px solid transparent",
        borderRadius: 999,
        padding: 1,
        background: "transparent",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: checked ? 1 : 0.6,
      }}
    >
      <KindTag kind={kind} />
    </button>
  );
}
