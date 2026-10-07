/**
 * Estado puro del editor único de planes (S18, ES3 P3.1 · contrato C10/C13 de
 * `.docs/PLANES.md` §4).
 *
 * Por qué existe aparte del componente: el editor es la pantalla central de
 * Planes y todo lo que decide (qué borrador se manda, qué resolución va por
 * fila, si el preview que se ve sigue valiendo, qué filas marcar después de un
 * `stale-preview`) es lógica que tiene que estar testeada sin DOM. El drawer
 * (`components/planes/plan-editor-drawer.tsx`) solo cablea esto con las
 * actions; el form (`plan-form.tsx`) solo pinta el borrador.
 *
 * Reglas que vienen del server y NO se reimplementan acá (la UI consume):
 *   - el `stateToken` lo calcula el motor sobre el borrador PARSEADO; el commit
 *     tiene que mandar EXACTAMENTE el mismo borrador que se previsualizó. Por
 *     eso el drawer guarda el `base` que mandó al preview y commitea ese, no
 *     uno re-armado (un `title: ""` vs `undefined` ya cambia el hash);
 *   - `isRowStale` del motor: toda fila que no sea "libre → crear" o "pasada →
 *     sin turno" necesita una resolución EXPLÍCITA en el commit. Por eso
 *     `commitResolutions` materializa la resolución por defecto que mostró la
 *     tabla (el usuario la vio y la aceptó) en vez de omitirla;
 *   - si la resolución elegida está permitida lo decide el motor (stale por
 *     fila); acá solo se descarta lo que el preview nuevo ya no ofrece.
 *
 * Fechas: solo dayKeys AR (`YYYY-MM-DD`) e instantes ISO que da el server.
 * "Hoy" sale de `toARDateKey` (nunca `toISOString().slice(0,10)`, C11).
 */
import { isDayKey } from "@/lib/availability/day";
import { planScheduleError } from "@/lib/availability/plan";
import { toARDateKey } from "@/lib/datetime-ar";
import { diagnosisRampSteps, type RampExercise } from "@/lib/diagnosis-engine";
import { phaseLabel } from "@/components/diagnostico/labels";
import { disciplineLabel } from "@/lib/plan-display";
import { PLAN_MAX_DURATION, PLAN_MAX_SESSIONS, PLAN_MIN_DURATION, type Discipline } from "@/lib/plans-constants";
import type { PlanEditorPrefill } from "@/lib/plans-deeplink";
import type { DiagnosisPlanPrefill } from "@/lib/diagnosis-types";
import type { PlanDetailDTO } from "@/lib/plans-read-types";
import type {
  PlanCreateInput,
  PlanPreview,
  PlanPreviewRow,
  PlanPreviewSummary,
  PlanPricingInput,
  PlanResolutionKind,
  PlanRowResolution,
  PlanScheduleV1,
} from "@/lib/plans-types";

// ─── Copy (C13 literal donde C13 lo fija) ────────────────────────────────────

export const PLAN_EDITOR_COPY = {
  /** C13 literal. */
  stale: "La agenda cambió mientras armabas el plan. Revisá las filas marcadas y confirmá de nuevo.",
  /** C13 literal (hint del selector de servicio). */
  serviceHint: "Asigná la disciplina en Configuración → Servicios",
  /** C13 literal. */
  priceNone: "Sin precio · sigue la cobertura",
  pricePerSession: "Por sesión",
  pricePackage: "Paquete",
  reviewTitle: "Revisá los turnos",
  preview: "Ver turnos",
  /** El borrador cambió después del preview: el que se ve ya no vale. */
  previewOutdated: "Cambiaste datos del plan: actualizando los turnos…",
  titleCreate: "Nuevo plan",
  titleGenerate: "Agendar sesiones del plan",
  titleReplan: "Editar el plan desde esta sesión",
  dirty: "Tenés un plan a medio armar. Si cerrás, se pierde.",
  noDiscipline: "Elegí la disciplina",
  noService: "Elegí el servicio",
  noPractitioner: "Elegí el profesional responsable",
  noPatient: "Elegí el paciente",
  noStart: "Elegí la fecha de inicio",
  noPrice: "Cargá el precio",
  sessionsRange: `De 1 a ${PLAN_MAX_SESSIONS} sesiones`,
  durationRange: `Entre ${PLAN_MIN_DURATION} y ${PLAN_MAX_DURATION} minutos`,
  authSessions: "Autorizá de 1 a 200 sesiones",
  authStart: "Elegí desde cuándo vale la autorización",
  authExpiry: "El vencimiento no puede ser anterior al inicio",
  noExercises: "El diagnóstico no tiene ejercicios para asignar",
} as const;

