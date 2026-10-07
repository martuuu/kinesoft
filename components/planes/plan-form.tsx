"use client";

/**
 * Formulario del editor único de planes (S18, C13 "Editor" en orden):
 *   1. Paciente (solo si falta; `PatientPicker requireFull`).
 *   2. Disciplina: segmentado Kinesiología / Osteopatía.
 *   3. Servicio: los de la disciplina + los sin disciplina, con el hint.
 *   4. Profesional responsable.
 *   5. Sede.
 *   6. Inicio, cantidad y horario por día.
 *   7. Precio: "Sin precio · sigue la cobertura" / "Por sesión" / "Paquete".
 *   (opcional) Autorización de la OS, solo con `plans.authorize`.
 *   8. Título y notas.
 *
 * Controlado y sin efectos: recibe el borrador y devuelve el siguiente. La
 * lógica (filtrar servicios, limpiar el servicio al cambiar la disciplina,
 * proponer el precio) vive en `lib/plan-editor-state.ts` (testeada); acá solo
 * se pinta. En modo `replan` solo se edita lo que el replan acepta (horario,
 * inicio, profesional, servicio, sede y duración): cantidad y precio tienen
 * diálogos propios (C10, S22e) y la disciplina del plan no cambia.
 */
import type { CSSProperties } from "react";
import { FormField } from "@/components/ui/form-field";
import { MoneyInput } from "@/components/ui/money-input";
import { PatientPicker } from "@/components/patients/patient-picker";
import { ScheduleSlotsEditor } from "@/components/planes/schedule-slots-editor";
import { planScheduleError } from "@/lib/availability/plan";
import { disciplineLabel } from "@/lib/plan-display";
import { DISCIPLINES, PLAN_MAX_DURATION, PLAN_MAX_SESSIONS, PLAN_MIN_DURATION, type Discipline } from "@/lib/plans-constants";
import {
  PLAN_EDITOR_COPY,
  defaultPlanTitle,
  servicesForDiscipline,
  withDiscipline,
  withPriceMode,
  type PlanDraftErrors,
  type PlanEditorDraft,
  type PlanEditorOptions,
  type PlanPriceMode,
} from "@/lib/plan-editor-state";

export type PlanFormProps = {
  mode: "create" | "replan";
  draft: PlanEditorDraft;
  onChange: (next: PlanEditorDraft) => void;
  options: PlanEditorOptions;
  /** Errores a mostrar (cliente + `fieldErrors` del server). */
  errors: PlanDraftErrors;
  /** Sin `patientId` en las props del drawer: se elige acá. */
  needsPatient: boolean;
  /** `permissions.authorize`: bloque "Autorización de la obra social". */
  showAuthorization: boolean;
  /** Puerta Diagnóstico: "N ejercicios de <condición>" (solo lectura). */
  exercisesNote?: string | null;
  disabled?: boolean;
};

const PRICE_OPTIONS: ReadonlyArray<{ value: PlanPriceMode; label: string }> = [
  { value: "NONE", label: PLAN_EDITOR_COPY.priceNone },
  { value: "PER_SESSION", label: PLAN_EDITOR_COPY.pricePerSession },
  { value: "PACKAGE", label: PLAN_EDITOR_COPY.pricePackage },
];

const sectionLabel: CSSProperties = { fontSize: 12, fontWeight: 600, color: "var(--navy-500)" };
const errorText: CSSProperties = { margin: "4px 0 0", fontSize: 12, color: "#9F1F1F" };
const hintText: CSSProperties = { margin: "4px 0 0", fontSize: 12, color: "var(--navy-500)" };
const grid2: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 };

