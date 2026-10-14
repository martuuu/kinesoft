/**
 * `sendEmail`: el ÚNICO punto por el que la app manda un mail (IAM-0b, C-IAM1).
 *
 * Principio del bloque IAM (ADR): la app manda todos los mails; Supabase solo
 * emite tokens (`admin.generateLink`). Quien llama arma el contenido con
 * `templates.ts` y pasa el resultado acá; este módulo:
 *  1. decide el transporte (`transport.ts`, por entorno; bloquea en Production
 *     cualquier mail con links a localhost),
 *  2. valida el destinatario (UNA dirección: nada de listas ni saltos),
 *  3. arma el remitente «Consultorio X vía KineSoft <EMAIL_FROM>» y el Reply-To,
 *  4. despacha (Resend, Mailpit o nada),
 *  5. le pasa el resultado al sink registrado (EmailLog, IAM-1) con el host
 *     del primer link — nunca el link, que lleva el token,
 *  6. loguea `email.sent|skipped|failed|blocked` con el destinatario
 *     enmascarado (`j***@dominio`) y sin el link.
 *
 * **Nunca tira.** Un mail que no sale no puede romper la action que lo dispara
 * (la invitación ya está creada, el token ya se emitió): el llamador mira
 * `ok`/`skipped` y decide qué decirle al usuario.
 *
 * El env se lee de `process.env` en CADA envío (no de `lib/env`, que se congela
 * al importar): los tests cambian el entorno con `vi.stubEnv` y el despacho real
 * se prueba con un `fetch` fake.
 */
import "server-only";
import { logger } from "@/lib/logger";
import type { SendEmailInput, SendEmailResult } from "@/lib/email/types";
import {
  composeFrom,
  decideEmailTransport,
  firstLinkHost,
  isProductionEnv,
  maskEmail,
  normalizeEmailAddress,
  resolveBaseFrom,
  DEFAULT_EMAIL_FROM,
  type EmailNotSentReason,
} from "@/lib/email/transport";
import { sendViaResend } from "@/lib/email/resend";
import { mailpitBaseUrl, sendViaMailpit } from "@/lib/email/mailpit";

export type { SendEmailInput, SendEmailResult, EmailKind, EmailTransportName, RenderedEmail } from "@/lib/email/types";

/**
 * Quien registra el envío (IAM-1 lo conecta a la tabla EmailLog). Se llama
 * SIEMPRE, también cuando el mail no salió: "no salió porque Production no
 * tiene key" es justo lo que la UI del equipo (IAM-4c) tiene que poder mostrar.
 */
export type EmailSink = (input: SendEmailInput, result: SendEmailResult, linkHost: string | null) => Promise<void>;

type TestTransport = (i: SendEmailInput) => Promise<SendEmailResult>;

let sink: EmailSink | null = null;
let testTransport: TestTransport | null = null;

export function registerEmailSink(s: EmailSink | null): void {
  sink = s;
}

/**
 * Tests (unit e integración de IAM-2): reemplaza SOLO el despacho. La validación
 * del destinatario, el bloqueo de Production, el sink y el log siguen corriendo,
 * así un test que usa esto ejercita el mismo camino que prod hasta la red.
 */
export function __setEmailTransportForTests(t: TestTransport | null): void {
  testTransport = t;
}

function fail(
  transport: SendEmailResult["transport"],
  reason: EmailNotSentReason,
  extra: { skipped?: boolean; status?: number } = {}
): SendEmailResult {
  return {
    ok: false,
    transport,
    skipped: extra.skipped ?? false,
    reason,
    ...(extra.status !== undefined ? { status: extra.status } : {}),
  };
}