// ─── Tipos ───────────────────────────────────────────────────────────────────

/** "Sin precio · sigue la cobertura" / "Por sesión" / "Paquete" (C13). */
export type PlanPriceMode = "NONE" | "PER_SESSION" | "PACKAGE";

/**
 * Autorización de la OS opcional (E2). Campos como los tipea el usuario:
 * `<input type="date">` ya da `YYYY-MM-DD` (= dayKey AR, la excepción de
 * AGENTS §4 para inputs de fecha); vacío = no cargado.
 */
export type PlanAuthorizationDraft = {
  enabled: boolean;
  code: string;
  authorizedSessions: number | null;
  startsOnDayKey: string;
  expiresOnDayKey: string;
};

export type PlanExerciseDraft = { exerciseId: string; sets: number; reps: number };

/** Borrador del editor (modo `create` y `replan`). */
export type PlanEditorDraft = {
  patientId: string | null;
  discipline: Discipline | null;
  serviceId: string | null;
  practitionerId: string | null;
  /** null = "Según la agenda del profesional" (sede de la franja / principal). */
  locationId: string | null;
  /** null = la duración del servicio. */
  durationMin: number | null;
  schedule: PlanScheduleV1;
  startDayKey: string;
  totalSessions: number;
  priceMode: PlanPriceMode;
  priceCents: number | null;
  authorization: PlanAuthorizationDraft;
  title: string;
  notes: string;
  templateId: string | null;
  fromBookingId: string | null;
  countBookingAsSession1: boolean;
  /** Ejercicios con dosis (Diagnóstico / plantilla). null = sin ejercicios. */
  exercises: PlanExerciseDraft[] | null;
  origin: "diagnosis" | "template" | "booking" | "manual";
};

export type PlanEditorService = {
  id: string;
  name: string;
  discipline: Discipline | null;
  durationMin: number;
  priceCents: number;
};
export type PlanEditorPractitioner = { id: string; name: string };
export type PlanEditorLocation = { id: string; name: string; isPrimary: boolean };
export type PlanEditorOptions = {
  services: PlanEditorService[];
  practitioners: PlanEditorPractitioner[];
  locations: PlanEditorLocation[];
};

/** Lo que un preview de alta necesita (sin key, filas ni token). */
export type PlanCreateBase = Omit<PlanCreateInput, "idempotencyKey" | "rows" | "stateToken">;

/** Lo que `previewReplanPlan`/`replanPlan` necesitan (sin filas ni token). */
export type PlanReplanBase = {
  programId: string;
  fromSessionId: string;
  schedule: PlanScheduleV1;
  startDayKey: string;
  practitionerId?: string;
  serviceId?: string;
  locationId?: string | null;
  durationMin?: number | null;
};

/** Refs del plan existente (replan): lo que no se manda si no cambió. */
export type PlanReplanOriginal = {
  practitionerId: string | null;
  serviceId: string | null;
  locationId: string | null;
  durationMin: number | null;
};

export type PlanDraftErrors = Partial<
  Record<
    | "patientId"
    | "discipline"
    | "serviceId"
    | "practitionerId"
    | "schedule"
    | "startDayKey"
    | "totalSessions"
    | "durationMin"
    | "pricing"
    | "authorizedSessions"
    | "authStartsOn"
    | "authExpiresOn"
    | "exercises",
    string
  >
>;

// ─── Construcción del borrador ───────────────────────────────────────────────

export const EMPTY_SCHEDULE: PlanScheduleV1 = Object.freeze({ v: 1, frequency: "weekly", everyNWeeks: 1, slots: [] }) as PlanScheduleV1;

/** Cantidad por defecto (la del editor legacy, `PLAN_FORM_DEFAULTS.totalSessions`). */
export const DEFAULT_TOTAL_SESSIONS = 10;

/** Hoy AR como dayKey (C11). */
export function planEditorToday(now: Date = new Date()): string {
  return toARDateKey(now);
}

export function emptyAuthorization(startDayKey: string): PlanAuthorizationDraft {
  return { enabled: false, code: "", authorizedSessions: null, startsOnDayKey: startDayKey, expiresOnDayKey: "" };
}

