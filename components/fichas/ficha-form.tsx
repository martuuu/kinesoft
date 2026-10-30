"use client";

/**
 * [FC-3c] `FichaForm`: el formulario ÚNICO de la ficha (§24.7). Inline en la HC (≥640 px), adentro de `FichaDrawer`
 * (mobile, agenda, toast «Atendido», Seguimiento) y en editar (24 h) / enmendar. Firma congelada `FichaFormProps`
 * (fichas-ui-types.ts); la lógica pura vive en `ficha-form-logic.ts` y `lib/hc-composer-logic.ts`.
 *
 * - Tipo como radio WAI-ARIA (un tab stop, ←/→ en ronda, 44 px), con default FC-UI-D5.
 * - Chip del turno (`BookingChip`): `pickDefaultComposerBooking` propone el de hoy sin ficha (propio primero) y se
 *   puede cambiar o dejar «Sin turno»; con `fixedBooking` no se cambia.
 * - Fecha con `DateTime24Picker` en reloj AR: sigue al turno salvo que la toquen; sin tocar no viaja (default del
 *   server con SU reloj).
 * - `HcEditorField` y `DiagnosisField` por sus props congeladas (los implementan FC-3a/FC-3b).
 * - Casilla «diagnóstico activo»: solo aparece con principal y arranca destildada (decisión #3 de Martin).
 * - Ctrl/⌘+Enter guarda desde cualquier campo del form. Con errores, el foco va al primer campo inválido.
 * - Composer inline compacto (T4-Z, revisión b A1: a 1024×768 el composer tapaba la primera tarjeta): editor de 4
 *   líneas que crece hasta 10, tipo/turno/fecha en una fila desde 1024, sin «Paciente:» (ya está en el perfil) y
 *   título + diagnósticos plegados detrás de «Agregar título y diagnósticos». El Drawer queda completo, con el pie
 *   sticky.
 * - Borrador en memoria por `draftScope` (`lib/hc-draft-store.ts`): se escribe mientras está sucio y se borra al
 *   guardar o descartar; la clave de idempotencia vive adentro y rota al guardar. Sin `draftScope` (editar,
 *   enmendar) el form pone su propio `beforeunload` mientras está sucio.
 *
 * Estático a propósito (§24.9: el composer está en el first load de /pacientes/[id]); nada de Drawer ni de lo
 * diferido acá (lo frena `hc-first-load-guard.test.ts`).
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ClinicalNoteKind } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { IconPlus } from "@/components/ui/icons";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { DateTime24Picker } from "@/components/ui/datetime-24-picker";
import { HcEditorField } from "@/components/fichas/hc-editor-field";
import { DiagnosisField } from "@/components/fichas/diagnosis-field";
import { BookingChip } from "@/components/fichas/booking-chip";
import { KindTag } from "@/components/clinical-notes/kind-tag";
import { FICHA_FORM_COPY as COPY } from "@/components/fichas/fichas-copy";
import type { FichaDraft, FichaFormProps, HcEditorChange } from "@/components/fichas/fichas-ui-types";
import {
  KIND_OPTIONS,
  editableUntilLabel,
  newIdempotencyKey,
  noteDateLabel,
  offersAmendAfterError,
} from "@/components/clinical-notes/clinical-notes-ui";
import {
  bookingById,
  bookingChoicesFor,
  buildFichaAmendInput,
  buildFichaCreateInput,
  buildFichaEditInput,
  draftAfterSave,
  draftFitsMode,
  initialFichaDraft,
  isFichaDraftDirty,
  kindKeyStep,
  restoreDraft,
  validateFicha,
  type FichaFormErrors,
} from "@/components/fichas/ficha-form-logic";
import { occurredAtAfterBookingChange } from "@/lib/hc-composer-logic";
import { hcDraftStore } from "@/lib/hc-draft-store";
import { amendClinicalNote, createClinicalNote, editClinicalNote } from "@/lib/clinical-notes";

export { kindKeyStep };

/**
 * handoff ZF4 (`FICHA_FORM_COPY`): `amendOf(date, author)` y `addExtras` («Agregar título y diagnósticos»). El
 * integrador los suma al bloque y saca este fallback.
 */
