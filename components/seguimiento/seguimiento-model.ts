/**
 * Seguimiento (S20, ES3 · C13): lógica pura del landing y del detalle de
 * sesión. Sin React ni actions, para testearla sola (AGENTS §3: la lógica va
 * fuera de los componentes).
 *
 * Reglas que viven acá:
 *   - "Sesión n de N" sale del ORDINAL (M13: por fecha entre las vivas, empate
 *     por `index`) y de `totalLive`, nunca de `index`/`totalSessions`: el
 *     `index` es estable y no se renumera al archivar ni al mover, así que
 *     "Sesión 7 / 10" podía ser la tercera que el paciente iba a hacer;
 *   - una sesión a medida muestra su `Session.title` (S12b dejó de guardarlo
 *     en `notes`, que es evolución clínica);
 *   - "Sin evolución" en el detalle = realizada y sin nada cargado (espejo del
 *     "untouched" del server); la EvaScore no viaja en el DTO, así que el
 *     server tiene la última palabra (`loadSessionEvolution` → `loaded:false`);
 *   - EV2-D19 (Martin puede revertir): la acción que guarda la meta de la
 *     sesión (anotaciones, EVA, RPE) se llama «Registrar sesión»; «Cargar
 *     evolución» pasa a ser la evolución de la historia clínica del turno de
 *     la sesión (`NoteEditorDrawer`). EV2-D18: una evolución viva del turno
 *     también saca la sesión de «Sin evolución» (bucket y tag), pero NO
 *     bloquea «Registrar sesión» (EV2-Z A2, default del orquestador para
 *     Martin): la evolución de HC y el registro del plan (EVA, ejercicios)
 *     son cosas distintas; si la HC bloqueaba, una sesión con evolución y
 *     sin EVA quedaba sin forma de cargarle la EVA.
 */
import { planSessionLabel } from "@/lib/plan-display";
import type { OpenSessionBuckets } from "@/lib/sessions-types";
import type { PlanEngineWriteResult } from "@/lib/plans-edit-types";
import type { PlanPreview } from "@/lib/plans-types";
import { clinicalNoteDeepLink } from "@/lib/clinical-notes-logic";

// ─── Copy (C13) ──────────────────────────────────────────────────────────────

export const SEGUIMIENTO_COPY = {
  sinTurnoTitle: "Sin turno",
  sinTurnoHint: "Sesiones de planes activos que no tienen turno en la agenda.",
  sinEvolucionTitle: "Sin evolución",
  sinEvolucionHint: "Realizadas en los últimos 14 días sin evolución ni registro de la sesión (anotaciones, EVA o ejercicios).",
  sinEvolucionTag: "Sin evolución",
  /** EV2-D19: guarda la meta de la sesión (antes decía «Cargar evolución»). */
  registrarSesion: "Registrar sesión",
  /** EV2-D19: abre el editor de la evolución de HC del turno de la sesión. */
  cargarEvolucionHc: "Cargar evolución",
  verEvolucionHc: "Ver evolución",
  agendar: "Agendar",
  dischargeTitle: "Para dar el alta",
  dischargeAction: "Ver el plan",
  /** EV2-Z A2/M3: el registro de la sesión no depende de la evolución de HC; esto es solo «ya tenía meta». */
  evolutionAlreadyLoaded: "Esta sesión ya tenía un registro: editalo con «Guardar anotaciones».",
  evolutionEmpty: "Cargá al menos una anotación, la EVA, el RPE o un ejercicio hecho.",
  archived: "Sesión archivada",
  scheduleTitle: "Agendar sesión",
  scheduleConfirm: "Agendar turno",
  scheduleNoSlot: "No encontramos un hueco libre cerca de esa fecha. Reprogramala desde el plan del paciente.",
  scheduleStale: "La agenda cambió mientras lo revisabas. Revisá el turno y confirmá de nuevo.",
} as const;

/** Prefijo de "Sesión n de N". Sin ordinal (archivada) no hay contador. */
export function sessionCounterLabel(ordinal: number | null | undefined, totalLive: number | null | undefined): string {
  if (ordinal == null || totalLive == null) return SEGUIMIENTO_COPY.archived;
  return planSessionLabel(ordinal, totalLive);
}

