"use client";

/**
 * Drawer de alta / edición de plantillas de plan (S21t, ES3 P3.2).
 *
 * Una plantilla es un borrador del editor de planes guardado para reusar:
 * disciplina, servicio, duración, cantidad, horario, precio, notas y
 * ejercicios. "Usar plantilla" (aplicarla a un paciente) NO vive acá: lo hace
 * el perfil con `getTemplatePrefill` + el editor único (S22a), así el alta
 * pasa siempre por el motor.
 *
 * Por qué así:
 *   - Formulario en Drawer con dirty-guard (AGENTS §5): un Esc o click fuera
 *     tiraba media plantilla cargada. El dirty compara el borrador con el que
 *     se abrió con `canonicalKey` (el mismo criterio que el editor de planes).
 *   - La edición manda SOLO lo que cambió (`templateUpdatePatch`) más el CAS
 *     `expectedUpdatedAt`. Mandar todo re-validaba un servicio que se borró
 *     después y la plantilla no se podía ni renombrar; y sin CAS dos admins
 *     editando a la vez se pisaban en silencio (el server devuelve el copy
 *     `stale` y el drawer lo muestra tal cual).
 *   - Ejercicios que hoy no se pueden asignar (archivados / fuera del catálogo
 *     del plan SaaS) se marcan y al guardar se sacan: el server los rechazaría
 *     y el motor mataría el alta del plan al aplicarla (handoff P3.Z).
 *   - Sin horario (ningún día) = `schedule: null`: el horario se elige al
 *     aplicar. Las reglas de horario y montos son las del editor (C6, centavos
 *     con `MoneyInput`); el server es la barrera (`fieldErrors`).
 *
 * La lógica es pura y exportada (testeada en `tests/unit/render/templates.test.tsx`);
 * el componente solo cablea con las actions de `lib/plan-templates.ts`.
 */
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Drawer } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { MoneyInput } from "@/components/ui/money-input";
import { Tag } from "@/components/ui/tag";
import { useToast } from "@/components/ui/toast";
import { ExerciseSearchPicker } from "@/components/ui/exercise-search-picker";
import { ScheduleSlotsEditor } from "@/components/planes/schedule-slots-editor";
import { listServices } from "@/lib/bookings";
import { createPlanTemplate, getPlanTemplate, updatePlanTemplate } from "@/lib/plan-templates";
import type {
  PlanTemplateCreateInput,
  PlanTemplateDetail,
  PlanTemplateUpdateInput,
} from "@/lib/plan-templates-types";
import { PLAN_TEMPLATE_MAX_EXERCISES } from "@/lib/plan-templates-types";
import { planScheduleError } from "@/lib/availability/plan";
import { disciplineLabel } from "@/lib/plan-display";
import {
  DISCIPLINES,
  DISCIPLINE_TAG_SLUGS,
  PLAN_MAX_DURATION,
  PLAN_MAX_SESSIONS,
  PLAN_MIN_DURATION,
  type Discipline,
} from "@/lib/plans-constants";
import {
  DEFAULT_TOTAL_SESSIONS,
  EMPTY_SCHEDULE,
  PLAN_EDITOR_COPY,
  canonicalKey,
  draftPricing,
  servicesForDiscipline,
  type PlanEditorService,
  type PlanPriceMode,
} from "@/lib/plan-editor-state";
import type { PlanPricingInput, PlanScheduleV1 } from "@/lib/plans-types";
import tap from "@/components/planes/planes-mobile.module.css";

// ─── Copy ────────────────────────────────────────────────────────────────────

export const TEMPLATE_COPY = {
  titleCreate: "Nueva plantilla",
  titleEdit: "Editar plantilla",
  titleView: "Plantilla",
  dirty: "Tenés una plantilla a medio cargar. Si cerrás, se pierde.",
  noName: "Poné un nombre",
  noPrice: PLAN_EDITOR_COPY.noPrice,
  priceInvalid: "Revisá el monto",
  sessionsRange: PLAN_EDITOR_COPY.sessionsRange,
  durationRange: PLAN_EDITOR_COPY.durationRange,
  scheduleHint: "Opcional. Sin días, el horario se elige al usar la plantilla.",
  noDisciplineOption: "Sin disciplina",
  exercisesEmpty: "Sin ejercicios. Los podés sumar ahora o al armar cada plan.",
  exerciseUnavailable: "No disponible: se saca al guardar",
  readOnly: "Solo quien creó la plantilla o un administrador puede cambiarla.",
  created: "Plantilla creada",
  saved: "Plantilla guardada",
  noChanges: "No hay cambios para guardar",
  loadError: "No pudimos abrir la plantilla.",
} as const;

