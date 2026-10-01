"use client";

/**
 * Sede + telemedicina del turno nuevo (B5.1).
 *
 * - Sede: solo con más de una sede activa (`showLocationPicker`). Default
 *   "Según el horario del profesional" (`""` → no se manda `locationId` y el
 *   server toma la sede de la franja que contiene el turno, o la principal;
 *   `defaultLocationFor` en `lib/bookings.ts`). Con una sola sede no hay nada
 *   que elegir y no se muestra.
 * - Telemedicina (decisión 9: URL por turno): switch + link opcional. El link
 *   se valida igual que el zod del server (https, ≤ 500; `telemedicineUrlError`)
 *   para avisar antes de enviar; vacío está bien (se puede cargar después
 *   desde el turno). El default por profesional y el envío al paciente son C1.
 *
 * Controlado: el estado vive en `index.tsx` (entra en el payload y en el
 * dirty-guard). Los inputs llevan `name` para la foto del dirty-guard.
 */
import { FormField } from "@/components/ui/form-field";
import { Select } from "../controls";
import { showLocationPicker, type ModalLocation } from "@/lib/booking-modal-state";

export function TelemedicineSection({
  locations,
  locationId,
  onLocationChange,
  isTelemedicine,
  onTelemedicineChange,
  telemedicineUrl,
  onTelemedicineUrlChange,
  urlError,
}: {
  locations?: ModalLocation[] | null;
  /** "" = según el horario del profesional. */
  locationId: string;
  onLocationChange: (id: string) => void;
  isTelemedicine: boolean;
  onTelemedicineChange: (on: boolean) => void;
  telemedicineUrl: string;
  onTelemedicineUrlChange: (url: string) => void;
  /** Error de validación del link (se muestra recién al intentar enviar o al salir del campo). */
  urlError?: string | null;
}) {
  return (
    <>
      {showLocationPicker(locations) && (
        <Select label="Sede" name="locationId" value={locationId} onChange={onLocationChange}>
          <option value="">Según el horario del profesional</option>
          {locations!.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
              {l.isPrimary ? " (principal)" : ""}
            </option>
          ))}
        </Select>
      )}

      <label
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 12px",
          borderRadius: 12,
          background: isTelemedicine ? "rgba(31,79,190,0.06)" : "rgba(15,30,51,0.03)",
          border: "1px solid " + (isTelemedicine ? "rgba(31,79,190,0.2)" : "rgba(15,30,51,0.06)"),
          cursor: "pointer",
        }}
      >
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Telemedicina</div>
          <div style={{ fontSize: 11, color: "var(--navy-500)" }}>
            Consulta por videollamada. El link se puede cargar ahora o después, desde el turno.
          </div>
        </div>
        <input
          type="checkbox"
          name="isTelemedicine"
          checked={isTelemedicine}
          onChange={(e) => onTelemedicineChange(e.target.checked)}
        />
      </label>

      {isTelemedicine && (
        <FormField
          label="Link de la videollamada"
          name="telemedicineUrl"
          type="text"
          placeholder="https://meet.google.com/…"
          value={telemedicineUrl}
          onChange={onTelemedicineUrlChange}
          error={urlError ?? undefined}
          hint={urlError ? undefined : "Opcional · tiene que empezar con https://"}
        />
      )}
    </>
  );
}
