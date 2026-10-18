import "server-only";

/**
 * FC-2b (C-FC3 «Lecturas») · Núcleo server-only de las lecturas de fichas: la proyección SQL de la nota (con el turno,
 * el servicio y el documento compartido en la MISMA sentencia) y los lectores en-tx que comparten la timeline, el
 * drawer del turno, el resumen y el inicio de la HC (`getPatientClinicalHome`, la tx 3 del perfil).
 *
 * Por qué vive acá y no en `lib/clinical-notes-read.ts`: ese archivo es `"use server"` (solo funciones async
 * exportadas) y el inicio de la HC tiene que componer los mismos lectores dentro de UNA tx. Ningún lector de acá corre
 * el gate: lo corre el que llama (`clinicalNoteGateInTx`) y les pasa lo que salió.
 *
 * Presupuesto (§24.9 «Perf»): la timeline sigue en ≤ 4 sentencias de datos por página; el documento vivo de cada raíz
 * entra por `LEFT JOIN LATERAL` en la sentencia de raíces, no como una 4ª ni como N+1. Lo fijan
 * tests/integration/clinical-notes-timeline-perf.test.ts y pf2-profile-budget.test.ts (techo de la tx 3).
 */
import { Prisma, type BookingStatus, type ClinicalNoteKind } from "@prisma/client";
import { mergeTimeline } from "@/lib/clinical-notes-logic";
import { toClinicalNoteDTO, type ClinicalNoteSelected } from "@/lib/clinical-notes-internal";
import {
  CLINICAL_NOTE_FUTURE_LIMIT_MS,
  type ClinicalNoteDTO,
  type ComposerBookingCandidate,
  type NoteSharedDocument,
  type PatientClinicalSummary,
  type TimelineItem,
  type TimelinePage,
  type TimelineSessionDTO,
} from "@/lib/clinical-notes-types";
import { escapeLike } from "@/lib/email-match";
import { sha256Hex } from "@/lib/hc-print-internal";
import { hcSourceVersion } from "@/lib/hc-print-model";
import type { DbClient } from "@/lib/rls";

/** FC-UI-D10: la primera página que llega por SSR (después «Cargar más» de a `TIMELINE_PAGE_SIZE`). */
export const CLINICAL_HOME_FIRST_PAGE_ITEMS = 10;
/**
 * FC-UI-D10: tope de caracteres de la primera página. Diez fichas de 20.000 caracteres (el máximo del cuerpo) serían
 * 200k en el HTML del perfil + el mismo texto otra vez en el payload de RSC; con 60k el SSR queda acotado y el resto
 * viene con «Cargar más».
 */
export const CLINICAL_HOME_FIRST_PAGE_MAX_CHARS = 60_000;
/**
 * Default de FC-2b (no lo fija el brief): candidatos del chip del turno = turnos del paciente de los últimos 30 días
 * hasta el límite de futuro de EV2-D12 (12 h), 20 como mucho, más nuevo primero. El chip elige el de hoy
 * (`pickDefaultComposerBooking`) y deja cambiarlo por uno reciente: más atrás es «cargar una ficha sin turno».
 */
export const COMPOSER_CANDIDATES_DAYS = 30;
export const COMPOSER_CANDIDATES_MAX = 20;

/** Lo que el que llama ya resolvió con el gate (`clinicalNoteGateInTx`) y necesita la proyección de permisos. */
export type NoteReadCtx = { actorUserId: string; isClinicalOwner: boolean; canWrite: boolean; now: Date };

/** Fila cruda de nota + proyección del turno + documento vivo, en la MISMA sentencia (ver `NOTE_COLUMNS`). */
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
  bodyDoc: Prisma.JsonValue | null;
  diagnoses: Prisma.JsonValue | null;
  authorLicense: string | null;
  importSource: Prisma.JsonValue | null;
  b_id: string | null;
  b_scheduledFor: Date | null;
  b_status: BookingStatus | null;
  b_serviceName: string | null;
  d_id: string | null;
  d_sharedAt: Date | null;
  d_sourceDigest: string | null;
  /** Versiones de TODAS las enmiendas de la raíz (anuladas incluidas): solo si hay documento vivo. */
  d_amends: { id: string; revision: number; voided: boolean }[] | null;
};

