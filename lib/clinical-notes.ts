"use server";

/**
 * EV2 (C-EV2-4) · Escrituras de evoluciones (EV2-2a). Brief EV2 §1 (EV2-D1..D24) y §3 C-EV2-4; tests:
 * `tests/integration/clinical-notes-write.test.ts` (matriz completa, 2 roles).
 *
 * Molde de cada action (todas iguales a propósito):
 *   `withReadOnlyResult` → `getActor()` → `assertModule(actor, "evoluciones")` → zod → `runWithRls` con
 *   `clinicalNoteGateInTx` ADENTRO de la tx → `where: { tenantId }` a mano en cada query (prod conecta con BYPASSRLS:
 *   es la única barrera) → write → `auditInTx` en la misma tx → `revalidatePath` después del commit.
 *
 * - Sin `withSupportWritable`: el soporte no escribe HC (y además no tiene `clinical.read`). En solo lectura (deuda o
 *   soporte) la tx va en `transaction_read_only` y el 25006 vuelve como `{ ok:false }` con el copy del modo lectura.
 * - Nunca se escribe `revision`: la sube el trigger `ClinicalNote_guard` (M9) al copiar la versión anterior a
 *   ClinicalNoteRevision. El optimistic lock va en el `where` (`revision: expectedRevision`), no en el `data`.
 * - `createdAt` se escribe explícito con el `now` del server: el default CURRENT_TIMESTAMP de una columna `timestamp`
 *   sin zona depende del TimeZone de la sesión (brief R11) y la ventana de 24 h se mide contra él.
 * - Los rechazos de acceso no distinguen «no existe» de «no podés» (copy único `forbidden`); una nota de otro
 *   consultorio no se encuentra (`notFound`) porque se busca con `tenantId`.
 * - Errores de la base que se traducen: 23505/P2002 (raíz viva del turno o clave de idempotencia; bajo RLS
 *   `meta.target` llega null, así que se decide releyendo en una tx nueva, precedente
 *   `resolveBookingUpdateUniqueViolation`) y P0001 de la red de 24 h + 10 min (EV2-D17).
 */
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import type { ZodError } from "zod";
import { assertModule } from "@/lib/authz";
import { auditInTx } from "@/lib/audit";
import {
  CLINICAL_NOTE_SELECT,
  clinicalNoteGateInTx,
  toClinicalNoteDTO,
  type ClinicalNoteGate,
  type ClinicalNoteSelected,
} from "@/lib/clinical-notes-internal";
import {
  AmendClinicalNoteSchema,
  CreateClinicalNoteSchema,
  EditClinicalNoteSchema,
  VoidClinicalNoteSchema,
  type CreateClinicalNoteParsed,
} from "@/lib/clinical-notes-schemas";
import {
  amendDecision,
  bookingTargetDecision,
  defaultOccurredAt,
  editDecision,
  occurredAtDecision,
  voidDecision,
} from "@/lib/clinical-notes-logic";
import {
  CLINICAL_NOTE_COPY as COPY,
  type AmendClinicalNoteInput,
  type ClinicalNoteDTO,
  type CreateClinicalNoteInput,
  type EditClinicalNoteInput,
  type VoidClinicalNoteInput,
} from "@/lib/clinical-notes-types";
import { withReadOnlyResult } from "@/lib/read-only-result";
import { runWithRls, type DbClient } from "@/lib/rls";
import { ForbiddenError, getActor, requireActorPractitionerId, type Actor } from "@/lib/session";
import type { ActionResult } from "@/lib/validation";

type Fail = { ok: false; error: string; fieldErrors?: Record<string, string[]> };
type Ok<T> = { ok: true; data: T };

// ─── Actions ─────────────────────────────────────────────────────────────────

export async function createClinicalNote(
  input: CreateClinicalNoteInput
): Promise<ActionResult<{ note: ClinicalNoteDTO; replayed: boolean }>> {
  return withReadOnlyResult(() => createImpl(input));
}

