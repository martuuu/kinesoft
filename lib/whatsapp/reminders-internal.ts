import "server-only";
import { prismaService } from "@/lib/db";
import { logger } from "@/lib/logger";
import { whatsappMode } from "@/lib/env";
import { phoneHash, maskPhone } from "@/lib/whatsapp/crypto";
import { getPhone, listTemplates, GRAPH_TIMEOUT_MS } from "@/lib/whatsapp/graph";
import { eligibility, idemKey, tomorrowWindowAR, WA_MIN_LEAD_MS } from "@/lib/whatsapp/logic";
import { TEMPLATE_SPECS } from "@/lib/whatsapp/templates";
import type { WaConsentStatus, WaMode, WaTemplateKey, WaTemplateStatus } from "@/lib/whatsapp/types";
import { loadCredential, markAccountProblem } from "@/lib/whatsapp/account-internal";
import {
  drainAll,
  enqueue,
  expireOverdue,
  type DrainResult,
  type WaDocumentPreparer,
  type WaEnqueueRow,
} from "@/lib/whatsapp/outbox-internal";

/**
 * WA-S4 (T6, C-WA9, WA-D19, brief §26.5) · El cron de WhatsApp de las 18:00 AR (`app/api/cron/whatsapp`, `0 21 * * *`).
 *
 * Por qué un cron propio y no una etapa más de `runDaily` (08:00 AR): el recordatorio sirve la tarde ANTERIOR al turno
 * (el paciente lo ve a la hora en que organiza el día siguiente y todavía hay tiempo de reasignar el hueco si contesta
 * «No puedo ir»), y el diario ya gasta su presupuesto de 45 s en los cobros de MPS: compartirlo haría que un día de
 * muchos cargos deje sin recordatorios a los pacientes, o al revés.
 *
 * Etapas, en orden, cada una en su try (una que falla no frena a las demás; todo es idempotente y mañana se reintenta):
 *   1. **Recordatorios** de los turnos de MAÑANA en AR (`tomorrowWindowAR`) para las cuentas ACTIVE en el modo vigente,
 *      con `autoReminder` y la plantilla del recordatorio APPROVED. ≤ 2000 turnos por consultorio. Filtra con la misma
 *      `eligibility` que la cola (la cola la RE-chequea al despachar) y encola `br:<id>:<epoch>` con
 *      `expiresAt` = horario − 60′ (WA-D4). Re-correr no duplica: la clave es UNIQUE y `enqueue` es ON CONFLICT DO
 *      NOTHING; si el turno se movió, la clave nueva lleva el horario nuevo y la vieja queda `rescheduled` en la cola.
 *      Sin la plantilla APPROVED no se encola: una fila encolada así quedaría SKIPPED (`template_pending`) con su clave
 *      tomada y, si Meta la aprueba a la noche, el recordatorio de mañana ya no saldría en la re-corrida.
 *   2. **Drain** de la cola de todas las cuentas (`drainAll`, ronda con concurrencia 4): los recordatorios recién
 *      encolados y lo que haya quedado de los avisos del hook o de reintentos.
 *   3. **Vencidos** → EXPIRED (`expireOverdue`).
 *   4. **Sync con Graph** (fuera de toda tx): plantillas PENDING hace más de 1 h (el webhook de aprobación se pudo
 *      perder) y la calidad/límite del número de cada cuenta ACTIVE (el aviso de calidad también llega por webhook; esto
 *      es la red). Un error de auth/pago/cuenta marca la cuenta (`markAccountProblem`).
 *
 * Con `WHATSAPP_MODE=off` devuelve `skipped: "off"` sin UNA sentencia. Nunca tira. Corta por presupuesto (reloj REAL
 * de la función, no `now`: el presupuesto es de la ejecución de la lambda) y lo informa con `truncated`. No lee PHI:
 * el texto del mensaje lo arma la cola (WA-D16) y los logs llevan solo ids y conteos.
 */

/** Techo de recordatorios por consultorio y corrida (C-WA9). Con más, el resto no sale: se loguea `capped`. */
export const WA_REMINDERS_PER_TENANT = 2000;
/** Plantillas PENDING «viejas» (C-WA9): Meta suele resolver en minutos; pasada 1 h se pregunta. */
export const WA_TEMPLATE_STALE_MS = 60 * 60_000;
const DRAIN_CONCURRENCY = 4;
/** Lo que se reserva del presupuesto para vencer y sincronizar después del drain. */
const TAIL_RESERVE_MS = 6_000;
/** Debajo de esto no se empieza otra unidad de trabajo (un consultorio, una cuenta a sincronizar). */
const MIN_STEP_MS = 500;
const ENQUEUE_CHUNK = 500;
const ACCOUNT_SCAN_LIMIT = 500;
const SYNC_TIMEOUT_MS = 5_000;

