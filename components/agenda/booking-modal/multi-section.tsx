"use client";

/**
 * «Varias sesiones» (antes «Múltiples turnos»): switch + `SessionsMode`
 * (cantidad, frecuencia, días, resumen y preview por fecha). Crea N turnos
 * sueltos (NO un plan/TreatmentProgram); el preflight y la creación los
 * resuelve `submit` en `index.tsx` con `createBookingsBatch`.
 *
 * Cambio de props en B5.3 (MOD-sessions), compatible con el `index.tsx` de
 * antes — todo lo nuevo es opcional:
 *   • Se mantienen `multiTurno`/`onMultiTurnoChange`, `count`/`onCountChange`,
 *     `weekdays`/`onWeekdaysChange` (0=Lun..6=Dom). OJO: `onCountChange` ahora
 *     recibe 1..20 (tope de la UI, `SESSIONS_UI_MAX_COUNT`), antes 1..60; el
 *     server sigue aceptando 60.
 *   • `frequency` + `onFrequencyChange`: solo si vienen los DOS se muestra el
 *     selector Semanal / Cada 2 semanas / Mensual. Sin ellos la frecuencia es
 *     "weekly" fija (lo que el batch hace sin `frequency`), así el preview no
 *     promete algo distinto de lo que se crea. Con ellos, `index.tsx` tiene
 *     que mandar `frequency` en el payload del batch (`toBatchFields`).
 *   • `anchorIso`, `practitionerId`, `serviceId`, `patientId` (+ `durationMin`,
 *     `locationId`): habilitan el preview por fecha (`previewRecurrence`). Sin
 *     profesional/servicio/fecha se muestra solo el resumen local.
 *   • `onPreview`: el último preview vigente (o null), por si el padre quiere
 *     usarlo (p. ej. el texto del botón).
 *   • `hideToggle`: cuando el modo lo elige el selector «Turno · Varias
 *     sesiones · Bloquear horario» de B5.1, no hace falta el switch; el padre
 *     monta esta sección solo en ese modo y con `multiTurno` en true.
 *
 * S18b (ES3, PD-11 · §14.1 "puerta liviana"): "Varias sesiones" SIGUE creando
 * turnos sueltos y suma el link "Crealo como plan…", que NAVEGA al perfil del
 * paciente con el editor abierto y prellenado (`planDeepLinkHref` de
 * `lib/plans-deeplink.ts`, contrato C10). El editor NO se monta acá: lo monta
 * el shell del perfil (S22b). Props nuevas, opcionales y que fallan cerrado:
 *   • `capabilities`: sin `plans.manage` (la Secretaria, PD-13) no se ve. Sin
 *     capabilities (no llegaron) tampoco.
 *   • `patientUnsaved`: alta inline todavía sin guardar → el link queda
 *     deshabilitado con un hint (no hay a qué perfil navegar).
 * El módulo se lee de `useTenantModules().has('planes')`: en un consultorio
 * General no aparece (enmienda EV0 de S18b).
 */
import { useRouter } from "next/navigation";
import { useId } from "react";
import { useTenantModules } from "@/components/layout/tenant-modules-context";
import { Button } from "@/components/ui/button";
import type { RecurrencePreview } from "@/lib/availability-actions-types";
import type { Frequency } from "@/lib/availability/types";
import { capabilitySet } from "@/lib/agenda-client-state";
import { planScheduleFromBatch } from "@/lib/plan-schedule";
import { PlanEditorPrefillSchema, planDeepLinkHref, type PlanEditorPrefill } from "@/lib/plans-deeplink";
import {
  SESSIONS_UI_MAX_COUNT,
  normalizeSessionsValue,
  type SessionsValue,
} from "@/lib/sessions-mode-state";
import { bookingModalModeLabel } from "@/lib/booking-modal-state";
import { SessionsMode } from "./sessions-mode";

// ─── "Crealo como plan…" (puro, testeado en tests/unit/render/multi-plan-link) ─

/** Lo cargado en "Varias sesiones" que pasa al editor del plan. */
export type CreateAsPlanInput = {
  /** Primera sesión, ISO con zona. "" = sin fecha todavía. */
  anchorIso: string;
  practitionerId: string;
  serviceId: string | null;
  /** "" / null = según el horario del profesional (el editor elige). */
  locationId?: string | null;
  /** Solo si el usuario la tocó; si no, el editor toma la del profesional. */
  durationMin?: number | null;
  value: SessionsValue;
};

