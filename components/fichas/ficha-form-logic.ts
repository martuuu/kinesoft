/**
 * [FC-3c] Lógica PURA de `FichaForm` (sin React ni DOM): estado inicial por modo, «sucio», validación previa y armado
 * de los inputs de las actions de C-FC3. La testea `tests/unit/fc3c-ficha-form.test.ts` en TZ=UTC y TZ=AR. La barrera
 * real es la action (`lib/clinical-notes.ts`, que re-arma el doc con `validateHcDoc` y resuelve los diagnósticos):
 * acá solo se evita mandar algo que el server va a rechazar.
 *
 * Fechas: `localToARIso`/`isoToARLocalInput` (lib/datetime-ar.ts) y `composerOccurredAtLocal` (lib/hc-composer-logic).
 */
import type { FichaBookingOption, FichaDraft, FichaFormMode } from "@/components/fichas/fichas-ui-types";
import { HC_DOC_ERROR_COPY, hcDocToPlainText, plainTextToHcDoc, validateHcDoc, type HcDoc } from "@/lib/hc-doc";
import { isoToARLocalInput, localToARIso } from "@/lib/datetime-ar";
import { composerOccurredAtLocal, pickDefaultComposerBooking } from "@/lib/hc-composer-logic";
import { DIAGNOSES_MAX, type DiagnosisOption, type DiagnosisRef, type DiagnosisSnapshot } from "@/lib/diagnoses-types";
// FC-3i1: un solo `snapshotToOption` (el de FC-3b, que sabe marcar `retired`). Vive en `diagnosis-field-logic.ts` y lo
// re-exporta `diagnosis-picker-logic.ts`; se importa del primero para no sumar el modelo del picker al chunk del
// composer (que se precarga en paralelo con la hidratación de la HC, §24.9).
import { snapshotToOption } from "@/components/fichas/diagnosis-field-logic";
import { FICHA_FORM_COPY } from "@/components/fichas/fichas-copy";
import {
  CLINICAL_NOTE_COPY,
  CLINICAL_NOTE_FUTURE_LIMIT_MS,
  CLINICAL_NOTE_TITLE_MAX,
  type AmendClinicalNoteInput,
  type ClinicalNoteDTO,
  type CreateClinicalNoteInput,
  type EditClinicalNoteInput,
} from "@/lib/clinical-notes-types";

/**
 * Diagnósticos con los que arranca una ENMIENDA (handoff de FC-2a): la enmienda resuelve sin `keep`, así que uno
 * retirado de la CIE-11 la haría rechazar con `DIAGNOSIS_COPY.retired`. Se precargan los de la raíz SIN los retirados
 * (el profesional suele enmendar el texto, no el diagnóstico, y obligarlo a recargarlos era perderlos).
 */
export function amendInitialDiagnoses(
  snapshots: readonly DiagnosisSnapshot[],
  toOption: (s: DiagnosisSnapshot) => DiagnosisOption = (s) => snapshotToOption(s)
): DiagnosisOption[] {
  return snapshots.map((s) => toOption(s)).filter((o) => !o.retired);
}

export const refsOf = (v: readonly DiagnosisOption[]): DiagnosisRef[] => v.slice(0, DIAGNOSES_MAX).map((o) => o.ref);
const refsKey = (v: readonly DiagnosisOption[]) => JSON.stringify(v.map((o) => o.ref));

/** Candidatos que el chip ofrece (crear sin turno fijo): sin los que ya tienen ficha viva. */
export function bookingChoicesFor(mode: FichaFormMode): FichaBookingOption[] {
  if (mode.type !== "create" || mode.fixedBooking) return [];
  return (mode.bookings ?? []).filter((b) => !b.hasLiveNote);
}

/** El turno que corresponde a un `bookingId` del estado (fijo, uno de los candidatos o el de la nota). */
export function bookingById(
  mode: FichaFormMode,
  choices: readonly FichaBookingOption[],
  id: string | null
): { id: string; scheduledFor: string; serviceName: string | null } | null {
  if (!id) return null;
  if (mode.type === "create") {
    if (mode.fixedBooking) return mode.fixedBooking.id === id ? mode.fixedBooking : null;
    return choices.find((b) => b.id === id) ?? null;
  }
  return mode.note.booking && mode.note.booking.id === id ? mode.note.booking : null;
}

/**
 * Estado inicial SIN borrador (`idempotencyKey` la pone el caller: UUID por instancia).
 * - Crear: tipo por FC-UI-D5 (sin fichas → «Primera consulta»; si no, «Evolución»); turno fijo, o el que elige
 *   `pickDefaultComposerBooking`; fecha = la del turno o ahora (lo mismo que hará el server si no se toca).
 * - Editar: lo guardado (diagnósticos congelados incluidos: editar resuelve con `keep`).
 * - Enmendar: texto vacío (o el que se traía del editor vencido, EV2-Z M5), sin fecha (la pone el server), con los
 *   diagnósticos de la raíz menos los retirados.
 */
