/**
 * BO1-C: servicios iniciales por vertical. Los usan `scripts/create-tenant.ts`
 * y el alta desde Plataforma (BO2-A); el stepper de onboarding pide al menos uno.
 */
import { describe, it, expect } from "vitest";
import type { TenantVertical } from "@prisma/client";
import { starterServicesFor } from "@/lib/tenant-starter-services";
import { isServiceColor } from "@/lib/service-colors";

const VERTICALS: TenantVertical[] = ["KINESIOLOGY", "GENERAL"];

describe("starterServicesFor", () => {
  it("Kinesiología: Kinesiología 45', Osteopatía 60', Evaluación inicial 45'", () => {
    const s = starterServicesFor("KINESIOLOGY");
    expect(s.map((x) => [x.name, x.durationMin])).toEqual([
      ["Kinesiología", 45],
      ["Osteopatía", 60],
      ["Evaluación inicial", 45],
    ]);
    expect(s.find((x) => x.name === "Kinesiología")?.discipline).toBe("KINESIOLOGY");
    expect(s.find((x) => x.name === "Osteopatía")?.discipline).toBe("OSTEOPATHY");
    // Kine atiende varios en paralelo (null = sin tope); osteopatía, uno por horario.
    expect(s.find((x) => x.name === "Kinesiología")?.maxConcurrent).toBeNull();
    expect(s.find((x) => x.name === "Osteopatía")?.maxConcurrent).toBe(1);
  });

  it("Consultorio general: Consulta 30', Primera consulta 45', Control 20', sin disciplina", () => {
    const s = starterServicesFor("GENERAL");
    expect(s.map((x) => [x.name, x.durationMin])).toEqual([
      ["Consulta", 30],
      ["Primera consulta", 45],
      ["Control", 20],
    ]);
    for (const x of s) {
      expect(x.discipline).toBeNull();
      expect(x.maxConcurrent).toBe(1);
    }
  });

  it.each(VERTICALS)("%s: precio 0 en centavos, color de la paleta, nombres únicos", (v) => {
    const s = starterServicesFor(v);
    expect(s.length).toBeGreaterThan(0);
    expect(new Set(s.map((x) => x.name)).size).toBe(s.length);
    expect(new Set(s.map((x) => x.color)).size).toBe(s.length);
    for (const x of s) {
      expect(x.priceCents).toBe(0);
      expect(Number.isInteger(x.priceCents)).toBe(true);
      expect(isServiceColor(x.color)).toBe(true);
      expect(Number.isInteger(x.durationMin) && x.durationMin > 0).toBe(true);
    }
  });

  it("devuelve una copia: mutar el resultado no ensucia la próxima llamada", () => {
    const a = starterServicesFor("GENERAL");
    a[0].name = "pisado";
    a.pop();
    expect(starterServicesFor("GENERAL")[0].name).toBe("Consulta");
    expect(starterServicesFor("GENERAL")).toHaveLength(3);
  });
});
