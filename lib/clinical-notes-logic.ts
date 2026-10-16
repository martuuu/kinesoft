/**
 * EV2 (C-EV2-2) · Lógica pura de evoluciones: schemas zod, permisos, ventanas de tiempo, cursor y la mezcla de la
 * línea de tiempo. Sin I/O ni `server-only`: la usan las actions (`lib/clinical-notes.ts`, `-read.ts`), la impresión
 * y la UI (para esconder botones; la barrera es siempre la action). Unit test: `tests/unit/clinical-notes-logic.test.ts`.
 *
 * Las ventanas se miden en milisegundos absolutos (`getTime()`), nunca con el reloj local del host: así dan lo mismo
 * en Vercel (UTC) y en una máquina AR (el test corre en las dos TZ).
 */
import type { BookingStatus } from "@prisma/client";
import type { Capability, PatientAccessLevel } from "@/lib/capabilities";
import {
  CLINICAL_NOTE_EDIT_WINDOW_MS,
  CLINICAL_NOTE_FUTURE_LIMIT_MS,
  TIMELINE_QUERY_MAX,
  type ClinicalNoteDTO,
  type ClinicalNotePermissions,
  type TimelineItem,
  type TimelineSessionDTO,
} from "@/lib/clinical-notes-types";

export type Decision<R extends string> = { ok: true } | { ok: false; reason: R };

const OK = { ok: true } as const;
function no<R extends string>(reason: R): Decision<R> {
  return { ok: false, reason };
}

// ─── Schemas ─────────────────────────────────────────────────────────────────
// PF1-Z (D-PF5): los zod de alta/edición/enmienda/anulación viven en `lib/clinical-notes-schemas.ts` (server-only).
// Este archivo lo importan componentes cliente (`clinicalNoteDeepLink` en la sala y el drawer del turno,
// `bookingTargetDecision` en Evoluciones) y con los schemas adentro arrastraba zod (~13 kB gz) al JS inicial de /sala,
// /seguimiento/[id] y el perfil del paciente.

// ─── Permisos ────────────────────────────────────────────────────────────────

/**
 * Lee: `clinical.read` + acceso `full`. Forma POSITIVA (AUDIT: nunca `access !== "basic"`, que abriría `admin`, el
 * nivel de la Secretaria/Facturación sobre todo el consultorio, PD-13).
 */
export function canReadClinicalNotes(caps: ReadonlySet<Capability>, access: PatientAccessLevel): boolean {
  return caps.has("clinical.read") && access === "full";
}

/**
 * Escribe: lo anterior + `practitionerId` no nulo (EV2-D3: el autor es un profesional; `authorPractitionerId` es NOT
 * NULL). Se chequea el valor, nunca una comparación `null === null`.
 */
export function canWriteClinicalNotes(
  caps: ReadonlySet<Capability>,
  access: PatientAccessLevel,
  practitionerId: string | null
): boolean {
  return canReadClinicalNotes(caps, access) && typeof practitionerId === "string" && practitionerId.length > 0;
}

export type NoteRuleRow = { authorUserId: string; createdAt: Date; voidedAt: Date | null; amendsNoteId: string | null };

/**
 * ¿Sigue abierta la ventana de 24 h? Abierta mientras `now < createdAt + 24 h`: en el milisegundo exacto de las 24 h ya
 * está cerrada. La base frena recién a las 24 h + 10 min (EV2-D17): la holgura cubre el reloj del server, nunca al revés.
 */
function editWindowOpen(createdAt: Date, now: Date): boolean {
  return now.getTime() - createdAt.getTime() < CLINICAL_NOTE_EDIT_WINDOW_MS;
}

/** EV2-D1: solo el autor, dentro de 24 h, y nunca una anulada (la base la congela). */
export function editDecision(
  n: NoteRuleRow,
  actorUserId: string,
  now: Date
): Decision<"voided" | "not-author" | "window-closed"> {
  if (n.voidedAt) return no("voided");
  if (n.authorUserId !== actorUserId) return no("not-author");
  if (!editWindowOpen(n.createdAt, now)) return no("window-closed");
  return OK;
}

