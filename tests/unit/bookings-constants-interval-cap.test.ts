/**
 * [AS-2w] T3d-2w (C-AS3): copy del rechazo por tope y su reconocedor (Seguimiento solo recibe el texto).
 */
import { describe, it, expect } from "vitest";
import { INTERVAL_CAP_ERROR, PRACTITIONER_CONFLICT_ERROR, isIntervalCapError } from "@/lib/bookings-constants";

describe("[AS-2w] INTERVAL_CAP_ERROR", () => {
  it("copy literal de C-AS3, con y sin nombre, singular y plural", () => {
    expect(INTERVAL_CAP_ERROR({ practitionerName: "Ana Paz", used: 2, cap: 2, fromTime: "10:00", toTime: "10:15" })).toBe(
      "Ana Paz ya tiene 2 turnos entre las 10:00 y las 10:15 (tope: 2)."
    );
    expect(INTERVAL_CAP_ERROR({ used: 1, cap: 1, fromTime: "23:00", toTime: "00:00" })).toBe(
      "El profesional ya tiene 1 turno entre las 23:00 y las 00:00 (tope: 1)."
    );
  });

  it("isIntervalCapError reconoce el texto por su forma y no confunde otros rechazos", () => {
    expect(isIntervalCapError(INTERVAL_CAP_ERROR({ used: 3, cap: 2, fromTime: "09:30", toTime: "10:00" }))).toBe(true);
    expect(isIntervalCapError(INTERVAL_CAP_ERROR({ practitionerName: "Dr. X (Kine)", used: 12, cap: 10, fromTime: "09:00", toTime: "10:00" }))).toBe(true);
    expect(isIntervalCapError(PRACTITIONER_CONFLICT_ERROR)).toBe(false);
    expect(isIntervalCapError("")).toBe(false);
    expect(isIntervalCapError(null)).toBe(false);
    expect(isIntervalCapError(undefined)).toBe(false);
  });
});
