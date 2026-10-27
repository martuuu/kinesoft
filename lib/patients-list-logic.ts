/**
 * HD-10 / HD-14 (PV §27) · lógica pura del directorio de pacientes (`/pacientes`).
 *
 * Vive fuera de `lib/patients.ts` ("use server", solo exporta funciones async) y de
 * `lib/patients-list-internal.ts` (server-only, toca la DB) para poder testearla sola
 * (`tests/unit/hd10-patients-list-logic.test.ts`). Todo lo de fechas va en UTC puro sobre el
 * día AR (`toARDateKey`): en Vercel el host corre en UTC y `getFullYear`/`getDate`/`new Date("…T00:00")`
 * del host corrían la edad y la «última visita» un día entre las 21:00 y las 24:00 AR (HD-14).
 */
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
 * Contadores de los pills sobre las filas VISIBLES (no solo la página). «Con plan» = fila `full` con al menos un
 * plan ACTIVE y vivo; «Sin plan» = fila `full` sin ninguno (ES4-Z: una fila basic/admin no se cuenta, porque al
 * filtrar no aparece). Sin `planes`, solo `all`.
 */
export function directoryTotals(
  rows: readonly { access: DirectoryRowAccess | undefined; activePlanCount: number }[],
  plansOn: boolean,
): { all: number; withProgram?: number; withoutProgram?: number } {
  if (!plansOn) return { all: rows.length };
  let withProgram = 0;
  let withoutProgram = 0;
  for (const r of rows) {
    if (r.access !== "full") continue;
    if (r.activePlanCount > 0) withProgram++;
    else withoutProgram++;
  }
  return { all: rows.length, withProgram, withoutProgram };
}