export type WaReminderStage = {
  accounts: number;
  scanned: number;
  eligible: number;
  enqueued: number;
  alreadyQueued: number;
  ineligible: number;
  /** Consultorios que llegaron al techo de 2000. */
  capped: number;
  errors: number;
  truncated: boolean;
};

export type WaSyncStage = {
  accounts: number;
  templatesUpdated: number;
  qualityUpdated: number;
  errors: number;
  truncated: boolean;
};

export type WhatsAppCronResult = {
  mode: WaMode;
  skipped?: "off";
  window: { dateKey: string } | null;
  reminders: WaReminderStage;
  drain: (DrainResult & { accounts: number }) | null;
  expired: number;
  sync: WaSyncStage;
  errors: number;
  truncated: boolean;
};

const emptyReminders = (): WaReminderStage => ({
  accounts: 0,
  scanned: 0,
  eligible: 0,
  enqueued: 0,
  alreadyQueued: 0,
  ineligible: 0,
  capped: 0,
  errors: 0,
  truncated: false,
});
const emptySync = (): WaSyncStage => ({ accounts: 0, templatesUpdated: 0, qualityUpdated: 0, errors: 0, truncated: false });

function errName(err: unknown): string {
  return err instanceof Error ? err.name : "unknown";
}

const REMINDER_KEY: WaTemplateKey = "BOOKING_REMINDER";

export type RunWhatsAppCronDeps = {
  /** WA-S6: sin preparador, los DOCUMENT_SHARED no se drenan (esperan al envío inline o vencen). */
  prepareDocument?: WaDocumentPreparer;
};

export async function runWhatsAppCron(now: Date, budgetMs = 45_000, deps: RunWhatsAppCronDeps = {}): Promise<WhatsAppCronResult> {
  const out: WhatsAppCronResult = {
    mode: "off",
    window: null,
    reminders: emptyReminders(),
    drain: null,
    expired: 0,
    sync: emptySync(),
    errors: 0,
    truncated: false,
  };
  try {
    const mode = whatsappMode();
    out.mode = mode;
    // C-WA1: con el canal apagado, ni una sentencia (el test las cuenta).
    if (mode === "off") return { ...out, skipped: "off" };
    const deadline = Date.now() + Math.max(0, budgetMs);
    const left = () => deadline - Date.now();

    // 1. Recordatorios de mañana.
    const win = tomorrowWindowAR(now);
    out.window = { dateKey: win.dateKey };
    try {
      await enqueueReminders(now, mode, win, deadline, out.reminders);
    } catch (err) {
      out.reminders.errors += 1;
      logger.error("whatsapp.cron.reminders_failed", { error: errName(err) });
    }

    // 2. Drain (deja la reserva para vencer y sincronizar: hasta 6 s, o el 20 % de un presupuesto chico).
    const drainBudget = left() - Math.min(TAIL_RESERVE_MS, budgetMs * 0.2);
    if (drainBudget >= MIN_STEP_MS) {
      try {
        out.drain = await drainAll(drainBudget, { concurrency: DRAIN_CONCURRENCY, prepareDocument: deps.prepareDocument });
      } catch (err) {
        out.errors += 1;
        logger.error("whatsapp.cron.drain_failed", { error: errName(err) });
      }
    } else {
      out.truncated = true;
    }

    // 3. Vencidos.
    if (left() >= MIN_STEP_MS) {
      try {
        out.expired = await expireOverdue(now);
      } catch (err) {
        out.errors += 1;
        logger.error("whatsapp.cron.expire_failed", { error: errName(err) });
      }
    } else {
      out.truncated = true;
    }

    // 4. Sync con Graph.
    try {
      await syncAccounts(now, mode, deadline, out.sync);
    } catch (err) {
      out.sync.errors += 1;
      logger.error("whatsapp.cron.sync_failed", { error: errName(err) });
    }

    out.truncated = out.truncated || out.reminders.truncated || out.sync.truncated;
    out.errors += out.reminders.errors + out.sync.errors;
    return out;
  } catch (err) {
    // Nunca tira: la ruta respondería 500 y Vercel lo reintentaría igual (todo es idempotente), pero el contrato es
    // devolver contadores.
    out.errors += 1;
    logger.error("whatsapp.cron.failed", { error: errName(err) });
    return out;
  }
}

// ── 1. Recordatorios ───────────────────────────────────────────────────────────────────────────────────────────

type ReminderAccount = { id: string; tenantId: string };

type ReminderRow = {
  id: string;
  status: string;
  patientId: string | null;
  scheduledFor: Date;
  phone: string | null;
  waConsent: WaConsentStatus | null;
  waPhoneE164: string | null;
};

