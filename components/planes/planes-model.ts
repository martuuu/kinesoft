/**
 * `/planes` (S21, ES3 · PD-11): lógica pura de la pantalla de planes del
 * consultorio. Vive fuera de `planes-client.tsx` ("use client") porque la usan
 * también las páginas server (`app/(app)/planes/…`): una función exportada de
 * un módulo cliente, importada desde un Server Component, llega como
 * referencia de cliente y no se puede llamar en el server.
 *
 * Reglas que se resuelven acá (y se testean en `tests/unit/render/planes.test.tsx`):
 *   - Una sola entrada "Planes" con pestañas por disciplina (PD-11). El slug
 *     de la URL es el del tag DISCIPLINE del catálogo (`DISCIPLINE_TAG_SLUGS`:
 *     `/planes/kinesiologia`, `/planes/osteopatia`): una sola fuente para la
 *     biblioteca y para esta ruta.
 *   - Pestañas = disciplinas con algún servicio del consultorio que la tenga.
 *     `Service` no tiene baja lógica: "servicio activo" = existe y tiene la
 *     disciplina cargada (la misma lista que ofrece el editor). Una disciplina
 *     sin servicio → `notFound` en la página (no hay cómo crear un plan ahí).
 *   - Permisos: NO se reimplementan; cada fila pasa por `planUiPermissions`
 *     con el nivel que el server ya calculó para SU paciente (`row.level`).
 *   - "Sesiones sin turno" (C4): solo planes ACTIVOS vinculados con alguna
 *     sesión sin turno (los únicos que el motor deja agendar, S25a) y SIN
 *     título en esa vista (PD-13: es la vista de trabajo de la Secretaria).
 */
import { DISCIPLINES, DISCIPLINE_TAG_SLUGS, type Discipline } from "@/lib/plans-constants";
import { disciplineLabel } from "@/lib/plan-display";
import type { Capability } from "@/lib/capabilities";
import type { PlanListRow } from "@/lib/plans-read-types";
import { planUiPermissions } from "@/components/planes/plan-editor-types";

// ─── Rutas ───────────────────────────────────────────────────────────────────

export const PLANES_BASE_PATH = "/planes";
/** `?filtro=sin-turno`: linkeable (la Secretaria lo deja en favoritos). */
export const PLANES_FILTER_PARAM = "filtro";
export const PLANES_SIN_TURNO = "sin-turno";

export type PlanesFilter = "all" | "sin-turno";

export function disciplineSlug(d: Discipline): string {
  return DISCIPLINE_TAG_SLUGS[d];
}

/** Slug de la URL → disciplina, o `null` (slug desconocido). */
export function disciplineFromSlug(slug: string | null | undefined): Discipline | null {
  if (!slug) return null;
  return DISCIPLINES.find((d) => DISCIPLINE_TAG_SLUGS[d] === slug) ?? null;
}

export function planesHref(d: Discipline, filter: PlanesFilter = "all"): string {
  const base = `${PLANES_BASE_PATH}/${disciplineSlug(d)}`;
  return filter === "sin-turno" ? `${base}?${PLANES_FILTER_PARAM}=${PLANES_SIN_TURNO}` : base;
}

export function parsePlanesFilter(raw: string | string[] | undefined): PlanesFilter {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v === PLANES_SIN_TURNO ? "sin-turno" : "all";
}

/**
 * Disciplinas con al menos un servicio que la tenga, en el orden canónico
 * (`DISCIPLINES`), sin repetir. Es el set de pestañas.
 */
export function availableDisciplines(services: ReadonlyArray<{ discipline: Discipline | null }>): Discipline[] {
  const present = new Set(services.map((s) => s.discipline).filter((d): d is Discipline => d != null));
  return DISCIPLINES.filter((d) => present.has(d));
}

/** Pestaña pedida si está disponible; si no, `null` (→ `notFound`). */
export function resolveDisciplineTab(slug: string, available: readonly Discipline[]): Discipline | null {
  const d = disciplineFromSlug(slug);
  return d && available.includes(d) ? d : null;
}

// ─── Permisos de la pantalla ─────────────────────────────────────────────────

export type PlanesScreenPermissions = {
  /** "Nuevo plan": `plans.manage` + `clinical.read` (el `full` sobre el paciente lo filtra el picker). */
  create: boolean;
  /** Filtro "Sesiones sin turno": `plans.schedule`. */
  sinTurnoFilter: boolean;
};

export function planesScreenPermissions(caps: ReadonlySet<Capability>, plansModule: boolean): PlanesScreenPermissions {
  if (!plansModule) return { create: false, sinTurnoFilter: false };
  return {
    create: caps.has("plans.manage") && caps.has("clinical.read"),
    sinTurnoFilter: caps.has("plans.schedule"),
  };
}

/**
 * "Agendar" de una fila: `plans.schedule` sobre ESE paciente (planUiPermissions:
 * full u `agenda.operateAll`), plan ACTIVO, vinculado y con sesiones sin turno.
 * El server re-chequea todo (`assertPlanScheduleInTx`): esto solo decide si se
 * ofrece el botón.
 */
export function canScheduleRow(row: PlanListRow, caps: ReadonlySet<Capability>, plansModule: boolean): boolean {
  if (row.status !== "ACTIVE" || !row.linked || row.sinTurno <= 0 || row.archivedAt != null) return false;
  return planUiPermissions({ caps, access: row.level, role: null, plansModule, templatesModule: false }).schedule;
}

// ─── Filas ───────────────────────────────────────────────────────────────────

