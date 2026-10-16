import { describe, it, expect } from "vitest";
import {
  PORTAL_HOME,
  PORTAL_PLAN_NO_BOOKING,
  portalNoLinkCopy,
  portalSessionOfTotal,
  portalCheckInCopy,
  portalNextSessionLabel,
  portalNoPlanCopy,
  portalPatientCardCopy,
  portalPlanProgress,
  portalSessionLabel,
  portalTenantHeader,
} from "@/lib/portal-copy";
import { portalSectionsFor } from "@/lib/portal-nav";
import { modulesFor } from "@/lib/tenant-modules";
import { portalTabItems } from "@/components/portal/portal-tabs";

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

/**
 * [P4-S24] Turnos del plan y tabs del consultorio. «Sesión n de N» con la palabra por vertical (mismo texto que el chip
 * de la agenda, V1-D18); las tabs salen de `portalSectionsFor` (una sola fuente con el gate de cada page).
 */
describe("[P4-S24] portal-copy · plan y tabs", () => {
  it("«Sesión 3 de 10» en Kine, «Turno 3 de 10» en General", () => {
    expect(portalSessionOfTotal("KINESIOLOGY", 3, 10)).toBe("Sesión 3 de 10");
    expect(portalSessionOfTotal("GENERAL", 3, 10)).toBe("Turno 3 de 10");
  });

  it("tabs por secciones: Kine completo vs General sin turnero", () => {
    const kine = portalSectionsFor(modulesFor({ vertical: "KINESIOLOGY", plan: "INDIVIDUAL", publicBookingEnabled: true }));
    expect(portalTabItems("consultorio-sur", kine)).toEqual([
      { key: "inicio", href: "/portal/c/consultorio-sur", label: "Tu plan", external: false },
      { key: "ejercicios", href: "/portal/c/consultorio-sur/ejercicios", label: "Ejercicios", external: false },
      { key: "cuenta", href: "/portal/c/consultorio-sur/cuenta", label: "Estado de cuenta", external: false },
      { key: "reservar", href: "/c/consultorio-sur/booking", label: "Sacar un turno", external: true },
    ]);
    const general = portalSectionsFor(modulesFor({ vertical: "GENERAL", plan: "LIBRE", publicBookingEnabled: false }));
    const g = portalTabItems("x", general);
    expect(g.map((t) => t.key)).toEqual(["inicio", "cuenta"]);
    expect(g[0].label).toBe("Tu consultorio");
    // General nunca ve «ejercicios» ni «plan» en las tabs; tampoco «Sacar un turno» con el turnero cerrado.
    expect(JSON.stringify(g)).not.toMatch(/ejercicio|plan|sesi[oó]n|booking/i);
    // Mismo resultado con el array serializado de `PortalPatient.sections`.
    expect(portalTabItems("x", [...general])).toEqual(g);
  });

  it("ninguna combinación vertical × plan × turnero ofrece una tab sin su módulo", () => {
    for (const vertical of ["KINESIOLOGY", "GENERAL"] as const) {
      for (const plan of ["INDIVIDUAL", "CONSULTORIO", "CLINICA", "LIBRE"] as const) {
        for (const publicBookingEnabled of [true, false]) {
          const mods = modulesFor({ vertical, plan, publicBookingEnabled });
          const keys = portalTabItems("s", portalSectionsFor(mods)).map((t) => t.key);
          expect(keys).toContain("inicio");
          expect(keys).toContain("cuenta");
          expect(keys.includes("ejercicios")).toBe(mods.has("planes") && mods.has("ejercicios"));
          expect(keys.includes("reservar")).toBe(mods.has("turneroPublico"));
        }
      }
    }
  });

  it("el slug se escapa en los href", () => {
    const items = portalTabItems("a b", ["inicio", "cuenta"]);
    expect(items.map((t) => t.href)).toEqual(["/portal/c/a%20b", "/portal/c/a%20b/cuenta"]);
  });

  it("sin fichas vinculadas: la salida es la invitación, no «cargá tu email exacto»", () => {
    const c = portalNoLinkCopy("ana@x.test");
    expect(c.title).toBe("No encontramos una ficha vinculada a ana@x.test");
    expect(c.text).toMatch(/te invite al portal/);
    expect(c.text).not.toMatch(/email exacto/);
    expect(PORTAL_PLAN_NO_BOOKING).toBe("Todavía sin turno asignado");
  });
});
