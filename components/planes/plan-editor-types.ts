/**
 * Contratos de UI de Planes (P3-C, ES3): props congeladas del editor único y
 * de las superficies que lo abren. Las sesiones de P3.1/P3.2 **implementan**
 * contra esto y solo AGREGAN (props opcionales); no cambian lo publicado.
 *
 * Fuente de los tipos de datos: los del server, RE-EXPORTADOS (nada se
 * redefine acá; si el server cambia un DTO, el editor no compila contra una
 * copia vieja):
 *   - motor (C7): `lib/plans-types.ts` → `PlanCreateInput`, `PlanPreview`, …;
 *   - lecturas (S14): `lib/plans-read-types.ts` → `PlanDTO`, `PlanSessionDTO`, …;
 *   - escrituras (P2-C2): `lib/plans-edit-types.ts` → `PlanWriteResult`, …;
 *   - Diagnóstico (S17d): `lib/diagnosis-types.ts`;
 *   - deep-link (C10): `lib/plans-deeplink.ts` → `PlanEditorPrefill`.
 *
 * Solo tipos y dos helpers puros (`planUiPermissions`, `planEditTargetOf`,
 * `heroPlanChips`): sin React, sin actions.
 */
import type { Role } from "@prisma/client";
import type { Capability, PatientAccessLevel } from "@/lib/capabilities";
import { canRestoreProgram } from "@/lib/plans-lifecycle-state";
import type { Discipline } from "@/lib/plans-constants";
import type { PlanEditorPrefill } from "@/lib/plans-deeplink";
import type {
  CreatePlanResult,
  PlanCreateInput,
  PlanPreview,
  PlanPricingInput,
  PlanResolutionKind,
  PlanRowResolution,
  PlanScheduleV1,
} from "@/lib/plans-types";
import type {
  PlanAuthorizationDTO,
  PlanDTO,
  PlanDetailDTO,
  PlanHeaderDTO,
  PlanPricingModeValue,
  PlanSessionDTO,
  ProgramStatusValue,
} from "@/lib/plans-read-types";
import type { CaseSelection, DiagnosisPlanPrefill } from "@/lib/diagnosis-types";
import type { InsurerOption, PatientWithRelations, PractitionerOption } from "@/components/patients/profile/types";

export type {
  CreatePlanResult,
  PlanAuthorizationDTO,
  PlanCreateInput,
  PlanDTO,
  PlanDetailDTO,
  PlanEditorPrefill,
  PlanPreview,
  PlanPricingInput,
  PlanResolutionKind,
  PlanRowResolution,
  PlanScheduleV1,
  PlanSessionDTO,
};
export type {
  PlanEngineWriteResult,
  PlanPreviewResult,
  PlanWriteResult,
  PackageCountPricing,
  RepricePlanPreview,
} from "@/lib/plans-edit-types";

// ─── Permisos de la UI ───────────────────────────────────────────────────────

/**
 * Qué controles de Planes se MUESTRAN. La barrera real es el server
 * (`assertPlan*InTx` de `lib/plan-authz-internal.ts`): esto solo evita botones
 * que van a rebotar. Falla cerrado.
 */
export type PlanPermissions = {
  /** Crear, editar, ciclo de vida, cantidad, precio, sesión a medida, archivar/restaurar sesión, vincular/sacar del plan. */
  manage: boolean;
  /** Agendar sesiones "sin turno", generar turnos, mover "este y los siguientes" (la Secretaria sí). */
  schedule: boolean;
  /** Renovar la autorización de la OS. */
  authorize: boolean;
  /** Restaurar un plan archivado (OWNER/ADMIN, `canRestoreProgram`). */
  restore: boolean;
  /** Plantillas (módulo `plantillas` / `gatingForActor().canBuildTemplates`). */
  templates: boolean;
};

export const NO_PLAN_PERMISSIONS: PlanPermissions = Object.freeze({
  manage: false,
  schedule: false,
  authorize: false,
  restore: false,
  templates: false,
});

/**
 * Espejo de `accessAllows` de `lib/plan-authz-internal.ts` (server-only, no se
 * puede importar en el cliente) para el acceso del actor AL PACIENTE:
 *   - manage = `plans.manage` + acceso full + `clinical.read` (nunca la Secretaria ni BILLING);
 *   - schedule / authorize = su capability + (full || `agenda.operateAll`).
 * Sin el módulo `planes` (consultorio General) todo en `false`.
 */