/** "Sesión 3 de 10 · Evaluación final" para una sesión a medida; si no, solo el contador. */
export function sessionHeading(s: {
  ordinal: number | null | undefined;
  totalLive: number | null | undefined;
  title?: string | null;
}): string {
  const counter = sessionCounterLabel(s.ordinal, s.totalLive);
  const title = s.title?.trim();
  return title ? `${counter} · ${title}` : counter;
}

/** C13 literal: "Completó las 10 sesiones. ¿Le das el alta?". */
export function dischargeCopy(totalLive: number): string {
  return totalLive === 1
    ? "Completó la sesión. ¿Le das el alta?"
    : `Completó las ${totalLive} sesiones. ¿Le das el alta?`;
}

// ─── Landing ─────────────────────────────────────────────────────────────────

/**
 * Los buckets nuevos son lentes, no particiones (S12b): una sesión "sin turno"
 * de mañana también está en "Próximas" y una "sin evolución" en "Realizadas".
 * Estos sets marcan esas tarjetas en los buckets de siempre.
 */
export function landingLenses(b: Pick<OpenSessionBuckets, "sinTurno" | "realizadasSinEvolucion">): {
  sinTurno: ReadonlySet<string>;
  sinEvolucion: ReadonlySet<string>;
} {
  return {
    sinTurno: new Set((b.sinTurno?.rows ?? []).map((r) => r.id)),
    sinEvolucion: new Set((b.realizadasSinEvolucion?.rows ?? []).map((r) => r.id)),
  };
}

/** Param de la página de detalle que abre el modal de agendar al entrar. */
/**
 * C8 (VX0-b): «Vencidas sin cerrar» como lista compacta agrupada por paciente. Con 29 vencidas en cards de alto
 * variable, Hoy/Próximas quedaban a 1.500 px. Los grupos mantienen el orden en que llegan (el server ordena por fecha)
 * y nunca se parten: se muestran grupos enteros hasta llegar a `limit` filas y el resto va colapsado («Ver todas»).
 */
export const OVERDUE_VISIBLE_ROWS = 6;

export type PatientGroup<T> = { patientId: string; patientName: string; rows: T[] };

export function groupByPatient<T extends { patientId: string; patientName: string }>(rows: readonly T[]): PatientGroup<T>[] {
  const out: PatientGroup<T>[] = [];
  const byId = new Map<string, PatientGroup<T>>();
  for (const r of rows) {
    let g = byId.get(r.patientId);
    if (!g) {
      g = { patientId: r.patientId, patientName: r.patientName, rows: [] };
      byId.set(r.patientId, g);
      out.push(g);
    }
    g.rows.push(r);
  }
  return out;
}

export function splitOverdueGroups<T extends { patientId: string; patientName: string }>(
  rows: readonly T[],
  limit = OVERDUE_VISIBLE_ROWS
): { visible: PatientGroup<T>[]; hidden: PatientGroup<T>[]; hiddenRows: number } {
  const groups = groupByPatient(rows);
  const visible: PatientGroup<T>[] = [];
  const hidden: PatientGroup<T>[] = [];
  let shown = 0;
  for (const g of groups) {
    // El primer grupo siempre se ve, aunque solo él pase el límite (si no, la sección quedaría vacía).
    // Cortado una vez, el resto también va colapsado: no se saltea un grupo para meter uno posterior (orden por fecha).
    if (hidden.length === 0 && (visible.length === 0 || shown + g.rows.length <= limit)) {
      visible.push(g);
      shown += g.rows.length;
    } else hidden.push(g);
  }
  return { visible, hidden, hiddenRows: rows.length - shown };
}

export const AGENDAR_PARAM = "agendar";

export function sessionHref(sessionId: string, opts?: { agendar?: boolean }): string {
  const base = `/seguimiento/${encodeURIComponent(sessionId)}`;
  return opts?.agendar ? `${base}?${AGENDAR_PARAM}=1` : base;
}

// ─── Detalle ─────────────────────────────────────────────────────────────────