/** Borrador vacío del alta. Con un solo profesional, ya queda elegido. */
export function emptyDraft(opts: {
  today: string;
  patientId?: string | null;
  discipline?: Discipline | null;
  practitioners?: ReadonlyArray<PlanEditorPractitioner>;
}): PlanEditorDraft {
  const onlyPractitioner = opts.practitioners?.length === 1 ? opts.practitioners[0].id : null;
  return {
    patientId: opts.patientId ?? null,
    discipline: opts.discipline ?? null,
    serviceId: null,
    practitionerId: onlyPractitioner,
    locationId: null,
    durationMin: null,
    schedule: { ...EMPTY_SCHEDULE, slots: [] },
    startDayKey: opts.today,
    totalSessions: DEFAULT_TOTAL_SESSIONS,
    priceMode: "NONE",
    priceCents: null,
    authorization: emptyAuthorization(opts.today),
    title: "",
    notes: "",
    templateId: null,
    fromBookingId: null,
    countBookingAsSession1: false,
    exercises: null,
    origin: "manual",
  };
}

function priceFromPricing(p: PlanPricingInput): Pick<PlanEditorDraft, "priceMode" | "priceCents"> {
  if (!p) return { priceMode: "NONE", priceCents: null };
  return p.mode === "PER_SESSION"
    ? { priceMode: "PER_SESSION", priceCents: p.pricePerSessionCents }
    : { priceMode: "PACKAGE", priceCents: p.totalPriceCents };
}

/**
 * Aplica un `PlanEditorPrefill` (C10: deep-link, "Crealo como plan…",
 * plantilla). Solo pisa lo que trae; el resto queda del borrador base.
 * `fromBookingId` sin `countBookingAsSession1` explícito → cuenta como la
 * sesión 1 (es lo que pide "crear plan desde este turno"; el form lo muestra
 * como checkbox y se puede destildar).
 */
export function applyPrefill(base: PlanEditorDraft, prefill: PlanEditorPrefill | null | undefined): PlanEditorDraft {
  if (!prefill) return base;
  const next: PlanEditorDraft = { ...base };
  if (prefill.discipline) next.discipline = prefill.discipline;
  if (prefill.serviceId) next.serviceId = prefill.serviceId;
  if (prefill.practitionerId) next.practitionerId = prefill.practitionerId;
  if (prefill.locationId !== undefined) next.locationId = prefill.locationId;
  if (prefill.durationMin !== undefined) next.durationMin = prefill.durationMin;
  if (prefill.startDayKey) {
    next.startDayKey = prefill.startDayKey;
    if (!base.authorization.enabled) next.authorization = { ...next.authorization, startsOnDayKey: prefill.startDayKey };
  }
  if (prefill.totalSessions !== undefined) next.totalSessions = prefill.totalSessions;
  if (prefill.schedule) next.schedule = prefill.schedule;
  if (prefill.pricing !== undefined) Object.assign(next, priceFromPricing(prefill.pricing));
  // La autorización de la OS NO se toma del prefill (P3.Z): el código es texto
  // libre y viajaba en la URL (C10 "sin texto libre", §2.6). Sale del schema;
  // acá se ignora aunque llegue una URL vieja o armada a mano.
  if (prefill.templateId) {
    next.templateId = prefill.templateId;
    next.origin = "template";
  }
  if (prefill.fromBookingId) {
    next.fromBookingId = prefill.fromBookingId;
    next.countBookingAsSession1 = prefill.countBookingAsSession1 ?? true;
    if (next.origin === "manual") next.origin = "booking";
  }
  return next;
}

/**
 * Rampa del Diagnóstico en el editor (S23 H3, P3.Z): "Sesiones 1-3 ·
 * Activación · 2 ejercicios; Sesiones 4-6 · …". Se recalcula con el borrador
 * (cantidad y ejercicios que siguen en él), con el mismo `diagnosisRampSteps`
 * que usa el server al escribir las sesiones: el editor no inventa otra rampa.
 * `null` = no hay nada que mostrar.
 */
export function diagnosisRampNote(
  diagnosisExercises: ReadonlyArray<RampExercise>,
  draft: Pick<PlanEditorDraft, "totalSessions" | "exercises">
): string | null {
  const kept = diagnosisExercises.filter((e) => draft.exercises?.some((x) => x.exerciseId === e.exerciseId));
  if (kept.length === 0 || !isInt(draft.totalSessions) || draft.totalSessions < 1) return null;
  const cap = (t: string) => t.charAt(0) + t.slice(1).toLowerCase();
  return diagnosisRampSteps(kept, draft.totalSessions)
    .map((st) => {
      const range = st.fromSession === st.toSession ? `Sesión ${st.fromSession}` : `Sesiones ${st.fromSession}-${st.toSession}`;
      return `${range} · ${cap(phaseLabel(st.phase))} · ${st.exerciseCount} ${st.exerciseCount === 1 ? "ejercicio" : "ejercicios"}`;
    })
    .join("; ");
}

