/**
 * CF3b CT-L (M23 `cf3_co_titular`) — matrícula de la PERSONA (`UserProfile.license*`): lógica PURA. Sin Prisma, sin
 * `server-only`, sin zod: la usan la action (`lib/user-license.ts`), los lectores (`lib/user-license-internal.ts`), el
 * formulario de «Mi agenda» (`components/configuracion/panels/license-section.tsx`) y Usuarios (CT-U, para mostrarla),
 * así el error sale en el campo sin un round-trip y con el MISMO copy.
 *
 * Por qué existe (decisión de Martin del 05-nov): es un dato de SEGURIDAD, opcional. El Titular la ve en Usuarios antes
 * de dar «Co-titular» a otro profesional. No se publica y no es ninguna de las otras dos matrículas del producto:
 *   - `Practitioner.licenseNumber` («Mis fichas»): por consultorio, texto libre histórico, PÚBLICO (turnero, sede) y
 *     congelado en la firma de cada ficha (`ClinicalNote.authorLicense`);
 *   - `ProfessionalPublicProfile.license*` (`/cuenta/perfil-publico`): la del directorio público, con su propio CHECK
 *     (tope 20, `lib/public-profile-logic.ts`). No se mezclan: cada una tiene su escritor y su CHECK.
 *
 * Espeja los CHECK de M23 (`prisma/migrations/20261105120000_cf3_co_titular`): la base es la última barrera, pero un
 * CHECK que salta llega como un 23514 genérico; acá cada campo tiene su copy. Si cambia un CHECK, cambia esto (el test
 * `tests/unit/ct-l-user-license-logic.test.ts` compara el regex y las 24 jurisdicciones contra el SQL).
 */
import { AR_PROVINCES, isProvinceCode, provinceName } from "@/lib/ar-provinces";
import type { ProvinceCode } from "@/lib/directory-types";

export const USER_LICENSE_KINDS = ["MN", "MP"] as const;
export type UserLicenseKind = (typeof USER_LICENSE_KINDS)[number];
export const USER_LICENSE_NUMBER_MAX = 30;
/**
 * = CHECK `UserProfile_licenseNumber_check`: 1..30, letra o dígito (ASCII) al principio y al final; en el medio también
 * espacio, «.», «/» y «-». Solo ASCII: `.length` de JS y `char_length` de Postgres coinciden.
 */
export const USER_LICENSE_NUMBER_RE = /^[A-Za-z0-9]([A-Za-z0-9 ./-]{0,28}[A-Za-z0-9])?$/;

export type UserLicense = { kind: UserLicenseKind; number: string; jurisdiction: ProvinceCode | null };
/** Lo que ve la persona (y lo que devuelve la action): la matrícula (null = no cargó) y cuándo cambió por última vez. */
export type UserLicenseView = { license: UserLicense | null; updatedAt: string | null };

export type UserLicenseInput = { kind?: unknown; number?: unknown; jurisdiction?: unknown };
export type UserLicenseField = "kind" | "number" | "jurisdiction";
export type UserLicenseFieldErrors = Partial<Record<UserLicenseField, string[]>>;
export type UserLicenseParse =
  | { ok: true; data: UserLicense | null }
  | { ok: false; error: string; fieldErrors: UserLicenseFieldErrors };