/** EV2-D14: se enmienda solo una RAÍZ viva (no una enmienda, no una anulada). */
export function amendDecision(n: NoteRuleRow): Decision<"voided" | "is-amendment"> {
  if (n.voidedAt) return no("voided");
  if (n.amendsNoteId != null) return no("is-amendment");
  return OK;
}

/**
 * EV2-D15: el autor o el Titular clínico, sin límite de tiempo. Una ya anulada → `voided` (la idempotencia «la anuló
 * el mismo actor» la resuelve la action al releer, porque depende de `voidedByUserId`).
 */
export function voidDecision(
  n: NoteRuleRow,
  actor: { userId: string; isClinicalOwner: boolean }
): Decision<"voided" | "forbidden"> {
  if (n.voidedAt) return no("voided");
  if (n.authorUserId !== actor.userId && !actor.isClinicalOwner) return no("forbidden");
  return OK;
}

/**
 * Qué muestra la UI para ESTA nota. Todo exige `canWrite` (un lector sin profesional no ve botones de escritura);
 * `editableUntil` solo para el autor con la ventana abierta.
 */
export function permissionsFor(
  n: NoteRuleRow,
  ctx: { actorUserId: string; isClinicalOwner: boolean; canWrite: boolean; now: Date }
): ClinicalNotePermissions {
  const canEdit = ctx.canWrite && editDecision(n, ctx.actorUserId, ctx.now).ok;
  return {
    canEdit,
    canAmend: ctx.canWrite && amendDecision(n).ok,
    canVoid: ctx.canWrite && voidDecision(n, { userId: ctx.actorUserId, isClinicalOwner: ctx.isClinicalOwner }).ok,
    editableUntil: canEdit ? new Date(n.createdAt.getTime() + CLINICAL_NOTE_EDIT_WINDOW_MS).toISOString() : null,
  };
}

// ─── Turno destino y fechas ──────────────────────────────────────────────────

/** EV2-D12: más de 12 h en el futuro. En el borde exacto (12 h justas) todavía vale. */
function tooFarInFuture(at: Date, now: Date): boolean {
  return at.getTime() - now.getTime() > CLINICAL_NOTE_FUTURE_LIMIT_MS;
}

/**
 * Turno destino (EV2-D12/D13): null = no existe o es de otro consultorio. Un turno sin paciente (invitado) o de otro
 * paciente → `other-patient` (la FK compuesta lo frenaría igual con un 500). Cancelado o ausente → no hubo atención.
 */
export function bookingTargetDecision(
  b: { patientId: string | null; status: BookingStatus; scheduledFor: Date } | null,
  patientId: string,
  now: Date
): Decision<"not-found" | "other-patient" | "cancelled" | "no-show" | "future"> {
  if (!b) return no("not-found");
  if (b.patientId !== patientId) return no("other-patient");
  if (b.status === "CANCELLED") return no("cancelled");
  if (b.status === "NO_SHOW") return no("no-show");
  if (tooFarInFuture(b.scheduledFor, now)) return no("future");
  return OK;
}

export function occurredAtDecision(occurredAt: Date, now: Date): Decision<"future"> {
  return tooFarInFuture(occurredAt, now) ? no("future") : OK;
}

/** EV2-D24: la hora del turno; sin turno, ahora. Copia (nunca la misma instancia de Date del caller). */
export function defaultOccurredAt(booking: { scheduledFor: Date } | null, now: Date): Date {
  return new Date((booking?.scheduledFor ?? now).getTime());
}

// ─── Cursor y búsqueda ───────────────────────────────────────────────────────

// base64url UTF-8 sin padding, igual en Node y en el navegador (molde lib/plans-deeplink.ts).
function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(raw: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (raw.length % 4)) % 4);
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Tope del cursor crudo: un `{at, key}` legítimo mide < 150 caracteres; más es basura y no se parsea. */
const CURSOR_MAX_CHARS = 512;
const TIMELINE_KEY_RE = /^[ns]:[A-Za-z0-9_-]{1,64}$/;

