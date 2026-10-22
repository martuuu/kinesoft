/**
 * [TP-2d] Mail del link de pago (T5, C-TP9 del plan §25.7, kind `payment_link`). Puro: datos → { subject, html, text },
 * sobre `compose` de `templates.ts` (mismo layout que el resto de los mails).
 *
 * **Sin concepto ni datos clínicos (TP-D27).** El concepto lo escribe el staff a mano y puede ser clínico («sesión de
 * rehabilitación de rodilla»); el mail lo puede leer cualquiera con acceso al buzón y viaja por proveedores de terceros.
 * Por eso la firma NO recibe el concepto, ni el paciente, ni el servicio: un cambio futuro no puede colarlos por
 * descuido (mismo criterio que `portalDocumentEmail`). El concepto sí va en el WhatsApp, que manda el staff mirando el
 * texto, y en la página `/pagar`, que se abre con el link.
 *
 * Anti-phishing: el cuerpo dice que el pago lo procesa Mercado Pago y que nunca se piden los datos de la tarjeta por
 * mail; el pie, que si no lo esperaba no pague. El remitente lleva el nombre del consultorio (`fromName` en el envío).
 */
import type { RenderedEmail } from "@/lib/email/types";
import { compose, escapeHtml, formatExpiryAR, plain, strong } from "@/lib/email/templates";
import { formatARS } from "@/lib/format";

export function paymentLinkEmail(p: {
  tenantName: string;
  /** «Es a nombre de {Profesional}»: a qué cuenta entra la plata. `null` = cuenta del consultorio (sin la línea). */
  practitionerName: string | null;
  amountCents: number;
  url: string;
  expiresAt: Date;
}): RenderedEmail {
  const tenant = plain(p.tenantName);
  const amount = formatARS(p.amountCents);
  const who = plain(p.practitionerName);
  const lead = `${tenant} te mandó un link para pagar ${amount} con Mercado Pago.`;
  const leadHtml = `${strong(tenant)} te mandó un link para pagar ${strong(amount)} con Mercado Pago.`;
  const onBehalf = who ? [`Es a nombre de ${who}.`] : [];
  const safety = "El pago lo procesa Mercado Pago: nunca te vamos a pedir los datos de tu tarjeta por mail ni por WhatsApp.";
  return compose({
    subject: `${tenant}: tu link de pago`,
    preheader: lead,
    context: tenant,
    title: "Tu link de pago",
    paragraphs: [lead, ...onBehalf, safety],
    htmlParagraphs: [leadHtml, ...onBehalf.map(escapeHtml), escapeHtml(safety)],
    ctas: [{ label: `Pagar ${amount}`, url: p.url }],
    footer: [
      `El link vence el ${formatExpiryAR(p.expiresAt)} (hora de Argentina).`,
      "Si no esperabas este mail, no pagues y avisale al consultorio.",
    ],
  });
}
