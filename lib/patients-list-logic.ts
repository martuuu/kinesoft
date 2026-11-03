/**
 * HD-10 / HD-14 (PV §27) · lógica pura del directorio de pacientes (`/pacientes`).
 *
 * Vive fuera de `lib/patients.ts` ("use server", solo exporta funciones async) y de
 * `lib/patients-list-internal.ts` (server-only, toca la DB) para poder testearla sola
 * (`tests/unit/hd10-patients-list-logic.test.ts`). Todo lo de fechas va en UTC puro sobre el
 * día AR (`toARDateKey`): en Vercel el host corre en UTC y `getFullYear`/`getDate`/`new Date("…T00:00")`
 * del host corrían la edad y la «última visita» un día entre las 21:00 y las 24:00 AR (HD-14).
 */
import type { BookingStatus, Prisma } from "@prisma/client";
import { localToARIso, toARDateKey } from "@/lib/datetime-ar";
import { matchesInsurerKey, type CoverageForOsFilter } from "@/lib/patients-os-filter";

/** Tope de `q` (llega por URL): un ILIKE con un patrón de kilobytes no le sirve a nadie. */
export const PATIENTS_QUERY_MAX = 100;
/** Edad aceptada en los filtros. Fuera de esto, `Date.UTC` de un año absurdo da Invalid Date y Prisma tira. */
export const PATIENTS_AGE_MAX = 130;

/** Acceso de una fila (`bulkPatientAccess`); ausente = `basic`, como antes de HD-10. */
export type DirectoryRowAccess = "full" | "admin" | "basic" | "none";

/** Lo que el predicado de visibilidad necesita de la fila (sale de la fase liviana). */
export type DirectoryVisibilityRow = {
  firstName: string;
  lastName: string;
  documentId: string | null;
  /** Cobertura vigente (`coverages[0]`, `orderBy id desc`); solo se mira con `insurerKey`. */
  currentCoverage?: CoverageForOsFilter;
};

export type DirectoryVisibilityFilters = {
  insurerKey?: string;
  /** Diagnóstico o «con/sin plan». */
  clinicalFilter: boolean;
  /** Obra social, edad o última visita. */
  maskedFilter: boolean;
  /** `q` en minúsculas (sin escapar: acá no hay comodines). */
  qLower?: string;
};

/**
 * ¿La fila entra al directorio de este actor? Movido TAL CUAL de `listPatients` (P0.Z H-b1 + T3e-2p):
 *  - `?os=`: solo la cobertura VIGENTE (el pre-filtro SQL matchea cualquiera). Va antes del acceso.
 *  - Filtros clínicos (diagnóstico, con/sin plan): solo filas `full` (si no, un rol sin HC sabía quién tenía
 *    lumbalgia o plan: era un oráculo). Un rol sin `clinical.read` (PD-13, siempre `admin`) recibe [].
 *  - Obra social, edad, última visita y email (en `q`) son PHI recortada en `basic`: no filtran filas basic.
 *    `admin` sí los ve en el perfil, así que conserva sus filas. En `q`, una fila basic queda solo si matchea por
 *    nombre o DNI (lo que su proyección muestra), no por email.
 */
export function isDirectoryVisible(
  p: DirectoryVisibilityRow,
  accessRaw: DirectoryRowAccess | undefined,
  f: DirectoryVisibilityFilters,
): boolean {
  if (f.insurerKey && !matchesInsurerKey(p.currentCoverage, f.insurerKey)) return false;
  const access = accessRaw ?? "basic";
  if (access === "full") return true;
  if (f.clinicalFilter) return false;
  if (access === "admin") return true;
  if (f.maskedFilter) return false;
  if (f.qLower) {
    const q = f.qLower;
    return [p.firstName, p.lastName, p.documentId].some((v) => v?.toLowerCase().includes(q));
  }
  return true;
}

/** `q` de la URL: recortado, ≤ 100 caracteres, vacío = sin búsqueda. */
export function normalizeDirectoryQuery(raw: string | undefined | null): string | undefined {
  const q = raw?.trim().slice(0, PATIENTS_QUERY_MAX).trim();
  return q ? q : undefined;
}

/** Edad de la URL: entero en [0, 130]; NaN/∞/ausente = sin filtro. */
export function normalizeAgeBound(raw: number | undefined | null): number | undefined {
  if (raw == null || !Number.isFinite(raw)) return undefined;
  return Math.min(PATIENTS_AGE_MAX, Math.max(0, Math.trunc(raw)));
}

