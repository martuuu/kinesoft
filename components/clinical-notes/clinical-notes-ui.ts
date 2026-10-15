/**
 * EV2-2e · Lógica pura de las primitivas UI de evoluciones (borrador del editor, validación previa, armado de los
 * inputs de las actions, copy derivado y fechas). Sin React ni DOM: la testea `tests/unit/clinical-notes-ui.test.ts`
 * en TZ=UTC y TZ=AR. La barrera real es siempre la action (`lib/clinical-notes.ts`): acá solo se evita mandar algo
 * que el server va a rechazar y se arma el copy.
 *
 * Fechas: todo pasa por `formatDateAR` (timeZone AR) y `localToARIso`/`isoToARLocalInput` (lib/datetime-ar.ts). Nada
 * de `getHours()`/`toLocale*` del host: en Vercel (UTC) daría 3 h corrido.
 */
import type { ClinicalNoteKind } from "@prisma/client";
import {
  CLINICAL_NOTE_BODY_MAX,
  CLINICAL_NOTE_COPY,
  CLINICAL_NOTE_FUTURE_LIMIT_MS,
  CLINICAL_NOTE_KIND_LABEL,
  CLINICAL_NOTE_KINDS,
  CLINICAL_NOTE_TITLE_MAX,
  CLINICAL_NOTE_VOID_REASON_MAX,
  CLINICAL_NOTE_VOID_REASON_MIN,
  type AmendClinicalNoteInput,
  type ClinicalNoteDTO,
  type CreateClinicalNoteInput,
  type EditClinicalNoteInput,
} from "@/lib/clinical-notes-types";
import { formStateKey, isFormDirty } from "@/lib/form-dirty";
import { isoToARLocalInput, localToARIso, toARDateKey } from "@/lib/datetime-ar";
import { formatDateAR } from "@/lib/format";

// ─── Copy de la UI (voseo). Lo de las actions vive en CLINICAL_NOTE_COPY (C-EV2-1). ─────────────────────────────

export const CLINICAL_NOTES_UI_COPY = {
  newTitle: "Nueva evolución",
  editTitle: "Editar evolución",
  amendTitle: "Agregar enmienda",
  kindLabel: "Tipo",
  titleLabel: "Título (opcional)",
  titlePlaceholder: "Ej.: Control post quirúrgico",
  bodyLabel: "Evolución",
  amendBodyLabel: "Enmienda",
  bodyPlaceholder: "Qué se hizo, cómo respondió el paciente, indicaciones…",
  occurredAtLabel: "Fecha y hora de la atención",
  save: "Guardar evolución",
  saveEdit: "Guardar cambios",
  saveAmend: "Guardar enmienda",
  saving: "Guardando…",
  cancel: "Cancelar",
  edit: "Editar",
  amend: "Agregar enmienda",
  void: "Anular",
  history: "Ver versiones anteriores",
  amendHint: "La enmienda se agrega debajo de la evolución original, que queda como estaba.",
  dirtyMessage: "Tenés texto sin guardar en la evolución. Si cerrás, se pierde.",
  savedCreate: "Evolución guardada",
  savedEdit: "Cambios guardados",
  savedAmend: "Enmienda guardada",
  voidTitle: "Anular evolución",
  voidDescription:
    "La evolución no se borra: queda en la historia clínica marcada como anulada, con el motivo y quién la anuló.",
  voidReasonLabel: "Motivo",
  voidReasonPlaceholder: "Ej.: Cargada en el paciente equivocado",
  voidConfirm: "Anular evolución",
  voiding: "Anulando…",
  voided: "Evolución anulada",
  voidedBadge: "Anulada",
  voidedShowText: "Ver el texto anulado",
  amendmentLabel: "Enmienda",
  historyTitle: "Versiones anteriores",
  historyLoading: "Cargando versiones…",
  historyEmpty: "Esta evolución no tiene versiones anteriores.",
  historyForbidden: "No tenés acceso a las versiones de esta evolución.",
  historyCurrent: "Versión actual",
  edited: "Editada",
  emptyBody: "Escribí la evolución.",
  emptyAmend: "Escribí la enmienda.",
  // EV2-Z M5: al pasar de «editar» a «enmienda» (se cerró la ventana de 24 h) el texto escrito no se pierde.
  amendCarriedHint: "Copiamos tu texto: dejá solo lo que agrega o corrige.",
  // EV2-Z bajo: un error de red no es «sin acceso» (antes los dos decían lo mismo y el usuario no reintentaba).
  historyError: "No pudimos cargar las versiones. Probá de nuevo.",
  historyRetry: "Reintentar",
  patientPrefix: "Paciente:",
} as const;

