import { describe, it, expect } from "vitest";
import {
  PORTAL_HOME,
  PORTAL_PLAN_NO_BOOKING,
  portalNoLinkCopy,
  portalSessionOfTotal,
  portalNextSessionLabel,
  portalNoPlanCopy,
  portalPatientCardCopy,
  portalPlanProgress,
  portalSessionLabel,
  portalTenantHeader,
  portalTabLabel,
  portalDocumentDate,
  PORTAL_DOCUMENTS_COPY,
  PORTAL_SEARCH,
  portalDocumentDownloadErrorFrom,
} from "@/lib/portal-copy";
import { PORTAL_VINCULAR_ERRORS } from "@/lib/portal-vincular-copy";
import { portalSectionsFor } from "@/lib/portal-nav";
import { modulesFor } from "@/lib/tenant-modules";
import { portalTabItems } from "@/components/portal/portal-tabs";

/**
 * [VX2-f · D-VX28] Copy del portal por vertical. Regla de brief-vx §3: «turno» es el genérico, «sesión» solo en
 * Kinesiología (el check-in pre-sesión se fue en CF con la EVA); nada de «recuperación» ni «evolución de tu dolor» en el copy neutral.
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
      portalNoPlanCopy(false),
      portalSessionLabel("GENERAL", 3),
      portalNextSessionLabel("GENERAL", 3, 5),
    ];
    expect(ALL(g)).not.toMatch(/sesi[oó]n|check-in|ejercicio/i);
    expect(portalPatientCardCopy("GENERAL").noPlan).toBeNull();
    expect(portalTenantHeader({ vertical: "GENERAL", hasPlan: false, firstName: "Ana" })).toEqual({
      title: "Tu consultorio",
      lead: "Hola Ana.",
    });
    expect(portalPlanProgress("GENERAL", 2, 5)).toBe("2 / 5 turnos");
    expect(portalNoPlanCopy(false)).toEqual({ text: "Acá ves tus próximos turnos en este consultorio.", linkToHome: false });
    expect(portalNextSessionLabel("GENERAL", 3, 5)).toBe("Próximo turno · Turno 3 de 5");
  });

  it("Kinesiología conserva «sesión por sesión»", () => {
    expect(portalTenantHeader({ vertical: "KINESIOLOGY", hasPlan: true, firstName: "Ana" }).lead).toBe(
      "Hola Ana. Acá ves cómo viene tu tratamiento, sesión por sesión."
    );
    expect(portalPlanProgress("KINESIOLOGY", 3, 10)).toBe("3 / 10 sesiones");
    expect(portalSessionLabel("KINESIOLOGY", 4)).toBe("Sesión 4");
    expect(portalNextSessionLabel("KINESIOLOGY", 3, 10)).toBe("Próxima sesión · Sesión 3 de 10");
    expect(portalPatientCardCopy("KINESIOLOGY").noPlan).toMatch(/plan de tratamiento/);
    expect(portalNoPlanCopy(true).linkToHome).toBe(false);
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
    const kine = portalSectionsFor(modulesFor({ vertical: "KINESIOLOGY", plan: "INDIVIDUAL", publicBookingEnabled: true, moduleGrants: [], moduleRevokes: [] }));
    expect(portalTabItems("consultorio-sur", kine)).toEqual([
      { key: "inicio", href: "/portal/c/consultorio-sur", label: "Tu plan", external: false },
      { key: "documentos", href: "/portal/c/consultorio-sur/documentos", label: "Documentos", external: false },
      { key: "ejercicios", href: "/portal/c/consultorio-sur/ejercicios", label: "Ejercicios", external: false },
      { key: "cuenta", href: "/portal/c/consultorio-sur/cuenta", label: "Estado de cuenta", external: false },
      { key: "reservar", href: "/c/consultorio-sur/booking", label: "Sacar un turno", external: true },
    ]);
    const general = portalSectionsFor(modulesFor({ vertical: "GENERAL", plan: "LIBRE", publicBookingEnabled: false, moduleGrants: [], moduleRevokes: [] }));
    const g = portalTabItems("x", general);
    // [FC-4a] «Documentos» es CORE (C-FC8): también en General sin turnero, segunda después de «inicio».
    expect(g.map((t) => t.key)).toEqual(["inicio", "documentos", "cuenta"]);
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
          const mods = modulesFor({ vertical, plan, publicBookingEnabled, moduleGrants: [], moduleRevokes: [] });
          const keys = portalTabItems("s", portalSectionsFor(mods)).map((t) => t.key);
          expect(keys).toContain("inicio");
          expect(keys).toContain("cuenta");
          expect(keys).toContain("documentos");
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
    expect(c.title).toBe("No encontramos un consultorio vinculado a ana@x.test");
    expect(c.text).toMatch(/te invite al portal/);
    expect(c.text).not.toMatch(/email exacto/);
    expect(PORTAL_PLAN_NO_BOOKING).toBe("Todavía sin turno asignado");
  });
});

/**
 * [FC-4a] Copy de «Documentos» (C-FC8). Neutral por vertical: lo mismo para Kine y General (no dice «sesión», no
 * promete planes) y nunca nombra la historia clínica ni las fichas internas: es lo que el profesional compartió.
 */
