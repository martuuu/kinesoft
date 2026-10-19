/**
 * [FC-3c] Formulario único de la ficha: lógica pura del composer (chip del turno y fecha), armado de los inputs de las
 * actions y el borrador en memoria (`lib/hc-draft-store.ts`). Símbolos reales, sin mocks. Corre en TZ=UTC y en
 * TZ=America/Argentina/Buenos_Aires: todo lo de fechas se afirma en reloj AR (en UTC los bugs de huso se ven).
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  composerOccurredAtLocal,
  occurredAtAfterBookingChange,
  pickDefaultComposerBooking,
  type HcComposerBookingCandidate,
} from "@/lib/hc-composer-logic";
import {
  amendInitialDiagnoses,
  buildFichaAmendInput,
  buildFichaCreateInput,
  buildFichaEditInput,
  draftAfterSave,
  draftFitsMode,
  initialFichaDraft,
  isFichaDraftDirty,
  restoreDraft,
  validateFicha,
} from "@/components/fichas/ficha-form-logic";
import { HC_DRAFT_MAX, HC_DRAFT_TTL_MS, createHcDraftStore, hcDraftKey, type HcBeforeUnloadEvent } from "@/lib/hc-draft-store";
import { plainTextToHcDoc } from "@/lib/hc-doc";
import type { FichaDraft, FichaFormCreateMode } from "@/components/fichas/fichas-ui-types";
import type { DiagnosisOption, DiagnosisSnapshot } from "@/lib/diagnoses-types";
import type { ClinicalNoteDTO } from "@/lib/clinical-notes-types";

const cand = (over: Partial<HcComposerBookingCandidate> & { id: string; scheduledFor: string }): HcComposerBookingCandidate => ({
  serviceName: "Kinesio",
  status: "CONFIRMED",
  practitionerId: "pr-otro",
  hasLiveNote: false,
  ...over,
});

const dx = (i: number): DiagnosisOption => ({
  ref: { kind: "text", text: `Dx ${i}` },
  source: "text",
  code: null,
  title: `Dx ${i}`,
  retired: false,
  favorite: false,
});

const KEY = "11111111-1111-4111-8111-111111111111";

describe("[FC-3c] pickDefaultComposerBooking", () => {
  it("[FC-3c] turno de las 23:00 AR visto a las 23:30 AR: es de HOY (en UTC ya es mañana)", () => {
    const now = new Date("2026-10-16T02:30:00.000Z"); // 23:30 AR del 15
    const b2300 = cand({ id: "b-2300", scheduledFor: "2026-10-16T02:00:00.000Z" }); // 23:00 AR del 15
    expect(pickDefaultComposerBooking({ candidates: [b2300], ownPractitionerId: null, now })?.id).toBe("b-2300");
  });

  it("[FC-3c] un turno de mañana AR más cercano no gana al de hoy (mismo día UTC que `now`)", () => {
    const now = new Date("2026-10-16T02:50:00.000Z"); // 23:50 AR del 15
    const tomorrow = cand({ id: "b-0000", scheduledFor: "2026-10-16T03:00:00.000Z" }); // 00:00 AR del 16
    const today = cand({ id: "b-2300", scheduledFor: "2026-10-16T02:00:00.000Z" });
    expect(pickDefaultComposerBooking({ candidates: [tomorrow, today], ownPractitionerId: null, now })?.id).toBe("b-2300");
    expect(pickDefaultComposerBooking({ candidates: [tomorrow], ownPractitionerId: null, now })).toBeNull();
  });

  it("[FC-3c] el propio primero aunque el de otro esté más cerca; sin propio, el más cercano", () => {
    const now = new Date("2026-10-15T15:00:00.000Z"); // 12:00 AR
    const otro = cand({ id: "b-otro", scheduledFor: "2026-10-15T14:45:00.000Z", practitionerId: "pr-otro" });
    const mio = cand({ id: "b-mio", scheduledFor: "2026-10-15T12:00:00.000Z", practitionerId: "pr-yo" });
    const mioTarde = cand({ id: "b-mio-tarde", scheduledFor: "2026-10-15T20:00:00.000Z", practitionerId: "pr-yo" });
    expect(pickDefaultComposerBooking({ candidates: [mioTarde, otro, mio], ownPractitionerId: "pr-yo", now })?.id).toBe("b-mio");
    expect(pickDefaultComposerBooking({ candidates: [mioTarde, otro, mio], ownPractitionerId: null, now })?.id).toBe("b-otro");
    expect(pickDefaultComposerBooking({ candidates: [otro], ownPractitionerId: "pr-yo", now })?.id).toBe("b-otro");
  });

  it("[FC-3c] sin turno hoy → null; uno con ficha viva queda afuera", () => {
    const now = new Date("2026-10-15T15:00:00.000Z");
    const ayer = cand({ id: "b-ayer", scheduledFor: "2026-10-14T15:00:00.000Z" });
    const conFicha = cand({ id: "b-con-ficha", scheduledFor: "2026-10-15T14:00:00.000Z", hasLiveNote: true });
    expect(pickDefaultComposerBooking({ candidates: [], ownPractitionerId: null, now })).toBeNull();
    expect(pickDefaultComposerBooking({ candidates: [ayer], ownPractitionerId: null, now })).toBeNull();
    expect(pickDefaultComposerBooking({ candidates: [conFicha, ayer], ownPractitionerId: null, now })).toBeNull();
    const libre = cand({ id: "b-libre", scheduledFor: "2026-10-15T19:00:00.000Z" });
    expect(pickDefaultComposerBooking({ candidates: [conFicha, libre], ownPractitionerId: null, now })?.id).toBe("b-libre");
  });
});

describe("[FC-3c] la fecha sigue al turno salvo que la hayan tocado", () => {
  const now = new Date("2026-10-15T14:07:30.000Z"); // 11:07 AR

  it("[FC-3c] con turno = su hora AR; sin turno = ahora redondeado hacia abajo a 5 min", () => {
    expect(composerOccurredAtLocal({ scheduledFor: "2026-10-16T02:00:00.000Z" }, now)).toBe("2026-10-15T23:00");
    expect(composerOccurredAtLocal(null, now)).toBe("2026-10-15T11:05");
  });

  it("[FC-3c] cambiar el turno mueve la fecha si no se tocó; si se tocó, queda", () => {
    const booking = { scheduledFor: "2026-10-15T12:30:00.000Z" };
    expect(occurredAtAfterBookingChange({ touched: false, current: "2026-10-15T11:05", booking, now })).toBe("2026-10-15T09:30");
    expect(occurredAtAfterBookingChange({ touched: false, current: "2026-10-15T09:30", booking: null, now })).toBe("2026-10-15T11:05");
    expect(occurredAtAfterBookingChange({ touched: true, current: "2026-10-14T18:00", booking, now })).toBe("2026-10-14T18:00");
  });

  it("[FC-3c] sin tocar la fecha viaja null (default del server); tocada viaja en ISO AR", () => {
    const mode: FichaFormCreateMode = { type: "create", patientId: "pat-1", patientHasNotes: true };
    const d = initialFichaDraft(mode, { viewerPractitionerId: null, now, idempotencyKey: KEY });
    const doc = plainTextToHcDoc("Texto");
    expect(buildFichaCreateInput("pat-1", d, doc).occurredAt).toBeNull();
    const touched = { ...d, occurredAtLocal: "2026-10-14T18:00", occurredAtTouched: true };
    expect(buildFichaCreateInput("pat-1", touched, doc).occurredAt).toBe("2026-10-14T18:00:00-03:00");
  });

  it("[FC-3c] fecha tocada a más de 12 h en el futuro: error antes de mandar", () => {
    const mode: FichaFormCreateMode = { type: "create", patientId: "pat-1", patientHasNotes: true };
    const d: FichaDraft = {
      ...initialFichaDraft(mode, { viewerPractitionerId: null, now, idempotencyKey: KEY }),
      doc: plainTextToHcDoc("Texto"),
      text: "Texto",
      occurredAtLocal: "2026-10-16T11:05",
      occurredAtTouched: true,
    };
    const v = validateFicha(mode, d, now);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.occurredAt).toBeTruthy();
  });
});

describe("[FC-3c] estado inicial y armado de inputs", () => {
  const now = new Date("2026-10-15T15:00:00.000Z");

  it("[FC-3c] FC-UI-D5: sin fichas «Primera consulta», con fichas «Evolución»; el chip arranca en el de hoy", () => {
    const bookings = [cand({ id: "b-hoy", scheduledFor: "2026-10-15T14:00:00.000Z" })];
    const first = initialFichaDraft({ type: "create", patientId: "p", patientHasNotes: false, bookings }, { viewerPractitionerId: null, now, idempotencyKey: KEY });
    expect(first.kind).toBe("FIRST_VISIT");
    expect(first.bookingId).toBe("b-hoy");
    expect(first.occurredAtLocal).toBe("2026-10-15T11:00");
    expect(first.setActiveDiagnosis).toBe(false);
    const next = initialFichaDraft({ type: "create", patientId: "p", patientHasNotes: true }, { viewerPractitionerId: null, now, idempotencyKey: KEY });
    expect(next.kind).toBe("EVOLUTION");
    expect(next.bookingId).toBeNull();
    // Turno fijo (agenda): gana sobre los candidatos.
    const fixed = cand({ id: "b-fijo", scheduledFor: "2026-10-14T12:00:00.000Z" });
    const fromAgenda = initialFichaDraft(
      { type: "create", patientId: "p", patientHasNotes: true, bookings, fixedBooking: fixed },
      { viewerPractitionerId: null, now, idempotencyKey: KEY }
    );
    expect(fromAgenda.bookingId).toBe("b-fijo");
    expect(fromAgenda.occurredAtLocal).toBe("2026-10-14T09:00");
  });

  it("[FC-3c] el input lleva doc, ≤5 diagnósticos en orden y setActiveDiagnosis=false por default", () => {
    const mode: FichaFormCreateMode = { type: "create", patientId: "pat-1", patientHasNotes: true };
    const base = initialFichaDraft(mode, { viewerPractitionerId: null, now, idempotencyKey: KEY });
    const doc = plainTextToHcDoc("Mejoró");
    const d: FichaDraft = { ...base, doc, text: "Mejoró", diagnoses: [1, 2, 3, 4, 5, 6].map(dx) };
    const input = buildFichaCreateInput("pat-1", d, doc);
    expect(input.bodyDoc).toEqual(doc);
    expect(input).not.toHaveProperty("body");
    expect(input.diagnoses).toHaveLength(5);
    expect(input.diagnoses?.[0]).toEqual({ kind: "text", text: "Dx 1" });
    expect(input.setActiveDiagnosis).toBe(false);
    expect(input.idempotencyKey).toBe(KEY);
    expect(input.title).toBeNull();
    // Tildada sin diagnósticos no viaja (la casilla solo vale con principal).
    expect(buildFichaCreateInput("pat-1", { ...d, diagnoses: [], setActiveDiagnosis: true }, doc).setActiveDiagnosis).toBe(false);
    expect(buildFichaCreateInput("pat-1", { ...d, setActiveDiagnosis: true }, doc).setActiveDiagnosis).toBe(true);
  });

  const note = (over: Partial<ClinicalNoteDTO> = {}): ClinicalNoteDTO => ({
    id: "n-1",
    patientId: "p",
    bookingId: null,
    amendsNoteId: null,
    kind: "EVOLUTION",
    title: "Control",
    body: "Texto viejo",
    occurredAt: "2026-10-15T12:30:00.000Z",
    author: { userId: "u", practitionerId: "pr", name: "Lic. Pérez" },
    revision: 3,
    createdAt: "2026-10-15T13:00:00.000Z",
    updatedAt: "2026-10-15T13:00:00.000Z",
    voided: null,
    booking: null,
    permissions: { canEdit: true, canAmend: true, canVoid: true, editableUntil: null },
    bodyDoc: null,
    diagnoses: [],
    authorLicense: null,
    importSource: null,
    lateEntry: false,
    sharedDocument: null,
    ...over,
  });

  it("[FC-3c] editar manda solo lo que cambió; cambiar solo el título de una ficha en texto plano vale", () => {
    const n = note();
    const mode = { type: "edit" as const, note: n };
    const init = initialFichaDraft(mode, { viewerPractitionerId: null, now, idempotencyKey: KEY });
    expect(init.occurredAtLocal).toBe("2026-10-15T09:30");
    const d = { ...init, title: "Control 2" };
    const v = validateFicha(mode, d, now);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(buildFichaEditInput(n, init, d, v.doc)).toEqual({ noteId: "n-1", expectedRevision: 3, title: "Control 2" });
    expect(buildFichaEditInput(n, init, init, v.doc)).toBeNull();
  });

  it("[FC-3c] la enmienda no precarga diagnósticos retirados (handoff de FC-2a)", () => {
    const snap = (refId: string, source: DiagnosisSnapshot["source"] = "icd11"): DiagnosisSnapshot => ({
      v: 1, source, refId, code: "FA00", title: refId, uri: null, release: null,
    });
    const snaps = [snap("vigente"), snap("retirado"), snap("propio", "tenant")];
    const marks = (s: DiagnosisSnapshot): DiagnosisOption => ({
      ref: { kind: s.source as "icd11", id: s.refId! },
      source: s.source,
      code: s.code,
      title: s.title,
      retired: s.refId === "retirado",
      favorite: false,
    });
    expect(amendInitialDiagnoses(snaps, marks).map((o) => o.title)).toEqual(["vigente", "propio"]);
    const n = note({ diagnoses: snaps });
    const amend = initialFichaDraft({ type: "amend", note: n }, { viewerPractitionerId: null, now, idempotencyKey: KEY });
    expect(amend.text).toBe("");
    expect(amend.occurredAtLocal).toBe("");
    const doc = plainTextToHcDoc("Agrego");
    const input = buildFichaAmendInput(n, { ...amend, doc, text: "Agrego" }, doc);
    expect(input).toMatchObject({ noteId: "n-1", bodyDoc: doc, setActiveDiagnosis: false, idempotencyKey: KEY });
  });

  it("[FC-3c] sucio: escribir y borrar vuelve a limpio; la fecha cuenta solo si se tocó", () => {
    const mode: FichaFormCreateMode = { type: "create", patientId: "p", patientHasNotes: true };
    const init = initialFichaDraft(mode, { viewerPractitionerId: null, now, idempotencyKey: KEY });
    expect(isFichaDraftDirty(init, { ...init, text: "a" })).toBe(true);
    expect(isFichaDraftDirty(init, { ...init, text: "  " })).toBe(false);
    expect(isFichaDraftDirty(init, { ...init, occurredAtLocal: "2026-10-14T10:00" })).toBe(false);
    expect(isFichaDraftDirty(init, { ...init, occurredAtLocal: "2026-10-14T10:00", occurredAtTouched: true })).toBe(true);
    expect(isFichaDraftDirty(init, { ...init, diagnoses: [dx(1)] })).toBe(true);
  });

  it("[FC-3c] restaurar: desde un turno fijo solo el borrador de ESE turno; un turno que ya no se ofrece queda «Sin turno»", () => {
    const fixed = cand({ id: "b-fijo", scheduledFor: "2026-10-15T14:00:00.000Z" });
    const draft = { ...initialFichaDraft({ type: "create", patientId: "p", patientHasNotes: true }, { viewerPractitionerId: null, now, idempotencyKey: KEY }), bookingId: "b-otro" };
    expect(draftFitsMode({ type: "create", patientId: "p", patientHasNotes: true, fixedBooking: fixed }, draft)).toBe(false);
    expect(draftFitsMode({ type: "create", patientId: "p", patientHasNotes: true, fixedBooking: fixed }, { ...draft, bookingId: "b-fijo" })).toBe(true);
    const inline: FichaFormCreateMode = { type: "create", patientId: "p", patientHasNotes: true, bookings: [fixed] };
    expect(draftFitsMode(inline, draft)).toBe(true);
    expect(restoreDraft(inline, draft, [fixed]).bookingId).toBeNull();
    expect(restoreDraft(inline, { ...draft, bookingId: "b-fijo" }, [fixed]).bookingId).toBe("b-fijo");
    expect(draftFitsMode({ type: "edit", note: note() }, draft)).toBe(false);
  });
});

describe("[FC-3c] borrador en memoria (lib/hc-draft-store.ts)", () => {
  const scope = { tenantId: "t-1", userId: "u-1", patientId: "p-1" };
  const draft = (text: string, key = KEY): FichaDraft => ({
    kind: "EVOLUTION",
    title: "",
    bookingId: null,
    bookingTouched: false,
    occurredAtLocal: "2026-10-15T11:00",
    occurredAtTouched: false,
    doc: plainTextToHcDoc(text),
    text,
    diagnoses: [],
    setActiveDiagnosis: false,
    idempotencyKey: key,
  });

  it("[FC-3c] clave = usuario + consultorio + paciente: otro usuario u otro consultorio no lo ve", () => {
    const store = createHcDraftStore({ isBrowser: true });
    store.write(scope, draft("hola"), 0);
    expect(store.read(scope, 1)?.text).toBe("hola");
    expect(store.read({ ...scope, userId: "u-2" }, 1)).toBeNull();
    expect(store.read({ ...scope, tenantId: "t-2" }, 1)).toBeNull();
    expect(store.read({ ...scope, patientId: "p-2" }, 1)).toBeNull();
    // Un id con separadores no choca con otro alcance.
    expect(hcDraftKey({ tenantId: "a:b", userId: "c", patientId: "d" })).not.toBe(hcDraftKey({ tenantId: "a", userId: "b:c", patientId: "d" }));
  });

  it("[FC-3c] la clave de idempotencia viaja dentro del borrador y rota al guardar", () => {
    const store = createHcDraftStore({ isBrowser: true });
    store.write(scope, draft("hola", KEY), 0);
    expect(store.read(scope, 1)?.idempotencyKey).toBe(KEY);
    // Guardar: el form borra el borrador y arranca uno con clave nueva.
    store.clear(scope);
    expect(store.read(scope, 1)).toBeNull();
    const next = draftAfterSave(draft(""), "22222222-2222-4222-8222-222222222222");
    expect(next.idempotencyKey).not.toBe(KEY);
  });

  it("[FC-3c] TTL de 12 h desde la última escritura", () => {
    const store = createHcDraftStore({ isBrowser: true });
    store.write(scope, draft("hola"), 1_000);
    expect(store.has(scope, 1_000 + HC_DRAFT_TTL_MS - 1)).toBe(true);
    expect(store.read(scope, 1_000 + HC_DRAFT_TTL_MS)).toBeNull();
    expect(store.size()).toBe(0);
  });

  it("[FC-3c] LRU de 20: el menos usado se va (leer cuenta como uso)", () => {
    const store = createHcDraftStore({ isBrowser: true });
    for (let i = 0; i < HC_DRAFT_MAX; i++) store.write({ ...scope, patientId: `p-${i}` }, draft(`t${i}`), i);
    store.read({ ...scope, patientId: "p-0" }, 100); // p-0 pasa a ser el más reciente
    store.write({ ...scope, patientId: "p-nuevo" }, draft("nuevo"), 101);
    expect(store.size()).toBe(HC_DRAFT_MAX);
    expect(store.has({ ...scope, patientId: "p-0" }, 102)).toBe(true);
    expect(store.has({ ...scope, patientId: "p-1" }, 102)).toBe(false);
    expect(store.has({ ...scope, patientId: "p-nuevo" }, 102)).toBe(true);
  });

  it("[FC-3c] en el server (sin window) no escribe nunca: el estado de módulo es compartido entre requests", () => {
    const store = createHcDraftStore({ isBrowser: false });
    store.write(scope, draft("hola"), 0);
    expect(store.size()).toBe(0);
  });

  it("[FC-3c] beforeunload: se instala con el primer borrador y pide confirmar solo si hay uno vivo", () => {
    const add = vi.fn();
    const store = createHcDraftStore({ isBrowser: true, win: { addEventListener: add } });
    expect(add).not.toHaveBeenCalled();
    store.write(scope, draft("hola"));
    store.write({ ...scope, patientId: "p-2" }, draft("chau"));
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0][0]).toBe("beforeunload");
    const ev = (): HcBeforeUnloadEvent & { prevented: boolean } => {
      const e = { prevented: false, returnValue: undefined as unknown, preventDefault: () => { e.prevented = true; } };
      return e;
    };
    const withDraft = ev();
    add.mock.calls[0][1](withDraft);
    expect(withDraft.prevented).toBe(true);
    expect(withDraft.returnValue).toBe("");
    store.clear(scope);
    store.clear({ ...scope, patientId: "p-2" });
    const clean = ev();
    add.mock.calls[0][1](clean);
    expect(clean.prevented).toBe(false);
  });

  it("[FC-3c] subscribe avisa cuando cambia el conjunto (no en cada tecla)", () => {
    const store = createHcDraftStore({ isBrowser: true });
    const fn = vi.fn();
    const off = store.subscribe(fn);
    store.write(scope, draft("h"));
    store.write(scope, draft("ho"));
    store.write(scope, draft("hol"));
    expect(fn).toHaveBeenCalledTimes(1);
    store.clear(scope);
    expect(fn).toHaveBeenCalledTimes(2);
    off();
    store.write(scope, draft("x"));
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("[FC-3c] guard estático: el borrador nunca toca disco (sin localStorage/sessionStorage/indexedDB/caches)", () => {
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
    for (const f of [
      "lib/hc-draft-store.ts",
      "components/fichas/ficha-form.tsx",
      "components/fichas/ficha-form-logic.ts",
      "components/fichas/ficha-drawer.tsx",
      "components/fichas/booking-chip.tsx",
    ]) {
      const code = strip(readFileSync(join(process.cwd(), f), "utf8"));
      expect(code, f).not.toMatch(/\b(localStorage|sessionStorage|indexedDB|caches|document\.cookie|navigator\.storage|openDatabase)\b/);
    }
  });
});