/** Medianoche UTC de (y, m, d) con el día recortado al último del mes (29-feb de un año no bisiesto → 28-feb). */
function utcDateClamped(y: number, monthIndex: number, d: number): Date {
  const last = new Date(Date.UTC(y, monthIndex + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, monthIndex, Math.min(d, last)));
}

/**
 * Rango de `dateOfBirth` (fecha guardada como medianoche UTC del día de nacimiento) para una edad en
 * [min, max] años cumplidos, inclusive en las dos puntas, contada sobre el día AR `todayKey` (`toARDateKey(now)`).
 *  - edad ≥ min ⇔ nació el (hoy − min años) o antes → `lte`;
 *  - edad ≤ max ⇔ nació después del (hoy − (max+1) años) → `gte` = ese día + 1.
 * HD-14: antes salía de `now.getFullYear()/getMonth()/getDate()` del host: en Vercel (UTC), desde las 21:00 AR ya era
 * mañana y quien cumplía años al día siguiente entraba con la edad nueva. El 29-feb se recorta al 28 (antes
 * desbordaba al 1-mar y dejaba afuera a quien cumplía ese día).
 */
export function dobBoundsForAge(
  todayKey: string,
  min: number | undefined,
  max: number | undefined,
): { gte?: Date; lte?: Date } | null {
  if (min == null && max == null) return null;
  const [y, m, d] = todayKey.split("-").map(Number);
  const out: { gte?: Date; lte?: Date } = {};
  if (min != null) out.lte = utcDateClamped(y - min, m - 1, d);
  if (max != null) {
    const base = utcDateClamped(y - max - 1, m - 1, d);
    out.gte = new Date(base.getTime() + 86_400_000);
  }
  return out;
}

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Punta del filtro «última visita» (`?lastVisitFrom=` / `?lastVisitTo=`, `yyyy-mm-dd` del `<input type="date">`)
 * como instante AR: `from` = 00:00 AR de ese día, `to` = 23:59:59.999 AR. Lo que no sea una fecha real
 * (`2026-02-31`, basura de la URL) se ignora: V8 parsea `2026-02-31` como 3-mar, por eso el ida y vuelta.
 * HD-14: antes `new Date(d + "T00:00:00")` se leía en el TZ del host (UTC en Vercel): un turno de las 22:30 AR caía
 * fuera de su día.
 */
export function parseLastVisitBound(raw: string | undefined | null, edge: "from" | "to"): Date | undefined {
  if (!raw || !DATE_KEY_RE.test(raw)) return undefined;
  const at = new Date(localToARIso(`${raw}T${edge === "from" ? "00:00:00" : "23:59:59.999"}`));
  if (Number.isNaN(at.getTime()) || toARDateKey(at) !== raw) return undefined;
  return at;
}

/**
 * Orden por una clave de fecha que depende de filas relacionadas («Próximo turno» asc, «Última visita» desc):
 * las filas sin clave van al final y los empates conservan el orden de entrada (el `orderBy` SQL + `id`), porque
 * `Array.prototype.sort` es estable. Es el MISMO comparador para la página y para el export.
 */
export function sortByDateKey<T>(
  items: readonly T[],
  key: (item: T) => Date | null | undefined,
  dir: "asc" | "desc",
): T[] {
  const keyed = items.map((item) => {
    const k = key(item);
    return { item, k: k ? k.getTime() : null };
  });
  keyed.sort((a, b) => {
    if (a.k === b.k) return 0;
    if (a.k === null) return 1;
    if (b.k === null) return -1;
    return dir === "asc" ? a.k - b.k : b.k - a.k;
  });
  return keyed.map((x) => x.item);
}

/** Página pedida → página real: entero en [1, pageCount]; `pageCount` ≥ 1 aunque no haya filas. */
export function clampPatientsPage(
  total: number,
  rawPage: number | undefined | null,
  pageSize: number,
): { page: number; pageCount: number; start: number } {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const wanted = rawPage != null && Number.isFinite(rawPage) ? Math.trunc(rawPage) : 1;
  const page = Math.min(pageCount, Math.max(1, wanted));
  return { page, pageCount, start: (page - 1) * pageSize };
}

/**
 * CF2 (§29, decisión 3 de Martin: el plan sale de Pacientes): totales del directorio sobre las filas VISIBLES (no solo
 * la página), sin «con/sin plan». Reemplazó a `directoryTotals` (contaba filas `full` con y sin plan activo para los
 * pills, y obligaba a la fase 1 a traer `_count.programs`).
 */
