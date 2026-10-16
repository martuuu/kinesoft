import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { PublicPlan } from "@/lib/saas-plans-public";

/**
 * [VX2-c1] Landing (`app/page.tsx` real, render sin jsdom). Se mockea solo lo que no es de esta página: la lectura
 * del catálogo (base de datos) y las secciones de VX2-c2 (precios/contacto, con sus propios tests), para afirmar el
 * contrato C-VX-L (qué props les pasa la página). Todo lo demás es el markup real.
 */
const catalog = vi.hoisted(() => ({ plans: [] as PublicPlan[] }));

vi.mock("@/lib/saas-plans-public", () => ({
  getPublicPlanCatalog: async () => catalog.plans,
}));
vi.mock("@/components/landing/pricing", () => ({
  LandingPricing: ({ plans }: { plans: PublicPlan[] }) => (
    <section id="precios" aria-labelledby="precios-title" data-plans={plans.map((p) => p.plan).join(",")}>
      <h2 id="precios-title">Precios</h2>
    </section>
  ),
}));
vi.mock("@/components/landing/contact", () => ({
  LandingContact: ({ startedAt }: { startedAt: number }) => (
    <section id="contacto" aria-labelledby="contacto-title" data-started-at={String(startedAt)}>
      <h2 id="contacto-title">Hablemos</h2>
    </section>
  ),
}));

import HomePage, { metadata, revalidate } from "@/app/page";
import { faqItems } from "@/components/landing/faq";
import { BRAND_NAME } from "@/lib/brand";

function plan(p: PublicPlan["plan"], trialDays: number): PublicPlan {
  return {
    plan: p,
    label: p,
    priceCents: null,
    priceLabel: "Consultá",
    period: null,
    limits: { maxUsers: 1, maxProfessionals: 1, maxStaff: 1 },
    limitsLabel: "",
    trialDays,
    features: [],
    cta: p === "LIBRE" ? "contact" : "signup",
    order: 1,
  };
}

async function render(): Promise<string> {
  return renderToStaticMarkup(await HomePage());
}

const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;