export const USER_LICENSE_COPY = {
  section: "Matrícula",
  intro:
    "Tu matrícula profesional y dónde está registrada. Es de tu usuario: vale para todos los consultorios donde " +
    "atendés. La que se imprime en tus fichas se carga en «Mis fichas».",
  note: "Opcional. La ve el titular del consultorio; no se publica.",
  kindLabel: "Tipo de matrícula",
  kindNone: "Sin matrícula",
  kindMN: "Matrícula nacional (MN)",
  kindMP: "Matrícula provincial (MP)",
  numberLabel: "Número de matrícula",
  numberHint: "Como figura en tu credencial: letras, números, espacios, puntos, barras o guiones.",
  jurisdictionLabel: "Provincia",
  jurisdictionPlaceholder: "Elegí la provincia",
  updatedAt: (date: string) => `Última modificación: ${date}.`,
  save: "Guardar",
  saving: "Guardando…",
  savedToast: "Matrícula guardada",
  clearedToast: "Matrícula borrada",
  network: "No pudimos guardar. Revisá la conexión y probá de nuevo.",
  errKind: "Elegí si la matrícula es nacional (MN) o provincial (MP).",
  errNumberMissing: "Escribí el número de matrícula.",
  errNumberFormat: `El número de matrícula admite hasta ${USER_LICENSE_NUMBER_MAX} letras, números, espacios, puntos, barras o guiones, y tiene que empezar y terminar con una letra o un número.`,
  errJurisdiction: "Elegí la provincia que otorgó la matrícula.",
  // Errores de la action (sesión): mismo texto que el perfil público y la 2FA.
  noSession: "Tu sesión venció. Volvé a entrar.",
  disabled: "Tu cuenta está deshabilitada.",
  pending2fa: "Primero terminá de verificar tu acceso.",
  notPractitioner: "La matrícula es para quienes atienden en al menos un consultorio.",
  invalid: "Revisá los datos de la matrícula.",
  saveFailed: "No pudimos guardar tu matrícula. Probá de nuevo.",
} as const;

const KINDS = new Set<string>(USER_LICENSE_KINDS);

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

/**
 * Normaliza y valida (todo o nada, como `UserProfile_license_check`):
 *  - tipo vacío y número vacío → `null` (borrar; una provincia suelta se ignora: es lo que deja el select);
 *  - número sin tipo, o un tipo que no es MN/MP → error en «tipo»;
 *  - tipo sin número, o un número fuera del regex → error en «número» (espacios recortados y colapsados antes);
 *  - MP sin una de las 24 → error en «provincia»; MN descarta la provincia (la base exige NULL y no es un error del
 *    usuario si el select quedó cargado).
 * Un valor que no es string (input armado a mano) cuenta como vacío: el tipo del action no lo admite, pero el endpoint
 * es RPC y recibe lo que le manden.
 */
export function parseUserLicenseInput(raw: UserLicenseInput): UserLicenseParse {
  const fieldErrors: UserLicenseFieldErrors = {};
  const add = (k: UserLicenseField, msg: string) => {
    (fieldErrors[k] ??= []).push(msg);
  };
  const kindRaw = str(raw.kind)?.toUpperCase() ?? null;
  const numberRaw = str(raw.number)?.replace(/\s+/g, " ") ?? null;
  const jurisdictionRaw = str(raw.jurisdiction)?.toUpperCase() ?? null;

  let data: UserLicense | null = null;
  if (kindRaw === null) {
    if (numberRaw !== null) add("kind", USER_LICENSE_COPY.errKind);
  } else if (!KINDS.has(kindRaw)) {
    add("kind", USER_LICENSE_COPY.errKind);
  } else {
    const kind = kindRaw as UserLicenseKind;
    let number: string | null = null;
    if (numberRaw === null) add("number", USER_LICENSE_COPY.errNumberMissing);
    else if (numberRaw.length > USER_LICENSE_NUMBER_MAX || !USER_LICENSE_NUMBER_RE.test(numberRaw)) {
      add("number", USER_LICENSE_COPY.errNumberFormat);
    } else number = numberRaw;
    let jurisdiction: ProvinceCode | null = null;
    if (kind === "MP") {
      if (isProvinceCode(jurisdictionRaw)) jurisdiction = jurisdictionRaw;
      else add("jurisdiction", USER_LICENSE_COPY.errJurisdiction);
    }
    if (number !== null) data = { kind, number, jurisdiction };
  }

  const firstError = Object.values(fieldErrors).find((v) => v && v.length > 0)?.[0];
  if (firstError) return { ok: false, error: firstError, fieldErrors };
  return { ok: true, data };
}

