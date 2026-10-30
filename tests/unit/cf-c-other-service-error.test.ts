import { describe, expect, it } from "vitest";
import { INTERVAL_CAP_ERROR, OTHER_SERVICE_ERROR, PRACTITIONER_CONFLICT_ERROR, isOtherServiceError } from "@/lib/bookings-constants";

// CF-D4: Lote y Planes solo reciben el texto del rechazo (sin el objeto del aviso); lo reconocen por su forma para
// ofrecer «como sobreturno», igual que `isIntervalCapError`.
describe("[CF-C3] OTHER_SERVICE_ERROR / isOtherServiceError", () => {
  it("texto con y sin servicio / profesional", () => {
    expect(OTHER_SERVICE_ERROR({ practitionerName: "Ana", serviceName: "Osteopatía" })).toBe(
      "Ana está atendiendo «Osteopatía» en ese horario."
    );
    expect(OTHER_SERVICE_ERROR({ practitionerName: "Ana", serviceName: null })).toBe(
      "Ana está atendiendo otro servicio en ese horario."
    );
    expect(OTHER_SERVICE_ERROR({})).toBe("El profesional está atendiendo otro servicio en ese horario.");
  });

  it("reconoce sus textos y no otros", () => {
    expect(isOtherServiceError(OTHER_SERVICE_ERROR({ practitionerName: "Ana", serviceName: "Kine «A»" }))).toBe(true);
    expect(isOtherServiceError(OTHER_SERVICE_ERROR({}))).toBe(true);
    expect(isOtherServiceError(PRACTITIONER_CONFLICT_ERROR)).toBe(false);
    expect(
      isOtherServiceError(INTERVAL_CAP_ERROR({ practitionerName: "Ana", used: 2, cap: 2, fromTime: "10:00", toTime: "11:00" }))
    ).toBe(false);
    expect(isOtherServiceError(null)).toBe(false);
    expect(isOtherServiceError(undefined)).toBe(false);
    expect(isOtherServiceError("")).toBe(false);
  });
});
