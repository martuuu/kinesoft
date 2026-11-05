/**
 * CF3 (SD-S, §30 D-CF3-9/D-CF3-10): validación y tipos de Configuración → «Sitio web» (la sede digital `/<slug>`).
 *
 * Puro (sin Prisma ni `server-only`): lo usan la action (`lib/clinic-site-settings.ts`, `"use server"`, que solo puede
 * exportar funciones async), el formulario de SD-C (mismos mensajes que el server) y los tests.
 *
 * Reglas de cada campo y por qué:
 *   • `siteTagline` 1..120 code points (CHECK `Tenant_siteTagline_check` de M22; `char_length` cuenta code points, por
 *     eso `[...s].length` y no `.length`, como la descripción del directorio). Una sola línea: va en el encabezado y en
 *     el `<title>`/OG de la sede; un salto de línea o un control se rechaza.
 *   • `publicDescription` ≤ 800 (CHECK `Tenant_publicDescription_check`, M11). Reusa la columna del directorio a
 *     propósito (§30.3: un solo texto del consultorio). Saltos de línea sí; otros controles no.
 *   • `whatsapp`: celular argentino normalizado a E.164 (`+549…`, `lib/phone-e164.ts`). La sede arma `wa.me/<número>`
 *     con él: un fijo o un número sin área abre «el número no está en WhatsApp», así que se rechaza al guardar y no
 *     en la cara pública.
 *   • `phone`: celular o fijo argentino (un consultorio suele tener fijo). Se valida con el mismo parser (el motivo
 *     `landline` = fijo válido) y se guarda como lo escribió la persona (recortado): para un fijo no hay forma
 *     canónica en `phone-e164` y `phoneActionsFor` arma el `tel:` de cualquiera de las dos formas.
 *   • `publicEmail`: email válido, en minúsculas, ≤ 120 (mismo tope que `TenantProfileFields` de /plataforma). Hoy la
 *     sede NO lo publica (D-CF3-9: «nunca el email de nadie»; `clinicSiteSchema` no tiene el campo); se edita acá
 *     porque es el único editor del consultorio para su contacto (antes solo onboarding y Plataforma).
 *   • "" o null = borrar (el form manda vacío). Todos los campos van siempre: es un formulario entero, no un patch.
 *   • BR-P · `palette` («Colores del sitio y del turnero», `Tenant.palette`): una de `ALL_PALETTES` (zod rechaza el
 *     resto). Es la única opcional (ausente = no tocar): el form de SD-C y sus tests no la mandaban. Que sea una de las
 *     que este consultorio puede elegir (las generales + la de marca que tenga ASIGNADA, `palettesForTenant`) lo
 *     decide la action contra la fila bloqueada: depende del valor guardado, no del input.
 */
import { z } from "zod";
import { PUBLIC_DESCRIPTION_MAX } from "@/lib/directory-constants";
import { normalizeArMobile } from "@/lib/phone-e164";
import { ALL_PALETTES, type AppPalette } from "@/lib/brand-palettes";

export const SITE_TAGLINE_MAX = 120;
export const SITE_DESCRIPTION_MAX = PUBLIC_DESCRIPTION_MAX;
export const SITE_EMAIL_MAX = 120;

export const SITE_SETTINGS_COPY = {
  taglineTooLong: `La frase puede tener hasta ${SITE_TAGLINE_MAX} caracteres.`,
  taglineOneLine: "La frase va en una sola línea.",
  descriptionTooLong: `La descripción puede tener hasta ${SITE_DESCRIPTION_MAX} caracteres.`,
  invalidChars: "El texto tiene caracteres inválidos.",
  phone: "Revisá el teléfono: con código de área (por ejemplo, 0341 455-1234 o 341 555-1234).",
  whatsapp: "El WhatsApp tiene que ser un celular con código de área (por ejemplo, 341 555-1234).",
  email: "Revisá el email.",
  stale: "Otro cambio se guardó antes. Recargá y revisá.",
  palette: "Elegí uno de los colores de la lista.",
  paletteNotAllowed: "Esos colores son los de la marca de otro consultorio.",
  notFound: "No encontramos el consultorio. Recargá la página.",
  invalid: "Revisá los datos.",
} as const;

/** "" / espacios / null → null; si no, recortado. */
function blankToNull(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
}

// eslint-disable-next-line no-control-regex
const CONTROL_ANY = /[\u0000-\u001f\u007f]/;
// Controles salvo \n y \r (la descripción es multilínea; \t tampoco: no se ve en HTML y rompe el JSON-LD a ojo).
// eslint-disable-next-line no-control-regex
const CONTROL_BUT_NEWLINE = /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/;

