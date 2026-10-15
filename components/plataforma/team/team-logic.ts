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
import { displayUserName } from "@/lib/display-name";
import type { Role } from "@prisma/client";
import type {
  InvitationEmailStatus,
  PlatformTeamInvitationRow,
  PlatformTeamMemberRow,
  PlatformTenantTeam,
} from "@/lib/invitations-types";
import { ROLE_ORDER, isClinicalMember, roleLabel } from "@/lib/roles";
import type { TenantVertical } from "@prisma/client";
import type { SeatCount } from "@/lib/plan-catalog";

/** Roles que se asignan con el selector. OWNER no: la titularidad tiene su propia acción (`platformTransferOwnership`). */
export const ASSIGNABLE_ROLES: readonly Exclude<Role, "OWNER">[] = ROLE_ORDER.filter(
  (r): r is Exclude<Role, "OWNER"> => r !== "OWNER"
);

/** Roles de la invitación (mismo enum que `InviteInput` de `lib/platform-team.ts`). */
export type InvitableRole = "PRACTITIONER" | "ADMIN" | "ASSISTANT" | "BILLING";

export const OWNER_LOCKED_REASON =
  "Es el titular del consultorio. Para cambiarle el rol, suspenderlo o quitarlo, primero transferí la titularidad a otra persona del equipo.";

export type ActionState = { enabled: boolean; reason?: string };

/**
 * [BO-Z C5] Porqués de las acciones apagadas de una fila, sin repetir, para mostrarlos VISIBLES debajo (11.5 px). Antes
 * vivían solo en el `title` (tooltip): en un celular o con teclado no se veían nunca, y el superadmin veía «Suspender»
 * gris sin saber por qué. El del titular no se repite: la fila ya lo dice en su propia línea.
 */
export function disabledReasons(acts: Partial<Record<string, ActionState | null>>, isOwner: boolean): string[] {
  const out: string[] = [];
  for (const a of Object.values(acts)) {
    if (!a || a.enabled || !a.reason) continue;
    if (isOwner && a.reason === OWNER_LOCKED_REASON) continue;
    if (!out.includes(a.reason)) out.push(a.reason);
  }
  return out;
}

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
          ? { enabled: false, reason: "Todavía no aceptó la invitación: no puede ser el titular." }
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
 * Indicador de cupos (BO-D7 → PL-1c, C-PL3): tres contadores (profesionales, no clínicos y total) porque el
 * plan pone topes por tipo además del total. `used` cuenta miembros activos + invitaciones pendientes, cada uno
 * en su tipo (`getSeatUsageInTx`); `limit` null = sin tope en ese tipo (Consultorio/Clínica no topean por tipo
 * desde la decisión de Martin del 15-oct §20.17, Libre según override).
 */
export function seatsSummary(seats: PlatformTenantTeam["seats"]): {
  text: string;
  full: boolean;
  hint: string;
} {
  const part = (label: string, c: SeatCount) =>
    c.limit === null ? `${label} ${c.used} (sin tope)` : `${label} ${c.used} de ${c.limit}`;
  const text = [
    part("Profesionales", seats.professional),
    part("Secretaría/administración", seats.staff),
    part("Total", seats.total),
  ].join(" · ");
  const full = seats.total.full || seats.professional.full || seats.staff.full;
  const base = "Cuentan los miembros activos y las invitaciones pendientes, cada uno en su tipo.";
  const hint = full
    ? `Cupo lleno: no se puede sumar a alguien de ese tipo sin cambiar el plan o el cupo a medida. ${base}`
    : base;
  return { text, full, hint };
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

/** Nombre a mostrar de un miembro (el perfil puede no tener nombre todavía). DIR-0: nunca el email (va en su línea). */
export function memberDisplayName(m: Pick<PlatformTeamMemberRow, "fullName" | "email">): string {
  return displayUserName(m.fullName);
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

/**
 * PL-3b: rótulo del miembro con «¿Atiende?» (Titular / Titular (sin agenda)); sin el dato (`clinical` todavía no
 * viene del lector) cae a la etiqueta del rol.
 */
export function platformMemberRoleLabel(m: Pick<PlatformTeamMemberRow, "role" | "clinical">, vertical: TenantVertical): string {
  return m.clinical === undefined ? roleLabel(m.role, vertical) : roleLabel(m.role, vertical, { clinical: isClinicalMember({ role: m.role, clinical: m.clinical }) });
}

/**
 * PL-3b (H-TURN): columna informativa del turnero por profesional. null = no corresponde (no atiende, o el lector
 * todavía no trae el dato). El switch lo cambia el consultorio (Configuración → Profesionales).
 */
export function publicBookingLabel(m: Pick<PlatformTeamMemberRow, "hasAgenda" | "publicBookingEnabled">): string | null {
  if (!m.hasAgenda || m.publicBookingEnabled == null) return null;
  return m.publicBookingEnabled ? "Aparece en el turnero online" : "No aparece en el turnero online";
}