export const KIND_OPTIONS: readonly { value: ClinicalNoteKind; label: string }[] = CLINICAL_NOTE_KINDS.map((k) => ({
  value: k,
  label: CLINICAL_NOTE_KIND_LABEL[k],
}));

/** Tono del `Tag` por tipo: Evolución (lo de todos los días) neutro-azul, Primera consulta lima, Alta suave. */
export const KIND_TAG_TONE: Record<ClinicalNoteKind, "sky" | "lime" | "soft"> = {
  EVOLUTION: "sky",
  FIRST_VISIT: "lime",
  DISCHARGE: "soft",
};

/** EV2-Z M8: borde visible para los pills `soft` (Alta, «Anulada»): el de `.k-tag-soft` es blanco sobre blanco. */
export const SOFT_TAG_BORDER = "1px solid var(--navy-200)";

// ─── Idempotencia ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * UUID v4 por instancia del editor (el server lo valida con `z.string().uuid()`): un doble click o un reintento dentro
 * de la MISMA apertura es replay; abrir de nuevo genera otra. `randomUUID` exige contexto seguro (http en una IP de
 * la red local no lo es): fallback a `getRandomValues`, mismo molde que new-tenant-drawer.tsx.
 */
export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ─── Modos y borrador del editor ────────────────────────────────────────────────────────────────────────────────

export type NoteEditorBooking = { id: string; scheduledFor: string; serviceName: string | null };

export type NoteEditorMode =
  | {
      type: "create";
      patientId: string;
      /** EV2-Z A1: el editor dice de quién es la evolución («Paciente: …»): desde la agenda no está a la vista. */
      patientName?: string;
      booking?: NoteEditorBooking | null;
      defaultKind?: ClinicalNoteKind;
    }
  | { type: "edit"; note: ClinicalNoteDTO }
  | { type: "amend"; note: ClinicalNoteDTO };

/** Estado controlado del form. `occurredAtLocal` = reloj de pared AR «YYYY-MM-DDTHH:mm» (contrato del picker). */
export type NoteDraft = { kind: ClinicalNoteKind; title: string; body: string; occurredAtLocal: string };

/**
 * Borrador inicial. Crear: tipo Evolución, fecha = hora del turno o ahora (EV2-D24, la misma regla que
 * `defaultOccurredAt` del server). Editar: lo guardado. Enmendar: texto vacío (la enmienda es una nota NUEVA; tipo y
 * fecha los pone el server: los de la raíz y «ahora», EV2-D14).
 */
export function initialDraft(mode: NoteEditorMode, now: Date): NoteDraft {
  if (mode.type === "edit") {
    const n = mode.note;
    return { kind: n.kind, title: n.title ?? "", body: n.body, occurredAtLocal: isoToARLocalInput(n.occurredAt) };
  }
  if (mode.type === "amend") {
    return { kind: mode.note.kind, title: "", body: "", occurredAtLocal: "" };
  }
  // EV2-Z M6: sin turno, «ahora» redondeado HACIA ABAJO a 5 min (el paso del picker): un 10:07 se mostraba como
  // 10:05 pero viajaba 10:07. Hacia abajo y no al más cercano: nunca corre la hora al futuro.
  const at = mode.booking ? new Date(mode.booking.scheduledFor) : floorTo5Min(now);
  return { kind: mode.defaultKind ?? "EVOLUTION", title: "", body: "", occurredAtLocal: isoToARLocalInput(at) };
}