export function planUiPermissions(input: {
  caps: ReadonlySet<Capability>;
  access: PatientAccessLevel;
  role: Role | null | undefined;
  plansModule: boolean;
  templatesModule: boolean;
}): PlanPermissions {
  const { caps, access, role, plansModule, templatesModule } = input;
  if (!plansModule || access === "none") return NO_PLAN_PERMISSIONS;
  const operable = access === "full" || caps.has("agenda.operateAll");
  const manage = caps.has("plans.manage") && access === "full" && caps.has("clinical.read");
  return {
    manage,
    schedule: caps.has("plans.schedule") && operable,
    authorize: caps.has("plans.authorize") && operable,
    restore: manage && canRestoreProgram(role),
    templates: manage && templatesModule,
  };
}

// ─── Editor único (C10) ──────────────────────────────────────────────────────

export type PlanEditorMode = "create" | "generate" | "replan";

/** Lo que devuelve el editor al guardar (C10 `onSaved({programId, patientId})`). */
export type PlanEditorSaved = { programId: string; patientId: string };

/**
 * Puerta Diagnóstico (S23): el caso clínico que `createPlanFromDiagnosis`
 * persiste junto con el plan. `prefill` = lo de `getDiagnosisPlanPrefill` si
 * el caller ya lo tiene; sin él, el editor lo pide con `conditionSlug` +
 * `exerciseIds`.
 */
export type PlanEditorDiagnosis = {
  conditionSlug: string;
  selection: CaseSelection;
  exerciseIds?: string[];
  prefill?: DiagnosisPlanPrefill;
};

/**
 * C10 (literal): `{open, onClose, onSaved({programId, patientId}), patientId?,
 * programId?, mode:'create'|'generate'|'replan', prefill?: PlanEditorPrefill,
 * fromBookingId?, templateId?, diagnosis?, discipline?, generateForSessionIds?,
 * replanFromSessionId?}`. Cantidad y precio NO van en el editor (diálogos de
 * S22e, `plan-edit-dialogs.tsx`).
 *
 * - `create`: alta (`previewPlan` → `createPlan`, o `createPlanFromDiagnosis`
 *   con `diagnosis`). Sin `patientId`, el editor pide paciente
 *   (`PatientPicker requireFull`).
 * - `generate`: turnos para sesiones "sin turno" del plan `programId`
 *   (`previewGeneratePlanBookings` → `generatePlanBookings`);
 *   `generateForSessionIds` vacío/ausente = todas las pendientes.
 * - `replan`: "Editar desde la sesión N" (`previewReplanPlan` → `replanPlan`)
 *   con `replanFromSessionId`.
 */
export type PlanEditorDrawerProps = {
  open: boolean;
  onClose: () => void;
  onSaved: (saved: PlanEditorSaved) => void;
  /** Permisos del actor sobre el paciente (S18): oculta el bloque de la
   *  autorización de la OS sin `authorize`. Opcional para no romper callers. */
  permissions?: PlanPermissions;
  patientId?: string;
  programId?: string;
  mode: PlanEditorMode;
  prefill?: PlanEditorPrefill;
  fromBookingId?: string;
  templateId?: string;
  diagnosis?: PlanEditorDiagnosis;
  discipline?: Discipline;
  generateForSessionIds?: string[];
  replanFromSessionId?: string;
};

/**
 * Pedido de apertura del editor desde una superficie (PlanCard, Sesiones,
 * Resumen, hero, drawer…): el editor lo monta UNA vez el shell (lazy,
 * `next/dynamic`) y las superficies solo piden abrirlo.
 */
export type PlanEditorRequest = Omit<PlanEditorDrawerProps, "open" | "onClose" | "onSaved">;

// ─── Horario (S18s) ──────────────────────────────────────────────────────────

/** C6: `dow` 0=Dom … 6=Sáb (como `PractitionerSchedule`), `startMin` minutos AR. */
export type ScheduleSlotsEditorProps = {
  value: PlanScheduleV1;
  onChange: (next: PlanScheduleV1) => void;
  disabled?: boolean;
  /** Error a mostrar debajo (`planScheduleError` o `fieldErrors.schedule` del server). */
  error?: string | null;
  /** Prefijo de ids para `label`/`aria-*` (dos editores en pantalla no chocan). */
  idPrefix?: string;
};

// ─── "Revisá los turnos" (S18p) ──────────────────────────────────────────────

/** Resolución elegida por fila (`PlanRowResolution.index` → resolución). */
export type PlanResolutionsByIndex = Readonly<Record<number, PlanRowResolution>>;

/**
 * Tabla C13 `# · lun 06/10 · 09:00 · Estado · Resolución` + resumen. La tabla
 * no llama actions: el editor hace el preview/commit y le pasa el resultado.
 */
