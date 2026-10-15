"use client";

import { Button } from "@/components/ui/button";
import { useTenantModules } from "@/components/layout/tenant-modules-context";
import { PatientPicker, type PickedPatient } from "@/components/patients/patient-picker";
import { PLAN_PATIENT_CHANGE_ERROR } from "@/lib/bookings-constants";
import { ConflictBanner } from "./conflict-banner";
import { fieldLabel, miniGhostBtn } from "./styles";
import type { DrawerBooking, ForcePrompt } from "./types";

/**
 * S19d (C4 / I1): un turno de plan no cambia de paciente. El core lo rechaza
 * (`plan-patient-change` → `PLAN_PATIENT_CHANGE_ERROR`; la FK compuesta
 * `Booking_plan_patient_fkey` es la red), así que el picker no se ofrece: se
 * muestra el paciente y el mismo texto del server. Sin C9 (`programId`
 * ausente) el picker queda como siempre y el server sigue siendo la barrera.
 */
export function patientLockedByPlan(booking: Pick<DrawerBooking, "programId" | "patientId">): boolean {
  return !!booking.programId && !!booking.patientId;
}

/** Valores del formulario "Editar" (los guarda `index.tsx`). */
export type EditDetailsValues = {
  duration: number;
  title: string;
  description: string;
  notes: string;
};

/**
 * Formulario inline "Editar" del drawer: paciente, duración, título
 * (diagnóstico), descripción y notas.
 *
 * Contrato: controlado. Todo el estado vive en `index.tsx` (alimenta el
 * dirty-guard y el envío de SOLO lo que cambió, A2a-S06). Acá se presenta:
 * - `onPatientChange`: selección del picker (`null` = lo vació sin elegir otro).
 *   En un turno de plan no hay picker (`patientLockedByPlan`): nunca se llama.
 * - `onChange(patch)`: cambio de un campo.
 * - `onApplyAsPatientDiagnosis`: solo si el turno tiene paciente y
 *   `clinicalWritable`. Opcional: sin él (o sin el módulo `diagnostico`,
 *   Clínica general, EV1-C1) el botón no aparece.
 * - Sin el módulo `diagnostico` (Clínica general) título y descripción se
 *   rotulan «Motivo de consulta» / «Detalle»: son los mismos campos del turno,
 *   solo que ahí no hay diagnóstico del paciente que los autocomplete.
 * - `clinicalWritable` / `notesWritable` (P0-S07u, de `bookingDrawerAccess`):
 *   sin ellos título, descripción, "Usar como diagnóstico" y notas NO se
 *   renderizan. "Un campo se escribe si y solo si se puede leer" (E1): con los
 *   valores ocultos (null → "") mostrar el input invitaba a pisarlos, y "Usar
 *   como diagnóstico" borraba el diagnóstico del paciente. La Secretaria sigue
 *   pudiendo cambiar paciente y duración (eso es operar).
 * - `onSubmit` / `onForce`: guardar y reintentar con el flag del aviso
 *   (sobreturno, bloqueo o fuera de horario; B5.7). Un turno más largo no
 *   tiene "próximo libre": el banner no ofrece moverlo.
 */