async function enqueueReminders(
  now: Date,
  mode: Exclude<WaMode, "off">,
  win: { from: Date; to: Date },
  deadline: number,
  r: WaReminderStage
): Promise<void> {
  if (deadline - Date.now() < MIN_STEP_MS) {
    r.truncated = true;
    return;
  }
  // Consultorio ACTIVE (un suspendido o dado de baja no le escribe a nadie), cuenta ACTIVE en el modo vigente con el
  // recordatorio prendido y la plantilla APPROVED. Orden estable por id: si un día corta, al menos es determinista.
  const accounts = await prismaService.$queryRaw<ReminderAccount[]>`
    SELECT a."id", a."tenantId" FROM "WhatsAppAccount" a
      JOIN "Tenant" t ON t."id" = a."tenantId"
      JOIN "WhatsAppTemplate" tp ON tp."accountId" = a."id" AND tp."tenantId" = a."tenantId"
                                AND tp."key"::text = ${REMINDER_KEY} AND tp."status" = 'APPROVED'
     WHERE a."status" = 'ACTIVE' AND a."mode" = ${mode} AND a."autoReminder" = true AND t."status" = 'ACTIVE'
     ORDER BY a."id" ASC
     LIMIT ${ACCOUNT_SCAN_LIMIT}`;
  r.accounts = accounts.length;
  const templateName = TEMPLATE_SPECS[REMINDER_KEY].name;

  for (const acc of accounts) {
    if (deadline - Date.now() < MIN_STEP_MS) {
      r.truncated = true;
      return;
    }
    try {
      // Una sentencia por consultorio: turnos CONFIRMED de mañana con el paciente y su consentimiento. El filtro de
      // consentimiento en SQL es solo para no traer filas de más; la decisión es de `eligibility`.
      const rows = await prismaService.$queryRaw<ReminderRow[]>`
        SELECT b."id", b."status"::text AS "status", b."patientId", b."scheduledFor",
               p."phone", p."waConsent"::text AS "waConsent", p."waPhoneE164"
          FROM "Booking" b
          JOIN "Patient" p ON p."id" = b."patientId" AND p."tenantId" = b."tenantId"
         WHERE b."tenantId" = ${acc.tenantId}
           AND b."status" = 'CONFIRMED'
           AND b."scheduledFor" >= ${win.from} AND b."scheduledFor" < ${win.to}
           AND p."waConsent" = 'GRANTED' AND p."waPhoneE164" IS NOT NULL
         ORDER BY b."scheduledFor" ASC, b."id" ASC
         LIMIT ${WA_REMINDERS_PER_TENANT}`;
      r.scanned += rows.length;
      if (rows.length >= WA_REMINDERS_PER_TENANT) {
        r.capped += 1;
        logger.warn("whatsapp.cron.reminders_capped", { tenantId: acc.tenantId, limit: WA_REMINDERS_PER_TENANT });
      }

      // Hash y máscara fuera de toda tx: `phoneHash` tira en Vercel sin service key (falla cerrada). Si tira, el
      // consultorio entero queda para la re-corrida (se cuenta en `errors`): mejor sin recordatorio que con un hash malo.
      const toQueue: WaEnqueueRow[] = [];
      for (const b of rows) {
        const e = eligibility(
          {
            status: b.status,
            patientId: b.patientId,
            scheduledFor: b.scheduledFor,
            patient: b.patientId ? { phone: b.phone, waConsent: b.waConsent, waPhoneE164: b.waPhoneE164 } : null,
          },
          now
        );
        if (!e.ok) {
          r.ineligible += 1;
          continue;
        }
        toQueue.push({
          tenantId: acc.tenantId,
          accountId: acc.id,
          kind: "BOOKING_REMINDER",
          trigger: "CRON",
          idempotencyKey: idemKey({ t: "br", bookingId: b.id, scheduledFor: b.scheduledFor }),
          patientId: b.patientId,
          bookingId: b.id,
          bookingScheduledFor: b.scheduledFor,
          templateName,
          toHash: phoneHash(e.e164),
          toMasked: maskPhone(e.e164),
          // WA-D4: a menos de 60′ del turno el recordatorio ya no sirve; la cola lo vence.
          expiresAt: new Date(b.scheduledFor.getTime() - WA_MIN_LEAD_MS),
        });
      }
      r.eligible += toQueue.length;
      for (let i = 0; i < toQueue.length; i += ENQUEUE_CHUNK) {
        const chunk = toQueue.slice(i, i + ENQUEUE_CHUNK);
        const created = await enqueue(chunk);
        r.enqueued += created.length;
        r.alreadyQueued += chunk.length - created.length;
      }
    } catch (err) {
      r.errors += 1;
      logger.warn("whatsapp.cron.reminders_tenant_failed", { tenantId: acc.tenantId, error: errName(err) });
    }
  }
}

// ── 4. Sync de plantillas y calidad ────────────────────────────────────────────────────────────────────────────