export async function editClinicalNote(input: EditClinicalNoteInput): Promise<ActionResult<{ note: ClinicalNoteDTO }>> {
  return withReadOnlyResult(() => editImpl(input));
}

export async function amendClinicalNote(
  input: AmendClinicalNoteInput
): Promise<ActionResult<{ note: ClinicalNoteDTO; replayed: boolean }>> {
  return withReadOnlyResult(() => amendImpl(input));
}

export async function voidClinicalNote(input: VoidClinicalNoteInput): Promise<ActionResult<{ note: ClinicalNoteDTO }>> {
  return withReadOnlyResult(() => voidImpl(input));
}

// ─── Crear ───────────────────────────────────────────────────────────────────

/**
 * EV2-Z: qué árboles RSC dependen de una evolución.
 * - `/pacientes/<id>`: siempre (pestaña, contador, «Última evolución»).
 * - `/seguimiento` (layout = landing + detalle): solo si cambió la existencia de la RAÍZ VIVA de un turno (crear o
 *   anular una raíz con `bookingId`). Es lo único que lee: el bucket «Sin evolución» (`listSeguimiento`, EV2-D18:
 *   raíz viva, sin enmiendas) y `hasLiveNote` del detalle. Antes el detalle hacía `router.refresh()` a mano.
 * - `/agenda` y `/sala` NO: sus árboles no leen notas (el drawer las pide aparte con `getBookingClinicalNote`; PD-13
 *   deja /sala sin texto clínico). Editar o enmendar no cambia ninguno de los dos predicados.
 */
function revalidateNote(note: ClinicalNoteDTO, opts: { rootLiveChanged: boolean }) {
  revalidatePath(`/pacientes/${note.patientId}`);
  if (opts.rootLiveChanged && note.bookingId && note.amendsNoteId === null) revalidatePath("/seguimiento", "layout");
}

async function createImpl(input: CreateClinicalNoteInput): Promise<ActionResult<{ note: ClinicalNoteDTO; replayed: boolean }>> {
  try {
    const actor = await getActor();
    assertModule(actor, "evoluciones");
    const parsed = CreateClinicalNoteSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    const p = parsed.data;
    const now = new Date();

    let result: ActionResult<{ note: ClinicalNoteDTO; replayed: boolean }>;
    try {
      result = await runWithRls(actor.tenantId, (tx) => createInTx(tx, actor, p, now));
    } catch (e) {
      // EV2-Z a3: carrera chequeo/escritura. El turno se borró (o cambió de paciente: FK compuesta) entre la lectura
      // de `createInTx` y el INSERT → 23503/P2003. Mismo caso que «no encontramos el turno», no un 500.
      if (isFkViolation(e)) return fail(COPY.bookingNotFound);
      // 23505: la clave de idempotencia (doble envío que corrió en paralelo) o el parcial «una raíz viva por turno»
      // (otro editor ganó el turno). La tx quedó abortada; se decide por los datos en una nueva.
      if (!isUniqueViolation(e)) throw e;
      result = await runWithRls(actor.tenantId, async (tx) => {
        const gate = await clinicalNoteGateInTx(tx, actor, p.patientId);
        // EV2-Z a2: el acceso se re-gatea en esta tx nueva (pudo cambiar en el medio: share quitado); sin lectura
        // no hay replay que devuelva la nota.
        if (!gate.canRead) return fail(COPY.forbidden);
        const replay = await replayByKey(tx, actor, gate, p.idempotencyKey, { patientId: p.patientId, amendsNoteId: null }, now);
        return replay ?? fail(COPY.bookingTaken);
      });
    }
    if (result.ok) revalidateNote(result.data.note, { rootLiveChanged: true });
    return result;
  } catch (e) {
    return forbiddenResult(e);
  }
}