const FIVE_MIN_MS = 5 * 60 * 1000;
/** Los husos AR son de hora entera: redondear en epoch a 5 min da lo mismo que en el reloj de pared AR. */
export function floorTo5Min(d: Date): Date {
  return new Date(Math.floor(d.getTime() / FIVE_MIN_MS) * FIVE_MIN_MS);
}

/** Dirty-guard del Drawer: «sucio» = distinto del inicial (escribir y borrar vuelve a limpio), como lib/form-dirty. */
export function isDraftDirty(initial: NoteDraft, current: NoteDraft): boolean {
  return isFormDirty(formStateKey([], initial), formStateKey([], current));
}

/** «La evolución puede tener hasta 20.000 caracteres.» / «La enmienda …» (EV2-Z: la enmienda decía «evolución»). */
export function bodyMaxMessage(mode: NoteEditorMode): string {
  const what = mode.type === "amend" ? "La enmienda" : "La evolución";
  return `${what} puede tener hasta ${CLINICAL_NOTE_BODY_MAX.toLocaleString("es-AR")} caracteres.`;
}

/**
 * Contador del cuerpo: «1.234 / 20.000». `over` mira el texto recortado (el server hace trim antes de medir).
 * `announce` (EV2-Z M7) es lo que lee el lector de pantalla: vacío lejos del límite (un aria-live que cantaba cada tecla
 * era ruido), «Te quedan N caracteres» cerca y el mensaje del máximo pasado.
 */
export function bodyCounter(
  body: string,
  mode?: NoteEditorMode
): { label: string; over: boolean; near: boolean; announce: string } {
  const fmt = (n: number) => n.toLocaleString("es-AR");
  const over = body.trim().length > CLINICAL_NOTE_BODY_MAX;
  const near = !over && body.length >= CLINICAL_NOTE_BODY_MAX * 0.9;
  const left = Math.max(0, CLINICAL_NOTE_BODY_MAX - body.length);
  return {
    label: `${fmt(body.length)} / ${fmt(CLINICAL_NOTE_BODY_MAX)}`,
    over,
    near,
    announce: over
      ? bodyMaxMessage(mode ?? { type: "create", patientId: "" })
      : near
        ? `Te quedan ${fmt(left)} ${left === 1 ? "carácter" : "caracteres"}`
        : "",
  };
}

export type DraftErrors = Partial<Record<"title" | "body" | "occurredAt", string>>;

/** Validación previa (mismos límites que los schemas de C-EV2-2). Vacío = se puede mandar. */
export function validateDraft(mode: NoteEditorMode, d: NoteDraft, now: Date): DraftErrors {
  const errors: DraftErrors = {};
  const body = d.body.trim();
  if (body.length === 0) {
    errors.body = mode.type === "amend" ? CLINICAL_NOTES_UI_COPY.emptyAmend : CLINICAL_NOTES_UI_COPY.emptyBody;
  } else if (body.length > CLINICAL_NOTE_BODY_MAX) {
    errors.body = bodyMaxMessage(mode);
  }
  if (d.title.trim().length > CLINICAL_NOTE_TITLE_MAX) {
    errors.title = `El título puede tener hasta ${CLINICAL_NOTE_TITLE_MAX} caracteres.`;
  }
  if (mode.type !== "amend") {
    const iso = localToARIso(d.occurredAtLocal);
    const at = iso ? new Date(iso) : null;
    if (!at || Number.isNaN(at.getTime())) errors.occurredAt = "Elegí la fecha y la hora.";
    else if (at.getTime() - now.getTime() > CLINICAL_NOTE_FUTURE_LIMIT_MS) {
      // Mismo copy que el server: «la hora del turno» solo si hay turno; sin turno, el límite es la fecha elegida.
      const hasBooking = mode.type === "edit" ? mode.note.bookingId !== null : Boolean(mode.booking);
      errors.occurredAt = hasBooking ? CLINICAL_NOTE_COPY.future : CLINICAL_NOTE_COPY.futureNoBooking;
    }
  }
  return errors;
}

export function hasErrors(e: DraftErrors): boolean {
  return Object.values(e).some(Boolean);
}

/** `null` = título vacío (el server también lo normaliza; así no viaja un string de espacios). */
function titleOrNull(t: string): string | null {
  const v = t.trim();
  return v === "" ? null : v;
}