/**
 * Las columnas de `CLINICAL_NOTE_SELECT` en SQL (sin `idempotencyKey`), con el turno y su servicio por LEFT JOIN
 * acotado al tenant (la FK compuesta ya lo garantiza; el `tenantId` igual va: no se depende de la FK para aislar), y
 * el documento vivo de la raíz (`d_*`).
 */
const NOTE_BASE_COLUMNS = Prisma.sql`
  n.id, n."patientId", n."bookingId", n."amendsNoteId", n.kind::text AS kind, n.title, n.body, n."occurredAt",
  n."authorUserId", n."authorPractitionerId", n."authorName", n.revision, n."voidedAt", n."voidedByUserId",
  n."voidReason", n."createdAt", n."updatedAt", n."bodyDoc", n.diagnoses, n."authorLicense", n."importSource",
  b.id AS "b_id", b."scheduledFor" AS "b_scheduledFor", b.status::text AS "b_status", sv.name AS "b_serviceName"`;
const NOTE_COLUMNS = Prisma.sql`${NOTE_BASE_COLUMNS},
  pd.id AS "d_id", pd."sharedAt" AS "d_sharedAt", pd."sourceDigest" AS "d_sourceDigest", pd.amends AS "d_amends"`;
/** Para listas que son SOLO enmiendas: el documento no aplica (null) y no se nombra la tabla (ni un probe de más). */
const AMENDMENT_COLUMNS = Prisma.sql`${NOTE_BASE_COLUMNS},
  NULL::text AS "d_id", NULL::timestamp AS "d_sharedAt", NULL::text AS "d_sourceDigest", NULL::json AS "d_amends"`;

/**
 * Documento vivo por `LEFT JOIN LATERAL` (§24.9: en la misma sentencia, no una 4ª ni N+1). Usa el índice parcial
 * `PatientDocument_noteId_live_key` (a lo sumo uno vivo por ficha, M14: por eso el `LIMIT 1` es solo defensivo). Con
 * `ON n."amendsNoteId" IS NULL` la enmienda ni lo evalúa: solo las raíces se comparten (el trigger lo exige).
 *
 * Las versiones de las enmiendas (para «desactualizada») salen en la misma subconsulta y SOLO si hay documento: en
 * una página sin nada compartido no se lee una enmienda de más. No se reusan las enmiendas de la sentencia 2 de la
 * timeline a propósito: el resumen y el drawer no la tienen, y así las cuatro lecturas calculan la huella igual.
 */
const BOOKING_JOINS = Prisma.sql`
  LEFT JOIN "Booking" b ON b.id = n."bookingId" AND b."tenantId" = n."tenantId"
  LEFT JOIN "Service" sv ON sv.id = b."serviceId" AND sv."tenantId" = n."tenantId"`;
const NOTE_JOINS = Prisma.sql`${BOOKING_JOINS}
  LEFT JOIN LATERAL (
    SELECT d.id, d."sharedAt", d."sourceDigest",
      (SELECT coalesce(json_agg(json_build_object('id', a.id, 'revision', a.revision, 'voided', a."voidedAt" IS NOT NULL)), '[]'::json)
         FROM "ClinicalNote" a
        WHERE a."tenantId" = n."tenantId" AND a."amendsNoteId" = n.id) AS amends
    FROM "PatientDocument" d
    WHERE d."tenantId" = n."tenantId" AND d."noteId" = n.id AND d."revokedAt" IS NULL
    LIMIT 1
  ) pd ON n."amendsNoteId" IS NULL`;

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
    bodyDoc: r.bodyDoc,
    diagnoses: r.diagnoses,
    authorLicense: r.authorLicense,
    importSource: r.importSource,
    booking:
      r.b_id && r.b_scheduledFor && r.b_status
        ? { id: r.b_id, scheduledFor: r.b_scheduledFor, status: r.b_status, service: { name: r.b_serviceName ?? "" } }
        : null,
  };
}

