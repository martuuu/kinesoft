import "server-only";
/**
 * CF3b PH-S (M24): lecturas y escritura de la foto de la PERSONA (`UserProfile.photoStorageKey/photoUpdatedAt`) y el
 * gate de la foto PÚBLICA de un profesional. Fuera del `"use server"`: reciben ids ya resueltos por el llamador y no
 * pueden ser endpoints RPC.
 *
 * `UserProfile` no tiene RLS ni `tenantId`: la ÚNICA barrera es el código. Por eso:
 *   - lo propio (`ownPhotoRefFor`, `writeOwnPhotoInTx`, `ownLicenseAndPhotoInTx`) recibe el `userId`
 *     de la SESIÓN (la action, la ruta o el loader lo sacan de `getAccessSnapshot`/el Actor, nunca de un input);
 *   - lo público (`loadPublicProPhotoRef`) va por `practitionerId` DENTRO de su consultorio y solo devuelve algo si se
 *     cumplen TODAS las condiciones de publicar (ver abajo). Nunca cae a `avatarUrl`.
 */
import type { Prisma } from "@prisma/client";
// No-Actor surfaces (foto pública anónima; foto propia por sesión, sin consultorio) → service channel. See lib/db.ts#prismaService.
import { prismaService } from "@/lib/db";
import type { DbClient } from "@/lib/rls";
import { bookablePractitionerWhere } from "@/lib/practitioner-scope";
import { PUBLIC_BOOKING_SWITCH_SELECT, publicSurfacesOpenFor } from "@/lib/public-booking-internal";
import { isPublicBookingOpen } from "@/lib/tenant-modules";
import { RESERVED_SLUGS } from "@/lib/onboarding-logic";
import { isSiteSlugShape } from "@/lib/clinic-site-logic";
import { USER_LICENSE_SELECT } from "@/lib/user-license-internal";
import { licenseFromColumns, type UserLicenseView } from "@/lib/user-license-logic";
import { isPractitionerIdShape, ownPhotoUrlFor } from "@/lib/user-photo-logic";
import { recordUserSecurityEventInTx, type UserSecurityEventKind } from "@/lib/two-factor-internal";
import type { TenantAccessInput } from "@/lib/tenant-access";

/** Las 2 columnas de M24. Para sumarlas a un `select` de `user`/`userProfile` que ya corre (0 sentencias). */
export const USER_PHOTO_SELECT = { photoStorageKey: true, photoUpdatedAt: true } as const satisfies Prisma.UserProfileSelect;

export type OwnPhotoRef = { key: string; at: Date };

/** Clave y fecha de la foto del usuario de la sesión; null = sin foto (o sin perfil). 1 sentencia. */
export async function ownPhotoRefFor(sessionUserId: string, db: DbClient = prismaService): Promise<OwnPhotoRef | null> {
  const row = await db.userProfile.findUnique({ where: { id: sessionUserId }, select: USER_PHOTO_SELECT });
  return row?.photoStorageKey && row.photoUpdatedAt ? { key: row.photoStorageKey, at: row.photoUpdatedAt } : null;
}

// CF3 ZF4a: el avatar propio del shell ya no tiene lector acá (`loadOwnPhotoUrl` se fue): sale de la foto de acceso
// (`AccessProfile.photoUpdatedAt`, lib/session.ts) con `ownPhotoUrlFor`, 0 sentencias.

/**
 * «Mi agenda» (loader de /configuracion): la matrícula (CT-L) y la foto de la persona en UNA lectura de `UserProfile`.
 * Reemplaza a `ownLicenseInTx` en el loader para que la foto no sume sentencia (la de la matrícula ya estaba declarada,
 * +1 en pf2-config-budget). La vista de la matrícula sale igual que `ownLicenseInTx` (`licenseFromColumns` + la fecha
 * del trigger). null = sin `UserProfile` (sesión rota).
 */
