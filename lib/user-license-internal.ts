import "server-only";
/**
 * CF3b CT-L (M23): lecturas y escritura de la matrícula de la PERSONA (`UserProfile.license*`) sobre una tx ya abierta.
 * Fuera del `"use server"`: reciben `tx`/`userId` del llamador y no pueden ser endpoints RPC; la sesión y la
 * autorización son del llamador.
 *
 * `UserProfile` no tiene RLS ni `tenantId` (y `kinesoft_app` la puede leer y escribir entera por los DEFAULT
 * PRIVILEGES): la ÚNICA barrera es el código. Por eso lo de acá es solo lo PROPIO (`ownLicenseInTx`,
 * `writeOwnLicenseInTx`): recibe el `userId` de la SESIÓN (la action o el loader lo sacan de `getAccessSnapshot`/el
 * Actor, nunca de un input).
 *
 * La matrícula AJENA la ve SOLO el Titular principal, en Usuarios (`listTeamMembersInTx`, lib/invitations-read.ts:
 * `USER_LICENSE_SELECT` en el select que ya corre, solo si quien mira es el principal y solo de miembros con la
 * invitación aceptada). CF3 ZF5 borró `licensesForTenantMembersInTx`: no tenía llamadores y su comentario decía que la
 * veían el co-titular y el soporte, que no es la regla (una función suelta con esa promesa invitaba a usarla mal).
 *
 * `licenseUpdatedAt` la escribe la base (trigger `UserProfile_license_stamp` de M23): acá no se escribe nunca.
 */
import type { Prisma } from "@prisma/client";
import type { DbClient } from "@/lib/rls";
import { recordUserSecurityEventInTx, type UserSecurityEventKind } from "@/lib/two-factor-internal";
import {
  licenseFromColumns,
  maskLicenseNumber,
  sameUserLicense,
  type UserLicense,
  type UserLicenseView,
} from "@/lib/user-license-logic";

/** Las 4 columnas de M23. Para sumarlas a un `select` de `user` que ya corre (0 sentencias), p. ej. el de Usuarios. */
export const USER_LICENSE_SELECT = {
  licenseKind: true,
  licenseNumber: true,
  licenseJurisdiction: true,
  licenseUpdatedAt: true,
} as const satisfies Prisma.UserProfileSelect;

type LicenseColumns = {
  licenseKind: string | null;
  licenseNumber: string | null;
  licenseJurisdiction: string | null;
  licenseUpdatedAt: Date | null;
};

function viewOf(c: LicenseColumns): UserLicenseView {
  return { license: licenseFromColumns(c), updatedAt: c.licenseUpdatedAt ? c.licenseUpdatedAt.toISOString() : null };
}

/** La matrícula del usuario de la sesión. null = sin `UserProfile` (sesión rota). 1 sentencia. */
export async function ownLicenseInTx(tx: DbClient, sessionUserId: string): Promise<UserLicenseView | null> {
  const row = await tx.userProfile.findUnique({ where: { id: sessionUserId }, select: USER_LICENSE_SELECT });
  return row ? viewOf(row) : null;
}

/** Tipos del registro de seguridad para la matrícula (`UserSecurityEventKind`, lib/two-factor-internal.ts). */
const LICENSE_EVENT = {
  updated: "license.updated",
  cleared: "license.cleared",
} as const satisfies Record<string, UserSecurityEventKind>;

export type WriteOwnLicenseResult = { changed: boolean; view: UserLicenseView } | null;

/**
 * Escribe la matrícula del usuario de la sesión (null = borrarla) y deja el evento en `UserSecurityEvent` (el registro
 * de «Seguridad de la cuenta», que la persona ve en `/cuenta/seguridad`). Corre en una tx del canal service: la tabla
 * de eventos es SERVICE_ONLY (M8).
 *   - `FOR UPDATE` de la fila: dos guardados simultáneos se serializan y cada evento describe un cambio real.
 *   - Sin cambio (misma terna) → no escribe ni deja evento (`changed: false`), y la fecha queda la vieja.
 *   - Payload sin el número completo (`maskLicenseNumber`): tipo, provincia y los 2 últimos caracteres.
 * null = sin `UserProfile` (sesión rota).
 */
export async function writeOwnLicenseInTx(
  tx: Prisma.TransactionClient,
  sessionUserId: string,
  next: UserLicense | null
): Promise<WriteOwnLicenseResult> {
  const locked = await tx.$queryRaw<LicenseColumns[]>`
    SELECT "licenseKind", "licenseNumber", "licenseJurisdiction", "licenseUpdatedAt"
    FROM "UserProfile" WHERE "id" = ${sessionUserId} FOR UPDATE`;
  const current = locked[0];
  if (!current) return null;
  if (sameUserLicense(licenseFromColumns(current), next)) return { changed: false, view: viewOf(current) };
  const row = await tx.userProfile.update({
    where: { id: sessionUserId },
    data: {
      licenseKind: next?.kind ?? null,
      licenseNumber: next?.number ?? null,
      licenseJurisdiction: next?.jurisdiction ?? null,
    },
    select: USER_LICENSE_SELECT,
  });
  await recordUserSecurityEventInTx(tx, {
    userId: sessionUserId,
    kind: next ? LICENSE_EVENT.updated : LICENSE_EVENT.cleared,
    payload: next
      ? { kind: next.kind, jurisdiction: next.jurisdiction, number: maskLicenseNumber(next.number) }
      : { kind: null },
  });
  return { changed: true, view: viewOf(row) };
}
