/**
 * CF3 (SD-K, §30 D-CF3-9/D-CF3-10): lógica PURA de la sede digital `/<slug>`. Sin Prisma, sin `next/*`, sin reloj
 * propio: la usan el builder del snapshot (`lib/clinic-site-internal.ts`), la página (W4) y los tests.
 *
 *   • `assembleClinicSite`: arma el DTO cerrado (`ClinicSite`) con lo que ya leyó el builder. Copia campo por campo
 *     (nunca spread): lo que entra puede traer más columnas que las públicas y no deben salir.
 *   • `lookupClinicSite`: sede / redirect (alias o mayúsculas) / null sobre el snapshot cacheado.
 *   • `clinicSiteJsonLd`: `MedicalClinic` de schema.org (escape con `jsonLdScript` del directorio).
 *   • SD-U: `weeklyHoursOf` (franjas vigentes por profesional), `siteWeekTable` / `siteWhoByDay` (lo que pinta la
 *     página en «Horarios» y «Quién atiende cada día») y `hoursLabel` («8 a 14 h»).
 *
 * Quién es reservable NO se decide acá: llega resuelto por `getPublicClinic` (la regla del turnero, como el
 * directorio, DIR-D14). Si el turnero cambia, la sede lo sigue sin drift.
 */
import { particularQuoteCents } from "@/lib/copago";
import { bookingHref } from "@/lib/public-booking-links";
import { normalizeCity } from "@/lib/directory-logic";
import type { PublicClinic } from "@/lib/public-booking-types";
import type { OpeningRange } from "@/lib/opening-hours-summary";
import { PUBLIC_PRO_PHOTO_PATH } from "@/lib/user-photo-logic";
import { personInitials } from "@/lib/person-initials";
import {
  SITE_PALETTES,
  type ClinicSite,
  type ClinicSiteLocation,
  type ClinicSiteLookup,
  type ClinicSitePractitioner,
  type ClinicSiteSnapshot,
  type ClinicSiteWeeklyRange,
  type CompactClinicSite,
  type SitePalette,
} from "@/lib/clinic-site-types";

/**
 * Tag propio de la sede (además de `global:directory`, que ya invalida todo lo que cambia quién es reservable vía
 * `tenantEntitlementTags`). Lo revalidan, después del commit, los escritores que cambian la sede pero no el
 * directorio: «Sitio web» (switch, frase, descripción, contacto), logo, precios y `showPublicPrice`, sedes, OS.
 * Vive en `lib/cache-tags.ts` (puro, como el resto de los tags); se re-exporta acá para los callers de la sede.
 */
export { CLINIC_SITES_TAG } from "@/lib/cache-tags";

/**
 * Forma de un slug de sede. Más laxa que `SLUG_RE` del onboarding (3..40) a propósito: un alias viejo o un slug
 * creado antes de esa regla tienen que poder redirigir. Lo que no matchea ni llega al cache (una URL basura no
 * cuesta nada).
 */
const SITE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

export function isSiteSlugShape(slug: string): boolean {
  return SITE_SLUG_RE.test(slug);
}

function cleanText(s: string | null | undefined): string | null {
  const t = s?.trim();
  return t ? t : null;
}

/** `/<slug>/logo?v=<ms>`: el `v` rompe el cache del navegador/CDN cuando se sube otro logo. */
export function siteLogoUrl(slug: string, logoStorageKey: string | null, logoUpdatedAt: Date | null): string | null {
  if (!logoStorageKey || !logoUpdatedAt) return null;
  return `/${encodeURIComponent(slug)}/logo?v=${logoUpdatedAt.getTime()}`;
}

/**
 * CF3b PH-S: la foto del profesional en la sede. Solo pasa una URL de la ruta pública de ESE profesional
 * (`/api/public/pro-photo/<id>?v=<ms>`, la que arma `publicProPhotoUrl`); cualquier otra cosa → null (iniciales). El DTO
 * es público e indexable: una URL de terceros que se colara por un lector futuro no se publica.
 */