/** Segmentado accesible (radiogroup con flechas nativas de los radios). */
function Segmented<T extends string>({
  name,
  label,
  value,
  options,
  onChange,
  disabled,
  error,
}: {
  name: string;
  label: string;
  value: T | null;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
  disabled?: boolean;
  error?: string;
}) {
  return (
    <fieldset style={{ border: "none", margin: 0, padding: 0, minWidth: 0 }} aria-invalid={error ? true : undefined}>
      <legend style={{ ...sectionLabel, padding: 0, marginBottom: 6 }}>{label}</legend>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: 3, borderRadius: 14, background: "rgba(15,30,51,0.04)" }}>
        {options.map((o) => {
          const on = o.value === value;
          return (
            <label
              key={o.value}
              style={{
                position: "relative",
                flex: "1 1 auto",
                textAlign: "center",
                padding: "7px 12px",
                borderRadius: 11,
                fontSize: 13,
                fontWeight: 600,
                cursor: disabled ? "not-allowed" : "pointer",
                background: on ? "#fff" : "transparent",
                color: on ? "var(--navy-900)" : "var(--navy-500)",
                boxShadow: on ? "0 1px 3px rgba(15,30,51,0.12)" : undefined,
              }}
            >
              <input
                type="radio"
                name={name}
                value={o.value}
                checked={on}
                disabled={disabled}
                onChange={() => onChange(o.value)}
                style={{ position: "absolute", opacity: 0, width: 1, height: 1 }}
              />
              {o.label}
            </label>
          );
        })}
      </div>
      {error && (
        <p role="alert" style={errorText}>
          {error}
        </p>
      )}
    </fieldset>
  );
}

const intOrNull = (v: string): number | null => {
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isInteger(n) ? n : null;
};

