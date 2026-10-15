/**
 * [EV2-2e] Lógica pura de las primitivas UI de evoluciones (components/clinical-notes/clinical-notes-ui.ts).
 * Corre en TZ=UTC y TZ=AR: toda fecha se arma con offset explícito y se afirma en hora AR.
 * Los permisos se arman con el `permissionsFor` real (lib/clinical-notes-logic.ts), no a mano.
 */
import { describe, expect, it } from "vitest";
import {
  CLINICAL_NOTES_UI_COPY as COPY,
  bodyCounter,
  bodyMaxMessage,
  bookingLabel,
  floorTo5Min,
  buildAmendInput,
  buildCreateInput,
  buildEditInput,
  canEditNow,
  editableUntilLabel,
  hasErrors,
  initialDraft,
  isDraftDirty,
  newIdempotencyKey,
  noteActions,
  offersAmendAfterError,
  validateDraft,
  voidReasonError,
  voidedByLabel,
  voidedSummary,
  type NoteEditorMode,
} from "@/components/clinical-notes/clinical-notes-ui";
import { permissionsFor } from "@/lib/clinical-notes-logic";
import { minuteOptions } from "@/components/ui/datetime-24-picker";
import { CLINICAL_NOTE_BODY_MAX, CLINICAL_NOTE_COPY, type ClinicalNoteDTO } from "@/lib/clinical-notes-types";

const AUTHOR = "user-author";
const OTHER = "user-other";
const CREATED = "2026-10-15T13:00:00.000Z"; // 10:00 AR

function note(over: Partial<ClinicalNoteDTO> = {}, ctx: { actor?: string; owner?: boolean; canWrite?: boolean; now?: string } = {}): ClinicalNoteDTO {
  const base: ClinicalNoteDTO = {
    id: "note-1",
    patientId: "pat-1",
    bookingId: "bk-1",
    amendsNoteId: null,
    kind: "EVOLUTION",
    title: "Control",
    body: "Mejoró la movilidad.",
    occurredAt: "2026-10-15T12:30:00.000Z",
    author: { userId: AUTHOR, practitionerId: "pr-1", name: "Lic. Pérez" },
    revision: 1,
    createdAt: CREATED,
    updatedAt: CREATED,
    voided: null,
    booking: { id: "bk-1", scheduledFor: "2026-10-15T12:30:00.000Z", status: "COMPLETED", serviceName: "Sesión kinésica" },
    permissions: { canEdit: false, canAmend: false, canVoid: false, editableUntil: null },
    ...over,
  };
  const now = new Date(ctx.now ?? "2026-10-15T14:00:00.000Z");
  base.permissions = permissionsFor(
    {
      authorUserId: base.author.userId,
      createdAt: new Date(base.createdAt),
      voidedAt: base.voided ? new Date(base.voided.at) : null,
      amendsNoteId: base.amendsNoteId,
    },
    { actorUserId: ctx.actor ?? AUTHOR, isClinicalOwner: ctx.owner ?? false, canWrite: ctx.canWrite ?? true, now }
  );
  return base;
}