/** Puerta Diagnóstico (S23): disciplina Kine, título, cantidad y ejercicios con dosis. */
export function applyDiagnosisPrefill(base: PlanEditorDraft, dp: DiagnosisPlanPrefill): PlanEditorDraft {
  return {
    ...base,
    discipline: dp.discipline,
    title: base.title || dp.title,
    totalSessions: dp.totalSessions,
    exercises: dp.exercises.map((e) => ({ exerciseId: e.exerciseId, sets: e.sets, reps: e.reps })),
    origin: "diagnosis",
  };
}

/**
 * Plantilla (S17t `getTemplatePrefill`): el prefill de la URL + lo que no
 * viaja en ella (título, notas, ejercicios con dosis). Tipado estructural para
 * no atar el editor a la forma interna del resultado de S17t.
 */
export function applyTemplatePrefill(
  base: PlanEditorDraft,
  tp: {
    templateId: string;
    prefill: PlanEditorPrefill;
    title: string;
    notes: string | null;
    exercises: ReadonlyArray<{ exerciseId: string; sets: number; reps: number }>;
  }
): PlanEditorDraft {
  // `prefill.templateId` viene SOLO si no se descartó ningún ejercicio (S17t):
  // `validatePlanRefsInTx` re-valida los ids guardados en la plantilla y
  // rechazaría el alta entera. Por eso no se fuerza `tp.templateId` acá.
  const withPrefill = applyPrefill(base, tp.prefill);
  return {
    ...withPrefill,
    title: base.title || tp.title,
    notes: base.notes || (tp.notes ?? ""),
    exercises: tp.exercises.length > 0 ? tp.exercises.map((e) => ({ exerciseId: e.exerciseId, sets: e.sets, reps: e.reps })) : base.exercises,
    origin: "template",
  };
}

/**
 * Borrador de "Editar desde la sesión N" (replan) a partir del detalle del
 * plan. El inicio es el día AR de esa sesión, nunca antes de hoy (el motor
 * no crea turnos en el pasado, H5). Sin horario (legacy) arranca vacío.
 */
export function draftFromPlanDetail(
  detail: Pick<
    PlanDetailDTO,
    "patientId" | "discipline" | "serviceId" | "practitionerId" | "locationId" | "durationMin" | "schedule" | "sessions"
  >,
  fromSessionId: string | null | undefined,
  today: string
): { draft: PlanEditorDraft; original: PlanReplanOriginal } {
  const from = detail.sessions.find((s) => s.id === fromSessionId);
  const fromDay = from ? toARDateKey(from.scheduledFor) : today;
  const startDayKey = fromDay < today ? today : fromDay;
  const draft: PlanEditorDraft = {
    ...emptyDraft({ today, patientId: detail.patientId, discipline: detail.discipline }),
    serviceId: detail.serviceId,
    practitionerId: detail.practitionerId,
    locationId: detail.locationId,
    durationMin: detail.durationMin,
    schedule: detail.schedule ?? { ...EMPTY_SCHEDULE, slots: [] },
    startDayKey,
  };
  return {
    draft,
    original: {
      practitionerId: detail.practitionerId,
      serviceId: detail.serviceId,
      locationId: detail.locationId,
      durationMin: detail.durationMin,
    },
  };
}

// ─── Cambios con efectos encadenados ─────────────────────────────────────────

/**
 * Servicios que ofrece el selector para una disciplina (C13): los de esa
 * disciplina primero y después los sin disciplina. Los de la otra disciplina
 * no aparecen. `untagged` = hay servicios sin disciplina (muestra el hint).
 */
export function servicesForDiscipline(
  services: ReadonlyArray<PlanEditorService>,
  discipline: Discipline | null
): { options: PlanEditorService[]; untagged: boolean } {
  const untagged = services.filter((s) => s.discipline == null);
  if (!discipline) return { options: [...untagged], untagged: untagged.length > 0 };
  const tagged = services.filter((s) => s.discipline === discipline);
  return { options: [...tagged, ...untagged], untagged: untagged.length > 0 };
}

/** Cambiar la disciplina limpia un servicio de la OTRA disciplina (el motor lo rechazaría). */
export function withDiscipline(
  draft: PlanEditorDraft,
  discipline: Discipline,
  services: ReadonlyArray<PlanEditorService>
): PlanEditorDraft {
  const current = services.find((s) => s.id === draft.serviceId);
  const keep = !current || current.discipline == null || current.discipline === discipline;
  return { ...draft, discipline, serviceId: keep ? draft.serviceId : null };
}

/**
 * Cambiar el modo de precio. Al pasar a "Por sesión" sin monto, propone el
 * precio del servicio (el kinesiólogo casi siempre cobra eso); "Sin precio"
 * limpia el monto.
 */
