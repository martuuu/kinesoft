"use server";

/**
 * Página pública del link de pago `/pagar/[token]` (T5, contrato C-TP9 del plan §25.7). Implementación de TP-2d.
 *
 * Superficie SIN Actor (la abre el paciente, o cualquiera a quien le reenvíen el link) → canal service
 * (`prismaService`, BYPASSRLS) con el token como única llave. Es `"use server"` porque además de la página la llama el
 * poller de `/pagar` (TP-3i, cada 3 s al volver de Mercado Pago).
 *
 * Reglas (C-TP9):
 *   - **El GET NUNCA escribe.** Los antivirus y los previews de mail y de WhatsApp abren los links: si leer el link
 *     venciera el cobro, marcara «visto» o abriera la preferencia, un escáner cambiaría el estado de un cobro. El
 *     vencimiento por reloj se CALCULA (`publicLinkStatus`); pasarlo a EXPIRED es del cron (TP-2h). El rate limit no
 *     toca la base (Upstash o memoria).
 *   - **Sin datos del paciente.** Ni el nombre, ni el DNI, ni el turno: el link viaja por canales de terceros. Ni
 *     siquiera se seleccionan (lo que no se lee no se puede filtrar en un refactor).
 *   - Rate limit 60/min/IP; token con zod `^[A-Za-z0-9_-]{22}$` (un token mal formado no llega a la base).
 *   - Consultorio suspendido o dado de baja → `unavailable` (TP-D23): sin checkout aunque el cobro siga vivo.
 *   - `null` = inexistente (token desconocido, mal formado, de un cobro que no es un link, o rate limit: el mismo
 *     resultado para no dar un oráculo de tokens válidos).
 */
import { headers } from "next/headers";
import { prismaService as prisma } from "@/lib/db";
import { clientIp } from "@/lib/client-ip";
import { rateLimit } from "@/lib/rate-limit";
import { TENANT_ACCESS_SELECT } from "@/lib/tenant-access";
import { publicSurfacesOpenFor } from "@/lib/public-booking-internal";
import { buildMpReceipt } from "@/lib/mp-receipt";
import { publicLinkStatus } from "@/lib/payment-links-logic";
import { PublicPaymentTokenSchema, type PublicPaymentLink } from "@/lib/payment-links-types";

/** C-TP9: 60 por minuto por IP. */
const PUBLIC_RATE = { limit: 60, windowMs: 60_000 } as const;

export async function getPublicPaymentLink(token: string): Promise<PublicPaymentLink | null> {
  const parsed = PublicPaymentTokenSchema.safeParse(token);
  if (!parsed.success) return null;
  const rl = await rateLimit(`payment-link:public:ip:${clientIp(headers())}`, PUBLIC_RATE);
  if (!rl.ok) return null;

  const c = await prisma.onlineCharge.findUnique({
    where: { publicToken: parsed.data },
    select: {
      origin: true,
      kind: true,
      status: true,
      amountCents: true,
      concept: true,
      expiresAt: true,
      checkoutUrl: true,
      mpPaymentId: true,
      approvedAt: true,
      paidAmountCents: true,
      paymentMethodId: true,
      paymentTypeId: true,
      // Solo el estado del turno (¿se canceló o ya se cobró a mano?): ni la fecha, ni el servicio, ni el paciente.
      booking: { select: { status: true, paymentStatus: true } },
      mpAccount: { select: { kind: true } },
      practitioner: { select: { user: { select: { fullName: true } } } },
      tenant: { select: { name: true, ...TENANT_ACCESS_SELECT } },
    },
  });
  if (!c || c.origin !== "LINK") return null;

  const status = publicLinkStatus(
    { status: c.status, expiresAt: c.expiresAt, checkoutUrl: c.checkoutUrl, kind: c.kind, booking: c.booking },
    publicSurfacesOpenFor(c.tenant),
    new Date()
  );
  const receipt =
    status === "paid" || status === "refunded"
      ? buildMpReceipt({
          mpPaymentId: c.mpPaymentId,
          approvedAt: c.approvedAt,
          paidAmountCents: c.paidAmountCents,
          paymentMethodId: c.paymentMethodId,
          paymentTypeId: c.paymentTypeId,
        })
      : null;

  return {
    status,
    clinicName: c.tenant.name,
    // «A nombre de»: a qué cuenta entra la plata. La del consultorio no lleva nombre de persona.
    practitionerName: c.mpAccount.kind === "PRACTITIONER" ? c.practitioner.user.fullName?.trim() || null : null,
    amountCents: c.amountCents,
    concept: c.concept ?? "",
    expiresAt: c.expiresAt.toISOString(),
    checkoutUrl: status === "payable" ? c.checkoutUrl : null,
    receipt: receipt ? { operationId: receipt.operationId, approvedAtLabel: receipt.approvedAtLabel, methodLabel: receipt.methodLabel } : null,
  };
}