export async function ownLicenseAndPhotoInTx(
  tx: DbClient,
  sessionUserId: string
): Promise<{ license: UserLicenseView; photoUrl: string | null } | null> {
  const row = await tx.userProfile.findUnique({
    where: { id: sessionUserId },
    select: { ...USER_LICENSE_SELECT, ...USER_PHOTO_SELECT },
  });
  if (!row) return null;
  return {
    license: { license: licenseFromColumns(row), updatedAt: row.licenseUpdatedAt ? row.licenseUpdatedAt.toISOString() : null },
    photoUrl: ownPhotoUrlFor(row),
  };
}

/**
 * `publicSlugs`: slugs de los consultorios donde la persona PUBLICA la foto (`Practitioner.showPhotoPublic`), para que
 * el llamador revalide solo esas superficies (CF3 ZF5). Vacío = la foto no sale en ninguna página pública.
 */
export type WriteOwnPhotoResult = { changed: boolean; oldKey: string | null; at: Date | null; publicSlugs: string[] } | null;

/** Tipos del registro de seguridad para la foto (`UserSecurityEventKind`, lib/two-factor-internal.ts). */
const PHOTO_EVENT = {
  updated: "photo.updated",
  removed: "photo.removed",
} as const satisfies Record<string, UserSecurityEventKind>;

/**
 * Pone (o borra, con `next = null`) la foto del usuario de la sesión en UNA escritura (las dos columnas juntas: el CHECK
 * `UserProfile_photo_check` no admite una sin la otra). `FOR UPDATE` de la fila: dos subidas simultáneas se serializan
 * y cada una ve la clave vieja real (la que se borra después del commit). `at` lo decide el llamador con
 * `nextPhotoStamp` sobre la fecha leída acá (`stampFrom`), así la versión nueva siempre es mayor.
 * Borrar sin foto → `changed: false`, sin escribir. null = sin `UserProfile`.
 *
 * CF3 ZF4a (B, auditoría de PH-S): cada cambio deja `photo.updated` / `photo.removed` en `UserSecurityEvent` (el
 * registro de «Seguridad de la cuenta», `/cuenta/seguridad`), en ESTA tx, como la matrícula (`writeOwnLicenseInTx`): la
 * foto sale en páginas públicas, y si alguien con la sesión abierta la cambia, la persona lo tiene que poder ver. La
 * tabla es SERVICE_ONLY (M8): el llamador abre la tx por el canal service (`prismaService.$transaction`, lib/user-photo.ts).
 * Sin payload: ni la clave del objeto ni nada de la imagen.
 *
 * CF3 ZF5 (B): la MISMA lectura bloqueante trae `publicSlugs` (subconsulta sobre `Practitioner` ⋈ `Tenant` por el
 * `userId` de la sesión, canal service: cruza los consultorios de la persona a propósito), 0 sentencias más. Antes la
 * action revalidaba `revalidatePath("/", "layout")`: cada foto de cualquiera tiraba el cache de TODAS las sedes,
 * turneros y el directorio. `FOR UPDATE OF u`: el lock es de la fila de la persona; las de `Practitioner` no se tocan
 * (un opt-in que cambia en paralelo revalida solo, `setOwnShowPhotoPublic`).
 */