describe("[EV2-2e] borrador del editor", () => {
  const now = new Date("2026-10-15T17:07:00.000Z"); // 14:07 AR

  it("[EV2-2e][EV2-Z M6] crear con turno: fecha = hora del turno en reloj AR (EV2-D24); sin turno: ahora redondeado a 5 min", () => {
    const withBooking = initialDraft(
      { type: "create", patientId: "pat-1", booking: { id: "bk-1", scheduledFor: "2026-10-15T12:30:00.000Z", serviceName: null } },
      now
    );
    expect(withBooking).toEqual({ kind: "EVOLUTION", title: "", body: "", occurredAtLocal: "2026-10-15T09:30" });
    // M6: 14:07 → 14:05 (hacia abajo, el paso del picker; antes viajaba 14:07 mostrando 14:05).
    expect(initialDraft({ type: "create", patientId: "pat-1" }, now).occurredAtLocal).toBe("2026-10-15T14:05");
    expect(floorTo5Min(new Date("2026-10-15T17:04:59.999Z")).toISOString()).toBe("2026-10-15T17:00:00.000Z");
    expect(floorTo5Min(new Date("2026-10-15T17:05:00.000Z")).toISOString()).toBe("2026-10-15T17:05:00.000Z");
    // Con turno no se redondea: es la hora del turno tal cual (un legacy a las 09:32 queda 09:32).
    expect(
      initialDraft(
        { type: "create", patientId: "pat-1", booking: { id: "bk-1", scheduledFor: "2026-10-15T12:32:00.000Z", serviceName: null } },
        now
      ).occurredAtLocal
    ).toBe("2026-10-15T09:32");
    expect(initialDraft({ type: "create", patientId: "pat-1", defaultKind: "FIRST_VISIT" }, now).kind).toBe("FIRST_VISIT");
  });

  it("[EV2-2e] editar parte de lo guardado; enmendar arranca vacío con el tipo de la raíz", () => {
    const n = note({ kind: "DISCHARGE", title: null });
    expect(initialDraft({ type: "edit", note: n }, now)).toEqual({
      kind: "DISCHARGE",
      title: "",
      body: "Mejoró la movilidad.",
      occurredAtLocal: "2026-10-15T09:30",
    });
    expect(initialDraft({ type: "amend", note: n }, now)).toEqual({ kind: "DISCHARGE", title: "", body: "", occurredAtLocal: "" });
  });

  it("[EV2-2e] dirty: cambiar ensucia; escribir y borrar vuelve a limpio", () => {
    const init = initialDraft({ type: "create", patientId: "p" }, now);
    expect(isDraftDirty(init, { ...init })).toBe(false);
    expect(isDraftDirty(init, { ...init, body: "x" })).toBe(true);
    expect(isDraftDirty(init, { ...init, body: "" })).toBe(false);
    expect(isDraftDirty(init, { ...init, kind: "DISCHARGE" })).toBe(true);
  });

  it("[EV2-2e] contador a 20.000 con separador AR; `over` mira el texto recortado", () => {
    expect(bodyCounter("").label).toBe("0 / 20.000");
    expect(bodyCounter("a".repeat(1234)).label).toBe("1.234 / 20.000");
    expect(bodyCounter("a".repeat(CLINICAL_NOTE_BODY_MAX)).over).toBe(false);
    expect(bodyCounter("a".repeat(CLINICAL_NOTE_BODY_MAX) + "   ").over).toBe(false);
    expect(bodyCounter("a".repeat(CLINICAL_NOTE_BODY_MAX + 1)).over).toBe(true);
    expect(bodyCounter("a".repeat(18_000)).near).toBe(true);
  });

  it("[EV2-Z M7] el lector solo oye el contador cerca del límite («Te quedan N caracteres») o pasado", () => {
    expect(bodyCounter("a".repeat(100)).announce).toBe("");
    expect(bodyCounter("a".repeat(18_000)).announce).toBe("Te quedan 2.000 caracteres");
    expect(bodyCounter("a".repeat(CLINICAL_NOTE_BODY_MAX - 1)).announce).toBe("Te quedan 1 carácter");
    expect(bodyCounter("a".repeat(CLINICAL_NOTE_BODY_MAX + 1)).announce).toBe(
      "La evolución puede tener hasta 20.000 caracteres."
    );
    const amend: NoteEditorMode = { type: "amend", note: {} as ClinicalNoteDTO };
    expect(bodyCounter("a".repeat(CLINICAL_NOTE_BODY_MAX + 1), amend).announce).toBe(
      "La enmienda puede tener hasta 20.000 caracteres."
    );
  });

  it("[EV2-Z] cuerpo largo en una enmienda: «La enmienda puede tener hasta…»", () => {
    const amend: NoteEditorMode = { type: "amend", note: {} as ClinicalNoteDTO };
    const d = { kind: "EVOLUTION" as const, title: "", body: "a".repeat(CLINICAL_NOTE_BODY_MAX + 1), occurredAtLocal: "" };
    expect(validateDraft(amend, d, now).body).toBe("La enmienda puede tener hasta 20.000 caracteres.");
    expect(bodyMaxMessage({ type: "create", patientId: "p" })).toBe("La evolución puede tener hasta 20.000 caracteres.");
  });

  it("[EV2-Z M6] picker: el minuto fuera de la grilla de 5' se agrega como opción (no se esconde)", () => {
    expect(minuteOptions("05")).toHaveLength(12);
    expect(minuteOptions("")).toHaveLength(12);
    const opts = minuteOptions("07");
    expect(opts).toHaveLength(13);
    expect(opts.slice(0, 4)).toEqual(["00", "05", "07", "10"]);
  });

  it("[EV2-2e] validación: cuerpo vacío, largo, título > 200 y más de 12 h en el futuro (copy C-EV2-1)", () => {
    const mode: NoteEditorMode = { type: "create", patientId: "p" };
    const ok = { kind: "EVOLUTION" as const, title: "", body: "Bien", occurredAtLocal: "2026-10-15T14:00" };
    expect(hasErrors(validateDraft(mode, ok, now))).toBe(false);
    expect(validateDraft(mode, { ...ok, body: "   " }, now).body).toBe(COPY.emptyBody);
    expect(validateDraft({ type: "amend", note: note() }, { ...ok, body: "" }, now).body).toBe(COPY.emptyAmend);
    expect(validateDraft(mode, { ...ok, body: "a".repeat(CLINICAL_NOTE_BODY_MAX + 1) }, now).body).toContain("20.000");
    expect(validateDraft(mode, { ...ok, title: "t".repeat(201) }, now).title).toContain("200");
    // 14:07 AR + 12 h = 02:07 del 16: 02:05 vale, 02:10 no.
    expect(validateDraft(mode, { ...ok, occurredAtLocal: "2026-10-16T02:05" }, now).occurredAt).toBeUndefined();
    // [EV2-Z] sin turno el copy habla de la fecha; con turno (crear o editar), de la hora del turno.
    expect(validateDraft(mode, { ...ok, occurredAtLocal: "2026-10-16T02:10" }, now).occurredAt).toBe(CLINICAL_NOTE_COPY.futureNoBooking);
    const withBooking: NoteEditorMode = { type: "create", patientId: "p", booking: { id: "bk-1", scheduledFor: "2026-10-15T17:00:00.000Z", serviceName: null } };
    expect(validateDraft(withBooking, { ...ok, occurredAtLocal: "2026-10-16T02:10" }, now).occurredAt).toBe(CLINICAL_NOTE_COPY.future);
    expect(validateDraft({ type: "edit", note: note() }, { ...ok, occurredAtLocal: "2026-10-16T02:10" }, now).occurredAt).toBe(CLINICAL_NOTE_COPY.future);
    expect(validateDraft({ type: "edit", note: note({ bookingId: null, booking: null }) }, { ...ok, occurredAtLocal: "2026-10-16T02:10" }, now).occurredAt).toBe(
      CLINICAL_NOTE_COPY.futureNoBooking
    );
    expect(validateDraft(mode, { ...ok, occurredAtLocal: "" }, now).occurredAt).toBeTruthy();
    // La enmienda no lleva fecha (la pone el server).
    expect(validateDraft({ type: "amend", note: note() }, { ...ok, occurredAtLocal: "" }, now).occurredAt).toBeUndefined();
  });
});

