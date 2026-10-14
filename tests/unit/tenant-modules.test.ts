import { describe, it, expect } from "vitest";
import type { TenantPlan, TenantVertical } from "@prisma/client";
import {
  TENANT_MODULES,
  modulesFor,
  isPublicBookingOpen,
  isProfileTabAllowed,
  MODULE_DENIED_COPY,
  VERTICAL_LABEL,
  PLAN_LABEL,
  type TenantModule,
  type TenantEntitlements,
} from "@/lib/tenant-modules";
import { NAV_ITEMS, navFor, shortcutsFor } from "@/lib/nav";
import { capabilitiesFor } from "@/lib/capabilities";

/**
 * EV-C1: matriz de módulos (plan §15.3 / `.docs/VERTICALES.md` §3.1), sus
 * invariantes y el nav único (C-EV2). La matriz se escribe acá a mano (no se
 * deriva del código) para que un cambio en `modulesFor` tenga que pasar por el
 * plan.
 */

const PLANS: TenantPlan[] = ["FREE", "STARTER", "PRO", "ENTERPRISE"];
const VERTICALS: TenantVertical[] = ["GENERAL", "KINESIOLOGY"];

const CORE: TenantModule[] = ["agenda", "pacientes", "facturacion", "obrasSociales", "salaEspera"];
const KINE_ONLY: TenantModule[] = [
  "reportes",
  "planes",
  "sesiones",
  "diagnostico",
  "evaluaciones",
  "ejercicios",
  "plantillas",
  "favoritos",
  "ejerciciosGlobales",
];

const EXPECTED: Record<TenantVertical, Record<TenantPlan, TenantModule[]>> = {
  GENERAL: { FREE: CORE, STARTER: CORE, PRO: CORE, ENTERPRISE: CORE },
  KINESIOLOGY: {
    FREE: [...CORE, "reportes", "planes", "sesiones", "diagnostico", "evaluaciones", "ejercicios"],
    STARTER: [
      ...CORE,
      "reportes",
      "planes",
      "sesiones",
      "diagnostico",
      "evaluaciones",
      "ejercicios",
      "plantillas",
      "favoritos",
    ],
    PRO: [...CORE, ...KINE_ONLY],
    ENTERPRISE: [...CORE, ...KINE_ONLY],
  },
};

const e = (vertical: TenantVertical, plan: TenantPlan, publicBookingEnabled = false): TenantEntitlements => ({
  vertical,
  plan,
  publicBookingEnabled,
});

const sorted = (s: Iterable<string>) => [...s].sort();

describe("modulesFor — matriz completa (§15.3)", () => {
  for (const v of VERTICALS) {
    for (const p of PLANS) {
      for (const sw of [false, true]) {
        it(`${v} ${p} turnero=${sw}`, () => {
          const want = sw ? [...EXPECTED[v][p], "turneroPublico"] : EXPECTED[v][p];
          expect(sorted(modulesFor(e(v, p, sw)))).toEqual(sorted(want));
        });
      }
    }
  }

  it("todo módulo devuelto pertenece a TENANT_MODULES", () => {
    for (const v of VERTICALS)
      for (const p of PLANS)
        for (const m of modulesFor(e(v, p, true))) expect(TENANT_MODULES).toContain(m);
  });

  it("falla cerrado ante una vertical o un plan desconocidos", () => {
    const weird = modulesFor({
      vertical: "OTRA" as TenantVertical,
      plan: "PRO",
      publicBookingEnabled: false,
    });
    expect(sorted(weird)).toEqual(sorted(CORE));
    const weirdPlan = modulesFor({
      vertical: "KINESIOLOGY",
      plan: "PLATINO" as TenantPlan,
      publicBookingEnabled: false,
    });
    expect(sorted(weirdPlan)).toEqual(sorted(EXPECTED.KINESIOLOGY.FREE));
  });

  it("misma combinación → misma identidad (memo)", () => {
    expect(modulesFor(e("KINESIOLOGY", "PRO", true))).toBe(modulesFor(e("KINESIOLOGY", "PRO", true)));
  });
});