export function sitePhotoUrl(practitionerId: string, photoUrl: string | null | undefined): string | null {
  if (typeof photoUrl !== "string") return null;
  const prefix = `${PUBLIC_PRO_PHOTO_PATH}/${practitionerId}?v=`;
  return photoUrl.startsWith(prefix) && /^\d{1,16}$/.test(photoUrl.slice(prefix.length)) ? photoUrl : null;
}

/** Link de búsqueda de Google Maps (formato documentado `?api=1&query=`): sin embed ni API key ni cookies de terceros. */
export function locationMapsUrl(l: { address: string | null; city: string | null; province: string | null }): string | null {
  if (!l.address && !l.city) return null;
  const q = [l.address, l.city, l.province, "Argentina"].filter(Boolean).join(", ");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

// ──────────────────────────────────────────────────────────────────────
// Armado
// ──────────────────────────────────────────────────────────────────────

export type ClinicSiteTenantInput = {
  slug: string;
  name: string;
  /** `Tenant.palette` (SD-U). Ausente o desconocida = `sky`. */
  palette?: string | null;
  siteTagline: string | null;
  publicDescription: string | null;
  phone: string | null;
  whatsapp: string | null;
  logoStorageKey: string | null;
  logoUpdatedAt: Date | null;
};

export type ClinicSiteLocationInput = {
  name: string;
  address: string | null;
  addressLine2: string | null;
  city: string | null;
  province: string | null;
};

/** Obra social activa del consultorio, con el nombre del catálogo ya resuelto si está vinculada. */
export type ClinicSiteInsurerInput = { id: string; name: string; isParticular: boolean };

/** Lo que usa la sede de `getPublicClinic` (null = turnero cerrado: la sede existe, sin profesionales). */
export type ClinicSiteClinicInput = {
  openingSummary?: PublicClinic["openingSummary"];
  /** CF3b PH-S: + `photoUrl` (ya resuelta por `getPublicClinic` con opt-in Y foto; ausente = null). */
  practitioners: Pick<
    PublicClinic["practitioners"][number],
    "id" | "name" | "specialty" | "licenseNumber" | "acceptedInsurerIds" | "photoUrl"
  >[];
  services: Pick<
    PublicClinic["services"][number],
    "id" | "name" | "durationMin" | "priceCents" | "practitionerId" | "practitionerIds" | "durationByPractitioner"
  >[];
};

export type ClinicSiteInput = {
  tenant: ClinicSiteTenantInput;
  clinic: ClinicSiteClinicInput | null;
  /** Sedes activas, la principal primero (orden de `getPublicClinic`). */
  locations: ClinicSiteLocationInput[];
  /** Obras sociales activas (puede incluir Particular: se descarta). */
  insurers: ClinicSiteInsurerInput[];
  /** practitionerId → `Practitioner.showPublicPrice`. Ausente = true (el DEFAULT de M22). */
  showPublicPrice: Record<string, boolean>;
  /** `${practitionerId}:${serviceId}` → `PractitionerService.priceCents` (solo los no null). */
  practitionerPrices: Record<string, number>;
  /** Copago de la fila Particular (`getParticularCopagoCents`): null = el consultorio no tiene fila. */
  particularCopagoCents: number | null;
  /**
   * SD-U: practitionerId → franjas que el turnero le ofrece (`publicOpeningRanges` de UN profesional: con la red de
   * seguridad del motor si no configuró ninguna). Ausente = sin horario («Quién atiende» no lo muestra).
   */
  practitionerHours?: Record<string, OpeningRange[]>;
  /** SD-U: hoy en Argentina (`toARDateKey(now)` del builder) para las vigencias. Ausente = no se filtra por vigencia. */
  today?: string | null;
};

// ──────────────────────────────────────────────────────────────────────
// Horarios (SD-U)
// ──────────────────────────────────────────────────────────────────────

const MINUTES_PER_DAY = 24 * 60;
/** Lunes primero: así lo lee un paciente argentino (como `summarizeOpeningHours`). */
export const SITE_WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const DAY_LONG: Record<number, string> = {
  0: "Domingo", 1: "Lunes", 2: "Martes", 3: "Miércoles", 4: "Jueves", 5: "Viernes", 6: "Sábado",
};
const DAY_SHORT: Record<number, string> = { 0: "Dom", 1: "Lun", 2: "Mar", 3: "Mié", 4: "Jue", 5: "Vie", 6: "Sáb" };
const weekIndex = (dow: number) => SITE_WEEK_ORDER.indexOf(dow as (typeof SITE_WEEK_ORDER)[number]);

export function sitePalette(raw: string | null | undefined): SitePalette {
  return (SITE_PALETTES as readonly string[]).includes(raw ?? "") ? (raw as SitePalette) : "sky";
}

/** Une las franjas que se pisan o se tocan (8-12 y 11-14 → 8-14), ordenadas por inicio. */
function mergeRanges(ranges: ReadonlyArray<{ startMin: number; endMin: number }>): { startMin: number; endMin: number }[] {
  const sorted = [...ranges].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  const out: { startMin: number; endMin: number }[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.startMin <= last.endMin) last.endMin = Math.max(last.endMin, r.endMin);
    else out.push({ ...r });
  }
  return out;
}

