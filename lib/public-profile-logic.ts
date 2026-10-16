/**
 * Validación pura del perfil público por persona (DIR-2b, C-DIR8). La usa `lib/public-profile.ts` antes de escribir
 * y la puede usar el formulario de `/cuenta/perfil-publico` para avisar antes de mandar.
 *
 * Espeja los CHECK de M11 (`ProfessionalPublicProfile_*_check`): la base es la última barrera, pero un CHECK que
 * salta llega como un error genérico de Prisma; acá cada campo tiene su copy. Si cambia un CHECK, cambia esto.
 *
 * Sin Prisma, sin `server-only`, sin zod (no entra al bundle del cliente por el formulario).
 */
import {
  DIRECTORY_CONSENT_VERSION,
  HONORIFIC_OPTIONS,
  LICENSE_KINDS,
  LICENSE_NUMBER_MAX,
  PUBLIC_BIO_MAX,
  PUBLIC_NAME_MAX,
  PUBLIC_NAME_MIN,
  type Honorific,
  type LicenseKind,
} from "@/lib/directory-constants";
import { AR_PROVINCE_CODES, type ArProvinceCode } from "@/lib/ar-provinces";

/** Lo que manda el formulario (todo opcional/nullable: se normaliza acá). */
export type PublicProfileFieldsInput = {
  publicName?: unknown;
  honorific?: unknown;
  licenseKind?: unknown;
  licenseNumber?: unknown;
  licenseJurisdiction?: unknown;
  bio?: unknown;
};

/** Forma normalizada, lista para escribir: respeta todos los CHECK de M11. */
export type PublicProfileFields = {
  publicName: string;
  honorific: Honorific | null;
  licenseKind: LicenseKind | null;
  licenseNumber: string | null;
  licenseJurisdiction: ArProvinceCode | null;
  bio: string | null;
};

export type FieldErrors = Partial<Record<keyof PublicProfileFields | "consent", string[]>>;

export type ParseResult<T> = { ok: true; data: T } | { ok: false; error: string; fieldErrors: FieldErrors };

const HONORIFICS = new Set<string>(HONORIFIC_OPTIONS.map((o) => o.value));
const KINDS = new Set<string>(LICENSE_KINDS);
const PROVINCES = new Set<string>(AR_PROVINCE_CODES);
/** Mismo patrón que `ProfessionalPublicProfile_license_check`. */
const LICENSE_NUMBER_RE = /^[0-9A-Za-z./ -]{1,20}$/;

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/**
 * Normaliza y valida los campos del perfil. Reglas:
 *  - Nombre público: espacios colapsados, 2..120, **sin «@»** (decisión 19: nunca un email como nombre; la base lo
 *    rechaza igual con `ProfessionalPublicProfile_publicName_check`).
 *  - Matrícula: todo o nada. MN sin jurisdicción (se descarta si viene: es nacional); MP con una de las 24.
 *  - Presentación: ≤ 1000; vacía = null.
 * El conteo de caracteres es el de Postgres (`char_length`: code points), no el `.length` UTF-16 de JS: un emoji
 * cuenta 1 en la base y 2 en JS, y con `.length` se rechazaba un texto que la base acepta.
 */
