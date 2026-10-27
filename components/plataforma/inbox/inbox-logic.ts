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
 * viejos que los llevan. Por eso la query trae también `status`/`kind` (derivados): la lista de Tickets (TK-U1) filtra
 * por `stage`/`source`, pero `kind` sigue viajando para que `?origen=leads` de un link viejo filtre lo mismo que antes.
 */
import {
  messageWhen,
  type InboxKindFilter,
  type InboxReplyMail,
  type InboxSourceFilter,
  type InboxStageFilter,
  type InboxStatusFilter,
  type TicketDetail,
  type TicketStage,
} from "@/lib/support-threads-types";
import { toArMobileE164 } from "@/lib/phone-e164";
import { SAAS_PLAN_LABEL } from "@/lib/tenant-modules";
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

/** Slug de `?estado=` de una etapa, o null para el default («Abiertos»). Lo usa el form GET del select de origen. */
export function stageSlugOf(stage: InboxStageFilter): string | null {
  return STAGE_SLUG[stage];
}

export function inboxThreadHref(id: string): string {
  return `${INBOX_PATH}/${encodeURIComponent(id)}`;
}

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

// ── Tickets (TK-U1) ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Tono del tag de etapa. El tag lleva el texto («Nuevo» / «En curso» / «Resuelto»): el color es un canal más, no el
 * único. Nuevo en lima (lo que hay que agarrar), En curso en sky, Resuelto apagado.
 */
export const STAGE_TAG_TONE: Record<TicketStage, "lime" | "sky" | "soft"> = {
  NEW: "lime",
  IN_PROGRESS: "sky",
  CLOSED: "soft",
};

/** Copy del confirm de «Marcar resuelto» (brief §A «Copy», literal). */
export function resolveConfirmMessage(kind: "TENANT" | "LEAD"): string {
  return kind === "TENANT"
    ? "El consultorio lo va a ver cerrado. Si vuelve a escribir, entra como ticket nuevo."
    : "Pasa a Resueltos. Si respondés, se vuelve a abrir.";
}

export type ContactRow = {
  label:
    | "Nombre"
    | "Email"
    | "Teléfono"
    | "WhatsApp"
    | "Consultorio"
    | "Usuario"
    | "Identidad"
    | "Plan que le interesa"
    | "Origen"
    | "Recibido"
    | "Tomado por";
  value: string;
  /** `mailto:` / `tel:` / `https://wa.me/` (externos) o una ruta de /plataforma (internos). */
  href?: string;
  external?: boolean;
};

/** `tel:` con solo dígitos y un `+` inicial: los espacios y guiones del dato cargado no van en el URI. */
function telHref(raw: string): string | null {
  const t = raw.trim();
  const digits = t.replace(/\D/g, "");
  if (digits.length < 6) return null;
  return `tel:${t.startsWith("+") ? "+" : ""}${digits}`;
}

/**
 * Filas de la tarjeta «Contacto» (brief §A): solo las que tienen dato, en el orden del brief. En Plataforma los links
 * directos están bien (decisión de Martin: «Yo me comunico luego con cada cliente»): email con `mailto:`, teléfono con
 * `tel:` y WhatsApp con `wa.me` solo si el número es un celular argentino válido (`toArMobileE164`: un fijo en `wa.me`
 * abre «el número no está en WhatsApp»; ahí va el número como texto).
 * WhatsApp: el del consultorio (`Tenant.whatsapp`) o, si no hay, el teléfono del contacto cuando es celular. Teléfono:
 * el del contacto (lead) o el del consultorio. «Usuario» linkea a /plataforma/usuarios (quien abrió el ticket); un
 * lead sin usuario lleva «Identidad: Sin verificar (formulario web)» en su lugar.
 */
export function ticketContactRows(t: TicketDetail): ContactRow[] {
  const c = t.contact;
  const rows: ContactRow[] = [];
  if (c.name?.trim()) rows.push({ label: "Nombre", value: c.name.trim() });
  if (c.email?.trim()) rows.push({ label: "Email", value: c.email.trim(), href: `mailto:${c.email.trim()}`, external: true });

  const phone = c.phone?.trim() || c.tenant?.phone?.trim() || null;
  if (phone) {
    const href = telHref(phone);
    rows.push(href ? { label: "Teléfono", value: phone, href, external: true } : { label: "Teléfono", value: phone });
  }
  const tenantWa = c.tenant?.whatsapp?.trim() || null;
  const waE164 = toArMobileE164(tenantWa ?? phone);
  if (waE164) {
    rows.push({ label: "WhatsApp", value: tenantWa ?? phone ?? waE164, href: `https://wa.me/${waE164.replace(/^\+/, "")}`, external: true });
  } else if (tenantWa) {
    rows.push({ label: "WhatsApp", value: tenantWa });
  }

  if (c.tenant) {
    rows.push({ label: "Consultorio", value: c.tenant.name, href: `/plataforma/consultorios/${encodeURIComponent(c.tenant.id)}` });
  } else if (c.clinicName?.trim()) {
    rows.push({ label: "Consultorio", value: c.clinicName.trim() });
  }
  if (c.userId) rows.push({ label: "Usuario", value: "Ver en Usuarios", href: `/plataforma/usuarios/${encodeURIComponent(c.userId)}` });
  // ZF1a (ZA B1): un LEAD sin usuario salió del formulario web: nombre, email y origen los tipeó cualquiera. Se dice
  // explícito para que un «Cuenta desactivada · Ana» de la web no se atienda como un pedido de la dueña de la cuenta
  // (los de sesión traen `userId`: los abre `submitSessionTicket` con la identidad verificada).
  else if (t.kind === "LEAD") rows.push({ label: "Identidad", value: "Sin verificar (formulario web)" });
  if (c.planInterest) rows.push({ label: "Plan que le interesa", value: SAAS_PLAN_LABEL[c.planInterest] });
  rows.push({ label: "Origen", value: TICKET_SOURCE_LABEL[t.source] });
  rows.push({ label: "Recibido", value: messageWhen(t.createdAt) });
  if (t.takenByName) {
    rows.push({ label: "Tomado por", value: t.takenAt ? `${t.takenByName} · ${messageWhen(t.takenAt)}` : t.takenByName });
  }
  return rows;
}