export function encodeTimelineCursor(c: { at: Date; key: string }): string {
  return toBase64Url(JSON.stringify({ at: c.at.toISOString(), key: c.key }));
}

/** Inválido (vacío, base64/JSON roto, fecha o key mal formadas) → null: la lectura arranca de la primera página. */
export function decodeTimelineCursor(raw: string | null | undefined): { at: Date; key: string } | null {
  if (!raw || raw.length > CURSOR_MAX_CHARS) return null;
  const text = fromBase64Url(raw);
  if (text == null) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const { at, key } = json as { at?: unknown; key?: unknown };
  if (typeof at !== "string" || typeof key !== "string" || !TIMELINE_KEY_RE.test(key)) return null;
  const date = new Date(at);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== at) return null;
  return { at: date, key };
}

export function normalizeTimelineQuery(q: string | null | undefined): string | null {
  if (q == null) return null;
  const t = q.replace(/\s+/g, " ").trim().slice(0, TIMELINE_QUERY_MAX).trim();
  return t === "" ? null : t;
}

// ─── Línea de tiempo (EV2-D4) ────────────────────────────────────────────────

type Entry =
  | { type: "note"; at: string; key: string; ms: number; note: ClinicalNoteDTO }
  | { type: "session"; at: string; key: string; ms: number; session: TimelineSessionDTO };

/** Orden keyset (at DESC, key DESC): el mismo que la lectura aplica con `(at, key) < (cursor)`. */
function compareDesc(a: { ms: number; key: string }, b: { ms: number; key: string }): number {
  if (a.ms !== b.ms) return b.ms - a.ms;
  return a.key < b.key ? 1 : a.key > b.key ? -1 : 0;
}

