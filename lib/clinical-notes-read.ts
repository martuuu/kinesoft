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
 * tests/integration/clinical-notes-timeline-perf.test.ts): (1) raíces por SQL crudo con el turno, el servicio y el
 * documento compartido (LEFT JOIN LATERAL, FC-2b) en la MISMA sentencia (Prisma 5 sin `relationJoins` emite una
 * sentencia por relación del `select`), (2) enmiendas de esas raíces, (3) sesiones completadas con sus agregados y el
 * turno activo. El gate aparte (paciente, ajustes, membresía y a lo sumo el share).
 *
 * FC-2b: las sentencias viven en `lib/clinical-notes-timeline-internal.ts` (server-only) para que
 * `getPatientClinicalHome` las componga en UNA tx (la tx 3 del perfil) con el mismo gate.
 */
import {
  bookingTargetDecision,
  decodeTimelineCursor,
  mergeTimeline,
  normalizeTimelineQuery,
} from "@/lib/clinical-notes-logic";
import { clinicalNoteGateInTx, type ClinicalNoteGate } from "@/lib/clinical-notes-internal";
import {
  CLINICAL_HOME_FIRST_PAGE_ITEMS,
  CLINICAL_HOME_FIRST_PAGE_MAX_CHARS,
  bookingNotesInTx,
  capTimelinePage,
  clinicalSummaryInTx,
  composerCandidatesInTx,
  timelineRowsInTx,
  type NoteReadCtx,
} from "@/lib/clinical-notes-timeline-internal";
import {
  TIMELINE_PAGE_MAX,
  TIMELINE_PAGE_SIZE,
  type BookingClinicalNoteView,
  type ClinicalNoteDTO,
  type ClinicalNoteRevisionDTO,
  type PatientClinicalHome,
  type PatientClinicalSummary,
  type TimelinePage,
} from "@/lib/clinical-notes-types";
import type { DbClient } from "@/lib/rls";
import { runWithRls } from "@/lib/rls";
import { getActor, type Actor } from "@/lib/session";
import { modulesFor } from "@/lib/tenant-modules";

/** Misma forma que los ids de URL (molde `UrlIdSchema`, lib/plans-deeplink.ts) y que los schemas de C-EV2-2. */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const validId = (raw: unknown): raw is string => typeof raw === "string" && ID_RE.test(raw);