/**
 * Franjas de un profesional vigentes `today`, unidas por día, lunes primero. Mismas reglas que
 * `summarizeOpeningHours` (rango 0..1440, invertidas fuera, vigencia `YYYY-MM-DD` contra el día AR): la sede y el
 * resumen del turnero no pueden contradecirse. Es un resumen: feriados y vacaciones se ven al sacar turno.
 */
export function weeklyHoursOf(ranges: ReadonlyArray<OpeningRange>, today: string | null | undefined): ClinicSiteWeeklyRange[] {
  const byDow = new Map<number, { startMin: number; endMin: number }[]>();
  for (const r of ranges) {
    if (!Number.isInteger(r.dow) || r.dow < 0 || r.dow > 6) continue;
    const startMin = Math.max(0, Math.trunc(r.startMin));
    const endMin = Math.min(MINUTES_PER_DAY, Math.trunc(r.endMin));
    if (!(startMin < endMin)) continue;
    if (today && r.validFrom && r.validFrom > today) continue;
    if (today && r.validUntil && r.validUntil < today) continue;
    byDow.set(r.dow, [...(byDow.get(r.dow) ?? []), { startMin, endMin }]);
  }
  const out: ClinicSiteWeeklyRange[] = [];
  for (const dow of SITE_WEEK_ORDER) for (const m of mergeRanges(byDow.get(dow) ?? [])) out.push({ dow, ...m });
  return out;
}

/** «8», «8:30». */
function hourText(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? String(h) : `${h}:${String(m).padStart(2, "0")}`;
}

/** «8 a 14 h» · «8 a 12 y 15 a 20 h» · «Cerrado» sin franjas. */
export function hoursLabel(ranges: ReadonlyArray<{ startMin: number; endMin: number }>): string {
  if (ranges.length === 0) return "Cerrado";
  return `${ranges.map((r) => `${hourText(r.startMin)} a ${hourText(r.endMin)}`).join(" y ")} h`;
}

export type SiteWeekRow = { dow: number; day: string; ranges: { startMin: number; endMin: number }[]; label: string };

/**
 * «Horarios» del consultorio: los 7 días (lunes a domingo) con la unión de las franjas de sus profesionales
 * reservables. null = no hay ninguna franja (turnero cerrado o sin horario vigente): la página no muestra la tabla
 * (mejor nada que un horario falso, como el turnero).
 */
export function siteWeekTable(site: Pick<ClinicSite, "practitioners">): SiteWeekRow[] | null {
  const all = site.practitioners.flatMap((p) => p.hours);
  if (all.length === 0) return null;
  return SITE_WEEK_ORDER.map((dow) => {
    const ranges = mergeRanges(all.filter((r) => r.dow === dow));
    return { dow, day: DAY_LONG[dow], ranges, label: hoursLabel(ranges) };
  });
}

