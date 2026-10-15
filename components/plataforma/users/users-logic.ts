/**
 * Lógica pura de presentación del directorio de usuarios de /plataforma (BO3-D, plan §19.5 fila «C usuarios y
 * reparación»). Sin React, sin `next/*`, sin DB: lo importan la página (server component), los client components
 * y su unit test (`tests/unit/render/platform-users-logic.test.tsx`).
 *
 * Contrato PHI (Ley 26.529, el mismo de `lib/platform-users-read.ts`): de la parte de PORTAL solo se muestra un
 * conteo («Paciente en N consultorios»), nunca cuáles. El DTO ya no trae los nombres; esta capa además no tiene
 * de dónde sacarlos, y el render test lo fija.
 */
import type { Role, TenantStatus, TenantVertical } from "@prisma/client";
import { isClinicalMember, roleLabel } from "@/lib/roles";
import { confirmEmailMatches } from "@/lib/platform-health-logic";
import { SUPABASE_LINK_TTL_COPY } from "@/lib/email/templates";
import type {
  PlatformAccessLinkResult,
  PlatformUserAuthState,
  PlatformUserKind,
  PlatformUserKindFilter,
  PlatformUserMembership,
  PlatformUserRow,
  PlatformUserToggleResult,
} from "@/lib/platform-health-logic";

export const USERS_PATH = "/plataforma/usuarios";

/**
 * [BO-Z B3] Aviso que acompaña a todo link de un clic que el superadmin ve para copiar (alta de consultorio sin
 * mail, «Mandar link de acceso» sin mail). Antes cada caja decía otra cosa y ninguna decía cuándo vence: el
 * superadmin lo pegaba en un grupo de WhatsApp al día siguiente y ya no andaba. El TTL sale de la MISMA constante
 * que usan los mails (`SUPABASE_LINK_TTL_COPY`): si Martin cambia el vencimiento en Supabase, cambia en un lugar.
 */
export const ONE_TIME_LINK_COPY = `Es como una contraseña: sirve una sola vez y vence en ${SUPABASE_LINK_TTL_COPY}. No lo compartas en grupos.`;

export const USER_KIND_LABEL: Record<PlatformUserKind, string> = {
  team: "Equipo",
  portal: "Paciente de portal",
  orphan: "Sin acceso",
};

/** Opciones del filtro, en el orden del selector. "all" = sin filtro (no va a la URL). */
export const USER_KIND_FILTER_OPTIONS: ReadonlyArray<{ value: PlatformUserKindFilter; label: string }> = [
  { value: "all", label: "Todos los tipos" },
  { value: "team", label: USER_KIND_LABEL.team },
  { value: "portal", label: USER_KIND_LABEL.portal },
  { value: "orphan", label: USER_KIND_LABEL.orphan },
];

export type UsersQuery = { q: string; kind: PlatformUserKindFilter; page: number };

type RawParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * searchParams → query normalizada. Un valor inválido (editado a mano) cae al default, igual que hace el zod de
 * `searchPlatformUsers`, para que el buscador muestre lo mismo que la lista.
 */
export function parseUsersQuery(sp: RawParams): UsersQuery {
  const q = (first(sp.q) ?? "").trim().slice(0, 200);
  const rawKind = first(sp.kind);
  const kind: PlatformUserKindFilter =
    rawKind === "team" || rawKind === "portal" || rawKind === "orphan" ? rawKind : "all";
  const n = Number(first(sp.page) ?? "1");
  const page = Number.isInteger(n) && n >= 1 && n <= 10_000 ? n : 1;
  return { q, kind, page };
}

/** URL del directorio con los filtros activos; sin keys vacías, sin `kind=all` ni `page=1`. */
export function buildUsersHref(query: { q: string; kind: PlatformUserKindFilter }, page = 1): string {
  const sp = new URLSearchParams();
  const q = query.q.trim();
  if (q) sp.set("q", q);
  if (query.kind !== "all") sp.set("kind", query.kind);
  if (page > 1) sp.set("page", String(page));
  const s = sp.toString();
  return s ? `${USERS_PATH}?${s}` : USERS_PATH;
}

