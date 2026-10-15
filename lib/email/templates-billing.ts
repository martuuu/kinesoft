/**
 * Mails de cobros de la suscripción (PL-2b, C-PL7..10 sin Mercado Pago). Puras: datos → { subject, html, text }.
 * Los manda el cron diario (cargo nuevo, vencido, precio nuevo) y Plataforma al revisar o imputar un pago. Van al
 * Titular y a quien tenga «Planes y pagos» (`grantBilling`); nunca llevan datos de pacientes.
 *
 * Usan `compose` de `templates.ts` (exportado en la integración de PL-2): mismo layout que el resto de los mails.
 */
import type { RenderedEmail } from "@/lib/email/types";
import { compose, plain } from "@/lib/email/templates";
import { formatARS } from "@/lib/format";

const AR_TZ = "America/Argentina/Buenos_Aires";

/** «5 de noviembre de 2026» de una clave AR «YYYY-MM-DD» (mediodía AR: ningún TZ del host la corre de día). */
export function formatBillingDate(key: string): string {
  const d = new Date(`${key}T12:00:00-03:00`);
  if (Number.isNaN(d.getTime())) return plain(key);
  return d.toLocaleDateString("es-AR", { day: "numeric", month: "long", year: "numeric", timeZone: AR_TZ });
}

function money(cents: number): string {
  return formatARS(cents);
}

/** Forma común de los mails de cobro sobre `compose`: un botón y el pie de «por qué te llegó». */
function render(p: {
  subject: string;
  context: string;
  title: string;
  paragraphs: string[];
  cta: { label: string; url: string };
  footer: string;
}): RenderedEmail {
  return compose({
    subject: p.subject,
    preheader: p.paragraphs[0] ?? p.title,
    context: p.context,
    title: p.title,
    paragraphs: p.paragraphs,
    ctas: [p.cta],
    footer: [p.footer],
  });
}

const FOOTER = (tenant: string) =>
  `Te llegó este mail porque sos titular de ${tenant} en KineSoft o tenés permiso para ver y cambiar el plan y los pagos.`;

/**
 * PL-Z (A2): a dónde transferir (`SAAS_BILLING_TRANSFER_INFO`, lo pasa quien arma el mail). Texto de la env, que puede
 * traer saltos de línea o `<>`: `plain` lo deja en una línea y `compose` lo escapa en el HTML. Sin dato, no hay
 * párrafo (el consultorio tampoco ve «Informar pago»).
 */
function transferParagraph(info: string | null | undefined): string[] {
  const v = plain(info);
  return v ? [`Datos para transferir: ${v}`] : [];
}

/** Cargo nuevo del período (cron). */
export function billingChargeCreatedEmail(p: {
  tenantName: string;
  amountCents: number;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  url: string;
  transferInfo?: string | null;
}): RenderedEmail {
  const tenant = plain(p.tenantName);
  return render({
    subject: `Tu cuota de KineSoft: ${money(p.amountCents)}`,
    context: tenant,
    title: "Ya está tu cuota del mes",
    paragraphs: [
      `La cuota de ${tenant} del ${formatBillingDate(p.periodStart)} al ${formatBillingDate(p.periodEnd)} es de ${money(p.amountCents)}.`,
      `Vence el ${formatBillingDate(p.dueDate)}. Cuando transfieras, subí el comprobante desde Configuración → Facturación y lo acreditamos.`,
      ...transferParagraph(p.transferInfo),
    ],
    cta: { label: "Ver facturación", url: p.url },
    footer: FOOTER(tenant),
  });
}

/** Pago acreditado (Plataforma aprobó el comprobante o imputó un pago). */
export function billingPaymentReceivedEmail(p: { tenantName: string; amountCents: number; url: string }): RenderedEmail {
  const tenant = plain(p.tenantName);
  return render({
    subject: `Recibimos tu pago de ${money(p.amountCents)}`,
    context: tenant,
    title: "Pago acreditado",
    paragraphs: [`Acreditamos un pago de ${money(p.amountCents)} en la cuenta de ${tenant}. ¡Gracias!`],
    cta: { label: "Ver facturación", url: p.url },
    footer: FOOTER(tenant),
  });
}

/** Comprobante rechazado, con el motivo que escribió Plataforma (texto libre: se escapa). */
export function billingPaymentRejectedEmail(p: { tenantName: string; amountCents: number; reason: string; url: string }): RenderedEmail {
  const tenant = plain(p.tenantName);
  return render({
    subject: "No pudimos acreditar tu comprobante",
    context: tenant,
    title: "Revisá el comprobante",
    paragraphs: [
      `No pudimos acreditar el comprobante de ${money(p.amountCents)} de ${tenant}.`,
      `Motivo: ${plain(p.reason)}`,
      "Podés subir otro desde Configuración → Facturación o respondernos este mail.",
    ],
    cta: { label: "Ver facturación", url: p.url },
    footer: FOOTER(tenant),
  });
}

/** La cuenta pasó a vencida (PAST_DUE): cuenta los días de gracia antes del modo lectura. */
export function billingPastDueEmail(p: {
  tenantName: string;
  balanceCents: number;
  graceDays: number;
  url: string;
  transferInfo?: string | null;
}): RenderedEmail {
  const tenant = plain(p.tenantName);
  return render({
    subject: "Tu cuota de KineSoft está vencida",
    context: tenant,
    title: "Tenés una cuota vencida",
    paragraphs: [
      `La cuenta de ${tenant} tiene ${money(Math.max(0, p.balanceCents))} pendientes.`,
      `Tenés ${p.graceDays} días para ponerte al día. Después el consultorio puede pasar a modo lectura: vas a poder consultar todo, incluida la historia clínica, pero no cargar datos nuevos.`,
      ...transferParagraph(p.transferInfo),
    ],
    cta: { label: "Pagar y subir comprobante", url: p.url },
    footer: FOOTER(tenant),
  });
}

/** Precio nuevo del plan con vigencia (PL-D8). */
export function billingPriceChangeEmail(p: {
  tenantName: string;
  planLabel: string;
  priceCents: number;
  previousPriceCents: number | null;
  effectiveFrom: string;
  url: string;
}): RenderedEmail {
  const tenant = plain(p.tenantName);
  const plan = plain(p.planLabel);
  const before = p.previousPriceCents === null ? "" : ` (antes ${money(p.previousPriceCents)})`;
  return render({
    subject: `Nuevo precio del plan ${plan}`,
    context: tenant,
    title: "Cambia el precio de tu plan",
    paragraphs: [
      `Desde el ${formatBillingDate(p.effectiveFrom)}, el plan ${plan} pasa a costar ${money(p.priceCents)} por mes${before}.`,
      "Se aplica desde la próxima cuota que se genere a partir de esa fecha. Si tenés dudas, respondé este mail.",
    ],
    cta: { label: "Ver facturación", url: p.url },
    footer: FOOTER(tenant),
  });
}
