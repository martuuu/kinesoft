"use server";

/**
 * Formulario de contacto de la web pública → bandeja de /plataforma como LEAD (PL-2d, contrato C-PL11, §20.5.7).
 *
 * Decisión de Martin (literal): «… además linkea el formulario de contacto de la homepage para que también me lleguen
 * los mensajes al soporte como "leads"». PL-D15: SIN respuesta automática al lead (Martin responde desde /plataforma).
 *
 * PÚBLICO: sin sesión ni Actor. Por eso escribe por el canal service (`prismaService`, como el turnero público), y por
 * eso las defensas son las de una superficie anónima:
 *  - honeypot `website` (campo escondido) lleno, o enviado en < 3 s desde que se mostró → OK SIN fila ni mail (al bot
 *    no se le dice que lo detectamos);
 *  - rate limit: 5/h por IP, 3/día por email (las dos claves con hash, nunca el dato crudo en Redis) y un corte global
 *    de 200/día, porque cada lead le manda un mail a Martin. Además del limitador (en memoria por isolate si no hay
 *    Upstash) se cuenta en la base el tope por email y el global: la base es la misma para todos los isolates y el
 *    índice (leadEmail, createdAt) de M8 existe para esto;
 *  - zod con largos máximos (espejo de los CHECK de M8) y `.strict()`.
 *
 * Contrato para la landing (C-PL2, la consume VX): `submitLead(input)` para llamarla desde JS, y `submitLeadForm(prev,
 * formData)` con la forma de `useFormState` para que el formulario funcione también SIN JS (progressive enhancement).
 */
import { headers } from "next/headers";
import { z } from "zod";
import type { SaasPlan } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { clientIp } from "@/lib/client-ip";
import { hashKeyPart, rateLimitAll, rateLimitedMessage } from "@/lib/rate-limit";
import { env, platformInboxEmail } from "@/lib/env";
import { sendEmail } from "@/lib/email";
import "@/lib/email/log";
import { leadReceivedEmail } from "@/lib/email/templates-support";
import { SAAS_PLAN_LABEL } from "@/lib/tenant-modules";
import { logger } from "@/lib/logger";
import type { ActionResult } from "@/lib/validation";
import {
  LEAD_CLINIC_MAX,
  LEAD_EMAIL_LIMIT,
  LEAD_EMAIL_MAX,
  LEAD_GLOBAL_LIMIT,
  LEAD_GLOBAL_LIMIT_COPY,
  LEAD_IP_LIMIT,
  LEAD_NAME_MAX,
  LEAD_PHONE_MAX,
  SUPPORT_BODY_MAX,
  SUPPORT_SUBJECT_MAX,
  LEAD_EMAIL_CAP_COPY,
  leadBotVerdict,
  type SubmitLeadInput,
} from "@/lib/support-threads-types";

const PLANS = ["INDIVIDUAL", "CONSULTORIO", "CLINICA", "LIBRE"] as const satisfies readonly SaasPlan[];

/** "" → undefined: el formulario manda campos vacíos para los opcionales. */
const blankToUndef = (v: unknown) => (v == null || (typeof v === "string" && v.trim() === "") ? undefined : v);

const LeadInput = z
  .object({
    name: z.string().trim().min(1, "Decinos tu nombre.").max(LEAD_NAME_MAX, `Hasta ${LEAD_NAME_MAX} caracteres.`),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .min(3, "Revisá el email.")
      .max(LEAD_EMAIL_MAX, "Revisá el email.")
      .email("Revisá el email."),
    phone: z.preprocess(blankToUndef, z.string().trim().max(LEAD_PHONE_MAX, `Hasta ${LEAD_PHONE_MAX} caracteres.`).optional()),
    clinicName: z.preprocess(blankToUndef, z.string().trim().max(LEAD_CLINIC_MAX, `Hasta ${LEAD_CLINIC_MAX} caracteres.`).optional()),
    planInterest: z.preprocess(blankToUndef, z.enum(PLANS).optional()),
    message: z.string().trim().min(1, "Contanos qué necesitás.").max(SUPPORT_BODY_MAX, `Hasta ${SUPPORT_BODY_MAX} caracteres.`),
    // Honeypot: se valida aparte (lleno = bot). Tope para no procesar basura enorme.
    website: z.preprocess((v) => (v == null ? "" : v), z.string().max(500)),
    // ms epoch de cuando se mostró el formulario (lo pone la landing en un hidden).
    // Basura → undefined (no cuenta como bot, ver `leadBotVerdict`); nunca un error de campo que el humano no ve.
    startedAt: z.preprocess((v) => {
      const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
      return typeof n === "number" && Number.isFinite(n) ? n : undefined;
    }, z.number().optional()),
  })
  .strict();

const RECEIVED = { ok: true as const, data: { received: true as const } };

function subjectFor(name: string, clinicName: string | undefined): string {
  const base = `Consulta de ${name}${clinicName ? ` · ${clinicName}` : ""}`;
  return base.length <= SUPPORT_SUBJECT_MAX ? base : `${base.slice(0, SUPPORT_SUBJECT_MAX - 1).trimEnd()}…`;
}

