"use client";

/**
 * Editor único de planes (S18, ES3 P3.1 · C10/C13). Lo monta UNA vez el shell
 * del perfil (S22b) y lo abren las superficies con un `PlanEditorRequest`.
 *
 * Flujo (mismo para los tres modos, cambian las actions):
 *   borrador (PlanForm) → "Ver turnos" = preview del motor → tabla "Revisá los
 *   turnos" (PlanPreviewTable, S18p) con una resolución por fila → confirmar =
 *   commit con el `stateToken` del preview.
 *     - create:   previewPlan → createPlan (o createPlanFromDiagnosis con `diagnosis`)
 *     - generate: previewGeneratePlanBookings → generatePlanBookings (sin form)
 *     - replan:   previewReplanPlan → replanPlan
 *
 * Decisiones que importan (el porqué):
 *   - El commit manda EXACTAMENTE el borrador (`previewBase`) que se
 *     previsualizó: el `stateToken` del motor es un hash del borrador y un
 *     re-armado con una diferencia mínima ("" vs ausente) daba `stale-preview`
 *     en cada intento.
 *   - Si el borrador o las resoluciones cambian después del preview, ese
 *     preview queda viejo: no se puede confirmar y se re-pide solo, con
 *     debounce y secuencia (gana la última respuesta; una respuesta lenta de
 *     un borrador anterior no pisa la tabla).
 *   - `stale-preview` en el commit: se muestra el preview nuevo con las filas
 *     que cambiaron marcadas y el copy C13; el usuario vuelve a confirmar.
 *   - `idempotencyKey` = UUID por instancia (cada apertura): un doble click o
 *     un reintento después de un timeout no crea dos planes.
 *   - Opciones (servicios, profesionales, sedes) se cargan al abrir con las
 *     actions existentes: las props del editor están congeladas (C10) y no
 *     las traen.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Drawer } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { PlanForm } from "@/components/planes/plan-form";
import {
  PlanPreviewTable,
  planPreviewOrdinalOf,
  previewTableCounts,
  type PreviewOrdinalSession,
} from "@/components/planes/plan-preview-table";
import type { PlanEditorDrawerProps, PlanPermissions } from "@/components/planes/plan-editor-types";
import { listPractitioners, listServices } from "@/lib/bookings";
import { listLocations } from "@/lib/locations";
import { createPlan, previewPlan } from "@/lib/plans";
import { previewReplanPlan, replanPlan } from "@/lib/plans-move";
import { generatePlanBookings, previewGeneratePlanBookings } from "@/lib/plans-adopt";
import { getPatientPlans, getPlanDetail } from "@/lib/plans-read";
import { createPlanFromDiagnosis, getDiagnosisPlanPrefill } from "@/lib/diagnosis";
import type { DiagnosisPlanPrefill } from "@/lib/diagnosis-types";
import { getTemplatePrefill } from "@/lib/plan-templates";
import type { Discipline } from "@/lib/plans-constants";
import type { PlanPreview, PlanRowResolution } from "@/lib/plans-types";
import {
  PLAN_EDITOR_COPY,
  PREVIEW_DEBOUNCE_MS,
  applyDiagnosisPrefill,
  applyPrefill,
  applyTemplatePrefill,
  chosenRows,
  commitLabel,
  commitResolutions,
  createPreviewSequencer,
  diagnosisRampNote,
  draftFromPlanDetail,
  draftToCreateBase,
  draftToReplanBase,
  emptyDraft,
  hasDraftErrors,
  isDraftDirty,
  planEditorToday,
  previewRequestKey,
  pruneResolutions,
  runSequencedPreview,
  serverFieldErrors,
  staleAfterRepreview,
  validateDraft,
  type PlanCreateBase,
  type PlanDraftErrors,
  type PlanEditorDraft,
  type PlanEditorOptions,
  type PlanReplanBase,
  type PlanReplanOriginal,
} from "@/lib/plan-editor-state";

/**
 * Props del editor: las congeladas de C10 + `permissions` opcional (handoff
 * a `plan-editor-types.ts`). Sin `permissions`, el bloque de la autorización
 * de la OS se muestra: quien puede crear (`plans.manage`, acceso full) tiene
 * `plans.authorize` en la matriz E1, y el server rechaza igual.
 */
