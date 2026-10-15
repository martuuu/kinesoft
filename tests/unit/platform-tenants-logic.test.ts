/**
 * PL-1d · `limitsShrinkBelowUsage` (lib/platform-tenants-logic.ts): el guard de «Editar suscripción» de Plataforma.
 * El Drawer no elige quiénes pierden el acceso, así que no puede achicar un límite por debajo de lo que ya se usa;
 * subir (o tocar un consultorio ya pasado de cupo sin achicarlo) sí.
 */
import { describe, it, expect } from "vitest";
import { limitsShrinkBelowUsage } from "@/lib/platform-tenants-logic";
import { PLAN_DEFAULTS } from "@/lib/saas-plans-logic";

const L = (p: keyof typeof PLAN_DEFAULTS) => PLAN_DEFAULTS[p].limits;

describe("limitsShrinkBelowUsage", () => {
  it("bajar de Clínica a Individual con 3 usuarios: no entra (usuarios)", () => {
    const r = limitsShrinkBelowUsage({ total: 3, professional: 2, staff: 1 }, L("CLINICA"), L("INDIVIDUAL"));
    expect(r).toMatch(/límite es de 1 usuario y hoy hay 3/);
  });

  it("[§20.17] Clínica → Consultorio con 5 profesionales: entran (5 de cualquier tipo); con 6 usuarios, no", () => {
    expect(limitsShrinkBelowUsage({ total: 5, professional: 5, staff: 0 }, L("CLINICA"), L("CONSULTORIO"))).toBeNull();
    expect(limitsShrinkBelowUsage({ total: 6, professional: 4, staff: 2 }, L("CLINICA"), L("CONSULTORIO"))).not.toBeNull();
  });

  it("con topes por tipo a medida: 5 profesionales no entran en 4, ni 2 no clínicos en 1", () => {
    const capped = { maxUsers: 5, maxProfessionals: 4, maxStaff: 1 };
    expect(limitsShrinkBelowUsage({ total: 5, professional: 5, staff: 0 }, L("CLINICA"), capped)).toMatch(/4 profesionales y hoy hay 5/);
    expect(limitsShrinkBelowUsage({ total: 4, professional: 2, staff: 2 }, L("CLINICA"), capped)).toMatch(/1 persona no clínica y hoy hay 2/);
  });

  it("subir de plan siempre se deja, aunque hoy esté pasado de cupo (datos viejos post-M8)", () => {
    // Un FREE viejo con 3 profesionales quedó INDIVIDUAL (1 usuario): subirlo a Consultorio no empeora nada.
    expect(limitsShrinkBelowUsage({ total: 3, professional: 3, staff: 0 }, L("INDIVIDUAL"), L("CONSULTORIO"))).toBeNull();
    expect(limitsShrinkBelowUsage({ total: 12, professional: 9, staff: 3 }, L("CLINICA"), L("LIBRE"))).toBeNull();
  });

  it("bajar cuando entra: ok", () => {
    expect(limitsShrinkBelowUsage({ total: 1, professional: 1, staff: 0 }, L("CLINICA"), L("INDIVIDUAL"))).toBeNull();
    expect(limitsShrinkBelowUsage({ total: 5, professional: 4, staff: 1 }, L("CLINICA"), L("CONSULTORIO"))).toBeNull();
  });

  it("override de Libre por debajo del uso: no entra; sacarlo (null = sin límite) sí", () => {
    const libre = L("LIBRE");
    const capped = { ...libre, maxProfessionals: 2 };
    expect(limitsShrinkBelowUsage({ total: 6, professional: 4, staff: 2 }, libre, capped)).toMatch(/2 profesionales y hoy hay 4/);
    expect(limitsShrinkBelowUsage({ total: 6, professional: 4, staff: 2 }, capped, libre)).toBeNull();
  });
});