function byCreatedAsc(a: ClinicalNoteDTO, b: ClinicalNoteDTO): number {
  const d = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (d !== 0) return d;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Mezcla raíces (desc por occurredAt,id) y sesiones (desc por completedAt,id) con keyset (at DESC, key DESC; keys
 * `n:<id>` / `s:<id>`), cuelga las enmiendas de su raíz y absorbe en la nota la sesión de su mismo turno si está en la
 * misma tanda. Corta en `limit` y devuelve el cursor del último elemento CONSUMIDO (una sesión absorbida cuenta como
 * consumida). Límite conocido: si la sesión y la nota del mismo turno caen en páginas distintas, se muestran separadas.
 *
 * Cómo se garantiza que nada se pierda ni se repita entre páginas (la lectura trae `limit + 1` de cada lista):
 *  - Una sesión que en el orden viene ANTES que su nota (lo normal: se completa después de la hora del turno) se
 *    retiene y sale adentro de la nota. Si la nota queda fuera del corte, se recalcula con esa sesión suelta en su
 *    lugar (punto fijo: cada vuelta suelta al menos una, así que termina).
 *  - Una sesión que viene DESPUÉS de su nota se absorbe al emitir la nota; si su lugar queda más allá del cursor, se
 *    despega y sale suelta en la página siguiente (si no, la keyset la traería de nuevo: duplicado).
 *  - `nextCursor` = null solo si se consumió todo lo que vino; con `limit + 1` de cada lista eso implica que no hay más.
 */
export function mergeTimeline(
  roots: ClinicalNoteDTO[],
  amendments: ClinicalNoteDTO[],
  sessions: TimelineSessionDTO[],
  limit: number
): { items: TimelineItem[]; nextCursor: string | null } {
  const max = Math.max(1, Math.floor(limit));

  const entries: Entry[] = [
    ...roots.map(
      (note): Entry => ({ type: "note", at: note.occurredAt, key: `n:${note.id}`, ms: Date.parse(note.occurredAt), note })
    ),
    ...sessions.map(
      (session): Entry => ({
        type: "session",
        at: session.completedAt,
        key: `s:${session.id}`,
        ms: Date.parse(session.completedAt),
        session,
      })
    ),
  ].sort(compareDesc);
  const indexOf = new Map(entries.map((e, i) => [e.key, i]));

  const amendmentsByRoot = new Map<string, ClinicalNoteDTO[]>();
  for (const a of amendments) {
    if (!a.amendsNoteId) continue;
    const list = amendmentsByRoot.get(a.amendsNoteId) ?? [];
    list.push(a);
    amendmentsByRoot.set(a.amendsNoteId, list);
  }
  for (const list of amendmentsByRoot.values()) list.sort(byCreatedAsc);

  // Sesión ↔ raíz del mismo turno dentro de la tanda. Con una anulada y una viva en el mismo turno, gana la viva; si
  // no, la primera en el orden. Una sesión por turno (Booking_session_active_key): la primera que aparezca.
  const rootForBooking = new Map<string, ClinicalNoteDTO>();
  for (const e of entries) {
    if (e.type !== "note" || !e.note.bookingId) continue;
    const prev = rootForBooking.get(e.note.bookingId);
    if (!prev || (prev.voided && !e.note.voided)) rootForBooking.set(e.note.bookingId, e.note);
  }
  const sessionTarget = new Map<string, string>(); // sessionId → rootId
  const sessionForRoot = new Map<string, TimelineSessionDTO>(); // rootId → session
  for (const e of entries) {
    if (e.type !== "session" || !e.session.bookingId) continue;
    const root = rootForBooking.get(e.session.bookingId);
    if (!root || sessionForRoot.has(root.id)) continue;
    sessionTarget.set(e.session.id, root.id);
    sessionForRoot.set(root.id, e.session);
  }

  const loose = new Set<string>(); // sesiones que salen sueltas aunque su nota esté en la tanda
  for (;;) {
    const items: TimelineItem[] = [];
    const held = new Map<string, TimelineSessionDTO>(); // rootId → sesión retenida (venía antes)
    const absorbed = new Set<string>(); // sesiones absorbidas (ya consumidas o por consumir)
    let last = -1;

    for (let i = 0; i < entries.length && items.length < max; i++) {
      last = i;
      const e = entries[i];
      if (e.type === "session") {
        if (absorbed.has(e.session.id)) continue;
        const target = sessionTarget.get(e.session.id);
        if (target && !loose.has(e.session.id)) {
          held.set(target, e.session);
          absorbed.add(e.session.id);
          continue;
        }
        items.push({ type: "session", key: e.key, at: e.at, session: e.session });
        continue;
      }
      let session: TimelineSessionDTO | null = held.get(e.note.id) ?? null;
      held.delete(e.note.id);
      if (!session) {
        const later = sessionForRoot.get(e.note.id);
        if (later && !loose.has(later.id) && !absorbed.has(later.id)) {
          session = later;
          absorbed.add(later.id);
        }
      }
      items.push({
        type: "note",
        key: e.key,
        at: e.at,
        note: e.note,
        amendments: amendmentsByRoot.get(e.note.id) ?? [],
        session,
      });
    }

    // Retenidas cuya nota quedó fuera del corte: se recalcula con ellas sueltas en su lugar.
    if (held.size > 0) {
      for (const s of held.values()) loose.add(s.id);
      continue;
    }

    // Absorbidas que vienen después del cursor: se despegan (salen sueltas en la página siguiente).
    for (const item of items) {
      if (item.type !== "note" || !item.session) continue;
      if ((indexOf.get(`s:${item.session.id}`) ?? -1) > last) item.session = null;
    }

    const done = last === entries.length - 1;
    const tail = last >= 0 ? entries[last] : null;
    return {
      items,
      nextCursor: done || !tail ? null : encodeTimelineCursor({ at: new Date(tail.ms), key: tail.key }),
    };
  }
}

// ─── Deep link ───────────────────────────────────────────────────────────────

/** Deep link del toast «Cargar evolución» (Recepción/sala): abre la pestaña con el editor del turno. */
export function clinicalNoteDeepLink(patientId: string, bookingId?: string | null): string {
  return `/pacientes/${patientId}?tab=evoluciones` + (bookingId ? `&turno=${encodeURIComponent(bookingId)}` : "");
}