/**
 * Prefill del editor (C10) con lo cargado: servicio, profesional, sede,
 * duración, día de inicio, cantidad y horario (días + hora + frecuencia, vía
 * `planScheduleFromBatch`, la única conversión 0=Lun → 0=Dom). Sin texto
 * libre: título y notas NO viajan en la URL (historial, logs, Referer).
 *
 * Cada campo se valida por separado contra `PlanEditorPrefillSchema`: uno
 * inválido (p. ej. una duración fuera de 15–240 tipeada a mano) se descarta y
 * el resto viaja igual, en vez de perder todo el prefill.
 */
export function createAsPlanPrefill(q: CreateAsPlanInput): PlanEditorPrefill {
  const raw: Record<string, unknown> = {
    serviceId: q.serviceId || undefined,
    practitionerId: q.practitionerId || undefined,
    locationId: q.locationId || undefined,
    durationMin: q.durationMin ?? undefined,
    totalSessions: q.value.count,
  };
  const anchor = q.anchorIso ? new Date(q.anchorIso) : null;
  if (anchor && !Number.isNaN(anchor.getTime())) {
    const { schedule, startDayKey } = planScheduleFromBatch({
      anchor,
      daysOfWeek: q.value.daysOfWeek,
      frequency: q.value.frequency,
    });
    raw.schedule = schedule;
    raw.startDayKey = startDayKey;
  }
  const shape = PlanEditorPrefillSchema.shape;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    const field = shape[k as keyof typeof shape];
    const parsed = field.safeParse(v);
    if (parsed.success && parsed.data !== undefined) out[k] = parsed.data;
  }
  return out as PlanEditorPrefill;
}

export const CREATE_AS_PLAN_LABEL = "Crealo como plan…";
export const CREATE_AS_PLAN_HINT = {
  // C10 literal (PLANES §C10, "Desde el modal, sin paciente guardado").
  unsaved: "Guardá el paciente para armar un plan",
  noPatient: "Elegí un paciente para crearlo como plan.",
  broken: "No pudimos pasar estos datos al plan. Revisá la fecha y la cantidad.",
  ready: "Abre el perfil del paciente con el plan prellenado. No se crea ningún turno acá.",
} as const;

export type CreateAsPlanState =
  | { kind: "hidden" }
  | { kind: "disabled"; hint: string }
  | { kind: "ready"; href: string; hint: string };

/**
 * Qué muestra la puerta. Oculta sin módulo `planes` o sin `plans.manage`
 * (la Secretaria agenda sesiones pero no crea planes, PD-13). Deshabilitada
 * con hint si no hay paciente guardado o si el link no se puede armar (nunca
 * navega a un link que el perfil después tiraría).
 */
export function createAsPlanState(
  q: CreateAsPlanInput & {
    planesEnabled: boolean;
    capabilities: readonly string[] | null | undefined;
    patientId: string | null;
    patientUnsaved?: boolean;
  }
): CreateAsPlanState {
  if (!q.planesEnabled || !capabilitySet(q.capabilities).has("plans.manage")) return { kind: "hidden" };
  if (q.patientUnsaved) return { kind: "disabled", hint: CREATE_AS_PLAN_HINT.unsaved };
  if (!q.patientId) return { kind: "disabled", hint: CREATE_AS_PLAN_HINT.noPatient };
  const href = planDeepLinkHref({ kind: "new", patientId: q.patientId, prefill: createAsPlanPrefill(q) });
  if (!href) return { kind: "disabled", hint: CREATE_AS_PLAN_HINT.broken };
  return { kind: "ready", href, hint: CREATE_AS_PLAN_HINT.ready };
}

/**
 * El link en sí. Botón (no `<a>`) porque navega con el router del App Router
 * y un `<a>` no se puede deshabilitar. El motivo va como texto visible al
 * lado (`aria-describedby`), no en un `title`: se lee sin hover y en mobile.
 * Navegar descarta el modal sin el dirty-guard a propósito: lo cargado viaja
 * en el prefill (lo único que no viaja es el texto libre, que el editor pide).
 */