describe("[EV2-2e] inputs de las actions", () => {
  const now = new Date("2026-10-15T17:07:00.000Z");
  const KEY = "3b241101-e2bb-4255-8caf-4136c566a962";

  it("[EV2-2e] crear: fecha solo si se tocó (si no, default del server); título vacío → null", () => {
    const mode = {
      type: "create" as const,
      patientId: "pat-1",
      booking: { id: "bk-1", scheduledFor: "2026-10-15T12:30:00.000Z", serviceName: null },
    };
    const init = initialDraft(mode, now);
    expect(buildCreateInput(mode, init, { ...init, body: "Texto", title: "  " }, KEY)).toEqual({
      patientId: "pat-1",
      bookingId: "bk-1",
      kind: "EVOLUTION",
      title: null,
      body: "Texto",
      occurredAt: null,
      idempotencyKey: KEY,
    });
    const moved = buildCreateInput(mode, init, { ...init, body: "Texto", occurredAtLocal: "2026-10-15T10:00" }, KEY);
    expect(moved.occurredAt).toBe("2026-10-15T10:00:00-03:00");
    expect(new Date(moved.occurredAt as string).toISOString()).toBe("2026-10-15T13:00:00.000Z");
  });

  it("[EV2-2e] editar: solo lo que cambió, con la revisión abierta; nada cambiado → null", () => {
    const n = note({ revision: 3 });
    const init = initialDraft({ type: "edit", note: n }, now);
    expect(buildEditInput(n, init, init)).toBeNull();
    expect(buildEditInput(n, init, { ...init, body: `${init.body}  ` })).toBeNull();
    expect(buildEditInput(n, init, { ...init, body: "Nuevo" })).toEqual({ noteId: "note-1", expectedRevision: 3, body: "Nuevo" });
    expect(buildEditInput(n, init, { ...init, title: "", kind: "DISCHARGE" })).toEqual({
      noteId: "note-1",
      expectedRevision: 3,
      kind: "DISCHARGE",
      title: null,
    });
    expect(buildEditInput(n, init, { ...init, occurredAtLocal: "2026-10-15T09:00" })?.occurredAt).toBe(
      "2026-10-15T09:00:00-03:00"
    );
  });

  it("[EV2-2e] enmendar: sin tipo ni fecha (los hereda/pone el server)", () => {
    expect(buildAmendInput(note(), { kind: "EVOLUTION", title: "", body: "Agrego", occurredAtLocal: "" }, KEY)).toEqual({
      noteId: "note-1",
      title: null,
      body: "Agrego",
      idempotencyKey: KEY,
    });
  });

  it("[EV2-2e] clave de idempotencia: UUID v4 distinto en cada instancia", () => {
    const a = newIdempotencyKey();
    const b = newIdempotencyKey();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });

  it("[EV2-2e] el error «pasaron 24 h» ofrece la enmienda; otros no", () => {
    expect(offersAmendAfterError(CLINICAL_NOTE_COPY.windowClosed)).toBe(true);
    expect(offersAmendAfterError(CLINICAL_NOTE_COPY.stale)).toBe(false);
    expect(offersAmendAfterError(null)).toBe(false);
  });
});