// ─── Borrador (puro) ─────────────────────────────────────────────────────────

export type TemplateExerciseDraft = { id: string; name: string; assignable: boolean };

export type TemplateDraft = {
  name: string;
  description: string;
  discipline: Discipline | null;
  serviceId: string | null;
  /** null = la duración del servicio. */
  durationMin: number | null;
  totalSessions: number;
  /** Sin slots = sin horario (`schedule: null`). */
  schedule: PlanScheduleV1;
  priceMode: PlanPriceMode;
  priceCents: number | null;
  notes: string;
  exercises: TemplateExerciseDraft[];
};

export type TemplateDraftErrors = Partial<
  Record<"name" | "description" | "discipline" | "serviceId" | "durationMin" | "totalSessions" | "schedule" | "pricing" | "notes" | "exercises", string>
>;

export function emptyTemplateDraft(discipline: Discipline | null = null): TemplateDraft {
  return {
    name: "",
    description: "",
    discipline,
    serviceId: null,
    durationMin: null,
    totalSessions: DEFAULT_TOTAL_SESSIONS,
    schedule: EMPTY_SCHEDULE,
    priceMode: "NONE",
    priceCents: null,
    notes: "",
    exercises: [],
  };
}

function priceOf(pricing: PlanPricingInput): { priceMode: PlanPriceMode; priceCents: number | null } {
  if (!pricing) return { priceMode: "NONE", priceCents: null };
  return pricing.mode === "PER_SESSION"
    ? { priceMode: "PER_SESSION", priceCents: pricing.pricePerSessionCents }
    : { priceMode: "PACKAGE", priceCents: pricing.totalPriceCents };
}

export function templateDraftFromDetail(d: PlanTemplateDetail): TemplateDraft {
  return {
    name: d.name,
    description: d.description ?? "",
    discipline: d.discipline,
    serviceId: d.serviceId,
    durationMin: d.durationMin,
    totalSessions: d.totalSessions,
    schedule: d.schedule ?? EMPTY_SCHEDULE,
    ...priceOf(d.pricing),
    notes: d.notes ?? "",
    exercises: d.exercises.map((e) => ({ id: e.id, name: e.name, assignable: e.assignable })),
  };
}

const scheduleOrNull = (s: PlanScheduleV1): PlanScheduleV1 | null => (s.slots.length === 0 ? null : s);
const textOrNull = (s: string): string | null => (s.trim() === "" ? null : s.trim());
const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);

/** Validación de cliente (espeja el zod de `plan-templates-types.ts`; el server sigue siendo la barrera). */
export function validateTemplateDraft(d: TemplateDraft, opts: { priceInvalid?: boolean } = {}): TemplateDraftErrors {
  const e: TemplateDraftErrors = {};
  if (d.name.trim() === "") e.name = TEMPLATE_COPY.noName;
  else if (d.name.trim().length > 120) e.name = "El nombre es demasiado largo";
  if (d.description.trim().length > 500) e.description = "Descripción: como máximo 500 caracteres";
  if (d.notes.trim().length > 4000) e.notes = "Notas: como máximo 4000 caracteres";
  if (!isInt(d.totalSessions) || d.totalSessions < 1 || d.totalSessions > PLAN_MAX_SESSIONS) e.totalSessions = TEMPLATE_COPY.sessionsRange;
  if (d.durationMin != null && (!isInt(d.durationMin) || d.durationMin < PLAN_MIN_DURATION || d.durationMin > PLAN_MAX_DURATION)) {
    e.durationMin = TEMPLATE_COPY.durationRange;
  }
  const sched = scheduleOrNull(d.schedule);
  if (sched) {
    const problem = planScheduleError(sched);
    if (problem) e.schedule = problem;
  }
  if (opts.priceInvalid) e.pricing = TEMPLATE_COPY.priceInvalid;
  else if (d.priceMode !== "NONE" && d.priceCents == null) e.pricing = TEMPLATE_COPY.noPrice;
  if (assignableExerciseIds(d).length > PLAN_TEMPLATE_MAX_EXERCISES) e.exercises = `Como máximo ${PLAN_TEMPLATE_MAX_EXERCISES} ejercicios`;
  return e;
}

export const hasTemplateErrors = (e: TemplateDraftErrors) => Object.keys(e).length > 0;