/**
 * Las tres columnas de la base → la matrícula (null = no cargó). Defensivo: si la terna no cierra (no debería: el CHECK
 * de M23 lo impide), devuelve null antes que mostrar una matrícula a medias.
 */
export function licenseFromColumns(c: {
  licenseKind: string | null;
  licenseNumber: string | null;
  licenseJurisdiction: string | null;
}): UserLicense | null {
  if (c.licenseNumber === null) return null;
  if (c.licenseKind === "MN" && c.licenseJurisdiction === null) {
    return { kind: "MN", number: c.licenseNumber, jurisdiction: null };
  }
  if (c.licenseKind === "MP" && isProvinceCode(c.licenseJurisdiction)) {
    return { kind: "MP", number: c.licenseNumber, jurisdiction: c.licenseJurisdiction };
  }
  return null;
}

/** Misma matrícula (para no escribir ni dejar evento cuando no cambió nada). */
export function sameUserLicense(a: UserLicense | null, b: UserLicense | null): boolean {
  if (a === null || b === null) return a === b;
  return a.kind === b.kind && a.number === b.number && a.jurisdiction === b.jurisdiction;
}

/** «MN 12345» · «MP 4567 · Córdoba». Para Usuarios (CT-U) y el resumen del formulario. */
export function formatUserLicense(l: UserLicense): string {
  if (l.kind === "MN") return `MN ${l.number}`;
  const where = provinceName(l.jurisdiction);
  return where ? `MP ${l.number} · ${where}` : `MP ${l.number}`;
}

/**
 * Para el registro de seguridad de la cuenta (`UserSecurityEvent`): el número NO va completo (el registro lo lee la
 * persona y queda para siempre, solo inserción). Los 2 últimos caracteres alcanzan para reconocer el cambio; con 4 o
 * menos no se muestra nada (2 de 3 ya es casi el número).
 */
export function maskLicenseNumber(n: string): string {
  return n.length > 4 ? `•••${n.slice(-2)}` : "•••";
}

// ── Formulario (UI) ───────────────────────────────────────────────────────────

export type UserLicenseDraft = { kind: "" | UserLicenseKind; number: string; jurisdiction: string };

export function licenseDraftOf(l: UserLicense | null): UserLicenseDraft {
  return l ? { kind: l.kind, number: l.number, jurisdiction: l.jurisdiction ?? "" } : { kind: "", number: "", jurisdiction: "" };
}

/**
 * Cambiar el tipo en el select: «Sin matrícula» vacía el número y la provincia (así se borra: el select manda y los
 * campos se esconden); pasar a MN vacía la provincia (la base la exige NULL). El número se conserva entre MN y MP.
 */
export function licenseDraftWithKind(d: UserLicenseDraft, kind: string): UserLicenseDraft {
  if (kind === "MN" || kind === "MP") return { ...d, kind, jurisdiction: kind === "MN" ? "" : d.jurisdiction };
  return { kind: "", number: "", jurisdiction: "" };
}

function canonical(d: UserLicenseDraft): string {
  return JSON.stringify([d.kind, d.number.trim().replace(/\s+/g, " "), d.kind === "MP" ? d.jurisdiction : ""]);
}

/** ¿Hay algo para guardar? Espacios de más y una provincia escondida (MN) no cuentan como cambio. */
export function licenseDraftDirty(d: UserLicenseDraft, saved: UserLicense | null): boolean {
  return canonical(d) !== canonical(licenseDraftOf(saved));
}

/** Opciones de los dos selects (la provincia, solo con MP). */
export const USER_LICENSE_KIND_OPTIONS: ReadonlyArray<{ value: "" | UserLicenseKind; label: string }> = [
  { value: "", label: USER_LICENSE_COPY.kindNone },
  { value: "MN", label: USER_LICENSE_COPY.kindMN },
  { value: "MP", label: USER_LICENSE_COPY.kindMP },
];

export const USER_LICENSE_PROVINCE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: USER_LICENSE_COPY.jurisdictionPlaceholder },
  ...AR_PROVINCES.map((p) => ({ value: p.code, label: p.name })),
];