export type SiteDaySlot = { practitionerId: string; name: string; initials: string; label: string };
export type SiteDay = { dow: number; day: string; short: string; slots: SiteDaySlot[] };

/**
 * Iniciales para el avatar (canal no cromático del profesional, AGENTS §5): «Lic. Ana María Pérez» → «AP». CF3 (ZF4b):
 * la regla vive en `lib/person-initials.ts` (la comparten el `Avatar`, la foto y el directorio); se re-exporta acá para
 * la sede (`components/sede/sede-page.tsx`) y sus tests.
 */
export { personInitials };

/**
 * «Quién atiende cada día» (de la dirección B del prototipo): solo los días con alguien, lunes primero; en cada día
 * los profesionales por hora de inicio (después por nombre, estable). Vacío = no se muestra la sección.
 */
export function siteWhoByDay(site: Pick<ClinicSite, "practitioners">): SiteDay[] {
  const days: SiteDay[] = [];
  for (const dow of SITE_WEEK_ORDER) {
    const slots = site.practitioners
      .map((p) => ({ p, ranges: p.hours.filter((r) => r.dow === dow) }))
      .filter((x) => x.ranges.length > 0)
      .sort((a, b) => a.ranges[0].startMin - b.ranges[0].startMin || collator(a.p.name, b.p.name))
      .map(({ p, ranges }) => ({ practitionerId: p.id, name: p.name, initials: personInitials(p.name), label: hoursLabel(ranges) }));
    if (slots.length > 0) days.push({ dow, day: DAY_LONG[dow], short: DAY_SHORT[dow], slots });
  }
  return days;
}

/** Días sin nadie, para la nota de «Quién atiende» («Domingo cerrado.»). */
export function siteClosedDays(days: ReadonlyArray<SiteDay>): string[] {
  const open = new Set(days.map((d) => d.dow));
  return SITE_WEEK_ORDER.filter((d) => !open.has(d)).map((d) => DAY_LONG[d]);
}

const collator = (a: string, b: string) => a.localeCompare(b, "es", { sensitivity: "base" });

function coveragesOf(input: ClinicSiteInput): string[] {
  const real = input.insurers.filter((i) => !i.isParticular);
  const pros = input.clinic?.practitioners ?? [];
  // Con turnero: las que acepta al menos un profesional reservable (la misma lista que filtra el turnero; sin fila
  // `PractitionerPayer` = aceptada). Sin turnero no hay a quién preguntarle: las activas del consultorio.
  const accepted = pros.length > 0 ? new Set(pros.flatMap((p) => p.acceptedInsurerIds ?? [])) : null;
  const byKey = new Map<string, string>();
  for (const i of real) {
    if (accepted && !accepted.has(i.id)) continue;
    const name = cleanText(i.name);
    if (!name) continue;
    const key = normalizeCity(name); // sin tildes ni mayúsculas: «OSDE» y «Osde» son una
    if (!byKey.has(key)) byKey.set(key, name);
  }
  return [...byKey.values()].sort(collator);
}

function servicesOf(input: ClinicSiteInput, practitionerId: string): ClinicSitePractitioner["services"] {
  const showPrice = input.showPublicPrice[practitionerId] ?? true;
  return (input.clinic?.services ?? [])
    .filter((s) => (s.practitionerIds ? s.practitionerIds.includes(practitionerId) : s.practitionerId === practitionerId))
    .map((s) => {
      // D-CF3-3: con el flag apagado el server NO manda el precio (ni se calcula). D-CF3-1: lo que paga un particular
      // es el precio del profesional → Particular → servicio (`particularQuoteCents`, la misma rama de la escalera).
      const quote = showPrice
        ? particularQuoteCents({
            practitionerPriceCents: input.practitionerPrices[`${practitionerId}:${s.id}`] ?? null,
            particularCopagoCents: input.particularCopagoCents,
            servicePriceCents: s.priceCents,
          })
        : 0;
      return {
        id: s.id,
        name: s.name,
        durationMin: s.durationByPractitioner?.[practitionerId] ?? s.durationMin,
        priceCents: quote > 0 ? quote : null,
      };
    });
}