async function createInTx(
  tx: DbClient,
  actor: Actor,
  p: CreateClinicalNoteParsed,
  now: Date
): Promise<Fail | Ok<{ note: ClinicalNoteDTO; replayed: boolean }>> {
  const tenantId = actor.tenantId;
  // Gate primero: un paciente de otro consultorio da access "none" → forbidden (no revela si existe).
  const gate = await clinicalNoteGateInTx(tx, actor, p.patientId);
  if (!gate.canWrite) return fail(COPY.forbidden);

  const replay = await replayByKey(tx, actor, gate, p.idempotencyKey, { patientId: p.patientId, amendsNoteId: null }, now);
  if (replay) return replay;

  const bookingId = p.bookingId ?? null;
  let booking: { scheduledFor: Date } | null = null;
  if (bookingId) {
    const b = await tx.booking.findFirst({
      where: { id: bookingId, tenantId },
      select: { patientId: true, status: true, scheduledFor: true },
    });
    const d = bookingTargetDecision(b, p.patientId, now);
    if (!d.ok) return fail(BOOKING_REJECTION[d.reason]);
    // EV2-D2: el parcial ClinicalNote_bookingId_live_key es la red; esto da el copy sin pasar por el 23505.
    const live = await tx.clinicalNote.findFirst({
      where: { tenantId, bookingId, amendsNoteId: null, voidedAt: null },
      select: { id: true },
    });
    if (live) return fail(COPY.bookingTaken);
    booking = b;
  }

  const occurredAt = p.occurredAt ?? defaultOccurredAt(booking, now);
  if (!occurredAtDecision(occurredAt, now).ok) return fail(bookingId ? COPY.future : COPY.futureNoBooking);

  const row = await tx.clinicalNote.create({
    data: {
      tenantId,
      patientId: p.patientId,
      bookingId,
      ...(p.kind ? { kind: p.kind } : {}),
      title: p.title ?? null,
      body: p.body,
      occurredAt,
      authorUserId: actor.userId,
      authorPractitionerId: requireActorPractitionerId(actor),
      // Nombre congelado tal como firmó (brief R14: ya es displayUserName, nunca el email).
      authorName: actor.practitionerName,
      idempotencyKey: p.idempotencyKey,
      createdAt: now,
    },
    select: CLINICAL_NOTE_SELECT,
  });
  await auditInTx(tx, {
    tenantId,
    actorId: actor.userId,
    action: "clinicalNote.create",
    entity: "Patient",
    entityId: row.patientId,
    payload: { noteId: row.id, bookingId: row.bookingId, kind: row.kind },
  });
  return { ok: true, data: { note: dto(row, actor, gate, now), replayed: false } };
}

// ─── Editar ──────────────────────────────────────────────────────────────────

