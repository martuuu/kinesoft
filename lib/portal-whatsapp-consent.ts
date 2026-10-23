"use server";

/**
 * WA-S5 (T6, C-WA9, WA-D17, brief §26.5) · El paciente decide desde el portal si recibe avisos por WhatsApp.
 *
 * Solo sobre SU ficha de ESE consultorio: `requirePortalPatient(slug)` resuelve por (tenantId, userId) y no hay ningún
 * id de paciente en la entrada, así que no hay forma de apuntar a la ficha de otro. Staff, cuentas sin ficha vinculada
 * y consultorios donde la cuenta no tiene ficha → rechazo sin escribir.
 *
 * Reglas (mismas que el consentimiento del equipo, `lib/whatsapp-consent-actions.ts`):
 *   - GRANTED exige que el teléfono de la ficha sea un celular válido y ancla `waPhoneE164` a esa normalización. El
 *     paciente NO tipea un número acá: cambiar el teléfono es un pedido de «Mis datos» que aprueba el consultorio (el
 *     portal nunca escribe el contacto). Si lo cargado no es un celular, se lo decimos y lo corrige por ese camino.
 *   - Versión del texto = la vigente (`WA_CONSENT_VERSION`), o se rechaza.
 *   - H-1: el portal SÍ revierte un REVOKED (es el paciente autenticado, no un anónimo con un DNI).
 *   - Revocar siempre se puede, aunque el consultorio esté suspendido (es un pedido de privacidad); otorgar exige
 *     `surfacesOpen` (escritura sin Actor en un consultorio que no está operando).
 *   - Canal `prismaService` (sin Actor) con `tenantId` + `patientId` + `userId` a mano; audit `patient.whatsapp_consent`
 *     en la misma tx, con IP y user-agent (el portal no tiene contexto de request) y sin el número.
 *   - La escritura es `writeWaConsentInTx` (`lib/whatsapp/consent-internal.ts`), compartida con el equipo: el guard
 *     «el portal nunca escribe la ficha» (`lib/portal*.ts` sin `patient.update*`) sigue valiendo para este archivo.
 */
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prismaService as prisma } from "@/lib/db";
import { requirePortalPatient } from "@/lib/portal-identity-internal";
import { writeWaConsentInTx } from "@/lib/whatsapp/consent-internal";
import { clientIp } from "@/lib/client-ip";
import { rateLimit, rateLimitedMessage } from "@/lib/rate-limit";
import { normalizeArMobile } from "@/lib/phone-e164";
import { logger } from "@/lib/logger";
import { maskPhone } from "@/lib/whatsapp/crypto";
import { WA_CONSENT_VERSION, type WaConsentStatus } from "@/lib/whatsapp/types";
import type { ActionResult } from "@/lib/validation";

const Slug = z.string().trim().min(1).max(100);
const Input = z
  .object({
    slug: Slug,
    granted: z.boolean(),
    version: z.string().regex(/^[a-z0-9.-]{1,32}$/),
  })
  .strict();

const COPY = {
  noRef: "No encontramos tu ficha en este consultorio. Volvé a Mis consultorios y probá de nuevo.",
  invalid: "Pedido inválido.",
  closed: "Tu consultorio no está recibiendo cambios por acá por ahora. Escribiles directamente.",
  staleVersion: "El texto cambió. Recargá la página y volvé a leerlo.",
  invalidPhone:
    "El teléfono que tiene cargado el consultorio no es un celular. Pedí el cambio desde «Mis datos» y, cuando lo aprueben, volvé a activar los avisos.",
} as const;

export async function setMyWhatsAppConsent(input: {
  slug: string;
  granted: boolean;
  version: string;
}): Promise<ActionResult<{ status: WaConsentStatus }>> {
  const parsed = Input.safeParse(input);
  if (!parsed.success) return { ok: false, error: COPY.invalid };
  const { slug, granted, version } = parsed.data;
  const ref = await requirePortalPatient(slug);
  if (!ref) return { ok: false, error: COPY.noRef };
  if (granted && !ref.surfacesOpen) return { ok: false, error: COPY.closed };
  if (granted && version !== WA_CONSENT_VERSION) return { ok: false, error: COPY.staleVersion };

  // Un switch: 10 por hora alcanzan para arrepentirse varias veces y frenan un loop que llene el audit.
  const rl = await rateLimit(`portal-wa-consent:${ref.userId}:${ref.tenantId}`, { limit: 10, windowMs: 3_600_000 });
  if (!rl.ok) return { ok: false, error: rateLimitedMessage(rl.retryAfterMs) };

  const h = headers();
  const ip = clientIp(h, null);
  const userAgent = h.get("user-agent");
  const r = await prisma.$transaction(async (tx): Promise<ActionResult<{ status: WaConsentStatus }>> => {
    const w = await writeWaConsentInTx(tx, {
      tenantId: ref.tenantId,
      patientId: ref.patientId,
      linkedUserId: ref.userId,
      granted,
      version,
      source: "PORTAL",
      byUserId: null,
      actorId: ref.userId,
      ip,
      userAgent,
    });
    if (!w.ok) return { ok: false, error: w.reason === "invalid_phone" ? COPY.invalidPhone : COPY.noRef };
    return { ok: true, data: { status: w.status } };
  });
  if (r.ok) {
    logger.info("portal.whatsapp_consent", { tenantSlug: ref.tenant.slug, status: r.data.status });
    revalidatePath(`/portal/c/${ref.tenant.slug}`);
  }
  return r;
}

/** Lo que muestra el portal en el switch de WhatsApp. `null` = sin ficha vinculada en ese consultorio. */
export async function getMyWhatsAppConsent(slug: string): Promise<{
  status: WaConsentStatus | null;
  /** El celular de la ficha, enmascarado (el paciente reconoce su número sin que viaje entero). */
  phoneMasked: string | null;
  /** Lo cargado es un celular: se puede activar. */
  phoneValid: boolean;
  /** Consintió con otro número (WA-D17): hay que volver a activarlo. */
  phoneChanged: boolean;
  /** Consintió una versión vieja del texto. */
  versionOutdated: boolean;
  currentVersion: string;
} | null> {
  const s = Slug.safeParse(slug);
  if (!s.success) return null;
  const ref = await requirePortalPatient(s.data);
  if (!ref) return null;
  const p = await prisma.patient.findFirst({
    where: { id: ref.patientId, tenantId: ref.tenantId, userId: ref.userId },
    select: { phone: true, waConsent: true, waPhoneE164: true, waConsentVersion: true },
  });
  if (!p) return null;
  const n = normalizeArMobile(p.phone);
  return {
    status: p.waConsent ?? null,
    phoneMasked: n.ok ? maskPhone(n.e164) : null,
    phoneValid: n.ok,
    phoneChanged: p.waConsent === "GRANTED" && (!n.ok || n.e164 !== p.waPhoneE164),
    versionOutdated: p.waConsent === "GRANTED" && p.waConsentVersion !== WA_CONSENT_VERSION,
    currentVersion: WA_CONSENT_VERSION,
  };
}
