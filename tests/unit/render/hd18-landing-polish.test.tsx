/**
 * [HD-18] Pulido de la landing y del panel de producto del login (PV §27, sesión W1j).
 *
 * - Funciones: los tiles «Cobrá la seña con tu Mercado Pago» y «Pantalla para la sala de espera» dependen de flags del
 *   server que `app/page.tsx` lee en el render ISR (`mpConnectMode()` y `env.REALTIME_DRIVER`). Se renderiza la
 *   página real; se mockea solo el catálogo (base) y las secciones de precios/contacto, como `landing.test.tsx`.
 * - Precios: tarjetas parejas por estructura (subgrid; separador y lista al pie, la lista es la que crece).
 * - Panel del login: turnos con avatar y estado, con ellipsis en el texto.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PublicPlan } from "@/lib/saas-plans-public";

const catalog = vi.hoisted(() => ({ plans: [] as PublicPlan[] }));

vi.mock("@/lib/saas-plans-public", async (orig) => ({
  ...(await orig<typeof import("@/lib/saas-plans-public")>()),
  getPublicPlanCatalog: async () => catalog.plans,
}));
vi.mock("@/lib/db", () => ({ prismaService: {} }));
vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn }));
vi.mock("@/components/landing/contact", () => ({
  LandingContact: () => <section id="contacto" aria-labelledby="contacto-title" />,
}));

import HomePage, { dynamic, revalidate } from "@/app/page";
import { env } from "@/lib/env";
import { LandingPricing } from "@/components/landing/pricing";
import { ProductPanel } from "@/components/auth/product-panel";
import { toPublicPlans } from "@/lib/saas-plans-public";
import { PLAN_DEFAULTS, SAAS_PLANS } from "@/lib/saas-plans-logic";

const mutableEnv = env as { REALTIME_DRIVER: string };
let prevDriver: string;
let prevMp: string | undefined;

beforeEach(() => {
  prevDriver = mutableEnv.REALTIME_DRIVER;
  prevMp = process.env.MP_CONNECT_MODE;
  catalog.plans = [];
});
afterEach(() => {
  mutableEnv.REALTIME_DRIVER = prevDriver;
  if (prevMp === undefined) delete process.env.MP_CONNECT_MODE;
  else process.env.MP_CONNECT_MODE = prevMp;
});

const render = async () => renderToStaticMarkup(await HomePage());
const funciones = (html: string) => html.match(/<section[^>]*id="funciones"[\s\S]*?<\/section>/)?.[0] ?? "";

describe("[HD-18] landing: tiles con flag", () => {
  it("[HD-18] sigue siendo ISR (revalidate + force-static): los flags son env del server leídos en el render", () => {
    expect(revalidate).toBe(3600);
    expect(dynamic).toBe("force-static");
  });

  it("[HD-18] con MP_CONNECT_MODE off y REALTIME_DRIVER ≠ supabase no aparecen los dos tiles", async () => {
    delete process.env.MP_CONNECT_MODE;
    mutableEnv.REALTIME_DRIVER = "off";
    const f = funciones(await render());
    expect(f).toContain("Turnos online");
    expect(f).not.toContain("Cobrá la seña con tu Mercado Pago");
    expect(f).not.toContain("Pantalla para la sala de espera");
    expect(f).not.toMatch(/mercado\s*pago/i);
    mutableEnv.REALTIME_DRIVER = "local";
    expect(funciones(await render())).not.toContain("Pantalla para la sala de espera");
  });

  it("[HD-18] con MP_CONNECT_MODE ≠ off y REALTIME_DRIVER=supabase aparecen los dos (la pantalla, con plan Clínica)", async () => {
    process.env.MP_CONNECT_MODE = "sandbox";
    mutableEnv.REALTIME_DRIVER = "supabase";
    const f = funciones(await render());
    expect(f).toMatch(/<h3[^>]*>Cobrá la seña con tu Mercado Pago<\/h3>/);
    const tv = f.match(/<article[^>]*>(?:(?!<\/article>)[\s\S])*Pantalla para la sala de espera[\s\S]*?<\/article>/)?.[0] ?? "";
    expect(tv).toContain("Plan Clínica");
    // Sigue sin WhatsApp (public-claims) aunque los flags estén prendidos.
    expect(f).not.toMatch(/whatsapp/i);
  });

  it("[HD-18] cada flag prende solo su tile", async () => {
    process.env.MP_CONNECT_MODE = "live";
    mutableEnv.REALTIME_DRIVER = "off";
    let f = funciones(await render());
    expect(f).toContain("Cobrá la seña con tu Mercado Pago");
    expect(f).not.toContain("Pantalla para la sala de espera");
    delete process.env.MP_CONNECT_MODE;
    mutableEnv.REALTIME_DRIVER = "supabase";
    f = funciones(await render());
    expect(f).not.toContain("Cobrá la seña con tu Mercado Pago");
    expect(f).toContain("Pantalla para la sala de espera");
  });
});

const ROWS = SAAS_PLANS.map((plan) => ({ plan, ...PLAN_DEFAULTS[plan] }));

describe("[HD-18] precios: tarjetas parejas", () => {
  it("[HD-18] 3 tarjetas de largo distinto con la misma estructura: separador y lista al pie, la lista es el último hijo", () => {
    const plans = toPublicPlans(ROWS);
    const cards = plans.filter((p) => p.cta === "signup");
    expect(cards).toHaveLength(3);
    const lens = cards.map((p) => p.features.flatMap((f) => f.bullets).length);
    expect(new Set(lens).size).toBeGreaterThan(1); // largos distintos (sin falso verde)
    const h = renderToStaticMarkup(<LandingPricing plans={plans} />);
    const arts = h.match(/<article[\s\S]*?<\/article>/g) ?? [];
    expect(arts).toHaveLength(3);
    for (const a of arts) {
      // Hijos directos en orden: head, priceBlock, cta, sep, listArea (último).
      expect(a).toMatch(/<div class="[^"]*_sep_[^"]*"><\/div><div class="[^"]*_listArea_[^"]*">[\s\S]*<\/div><\/article>$/);
    }
    const css = readFileSync(join(process.cwd(), "components/landing/pricing.module.css"), "utf8");
    const card = css.match(/\n\.card \{([^}]*)\}/)?.[1] ?? "";
    expect(card).toMatch(/grid-template-rows:\s*subgrid/);
    expect(card).toMatch(/grid-row:\s*span 5/);
  });
});

describe("[HD-18] panel de producto del login", () => {
  it("[HD-18] cada turno del mock lleva avatar y estado; el texto corta con ellipsis", () => {
    const h = renderToStaticMarkup(<ProductPanel />);
    const appts = h.match(/<div class="[^"]*_appt_[^"]*"[\s\S]*?(?=<div class="[^"]*_appt_|<\/div><\/div><\/div>)/g) ?? [];
    expect(appts.length).toBeGreaterThanOrEqual(8);
    const short = appts.filter((a) => /class="[^"]*_short_/.test(a.slice(0, 120)));
    expect(short.length).toBeGreaterThanOrEqual(3); // turnos de un cupo
    for (const a of appts) {
      expect(a).toMatch(/class="[^"]*_apptAv_[^"]*"[^>]*>[A-Z]{2}</);
      expect(a).toMatch(/class="[^"]*_apptS_[^"]*"[^>]*>(Atendido|En atención|Confirmado|Pendiente|En sala)</);
    }
    const css = readFileSync(join(process.cwd(), "components/auth/product-panel.module.css"), "utf8");
    for (const cls of ["apptT", "apptS"]) {
      const rule = css.match(new RegExp(`\\n\\.${cls} \\{([^}]*)\\}`))?.[1] ?? "";
      expect(rule, cls).toContain("text-overflow: ellipsis");
      expect(rule, cls).toContain("white-space: nowrap");
      expect(rule, cls).toContain("overflow: hidden");
    }
  });
});
