/**
 * [DIR-3e] Lógica pura de /plataforma/directorio (C-DIR9: «lista de consultorios publicados y perfiles, filtros,
 * ocultar con motivo, verificar matrícula»). Sin "use client" ni Prisma: la importan la página (server), las listas
 * (server) y los paneles de acciones (cliente). La lectura y las actions viven en `lib/platform-directory-read.ts` y
 * `lib/platform-directory.ts` (DIR-2c); acá solo hay copy, estados derivados y la validación del motivo.
 *
 * Por qué se valida el motivo también acá: la action lo vuelve a exigir (zod 3..500, y la base con su CHECK), pero el
 * superadmin tiene que ver el error en el campo antes de mandar y no un «Datos inválidos» genérico.
 */
import type {
  PlatformDirectoryClinicRow,
  PlatformDirectoryProfileRow,
  PlatformDirectoryStatusFilter,
} from "@/lib/platform-directory-read";
import { honorificLabel, professionalPath, clinicPath } from "@/lib/directory-logic";
import { provinceName } from "@/lib/ar-provinces";
import type { DirectoryMode } from "@/lib/directory-mode";

export const DIRECTORY_ADMIN_PATH = "/plataforma/directorio";

/** Mismo rango que `Reason` en `lib/platform-directory.ts` y los CHECK de M11 (btrim 3..500). */
export const HIDE_REASON_MIN = 3;
export const HIDE_REASON_MAX = 500;

export const ESTADO_FILTERS: readonly { value: PlatformDirectoryStatusFilter; label: string }[] = [
  { value: "todos", label: "Todos" },
  { value: "publicados", label: "Publicados" },
  { value: "ocultos", label: "Ocultos por Plataforma" },
  { value: "sin_verificar", label: "Matrícula sin verificar" },
];

/** URL del filtro: los defaults (`todos`, búsqueda vacía) no van a la query para que «Limpiar» sea la URL pelada. */
export function directoryAdminHref(f: { q?: string | null; estado?: PlatformDirectoryStatusFilter | null }): string {
  const sp = new URLSearchParams();
  const q = f.q?.trim();
  if (q) sp.set("q", q);
  if (f.estado && f.estado !== "todos") sp.set("estado", f.estado);
  const s = sp.toString();
  return s ? `${DIRECTORY_ADMIN_PATH}?${s}` : DIRECTORY_ADMIN_PATH;
}

/** El motivo, recortado como lo recorta el server. null = válido. */
export function hideReasonError(reason: string): string | null {
  const r = reason.trim();
  if (r.length < HIDE_REASON_MIN) return `Escribí un motivo (mínimo ${HIDE_REASON_MIN} caracteres).`;
  if (r.length > HIDE_REASON_MAX) return `El motivo puede tener hasta ${HIDE_REASON_MAX} caracteres.`;
  return null;
}

/** Dirty-guard del Drawer: cambió algo respecto de lo que se abrió (el motivo vigente al corregirlo, o vacío). */
export function isHideReasonDirty(reason: string, initial: string): boolean {
  return reason.trim() !== initial.trim();
}

export type StatusTone = "lime" | "sky" | "soft" | "warn";
export type DerivedStatus = { label: string; tone: StatusTone; note: string | null };

/**
 * Estado de un consultorio en la lista. Ocultar pisa el switch del Titular sin tocarlo, así que «oculto» manda. Un
 * consultorio publicado puede igual no aparecer (C-DIR4: turnero prendido, consultorio activo): se explica en `note`
 * para que el superadmin no lo oculte creyendo que se ve.
 */
export function clinicStatus(c: PlatformDirectoryClinicRow): DerivedStatus {
  if (c.hidden) return { label: "Oculto por Plataforma", tone: "warn", note: null };
  if (!c.directoryListed) return { label: "Sin publicar", tone: "soft", note: null };
  if (c.tenantStatus !== "ACTIVE") return { label: "Publicado", tone: "soft", note: "No aparece: el consultorio no está activo." };
  if (!c.publicBookingEnabled) return { label: "Publicado", tone: "soft", note: "No aparece: tiene el turnero apagado." };
  return { label: "Publicado", tone: "lime", note: null };
}

/** El perfil se ve (o se vería, según el consultorio) si la persona lo publica con consentimiento vigente. */
export function profileIsPublished(p: PlatformDirectoryProfileRow): boolean {
  return p.listed && p.consentAt !== null && p.consentWithdrawnAt === null;
}

export function profileStatus(p: PlatformDirectoryProfileRow): DerivedStatus {
  if (p.hidden) return { label: "Oculto por Plataforma", tone: "warn", note: null };
  if (profileIsPublished(p)) return { label: "Publicado", tone: "lime", note: null };
  if (p.consentWithdrawnAt) return { label: "Retiró el consentimiento", tone: "soft", note: null };
  return { label: "Sin publicar", tone: "soft", note: null };
}

/** «Lic. Ana Pérez»: el honorífico solo si es uno de los códigos de M11. */
export function profileDisplayName(p: Pick<PlatformDirectoryProfileRow, "publicName" | "honorific">): string {
  const h = honorificLabel(p.honorific);
  return h ? `${h} ${p.publicName}` : p.publicName;
}

/** «MN 12345» / «MP 4567 · Córdoba». null = sin matrícula cargada (no hay nada que verificar). */
export function licenseText(license: PlatformDirectoryProfileRow["license"]): string | null {
  if (!license) return null;
  const base = `${license.kind} ${license.number}`;
  const j = license.jurisdiction ? provinceName(license.jurisdiction) ?? license.jurisdiction : null;
  return j ? `${base} · ${j}` : base;
}

/** Ficha del usuario en Plataforma (ahí se ve el mail, con su propia barrera; acá no). */
export function platformUserHref(userId: string): string {
  return `/plataforma/usuarios/${encodeURIComponent(userId)}`;
}

/**
 * Link a la vista pública: solo con el directorio prendido (`preview`/`public`) y si lo que se mira está publicado y
 * no oculto. Puede igual dar 404 si el consultorio no cumple C-DIR4; es una ayuda para revisar, no un estado.
 */
export function publicProfileHref(p: PlatformDirectoryProfileRow, mode: DirectoryMode): string | null {
  if (mode === "off" || p.hidden || !profileIsPublished(p)) return null;
  return professionalPath(p.publicName, p.profileId);
}

export function publicClinicHref(c: PlatformDirectoryClinicRow, mode: DirectoryMode): string | null {
  if (mode === "off" || c.hidden || !c.directoryListed) return null;
  return clinicPath(c.slug);
}

export const DIRECTORY_MODE_COPY: Record<DirectoryMode, string> = {
  off: "El directorio está apagado: nada de esto se ve en público todavía.",
  preview: "El directorio está en vista previa: se ve por link, sin indexar.",
  public: "El directorio está publicado: lo que figura como publicado se ve en Google.",
};
