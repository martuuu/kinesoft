/**
 * PL-1a · C-PL2: catálogo público de planes (`getPublicPlanCatalog`). Se mockea la base (`prismaService`) y
 * `next/cache` (passthrough que registra el tag); la función bajo test y su lógica pura corren reales.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({ findMany: vi.fn() }));
const cache = vi.hoisted(() => ({ calls: [] as { keyParts?: string[]; tags?: string[] }[] }));
const report = vi.hoisted(() => ({ reportError: vi.fn() }));

vi.mock("@/lib/db", () => ({ prismaService: { saasPlanConfig: { findMany: db.findMany } } }));
vi.mock("next/cache", () => ({
  unstable_cache: <T extends (...a: never[]) => unknown>(fn: T, keyParts?: string[], opts?: { tags?: string[] }) => {
    cache.calls.push({ keyParts, tags: opts?.tags });
    return fn;
  },
}));
vi.mock("@/lib/error-report", () => report);

import { getPublicPlanCatalog, SAAS_PLANS_TAG, MAX_FEATURE_BULLETS, limitsLabelFor } from "@/lib/saas-plans-public";
import { formatARS } from "@/lib/format";
import { tags } from "@/lib/cache-tags";
import { BRAND_NAME } from "@/lib/brand";

/** Las filas que siembra M8 (precios NULL, PL-D19), desordenadas a propósito. */
const M8_ROWS = [
  { plan: "CLINICA", label: "Clínica", priceCents: null, maxUsers: 10, maxProfessionals: null, maxStaff: null, trialDays: 0, isPublic: true, sortOrder: 3 },
  { plan: "INDIVIDUAL", label: "Individual", priceCents: null, maxUsers: 1, maxProfessionals: 1, maxStaff: 1, trialDays: 14, isPublic: true, sortOrder: 1 },
  { plan: "LIBRE", label: "Libre", priceCents: null, maxUsers: null, maxProfessionals: null, maxStaff: null, trialDays: 0, isPublic: true, sortOrder: 4 },
  { plan: "CONSULTORIO", label: "Consultorio", priceCents: null, maxUsers: 5, maxProfessionals: 4, maxStaff: 1, trialDays: 0, isPublic: true, sortOrder: 2 },
];

beforeEach(() => {
  db.findMany.mockReset();
  report.reportError.mockReset();
});

describe("[PL-1a] getPublicPlanCatalog (C-PL2)", () => {
  it("se cachea con el tag saas-plans (el mismo que tags.saasPlans())", () => {
    expect(SAAS_PLANS_TAG).toBe("saas-plans");
    expect(tags.saasPlans()).toBe(SAAS_PLANS_TAG);
    expect(cache.calls.some((c) => c.tags?.includes(SAAS_PLANS_TAG))).toBe(true);
  });

  it("en orden (sortOrder), con «Consultá» cuando el precio es null y Libre «A medida» + contacto", async () => {
    db.findMany.mockResolvedValue(M8_ROWS);
    const c = await getPublicPlanCatalog();
    expect(c.map((p) => p.plan)).toEqual(["INDIVIDUAL", "CONSULTORIO", "CLINICA", "LIBRE"]);
    expect(c.map((p) => p.order)).toEqual([1, 2, 3, 4]);
    for (const p of c.slice(0, 3)) {
      expect(p).toMatchObject({ priceCents: null, priceLabel: "Consultá", period: null, cta: "signup" });
    }
    expect(c[3]).toMatchObject({ plan: "LIBRE", priceLabel: "A medida", period: null, cta: "contact" });
    expect(c[0]).toMatchObject({ label: "Individual", trialDays: 14, limits: { maxUsers: 1, maxProfessionals: 1, maxStaff: 1 } });
  });

  it("con precio cargado: formatARS desde centavos y período «mes»; Libre nunca muestra precio", async () => {
    db.findMany.mockResolvedValue(
      M8_ROWS.map((r) => (r.plan === "CONSULTORIO" ? { ...r, priceCents: 2_500_000 } : r.plan === "LIBRE" ? { ...r, priceCents: 9_900_000 } : r))
    );
    const c = await getPublicPlanCatalog();
    const cons = c.find((p) => p.plan === "CONSULTORIO")!;
    expect(cons).toMatchObject({ priceCents: 2_500_000, priceLabel: formatARS(2_500_000), period: "mes" });
    expect(c.find((p) => p.plan === "LIBRE")).toMatchObject({ priceCents: null, priceLabel: "A medida" });
  });

  it("solo los planes públicos", async () => {
    db.findMany.mockResolvedValue(M8_ROWS.map((r) => (r.plan === "CLINICA" ? { ...r, isPublic: false } : r)));
    expect((await getPublicPlanCatalog()).map((p) => p.plan)).toEqual(["INDIVIDUAL", "CONSULTORIO", "LIBRE"]);
  });

  it("nunca tira: sin base → [] y queda reportado", async () => {
    db.findMany.mockRejectedValue(new Error("connect ECONNREFUSED"));
    await expect(getPublicPlanCatalog()).resolves.toEqual([]);
    expect(report.reportError).toHaveBeenCalledWith("saas_plans.public_catalog_failed", expect.any(Error));
  });

  it("features: las dos verticales, ≤ 8 bullets, sin módulos Kine en General ni salas antes de Clínica", async () => {
    db.findMany.mockResolvedValue(M8_ROWS);
    const c = await getPublicPlanCatalog();
    for (const p of c) {
      expect(p.features.map((f) => f.vertical)).toEqual(["GENERAL", "KINESIOLOGY"]);
      for (const f of p.features) {
        expect(f.bullets.length).toBeGreaterThan(0);
        expect(f.bullets.length).toBeLessThanOrEqual(MAX_FEATURE_BULLETS);
        expect(new Set(f.bullets).size).toBe(f.bullets.length);
      }
      const general = p.features[0].bullets.join(" | ");
      expect(general).not.toMatch(/Diagnóstico|ejercicios|Planes de tratamiento/i);
    }
    const all = (plan: string) => c.find((p) => p.plan === plan)!.features.flatMap((f) => f.bullets).join(" | ");
    expect(all("INDIVIDUAL")).not.toMatch(/Sala/);
    expect(all("CONSULTORIO")).not.toMatch(/Sala/);
    expect(all("CLINICA")).toMatch(/Sala de espera/);
    expect(c[1].features[1].bullets[0]).toBe("Todo lo del plan Individual");
    expect(c[1].features[1].bullets.join(" | ")).toMatch(/Catálogo de ejercicios de KineSoft/);
  });
});

