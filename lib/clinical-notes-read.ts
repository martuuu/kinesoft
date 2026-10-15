"use server";

/**
 * EV2 (C-EV2-5) · Lecturas de evoluciones (EV2-2b). Firmas congeladas por EV2-1a.
 *
 * Reglas comunes:
 *  - El gate es UNO (`clinicalNoteGateInTx`, lib/clinical-notes-internal.ts) y corre DENTRO de la tx: módulo
 *    `evoluciones` + `clinical.read` + acceso `full`. Sin eso → `null`, sin distinguir «no existe», «es de otro
 *    consultorio» o «no podés» (no revela nada: ni siquiera si el turno tiene evolución).
 *  - `where tenantId` a mano en cada sentencia (en prod la conexión tiene BYPASSRLS: es la única barrera).
 *  - Ids de entrada con la forma de un id de URL antes de tocar la base (basura → null, como «no existe»).
 *
 * `getPatientTimeline` (presupuesto del brief: ≤ 4 sentencias de datos, constante en el volumen; lo fija
 * tests/integration/clinical-notes-timeline-perf.test.ts): (1) raíces por SQL crudo con el turno y el servicio en la
 * MISMA sentencia (Prisma 5 sin `relationJoins` emite una sentencia por relación del `select`), (2) enmiendas de esas
 * raíces, (3) sesiones completadas con sus agregados y el turno activo. El gate aparte (paciente, ajustes, membresía y
 * a lo sumo el share).
 */
import { Prisma, type BookingStatus, type ClinicalNoteKind } from "@prisma/client";
import {
  bookingTargetDecision,
  decodeTimelineCursor,
  mergeTimeline,
  normalizeTimelineQuery,
} from "@/lib/clinical-notes-logic";
import {
  CLINICAL_NOTE_SELECT,
  clinicalNoteGateInTx,
  toClinicalNoteDTO,
  type ClinicalNoteSelected,
} from "@/lib/clinical-notes-internal";
import {
  TIMELINE_PAGE_MAX,
  TIMELINE_PAGE_SIZE,
  type BookingClinicalNoteView,
  type ClinicalNoteDTO,
  type ClinicalNoteRevisionDTO,
  type PatientClinicalSummary,
  type TimelinePage,
  type TimelineSessionDTO,
} from "@/lib/clinical-notes-types";
import { escapeLike } from "@/lib/email-match";
import { runWithRls } from "@/lib/rls";
import { getActor } from "@/lib/session";
import { modulesFor } from "@/lib/tenant-modules";

/** Misma forma que los ids de URL (molde `UrlIdSchema`, lib/plans-deeplink.ts) y que los schemas de C-EV2-2. */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const validId = (raw: unknown): raw is string => typeof raw === "string" && ID_RE.test(raw);

/** Fila cruda de nota + proyección del turno, en la MISMA sentencia (ver `NOTE_COLUMNS`). */
type RawNoteRow = {
  id: string;
  patientId: string;
  bookingId: string | null;
  amendsNoteId: string | null;
  kind: ClinicalNoteKind;
  title: string | null;
  body: string;
  occurredAt: Date;
  authorUserId: string;
  authorPractitionerId: string;
  authorName: string;
  revision: number;
  voidedAt: Date | null;
  voidedByUserId: string | null;
  voidReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  b_id: string | null;
  b_scheduledFor: Date | null;
  b_status: BookingStatus | null;
  b_serviceName: string | null;
};

/**
 * Las columnas de `CLINICAL_NOTE_SELECT` en SQL (sin `idempotencyKey`), con el turno y su servicio por LEFT JOIN
 * acotado al tenant (la FK compuesta ya lo garantiza; el `tenantId` igual va: no se depende de la FK para aislar).
 */
const NOTE_COLUMNS = Prisma.sql`
  n.id, n."patientId", n."bookingId", n."amendsNoteId", n.kind::text AS kind, n.title, n.body, n."occurredAt",
  n."authorUserId", n."authorPractitionerId", n."authorName", n.revision, n."voidedAt", n."voidedByUserId",
  n."voidReason", n."createdAt", n."updatedAt",
  b.id AS "b_id", b."scheduledFor" AS "b_scheduledFor", b.status::text AS "b_status", sv.name AS "b_serviceName"`;
const NOTE_JOINS = Prisma.sql`
  LEFT JOIN "Booking" b ON b.id = n."bookingId" AND b."tenantId" = n."tenantId"
  LEFT JOIN "Service" sv ON sv.id = b."serviceId" AND sv."tenantId" = n."tenantId"`;

