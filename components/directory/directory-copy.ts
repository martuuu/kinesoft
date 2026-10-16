/**
 * DIR-3a: textos y metadata compartidos por las tres páginas del directorio. Puro (sin `next/*` salvo el tipo de
 * `Metadata`), para que el render test y las páginas usen exactamente lo mismo.
 *
 * Copy: voseo y sin jerga. Las palabras «matrícula» y «WhatsApp» están en la lista negra de claims de superficies
 * públicas (`tests/unit/public-claims.test.ts`) porque la landing vieja las prometía como funciones de la app; acá son
 * DATOS que cargó la persona o el consultorio, y cada línea lleva su `claim-ok` con la columna de evidencia.
 */
import type { Metadata } from "next";
import { BRAND_NAME } from "@/lib/brand";
import { provinceName } from "@/lib/ar-provinces";
import type { DirectoryMode } from "@/lib/directory-mode";
import type { DirectoryCoverage, DirectoryLicense, ProvinceCode } from "@/lib/directory-types";

/** «Rosario, Santa Fe» · «Santa Fe» · null. Sin repetir si la ciudad ya es el nombre de la provincia. */
export function placeLabel(city: string | null, provinceCode: ProvinceCode | null): string | null {
  const prov = provinceName(provinceCode);
  if (city && prov && city.trim().toLowerCase() !== prov.toLowerCase()) return `${city}, ${prov}`;
  return city || prov || null;
}

/** «Lic. Ana Pérez»: el honorífico va pegado al nombre (es como se presenta la persona). */
export function displayName(p: { honorificLabel: string | null; publicName: string }): string {
  return p.honorificLabel ? `${p.honorificLabel} ${p.publicName}` : p.publicName;
}

/** Texto de la credencial. DIR-D21: va en el HTML si está cargada; nunca en JSON-LD. */
export function licenseLabel(l: DirectoryLicense): string {
  if (l.kind === "MN") return `Matrícula nacional ${l.number}`; // claim-ok: prisma/schema.prisma:247
  const prov = provinceName(l.jurisdiction);
  return `Matrícula provincial ${l.number}${prov ? ` (${prov})` : ""}`; // claim-ok: prisma/schema.prisma:247
}

/** Badge solo con `license.verified` (DIR-D10: «verificada» únicamente después de que Plataforma la verificó). */
export const LICENSE_VERIFIED_LABEL = "Verificada"; // claim-ok: prisma/schema.prisma:257
export const LICENSE_VERIFIED_HINT = `${BRAND_NAME} revisó la matrícula contra el registro`; // claim-ok: prisma/schema.prisma:257

export type ContactChannel = { label: string; value: string; href: string; external: boolean };

/**
 * Canales de contacto del CONSULTORIO para su página (DIR-D15: teléfono y mensajería sí, email nunca). Es el dato que
 * cargó el consultorio, no una función de la app; vive acá para que la palabra quede en un solo lugar con su
 * evidencia (guard de claims).
 */
export function clinicContactChannels(c: { phone: string | null; whatsapp: string | null }): ContactChannel[] { // claim-ok: prisma/schema.prisma:58
  const out: ContactChannel[] = [];
  const phone = c.phone?.trim();
  const tel = phone ? phone.replace(/[^\d+]/g, "") : "";
  if (phone && tel) out.push({ label: "Teléfono", value: phone, href: `tel:${tel}`, external: false });
  const wa = c.whatsapp?.trim(); // claim-ok: prisma/schema.prisma:58
  const digits = wa ? wa.replace(/\D/g, "") : "";
  if (wa && digits) out.push({ label: "WhatsApp", value: wa, href: `https://wa.me/${digits}`, external: true }); // claim-ok: prisma/schema.prisma:58
  return out;
}

/** Coberturas para mostrar: las del catálogo y las sin vincular (por nombre) + Particular al final. */
export function coverageNames(coverages: DirectoryCoverage[], acceptsParticular: boolean): string[] {
  const names = coverages.map((c) => c.name);
  return acceptsParticular ? [...names, "Particular"] : names;
}

/** «OSDE, Swiss Medical y 3 más». */
export function summarize(list: string[], max = 3): string {
  if (list.length <= max) return list.join(", ");
  return `${list.slice(0, max).join(", ")} y ${list.length - max} más`;
}

/**
 * C-DIR2: `preview` = accesible por link pero `noindex, nofollow` (DIR-D22); `public` = indexable. `off` no llega
 * acá con contenido (las páginas hacen `notFound()`), pero por las dudas tampoco se indexa.
 */
export function directoryRobots(mode: DirectoryMode, opts: { thin?: boolean } = {}): Metadata["robots"] {
  if (mode !== "public") return { index: false, follow: false };
  // Una combinación de filtros es una página «fina» (duplica la lista): se sigue, no se indexa.
  if (opts.thin) return { index: false, follow: true };
  return { index: true, follow: true };
}

export function directoryTitle(...parts: string[]): string {
  return [...parts, BRAND_NAME].join(" · ");
}

/** Corta una descripción para `<meta name="description">` sin partir palabras. */
export function metaDescription(text: string, max = 160): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > 60 ? cut.slice(0, sp) : cut).replace(/[\s,.;:]+$/, "")}…`;
}
