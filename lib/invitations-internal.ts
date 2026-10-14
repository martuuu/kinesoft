import "server-only";
import type { Role, TenantVertical } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { hashInviteToken } from "@/lib/invitations-tokens";
import { invitationStatus } from "@/lib/access-logic";

/**
 * Búsqueda única de una invitación por el token crudo del link (IAM-2, contrato C-IAM5).
 *
 * Por qué existe: el link `/invite/<token>` lo abren superficies sin Actor (la página pública, la activación de
 * una cuenta nueva) y lo resuelven dos sesiones distintas de IAM-2 (2a reenvía, 2b activa). Tener una sola función
 * evita que cada una vuelva a decidir qué cuenta como «el mismo link».
 *
 * Qué cuenta como el mismo link: el token vigente (`Invitation.token`, hash sha256) **o** cualquiera de
 * `priorTokens` (hashes de links anteriores que siguen valiendo después de un «Reenviar»). Antes de IAM-2,
 * reenviar rotaba el token y el link del primer mail daba 404 (hallazgo del 14-oct). «Generar link nuevo» vacía
 * `priorTokens` y así anula los anteriores a propósito.
 *
 * Va por `prismaService` (sin GUC) porque no hay tenant todavía: el token es la credencial. Nunca devuelve el hash.
 */

export type InvitationLookup = {
  id: string;
  tenantId: string;
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
  specialty: string | null;
  invitedById: string;
  invitedAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  acceptedByUserId: string | null;
  tenant: { id: string; name: string; slug: string; vertical: TenantVertical };
  status: "pending" | "accepted" | "expired" | "revoked";
  /** true = el link usado es uno anterior (reenviado), no el vigente. Solo informativo. */
  matchedPrior: boolean;
};

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;

export async function findInvitationByRawToken(rawToken: string, now: Date = new Date()): Promise<InvitationLookup | null> {
  // Un token con otra forma no puede ser nuestro: se corta antes de ir a la base.
  if (typeof rawToken !== "string" || !TOKEN_SHAPE.test(rawToken)) return null;
  const hash = hashInviteToken(rawToken);
  const row = await prismaService.invitation.findFirst({
    where: { OR: [{ token: hash }, { priorTokens: { has: hash } }] },
    select: {
      id: true,
      tenantId: true,
      email: true,
      firstName: true,
      lastName: true,
      role: true,
      specialty: true,
      invitedById: true,
      invitedAt: true,
      expiresAt: true,
      acceptedAt: true,
      revokedAt: true,
      acceptedByUserId: true,
      token: true,
      tenant: { select: { id: true, name: true, slug: true, vertical: true } },
    },
  });
  if (!row) return null;
  const { token, ...rest } = row;
  return {
    ...rest,
    status: invitationStatus({ acceptedAt: row.acceptedAt, expiresAt: row.expiresAt, revokedAt: row.revokedAt }, now),
    matchedPrior: token !== hash,
  };
}