export type PlanPreviewTableProps = {
  preview: PlanPreview;
  /** Las elegidas por el usuario; las que faltan muestran `defaultResolution`. */
  resolutions: PlanResolutionsByIndex;
  onResolutionChange: (resolution: PlanRowResolution) => void;
  /**
   * Filas marcadas después de un `stale-preview` (banner C13 "La agenda cambió
   * mientras armabas el plan…"). `null`/ausente = sin banner.
   */
  staleIndexes?: ReadonlySet<number> | null;
  /** Para el resumen "lun y jue 09:00" y "Paquete $120.000" (null = sin horario/legacy). */
  schedule: PlanScheduleV1 | null;
  pricing: PlanPricingInput;
  disabled?: boolean;
  /**
   * Ordinal (M13) que muestran la columna "#" y el aria de cada fila. Ausente
   * o `null` = `row.index` (el alta: ahí index = ordinal). Generar, re-planificar
   * y agregar lo pasan (`planPreviewOrdinalOf`): con una sesión archivada el
   * `index` fijo no coincide con lo que cuenta la card (P3.Z F2).
   */
  ordinalOf?: (row: PlanPreview["rows"][number]) => number | null;
};

// ─── Tab Planes (S22a) y vistas del perfil (S22h) ────────────────────────────

/**
 * `plan-view.tsx` (S22a). El shell (S22b) carga `getPatientPlans` (+ saldos
 * en `PlanDTO.balance`) y monta el editor; la vista pinta las PlanCard.
 * Lo que el DTO no trae no se muestra (título null sin `clinical.read`;
 * `authorization` ausente = el actor no la puede ver, E2).
 */
export type PlanViewProps = {
  patientId: string;
  plans: PlanDTO[];
  permissions: PlanPermissions;
  /** `?tab=planes&programa=<id>`: card en foco (scroll + abierta). */
  focusProgramId?: string | null;
  loading?: boolean;
  error?: string | null;
  onOpenEditor: (req: PlanEditorRequest) => void;
  /** Después de cualquier escritura: el shell recarga planes y saldos. */
  onChanged: () => void;
  /** Ver archivados (para restaurar): el shell recarga con `includeArchived`. */
  showArchived?: boolean;
  onShowArchivedChange?: (show: boolean) => void;
  /**
   * El paciente tiene obra social (P3.Z): la PlanCard muestra "Obra social:
   * Sin autorización vigente" solo con cobertura. Ausente = no se muestra la
   * línea vacía (una autorización vigente se muestra siempre).
   */
  insured?: boolean;
};

/** Chip del hero: un plan vivo (ACTIVE/PAUSED, no archivado). Sin título (PHI). */
export type HeroPlanChip = {
  programId: string;
  discipline: Discipline | null;
  status: "ACTIVE" | "PAUSED";
  done: number;
  totalLive: number;
};

/** Planes → chips del hero: ACTIVE antes que PAUSED, después por `updatedAt` desc. */
export function heroPlanChips(
  plans: readonly Pick<PlanHeaderDTO, "id" | "discipline" | "status" | "archivedAt" | "done" | "totalLive" | "updatedAt">[]
): HeroPlanChip[] {
  const rank = (s: ProgramStatusValue) => (s === "ACTIVE" ? 0 : 1);
  return plans
    .filter((p) => p.archivedAt == null && (p.status === "ACTIVE" || p.status === "PAUSED"))
    .sort((a, b) => rank(a.status) - rank(b.status) || +new Date(b.updatedAt) - +new Date(a.updatedAt))
    .map((p) => ({
      programId: p.id,
      discipline: p.discipline,
      status: p.status as "ACTIVE" | "PAUSED",
      done: p.done,
      totalLive: p.totalLive,
    }));
}

/**
 * `PatientHero` (S22h). Reemplaza `plan: HeroPlanState` por `plans` (chips
 * por disciplina; el plan de la obra social sigue aparte, en `coverageLabel`).
 */
export type PatientHeroProps = {
  patient: PatientWithRelations;
  age: number | null;
  coverageLabel: string;
  /** `heroPlanChips(plans)`; `[]` = sin plan vivo. */
  plans: HeroPlanChip[];
  insurers: InsurerOption[];
  practitioners: PractitionerOption[];
  canReassign: boolean;
  /** Módulo `planes`: sin él no hay chips ni la pregunta L9 al archivar el paciente. */
  plansEnabled: boolean;
  /** Click en un chip → Tab Planes con ese plan en foco. */
  onOpenPlan?: (programId: string) => void;
};

/** `SesionesView` (S22h): sesiones por plan con "Sesión n de N" (ordinal, nunca `index`). */
export type SesionesViewProps = {
  patient: PatientWithRelations;
  plans: PlanDTO[];
  permissions: PlanPermissions;
  onOpenEditor: (req: PlanEditorRequest) => void;
  onOpenPlan?: (programId: string) => void;
};

