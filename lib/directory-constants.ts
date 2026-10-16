/**
 * Constantes del directorio público (DIR-2b, C-DIR8). Fuera de los `"use server"` (`lib/directory-settings.ts`,
 * `lib/public-profile.ts`) porque esos archivos solo pueden exportar funciones async, y la UI (pestaña «Directorio»
 * de Configuración, `/cuenta/perfil-publico`) necesita los mismos valores y el mismo texto que valida el servidor.
 *
 * Módulo puro: sin Prisma ni `server-only` (lo importa el cliente).
 */
import { BRAND_NAME } from "@/lib/brand";

/**
 * Versión del texto de consentimiento (DIR-D20). Publicar exige que el cliente mande ESTA versión: si el texto
 * cambia, se sube la versión y un formulario abierto con el texto viejo deja de poder publicar (la persona tiene
 * que aceptar lo que de verdad se publica). La fila guarda la versión aceptada (`consentVersion`).
 */
export const DIRECTORY_CONSENT_VERSION = "2026-10-v1";

/**
 * Texto literal del consentimiento v`2026-10-v1` (C-DIR8, DIR-D20). Ley 25.326: el consentimiento es de la persona,
 * informado y revocable. **Revisión legal recomendada antes de pasar `DIRECTORY_MODE` a `public`.** Cambiar una
 * coma acá = subir `DIRECTORY_CONSENT_VERSION`.
 */
export const DIRECTORY_CONSENT_TEXT =
  `Acepto que ${BRAND_NAME} publique en su directorio mi nombre público, mi matrícula, mis especialidades, las ` +
  "coberturas que acepto, los consultorios donde atiendo y la presentación que cargué. Puedo retirar este " +
  "consentimiento cuando quiera desde esta pantalla, y mi perfil deja de verse en ese momento.";

/** Topes que también fija la base (M11: `Tenant_publicDescription_check`, `ProfessionalPublicProfile_*_check`). */
export const PUBLIC_DESCRIPTION_MAX = 800;
export const PUBLIC_BIO_MAX = 1000;
export const PUBLIC_NAME_MIN = 2;
export const PUBLIC_NAME_MAX = 120;
export const LICENSE_NUMBER_MAX = 20;
/** DIR-D19: hasta 5 especialidades del catálogo por profesional. */
export const MAX_PRACTITIONER_SPECIALTIES = 5;

/** Honoríficos permitidos (CHECK `ProfessionalPublicProfile_honorific_check`) y cómo se leen. */
export const HONORIFIC_OPTIONS = [
  { value: "LIC", label: "Lic." },
  { value: "KLGO", label: "Klgo." },
  { value: "KLGA", label: "Klga." },
  { value: "DR", label: "Dr." },
  { value: "DRA", label: "Dra." },
] as const;
export type Honorific = (typeof HONORIFIC_OPTIONS)[number]["value"];

/** MN = matrícula nacional (sin jurisdicción); MP = provincial (con la provincia que la otorgó). */
export const LICENSE_KINDS = ["MN", "MP"] as const;
export type LicenseKind = (typeof LICENSE_KINDS)[number];

/** Copy compartido por las actions y sus tests. */
export const DIRECTORY_SUPPORT_DENIED = "Soporte no puede cambiar la publicación en el directorio.";