describe("invariantes de la matriz", () => {
  const all = VERTICALS.flatMap((v) => PLANS.flatMap((p) => [e(v, p, false), e(v, p, true)]));

  it("sesiones ⇔ planes", () => {
    for (const x of all) {
      const m = modulesFor(x);
      expect(m.has("sesiones")).toBe(m.has("planes"));
    }
  });
  it("plantillas ⇒ planes", () => {
    for (const x of all) {
      const m = modulesFor(x);
      if (m.has("plantillas")) expect(m.has("planes")).toBe(true);
    }
  });
  it("favoritos ⇒ ejercicios y ejerciciosGlobales ⇒ ejercicios", () => {
    for (const x of all) {
      const m = modulesFor(x);
      if (m.has("favoritos")) expect(m.has("ejercicios")).toBe(true);
      if (m.has("ejerciciosGlobales")) expect(m.has("ejercicios")).toBe(true);
    }
  });
  it("Kine monótono: FREE ⊆ STARTER ⊆ PRO = ENTERPRISE", () => {
    for (const sw of [false, true]) {
      const free = modulesFor(e("KINESIOLOGY", "FREE", sw));
      const starter = modulesFor(e("KINESIOLOGY", "STARTER", sw));
      const pro = modulesFor(e("KINESIOLOGY", "PRO", sw));
      const ent = modulesFor(e("KINESIOLOGY", "ENTERPRISE", sw));
      for (const m of free) expect(starter.has(m)).toBe(true);
      for (const m of starter) expect(pro.has(m)).toBe(true);
      expect(sorted(ent)).toEqual(sorted(pro));
    }
  });
  it("GENERAL no tiene ningún módulo Kine, para ningún plan", () => {
    for (const p of PLANS)
      for (const sw of [false, true]) {
        const m = modulesFor(e("GENERAL", p, sw));
        for (const k of KINE_ONLY) expect(m.has(k)).toBe(false);
      }
  });
  it("turneroPublico = switch en cualquier vertical; isPublicBookingOpen lo refleja", () => {
    for (const v of VERTICALS)
      for (const p of PLANS) {
        expect(modulesFor(e(v, p, true)).has("turneroPublico")).toBe(true);
        expect(modulesFor(e(v, p, false)).has("turneroPublico")).toBe(false);
        expect(isPublicBookingOpen(e(v, p, true))).toBe(true);
        expect(isPublicBookingOpen(e(v, p, false))).toBe(false);
      }
  });
});

describe("isProfileTabAllowed", () => {
  const general = modulesFor(e("GENERAL", "PRO"));
  const kine = modulesFor(e("KINESIOLOGY", "FREE"));

  it("sesiones/plan/planes/evol dependen de su módulo", () => {
    for (const tab of ["sesiones", "plan", "planes", "evol"]) {
      expect(isProfileTabAllowed(tab, general)).toBe(false);
      expect(isProfileTabAllowed(tab, kine)).toBe(true);
    }
  });
  it("el resto de las pestañas reales son comunes", () => {
    for (const tab of ["resumen", "turnos", "archivos", "antec", "fact", "actividad"]) {
      expect(isProfileTabAllowed(tab, general)).toBe(true);
      expect(isProfileTabAllowed(tab, kine)).toBe(true);
    }
  });
});

describe("copy y labels", () => {
  it("MODULE_DENIED_COPY tiene un texto no vacío por módulo", () => {
    for (const m of TENANT_MODULES) expect(MODULE_DENIED_COPY[m]?.length).toBeGreaterThan(10);
  });
  it("labels de vertical y plan", () => {
    expect(VERTICAL_LABEL).toEqual({
      GENERAL: "Consultorio general",
      KINESIOLOGY: "Kinesiología y osteopatía",
    });
    expect(PLAN_LABEL).toEqual({ FREE: "Free", STARTER: "Base", PRO: "PRO", ENTERPRISE: "Enterprise" });
  });
});