/**
 * Crear. La fecha viaja SOLO si el usuario la tocó: sin tocar, el server aplica su default (turno o ahora) con SU reloj;
 * así un editor abierto 20 min no manda un «ahora» viejo.
 */
export function buildCreateInput(
  mode: Extract<NoteEditorMode, { type: "create" }>,
  initial: NoteDraft,
  d: NoteDraft,
  idempotencyKey: string
): CreateClinicalNoteInput {
  return {
    patientId: mode.patientId,
    bookingId: mode.booking?.id ?? null,
    kind: d.kind,
    title: titleOrNull(d.title),
    body: d.body,
    occurredAt: d.occurredAtLocal !== initial.occurredAtLocal ? localToARIso(d.occurredAtLocal) : null,
    idempotencyKey,
  };
}

/**
 * Editar: solo los campos que cambiaron (el schema exige al menos uno). null = nada cambió (no se llama a la action).
 * `expectedRevision` = la revisión que se abrió (optimistic lock: si otro la cambió, `stale`).
 */
export function buildEditInput(note: ClinicalNoteDTO, initial: NoteDraft, d: NoteDraft): EditClinicalNoteInput | null {
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
  if (d.body.trim() !== initial.body.trim()) {
    input.body = d.body;
    changed = true;
  }
  if (d.occurredAtLocal !== initial.occurredAtLocal) {
    input.occurredAt = localToARIso(d.occurredAtLocal);
    changed = true;
  }
  return changed ? input : null;
}

export function buildAmendInput(note: ClinicalNoteDTO, d: NoteDraft, idempotencyKey: string): AmendClinicalNoteInput {
  return { noteId: note.id, title: titleOrNull(d.title), body: d.body, idempotencyKey };
}

export function editorTitle(mode: NoteEditorMode): string {
  if (mode.type === "edit") return CLINICAL_NOTES_UI_COPY.editTitle;
  if (mode.type === "amend") return CLINICAL_NOTES_UI_COPY.amendTitle;
  return CLINICAL_NOTES_UI_COPY.newTitle;
}

export function submitLabel(mode: NoteEditorMode): string {
  if (mode.type === "edit") return CLINICAL_NOTES_UI_COPY.saveEdit;
  if (mode.type === "amend") return CLINICAL_NOTES_UI_COPY.saveAmend;
  return CLINICAL_NOTES_UI_COPY.save;
}

export function savedToast(mode: NoteEditorMode): string {
  if (mode.type === "edit") return CLINICAL_NOTES_UI_COPY.savedEdit;
  if (mode.type === "amend") return CLINICAL_NOTES_UI_COPY.savedAmend;
  return CLINICAL_NOTES_UI_COPY.savedCreate;
}

/** Si la action respondió «pasaron 24 h», el editor ofrece pasar a enmienda en vez de dejar al usuario trabado. */
export function offersAmendAfterError(error: string | null): boolean {
  return error === CLINICAL_NOTE_COPY.windowClosed;
}

// ─── Permisos en pantalla y ventana de 24 h ─────────────────────────────────────────────────────────────────────

/**
 * ¿Mostrar «Editar» AHORA? El DTO trae `canEdit` calculado por el server al leer; si la pantalla quedó abierta y se
 * pasaron las 24 h, se esconde sin recargar (la action lo rechazaría igual con `windowClosed`).
 */
export function canEditNow(note: ClinicalNoteDTO, now: Date): boolean {
  const p = note.permissions;
  if (!p.canEdit || !p.editableUntil) return false;
  return now.getTime() < new Date(p.editableUntil).getTime();
}

/**
 * Botones de la tarjeta. Dentro de las 24 h el autor ve «Editar» y no «Agregar enmienda» (EV2-D14: se le sugiere
 * editar); pasada la ventana, «Agregar enmienda». Los demás profesionales con escritura ven la enmienda siempre.
 */
export function noteActions(note: ClinicalNoteDTO, now: Date): { edit: boolean; amend: boolean; void: boolean; history: boolean } {
  const edit = canEditNow(note, now);
  return {
    edit,
    amend: note.permissions.canAmend && !edit,
    void: note.permissions.canVoid,
    history: note.revision > 1 && !note.voided,
  };
}