const COPY_ZF4 = COPY as typeof COPY & { amendOf?: (date: string, author: string) => string; addExtras?: string };
const amendOfLabel =
  COPY_ZF4.amendOf ?? ((date: string, author: string) => `Enmienda a la ficha del ${date} de ${author}.`);
const addExtrasLabel = COPY_ZF4.addExtras ?? "Agregar título y diagnósticos";

/** Composer inline: el editor arranca en 4 líneas y crece hasta 10 (revisión b A1); el Drawer, con 10 desde el vamos. */
const INLINE_EDITOR_ROWS = 4;

/** Orden en pantalla de los campos con error, para llevar el foco al primero (cambia con el variant, ver render). */
const ERROR_ORDER: Record<"inline" | "drawer", readonly (keyof FichaFormErrors)[]> = {
  inline: ["occurredAt", "body", "title"],
  drawer: ["title", "occurredAt", "body"],
};

const labelStyle: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "var(--navy-500)" };
const hintStyle: React.CSSProperties = { fontSize: 12, color: "var(--navy-500)", margin: 0 };
const errorStyle: React.CSSProperties = { fontSize: 12, color: "var(--danger-fg)", marginTop: 4 };
const actionsStyle: React.CSSProperties = { display: "flex", justifyContent: "flex-end", flexWrap: "wrap", gap: 8 };
const drawerFooterStyle: React.CSSProperties = {
  position: "sticky",
  bottom: -22,
  zIndex: 1,
  margin: "0 -22px -22px",
  padding: "12px 22px",
  paddingBottom: "max(22px, env(safe-area-inset-bottom))",
  background: "var(--bg-panel)",
  borderTop: "1px solid var(--navy-100)",
};

