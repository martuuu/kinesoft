import { describe, it, expect } from "vitest";
import {
  PORTAL_HOME,
  portalCheckInCopy,
  portalNextSessionLabel,
  portalNoPlanCopy,
  portalPatientCardCopy,
  portalPlanProgress,
  portalSessionLabel,
  portalTenantHeader,
} from "@/lib/portal-copy";

/**
 * [VX2-f · D-VX28] Copy del portal por vertical. Regla de brief-vx §3: «turno» es el genérico, «sesión» (y el
 * «Check-in pre-sesión») solo en Kinesiología; nada de «recuperación» ni «evolución de tu dolor» en el copy neutral.
 */
const ALL = (o: unknown) => JSON.stringify(o);

describe("[VX2-f] portal-copy", () => {
  it("la home y el ingreso son neutrales", () => {
    expect(PORTAL_HOME.title).toBe("Tus turnos y tu tratamiento, en un solo lugar");
    expect(PORTAL_HOME.signInLead).toBe("Entrá para ver tus próximos turnos y tu tratamiento.");
    expect(ALL(PORTAL_HOME)).not.toMatch(/sesi[oó]n|recuperaci|dolor|evoluci/i);
  });

  it("General nunca dice «sesión» ni promete planes", () => {
    const g = [
      portalPlanProgress("GENERAL", 2, 5),
      portalPatientCardCopy("GENERAL"),
      portalTenantHeader({ vertical: "GENERAL", hasPlan: false, firstName: "Ana" }),
      portalTenantHeader({ vertical: "GENERAL", hasPlan: true, firstName: "Ana" }),
      portalNoPlanCopy("GENERAL"),
      portalSessionLabel("GENERAL", 3),
      portalNextSessionLabel("GENERAL", 3),
      portalCheckInCopy("GENERAL"),
    ];
    expect(ALL(g)).not.toMatch(/sesi[oó]n|check-in|ejercicio/i);
    expect(portalPatientCardCopy("GENERAL").noPlan).toBeNull();
    expect(portalTenantHeader({ vertical: "GENERAL", hasPlan: false, firstName: "Ana" })).toEqual({
      title: "Tu consultorio",
      lead: "Hola Ana.",
    });
    expect(portalPlanProgress("GENERAL", 2, 5)).toBe("2 / 5 turnos");
    expect(portalNoPlanCopy("GENERAL").linkToHome).toBe(true);
  });

  it("Kinesiología conserva «sesión por sesión» y el check-in pre-sesión", () => {
    expect(portalTenantHeader({ vertical: "KINESIOLOGY", hasPlan: true, firstName: "Ana" }).lead).toBe(
      "Hola Ana. Acá ves cómo viene tu tratamiento, sesión por sesión."
    );
    expect(portalPlanProgress("KINESIOLOGY", 3, 10)).toBe("3 / 10 sesiones");
    expect(portalSessionLabel("KINESIOLOGY", 4)).toBe("Sesión 4");
    expect(portalNextSessionLabel("KINESIOLOGY", 4)).toBe("Próxima sesión · #4");
    expect(portalCheckInCopy("KINESIOLOGY").title).toBe("Check-in pre-sesión");
    expect(portalPatientCardCopy("KINESIOLOGY").noPlan).toMatch(/plan de tratamiento/);
    expect(portalNoPlanCopy("KINESIOLOGY").linkToHome).toBe(false);
  });
});
