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
 */
import type { RecurrencePreview } from "@/lib/availability-actions-types";
import type { Frequency } from "@/lib/availability/types";
import {
  SESSIONS_UI_MAX_COUNT,
  normalizeSessionsValue,
  type SessionsValue,
} from "@/lib/sessions-mode-state";
import { SessionsMode } from "./sessions-mode";

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
}) {
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
            <div style={{ fontSize: 13, fontWeight: 600 }}>Varias sesiones</div>
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
        />
      )}
    </>
  );
}
