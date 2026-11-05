import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import type { ClinicSiteLookup } from "@/lib/clinic-site-types";

/**
 * CF3 (SD-U, §30 D-CF3-9/D-CF3-10) · la página REAL de la sede `/<slug>` (`app/(sede)/[slug]/page.tsx`), su 404, su
 * metadata, el canonical de `/consultorios/<slug>` y el link «← Consultorio» del turnero. Render sin jsdom.
 *
 * Se mockea solo la red: `getClinicSite` (snapshot cacheado = base + data cache) y el snapshot del directorio. El DTO
 * de la fixture lo arma `assembleClinicSite` REAL (con basura privada pegada en la entrada): lo que se renderiza tiene
 * la forma que produce el builder en prod. `next/navigation` tira con el destino en el digest, como el real.
 */
const state = vi.hoisted(() => ({ lookup: null as ClinicSiteLookup, calls: [] as string[] }));
vi.mock("@/lib/clinic-site-internal", () => ({
  getClinicSite: async (slug: string) => {
    state.calls.push(slug);
    return state.lookup;
  },
}));
const dirState = vi.hoisted(() => ({ clinics: [] as unknown[] }));
vi.mock("@/lib/directory-internal", () => ({
  getDirectorySnapshot: async () => ({ version: 1, builtAt: "", professionals: [], clinics: dirState.clinics }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" });
  },
  permanentRedirect: (to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;replace;${to};308;` });
  },
}));

import SedeDigitalPage, * as pageModule from "@/app/(sede)/[slug]/page";
import * as layoutModule from "@/app/(sede)/[slug]/layout";
import SedeNotFound, { metadata as notFoundMetadata } from "@/app/(sede)/[slug]/not-found";
import { generateMetadata as clinicDirMetadata } from "@/app/(directory)/consultorios/[slug]/page";
import { PublicBookingWizard } from "@/components/booking/public-booking-wizard";
import { assembleClinicSite, type ClinicSiteClinicInput, type ClinicSiteInput } from "@/lib/clinic-site-logic";
import type { OpeningRange } from "@/lib/opening-hours-summary";
import type { PublicClinic } from "@/lib/public-booking-types";
import { BRAND_NAME } from "@/lib/brand";
import { formatARS } from "@/lib/format";

const r = (dow: number, s: number, e: number): OpeningRange => ({ dow, startMin: s * 60, endMin: e * 60, validFrom: null, validUntil: null });

function siteInput(over: Partial<ClinicSiteInput> = {}): ClinicSiteInput {
  const leaky = (id: string, name: string, specialty: string, licenseNumber: string | null) =>
    ({
      id,
      name,
      specialty,
      licenseNumber,
      acceptedInsurerIds: ["os-1"],
      email: `${id}@privado.test`,
      contactWhatsapp: "+5493410000001",
    }) as ClinicSiteClinicInput["practitioners"][number];
  return {
    tenant: {
      slug: "tmp",
      name: "TMP",
      palette: "coral",
      siteTagline: "Kinesiología y osteopatía en Palermo",
      publicDescription: "Rehabilitación, kinesiología deportiva y osteopatía.",
      phone: "011 4832-5517",
      whatsapp: "+54 9 11 5023-4471",
      logoStorageKey: null,
      logoUpdatedAt: null,
      ...({ publicEmail: "contacto@tmp.test" } as object),
    },
    clinic: {
      openingSummary: "Lun a vie 8 a 20 · Sáb 9 a 13",
      practitioners: [
        leaky("tomas", "Lic. Tomás Paredes", "Kinesiología deportiva", "MN 12345"),
        leaky("mariana", "Mariana Pérez", "Osteopatía", null),
      ],
      services: [
        { id: "svc-k", name: "Sesión de kinesiología", durationMin: 45, priceCents: 0, practitionerId: "tomas", practitionerIds: ["tomas"] },
        { id: "svc-o", name: "Sesión de osteopatía", durationMin: 50, priceCents: 0, practitionerId: "mariana", practitionerIds: ["mariana"] },
      ],
    },
    locations: [{ name: "Palermo", address: "Av. Santa Fe 3450", addressLine2: "2.º B", city: "Palermo", province: "Ciudad de Buenos Aires" }],
    insurers: [{ id: "os-1", name: "OSDE", isParticular: false }],
    showPublicPrice: { tomas: true, mariana: false },
    practitionerPrices: { "tomas:svc-k": 1_800_000, "mariana:svc-o": 2_222_200 },
    particularCopagoCents: 0,
    practitionerHours: { tomas: [r(1, 8, 14), r(2, 14, 20)], mariana: [r(1, 15, 20), r(6, 9, 13)] },
    today: "2026-11-05",
    ...over,
  };
}

async function render(el: Promise<ReactElement> | ReactElement): Promise<string> {
  return renderToStaticMarkup(await el);
}
async function digestOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as { digest?: string }).digest ?? String(e);
  }
  return "no tiró";
}
const page = (slug: string) => SedeDigitalPage({ params: { slug } });
const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;

const prevMode = process.env.DIRECTORY_MODE;
beforeEach(() => {
  state.lookup = assembleClinicSite(siteInput());
  state.calls = [];
  dirState.clinics = [];
});
afterEach(() => {
  if (prevMode === undefined) delete process.env.DIRECTORY_MODE;
  else process.env.DIRECTORY_MODE = prevMode;
});

describe("[CF3-SDU] contrato de la ruta", () => {
  it("[CF3-SDU11] ISR force-static, sin params en el build y SIN dynamicParams=false (rompería /<slug>/logo)", () => {
    expect(pageModule.revalidate).toBe(600);
    expect(pageModule.dynamic).toBe("force-static");
    expect(pageModule.generateStaticParams()).toEqual([]);
    expect("dynamicParams" in pageModule).toBe(false);
    expect("dynamicParams" in layoutModule).toBe(false);
    for (const f of ["page.tsx", "layout.tsx", "not-found.tsx"]) {
      // Sin comentarios: el porqué de cada archivo nombra justamente lo que no se usa.
      const src = readFileSync(join(process.cwd(), "app/(sede)/[slug]", f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      // Ni la sesión ni el request: en un render ISR eso es un 500 (DIR-Z-F1).
      expect(src, f).not.toMatch(/from "next\/headers"|cookies\(|headers\(\)|searchParams|getSession|supabase/);
    }
  });

  it("[CF3-SDU12] inexistente/apagada → 404; slug con forma inválida → 404 sin tocar el cache; alias → 308", async () => {
    state.lookup = null;
    expect(await digestOf(page("no-existe"))).toBe("NEXT_NOT_FOUND");
    state.calls = [];
    for (const bad of ["wp-admin.php", "..%2Fetc", "%E0%A4%A", "a_b", "-tmp"]) expect(await digestOf(page(bad)), bad).toBe("NEXT_NOT_FOUND");
    expect(state.calls).toEqual([]);
    state.lookup = { redirectTo: "tmp" };
    expect(await digestOf(page("TMP"))).toBe("NEXT_REDIRECT;replace;/tmp;308;");
  });

  it("[CF3-SDU13] 404 propio: estático, noindex, una h1, sin nada del consultorio", () => {
    const html = renderToStaticMarkup(<SedeNotFound />);
    expect(count(html, /<h1/g)).toBe(1);
    expect(html).toContain("No encontramos esta página");
    expect(html).toContain('href="/"');
    expect(notFoundMetadata.robots).toEqual({ index: false, follow: false });
  });
});

describe("[CF3-SDU] contenido (D-CF3-9)", () => {
  it("[CF3-SDU14] encabezado, CTA, profesionales sin precios (Martin 05-nov), matrícula y ?pro=", async () => {
    const html = await render(page("tmp"));
    expect(count(html, /<h1/g)).toBe(1);
    for (const tag of ["<header", "<nav", "<main", "<footer"]) expect(html).toContain(tag);
    expect(html).toContain('href="#main"'); // skip link
    expect(html).toContain('data-palette="coral"');
    expect(html).toContain("TMP");
    expect(html).toContain("Kinesiología y osteopatía en Palermo");
    expect(html).toContain("Rehabilitación, kinesiología deportiva y osteopatía.");
    expect(html).toContain('href="/c/tmp/booking"');
    expect(html).toContain('href="/c/tmp/booking?pro=tomas"');
    expect(html).toContain("Sacar turno con Tomás");
    expect(html).toContain('aria-label="Sacar turno con Lic. Tomás Paredes"');
    expect(html).toContain('href="/c/tmp/booking?pro=mariana"');
    // Martin (05-nov): la sede no muestra precios (ni el visible ni el oculto): el valor aparece en el turnero.
    expect(html).not.toContain(formatARS(1_800_000));
    expect(html).not.toContain("Consultá el valor");
    expect(html).not.toContain("22.222");
    expect(html).toContain("Matrícula MN 12345");
    expect(count(html, /Matrícula/g)).toBe(1); // Mariana no cargó
    expect(html).toContain("45 min");
    expect(html).toContain(`Hecho con ${BRAND_NAME}`);
  });

  it("[CF3-SDU15] «Quién atiende cada día», horarios, sede con mapa, obras sociales y contacto del consultorio", async () => {
    const html = await render(page("tmp"));
    expect(html).toContain("Quién atiende cada día");
    expect(html).toMatch(/Lun<\/abbr>[\s\S]*Tomás[\s\S]*8 a 14 h[\s\S]*Mariana[\s\S]*15 a 20 h/);
    expect(html).toContain("Sáb");
    expect(html).toContain("<th scope=\"row\">Domingo</th><td>Cerrado</td>");
    expect(html).toContain("8 a 14 y 15 a 20 h"); // lunes: unión de los dos
    expect(html).toContain("https://www.google.com/maps/search/?api=1&amp;query=");
    expect(html).toContain("(se abre en otra pestaña)");
    expect(html).toContain("OSDE");
    expect(html).toContain('href="tel:01148325517"');
    expect(html).toContain('href="https://wa.me/5491150234471"'); // claim-ok: prisma/schema.prisma:58
    expect(html).toContain("Lun a vie 8 a 20 · Sáb 9 a 13");
  });

  it("[CF3-SDU16] PII: ni email (del consultorio ni de profesionales) ni el celular de un profesional; JSON-LD escapado", async () => {
    const t = siteInput().tenant;
    state.lookup = assembleClinicSite(siteInput({ tenant: { ...t, name: "Evil </script><script>alert(1)</script>" } }));
    const html = await render(page("tmp"));
    expect(html).not.toContain("@privado.test");
    expect(html).not.toContain("contacto@tmp.test");
    expect(html).not.toContain("3410000001");
    expect(html).not.toContain("mailto:");
    const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1];
    expect(ld).not.toContain("</script>");
    expect(JSON.parse(ld)).toMatchObject({ "@type": "MedicalClinic", url: expect.stringMatching(/\/tmp$/) });
    expect(html).not.toContain("<script>alert(1)");
  });

  it("[CF3-SDU17] turnero cerrado y sin contacto: sin CTA de turno, sin «Quién atiende», sin banda de contacto, sin anclas rotas", async () => {
    const t = siteInput().tenant;
    state.lookup = assembleClinicSite(siteInput({ clinic: null, tenant: { ...t, phone: null, whatsapp: null } }));
    const html = await render(page("tmp"));
    expect(html).not.toContain("/c/tmp/booking");
    expect(html).not.toContain("Quién atiende cada día");
    expect(html).not.toContain('id="contacto"');
    expect(html).not.toContain('href="#contacto"');
    expect(html).toContain("Por ahora no hay turnos online");
    expect(count(html, /<h1/g)).toBe(1);
  });

  it("[CF3-SDU18] con logo: <img> de la ruta pública con alt; sin logo: monograma decorativo", async () => {
    const t = siteInput().tenant;
    state.lookup = assembleClinicSite(
      siteInput({ tenant: { ...t, logoStorageKey: "tenants/x/logo.png", logoUpdatedAt: new Date("2026-11-01T12:00:00Z") } })
    );
    const html = await render(page("tmp"));
    expect(html).toMatch(/<img[^>]+src="\/tmp\/logo\?v=\d+"[^>]+alt="Logo de TMP"/);
    state.lookup = assembleClinicSite(siteInput());
    // BR-H: la única <img> sin logo es la foto decorativa del encabezado (alt vacío); del logo, ninguna.
    const without = await render(page("tmp"));
    expect(without).not.toMatch(/\/logo\?v=/);
    expect(without.match(/<img[^>]*>/g)).toEqual([expect.stringMatching(/src="\/sede\/hero-consultorio-1600\.jpg"[^>]*alt=""/)]);
  });
});

describe("[CF3-SDU] SEO", () => {
  it("[CF3-SDU19] metadata: título absoluto, descripción, canonical /<slug>, OG, index; null/alias → noindex", async () => {
    const m = await pageModule.generateMetadata({ params: { slug: "tmp" } });
    expect(m.title).toEqual({ absolute: "TMP · Kinesiología y osteopatía en Palermo" });
    expect(m.description).toBe("Rehabilitación, kinesiología deportiva y osteopatía.");
    expect(m.alternates?.canonical).toBe("/tmp");
    expect(m.robots).toEqual({ index: true, follow: true });
    expect(m.openGraph).toMatchObject({ url: "/tmp", siteName: BRAND_NAME, locale: "es_AR" });
    expect(m.metadataBase).toBeInstanceOf(URL);
    state.lookup = null;
    expect((await pageModule.generateMetadata({ params: { slug: "tmp" } })).robots).toEqual({ index: false, follow: false });
    state.lookup = { redirectTo: "tmp" };
    expect((await pageModule.generateMetadata({ params: { slug: "viejo" } })).robots).toEqual({ index: false, follow: false });
  });

  it("[CF3-SDU20] /consultorios/<slug> con sede publicada → canonical /<slug>; sin sede → la propia", async () => {
    process.env.DIRECTORY_MODE = "public";
    dirState.clinics = [{ slug: "tmp", path: "/consultorios/tmp", name: "TMP", description: null, locations: [] }];
    expect((await clinicDirMetadata({ params: { slug: "tmp" } })).alternates?.canonical).toBe("/tmp");
    state.lookup = null;
    expect((await clinicDirMetadata({ params: { slug: "tmp" } })).alternates?.canonical).toBe("/consultorios/tmp");
  });
});

describe("[CF3-SDU] turnero: «← Consultorio»", () => {
  const clinic = {
    slug: "tmp",
    name: "TMP",
    legalName: null,
    palette: "sky",
    openingSummary: null,
    practitioners: [],
    services: [],
    locations: [],
    insurers: [],
  } as unknown as PublicClinic;

  it("[CF3-SDU21] con sede publicada la marca del nav vuelve a /<slug>; sin sede, no hay link", () => {
    const withSite = renderToStaticMarkup(
      <PublicBookingWizard clinic={clinic} session={null} prefill={null} siteHref="/tmp" />
    );
    expect(withSite).toMatch(/<a href="\/tmp"[^>]*>[\s\S]*Volver al sitio de [\s\S]*TMP/);
    const without = renderToStaticMarkup(<PublicBookingWizard clinic={clinic} session={null} prefill={null} />);
    expect(without).not.toContain('href="/tmp"');
    expect(without).not.toContain("Volver al sitio de");
  });
});

// CF3 ZF3 (revisor de UI): el nav linkeaba «Horarios y sede» / «Obras sociales» aunque `VisitSection` no se pintara, y
// sin canales el vacío de profesionales decía «Escribinos o llamanos». Y «Ver en el mapa» a 44 px en táctil.
describe("[CF3-ZF3-10] sede sin datos", () => {
  it("[CF3-ZF3-10a] sin horarios, sedes, coberturas ni profesionales: sin #visita ni #coberturas en el nav", async () => {
    const t = siteInput().tenant;
    state.lookup = assembleClinicSite(siteInput({ clinic: null, locations: [], insurers: [], tenant: { ...t, phone: null, whatsapp: null } }));
    const html = await render(page("tmp"));
    expect(html).not.toContain('id="visita"');
    expect(html).not.toContain('href="#visita"');
    expect(html).not.toContain('href="#coberturas"');
    expect(html).toContain("Por ahora no hay turnos online.");
    expect(html).not.toContain("Escribinos o llamanos");
  });

  it("[CF3-ZF3-10b] con canales, el vacío de profesionales invita a escribir o llamar", async () => {
    state.lookup = assembleClinicSite(siteInput({ clinic: null }));
    const html = await render(page("tmp"));
    expect(html).toContain("Escribinos o llamanos");
    expect(html).toContain('href="#visita"');
  });

  it("[CF3-ZF3-5c] «Ver en el mapa» llega a 44 px en táctil / mobile", () => {
    const css = readFileSync(join(process.cwd(), "components/sede/sede.module.css"), "utf8");
    expect(css).toMatch(/@media \(pointer: coarse\), \(max-width: 767px\) \{ \.fact a \{ min-height: 44px; \} \}/);
  });
});