/** Ids que se guardan: los asignables, en orden y sin repetidos. */
export function assignableExerciseIds(d: Pick<TemplateDraft, "exercises">): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of d.exercises) {
    if (!x.assignable || seen.has(x.id)) continue;
    seen.add(x.id);
    out.push(x.id);
  }
  return out;
}

export function templateDraftToCreate(d: TemplateDraft): PlanTemplateCreateInput {
  return {
    name: d.name.trim(),
    description: textOrNull(d.description),
    discipline: d.discipline,
    serviceId: d.serviceId,
    durationMin: d.durationMin,
    totalSessions: d.totalSessions,
    schedule: scheduleOrNull(d.schedule),
    pricing: draftPricing(d),
    notes: textOrNull(d.notes),
    exerciseIds: assignableExerciseIds(d),
  };
}

/**
 * Patch de edición: solo los campos que cambiaron respecto del borrador con
 * el que se abrió, más el CAS. Los ejercicios van si cambiaron o si había
 * alguno no asignable (se sacan al guardar, como promete el drawer).
 * `null` = nada que guardar.
 */
export function templateUpdatePatch(
  baseline: TemplateDraft,
  draft: TemplateDraft,
  ref: { id: string; updatedAt: Date | string }
): PlanTemplateUpdateInput | null {
  const before = templateDraftToCreate(baseline);
  const after = templateDraftToCreate(draft);
  const patch: PlanTemplateUpdateInput = { id: ref.id, expectedUpdatedAt: new Date(ref.updatedAt).toISOString() };
  let changed = false;
  const keys = ["name", "description", "discipline", "serviceId", "durationMin", "totalSessions", "schedule", "pricing", "notes"] as const;
  for (const k of keys) {
    if (canonicalKey(before[k] ?? null) !== canonicalKey(after[k] ?? null)) {
      (patch as Record<string, unknown>)[k] = after[k] ?? null;
      changed = true;
    }
  }
  const hadUnavailable = baseline.exercises.some((x) => !x.assignable);
  if (hadUnavailable || canonicalKey(before.exerciseIds) !== canonicalKey(after.exerciseIds)) {
    patch.exerciseIds = after.exerciseIds;
    changed = true;
  }
  return changed ? patch : null;
}

export function isTemplateDraftDirty(baseline: TemplateDraft | null, draft: TemplateDraft): boolean {
  if (!baseline) return false;
  return canonicalKey(baseline) !== canonicalKey(draft);
}

/** Cambiar la disciplina limpia un servicio de la OTRA disciplina (el server lo rechazaría). */
export function templateWithDiscipline(
  d: TemplateDraft,
  discipline: Discipline | null,
  services: ReadonlyArray<PlanEditorService>
): TemplateDraft {
  const current = services.find((s) => s.id === d.serviceId);
  const keep = !current || current.discipline == null || discipline == null || current.discipline === discipline;
  return { ...d, discipline, serviceId: keep ? d.serviceId : null };
}

/** "Sin precio" limpia el monto; pasar a "Por sesión" sin monto propone el del servicio. */
export function templateWithPriceMode(
  d: TemplateDraft,
  mode: PlanPriceMode,
  services: ReadonlyArray<PlanEditorService>
): TemplateDraft {
  if (mode === "NONE") return { ...d, priceMode: mode, priceCents: null };
  if (mode === d.priceMode) return d;
  const service = services.find((s) => s.id === d.serviceId);
  const suggested =
    mode === "PER_SESSION" && d.priceCents == null && service && service.priceCents > 0 ? service.priceCents : d.priceCents;
  return { ...d, priceMode: mode, priceCents: suggested ?? null };
}

/** `fieldErrors` del server → errores del form (la primera línea de cada campo). */
export function templateServerErrors(fieldErrors: Record<string, string[] | undefined> | undefined): TemplateDraftErrors {
  const out: TemplateDraftErrors = {};
  if (!fieldErrors) return out;
  const map: Record<string, keyof TemplateDraftErrors> = {
    name: "name",
    description: "description",
    discipline: "discipline",
    serviceId: "serviceId",
    durationMin: "durationMin",
    totalSessions: "totalSessions",
    schedule: "schedule",
    pricing: "pricing",
    notes: "notes",
    exerciseIds: "exercises",
  };
  for (const [k, msgs] of Object.entries(fieldErrors)) {
    const key = map[k];
    if (key && msgs?.[0]) out[key] = msgs[0];
  }
  return out;
}

// ─── Form (controlado, sin efectos) ──────────────────────────────────────────

