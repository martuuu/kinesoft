/**
 * Display de Planes, puro (PLANES.md V1-D18 · V2 · R-LEGACY · M13; sesión
 * S16p, ES1).
 *
 * Lo importan la UI (chip de agenda, PlanCard, Seguimiento) y el server
 * (proyección de agenda S12p, ICS, recordatorios). Sin DB ni reloj; fechas
 * como Date o ISO, comparadas como instantes (nada del huso del host).
 */
import type { Discipline } from "@/lib/plans-constants";

// ─── Disciplina ──────────────────────────────────────────────────────────────

const LABEL: Record<Discipline, string> = { KINESIOLOGY: "Kinesiología", OSTEOPATHY: "Osteopatía" };
const SHORT: Record<Discipline, string> = { KINESIOLOGY: "Kine", OSTEOPATHY: "Osteo" };
/**
 * Tokens `--disc-*` de `app/globals.css` (hex literal con contraste AA, los
 * publica la sesión de tokens de ES1). Se referencian por `var()` para que el
 * color viva en un solo lugar. En la agenda la disciplina es un canal NO
 * cromático primero (el texto del chip): el color solo acompaña (AGENTS §5).
 */
const COLOR_VAR: Record<Discipline, string> = {
  KINESIOLOGY: "var(--disc-kine)",
  OSTEOPATHY: "var(--disc-osteo)",
};

export function disciplineLabel(d: Discipline): string {
  return LABEL[d];
}
export function disciplineShortLabel(d: Discipline): string {
  return SHORT[d];
}
export function disciplineColorVar(d: Discipline | null): string | null {
  return d ? COLOR_VAR[d] : null;
}

// ─── V1-D18 · chip ───────────────────────────────────────────────────────────

/** "Sesión 3 de 10": aria del chip, ICS y recordatorio (V1-D18). */
export function planSessionLabel(ordinal: number, totalLive: number): string {
  return `Sesión ${ordinal} de ${totalLive}`;
}

/**
 * Chip `Kine · 3/10` / `Osteo · 3/6` (V1-D18). Disciplina y contador los ve
 * todo el que ve el turno; el TÍTULO del plan nunca sale del chip: la entrada
 * solo lee `discipline`, `ordinal` y `totalLive`, así que un `title` que venga
 * colado en el objeto (C9) no puede filtrarse a un rol con `clinicalHidden` o
 * acceso básico, ni al aria.
 *
 * El aria arranca con el texto literal "Sesión 3 de 10" y suma la disciplina,
 * porque el `aria-label` reemplaza al texto visible y si no "Kine" se
 * perdería para un lector de pantalla. Un legacy sin disciplina muestra
 * "Plan · 2/8". En "Por profesional" este chip es una pill distinta de la de
 * ocupación "2/3" (la diferencia la pone el componente, no el texto).
 */
export function planChip(plan: {
  discipline: Discipline | null;
  ordinal: number;
  totalLive: number;
}): { label: string; ariaLabel: string; colorVar: string | null } {
  const { discipline, ordinal, totalLive } = plan;
  const counter = `${ordinal}/${totalLive}`;
  const session = planSessionLabel(ordinal, totalLive);
  return {
    label: `${discipline ? SHORT[discipline] : "Plan"} · ${counter}`,
    ariaLabel: discipline ? `${session} · ${LABEL[discipline]}` : session,
    colorVar: disciplineColorVar(discipline),
  };
}

// ─── R-LEGACY ────────────────────────────────────────────────────────────────

/**
 * R-LEGACY: un plan está **vinculado** si tiene `schedule` no nulo o al menos
 * un turno con `programId`. Un legacy de prod (sesiones a 00:00Z, sin turnos)
 * no cuenta para "Fuera de plan", ni para "Sin turno", ni para I3/I5/I6 del
 * verificador, hasta que "Completar datos" (S25L) lo vincule.
 */
