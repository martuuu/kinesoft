/**
 * [EV2-1a] Lógica pura de evoluciones (C-EV2-2). `now` fijo; corre en TZ=UTC (`npm test`) y en TZ=AR
 * (`npm run test:tz-ar`): las ventanas se miden en ms absolutos, así que los bordes dan igual en las dos.
 */
import { describe, it, expect } from "vitest";
import type { Capability } from "@/lib/capabilities";
import { parseProfilePlanParams, stripPlanIntentParams } from "@/lib/plans-deeplink";
import {
  AmendClinicalNoteSchema,
  CreateClinicalNoteSchema,
  EditClinicalNoteSchema,
  VoidClinicalNoteSchema,
  amendDecision,
  bookingTargetDecision,
  canReadClinicalNotes,
  canWriteClinicalNotes,
  clinicalNoteDeepLink,
  decodeTimelineCursor,
  defaultOccurredAt,
  editDecision,
  encodeTimelineCursor,
  mergeTimeline,
  normalizeTimelineQuery,
  occurredAtDecision,
  permissionsFor,
  voidDecision,
  type NoteRuleRow,
} from "@/lib/clinical-notes-logic";
import {
  CLINICAL_NOTE_EDIT_WINDOW_MS,
  CLINICAL_NOTE_FUTURE_LIMIT_MS,
  TIMELINE_QUERY_MAX,
  type ClinicalNoteDTO,
  type TimelineSessionDTO,
} from "@/lib/clinical-notes-types";

// 15-oct 21:30 AR = 16-oct 00:30 UTC: cruza el día según la TZ (si algo usara el reloj local, se vería acá).
const NOW = new Date("2026-10-16T00:30:00.000Z");
const H = 60 * 60 * 1000;
const at = (ms: number) => new Date(NOW.getTime() + ms);

const CLINICAL = new Set<Capability>(["clinical.read"]);
const NONE = new Set<Capability>();

function row(p: Partial<NoteRuleRow> = {}): NoteRuleRow {
  return { authorUserId: "u-autor", createdAt: at(-H), voidedAt: null, amendsNoteId: null, ...p };
}

describe("[EV2-1a] permisos de lectura y escritura", () => {
  it("lee solo con clinical.read + full (forma positiva)", () => {
    expect(canReadClinicalNotes(CLINICAL, "full")).toBe(true);
    for (const a of ["admin", "basic", "none"] as const) expect(canReadClinicalNotes(CLINICAL, a)).toBe(false);
    expect(canReadClinicalNotes(NONE, "full")).toBe(false);
  });

  it("escribe solo además con practitionerId no nulo (EV2-D3)", () => {
    expect(canWriteClinicalNotes(CLINICAL, "full", "pr-1")).toBe(true);
    expect(canWriteClinicalNotes(CLINICAL, "full", null)).toBe(false);
    expect(canWriteClinicalNotes(CLINICAL, "full", "")).toBe(false);
    for (const a of ["admin", "basic", "none"] as const) expect(canWriteClinicalNotes(CLINICAL, a, "pr-1")).toBe(false);
    expect(canWriteClinicalNotes(NONE, "full", "pr-1")).toBe(false);
  });
});

describe("[EV2-1a] editDecision (24 h, EV2-D1)", () => {
  it("el autor edita hasta 1 ms antes de las 24 h; en el borde exacto ya no", () => {
    expect(editDecision(row({ createdAt: at(-CLINICAL_NOTE_EDIT_WINDOW_MS + 1) }), "u-autor", NOW)).toEqual({ ok: true });
    expect(editDecision(row({ createdAt: at(-CLINICAL_NOTE_EDIT_WINDOW_MS) }), "u-autor", NOW)).toEqual({
      ok: false,
      reason: "window-closed",
    });
  });

  it("otro usuario → not-author; anulada → voided (antes que todo)", () => {
    expect(editDecision(row(), "u-otro", NOW)).toEqual({ ok: false, reason: "not-author" });
    expect(editDecision(row({ voidedAt: at(-1) }), "u-autor", NOW)).toEqual({ ok: false, reason: "voided" });
    expect(editDecision(row({ voidedAt: at(-1), createdAt: at(-48 * H) }), "u-otro", NOW)).toEqual({
      ok: false,
      reason: "voided",
    });
  });

  it("una enmienda propia también se edita dentro de la ventana", () => {
    expect(editDecision(row({ amendsNoteId: "n-raiz" }), "u-autor", NOW)).toEqual({ ok: true });
  });
});

