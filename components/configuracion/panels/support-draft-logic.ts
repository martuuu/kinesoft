/**
 * PV (§27, TK-U3): borrador de «Nuevo mensaje» de Configuración → Soporte según el motivo de la URL
 * (`/configuracion?tab=soporte&nuevo=<slug>`). Es el destino adentro de la app de todo lo que antes era un `mailto:`
 * (banda de acceso, «Consultanos» del plan Libre) y al que `/contacto` (TK-U2) redirige a quien tiene un consultorio
 * usable: el mensaje entra como ticket de /plataforma con su origen (`SupportThread.source`, M19).
 *
 * PURO (sin React ni server): lo usa la página (server) para armar el borrador, así el JS de /configuracion no crece
 * (el cliente recibe un objeto plano), y la banda de acceso (server component) para el href.
 *
 * El origen lo vuelve a validar el zod de `createSupportThread` (`lib/support-threads.ts`, `APP_SOURCES`): acá solo se
 * elige uno que el server acepte, para que un link raro no termine en «Ese motivo no es válido».
 */
import { TENANT_TICKET_SOURCES, ticketSourceFromMotivo, type TenantTicketSourceValue } from "@/lib/support-ticket-sources";

/**
 * Orígenes que el consultorio puede abrir desde la app. Son los TENANT del CHECK de M19 SIN `TENANT_SUSPENDED`: el
 * zod de `createSupportThread` lo rechaza (un consultorio con Actor no está suspendido; ese ticket lo abre
 * `lib/tickets.ts`). Si el brief dice «TENANT_TICKET_SOURCES», gana el código del server.
 */
export const APP_TICKET_SOURCES = TENANT_TICKET_SOURCES.filter(
  (s): s is Exclude<TenantTicketSourceValue, "TENANT_SUSPENDED"> => s !== "TENANT_SUSPENDED"
);
export type AppTicketSourceValue = (typeof APP_TICKET_SOURCES)[number];

/** PL-3a: mensaje prellenado. TK-U3 suma `source` (sin él, el server usa `TENANT_SUPPORT`). */
export type SupportDraft = { subject: string; body: string; source?: AppTicketSourceValue };

/** Asunto sugerido por origen. Soporte genérico va vacío: no sabemos de qué es la duda. */
const SUBJECT: Record<AppTicketSourceValue, string> = {
  TENANT_SUPPORT: "",
  PLAN_CHANGE: "Consulta por mi plan",
  PRIVACY: "Consulta sobre datos personales",
};

/**
 * `?nuevo=` crudo → borrador, o null si no vino (sin `nuevo`, la pestaña se comporta como siempre).
 *  - `plan` → PLAN_CHANGE «Consulta por mi plan»; `privacidad` → PRIVACY.
 *  - `plan-libre` y `precio` (orígenes de LEAD, que /contacto puede reenviar a alguien con sesión): PLAN_CHANGE, porque
 *    quien ya tiene consultorio y pregunta por precio o por Libre está pidiendo cambiar de plan. Libre con su asunto.
 *  - Cualquier otro slug (desconocido, `soporte`, `suspendido`, uno de lead): TENANT_SUPPORT con asunto vacío.
 */
export function supportDraftFromNuevo(raw: unknown): SupportDraft | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (typeof v !== "string" || v.trim() === "") return null;
  const source = ticketSourceFromMotivo(v);
  if (source === "PLAN_LIBRE") return { subject: "Quiero el plan Libre", body: "", source: "PLAN_CHANGE" };
  if (source === "PRICING") return { subject: SUBJECT.PLAN_CHANGE, body: "", source: "PLAN_CHANGE" };
  const app: AppTicketSourceValue = (APP_TICKET_SOURCES as readonly string[]).includes(source)
    ? (source as AppTicketSourceValue)
    : "TENANT_SUPPORT";
  return { subject: SUBJECT[app], body: "", source: app };
}

/** Lo que el Drawer le manda a `createSupportThread`. Sin origen no se manda la clave (el server usa su default). */
export function supportComposeInput(subject: string, body: string, source: AppTicketSourceValue | undefined) {
  return source ? { subject, body, source } : { subject, body };
}

/** Link a «Nuevo mensaje» con borrador. `motivo` = slug de `TICKET_MOTIVO` (`plan`, `soporte`, `privacidad`…). */
export function supportComposeHref(motivo: string): string {
  return `/configuracion?tab=soporte&nuevo=${encodeURIComponent(motivo)}`;
}