export function EditDetailsForm({
  booking,
  clinicalWritable,
  notesWritable,
  values,
  pending,
  conflict,
  onPatientChange,
  onChange,
  onApplyAsPatientDiagnosis,
  onSubmit,
  onForce,
  onDismissConflict,
}: {
  booking: DrawerBooking;
  clinicalWritable: boolean;
  notesWritable: boolean;
  values: EditDetailsValues;
  pending: boolean;
  conflict: ForcePrompt | null;
  onPatientChange: (p: PickedPatient | null) => void;
  onChange: (patch: Partial<EditDetailsValues>) => void;
  onApplyAsPatientDiagnosis?: () => void;
  onSubmit: () => void;
  onForce: () => void;
  onDismissConflict: () => void;
}) {
  const diagnostico = useTenantModules().has("diagnostico");
  return (
    <div
      style={{
        padding: 14,
        borderRadius: 14,
        background: "rgba(200,245,100,0.08)",
        border: "1px solid rgba(200,245,100,0.4)",
        display: "grid",
        gap: 10,
      }}
    >
      {/* Patient picker — initialPatientId comes from the
          current booking so the row shows "selected" first.
          Clearing replaces with a search input; user can pick
          a different patient or create one inline (firstName +
          lastName fields). */}
      {patientLockedByPlan(booking) ? (
        <div style={{ display: "grid", gap: 4 }}>
          <span style={fieldLabel}>Paciente del turno</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--navy-900)" }}>{booking.patientName}</span>
          <span style={{ fontSize: 11.5, color: "var(--navy-500)" }}>{PLAN_PATIENT_CHANGE_ERROR}</span>
        </div>
      ) : (
        <PatientPicker
          label="Paciente del turno"
          initialPatientId={booking.patientId ?? null}
          initialPatients={
            booking.patientId
              ? [{ id: booking.patientId, name: booking.patientName }]
              : []
          }
          onChange={onPatientChange}
        />
      )}
      <label style={fieldLabel}>Duración (min)</label>
      <input
        type="number"
        min={15}
        max={240}
        step={15}
        value={values.duration}
        onChange={(e) => onChange({ duration: Number(e.target.value) })}
        style={{
          padding: "10px 12px",
          borderRadius: 10,
          border: "1px solid rgba(15,30,51,0.1)",
          background: "#fff",
          fontSize: 13,
          width: 120,
        }}
      />
      {clinicalWritable && (
        <>
          <label style={fieldLabel}>{diagnostico ? "Título (diagnóstico)" : "Motivo de consulta"}</label>
          <input
            type="text"
            maxLength={80}
            value={values.title}
            onChange={(e) => onChange({ title: e.target.value })}
            placeholder={diagnostico ? "ej: Lumbalgia — se autocompleta del paciente" : "ej: Control anual"}
            style={{
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid rgba(15,30,51,0.1)",
              background: "#fff",
              fontSize: 13,
            }}
          />
          <label style={fieldLabel}>{diagnostico ? "Descripción" : "Detalle"}</label>
          <textarea
            value={values.description}
            onChange={(e) => onChange({ description: e.target.value })}
            rows={2}
            placeholder={diagnostico ? "Detalle del diagnóstico para este turno…" : "Detalle del motivo de consulta…"}
            style={{
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid rgba(15,30,51,0.1)",
              background: "#fff",
              fontSize: 13,
              resize: "vertical",
              fontFamily: "inherit",
            }}
          />
          {diagnostico && booking.patientId && onApplyAsPatientDiagnosis && (
            <button
              type="button"
              onClick={onApplyAsPatientDiagnosis}
              disabled={pending}
              style={{ ...miniGhostBtn, alignSelf: "flex-start" }}
              title="Guardar este título y descripción como el diagnóstico del paciente (se aplica a sus turnos futuros)"
            >
              Usar como diagnóstico del paciente
            </button>
          )}
        </>
      )}
      {notesWritable && (
        <>
          <label style={fieldLabel}>Notas</label>
          <textarea
            value={values.notes}
            onChange={(e) => onChange({ notes: e.target.value })}
            rows={3}
            placeholder="Observaciones del turno…"
            style={{
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid rgba(15,30,51,0.1)",
              background: "#fff",
              fontSize: 13,
              resize: "vertical",
              fontFamily: "inherit",
            }}
          />
        </>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Button
          variant="primary"
          onClick={onSubmit}
          disabled={pending}
          style={{ fontSize: 12, padding: "8px 14px" }}
        >
          {pending ? "Guardando…" : "Guardar cambios"}
        </Button>
      </div>
      {conflict && (
        <ConflictBanner
          prompt={conflict}
          action="edit"
          pending={pending}
          // A longer turno can't "move" to the next free slot: the
          // only choices are to force it or go back.
          onForce={onForce}
          onBack={onDismissConflict}
        />
      )}
    </div>
  );
}
