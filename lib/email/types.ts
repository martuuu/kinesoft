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
  | "welcome"
  // BO2 (back-office de Plataforma): los mails que manda el equipo de KineSoft, no un consultorio.
  | "tenant_activation" // alta asistida: el titular activa su acceso (BO2-A)
  | "platform_access_link" // Plataforma → Usuarios: link para activar o recuperar el acceso (BO2-C)
  | "support_access" // aviso al OWNER: soporte entró al consultorio (BO2-E, decisión 3)
  // BO5-A (cron): los manda un job, sin Actor.
  | "trial_reminder" // al OWNER: la prueba vence en 7/3/1 días o ya venció (BO-D1/2)
  | "platform_health_digest" // a los superadmins: resumen diario de /plataforma/salud
  // BO5-C (export): Plataforma solo PIDE el export; el titular lo descarga él.
  | "tenant_export_request" // al OWNER: «descargá el export de tus datos»
  // PL (plan §20.5, PL-1a deja los tipos; las plantillas son de PL-2). Ninguno lleva datos de pacientes.
  // 2FA (C-PL6, PL-2a): al propio usuario.
  | "two_factor_code" // código de verificación por email (login, step-up, alta del método)
  | "two_factor_changed" // aviso: se prendió/apagó un método o un superadmin reseteó la 2FA
  | "recovery_codes_used" // aviso: se usó un código de recuperación
  // Cobros (C-PL7..10, PL-2b/2c): al Titular y a quien tenga `account.billing`.
  | "billing_charge_created" // cargo nuevo del período
  | "billing_payment_received" // pago acreditado (MP o manual aprobado)
  | "billing_payment_rejected" // comprobante rechazado o pago de MP rechazado
  | "billing_past_due" // cuenta vencida (PAST_DUE)
  | "billing_price_change" // precio nuevo con vigencia (PL-D8)
  | "billing_auto_debit_changed" // débito automático prendido, pausado o apagado
  // Mensajes y leads (C-PL11, PL-2d).
  | "support_message_platform" // a PLATFORM_INBOX_EMAIL: mensaje nuevo de un consultorio
  | "support_reply_tenant" // al creador del hilo: Plataforma respondió
  | "lead_received" // a PLATFORM_INBOX_EMAIL: consulta nueva desde la landing
  | "lead_reply"; // al lead: respuesta de Plataforma (sin respuesta automática, PL-D15)

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
