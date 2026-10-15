/**
 * Mensajes con Plataforma y leads de la web (PL-2d, contrato C-PL11, plan §20.5.7). Tipos, límites, copy y lógica
 * PURA: sin DB, sin `server-only`, solo `import type` de Prisma. Lo importan las actions (`lib/support-threads.ts`,
 * `lib/platform-inbox.ts`, `lib/leads.ts`, que como `"use server"` solo pueden exportar funciones async), la UI del
 * consultorio y la bandeja de /plataforma, y los tests.
 *
 * Decisión de Martin (literal): «Bandeja en /plataforma y además linkea el formulario de contacto de la homepage para
 * que también me lleguen los mensajes al soporte como "leads"». El consultorio escribe desde Configuración → Soporte,
 * a Martin le llega mail, responde desde /plataforma y el consultorio ve la respuesta (y le llega mail). Abierto/cerrado.
 */
import type { SaasPlan } from "@prisma/client";
import { formatDateAR } from "@/lib/format";
import { toARMinutes } from "@/lib/datetime-ar";

// ── Límites (espejo de los CHECK de M8: subject 1..200, body 1..5000, leadName 1..120, leadEmail 3..254,
//    leadPhone ≤ 40, leadClinicName ≤ 120). El zod de las actions los usa para devolver un error legible en vez de
//    reventar contra el CHECK.
export const SUPPORT_SUBJECT_MAX = 200;
export const SUPPORT_BODY_MAX = 5000;
export const LEAD_NAME_MAX = 120;
export const LEAD_EMAIL_MAX = 254;
export const LEAD_PHONE_MAX = 40;
export const LEAD_CLINIC_MAX = 120;

/** Hilos que lista el consultorio (los más recientes). Un consultorio con más de 100 conversaciones es raro. */
export const SUPPORT_THREADS_LIST_MAX = 100;
/** Mensajes que se traen de un hilo. */
export const SUPPORT_MESSAGES_MAX = 500;
/** Página de la bandeja de Plataforma. */
export const INBOX_PAGE_SIZE = 30;

/**
 * Rate limits (C-PL11). El del consultorio es por USUARIO (crear + responder comparten el cupo: 10 por hora). Los
 * del lead son por IP (hash), por email (hash) y un corte global diario: el formulario es público y cada lead le
 * manda un mail a Martin.
 */
export const SUPPORT_WRITE_LIMIT = { limit: 10, windowMs: 60 * 60_000 } as const;
export const LEAD_IP_LIMIT = { limit: 5, windowMs: 60 * 60_000 } as const;
export const LEAD_EMAIL_LIMIT = { limit: 3, windowMs: 24 * 60 * 60_000 } as const;
export const LEAD_GLOBAL_LIMIT = { limit: 200, windowMs: 24 * 60 * 60_000 } as const;
/** Un humano no completa el formulario en menos de 3 s; un bot que lo postea directo, sí. */
export const LEAD_MIN_FILL_MS = 3_000;

// ── Copy ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Aviso en todo lugar donde se escribe (consultorio, Plataforma y landing). */
export const NO_PATIENT_DATA_COPY = "No incluyas datos de pacientes.";
export const SUPPORT_TEAM_NAME = "Equipo de KineSoft";
export const SUPPORT_NO_PERMISSION =
  "Solo el titular, quien administra la configuración o quien tiene «Planes y pagos» puede escribirle a soporte.";
/** El superadmin «como soporte» no escribe en nombre del consultorio: para eso tiene la bandeja de /plataforma. */
export const SUPPORT_SESSION_COPY = "Entraste como soporte: los mensajes los escribe el consultorio. Respondé desde /plataforma → Mensajes.";
export const SUPPORT_THREAD_NOT_FOUND = "No encontramos esa conversación. Recargá la página.";
export const SUPPORT_THREAD_CLOSED = "Esta conversación está cerrada. Si necesitás algo más, escribinos un mensaje nuevo.";
export const LEAD_RECEIVED_COPY = "¡Gracias! Recibimos tu consulta y te vamos a responder por mail.";
export const LEAD_EMAIL_CAP_COPY = "Ya recibimos tus consultas de hoy. Te vamos a responder por mail.";
export const LEAD_GLOBAL_LIMIT_COPY = "Hoy recibimos muchas consultas. Probá de nuevo mañana o escribinos por mail.";

// ── Lead (contrato C-PL2 para la landing) ────────────────────────────────────────────────────────────────────────

/**
 * Entrada de `submitLead` (lib/leads.ts). `website` es el honeypot (input escondido, vacío para un humano) y
 * `startedAt` el epoch en ms de cuando se mostró el formulario. `planInterest`: un `SaasPlan` o vacío.
 */
export type SubmitLeadInput = {
  name: string;
  email: string;
  phone?: string | null;
  clinicName?: string | null;
  planInterest?: SaasPlan | string | null;
  message: string;
  website?: string | null;
  startedAt?: number | string | null;
};

// ── Tipos del consultorio ────────────────────────────────────────────────────────────────────────────────────────

export type SupportThreadStatusValue = "OPEN" | "CLOSED";
export type SupportAuthorKindValue = "TENANT" | "PLATFORM" | "LEAD";

