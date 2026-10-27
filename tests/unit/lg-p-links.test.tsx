/**
 * [LG-P] Links a los legales desde las superficies públicas, sitemap y guards (PV §27, bloque LG).
 *
 * - [LG-7] `/terminos` y `/privacidad` caen en el grupo de bundle `public` (120 kB bloqueante): sin el match caían en
 *   `workspace` (el comodín) y nadie se enteraba si crecían. El guard de superficies públicas cubre `app/(legal)/`.
 * - [LG-8] los dos links en el AuthShell (las 3 variantes), el portal, el turnero (wizard y marco de resultado/apagado)
 *   y el directorio. El SiteFooter de la landing lo hace TK-U2 (Q3), no esta sesión.
 * Render real con `react-dom/server`; se mockea solo lo que toca red o sesión (`@/lib/public-booking`, `getSessionUser`).
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/public-booking", () => ({
  listPublicSlots: vi.fn(async () => []),
  listPublicSlotWindow: vi.fn(async () => ({ days: [], nextFrom: null, reachedEnd: true, skippedFrom: null })),
  findFirstPublicSlot: vi.fn(async () => null),
  submitPublicBooking: vi.fn(),
}));
vi.mock("@/lib/session-user", () => ({ getSessionUser: async () => null }));

import { groupFor } from "../../scripts/bundle-groups.mjs";
import { AuthShell } from "@/components/auth/auth-shell";
import PortalLayout from "@/app/(portal)/portal/layout";
import { PublicBookingWizard } from "@/components/booking/public-booking-wizard";
import { BookingFrame, BookingUnavailable } from "@/components/booking/booking-unavailable";
import { DirectoryShell } from "@/components/directory/directory-shell";
import { LegalLinks } from "@/components/legal/legal-links";
import type { PublicClinic } from "@/lib/public-booking-types";
import { PRIVACY_PATH, TERMS_PATH } from "@/lib/legal";
import sitemap from "@/app/sitemap";
import { env } from "@/lib/env";

const footerOf = (html: string) => html.slice(html.lastIndexOf("<footer"));
const expectLegal = (html: string, where: string) => {
  expect(html, where).toMatch(new RegExp(`<a[^>]*href="${TERMS_PATH}"[^>]*>Términos y condiciones</a>`));
  expect(html, where).toMatch(new RegExp(`<a[^>]*href="${PRIVACY_PATH}"[^>]*>Política de privacidad</a>`));
};

const clinic: PublicClinic = {
  slug: "demo",
  name: "Kine Demo",
  legalName: null,
  palette: "sky",
  practitioners: [{ id: "Ana", name: "Lic. Ana", specialty: null, licenseNumber: null, yearsExp: null, locationIds: ["L1"], acceptedInsurerIds: ["P"] }],
  services: [{ id: "S", name: "Sesión", description: null, durationMin: 45, priceCents: 1500000, practitionerId: null, practitionerIds: ["Ana"] }],
  locations: [{ id: "L1", name: "Centro", address: "Av. Pellegrini 1200", addressLine2: null, city: "Rosario", province: null, isPrimary: true }],
  insurers: [{ id: "P", name: "Particular", isParticular: true }],
} as PublicClinic;

describe("[LG-7] bundle y guard público", () => {
  it("groupFor('/terminos') y groupFor('/privacidad') → public", () => {
    expect(groupFor("/terminos")?.id).toBe("public");
    expect(groupFor("/privacidad")?.id).toBe("public");
    // y no se come rutas vecinas que no son legales
    expect(groupFor("/terminos-viejos")?.id).not.toBe("public");
  });

  it("el guard de superficies públicas recorre app/(legal)/", () => {
    const src = readFileSync(join(process.cwd(), "tests/unit/public-surface-imports.test.ts"), "utf8");
    expect(src).toContain('"app/(legal)/"');
  });
});

describe("[LG-P] sitemap", () => {
  it("lista /terminos y /privacidad (indexables) con URL absoluta", async () => {
    const base = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
    const urls = (await sitemap()).map((e) => e.url);
    expect(urls).toEqual(expect.arrayContaining([`${base}${TERMS_PATH}`, `${base}${PRIVACY_PATH}`]));
  });
});

describe("[LG-8] links legales", () => {
  it("LegalLinks: los dos links, por defecto en la misma pestaña; newTab abre en otra con noopener", () => {
    expectLegal(renderToStaticMarkup(<LegalLinks />), "LegalLinks");
    expect(renderToStaticMarkup(<LegalLinks />)).not.toContain("target=");
    const tab = renderToStaticMarkup(<LegalLinks newTab />);
    expect(tab).toMatch(/target="_blank"[^>]*rel="noopener noreferrer"|rel="noopener noreferrer"[^>]*target="_blank"/);
  });

  it("AuthShell: en el footer de las 3 variantes, después de los footerLinks propios", () => {
    for (const variant of ["product", "split", "centered"] as const) {
      const html = renderToStaticMarkup(
        <AuthShell variant={variant} heading="H" footerLinks={[{ label: "Volver al login", href: "/login" }]}>
          <p>x</p>
        </AuthShell>,
      );
      const foot = footerOf(html);
      expectLegal(foot, variant);
      expect(foot.indexOf("Volver al login"), variant).toBeLessThan(foot.indexOf(TERMS_PATH));
    }
  });

  it("portal: footer chico con los dos links", async () => {
    const html = renderToStaticMarkup(await PortalLayout({ children: <p>x</p> }));
    expectLegal(footerOf(html), "portal");
  });

  it("turnero: el wizard y el marco de resultado/apagado los llevan en el pie, con «Turnos online con»", () => {
    const wizard = footerOf(renderToStaticMarkup(<PublicBookingWizard clinic={clinic} session={null} prefill={null} />));
    expect(wizard).toContain("Turnos online con");
    expectLegal(wizard, "wizard");
    const off = footerOf(
      renderToStaticMarkup(<BookingUnavailable contact={{ name: "Consultorio Norte", phone: null, whatsapp: null, email: null }} />),
    );
    expectLegal(off, "booking-unavailable");
    expectLegal(footerOf(renderToStaticMarkup(<BookingFrame>x</BookingFrame>)), "booking-frame sin consultorio");
  });

  it("directorio: en la lista del pie", () => {
    const html = renderToStaticMarkup(<DirectoryShell>x</DirectoryShell>);
    expectLegal(footerOf(html), "directorio");
  });
});
