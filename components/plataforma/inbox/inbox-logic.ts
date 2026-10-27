/**
 * Lógica pura de la bandeja de /plataforma → Tickets (PL-2d; tickets en PV §27, TK-S2). Sin React, sin `next/*`, sin
 * DB: la usan la página (server), los componentes y los tests. La ruta sigue siendo `/plataforma/mensajes` (D-TK2).
 *
 * Los filtros viven en la URL, en castellano como el resto de las URLs de la app; la action recibe los valores del enum:
 *  - `?estado=abiertos|nuevos|en-curso|resueltos|todos` (etapa: Nuevo = OPEN sin tomar, En curso = OPEN tomado,
 *    Resuelto = CLOSED; «abiertos» = Nuevos + En curso, el default);
 *  - `?origen=<slug>` con los slugs de `TICKET_MOTIVO` (los mismos de `/contacto?motivo=`);
 *  - `?desde=<cursor>`.
 * Los de PL-2d (`?estado=abiertas|cerradas|todas`, `?origen=consultorios|leads`) siguen: hay links guardados y mails
 * viejos que los llevan. Por eso la query trae también `status`/`kind` (derivados), que usa la lista de PL-2d hasta
 * que TK-U1 (Q3) la reemplace.
 */
import type {
  InboxKindFilter,
  InboxReplyMail,
  InboxSourceFilter,
  InboxStageFilter,
  InboxStatusFilter,
} from "@/lib/support-threads-types";
import {
  SUPPORT_TICKET_SOURCES,
  TICKET_MOTIVO,
  TICKET_SOURCE_LABEL,
  motivoOfSource,
} from "@/lib/support-ticket-sources";

export const INBOX_PATH = "/plataforma/mensajes";

export type InboxQuery = {
  stage: InboxStageFilter;
  source: InboxSourceFilter;
  /** Derivado de `stage` (PL-2d). */
  status: InboxStatusFilter;
  /** Solo por los slugs viejos `consultorios|leads`; con un origen nuevo queda `all` (el origen ya implica el tipo). */
  kind: InboxKindFilter;
  cursor: string | null;
};

type RawParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** `hasOwnProperty` y no `in` / indexar directo: `?estado=constructor` no puede resolver a `Object.prototype`. */
function own<T>(map: Record<string, T>, key: string | undefined): T | undefined {
  return key !== undefined && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

const STAGE_PARAM: Record<string, InboxStageFilter> = {
  abiertos: "open",
  nuevos: "NEW",
  "en-curso": "IN_PROGRESS",
  resueltos: "CLOSED",
  todos: "all",
  // PL-2d
  abiertas: "open",
  cerradas: "CLOSED",
  todas: "all",
};
const STAGE_SLUG: Record<InboxStageFilter, string | null> = {
  open: null, // default: no ensucia la URL
  NEW: "nuevos",
  IN_PROGRESS: "en-curso",
  CLOSED: "resueltos",
  all: "todos",
};
const KIND_PARAM: Record<string, InboxKindFilter> = { consultorios: "TENANT", leads: "LEAD" };

function statusOfStage(stage: InboxStageFilter): InboxStatusFilter {
  if (stage === "all") return "all";
  return stage === "CLOSED" ? "CLOSED" : "OPEN";
}

function stageOfStatus(status: InboxStatusFilter | undefined): InboxStageFilter {
  if (status === "all") return "all";
  return status === "CLOSED" ? "CLOSED" : "open";
}

/** Default: abiertos (lo que hay que atender). «Todos» se pide explícito con `?estado=todos`. */
export function parseInboxQuery(sp: RawParams): InboxQuery {
  const estado = first(sp.estado);
  const origen = first(sp.origen);
  const desde = first(sp.desde);
  const stage = own(STAGE_PARAM, estado) ?? "open";
  const source = own<InboxSourceFilter>(TICKET_MOTIVO, origen) ?? "all";
  return {
    stage,
    source,
    status: statusOfStage(stage),
    kind: (source === "all" && own(KIND_PARAM, origen)) || "all",
    cursor: desde && desde.length <= 200 ? desde : null,
  };
}

/**
 * Link a la bandeja con estos filtros. Acepta la forma nueva (`stage`/`source`) y la de PL-2d (`status`/`kind`): si
 * viene `stage`, manda `stage`; si no, se deriva de `status`. Con un `source` concreto se escribe el slug nuevo; si
 * no, el `kind` viejo (`consultorios|leads`).
 */
export function inboxHref(q: Partial<Omit<InboxQuery, "cursor">>, cursor?: string | null): string {
  const p = new URLSearchParams();
  const stageSlug = STAGE_SLUG[q.stage ?? stageOfStatus(q.status)];
  if (stageSlug) p.set("estado", stageSlug);
  if (q.source && q.source !== "all") p.set("origen", motivoOfSource(q.source));
  else if (q.kind === "TENANT") p.set("origen", "consultorios");
  else if (q.kind === "LEAD") p.set("origen", "leads");
  if (cursor) p.set("desde", cursor);
  const s = p.toString();
  return s ? `${INBOX_PATH}?${s}` : INBOX_PATH;
}

export function inboxThreadHref(id: string): string {
  return `${INBOX_PATH}/${encodeURIComponent(id)}`;
}

/** PL-2d (lista vieja, hasta TK-U1 en Q3). Los de Tickets son `STAGE_FILTERS` / `SOURCE_FILTERS`, abajo. */
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

/** Etapas de Tickets (PV, copy del brief §A «Copy»). «Abiertos» = Nuevos + En curso (default). */
export const STAGE_FILTERS: ReadonlyArray<{ value: InboxStageFilter; label: string }> = [
  { value: "open", label: "Abiertos" },
  { value: "NEW", label: "Nuevos" },
  { value: "IN_PROGRESS", label: "En curso" },
  { value: "CLOSED", label: "Resueltos" },
  { value: "all", label: "Todos" },
];

/** Orígenes, en el orden del enum (M19), con la etiqueta de `TICKET_SOURCE_LABEL`. */
export const SOURCE_FILTERS: ReadonlyArray<{ value: InboxSourceFilter; label: string }> = [
  { value: "all", label: "Todos los orígenes" },
  ...SUPPORT_TICKET_SOURCES.map((s) => ({ value: s, label: TICKET_SOURCE_LABEL[s] })),
];

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