const readCtx = (actor: Actor, gate: ClinicalNoteGate, now: Date): NoteReadCtx => ({
  actorUserId: actor.userId,
  isClinicalOwner: gate.isClinicalOwner,
  canWrite: gate.canWrite,
  now,
});

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
  // PV · HD-3: export de "use server" = RPC; un `q` no-string tiraba en `normalizeTimelineQuery` (`q.replace`). El
  // tope de 100 ya lo aplica `normalizeTimelineQuery` (TIMELINE_QUERY_MAX): un `q` largo se acota, no se rechaza
  // (null acá significa «sin acceso» para la UI).
  const q = normalizeTimelineQuery(typeof input.q === "string" ? input.q : null);
  const withSessions = modulesFor(actor.entitlements).has("sesiones");
  const now = new Date();

  return runWithRls(tenantId, async (tx) => {
    const gate = await clinicalNoteGateInTx(tx, actor, patientId);
    if (!gate.canRead) return null;
    const rows = await timelineRowsInTx(tx, {
      tenantId,
      patientId,
      cursor,
      q,
      limit,
      withSessions,
      ctx: readCtx(actor, gate, now),
    });
    return mergeTimeline(rows.roots, rows.amendments, rows.sessions, limit);
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

/**
 * Vista del turno ya con el gate corrido para `patientId` (drawer y deep link del inicio de la HC). null = el turno no
 * existe, es de otro consultorio, es guest o es de OTRO paciente (no revela cuál).
 */
async function bookingClinicalNoteViewInTx(
  tx: DbClient,
  actor: Actor,
  gate: ClinicalNoteGate,
  patientId: string,
  bookingId: string,
  now: Date
): Promise<BookingClinicalNoteView | null> {
  const tenantId = actor.tenantId;
  const booking = await tx.booking.findFirst({
    where: { id: bookingId, tenantId, patientId },
    select: { patientId: true, status: true, scheduledFor: true },
  });
  if (!booking) return null;
  const rows = await bookingNotesInTx(tx, { tenantId, patientId, bookingId, ctx: readCtx(actor, gate, now) });
  const roots = rows.filter((r) => r.amendsNoteId === null);
  // EV2-D2: a lo sumo una raíz viva por turno (índice parcial); las anuladas van aparte, más nueva primero.
  const live = roots.find((r) => r.voided === null) ?? null;
  const voided = roots.filter((r) => r.voided !== null).reverse();
  // Enmiendas de la raíz viva, en orden de creación (anuladas incluidas: la UI las muestra colapsadas). Las
  // enmiendas de una raíz anulada no se listan: la raíz anulada ya se muestra colapsada con su motivo.
  const amendments: ClinicalNoteDTO[] = live ? rows.filter((r) => r.amendsNoteId === live.id) : [];
  const target = bookingTargetDecision(booking, patientId, now);
  return { note: live, amendments, voided, canCreate: gate.canWrite && !live && target.ok };
}

/** Drawer del turno. null si no hay acceso o el turno es guest/ajeno: no revela si tiene ficha. */
export async function getBookingClinicalNote(bookingId: string): Promise<BookingClinicalNoteView | null> {
  if (!validId(bookingId)) return null;
  const actor = await getActor();
  const tenantId = actor.tenantId;
  const now = new Date();
  return runWithRls(tenantId, async (tx) => {
    const booking = await tx.booking.findFirst({ where: { id: bookingId, tenantId }, select: { patientId: true } });
    // Guest (sin paciente) o de otro consultorio: null, igual que «sin acceso».
    if (!booking?.patientId) return null;
    const gate = await clinicalNoteGateInTx(tx, actor, booking.patientId);
    if (!gate.canRead) return null;
    return bookingClinicalNoteViewInTx(tx, actor, gate, booking.patientId, bookingId, now);
  });
}

/** «Última ficha» de Resumen + contador de la pestaña. null sin acceso. */
export async function getPatientClinicalSummary(patientId: string): Promise<PatientClinicalSummary | null> {
  if (!validId(patientId)) return null;
  const actor = await getActor();
  const tenantId = actor.tenantId;
  const now = new Date();
  return runWithRls(tenantId, async (tx) => {
    const gate = await clinicalNoteGateInTx(tx, actor, patientId);
    if (!gate.canRead) return null;
    return clinicalSummaryInTx(tx, { tenantId, patientId, ctx: readCtx(actor, gate, now) });
  });
}

/**
 * FC (C-FC3) · La tx 3 del perfil (§24.2 hallazgo 3): resumen + primera página de la timeline + turnos candidatos del
 * compositor + deep link del turno, en UNA lectura (el perfil sigue en exactamente 3 tx, pf2-profile-budget, que
 * también fija el techo de sentencias de esta tx).
 *  - `firstPage`: 10 ítems / 60k caracteres (FC-UI-D10), mismo algoritmo y cursor que «Cargar más»
 *    (`getPatientTimeline`). `opts.timeline: false` no la arma (ni la lee).
 *  - `composer`: null sin escritura clínica (no se leen turnos que no se van a ofrecer).
 *  - `deepLink`: `opts.noteBookingId` (`?turno=`) → la misma vista que el drawer del turno, solo si el turno es de
 *    ESTE paciente; si no, null sin decir por qué.
 * null = sin módulo, sin acceso o paciente ajeno (mismo gate que el resto del archivo).
 */
export async function getPatientClinicalHome(
  patientId: string,
  opts?: { noteBookingId?: string | null; timeline?: boolean }
): Promise<PatientClinicalHome | null> {
  if (!validId(patientId)) return null;
  const actor = await getActor();
  const tenantId = actor.tenantId;
  const now = new Date();
  const withTimeline = opts?.timeline !== false;
  const noteBookingId = validId(opts?.noteBookingId) ? opts!.noteBookingId! : null;
  const withSessions = modulesFor(actor.entitlements).has("sesiones");
  return runWithRls(tenantId, async (tx) => {
    const gate = await clinicalNoteGateInTx(tx, actor, patientId);
    if (!gate.canRead) return null;
    const ctx = readCtx(actor, gate, now);
    // En serie: una tx = una conexión (Promise.all no paraleliza y mezcla el orden de las sentencias).
    const summary = await clinicalSummaryInTx(tx, { tenantId, patientId, ctx });
    const firstPage: TimelinePage | null = withTimeline
      ? capTimelinePage(
          await timelineRowsInTx(tx, {
            tenantId,
            patientId,
            cursor: null,
            q: null,
            limit: CLINICAL_HOME_FIRST_PAGE_ITEMS,
            withSessions,
            ctx,
          }),
          CLINICAL_HOME_FIRST_PAGE_ITEMS,
          CLINICAL_HOME_FIRST_PAGE_MAX_CHARS
        )
      : null;
    const composer = gate.canWrite ? { candidates: await composerCandidatesInTx(tx, { tenantId, patientId, now }) } : null;
    const deepLink = noteBookingId
      ? await bookingClinicalNoteViewInTx(tx, actor, gate, patientId, noteBookingId, now)
      : null;
    return { summary, firstPage, composer, deepLink };
  });
}