async function dispatch(input: SendEmailInput, to: string): Promise<SendEmailResult> {
  const env = process.env;
  const route = decideEmailTransport(env, input);

  if (route.transport === "blocked") return fail("blocked", route.reason ?? "unsafe_link_host");
  if (testTransport) return testTransport({ ...input, to });
  if (route.transport === "log") return fail("log", route.reason ?? "log_only", { skipped: true });

  const baseFrom = resolveBaseFrom(env) ?? DEFAULT_EMAIL_FROM;
  const from = composeFrom(baseFrom, input.fromName);
  const replyTo = normalizeEmailAddress(input.replyTo) ?? normalizeEmailAddress(env.EMAIL_REPLY_TO);
  const msg = { from, to, replyTo, subject: input.subject, html: input.html, text: input.text };

  if (route.transport === "mailpit") {
    const r = await sendViaMailpit(msg, { baseUrl: mailpitBaseUrl(env) });
    if (r.ok) return { ok: true, transport: "mailpit", providerId: r.id };
    // Mailpit caído: el mail queda como `log` (no salió, y no es un error de la app).
    if (r.reason === "mailpit_unreachable") return fail("log", "mailpit_unreachable", { skipped: true });
    return fail("mailpit", "provider_error", { status: r.status });
  }

  const r = await sendViaResend(msg, { apiKey: env.RESEND_API_KEY ?? "" });
  if (r.ok) return { ok: true, transport: "resend", providerId: r.id };
  if (r.reason === "no_api_key") return fail("log", "no_api_key", { skipped: true });
  if (!("status" in r)) return fail("resend", r.reason);
  return fail("resend", r.reason, { status: r.status });
}

function logResult(input: SendEmailInput, to: string, result: SendEmailResult, linkHost: string | null): void {
  // Ni el link ni el destinatario completo: los logs de Vercel los lee cualquiera
  // con acceso al proyecto y el link es una credencial. `linkHost` sí (solo el host).
  const ctx = {
    kind: input.kind,
    transport: result.transport,
    toMasked: maskEmail(to),
    linkHost,
    tenantId: input.tenantId ?? undefined,
    entity: input.entity ?? undefined,
    entityId: input.entityId ?? undefined,
    actorId: input.actorId ?? undefined,
  };
  if (result.ok) {
    logger.info("email.sent", { ...ctx, providerId: result.providerId });
  } else if (result.transport === "blocked") {
    logger.error("email.blocked", { ...ctx, reason: result.reason });
  } else if (result.skipped) {
    // En Production un skip es config faltante: nadie recibe sus mails.
    const lvl = isProductionEnv(process.env) ? "warn" : "info";
    logger[lvl]("email.skipped", { ...ctx, reason: result.reason });
  } else {
    const lvl = result.reason === "internal_error" ? "error" : "warn";
    logger[lvl]("email.failed", { ...ctx, reason: result.reason, status: result.status });
  }
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  let result: SendEmailResult;
  let linkHost: string | null = null;
  const to = normalizeEmailAddress(input.to);
  const normalized: SendEmailInput = to ? { ...input, to } : input;

  try {
    linkHost = firstLinkHost(input.html ?? "");
    if (!to) {
      result = fail(decideEmailTransport(process.env, input).transport, "invalid_to");
    } else {
      result = await dispatch(input, to);
    }
  } catch {
    // Solo puede venir de un transporte de test o de un bug nuestro: los
    // transportes reales no tiran. El mensaje del error no se loguea (podría
    // traer el destinatario); el `reason` alcanza para buscarlo.
    result = fail("log", "internal_error");
  }

  try {
    logResult(normalized, to ?? input.to ?? "", result, linkHost);
  } catch {
    // Loguear nunca rompe el envío.
  }

  if (sink) {
    try {
      await sink(normalized, result, linkHost);
    } catch (err) {
      try {
        logger.warn("email.sink_failed", {
          kind: input.kind,
          entity: input.entity ?? undefined,
          entityId: input.entityId ?? undefined,
          error: err instanceof Error ? err.name : "unknown",
        });
      } catch {
        // idem
      }
    }
  }
  return result;
}