async function editImpl(input: EditClinicalNoteInput): Promise<ActionResult<{ note: ClinicalNoteDTO }>> {
  try {
    const actor = await getActor();
    assertModule(actor, "evoluciones");
    const parsed = EditClinicalNoteSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    const p = parsed.data;
    const tenantId = actor.tenantId;
    const now = new Date();

    let result: Fail | Ok<{ note: ClinicalNoteDTO }>;
    try {
      result = await runWithRls(tenantId, async (tx) => {
        const note = await tx.clinicalNote.findFirst({ where: { id: p.noteId, tenantId }, select: RULE_SELECT });
        if (!note) return fail(COPY.notFound);
        const gate = await clinicalNoteGateInTx(tx, actor, note.patientId);
        if (!gate.canWrite) return fail(COPY.forbidden);
        const d = editDecision(note, actor.userId, now);
        if (!d.ok) return fail(EDIT_REJECTION[d.reason]);
        if (p.occurredAt && !occurredAtDecision(p.occurredAt, now).ok) {
          return fail(note.bookingId ? COPY.future : COPY.futureNoBooking);
        }

        // Solo el contenido que vino (`title: null` borra el título; `undefined` no lo toca). Sin `revision`: el
        // trigger guarda la versión anterior en ClinicalNoteRevision y pone OLD.revision + 1.
        const n = await tx.clinicalNote.updateMany({
          where: { id: note.id, tenantId, revision: p.expectedRevision, voidedAt: null },
          data: {
            ...(p.kind !== undefined ? { kind: p.kind } : {}),
            ...(p.title !== undefined ? { title: p.title } : {}),
            ...(p.body !== undefined ? { body: p.body } : {}),
            ...(p.occurredAt !== undefined ? { occurredAt: p.occurredAt } : {}),
          },
        });
        const row = await tx.clinicalNote.findFirstOrThrow({ where: { id: note.id, tenantId }, select: CLINICAL_NOTE_SELECT });
        // 0 filas: la anularon o la editaron entre la lectura del editor y este guardado (CAS).
        if (n.count === 0) return fail(row.voidedAt ? COPY.voided : COPY.stale);
        await auditInTx(tx, {
          tenantId,
          actorId: actor.userId,
          action: "clinicalNote.edit",
          entity: "Patient",
          entityId: row.patientId,
          payload: { noteId: row.id, bookingId: row.bookingId, revision: row.revision, kind: row.kind },
        });
        return { ok: true as const, data: { note: dto(row, actor, gate, now) } };
      });
    } catch (e) {
      // P0001 de ClinicalNote_guard: con el `where` de arriba (viva, misma revisión) la única rama alcanzable es la
      // red de 24 h + 10 min (EV2-D17), p. ej. con el reloj del server atrasado respecto de la base.
      if (pgErrorCode(e) === "P0001") return fail(COPY.windowClosed);
      throw e;
    }
    if (result.ok) revalidateNote(result.data.note, { rootLiveChanged: false });
    return result;
  } catch (e) {
    return forbiddenResult(e);
  }
}

// ─── Enmendar ────────────────────────────────────────────────────────────────

async function amendImpl(input: AmendClinicalNoteInput): Promise<ActionResult<{ note: ClinicalNoteDTO; replayed: boolean }>> {
  try {
    const actor = await getActor();
    assertModule(actor, "evoluciones");
    const parsed = AmendClinicalNoteSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    const p = parsed.data;
    const tenantId = actor.tenantId;
    const now = new Date();

    let result: Fail | Ok<{ note: ClinicalNoteDTO; replayed: boolean }>;
    try {
      result = await runWithRls(tenantId, async (tx) => {
        const root = await tx.clinicalNote.findFirst({
          where: { id: p.noteId, tenantId },
          select: { ...RULE_SELECT, bookingId: true, kind: true },
        });
        if (!root) return fail(COPY.notFound);
        const gate = await clinicalNoteGateInTx(tx, actor, root.patientId);
        if (!gate.canWrite) return fail(COPY.forbidden);
        const d = amendDecision(root);
        if (!d.ok) return fail(d.reason === "voided" ? COPY.voided : COPY.amendTarget);
        const replay = await replayByKey(tx, actor, gate, p.idempotencyKey, { patientId: root.patientId, amendsNoteId: root.id }, now);
        if (replay) return replay;

        // EV2-D14: hereda paciente, turno y tipo de la raíz; occurredAt = ahora (es lo que se agrega hoy).
        const row = await tx.clinicalNote.create({
          data: {
            tenantId,
            patientId: root.patientId,
            bookingId: root.bookingId,
            amendsNoteId: root.id,
            kind: root.kind,
            title: p.title ?? null,
            body: p.body,
            occurredAt: now,
            authorUserId: actor.userId,
            authorPractitionerId: requireActorPractitionerId(actor),
            authorName: actor.practitionerName,
            idempotencyKey: p.idempotencyKey,
            createdAt: now,
          },
          select: CLINICAL_NOTE_SELECT,
        });
        await auditInTx(tx, {
          tenantId,
          actorId: actor.userId,
          action: "clinicalNote.amend",
          entity: "Patient",
          entityId: row.patientId,
          payload: { noteId: row.id, amendsNoteId: root.id, bookingId: row.bookingId, kind: row.kind },
        });
        return { ok: true as const, data: { note: dto(row, actor, gate, now), replayed: false } };
      });
    } catch (e) {
      // Una enmienda no cuenta para el parcial del turno: el único 23505 posible es la clave (doble envío).
      if (!isUniqueViolation(e)) throw e;
      result = await runWithRls(tenantId, async (tx) => {
        const root = await tx.clinicalNote.findFirst({ where: { id: p.noteId, tenantId }, select: { patientId: true } });
        if (!root) return fail(COPY.notFound);
        const gate = await clinicalNoteGateInTx(tx, actor, root.patientId);
        if (!gate.canRead) return fail(COPY.forbidden); // EV2-Z a2: mismo re-gate que en crear
        const replay = await replayByKey(tx, actor, gate, p.idempotencyKey, { patientId: root.patientId, amendsNoteId: p.noteId }, now);
        return replay ?? fail(COPY.keyReused);
      });
    }
    if (result.ok) revalidateNote(result.data.note, { rootLiveChanged: false });
    return result;
  } catch (e) {
    return forbiddenResult(e);
  }
}

