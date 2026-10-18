/**
 * [AS-1p] T3c-1p (plan §23.6, regla 4 del brief): dependencias entre módulos y el modelo del form de «Módulos» de
 * Plataforma. Puro: `lib/tenant-module-deps.ts` (la regla que aplica el escritor) y
 * `components/plataforma/tenants/module-overrides-form.ts` (lo que arma el Drawer).
 */
import { describe, it, expect } from "vitest";
import type { TenantEntitlements } from "@/lib/tenant-modules";
import { TENANT_MODULES, modulesFor, minimumPlanFor } from "@/lib/tenant-modules";
import {
  MODULE_REQUIRES,
  dependentsOf,
  moduleDependencyCopy,
  moduleDependencyViolations,
} from "@/lib/tenant-module-deps";
import {
  buildModuleOverridesPayload,
  choiceOf,
  choiceOptions,
  formFromLists,
  isOverridesDirty,
  moduleTableRows,
  priceText,
  setChoice,
  withDependentsOff,
  draftViolations,
  type ModuleTenantBase,
} from "@/components/plataforma/tenants/module-overrides-form";
import { formatAuditValue, auditKeyLabel, moduleName } from "@/components/plataforma/tenants/labels";
import { formatARS } from "@/lib/format";

const e = (over: Partial<TenantEntitlements> = {}): TenantEntitlements => ({
  vertical: "KINESIOLOGY",
  plan: "CLINICA",
  publicBookingEnabled: false,
  moduleGrants: [],
  moduleRevokes: [],
  ...over,
});

describe("[AS-1p] dependencias de módulos", () => {
  it("planes → sesiones y plantillas; ejercicios → favoritos y el catálogo global", () => {
    expect(dependentsOf("planes")).toEqual(["sesiones", "plantillas"]);
    expect(dependentsOf("ejercicios")).toEqual(["favoritos", "ejerciciosGlobales"]);
    expect(dependentsOf("diagnostico")).toEqual([]);
  });

  it("la matriz del plan nunca arma una dependencia colgada (cualquier vertical × plan × turnero)", () => {
    for (const vertical of ["GENERAL", "KINESIOLOGY"] as const) {
      for (const plan of ["INDIVIDUAL", "CONSULTORIO", "CLINICA", "LIBRE"] as const) {
        expect(moduleDependencyViolations(e({ vertical, plan }))).toEqual([]);
      }
    }
  });

  it("todo lo de MODULE_REQUIRES existe en Kine y no en General (no hay dependencias del núcleo)", () => {
    for (const [dep, req] of Object.entries(MODULE_REQUIRES)) {
      expect(TENANT_MODULES).toContain(dep);
      expect(minimumPlanFor(req as never, "GENERAL")).toBeNull();
    }
  });

  it("sacar Planes dejando Sesiones y Plantillas → violación con los dos; sacarlos juntos → ok", () => {
    expect(moduleDependencyViolations(e({ moduleRevokes: ["planes"] }))).toEqual([
      { module: "planes", dependents: ["sesiones", "plantillas"] },
    ]);
    expect(moduleDependencyViolations(e({ moduleRevokes: ["planes", "sesiones", "plantillas"] }))).toEqual([]);
    // En Individual las plantillas no están: alcanza con sacar Sesiones.
    expect(moduleDependencyViolations(e({ plan: "INDIVIDUAL", moduleRevokes: ["planes"] }))).toEqual([
      { module: "planes", dependents: ["sesiones"] },
    ]);
  });

  it("conceder Favoritos con Ejercicios sacado también es colgada", () => {
    expect(
      moduleDependencyViolations(e({ plan: "INDIVIDUAL", moduleGrants: ["favoritos"], moduleRevokes: ["ejercicios"] }))
    ).toEqual([{ module: "ejercicios", dependents: ["favoritos"] }]);
  });

  it("copy literal del brief", () => {
    expect(moduleDependencyCopy({ module: "planes", dependents: ["sesiones", "plantillas"] }, moduleName)).toBe(
      "Para deshabilitar Planes de tratamiento, deshabilitá también Sesiones y Plantillas de plan."
    );
  });
});