export function isLinkedProgram(p: { hasSchedule: boolean; hasLinkedBooking: boolean }): boolean {
  return p.hasSchedule || p.hasLinkedBooking;
}

export type LinkedPlanDiscipline = Discipline | "NONE";

/**
 * Las disciplinas de los planes ACTIVE, no archivados (`liveProgramWhere`) y
 * vinculados del paciente: el valor de `patientActiveLinkedPlanDisciplines`
 * de C9. `"NONE"` = plan vinculado sin disciplina. `[]` = sin plan vinculado
 * activo. Sin duplicados, en orden de aparición.
 */
export function activeLinkedPlanDisciplines(
  programs: readonly {
    status: "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED" | string;
    archivedAt: Date | string | null;
    discipline: Discipline | null;
    hasSchedule: boolean;
    hasLinkedBooking: boolean;
  }[]
): LinkedPlanDiscipline[] {
  const out: LinkedPlanDiscipline[] = [];
  for (const p of programs) {
    if (p.status !== "ACTIVE" || p.archivedAt != null || !isLinkedProgram(p)) continue;
    const d: LinkedPlanDiscipline = p.discipline ?? "NONE";
    if (!out.includes(d)) out.push(d);
  }
  return out;
}

// ─── V2 · "Fuera de plan" ────────────────────────────────────────────────────

/**
 * "Fuera de plan" (V2): un turno suelto (`programId` null), no cancelado, de
 * un paciente que tiene un plan ACTIVE **vinculado** (R-LEGACY) de la misma
 * disciplina que el servicio; si el servicio no tiene disciplina, cualquier
 * plan vinculado activo cuenta. Un plan vinculado sin disciplina ("NONE")
 * cubre cualquier servicio: es un aviso para vincular, y ante la duda se
 * muestra (no bloquea nada).
 *
 * Los campos C9 son opcionales en `BookingDTO`/`DrawerBooking` (patrón B4.1):
 * si no vienen (proyección completa), devuelve `false` en vez de adivinar.
 */
export function isOutOfPlan(b: {
  programId?: string | null;
  status: string;
  hasPatient: boolean;
  serviceDiscipline?: Discipline | null;
  patientActiveLinkedPlanDisciplines?: readonly LinkedPlanDiscipline[];
}): boolean {
  const plans = b.patientActiveLinkedPlanDisciplines;
  if (!plans || plans.length === 0) return false;
  if (b.programId !== null) return false; // undefined (sin C9) o turno del plan
  if (!b.hasPatient || b.status === "CANCELLED") return false;
  if (b.serviceDiscipline === undefined) return false;
  if (b.serviceDiscipline === null) return true;
  return plans.includes(b.serviceDiscipline) || plans.includes("NONE");
}

// ─── M13 · ordinal ───────────────────────────────────────────────────────────

type OrdinalSession = { id: string; index: number; scheduledFor: Date | string; archivedAt: Date | string | null };
const ms = (d: Date | string) => (typeof d === "string" ? Date.parse(d) : d.getTime());

/**
 * M13: el `index` de una sesión es fijo (no se renumera nunca: `restoreSession`
 * falla si otro tomó su index) y lo que se muestra es el **ordinal** por fecha
 * entre las sesiones no archivadas. Empate de instante → `index`, para que el
 * orden sea determinista. Las archivadas no reciben ordinal.
 */
export function planSessionOrdinals(sessions: readonly OrdinalSession[]): Map<string, number> {
  const live = sessions
    .filter((s) => s.archivedAt == null)
    .sort((a, b) => ms(a.scheduledFor) - ms(b.scheduledFor) || a.index - b.index);
  return new Map(live.map((s, i) => [s.id, i + 1]));
}

export function planSessionOrdinal(sessions: readonly OrdinalSession[], sessionId: string): number | null {
  return planSessionOrdinals(sessions).get(sessionId) ?? null;
}