export function assembleClinicSite(input: ClinicSiteInput): ClinicSite {
  const { tenant, clinic } = input;
  const locations: ClinicSiteLocation[] = input.locations.map((l) => {
    const address = [cleanText(l.address), cleanText(l.addressLine2)].filter(Boolean).join(", ") || null;
    const city = cleanText(l.city);
    const province = cleanText(l.province);
    return { name: l.name, address, city, province, mapsUrl: locationMapsUrl({ address, city, province }) };
  });
  const practitioners: ClinicSitePractitioner[] = (clinic?.practitioners ?? [])
    .map((p) => ({
      id: p.id,
      name: p.name,
      specialty: cleanText(p.specialty),
      license: cleanText(p.licenseNumber),
      bookingUrl: bookingHref(tenant.slug, p.id),
      services: servicesOf(input, p.id),
      hours: weeklyHoursOf(input.practitionerHours?.[p.id] ?? [], input.today),
      // CF3b PH-S: solo una URL de la ruta pública (lo que `getPublicClinic` decidió con opt-in Y foto); cualquier otra
      // cosa que llegara por acá (una URL de terceros, un `avatarUrl`) no sale.
      photoUrl: sitePhotoUrl(p.id, p.photoUrl),
    }))
    .filter((p) => p.services.length > 0);

  return {
    slug: tenant.slug,
    name: tenant.name,
    palette: sitePalette(tenant.palette),
    tagline: cleanText(tenant.siteTagline),
    description: cleanText(tenant.publicDescription),
    logoUrl: siteLogoUrl(tenant.slug, tenant.logoStorageKey, tenant.logoUpdatedAt),
    contact: { phone: cleanText(tenant.phone), whatsapp: cleanText(tenant.whatsapp) },
    locations,
    openingSummary: clinic?.openingSummary ?? null,
    coverages: coveragesOf(input),
    bookingUrl: bookingHref(tenant.slug),
    practitioners,
    online: { bookingOpen: practitioners.length > 0 },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Forma compacta del cache (ver `CompactClinicSite`)
// ──────────────────────────────────────────────────────────────────────

export function compactClinicSite(site: ClinicSite): CompactClinicSite {
  const services: { id: string; name: string }[] = [];
  const index = new Map<string, number>();
  const practitioners = site.practitioners.map((p) => ({
    id: p.id,
    name: p.name,
    specialty: p.specialty,
    license: p.license,
    photoUrl: p.photoUrl,
    s: p.services.map((svc): [number, number, number | null] => {
      let i = index.get(svc.id);
      if (i === undefined) {
        i = services.push({ id: svc.id, name: svc.name }) - 1;
        index.set(svc.id, i);
      }
      return [i, svc.durationMin, svc.priceCents];
    }),
    h: p.hours.map((r): [number, number, number] => [r.dow, r.startMin, r.endMin]),
  }));
  return {
    slug: site.slug,
    name: site.name,
    palette: site.palette,
    tagline: site.tagline,
    description: site.description,
    logoUrl: site.logoUrl,
    contact: site.contact,
    locations: site.locations,
    openingSummary: site.openingSummary,
    coverages: site.coverages,
    online: site.online,
    services,
    practitioners,
  };
}

export function expandClinicSite(c: CompactClinicSite): ClinicSite {
  return {
    slug: c.slug,
    name: c.name,
    palette: sitePalette(c.palette),
    tagline: c.tagline,
    description: c.description,
    logoUrl: c.logoUrl,
    contact: { phone: c.contact.phone, whatsapp: c.contact.whatsapp },
    locations: c.locations.map((l) => ({ name: l.name, address: l.address, city: l.city, province: l.province, mapsUrl: l.mapsUrl })),
    openingSummary: c.openingSummary,
    coverages: [...c.coverages],
    bookingUrl: bookingHref(c.slug),
    practitioners: c.practitioners.map((p) => ({
      id: p.id,
      name: p.name,
      specialty: p.specialty,
      license: p.license,
      bookingUrl: bookingHref(c.slug, p.id),
      services: p.s.map(([i, durationMin, priceCents]) => ({
        id: c.services[i].id,
        name: c.services[i].name,
        durationMin,
        priceCents,
      })),
      hours: (p.h ?? []).map(([dow, startMin, endMin]) => ({ dow, startMin, endMin })),
      // `?? null`: un snapshot v2 (sin el campo) no llega acá (la clave del cache subió a v3), pero no cuesta nada.
      photoUrl: p.photoUrl ?? null,
    })),
    online: { bookingOpen: c.online.bookingOpen },
  };
}

/** Slugs de las sedes publicadas (sitemap), en orden estable. */
export function siteSlugsOf(snapshot: ClinicSiteSnapshot): string[] {
  return snapshot.sites.map((s) => s.slug).sort();
}

// ──────────────────────────────────────────────────────────────────────
// Búsqueda en el snapshot
// ──────────────────────────────────────────────────────────────────────

/**
 * Sede por slug sobre el snapshot. Orden: slug vigente → alias viejo (308 a la vigente) → la misma búsqueda en
 * minúsculas (`/TMP` impreso en una tarjeta → `/tmp`). `aliases` se lee con `Object.hasOwn`: `constructor` matchea la
 * forma de slug y `aliases["constructor"]` devolvería la función de `Object.prototype` (el snapshot vuelve de JSON
 * como objeto plano).
 */
export function lookupClinicSite(snapshot: ClinicSiteSnapshot, slug: string): ClinicSiteLookup {
  const direct = findSite(snapshot, slug);
  if (direct) return direct;
  const lower = slug.toLowerCase();
  if (lower !== slug && isSiteSlugShape(lower)) {
    const r = findSite(snapshot, lower);
    if (r) return { redirectTo: "redirectTo" in r ? r.redirectTo : r.slug };
  }
  return null;
}

function findSite(snapshot: ClinicSiteSnapshot, slug: string): ClinicSiteLookup {
  if (!isSiteSlugShape(slug)) return null;
  const site = snapshot.sites.find((s) => s.slug === slug);
  if (site) return expandClinicSite(site);
  if (Object.hasOwn(snapshot.aliases, slug)) {
    const target = snapshot.aliases[slug];
    if (target !== slug && snapshot.sites.some((s) => s.slug === target)) return { redirectTo: target };
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────
// JSON-LD
// ──────────────────────────────────────────────────────────────────────

/**
 * `MedicalClinic` de schema.org para `<script type="application/ld+json">` (serializar con `jsonLdScript` de
 * `lib/directory-logic.ts`, que escapa `</script>`). No reusa `clinicJsonLd` del directorio: ese recibe una
 * `DirectoryClinic` (con `provinceCode` y path `/consultorios/…`) y la sede tiene canonical `/<slug>` (D-CF3-10).
 * Sin email (D-CF3-9) ni precios ni profesionales (el `Person` de cada uno no es de v1). Opcionales vacíos no se emiten.
 */
export function clinicSiteJsonLd(site: ClinicSite, origin: string): Record<string, unknown> {
  const abs = (path: string) => new URL(path, origin).toString();
  return {
    "@context": "https://schema.org",
    "@type": "MedicalClinic",
    name: site.name,
    url: abs(`/${encodeURIComponent(site.slug)}`),
    ...(site.description ?? site.tagline ? { description: site.description ?? site.tagline } : {}),
    ...(site.contact.phone ? { telephone: site.contact.phone } : {}),
    ...(site.logoUrl ? { logo: abs(site.logoUrl), image: abs(site.logoUrl) } : {}),
    address: site.locations.map((l) => ({
      "@type": "PostalAddress",
      ...(l.address ? { streetAddress: l.address } : {}),
      ...(l.city ? { addressLocality: l.city } : {}),
      ...(l.province ? { addressRegion: l.province } : {}),
      addressCountry: "AR",
    })),
    ...(site.online.bookingOpen
      ? {
          potentialAction: {
            "@type": "ReserveAction",
            target: abs(site.bookingUrl),
          },
        }
      : {}),
  };
}
