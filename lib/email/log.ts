/**
 * Sink de `sendEmail` → tabla `EmailLog` (IAM-1, M6; contrato C-IAM1 `EmailSink`).
 *
 * Por qué existe: hoy un mail que no sale (Production sin key, Mailpit caído,
 * link a localhost bloqueado) solo deja una línea en los logs de Vercel. La
 * administración del equipo (IAM-4c) y Plataforma (BO) necesitan ver "se le
 * mandó la invitación el martes y Resend la aceptó" o "no salió: falta la key"
 * sin abrir Vercel. Una fila por intento, también cuando NO salió.
 *
 * Qué guarda y qué NO:
 *  - `toHash` = sha256 del email normalizado (trim + minúsculas): permite buscar
 *    "¿le mandamos algo a juana@x.com?" hasheando la consulta, sin tener la
 *    dirección en claro en una tabla más.
 *  - `toMasked` = `j***@dominio`, la misma máscara que el log de `index.ts`.
 *  - `linkHost` = solo el host del primer link. NUNCA el link: lleva el token
 *    (invitación, recovery, magic link) y con él se entra.
 *  - Ni subject, ni html, ni text.
 *
 * Canal: `prismaService` (BYPASSRLS). El envío puede no tener Actor (signup,
 * olvidé contraseña, portal) y las filas sin consultorio (`tenantId` NULL)
 * no pasarían el WITH CHECK de la policy. La app (kinesoft_app) solo ve las de
 * su consultorio.
 *
 * Nunca tira: `sendEmail` ya envuelve el sink en try/catch, pero el contrato es
 * que el registro no puede romper el envío ni la action que lo dispara, así que
 * se ataja acá también (un sink llamado desde otro lado tampoco rompe).
 *
 * Registro: este módulo se AUTO-REGISTRA al importarse. `lib/email/index.ts`
 * no lo puede importar (sería un ciclo: este importa `registerEmailSink` de
 * ahí), e `instrumentation.ts` corre en otro bundle de Next (no comparte la
 * variable del sink con las server actions). Por eso cada emisor de mails
 * (IAM-2: invitaciones, auth, portal) hace `import "@/lib/email/log";` junto
 * con el import de `sendEmail`. Es idempotente: importarlo N veces registra el
 * mismo sink.
 */
import "server-only";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { logger } from "@/lib/logger";
import { registerEmailSink, type EmailSink } from "@/lib/email/index";
import { maskEmail } from "@/lib/email/transport";
import { normalizeEmail } from "@/lib/email-match";
import type { SendEmailInput, SendEmailResult } from "@/lib/email/types";

/** Valores del CHECK `EmailLog_status_check` (M6). */
export type EmailLogStatus = "sent" | "skipped" | "failed" | "blocked";

export function emailLogStatus(result: SendEmailResult): EmailLogStatus {
  if (result.ok) return "sent";
  if (result.transport === "blocked") return "blocked";
  return result.skipped ? "skipped" : "failed";
}

/** sha256 hex del email normalizado. Exportado para buscar por destinatario (IAM-4c). */
export function emailToHash(to: string): string {
  return createHash("sha256").update(normalizeEmail(to)).digest("hex");
}

/** Fila a insertar (pura: la usa el test para fijar el mapeo sin base). */
export function emailLogRowFor(
  input: SendEmailInput,
  result: SendEmailResult,
  linkHost: string | null
): Prisma.EmailLogUncheckedCreateInput {
  const to = normalizeEmail(input.to ?? "");
  return {
    tenantId: input.tenantId ?? null,
    kind: input.kind,
    toHash: emailToHash(to),
    toMasked: maskEmail(to),
    entity: input.entity ?? null,
    entityId: input.entityId ?? null,
    transport: result.transport,
    status: emailLogStatus(result),
    providerId: result.ok ? result.providerId : null,
    reason: result.ok ? null : result.reason,
    linkHost,
    actorId: input.actorId ?? null,
  };
}

export const emailLogSink: EmailSink = async (input, result, linkHost) => {
  try {
    await prismaService.emailLog.create({ data: emailLogRowFor(input, result, linkHost), select: { id: true } });
  } catch (err) {
    // Sin el mensaje de Prisma: puede citar valores de la fila. El nombre y el
    // kind alcanzan para encontrarlo (tenant inexistente → FK, base caída, …).
    try {
      logger.warn("email.log_insert_failed", {
        kind: input.kind,
        entity: input.entity ?? undefined,
        entityId: input.entityId ?? undefined,
        error: err instanceof Error ? err.name : "unknown",
      });
    } catch {
      // Loguear nunca rompe.
    }
  }
};

registerEmailSink(emailLogSink);
