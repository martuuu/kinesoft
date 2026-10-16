import { describe, it, expect } from "vitest";
import type { SaasPlan, TenantVertical } from "@prisma/client";
import { modulesFor } from "@/lib/tenant-modules";
import { PORTAL_SECTIONS, portalSectionsFor, type PortalSection } from "@/lib/portal-nav";

/** [P4-C] Gates del portal por módulo (brief ES4 §3.5): una sola fuente para pages y nav. */

const PLANS: SaasPlan[] = ["INDIVIDUAL", "CONSULTORIO", "CLINICA", "LIBRE"];
const VERTICALS: TenantVertical[] = ["GENERAL", "KINESIOLOGY"];

const sections = (vertical: TenantVertical, plan: SaasPlan, publicBookingEnabled: boolean) =>
  [...portalSectionsFor(modulesFor({ vertical, plan, publicBookingEnabled }))].sort();

describe("[P4-C] portalSectionsFor", () => {
  it("General Individual sin turnero = {inicio, cuenta}", () => {
    expect(sections("GENERAL", "INDIVIDUAL", false)).toEqual(["cuenta", "inicio"]);
  });

  it("General con turnero suma solo reservar (sin plan, checkin ni ejercicios)", () => {
    for (const plan of PLANS) expect(sections("GENERAL", plan, true)).toEqual(["cuenta", "inicio", "reservar"]);
  });

  it("Kine sin turnero = sin reservar; con todo lo clínico del portal", () => {
    for (const plan of PLANS) {
      expect(sections("KINESIOLOGY", plan, false)).toEqual(["checkin", "cuenta", "ejercicios", "inicio", "plan"]);
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
        }
    expect(n).toBe(16);
  });

  it("el enum no tiene sección de historia clínica", () => {
    expect(PORTAL_SECTIONS as readonly string[]).not.toContain("evoluciones");
    expect([...PORTAL_SECTIONS].sort()).toEqual(["checkin", "cuenta", "ejercicios", "inicio", "plan", "reservar"]);
  });

  it("checkin y ejercicios dependen de planes (sin planes no salen aunque estén sus módulos)", () => {
    const s = portalSectionsFor(new Set(["evaluaciones", "ejercicios", "evoluciones"] as const));
    expect([...s].sort()).toEqual<PortalSection[]>(["cuenta", "inicio"]);
    expect([...portalSectionsFor(new Set(["planes", "evaluaciones"] as const))].sort()).toEqual([
      "checkin",
      "cuenta",
      "inicio",
      "plan",
    ]);
    expect([...portalSectionsFor(new Set(["planes", "ejercicios"] as const))].sort()).toEqual([
      "cuenta",
      "ejercicios",
      "inicio",
      "plan",
    ]);
  });

  it("el mismo set de módulos da el mismo set de secciones (identidad estable)", () => {
    const m = modulesFor({ vertical: "KINESIOLOGY", plan: "CONSULTORIO", publicBookingEnabled: true });
    expect(portalSectionsFor(m)).toBe(portalSectionsFor(m));
  });
});