function callerIp(): string {
  try {
    return clientIp(headers());
  } catch {
    // Fuera de un request (no debería pasar en una server action): un solo bucket, que limita igual.
    return "unknown";
  }
}

export async function submitLead(input: SubmitLeadInput): Promise<ActionResult<{ received: true }>> {
  const parsed = LeadInput.safeParse(input ?? {});
  if (!parsed.success) {
    const fieldErrors = parsed.error.flatten().fieldErrors as Record<string, string[]>;
    // Un honeypot gigante o un campo de más: es un bot armando el POST, no un humano. OK sin fila.
    if (fieldErrors.website || parsed.error.issues.some((i) => i.code === "unrecognized_keys")) return RECEIVED;
    const first = Object.values(fieldErrors).flat()[0];
    return { ok: false, error: first ?? "Revisá los datos.", fieldErrors };
  }
  const d = parsed.data;
  if (leadBotVerdict({ website: d.website, startedAt: d.startedAt, now: Date.now() }) === "bot") {
    logger.info("lead.bot_dropped", {});
    return RECEIVED;
  }

  const emailHash = hashKeyPart(d.email);
  // PL-Z a4#1: sin `lead:global` en el limitador. `rateLimitAll` consume todos los buckets aunque uno corte, así que
  // una sola IP bloqueada seguía sumando al global y en minutos dejaba la landing sin leads por 24 h para todos. El
  // tope global lo da el conteo de filas en la base (abajo), que solo cuenta leads que de verdad se guardaron.
  const rl = await rateLimitAll([
    { key: `lead:ip:${hashKeyPart(callerIp())}`, ...LEAD_IP_LIMIT },
    { key: `lead:email:${emailHash}`, ...LEAD_EMAIL_LIMIT },
  ]);
  if (!rl.ok) return { ok: false, error: rateLimitedMessage(rl.retryAfterMs) };

  // Respaldo en la base (compartida entre isolates): 3 por email y 200 en total en las últimas 24 h.
  const since = new Date(Date.now() - LEAD_GLOBAL_LIMIT.windowMs);
  const [byEmail, total] = await Promise.all([
    prismaService.supportThread.count({ where: { kind: "LEAD", leadEmail: d.email, createdAt: { gte: since } } }),
    prismaService.supportThread.count({ where: { kind: "LEAD", createdAt: { gte: since } } }),
  ]);
  if (total >= LEAD_GLOBAL_LIMIT.limit) {
    logger.warn("lead.global_cap", { total });
    return { ok: false, error: LEAD_GLOBAL_LIMIT_COPY };
  }
  if (byEmail >= LEAD_EMAIL_LIMIT.limit) return { ok: false, error: LEAD_EMAIL_CAP_COPY };

  const subject = subjectFor(d.name, d.clinicName);
  const thread = await prismaService.$transaction(async (tx) => {
    const t = await tx.supportThread.create({
      data: {
        kind: "LEAD",
        tenantId: null,
        subject,
        status: "OPEN",
        leadName: d.name,
        leadEmail: d.email,
        leadPhone: d.phone ?? null,
        leadClinicName: d.clinicName ?? null,
        leadPlanInterest: d.planInterest ?? null,
      },
      select: { id: true },
    });
    await tx.supportMessage.create({
      data: { threadId: t.id, tenantId: null, authorKind: "LEAD", authorUserId: null, body: d.message },
    });
    return t;
  });

  const to = platformInboxEmail();
  if (to) {
    await sendEmail({
      kind: "lead_received",
      to,
      tenantId: null,
      entity: "SupportThread",
      entityId: thread.id,
      ...leadReceivedEmail({
        name: d.name,
        email: d.email,
        phone: d.phone ?? null,
        clinicName: d.clinicName ?? null,
        planLabel: d.planInterest ? SAAS_PLAN_LABEL[d.planInterest] : null,
        message: d.message,
        url: `${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}/plataforma/mensajes/${encodeURIComponent(thread.id)}`,
      }),
    });
  } else {
    logger.info("lead.notify_skipped", { reason: "no_inbox_email", threadId: thread.id });
  }
  return RECEIVED;
}

/**
 * Variante para `useFormState(submitLeadForm, null)` (C-PL2): lee el `FormData` del formulario (nombres de campo =
 * claves de `submitLead`) y devuelve el mismo `ActionResult`. Sin JS, el form postea igual y la página re-renderiza
 * con el estado.
 */
export async function submitLeadForm(
  _prev: ActionResult<{ received: true }> | null,
  formData: FormData
): Promise<ActionResult<{ received: true }>> {
  const str = (k: string) => {
    const v = formData.get(k);
    return typeof v === "string" ? v : undefined;
  };
  return submitLead({
    name: str("name") ?? "",
    email: str("email") ?? "",
    phone: str("phone"),
    clinicName: str("clinicName"),
    planInterest: str("planInterest"),
    message: str("message") ?? "",
    website: str("website") ?? "",
    startedAt: str("startedAt"),
  });
}