const PRICE_OPTIONS: ReadonlyArray<{ value: PlanPriceMode; label: string }> = [
  { value: "NONE", label: PLAN_EDITOR_COPY.priceNone },
  { value: "PER_SESSION", label: PLAN_EDITOR_COPY.pricePerSession },
  { value: "PACKAGE", label: PLAN_EDITOR_COPY.pricePackage },
];

const sectionLabel: CSSProperties = { fontSize: 12, fontWeight: 600, color: "var(--navy-500)" };
const errorText: CSSProperties = { margin: "4px 0 0", fontSize: 12, color: "var(--danger-fg)" };
const hintText: CSSProperties = { margin: "4px 0 0", fontSize: 12, color: "var(--navy-500)" };
const grid2: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 };

const intOrNull = (v: string): number | null => {
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isInteger(n) ? n : null;
};

export type TemplateFormProps = {
  draft: TemplateDraft;
  onChange: (next: TemplateDraft) => void;
  services: ReadonlyArray<PlanEditorService>;
  errors: TemplateDraftErrors;
  /** Sin permiso de edición (no es autor ni admin): todo en solo lectura. */
  disabled?: boolean;
  onPriceInvalidChange?: (invalid: boolean) => void;
  /** Abre el buscador de ejercicios (lo monta el drawer). */
  onAddExercises?: () => void;
};