export function directoryTotalsAll(rows: readonly unknown[]): { all: number } {
  return { all: rows.length };
}

/**
 * CF2 (decisión 3): las pastillas «Con plan / Sin plan» salieron para todos. Un link viejo con `?filter=active` o
 * `?filter=no-program` (marcadores, el recordatorio de altas previo) se lee como `all` en vez de filtrar por plan.
 */
export function normalizeDirectoryFilter(raw: string | undefined | null): "all" | "archived" {
  return raw === "archived" ? "archived" : "all";
}

// ── CF2 · hechos de turnos por paciente × profesional (P.1) ──────────────────────────────────────────────────────

/** D-CF2-14: activo = turno próximo o una visita en los últimos 90 días. */
export const PATIENT_ACTIVE_WINDOW_DAYS = 90;
/** Decisión 2 de Martin: «los que tienen turnos con ese paciente (próximos o del último mes)». */
export const PATIENT_RECENT_PRACTITIONER_DAYS = 30;

const DAY_MS = 86_400_000;

/**
 * D-CF2-15: «última visita» = último turno PASADO que no fue cancelado, ausente ni quedó PENDING. No exige COMPLETED:
 * muchos consultorios nunca marcan «Atendido» y la columna quedaba vacía (feedback del 2-nov). El mismo criterio va en
 * la columna, el filtro, el orden y el «reciente» de profesionales; el SQL de `bookingFactsByPatient` (`lastSeenAt`)
 * usa esta misma lista.
 * PENDING (INT-P, hallazgo de P-S1): un turno con paciente nace CONFIRMED (`buildBookingCreateData`); PENDING con
 * paciente es la reserva del turnero con seña obligatoria que todavía no se pagó (hold de 30 min). Si nunca se pagó,
 * el paciente no vino: contarla mostraba una «última visita» (y un profesional «reciente») que no existió.
 */
export const PATIENT_LAST_VISIT_EXCLUDED_STATUSES = ["CANCELLED", "NO_SHOW", "PENDING"] as const satisfies readonly BookingStatus[];

/**
 * Una fila de `bookingFactsByPatient` (1 `$queryRaw` agrupado por paciente × profesional):
 *  - `nextAt` = MIN(scheduledFor) de turnos ≥ now no cancelados;
 *  - `lastCompletedAt` = MAX de COMPLETED (queda por compatibilidad; la «última visita» ya no lo usa);
 *  - `lastSeenAt` = MAX de turnos < now fuera de `PATIENT_LAST_VISIT_EXCLUDED_STATUSES` (CANCELLED, NO_SHOW, PENDING).
 */
export type PatientBookingFactRow = {
  patientId: string;
  practitionerId: string;
  nextAt: Date | null;
  lastCompletedAt: Date | null;
  lastSeenAt: Date | null;
};

export type PatientBookingFacts = {
  /** Próximo turno del paciente con cualquier profesional (el más cercano). */
  nextAt: Date | null;
  /** D-CF2-15: max(lastSeenAt) entre profesionales. */
  lastVisitAt: Date | null;
  /** Profesionales con un turno próximo o visto en los últimos 30 días: próximos primero (más cercano), después el visto más reciente. */
  recentPractitionerIds: string[];
  /**
   * CF2-ZF3 (ZA-6): solo los que tienen un turno PRÓXIMO, por cercanía (el prefijo de `recentPractitionerIds`). Es lo
   * que lleva la fila `basic`: con los recientes, un kine sin acceso a la HC veía «Kinesiólogo: X» y deducía que el
   * paciente se atendió con X en el último mes, justo la «última visita» que la fila basic oculta (D-CF2-15). El
   * próximo turno, en cambio, la fila basic ya lo muestra (`upcomingAt`).
   */
  upcomingPractitionerIds: string[];
};

export type PatientActivity = "active" | "inactive" | "archived";

const minDate = (a: Date | null, b: Date | null): Date | null => (!a ? b : !b ? a : a.getTime() <= b.getTime() ? a : b);
const maxDate = (a: Date | null, b: Date | null): Date | null => (!a ? b : !b ? a : a.getTime() >= b.getTime() ? a : b);

/**
 * Pliega las filas paciente × profesional en un hecho por paciente. Solo hay entradas para pacientes con filas (el
 * llamador trata la ausencia como «sin turnos»). Filas repetidas del mismo par se funden (min nextAt, max lastSeenAt):
 * el SQL agrupa, pero un UNION futuro o un loader en lotes no debería duplicar al profesional en la celda.
 * Aritmética de instantes (no de día AR): «hace 30 días» es una ventana, no un calendario, y así no depende del TZ.
 */
