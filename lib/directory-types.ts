/**
 * DIR (C-DIR3): tipos del directorio público (`/profesionales`, `/profesionales/[nombreId]`, `/consultorios/[slug]`).
 * Solo tipos: este archivo no exporta valores, así que lo pueden importar páginas, builders y tests sin arrastrar nada.
 * Lo arma `lib/directory-internal.ts` (I/O) con `assembleDirectorySnapshot` (`lib/directory-logic.ts`, puro).
 */

/** Nada de email (ni del consultorio), userId, rating, precios ni pacientes. `practitionerId` SOLO dentro de
 *  `bookingHref` (ya es público en el turnero). Un campo nuevo acá pasa por el revisor de privacidad de DIR-Z. */
export type ProvinceCode =
  | "C" | "B" | "K" | "H" | "U" | "X" | "W" | "E" | "P" | "Y" | "L" | "F"
  | "M" | "N" | "Q" | "R" | "A" | "J" | "D" | "Z" | "S" | "G" | "V" | "T";
export type DirectoryLicense = { kind: "MN" | "MP"; number: string; jurisdiction: ProvinceCode | null; verified: boolean };
export type DirectorySpecialty = { slug: string; name: string };
/** `payerSlug` null = cobertura del consultorio sin vincular al catálogo: se muestra, no filtra. */
export type DirectoryCoverage = { name: string; payerSlug: string | null };
export type DirectoryClinicRef = {
  slug: string; name: string; path: string; city: string | null; provinceCode: ProvinceCode | null;
  /** `/c/<slug>/booking?pro=<practitionerId>` */
  bookingHref: string;
};
export type DirectoryProfessional = {
  profileId: string;
  /** `/profesionales/<nombre-normalizado>-<profileId>` */
  path: string;
  publicName: string;
  honorificLabel: string | null;
  initials: string;
  license: DirectoryLicense | null;
  bio: string | null;
  specialties: DirectorySpecialty[];
  coverages: DirectoryCoverage[];
  acceptsParticular: boolean;
  /** ≥ 1: solo consultorios donde hoy es reservable. */
  clinics: DirectoryClinicRef[];
};
export type DirectoryClinicProfessional = Pick<
  DirectoryProfessional, "profileId" | "path" | "publicName" | "honorificLabel" | "initials" | "specialties"
> & { bookingHref: string };
export type DirectoryClinic = {
  slug: string;
  path: string; // `/consultorios/<slug>`
  name: string;
  description: string | null;
  locations: { name: string; address: string | null; city: string | null; provinceCode: ProvinceCode | null }[];
  phone: string | null;
  whatsapp: string | null;
  specialties: DirectorySpecialty[];
  coverages: DirectoryCoverage[];
  acceptsParticular: boolean;
  /** Solo los profesionales con perfil publicado; los demás quedan detrás de «Ver todos en el turnero». */
  professionals: DirectoryClinicProfessional[];
  bookingHref: string; // `/c/<slug>/booking`
};
export type DirectorySnapshot = { version: 1; builtAt: string; professionals: DirectoryProfessional[]; clinics: DirectoryClinic[] };
export type DirectoryFilters = {
  especialidad: string | null; cobertura: string | null /* payerSlug | "particular" */;
  provincia: ProvinceCode | null; ciudad: string | null; pagina: number;
};