export function CreateAsPlanLink({ state }: { state: CreateAsPlanState }) {
  const router = useRouter();
  const hintId = useId();
  if (state.kind === "hidden") return null;
  return (
    <div
      data-testid="create-as-plan"
      style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}
    >
      <Button
        type="button"
        variant="ghost"
        disabled={state.kind === "disabled"}
        aria-describedby={hintId}
        onClick={() => {
          if (state.kind === "ready") router.push(state.href);
        }}
      >
        {CREATE_AS_PLAN_LABEL}
      </Button>
      <span id={hintId} style={{ fontSize: 11, color: "var(--navy-500)", flex: "1 1 200px", minWidth: 0 }}>
        {state.hint}
      </span>
    </div>
  );
}

export function MultiSection({
  multiTurno,
  onMultiTurnoChange,
  count,
  onCountChange,
  weekdays,
  onWeekdaysChange,
  frequency,
  onFrequencyChange,
  anchorIso = "",
  practitionerId = "",
  serviceId = null,
  patientId = null,
  durationMin,
  locationId,
  onPreview,
  hideToggle = false,
  capabilities,
  patientUnsaved = false,
}: {
  multiTurno: boolean;
  onMultiTurnoChange: (on: boolean) => void;
  count: number;
  /** Recibe el valor ya acotado a 1–20 (`SESSIONS_UI_MAX_COUNT`). */
  onCountChange: (n: number) => void;
  /** 0=Lun..6=Dom. Vacío = mismo día de la semana del turno. */
  weekdays: number[];
  onWeekdaysChange: (days: number[]) => void;
  frequency?: Frequency;
  onFrequencyChange?: (f: Frequency) => void;
  /** Primera sesión, ISO con zona (`localToARIso` del datetime-local). */
  anchorIso?: string;
  practitionerId?: string;
  serviceId?: string | null;
  patientId?: string | null;
  durationMin?: number | null;
  locationId?: string | null;
  onPreview?: (p: RecurrencePreview | null) => void;
  hideToggle?: boolean;
  /** Capabilities del actor (las mismas que recibe el modal). Sin ellas, sin puerta. */
  capabilities?: readonly string[] | null;
  /** Alta inline («Nuevo paciente») todavía sin guardar. */
  patientUnsaved?: boolean;
}) {
  const modules = useTenantModules();
  const frequencyControlled =
    frequency !== undefined && onFrequencyChange !== undefined;
  const value = normalizeSessionsValue({
    count,
    daysOfWeek: weekdays,
    frequency: frequencyControlled ? frequency : "weekly",
  });

  const handleChange = (v: SessionsValue) => {
    if (v.count !== value.count) onCountChange(v.count);
    if (v.daysOfWeek.join(",") !== value.daysOfWeek.join(","))
      onWeekdaysChange(v.daysOfWeek);
    if (frequencyControlled && v.frequency !== value.frequency)
      onFrequencyChange!(v.frequency);
  };

  const on = hideToggle || multiTurno;

  return (
    <>
      {!hideToggle && (
        <label
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "10px 12px",
            borderRadius: 12,
            background: multiTurno
              ? "rgba(31,79,190,0.06)"
              : "rgba(15,30,51,0.03)",
            border:
              "1px solid " +
              (multiTurno ? "rgba(31,79,190,0.2)" : "rgba(15,30,51,0.06)"),
            cursor: "pointer",
          }}
        >
          <div>
            {/* EV1-C1: «Varios turnos» en Clínica general (sin `sesiones`). */}
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              {bookingModalModeLabel("sessions", modules.has)}
            </div>
            <div style={{ fontSize: 11, color: "var(--navy-500)" }}>
              Crea hasta {SESSIONS_UI_MAX_COUNT} turnos sueltos con la
              frecuencia que elijas. Con un solo turno, dejalo apagado.
            </div>
          </div>
          <input
            type="checkbox"
            checked={multiTurno}
            onChange={(e) => onMultiTurnoChange(e.target.checked)}
          />
        </label>
      )}

      {on && (
        <SessionsMode
          anchorIso={anchorIso}
          practitionerId={practitionerId}
          serviceId={serviceId}
          patientId={patientId}
          durationMin={durationMin}
          locationId={locationId}
          value={value}
          onChange={handleChange}
          onPreview={onPreview}
          showFrequency={frequencyControlled}
          footer={
            <CreateAsPlanLink
              state={createAsPlanState({
                planesEnabled: modules.has("planes"),
                capabilities,
                patientId,
                patientUnsaved,
                anchorIso,
                practitionerId,
                serviceId,
                locationId,
                durationMin,
                value,
              })}
            />
          }
        />
      )}
    </>
  );
}