export function withPriceMode(
  draft: PlanEditorDraft,
  mode: PlanPriceMode,
  services: ReadonlyArray<PlanEditorService>
): PlanEditorDraft {
  if (mode === "NONE") return { ...draft, priceMode: mode, priceCents: null };
  if (mode === draft.priceMode) return draft;
  const service = services.find((s) => s.id === draft.serviceId);
  const suggested =
    mode === "PER_SESSION" && service && service.priceCents > 0
      ? service.priceCents
      : mode === "PACKAGE" && draft.priceMode === "PER_SESSION" && draft.priceCents != null
        ? draft.priceCents * draft.totalSessions
        : draft.priceCents;
  return { ...draft, priceMode: mode, priceCents: suggested ?? null };
}

/** Título por defecto (D6, mismo texto que el motor): "Kinesiología · 10 sesiones". */
export function defaultPlanTitle(discipline: Discipline | null, totalSessions: number): string {
  if (!discipline) return `Plan · ${totalSessions} sesiones`;
  return `${disciplineLabel(discipline)} · ${totalSessions} sesiones`;
}

// ─── Validación y armado del input ───────────────────────────────────────────

export function draftPricing(draft: Pick<PlanEditorDraft, "priceMode" | "priceCents">): PlanPricingInput {
  if (draft.priceMode === "NONE" || draft.priceCents == null) return null;
  return draft.priceMode === "PER_SESSION"
    ? { mode: "PER_SESSION", pricePerSessionCents: draft.priceCents }
    : { mode: "PACKAGE", totalPriceCents: draft.priceCents };
}

function draftAuthorization(a: PlanAuthorizationDraft): PlanCreateInput["authorization"] {
  if (!a.enabled) return undefined;
  const code = a.code.trim();
  return {
    ...(code ? { code } : {}),
    ...(a.authorizedSessions != null ? { authorizedSessions: a.authorizedSessions } : {}),
    startsOnDayKey: a.startsOnDayKey,
    ...(a.expiresOnDayKey ? { expiresOnDayKey: a.expiresOnDayKey } : {}),
  };
}

const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);

/**
 * Validación de cliente, antes de pedir el preview. Espeja el zod del server
 * (`PlanCreateInputSchema`) solo para no gastar un viaje en un borrador
 * incompleto; el server sigue siendo la barrera (`fieldErrors`).
 */
export function validateDraft(
  draft: PlanEditorDraft,
  mode: "create" | "replan",
  opts: { requireExercises?: boolean } = {}
): PlanDraftErrors {
  const e: PlanDraftErrors = {};
  if (mode === "create") {
    if (!draft.patientId) e.patientId = PLAN_EDITOR_COPY.noPatient;
    if (!draft.discipline) e.discipline = PLAN_EDITOR_COPY.noDiscipline;
    if (!isInt(draft.totalSessions) || draft.totalSessions < 1 || draft.totalSessions > PLAN_MAX_SESSIONS) {
      e.totalSessions = PLAN_EDITOR_COPY.sessionsRange;
    }
    if (draft.priceMode !== "NONE" && draft.priceCents == null) e.pricing = PLAN_EDITOR_COPY.noPrice;
    const a = draft.authorization;
    if (a.enabled) {
      if (a.authorizedSessions != null && (!isInt(a.authorizedSessions) || a.authorizedSessions < 1 || a.authorizedSessions > 200)) {
        e.authorizedSessions = PLAN_EDITOR_COPY.authSessions;
      }
      if (!isDayKey(a.startsOnDayKey)) e.authStartsOn = PLAN_EDITOR_COPY.authStart;
      else if (a.expiresOnDayKey && (!isDayKey(a.expiresOnDayKey) || a.expiresOnDayKey < a.startsOnDayKey)) {
        e.authExpiresOn = PLAN_EDITOR_COPY.authExpiry;
      }
    }
    if (opts.requireExercises && !(draft.exercises && draft.exercises.length > 0)) e.exercises = PLAN_EDITOR_COPY.noExercises;
  }
  if (!draft.serviceId) e.serviceId = PLAN_EDITOR_COPY.noService;
  if (!draft.practitionerId) e.practitionerId = PLAN_EDITOR_COPY.noPractitioner;
  const sched = planScheduleError(draft.schedule);
  if (sched) e.schedule = sched;
  if (!isDayKey(draft.startDayKey)) e.startDayKey = PLAN_EDITOR_COPY.noStart;
  if (draft.durationMin != null && (!isInt(draft.durationMin) || draft.durationMin < PLAN_MIN_DURATION || draft.durationMin > PLAN_MAX_DURATION)) {
    e.durationMin = PLAN_EDITOR_COPY.durationRange;
  }
  return e;
}

