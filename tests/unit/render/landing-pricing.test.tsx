/**
 * [VX2-c2] Precios de la landing (C-VX-L). SSR puro sobre el componente real; el catálogo sale de la función real
 * `toPublicPlans` con las filas por defecto del plan (`PLAN_DEFAULTS`), así el test ve los mismos bullets y cupos que
 * la landing. Se mockean solo la base y `next/cache` (los importa el módulo del catálogo; acá no se usan).
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/db", () => ({ prismaService: {} }));
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));

import { LandingPricing, splitBullets } from "@/components/landing/pricing";
import { toPublicPlans, type PublicPlan } from "@/lib/saas-plans-public";
import { PLAN_DEFAULTS, SAAS_PLANS } from "@/lib/saas-plans-logic";
import { formatARS } from "@/lib/format";

const ROWS = SAAS_PLANS.map((plan) => ({ plan, ...PLAN_DEFAULTS[plan] }));
const catalog = (patch?: (r: (typeof ROWS)[number]) => (typeof ROWS)[number]) => toPublicPlans(patch ? ROWS.map(patch) : ROWS);

const html = (plans: PublicPlan[]) => renderToStaticMarkup(<LandingPricing plans={plans} />);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
/** HTML de la tarjeta de un plan (el <article> que la etiqueta). */
const card = (h: string, plan: string) => {
  const m = h.match(new RegExp(`<article[^>]*aria-labelledby="plan-${plan}"[\\s\\S]*?</article>`));
  return m ? m[0] : null;
};

describe("[VX2-c2] LandingPricing", () => {
  it("contrato C-VX-L: section#precios con h2#precios-title", () => {
    const h = html(catalog());
    expect(h).toMatch(/<section id="precios" aria-labelledby="precios-title"/);
    expect(h).toContain('id="precios-title"');
    expect(h).toContain("Un plan para cada tamaño de consultorio");
    expect(h.match(/<h1/g)).toBeNull();
  });

  it("Individual, Consultorio y Clínica son tarjetas; Libre es la banda «Hablemos» → #contacto", () => {
    const h = html(catalog());
    expect(card(h, "individual")).not.toBeNull();
    expect(card(h, "consultorio")).not.toBeNull();
    expect(card(h, "clinica")).not.toBeNull();
    expect(card(h, "libre")).toBeNull();
    expect(h.match(/<article/g)).toHaveLength(3);
    expect(text(h)).toContain("¿Hospital o clínica grande? Hablemos.");
    expect(text(h)).toContain("Si necesitás más de 10 usuarios, armamos el plan Libre a la medida de tu equipo.");
    expect(h).toMatch(/<a class="[^"]*k-btn-lime[^"]*" href="#contacto">Escribinos/);
  });

  it("precio null → «Consultá» sin «por mes»; precio cargado → formatARS + «por mes»", () => {
    const h = html(catalog((r) => (r.plan === "CONSULTORIO" ? { ...r, priceCents: 6_400_000 } : r)));
    const ind = text(card(h, "individual")!);
    expect(ind).toContain("Consultá");
    expect(ind).not.toContain("por mes");
    const cons = text(card(h, "consultorio")!);
    expect(cons).toContain(formatARS(6_400_000).replace(/\s+/g, " "));
    expect(cons).toContain("por mes");
    expect(text(h)).not.toMatch(/precio de ejemplo/i);
  });

  it("cupos: Individual 1, Consultorio 5 de cualquier tipo, Clínica 10", () => {
    const h = html(catalog());
    expect(text(card(h, "individual")!)).toContain("Para vos solo: 1 usuario");
    expect(text(card(h, "consultorio")!)).toContain("Hasta 5 usuarios, profesionales o no");
    expect(text(card(h, "clinica")!)).toContain("Hasta 10 usuarios, profesionales o no");
  });

  it("salas y sala de espera solo en Clínica; evoluciones en Individual (los demás lo heredan)", () => {
    const h = html(catalog());
    expect(text(card(h, "individual")!)).not.toMatch(/Sala/);
    expect(text(card(h, "consultorio")!)).not.toMatch(/Sala/);
    expect(text(card(h, "clinica")!)).toMatch(/Sala de espera/);
    expect(text(card(h, "individual")!)).toContain("Evoluciones de cada consulta en la historia clínica");
    expect(text(card(h, "consultorio")!)).toContain("Todo lo del plan Individual");
  });

  it("lo de Kinesiología va aparte («Con Kinesiología, además:»), no mezclado con lo de General", () => {
    const plans = catalog();
    const ind = splitBullets(plans.find((p) => p.plan === "INDIVIDUAL")!);
    expect(ind.common.join(" | ")).not.toMatch(/Diagnóstico|ejercicios|Planes de tratamiento/i);
    expect(ind.kineExtra).toEqual(
      expect.arrayContaining(["Planes de tratamiento con seguimiento de sesiones", "Biblioteca con tus propios ejercicios"])
    );
    const h = html(plans);
    expect(text(card(h, "individual")!)).toContain("Con Kinesiología, además:");
    // Clínica no suma nada propio de Kine sobre Consultorio: no muestra el subtítulo vacío.
    expect(text(card(h, "clinica")!)).not.toContain("Con Kinesiología");
  });

  it("CTA a /signup (D-VX18); prueba gratis solo donde hay trialDays; Consultorio destacado", () => {
    const h = html(catalog());
    for (const p of ["individual", "consultorio", "clinica"]) {
      expect(card(h, p)).toMatch(new RegExp(`<a [^>]*href="/signup"[^>]*aria-describedby="plan-${p}"|<a [^>]*aria-describedby="plan-${p}"[^>]*href="/signup"`));
    }
    expect(text(card(h, "individual")!)).toContain("14 días gratis, sin medio de pago");
    expect(text(card(h, "individual")!)).toContain("Empezá gratis");
    expect(text(card(h, "clinica")!)).toContain("Crear cuenta");
    expect(text(card(h, "clinica")!)).not.toContain("días gratis");
    expect(card(h, "consultorio")).toMatch(/k-btn-primary/);
    expect(card(h, "individual")).toMatch(/k-btn-ghost/);
    expect(text(h)).toContain("Empezás con 14 días gratis. Cambiás de plan cuando lo necesites.");
    expect(text(h)).toContain("Precios en pesos argentinos.");
  });

  it("[] (sin base en el build) no rompe: sin tarjetas, banda y «Escribinos y te pasamos los precios.»", () => {
    const h = html([]);
    expect(h).toContain('id="precios"');
    expect(h).not.toContain("<article");
    expect(text(h)).toContain("Escribinos y te pasamos los precios.");
    expect(text(h)).toContain("¿Hospital o clínica grande? Hablemos.");
    expect(text(h)).not.toContain("Precios en pesos argentinos.");
  });

  it("sin prueba gratis en ningún plan: la bajada no promete días", () => {
    const h = html(catalog((r) => ({ ...r, trialDays: 0 })));
    expect(text(h)).not.toMatch(/días gratis/);
    expect(text(h)).toContain("Cambiás de plan cuando lo necesites.");
  });

  it("si Plataforma oculta un plan, las tarjetas que quedan se acomodan (data-count)", () => {
    const h = html(catalog((r) => (r.plan === "CLINICA" ? { ...r, isPublic: false } : r)));
    expect(h.match(/<article/g)).toHaveLength(2);
    expect(h).toContain('data-count="2"');
  });
});
