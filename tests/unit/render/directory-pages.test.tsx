import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import type { DirectorySnapshot } from "@/lib/directory-types";

/**
 * DIR-3a (C-DIR5/C-DIR6/C-DIR7): las tres páginas REALES del directorio (`app/(directory)/…`), render sin jsdom.
 *
 * Se mockea solo la red: el snapshot cacheado (`getDirectorySnapshot`, base + data cache) y el alias de slug
 * (`resolveSlugAlias`, base). `next/navigation` se reemplaza por funciones que tiran con el destino en el digest (como
 * las reales) para afirmar 404/redirect. El snapshot de la fixture lo arma `assembleDirectorySnapshot` real: lo que
 * se renderiza tiene la forma que produce el builder en prod.
 */
const state = vi.hoisted(() => ({
  snapshot: null as unknown as DirectorySnapshot,
  snapshotCalls: 0,
  aliases: {} as Record<string, string>,
}));

vi.mock("@/lib/directory-internal", () => ({
  getDirectorySnapshot: async () => {
    state.snapshotCalls++;
    return state.snapshot;
  },
}));
vi.mock("@/lib/public-booking-internal", () => ({
  resolveSlugAlias: async (slug: string) =>
    state.aliases[slug] ? { tenantId: "t-x", slug: state.aliases[slug] } : null,
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" });
  },
  permanentRedirect: (to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;replace;${to};308;` });
  },
}));

import ProfesionalesPage, {
  generateMetadata as listMetadata,
  revalidate as listRevalidate,
} from "@/app/(directory)/profesionales/page";
import ProfesionalPage, {
  generateMetadata as proMetadata,
  generateStaticParams as proStaticParams,
  revalidate as proRevalidate,
} from "@/app/(directory)/profesionales/[nombreId]/page";
import ConsultorioPage, {
  generateMetadata as clinicMetadata,
  generateStaticParams as clinicStaticParams,
  revalidate as clinicRevalidate,
} from "@/app/(directory)/consultorios/[slug]/page";
import DirectoryLayout from "@/app/(directory)/layout";
import { SiteHeader } from "@/components/landing/site-header";
import { SiteFooter } from "@/components/landing/site-footer";
import { assembleDirectorySnapshot, type DirectoryProfileInput } from "@/lib/directory-logic";
import { BRAND_NAME } from "@/lib/brand";

// ── Fixture ───────────────────────────────────────────────────────────
const XSS = `Ana </script><script>alert(1)</script> Pérez\u2028`;

function profile(id: string, publicName: string, extra: Partial<DirectoryProfileInput> = {}): DirectoryProfileInput {
  return {
    id,
    publicName,
    honorific: null,
    licenseKind: null,
    licenseNumber: null,
    licenseJurisdiction: null,
    bio: null,
    licenseVerified: false,
    ...extra,
  };
}

/** `extraPros` profesionales más en «kine-centro», para el paginado (todos con perfil). */
function buildSnapshot(extraPros = 0): DirectorySnapshot {
  const extraIds = Array.from({ length: extraPros }, (_, i) => `prx${String(i).padStart(3, "0")}`);
  const profilesByPractitioner: Record<string, DirectoryProfileInput> = {
    pr_ana: profile("cprofana0001", "Ana Pérez", {
      honorific: "LIC",
      licenseKind: "MP",
      licenseNumber: "4512",
      licenseJurisdiction: "S",
      licenseVerified: true,
      bio: "Kinesióloga deportiva.\nAtiendo lesiones de rodilla.",
    }),
    pr_beto: profile("cprofbeto001", "Beto Gómez", { licenseKind: "MN", licenseNumber: "99887" }),
    pr_xss: profile("cprofxss0001", XSS, { bio: `Bio </script><img src=x onerror=alert(1)> \u2029fin` }),
  };
  for (const id of extraIds) profilesByPractitioner[id] = profile(`cprof${id}`, `Zeta ${id}`);
  return assembleDirectorySnapshot({
    builtAt: new Date("2026-10-16T12:00:00Z"),
    profilesByPractitioner,
    clinics: [
      {
        slug: "kine-centro",
        name: "Kine Centro",
        description: "Consultorio de kinesiología en el centro.",
        phone: "+54 341 555-1234",
        whatsapp: "+54 9 341 555 1234",
        locations: [
          { id: "loc1", name: "Sede Centro", address: "Córdoba 1234", addressLine2: "Piso 2", city: "Rosario", provinceCode: "S" },
        ],
        practitioners: [
          { id: "pr_ana", locationIds: ["loc1"], acceptedInsurerIds: ["ins_osde", "ins_part"] },
          { id: "pr_xss", locationIds: ["loc1"], acceptedInsurerIds: ["ins_local"] },
          { id: "pr_sinperfil", locationIds: ["loc1"], acceptedInsurerIds: [] },
          ...extraIds.map((id) => ({ id, locationIds: ["loc1"], acceptedInsurerIds: [] })),
        ],
        insurers: {
          ins_osde: { isParticular: false, name: "OSDE", payerSlug: "osde" },
          ins_part: { isParticular: true, name: "Particular", payerSlug: null },
          ins_local: { isParticular: false, name: "Mutual Local", payerSlug: null },
        },
        specialtiesByPractitioner: {
          pr_ana: [{ slug: "deportiva", name: "Kinesiología deportiva" }],
          pr_xss: [{ slug: "neuro", name: "Neurorrehabilitación" }],
        },
      },
      {
        slug: "osteo-norte",
        name: "Osteo Norte",
        description: null,
        phone: null,
        whatsapp: null,
        locations: [{ id: "loc2", name: "Principal", address: null, addressLine2: null, city: "Córdoba", provinceCode: "X" }],
        practitioners: [
          { id: "pr_beto", locationIds: ["loc2"], acceptedInsurerIds: ["ins_swiss"] },
          { id: "pr_ana", locationIds: ["loc2"], acceptedInsurerIds: [] },
        ],
        insurers: { ins_swiss: { isParticular: false, name: "Swiss Medical", payerSlug: "swiss-medical" } },
        specialtiesByPractitioner: { pr_beto: [{ slug: "osteopatia", name: "Osteopatía" }] },
      },
      {
        // DIR-D25: reservable pero sin perfiles publicados → tiene página, no suma a /profesionales.
        slug: "sin-perfiles",
        name: "Consultorio Sin Perfiles",
        description: null,
        phone: null,
        whatsapp: null,
        locations: [{ id: "loc3", name: "Única", address: "Mitre 1", addressLine2: null, city: "Salta", provinceCode: "A" }],
        practitioners: [{ id: "pr_otro", locationIds: ["loc3"], acceptedInsurerIds: [] }],
        insurers: {},
        specialtiesByPractitioner: {},
      },
    ],
  });
}

// ── Helpers ───────────────────────────────────────────────────────────
const html = (el: ReactElement) => renderToStaticMarkup(el);

async function thrown(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as { digest?: string }).digest ?? String(e);
  }
  return "no tiró";
}

const count = (h: string, re: RegExp) => (h.match(re) ?? []).length;

function jsonLdBlocks(h: string): string[] {
  return [...h.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

/** Lo que nunca puede salir en una superficie del directorio (meta §1 del brief). */
function expectNoPii(h: string) {
  // Emails: cualquier «algo@dominio». El «@» pelado aparece legítimo en el JSON-LD (`@context`, `@type`).
  expect(h).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
  expect(h.replace(/"@(context|type)"/g, "")).not.toContain("@");
  expect(h).not.toMatch(/rating/i);
  expect(h).not.toMatch(/priceCents|\$\s?\d/);
  expect(h).not.toMatch(/userId/);
}

const ENV_KEY = "DIRECTORY_MODE";
let prevMode: string | undefined;
beforeEach(() => {
  prevMode = process.env[ENV_KEY];
  process.env[ENV_KEY] = "preview";
  state.snapshot = buildSnapshot();
  state.snapshotCalls = 0;
  state.aliases = {};
});
afterEach(() => {
  if (prevMode === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = prevMode;
});

const ANA_PATH = "/profesionales/ana-perez-cprofana0001";

// ── Modo ──────────────────────────────────────────────────────────────
describe("[DIR-3a] DIRECTORY_MODE=off", () => {
  beforeEach(() => {
    process.env[ENV_KEY] = "off";
  });

  it("las 3 rutas dan 404 sin leer el snapshot", async () => {
    expect(await thrown(ProfesionalesPage({ searchParams: {} }))).toBe("NEXT_NOT_FOUND");
    expect(await thrown(ProfesionalPage({ params: { nombreId: "ana-perez-cprofana0001" } }))).toBe("NEXT_NOT_FOUND");
    expect(await thrown(ConsultorioPage({ params: { slug: "kine-centro" }, searchParams: {} }))).toBe("NEXT_NOT_FOUND");
    expect(state.snapshotCalls).toBe(0);
  });

  it("metadata noindex y sin leer el snapshot", async () => {
    for (const m of [
      await listMetadata({ searchParams: {} }),
      await proMetadata({ params: { nombreId: "ana-perez-cprofana0001" } }),
      await clinicMetadata({ params: { slug: "kine-centro" } }),
    ]) {
      expect(m.robots).toEqual({ index: false, follow: false });
    }
    expect(state.snapshotCalls).toBe(0);
  });

  it("la landing no linkea al directorio (header ni footer)", () => {
    expect(html(<SiteHeader trialDays={14} />)).not.toContain('href="/profesionales"');
    expect(html(<SiteFooter email={null} />)).not.toContain('href="/profesionales"');
  });
});

describe("[DIR-3a] metadata según el modo (C-DIR2, C-DIR5)", () => {
  it("ISR: revalidate 600 y generateStaticParams vacío en las rutas con parámetro", () => {
    expect(listRevalidate).toBe(600);
    expect(proRevalidate).toBe(600);
    expect(clinicRevalidate).toBe(600);
    expect(proStaticParams()).toEqual([]);
    expect(clinicStaticParams()).toEqual([]);
  });

  it("preview: noindex/nofollow en las 3; sin link en la landing (DIR-D22)", async () => {
    expect((await listMetadata({ searchParams: {} })).robots).toEqual({ index: false, follow: false });
    expect((await proMetadata({ params: { nombreId: "ana-perez-cprofana0001" } })).robots).toEqual({
      index: false,
      follow: false,
    });
    expect((await clinicMetadata({ params: { slug: "kine-centro" } })).robots).toEqual({ index: false, follow: false });
    expect(html(<SiteHeader />)).not.toContain('href="/profesionales"');
  });

  it("public: indexable, título «<Nombre> · Profesionales · marca», canonical y metadataBase", async () => {
    process.env[ENV_KEY] = "public";
    const m = await proMetadata({ params: { nombreId: "cualquier-nombre-cprofana0001" } });
    expect(m.robots).toEqual({ index: true, follow: true });
    expect(m.title).toEqual({ absolute: `Ana Pérez · Profesionales · ${BRAND_NAME}` });
    expect(m.alternates?.canonical).toBe(ANA_PATH);
    expect(m.metadataBase).toBeInstanceOf(URL);
    expect(m.openGraph?.url).toBe(ANA_PATH);
    expect(String(m.description)).not.toMatch(/4512|matr/i);

    const c = await clinicMetadata({ params: { slug: "kine-centro" } });
    expect(c.title).toEqual({ absolute: `Kine Centro · Consultorios · ${BRAND_NAME}` });
    expect(c.alternates?.canonical).toBe("/consultorios/kine-centro");
    expect(c.robots).toEqual({ index: true, follow: true });

    const l = await listMetadata({ searchParams: { pagina: "2" } });
    expect(l.alternates?.canonical).toBe("/profesionales?pagina=2");
    expect(l.robots).toEqual({ index: true, follow: true });
    // Una combinación de filtros no se indexa (duplica la lista), pero se sigue.
    const f = await listMetadata({ searchParams: { especialidad: "deportiva" } });
    expect(f.robots).toEqual({ index: false, follow: true });
    expect(f.alternates?.canonical).toBe("/profesionales");
  });

  it("public: la landing suma «Buscá un profesional» en header y footer", () => {
    process.env[ENV_KEY] = "public";
    expect(html(<SiteHeader />)).toMatch(/<a href="\/profesionales">Buscá un profesional<\/a>/);
    expect(html(<SiteFooter email={null} />)).toMatch(/href="\/profesionales"[^>]*>Buscá un profesional<\/a>/);
  });
});

// ── /profesionales ────────────────────────────────────────────────────
describe("[DIR-3a] /profesionales", () => {
  it("una h1, form GET con los 4 filtros (sin JS) y las cards de los publicados", async () => {
    const h = html(await ProfesionalesPage({ searchParams: {} }));
    expect(count(h, /<h1[\s>]/g)).toBe(1);
    expect(h).toMatch(/<form[^>]*method="get"[^>]*action="\/profesionales"/);
    for (const n of ["especialidad", "cobertura", "provincia", "ciudad"]) expect(h).toContain(`name="${n}"`);
    expect(h).toContain("3 profesionales");
    expect(h).toContain(`href="${ANA_PATH}"`);
    expect(h).toContain("Lic. Ana Pérez");
    // Sin perfil publicado no aparece (ni por id de practitioner).
    expect(h).not.toContain("pr_sinperfil");
    expect(h).not.toContain("Consultorio Sin Perfiles");
    // Beto atiende en un solo consultorio → «Sacar turno» directo con el deep link `?pro=`.
    expect(h).toContain('href="/c/osteo-norte/booking?pro=pr_beto"');
    // Ana atiende en dos → «Elegí consultorio» al ancla del perfil.
    expect(h).toContain(`href="${ANA_PATH}#consultorios"`);
    expect(h).not.toContain("<script"); // ni JSON-LD ni JS propio en la lista
    expectNoPii(h);
  });

  it("filtra por especialidad, cobertura (incl. particular), provincia y ciudad", async () => {
    let h = html(await ProfesionalesPage({ searchParams: { especialidad: "osteopatia" } }));
    expect(h).toContain("1 profesional<");
    expect(h).toContain("Beto Gómez");
    expect(h).not.toContain("Ana Pérez");

    h = html(await ProfesionalesPage({ searchParams: { cobertura: "particular" } }));
    expect(h).toContain("Ana Pérez");
    expect(h).not.toContain("Beto Gómez");

    h = html(await ProfesionalesPage({ searchParams: { provincia: "X" } }));
    expect(h).toContain("Ana Pérez");
    expect(h).toContain("Beto Gómez");
    expect(h).not.toContain("cprofxss0001"); // solo atiende en Santa Fe

    h = html(await ProfesionalesPage({ searchParams: { ciudad: "  rosario " } }));
    expect(h).toContain("Ana Pérez");
    expect(h).not.toContain("Beto Gómez");
  });

  it("vacío: «Probá sacar un filtro» con un link por filtro activo", async () => {
    const h = html(await ProfesionalesPage({ searchParams: { especialidad: "osteopatia", provincia: "S" } }));
    expect(h).toContain("Probá sacar un filtro");
    expect(h).toContain('href="/profesionales?provincia=S"'); // sacar especialidad
    expect(h).toContain('href="/profesionales?especialidad=osteopatia"'); // sacar provincia
  });

  it("vacío sin nadie publicado: otro mensaje", async () => {
    state.snapshot = { ...state.snapshot, professionals: [] };
    const h = html(await ProfesionalesPage({ searchParams: {} }));
    expect(h).toContain("Todavía no hay profesionales publicados");
  });

  it("paginado de a 24; fuera de rango → la última; filtros conservados en los links", async () => {
    state.snapshot = buildSnapshot(27); // 3 + 27 = 30 → 2 páginas
    let h = html(await ProfesionalesPage({ searchParams: {} }));
    expect(count(h, /<article/g)).toBe(24);
    expect(h).toContain("Página 1 de 2");
    expect(h).toContain('href="/profesionales?pagina=2"');

    h = html(await ProfesionalesPage({ searchParams: { pagina: "99" } }));
    expect(count(h, /<article/g)).toBe(6);
    expect(h).toContain("Página 2 de 2");
    expect(h).toContain('href="/profesionales"'); // «Anterior» = página 1 sin query

    h = html(await ProfesionalesPage({ searchParams: { provincia: "S", pagina: "2" } }));
    expect(h).toContain('href="/profesionales?provincia=S"');
  });

  it("basura en la query no rompe (se descarta)", async () => {
    const h = html(
      await ProfesionalesPage({ searchParams: { especialidad: "<script>", provincia: "ZZ", pagina: "-3", ciudad: ["Rosario", "x"] } })
    );
    expect(h).toContain("Ana Pérez");
    expect(h).not.toContain("<script>");
  });
});

// ── /profesionales/[nombreId] ─────────────────────────────────────────
describe("[DIR-3a] /profesionales/[nombreId]", () => {
  it("nombre no canónico → permanentRedirect al canónico; id inexistente o forma inválida → 404", async () => {
    expect(await thrown(ProfesionalPage({ params: { nombreId: "otro-nombre-cprofana0001" } }))).toBe(
      `NEXT_REDIRECT;replace;${ANA_PATH};308;`
    );
    expect(await thrown(ProfesionalPage({ params: { nombreId: "ana-perez-cnoexiste0001" } }))).toBe("NEXT_NOT_FOUND");
    expect(await thrown(ProfesionalPage({ params: { nombreId: "ana-perez-NO_VALE" } }))).toBe("NEXT_NOT_FOUND");
    // DIR-D23: perfil retirado/oculto = ya no está en el snapshot → 404 inmediato.
    state.snapshot = { ...state.snapshot, professionals: state.snapshot.professionals.filter((p) => p.profileId !== "cprofana0001") };
    expect(await thrown(ProfesionalPage({ params: { nombreId: "ana-perez-cprofana0001" } }))).toBe("NEXT_NOT_FOUND");
  });

  it("perfil: h1, matrícula con «Verificada» solo si Plataforma la verificó, consultorios con «Sacar turno»", async () => {
    const h = html(await ProfesionalPage({ params: { nombreId: "ana-perez-cprofana0001" } }));
    expect(count(h, /<h1[\s>]/g)).toBe(1);
    expect(h).toMatch(/<h1[^>]*>Lic\. Ana Pérez<\/h1>/);
    expect(h).toContain("Matrícula provincial 4512 (Santa Fe)");
    expect(h).toContain("Verificada");
    expect(h).toContain("Kinesiología deportiva");
    expect(h).toContain("OSDE");
    expect(h).toContain("Particular");
    expect(h).toContain('href="/c/kine-centro/booking?pro=pr_ana"');
    expect(h).toContain('href="/c/osteo-norte/booking?pro=pr_ana"');
    expect(h).toContain('href="/consultorios/kine-centro"');
    expect(h).toContain('id="consultorios"');
    expectNoPii(h);

    const beto = html(await ProfesionalPage({ params: { nombreId: "beto-gomez-cprofbeto001" } }));
    expect(beto).toContain("Matrícula nacional 99887");
    expect(beto).not.toContain("Verificada");
  });

  it("JSON-LD Person: parseable, sin matrícula, y un nombre con </script> no cierra el bloque (C-DIR6)", async () => {
    const xssPro = state.snapshot.professionals.find((p) => p.profileId === "cprofxss0001")!;
    const nombreId = xssPro.path.split("/").pop()!;
    const h = html(await ProfesionalPage({ params: { nombreId } }));
    const blocks = jsonLdBlocks(h);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).not.toMatch(/<\/script/i);
    expect(blocks[0]).not.toMatch(/[<>\u2028\u2029]/);
    const ld = JSON.parse(blocks[0]);
    expect(ld["@type"]).toBe("Person");
    expect(ld.name).toBe(XSS);
    expect(ld.description).toBe(xssPro.bio);
    // Fuera del JSON-LD, React escapa el texto: no hay un <script> inyectado.
    expect(count(h, /<script/g)).toBe(1);
    expect(h).not.toContain("<img src=x");

    const ana = jsonLdBlocks(html(await ProfesionalPage({ params: { nombreId: "ana-perez-cprofana0001" } })))[0];
    expect(ana).not.toContain("4512");
    expect(ana).not.toMatch(/license|matr/i);
    expect(JSON.parse(ana).worksFor).toHaveLength(2);
  });
});

// ── /consultorios/[slug] ──────────────────────────────────────────────
describe("[DIR-3a] /consultorios/[slug]", () => {
  it("consultorio: h1, sedes, contacto, profesionales publicados y «Ver todos en el turnero»", async () => {
    const h = html(await ConsultorioPage({ params: { slug: "kine-centro" }, searchParams: {} }));
    expect(count(h, /<h1[\s>]/g)).toBe(1);
    expect(h).toMatch(/<h1[^>]*>Kine Centro<\/h1>/);
    expect(h).toContain("Córdoba 1234, Piso 2");
    expect(h).toContain("Rosario, Santa Fe");
    expect(h).toContain('href="tel:+543415551234"');
    expect(h).toContain('href="https://wa.me/5493415551234"');
    expect(h).toContain('href="/c/kine-centro/booking?pro=pr_ana"');
    expect(h).toContain(`href="${ANA_PATH}"`);
    expect(h).toContain('href="/c/kine-centro/booking"');
    expect(h).toContain("Ver todos en el turnero");
    // El que no publicó su perfil no aparece por nombre ni por id.
    expect(h).not.toContain("pr_sinperfil");
    expectNoPii(h);
    const ld = JSON.parse(jsonLdBlocks(h)[0]);
    expect(ld["@type"]).toBe("MedicalClinic");
    expect(ld.telephone).toBe("+54 341 555-1234");
    expect(ld.address[0]).toMatchObject({ addressLocality: "Rosario", addressRegion: "Santa Fe", addressCountry: "AR" });
    expect(Object.keys(ld)).not.toContain("email");
  });

  it("sin perfiles publicados: la página existe y deriva al turnero (DIR-D25)", async () => {
    const h = html(await ConsultorioPage({ params: { slug: "sin-perfiles" }, searchParams: {} }));
    expect(h).toContain("todavía no publicaron su perfil");
    expect(h).toContain('href="/c/sin-perfiles/booking"');
  });

  // DIR-Z (revisor A, M1): sin la query. La ruta es ISR y leer `searchParams` en un render ISR de Next 14.2 tira
  // DYNAMIC_SERVER_USAGE (500 en producción); un objeto plano en el test no lo reproducía.
  it("alias: slug viejo → permanentRedirect al vigente (sin la query); no listado → 404", async () => {
    state.aliases = { "kine-viejo": "kine-centro", "otro-viejo": "no-listado" };
    expect(
      await thrown(ConsultorioPage({ params: { slug: "kine-viejo" }, searchParams: { utm_source: "x", a: ["1", "2"] } }))
    ).toBe("NEXT_REDIRECT;replace;/consultorios/kine-centro;308;");
    expect(await thrown(ConsultorioPage({ params: { slug: "kine-viejo" }, searchParams: {} }))).toBe(
      "NEXT_REDIRECT;replace;/consultorios/kine-centro;308;"
    );
    // El vigente no está en el directorio: no se revela adónde se mudó.
    expect(await thrown(ConsultorioPage({ params: { slug: "otro-viejo" }, searchParams: {} }))).toBe("NEXT_NOT_FOUND");
    expect(await thrown(ConsultorioPage({ params: { slug: "no-existe" }, searchParams: {} }))).toBe("NEXT_NOT_FOUND");
    expect(await thrown(ConsultorioPage({ params: { slug: "../Etc" }, searchParams: {} }))).toBe("NEXT_NOT_FOUND");
  });
});

// ── Layout ────────────────────────────────────────────────────────────
describe("[DIR-3a] layout del directorio", () => {
  it("skip link a #main, header/main/footer y sin JS propio", () => {
    const h = html(
      <DirectoryLayout>
        <h1>x</h1>
      </DirectoryLayout>
    );
    expect(h).toContain('href="#main"');
    expect(h).toMatch(/<header[\s>]/);
    expect(h).toMatch(/<main[^>]*id="main"/);
    expect(h).toMatch(/<footer[\s>]/);
    expect(h).not.toContain("<script");
    expectNoPii(h);
  });
});