export function initialFichaDraft(
  mode: FichaFormMode,
  ctx: { viewerPractitionerId: string | null; now: Date; idempotencyKey: string; carry?: { doc: HcDoc | null; text: string } | null }
): FichaDraft {
  const base = { bookingTouched: false, occurredAtTouched: false, setActiveDiagnosis: false, idempotencyKey: ctx.idempotencyKey };
  if (mode.type === "create") {
    const booking =
      mode.fixedBooking ??
      pickDefaultComposerBooking({ candidates: bookingChoicesFor(mode), ownPractitionerId: ctx.viewerPractitionerId, now: ctx.now });
    return {
      ...base,
      kind: mode.patientHasNotes ? "EVOLUTION" : "FIRST_VISIT",
      title: "",
      bookingId: booking?.id ?? null,
      occurredAtLocal: composerOccurredAtLocal(booking, ctx.now),
      doc: null,
      text: "",
      diagnoses: [],
    };
  }
  const n = mode.note;
  if (mode.type === "edit") {
    return {
      ...base,
      kind: n.kind,
      title: n.title ?? "",
      bookingId: n.bookingId,
      occurredAtLocal: isoToARLocalInput(n.occurredAt),
      doc: n.bodyDoc,
      text: n.bodyDoc ? hcDocToPlainText(n.bodyDoc) : n.body,
      diagnoses: n.diagnoses.map((s) => snapshotToOption(s)),
    };
  }
  return {
    ...base,
    kind: n.kind,
    title: "",
    bookingId: n.bookingId,
    occurredAtLocal: "",
    doc: ctx.carry?.doc ?? null,
    text: ctx.carry?.text ?? "",
    diagnoses: amendInitialDiagnoses(n.diagnoses),
  };
}

/**
 * «Sucio» = distinto del inicial en algo que el usuario escribió o eligió (escribir y borrar vuelve a limpio, como
 * lib/form-dirty). La casilla del diagnóstico activo no cuenta sola: sin diagnósticos está deshabilitada, y con ellos
 * ya está sucio por los diagnósticos. `occurredAtLocal` cuenta solo si se tocó (si sigue al turno, cambiar el turno ya
 * lo marca).
 */
export function isFichaDraftDirty(initial: FichaDraft, d: FichaDraft): boolean {
  return (
    d.kind !== initial.kind ||
    d.title.trim() !== initial.title.trim() ||
    d.bookingId !== initial.bookingId ||
    (d.occurredAtTouched && d.occurredAtLocal !== initial.occurredAtLocal) ||
    d.text.trim() !== initial.text.trim() ||
    refsKey(d.diagnoses) !== refsKey(initial.diagnoses)
  );
}

/** ¿El borrador guardado en memoria sirve para ESTE formulario? */
export function draftFitsMode(mode: FichaFormMode, draft: FichaDraft): boolean {
  if (mode.type !== "create") return false;
  // Entrada desde un turno (agenda, toast, Seguimiento): solo el borrador de ESE turno. Uno de otro turno no se pisa
  // ni se mezcla (el texto de la sesión del martes no puede terminar en el turno del jueves).
  if (mode.fixedBooking) return draft.bookingId === mode.fixedBooking.id;
  // El turno del borrador ya tiene ficha (la cargó otro, o yo desde la agenda): se restaura igual, sin turno.
  return true;
}

/** Borrador restaurado, ajustado a los candidatos de hoy (un turno que ya no se ofrece queda «Sin turno»). */
export function restoreDraft(mode: FichaFormMode, draft: FichaDraft, choices: readonly FichaBookingOption[]): FichaDraft {
  if (mode.type !== "create" || mode.fixedBooking || !draft.bookingId) return draft;
  return choices.some((b) => b.id === draft.bookingId) ? draft : { ...draft, bookingId: null };
}

export type FichaFormErrors = Partial<Record<"title" | "body" | "occurredAt", string>>;
export type FichaValidation = { ok: true; doc: HcDoc } | { ok: false; errors: FichaFormErrors };