/**
 * C-FC3: `{status:"none"|"live"|"stale"}` en raíces, `null` en enmiendas. «stale» en JS: sha256(`hcSourceVersion`)
 * de la versión ACTUAL (revisión de la raíz + todas sus enmiendas) contra el `sourceDigest` guardado al compartir
 * (mismos puros que usa FC-2d al escribirlo). Una raíz anulada no tiene documento vivo (el trigger lo revoca en la
 * misma sentencia), así que sale «none».
 */
export function sharedDocumentOf(r: {
  amendsNoteId: string | null;
  revision: number;
  d_id: string | null;
  d_sharedAt: Date | null;
  d_sourceDigest: string | null;
  d_amends: { id: string; revision: number; voided: boolean }[] | null;
}): NoteSharedDocument | null {
  if (r.amendsNoteId !== null) return null;
  if (!r.d_id || !r.d_sharedAt || !r.d_sourceDigest) return { status: "none" };
  const digest = sha256Hex(hcSourceVersion({ revision: r.revision }, r.d_amends ?? []));
  return {
    status: digest === r.d_sourceDigest ? "live" : "stale",
    documentId: r.d_id,
    sharedAt: r.d_sharedAt.toISOString(),
  };
}

function rawToDTO(r: RawNoteRow, ctx: NoteReadCtx): ClinicalNoteDTO {
  return { ...toClinicalNoteDTO(rawToSelected(r), ctx), sharedDocument: sharedDocumentOf(r) };
}

/**
 * Instante como literal `timestamp` sin zona. Las columnas son `timestamp(3)` escritas en UTC por Prisma; un `Date`
 * como parámetro de `$queryRaw` llega como timestamptz y la comparación convertiría la COLUMNA con el `TimeZone` de la
 * sesión (riesgo R11 del brief EV2). El ISO con `Z` casteado a `timestamp` descarta la zona y queda el reloj UTC exacto.
 */
const ts = (d: Date) => Prisma.sql`${d.toISOString()}::timestamp`;

type SessionRow = {
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
};

/** Las tres listas de una página, ya proyectadas, listas para `mergeTimeline` (que trae `limit + 1` de cada una). */
export type TimelineRows = { roots: ClinicalNoteDTO[]; amendments: ClinicalNoteDTO[]; sessions: TimelineSessionDTO[] };

/**
 * Las ≤ 3 sentencias de datos de una página de la timeline (EV2-2b, C-EV2-5). El que llama ya corrió el gate.
 * `cursor` ya decodificado y `q` ya normalizada (`decodeTimelineCursor`, `normalizeTimelineQuery`).
 */