describe("[VX2-c2] bullet de evoluciones (EV2 ya está)", () => {
  const EVOL = "Evoluciones de cada consulta en la historia clínica";

  it("Individual lo muestra en las dos verticales y los planes de arriba lo heredan («Todo lo del plan…»)", async () => {
    db.findMany.mockResolvedValue(M8_ROWS);
    const c = await getPublicPlanCatalog();
    const ind = c.find((p) => p.plan === "INDIVIDUAL")!;
    for (const f of ind.features) expect(f.bullets).toContain(EVOL);
    for (const p of c.filter((x) => x.plan !== "INDIVIDUAL")) {
      for (const f of p.features) expect(f.bullets).not.toContain(EVOL);
    }
  });

  it("sumarlo no corta ningún bullet de Individual Kine por el tope de 8 (ejercicios propios sigue)", async () => {
    db.findMany.mockResolvedValue(M8_ROWS);
    const kine = (await getPublicPlanCatalog()).find((p) => p.plan === "INDIVIDUAL")!.features[1].bullets;
    expect(kine.length).toBeLessThanOrEqual(MAX_FEATURE_BULLETS);
    expect(kine).toContain("Biblioteca con tus propios ejercicios");
    expect(kine).toContain("Diagnóstico y evaluaciones");
    expect(kine.join(" | ")).toMatch(/obra social/);
  });

  it("el catálogo de ejercicios lleva el nombre de la marca (BRAND_NAME, D-VX25)", async () => {
    db.findMany.mockResolvedValue(M8_ROWS);
    const cons = (await getPublicPlanCatalog()).find((p) => p.plan === "CONSULTORIO")!.features[1].bullets;
    expect(cons).toContain(`Catálogo de ejercicios de ${BRAND_NAME}`);
  });
});

describe("[PL-1a] limitsLabelFor", () => {
  it("los cupos de cada plan en lenguaje llano", () => {
    expect(limitsLabelFor({ maxUsers: 1, maxProfessionals: 1, maxStaff: 1 })).toBe("Para vos solo: 1 usuario");
    expect(limitsLabelFor({ maxUsers: 5, maxProfessionals: 4, maxStaff: 1 })).toBe(
      "Hasta 5 usuarios: hasta 4 profesionales y 1 de recepción o administración"
    );
    expect(limitsLabelFor({ maxUsers: 10, maxProfessionals: null, maxStaff: null })).toBe("Hasta 10 usuarios, profesionales o no");
    expect(limitsLabelFor({ maxUsers: null, maxProfessionals: null, maxStaff: null })).toBe("Usuarios a medida");
  });
});
