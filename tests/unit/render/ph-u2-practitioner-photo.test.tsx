import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { PractitionerPhoto } from "@/components/ui/practitioner-photo";
// [CF3-ZF4b] la regla de iniciales vive en lib/person-initials.ts (antes era una copia local en el componente).
import { personInitials as practitionerInitials } from "@/lib/person-initials";
import { SedePage } from "@/components/sede/sede-page";
import { PractitionerStep } from "@/components/booking/wizard/practitioner-step";
import type { ClinicSite, ClinicSitePractitioner } from "@/lib/clinic-site-types";
import type { PublicClinic } from "@/lib/public-booking-types";

/**
 * CF3b (PH-U2, pedido de Martin del 05-nov) · foto del profesional con el marco «profesional» para TODOS los
 * consultorios: fondo blanco, sombra en el color del consultorio, anillo fino y el logo del consultorio chico abajo a la
 * derecha. La usan la selección de profesional del turnero y las tarjetas de la sede (y PH-U1, el avatar de la app).
 *
 * Render real con `renderToStaticMarkup` (sin jsdom, sin mocks: el componente es server-safe y no toca red). El CSS se
 * lee como texto (la capa unit no tiene layout): el contrato es el archivo que sirve Next.
 *
 * Contrato FOTO (cf3-handoffs, literal): `PractitionerPhoto({ src, name, logoUrl, size = 96, className })`, server-safe,
 * sin "use client", sin framer; sin foto → iniciales con el mismo marco; `<img>` con width/height, `alt` = nombre o
 * vacío si el nombre ya está al lado, `loading="lazy"` salvo que se indique. DTOs de PH-S:
 * `PublicClinic.practitioners[].photoUrl?`, `ClinicSite.practitioners[].photoUrl`.
 */
const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const noComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "");
const PHOTO_CSS = read("components/ui/practitioner-photo.module.css");
const PHOTO_TSX = read("components/ui/practitioner-photo.tsx");
const BOOKING_CSS = read("components/booking/public-booking.module.css");

/** Cuerpo de la primera regla `selector {…}` del CSS (sin comentarios). */
function rule(css: string, selector: string): string {
  const src = noComments(css);
  const i = src.indexOf(`${selector} {`);
  expect(i, selector).toBeGreaterThanOrEqual(0);
  return src.slice(i, src.indexOf("}", i));
}
const imgs = (html: string): string[] => html.match(/<img[^>]*>/g) ?? [];

const PHOTO = "/api/public/pro-photo/p1?v=1730800000000";
const LOGO = "/tmp/logo?v=1730700000000";

