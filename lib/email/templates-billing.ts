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
import { SAAS_ANCHOR_DAY } from "@/lib/saas-billing-logic";
import type { SaasCollectionMethod } from "@/lib/saas-billing-types";

const AR_TZ = "America/Argentina/Buenos_Aires";

/** «5 de noviembre de 2026» de una clave AR «YYYY-MM-DD» (mediodía AR: ningún TZ del host la corre de día). */
export function formatBillingDate(key: string): string {
  const d = new Date(`${key}T12:00:00-03:00`);
  if (Number.isNaN(d.getTime())) return plain(key);
  return d.toLocaleDateString("es-AR", { day: "numeric", month: "long", year: "numeric", timeZone: AR_TZ });
}

/**
 * «9 de noviembre» (sin año) de una clave AR «YYYY-MM-DD»: el copy de MPS-3c habla del día de este mes o del que viene
 * («Pagá hasta el 9 de noviembre»), donde el año sobra. Mismo mediodía AR que `formatBillingDate`.
 */
export function formatBillingDayMonth(key: string): string {
  const d = new Date(`${key}T12:00:00-03:00`);
  if (Number.isNaN(d.getTime())) return plain(key);
  return d.toLocaleDateString("es-AR", { day: "numeric", month: "long", timeZone: AR_TZ });
}