function rawToSelected(r: RawNoteRow): ClinicalNoteSelected {
  return {
    id: r.id,
    patientId: r.patientId,
    bookingId: r.bookingId,
    amendsNoteId: r.amendsNoteId,
    kind: r.kind,
    title: r.title,
    body: r.body,
    occurredAt: r.occurredAt,
    authorUserId: r.authorUserId,
    authorPractitionerId: r.authorPractitionerId,
    authorName: r.authorName,
    revision: r.revision,
    voidedAt: r.voidedAt,
    voidedByUserId: r.voidedByUserId,
    voidReason: r.voidReason,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    booking:
      r.b_id && r.b_scheduledFor && r.b_status
        ? { id: r.b_id, scheduledFor: r.b_scheduledFor, status: r.b_status, service: { name: r.b_serviceName ?? "" } }
        : null,
  };
}

/**
 * Instante como literal `timestamp` sin zona. Las columnas son `timestamp(3)` escritas en UTC por Prisma; un `Date`
 * como parámetro de `$queryRaw` llega como timestamptz y la comparación convertiría la COLUMNA con el `TimeZone` de la
 * sesión (riesgo R11 del brief). El ISO con `Z` casteado a `timestamp` descarta la zona y queda el reloj UTC exacto.
 */
const ts = (d: Date) => Prisma.sql`${d.toISOString()}::timestamp`;

