/**
 * Plantillas de mail de Mensajes y leads (PL-2d, C-PL11, plan §20.5.7). PURAS como `templates.ts`: ni red ni env ni
 * `server-only` (las importan los tests y `scripts/diagnose-email.ts`).
 *
 * Usan `compose` de `templates.ts` (exportado en la integración de PL-2): mismo layout que el resto de los mails.
 *
 * Qué NO lleva cada mail, a propósito:
 *  - `support_message_platform` y `support_reply_tenant` NO llevan el texto del mensaje, solo el asunto y un link
 *    detrás del login. Aunque el formulario dice «No incluyas datos de pacientes», alguien puede pegar uno; un mail
 *    reenviado o en una casilla compartida no tiene que llevarlo. Se lee en la app.
 *  - `lead_received` SÍ lleva el mensaje del lead: es un interesado de la web pública (no hay consultorio ni pacientes
 *    detrás) y Martin lo tiene que poder evaluar desde el celular. Va escapado.
 *  - `lead_reply` lleva la respuesta entera: el lead no tiene cuenta, el mail ES el canal. Nunca hay respuesta
 *    automática al lead (PL-D15): este mail sale solo cuando Martin responde desde /plataforma.
 */
import type { RenderedEmail } from "@/lib/email/types";
import { EMAIL_COLORS as C, EMAIL_FONT as FONT, compose, escapeHtml, para, plain, strong } from "@/lib/email/templates";

/** Copy fijo del pie de los mails de soporte (C-PL11). */
export const SUPPORT_EMAIL_NO_PHI = "No incluyas datos de pacientes en los mensajes a soporte.";
const SUPPORT_TEAM_SIGNATURE = "Equipo de KineSoft";

/** Texto multilínea escapado, con los saltos como `<br>` (el cuerpo de un mensaje). */
function multiline(s: string): string {
  return escapeHtml(s.replace(/\r\n?/g, "\n").trim()).replace(/\n/g, "<br />");
}

function quote(html: string): string {
  return `<div style="margin:0 0 16px;padding:14px 16px;background-color:${C.panel};border:1px solid ${C.line};border-radius:10px;font-family:${FONT};font-size:15px;line-height:24px;color:${C.body};">${html}</div>`;
}

// ── support_message_platform ─────────────────────────────────────────────────────────────────────────────────────

/** A `PLATFORM_INBOX_EMAIL`: un consultorio abrió una conversación o respondió en una. Sin el texto del mensaje. */
export function supportMessagePlatformEmail(p: {
  tenantName: string;
  subject: string;
  isReply: boolean;
  url: string;
}): RenderedEmail {
  const tenant = plain(p.tenantName) || "Un consultorio";
  const subj = plain(p.subject);
  const title = p.isReply ? "Respuesta nueva de un consultorio" : "Mensaje nuevo de un consultorio";
  const lead = p.isReply ? `${tenant} respondió en la conversación «${subj}».` : `${tenant} te escribió: «${subj}».`;
  const leadHtml = p.isReply
    ? `${strong(tenant)} respondió en la conversación «${escapeHtml(subj)}».`
    : `${strong(tenant)} te escribió: «${escapeHtml(subj)}».`;
  const more = "Por seguridad el mensaje no viene en este mail: leelo y respondé desde la bandeja de Plataforma.";
  const footer = ["Te llegó porque tu dirección es la bandeja de soporte de KineSoft.", SUPPORT_EMAIL_NO_PHI];
  return compose({
    subject: `${p.isReply ? "Respuesta" : "Mensaje"} de ${tenant}: ${subj}`,
    preheader: lead,
    context: "Soporte",
    title,
    paragraphs: [lead, more],
    htmlParagraphs: [leadHtml, escapeHtml(more)],
    ctas: [{ label: "Abrir la conversación", url: p.url }],
    footer,
  });
}

// ── support_reply_tenant ─────────────────────────────────────────────────────────────────────────────────────────