export function foldPatientBookingFacts(
  rows: readonly PatientBookingFactRow[],
  now: Date,
): Map<string, PatientBookingFacts> {
  const byPatient = new Map<string, Map<string, { nextAt: Date | null; lastSeenAt: Date | null }>>();
  for (const r of rows) {
    let pros = byPatient.get(r.patientId);
    if (!pros) byPatient.set(r.patientId, (pros = new Map()));
    const prev = pros.get(r.practitionerId);
    pros.set(r.practitionerId, {
      nextAt: minDate(prev?.nextAt ?? null, r.nextAt),
      lastSeenAt: maxDate(prev?.lastSeenAt ?? null, r.lastSeenAt),
    });
  }

  const recentFrom = now.getTime() - PATIENT_RECENT_PRACTITIONER_DAYS * DAY_MS;
  const out = new Map<string, PatientBookingFacts>();
  for (const [patientId, pros] of byPatient) {
    let nextAt: Date | null = null;
    let lastVisitAt: Date | null = null;
    const recent: { id: string; nextAt: Date | null; lastSeenAt: Date | null }[] = [];
    for (const [id, f] of pros) {
      nextAt = minDate(nextAt, f.nextAt);
      lastVisitAt = maxDate(lastVisitAt, f.lastSeenAt);
      if (f.nextAt || (f.lastSeenAt && f.lastSeenAt.getTime() >= recentFrom)) recent.push({ id, ...f });
    }
    recent.sort((a, b) => {
      if (a.nextAt && b.nextAt) return a.nextAt.getTime() - b.nextAt.getTime() || a.id.localeCompare(b.id);
      if (a.nextAt) return -1;
      if (b.nextAt) return 1;
      // Sin próximo los dos: los dos tienen lastSeenAt dentro de la ventana (si no, no serían recientes).
      return (b.lastSeenAt?.getTime() ?? 0) - (a.lastSeenAt?.getTime() ?? 0) || a.id.localeCompare(b.id);
    });
    out.set(patientId, {
      nextAt,
      lastVisitAt,
      recentPractitionerIds: recent.map((r) => r.id),
      upcomingPractitionerIds: recent.filter((r) => r.nextAt).map((r) => r.id),
    });
  }
  return out;
}

/**
 * Decisión 2 de Martin («dos kines» en Pacientes): el a cargo primero y después los recientes, sin duplicados. Sin a
 * cargo («Consultorio común», `assignedPractitionerId` null) quedan solo los recientes.
 */
export function patientPractitionerIds(
  assignedId: string | null | undefined,
  recent: readonly string[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of assignedId ? [assignedId, ...recent] : recent) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * D-CF2-14 (todos los roles y verticales): Archivado = la vista de archivados; Activo = turno próximo o una visita en
 * los últimos 90 días (borde inclusive); Inactivo = ninguna. Sale de los turnos, no de la HC, por eso una fila `admin`
 * (Secretaria) también lo recibe; solo la `basic` lo oculta (D-CF2-15). `nextAt` llega ya filtrado a ≥ now por el SQL.
 */
export function patientActivity(
  input: { archivedView: boolean; nextAt: Date | null; lastVisitAt: Date | null },
  now: Date,
): PatientActivity {
  if (input.archivedView) return "archived";
  if (input.nextAt) return "active";
  const from = now.getTime() - PATIENT_ACTIVE_WINDOW_DAYS * DAY_MS;
  return input.lastVisitAt && input.lastVisitAt.getTime() >= from ? "active" : "inactive";
}

/**
 * D-CF2-15 para el filtro «Última visita desde/hasta» (`lib/patients-list-internal.ts`, `lastVisitWhere`): el
 * `bookings.some` pasa de `status: "COMPLETED"` a «pasado y no cancelado, ausente ni PENDING», el mismo criterio que la
 * columna y el orden. Las puntas salen de `parseLastVisitBound`. Va como `bookings: { some: lastVisitBookingWhere(…) }`.
 * Como hoy, filtra filas `full` y `admin` (las dos ven la última visita); las `basic` las saca `isDirectoryVisible`
 * con `maskedFilter`, que no cambia.
 */
export function lastVisitBookingWhere(
  now: Date,
  from: Date | undefined,
  to: Date | undefined,
): Prisma.BookingWhereInput {
  return {
    status: { notIn: [...PATIENT_LAST_VISIT_EXCLUDED_STATUSES] },
    scheduledFor: { lt: now, ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) },
  };
}