/** Validación previa: los mismos topes que los schemas de C-FC3. */
export function validateFicha(mode: FichaFormMode, d: FichaDraft, now: Date): FichaValidation {
  const errors: FichaFormErrors = {};
  // Sin doc = el editor no emitió (una ficha vieja en texto plano que solo cambia el título): se arma del texto.
  const v = validateHcDoc(d.doc ?? plainTextToHcDoc(d.text));
  if (!v.ok) errors.body = HC_DOC_ERROR_COPY[v.reason];
  if (d.title.trim().length > CLINICAL_NOTE_TITLE_MAX) {
    errors.title = `El título puede tener hasta ${CLINICAL_NOTE_TITLE_MAX} caracteres.`;
  }
  if (mode.type !== "amend" && (mode.type === "edit" || d.occurredAtTouched)) {
    const iso = localToARIso(d.occurredAtLocal);
    const at = iso ? new Date(iso) : null;
    if (!at || Number.isNaN(at.getTime())) errors.occurredAt = FICHA_FORM_COPY.occurredAtRequired;
    else if (at.getTime() - now.getTime() > CLINICAL_NOTE_FUTURE_LIMIT_MS) {
      errors.occurredAt = d.bookingId ? CLINICAL_NOTE_COPY.future : CLINICAL_NOTE_COPY.futureNoBooking;
    }
  }
  if (!v.ok || Object.values(errors).some(Boolean)) return { ok: false, errors };
  return { ok: true, doc: v.doc };
}

const titleOrNull = (t: string): string | null => (t.trim() === "" ? null : t.trim());
/** La casilla solo vale con principal (C-FC3 refine 3): sin diagnósticos viaja false aunque el estado diga otra cosa. */
const activeFlag = (d: FichaDraft) => d.setActiveDiagnosis && d.diagnoses.length > 0;

/**
 * Crear: doc (nunca `body`: C-FC3 pide exactamente uno y el server deriva el texto), ≤5 diagnósticos en orden (el
 * primero es el principal) y la fecha SOLO si el usuario la tocó: sin tocar viaja null y el server aplica su default
 * (turno o ahora) con SU reloj, así un composer abierto 20 min no manda un «ahora» viejo.
 */
export function buildFichaCreateInput(patientId: string, d: FichaDraft, doc: HcDoc): CreateClinicalNoteInput {
  return {
    patientId,
    bookingId: d.bookingId,
    kind: d.kind,
    title: titleOrNull(d.title),
    bodyDoc: doc,
    diagnoses: refsOf(d.diagnoses),
    setActiveDiagnosis: activeFlag(d),
    occurredAt: d.occurredAtTouched ? localToARIso(d.occurredAtLocal) : null,
    idempotencyKey: d.idempotencyKey,
  };
}

/** Editar: solo lo que cambió (el schema exige al menos uno); null = nada cambió (no se escribe una revisión vacía). */
export function buildFichaEditInput(note: ClinicalNoteDTO, initial: FichaDraft, d: FichaDraft, doc: HcDoc): EditClinicalNoteInput | null {
  const input: EditClinicalNoteInput = { noteId: note.id, expectedRevision: note.revision };
  let changed = false;
  if (d.kind !== initial.kind) {
    input.kind = d.kind;
    changed = true;
  }
  if (titleOrNull(d.title) !== titleOrNull(initial.title)) {
    input.title = titleOrNull(d.title);
    changed = true;
  }
  if (d.text.trim() !== initial.text.trim() || JSON.stringify(d.doc) !== JSON.stringify(initial.doc)) {
    input.bodyDoc = doc;
    changed = true;
  }
  if (refsKey(d.diagnoses) !== refsKey(initial.diagnoses)) {
    input.diagnoses = refsOf(d.diagnoses);
    changed = true;
  }
  if (d.occurredAtLocal !== initial.occurredAtLocal) {
    input.occurredAt = localToARIso(d.occurredAtLocal);
    changed = true;
  }
  if (activeFlag(d)) {
    input.setActiveDiagnosis = true;
    changed = true;
  }
  return changed ? input : null;
}

export function buildFichaAmendInput(note: ClinicalNoteDTO, d: FichaDraft, doc: HcDoc): AmendClinicalNoteInput {
  return {
    noteId: note.id,
    title: titleOrNull(d.title),
    bodyDoc: doc,
    diagnoses: refsOf(d.diagnoses),
    setActiveDiagnosis: activeFlag(d),
    idempotencyKey: d.idempotencyKey,
  };
}

/** Borrador nuevo después de guardar en el composer inline: la clave ROTA (la próxima ficha no es replay de esta). */
export function draftAfterSave(fresh: FichaDraft, newKey: string): FichaDraft {
  return { ...fresh, idempotencyKey: newKey };
}

/** ←/↑ = anterior, →/↓ = siguiente; cualquier otra tecla, 0 (radio WAI-ARIA del tipo, EV2-Z M7). */
export function kindKeyStep(key: string): -1 | 0 | 1 {
  if (key === "ArrowRight" || key === "ArrowDown") return 1;
  if (key === "ArrowLeft" || key === "ArrowUp") return -1;
  return 0;
}