export const hasDraftErrors = (e: PlanDraftErrors) => Object.keys(e).length > 0;

/**
 * Borrador → `PlanCreateInput` sin key/filas/token (lo que va al preview y,
 * TAL CUAL, al commit). Las claves vacías se OMITEN (no `undefined` ni ""):
 * el `stateToken` del motor es un hash del borrador parseado y el editor
 * tiene que mandar siempre la misma forma. Devuelve null si falta algo.
 */
export function draftToCreateBase(draft: PlanEditorDraft): PlanCreateBase | null {
  if (!draft.patientId || !draft.discipline || !draft.serviceId || !draft.practitionerId) return null;
  const title = draft.title.trim();
  const notes = draft.notes.trim();
  const authorization = draftAuthorization(draft.authorization);
  return {
    patientId: draft.patientId,
    discipline: draft.discipline,
    practitionerId: draft.practitionerId,
    serviceId: draft.serviceId,
    locationId: draft.locationId,
    ...(title ? { title } : {}),
    ...(notes ? { notes } : {}),
    ...(draft.durationMin != null ? { durationMin: draft.durationMin } : {}),
    schedule: draft.schedule,
    startDayKey: draft.startDayKey,
    totalSessions: draft.totalSessions,
    pricing: draftPricing(draft),
    ...(draft.templateId ? { templateId: draft.templateId } : {}),
    ...(draft.exercises && draft.exercises.length > 0 ? { exercises: draft.exercises.map((x) => ({ ...x })) } : {}),
    origin: { kind: draft.origin },
    ...(draft.fromBookingId
      ? { fromBookingId: draft.fromBookingId, ...(draft.countBookingAsSession1 ? { countBookingAsSession1: true } : {}) }
      : {}),
    ...(authorization ? { authorization } : {}),
  };
}

/**
 * Borrador → entrada de replan. Profesional, servicio, sede y duración se
 * mandan SOLO si cambiaron: "ausente = se mantiene" (P2-C2), y cambiarlos es
 * cancelar y recrear (el server lo valida todo).
 */
export function draftToReplanBase(
  draft: PlanEditorDraft,
  ids: { programId: string; fromSessionId: string },
  original: PlanReplanOriginal
): PlanReplanBase | null {
  if (!draft.serviceId || !draft.practitionerId) return null;
  return {
    programId: ids.programId,
    fromSessionId: ids.fromSessionId,
    schedule: draft.schedule,
    startDayKey: draft.startDayKey,
    ...(draft.practitionerId !== original.practitionerId ? { practitionerId: draft.practitionerId } : {}),
    ...(draft.serviceId !== original.serviceId ? { serviceId: draft.serviceId } : {}),
    ...(draft.locationId !== original.locationId ? { locationId: draft.locationId } : {}),
    ...(draft.durationMin !== original.durationMin ? { durationMin: draft.durationMin } : {}),
  };
}

/**
 * Primer mensaje por campo de los `fieldErrors` del server (zod flatten o
 * `PlanRejected.field`), con las claves del form.
 */
export function serverFieldErrors(fieldErrors: Record<string, string[] | undefined> | undefined): PlanDraftErrors {
  const out: PlanDraftErrors = {};
  if (!fieldErrors) return out;
  const map: Record<string, keyof PlanDraftErrors> = {
    patientId: "patientId",
    discipline: "discipline",
    serviceId: "serviceId",
    practitionerId: "practitionerId",
    schedule: "schedule",
    startDayKey: "startDayKey",
    totalSessions: "totalSessions",
    durationMin: "durationMin",
    pricing: "pricing",
    authorization: "authStartsOn",
    exercises: "exercises",
  };
  for (const [k, msgs] of Object.entries(fieldErrors)) {
    const key = map[k];
    if (key && msgs && msgs[0] && !out[key]) out[key] = msgs[0];
  }
  return out;
}

// ─── Claves canónicas: dirty y "el preview sigue valiendo" ───────────────────

/** JSON con claves ordenadas y sin `undefined` (dos objetos iguales → mismo texto). */
export function canonicalKey(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object" && !(v instanceof Date)) {
      const o = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o).sort()) if (o[k] !== undefined) out[k] = norm(o[k]);
      return out;
    }
    return v instanceof Date ? v.toISOString() : v;
  };
  return JSON.stringify(norm(value)) ?? "";
}

/** Dirty-guard: el borrador difiere del que se abrió (prefill incluido). */
export function isDraftDirty(baseline: PlanEditorDraft | null, draft: PlanEditorDraft): boolean {
  if (!baseline) return false;
  return canonicalKey(baseline) !== canonicalKey(draft);
}