const ENV_KEY = "SAAS_BILLING_MODE";
let prevMode: string | undefined;
beforeEach(() => {
  prevMode = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
  catalog.plans = [plan("INDIVIDUAL", 14), plan("CONSULTORIO", 0), plan("LIBRE", 0)];
});
afterEach(() => {
  if (prevMode === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = prevMode;
});

describe("[VX2-c1] landing", () => {
  it("ISR de 1 h y metadata con la marca (C-VX-L, D-VX25)", () => {
    expect(revalidate).toBe(3600);
    const title = (metadata.title as { absolute: string }).absolute;
    expect(title).toContain(BRAND_NAME);
    expect(metadata.openGraph?.siteName).toBe(BRAND_NAME);
    expect(metadata.metadataBase).toBeInstanceOf(URL);
  });

  it("una sola h1, skip link a #main y landmarks", async () => {
    const html = await render();
    expect(count(html, /<h1[\s>]/g)).toBe(1);
    expect(html).toMatch(/<h1[^>]*>Tu consultorio, <em>ordenado<\/em> de punta a punta\.<\/h1>/);
    // El skip link es lo primero enfocable de la página.
    expect(html).toMatch(/^<div[^>]*><a class="k-skip-link" href="#main">Saltar al contenido<\/a>/);
    expect(html).toContain('<main id="main">');
    expect(html).toMatch(/<header[\s>]/);
    expect(html).toMatch(/<footer[\s>]/);
    expect(html).toMatch(/<nav[^>]*aria-label="Secciones"/);
    expect(html).toMatch(/<nav[^>]*aria-label="Pie de página"/);
  });

  it("cada ancla del menú tiene su sección", async () => {
    const html = await render();
    for (const id of ["funciones", "kinesiologia", "como-empezar", "precios", "preguntas", "contacto"]) {
      expect(html, id).toContain(`href="#${id}"`);
      expect(html, id).toMatch(new RegExp(`<section[^>]*id="${id}"`));
    }
  });

  it("monta precios y contacto de VX2-c2 con el catálogo y un startedAt del render (C-VX-L)", async () => {
    const before = Date.now();
    const html = await render();
    expect(html).toContain('data-plans="INDIVIDUAL,CONSULTORIO,LIBRE"');
    const startedAt = Number(html.match(/data-started-at="(\d+)"/)?.[1]);
    expect(startedAt).toBeGreaterThanOrEqual(before);
    expect(startedAt).toBeLessThanOrEqual(Date.now());
  });

  it("la prueba gratis sale del catálogo (Individual)", async () => {
    const html = await render();
    expect(html).toContain("Probá 14 días gratis");
    expect(html).toContain("Sin medio de pago para empezar.");
    expect(html).toContain("El plan Individual tiene 14 días gratis y no te pide medio de pago.");
  });

  it("[VX-Z] el CTA del header sigue al catálogo: «Probá N días gratis» o «Creá tu cuenta» (nunca «Probá gratis» fijo)", async () => {
    const header = (html: string) => html.match(/<header[\s\S]*?<\/header>/)?.[0] ?? "";
    expect(header(await render())).toMatch(/<a[^>]*href="\/signup"[^>]*>Probá 14 días gratis<\/a>/);
    for (const plans of [[plan("INDIVIDUAL", 0)], []]) {
      catalog.plans = plans;
      const h = header(await render());
      expect(h).toMatch(/<a[^>]*href="\/signup"[^>]*>Creá tu cuenta<\/a>/);
      expect(h).not.toMatch(/gratis/);
    }
  });

  it("sin días de prueba (0 o catálogo vacío) no se promete ninguna", async () => {
    for (const plans of [[plan("INDIVIDUAL", 0)], []]) {
      catalog.plans = plans;
      const html = await render();
      expect(html).toContain("Creá tu cuenta");
      expect(html).not.toMatch(/días gratis/);
      expect(html).not.toContain("Sin medio de pago para empezar.");
      expect(html).toContain('data-plans="');
    }
  });

  it("«¿Cómo pago?» solo con SAAS_BILLING_MODE=manual (D-VX17)", async () => {
    expect(await render()).not.toContain("¿Cómo pago?");
    process.env[ENV_KEY] = "mp";
    expect(await render()).not.toContain("¿Cómo pago?");
    process.env[ENV_KEY] = "manual";
    const html = await render();
    expect(html).toContain("¿Cómo pago?");
    expect(html).toContain("Configuración → Facturación");
    expect(html).not.toMatch(/débito automático/i);
  });

  it("FAQ: la primera abierta y el resto cerradas; sin días si no hay prueba", () => {
    expect(faqItems({ trialDays: 14, showBilling: false })[0].a).toContain("14 días gratis");
    expect(faqItems({ trialDays: null, showBilling: false })[0].a).not.toMatch(/\d/);
    expect(faqItems({ trialDays: 0, showBilling: true }).map((i) => i.q)).toContain("¿Cómo pago?");
  });

  it("especialidad: título de Martin, sin switch, con ejercicios compartidos y el cierre para General (D-VX2/15/27)", async () => {
    const html = await render();
    expect(html).toMatch(/<h2[^>]*id="kinesiologia-title"[^>]*>Enfoque exclusivo para kinesiólogos y osteópatas<\/h2>/);
    expect(html).not.toContain('role="radiogroup"');
    expect(html).toContain("los ejercicios que creás quedan para todo tu consultorio");
    expect(html).toContain(`el catálogo de ${BRAND_NAME}`);
    expect(html).toContain("Terapia manual");
    expect(html).toContain("Diagnóstico específico");
    expect(html).toContain("¿Otro tipo de consultorio? Con Clínica general tenés agenda, turnos e historia clínica.");
  });

  it("sala de espera sin «en vivo» ni pantalla (D-VX26)", async () => {
    const html = await render();
    expect(html).toContain("Recepción marca quién llegó, cobra el copago y cada profesional llama al siguiente.");
    expect(html).not.toMatch(/en vivo|pantalla de la sala|se actualiza sola/i);
  });

  it("los mocks son decorativos (aria-hidden) y sin cifras de plata", async () => {
    const html = await render();
    expect(html).toMatch(/<div[^>]*aria-hidden="true"[^>]*data-testid="product-mock"/);
    expect(html).toMatch(/<div[^>]*aria-hidden="true"[^>]*data-testid="plan-mock"/);
    expect(html).not.toMatch(/\$\s?\d/);
  });

  it("menú mobile: botón con aria-expanded/aria-controls y panel oculto", async () => {
    const html = await render();
    const btn = html.match(/<button[^>]*aria-controls="([^"]+)"[^>]*>/);
    expect(btn?.[0]).toContain('aria-expanded="false"');
    expect(btn?.[0]).toContain('aria-label="Abrir menú"');
    const id = btn![1];
    const panelTag = html.slice(html.lastIndexOf("<div", html.indexOf(`id="${id}"`)), html.indexOf(`id="${id}"`) + 200);
    expect(panelTag).toMatch(/^<div[^>]*hidden/);
  });

  it("CTAs como un solo <a> (sin <button> adentro de un link)", async () => {
    const html = await render();
    expect(html).not.toMatch(/<a[^>]*>(?:(?!<\/a>).)*<button/s);
    expect(html).toMatch(/<a[^>]*href="\/signup"[^>]*>Probá 14 días gratis<\/a>/);
    expect(html).toMatch(/<a[^>]*href="\/login"[^>]*>Ingresar<\/a>/);
  });

  it("footer con © y la marca", async () => {
    expect(await render()).toContain(`© 2026 ${BRAND_NAME}`);
  });
});