/** null = sin módulo, sin acceso o paciente ajeno (no revela cuál). Sesiones solo con el módulo `sesiones`. */
export async function getPatientTimeline(input: {
  patientId: string;
  cursor?: string | null;
  q?: string | null;
  limit?: number;
}): Promise<TimelinePage | null> {
  if (!input || !validId(input.patientId)) return null;
  const actor = await getActor();
  const patientId = input.patientId;
  const tenantId = actor.tenantId;
  const limit = Math.min(
    TIMELINE_PAGE_MAX,
    Math.max(1, Math.floor(Number.isFinite(input.limit) ? (input.limit as number) : TIMELINE_PAGE_SIZE))
  );
  // Cursor inválido → primera página (decodeTimelineCursor ya devuelve null para cualquier forma rara).
  const cursor = decodeTimelineCursor(input.cursor);
  const q = normalizeTimelineQuery(input.q);
  const pattern = q ? `%${escapeLike(q)}%` : null;
  const withSessions = modulesFor(actor.entitlements).has("sesiones");
  const now = new Date();

  return runWithRls(tenantId, async (tx) => {
    const gate = await clinicalNoteGateInTx(tx, actor, patientId);
    if (!gate.canRead) return null;

    // Keyset (at DESC, key DESC) con key = 'n:'||id / 's:'||id, el orden de `mergeTimeline` (contrato EV2-1a): en un
    // empate de instante entre una nota y una sesión el cursor puede tener el prefijo del OTRO tipo, así que NO alcanza
    // `(occurredAt, id) < (cursor)` pelado. Se resuelve el prefijo acá y cada lista queda con un predicado simple:
    //  - cursor 'n:X': notas con at < c OR (at = c AND id < X); sesiones ('s' > 'n') solo con at < c.
    //  - cursor 's:X': notas ('n' < 's') con at <= c; sesiones con at < c OR (at = c AND id < X).
    // `COLLATE "C"`: JS (`mergeTimeline`) compara por unidades de código; con una collation lingüística (en_US de glibc,
    // la de Supabase) un id con `-`/`_` o mayúsculas ordenaría distinto y la página siguiente repetiría/perdería. El
    // Docker local (Alpine/musl) ordena por bytes aunque diga en_US.utf8: ahí el test de empates pasa igual sin esto
    // (medido el 15-oct), así que NO se saca por «los tests siguen verdes».
    // El índice (tenantId, patientId, occurredAt DESC, id DESC) da el orden por instante; el desempate por id es un
    // incremental sort sobre el LIMIT (EXPLAIN sin Seq Scan: lo fija el test de perf).
    const cPrefix = cursor?.key.slice(0, 1) ?? null;
    const cId = cursor?.key.slice(2) ?? null;
    const noteKeyset = !cursor
      ? Prisma.empty
      : cPrefix === "n"
        ? Prisma.sql`AND (n."occurredAt" < ${ts(cursor.at)}
            OR (n."occurredAt" = ${ts(cursor.at)} AND n.id COLLATE "C" < ${cId}))`
        : Prisma.sql`AND n."occurredAt" <= ${ts(cursor.at)}`;
    const sessionKeyset = !cursor
      ? Prisma.empty
      : cPrefix === "s"
        ? Prisma.sql`AND (s."completedAt" < ${ts(cursor.at)}
            OR (s."completedAt" = ${ts(cursor.at)} AND s.id COLLATE "C" < ${cId}))`
        : Prisma.sql`AND s."completedAt" < ${ts(cursor.at)}`;
    // Búsqueda: título/cuerpo de la raíz O de alguna de sus enmiendas (la enmienda se muestra debajo de su raíz, así
    // que la que matchea trae a la raíz). `escapeLike`: `%` y `_` son literales (ILIKE escapa con `\` por defecto).
    const noteSearch = pattern
      ? Prisma.sql`AND (n.title ILIKE ${pattern} OR n.body ILIKE ${pattern} OR EXISTS (
          SELECT 1 FROM "ClinicalNote" a
          WHERE a."tenantId" = ${tenantId} AND a."amendsNoteId" = n.id
            AND (a.title ILIKE ${pattern} OR a.body ILIKE ${pattern})))`
      : Prisma.empty;

    // (1) Raíces (anuladas incluidas: se muestran colapsadas con su motivo, EV2-D23).
    const rootRows = await tx.$queryRaw<RawNoteRow[]>`
      SELECT ${NOTE_COLUMNS}
      FROM "ClinicalNote" n ${NOTE_JOINS}
      WHERE n."tenantId" = ${tenantId} AND n."patientId" = ${patientId} AND n."amendsNoteId" IS NULL
        ${noteKeyset} ${noteSearch}
      ORDER BY n."occurredAt" DESC, n.id COLLATE "C" DESC
      LIMIT ${limit + 1}`;

    // (2) Enmiendas de esas raíces (todas: van colgadas debajo, en orden de creación; las ordena `mergeTimeline`).
    const rootIds = rootRows.map((r) => r.id);
    const amendmentRows = rootIds.length
      ? await tx.$queryRaw<RawNoteRow[]>`
          SELECT ${NOTE_COLUMNS}
          FROM "ClinicalNote" n ${NOTE_JOINS}
          WHERE n."tenantId" = ${tenantId} AND n."patientId" = ${patientId} AND n."amendsNoteId" = ANY(${rootIds})`
      : [];

    // (3) Sesiones completadas (kine, módulo `sesiones`) de planes y sesiones no archivados, con los agregados de
    // ejercicios (`DONE`, mismo criterio que Seguimiento, lib/sessions.ts) y el turno ACTIVO
    // (Booking_session_active_key: a lo sumo uno) en la misma sentencia. Con búsqueda, filtra por las notas de la sesión.
    const sessionRows = withSessions
      ? await tx.$queryRaw<
          {
            id: string;
            programId: string;
            programTitle: string | null;
            completedAt: Date;
            bookingId: string | null;
            notes: string | null;
            rpe: number | null;
            paInPre: number | null;
            paInPost: number | null;
            exercisesDone: number;
            exercisesTotal: number;
          }[]
        >`
          SELECT s.id, s."programId", tp.title AS "programTitle", s."completedAt", b.id AS "bookingId", s.notes,
            s.rpe, s."paInPre", s."paInPost",
            (SELECT count(*) FROM "SessionExercise" x WHERE x."sessionId" = s.id AND x.status = 'DONE')::int AS "exercisesDone",
            (SELECT count(*) FROM "SessionExercise" x WHERE x."sessionId" = s.id)::int AS "exercisesTotal"
          FROM "Session" s
          JOIN "TreatmentProgram" tp ON tp.id = s."programId"
          LEFT JOIN "Booking" b ON b."sessionId" = s.id AND b."tenantId" = ${tenantId}
            AND b.status NOT IN ('CANCELLED', 'NO_SHOW')
          WHERE tp."tenantId" = ${tenantId} AND tp."patientId" = ${patientId} AND tp."archivedAt" IS NULL
            AND s."archivedAt" IS NULL AND s."completedAt" IS NOT NULL
            ${sessionKeyset} ${pattern ? Prisma.sql`AND s.notes ILIKE ${pattern}` : Prisma.empty}
          ORDER BY s."completedAt" DESC, s.id COLLATE "C" DESC
          LIMIT ${limit + 1}`
      : [];

    const ctx = { actorUserId: actor.userId, isClinicalOwner: gate.isClinicalOwner, canWrite: gate.canWrite, now };
    const toDTO = (r: RawNoteRow): ClinicalNoteDTO => toClinicalNoteDTO(rawToSelected(r), ctx);
    const sessions: TimelineSessionDTO[] = sessionRows.map((s) => ({
      id: s.id,
      programId: s.programId,
      programTitle: s.programTitle,
      completedAt: s.completedAt.toISOString(),
      bookingId: s.bookingId,
      notes: s.notes,
      rpe: s.rpe,
      paInPre: s.paInPre,
      paInPost: s.paInPost,
      exercisesDone: s.exercisesDone,
      exercisesTotal: s.exercisesTotal,
    }));
    return mergeTimeline(rootRows.map(toDTO), amendmentRows.map(toDTO), sessions, limit);
  });
}

