"use client";

import { Button } from "@/components/ui/button";
import { PatientPicker, type PickedPatient } from "@/components/patients/patient-picker";
import { ConflictBanner } from "./conflict-banner";
import { fieldLabel, miniGhostBtn } from "./styles";
import type { DrawerBooking, ForcePrompt } from "./types";

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
 * - `onChange(patch)`: cambio de un campo.
 * - `onApplyAsPatientDiagnosis`: solo si el turno tiene paciente.
 * - `onSubmit` / `onForce`: guardar y reintentar con el flag del aviso
 *   (sobreturno, bloqueo o fuera de horario; B5.7). Un turno más largo no
 *   tiene "próximo libre": el banner no ofrece moverlo.
 */
export function EditDetailsForm({
  booking,
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
  values: EditDetailsValues;
  pending: boolean;
  conflict: ForcePrompt | null;
  onPatientChange: (p: PickedPatient | null) => void;
  onChange: (patch: Partial<EditDetailsValues>) => void;
  onApplyAsPatientDiagnosis: () => void;
  onSubmit: () => void;
  onForce: () => void;
  onDismissConflict: () => void;
}) {
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
      <label style={fieldLabel}>Título (diagnóstico)</label>
      <input
        type="text"
        maxLength={80}
        value={values.title}
        onChange={(e) => onChange({ title: e.target.value })}
        placeholder="ej: Lumbalgia — se autocompleta del paciente"
        style={{
          padding: "10px 12px",
          borderRadius: 10,
          border: "1px solid rgba(15,30,51,0.1)",
          background: "#fff",
          fontSize: 13,
        }}
      />
      <label style={fieldLabel}>Descripción</label>
      <textarea
        value={values.description}
        onChange={(e) => onChange({ description: e.target.value })}
        rows={2}
        placeholder="Detalle del diagnóstico para este turno…"
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
      {booking.patientId && (
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