describe("[EV2-1a] amendDecision y voidDecision", () => {
  it("se enmienda solo una raíz viva (EV2-D14), sin límite de tiempo", () => {
    expect(amendDecision(row({ createdAt: at(-500 * H) }))).toEqual({ ok: true });
    expect(amendDecision(row({ voidedAt: at(-1) }))).toEqual({ ok: false, reason: "voided" });
    expect(amendDecision(row({ amendsNoteId: "n-raiz" }))).toEqual({ ok: false, reason: "is-amendment" });
  });

  it("anula el autor o el Titular clínico (EV2-D15); una anulada → voided", () => {
    expect(voidDecision(row(), { userId: "u-autor", isClinicalOwner: false })).toEqual({ ok: true });
    expect(voidDecision(row(), { userId: "u-titular", isClinicalOwner: true })).toEqual({ ok: true });
    expect(voidDecision(row(), { userId: "u-otro", isClinicalOwner: false })).toEqual({ ok: false, reason: "forbidden" });
    expect(voidDecision(row({ voidedAt: at(-1) }), { userId: "u-autor", isClinicalOwner: true })).toEqual({
      ok: false,
      reason: "voided",
    });
  });
});

describe("[EV2-1a] permissionsFor", () => {
  const ctx = { actorUserId: "u-autor", isClinicalOwner: false, canWrite: true, now: NOW };

  it("autor dentro de la ventana: todo, y editableUntil = createdAt + 24 h", () => {
    const createdAt = at(-H);
    expect(permissionsFor(row({ createdAt }), ctx)).toEqual({
      canEdit: true,
      canAmend: true,
      canVoid: true,
      editableUntil: new Date(createdAt.getTime() + CLINICAL_NOTE_EDIT_WINDOW_MS).toISOString(),
    });
  });

  it("autor fuera de la ventana: enmienda y anula, no edita", () => {
    expect(permissionsFor(row({ createdAt: at(-25 * H) }), ctx)).toEqual({
      canEdit: false,
      canAmend: true,
      canVoid: true,
      editableUntil: null,
    });
  });

  it("otro profesional: solo enmienda; el Titular clínico además anula", () => {
    expect(permissionsFor(row(), { ...ctx, actorUserId: "u-otro" })).toEqual({
      canEdit: false,
      canAmend: true,
      canVoid: false,
      editableUntil: null,
    });
    expect(permissionsFor(row(), { ...ctx, actorUserId: "u-titular", isClinicalOwner: true }).canVoid).toBe(true);
  });

  it("sin escritura (lector sin profesional): nada", () => {
    expect(permissionsFor(row(), { ...ctx, canWrite: false })).toEqual({
      canEdit: false,
      canAmend: false,
      canVoid: false,
      editableUntil: null,
    });
  });

  it("anulada: nada; enmienda: no se enmienda", () => {
    expect(permissionsFor(row({ voidedAt: at(-1) }), ctx)).toEqual({
      canEdit: false,
      canAmend: false,
      canVoid: false,
      editableUntil: null,
    });
    expect(permissionsFor(row({ amendsNoteId: "n-raiz" }), ctx).canAmend).toBe(false);
  });
});

