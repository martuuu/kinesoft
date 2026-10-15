import { describe, it, expect } from "vitest";
import type { SaasPlan, TenantVertical } from "@prisma/client";
import {
  TENANT_MODULES,
  modulesFor,
  isPublicBookingOpen,
  isProfileTabAllowed,
  roomsEnabled,
  waitingRoomEnabled,
  minimumPlanFor,
  MODULE_DENIED_COPY,
  VERTICAL_LABEL,
  SAAS_PLAN_LABEL,
  PLAN_LABEL,
  type TenantModule,
  type TenantEntitlements,
} from "@/lib/tenant-modules";
import { NAV_ITEMS, navFor, shortcutsFor } from "@/lib/nav";
import { capabilitiesFor } from "@/lib/capabilities";

/**
 * EV-C1 → PL-1a (C-PL1): matriz de módulos vertical × plan SaaS (plan §20.5.2), sus invariantes y el nav único
 * (C-EV2). La matriz se escribe acá a mano (no se deriva del código) para que un cambio en `modulesFor` tenga que
 * pasar por el plan.
 */

const PLANS: SaasPlan[] = ["INDIVIDUAL", "CONSULTORIO", "CLINICA", "LIBRE"];
const VERTICALS: TenantVertical[] = ["GENERAL", "KINESIOLOGY"];

const CORE: TenantModule[] = ["agenda", "pacientes", "facturacion", "obrasSociales", "evoluciones"];
const KINE_ALL: TenantModule[] = ["reportes", "planes", "sesiones", "diagnostico", "evaluaciones", "ejercicios"];
const KINE_CONS: TenantModule[] = ["plantillas", "favoritos", "ejerciciosGlobales"];
const KINE_ONLY: TenantModule[] = [...KINE_ALL, ...KINE_CONS];
const CLINICA_UP: TenantModule[] = ["salas", "salaEspera"];

const EXPECTED: Record<TenantVertical, Record<SaasPlan, TenantModule[]>> = {
  GENERAL: {
    INDIVIDUAL: CORE,
    CONSULTORIO: CORE,
    CLINICA: [...CORE, ...CLINICA_UP],
    LIBRE: [...CORE, ...CLINICA_UP],
  },
  KINESIOLOGY: {
    INDIVIDUAL: [...CORE, ...KINE_ALL],
    CONSULTORIO: [...CORE, ...KINE_ALL, ...KINE_CONS],
    CLINICA: [...CORE, ...KINE_ONLY, ...CLINICA_UP],
    LIBRE: [...CORE, ...KINE_ONLY, ...CLINICA_UP],
  },
};

const e = (vertical: TenantVertical, plan: SaasPlan, publicBookingEnabled = false): TenantEntitlements => ({
  vertical,
  plan,
  publicBookingEnabled,
});

const sorted = (s: Iterable<string>) => [...s].sort();

describe("[PL-1a] modulesFor — matriz completa (§20.5.2)", () => {
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

  it("todo módulo devuelto pertenece a TENANT_MODULES, y todo TENANT_MODULES aparece en alguna celda", () => {
    const seen = new Set<string>();
    for (const v of VERTICALS)
      for (const p of PLANS)
        for (const m of modulesFor(e(v, p, true))) {
          expect(TENANT_MODULES).toContain(m);
          seen.add(m);
        }
    expect(sorted(seen)).toEqual(sorted(TENANT_MODULES));
  });

  it("falla cerrado ante una vertical o un plan desconocidos (o un plan LEGADO colado)", () => {
    const weird = modulesFor({ vertical: "OTRA" as TenantVertical, plan: "CLINICA", publicBookingEnabled: false });
    expect(sorted(weird)).toEqual(sorted([...CORE, ...CLINICA_UP]));
    for (const bad of ["PLATINO", "PRO", "ENTERPRISE"]) {
      const m = modulesFor({ vertical: "KINESIOLOGY", plan: bad as SaasPlan, publicBookingEnabled: false });
      expect(sorted(m)).toEqual(sorted(EXPECTED.KINESIOLOGY.INDIVIDUAL));
    }
  });

  it("misma combinación → misma identidad (memo)", () => {
    expect(modulesFor(e("KINESIOLOGY", "CLINICA", true))).toBe(modulesFor(e("KINESIOLOGY", "CLINICA", true)));
  });
});