export function userHref(id: string): string {
  return `${USERS_PATH}/${encodeURIComponent(id)}`;
}

export function totalPages(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

/** «1 usuario», «12 usuarios». */
export function usersCountLabel(total: number): string {
  return plural(total, "usuario", "usuarios");
}

/**
 * Columna «Consultorios» de la fila. Equipo: cuántas membresías. Portal: SOLO el conteo de fichas, nunca cuáles
 * (PHI). Una persona puede ser las dos cosas (kinesióloga que además es paciente en otro lado): se dicen ambas.
 */
export function rowTenantsSummary(r: Pick<PlatformUserRow, "membershipCount" | "portalLinkCount" | "isPlatformAdmin">): string {
  const parts: string[] = [];
  if (r.membershipCount > 0) parts.push(`Equipo en ${plural(r.membershipCount, "consultorio", "consultorios")}`);
  if (r.portalLinkCount > 0) parts.push(portalLinksLabel(r.portalLinkCount));
  if (parts.length === 0) return r.isPlatformAdmin ? "Solo Plataforma" : "Ninguno";
  return parts.join(" · ");
}

/** «Paciente en N consultorios». El único dato de portal que se muestra. */
export function portalLinksLabel(n: number): string {
  return `Paciente en ${plural(n, "consultorio", "consultorios")}`;
}

// ── Detalle ──────────────────────────────────────────────────────────────────

export const TENANT_STATUS_LABEL: Record<TenantStatus, string> = {
  ACTIVE: "Activo",
  SUSPENDED: "Suspendido",
  CLOSED: "Dado de baja",
};

/** Con la vertical del consultorio: un PRACTITIONER de Clínica general es «Profesional», no «Kinesiólogo/a». */
export function membershipRoleLabel(role: Role, vertical: TenantVertical): string {
  return roleLabel(role, vertical);
}

/**
 * Estado de la membresía en una palabra: pendiente (no aceptó la invitación), suspendida en ese consultorio, o
 * activa. Lo del consultorio (suspendido/baja) va aparte, con `TENANT_STATUS_LABEL`.
 */
export function membershipStatusLabel(m: Pick<PlatformUserMembership, "accepted" | "suspended">): string {
  if (!m.accepted) return "Invitación pendiente";
  if (m.suspended) return "Suspendida";
  return "Activa";
}

/**
 * Miembro clínico aceptado y activo sin profesional: el bucle de acceso que repara Salud.
 *
 * PL-1d: «clínico» es `isClinicalMember` (PRACTITIONER, u OWNER/ADMIN que atiende), no el rol: a un Titular que no
 * atiende no se le ofrece «Crear profesional». `clinical` viene en el DTO (`PlatformUserMembership`); queda
 * opcional para los llamadores que arman la fila a mano: ausente = true, el default de la columna.
 */
export function membershipNeedsPractitioner(
  m: Pick<PlatformUserMembership, "accepted" | "suspended" | "hasPractitioner" | "role"> & { clinical?: boolean }
): boolean {
  const clinical = isClinicalMember({ role: m.role, clinical: m.clinical ?? true });
  return clinical && m.accepted && !m.suspended && !m.hasPractitioner;
}

/** Fecha y hora en hora AR (Vercel corre en UTC: nunca el reloj del host). */
export function formatDateTimeAR(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

export type AuthStateLine = { label: string; value: string; tone: "ok" | "warn" | "muted" };

/** Renglones de «Cuenta de acceso» del detalle. `missing`/`unavailable` son un solo renglón con el porqué. */
export function authStateLines(auth: PlatformUserAuthState): AuthStateLine[] {
  if (auth.status === "missing") {
    return [{ label: "Cuenta de acceso", value: "No existe en el servicio de acceso (se borró desde afuera). Revisalo en Salud.", tone: "warn" }];
  }
  if (auth.status === "unavailable") {
    return [{ label: "Cuenta de acceso", value: "No pudimos consultarla ahora. Recargá en un rato.", tone: "muted" }];
  }
  return [
    { label: "Email confirmado", value: auth.emailConfirmed ? "Sí" : "No", tone: auth.emailConfirmed ? "ok" : "warn" },
    {
      label: "Último ingreso",
      value: auth.lastSignInAt ? formatDateTimeAR(auth.lastSignInAt) || "—" : "Nunca entró",
      tone: auth.lastSignInAt ? "ok" : "warn",
    },
    { label: "Bloqueada", value: auth.banned ? "Sí" : "No", tone: auth.banned ? "warn" : "ok" },
    {
      label: "Email en el servicio de acceso",
      value: auth.emailMismatch ? `Distinto: ${auth.email ?? "—"}` : "Coincide",
      tone: auth.emailMismatch ? "warn" : "ok",
    },
  ];
}

/** Se ofrece «Sincronizar email» solo si Auth respondió y el email difiere. */
export function canOfferEmailSync(auth: PlatformUserAuthState): boolean {
  return auth.status === "ok" && auth.emailMismatch;
}

/**
 * Por qué no se ofrece «Mandar link de acceso» (null = se ofrece). Son los mismos cortes que hace el server: sin
 * esto el botón existiría para fallar siempre.
 */
export function accessLinkBlockReason(u: { disabled: boolean; auth: PlatformUserAuthState }): string | null {
  if (u.disabled) return "Está deshabilitado: habilitalo antes de mandarle un link.";
  if (u.auth.status === "missing") return "No tiene cuenta en el servicio de acceso.";
  if (u.auth.status === "ok" && u.auth.emailMismatch) return "Primero sincronizá el email.";
  return null;
}

/** El email tipeado confirma la acción de superadmin (mismo criterio que el server: exacto normalizado). */
export function superadminConfirmReady(typed: string, email: string): boolean {
  return confirmEmailMatches(typed, email);
}

export function superadminCopy(grant: boolean): { title: string; description: string; confirmLabel: string } {
  return grant
    ? {
        title: "Dar acceso a Plataforma",
        description:
          "Va a poder ver todos los consultorios y usuarios y hacer cambios en cualquiera. Para confirmar, escribí su email.",
        confirmLabel: "Dar acceso",
      }
    : {
        title: "Quitar acceso a Plataforma",
        description: "Deja de poder entrar a Plataforma. Para confirmar, escribí su email.",
        confirmLabel: "Quitar acceso",
      };
}

export type ResultMessage = { tone: "success" | "warning" | "info"; title: string; description?: string };

/**
 * Resultado de «Mandar link de acceso». Con el mail enviado no se muestra el link (es una credencial de un clic
 * de otra persona); si no salió, el server devuelve `copyUrl` para copiar. `blocked` = config de prod rota.
 */
export function accessLinkMessage(r: PlatformAccessLinkResult): ResultMessage {
  const what = r.purpose === "activation" ? "activar su cuenta" : "elegir una contraseña nueva";
  if (r.emailSent) return { tone: "success", title: "Le mandamos el mail", description: `Con un link para ${what}.` };
  if (r.copyUrl) {
    return {
      tone: "warning",
      title: "El mail no salió",
      description: `Copiá el link y mandáselo por otro canal. Sirve para ${what}.`,
    };
  }
  return {
    tone: "warning",
    title: "El mail no salió",
    description: "El envío de mails está bloqueado en este entorno. Avisale al equipo técnico.",
  };
}

/** Resultado de deshabilitar/habilitar. `authSynced:false` = la base quedó bien pero falta el bloqueo de Auth. */
export function toggleMessage(r: PlatformUserToggleResult, disabled: boolean): ResultMessage {
  if (!r.authSynced) {
    return {
      tone: "warning",
      title: disabled ? "Quedó deshabilitado, pero falta bloquear la cuenta" : "Quedó habilitado, pero falta desbloquear la cuenta",
      description: "El servicio de acceso no respondió. Reintentá: es seguro repetirlo.",
    };
  }
  if (!r.changed) return { tone: "info", title: disabled ? "Ya estaba deshabilitado" : "Ya estaba habilitado" };
  return { tone: "success", title: disabled ? "Usuario deshabilitado" : "Usuario habilitado" };
}
