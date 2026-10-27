/**
 * [LG-P] Páginas `/terminos` y `/privacidad` (PV §27, bloque LG). Render real con `react-dom/server` de las páginas
 * de `app/(legal)/` y de su layout: nada mockeado (son server components puros, sin red ni cookies).
 *
 * - [LG-2] anti-drift: toda cookie `kine_*` / `ks_*` que el código define aparece en la Política de privacidad. Se
 *   barre el código real (no una lista copiada): una cookie nueva sin declarar en la política rompe acá.
 * - [LG-3] versión, los dos textos AAIP de la Disp. 10/2008 LITERALES, la lista de subencargados con su región, y
 *   `LEGAL_ENTITY` con nulos → no hay línea de «Operado por» / «CUIT» (nunca un «null» ni un dato inventado).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import TerminosPage, * as terminosMod from "@/app/(legal)/terminos/page";
import PrivacidadPage, * as privacidadMod from "@/app/(legal)/privacidad/page";
import LegalLayout from "@/app/(legal)/layout";
import { PrivacidadContent } from "@/components/legal/privacidad-content";
import { TerminosContent } from "@/components/legal/terminos-content";
import { legalEntityLine } from "@/components/legal/legal-document";
import { LEGAL_ENTITY, LEGAL_VERSION_LABEL, PRIVACY_PATH, TERMS_PATH } from "@/lib/legal";
import { BRAND_NAME } from "@/lib/brand";

const ROOT = process.cwd();
const terms = renderToStaticMarkup(<TerminosPage />);
const privacy = renderToStaticMarkup(<PrivacidadPage />);
/** Texto plano (sin tags) y con las entidades que React escapa devueltas a su carácter. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

const AAIP_ACCESS =
  "El titular de los datos personales tiene la facultad de ejercer el derecho de acceso a los mismos en forma gratuita a intervalos no inferiores a seis meses, salvo que se acredite un interés legítimo al efecto conforme lo establecido en el artículo 14, inciso 3 de la Ley Nº 25.326.";
const AAIP_AUTHORITY =
  "La AGENCIA DE ACCESO A LA INFORMACIÓN PÚBLICA, en su carácter de Órgano de Control de la Ley N° 25.326, tiene la atribución de atender las denuncias y reclamos que interpongan quienes resulten afectados en sus derechos por incumplimiento de las normas vigentes en materia de protección de datos personales.";

const SUBPROCESSORS: [string, string][] = [
  ["Supabase", "São Paulo, sa-east-1"],
  ["Vercel", "São Paulo, gru1"],
  ["Upstash", "sa-east-1"],
  ["Resend", "EE. UU."],
  ["Mercado Pago", "Argentina"],
  ["Meta WhatsApp Business", "EE. UU., solo si se conecta"],
  ["Sentry", "EE. UU."],
];

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (f === "node_modules" || f === ".next") return [];
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
}

/** Nombres de cookie propios: literales de string `"kine_…"` / `"ks_…"` en el código que corre (no en comentarios). */
function cookieNamesInCode(): string[] {
  const files = [...["lib", "app", "components", "hooks"].flatMap((d) => walk(join(ROOT, d))), join(ROOT, "middleware.ts")];
  const names = new Set<string>();
  for (const f of files) {
    if (!existsSync(f)) continue;
    // Se sacan los comentarios: ahí los nombres van entre backticks y no son cookies que se setean.
    const src = readFileSync(f, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const m of src.matchAll(/["'`]((?:kine|ks)_[a-z0-9_]+)["'`]/g)) names.add(m[1]);
  }
  return [...names].sort();
}

describe("[LG-2] cookies declaradas en /privacidad", () => {
  const found = cookieNamesInCode();

  it("anti-false-green: el barrido encuentra las cookies conocidas", () => {
    expect(found).toEqual(expect.arrayContaining(["kine_tenant", "kine_2fa", "ks_recovery", "kine_tv"]));
    expect(found.length).toBeGreaterThanOrEqual(11);
  });

  it("toda cookie kine_*/ks_* del código aparece en la política, y también la de sesión de Supabase", () => {
    const missing = found.filter((c) => !privacy.includes(`>${c}<`));
    expect(missing, `cookies sin declarar en /privacidad: ${missing.join(", ")}`).toEqual([]);
    expect(privacy).toContain("sb-…-auth-token");
    expect(text(privacy).toLowerCase()).toContain("sin analítica ni publicidad");
  });
});

describe("[LG-3] /terminos y /privacidad", () => {
  it("una sola h1 cada una, con la versión vigente y sin banner de borrador", () => {
    for (const [html, h1] of [
      [terms, "Términos y condiciones"],
      [privacy, "Política de privacidad"],
    ] as const) {
      expect((html.match(/<h1[\s>]/g) ?? []).length, h1).toBe(1);
      expect(html).toMatch(new RegExp(`<h1[^>]*>${h1}</h1>`));
      expect(text(html)).toContain(LEGAL_VERSION_LABEL);
      expect(text(html).toLowerCase()).not.toContain("borrador");
    }
  });

  it("índice con anclas: cada link del índice apunta a una sección que existe", () => {
    for (const html of [terms, privacy]) {
      const nav = html.match(/<nav[^>]*aria-labelledby="indice"[^>]*>[\s\S]*?<\/nav>/)?.[0] ?? "";
      const anchors = [...nav.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
      expect(anchors.length).toBeGreaterThanOrEqual(13);
      for (const a of anchors) expect(html, a).toContain(`id="${a}"`);
    }
  });

  it("privacidad: los dos textos de la Disp. AAIP 10/2008, literales", () => {
    expect(text(privacy)).toContain(AAIP_ACCESS);
    expect(text(privacy)).toContain(AAIP_AUTHORITY);
  });

  it("privacidad: subencargados con su región, transferencias con cláusulas (Disp. 60-E/2016) y ARCO por ticket", () => {
    const t = text(privacy);
    for (const [name, region] of SUBPROCESSORS) expect(t, name).toContain(`${name} (${region})`);
    expect(t).toContain("Google y Facebook");
    expect(t).toContain("60-E/2016");
    expect(t).toContain("art. 25");
    expect(t).toContain("26.529");
    expect(privacy).toContain('href="/contacto?motivo=privacidad"');
    expect(t).toContain("nunca la historia clínica");
  });

  it("términos: cobro el día 4, tope de responsabilidad, jurisdicción y link a la política", () => {
    const t = text(terms);
    expect(t).toContain("día 4");
    expect(t).toContain("últimos 12 meses");
    expect(t).toContain(LEGAL_ENTITY.jurisdiction);
    expect(t).toContain("15 días");
    expect(terms).toContain(`href="${PRIVACY_PATH}`);
    // Los subencargados también se listan en el acuerdo de tratamiento.
    for (const [name] of SUBPROCESSORS) expect(t, name).toContain(name);
  });

  it("la marca sale de BRAND_NAME", () => {
    expect(text(terms)).toContain(BRAND_NAME);
    expect(text(privacy)).toContain(BRAND_NAME);
  });

  it("LEGAL_ENTITY con nulos (hoy) → sin línea de operador, CUIT ni domicilio", () => {
    expect(LEGAL_ENTITY.name).toBeNull();
    for (const html of [terms, privacy]) {
      const t = text(html);
      expect(t).not.toContain("Operado por");
      expect(t).not.toContain("CUIT");
      expect(t).not.toMatch(/\bnull\b/);
    }
    expect(legalEntityLine(LEGAL_ENTITY)).toBeNull();
  });

  it("LEGAL_ENTITY completo → la línea aparece (solo con lo que hay)", () => {
    const full = { ...LEGAL_ENTITY, name: "Ejemplo SRL", cuit: "30-00000000-0", address: "Calle 1, CABA" };
    expect(legalEntityLine(full)).toBe("Operado por Ejemplo SRL · CUIT 30-00000000-0 · Domicilio: Calle 1, CABA");
    expect(legalEntityLine({ ...LEGAL_ENTITY, name: "Ejemplo SRL" })).toBe("Operado por Ejemplo SRL");
    for (const html of [
      renderToStaticMarkup(<PrivacidadContent entity={full} />),
      renderToStaticMarkup(<TerminosContent entity={full} />),
    ]) {
      expect(text(html)).toContain("Operado por Ejemplo SRL · CUIT 30-00000000-0");
    }
  });

  it("force-static, metadata con título y descripción, indexables y canónicas", () => {
    for (const [mod, path] of [
      [terminosMod, TERMS_PATH],
      [privacidadMod, PRIVACY_PATH],
    ] as const) {
      expect(mod.dynamic).toBe("force-static");
      // [BR-6] Solo el nombre de la página: la marca la agrega el template del root (`%s · ${BRAND_NAME}`); repetirla acá
      // daba «Términos y condiciones · <marca> · <marca>».
      expect(String(mod.metadata.title)).toBeTruthy();
      expect(String(mod.metadata.title)).not.toContain(BRAND_NAME);
      expect(mod.metadata.description).toBeTruthy();
      expect(mod.metadata.robots).toBeUndefined();
      expect(mod.metadata.alternates?.canonical).toBe(path);
    }
  });

  it("layout: skip link, main#main, footer con los dos links legales y sin «use client» en todo el grupo", () => {
    const html = renderToStaticMarkup(<LegalLayout>{<p>x</p>}</LegalLayout>);
    expect(html).toContain('href="#main"');
    expect(html).toMatch(/<main id="main"/);
    const foot = html.slice(html.lastIndexOf("<footer"));
    expect(foot).toContain(`href="${TERMS_PATH}"`);
    expect(foot).toContain(`href="${PRIVACY_PATH}"`);
    const files = [
      ...walk(join(ROOT, "app", "(legal)")),
      ...walk(join(ROOT, "components", "legal")),
    ];
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const f of files) expect(readFileSync(f, "utf8"), f).not.toMatch(/^\s*["']use client["']/m);
  });
});