const text = z.string().max(4000).nullable().optional().transform(blankToNull);

const tagline = text
  .refine((v) => v === null || !/[\r\n]/.test(v), { message: SITE_SETTINGS_COPY.taglineOneLine })
  .refine((v) => v === null || !CONTROL_ANY.test(v), { message: SITE_SETTINGS_COPY.invalidChars })
  .refine((v) => v === null || [...v].length <= SITE_TAGLINE_MAX, { message: SITE_SETTINGS_COPY.taglineTooLong });

const description = text
  .refine((v) => v === null || !CONTROL_BUT_NEWLINE.test(v), { message: SITE_SETTINGS_COPY.invalidChars })
  .refine((v) => v === null || [...v].length <= SITE_DESCRIPTION_MAX, {
    message: SITE_SETTINGS_COPY.descriptionTooLong,
  });

/** Celular o fijo argentino; se guarda recortado como vino. */
const phone = z
  .string()
  .max(30, SITE_SETTINGS_COPY.phone)
  .nullable()
  .optional()
  .transform(blankToNull)
  .refine(
    (v) => {
      if (v === null) return true;
      if (!/^[0-9+().\-\s]+$/.test(v)) return false;
      const r = normalizeArMobile(v);
      return r.ok || r.reason === "landline";
    },
    { message: SITE_SETTINGS_COPY.phone }
  );

/** Celular argentino → E.164. */
const whatsapp = z
  .string()
  .max(30, SITE_SETTINGS_COPY.whatsapp)
  .nullable()
  .optional()
  .transform((v, ctx) => {
    const t = blankToNull(v);
    if (t === null) return null;
    const r = /^[0-9+().\-\s]+$/.test(t) ? normalizeArMobile(t) : null;
    if (!r?.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: SITE_SETTINGS_COPY.whatsapp });
      return z.NEVER;
    }
    return r.e164;
  });

const email = z
  .string()
  .max(SITE_EMAIL_MAX, SITE_SETTINGS_COPY.email)
  .nullable()
  .optional()
  .transform((v) => blankToNull(v)?.toLowerCase() ?? null)
  .refine((v) => v === null || z.string().email().safeParse(v).success, { message: SITE_SETTINGS_COPY.email });

export const SiteSettingsInput = z
  .object({
    siteEnabled: z.boolean(),
    siteTagline: tagline,
    publicDescription: description,
    phone,
    whatsapp,
    publicEmail: email,
    palette: z.enum(ALL_PALETTES, { message: SITE_SETTINGS_COPY.palette }).optional(),
  })
  .strict();

export type SiteSettingsInputValues = z.input<typeof SiteSettingsInput>;
export type SiteSettingsParsed = z.output<typeof SiteSettingsInput>;

/** `expectedUpdatedAt` = `Tenant.updatedAt` que vio el formulario (ISO). Obligatorio: el CAS no es opcional acá. */
export const SiteSettingsExpected = z.string().datetime({ offset: true });

/** Lo que lee Configuración → «Sitio web» (`getSiteSettings`). */
export type SiteSettings = {
  slug: string;
  /** `/<slug>`: «Ver mi sitio». */
  sitePath: string;
  siteEnabled: boolean;
  /** ISO de la última vez que se prendió (null = nunca). */
  siteEnabledAt: string | null;
  siteTagline: string | null;
  publicDescription: string | null;
  phone: string | null;
  whatsapp: string | null;
  publicEmail: string | null;
  /** Hay logo cargado (se edita en la tarjeta del logo de Configuración, `lib/practice-assets.ts`). */
  hasLogo: boolean;
  /**
   * El slug quedó tapado por una ruta fija de la app (`RESERVED_SLUGS`, `pre.M22.reservedSlugs`): aunque se prenda,
   * `/<slug>` muestra otra cosa y la sede no se publica (`buildClinicSiteSnapshot` la excluye). Lo resuelve Plataforma
   * cambiando el slug.
   */
  slugReserved: boolean;
  /** ISO de `Tenant.updatedAt`: va como `expectedUpdatedAt` del guardado. */
  updatedAt: string;
  /**
   * BR-P: `Tenant.palette` (los colores de la sede y del turnero; un valor desconocido llega como sky) y lo que se
   * puede elegir: las generales + la de marca si es la asignada. Opcionales solo por los fixtures de los tests de SD-C;
   * `getSiteSettings` siempre los manda.
   */
  palette?: AppPalette;
  paletteOptions?: AppPalette[];
};

/** Campos que cambiaron (para el audit: solo las claves, nunca los valores). */
export type SiteSettingsKey = keyof SiteSettingsParsed;
