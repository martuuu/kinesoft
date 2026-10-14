"use server";

/**
 * IAM-3c · ingreso al portal del paciente con un link por email (además de Google; IAM-D5, plan §19.4).
 *
 * Por qué: el portal solo tenía «Ingresar con Google» y mucha gente no tiene (o no quiere usar) una cuenta
 * de Google. El link sale como en el resto del bloque IAM (ADR: la app manda los mails; Supabase solo emite
 * tokens): `admin.generateLink(magiclink)` vía `issueAccessLink` + mail propio `portal_magic_link` con link a
 * NUESTRO `/auth/confirm` (resistente a escáneres: GET no canjea, ver `app/auth/confirm/route.ts`).
 *
 * Sin oráculo: la respuesta es SIEMPRE la misma (`PORTAL_LINK_SENT`), haya ficha o no, sea staff o no, falle
 * GoTrue o el mail. Los únicos errores visibles son el formato del email y el rate limit, que aplican igual
 * exista o no la ficha. Quién recibe el link y por qué (sin cuenta → GoTrue la crea [S4]) está en
 * `lib/portal-auth-internal.ts`.
 *
 * El vínculo `Patient.userId` NO se hace acá (el pedido es anónimo: nadie probó todavía ser dueño del
 * email): lo hace el inicio de sesión con el email ya verificado (`linkPortalPatientsOnSignIn`, AUDIT §5.8).
 */
import { headers } from "next/headers";
import { z } from "zod";
import { hashKeyPart, rateLimitAll, rateLimitedMessage } from "@/lib/rate-limit";
import { clientIp } from "@/lib/client-ip";
import { issueAccessLink } from "@/lib/identity/access-link";
import { sendEmail } from "@/lib/email";
// Registra el sink de EmailLog (cada emisor de mails lo importa: ver lib/email/log.ts).
import "@/lib/email/log";
import { portalMagicLinkEmail } from "@/lib/email/templates";
import { resolvePortalLinkTarget } from "@/lib/portal-auth-internal";
import { logger } from "@/lib/logger";
import type { ActionResult } from "@/lib/validation";

/** Mismo texto en todos los casos (sin oráculo). «1 hora» = `SUPABASE_LINK_TTL_COPY` de las plantillas. */
const PORTAL_LINK_SENT = "Si tu email está registrado en un consultorio, te mandamos un link para entrar. Vence en 1 hora.";

const PortalLinkInput = z.object({
  email: z.string().trim().toLowerCase().email("Ingresá un email válido.").max(120),
  // El slug solo elige el destino y el remitente; uno inválido se ignora (no es un error del paciente).
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]{1,64}$/)
    .optional()
    .catch(undefined),
});

export async function requestPortalLink(formData: FormData): Promise<ActionResult<{ message: string }>> {
  const rawSlug = formData.get("slug");
  const parsed = PortalLinkInput.safeParse({
    email: String(formData.get("email") ?? ""),
    slug: typeof rawSlug === "string" && rawSlug.trim() ? rawSlug : undefined,
  });
  if (!parsed.success) {
    return { ok: false, error: "Ingresá un email válido.", fieldErrors: parsed.error.flatten().fieldErrors };
  }
  const { email } = parsed.data;
  const slug = parsed.data.slug ?? null;

  // Por IP (5 cada 10 min) y por hash del email (3 por hora): rotando IPs no se bombardea un buzón, y el
  // límite aplica exista o no la ficha (no filtra nada). Mismo criterio que forgot/signup (IAM-2c).
  const limited = await rateLimitAll([
    { key: `portal-link:ip:${clientIp(headers())}`, limit: 5, windowMs: 600_000 },
    { key: `portal-link:email:${hashKeyPart(email)}`, limit: 3, windowMs: 3_600_000 },
  ]);
  if (!limited.ok) return { ok: false, error: rateLimitedMessage(limited.retryAfterMs) };

  const done = { ok: true as const, data: { message: PORTAL_LINK_SENT } };

  let target: Awaited<ReturnType<typeof resolvePortalLinkTarget>>;
  try {
    target = await resolvePortalLinkTarget(email, slug);
  } catch (err) {
    // Una falla de la base no puede cambiar la respuesta (sería un oráculo por timing de errores).
    logger.error("portal.link_request.lookup_failed", { error: err instanceof Error ? err.name : "unknown" });
    return done;
  }
  if (target.kind === "skip") {
    logger.info("portal.link_request.skipped", { reason: target.reason });
    return done;
  }

  const link = await issueAccessLink({ email, kind: "magiclink", next: target.next });
  if (!link.ok) {
    logger.warn("portal.link_request.link_failed", { code: link.code });
    return done;
  }
  const r = await sendEmail({
    ...portalMagicLinkEmail({ tenantName: target.tenant?.name ?? null, url: link.url }),
    kind: "portal_magic_link",
    to: email,
    tenantId: target.tenant?.id ?? null,
    entity: target.patientId ? "Patient" : null,
    entityId: target.patientId,
    fromName: target.tenant?.name ?? null,
    replyTo: target.tenant?.publicEmail || null,
  });
  if (!r.ok) logger.warn("portal.link_request.email_not_sent", { transport: r.transport, reason: r.reason });
  return done;
}