describe("[FC-4a] portal-copy · documentos", () => {
  it("vacío literal de C-FC8 y tab en el orden inicio, documentos, ejercicios, cuenta, reservar", () => {
    expect(PORTAL_DOCUMENTS_COPY.empty("Consultorio Sur")).toBe("Todavía no hay documentos compartidos por Consultorio Sur.");
    expect(portalTabLabel("documentos", true)).toBe("Documentos");
    expect(portalTabLabel("documentos", false)).toBe("Documentos");
    const all = portalSectionsFor(modulesFor({ vertical: "KINESIOLOGY", plan: "INDIVIDUAL", publicBookingEnabled: true, moduleGrants: [], moduleRevokes: [] }));
    expect(portalTabItems("s", all).map((t) => t.key)).toEqual(["inicio", "documentos", "ejercicios", "cuenta", "reservar"]);
  });

  it("neutral: sin «sesión», planes, evoluciones ni historia clínica; fechas en hora AR", () => {
    const txt = JSON.stringify({
      ...PORTAL_DOCUMENTS_COPY,
      empty: PORTAL_DOCUMENTS_COPY.empty("X"),
      lead: PORTAL_DOCUMENTS_COPY.lead("X"),
      sharedOn: PORTAL_DOCUMENTS_COPY.sharedOn("2026-10-18T02:30:00.000Z"),
    });
    expect(txt).not.toMatch(/sesi[oó]n|plan|evoluci|historia cl[ií]nica|ficha/i);
    // 02:30 UTC del 18 = 23:30 AR del 17: el día es el argentino aunque el host corra en UTC (Vercel).
    expect(PORTAL_DOCUMENTS_COPY.sharedOn("2026-10-18T02:30:00.000Z")).toBe("Compartido el 17 de oct de 2026");
    expect(portalDocumentDate("2026-10-18T02:30:00.000Z")).toBe("17 de oct de 2026");
  });
});

describe("[T4-Z] portal-copy · errores de descarga y «ficha»", () => {
  it("allow-list de ?e=: solo 429, 503 y 500; el resto (y los arrays) se ignora", () => {
    expect(portalDocumentDownloadErrorFrom("429")).toBe("429");
    expect(portalDocumentDownloadErrorFrom("503")).toBe("503");
    expect(portalDocumentDownloadErrorFrom("500")).toBe("500");
    for (const raw of ["404", "", "toString", "__proto__", "<b>x</b>", null, undefined, ["503"]]) {
      expect(portalDocumentDownloadErrorFrom(raw as string)).toBeNull();
    }
    expect(PORTAL_DOCUMENTS_COPY.downloadError["429"]).toBe("Bajaste varios documentos seguidos. Esperá unos minutos y probá de nuevo.");
    expect(PORTAL_DOCUMENTS_COPY.downloadError["503"]).toBe("No pudimos preparar la descarga. Probá de nuevo en un rato.");
    expect(PORTAL_DOCUMENTS_COPY.downloadError["500"]).toBe(
      "No pudimos generar el PDF. Probá de nuevo; si sigue pasando, avisale a tu consultorio."
    );
  });

  it("al paciente no se le dice «ficha» (choca con la ficha de la historia clínica): ingreso, búsqueda y vínculo", () => {
    expect(ALL({ f: PORTAL_HOME.signInFootnote, s: PORTAL_SEARCH, v: PORTAL_VINCULAR_ERRORS })).not.toMatch(/ficha/i);
    expect(PORTAL_HOME.signInFootnote).toBe("Usá el mismo email que tiene tu cuenta con el consultorio.");
  });
});