export type EvolutionProbe = {
  completedAt: Date | string | null;
  notes: string | null;
  rpe: number | null;
  paInPre: number | null;
  paInPost: number | null;
  exercises: ReadonlyArray<{ status: string }>;
};

/**
 * Realizada (p. ej. por "Atendido" en la agenda) y sin evolución cargada. EV2-D18: `hasClinicalNote` = el turno
 * activo de la sesión tiene una evolución de HC viva (raíz no anulada); con eso tampoco es "Sin evolución", igual
 * que en el bucket del server (`listOpenSessions`).
 */
export function isSessionWithoutEvolution(s: EvolutionProbe, opts?: { hasClinicalNote?: boolean }): boolean {
  return (
    s.completedAt != null &&
    !opts?.hasClinicalNote &&
    s.notes == null &&
    s.rpe == null &&
    s.paInPre == null &&
    s.paInPost == null &&
    s.exercises.every((x) => x.status === "PENDING")
  );
}

/** Orden del riel de sesiones: el del ordinal (fecha, empate por `index`). */
export function sortByOrdinal<T extends { scheduledFor: Date | string; index: number }>(sessions: readonly T[]): T[] {
  return [...sessions].sort((a, b) => +new Date(a.scheduledFor) - +new Date(b.scheduledFor) || a.index - b.index);
}

// ─── Evolución de HC del turno de la sesión (EV2-D19) ────────────────────────

/**
 * Lo que la página de detalle le pasa a `SessionDetail` sobre la evolución de HC del turno activo de la sesión.
 * Sale de `getBookingClinicalNote(booking.id)` en el server: `null` (sin turno, sin acceso o sin el módulo
 * `evoluciones`) = no se ofrece nada.
 */
export type SessionClinicalNote = {
  patientId: string;
  booking: { id: string; scheduledFor: string; serviceName: string | null };
  /** `BookingClinicalNoteView.canCreate`: escritura + turno válido + sin raíz viva. */
  canCreate: boolean;
  /** Hay una raíz viva en el turno (`BookingClinicalNoteView.note !== null`). */
  hasLiveNote: boolean;
};

/**
 * Qué muestra el detalle: «Cargar evolución» (abre el editor) si el server dice que se puede crear; «Ver
 * evolución» (perfil con `?turno=`) si ya hay una viva; si no, nada. La barrera es `createClinicalNote`.
 */
export function sessionClinicalNoteAction(
  c: SessionClinicalNote | null | undefined
): { kind: "create" } | { kind: "view"; href: string } | null {
  if (!c) return null;
  if (c.hasLiveNote) return { kind: "view", href: clinicalNoteDeepLink(c.patientId, c.booking.id) };
  if (c.canCreate) return { kind: "create" };
  return null;
}

// ─── Agendar (generar turno de una sesión "sin turno") ──────────────────────

export type ScheduleOutcome =
  | { kind: "done"; message: string; notice?: string }
  | { kind: "stale"; preview: PlanPreview | null; message: string }
  | { kind: "confirm"; message: string }
  | { kind: "error"; message: string };

/** Resultado de `generatePlanBookings` → qué muestra el modal. */
export function scheduleOutcome(
  r: PlanEngineWriteResult<{ createdBookings: number; adoptedBookings: number }>
): ScheduleOutcome {
  if (r.ok) {
    const n = r.data.createdBookings + r.data.adoptedBookings;
    return {
      kind: "done",
      message: n > 0 ? "Turno agendado." : "La sesión quedó sin turno.",
      ...(r.notice ? { notice: r.notice } : {}),
    };
  }
  if ("kind" in r) {
    if (r.kind === "stale-preview") return { kind: "stale", preview: r.preview, message: SEGUIMIENTO_COPY.scheduleStale };
    if (r.kind === "stale") return { kind: "stale", preview: null, message: SEGUIMIENTO_COPY.scheduleStale };
    if (r.kind === "needs-confirmation") return { kind: "confirm", message: r.error };
  }
  return { kind: "error", message: "error" in r && r.error ? r.error : "No pudimos agendar la sesión." };
}
