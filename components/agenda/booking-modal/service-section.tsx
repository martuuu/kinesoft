"use client";

/**
 * Profesional + Servicio del turno nuevo. Los dos son CONTROLADOS (B5.1):
 * el profesional elegido filtra los servicios (los habilitados para él, vía
 * `enabledServiceIds` de la disponibilidad de la agenda) y alimenta el
 * SlotPicker, el modo Sesiones y el chequeo en vivo, así que su valor vive en
 * `index.tsx`. Los `name` (`practitionerId`, `serviceId`) se mantienen: el
 * dirty-guard toma la foto de los inputs con `name`.
 *
 * Aviso "No atiende este servicio": sale de `serviceEnabled` (el mapa o el
 * chequeo en vivo `classifyBookingInstant`). Es un aviso, no un bloqueo: el
 * server rechaza el alta con el PractitionerService deshabilitado (contrato
 * post-B3.1) y el mensaje llega igual por el error del submit.
 */
import { Select } from "../controls";
import type { PractitionerOption, ServiceOption } from "./types";

export function ServiceSection({
  practitioners,
  practitionerId,
  onPractitionerChange,
  services,
  serviceId,
  onServiceChange,
  serviceEnabled,
  durationHint,
}: {
  practitioners: PractitionerOption[];
  practitionerId: string;
  onPractitionerChange: (id: string) => void;
  /** Ya filtrados por profesional (`servicesForPractitioner`). */
  services: ServiceOption[];
  serviceId: string;
  onServiceChange: (id: string) => void;
  /** false = el profesional no tiene habilitado el servicio elegido; null = no se sabe. */
  serviceEnabled: boolean | null;
  /** Duración del profesional para el servicio, si difiere de la del servicio ("45m"). */
  durationHint?: number | null;
}) {
  const practitionerName = practitioners.find((p) => p.id === practitionerId)?.name ?? "El profesional";
  return (
    <>
      <Select
        label="Profesional"
        name="practitionerId"
        required
        value={practitionerId}
        onChange={onPractitionerChange}
      >
        {practitioners.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </Select>
      <div style={{ display: "grid", gap: 4 }}>
        <Select
          label="Servicio"
          name="serviceId"
          required
          value={serviceId}
          onChange={onServiceChange}
        >
          <option value="" disabled>
            {services.length === 0 ? "— Este profesional no tiene servicios habilitados —" : "— Seleccioná un servicio —"}
          </option>
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} · {s.id === serviceId && durationHint ? durationHint : s.durationMin}m
            </option>
          ))}
        </Select>
        {serviceId && serviceEnabled === false && (
          <div
            role="status"
            style={{
              fontSize: 11.5,
              color: "#7A4A00",
              background: "rgba(255,176,32,0.14)",
              border: "1px solid rgba(255,176,32,0.45)",
              borderRadius: 10,
              padding: "6px 10px",
            }}
          >
            {practitionerName} no atiende este servicio. Elegí otro servicio u otro profesional
            (se habilita en Configuración → Profesionales).
          </div>
        )}
      </div>
    </>
  );
}