describe("[AS-1p] form de «Módulos»", () => {
  const base: ModuleTenantBase = { vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: false };

  it("setChoice mueve entre listas, nunca deja un módulo en las dos, y ordena", () => {
    let f = formFromLists(["salas"], []);
    f = setChoice(f, "salas", "revoke");
    expect(f).toEqual({ grants: [], revokes: ["salas"] });
    f = setChoice(f, "diagnostico", "revoke");
    expect(f.revokes).toEqual(["diagnostico", "salas"]);
    expect(choiceOf(f, "salas")).toBe("revoke");
    expect(choiceOf(setChoice(f, "salas", "plan"), "salas")).toBe("plan");
  });

  it("dirty compara por contenido, sin orden", () => {
    expect(isOverridesDirty(formFromLists(["a" as never, "b" as never], []), { grants: ["b" as never, "a" as never], revokes: [] })).toBe(false);
    expect(isOverridesDirty(formFromLists([], []), formFromLists([], ["planes"]))).toBe(true);
  });

  it("opciones: «Habilitado a mano» solo si el plan no lo trae (o ya estaba guardado así)", () => {
    expect(choiceOptions(true, "plan").map((o) => o.value)).toEqual(["plan", "revoke"]);
    expect(choiceOptions(true, "grant").map((o) => o.value)).toEqual(["plan", "grant", "revoke"]);
    expect(choiceOptions(false, "plan").map((o) => o.value)).toEqual(["plan", "grant", "revoke"]);
  });

  it("«Deshabilitar también»: revoke a lo del plan, vuelve a «Según el plan» lo concedido", () => {
    const ind: ModuleTenantBase = { ...base, plan: "INDIVIDUAL" };
    const f = formFromLists(["plantillas"], ["planes"]);
    const [v] = draftViolations(ind, f);
    expect(v).toEqual({ module: "planes", dependents: ["sesiones", "plantillas"] });
    const fixed = withDependentsOff(ind, f, v);
    expect(fixed).toEqual({ grants: [], revokes: ["planes", "sesiones"] });
    expect(draftViolations(ind, fixed)).toEqual([]);
  });

  it("payload: siempre las dos listas, ordenadas", () => {
    expect(buildModuleOverridesPayload("t1", "v", { grants: [], revokes: ["sesiones", "planes"] })).toEqual({
      tenantId: "t1",
      expectedUpdatedAt: "v",
      grants: [],
      revokes: ["planes", "sesiones"],
    });
  });

  it("filas: candado en el núcleo y en lo que no existe en la vertical; sin turnero; estados del set efectivo", () => {
    const rows = moduleTableRows(e({ vertical: "GENERAL", plan: "INDIVIDUAL", moduleGrants: ["salas"] }));
    expect(rows.find((r) => r.module === "turneroPublico")).toBeUndefined();
    expect(rows.find((r) => r.module === "agenda")).toMatchObject({ locked: true, lockHint: "Básico: lo tiene todo consultorio.", stateLabel: "Del plan" });
    expect(rows.find((r) => r.module === "diagnostico")).toMatchObject({ locked: true, lockHint: "No existe para Clínica general.", stateLabel: "No incluido" });
    expect(rows.find((r) => r.module === "salas")).toMatchObject({ locked: false, stateLabel: "Habilitado a mano" });
    expect(rows.find((r) => r.module === "salaEspera")).toMatchObject({ locked: false, stateLabel: "No incluido" });
    const kine = moduleTableRows(e({ moduleRevokes: ["diagnostico"] }));
    expect(kine.find((r) => r.module === "diagnostico")).toMatchObject({ locked: false, stateLabel: "Deshabilitado a mano" });
    // Consistente con lo que ve el consultorio.
    expect(modulesFor(e({ moduleRevokes: ["diagnostico"] })).has("diagnostico")).toBe(false);
  });

  it("precio: a medida marcado, de lista, o «Consultá»", () => {
    expect(priceText({ planPriceCents: 4_500_000, customPriceCents: 3_000_000, effectivePriceCents: 3_000_000 })).toEqual({
      text: `${formatARS(3_000_000)} / mes · a medida (lista: ${formatARS(4_500_000)})`,
      custom: true,
    });
    expect(formatARS(3_000_000)).toMatch(/30\.000/);
    expect(priceText({ planPriceCents: 4_500_000, customPriceCents: null, effectivePriceCents: 4_500_000 }).text).toContain("/ mes");
    expect(priceText({ planPriceCents: 4_500_000, customPriceCents: null, effectivePriceCents: 4_500_000 }).custom).toBe(false);
    expect(priceText({ planPriceCents: null, customPriceCents: null, effectivePriceCents: null }).text).toBe(
      "Consultá: el plan no tiene precio de lista"
    );
  });
});

describe("[AS-1p] «Actividad» muestra los cambios de listas", () => {
  it("nombres de módulo, «Ninguno» si está vacía, crudo si no lo conocemos", () => {
    expect(auditKeyLabel("moduleRevokes")).toBe("Módulos deshabilitados a mano");
    expect(auditKeyLabel("moduleGrants")).toBe("Módulos habilitados a mano");
    expect(formatAuditValue("moduleRevokes", ["planes", "sesiones"])).toBe("Planes de tratamiento, Sesiones");
    expect(formatAuditValue("moduleGrants", [])).toBe("Ninguno");
    expect(formatAuditValue("moduleGrants", ["reportes", "modulo-viejo"])).toBe("Reportes, modulo-viejo");
  });
});
