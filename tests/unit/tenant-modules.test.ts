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
  planRank,
  PLAN_ORDER,
  MODULE_DENIED_COPY,
  MODULE_REVOKED_COPY,
  moduleDeniedCopy,
  moduleStateRows,
  parseModuleOverrides,
  isModuleOverridable,
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

// T3b-1k2: los overrides de Plataforma son obligatorios en el tipo; la matriz se prueba sin overrides.
const e = (
  vertical: TenantVertical,
  plan: SaasPlan,
  publicBookingEnabled = false,
  moduleGrants: readonly TenantModule[] = [],
  moduleRevokes: readonly TenantModule[] = []
): TenantEntitlements => ({
  vertical,
  plan,
  publicBookingEnabled,
  moduleGrants,
  moduleRevokes,
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
    const weird = modulesFor(e("OTRA" as TenantVertical, "CLINICA"));
    expect(sorted(weird)).toEqual(sorted([...CORE, ...CLINICA_UP]));
    for (const bad of ["PLATINO", "PRO", "ENTERPRISE"]) {
      const m = modulesFor(e("KINESIOLOGY", bad as SaasPlan));
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

  it("sesiones/plan/planes dependen de su módulo", () => {
    for (const tab of ["sesiones", "plan", "planes"]) {
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
      // CF2 (D-CF2-17): «Caja», con cualquier capability de cobro y sin depender de los cobros online.
      "/caja",
      // [TP-3g] Cobros online: con `billing.collect`, antes de Configuración. CF2: solo con cobros online
      // (`onlinePaymentsOnly`): este `navFor` va sin opts (falla cerrado), así que no aparece.
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

  // CF-NAV: `shortcutsFor` filtra por capabilities como `navFor`; con las del Titular que atiende son los de siempre.
  it("shortcutsFor: Kine = los SHORTCUTS de lib/search.ts de hoy", () => {
    expect(shortcutsFor(kine, ownerCaps)).toEqual([
      { id: "nav:dashboard", category: "shortcut", label: "Inicio", href: "/dashboard" },
      { id: "nav:agenda", category: "shortcut", label: "Agenda", href: "/agenda" },
      { id: "nav:pacientes", category: "shortcut", label: "Pacientes", href: "/pacientes" },
      { id: "nav:planes", category: "shortcut", label: "Planes", href: "/planes" },
      { id: "nav:diagnostico", category: "shortcut", label: "Diagnóstico", href: "/diagnostico" },
      { id: "nav:seguimiento", category: "shortcut", label: "Seguimiento", href: "/seguimiento" },
      { id: "nav:biblioteca", category: "shortcut", label: "Ejercicios", href: "/biblioteca" },
      // CF2 (P-NAV): atajo «Caja».
      { id: "nav:caja", category: "shortcut", label: "Caja", href: "/caja" },
    ]);
  });

  it("[PL-1a] sin Clínica no hay Sala de espera en el nav (Kine Consultorio, General Individual)", () => {
    expect(hrefs(navFor(modulesFor(e("KINESIOLOGY", "CONSULTORIO")), ownerCaps))).not.toContain("/sala");
    expect(hrefs(navFor(modulesFor(e("GENERAL", "INDIVIDUAL")), ownerCaps))).not.toContain("/sala");
  });

  it("shortcutsFor: General sin atajos clínicos", () => {
    expect(shortcutsFor(general, ownerCaps).map((s) => s.href)).toEqual(["/dashboard", "/agenda", "/pacientes", "/caja"]);
  });
});

// VX-Z (B2): `lib/module-wall.ts` usa este rango en vez de su copia `PLAN_RANK`.
describe("planRank / PLAN_ORDER", () => {
  it("ordena de menor a mayor y un plan desconocido falla cerrado (0)", () => {
    expect(PLAN_ORDER).toEqual(["INDIVIDUAL", "CONSULTORIO", "CLINICA", "LIBRE"]);
    expect(PLAN_ORDER.map(planRank)).toEqual([0, 1, 2, 3]);
    expect(planRank("PRO" as SaasPlan)).toBe(0);
  });
});

/**
 * T3b-1k2 (plan §23.6): módulos a medida por consultorio desde Plataforma (`Tenant.moduleGrants`/`moduleRevokes`, M12).
 * `modulesFor` = base del plan + grants que existen en la vertical − revokes fuera del núcleo; el turnero sigue el
 * switch (ningún override lo toca).
 */
describe("[AS-1k2] overrides de módulos (moduleGrants / moduleRevokes)", () => {
  it("[AS-1k2] un grant suma un módulo que el plan no trae (Kine Individual + plantillas; General Individual + salas)", () => {
    const kine = modulesFor(e("KINESIOLOGY", "INDIVIDUAL", false, ["plantillas"]));
    expect(kine.has("plantillas")).toBe(true);
    expect(sorted(kine)).toEqual(sorted([...EXPECTED.KINESIOLOGY.INDIVIDUAL, "plantillas"]));
    const gen = modulesFor(e("GENERAL", "INDIVIDUAL", false, ["salas", "salaEspera"]));
    expect(sorted(gen)).toEqual(sorted([...CORE, "salas", "salaEspera"]));
    expect(roomsEnabled(e("GENERAL", "INDIVIDUAL", false, ["salas"]))).toBe(true);
  });

  it("[AS-1k2] un revoke saca un módulo del plan (Kine Clínica − salaEspera − diagnostico)", () => {
    const m = modulesFor(e("KINESIOLOGY", "CLINICA", false, [], ["salaEspera", "diagnostico"]));
    expect(m.has("salaEspera")).toBe(false);
    expect(m.has("diagnostico")).toBe(false);
    expect(m.has("salas")).toBe(true);
    expect(waitingRoomEnabled(e("KINESIOLOGY", "CLINICA", false, [], ["salaEspera"]))).toBe(false);
  });

  it("[AS-1k2] el núcleo no se revoca: un revoke de agenda/pacientes/facturacion/obrasSociales/evoluciones se ignora", () => {
    const m = modulesFor(e("GENERAL", "CLINICA", false, [], [...CORE, "salas"]));
    for (const c of CORE) expect(m.has(c)).toBe(true);
    expect(m.has("salas")).toBe(false); // control: el revoke de un no-núcleo sí aplica
  });

  it("[AS-1k2] un módulo que no existe en la vertical no se concede (Diagnóstico en General)", () => {
    const m = modulesFor(e("GENERAL", "LIBRE", false, ["diagnostico", "planes", "salas"]));
    expect(m.has("diagnostico")).toBe(false);
    expect(m.has("planes")).toBe(false);
    for (const k of KINE_ONLY) expect(m.has(k)).toBe(false);
    // Control: el mismo grant en Kine Individual sí entra (plantillas no está en Individual).
    expect(modulesFor(e("KINESIOLOGY", "INDIVIDUAL", false, ["plantillas"])).has("plantillas")).toBe(true);
  });

  it("[AS-1k2] el turnero ignora los overrides: solo lo prende/apaga el switch", () => {
    expect(modulesFor(e("KINESIOLOGY", "CLINICA", false, ["turneroPublico", "salas"])).has("turneroPublico")).toBe(false);
    expect(modulesFor(e("KINESIOLOGY", "CLINICA", true, [], ["turneroPublico", "salas"])).has("turneroPublico")).toBe(true);
    // Control: en la misma llamada, el revoke de salas sí aplica (los overrides se leen).
    expect(modulesFor(e("KINESIOLOGY", "CLINICA", true, [], ["turneroPublico", "salas"])).has("salas")).toBe(false);
    expect(isModuleOverridable("turneroPublico", "KINESIOLOGY")).toBe(false);
  });

  it("[AS-1k2] el memo distingue overrides (y no depende del orden de las listas)", () => {
    const plain = modulesFor(e("KINESIOLOGY", "INDIVIDUAL"));
    const granted = modulesFor(e("KINESIOLOGY", "INDIVIDUAL", false, ["plantillas", "favoritos"]));
    const revoked = modulesFor(e("KINESIOLOGY", "INDIVIDUAL", false, [], ["plantillas"]));
    expect(granted).not.toBe(plain);
    expect(granted.has("plantillas")).toBe(true);
    expect(plain.has("plantillas")).toBe(false);
    expect(revoked.has("plantillas")).toBe(false);
    // Grant y revoke del mismo módulo en listas distintas no comparten clave.
    expect(revoked).not.toBe(granted);
    // Mismo contenido en otro orden → misma identidad.
    expect(modulesFor(e("KINESIOLOGY", "INDIVIDUAL", false, ["favoritos", "plantillas"]))).toBe(granted);
    // Sin overrides sigue siendo la misma identidad de siempre.
    expect(modulesFor(e("KINESIOLOGY", "INDIVIDUAL"))).toBe(plain);
  });

  it("[AS-1k2] isModuleOverridable: ni núcleo, ni turnero, ni módulos de otra vertical", () => {
    for (const c of CORE) expect(isModuleOverridable(c, "KINESIOLOGY")).toBe(false);
    for (const k of KINE_ONLY) {
      expect(isModuleOverridable(k, "GENERAL")).toBe(false);
      expect(isModuleOverridable(k, "KINESIOLOGY")).toBe(true);
    }
    for (const c of CLINICA_UP) {
      expect(isModuleOverridable(c, "GENERAL")).toBe(true);
      expect(isModuleOverridable(c, "KINESIOLOGY")).toBe(true);
    }
    expect(isModuleOverridable("noexiste" as TenantModule, "KINESIOLOGY")).toBe(false);
  });

  it("[AS-1k2] parseModuleOverrides: descarta lo desconocido y duplicado, ordena (falla cerrado sobre la columna cruda)", () => {
    expect(parseModuleOverrides({ moduleGrants: ["salas", "basura", "plantillas", "salas"], moduleRevokes: ["diagnostico"] })).toEqual({
      moduleGrants: ["plantillas", "salas"],
      moduleRevokes: ["diagnostico"],
    });
    expect(parseModuleOverrides({ moduleGrants: [], moduleRevokes: [] })).toEqual({ moduleGrants: [], moduleRevokes: [] });
  });

  it("[AS-1k2] moduleStateRows: plan / granted / revoked / absent, candado en el núcleo y en lo que no existe en la vertical", () => {
    const rows = moduleStateRows(e("KINESIOLOGY", "INDIVIDUAL", true, ["plantillas"], ["diagnostico"]));
    const by = Object.fromEntries(rows.map((r) => [r.module, r]));
    // El turnero no es un override: no tiene fila (se maneja con su switch).
    expect(rows.map((r) => r.module)).toEqual(TENANT_MODULES.filter((m) => m !== "turneroPublico"));
    expect(by.agenda).toEqual({ module: "agenda", state: "plan", locked: true });
    expect(by.planes).toEqual({ module: "planes", state: "plan", locked: false });
    expect(by.plantillas).toEqual({ module: "plantillas", state: "granted", locked: false });
    expect(by.diagnostico).toEqual({ module: "diagnostico", state: "revoked", locked: false });
    expect(by.salas).toEqual({ module: "salas", state: "absent", locked: false });
    const gen = Object.fromEntries(moduleStateRows(e("GENERAL", "CLINICA")).map((r) => [r.module, r]));
    expect(gen.diagnostico).toEqual({ module: "diagnostico", state: "absent", locked: true });
    expect(gen.salas).toEqual({ module: "salas", state: "plan", locked: false });
  });

  it("[AS-1k2] moduleDeniedCopy: el revocado dice que no está habilitado; el resto, el copy de siempre", () => {
    expect(MODULE_REVOKED_COPY).toBe("Este módulo no está habilitado para tu consultorio. Si lo necesitás, escribinos desde Soporte.");
    const rev = e("KINESIOLOGY", "CLINICA", false, [], ["salaEspera"]);
    expect(moduleDeniedCopy(rev, "salaEspera")).toBe(MODULE_REVOKED_COPY);
    expect(moduleDeniedCopy(rev, "plantillas")).toBe(MODULE_DENIED_COPY.plantillas);
    expect(moduleDeniedCopy(e("KINESIOLOGY", "INDIVIDUAL"), "salaEspera")).toBe(MODULE_DENIED_COPY.salaEspera);
    // Un revoke ignorado (núcleo, turnero) no cambia el copy.
    expect(moduleDeniedCopy(e("GENERAL", "INDIVIDUAL", false, [], ["turneroPublico"]), "turneroPublico")).toBe(
      MODULE_DENIED_COPY.turneroPublico
    );
  });
});
