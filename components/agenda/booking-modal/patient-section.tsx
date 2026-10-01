"use client";

/**
 * Paciente del turno nuevo: picker de pacientes existentes o, con el switch
 * «Nuevo paciente», el alta inline (nombre, apellido, DNI, teléfono, obra
 * social). Los inputs del alta inline son no controlados (`newFirstName`…):
 * los lee `submit` de `index.tsx` del FormData. La obra social es controlada
 * y vive en `index` porque entra en la foto del dirty-guard.
 */
import { FormField } from "@/components/ui/form-field";
import { PatientPicker } from "@/components/patients/patient-picker";
import type { InsurerOption, PatientOption, PatientRef } from "./types";

export function PatientSection({
  isGuest,
  onToggleGuest,
  createdPatient,
  inlineErrors,
  insurers,
  newCoverage,
  onNewCoverageChange,
  newOtherInsurer,
  onNewOtherInsurerChange,
  selectedPatient,
  patients,
  onPatientChange,
}: {
  /** Switch «Nuevo paciente». */
  isGuest: boolean;
  onToggleGuest: () => void;
  /** Ficha ya creada en un intento anterior: se reusa y no se muestran los campos. */
  createdPatient: PatientRef | null;
  /** Errores por input del alta inline (`newFirstName`, `newDocumentId`, …). */
  inlineErrors: Record<string, string>;
  insurers: InsurerOption[];
  /** "particular" | "ins:<id>" | "other". */
  newCoverage: string;
  onNewCoverageChange: (v: string) => void;
  newOtherInsurer: string;
  onNewOtherInsurerChange: (v: string) => void;
  selectedPatient: PatientRef | null;
  patients: PatientOption[];
  onPatientChange: (p: PatientRef | null) => void;
}) {
  return (
    <div>
      {/* Single row: "Paciente *" label on the left, toggle on the right */}
      <label
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--navy-500)" }}>Paciente</span>
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            fontWeight: 600,
            color: isGuest ? "var(--sky-700)" : "var(--navy-400)",
          }}
        >
          Nuevo paciente
          <span
            onClick={onToggleGuest}
            role="switch"
            aria-checked={isGuest}
            tabIndex={0}
            onKeyDown={(e) => e.key === " " && onToggleGuest()}
            style={{
              display: "inline-flex",
              width: 36,
              height: 20,
              borderRadius: 10,
              background: isGuest ? "var(--sky-700)" : "rgba(15,30,51,0.15)",
              position: "relative",
              cursor: "pointer",
              transition: "background 0.15s",
              flexShrink: 0,
            }}
          >
            <span
              style={{
                position: "absolute",
                top: 2,
                left: isGuest ? 18 : 2,
                width: 16,
                height: 16,
                borderRadius: "50%",
                background: "#fff",
                boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
                transition: "left 0.15s",
              }}
            />
          </span>
        </span>
      </label>
      {isGuest && createdPatient ? (
        // La ficha ya se creó en un intento anterior: se reusa (ver
        // `createdPatient` en index.tsx). Los campos no se muestran para que
        // no parezca que editarlos cambia la ficha ya guardada.
        <div
          role="status"
          style={{
            padding: "10px 12px",
            borderRadius: 12,
            background: "rgba(54,179,126,0.1)",
            border: "1px solid rgba(54,179,126,0.35)",
            fontSize: 12.5,
            color: "var(--navy-700)",
            lineHeight: 1.45,
          }}
        >
          Ya registramos a <b>{createdPatient.name}</b>. El turno se crea para esa ficha;
          los datos se corrigen después desde su perfil.
        </div>
      ) : isGuest ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <FormField label="Nombre" name="newFirstName" required error={inlineErrors.newFirstName} />
          <FormField label="Apellido" name="newLastName" required error={inlineErrors.newLastName} />
          <FormField label="DNI" name="newDocumentId" required error={inlineErrors.newDocumentId} />
          <FormField label="Teléfono" name="newPhone" error={inlineErrors.newPhone} />
          <div style={{ gridColumn: "1 / -1" }}>
            <FormField
              as="select"
              label="Obra social"
              value={newCoverage}
              onChange={(v) => onNewCoverageChange(v)}
              options={[
                { value: "particular", label: "Particular (sin cobertura)" },
                ...insurers.map((i) => ({ value: `ins:${i.id}`, label: i.name })),
                { value: "other", label: "Otra (escribir manualmente)" },
              ]}
            />
          </div>
          {newCoverage === "other" && (
            <div style={{ gridColumn: "1 / -1" }}>
              <FormField
                label="Nombre de la obra social"
                value={newOtherInsurer}
                onChange={(v) => onNewOtherInsurerChange(v)}
                placeholder="Ej: PAMI, IOSFA…"
              />
            </div>
          )}
        </div>
      ) : (
        <PatientPicker
          name="patientId"
          label={null}
          // Al volver de «Nuevo paciente» el picker se re-monta: que
          // arranque con el paciente que ya estaba elegido (y cuyo
          // copago se muestra), no con el del deep-link.
          initialPatientId={selectedPatient?.id ?? null}
          initialPatients={selectedPatient ? [selectedPatient, ...patients] : patients}
          onChange={onPatientChange}
        />
      )}
    </div>
  );
}
