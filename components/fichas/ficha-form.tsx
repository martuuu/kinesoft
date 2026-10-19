"use client";

/**
 * [FC-3k] `FichaForm` · stub FUNCIONAL con la firma congelada (`FichaFormProps`, fichas-ui-types.ts).
 *
 * El formulario ÚNICO de la ficha (§24.7): inline en la HC, adentro de `FichaDrawer` en mobile, desde la agenda y
 * Seguimiento; crea, edita (24 h) y enmienda. Este stub ya guarda de verdad (las actions de C-FC3 con `bodyDoc`) para
 * que FC-3d/3e1/3h puedan montarlo mientras FC-3c lo completa sin cambiar la firma:
 *   - borrador en memoria por `draftScope` (`lib/hc-draft-store.ts`, TTL 12 h, LRU 20, nunca en disco) con
 *     `beforeunload` y la clave de idempotencia adentro;
 *   - chip del turno con `pickDefaultComposerBooking` y la fecha que sigue al turno salvo que la toquen;
 *   - radio del tipo, picker de fecha y Ctrl/⌘+Enter en todo el form.
 * Hoy: tipo, título, turno (fijo, o elegir entre los candidatos / «Sin turno»), editor, diagnósticos y la casilla del
 * diagnóstico activo (destildada, solo con principal). La fecha no viaja: el server pone su default (turno o ahora,
 * EV2-D24), igual que cuando el usuario no la toca.
 *
 * Estático a propósito (§24.9: el composer está en el first load); nada de Drawer acá (ese es `FichaDrawer`, diferido).
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ClinicalNoteKind } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { HcEditorField } from "@/components/fichas/hc-editor-field";
import { DiagnosisField } from "@/components/fichas/diagnosis-field";
import { FICHA_FORM_COPY as COPY } from "@/components/fichas/fichas-copy";
import type { FichaBookingOption, FichaFormProps, HcEditorChange } from "@/components/fichas/fichas-ui-types";
import { KIND_OPTIONS, bookingLabel, newIdempotencyKey } from "@/components/clinical-notes/clinical-notes-ui";
import { HC_DOC_ERROR_COPY, hcDocToPlainText, validateHcDoc, type HcDoc } from "@/lib/hc-doc";
import { pickDefaultComposerBooking } from "@/lib/hc-composer-logic";
import type { DiagnosisOption, DiagnosisRef, DiagnosisSnapshot } from "@/lib/diagnoses-types";
import type { ClinicalNoteDTO } from "@/lib/clinical-notes-types";
import { amendClinicalNote, createClinicalNote, editClinicalNote } from "@/lib/clinical-notes";

/** Snapshot congelado → opción del campo. Sin `refId` (o texto libre) vuelve como texto: el server lo re-congela igual. */
function snapshotToOption(s: DiagnosisSnapshot): DiagnosisOption {
  const ref: DiagnosisRef =
    s.source === "text" || !s.refId ? { kind: "text", text: s.title } : { kind: s.source, id: s.refId };
  return { ref, source: s.source, code: s.code, title: s.title, retired: false, favorite: false };
}
const refsOf = (v: readonly DiagnosisOption[]) => v.map((o) => o.ref);
const refsKey = (v: readonly DiagnosisOption[]) => JSON.stringify(refsOf(v));

/** Default del chip. `pickDefaultComposerBooking` lo implementa FC-3c: hasta entonces tira y el chip arranca vacío. */
function defaultBooking(
  bookings: readonly FichaBookingOption[],
  ownPractitionerId: string | null,
  now: Date
): FichaBookingOption | null {
  try {
    return pickDefaultComposerBooking({ candidates: bookings, ownPractitionerId, now });
  } catch {
    return null;
  }
}