/**
 * «Podés editar hasta 14:30» (24 h, hora AR). Como la ventana es de 24 h, el límite cae hoy o mañana: si es mañana se
 * dice («hasta mañana 14:30»), porque «hasta 14:30» a secas se leería como hoy. null si no puede editar.
 */
export function editableUntilLabel(note: ClinicalNoteDTO, now: Date): string | null {
  if (!canEditNow(note, now)) return null;
  const until = new Date(note.permissions.editableUntil as string);
  const hhmm = formatDateAR(until, "time");
  const sameDay = toARDateKey(until) === toARDateKey(now);
  return sameDay ? `Podés editar hasta ${hhmm}` : `Podés editar hasta mañana ${hhmm}`;
}

// ─── Anular ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** null = válido. Mismo rango que `VoidClinicalNoteSchema` (trim, 3..500). */
export function voidReasonError(reason: string): string | null {
  const r = reason.trim();
  if (r.length < CLINICAL_NOTE_VOID_REASON_MIN) {
    return `Escribí el motivo (al menos ${CLINICAL_NOTE_VOID_REASON_MIN} caracteres).`;
  }
  if (r.length > CLINICAL_NOTE_VOID_REASON_MAX) {
    return `El motivo puede tener hasta ${CLINICAL_NOTE_VOID_REASON_MAX} caracteres.`;
  }
  return null;
}

export function voidReasonCounter(reason: string): string {
  return `${reason.length} / ${CLINICAL_NOTE_VOID_REASON_MAX}`;
}

/**
 * Quién la anuló. El DTO trae solo el `byUserId`; por la regla de EV2-D15 anula el autor o el/la Titular clínico/a,
 * así que si no fue el autor fue el/la Titular (sin otra query, y nunca un email).
 */
export function voidedByLabel(note: ClinicalNoteDTO): string {
  if (!note.voided) return "";
  return note.voided.byUserId === note.author.userId ? note.author.name : "el/la Titular";
}

/**
 * «15/10/26 17:15» en hora AR. Se arma con `toARDateKey` + el preset `time`: el preset `compact` de lib/format mete una
 * coma («15/10/26, 17:15») que en una frase se lee mal.
 */
export function shortDateTime(iso: string): string {
  const [y, m, d] = toARDateKey(iso).split("-");
  return `${d}/${m}/${y.slice(2)} ${formatDateAR(iso, "time")}`;
}

/** «Anulada el 12/10/26 14:30 por Lic. Pérez». */
export function voidedSummary(note: ClinicalNoteDTO): string {
  if (!note.voided) return "";
  return `Anulada el ${shortDateTime(note.voided.at)} por ${voidedByLabel(note)}`;
}

// ─── Encabezados ────────────────────────────────────────────────────────────────────────────────────────────────

/** «jueves, 12 de octubre, 14:30» (hora AR). */
export function noteDateLabel(iso: string): string {
  return formatDateAR(iso, "longDateTime");
}

/** «Turno del 12/10/26 14:30 · Sesión kinésica». */
export function bookingLabel(b: { scheduledFor: string; serviceName: string | null } | null | undefined): string | null {
  if (!b) return null;
  const when = shortDateTime(b.scheduledFor);
  return b.serviceName ? `Turno del ${when} · ${b.serviceName}` : `Turno del ${when}`;
}

/** «Lic. Pérez · editada» (la revisión > 1 la sube solo el trigger al editar contenido). */
export function authorLine(note: ClinicalNoteDTO): string {
  return note.revision > 1 ? `${note.author.name} · ${CLINICAL_NOTES_UI_COPY.edited.toLowerCase()}` : note.author.name;
}

/** «Versión 2 · guardada el … · reemplazada el …» para el historial. */
export function revisionLabel(r: { revision: number; savedAt: string; replacedAt: string }): string {
  return `Versión ${r.revision} · guardada el ${shortDateTime(r.savedAt)} · reemplazada el ${shortDateTime(r.replacedAt)}`;
}
