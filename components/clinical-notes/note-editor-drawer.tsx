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
import { useEffect, useRef, useState } from "react";
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
  // EV2-Z M5: el texto que se estaba editando pasa a la enmienda (antes se abría vacía y se perdía lo escrito).
  const [carryBody, setCarryBody] = useState<string | null>(null);
  const active = override ?? mode;

  const close = () => {
    setOverride(null);
    setCarryBody(null);
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
        carryBody={override ? carryBody : null}
        onDirtyChange={setDirty}
        onCancel={close}
        onSaved={(note, replayed) => {
          onSaved(note, { type: active.type, replayed });
          close();
        }}
        onSwitchToAmend={
          // Solo una raíz se enmienda (EV2-D14): una enmienda vencida no ofrece nada más que anularla.
          active.type === "edit" && active.note.amendsNoteId == null
            ? (body: string) => {
                setCarryBody(body.trim() === "" ? null : body);
                setOverride({ type: "amend", note: active.note });
              }
            : undefined
        }
      />
    </Drawer>
  );
}

const hintStyle: React.CSSProperties = { fontSize: 12, color: "var(--navy-500)", margin: 0 };
const errorStyle: React.CSSProperties = { fontSize: 12, color: "var(--danger-fg)", marginTop: 4 };
const fieldLabelStyle: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "var(--navy-500)" };
/** Fuera de pantalla pero leído por el lector (no hay clase sr-only en globals.css). */
const srOnly: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

export function NoteEditorForm({
  mode,
  onCancel,
  onSaved,
  onDirtyChange,
  onSwitchToAmend,
  carryBody,
  now: nowProp,
}: {
  mode: NoteEditorMode;
  onCancel: () => void;
  onSaved: (note: ClinicalNoteDTO, replayed: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** Recibe el texto escrito, que la enmienda arranca copiado (M5). */
  onSwitchToAmend?: (body: string) => void;
  /** Texto que viene del editor de 24 h vencido. Queda «sucio» a propósito: cerrar sin guardar lo pierde. */
  carryBody?: string | null;
  /** Solo tests: reloj fijo. */
  now?: Date;
}) {
  const toast = useToast();
  const [openedAt] = useState(() => nowProp ?? new Date());
  const [initial] = useState<NoteDraft>(() => initialDraft(mode, openedAt));
  const [draft, setDraft] = useState<NoteDraft>(() => (carryBody ? { ...initial, body: carryBody } : initial));
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

  const counter = bodyCounter(draft.body, mode);
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
      {(context || until || mode.type === "amend" || (mode.type === "create" && mode.patientName)) && (
        <div style={{ display: "grid", gap: 4 }}>
          {mode.type === "create" && mode.patientName && (
            <p style={{ margin: 0, fontSize: 14, color: "var(--navy-900)" }} data-testid="editor-patient">
              <strong>
                {COPY.patientPrefix} {mode.patientName}
              </strong>
            </p>
          )}
          {mode.type === "amend" && (
            <p style={hintStyle}>
              Enmienda a la evolución del {noteDateLabel(mode.note.occurredAt)} de {mode.note.author.name}.{" "}
              {COPY.amendHint}
            </p>
          )}
          {mode.type === "amend" && carryBody && (
            <p style={{ ...hintStyle, fontWeight: 600, color: "var(--sky-700)" }} data-testid="amend-carried">
              {COPY.amendCarriedHint}
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
        <span style={fieldLabelStyle}>{COPY.kindLabel}</span>
        {mode.type === "amend" ? (
          <div style={{ marginTop: 6 }}>
            <KindTag kind={mode.note.kind} />
          </div>
        ) : (
          <KindRadioGroup value={draft.kind} disabled={saving} onChange={(k) => set("kind", k)} />
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
          aria-hidden="true"
          data-testid="body-counter"
          style={{
            textAlign: "right",
            fontSize: 11,
            marginTop: 4,
            fontVariantNumeric: "tabular-nums",
            color: counter.over ? "var(--danger-fg)" : counter.near ? "var(--st-noshow-fg)" : "var(--navy-300)",
            fontWeight: counter.over ? 700 : 400,
          }}
        >
          {counter.label}
        </div>
        {/* EV2-Z M7: la región vive siempre (un aria-live que aparece no se anuncia) y solo habla cerca del límite. */}
        <div aria-live="polite" data-testid="body-counter-live" style={srOnly}>
          {counter.announce}
        </div>
      </div>

      {mode.type !== "amend" && (
        // EV2-Z M7: fieldset/legend agrupa fecha + hora + minutos bajo un nombre (antes era un <span> suelto).
        <fieldset style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
          <legend style={{ ...fieldLabelStyle, padding: 0 }}>{COPY.occurredAtLabel}</legend>
          <div style={{ marginTop: 6 }}>
            <DateTime24Picker
              value={draft.occurredAtLocal}
              onChange={(v) => set("occurredAtLocal", v)}
              disabled={saving}
              required
            />
          </div>
          {errors.occurredAt && <div style={errorStyle}>{errors.occurredAt}</div>}
        </fieldset>
      )}

      {serverError && (
        <div
          role="alert"
          style={{
            padding: "10px 12px",
            borderRadius: "var(--r-sm)",
            background: "var(--danger-bg)",
            border: "1px solid var(--danger-border)",
            fontSize: 13,
            color: "var(--navy-900)",
            display: "grid",
            gap: 8,
          }}
        >
          <span>{serverError}</span>
          {offersAmendAfterError(serverError) && onSwitchToAmend && (
            <div>
              <Button type="button" variant="ghost" onClick={() => onSwitchToAmend(draft.body)}>
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

/**
 * Tipo como radiogroup (EV2-Z M7). Patrón WAI-ARIA de radio: un solo tab stop (el elegido) y ←/→ (también ↑/↓) mueven
 * Y eligen, en ronda. Cada opción mide 44 px de alto (target táctil); el `Tag` adentro queda del tamaño de siempre.
 */
function KindRadioGroup({
  value,
  disabled,
  onChange,
}: {
  value: ClinicalNoteKind;
  disabled?: boolean;
  onChange: (k: ClinicalNoteKind) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    const step = kindKeyStep(e.key);
    if (step === 0) return;
    e.preventDefault();
    const next = (i + step + KIND_OPTIONS.length) % KIND_OPTIONS.length;
    onChange(KIND_OPTIONS[next].value);
    refs.current[next]?.focus();
  };
  const hasChecked = KIND_OPTIONS.some((o) => o.value === value);
  return (
    <div role="radiogroup" aria-label={COPY.kindLabel} style={{ display: "flex", gap: 2, marginTop: 2, flexWrap: "wrap" }}>
      {KIND_OPTIONS.map((o, i) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked || (!hasChecked && i === 0) ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            style={{
              minHeight: 44,
              display: "inline-flex",
              alignItems: "center",
              border: "none",
              padding: "0 2px",
              background: "transparent",
              cursor: disabled ? "not-allowed" : "pointer",
            }}
          >
            <span
              style={{
                display: "inline-flex",
                border: checked ? "2px solid var(--sky-700)" : "2px solid transparent",
                borderRadius: 999,
                padding: 1,
                opacity: checked ? 1 : 0.6,
              }}
            >
              <KindTag kind={o.value} />
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** ←/↑ = anterior, →/↓ = siguiente; cualquier otra tecla, 0 (no se toca). */
export function kindKeyStep(key: string): -1 | 0 | 1 {
  if (key === "ArrowRight" || key === "ArrowDown") return 1;
  if (key === "ArrowLeft" || key === "ArrowUp") return -1;
  return 0;
}