// ─── Anular ──────────────────────────────────────────────────────────────────

async function voidImpl(input: VoidClinicalNoteInput): Promise<ActionResult<{ note: ClinicalNoteDTO }>> {
  try {
    const actor = await getActor();
    assertModule(actor, "evoluciones");
    const parsed = VoidClinicalNoteSchema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    const p = parsed.data;
    const tenantId = actor.tenantId;
    const now = new Date();

    const result = await runWithRls(tenantId, async (tx): Promise<Fail | Ok<{ note: ClinicalNoteDTO }>> => {
      const note = await tx.clinicalNote.findFirst({
        where: { id: p.noteId, tenantId },
        select: { ...RULE_SELECT, voidedByUserId: true },
      });
      if (!note) return fail(COPY.notFound);
      const gate = await clinicalNoteGateInTx(tx, actor, note.patientId);
      if (!gate.canRead) return fail(COPY.forbidden);
      const current = () => tx.clinicalNote.findFirstOrThrow({ where: { id: note.id, tenantId }, select: CLINICAL_NOTE_SELECT });

      const d = voidDecision(note, { userId: actor.userId, isClinicalOwner: gate.isClinicalOwner });
      if (!d.ok) {
        // EV2-D15: anular es idempotente para quien anuló (doble click): ok con la nota tal como quedó, sin audit.
        if (d.reason === "voided" && note.voidedByUserId === actor.userId) {
          return { ok: true, data: { note: dto(await current(), actor, gate, now) } };
        }
        return fail(d.reason === "voided" ? COPY.voided : COPY.voidForbidden);
      }

      const n = await tx.clinicalNote.updateMany({
        where: { id: note.id, tenantId, revision: p.expectedRevision, voidedAt: null },
        data: { voidedAt: now, voidedByUserId: actor.userId, voidReason: p.reason },
      });
      const row = await current();
      if (n.count === 0) {
        // Otra tx ganó en el medio: si fue el mismo actor anulando, es el mismo doble click.
        if (row.voidedAt) return row.voidedByUserId === actor.userId ? { ok: true, data: { note: dto(row, actor, gate, now) } } : fail(COPY.voided);
        return fail(COPY.stale);
      }
      // Sin el motivo (EV2-D16): puede contener texto clínico.
      await auditInTx(tx, {
        tenantId,
        actorId: actor.userId,
        action: "clinicalNote.void",
        entity: "Patient",
        entityId: row.patientId,
        payload: { noteId: row.id, bookingId: row.bookingId, revision: row.revision },
      });
      return { ok: true, data: { note: dto(row, actor, gate, now) } };
    });
    if (result.ok) revalidateNote(result.data.note, { rootLiveChanged: true });
    return result;
  } catch (e) {
    return forbiddenResult(e);
  }
}

// ─── Helpers (no exportados: el archivo es "use server") ─────────────────────

