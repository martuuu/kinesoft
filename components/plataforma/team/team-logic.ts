/**
 * /plataforma/consultorios/[id]/equipo — lógica pura del panel de equipo (BO3-C).
 *
 * Fuera del componente para testearla sin render (AGENTS.md §3). Las reglas son un ESPEJO de las del server
 * (`lib/team-internal.ts` con `via: "platform"`), no la barrera: el server rechaza igual y su mensaje se muestra tal
 * cual en un Toast. Acá solo se evita ofrecer un botón que seguro va a fallar y se explica por qué está apagado:
 *  - el OWNER no se suspende, no se quita ni cambia de rol sin transferir antes (C-BO8, «siempre exactamente un
 *    OWNER»): `changeMemberRoleInTx` / `suspendMemberInTx` / `removeMemberInTx` lo frenan;
 *  - la titularidad no va a una membresía sin aceptar ni a una suspendida (`changeMemberRoleInTx`);
 *  - a un suspendido no se le manda link de contraseña: primero se reactiva (mismo criterio que Configuración).
 */
import type { Role } from "@prisma/client";
import type {
  InvitationEmailStatus,
  PlatformTeamInvitationRow,
  PlatformTeamMemberRow,
  PlatformTenantTeam,
} from "@/lib/invitations-types";
import { ROLE_ORDER } from "@/lib/roles";

/** Roles que se asignan con el selector. OWNER no: la titularidad tiene su propia acción (`platformTransferOwnership`). */
export const ASSIGNABLE_ROLES: readonly Exclude<Role, "OWNER">[] = ROLE_ORDER.filter(
  (r): r is Exclude<Role, "OWNER"> => r !== "OWNER"
);

/** Roles de la invitación (mismo enum que `InviteInput` de `lib/platform-team.ts`). */
export type InvitableRole = "PRACTITIONER" | "ADMIN" | "ASSISTANT" | "BILLING";

export const OWNER_LOCKED_REASON =
  "Es el dueño del consultorio. Para cambiarle el rol, suspenderlo o quitarlo, primero transferí la titularidad a otra persona del equipo.";

export type ActionState = { enabled: boolean; reason?: string };

export type MemberActionKey = "changeRole" | "transfer" | "suspend" | "reactivate" | "remove" | "passwordReset";

/**
 * Qué acciones ofrece la fila de un miembro. `null` = no se muestra (p. ej. «Reactivar» en alguien activo);
 * `{ enabled: false, reason }` = se muestra apagada con el porqué como tooltip.
 */
export function memberActions(m: Pick<PlatformTeamMemberRow, "role" | "disabledAt" | "joinedAt">): Record<
  MemberActionKey,
  ActionState | null
> {
  const isOwner = m.role === "OWNER";
  const suspended = !!m.disabledAt;
  const locked: ActionState = { enabled: false, reason: OWNER_LOCKED_REASON };
  return {
    changeRole: isOwner ? locked : { enabled: true },
    transfer: isOwner
      ? null
      : suspended
        ? { enabled: false, reason: "No se puede transferir la titularidad a alguien suspendido. Reactivalo primero." }
        : !m.joinedAt
          ? { enabled: false, reason: "Todavía no aceptó la invitación: no puede ser el dueño." }
          : { enabled: true },
    suspend: suspended ? null : isOwner ? locked : { enabled: true },
    reactivate: suspended ? { enabled: true } : null,
    remove: isOwner ? locked : { enabled: true },
    passwordReset: suspended
      ? { enabled: false, reason: "Está suspendido: reactivalo antes de mandarle un link para entrar." }
      : { enabled: true },
  };
}

/** La confirmación reforzada de transferir: hay que tipear el email del nuevo titular (sin distinguir mayúsculas). */
export function transferConfirmMatches(typed: string, email: string): boolean {
  const t = typed.trim().toLowerCase();
  return t.length > 0 && t === email.trim().toLowerCase();
}

/**
 * Indicador de cupos (BO-D7). `used` ya cuenta los clínicos activos + las invitaciones clínicas vigentes
 * (`getSeatUsageInTx`); la Secretaria y Facturación no ocupan lugar. `limit` null = sin tope (plan sin límite).
 */
export function seatsSummary(seats: PlatformTenantTeam["seats"]): {
  text: string;
  full: boolean;
  hint: string;
} {
  const text =
    seats.limit === null ? `Profesionales: ${seats.used} (sin tope)` : `Profesionales ${seats.used} de ${seats.limit}`;
  const base = "Cuentan los profesionales activos y las invitaciones pendientes. La Secretaria y Facturación no ocupan lugar.";
  const hint = seats.full
    ? `Cupo lleno: no se puede invitar a otro profesional sin ampliar el plan o el cupo a medida. ${base}`
    : base;
  return { text, full: seats.full, hint };
}

/** Rótulo del estado de una invitación de la lista (nunca viene "accepted" ni "revoked"). */
export function invitationStatusLabel(inv: Pick<PlatformTeamInvitationRow, "status">): string {
  return inv.status === "expired" ? "Vencida" : inv.status === "pending" ? "Pendiente" : inv.status === "revoked" ? "Anulada" : "Aceptada";
}

/** Rótulo del último intento de mail de una invitación (`EmailLog.status`). */
export function emailStatusLabel(status: InvitationEmailStatus | null): { text: string; tone: "ok" | "warn" | "error" } {
  switch (status) {
    case "sent":
      return { text: "Mail enviado", tone: "ok" };
    case "skipped":
      return { text: "Mail no enviado (entorno sin envío)", tone: "warn" };
    case "failed":
      return { text: "Mail rechazado por el proveedor", tone: "error" };
    case "blocked":
      return { text: "Mail bloqueado (link local)", tone: "error" };
    case null:
      return { text: "Sin registro de mail", tone: "warn" };
  }
}

/** Nombre a mostrar de un miembro (el perfil puede no tener nombre todavía). */
export function memberDisplayName(m: Pick<PlatformTeamMemberRow, "fullName" | "email">): string {
  return m.fullName?.trim() || m.email;
}

/** Estado de la invitación recién creada/reenviada: mostrar el link copiable solo si el mail no salió. */
export function shouldOfferCopyLink(r: { emailSent: boolean; url: string | null }): boolean {
  return !r.emailSent && !!r.url;
}

const AR_TZ = "America/Argentina/Buenos_Aires";

/** «14/10/2026» en hora argentina (en Vercel el host está en UTC: sin `timeZone` un envío de las 22 h salía del día siguiente). */
export function formatARDate(d: Date | string): string {
  return new Date(d).toLocaleDateString("es-AR", { timeZone: AR_TZ, day: "2-digit", month: "2-digit", year: "numeric" });
}

/** «14/10/2026 13:05» en hora argentina, 24 h. Para «último envío». */
export function formatARDateTime(d: Date | string): string {
  const date = formatARDate(d);
  const time = new Date(d).toLocaleTimeString("es-AR", { timeZone: AR_TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return `${date} ${time}`;
}