export function parsePublicProfileFields(raw: PublicProfileFieldsInput): ParseResult<PublicProfileFields> {
  const fieldErrors: FieldErrors = {};
  const add = (k: keyof FieldErrors, msg: string) => {
    (fieldErrors[k] ??= []).push(msg);
  };

  const publicName = (str(raw.publicName) ?? "").replace(/\s+/g, " ");
  const nameLen = [...publicName].length;
  if (nameLen < PUBLIC_NAME_MIN) add("publicName", "Escribí tu nombre público.");
  else if (nameLen > PUBLIC_NAME_MAX) add("publicName", `El nombre público puede tener hasta ${PUBLIC_NAME_MAX} caracteres.`);
  if (publicName.includes("@")) add("publicName", "El nombre público no puede ser un email.");

  const honorificRaw = str(raw.honorific);
  if (honorificRaw !== null && !HONORIFICS.has(honorificRaw)) add("honorific", "Elegí un título de la lista.");
  const honorific = honorificRaw !== null && HONORIFICS.has(honorificRaw) ? (honorificRaw as Honorific) : null;

  const kindRaw = str(raw.licenseKind);
  const numberRaw = str(raw.licenseNumber)?.replace(/\s+/g, " ") ?? null;
  const jurisdictionRaw = str(raw.licenseJurisdiction)?.toUpperCase() ?? null;
  let licenseKind: LicenseKind | null = null;
  let licenseNumber: string | null = null;
  let licenseJurisdiction: ArProvinceCode | null = null;
  if (kindRaw === null) {
    if (numberRaw !== null) add("licenseKind", "Elegí si la matrícula es nacional (MN) o provincial (MP).");
  } else if (!KINDS.has(kindRaw)) {
    add("licenseKind", "Elegí si la matrícula es nacional (MN) o provincial (MP).");
  } else {
    licenseKind = kindRaw as LicenseKind;
    if (numberRaw === null) add("licenseNumber", "Escribí el número de matrícula.");
    else if (numberRaw.length > LICENSE_NUMBER_MAX || !LICENSE_NUMBER_RE.test(numberRaw)) {
      add("licenseNumber", `El número de matrícula admite hasta ${LICENSE_NUMBER_MAX} letras, números, puntos, barras o guiones.`);
    } else licenseNumber = numberRaw;
    if (licenseKind === "MP") {
      if (jurisdictionRaw === null || !PROVINCES.has(jurisdictionRaw)) {
        add("licenseJurisdiction", "Elegí la provincia que otorgó la matrícula.");
      } else licenseJurisdiction = jurisdictionRaw as ArProvinceCode;
    }
    // MN: la jurisdicción se ignora (la base exige NULL; no es un error del usuario si el select quedó cargado).
  }

  const bio = str(raw.bio);
  if (bio !== null && [...bio].length > PUBLIC_BIO_MAX) add("bio", `La presentación puede tener hasta ${PUBLIC_BIO_MAX} caracteres.`);

  const firstError = Object.values(fieldErrors).find((v) => v && v.length > 0)?.[0];
  if (firstError) return { ok: false, error: firstError, fieldErrors };
  return { ok: true, data: { publicName, honorific, licenseKind, licenseNumber, licenseJurisdiction, bio } };
}

/**
 * Consentimiento para publicar: la casilla tildada (`accepted === true`, no «truthy») Y la versión vigente del texto.
 * Una versión vieja (formulario abierto antes de un cambio de texto) no publica: la persona tiene que leer el nuevo.
 */
export function checkConsent(input: { accepted?: unknown; version?: unknown }): ParseResult<{ version: string }> {
  if (input.accepted !== true) {
    const msg = "Para publicar tu perfil tenés que aceptar el consentimiento.";
    return { ok: false, error: msg, fieldErrors: { consent: [msg] } };
  }
  if (input.version !== DIRECTORY_CONSENT_VERSION) {
    const msg = "El texto del consentimiento cambió. Recargá la página, leelo y volvé a aceptarlo.";
    return { ok: false, error: msg, fieldErrors: { consent: [msg] } };
  }
  return { ok: true, data: { version: DIRECTORY_CONSENT_VERSION } };
}

/** Estado del perfil tal como lo ve la persona en `/cuenta/perfil-publico`. */
export type PublicProfileStatus = "none" | "draft" | "published" | "withdrawn" | "hidden";

/**
 * `hidden` gana (Plataforma lo ocultó: aunque esté publicado, no se ve); `published` = listado con consentimiento
 * vigente; `withdrawn` = retiró el consentimiento alguna vez y no volvió a publicar; `draft` = guardado sin publicar.
 */
export function publicProfileStatus(
  row: { listed: boolean; consentAt: Date | null; consentWithdrawnAt: Date | null; hiddenAt: Date | null } | null
): PublicProfileStatus {
  if (!row) return "none";
  if (row.hiddenAt) return "hidden";
  if (row.listed && row.consentAt && !row.consentWithdrawnAt) return "published";
  if (row.consentWithdrawnAt) return "withdrawn";
  return "draft";
}