export type PlanEditorDrawerOwnProps = PlanEditorDrawerProps & { permissions?: PlanPermissions };

/** Ancho del drawer (C13/S18: 600 px). */
export const PLAN_EDITOR_WIDTH = 600;

export function planEditorTitle(mode: PlanEditorDrawerProps["mode"]): string {
  return mode === "generate" ? PLAN_EDITOR_COPY.titleGenerate : mode === "replan" ? PLAN_EDITOR_COPY.titleReplan : PLAN_EDITOR_COPY.titleCreate;
}

/** Cada apertura es una instancia nueva (estado limpio, idempotencyKey nueva). */
export function PlanEditorDrawer(props: PlanEditorDrawerOwnProps) {
  const [instance, setInstance] = useState(0);
  const wasOpen = useRef(props.open);
  useEffect(() => {
    if (props.open && !wasOpen.current) setInstance((i) => i + 1);
    wasOpen.current = props.open;
  }, [props.open]);
  return <PlanEditorInstance key={instance} {...props} />;
}

type GenerateBase = { programId: string; sessionIds?: string[] };
type AnyBase = PlanCreateBase | PlanReplanBase | GenerateBase;

type Loaded = {
  options: PlanEditorOptions;
  draft: PlanEditorDraft;
  replanOriginal: PlanReplanOriginal | null;
  patientId: string | null;
  exercisesNote: string | null;
  /**
   * Ejercicios del Diagnóstico con su fase (S23 H3): la rampa "Sesiones 1-3 ·
   * Activación · 2 ejercicios" se recalcula con el borrador (cantidad y
   * ejercicios que siguen). null = no viene de Diagnóstico.
   */
  diagnosis: { conditionName: string; exercises: DiagnosisPlanPrefill["exercises"] } | null;
  /**
   * Sesiones del plan para el ordinal (M13) de la tabla en generar/re-planificar
   * (P3.Z F2). null = no se pudo cargar: la tabla cae a `row.index`.
   */
  ordinalSessions: PreviewOrdinalSession[] | null;
};

const EMPTY_OPTIONS: PlanEditorOptions = { services: [], practitioners: [], locations: [] };

function newKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // Navegadores viejos sin randomUUID: suficiente como clave de idempotencia (8..64, sin prefijo reservado).
  return `ed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

async function loadOptions(): Promise<PlanEditorOptions> {
  const [services, practitioners, locations] = await Promise.all([
    listServices().catch(() => []),
    listPractitioners().catch(() => []),
    // `agenda.viewAll`: quien crea planes la tiene; si no, "según la agenda" alcanza.
    listLocations().catch(() => []),
  ]);
  return {
    services: services.map((s) => ({
      id: s.id,
      name: s.name,
      discipline: (s.discipline ?? null) as Discipline | null,
      durationMin: s.durationMin,
      priceCents: s.priceCents,
    })),
    practitioners: practitioners.map((p) => ({ id: p.id, name: p.user.fullName || p.user.email })),
    locations: locations.map((l) => ({ id: l.id, name: l.name, isPrimary: l.isPrimary })),
  };
}

function PlanEditorInstance(props: PlanEditorDrawerOwnProps) {
  const { open, onClose, onSaved, mode, programId, diagnosis } = props;
  const toast = useToast();
  const [idempotencyKey] = useState(newKey);
  const sequencer = useRef(createPreviewSequencer());

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<PlanEditorDraft | null>(null);
  const [baseline, setBaseline] = useState<PlanEditorDraft | null>(null);

  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [previewBase, setPreviewBase] = useState<AnyBase | null>(null);
  const [resolutions, setResolutions] = useState<Record<number, PlanRowResolution>>({});
  const [staleIndexes, setStaleIndexes] = useState<Set<number> | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<PlanDraftErrors>({});

  // ── Carga inicial ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    let alive = true;
    (async () => {
      try {
        const today = planEditorToday();
        if (mode === "generate") {
          if (!programId) throw new Error("Falta el plan.");
          const blank = emptyDraft({ today });
          // Ordinales (M13) para la tabla: la Secretaria no tiene `getPlanDetail`,
          // pero sí `getPatientPlans` (trae `sessions` con id/fecha/archivada).
          // Es cosmético: si falla, la tabla muestra el `index`.
          let ordinalSessions: PreviewOrdinalSession[] | null = null;
          if (props.patientId) {
            try {
              const r = await getPatientPlans({ patientId: props.patientId });
              const plan = r.ok ? r.data.find((p) => p.id === programId) : undefined;
              if (plan) ordinalSessions = plan.sessions;
            } catch {
              ordinalSessions = null;
            }
          }
          if (alive)
            setLoaded({
              options: EMPTY_OPTIONS,
              draft: blank,
              replanOriginal: null,
              patientId: props.patientId ?? null,
              exercisesNote: null,
              diagnosis: null,
              ordinalSessions,
            });
          return;
        }
        const options = await loadOptions();
        if (mode === "replan") {
          if (!programId) throw new Error("Falta el plan.");
          const r = await getPlanDetail({ programId });
          if (!r.ok) throw new Error(r.error);
          const { draft: d, original } = draftFromPlanDetail(r.data, props.replanFromSessionId, today);
          if (alive)
            setLoaded({
              options,
              draft: d,
              replanOriginal: original,
              patientId: r.data.patientId,
              exercisesNote: null,
              diagnosis: null,
              ordinalSessions: r.data.sessions,
            });
          return;
        }
        let d = emptyDraft({ today, patientId: props.patientId ?? null, discipline: props.discipline ?? null, practitioners: options.practitioners });
        let exercisesNote: string | null = null;
        let diagnosisInfo: Loaded["diagnosis"] = null;
        if (props.templateId) {
          const t = await getTemplatePrefill(props.templateId);
          if (!t.ok) throw new Error(t.error);
          d = applyTemplatePrefill(d, t.data);
          const n = t.data.droppedExercises;
          if (n > 0) {
            toast.warning(
              n === 1
                ? "La plantilla tenía 1 ejercicio que ya no está disponible"
                : `La plantilla tenía ${n} ejercicios que ya no están disponibles`
            );
          }
          if (t.data.serviceDropped) toast.warning("El servicio de la plantilla ya no está disponible: elegí otro.");
        }
        d = applyPrefill(d, props.prefill);
        if (diagnosis) {
          const dp =
            diagnosis.prefill ??
            (await (async () => {
              const r = await getDiagnosisPlanPrefill({ conditionSlug: diagnosis.conditionSlug, exerciseIds: diagnosis.exerciseIds });
              if (!r.ok) throw new Error(r.error);
              return r.data;
            })());
          d = applyDiagnosisPrefill(d, dp);
          exercisesNote = `${dp.exercises.length} ${dp.exercises.length === 1 ? "ejercicio" : "ejercicios"} de ${dp.conditionName}, con la progresión del diagnóstico.`;
          diagnosisInfo = { conditionName: dp.conditionName, exercises: dp.exercises };
        }
        if (props.fromBookingId) d = applyPrefill(d, { fromBookingId: props.fromBookingId });
        if (alive)
          setLoaded({
            options,
            draft: d,
            replanOriginal: null,
            patientId: props.patientId ?? null,
            exercisesNote,
            diagnosis: diagnosisInfo,
            ordinalSessions: null,
          });
      } catch (e) {
        if (alive) setLoadError(e instanceof Error && e.message ? e.message : "No pudimos abrir el editor. Probá de nuevo.");
      }
    })();
    return () => {
      alive = false;
      sequencer.current.cancel();
    };
    // Una carga por instancia: las props del pedido no cambian con el drawer abierto.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (loaded) {
      setDraft(loaded.draft);
      setBaseline(loaded.draft);
    }
  }, [loaded]);

  // ── Derivados ─────────────────────────────────────────────────────────────
  const formMode = mode === "replan" ? "replan" : "create";
  const clientErrors = useMemo<PlanDraftErrors>(
    () => (draft && mode !== "generate" ? validateDraft(draft, formMode, { requireExercises: !!diagnosis }) : {}),
    [draft, mode, formMode, diagnosis]
  );
  const base = useMemo<AnyBase | null>(() => {
    if (mode === "generate") {
      if (!programId) return null;
      const ids = props.generateForSessionIds?.length ? props.generateForSessionIds : undefined;
      return { programId, ...(ids ? { sessionIds: ids } : {}) };
    }
    if (!draft || hasDraftErrors(clientErrors)) return null;
    if (mode === "replan") {
      if (!programId || !props.replanFromSessionId || !loaded?.replanOriginal) return null;
      return draftToReplanBase(draft, { programId, fromSessionId: props.replanFromSessionId }, loaded.replanOriginal);
    }
    return draftToCreateBase(draft);
  }, [mode, programId, props.generateForSessionIds, props.replanFromSessionId, draft, clientErrors, loaded]);

  const baseKey = useMemo(() => (base ? previewRequestKey(base, {}) : null), [base]);
  const currentKey = useMemo(() => (base ? previewRequestKey(base, resolutions) : null), [base, resolutions]);
  const fresh = !!preview && previewKey !== null && previewKey === currentKey && !previewing;
  const dirty = (!!draft && isDraftDirty(baseline, draft)) || Object.keys(resolutions).length > 0;

  // ── Preview ───────────────────────────────────────────────────────────────
  // El preview a la vista, para marcar el stale contra él después de un re-preview forzado.
  const previewRef = useRef<PlanPreview | null>(null);
  previewRef.current = preview;

  /**
   * `markStale`: re-preview después de un `stale` (CAS perdido en generar /
   * re-planificar). Las filas se marcan con el banner C13 AL VOLVER el
   * preview nuevo; antes se mostraba el error y el re-preview lo borraba
   * (`setFormError(null)`), así que el aviso desaparecía solo (P3.Z F2).
   */
  const runPreview = useCallback(
    async (b: AnyBase, chosen: Record<number, PlanRowResolution>, opts: { markStale?: boolean } = {}) => {
      const input = { ...b, rows: chosenRows(chosen) };
      await runSequencedPreview(
        sequencer.current,
        () =>
          mode === "generate"
            ? previewGeneratePlanBookings(input as GenerateBase & { rows: PlanRowResolution[] })
            : mode === "replan"
              ? previewReplanPlan(input as PlanReplanBase & { rows: PlanRowResolution[] })
              : previewPlan(input as PlanCreateBase & { rows: PlanRowResolution[] }),
        {
          start: () => setPreviewing(true),
          result: (r) => {
            if (!r.ok) {
              setFormError(r.error);
              setServerErrors(serverFieldErrors(r.fieldErrors));
              return;
            }
            setFormError(null);
            setServerErrors({});
            let kept = pruneResolutions(r.preview, chosen);
            if (opts.markStale) {
              const st = staleAfterRepreview(previewRef.current, r.preview, chosen);
              kept = st.resolutions;
              setStaleIndexes(st.staleIndexes);
            }
            setPreview(r.preview);
            setPreviewBase(b);
            setResolutions(kept);
            setPreviewKey(previewRequestKey(b, kept));
          },
          // Sin esto el editor quedaba en "Buscando turnos…" para siempre si la action tiraba.
          error: () => setFormError("No pudimos revisar la agenda. Probá de nuevo."),
          done: () => setPreviewing(false),
        }
      );
    },
    [mode]
  );

  // Generar: no hay form, el preview sale al abrir.
  useEffect(() => {
    if (mode === "generate" && loaded && base && !preview && !previewing) void runPreview(base, {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, loaded]);

  // Borrador cambiado después de un preview: las marcas de stale ya no aplican.
  const lastBaseKey = useRef<string | null>(null);
  useEffect(() => {
    if (lastBaseKey.current !== null && lastBaseKey.current !== baseKey) setStaleIndexes(null);
    lastBaseKey.current = baseKey;
  }, [baseKey]);

  // Re-preview automático (debounce + secuencia) una vez que hay un preview a la vista.
  useEffect(() => {
    if (!preview || !base || !currentKey || currentKey === previewKey || committing) return;
    const t = setTimeout(() => void runPreview(base, resolutions), PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [preview, base, currentKey, previewKey, resolutions, committing, runPreview]);

  const askPreview = () => {
    setAttempted(true);
    if (!base) {
      // Sin errores de campo y sin base = falta un dato del pedido (p. ej. replan sin sesión de origen).
      if (!hasDraftErrors(clientErrors)) setFormError("Faltan datos del plan para armar los turnos. Cerrá y volvé a abrir el editor.");
      return;
    }
    void runPreview(base, resolutions);
  };

  // ── Commit ────────────────────────────────────────────────────────────────
  const savedPatientId = loaded?.patientId ?? props.patientId ?? "";

  const commit = async () => {
    if (!preview || !previewBase || !fresh || committing) return;
    setCommitting(true);
    setFormError(null);
    const rows = commitResolutions(preview, resolutions);
    const stateToken = preview.stateToken;
    try {
      if (mode === "create") {
        const plan = { ...(previewBase as PlanCreateBase), idempotencyKey, rows, stateToken };
        const r = diagnosis
          ? await createPlanFromDiagnosis({ plan, diagnosis: { conditionSlug: diagnosis.conditionSlug, selection: diagnosis.selection } })
          : await createPlan(plan);
        if (r.ok) {
          toast.success(r.idempotent ? "El plan ya estaba creado" : "Plan creado");
          onSaved({ programId: r.programId, patientId: plan.patientId });
          onClose();
          return;
        }
        if ("preview" in r) return applyStale(r.preview);
        setFormError(r.error);
        setServerErrors(serverFieldErrors(r.fieldErrors));
        return;
      }
      const r =
        mode === "generate"
          ? await generatePlanBookings({ ...(previewBase as GenerateBase), rows, stateToken })
          : await replanPlan({ ...(previewBase as PlanReplanBase), rows, stateToken });
      if (r.ok) {
        toast.success(mode === "generate" ? "Turnos agendados" : "Plan actualizado", r.notice ? { description: r.notice } : undefined);
        onSaved({ programId: programId!, patientId: savedPatientId });
        onClose();
        return;
      }
      if ("kind" in r && r.kind === "stale-preview") return applyStale(r.preview);
      if ("kind" in r && r.kind === "stale") {
        // CAS perdido: alguien tocó el plan. Se re-pide el preview con lo de hoy
        // y, al volver, las filas quedan marcadas con el copy C13 (no un error
        // suelto que el re-preview borraba).
        void runPreview(previewBase, resolutions, { markStale: true });
        return;
      }
      setFormError(r.error);
      setServerErrors(serverFieldErrors("fieldErrors" in r ? r.fieldErrors : undefined));
    } catch {
      setFormError("No pudimos guardar. Revisá la conexión y probá de nuevo.");
    } finally {
      setCommitting(false);
    }
  };

  const applyStale = (next: PlanPreview) => {
    // Sin un dato mejor (ninguna fila cambió a la vista), se marcan todas: el banner igual tiene que salir.
    const r = staleAfterRepreview(preview, next, resolutions);
    sequencer.current.cancel();
    setPreviewing(false);
    setPreview(next);
    setResolutions(r.resolutions);
    setStaleIndexes(r.staleIndexes);
    if (previewBase) setPreviewKey(previewRequestKey(previewBase, r.resolutions));
  };

  const onResolutionChange = (res: PlanRowResolution) => {
    setResolutions((prev) => ({ ...prev, [res.index]: res }));
  };

  // ── Render ────────────────────────────────────────────────────────────────
  const shownErrors: PlanDraftErrors = { ...(attempted ? clientErrors : {}), ...serverErrors };
  const counts = preview ? previewTableCounts(preview, resolutions) : null;
  const pricing = previewBase && "pricing" in previewBase ? previewBase.pricing : null;
  const schedule = draft && mode !== "generate" ? draft.schedule : null;
  const busy = previewing || committing;
  const ordinalOf = useMemo(
    () => (preview && mode !== "create" && loaded?.ordinalSessions ? planPreviewOrdinalOf(preview, { sessions: loaded.ordinalSessions }) : undefined),
    [preview, mode, loaded]
  );
  // Rampa del Diagnóstico (S23 H3): sigue al borrador (cantidad y ejercicios).
  const rampNote = loaded?.diagnosis && draft?.origin === "diagnosis" ? diagnosisRampNote(loaded.diagnosis.exercises, draft) : null;
  const exercisesNote = rampNote && loaded?.diagnosis ? `Progresión de ${loaded.diagnosis.conditionName}: ${rampNote}.` : loaded?.exercisesNote ?? null;

  return (
    <Drawer open={open} onClose={onClose} title={planEditorTitle(mode)} width={PLAN_EDITOR_WIDTH} dirty={dirty} dirtyMessage={PLAN_EDITOR_COPY.dirty}>
      <div style={{ display: "flex", flexDirection: "column", gap: 18, minWidth: 0 }}>
        {loadError ? (
          <p role="alert" style={{ margin: 0, fontSize: 13, color: "#9F1F1F" }}>
            {loadError}
          </p>
        ) : !loaded || !draft ? (
          <p aria-busy="true" style={{ margin: 0, fontSize: 13, color: "var(--navy-500)" }}>
            Cargando…
          </p>
        ) : (
          <>
            {mode !== "generate" && (
              <PlanForm
                mode={formMode}
                draft={draft}
                onChange={(next) => {
                  setDraft(next);
                  setServerErrors({});
                }}
                options={loaded.options}
                errors={shownErrors}
                needsPatient={!props.patientId}
                showAuthorization={props.permissions?.authorize ?? true}
                exercisesNote={exercisesNote}
                disabled={committing}
              />
            )}

            {mode !== "generate" && (
              <div>
                <Button type="button" variant="ghost" onClick={askPreview} disabled={busy} aria-describedby={formError ? "plan-editor-error" : undefined}>
                  {previewing && !preview ? "Buscando turnos…" : PLAN_EDITOR_COPY.preview}
                </Button>
              </div>
            )}

            {preview && (
              <section aria-label={PLAN_EDITOR_COPY.reviewTitle} aria-busy={previewing || undefined} style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
                <h3 className="k-display" style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
                  {PLAN_EDITOR_COPY.reviewTitle}
                </h3>
                {!fresh && !committing && (
                  <p aria-live="polite" style={{ margin: 0, fontSize: 12, color: "var(--navy-500)" }}>
                    {PLAN_EDITOR_COPY.previewOutdated}
                  </p>
                )}
                <PlanPreviewTable
                  preview={preview}
                  resolutions={resolutions}
                  onResolutionChange={onResolutionChange}
                  staleIndexes={staleIndexes}
                  schedule={schedule}
                  pricing={pricing}
                  disabled={committing}
                  ordinalOf={ordinalOf}
                />
              </section>
            )}

            {mode === "generate" && !preview && previewing && (
              <p aria-busy="true" style={{ margin: 0, fontSize: 13, color: "var(--navy-500)" }}>
                Buscando turnos…
              </p>
            )}

            {formError && (
              <p id="plan-editor-error" role="alert" style={{ margin: 0, fontSize: 13, color: "#9F1F1F" }}>
                {formError}
              </p>
            )}

            <footer style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
              <Button type="button" variant="ghost" onClick={onClose} disabled={committing}>
                Cancelar
              </Button>
              <Button type="button" variant="primary" onClick={() => void commit()} disabled={!fresh || committing}>
                {committing ? "Guardando…" : commitLabel(mode, counts)}
              </Button>
            </footer>
          </>
        )}
      </div>
    </Drawer>
  );
}