/** Filas de la vista: filtro + búsqueda por paciente + orden estable (paciente, alta). */
export function visiblePlanRows(rows: readonly PlanListRow[], filter: PlanesFilter, query = ""): PlanListRow[] {
  const q = normalize(query);
  return rows
    .filter((r) => (filter === "sin-turno" ? r.status === "ACTIVE" && r.linked && r.sinTurno > 0 : true))
    .filter((r) => (q ? normalize(r.patientName).includes(q) : true))
    .sort(
      (a, b) =>
        a.patientName.localeCompare(b.patientName, "es-AR", { sensitivity: "base" }) ||
        +new Date(a.createdAt) - +new Date(b.createdAt)
    );
}

function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Título que se muestra en la fila. Nunca en "Sesiones sin turno" (PD-13) y
 * solo si el server lo mandó (null para quien no tiene `clinical.read` + full).
 * Con nivel distinto de `full` no se pinta aunque venga (defensa en
 * profundidad, P3.Z).
 */
export function rowTitle(row: PlanListRow, filter: PlanesFilter): string | null {
  if (filter === "sin-turno" || row.level !== "full") return null;
  return row.title?.trim() ? row.title : null;
}

/** Una sola fuente con el perfil (P3.Z): `plan-booking-groups.ts` es puro (sin React ni server). */
export { PLAN_STATUS_LABEL } from "@/components/planes/plan-booking-groups";

/** C13 literal del plan legacy (R-LEGACY). Lo usan `/planes` y la PlanCard. */
export const PLAN_LEGACY_COPY = "Plan anterior a la agenda · Completá los datos para agendar";

/** "3 de 10 realizadas". */
export function progressLabel(row: Pick<PlanListRow, "done" | "totalLive">): string {
  return `${row.done} de ${row.totalLive} realizada${row.totalLive === 1 ? "" : "s"}`;
}

/** "1 sesión sin turno" / "3 sesiones sin turno". */
export function sinTurnoLabel(n: number): string {
  return n === 1 ? "1 sesión sin turno" : `${n} sesiones sin turno`;
}

/** Próxima sesión con turno, en hora AR ("Próxima: mar 14/10 · 09:30"). */
export function nextSessionLabel(row: Pick<PlanListRow, "nextSession">): string | null {
  if (!row.nextSession) return null;
  const at = new Date(row.nextSession.at);
  // Por partes: el separador de `toLocaleDateString("es-AR")` cambia entre
  // runtimes de ICU ("14/10" en el navegador, "14-10" en algunos Node).
  const parts = new Intl.DateTimeFormat("es-AR", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    timeZone: "America/Argentina/Buenos_Aires",
  }).formatToParts(at);
  const part = (t: Intl.DateTimeFormatPartTypes) => parts.find((x) => x.type === t)?.value ?? "";
  const day = `${part("weekday").replace(/\.$/, "")} ${part("day")}/${part("month")}`;
  const time = at.toLocaleTimeString("es-AR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "America/Argentina/Buenos_Aires",
  });
  return `Próxima: ${day} · ${time}`;
}

/** "Sesión 3 de 10" (ordinal M13, nunca `index`). */
export function sessionLabel(ordinal: number, totalLive: number): string {
  return `Sesión ${ordinal} de ${totalLive}`;
}

// ─── "Agendar": qué sesión ───────────────────────────────────────────────────

/**
 * Elige la sesión a agendar de un plan: la "sin turno" de menor ordinal entre
 * las agendables del paciente (`listSchedulablePlanSessions`) de ESE plan.
 * Desde S19c la fila trae `programId` (S21 H3, P3.Z): antes no lo traía y se
 * cruzaba con un preview del motor (doble lectura). El server re-valida
 * sesión ↔ plan al agendar.
 */
export function pickSessionToSchedule(
  programId: string,
  schedulable: ReadonlyArray<{ sessionId: string; programId: string; ordinal: number; totalLive: number; sinTurno: boolean }>
): { sessionId: string; label: string } | null {
  const best = schedulable
    .filter((s) => s.sinTurno && s.programId === programId)
    .sort((a, b) => a.ordinal - b.ordinal)[0];
  return best ? { sessionId: best.sessionId, label: sessionLabel(best.ordinal, best.totalLive) } : null;
}

// ─── Copy (C13, voseo) ───────────────────────────────────────────────────────

export const PLANES_COPY = {
  heading: "Planes",
  eyebrow: "Planes de tratamiento",
  tabsLabel: "Disciplinas",
  newPlan: "Nuevo plan",
  newPlanTitle: "Nuevo plan",
  newPlanDescription: "Elegí el paciente. El plan se arma en su ficha.",
  newPlanContinue: "Continuar",
  filterAll: "Todos",
  filterSinTurno: "Sesiones sin turno",
  filterSinTurnoHint: "Planes activos con sesiones que todavía no tienen turno.",
  search: "Buscar paciente",
  schedule: "Agendar",
  scheduleNothing: "Este plan ya no tiene sesiones para agendar.",
  scheduleError: "No pudimos revisar el plan. Reintentá en un momento.",
  empty: (d: Discipline) => `No hay planes activos de ${disciplineLabel(d).toLowerCase()}.`,
  emptySinTurno: "No hay sesiones sin turno. Todo agendado.",
  emptySearch: "Ningún plan coincide con la búsqueda.",
  noDisciplines: "Todavía no hay servicios con disciplina.",
  noDisciplinesHint: "Cargá la disciplina (Kinesiología u Osteopatía) en tus servicios para empezar a crear planes.",
  noDisciplinesAction: "Ir a Servicios",
  truncated: (n: number) => `Se muestran los primeros ${n} planes.`,
  unlinked: PLAN_LEGACY_COPY,
  templatesHeading: "Plantillas",
} as const;
