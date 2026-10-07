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
 *     server tiene la última palabra (`loadSessionEvolution` → `loaded:false`).
 */
import { planSessionLabel } from "@/lib/plan-display";
import type { OpenSessionBuckets } from "@/lib/sessions-types";
import type { PlanEngineWriteResult } from "@/lib/plans-edit-types";
import type { PlanPreview } from "@/lib/plans-types";

// ─── Copy (C13) ──────────────────────────────────────────────────────────────

export const SEGUIMIENTO_COPY = {
  sinTurnoTitle: "Sin turno",
  sinTurnoHint: "Sesiones de planes activos que no tienen turno en la agenda.",
  sinEvolucionTitle: "Sin evolución",
  sinEvolucionHint: "Realizadas en los últimos 14 días que todavía no tienen anotaciones, EVA ni ejercicios marcados.",
  sinEvolucionTag: "Sin evolución",
  cargarEvolucion: "Cargar evolución",
  agendar: "Agendar",
  dischargeTitle: "Para dar el alta",
  dischargeAction: "Ver el plan",
  evolutionAlreadyLoaded: "Esta sesión ya tenía evolución cargada: editala con «Guardar anotaciones».",
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

/** Realizada (p. ej. por "Atendido" en la agenda) y sin evolución cargada. */
export function isSessionWithoutEvolution(s: EvolutionProbe): boolean {
  return (
    s.completedAt != null &&
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