describe("[EV2-2e] permisos en pantalla (permissionsFor real)", () => {
  it("[EV2-2e] autor dentro de 24 h: Editar (no Enmienda), Anular; «Podés editar hasta mañana 10:00»", () => {
    const n = note();
    const at = new Date("2026-10-15T14:00:00.000Z");
    expect(noteActions(n, at)).toEqual({ edit: true, amend: false, void: true, history: false });
    expect(editableUntilLabel(n, at)).toBe("Podés editar hasta mañana 10:00");
  });

  it("[EV2-2e] mismo día AR: «Podés editar hasta HH:MM» en 24 h", () => {
    // Creada 00:30 AR del 15 → editable hasta 00:30 del 16; a las 00:10 del 16 ya es el mismo día.
    const n = note({ createdAt: "2026-10-15T03:30:00.000Z" }, { now: "2026-10-16T03:10:00.000Z" });
    expect(editableUntilLabel(n, new Date("2026-10-16T03:10:00.000Z"))).toBe("Podés editar hasta 00:30");
  });

  it("[EV2-2e] vencida la ventana con la pantalla abierta: se esconde Editar y aparece la enmienda", () => {
    const n = note();
    const later = new Date("2026-10-16T13:00:00.000Z"); // 24 h justas
    expect(canEditNow(n, later)).toBe(false);
    expect(noteActions(n, later)).toEqual({ edit: false, amend: true, void: true, history: false });
    expect(editableUntilLabel(n, later)).toBeNull();
  });

  it("[EV2-2e] otro profesional: Enmienda sí, Editar y Anular no; Titular clínico: Anular sí", () => {
    const at = new Date("2026-10-15T14:00:00.000Z");
    expect(noteActions(note({}, { actor: OTHER }), at)).toEqual({ edit: false, amend: true, void: false, history: false });
    expect(noteActions(note({}, { actor: OTHER, owner: true }), at).void).toBe(true);
  });

  it("[EV2-2e] sin escritura (lector): ningún botón", () => {
    const at = new Date("2026-10-15T14:00:00.000Z");
    expect(noteActions(note({}, { canWrite: false }), at)).toEqual({ edit: false, amend: false, void: false, history: false });
  });

  it("[EV2-2e] enmienda: no se enmienda; historial solo con revisiones", () => {
    const at = new Date("2026-10-15T14:00:00.000Z");
    const a = note({ id: "am-1", amendsNoteId: "note-1", revision: 2 }, { actor: OTHER });
    expect(noteActions(a, at)).toEqual({ edit: false, amend: false, void: false, history: true });
  });
});

describe("[EV2-2e] anular", () => {
  it("[EV2-2e] motivo 3..500 recortado", () => {
    expect(voidReasonError("ab")).toContain("3");
    expect(voidReasonError("  ab  ")).toContain("3");
    expect(voidReasonError("abc")).toBeNull();
    expect(voidReasonError("x".repeat(500))).toBeNull();
    expect(voidReasonError("x".repeat(501))).toContain("500");
  });

  it("[EV2-2e] quién anuló: el autor por nombre; si no, el/la Titular (nunca un email); fecha AR", () => {
    const voided = { at: "2026-10-15T20:15:00.000Z", byUserId: AUTHOR, reason: "Paciente equivocado" };
    const byAuthor = note({ voided });
    expect(voidedByLabel(byAuthor)).toBe("Lic. Pérez");
    expect(voidedSummary(byAuthor)).toBe("Anulada el 15/10/26 17:15 por Lic. Pérez");
    expect(voidedByLabel(note({ voided: { ...voided, byUserId: "owner" } }))).toBe("el/la Titular");
    expect(noteActions(byAuthor, new Date("2026-10-15T21:00:00.000Z"))).toEqual({
      edit: false,
      amend: false,
      void: false,
      history: false,
    });
  });
});

describe("[EV2-2e] encabezados en hora AR", () => {
  it("[EV2-2e] turno con y sin servicio", () => {
    expect(bookingLabel({ scheduledFor: "2026-10-15T12:30:00.000Z", serviceName: "Sesión kinésica" })).toBe(
      "Turno del 15/10/26 09:30 · Sesión kinésica"
    );
    expect(bookingLabel({ scheduledFor: "2026-10-16T02:30:00.000Z", serviceName: null })).toBe("Turno del 15/10/26 23:30");
    expect(bookingLabel(null)).toBeNull();
  });
});