/** «4 de noviembre»: el día del débito (`SAAS_ANCHOR_DAY`) del mes de la clave (el cargo vence el 9 del mismo mes). */
function debitDayOf(key: string): string {
  const ym = /^\d{4}-\d{2}/.exec(key)?.[0];
  return ym ? formatBillingDayMonth(`${ym}-${String(SAAS_ANCHOR_DAY).padStart(2, "0")}`) : plain(key);
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
  /**
   * MPS-3c (C-MPS12): cómo paga el consultorio. Opcional a propósito: sin él (llamadores de PL-2b, el diagnóstico de
   * mails) el texto queda como antes, pensado para transferencia. Con débito no se pide comprobante ni se muestran
   * los datos para transferir: el cobro sale solo y un «transferí» confundiría (pagaría dos veces).
   */
  collection?: SaasCollectionMethod | null;
}): RenderedEmail {
  const tenant = plain(p.tenantName);
  const how: string[] =
    p.collection === "AUTO_DEBIT"
      ? [`Se debita el ${debitDayOf(p.dueDate)}.`]
      : p.collection === "MP_CHECKOUT"
        ? [`Pagá hasta el ${formatBillingDayMonth(p.dueDate)} para no perder el acceso. Podés pagar con Mercado Pago desde Configuración → Facturación.`]
        : p.collection === "TRANSFER"
          ? [
              `Pagá hasta el ${formatBillingDayMonth(p.dueDate)} para no perder el acceso. Cuando transfieras, subí el comprobante desde Configuración → Facturación y lo acreditamos.`,
              ...transferParagraph(p.transferInfo),
            ]
          : [
              `Vence el ${formatBillingDate(p.dueDate)}. Cuando transfieras, subí el comprobante desde Configuración → Facturación y lo acreditamos.`,
              ...transferParagraph(p.transferInfo),
            ];
  return render({
    subject: `Tu cuota de KineSoft: ${money(p.amountCents)}`,
    context: tenant,
    title: "Ya está tu cuota del mes",
    paragraphs: [
      `La cuota de ${tenant} del ${formatBillingDate(p.periodStart)} al ${formatBillingDate(p.periodEnd)} es de ${money(p.amountCents)}.`,
      ...how,
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

// ── Mercado Pago de la suscripción (MPS-3c, C-MPS12) ───────────────────────────────────────────────────────────
// Mismas reglas que los de arriba: al Titular y a «Planes y pagos», solo consultorio, montos, fechas y plan. El motivo
// del rechazo de MP NO va al mail: el payload de MP es opaco y puede traer datos del pagador; alcanza con el monto.

/** El débito automático quedó autorizado en Mercado Pago. */
export function billingDebitActivatedEmail(p: { tenantName: string; url: string }): RenderedEmail {
  const tenant = plain(p.tenantName);
  return render({
    subject: "Débito automático activo",
    context: tenant,
    title: "Débito automático activo",
    paragraphs: [
      `Listo: el débito automático quedó activo. Se debita el ${SAAS_ANCHOR_DAY} de cada mes.`,
      "Lo podés cambiar o dar de baja cuando quieras desde Configuración → Facturación.",
    ],
    cta: { label: "Ver facturación", url: p.url },
    footer: FOOTER(tenant),
  });
}

/** Mercado Pago rechazó un débito del período. `dueDate` = clave AR del vencimiento del cargo (el 9). */
export function billingDebitFailedEmail(p: { tenantName: string; amountCents: number; dueDate: string; url: string }): RenderedEmail {
  const tenant = plain(p.tenantName);
  return render({
    subject: "No pudimos debitar tu cuota de KineSoft",
    context: tenant,
    title: "No pudimos debitar tu cuota",
    paragraphs: [
      `No pudimos debitar ${money(p.amountCents)}. Pagalo antes del ${formatBillingDayMonth(p.dueDate)} para no perder el acceso.`,
      "Podés pagarlo desde Configuración → Facturación, o revisar el medio de pago del débito en Mercado Pago.",
    ],
    cta: { label: "Ir a Facturación", url: p.url },
    footer: FOOTER(tenant),
  });
}

/** El consultorio pidió la baja: sigue con acceso completo hasta el fin del período pago. */
export function billingCancelScheduledEmail(p: { tenantName: string; accessUntil: string; url: string }): RenderedEmail {
  const tenant = plain(p.tenantName);
  return render({
    subject: "Pediste la baja de KineSoft",
    context: tenant,
    title: "Pediste la baja",
    paragraphs: [
      `Pediste la baja. Vas a tener acceso completo hasta el ${formatBillingDate(p.accessUntil)}. Después el consultorio queda en solo lectura.`,
      "Si cambiás de idea, podés deshacer la baja desde Configuración → Facturación hasta esa fecha.",
    ],
    cta: { label: "Ver facturación", url: p.url },
    footer: FOOTER(tenant),
  });
}

/** La baja se aplicó (CANCELLED): solo lectura, los datos siguen ahí. */
export function billingCancelledEmail(p: { tenantName: string; url: string }): RenderedEmail {
  const tenant = plain(p.tenantName);
  return render({
    subject: "Tu suscripción de KineSoft terminó",
    context: tenant,
    title: "Se aplicó la baja",
    paragraphs: [
      `Se aplicó la baja de ${tenant}. El consultorio quedó en solo lectura: vas a poder consultar todo, pero no cargar datos nuevos.`,
      "Tus datos no se pierden. Para volver, tocá «Reactivar» en Configuración → Facturación.",
    ],
    cta: { label: "Ver facturación", url: p.url },
    footer: FOOTER(tenant),
  });
}

/**
 * Cambio de plan (MPS-D11/D12):
 *  - scheduled   bajada programada para el próximo período;
 *  - applied     la bajada programada se aplicó;
 *  - not_applied / annulled   no entraba (más usuarios que los del plan nuevo): se anuló y sigue el plan actual;
 *  - upgraded    subida inmediata, con el proporcional que se suma al próximo cargo (si hubo).
 * `annulled` es el nombre del stub de MPS-K y `not_applied` el del brief de MPS-3c: mismo mail.
 */
export function billingPlanChangeEmail(p: {
  tenantName: string;
  outcome: "scheduled" | "applied" | "not_applied" | "annulled" | "upgraded";
  planToLabel: string;
  effectiveOn?: string | null;
  prorationCents?: number | null;
  url: string;
}): RenderedEmail {
  const tenant = plain(p.tenantName);
  const plan = plain(p.planToLabel);
  const cta = { label: "Ver facturación", url: p.url };
  const footer = FOOTER(tenant);
  if (p.outcome === "scheduled") {
    const when = p.effectiveOn ? ` el ${formatBillingDate(p.effectiveOn)}` : " en el próximo período";
    return render({
      subject: `Tu plan pasa a ${plan}`,
      context: tenant,
      title: "Programaste un cambio de plan",
      paragraphs: [`Tu plan pasa a ${plan}${when}.`, "Hasta entonces seguís con tu plan actual. Lo podés anular desde Configuración → Facturación."],
      cta,
      footer,
    });
  }
  if (p.outcome === "applied") {
    return render({
      subject: `Tu plan ya es ${plan}`,
      context: tenant,
      title: "Se aplicó el cambio de plan",
      paragraphs: [`Tu plan ya es ${plan}.`, "La próxima cuota sale con el precio de este plan."],
      cta,
      footer,
    });
  }
  if (p.outcome === "upgraded") {
    const extra =
      p.prorationCents && p.prorationCents > 0 ? [`En el próximo cargo se suman ${money(p.prorationCents)} por los días que quedan del período.`] : [];
    return render({
      subject: `Pasaste a ${plan}`,
      context: tenant,
      title: "Cambiaste de plan",
      paragraphs: [`Pasaste a ${plan}.`, ...extra],
      cta,
      footer,
    });
  }
  return render({
    subject: `Tu cambio a ${plan} no se aplicó`,
    context: tenant,
    title: "No se aplicó el cambio de plan",
    paragraphs: [
      `Tu cambio a ${plan} no se aplicó porque el consultorio tiene más usuarios que los que permite ese plan.`,
      "Seguís con tu plan actual. Si querés bajar de plan, primero desactivá los usuarios que sobran y programalo de nuevo.",
    ],
    cta,
    footer,
  });
}