/**
 * Clave del pedido de preview: borrador base + resoluciones elegidas. Si la
 * clave actual difiere de la del preview que se ve, ese preview está viejo
 * (no se puede commitear; el drawer re-previsualiza con debounce).
 */
export function previewRequestKey(base: unknown, resolutions: PlanResolutionsMap): string {
  const rows = Object.values(resolutions).sort((a, b) => a.index - b.index);
  return canonicalKey({ base, rows });
}

// ─── Resoluciones por fila ───────────────────────────────────────────────────

export type PlanResolutionsMap = Readonly<Record<number, PlanRowResolution>>;

/**
 * Resolución COMPLETA de una fila para un `kind` (lo que pide el zod del
 * server): `move` lleva el destino sugerido, `adopt` el turno y su
 * `updatedAt` tal como los mostró el preview, `force` las banderas que la
 * fila necesita. `null` = no se puede armar con lo que dio el preview (un
 * `move` sin sugerencia, un `adopt` sin duplicado): la UI no la ofrece.
 */
export function resolutionFor(row: PlanPreviewRow, kind: PlanResolutionKind, at?: string): PlanRowResolution | null {
  switch (kind) {
    case "create":
    case "none":
    case "mark-done":
      return { index: row.index, kind };
    case "move": {
      const dest = at ?? row.suggestion;
      return dest ? { index: row.index, kind, at: dest } : null;
    }
    case "adopt": {
      const d = row.flags.duplicate;
      return d && d.adoptable ? { index: row.index, kind, bookingId: d.bookingId, expectedUpdatedAt: d.updatedAt } : null;
    }
    case "force": {
      const f = row.flags;
      const force = {
        ...(f.capacityFull ? { capacity: true as const } : {}),
        ...(f.outOfHours ? { outOfHours: true as const } : {}),
        ...(f.patientOverlapIds.length > 0 ? { patientOverlap: true as const } : {}),
      };
      return Object.keys(force).length > 0 ? { index: row.index, kind, force } : null;
    }
  }
}

/** ¿La resolución elegida sigue siendo ofrecida por esta fila (mismo turno/destino válido)? */
export function resolutionStillValid(row: PlanPreviewRow, r: PlanRowResolution): boolean {
  if (!row.allowedResolutions.includes(r.kind)) return false;
  if (r.kind === "adopt") {
    const d = row.flags.duplicate;
    return !!d && d.adoptable && d.bookingId === r.bookingId && d.updatedAt === r.expectedUpdatedAt;
  }
  if (r.kind === "force") {
    const fresh = resolutionFor(row, "force");
    return !!fresh && canonicalKey(fresh.force) === canonicalKey(r.force);
  }
  return true;
}

/**
 * Resoluciones del commit: por cada fila, la elegida (si sigue valiendo) o la
 * POR DEFECTO materializada. Mandarlas todas evita el stale del motor por
 * "resolución faltante" en filas que no son "libre → crear" (`isRowStale`):
 * el usuario vio la tabla con esa resolución y apretó confirmar.
 */
export function commitResolutions(preview: PlanPreview, chosen: PlanResolutionsMap): PlanRowResolution[] {
  const out: PlanRowResolution[] = [];
  for (const row of preview.rows) {
    const picked = chosen[row.index];
    if (picked && resolutionStillValid(row, picked)) {
      out.push(picked);
      continue;
    }
    const def = resolutionFor(row, row.defaultResolution);
    if (def) out.push(def);
  }
  return out;
}

/** Las elegidas que vale la pena mandar al RE-preview (el fold del motor las usa). */
export function chosenRows(chosen: PlanResolutionsMap): PlanRowResolution[] {
  return Object.values(chosen).sort((a, b) => a.index - b.index);
}

function rowSignature(r: PlanPreviewRow): string {
  return canonicalKey({
    at: r.at,
    flags: r.flags,
    suggestion: r.suggestion ?? null,
    def: r.defaultResolution,
    allowed: [...r.allowedResolutions].sort(),
  });
}

/**
 * Después de un `stale-preview` (la agenda cambió entre el preview y el
 * commit): conserva las resoluciones elegidas que el preview nuevo sigue
 * ofreciendo y marca las filas que cambiaron (o perdieron su resolución) para
 * el banner C13 de la tabla. Sin preview anterior, se marcan todas las filas
 * que no son "libre → crear".
 */