export function TemplateForm({ draft, onChange, services, errors, disabled, onPriceInvalidChange, onAddExercises }: TemplateFormProps) {
  const set = (patch: Partial<TemplateDraft>) => onChange({ ...draft, ...patch });
  const { options: serviceOptions, untagged } = servicesForDiscipline(services, draft.discipline);
  const service = services.find((s) => s.id === draft.serviceId) ?? null;
  const serviceSelect = [
    { value: "", label: "Sin servicio fijo" },
    ...serviceOptions.map((s) => ({ value: s.id, label: s.name })),
    // Un servicio guardado que ya no está en la lista (borrado, otra disciplina) se sigue mostrando.
    ...(draft.serviceId && !serviceOptions.some((s) => s.id === draft.serviceId)
      ? [{ value: draft.serviceId, label: service?.name ?? "Servicio actual" }]
      : []),
  ];
  const unavailable = draft.exercises.filter((x) => !x.assignable).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
      <FormField label="Nombre" value={draft.name} onChange={(v) => set({ name: v })} error={errors.name} disabled={disabled} placeholder="Ej.: Lumbalgia aguda · 10 sesiones" />
      <FormField
        as="textarea"
        label="Descripción"
        rows={2}
        value={draft.description}
        onChange={(v) => set({ description: v })}
        error={errors.description}
        disabled={disabled}
        placeholder="Opcional: para qué casos sirve"
      />

      <div style={grid2}>
        <FormField
          as="select"
          label="Disciplina"
          value={draft.discipline ?? ""}
          onChange={(v) => onChange(templateWithDiscipline(draft, (v || null) as Discipline | null, services))}
          options={[{ value: "", label: TEMPLATE_COPY.noDisciplineOption }, ...DISCIPLINES.map((d) => ({ value: d, label: disciplineLabel(d) }))]}
          error={errors.discipline}
          disabled={disabled}
        />
        <div style={{ minWidth: 0 }}>
          <FormField
            as="select"
            label="Servicio"
            value={draft.serviceId ?? ""}
            onChange={(v) => set({ serviceId: v || null })}
            options={serviceSelect}
            error={errors.serviceId}
            disabled={disabled}
          />
          {untagged && draft.discipline && <p style={hintText}>{PLAN_EDITOR_COPY.serviceHint}</p>}
        </div>
      </div>

      <div style={grid2}>
        <FormField
          type="number"
          label="Cantidad de sesiones"
          min={1}
          max={PLAN_MAX_SESSIONS}
          value={Number.isFinite(draft.totalSessions) ? draft.totalSessions : ""}
          onChange={(v) => set({ totalSessions: intOrNull(v) ?? Number.NaN })}
          error={errors.totalSessions}
          disabled={disabled}
        />
        <FormField
          type="number"
          label="Duración"
          tooltip="En minutos. Vacío = la del servicio."
          min={PLAN_MIN_DURATION}
          max={PLAN_MAX_DURATION}
          step={5}
          value={draft.durationMin ?? ""}
          placeholder={service ? String(service.durationMin) : "La del servicio"}
          onChange={(v) => set({ durationMin: intOrNull(v) })}
          error={errors.durationMin}
          disabled={disabled}
        />
      </div>

      <div>
        <ScheduleSlotsEditor
          value={draft.schedule}
          onChange={(schedule) => set({ schedule })}
          error={errors.schedule}
          idPrefix="template"
          disabled={disabled}
        />
        <p style={hintText}>{TEMPLATE_COPY.scheduleHint}</p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <FormField
          as="select"
          label="Precio"
          value={draft.priceMode}
          onChange={(v) => onChange(templateWithPriceMode(draft, v as PlanPriceMode, services))}
          options={PRICE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          disabled={disabled}
        />
        {draft.priceMode !== "NONE" && (
          <MoneyInput
            label={draft.priceMode === "PER_SESSION" ? "Precio por sesión" : "Precio total del paquete"}
            value={draft.priceCents}
            onChange={(cents) => set({ priceCents: cents })}
            onInvalidChange={onPriceInvalidChange}
            error={errors.pricing}
            disabled={disabled}
          />
        )}
        {draft.priceMode === "NONE" && errors.pricing && (
          <p role="alert" style={errorText}>
            {errors.pricing}
          </p>
        )}
      </div>

      <fieldset style={{ border: "1px solid rgba(15,30,51,0.1)", borderRadius: 14, padding: 12, margin: 0, minWidth: 0 }}>
        <legend style={{ ...sectionLabel, padding: "0 4px" }}>Ejercicios</legend>
        {draft.exercises.length === 0 ? (
          <p style={{ ...hintText, margin: 0 }}>{TEMPLATE_COPY.exercisesEmpty}</p>
        ) : (
          <ul data-testid="template-exercises" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            {draft.exercises.map((x) => (
              <li
                key={x.id}
                data-assignable={x.assignable ? "true" : "false"}
                style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 13, color: "var(--navy-900)", minWidth: 0 }}
              >
                <span style={{ flex: "1 1 160px", minWidth: 0, overflowWrap: "anywhere", textDecoration: x.assignable ? undefined : "line-through" }}>{x.name}</span>
                {!x.assignable && <Tag tone="soft">{TEMPLATE_COPY.exerciseUnavailable}</Tag>}
                {!disabled && (
                  <button
                    type="button"
                    className="k-btn k-btn-ghost"
                    style={{ padding: "4px 10px", fontSize: 12 }}
                    aria-label={`Quitar ${x.name}`}
                    onClick={() => set({ exercises: draft.exercises.filter((y) => y.id !== x.id) })}
                  >
                    Quitar
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {unavailable > 0 && (
          <p style={hintText}>
            {unavailable === 1 ? "1 ejercicio ya no está disponible" : `${unavailable} ejercicios ya no están disponibles`}: se sacan al guardar.
          </p>
        )}
        {errors.exercises && (
          <p role="alert" style={errorText}>
            {errors.exercises}
          </p>
        )}
        {!disabled && onAddExercises && (
          <div style={{ marginTop: 10 }}>
            <Button type="button" variant="ghost" onClick={onAddExercises}>
              Sumar ejercicios
            </Button>
          </div>
        )}
      </fieldset>

      <FormField as="textarea" label="Notas" rows={3} value={draft.notes} onChange={(v) => set({ notes: v })} error={errors.notes} disabled={disabled} />
    </div>
  );
}

// ─── Drawer ──────────────────────────────────────────────────────────────────

export type TemplateDrawerProps = {
  open: boolean;
  /** null = alta. */
  templateId: string | null;
  /** Disciplina inicial del alta (la pestaña `/planes/[disciplina]`). */
  discipline?: Discipline;
  onClose: () => void;
  /** Después de crear o guardar (el listado recarga). */
  onSaved: (id: string) => void;
};

async function loadServices(): Promise<PlanEditorService[]> {
  const rows = await listServices().catch(() => []);
  return rows.map((s) => ({
    id: s.id,
    name: s.name,
    discipline: (s.discipline ?? null) as Discipline | null,
    durationMin: s.durationMin,
    priceCents: s.priceCents,
  }));
}

export function TemplateDrawer(props: TemplateDrawerProps) {
  if (!props.open) return null;
  // Instancia nueva por plantilla: el estado (borrador, baseline, CAS) no se arrastra.
  return <TemplateDrawerInstance key={props.templateId ?? "new"} {...props} />;
}

function TemplateDrawerInstance({ open, templateId, discipline, onClose, onSaved }: TemplateDrawerProps) {
  const toast = useToast();
  const isNew = templateId == null;
  const [services, setServices] = useState<PlanEditorService[]>([]);
  const [detail, setDetail] = useState<PlanTemplateDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<TemplateDraft | null>(() => (isNew ? emptyTemplateDraft(discipline ?? null) : null));
  const [draft, setDraft] = useState<TemplateDraft>(() => emptyTemplateDraft(discipline ?? null));
  const [errors, setErrors] = useState<TemplateDraftErrors>({});
  const [priceInvalid, setPriceInvalid] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    void loadServices().then((s) => alive && setServices(s));
    if (templateId) {
      void getPlanTemplate(templateId)
        .then((r) => {
          if (!alive) return;
          if (!r.ok) {
            setLoadError(r.error);
            return;
          }
          const d = templateDraftFromDetail(r.data);
          setDetail(r.data);
          setBaseline(d);
          setDraft(d);
        })
        .catch(() => alive && setLoadError(TEMPLATE_COPY.loadError));
    }
    return () => {
      alive = false;
    };
  }, [templateId]);

  const readOnly = !isNew && detail != null && !detail.canEdit;
  const loading = !isNew && detail == null && loadError == null;
  const dirty = !readOnly && isTemplateDraftDirty(baseline, draft);
  const existingIds = useMemo(() => new Set(draft.exercises.map((x) => x.id)), [draft.exercises]);
  const title = isNew ? TEMPLATE_COPY.titleCreate : readOnly ? TEMPLATE_COPY.titleView : TEMPLATE_COPY.titleEdit;

  const save = async () => {
    const local = validateTemplateDraft(draft, { priceInvalid });
    setErrors(local);
    if (hasTemplateErrors(local)) return;
    setSaving(true);
    try {
      if (isNew) {
        const r = await createPlanTemplate(templateDraftToCreate(draft));
        if (!r.ok) {
          setErrors(templateServerErrors(r.fieldErrors));
          toast.error(r.error);
          return;
        }
        toast.success(TEMPLATE_COPY.created);
        onSaved(r.data.id);
        onClose();
        return;
      }
      if (!detail || !baseline) return;
      const patch = templateUpdatePatch(baseline, draft, { id: detail.id, updatedAt: detail.updatedAt });
      if (!patch) {
        toast.info(TEMPLATE_COPY.noChanges);
        onClose();
        return;
      }
      const r = await updatePlanTemplate(patch);
      if (!r.ok) {
        setErrors(templateServerErrors(r.fieldErrors));
        toast.error(r.error);
        return;
      }
      toast.success(TEMPLATE_COPY.saved);
      onSaved(r.data.id);
      onClose();
    } catch {
      toast.error("No pudimos guardar la plantilla. Probá de nuevo.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer open={open} onClose={onClose} title={title} width={560} dirty={dirty} dirtyMessage={TEMPLATE_COPY.dirty}>
      <div className={`${tap.tapScope} ${tap.contents}`}>
      {loadError ? (
        <p role="alert" style={errorText}>
          {loadError}
        </p>
      ) : loading ? (
        <p aria-live="polite" style={hintText}>
          Cargando plantilla…
        </p>
      ) : (
        <>
          {readOnly && <p style={{ ...hintText, marginTop: 0, marginBottom: 12 }}>{TEMPLATE_COPY.readOnly}</p>}
          <TemplateForm
            draft={draft}
            onChange={setDraft}
            services={services}
            errors={errors}
            disabled={readOnly || saving}
            onPriceInvalidChange={setPriceInvalid}
            onAddExercises={() => setPickerOpen(true)}
          />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20, flexWrap: "wrap" }}>
            <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
              {readOnly ? "Cerrar" : "Cancelar"}
            </Button>
            {!readOnly && (
              <Button type="button" onClick={() => void save()} disabled={saving} aria-busy={saving || undefined}>
                {saving ? "Guardando…" : isNew ? "Crear plantilla" : "Guardar"}
              </Button>
            )}
          </div>
          {!readOnly && (
            <ExerciseSearchPicker
              open={pickerOpen}
              existingIds={existingIds}
              disciplineSlug={draft.discipline ? DISCIPLINE_TAG_SLUGS[draft.discipline] : null}
              onPick={(ex) =>
                setDraft((d) =>
                  d.exercises.some((x) => x.id === ex.id) ? d : { ...d, exercises: [...d.exercises, { id: ex.id, name: ex.name, assignable: true }] }
                )
              }
              onClose={() => setPickerOpen(false)}
            />
          )}
        </>
      )}
      </div>
    </Drawer>
  );
}