describe("nav único (C-EV2)", () => {
  const general = modulesFor(e("GENERAL", "PRO"));
  const kine = modulesFor(e("KINESIOLOGY", "PRO"));
  const ownerCaps = capabilitiesFor("OWNER");
  const billingCaps = capabilitiesFor("BILLING");
  const hrefs = (items: readonly { href: string }[]) => items.map((i) => i.href);

  it("todo NAV_ITEMS.module ∈ TENANT_MODULES y los href son únicos", () => {
    for (const it of NAV_ITEMS) if (it.module) expect(TENANT_MODULES).toContain(it.module);
    expect(new Set(hrefs(NAV_ITEMS)).size).toBe(NAV_ITEMS.length);
  });

  it("Planes (S21, ES3) solo con el módulo planes: General no lo ve", () => {
    expect(NAV_ITEMS.some((i) => i.href === "/planes")).toBe(true);
    expect(hrefs(navFor(general, ownerCaps))).not.toContain("/planes");
    expect(shortcutsFor(general).some((s) => s.href === "/planes")).toBe(false);
  });

  it("General: sin Diagnóstico/Seguimiento/Ejercicios/Terapia manual/Reportes; con Sala de espera", () => {
    const h = hrefs(navFor(general, ownerCaps));
    for (const x of ["/diagnostico", "/seguimiento", "/biblioteca", "/terapia-manual", "/reportes"])
      expect(h).not.toContain(x);
    for (const x of ["/dashboard", "/agenda", "/pacientes", "/sala", "/configuracion"])
      expect(h).toContain(x);
  });

  it("Kine: todo lo de hoy + Sala de espera, en orden", () => {
    expect(hrefs(navFor(kine, ownerCaps))).toEqual([
      "/dashboard",
      "/agenda",
      "/sala",
      "/pacientes",
      "/planes",
      "/diagnostico",
      "/seguimiento",
      "/biblioteca",
      "/terapia-manual",
      "/reportes",
      "/configuracion",
    ]);
  });

  it("[SV11a] Sala de espera apunta a /sala: /agenda?view=reception ya no está en el nav", () => {
    const sala = NAV_ITEMS.find((i) => i.label === "Sala de espera");
    expect(sala).toMatchObject({
      href: "/sala",
      module: "salaEspera",
      capability: "agenda.reception",
      icon: "clock",
    });
    expect(NAV_ITEMS.some((i) => i.href.includes("view=reception"))).toBe(false);
    expect(hrefs(navFor(general, ownerCaps))).toContain("/sala");
    expect(hrefs(navFor(kine, ownerCaps))).toContain("/sala");
  });

  it("Sala de espera exige la capability agenda.reception (BILLING afuera; sin caps, falla cerrado)", () => {
    expect(hrefs(navFor(kine, billingCaps))).not.toContain("/sala");
    expect(hrefs(navFor(kine))).not.toContain("/sala");
    expect(hrefs(navFor(kine))).toContain("/agenda");
  });

  it("shortcutsFor: Kine = los SHORTCUTS de lib/search.ts de hoy", () => {
    expect(shortcutsFor(kine)).toEqual([
      { id: "nav:dashboard", category: "shortcut", label: "Inicio", href: "/dashboard" },
      { id: "nav:agenda", category: "shortcut", label: "Agenda", href: "/agenda" },
      { id: "nav:pacientes", category: "shortcut", label: "Pacientes", href: "/pacientes" },
      { id: "nav:planes", category: "shortcut", label: "Planes", href: "/planes" },
      { id: "nav:diagnostico", category: "shortcut", label: "Diagnóstico", href: "/diagnostico" },
      { id: "nav:seguimiento", category: "shortcut", label: "Seguimiento", href: "/seguimiento" },
      { id: "nav:biblioteca", category: "shortcut", label: "Ejercicios", href: "/biblioteca" },
      { id: "nav:reportes", category: "shortcut", label: "Reportes", href: "/reportes" },
    ]);
  });

  it("shortcutsFor: General sin atajos clínicos", () => {
    expect(shortcutsFor(general).map((s) => s.href)).toEqual(["/dashboard", "/agenda", "/pacientes"]);
  });
});