/**
 * Estado de Meta → el enum de M15. COPIA de `templateStatusOf` de `lib/whatsapp/account-internal.ts` (privada allá;
 * handoff a INT para exportarla y usar una sola). Lo desconocido (IN_APPEAL, PENDING_DELETION…) queda «en revisión».
 */
function templateStatusOf(s: string | null | undefined): WaTemplateStatus {
  switch ((s ?? "").toUpperCase()) {
    case "APPROVED":
      return "APPROVED";
    case "REJECTED":
      return "REJECTED";
    case "PAUSED":
      return "PAUSED";
    case "DISABLED":
    case "DELETED":
    case "LIMIT_EXCEEDED":
      return "DISABLED";
    default:
      return "PENDING";
  }
}

type SyncAccount = {
  id: string;
  tenantId: string;
  wabaId: string;
  phoneNumberId: string;
  qualityRating: string | null;
  messagingLimit: string | null;
};

async function syncAccounts(now: Date, mode: Exclude<WaMode, "off">, deadline: number, s: WaSyncStage): Promise<void> {
  if (deadline - Date.now() < MIN_STEP_MS) {
    s.truncated = true;
    return;
  }
  const accounts = await prismaService.whatsAppAccount.findMany({
    where: { status: "ACTIVE", mode },
    select: { id: true, tenantId: true, wabaId: true, phoneNumberId: true, qualityRating: true, messagingLimit: true },
    // El que hace más que no se toca primero: si un día corta por presupuesto, mañana empieza por los que faltaron.
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: ACCOUNT_SCAN_LIMIT,
  });
  const staleBefore = new Date(now.getTime() - WA_TEMPLATE_STALE_MS);
  for (const a of accounts) {
    const left = deadline - Date.now();
    if (left < MIN_STEP_MS) {
      s.truncated = true;
      return;
    }
    s.accounts += 1;
    try {
      await syncAccount(a, staleBefore, Math.min(SYNC_TIMEOUT_MS, GRAPH_TIMEOUT_MS, left), s);
    } catch (err) {
      s.errors += 1;
      logger.warn("whatsapp.cron.sync_account_failed", { tenantId: a.tenantId, accountId: a.id, error: errName(err) });
    }
  }
}

async function syncAccount(a: SyncAccount, staleBefore: Date, timeoutMs: number, s: WaSyncStage): Promise<void> {
  const cred = await loadCredential(a.id, a.tenantId);
  if (!cred) return;

  // Plantillas PENDING enviadas hace más de 1 h (`statusAt` = la última vez que supimos de ella).
  const pending = await prismaService.whatsAppTemplate.findMany({
    where: { tenantId: a.tenantId, accountId: a.id, status: "PENDING", OR: [{ statusAt: { lt: staleBefore } }, { statusAt: null }] },
    select: { id: true, name: true, language: true },
  });
  if (pending.length > 0) {
    const listed = await listTemplates(cred.token, a.wabaId, { timeoutMs });
    if (!listed.ok) {
      s.errors += 1;
      await markAccountProblem(a.tenantId, listed.errorClass, listed.errorCode);
      return;
    }
    const inMeta = new Map(listed.data.map((t) => [`${t.name}|${t.language}`, t]));
    const at = new Date();
    for (const p of pending) {
      const found = inMeta.get(`${p.name}|${p.language}`);
      if (!found) continue;
      const status = templateStatusOf(found.status);
      if (status === "PENDING") continue;
      // Condicionado a seguir PENDING: si el webhook de aprobación llegó en el medio, no se pisa con lo que leímos.
      const n = await prismaService.whatsAppTemplate.updateMany({
        where: { id: p.id, tenantId: a.tenantId, status: "PENDING" },
        data: {
          status,
          metaTemplateId: found.id ?? undefined,
          rejectedReason: status === "REJECTED" ? (found.rejectedReason?.slice(0, 200) ?? null) : null,
          statusAt: at,
        },
      });
      s.templatesUpdated += n.count;
    }
  }

  // Calidad y límite del número.
  const phone = await getPhone(cred.token, a.phoneNumberId, { timeoutMs });
  if (!phone.ok) {
    s.errors += 1;
    await markAccountProblem(a.tenantId, phone.errorClass, phone.errorCode);
    return;
  }
  const qualityRating = phone.data.qualityRating?.slice(0, 20) ?? null;
  const messagingLimit = phone.data.messagingLimit?.slice(0, 40) ?? null;
  if (qualityRating !== a.qualityRating || messagingLimit !== a.messagingLimit) {
    const n = await prismaService.whatsAppAccount.updateMany({
      where: { id: a.id, tenantId: a.tenantId, status: "ACTIVE" },
      data: { qualityRating, messagingLimit },
    });
    s.qualityUpdated += n.count;
  }
}