export function PlanForm({ mode, draft, onChange, options, errors, needsPatient, showAuthorization, exercisesNote, disabled }: PlanFormProps) {
  const create = mode === "create";
  const { options: serviceOptions, untagged } = servicesForDiscipline(options.services, draft.discipline);
  const service = options.services.find((s) => s.id === draft.serviceId) ?? null;
  // Un servicio del plan que ya no está en la lista (borrado, otra disciplina) se sigue mostrando.
  const serviceSelect = [
    { value: "", label: draft.discipline || !create ? "Elegí un servicio" : "Elegí primero la disciplina" },
    ...serviceOptions.map((s) => ({ value: s.id, label: s.name })),
    ...(draft.serviceId && !serviceOptions.some((s) => s.id === draft.serviceId)
      ? [{ value: draft.serviceId, label: service?.name ?? "Servicio actual" }]
      : []),
  ];
  const set = (patch: Partial<PlanEditorDraft>) => onChange({ ...draft, ...patch });
  const auth = draft.authorization;
  const setAuth = (patch: Partial<PlanEditorDraft["authorization"]>) => set({ authorization: { ...auth, ...patch } });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
      {/* 1. Paciente */}
      {create && needsPatient && (
        <div>
          <PatientPicker requireFull label="Paciente" onChange={(p) => set({ patientId: p?.id ?? null })} />
          {errors.patientId && (
            <p role="alert" style={errorText}>
              {errors.patientId}
            </p>
          )}
        </div>
      )}

      {/* 2. Disciplina */}
      {create && (
        <Segmented<Discipline>
          name="plan-discipline"
          label="Disciplina"
          value={draft.discipline}
          options={DISCIPLINES.map((d) => ({ value: d, label: disciplineLabel(d) }))}
          onChange={(d) => onChange(withDiscipline(draft, d, options.services))}
          disabled={disabled}
          error={errors.discipline}
        />
      )}

      {/* 3. Servicio · 4. Profesional responsable */}
      <div style={grid2}>
        <div style={{ minWidth: 0 }}>
          <FormField
            as="select"
            label="Servicio"
            value={draft.serviceId ?? ""}
            onChange={(v) => set({ serviceId: v || null })}
            options={serviceSelect}
            error={errors.serviceId}
            disabled={disabled || (create && !draft.discipline)}
          />
          {untagged && draft.discipline && <p style={hintText}>{PLAN_EDITOR_COPY.serviceHint}</p>}
        </div>
        <FormField
          as="select"
          label="Profesional responsable"
          value={draft.practitionerId ?? ""}
          onChange={(v) => set({ practitionerId: v || null })}
          options={[{ value: "", label: "Elegí un profesional" }, ...options.practitioners.map((p) => ({ value: p.id, label: p.name }))]}
          error={errors.practitionerId}
          disabled={disabled}
        />
      </div>

      {/* 5. Sede · duración */}
      <div style={grid2}>
        <FormField
          as="select"
          label="Sede"
          value={draft.locationId ?? ""}
          onChange={(v) => set({ locationId: v || null })}
          options={[
            { value: "", label: "Según la agenda del profesional" },
            ...options.locations.map((l) => ({ value: l.id, label: l.isPrimary ? `${l.name} (principal)` : l.name })),
          ]}
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

      {/* 6. Inicio, cantidad y horario por día */}
      <div style={grid2}>
        <FormField
          type="date"
          label={create ? "Inicio" : "Desde"}
          value={draft.startDayKey}
          onChange={(v) => set({ startDayKey: v })}
          error={errors.startDayKey}
          disabled={disabled}
        />
        {create && (
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
        )}
      </div>
      <ScheduleSlotsEditor
        value={draft.schedule}
        onChange={(schedule) => set({ schedule })}
        error={errors.schedule ?? planScheduleError(draft.schedule)}
        idPrefix="plan"
        disabled={disabled}
      />

      {create && draft.fromBookingId && (
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, color: "var(--navy-900)" }}>
          <input
            type="checkbox"
            checked={draft.countBookingAsSession1}
            disabled={disabled}
            onChange={(e) => set({ countBookingAsSession1: e.target.checked })}
          />
          El turno de origen cuenta como la sesión 1
        </label>
      )}

      {/* 7. Precio */}
      {create && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Segmented<PlanPriceMode>
            name="plan-price"
            label="Precio"
            value={draft.priceMode}
            options={PRICE_OPTIONS}
            onChange={(m) => onChange(withPriceMode(draft, m, options.services))}
            disabled={disabled}
          />
          {draft.priceMode !== "NONE" && (
            <MoneyInput
              label={draft.priceMode === "PER_SESSION" ? "Precio por sesión" : "Precio total del paquete"}
              value={draft.priceCents}
              onChange={(cents) => set({ priceCents: cents })}
              error={errors.pricing}
              disabled={disabled}
            />
          )}
        </div>
      )}

      {/* Autorización de la OS (E2), opcional */}
      {create && showAuthorization && (
        <fieldset style={{ border: "1px solid rgba(15,30,51,0.1)", borderRadius: 14, padding: 12, margin: 0, minWidth: 0 }}>
          <legend style={{ ...sectionLabel, padding: "0 4px" }}>Autorización de la obra social</legend>
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, color: "var(--navy-900)" }}>
            <input
              type="checkbox"
              checked={auth.enabled}
              disabled={disabled}
              onChange={(e) => setAuth({ enabled: e.target.checked, startsOnDayKey: auth.startsOnDayKey || draft.startDayKey })}
            />
            Cargar la autorización
          </label>
          {auth.enabled && (
            <div style={{ ...grid2, marginTop: 10 }}>
              <FormField label="Código" value={auth.code} onChange={(v) => setAuth({ code: v })} disabled={disabled} placeholder="Opcional" />
              <FormField
                type="number"
                label="Sesiones autorizadas"
                min={1}
                max={200}
                value={auth.authorizedSessions ?? ""}
                onChange={(v) => setAuth({ authorizedSessions: intOrNull(v) })}
                error={errors.authorizedSessions}
                disabled={disabled}
              />
              <FormField
                type="date"
                label="Desde"
                value={auth.startsOnDayKey}
                onChange={(v) => setAuth({ startsOnDayKey: v })}
                error={errors.authStartsOn}
                disabled={disabled}
              />
              <FormField
                type="date"
                label="Vence"
                value={auth.expiresOnDayKey}
                onChange={(v) => setAuth({ expiresOnDayKey: v })}
                error={errors.authExpiresOn}
                disabled={disabled}
              />
            </div>
          )}
        </fieldset>
      )}

      {exercisesNote && <p style={hintText}>{exercisesNote}</p>}
      {errors.exercises && (
        <p role="alert" style={errorText}>
          {errors.exercises}
        </p>
      )}

      {/* 8. Título y notas */}
      {create && (
        <>
          <FormField
            label="Título"
            value={draft.title}
            onChange={(v) => set({ title: v })}
            placeholder={defaultPlanTitle(draft.discipline, Number.isFinite(draft.totalSessions) ? draft.totalSessions : 0)}
            disabled={disabled}
          />
          <FormField as="textarea" label="Notas" rows={3} value={draft.notes} onChange={(v) => set({ notes: v })} disabled={disabled} />
        </>
      )}
    </div>
  );
}
