import { describe, it, expect } from "vitest";
import type { SaasPlan, TenantVertical } from "@prisma/client";
import { modulesFor } from "@/lib/tenant-modules";
import { PORTAL_SECTIONS, portalReturnPath, portalReturnSection, portalSectionsFor, type PortalSection } from "@/lib/portal-nav";

/** [P4-C] Gates del portal por módulo (brief ES4 §3.5): una sola fuente para pages y nav. */

const PLANS: SaasPlan[] = ["INDIVIDUAL", "CONSULTORIO", "CLINICA", "LIBRE"];
const VERTICALS: TenantVertical[] = ["GENERAL", "KINESIOLOGY"];

const sections = (vertical: TenantVertical, plan: SaasPlan, publicBookingEnabled: boolean) =>
  [...portalSectionsFor(modulesFor({ vertical, plan, publicBookingEnabled, moduleGrants: [], moduleRevokes: [] }))].sort();

describe("[P4-C] portalSectionsFor", () => {
  it("General Individual sin turnero = {inicio, cuenta, documentos}", () => {
    expect(sections("GENERAL", "INDIVIDUAL", false)).toEqual(["cuenta", "documentos", "inicio"]);
  });

  it("General con turnero suma solo reservar (sin plan ni ejercicios)", () => {
    for (const plan of PLANS) expect(sections("GENERAL", plan, true)).toEqual(["cuenta", "documentos", "inicio", "reservar"]);
  });

  it("Kine sin turnero = sin reservar; con todo lo clínico del portal", () => {
    for (const plan of PLANS) {
      expect(sections("KINESIOLOGY", plan, false)).toEqual(["cuenta", "documentos", "ejercicios", "inicio", "plan"]);
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
    expect([...PORTAL_SECTIONS].sort()).toEqual(["cuenta", "documentos", "ejercicios", "inicio", "plan", "reservar"]);
    for (const v of VERTICALS)
      for (const p of PLANS)
        for (const sw of [false, true]) expect(sections(v, p, sw), `${v} ${p} ${sw}`).toContain("documentos");
  });

  it("ejercicios depende de planes (sin planes no sale aunque esté su módulo)", () => {
    const s = portalSectionsFor(new Set(["evaluaciones", "ejercicios", "evoluciones"] as const));
    expect([...s].sort()).toEqual<PortalSection[]>(["cuenta", "documentos", "inicio"]);
    expect([...portalSectionsFor(new Set(["planes", "ejercicios"] as const))].sort()).toEqual([
      "cuenta",
      "documentos",
      "ejercicios",
      "inicio",
      "plan",
    ]);
  });

  // [CF-L3] Decisión de Martin (30-oct, §28.1 punto 4): la EVA sale de toda la app, incluido el check-in del portal
  // (era una EVA 0..10 que mandaba el paciente). Los datos (`EvaScore` con `source` «checkin-…») quedan en la base y
  // en el export; lo que no queda es la sección: ni en el enum, ni con `planes` ∧ `evaluaciones`.
  it("[CF-L3] no hay sección «checkin» en el enum ni en ninguna combinación", () => {
    expect(PORTAL_SECTIONS as readonly string[]).not.toContain("checkin");
    const all = new Set(["planes", "evaluaciones", "ejercicios", "evoluciones", "turneroPublico"] as const);
    expect([...portalSectionsFor(all)] as string[]).not.toContain("checkin");
    for (const v of VERTICALS)
      for (const p of PLANS)
        for (const sw of [false, true]) expect(sections(v, p, sw) as string[], `${v} ${p} ${sw}`).not.toContain("checkin");
  });

  it("el mismo set de módulos da el mismo set de secciones (identidad estable)", () => {
    const m = modulesFor({ vertical: "KINESIOLOGY", plan: "CONSULTORIO", publicBookingEnabled: true, moduleGrants: [], moduleRevokes: [] });
    expect(portalSectionsFor(m)).toBe(portalSectionsFor(m));
  });
});

describe("[FC-4i] ?n= del portal: a qué sección volver después de entrar", () => {
  it("solo «documentos» (allow-list cerrada); el resto, null", () => {
    expect(portalReturnSection("documentos")).toBe("documentos");
    expect(portalReturnSection(["documentos", "x"])).toBe("documentos");
    for (const v of [undefined, null, "", "cuenta", "../documentos", "documentos/1", "DOCUMENTOS", 1]) {
      expect(portalReturnSection(v), String(v)).toBeNull();
    }
  });

  it("el path: sin slug al portal general; con slug, el consultorio y su sección", () => {
    expect(portalReturnPath(null, "documentos")).toBe("/portal");
    expect(portalReturnPath("sur", null)).toBe("/portal/c/sur");
    expect(portalReturnPath("sur", "documentos")).toBe("/portal/c/sur/documentos");
  });
});