export async function timelineRowsInTx(
  tx: DbClient,
  p: {
    tenantId: string;
    patientId: string;
    cursor: { at: Date; key: string } | null;
    q: string | null;
    limit: number;
    withSessions: boolean;
    ctx: NoteReadCtx;
  }
): Promise<TimelineRows> {
  const { tenantId, patientId, cursor, limit } = p;
  const pattern = p.q ? `%${escapeLike(p.q)}%` : null;

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
  // incremental sort sobre el LIMIT (EXPLAIN sin Seq Scan: lo fija el test de perf). El LATERAL del documento queda
  // debajo del Limit (nested loop): corre para las `limit + 1` raíces, no para todas.
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

  // (1) Raíces (anuladas incluidas: se muestran colapsadas con su motivo, EV2-D23) + documento vivo (LATERAL).
  const rootRows = await tx.$queryRaw<RawNoteRow[]>`
    SELECT ${NOTE_COLUMNS}
    FROM "ClinicalNote" n ${NOTE_JOINS}
    WHERE n."tenantId" = ${tenantId} AND n."patientId" = ${patientId} AND n."amendsNoteId" IS NULL
      ${noteKeyset} ${noteSearch}
    ORDER BY n."occurredAt" DESC, n.id COLLATE "C" DESC
    LIMIT ${limit + 1}`;

  // (2) Enmiendas de esas raíces (todas: van colgadas debajo, en orden de creación; las ordena `mergeTimeline`). Sin
  // el LATERAL: una enmienda nunca tiene documento (`sharedDocument: null`).
  const rootIds = rootRows.map((r) => r.id);
  const amendmentRows = rootIds.length
    ? await tx.$queryRaw<RawNoteRow[]>`
        SELECT ${AMENDMENT_COLUMNS}
        FROM "ClinicalNote" n ${BOOKING_JOINS}
        WHERE n."tenantId" = ${tenantId} AND n."patientId" = ${patientId} AND n."amendsNoteId" = ANY(${rootIds})`
    : [];

  // (3) Sesiones completadas (kine, módulo `sesiones`) de planes y sesiones no archivados, con los agregados de
  // ejercicios (`DONE`, mismo criterio que Seguimiento, lib/sessions.ts) y el turno ACTIVO
  // (Booking_session_active_key: a lo sumo uno) en la misma sentencia. Con búsqueda, filtra por las notas de la sesión.
  const sessionRows = p.withSessions
    ? await tx.$queryRaw<SessionRow[]>`
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

  return {
    roots: rootRows.map((r) => rawToDTO(r, p.ctx)),
    amendments: amendmentRows.map((r) => rawToDTO(r, p.ctx)),
    sessions: sessionRows.map((s) => ({
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
    })),
  };
}

/** Caracteres de texto que un ítem le suma a la página (título + cuerpo de la raíz y sus enmiendas, notas de sesión). */
export function timelineItemChars(item: TimelineItem): number {
  const note = (n: ClinicalNoteDTO) => (n.title?.length ?? 0) + n.body.length;
  if (item.type === "session") return item.session.notes?.length ?? 0;
  return note(item.note) + item.amendments.reduce((a, m) => a + note(m), 0) + (item.session?.notes?.length ?? 0);
}

/**
 * PURO · Primera página con tope de ítems Y de caracteres (FC-UI-D10). Se arma con `mergeTimeline` y, si se pasa del
 * tope, se vuelve a armar con un `limit` menor: así el corte y el `nextCursor` salen del MISMO algoritmo que «Cargar
 * más» (una página recortada a mano tendría un cursor que no es el del último ítem consumido y la siguiente
 * repetiría o perdería ítems, p. ej. con una sesión absorbida en el borde). Siempre al menos 1 ítem: una sola ficha
 * enorme se muestra igual (el tope es para la página, no para la ficha).
 */
export function capTimelinePage(rows: TimelineRows, maxItems: number, maxChars: number): TimelinePage {
  let limit = Math.max(1, Math.floor(maxItems));
  for (;;) {
    const page = mergeTimeline(rows.roots, rows.amendments, rows.sessions, limit);
    if (limit === 1) return page;
    let chars = 0;
    let fit = 0;
    for (const item of page.items) {
      chars += timelineItemChars(item);
      if (chars > maxChars) break;
      fit++;
    }
    if (fit >= page.items.length) return page;
    // Lo que entra (al menos 1); cada vuelta baja `limit`, así que termina.
    limit = Math.max(1, Math.min(limit - 1, fit));
  }
}

/**
 * «Última ficha» de Resumen + contador de la pestaña, en UNA sentencia: el `count(*) OVER ()` se calcula sobre las
 * raíces vivas ANTES del `LIMIT 1` (en la CTE, sin joins: el LATERAL y el turno se leen solo para la última). «Viva» =
 * raíz no anulada (mismo criterio que el índice parcial y Seguimiento, EV2-D18). Sin fichas → `{ latest: null, 0 }`.
 */
export async function clinicalSummaryInTx(
  tx: DbClient,
  p: { tenantId: string; patientId: string; ctx: NoteReadCtx }
): Promise<PatientClinicalSummary> {
  const rows = await tx.$queryRaw<(RawNoteRow & { liveCount: number })[]>`
    WITH live AS (
      SELECT n.id, count(*) OVER ()::int AS "liveCount"
      FROM "ClinicalNote" n
      WHERE n."tenantId" = ${p.tenantId} AND n."patientId" = ${p.patientId}
        AND n."amendsNoteId" IS NULL AND n."voidedAt" IS NULL
      ORDER BY n."occurredAt" DESC, n.id COLLATE "C" DESC
      LIMIT 1
    )
    SELECT ${NOTE_COLUMNS}, live."liveCount"
    FROM live JOIN "ClinicalNote" n ON n.id = live.id AND n."tenantId" = ${p.tenantId} ${NOTE_JOINS}`;
  const row = rows[0];
  return { latest: row ? rawToDTO(row, p.ctx) : null, liveCount: row?.liveCount ?? 0 };
}

/**
 * Notas de un turno (raíces y enmiendas) en orden de creación, con el documento vivo de la raíz. El que llama ya
 * validó que el turno es de ESE paciente y corrió el gate; el `patientId` igual va en el WHERE (defensa en
 * profundidad: el turno y la nota tienen que ser del mismo paciente).
 */
export async function bookingNotesInTx(
  tx: DbClient,
  p: { tenantId: string; patientId: string; bookingId: string; ctx: NoteReadCtx }
): Promise<ClinicalNoteDTO[]> {
  const rows = await tx.$queryRaw<RawNoteRow[]>`
    SELECT ${NOTE_COLUMNS}
    FROM "ClinicalNote" n ${NOTE_JOINS}
    WHERE n."tenantId" = ${p.tenantId} AND n."bookingId" = ${p.bookingId} AND n."patientId" = ${p.patientId}
    ORDER BY n."createdAt" ASC, n.id ASC`;
  return rows.map((r) => rawToDTO(r, p.ctx));
}

/**
 * Turnos candidatos del chip del compositor (FC-3c), en UNA sentencia: del paciente, ni cancelados ni ausentes (no
 * se les puede cargar ficha, `bookingTargetDecision`), hasta 12 h en el futuro (EV2-D12) y desde hace
 * `COMPOSER_CANDIDATES_DAYS`, con `hasLiveNote` (la raíz viva del turno, índice parcial de M9). Usa
 * `Booking_patientId_scheduledFor_idx`.
 */
export async function composerCandidatesInTx(
  tx: DbClient,
  p: { tenantId: string; patientId: string; now: Date }
): Promise<ComposerBookingCandidate[]> {
  const from = new Date(p.now.getTime() - COMPOSER_CANDIDATES_DAYS * 24 * 60 * 60 * 1000);
  const to = new Date(p.now.getTime() + CLINICAL_NOTE_FUTURE_LIMIT_MS);
  const rows = await tx.$queryRaw<
    {
      id: string;
      scheduledFor: Date;
      status: BookingStatus;
      practitionerId: string | null;
      serviceName: string | null;
      hasLiveNote: boolean;
    }[]
  >`
    SELECT b.id, b."scheduledFor", b.status::text AS status, b."practitionerId", sv.name AS "serviceName",
      EXISTS (
        SELECT 1 FROM "ClinicalNote" c
        WHERE c."tenantId" = b."tenantId" AND c."bookingId" = b.id AND c."amendsNoteId" IS NULL AND c."voidedAt" IS NULL
      ) AS "hasLiveNote"
    FROM "Booking" b
    LEFT JOIN "Service" sv ON sv.id = b."serviceId" AND sv."tenantId" = b."tenantId"
    WHERE b."tenantId" = ${p.tenantId} AND b."patientId" = ${p.patientId}
      AND b.status NOT IN ('CANCELLED', 'NO_SHOW')
      AND b."scheduledFor" >= ${ts(from)} AND b."scheduledFor" <= ${ts(to)}
    ORDER BY b."scheduledFor" DESC, b.id DESC
    LIMIT ${COMPOSER_CANDIDATES_MAX}`;
  return rows.map((r) => ({
    id: r.id,
    scheduledFor: r.scheduledFor.toISOString(),
    serviceName: r.serviceName,
    status: r.status,
    practitionerId: r.practitionerId,
    hasLiveNote: r.hasLiveNote,
  }));
}
