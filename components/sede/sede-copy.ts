/**
 * CF3 (SD-U, §30 D-CF3-9): copy y armado puro de la sede digital `/<slug>`. Sin React ni `next/*`: lo testea
 * `tests/unit/render/cf3-sede-page.test.tsx` y lo usan la página, la metadata y la imagen OG.
 *
 * Guard de claims (`tests/unit/public-claims.test.ts`): «WhatsApp» y «matrícula» están en la lista negra del copy
 * público porque la landing vieja prometía cosas que no existían. Acá SÍ hay evidencia: el WhatsApp es el del
 * CONSULTORIO (`Tenant.whatsapp`, cargado por el Titular) y la matrícula es la que el profesional cargó y el turnero ya
 * muestra. Cada línea que los nombra lleva su `// claim-ok:`. Nunca el WhatsApp ni el email de un profesional: el DTO
 * (`clinicSiteSchema`, strict) no los trae.
 */
import type { Metadata } from "next";
import { BRAND_NAME } from "@/lib/brand";
import { phoneActionsFor } from "@/lib/booking-share";
import type { ClinicSite, ClinicSiteLocation } from "@/lib/clinic-site-types";

export const SEDE_COPY = {
  skip: "Saltar al contenido",
  book: "Sacar turno",
  seePros: "Ver profesionales",
  navLabel: "Secciones",
  navPros: "Profesionales",
  navVisit: "Horarios y sede",
  navCoverages: "Obras sociales",
  navContact: "Contacto",
  prosEyebrow: "Profesionales",
  prosTitle: "Elegí con quién atenderte",
  prosEmpty: "Por ahora no hay turnos online. Escribinos o llamanos al consultorio para coordinar.",
  prosEmptyNoContact: "Por ahora no hay turnos online.",
  weekEyebrow: "Semana",
  weekTitle: "Quién atiende cada día",
  weekNote: "Los feriados y las vacaciones se ven al sacar turno.",
  visitEyebrow: "Horarios y sede",
  visitTitle: "Cuándo y dónde atendemos",
  hoursTitle: "Horarios",
  hoursCaption: "Horario de atención por día",
  locationTitle: "Sede",
  locationsTitle: "Sedes",
  addressLabel: "Dirección",
  map: "Ver en el mapa",
  newTab: "(se abre en otra pestaña)",
  coveragesTitle: "Obras sociales",
  coveragesLabel: "Obras sociales con las que atendemos",
  coveragesNote: "Consultá tu cobertura con el consultorio antes del turno.",
  coveragesEmpty: "Atendemos de forma particular. Consultá por tu cobertura.",
  contactTitle: "¿Tenés una consulta?",
  contactLead: "Escribinos o llamanos al consultorio. Para turnos, lo más rápido es sacarlo online.",
  contactLeadNoBooking: "Escribinos o llamanos al consultorio para coordinar tu turno.",
} as const;

/** «Lic. Tomás Paredes» → «Tomás» (para «Sacar turno con Tomás»; el aria-label lleva el nombre completo). */
export function firstNameOf(name: string): string {
  const words = name.trim().split(/\s+/).filter((w) => !/^(lic|dr|dra|klgo|klga|prof)\.?$/i.test(w));
  return words[0] ?? name.trim();
}

/** La matrícula que cargó el profesional (D-CF3-9: lo que ya es público en el turnero). */
export function licenseText(license: string | null): string | null {
  return license ? `Matrícula ${license}` : null; // claim-ok: lib/clinic-site-types.ts:43
}

/** «Córdoba 1234, 2.º B · Rosario». */
export function placeText(l: Pick<ClinicSiteLocation, "address" | "city" | "province">): string | null {
  const city = [l.city, l.province && l.province !== l.city ? l.province : null].filter(Boolean).join(", ");
  return [l.address, city].filter(Boolean).join(" · ") || null;
}

export type SedeChannel = { id: "chat" | "phone"; label: string; display: string; href: string; external: boolean };

/**
 * Canales del CONSULTORIO (`Tenant.whatsapp/phone`). El de chat solo si el número es un celular argentino válido
 * (`phoneActionsFor`, la misma regla del drawer); un fijo cargado ahí no abre un chat. El teléfono, si tiene ≥ 6 dígitos.
 */
export function sedeChannels(contact: ClinicSite["contact"]): SedeChannel[] {
  const out: SedeChannel[] = [];
  const chat = phoneActionsFor(contact.whatsapp); // claim-ok: prisma/schema.prisma:58
  if (chat.waChatHref) out.push({ id: "chat", label: "WhatsApp", display: chat.display, href: chat.waChatHref, external: true }); // claim-ok: prisma/schema.prisma:58
  const phone = phoneActionsFor(contact.phone);
  if (phone.telHref) out.push({ id: "phone", label: "Teléfono", display: phone.display, href: phone.telHref, external: false });
  return out;
}

/** Descripción para buscadores (≤ 160): la del consultorio, si no la frase, si no una genérica con el lugar. */
export function sedeMetaDescription(site: Pick<ClinicSite, "name" | "description" | "tagline" | "locations" | "online">): string {
  const city = site.locations.find((l) => l.city)?.city ?? null;
  const base =
    site.description ??
    site.tagline ??
    `${site.name}${city ? `, consultorio en ${city}` : ""}.${site.online.bookingOpen ? " Sacá turno online." : ""}`;
  const flat = base.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 157).trimEnd()}…` : flat;
}

/** `<title>`: «TMP · Kinesiología en Palermo» (la frase si hay); absoluto, sin la marca de la app. */
export function sedeTitle(site: Pick<ClinicSite, "name" | "tagline">): string {
  return site.tagline ? `${site.name} · ${site.tagline}` : site.name;
}

/** Monograma del consultorio sin logo (como el turnero): hasta 3 letras de las iniciales. */
export function clinicMonogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0].slice(0, 3).toLocaleUpperCase("es-AR");
  return words
    .slice(0, 3)
    .map((w) => w[0])
    .join("")
    .toLocaleUpperCase("es-AR");
}

/**
 * Metadata de la sede (la superficie SEO: título, descripción, canonical `/<slug>`, OG, robots). Vive acá y no en
 * `page.tsx` porque un archivo de página de Next solo puede exportar sus campos reservados.
 */
export function sedeMetadata(site: ClinicSite, appUrl: string): Metadata {
  const title = sedeTitle(site);
  const description = sedeMetaDescription(site);
  const path = `/${site.slug}`;
  return {
    metadataBase: new URL(appUrl),
    // Absoluto: la página es del consultorio; el template del root le agregaría la marca de la app.
    title: { absolute: title },
    description,
    alternates: { canonical: path },
    // D-CF3-10: prendida = indexable. Apagada, suspendida o inexistente no llega acá (404 noindex).
    robots: { index: true, follow: true },
    openGraph: { type: "website", locale: "es_AR", siteName: BRAND_NAME, title, description, url: path },
    twitter: { card: "summary_large_image", title, description },
  };
}
