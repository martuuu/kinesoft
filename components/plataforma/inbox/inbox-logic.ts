/**
 * Lógica pura de la bandeja de /plataforma → Mensajes (PL-2d). Sin React, sin `next/*`, sin DB: la usan la página
 * (server), los componentes y el render test.
 *
 * Los filtros viven en la URL (`?estado=abiertas|cerradas&origen=consultorios|leads&desde=<cursor>`), en castellano
 * como el resto de las URLs de la app; la action recibe los valores del enum.
 */
import type { InboxKindFilter, InboxStatusFilter, InboxReplyMail } from "@/lib/support-threads-types";

export const INBOX_PATH = "/plataforma/mensajes";

export type InboxQuery = { status: InboxStatusFilter; kind: InboxKindFilter; cursor: string | null };

type RawParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

const STATUS_PARAM: Record<string, InboxStatusFilter> = { abiertas: "OPEN", cerradas: "CLOSED" };
const KIND_PARAM: Record<string, InboxKindFilter> = { consultorios: "TENANT", leads: "LEAD" };

/** Default: abiertas (lo que hay que atender). «Todas» se pide explícito con `?estado=todas`. */
export function parseInboxQuery(sp: RawParams): InboxQuery {
  const estado = first(sp.estado);
  const origen = first(sp.origen);
  const desde = first(sp.desde);
  return {
    status: estado === "todas" ? "all" : (estado && STATUS_PARAM[estado]) || "OPEN",
    kind: (origen && KIND_PARAM[origen]) || "all",
    cursor: desde && desde.length <= 200 ? desde : null,
  };
}

export function inboxHref(q: Omit<InboxQuery, "cursor">, cursor?: string | null): string {
  const p = new URLSearchParams();
  if (q.status === "all") p.set("estado", "todas");
  else if (q.status === "CLOSED") p.set("estado", "cerradas");
  if (q.kind === "TENANT") p.set("origen", "consultorios");
  else if (q.kind === "LEAD") p.set("origen", "leads");
  if (cursor) p.set("desde", cursor);
  const s = p.toString();
  return s ? `${INBOX_PATH}?${s}` : INBOX_PATH;
}

export function inboxThreadHref(id: string): string {
  return `${INBOX_PATH}/${encodeURIComponent(id)}`;
}

export const STATUS_FILTERS: ReadonlyArray<{ value: InboxStatusFilter; label: string }> = [
  { value: "OPEN", label: "Abiertas" },
  { value: "CLOSED", label: "Cerradas" },
  { value: "all", label: "Todas" },
];

export const KIND_FILTERS: ReadonlyArray<{ value: InboxKindFilter; label: string }> = [
  { value: "all", label: "Todo" },
  { value: "TENANT", label: "Consultorios" },
  // PL-Z: «Leads» es jerga de marketing; en la UI son «Consultas de la web» (el slug `leads` de la URL queda igual,
  // así no se rompen links guardados).
  { value: "LEAD", label: "Consultas de la web" },
];

export const KIND_LABEL: Record<"TENANT" | "LEAD", string> = { TENANT: "Consultorio", LEAD: "Consulta de la web" };

/** Qué decirle al superadmin después de responder, según cómo salió el mail. */
export function replyMailMessage(kind: "TENANT" | "LEAD", mail: InboxReplyMail): { tone: "success" | "warning"; title: string; description?: string } {
  const who = kind === "LEAD" ? "a quien consultó" : "al consultorio";
  switch (mail) {
    case "sent":
      return { tone: "success", title: "Respuesta enviada", description: `Le avisamos por mail ${who}.` };
    case "skipped":
      return {
        tone: "warning",
        title: "Respuesta guardada, el mail no salió",
        description: "En este entorno no se mandan mails. En producción le llega normalmente.",
      };
    case "failed":
      return {
        tone: "warning",
        title: "Respuesta guardada, el mail falló",
        description: kind === "LEAD" ? "Quien consultó no tiene otra forma de verla: escribile por otro medio." : "El consultorio la ve igual en Configuración → Soporte.",
      };
    default:
      return {
        tone: "warning",
        title: "Respuesta guardada sin aviso por mail",
        description: "No encontramos a quién avisarle (nadie activo en el consultorio). La ven al entrar.",
      };
  }
}

/** Contador del nav: «9+» desde 10 (no ensancha el sidebar). */
export function unreadBadgeLabel(n: number): string | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 9 ? "9+" : String(Math.floor(n));
}
