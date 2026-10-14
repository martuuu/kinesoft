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

/**
 * IAM-4b: profesional inicial del turno nuevo. El default (columna, chip o el
 * profesional del usuario) si está en la lista; si no, el ÚNICO profesional
 * (no hay nada que elegir); con varios, ninguno: obliga a elegir. Antes caía
 * en silencio al primero de la lista, y la Secretaria (sin profesional propio
 * desde IAM-4a) le cargaba el turno a cualquiera. La lista ya viene filtrada a
 * los reservables (`listPractitioners`, IAM-2e).
 */
export function initialPractitionerId(
  defaultId: string | null | undefined,
  practitioners: ReadonlyArray<{ id: string }>
): string {
  if (defaultId && practitioners.some((p) => p.id === defaultId)) return defaultId;
  return practitioners.length === 1 ? practitioners[0].id : "";
}

export const NO_BOOKABLE_PRACTITIONERS_COPY =
  "No hay profesionales con agenda en este consultorio. Sumá uno desde Configuración → Usuarios.";

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
        {/* IAM-4b: placeholder solo sin elegir (con uno elegido, el markup de siempre). */}
        {practitionerId === "" && (
          <option value="" disabled>
            — Elegí un profesional —
          </option>
        )}
        {practitioners.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </Select>
      {practitioners.length === 0 && (
        <div role="status" style={{ fontSize: 12, color: "var(--navy-500)" }}>
          {NO_BOOKABLE_PRACTITIONERS_COPY}
        </div>
      )}
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
