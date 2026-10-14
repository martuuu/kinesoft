import type { Role } from "@prisma/client";
import type { EmailTransportName } from "@/lib/email/types";

/**
 * Estado de una invitación (mismo vocabulario que `invitationStatus` de `lib/access-logic.ts`). En la lista de
 * pendientes nunca viene "accepted" (esas ya son miembros) ni "revoked" (anuladas: quedan como historia).
 */
export type InvitationStatus = "pending" | "accepted" | "expired" | "revoked";

/** Mismos valores que `EmailLog.status` (CHECK de M6, `lib/email/log.ts`). Acá para que la UI lo importe. */
export type InvitationEmailStatus = "sent" | "skipped" | "failed" | "blocked";

/** Último intento de mail de una invitación, leído de `EmailLog` (IAM-2a). */
export type InvitationLastEmail = {
  status: InvitationEmailStatus;
  transport: EmailTransportName;
  reason: string | null;
  at: Date;
};

export type InvitationRow = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
  specialty: string | null;
  invitedAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
  url: string | null; // nunca en la lista: el token solo vive en el mail y en el resultado de la action
  // IAM-2a: estado de envío real (antes la UI solo sabía «se creó»).
  status: InvitationStatus;
  lastSentAt: Date | null;
  sendCount: number;
  lastEmail: InvitationLastEmail | null;
};

/**
 * Resultado de crear / reenviar / generar link nuevo (IAM-2a). Dice la verdad sobre el mail: antes `emailSent`
 * era «Supabase no devolvió error», que no significaba que el mail hubiera llegado ni que el link sirviera.
 *  - `emailSent`: el transporte lo aceptó (Resend/Mailpit). `false` con `emailStatus: "skipped"` = el entorno no
 *    manda mails (Preview, dev, Production sin key); `"failed"` = el proveedor lo rechazó; `"blocked"` = link a
 *    localhost en Production.
 *  - `url`: el link para copiarlo, SOLO para el OWNER (null para el ADMIN): el link es una credencial y quien
 *    gestiona el equipo sin ser dueño no necesita verlo, le alcanza con «Reenviar».
 */
export type InvitationSendResult = {
  id: string;
  url: string | null;
  emailSent: boolean;
  transport: EmailTransportName;
  emailStatus: InvitationEmailStatus;
  emailReason: string | null;
};

export type TeamMemberRow = {
  membershipId: string;
  userId: string;
  email: string;
  fullName: string | null;
  role: Role;
  specialty: string | null;
  joinedAt: Date | null;
  isYou: boolean;
  /** IAM-4c: suspendido desde (null = activo). Suspendido = no entra a este consultorio ni es reservable. */
  disabledAt: Date | null;
  /**
   * IAM-4c: tiene profesional (`Practitioner`) en este consultorio con rol clínico, o sea agenda propia y turnos.
   * La Secretaria y Facturación: false. Un clínico en false es una membresía rota (no puede entrar).
   */
  hasAgenda: boolean;
  /** IAM-4c: último «link para nueva contraseña» que se le mandó (de `EmailLog`), para mostrar si salió. */
  lastPasswordResetEmail: InvitationLastEmail | null;
};

/**
 * Resultado de «Mandar link para nueva contraseña» (IAM-4c). A propósito SIN el link: es una credencial de un clic
 * para entrar a la cuenta de otra persona, y quien gestiona el equipo (OWNER o ADMIN) no tiene por qué verla. Solo
 * se dice si el mail salió (mismo vocabulario que las invitaciones, para reusar `inviteEmailStatusCopy`).
 */
export type MemberPasswordResetResult = {
  emailSent: boolean;
  transport: EmailTransportName;
  emailStatus: InvitationEmailStatus;
  emailReason: string | null;
};

/** Resultado de suspender (IAM-4c): cuántos turnos futuros activos le quedan, para avisar que no se cancelan. */
export type SuspendMemberResult = { futureBookings: number };
