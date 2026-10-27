import "server-only";
/**
 * PV (§27, LG-S): registro y lectura de la aceptación de los Términos y la Política de privacidad. Server-only.
 *
 * Sin migración (decisión de §27): la aceptación es una fila `legal.accepted` en `UserSecurityEvent` (M8), con payload
 * `{ version, via }`. La tabla es solo inserción (trigger de M8) y SERVICE_ONLY (ENABLE + FORCE sin policies): se
 * escribe por `recordUserSecurityEventInTx` (`lib/two-factor-internal.ts`, el único escritor de la tabla, que suma
 * ip y user-agent del request) dentro de una tx de `prismaService`, y se lee por `prismaService`. Ningún caller tiene
 * Actor todavía (alta, onboarding, invitación): el filtro es el `userId` de la sesión verificada o el recién creado.
 *
 * Por qué un evento y no un flag en `UserProfile`: (1) en el alta por email todavía NO hay `UserProfile` (lo crea
 * `/auth/confirm`), y el evento no tiene FK; (2) cambiar el texto = nueva `LEGAL_VERSION` = se vuelve a pedir, sin
 * migrar nada (`hasAcceptedCurrentLegal` filtra por la versión del payload); (3) queda la prueba de cuándo, desde dónde
 * y por qué pantalla se aceptó, que es lo que se le pide a un consentimiento.
 */
import type { Prisma } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { LEGAL_VERSION, type LegalAcceptVia } from "@/lib/legal";
import { recordUserSecurityEventInTx } from "@/lib/two-factor-internal";

export const LEGAL_ACCEPTED_KIND = "legal.accepted" as const;

/**
 * Una aceptación de la versión vigente, en la tx del caller (que tiene que ser de `prismaService`). Va en la MISMA tx
 * que lo que habilita (consultorio nuevo, unión al equipo): si eso se deshace, la aceptación también.
 */
export async function recordLegalAcceptanceInTx(
  tx: Prisma.TransactionClient,
  p: { userId: string; via: LegalAcceptVia; tenantId?: string | null }
): Promise<void> {
  await recordUserSecurityEventInTx(tx, {
    userId: p.userId,
    tenantId: p.tenantId ?? null,
    kind: LEGAL_ACCEPTED_KIND,
    payload: { version: LEGAL_VERSION, via: p.via },
  });
}

/**
 * ¿Este usuario aceptó `version` (por default la vigente)? Una aceptación de una versión vieja NO cuenta: el texto
 * cambió y hay que volver a pedirla. Filtro por JSON path del payload (índice `userId, createdAt` de M8: pocas filas
 * por usuario).
 */
export async function hasAcceptedCurrentLegal(userId: string, version: string = LEGAL_VERSION): Promise<boolean> {
  if (!userId) return false;
  const row = await prismaService.userSecurityEvent.findFirst({
    where: { userId, kind: LEGAL_ACCEPTED_KIND, payload: { path: ["version"], equals: version } },
    select: { id: true },
  });
  return !!row;
}