describe("[EV2-1a] turno destino y fechas (12 h, EV2-D12/D13/D24)", () => {
  const b = (p: Partial<{ patientId: string | null; status: "CONFIRMED" | "CANCELLED" | "NO_SHOW" | "COMPLETED"; scheduledFor: Date }> = {}) => ({
    patientId: "p-1",
    status: "CONFIRMED" as const,
    scheduledFor: at(-H),
    ...p,
  });

  it("cada razón", () => {
    expect(bookingTargetDecision(null, "p-1", NOW)).toEqual({ ok: false, reason: "not-found" });
    expect(bookingTargetDecision(b({ patientId: "p-2" }), "p-1", NOW)).toEqual({ ok: false, reason: "other-patient" });
    expect(bookingTargetDecision(b({ patientId: null }), "p-1", NOW)).toEqual({ ok: false, reason: "other-patient" });
    expect(bookingTargetDecision(b({ status: "CANCELLED" }), "p-1", NOW)).toEqual({ ok: false, reason: "cancelled" });
    expect(bookingTargetDecision(b({ status: "NO_SHOW" }), "p-1", NOW)).toEqual({ ok: false, reason: "no-show" });
    expect(bookingTargetDecision(b({ status: "COMPLETED" }), "p-1", NOW)).toEqual({ ok: true });
  });

  it("12 h justas en el futuro vale; 1 ms más, no", () => {
    expect(bookingTargetDecision(b({ scheduledFor: at(CLINICAL_NOTE_FUTURE_LIMIT_MS) }), "p-1", NOW)).toEqual({ ok: true });
    expect(bookingTargetDecision(b({ scheduledFor: at(CLINICAL_NOTE_FUTURE_LIMIT_MS + 1) }), "p-1", NOW)).toEqual({
      ok: false,
      reason: "future",
    });
    expect(occurredAtDecision(at(CLINICAL_NOTE_FUTURE_LIMIT_MS), NOW)).toEqual({ ok: true });
    expect(occurredAtDecision(at(CLINICAL_NOTE_FUTURE_LIMIT_MS + 1), NOW)).toEqual({ ok: false, reason: "future" });
    expect(occurredAtDecision(at(-365 * 24 * H), NOW)).toEqual({ ok: true });
  });

  it("defaultOccurredAt = hora del turno o ahora (copia, no la misma instancia)", () => {
    const sf = at(-3 * H);
    const d = defaultOccurredAt({ scheduledFor: sf }, NOW);
    expect(d.toISOString()).toBe(sf.toISOString());
    expect(d).not.toBe(sf);
    const n = defaultOccurredAt(null, NOW);
    expect(n.toISOString()).toBe(NOW.toISOString());
    expect(n).not.toBe(NOW);
  });
});