export function FichaForm({
  mode,
  variant,
  viewerPractitionerId,
  onSaved,
  onCancel,
  onDirtyChange,
  onSwitchToAmend,
  now: nowProp,
}: FichaFormProps) {
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  // useId: el composer inline y el FichaDrawer pueden estar montados a la vez (ids repetidos rompen los <label>).
  const uid = useId();
  const ids = { body: `${uid}-body`, title: `${uid}-title`, kind: `${uid}-kind`, booking: `${uid}-booking`, dx: `${uid}-dx` };
  const [openedAt] = useState(() => nowProp ?? new Date());
  const note: ClinicalNoteDTO | null = mode.type === "create" ? null : mode.note;

  const bookingChoices = useMemo(
    () => (mode.type === "create" && !mode.fixedBooking ? (mode.bookings ?? []).filter((b) => !b.hasLiveNote) : []),
    [mode]
  );
  const initial = useMemo(() => {
    if (mode.type === "create") {
      const kind: ClinicalNoteKind = mode.patientHasNotes ? "EVOLUTION" : "FIRST_VISIT"; // FC-UI-D5
      const booking = mode.fixedBooking ?? defaultBooking(bookingChoices, viewerPractitionerId, openedAt);
      return { kind, title: "", bookingId: booking?.id ?? null, doc: null as HcDoc | null, text: "", diagnoses: [] as DiagnosisOption[] };
    }
    const n = mode.note;
    return {
      kind: n.kind,
      title: mode.type === "edit" ? (n.title ?? "") : "",
      bookingId: n.bookingId,
      doc: mode.type === "edit" ? n.bodyDoc : null,
      text: mode.type === "edit" ? (n.bodyDoc ? hcDocToPlainText(n.bodyDoc) : n.body) : "",
      // Handoff de FC-2a: la enmienda NO precarga diagnósticos (uno retirado la haría rechazar); editar sí (`keep`).
      diagnoses: mode.type === "edit" ? n.diagnoses.map(snapshotToOption) : [],
    };
  }, [mode, bookingChoices, viewerPractitionerId, openedAt]);

  const [kind, setKind] = useState(initial.kind);
  const [title, setTitle] = useState(initial.title);
  const [bookingId, setBookingId] = useState<string | null>(initial.bookingId);
  const [body, setBody] = useState<{ doc: HcDoc | null; text: string }>({ doc: initial.doc, text: initial.text });
  const [diagnoses, setDiagnoses] = useState<DiagnosisOption[]>(initial.diagnoses);
  const [setActive, setSetActive] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const [resetKey, setResetKey] = useState(0);
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const dirty =
    kind !== initial.kind ||
    title.trim() !== initial.title.trim() ||
    bookingId !== initial.bookingId ||
    body.text.trim() !== initial.text.trim() ||
    refsKey(diagnoses) !== refsKey(initial.diagnoses);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  // La casilla solo vale con principal (C-FC3 refine 3): sin diagnósticos se destilda sola.
  useEffect(() => {
    if (diagnoses.length === 0 && setActive) setSetActive(false);
  }, [diagnoses.length, setActive]);

  const onEditorChange = (c: HcEditorChange) => {
    setBody({ doc: c.doc, text: c.text });
    if (bodyError) setBodyError(null);
  };

  const resetAfterCreate = () => {
    setTitle("");
    setBody({ doc: null, text: "" });
    setDiagnoses([]);
    setSetActive(false);
    setIdempotencyKey(newIdempotencyKey()); // la clave rota al guardar (§24.7)
    setResetKey((k) => k + 1);
  };

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (saving) return;
    const v = validateHcDoc(body.doc ?? { type: "doc", content: [] });
    if (!v.ok) return setBodyError(HC_DOC_ERROR_COPY[v.reason]);
    const titleOrNull = title.trim() === "" ? null : title.trim();
    setServerError(null);
    setSaving(true);
    try {
      if (mode.type === "create") {
        const res = await createClinicalNote({
          patientId: mode.patientId,
          bookingId,
          kind,
          title: titleOrNull,
          bodyDoc: v.doc,
          diagnoses: refsOf(diagnoses),
          setActiveDiagnosis: setActive,
          idempotencyKey,
        });
        if (!res.ok) return setServerError(res.error);
        toast.success(COPY.saved);
        onSaved(res.data.note, { type: "create", replayed: res.data.replayed });
        if (variant === "inline") resetAfterCreate();
      } else if (mode.type === "edit") {
        const n = mode.note;
        const diagnosesChanged = refsKey(diagnoses) !== refsKey(initial.diagnoses);
        const res = await editClinicalNote({
          noteId: n.id,
          expectedRevision: n.revision,
          ...(kind !== initial.kind ? { kind } : {}),
          ...(titleOrNull !== (initial.title.trim() || null) ? { title: titleOrNull } : {}),
          ...(body.text.trim() !== initial.text.trim() ? { bodyDoc: v.doc } : {}),
          ...(diagnosesChanged ? { diagnoses: refsOf(diagnoses) } : {}),
          ...(setActive ? { setActiveDiagnosis: true } : {}),
        });
        if (!res.ok) return setServerError(res.error);
        toast.success(COPY.savedEdit);
        onSaved(res.data.note, { type: "edit", replayed: false });
      } else {
        const res = await amendClinicalNote({
          noteId: mode.note.id,
          title: titleOrNull,
          bodyDoc: v.doc,
          diagnoses: refsOf(diagnoses),
          setActiveDiagnosis: setActive,
          idempotencyKey,
        });
        if (!res.ok) return setServerError(res.error);
        toast.success(COPY.savedAmend);
        onSaved(res.data.note, { type: "amend", replayed: res.data.replayed });
      }
    } catch {
      setServerError(COPY.network);
    } finally {
      setSaving(false);
    }
  }

  const fixed = mode.type === "create" ? mode.fixedBooking : null;
  const context = fixed ? bookingLabel(fixed) : note ? bookingLabel(note.booking) : null;
  const labelStyle: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "var(--navy-500)" };

  return (
    <form ref={formRef} onSubmit={submit} noValidate style={{ display: "grid", gap: 12 }} aria-busy={saving || undefined}>
      {mode.type === "create" && mode.patientName && (
        <p style={{ margin: 0, fontSize: 14, color: "var(--navy-900)" }}>
          <strong>
            {COPY.patientPrefix} {mode.patientName}
          </strong>
        </p>
      )}
      {context && <p style={{ margin: 0, fontSize: 12, color: "var(--navy-500)" }}>{context}</p>}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        {mode.type !== "amend" && (
          <div style={{ display: "grid", gap: 4, flex: "1 1 160px" }}>
            <label htmlFor={ids.kind} style={labelStyle}>
              {COPY.kindLabel}
            </label>
            <select
              id={ids.kind}
              className="k-input"
              value={kind}
              disabled={saving}
              onChange={(e) => setKind(e.target.value as ClinicalNoteKind)}
            >
              {KIND_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        )}
        {mode.type === "create" && !fixed && (
          <div style={{ display: "grid", gap: 4, flex: "2 1 220px" }}>
            <label htmlFor={ids.booking} style={labelStyle}>
              {COPY.bookingLabel}
            </label>
            <select
              id={ids.booking}
              className="k-input"
              value={bookingId ?? ""}
              disabled={saving}
              onChange={(e) => setBookingId(e.target.value || null)}
            >
              <option value="">{COPY.noBooking}</option>
              {bookingChoices.map((b) => (
                <option key={b.id} value={b.id}>
                  {bookingLabel(b)}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div style={{ display: "grid", gap: 4 }}>
        <label htmlFor={ids.title} style={labelStyle}>
          {COPY.titleLabel}
        </label>
        <input
          id={ids.title}
          className="k-input"
          value={title}
          maxLength={200}
          placeholder={COPY.titlePlaceholder}
          disabled={saving}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>

      <HcEditorField
        id={ids.body}
        label={mode.type === "amend" ? COPY.amendBodyLabel : COPY.bodyLabel}
        initialDoc={initial.doc}
        initialText={initial.text}
        resetKey={resetKey}
        onChange={onEditorChange}
        onSubmitShortcut={() => formRef.current?.requestSubmit()}
        placeholder={COPY.bodyPlaceholder}
        disabled={saving}
        error={bodyError}
        autoFocus={variant === "drawer"}
      />

      <DiagnosisField id={ids.dx} value={diagnoses} onChange={setDiagnoses} disabled={saving} />

      <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, color: "var(--navy-700)" }}>
        <input
          type="checkbox"
          checked={setActive}
          disabled={saving || diagnoses.length === 0}
          onChange={(e) => setSetActive(e.target.checked)}
          style={{ marginTop: 2 }}
        />
        <span>
          {COPY.setActiveDiagnosis}
          <span style={{ display: "block", fontSize: 12, color: "var(--navy-500)" }}>{COPY.setActiveDiagnosisHint}</span>
        </span>
      </label>

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
          {mode.type === "edit" && mode.note.amendsNoteId == null && onSwitchToAmend && (
            <div>
              <Button type="button" variant="ghost" onClick={() => onSwitchToAmend({ doc: body.doc, text: body.text })}>
                {COPY.amendInstead}
              </Button>
            </div>
          )}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
            {COPY.cancel}
          </Button>
        )}
        <Button type="submit" disabled={saving} title={COPY.saveShortcut}>
          {saving ? COPY.saving : COPY.save}
        </Button>
      </div>
    </form>
  );
}