describe("[PH-U2] PractitionerPhoto", () => {
  it("[PH-U2-1] con foto: <img> con src, alt = nombre, width/height = size, lazy y async; sin iniciales", () => {
    const html = renderToStaticMarkup(<PractitionerPhoto src={PHOTO} name="Lic. Ana María Pérez" logoUrl={null} />);
    const [img, ...rest] = imgs(html);
    expect(rest).toEqual([]);
    expect(img).toContain(`src="${PHOTO}"`);
    expect(img).toContain('alt="Lic. Ana María Pérez"');
    expect(img).toContain('width="96"');
    expect(img).toContain('height="96"');
    expect(img).toContain('loading="lazy"');
    expect(img).toContain('decoding="async"');
    expect(img).toMatch(/class="[^"]*photo/);
    // El marco reserva su lugar (CLS 0): tamaño fijo en px.
    expect(html).toMatch(/^<span class="[^"]*frame[^"]*" style="width:96px;height:96px"/);
    expect(html).not.toContain(">AP<");
    expect(html).not.toMatch(/role="img"/);
  });

  it("[PH-U2-2] nombre al lado: alt vacío y el marco fuera del árbol de accesibilidad; loading se puede pedir eager", () => {
    const html = renderToStaticMarkup(
      <PractitionerPhoto src={PHOTO} name="Lic. Ana" logoUrl={null} size={64} nameShown loading="eager" className="extra" />
    );
    expect(html).toMatch(/^<span class="[^"]*frame[^"]* extra" style="width:64px;height:64px" aria-hidden="true"/);
    const [img] = imgs(html);
    expect(img).toContain('alt=""');
    expect(img).toContain('loading="eager"');
    expect(img).toContain('width="64"');
  });

  it("[PH-U2-3] sin foto: iniciales con el mismo marco (sin <img>), con nombre accesible; src vacío = sin foto", () => {
    for (const src of [null, undefined, ""]) {
      const html = renderToStaticMarkup(<PractitionerPhoto src={src} name="Lic. Ana María Pérez" logoUrl={null} />);
      expect(imgs(html), String(src)).toEqual([]);
      expect(html).toMatch(/^<span class="[^"]*frame[^"]*" style="width:96px;height:96px" role="img" aria-label="Lic. Ana María Pérez"/);
      expect(html).toMatch(/<span class="[^"]*initials[^"]*"[^>]*aria-hidden="true">AP<\/span>/);
    }
    // Con el nombre al lado, decorativo entero.
    const shown = renderToStaticMarkup(<PractitionerPhoto src={null} name="Beto Gómez" logoUrl={null} nameShown />);
    expect(shown).toMatch(/aria-hidden="true"/);
    expect(shown).not.toMatch(/role="img"/);
    expect(shown).toContain(">BG<");
    // Mismas iniciales que la sede («Semana»): sin el título, primera y última palabra.
    expect(practitionerInitials("Lic. Ana María Pérez")).toBe("AP");
    expect(practitionerInitials("Dra. lucía")).toBe("L");
    expect(practitionerInitials("  ")).toBe("");
  });

  it("[PH-U2-4] logo: insignia abajo a la derecha (~32 %) con alt vacío; sin logo, sin insignia", () => {
    const withLogo = renderToStaticMarkup(<PractitionerPhoto src={PHOTO} name="Ana" logoUrl={LOGO} />);
    const [, badge] = imgs(withLogo);
    expect(badge).toContain(`src="${LOGO}"`);
    expect(badge).toContain('alt=""');
    expect(badge).toContain('width="31"');
    expect(badge).toContain('loading="lazy"');
    expect(withLogo).toMatch(/<span class="[^"]*badge[^"]*" style="width:31px;height:31px" aria-hidden="true"><img/);
    // Sin foto, el logo va igual (mismo marco).
    const initials = renderToStaticMarkup(<PractitionerPhoto src={null} name="Ana" logoUrl={LOGO} />);
    expect(imgs(initials)).toHaveLength(1);
    expect(initials).toContain(`src="${LOGO}"`);
    // Piso de tamaño: en un avatar chico el logo sigue siendo un logo.
    expect(renderToStaticMarkup(<PractitionerPhoto src={null} name="Ana" logoUrl={LOGO} size={32} />)).toContain("width:14px;height:14px");
    for (const logoUrl of [null, undefined, ""]) {
      const html = renderToStaticMarkup(<PractitionerPhoto src={PHOTO} name="Ana" logoUrl={logoUrl} />);
      expect(imgs(html), String(logoUrl)).toHaveLength(1);
      expect(html).not.toMatch(/badge/);
    }
  });

  it("[PH-U2-5] sin hex de marca: color solo de --sky-*; sombra teñida con respaldo sólido; blanco; sin animación", () => {
    const css = noComments(PHOTO_CSS);
    // Ni TMP (#1A436C / #53A0AA) ni ningún color de un consultorio: el único hex es el blanco del marco.
    expect(PHOTO_CSS + PHOTO_TSX).not.toMatch(/1a436c|53a0aa/i);
    expect([...new Set(css.match(/#[0-9a-f]{3,8}\b/gi)!.map((h) => h.toLowerCase()))]).toEqual(["#fff"]);
    // Fondo blanco (el PNG transparente queda recortado sobre blanco) y la foto cubre el círculo.
    expect(rule(PHOTO_CSS, ".frame")).toMatch(/background:\s*#fff/);
    expect(rule(PHOTO_CSS, ".photo")).toMatch(/object-fit:\s*cover/);
    expect(rule(PHOTO_CSS, ".photo")).toMatch(/background:\s*#fff/);
    expect(rule(PHOTO_CSS, ".inner")).toMatch(/border-radius:\s*50%/);
    expect(rule(PHOTO_CSS, ".inner")).toMatch(/overflow:\s*hidden/);
    // Sombra difusa en el color del consultorio: primero el respaldo sin color-mix, después la teñida (--sky-600).
    for (const sel of [".frame", ".compact"]) {
      expect(rule(PHOTO_CSS, sel), sel).toMatch(/box-shadow:[^;]*rgba\([^;]*;\s*box-shadow:[^;]*color-mix\(in srgb, var\(--sky-600\)/);
    }
    // Anillo fino en --sky-500 y la insignia blanca con su sombra chica.
    expect(rule(PHOTO_CSS, ".inner::after")).toMatch(/box-shadow:\s*inset 0 0 0 1\.5px var\(--sky-500\)/);
    expect(rule(PHOTO_CSS, ".badge")).toMatch(/background:\s*#fff/);
    expect(rule(PHOTO_CSS, ".badge")).toMatch(/border-radius:\s*50%/);
    expect(rule(PHOTO_CSS, ".badgeImg")).toMatch(/object-fit:\s*contain/);
    // Iniciales en --sky-700 (AA sobre --sky-50 con todas las paletas: lo mide BR-H-10).
    expect(rule(PHOTO_CSS, ".initials")).toMatch(/color:\s*var\(--sky-700\)/);
    // Reduced motion trivial: nada se mueve.
    expect(css).not.toMatch(/animation|transition|@keyframes/);
    // Server-safe: sin "use client", sin framer, sin hooks; solo su CSS module.
    expect(PHOTO_TSX).not.toMatch(/^\s*["']use client["']/m);
    expect(PHOTO_TSX).not.toMatch(/framer-motion|useState|useEffect|onError/);
    // [CF3-ZF4b] + las iniciales compartidas, que son puras y sin imports (lo afirma cf3-zf4b.test.tsx).
    expect([...PHOTO_TSX.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1])).toEqual([
      "@/lib/person-initials",
      "./practitioner-photo.module.css",
    ]);
  });

  it("[PH-U2-5b] tampoco hay hex de TMP en el turnero ni en la sede tocados por PH-U2", () => {
    for (const f of [
      "components/booking/wizard/practitioner-step.tsx",
      "components/booking/public-booking.module.css",
      "components/sede/sede-page.tsx",
      "components/sede/sede.module.css",
    ]) {
      expect(read(f), f).not.toMatch(/1a436c|53a0aa/i);
    }
  });
});

// ── Sede: tarjetas de profesionales ───────────────────────────────────────────────────────────────────────────────
function pro(id: string, name: string, photoUrl: string | null): ClinicSitePractitioner {
  return {
    id,
    name,
    specialty: "Kinesiología",
    license: null,
    bookingUrl: `/c/tmp/booking?pro=${id}`,
    services: [],
    hours: [],
    photoUrl,
  };
}
function site(over: Partial<ClinicSite> = {}): ClinicSite {
  return {
    slug: "tmp",
    name: "TMP",
    palette: "tmp",
    tagline: null,
    description: null,
    logoUrl: LOGO,
    contact: { phone: null, whatsapp: null },
    locations: [],
    openingSummary: null,
    coverages: [],
    bookingUrl: "/c/tmp/booking",
    practitioners: [pro("p1", "Lic. Ana Pérez", PHOTO), pro("p2", "Lic. Beto Gómez", null)],
    online: { bookingOpen: true },
    ...over,
  };
}
/** La sección «Profesionales» (hasta su `</section>`). */
function prosOf(html: string): string {
  const start = html.indexOf('id="profesionales"');
  expect(start, "no hay sección de profesionales").toBeGreaterThan(0);
  return html.slice(start, html.indexOf("</section>", start));
}

describe("[PH-U2] sede · tarjetas de profesionales", () => {
  it("[PH-U2-6] foto con el logo de la sede en la insignia; sin foto, iniciales en el mismo marco; alt vacío (el h3 dice el nombre)", () => {
    const pros = prosOf(renderToStaticMarkup(<SedePage site={site()} />));
    const all = imgs(pros);
    // p1: foto + logo; p2: solo logo (iniciales).
    expect(all).toHaveLength(3);
    expect(all[0]).toContain(`src="${PHOTO}"`);
    expect(all[0]).toContain('alt=""');
    expect(all[0]).toContain('width="96"');
    expect(all[0]).toContain('loading="lazy"');
    expect(all.filter((i) => i.includes(`src="${LOGO}"`))).toHaveLength(2);
    expect(pros).toContain(">BG<");
    // La foto va antes del nombre (orden de lectura: marco decorativo → h3).
    expect(pros.indexOf(PHOTO)).toBeLessThan(pros.indexOf("Lic. Ana Pérez</h3>"));
    // El avatar viejo de iniciales (degradé) se fue: el marco es el de la primitiva.
    expect(pros).not.toMatch(/class="[^"]*\bavatar/);
    expect(read("components/sede/sede.module.css")).not.toMatch(/^\.avatar\s*\{/m);
  });

  it("[PH-U2-6b] sede sin logo: sin insignias; sin profesionales con foto: ninguna <img> en la sección", () => {
    const pros = prosOf(renderToStaticMarkup(<SedePage site={site({ logoUrl: null, practitioners: [pro("p2", "Lic. Beto Gómez", null)] })} />));
    expect(imgs(pros)).toEqual([]);
    expect(pros).not.toMatch(/badge/);
    expect(pros).toContain(">BG<");
  });
});

// ── Turnero: selección de profesional ─────────────────────────────────────────────────────────────────────────────
type StepClinic = Parameters<typeof PractitionerStep>[0]["clinic"];
function clinic(over: Partial<StepClinic> = {}): StepClinic {
  const base: PublicClinic = {
    slug: "tmp",
    name: "TMP",
    legalName: null,
    palette: "tmp",
    practitioners: [
      { id: "p1", name: "Lic. Ana Pérez", specialty: null, licenseNumber: "123", yearsExp: null, photoUrl: PHOTO },
      { id: "p2", name: "Lic. Beto Gómez", specialty: null, licenseNumber: null, yearsExp: null, photoUrl: null },
      // Payload viejo (sin el campo): iniciales, como sin foto.
      { id: "p3", name: "Lic. Caro Díaz", specialty: null, licenseNumber: null, yearsExp: null },
    ],
    services: [],
  };
  return { ...base, logoUrl: LOGO, ...over };
}
const stepProps = {
  filters: { insurerId: null, locationId: null },
  onFiltersChange: () => {},
  mode: "pick" as const,
  value: null,
  onPick: () => {},
  onAny: () => {},
};
/** Cada `<button>` de la grilla de profesionales. */
const buttons = (html: string): string[] => html.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? [];

describe("[PH-U2] turnero · ¿Con quién querés atenderte?", () => {
  it("[PH-U2-7] cada profesional con su foto (o iniciales) y el logo del consultorio; «Primer turno» sin foto", () => {
    const html = renderToStaticMarkup(<PractitionerStep clinic={clinic()} {...stepProps} />);
    const [any, ana, beto, caro] = buttons(html);
    expect(any).toContain("Primer turno disponible");
    expect(imgs(any)).toEqual([]);
    expect(any).not.toMatch(/frame/);

    const [photo, badge] = imgs(ana);
    expect(photo).toContain(`src="${PHOTO}"`);
    expect(photo).toContain('alt=""');
    expect(photo).toContain('width="64"');
    expect(badge).toContain(`src="${LOGO}"`);
    // La foto antes del nombre, y el nombre sigue siendo el texto del botón.
    expect(ana.indexOf(PHOTO)).toBeLessThan(ana.indexOf("Lic. Ana Pérez"));
    expect(ana).toContain("MN 123");

    for (const [b, ini] of [
      [beto, "BG"],
      [caro, "CD"],
    ] as const) {
      expect(imgs(b)).toHaveLength(1); // solo el logo
      expect(b).toContain(`>${ini}<`);
      expect(b).toMatch(/aria-hidden="true"/);
    }
  });

  it("[PH-U2-7b] el turnero sin logo (payload de hoy, sin `logoUrl`): fotos e iniciales sin insignia", () => {
    const { logoUrl: _drop, ...noLogo } = clinic();
    void _drop;
    const html = renderToStaticMarkup(<PractitionerStep clinic={noLogo} {...stepProps} />);
    expect(imgs(html)).toHaveLength(1);
    expect(html).not.toMatch(/badge/);
  });

  it("[PH-U2-8] la tarjeta elegida se tiñe con la paleta (TMP turquesa/azul), no con el celeste fijo", () => {
    const sel = rule(BOOKING_CSS, '.choice[aria-pressed="true"]');
    expect(sel).toMatch(/background:\s*rgba\([^;]*;\s*background:\s*color-mix\(in srgb, var\(--sky-700\) 8%, transparent\)/);
  });
});