describe("[EV2-1a] schemas zod", () => {
  const key = "7b0a3c9e-4f1d-4a2b-9c3e-1d2f3a4b5c6d";

  it("create: trim del body, título vacío → null, occurredAt ISO → Date, strict", () => {
    const r = CreateClinicalNoteSchema.safeParse({
      patientId: "p_1",
      bookingId: "",
      title: "   ",
      body: "  Mejora del ROM.  ",
      occurredAt: "2026-10-15T13:00:00.000Z",
      idempotencyKey: key,
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.body).toBe("Mejora del ROM.");
    expect(r.data.title).toBeNull();
    expect(r.data.bookingId).toBeNull();
    expect(r.data.occurredAt).toEqual(new Date("2026-10-15T13:00:00.000Z"));
    expect(CreateClinicalNoteSchema.safeParse({ patientId: "p", body: "x", idempotencyKey: key, extra: 1 }).success).toBe(false);
  });

  it("create: body vacío o > 20.000, título > 200, kind fuera del enum, key no uuid, fecha sin zona → inválido", () => {
    const base = { patientId: "p", body: "ok", idempotencyKey: key };
    expect(CreateClinicalNoteSchema.safeParse({ ...base, body: "  \n " }).success).toBe(false);
    expect(CreateClinicalNoteSchema.safeParse({ ...base, body: "a".repeat(20_000) }).success).toBe(true);
    expect(CreateClinicalNoteSchema.safeParse({ ...base, body: "a".repeat(20_001) }).success).toBe(false);
    expect(CreateClinicalNoteSchema.safeParse({ ...base, title: "t".repeat(200) }).success).toBe(true);
    expect(CreateClinicalNoteSchema.safeParse({ ...base, title: "t".repeat(201) }).success).toBe(false);
    expect(CreateClinicalNoteSchema.safeParse({ ...base, kind: "DISCHARGE" }).success).toBe(true);
    expect(CreateClinicalNoteSchema.safeParse({ ...base, kind: "OTRO" }).success).toBe(false);
    expect(CreateClinicalNoteSchema.safeParse({ ...base, idempotencyKey: "abc" }).success).toBe(false);
    expect(CreateClinicalNoteSchema.safeParse({ ...base, occurredAt: "2026-10-15T13:00:00" }).success).toBe(false);
  });

  it("edit: al menos un campo de contenido; expectedRevision int ≥ 1", () => {
    expect(EditClinicalNoteSchema.safeParse({ noteId: "n", expectedRevision: 1 }).success).toBe(false);
    expect(EditClinicalNoteSchema.safeParse({ noteId: "n", expectedRevision: 1, title: null }).success).toBe(true);
    expect(EditClinicalNoteSchema.safeParse({ noteId: "n", expectedRevision: 0, body: "x" }).success).toBe(false);
    expect(EditClinicalNoteSchema.safeParse({ noteId: "n", expectedRevision: 1.5, body: "x" }).success).toBe(false);
    expect(EditClinicalNoteSchema.safeParse({ noteId: "n", expectedRevision: 2, revision: 3, body: "x" }).success).toBe(false);
  });

  it("amend y void", () => {
    expect(AmendClinicalNoteSchema.safeParse({ noteId: "n", body: "Agrego", idempotencyKey: key }).success).toBe(true);
    expect(AmendClinicalNoteSchema.safeParse({ noteId: "n", body: "Agrego" }).success).toBe(false);
    const v = VoidClinicalNoteSchema.safeParse({ noteId: "n", expectedRevision: 1, reason: "  Paciente equivocado " });
    expect(v.success && v.data.reason).toBe("Paciente equivocado");
    expect(VoidClinicalNoteSchema.safeParse({ noteId: "n", expectedRevision: 1, reason: " ab " }).success).toBe(false);
    expect(VoidClinicalNoteSchema.safeParse({ noteId: "n", expectedRevision: 1, reason: "abc" }).success).toBe(true);
    expect(VoidClinicalNoteSchema.safeParse({ noteId: "n", expectedRevision: 1, reason: "a".repeat(501) }).success).toBe(false);
  });
});

describe("[EV2-1a] cursor y búsqueda", () => {
  it("ida y vuelta", () => {
    const c = { at: new Date("2026-10-15T13:00:00.123Z"), key: "n:ckabc123" };
    expect(decodeTimelineCursor(encodeTimelineCursor(c))).toEqual(c);
    const s = { at: new Date("2026-10-15T13:00:00.000Z"), key: "s:sess_1" };
    expect(decodeTimelineCursor(encodeTimelineCursor(s))).toEqual(s);
  });

  it("basura → null", () => {
    for (const raw of [null, undefined, "", "%%%", "no-es-base64!", "x".repeat(600)]) {
      expect(decodeTimelineCursor(raw)).toBeNull();
    }
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    expect(decodeTimelineCursor(Buffer.from("no json").toString("base64url"))).toBeNull();
    expect(decodeTimelineCursor(enc({ at: "ayer", key: "n:1" }))).toBeNull();
    expect(decodeTimelineCursor(enc({ at: "2026-10-15T13:00:00.000Z", key: "x:1" }))).toBeNull();
    expect(decodeTimelineCursor(enc({ at: "2026-10-15T13:00:00.000Z", key: "n:1' OR 1=1" }))).toBeNull();
    expect(decodeTimelineCursor(enc({ at: "2026-10-15T13:00:00.000Z" }))).toBeNull();
    expect(decodeTimelineCursor(enc([1, 2]))).toBeNull();
  });

  it("normalizeTimelineQuery: trim, colapsa espacios, tope, vacío → null", () => {
    expect(normalizeTimelineQuery("  dolor \n  lumbar  ")).toBe("dolor lumbar");
    expect(normalizeTimelineQuery("   ")).toBeNull();
    expect(normalizeTimelineQuery(null)).toBeNull();
    expect(normalizeTimelineQuery(undefined)).toBeNull();
    expect(normalizeTimelineQuery("a".repeat(250))).toHaveLength(TIMELINE_QUERY_MAX);
    expect(normalizeTimelineQuery("50%_off")).toBe("50%_off"); // el escape de LIKE es de la lectura
  });
});

// ─── mergeTimeline ───────────────────────────────────────────────────────────

const T = (h: number) => new Date(Date.parse("2026-10-15T12:00:00.000Z") + h * H).toISOString();

function note(id: string, occurredH: number, p: Partial<ClinicalNoteDTO> = {}): ClinicalNoteDTO {
  return {
    id,
    patientId: "p-1",
    bookingId: null,
    amendsNoteId: null,
    kind: "EVOLUTION",
    title: null,
    body: `cuerpo ${id}`,
    occurredAt: T(occurredH),
    author: { userId: "u-1", practitionerId: "pr-1", name: "Ana Pérez" },
    revision: 1,
    createdAt: T(occurredH),
    updatedAt: T(occurredH),
    voided: null,
    booking: null,
    permissions: { canEdit: false, canAmend: true, canVoid: false, editableUntil: null },
    ...p,
  };
}

function session(id: string, completedH: number, bookingId: string | null = null): TimelineSessionDTO {
  return {
    id,
    programId: "prog-1",
    programTitle: "Rodilla",
    completedAt: T(completedH),
    bookingId,
    notes: null,
    rpe: null,
    paInPre: null,
    paInPost: null,
    exercisesDone: 3,
    exercisesTotal: 4,
  };
}

const keys = (r: ReturnType<typeof mergeTimeline>) =>
  r.items.map((i) => (i.type === "note" ? `${i.key}${i.session ? `+${i.session.id}` : ""}` : i.key));

describe("[EV2-1a] mergeTimeline", () => {
  it("orden desc por fecha; empate de fecha → key desc (s: > n:, y por id)", () => {
    const r = mergeTimeline([note("a", 1), note("b", 5), note("c", 3)], [], [session("x", 3), session("y", 4)], 20);
    expect(keys(r)).toEqual(["n:b", "s:y", "s:x", "n:c", "n:a"]);
    expect(r.nextCursor).toBeNull();
    const tie = mergeTimeline([note("a", 1), note("b", 1)], [], [], 20);
    expect(keys(tie)).toEqual(["n:b", "n:a"]);
  });

  it("no confía en el orden de entrada", () => {
    const r = mergeTimeline([note("a", 1), note("c", 3), note("b", 2)], [], [], 20);
    expect(keys(r)).toEqual(["n:c", "n:b", "n:a"]);
  });

  it("cuelga las enmiendas de su raíz en orden de creación", () => {
    const am2 = note("am2", 9, { amendsNoteId: "a", createdAt: T(9) });
    const am1 = note("am1", 8, { amendsNoteId: "a", createdAt: T(8) });
    const r = mergeTimeline([note("a", 1), note("b", 2)], [am2, am1], [], 20);
    const a = r.items.find((i) => i.key === "n:a");
    expect(a?.type === "note" && a.amendments.map((x) => x.id)).toEqual(["am1", "am2"]);
    const b = r.items.find((i) => i.key === "n:b");
    expect(b?.type === "note" && b.amendments).toEqual([]);
  });

  it("absorbe la sesión del mismo turno (antes o después de la nota en el orden)", () => {
    const r = mergeTimeline(
      [note("a", 1, { bookingId: "bk-1" }), note("b", 5, { bookingId: "bk-2" })],
      [],
      [session("s1", 2, "bk-1"), session("s2", 4, "bk-2"), session("s3", 3, "bk-9")],
      20
    );
    expect(keys(r)).toEqual(["n:b+s2", "s:s3", "n:a+s1"]);
    expect(r.nextCursor).toBeNull();
  });

  it("con una anulada y una viva en el mismo turno, la sesión va con la viva", () => {
    const voided = { at: T(3), byUserId: "u-1", reason: "error" };
    const r = mergeTimeline(
      [note("v", 2, { bookingId: "bk-1", voided }), note("l", 1, { bookingId: "bk-1" })],
      [],
      [session("s1", 4, "bk-1")],
      20
    );
    expect(keys(r)).toEqual(["n:v", "n:l+s1"]);
  });

  it("corta en limit; el cursor es el último consumido y la página siguiente sigue sin huecos ni duplicados", () => {
    const roots = [note("a", 1), note("b", 2), note("c", 3), note("d", 4)];
    const sess = [session("x", 2.5), session("y", 0.5)];
    const p1 = mergeTimeline(roots, [], sess, 2);
    expect(keys(p1)).toEqual(["n:d", "n:c"]);
    const c1 = decodeTimelineCursor(p1.nextCursor);
    expect(c1).toEqual({ at: new Date(T(3)), key: "n:c" });

    // Simula la keyset de la lectura: (at, key) < cursor.
    const after = <X extends { k: string; t: string }>(xs: X[], c: { at: Date; key: string }) =>
      xs.filter((x) => Date.parse(x.t) < c.at.getTime() || (Date.parse(x.t) === c.at.getTime() && x.k < c.key));
    const rest = (c: { at: Date; key: string }) => ({
      roots: after(roots.map((n) => ({ ...n, k: `n:${n.id}`, t: n.occurredAt })), c),
      sess: after(sess.map((s) => ({ ...s, k: `s:${s.id}`, t: s.completedAt })), c),
    });
    const r2 = rest(c1!);
    const p2 = mergeTimeline(r2.roots, [], r2.sess, 2);
    expect(keys(p2)).toEqual(["s:x", "n:b"]);
    const r3 = rest(decodeTimelineCursor(p2.nextCursor)!);
    const p3 = mergeTimeline(r3.roots, [], r3.sess, 2);
    expect(keys(p3)).toEqual(["n:a", "s:y"]);
    expect(p3.nextCursor).toBeNull();
  });

  it("una sesión absorbida cuenta como consumida (no come lugar ni se repite)", () => {
    const r = mergeTimeline(
      [note("a", 1, { bookingId: "bk-1" }), note("b", 0)],
      [],
      [session("s1", 2, "bk-1")],
      2
    );
    expect(keys(r)).toEqual(["n:a+s1", "n:b"]);
    expect(r.nextCursor).toBeNull();
  });

  it("si la nota de una sesión queda fuera del corte, la sesión sale suelta en su lugar (límite conocido)", () => {
    const r = mergeTimeline(
      [note("n1", 3), note("n3", 2), note("n2", 1, { bookingId: "bk-1" })],
      [],
      [session("s1", 4, "bk-1")],
      2
    );
    expect(keys(r)).toEqual(["s:s1", "n:n1"]);
    expect(decodeTimelineCursor(r.nextCursor)).toEqual({ at: new Date(T(3)), key: "n:n1" });
  });

  it("si la sesión (posterior en el orden) queda después del cursor, se despega y sale en la página siguiente", () => {
    // occurredAt editado DESPUÉS de completar la sesión: la nota viene antes en el orden.
    const r = mergeTimeline(
      [note("n1", 5, { bookingId: "bk-1" }), note("n2", 4)],
      [],
      [session("s1", 1, "bk-1")],
      2
    );
    expect(keys(r)).toEqual(["n:n1", "n:n2"]);
    expect(decodeTimelineCursor(r.nextCursor)).toEqual({ at: new Date(T(4)), key: "n:n2" });
  });

  it("sesión posterior en el orden dentro del corte: se absorbe y no se repite", () => {
    const r = mergeTimeline([note("n1", 5, { bookingId: "bk-1" }), note("n2", 0)], [], [session("s1", 1, "bk-1")], 2);
    expect(keys(r)).toEqual(["n:n1+s1", "n:n2"]);
    expect(r.nextCursor).toBeNull();
  });

  it("vacío → sin items ni cursor", () => {
    expect(mergeTimeline([], [], [], 20)).toEqual({ items: [], nextCursor: null });
  });
});

describe("[EV2-1a] deep link", () => {
  it("pestaña evoluciones, con o sin turno", () => {
    expect(clinicalNoteDeepLink("p-1")).toBe("/pacientes/p-1?tab=evoluciones");
    expect(clinicalNoteDeepLink("p-1", null)).toBe("/pacientes/p-1?tab=evoluciones");
    expect(clinicalNoteDeepLink("p-1", "bk 1&x")).toBe("/pacientes/p-1?tab=evoluciones&turno=bk%201%26x");
  });

  it("[EV2-Z] lo que genera es lo que lee el perfil (`parseProfilePlanParams` + `?turno=`) y lo que limpia", () => {
    const href = clinicalNoteDeepLink("p-1", "bk_1");
    const sp = new URL(href, "http://x").searchParams;
    expect(parseProfilePlanParams(sp).tab).toBe("evoluciones");
    expect(sp.get("turno")).toBe("bk_1");
    // La pestaña consume el deep link una vez y saca `turno` (un refresh no reabre el editor); `tab` queda.
    expect(stripPlanIntentParams(href)).toBe("/pacientes/p-1?tab=evoluciones");
  });
});