/** Versiones anteriores de una nota (más nueva primero). null si no hay acceso. */
export async function getClinicalNoteHistory(noteId: string): Promise<ClinicalNoteRevisionDTO[] | null> {
  if (!validId(noteId)) return null;
  const actor = await getActor();
  const tenantId = actor.tenantId;
  return runWithRls(tenantId, async (tx) => {
    const note = await tx.clinicalNote.findFirst({ where: { id: noteId, tenantId }, select: { patientId: true } });
    if (!note) return null;
    const gate = await clinicalNoteGateInTx(tx, actor, note.patientId);
    if (!gate.canRead) return null;
    const rows = await tx.clinicalNoteRevision.findMany({
      where: { tenantId, noteId },
      orderBy: { revision: "desc" },
      select: { revision: true, kind: true, title: true, body: true, occurredAt: true, savedAt: true, createdAt: true },
    });
    // `savedAt` = cuándo se guardó esa versión (el `updatedAt` de la nota en ese momento, lo copia el trigger);
    // `replacedAt` = cuándo la reemplazó la edición siguiente (el `createdAt` de la fila de revisión).
    return rows.map((r) => ({
      revision: r.revision,
      kind: r.kind,
      title: r.title,
      body: r.body,
      occurredAt: r.occurredAt.toISOString(),
      savedAt: r.savedAt.toISOString(),
      replacedAt: r.createdAt.toISOString(),
    }));
  });
}

/** Drawer del turno. null si no hay acceso o el turno es guest/ajeno: no revela si tiene evolución. */
export async function getBookingClinicalNote(bookingId: string): Promise<BookingClinicalNoteView | null> {
  if (!validId(bookingId)) return null;
  const actor = await getActor();
  const tenantId = actor.tenantId;
  const now = new Date();
  return runWithRls(tenantId, async (tx) => {
    const booking = await tx.booking.findFirst({
      where: { id: bookingId, tenantId },
      select: { patientId: true, status: true, scheduledFor: true },
    });
    // Guest (sin paciente) o de otro consultorio: null, igual que «sin acceso».
    if (!booking?.patientId) return null;
    const gate = await clinicalNoteGateInTx(tx, actor, booking.patientId);
    if (!gate.canRead) return null;

    const rows = await tx.clinicalNote.findMany({
      where: { tenantId, bookingId, patientId: booking.patientId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: CLINICAL_NOTE_SELECT,
    });
    const ctx = { actorUserId: actor.userId, isClinicalOwner: gate.isClinicalOwner, canWrite: gate.canWrite, now };
    const roots = rows.filter((r) => r.amendsNoteId === null);
    // EV2-D2: a lo sumo una raíz viva por turno (índice parcial); las anuladas van aparte, más nueva primero.
    const live = roots.find((r) => r.voidedAt === null) ?? null;
    const voided = roots.filter((r) => r.voidedAt !== null).reverse();
    // Enmiendas de la raíz viva, en orden de creación (anuladas incluidas: la UI las muestra colapsadas). Las
    // enmiendas de una raíz anulada no se listan: la raíz anulada ya se muestra colapsada con su motivo.
    const amendments = live ? rows.filter((r) => r.amendsNoteId === live.id) : [];
    const target = bookingTargetDecision(booking, booking.patientId, now);
    return {
      note: live ? toClinicalNoteDTO(live, ctx) : null,
      amendments: amendments.map((r) => toClinicalNoteDTO(r, ctx)),
      voided: voided.map((r) => toClinicalNoteDTO(r, ctx)),
      canCreate: gate.canWrite && !live && target.ok,
    };
  });
}

/** «Última evolución» de Resumen + contador de la pestaña. null sin acceso. */
export async function getPatientClinicalSummary(patientId: string): Promise<PatientClinicalSummary | null> {
  if (!validId(patientId)) return null;
  const actor = await getActor();
  const tenantId = actor.tenantId;
  const now = new Date();
  return runWithRls(tenantId, async (tx) => {
    const gate = await clinicalNoteGateInTx(tx, actor, patientId);
    if (!gate.canRead) return null;
    // «Viva» = raíz no anulada (mismo criterio que el índice parcial y Seguimiento, EV2-D18).
    const liveWhere: Prisma.ClinicalNoteWhereInput = { tenantId, patientId, amendsNoteId: null, voidedAt: null };
    const [latest, liveCount] = await Promise.all([
      tx.clinicalNote.findFirst({
        where: liveWhere,
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        select: CLINICAL_NOTE_SELECT,
      }),
      tx.clinicalNote.count({ where: liveWhere }),
    ]);
    const ctx = { actorUserId: actor.userId, isClinicalOwner: gate.isClinicalOwner, canWrite: gate.canWrite, now };
    return { latest: latest ? toClinicalNoteDTO(latest, ctx) : null, liveCount };
  });
}