/** Al creador del hilo: Plataforma respondió. Sin el texto: se lee en Configuración → Soporte. */
export function supportReplyTenantEmail(p: { tenantName: string; subject: string; url: string }): RenderedEmail {
  const tenant = plain(p.tenantName);
  const subj = plain(p.subject);
  const title = "Te respondimos";
  const lead = `El equipo de KineSoft respondió tu mensaje «${subj}».`;
  const more = "Entrá a Configuración → Soporte para leer la respuesta y seguir la conversación.";
  const footer = [
    `Te llegó porque escribiste a soporte desde ${tenant || "tu consultorio"}.`,
    SUPPORT_EMAIL_NO_PHI,
  ];
  return compose({
    subject: `Te respondimos: ${subj}`,
    preheader: lead,
    context: tenant || "Soporte",
    title,
    paragraphs: [lead, more],
    ctas: [{ label: "Ver la respuesta", url: p.url }],
    footer,
  });
}

// ── lead_received ────────────────────────────────────────────────────────────────────────────────────────────────

/** A `PLATFORM_INBOX_EMAIL`: consulta nueva desde la web pública. Lleva los datos del lead y su mensaje (escapados). */
export function leadReceivedEmail(p: {
  name: string;
  email: string;
  phone: string | null;
  clinicName: string | null;
  planLabel: string | null;
  message: string;
  url: string;
}): RenderedEmail {
  const name = plain(p.name);
  const title = "Consulta nueva desde la web";
  const facts: Array<[string, string]> = [
    ["Nombre", name],
    ["Email", plain(p.email)],
    ...(p.phone ? ([["Teléfono", plain(p.phone)]] as Array<[string, string]>) : []),
    ...(p.clinicName ? ([["Consultorio", plain(p.clinicName)]] as Array<[string, string]>) : []),
    ...(p.planLabel ? ([["Plan que le interesa", plain(p.planLabel)]] as Array<[string, string]>) : []),
  ];
  const factsHtml = facts.map(([k, v]) => `<p style="margin:0 0 6px;font-family:${FONT};font-size:15px;line-height:22px;color:${C.body};">${escapeHtml(k)}: ${strong(v)}</p>`).join("");
  const more = "Respondé desde la bandeja de Plataforma: la respuesta le llega por mail y queda registrada.";
  const footer = ["Te llegó porque tu dirección es la bandeja de soporte de KineSoft.", "El lead no recibió ninguna respuesta automática."];
  return compose({
    subject: `Consulta de ${name}${p.clinicName ? ` (${plain(p.clinicName)})` : ""}`,
    preheader: `${name} escribió desde la web.`,
    context: "Leads",
    title,
    paragraphs: [...facts.map(([k, v]) => `${k}: ${v}`), "Mensaje:", p.message.trim(), more],
    bodyBlocksHtml: [`<div style="margin:0 0 16px;">${factsHtml}</div>`, quote(multiline(p.message)), para(escapeHtml(more))],
    ctas: [{ label: "Responder", url: p.url }],
    footer,
  });
}

// ── lead_reply ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Al lead: la respuesta de Plataforma, entera (no tiene cuenta: el mail es el canal). */
export function leadReplyEmail(p: { name: string; subject: string; body: string }): RenderedEmail {
  const name = plain(p.name);
  const title = "Respuesta a tu consulta";
  const hello = name ? `Hola, ${name}:` : "Hola:";
  const outro = "Si querés seguir la conversación, respondé este mail.";
  const footer = ["Te llegó porque nos escribiste desde el formulario de contacto de KineSoft."];
  return compose({
    subject: `Re: ${plain(p.subject)}`,
    preheader: "El equipo de KineSoft respondió tu consulta.",
    context: "KineSoft",
    title,
    paragraphs: [hello, p.body.trim(), outro, SUPPORT_TEAM_SIGNATURE],
    bodyBlocksHtml: [
      para(escapeHtml(hello)),
      quote(multiline(p.body)),
      para(escapeHtml(outro)),
      para(escapeHtml(SUPPORT_TEAM_SIGNATURE)),
    ],
    ctas: [],
    footer,
  });
}