export function FichaForm({
  mode,
  variant,
  viewerPractitionerId,
  draftScope,
  onSaved,
  onCancel,
  onDirtyChange,
  onSwitchToAmend,
  pickerHome,
  now: nowProp,
  carry,
}: FichaFormProps) {
  const toast = useToast();
  const confirm = useConfirm();
  const formRef = useRef<HTMLFormElement>(null);
  // useId: el composer inline y el FichaDrawer pueden estar montados a la vez (ids repetidos rompen los <label>).
  const uid = useId();
  const ids = {
    body: `${uid}-body`,
    title: `${uid}-title`,
    titleError: `${uid}-title-error`,
    when: `${uid}-when`,
    whenError: `${uid}-when-error`,
    booking: `${uid}-booking`,
    bookingLabel: `${uid}-booking-label`,
    dx: `${uid}-dx`,
    active: `${uid}-active`,
  };
  const clock = () => nowProp ?? new Date();

  // Turnos que este form ya usó (la ficha se guardó y el caller todavía no refrescó `bookings`): no se reofrecen.
  const [usedBookingIds, setUsedBookingIds] = useState<readonly string[]>([]);
  const choices = useMemo(
    () => bookingChoicesFor(mode).filter((b) => !usedBookingIds.includes(b.id)),
    [mode, usedBookingIds]
  );
  const scope = mode.type === "create" ? (draftScope ?? null) : null;

  // Inicial y borrador se fijan al montar (el caller re-monta con `key` para otra ficha). Restaurar acá y no en un
  // effect: el primer render ya muestra lo escrito (un effect pintaría vacío y después el texto, y el textarea no
  // controlado del editor solo lee el valor al montar).
  const [boot] = useState(() => {
    const at = clock();
    const fresh = initialFichaDraft(mode, { viewerPractitionerId, now: at, idempotencyKey: newIdempotencyKey(), carry });
    const stored = scope ? hcDraftStore.read(scope) : null;
    if (stored && !draftFitsMode(mode, stored)) return { initial: fresh, draft: fresh, persist: false };
    return { initial: fresh, draft: stored ? restoreDraft(mode, stored, choices) : fresh, persist: Boolean(scope) };
  });
  const [initial, setInitial] = useState<FichaDraft>(boot.initial);
  const [draft, setDraft] = useState<FichaDraft>(boot.draft);
  const persist = boot.persist;
  const [resetKey, setResetKey] = useState(0);
  const [errors, setErrors] = useState<FichaFormErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Composer inline (A1): título y diagnósticos plegados detrás de «Agregar título y diagnósticos». Arrancan abiertos
  // en el Drawer, al editar/enmendar y si el borrador restaurado ya los tiene (nunca se esconde algo cargado).
  const compact = variant === "inline" && mode.type === "create";
  const [extrasOpen, setExtrasOpen] = useState(
    () => !compact || boot.draft.title.trim() !== "" || boot.draft.diagnoses.length > 0
  );
  // Pedidos de foco después del render: al primer campo inválido, o al título al desplegar.
  const [focusReq, setFocusReq] = useState<{ n: number; target: "invalid" | "title" } | null>(null);

  // El texto traído del editor vencido queda «sucio» a propósito: cerrar sin guardar lo pierde (y el guard avisa).
  const dirty = isFichaDraftDirty(initial, draft) || Boolean(carry?.text.trim());
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // Borrador en memoria: se escribe mientras está sucio; limpio (escribió y borró) se saca, así el punto de la pestaña
  // no queda prendido por nada.
  useEffect(() => {
    if (!persist || !scope) return;
    if (dirty) hcDraftStore.write(scope, draft);
    else hcDraftStore.clear(scope);
  }, [persist, scope, dirty, draft]);

  // Sin borrador en memoria (editar/enmendar, o un borrador de otro turno que no se pisa): recargar con cambios pierde
  // lo escrito, así que el form avisa por su cuenta. Con borrador, el aviso lo da el store (vive aunque el form no).
  useEffect(() => {
    if (persist || !dirty || typeof window === "undefined") return;
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [persist, dirty]);

  const patch = (p: Partial<FichaDraft>, clearField?: keyof FichaFormErrors) => {
    setDraft((d) => ({ ...d, ...p }));
    if (clearField) setErrors((e) => (e[clearField] ? { ...e, [clearField]: undefined } : e));
  };
  const onEditorChange = (c: HcEditorChange) => patch({ doc: c.doc, text: c.text }, "body");
  const onBookingChange = (bookingId: string | null) =>
    setDraft((d) => ({
      ...d,
      bookingId,
      bookingTouched: true,
      occurredAtLocal: occurredAtAfterBookingChange({
        touched: d.occurredAtTouched,
        current: d.occurredAtLocal,
        booking: bookingById(mode, choices, bookingId),
        now: clock(),
      }),
    }));

  const resetToFresh = (usedBookingId: string | null) => {
    const nextUsed = usedBookingId ? [...usedBookingIds, usedBookingId] : usedBookingIds;
    const nextMode = mode.type === "create" ? { ...mode, bookings: (mode.bookings ?? []).filter((b) => !nextUsed.includes(b.id)) } : mode;
    const fresh = draftAfterSave(
      initialFichaDraft(nextMode, { viewerPractitionerId, now: clock(), idempotencyKey: "" }),
      newIdempotencyKey() // la clave rota al guardar (§24.7): la próxima ficha no es replay de esta
    );
    setUsedBookingIds(nextUsed);
    setInitial(fresh);
    setDraft(fresh);
    setErrors({});
    setServerError(null);
    setResetKey((k) => k + 1);
    setExtrasOpen(!compact);
  };

  useEffect(() => {
    if (!focusReq) return;
    let el: HTMLElement | null = null;
    if (focusReq.target === "title") el = document.getElementById(ids.title);
    else {
      const first = ERROR_ORDER[variant].find((k) => errors[k]);
      if (first === "title") el = document.getElementById(ids.title);
      else if (first === "body") el = document.getElementById(ids.body);
      else if (first === "occurredAt") el = formRef.current?.querySelector<HTMLElement>(`[data-ficha-when] input, [data-ficha-when] select`) ?? null;
    }
    el?.focus();
    // Solo cuando llega un pedido nuevo: los errores y los ids son los del render que lo pidió.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusReq]);

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (saving) return;
    const now = clock();
    const v = validateFicha(mode, draft, now);
    if (!v.ok) {
      setErrors(v.errors);
      if (v.errors.title) setExtrasOpen(true);
      // El foco va al primer campo con error (antes quedaba en «Guardar ficha» y el error no se escuchaba).
      setFocusReq((r) => ({ n: (r?.n ?? 0) + 1, target: "invalid" }));
      return;
    }
    setErrors({});
    setServerError(null);
    setSaving(true);
    try {
      if (mode.type === "create") {
        const res = await createClinicalNote(buildFichaCreateInput(mode.patientId, draft, v.doc));
        if (!res.ok) return setServerError(res.error);
        if (scope) hcDraftStore.clear(scope);
        toast.success(COPY.saved);
        onSaved(res.data.note, { type: "create", replayed: res.data.replayed });
        if (variant === "inline") resetToFresh(draft.bookingId);
      } else if (mode.type === "edit") {
        const input = buildFichaEditInput(mode.note, initial, draft, v.doc);
        if (!input) return onCancel?.(); // nada cambió: no se escribe una revisión vacía
        const res = await editClinicalNote(input);
        if (!res.ok) return setServerError(res.error);
        toast.success(COPY.savedEdit);
        onSaved(res.data.note, { type: "edit", replayed: false });
      } else {
        const res = await amendClinicalNote(buildFichaAmendInput(mode.note, draft, v.doc));
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

  async function discard() {
    const ok = await confirm({
      title: COPY.discard,
      message: COPY.discardConfirm,
      confirmLabel: COPY.discard,
      cancelLabel: COPY.cancel,
      tone: "danger",
    });
    if (!ok) return;
    if (scope) hcDraftStore.clear(scope);
    resetToFresh(null);
  }

  const note = mode.type === "create" ? null : mode.note;
  const fixed = mode.type === "create" ? (mode.fixedBooking ?? null) : null;
  const selectedBooking = bookingById(mode, choices, draft.bookingId);
  const until = mode.type === "edit" ? editableUntilLabel(mode.note, clock()) : null;
  const showChip = mode.type !== "create" ? Boolean(note?.booking) : true;
  const submitLabel =
    mode.type === "edit" ? COPY.saveEdit : mode.type === "amend" ? COPY.saveAmend : COPY.save;

  const titleField = (
    <div style={{ display: "grid", gap: 4 }}>
      <label htmlFor={ids.title} style={labelStyle}>
        {COPY.titleLabel}
      </label>
      <input
        id={ids.title}
        className="k-input"
        value={draft.title}
        maxLength={200}
        placeholder={COPY.titlePlaceholder}
        disabled={saving}
        aria-invalid={errors.title ? true : undefined}
        aria-describedby={errors.title ? ids.titleError : undefined}
        aria-errormessage={errors.title ? ids.titleError : undefined}
        onChange={(e) => patch({ title: e.target.value }, "title")}
      />
      {errors.title && (
        <div id={ids.titleError} className="k-field-error" style={errorStyle}>
          {errors.title}
        </div>
      )}
    </div>
  );

  return (
    <form
      ref={formRef}
      onSubmit={submit}
      noValidate
      style={{ display: "grid", gap: 14 }}
      aria-busy={saving || undefined}
      onKeyDown={(e) => {
        // Ctrl/⌘+Enter desde cualquier campo. El editor ya lo maneja (y hace preventDefault): no se manda dos veces.
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.defaultPrevented) {
          e.preventDefault();
          formRef.current?.requestSubmit();
        }
      }}
    >
      {(mode.type === "create" && mode.patientName && variant === "drawer") || mode.type === "amend" || until ? (
        <div style={{ display: "grid", gap: 4 }}>
          {/* Solo en el Drawer (agenda, toast, Seguimiento): inline está adentro del perfil del paciente y lo repetía. */}
          {mode.type === "create" && mode.patientName && variant === "drawer" && (
            <p style={{ margin: 0, fontSize: 14, color: "var(--navy-900)" }} data-testid="editor-patient">
              <strong>
                {COPY.patientPrefix} {mode.patientName}
              </strong>
            </p>
          )}
          {mode.type === "amend" && (
            <p style={hintStyle}>
              {amendOfLabel(noteDateLabel(mode.note.occurredAt), mode.note.author.name)} {COPY.amendHint}
            </p>
          )}
          {mode.type === "amend" && carry?.text.trim() && (
            <p style={{ ...hintStyle, fontWeight: 600, color: "var(--sky-700)" }} data-testid="amend-carried">
              {COPY.amendCarriedHint}
            </p>
          )}
          {until && (
            <>
              <p style={{ ...hintStyle, fontWeight: 600, color: "var(--sky-700)" }} data-testid="editable-until">
                {until}
              </p>
              {/* [CF-UI1 · M] Qué pasa cuando vence la ventana: no se bloquea, pasa a enmienda. */}
              <p style={hintStyle} data-testid="editable-until-after">
                {COPY.editWindowAfterHint}
              </p>
            </>
          )}
        </div>
      ) : null}

      {/*
        Tipo, turno y fecha: en el composer inline van en una fila desde 1024 px (`.k-ficha-meta`, CSS de
        evoluciones-view): apilados, con el editor de 10 filas, el composer medía ~800 px y tapaba la primera tarjeta a
        1024×768 y 1366×768 (revisión b A1). En el Drawer (560 px) siguen apilados.
      */}
      <div className="k-ficha-meta" style={{ display: "grid", gap: 14, minWidth: 0 }}>
        <div style={{ minWidth: 0 }}>
          <span style={labelStyle}>{COPY.kindLabel}</span>
          {mode.type === "amend" ? (
            <div style={{ marginTop: 6 }}>
              <KindTag kind={mode.note.kind} />
            </div>
          ) : (
            <KindRadioGroup value={draft.kind} disabled={saving} onChange={(k) => patch({ kind: k })} />
          )}
        </div>

        {showChip && (
          <div role="group" aria-labelledby={ids.bookingLabel} style={{ display: "grid", gap: 4, minWidth: 0 }}>
            <span id={ids.bookingLabel} style={labelStyle}>
              {COPY.bookingLabel}
            </span>
            <BookingChip
              id={ids.booking}
              value={draft.bookingId}
              selected={selectedBooking ?? (note?.booking ?? null)}
              choices={choices}
              fixed={mode.type !== "create" || Boolean(fixed)}
              onChange={onBookingChange}
              disabled={saving}
            />
          </div>
        )}

        {mode.type !== "amend" && (
          // EV2-Z M7: fieldset/legend agrupa fecha + hora + minutos bajo un nombre.
          <fieldset
            data-ficha-when=""
            aria-describedby={errors.occurredAt ? ids.whenError : undefined}
            style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}
          >
            <legend style={{ ...labelStyle, padding: 0 }}>{COPY.occurredAtLabel}</legend>
            <div style={{ marginTop: 6 }}>
              <DateTime24Picker
                value={draft.occurredAtLocal}
                onChange={(v) => patch({ occurredAtLocal: v, occurredAtTouched: true }, "occurredAt")}
                disabled={saving}
                required
              />
            </div>
            {errors.occurredAt && (
              <div id={ids.whenError} className="k-field-error" style={errorStyle}>
                {errors.occurredAt}
              </div>
            )}
          </fieldset>
        )}
      </div>

      {!compact && titleField}

      <HcEditorField
        id={ids.body}
        label={mode.type === "amend" ? COPY.amendBodyLabel : COPY.bodyLabel}
        initialDoc={draft.doc}
        initialText={draft.text}
        resetKey={resetKey}
        onChange={onEditorChange}
        onSubmitShortcut={() => formRef.current?.requestSubmit()}
        placeholder={COPY.bodyPlaceholder}
        disabled={saving}
        error={errors.body ?? null}
        autoFocus={variant === "drawer"}
        rows={variant === "inline" ? INLINE_EDITOR_ROWS : undefined}
      />

      {(!compact || extrasOpen) && (
        <>
          {compact && titleField}
          <DiagnosisField
            id={ids.dx}
            label={COPY.diagnosesLabel}
            value={draft.diagnoses}
            onChange={(next) => patch({ diagnoses: next, ...(next.length === 0 ? { setActiveDiagnosis: false } : {}) })}
            pickerHome={pickerHome}
            disabled={saving}
          />

          {draft.diagnoses.length > 0 && (
            <label
              htmlFor={ids.active}
              style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, color: "var(--navy-700)", minHeight: 44 }}
            >
              <input
                id={ids.active}
                type="checkbox"
                data-testid="ficha-set-active"
                checked={draft.setActiveDiagnosis}
                disabled={saving}
                onChange={(e) => patch({ setActiveDiagnosis: e.target.checked })}
                style={{ marginTop: 2 }}
              />
              <span>
                {COPY.setActiveDiagnosis}
                <span style={{ display: "block", fontSize: 12, color: "var(--navy-500)" }}>{COPY.setActiveDiagnosisHint}</span>
              </span>
            </label>
          )}

        </>
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
          {mode.type === "edit" && mode.note.amendsNoteId == null && onSwitchToAmend && offersAmendAfterError(serverError) && (
            <div>
              <Button type="button" variant="ghost" onClick={() => onSwitchToAmend({ doc: draft.doc, text: draft.text })}>
                {COPY.amendInstead}
              </Button>
            </div>
          )}
        </div>
      )}

      <div
        // Drawer: pie pegado al borde del panel (mismo patrón que «Nuevo turno», booking-modal.module.css .footer):
        // a 390 la ficha larga dejaba «Guardar ficha» abajo del pliegue. `data-drawer-footer` hace que el Drawer
        // reserve su alto (scroll-padding) y suba el toast.
        {...(variant === "drawer" ? { "data-drawer-footer": "" } : {})}
        style={variant === "drawer" ? { ...actionsStyle, ...drawerFooterStyle } : actionsStyle}
      >
        {compact && !extrasOpen && (
          // En la fila de «Guardar ficha» y no en una propia: otra fila más era lo que el composer no podía gastar (A1).
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="ficha-add-extras"
            disabled={saving}
            style={{ marginRight: "auto" }}
            onClick={() => {
              setExtrasOpen(true);
              setFocusReq((r) => ({ n: (r?.n ?? 0) + 1, target: "title" }));
            }}
          >
            <IconPlus size={14} /> {addExtrasLabel}
          </Button>
        )}
        {variant === "inline" && mode.type === "create" && dirty && (
          <Button type="button" variant="ghost" onClick={() => void discard()} disabled={saving}>
            {COPY.discard}
          </Button>
        )}
        {onCancel && (
          // «Cancelar» cierra sin preguntar acá: el que pregunta es el dirty-guard del Drawer.
          <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
            {COPY.cancel}
          </Button>
        )}
        <Button type="submit" disabled={saving} aria-keyshortcuts="Control+Enter Meta+Enter" title={COPY.saveShortcut}>
          {saving ? COPY.saving : submitLabel}
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
                // 0,75 y no 0,6: con 0,6 el texto de los tipos no elegidos quedaba por debajo de 4,5:1.
                opacity: checked ? 1 : 0.75,
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