describe("[PL-1a] invariantes de la matriz", () => {
  const all = VERTICALS.flatMap((v) => PLANS.flatMap((p) => [e(v, p, false), e(v, p, true)]));

  it("núcleo (con evoluciones) en todas las celdas", () => {
    for (const x of all) for (const m of CORE) expect(modulesFor(x).has(m)).toBe(true);
  });
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
  it("monótono en las dos verticales: Individual ⊆ Consultorio ⊆ Clínica = Libre", () => {
    for (const v of VERTICALS)
      for (const sw of [false, true]) {
        const [ind, cons, cli, lib] = PLANS.map((p) => modulesFor(e(v, p, sw)));
        for (const m of ind) expect(cons.has(m)).toBe(true);
        for (const m of cons) expect(cli.has(m)).toBe(true);
        expect(sorted(lib)).toEqual(sorted(cli));
      }
  });
  it("GENERAL no tiene ningún módulo Kine, para ningún plan", () => {
    for (const p of PLANS)
      for (const sw of [false, true]) {
        const m = modulesFor(e("GENERAL", p, sw));
        for (const k of KINE_ONLY) expect(m.has(k)).toBe(false);
      }
  });
  it("salas y salaEspera solo en Clínica/Libre (las dos verticales); roomsEnabled/waitingRoomEnabled lo reflejan", () => {
    for (const v of VERTICALS)
      for (const p of PLANS)
        for (const sw of [false, true]) {
          const want = p === "CLINICA" || p === "LIBRE";
          const m = modulesFor(e(v, p, sw));
          expect(m.has("salas"), `${v}/${p}`).toBe(want);
          expect(m.has("salaEspera"), `${v}/${p}`).toBe(want);
          expect(roomsEnabled(e(v, p, sw))).toBe(want);
          expect(waitingRoomEnabled(e(v, p, sw))).toBe(want);
        }
  });
  it("turneroPublico = switch en cualquier vertical y plan; isPublicBookingOpen lo refleja", () => {
    for (const v of VERTICALS)
      for (const p of PLANS) {
        expect(modulesFor(e(v, p, true)).has("turneroPublico")).toBe(true);
        expect(modulesFor(e(v, p, false)).has("turneroPublico")).toBe(false);
        expect(isPublicBookingOpen(e(v, p, true))).toBe(true);
        expect(isPublicBookingOpen(e(v, p, false))).toBe(false);
      }
  });
});

describe("[PL-1a] minimumPlanFor", () => {
  it("el plan más chico que trae el módulo, por vertical", () => {
    for (const m of CORE) {
      expect(minimumPlanFor(m, "GENERAL")).toBe("INDIVIDUAL");
      expect(minimumPlanFor(m, "KINESIOLOGY")).toBe("INDIVIDUAL");
    }
    expect(minimumPlanFor("turneroPublico", "GENERAL")).toBe("INDIVIDUAL");
    for (const m of KINE_ALL) expect(minimumPlanFor(m, "KINESIOLOGY")).toBe("INDIVIDUAL");
    for (const m of KINE_CONS) expect(minimumPlanFor(m, "KINESIOLOGY")).toBe("CONSULTORIO");
    for (const m of CLINICA_UP) {
      expect(minimumPlanFor(m, "GENERAL")).toBe("CLINICA");
      expect(minimumPlanFor(m, "KINESIOLOGY")).toBe("CLINICA");
    }
  });
  it("null si ningún plan lo trae en esa vertical (Kine en General)", () => {
    for (const m of KINE_ONLY) expect(minimumPlanFor(m, "GENERAL")).toBeNull();
  });
  it("coincide con la matriz: el mínimo lo tiene y el anterior no", () => {
    for (const v of VERTICALS)
      for (const m of TENANT_MODULES) {
        const min = minimumPlanFor(m, v);
        if (min === null) continue;
        expect(modulesFor(e(v, min, true)).has(m)).toBe(true);
        const i = PLANS.indexOf(min);
        if (i > 0) expect(modulesFor(e(v, PLANS[i - 1], true)).has(m)).toBe(false);
      }
  });
});

