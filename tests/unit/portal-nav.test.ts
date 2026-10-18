import { describe, it, expect } from "vitest";
import type { SaasPlan, TenantVertical } from "@prisma/client";
import { modulesFor } from "@/lib/tenant-modules";
import { PORTAL_SECTIONS, portalSectionsFor, type PortalSection } from "@/lib/portal-nav";

/** [P4-C] Gates del portal por módulo (brief ES4 §3.5): una sola fuente para pages y nav. */

const PLANS: SaasPlan[] = ["INDIVIDUAL", "CONSULTORIO", "CLINICA", "LIBRE"];
const VERTICALS: TenantVertical[] = ["GENERAL", "KINESIOLOGY"];

const sections = (vertical: TenantVertical, plan: SaasPlan, publicBookingEnabled: boolean) =>
  [...portalSectionsFor(modulesFor({ vertical, plan, publicBookingEnabled, moduleGrants: [], moduleRevokes: [] }))].sort();

describe("[P4-C] portalSectionsFor", () => {
  it("General Individual sin turnero = {inicio, cuenta, documentos}", () => {
    expect(sections("GENERAL", "INDIVIDUAL", false)).toEqual(["cuenta", "documentos", "inicio"]);
  });

  it("General con turnero suma solo reservar (sin plan, checkin ni ejercicios)", () => {
    for (const plan of PLANS) expect(sections("GENERAL", plan, true)).toEqual(["cuenta", "documentos", "inicio", "reservar"]);
  });

  it("Kine sin turnero = sin reservar; con todo lo clínico del portal", () => {
    for (const plan of PLANS) {
      expect(sections("KINESIOLOGY", plan, false)).toEqual(["checkin", "cuenta", "documentos", "ejercicios", "inicio", "plan"]);
      expect(sections("KINESIOLOGY", plan, true)).toContain("reservar");
    }
  });

  it("las 16 combinaciones (2 verticales × 4 planes × switch) devuelven solo secciones del enum", () => {
    const allowed = new Set<string>(PORTAL_SECTIONS);
    let n = 0;
    for (const v of VERTICALS)
      for (const p of PLANS)
        for (const sw of [false, true]) {
          n++;
          const s = sections(v, p, sw);
          for (const x of s) expect(allowed.has(x)).toBe(true);
          expect(s).toContain("inicio");
          expect(s).toContain("cuenta");
          expect(s).toContain("documentos");
        }
    expect(n).toBe(16);
  });

  // [FC-1e] T4 (C-FC8): el portal suma «Documentos» = lo que el profesional compartió (PatientDocument), nunca la HC.
  // La historia clínica (`evoluciones`) es CORE (todas las verticales y planes), así que la sección sale en las 16
  // combinaciones; sin documentos compartidos la página muestra el vacío. La lista exacta del enum vive acá: sumar una
  // sección es una decisión de producto (y de PHI, si toca la HC), no un cambio de una línea.
  it("[FC-2h] PORTAL_SECTIONS + documentos (nunca evoluciones)", () => {
    expect(PORTAL_SECTIONS as readonly string[]).not.toContain("evoluciones");
    expect([...PORTAL_SECTIONS].sort()).toEqual(["checkin", "cuenta", "documentos", "ejercicios", "inicio", "plan", "reservar"]);
    for (const v of VERTICALS)
      for (const p of PLANS)
        for (const sw of [false, true]) expect(sections(v, p, sw), `${v} ${p} ${sw}`).toContain("documentos");
  });

  it("checkin y ejercicios dependen de planes (sin planes no salen aunque estén sus módulos)", () => {
    const s = portalSectionsFor(new Set(["evaluaciones", "ejercicios", "evoluciones"] as const));
    expect([...s].sort()).toEqual<PortalSection[]>(["cuenta", "documentos", "inicio"]);
    expect([...portalSectionsFor(new Set(["planes", "evaluaciones"] as const))].sort()).toEqual([
      "checkin",
      "cuenta",
      "documentos",
      "inicio",
      "plan",
    ]);
    expect([...portalSectionsFor(new Set(["planes", "ejercicios"] as const))].sort()).toEqual([
      "cuenta",
      "documentos",
      "ejercicios",
      "inicio",
      "plan",
    ]);
  });

  it("el mismo set de módulos da el mismo set de secciones (identidad estable)", () => {
    const m = modulesFor({ vertical: "KINESIOLOGY", plan: "CONSULTORIO", publicBookingEnabled: true, moduleGrants: [], moduleRevokes: [] });
    expect(portalSectionsFor(m)).toBe(portalSectionsFor(m));
  });
});