export function reconcileStalePreview(
  previous: PlanPreview | null,
  next: PlanPreview,
  chosen: PlanResolutionsMap
): { resolutions: Record<number, PlanRowResolution>; staleIndexes: Set<number> } {
  const prevByIndex = new Map((previous?.rows ?? []).map((r) => [r.index, r]));
  const resolutions: Record<number, PlanRowResolution> = {};
  const staleIndexes = new Set<number>();
  for (const row of next.rows) {
    const picked = chosen[row.index];
    if (picked) {
      if (resolutionStillValid(row, picked)) resolutions[row.index] = picked;
      else staleIndexes.add(row.index);
    }
    const prev = prevByIndex.get(row.index);
    if (prev ? rowSignature(prev) !== rowSignature(row) : row.defaultResolution !== "create") staleIndexes.add(row.index);
  }
  return { resolutions, staleIndexes };
}

/**
 * Marcas de stale después de un re-preview forzado (`stale-preview` del commit
 * o `stale` del CAS en generar): como `reconcileStalePreview`, pero si ninguna
 * fila cambió a la vista se marcan TODAS, porque el banner C13 tiene que salir
 * igual (P3.Z: en generar, el `stale` hacía `setFormError` + re-preview y el
 * re-preview borraba el aviso al volver).
 */
export function staleAfterRepreview(
  previous: PlanPreview | null,
  next: PlanPreview,
  chosen: PlanResolutionsMap
): { resolutions: Record<number, PlanRowResolution>; staleIndexes: Set<number> } {
  const r = reconcileStalePreview(previous, next, chosen);
  return { resolutions: r.resolutions, staleIndexes: r.staleIndexes.size > 0 ? r.staleIndexes : new Set(next.rows.map((x) => x.index)) };
}

/** Saca de las elegidas las que el preview ya no ofrece (re-preview por cambio de resoluciones). */
export function pruneResolutions(preview: PlanPreview, chosen: PlanResolutionsMap): Record<number, PlanRowResolution> {
  const byIndex = new Map(preview.rows.map((r) => [r.index, r]));
  const out: Record<number, PlanRowResolution> = {};
  for (const r of Object.values(chosen)) {
    const row = byIndex.get(r.index);
    if (row && resolutionStillValid(row, r)) out[r.index] = r;
  }
  return out;
}

// ─── Copy del pie y avisos ───────────────────────────────────────────────────

const turnos = (n: number) => `${n} ${n === 1 ? "turno" : "turnos"}`;

/**
 * Botón de confirmar (C13: "Crear plan y 9 turnos"). `summary.bookings` =
 * turnos NUEVOS (crear + mover + forzar).
 */
export function commitLabel(mode: "create" | "generate" | "replan", summary: Pick<PlanPreviewSummary, "bookings"> | null): string {
  const n = summary?.bookings ?? 0;
  if (mode === "generate") return n > 0 ? `Crear ${turnos(n)}` : "Confirmar";
  if (mode === "replan") return n > 0 ? `Guardar y crear ${turnos(n)}` : "Guardar cambios";
  return n > 0 ? `Crear plan y ${turnos(n)}` : "Crear plan";
}

// ─── Secuencia de previews (debounce + "gana el último") ─────────────────────

/**
 * Cada pedido de preview toma un número; solo la respuesta del ÚLTIMO pedido
 * se aplica. Sin esto, un preview lento de un borrador viejo pisaba al nuevo
 * (el usuario cambia el horario dos veces rápido y la tabla queda con el
 * primero, y el commit iría con el `stateToken` equivocado).
 */
export function createPreviewSequencer() {
  let seq = 0;
  return {
    next: () => ++seq,
    isLatest: (n: number) => n === seq,
    /** Invalida lo que esté en vuelo (cerrar el drawer, cambiar de modo). */
    cancel: () => {
      seq++;
    },
  };
}

/**
 * Un pedido de preview con la secuencia y SIN dejar el editor trabado (P3.Z):
 * antes, si la action tiraba (red caída, timeout del server action), nadie
 * apagaba `previewing` y el editor quedaba en "Buscando turnos…" para
 * siempre. Solo el último pedido toca el estado (`result`/`error`/`done`).
 * Es el mismo patrón que `useAddSessionsFlow` (`plan-edit-dialogs.tsx`).
 */
export async function runSequencedPreview<T>(
  sequencer: ReturnType<typeof createPreviewSequencer>,
  call: () => Promise<T>,
  on: { start: () => void; result: (r: T) => void; error: () => void; done: () => void }
): Promise<void> {
  const seq = sequencer.next();
  on.start();
  try {
    const r = await call();
    if (sequencer.isLatest(seq)) on.result(r);
  } catch {
    if (sequencer.isLatest(seq)) on.error();
  } finally {
    if (sequencer.isLatest(seq)) on.done();
  }
}

/** Debounce del re-preview automático (ms). */
export const PREVIEW_DEBOUNCE_MS = 500;