describe("isProfileTabAllowed", () => {
  const general = modulesFor(e("GENERAL", "CLINICA"));
  const kine = modulesFor(e("KINESIOLOGY", "INDIVIDUAL"));

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
  it("[PL-1a] el copy de upsell nombra el plan mínimo (Clínica para salas; Consultorio para plantillas/favoritos/catálogo)", () => {
    // PL-Z B6: los dos planes que la traen y dónde se cambia.
    expect(MODULE_DENIED_COPY.salas).toBe(
      "Las salas vienen con los planes Clínica y Libre. El plan se cambia en Configuración → Plan y uso."
    );
    expect(MODULE_DENIED_COPY.salaEspera).toBe(
      "La sala de espera viene con los planes Clínica y Libre. El plan se cambia en Configuración → Plan y uso."
    );
    for (const m of ["plantillas", "favoritos", "ejerciciosGlobales"] as const) {
      expect(MODULE_DENIED_COPY[m]).toMatch(/desde el plan Consultorio/);
    }
    // Ninguno nombra los planes viejos.
    for (const m of TENANT_MODULES) expect(MODULE_DENIED_COPY[m]).not.toMatch(/\b(PRO|Base|Free|Enterprise)\b/);
  });
  it("[PL-1a] SAAS_PLAN_LABEL", () => {
    expect(SAAS_PLAN_LABEL).toEqual({ INDIVIDUAL: "Individual", CONSULTORIO: "Consultorio", CLINICA: "Clínica", LIBRE: "Libre" });
  });
  it("labels de vertical y plan legado (deprecado)", () => {
    expect(VERTICAL_LABEL).toEqual({
      GENERAL: "Clínica general",
      KINESIOLOGY: "Kinesiología y osteopatía",
    });
    expect(PLAN_LABEL).toEqual({ FREE: "Free", STARTER: "Base", PRO: "PRO", ENTERPRISE: "Enterprise" });
  });
});

describe("nav único (C-EV2)", () => {
  // Clínica: el nav incluye Sala de espera (desde PL-1a, módulo de Clínica/Libre).
  const general = modulesFor(e("GENERAL", "CLINICA"));
  const kine = modulesFor(e("KINESIOLOGY", "CLINICA"));
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

  it("[PL-F1b] «Reportes» (placeholder sin funcionalidad) no está en el nav ni en el ⌘K, en ningún consultorio", () => {
    expect(NAV_ITEMS.some((i) => i.href === "/reportes")).toBe(false);
    expect(hrefs(navFor(kine, ownerCaps))).not.toContain("/reportes");
    expect(shortcutsFor(kine).some((s) => s.href === "/reportes")).toBe(false);
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
    ]);
  });

  it("[PL-1a] sin Clínica no hay Sala de espera en el nav (Kine Consultorio, General Individual)", () => {
    expect(hrefs(navFor(modulesFor(e("KINESIOLOGY", "CONSULTORIO")), ownerCaps))).not.toContain("/sala");
    expect(hrefs(navFor(modulesFor(e("GENERAL", "INDIVIDUAL")), ownerCaps))).not.toContain("/sala");
  });

  it("shortcutsFor: General sin atajos clínicos", () => {
    expect(shortcutsFor(general).map((s) => s.href)).toEqual(["/dashboard", "/agenda", "/pacientes"]);
  });
});