export async function writeOwnPhotoInTx(
  tx: Prisma.TransactionClient,
  sessionUserId: string,
  next: { key: string; stampFrom: (prev: Date | null) => Date } | null
): Promise<WriteOwnPhotoResult> {
  const locked = await tx.$queryRaw<{ photoStorageKey: string | null; photoUpdatedAt: Date | null; publicSlugs: string[] }[]>`
    SELECT u."photoStorageKey", u."photoUpdatedAt",
           ARRAY(SELECT t."slug" FROM "Practitioner" p JOIN "Tenant" t ON t."id" = p."tenantId"
                  WHERE p."userId" = u."id" AND p."showPhotoPublic" ORDER BY t."slug") AS "publicSlugs"
      FROM "UserProfile" u WHERE u."id" = ${sessionUserId} FOR UPDATE OF u`;
  const cur = locked[0];
  if (!cur) return null;
  const publicSlugs = Array.isArray(cur.publicSlugs) ? cur.publicSlugs : [];
  if (!next && !cur.photoStorageKey) return { changed: false, oldKey: null, at: null, publicSlugs };
  const at = next ? next.stampFrom(cur.photoUpdatedAt) : null;
  await tx.userProfile.update({
    where: { id: sessionUserId },
    data: { photoStorageKey: next ? next.key : null, photoUpdatedAt: at },
    select: { id: true },
  });
  await recordUserSecurityEventInTx(tx, { userId: sessionUserId, kind: next ? PHOTO_EVENT.updated : PHOTO_EVENT.removed });
  return { changed: true, oldKey: cur.photoStorageKey, at, publicSlugs };
}

/**
 * ¿El consultorio tiene una superficie pública abierta donde pueda salir la foto? Acceso abierto (`publicSurfacesOpenFor`,
 * modo efectivo: suspendido y dado de baja cierran) Y (turnero prendido O sede publicada con un slug que la sede usa).
 * Mismo criterio que `isPublicTurneroOpen` y que el builder de la sede (`buildClinicSiteSnapshot`).
 */
export function photoSurfaceOpen(
  t: TenantAccessInput & { publicBookingEnabled: boolean; siteEnabled: boolean; slug: string },
  now: Date = new Date()
): boolean {
  if (!publicSurfacesOpenFor(t, now)) return false;
  if (isPublicBookingOpen(t)) return true;
  return t.siteEnabled && isSiteSlugShape(t.slug) && !RESERVED_SLUGS.has(t.slug);
}

export type PublicProPhotoRef = { key: string; at: Date; userId: string };

/**
 * Foto PÚBLICA de un profesional (turnero y sede), o null (= el MISMO 404 para todo: no existe, sin opt-in, sin foto,
 * consultorio cerrado, miembro suspendido). Publica SOLO si:
 *   1. el id tiene forma de id (antes de la base);
 *   2. su consultorio tiene una superficie pública abierta (`photoSurfaceOpen`);
 *   3. es reservable en ESE consultorio con la regla del turnero (`publicPractitionerWhere` de lib/public-booking.ts:
 *      membresía aceptada, clínica, sin suspender, usuario no deshabilitado, switch propio del turnero prendido);
 *   4. `showPhotoPublic` (opt-in de ese consultorio) y la persona subió una foto.
 * 2 sentencias (consultorio; persona con las condiciones del profesional como subconsulta), por el canal service con
 * el `tenantId` a mano en la relación.
 */
export async function loadPublicProPhotoRef(practitionerId: string, now: Date = new Date()): Promise<PublicProPhotoRef | null> {
  if (!isPractitionerIdShape(practitionerId)) return null;
  const tenant = await prismaService.tenant.findFirst({
    where: { practitioners: { some: { id: practitionerId } } },
    select: { id: true, slug: true, siteEnabled: true, ...PUBLIC_BOOKING_SWITCH_SELECT },
  });
  if (!tenant || !photoSurfaceOpen(tenant, now)) return null;
  const user = await prismaService.userProfile.findFirst({
    where: {
      photoStorageKey: { not: null },
      photoUpdatedAt: { not: null },
      practitioners: {
        some: {
          id: practitionerId,
          showPhotoPublic: true,
          publicBookingEnabled: true,
          ...bookablePractitionerWhere(tenant.id, { includeDisabledFilter: true }),
        },
      },
    },
    select: { id: true, ...USER_PHOTO_SELECT },
  });
  if (!user?.photoStorageKey || !user.photoUpdatedAt) return null;
  return { key: user.photoStorageKey, at: user.photoUpdatedAt, userId: user.id };
}