export type SupportThreadRow = {
  id: string;
  subject: string;
  status: SupportThreadStatusValue;
  createdAt: string; // ISO
  /** Último mensaje (de cualquiera). */
  lastMessageAt: string;
  lastAuthorKind: SupportAuthorKindValue;
  messageCount: number;
  /** Hay una respuesta de Plataforma posterior a la última vez que ESTE usuario abrió el hilo. */
  unread: boolean;
};

export type SupportMessageView = {
  id: string;
  authorKind: SupportAuthorKindValue;
  /** Nombre para mostrar. Nunca un email (decisión 19). */
  authorName: string;
  /** Lo escribió el usuario que mira (consultorio) o el superadmin que mira (Plataforma). */
  mine: boolean;
  body: string;
  createdAt: string;
};

export type SupportThreadDetail = {
  id: string;
  subject: string;
  status: SupportThreadStatusValue;
  createdAt: string;
  closedAt: string | null;
  messages: SupportMessageView[];
};

// ── Tipos de la bandeja de Plataforma ────────────────────────────────────────────────────────────────────────────

export type InboxKindFilter = "all" | "TENANT" | "LEAD";
export type InboxStatusFilter = "all" | "OPEN" | "CLOSED";

export type InboxRow = {
  id: string;
  kind: "TENANT" | "LEAD";
  status: SupportThreadStatusValue;
  subject: string;
  /** Consultorio (TENANT) o «Nombre · Consultorio» del lead (LEAD). */
  fromLabel: string;
  tenantId: string | null;
  createdAt: string;
  lastMessageAt: string;
  messageCount: number;
  /** Hay mensajes del consultorio/lead posteriores a `platformReadAt`. */
  unread: boolean;
};

export type InboxPage = { rows: InboxRow[]; nextCursor: string | null };

export type InboxThreadDetail = SupportThreadDetail & {
  kind: "TENANT" | "LEAD";
  tenant: { id: string; name: string; slug: string } | null;
  lead: {
    name: string;
    email: string;
    phone: string | null;
    clinicName: string | null;
    planInterest: SaasPlan | null;
  } | null;
};

/** Cómo salió el mail que acompaña una respuesta de Plataforma (la UI avisa si no salió). */
export type InboxReplyMail = "sent" | "skipped" | "failed" | "no_recipient";
export type InboxReplyResult = { messageId: string; mail: InboxReplyMail };

// ── Lógica pura ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Consultorio: no leído = hay respuesta de Plataforma posterior a la marca de este usuario (sin marca = no leído). */
export function isUnreadForTenant(lastPlatformAt: Date | null, readAt: Date | null): boolean {
  if (!lastPlatformAt) return false;
  return !readAt || lastPlatformAt.getTime() > readAt.getTime();
}

/** Plataforma: no leído = hay mensaje del consultorio/lead posterior a `platformReadAt` (sin marca = no leído). */
export function isUnreadForPlatform(lastInboundAt: Date | null, platformReadAt: Date | null): boolean {
  if (!lastInboundAt) return false;
  return !platformReadAt || lastInboundAt.getTime() > platformReadAt.getTime();
}

/**
 * Filtro de bots del formulario público (C-PL11): el honeypot `website` (un campo escondido que un humano no ve ni
 * completa) lleno, o el formulario enviado en menos de 3 s desde que se mostró → `bot`. Al bot se le contesta OK sin
 * crear fila ni mandar mail: si le dijéramos que falló, ajustaría.
 * PL-Z a4#2: SIN `startedAt` (o uno que no es un instante válido) también es `bot`: el formulario de la web siempre lo
 * manda (VX2-c2 lo tiene que incluir como hidden), así que quien no lo trae está posteando directo a la action y se
 * salteaba el filtro de tiempo. Un `startedAt` en el futuro (reloj del cliente adelantado) NO cuenta como bot:
 * preferimos un spam más a perder un lead real.
 */
export function leadBotVerdict(p: { website: string | null | undefined; startedAt: number | null | undefined; now: number }): "bot" | "ok" {
  if ((p.website ?? "").trim() !== "") return "bot";
  const s = p.startedAt;
  if (typeof s !== "number" || !Number.isFinite(s) || s <= 0) return "bot";
  const elapsed = p.now - s;
  if (elapsed < 0) return "ok";
  return elapsed < LEAD_MIN_FILL_MS ? "bot" : "ok";
}

/** Cursor de la bandeja: `<ISO del último mensaje>|<id>`. */
export function encodeInboxCursor(lastAt: Date, id: string): string {
  return `${lastAt.toISOString()}|${id}`;
}

export function decodeInboxCursor(cursor: string | null | undefined): { lastAt: Date; id: string } | null {
  if (!cursor) return null;
  const i = cursor.indexOf("|");
  if (i <= 0) return null;
  const lastAt = new Date(cursor.slice(0, i));
  const id = cursor.slice(i + 1);
  if (Number.isNaN(lastAt.getTime()) || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  return { lastAt, id };
}

/**
 * «14 oct 2026, 13:27» en hora AR sea cual sea el TZ del host (Vercel corre en UTC). Misma construcción que
 * `supportWhen` de «Accesos de soporte»: la hora sale de `toARMinutes` (el ICU de Node imprimía «24:00»).
 */
export function messageWhen(iso: string): string {
  const m = toARMinutes(iso) % 1440;
  const hhmm = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return `${formatDateAR(iso, "short")}, ${hhmm}`;
}

export const SUPPORT_STATUS_LABEL: Record<SupportThreadStatusValue, string> = {
  OPEN: "Abierta",
  CLOSED: "Cerrada",
};
