/**
 * Tipos del mail transaccional (IAM-0b, contrato C-IAM1: firmas congeladas).
 *
 * Puro y SIN `server-only` a propósito: lo importan los tests, las plantillas
 * (`templates.ts`, también pura) y la UI que muestre el estado de un envío
 * (EmailLog, IAM-4c). El envío en sí vive en `index.ts` (server-only).
 */

export type EmailKind =
  | "staff_invite"
  | "portal_invite"
  | "portal_magic_link"
  | "email_verification"
  | "password_reset"
  | "admin_password_reset"
  | "account_exists"
  | "welcome";

/**
 * Por dónde salió (o no) un mail:
 *  - resend   Production (o el opt-in explícito de dev, ver `transport.ts`).
 *  - mailpit  dev con `EMAIL_TRANSPORT=mailpit`: buzón local, no sale de la máquina.
 *  - log      no sale: Preview, dev/test, Production sin configurar o Mailpit caído.
 *  - blocked  no sale y es un ERROR: Production con un link a localhost.
 */
export type EmailTransportName = "resend" | "mailpit" | "log" | "blocked";

export type RenderedEmail = { subject: string; html: string; text: string };

export type SendEmailInput = RenderedEmail & {
  kind: EmailKind;
  to: string;
  tenantId?: string | null; // para EmailLog (IAM-1)
  entity?: string | null; // p. ej. "Invitation"
  entityId?: string | null;
  fromName?: string | null; // «Consultorio X» → "Consultorio X vía KineSoft <EMAIL_FROM>"
  replyTo?: string | null;
  actorId?: string | null;
};

/**
 * `reason` (cuando `ok: false`) es uno de `EmailNotSentReason` (`transport.ts`).
 * El contrato lo deja en `string` para que EmailLog lo guarde tal cual.
 * `skipped: true` = el ENTORNO decidió no mandar (log, Mailpit caído): no es un
 * rechazo del proveedor y no hay que mostrarlo como "falló el envío".
 */
export type SendEmailResult =
  | { ok: true; transport: EmailTransportName; providerId: string | null }
  | { ok: false; transport: EmailTransportName; skipped: boolean; reason: string; status?: number };