/** Lo que necesitan las reglas puras (NoteRuleRow) + el paciente para el gate. */
const RULE_SELECT = {
  id: true,
  patientId: true,
  bookingId: true,
  authorUserId: true,
  createdAt: true,
  voidedAt: true,
  amendsNoteId: true,
} as const satisfies Prisma.ClinicalNoteSelect;

const BOOKING_REJECTION = {
  "not-found": COPY.bookingNotFound,
  "other-patient": COPY.bookingOtherPatient,
  cancelled: COPY.bookingCancelled,
  "no-show": COPY.bookingNoShow,
  future: COPY.future,
} as const;

const EDIT_REJECTION = {
  voided: COPY.voided,
  "not-author": COPY.notAuthor,
  "window-closed": COPY.windowClosed,
} as const;

function fail(error: string): Fail {
  return { ok: false, error };
}

function invalid(err: ZodError): Fail {
  return {
    ok: false,
    error: err.issues[0]?.message ?? COPY.invalid,
    fieldErrors: err.flatten().fieldErrors as Record<string, string[]>,
  };
}

/** `assertModule` / `requireActorPractitionerId` tiran ForbiddenError con su copy; el resto se propaga. */
function forbiddenResult(e: unknown): Fail {
  if (e instanceof ForbiddenError) return fail(e.message);
  throw e;
}

function dto(row: ClinicalNoteSelected, actor: Actor, gate: ClinicalNoteGate, now: Date): ClinicalNoteDTO {
  return toClinicalNoteDTO(row, { actorUserId: actor.userId, isClinicalOwner: gate.isClinicalOwner, canWrite: gate.canWrite, now });
}

/**
 * Replay por clave de idempotencia (UUID por instancia del editor). Es el mismo envío solo si coincide paciente,
 * autor y destino (raíz: `amendsNoteId` null; enmienda: la misma raíz); si no, la clave se reusó → `keyReused`.
 * null = la clave está libre.
 */
async function replayByKey(
  tx: DbClient,
  actor: Actor,
  gate: ClinicalNoteGate,
  idempotencyKey: string,
  expected: { patientId: string; amendsNoteId: string | null },
  now: Date
): Promise<Fail | Ok<{ note: ClinicalNoteDTO; replayed: true }> | null> {
  const prev = await tx.clinicalNote.findFirst({
    where: { tenantId: actor.tenantId, idempotencyKey },
    select: CLINICAL_NOTE_SELECT,
  });
  if (!prev) return null;
  const same =
    prev.patientId === expected.patientId &&
    prev.authorUserId === actor.userId &&
    prev.amendsNoteId === expected.amendsNoteId;
  if (!same) return fail(COPY.keyReused);
  return { ok: true, data: { note: dto(prev, actor, gate, now), replayed: true } };
}

function isFkViolation(e: unknown): boolean {
  return (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003") || pgErrorCode(e) === "23503";
}

function isUniqueViolation(e: unknown): boolean {
  return (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") || pgErrorCode(e) === "23505";
}

/**
 * SQLSTATE de un error de Postgres que atraviesa Prisma. Un RAISE de trigger en una query de modelo no tiene código
 * Prisma propio: llega como Unknown (o Known con `meta.code`) y el SQLSTATE solo aparece en el mensaje
 * (`code: "P0001"`), mismo parseo que tests/integration/clinical-notes-m9.test.ts.
 */
function pgErrorCode(e: unknown): string | null {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = (e.meta as { code?: unknown } | undefined)?.code;
    if (typeof meta === "string") return meta;
  }
  if (e instanceof Prisma.PrismaClientKnownRequestError || e instanceof Prisma.PrismaClientUnknownRequestError) {
    const m = /SQLSTATE[: ]+([0-9A-Z]{5})|code: "([0-9A-Z]{5})"/.exec(e.message);
    return m?.[1] ?? m?.[2] ?? null;
  }
  return null;
}
