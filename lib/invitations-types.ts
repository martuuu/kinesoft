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
};