/** `ResumenView` (S22h). `plan` = el plan en foco (el ACTIVE más reciente o, si no hay, el último). */
export type ResumenViewProps = {
  patient: PatientWithRelations;
  plan: PlanDTO | null;
  otherActiveCount?: number;
  diagnosisName: string | null;
  permissions: PlanPermissions;
  onOpenEditor: (req: PlanEditorRequest) => void;
  onOpenPlan?: (programId: string) => void;
};

// ─── Edición del plan (S22e): diálogos y acciones por sesión ─────────────────

/**
 * Lo que necesitan los diálogos de edición de un plan. `updatedAt` ISO = el
 * `expectedUpdatedAt` (CAS) de las escrituras sin motor; las del motor van
 * con `stateToken` del preview (P2-C2 D3).
 */
export type PlanEditTarget = {
  programId: string;
  patientId: string;
  updatedAt: string;
  status: ProgramStatusValue;
  discipline: Discipline | null;
  pricingMode: PlanPricingModeValue | null;
  totalLive: number;
  done: number;
};

export function planEditTargetOf(
  plan: Pick<PlanDTO, "id" | "patientId" | "updatedAt" | "status" | "discipline" | "pricingMode" | "totalLive" | "done">
): PlanEditTarget {
  return {
    programId: plan.id,
    patientId: plan.patientId,
    updatedAt: new Date(plan.updatedAt).toISOString(),
    status: plan.status,
    discipline: plan.discipline,
    pricingMode: plan.pricingMode,
    totalLive: plan.totalLive,
    done: plan.done,
  };
}

/** Éxito de una edición: `notice` del server (toast), si vino. */
export type PlanEditDone = { notice?: string };

/**
 * Base de los diálogos. Cada diálogo llama sus actions: `stale` → copy de
 * `PLAN_LIFECYCLE_COPY.stale` + `onStale()` (el caller recarga);
 * `stale-preview` → re-preview con el copy de C13; `needs-confirmation` →
 * `useConfirm` y reenvío.
 */
export type PlanDialogBaseProps = {
  open: boolean;
  onClose: () => void;
  onChanged: (done: PlanEditDone) => void;
  onStale?: () => void;
};

/** Cantidad: agregar al final (`addPlanSessions` append, por el motor) o reducir (`archivePlanSessions` con `totalSessions`); en PACKAGE pregunta "¿Mantenemos el total o el precio por sesión?". */
export type PlanCountDialogProps = PlanDialogBaseProps & { plan: PlanEditTarget };

/** Precio: `previewRepricePlan` → copy C13 "Cambiar precio: de $X a $Y en N turnos · M quedan como están" → `repricePlan`. */
export type PlanPriceDialogProps = PlanDialogBaseProps & { plan: PlanEditTarget };

/** Sesión a medida: `addPlanSessions` kind `custom` (título y fecha opcionales; sin fecha queda "sin turno"). */
export type CustomSessionDialogProps = PlanDialogBaseProps & { plan: PlanEditTarget };

/**
 * Renovar la autorización de la OS (`renewPlanAuthorization`, gate
 * `plans.authorize`; también la Secretaria, desde el drawer S19c).
 * `current` = la vigente que se muestra (su id es el `expectedCurrentId`;
 * `null` = no hay vigente). **Ausente** = el diálogo la carga
 * (`getPatientPlans({patientId})`), porque el drawer no la tiene: la
 * autorización nunca viaja en C9 (E2).
 */
export type RenewAuthorizationDialogProps = PlanDialogBaseProps & {
  programId: string;
  patientId: string;
  current?: PlanAuthorizationDTO | null;
};

/**
 * Acciones de UNA sesión en la PlanCard (S22a la monta, S22e la implementa):
 *   - "Agendar" (`sinTurno`, `permissions.schedule`) → editor `generate` con `[sessionId]`;
 *   - "Editar desde la sesión N" (`manage`) → editor `replan`;
 *   - "Archivar sesión" (`archivePlanSessions` con `sessionIds`, `useConfirm`) y
 *     "Restaurar" (`restoreSession`) (`manage`).
 * Sin permisos no renderiza nada.
 */
export type PlanSessionActionsProps = {
  plan: PlanEditTarget;
  session: Pick<PlanSessionDTO, "id" | "ordinal" | "state" | "sinTurno" | "archivedAt" | "booking">;
  permissions: PlanPermissions;
  onOpenEditor: (req: PlanEditorRequest) => void;
  onChanged: (done: PlanEditDone) => void;
  onStale?: () => void;
};

/** "Generar turnos para pendientes" (`permissions.schedule`, plan ACTIVE, `pendingCount > 1`, decisión S22h) → editor `generate`. */
export type GeneratePendingButtonProps = {
  plan: PlanEditTarget;
  /** `PlanDTO.sinTurno`. */
  pendingCount: number;
  permissions: PlanPermissions;
  onOpenEditor: (req: PlanEditorRequest) => void;
};
