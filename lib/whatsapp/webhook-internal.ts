import "server-only";
import { revalidateTag } from "next/cache";
import { prismaService } from "@/lib/db";
import { auditInTx } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { tags } from "@/lib/cache-tags";
import { whatsappMode } from "@/lib/env";
import { WA_ACCOUNT_AUDIT, markAccountProblem } from "@/lib/whatsapp/account-internal";
import { applyStatus, cancelQueuedInTx, drainAccount, type WaStatusInput } from "@/lib/whatsapp/outbox-internal";
import { handleInboundMessage, type WaInboundMessage, type WaInboundOutcome, type WaRoutedAccount } from "@/lib/whatsapp/reply-internal";
import { prepareWhatsAppDocument } from "@/lib/whatsapp/document-internal";
import type { WaTemplateStatus } from "@/lib/whatsapp/types";

/**
 * WA-S3 (T6, C-WA9, brief §26.5) · El cuerpo del webhook de Meta, YA con la firma verificada por la ruta
 * (`app/api/webhooks/whatsapp/route.ts`). Rutea cada cambio a la cuenta viva de ESE consultorio y aplica:
 *   - `messages` → por `metadata.phone_number_id`: `statuses[]` → `applyStatus` (monótono, de la cola) y
 *     `messages[]` → `handleInboundMessage` (botones, BAJA/ALTA, texto libre; `reply-internal`);
 *   - `message_template_status_update` → estado de la plantilla;
 *   - `phone_number_quality_update` → calidad y límite de mensajes del número;
 *   - `account_update` PARTNER_REMOVED → cuenta DISCONNECTED (sin credencial, cola cancelada) + aviso al titular.
 * Después de los estados de una cuenta, re-drena SU cola (2,5 s / 5 mensajes): no hay `waitUntil` ni cola externa,
 * y cada webhook de estado es una señal de que Meta está aceptando mensajes (C-WA9 «Re-drenado»).
 *
 * Ruteo: `phone_number_id` (mensajes) o el id del WABA (`entry.id`, el resto) contra una cuenta NO DISCONNECTED en el
 * modo vigente. Los índices parciales de M15 garantizan que un número / WABA vivo está en UN consultorio. Lo que no
 * rutea (un número que se desconectó, otro modo, un id inventado) se ignora con 200: Meta no tiene que reintentar algo
 * que no es de nadie. TODO con `prismaService` y el `tenantId` de la cuenta ruteada (en prod la conexión tiene
 * BYPASSRLS: el `tenantId` a mano es la única barrera).
 *
 * Nunca se loguea el cuerpo, ni un teléfono, ni un texto: tenant, cuenta, campo y conteos.
 */

/** Tope del cuerpo (C-WA9). Meta manda lotes chicos; 1 MB es un margen enorme y corta un POST abusivo antes del HMAC. */
export const WA_WEBHOOK_MAX_BYTES = 1_048_576;
/** Re-drenado después de los estados (C-WA9): 2,5 s / 5 mensajes por cuenta. */
export const WA_REDRAIN = { budgetMs: 2_500, max: 5 } as const;
/** Topes de lo que se procesa de un solo POST (un lote patológico no deja la lambda colgada). */
const MAX_ENTRIES = 50;
const MAX_CHANGES = 50;
const MAX_STATUSES = 200;
const MAX_MESSAGES = 50;
const META_ID_RE = /^[0-9]{5,25}$/;
const WAMID_RE = /^[A-Za-z0-9._:=+/-]{1,200}$/;
const STATUS_INPUTS = new Set<WaStatusInput>(["sent", "delivered", "read", "failed"]);

export type WaWebhookSummary = {
  /** Cambios que rutearon a una cuenta y se procesaron. */
  processed: number;
  /** Cambios ignorados (sin cuenta, campo desconocido, forma rara). */
  ignored: number;
  statuses: number;
  /** Outcome de cada mensaje entrante, en orden. */
  outcomes: WaInboundOutcome[];
};

/**
 * Lee el cuerpo CRUDO con tope: `Content-Length` declarado de más → corta sin leer; sin `Content-Length` (chunked) →
 * lee hasta pasarse y corta. Devuelve los bytes tal cual llegaron (la firma es sobre ellos) o `too_large`.
 */
export async function readCappedBody(req: Request, max: number = WA_WEBHOOK_MAX_BYTES): Promise<Buffer | "too_large"> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return "too_large";
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return "too_large";
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const arr = (x: unknown, max: number): unknown[] => (Array.isArray(x) ? x.slice(0, max) : []);
const str = (x: unknown): string | null => (typeof x === "string" ? x : typeof x === "number" && Number.isFinite(x) ? String(x) : null);

const ROUTE_SELECT = { id: true, tenantId: true, wabaId: true, phoneNumberId: true, autoReplyText: true } as const;

/** Ruteo con memo por request (un lote de 50 estados del mismo número = 1 query). */
function makeRouter() {
  const byPhone = new Map<string, Promise<WaRoutedAccount | null>>();
  const byWaba = new Map<string, Promise<WaRoutedAccount | null>>();
  const mode = whatsappMode();
  const find = (where: { phoneNumberId: string } | { wabaId: string }) =>
    mode === "off"
      ? Promise.resolve(null)
      : prismaService.whatsAppAccount.findFirst({ where: { ...where, status: { not: "DISCONNECTED" }, mode }, select: ROUTE_SELECT });
  return {
    phone(id: string | null): Promise<WaRoutedAccount | null> {
      if (!id || !META_ID_RE.test(id)) return Promise.resolve(null);
      if (!byPhone.has(id)) byPhone.set(id, find({ phoneNumberId: id }));
      return byPhone.get(id)!;
    },
    waba(id: string | null): Promise<WaRoutedAccount | null> {
      if (!id || !META_ID_RE.test(id)) return Promise.resolve(null);
      if (!byWaba.has(id)) byWaba.set(id, find({ wabaId: id }));
      return byWaba.get(id)!;
    },
  };
}

function revalidateAccount(tenantId: string): void {
  try {
    revalidateTag(tags.whatsappAccount(tenantId));
  } catch (err) {
    logger.warn("whatsapp.webhook.revalidate_failed", { tenantId, error: (err as Error)?.name });
  }
}

/**
 * Procesa el cuerpo ya verificado. Los errores de un cambio no frenan a los demás (cada uno en su try, logueado sin
 * datos): un estado que falla no tiene que perder el «No puedo ir» que venía en el mismo lote.
 */
export async function handleWhatsAppWebhook(body: unknown, now: Date = new Date()): Promise<WaWebhookSummary> {
  const out: WaWebhookSummary = { processed: 0, ignored: 0, statuses: 0, outcomes: [] };
  if (!isObj(body) || body.object !== "whatsapp_business_account") {
    out.ignored += 1;
    return out;
  }
  const route = makeRouter();
  const drain = new Map<string, WaRoutedAccount>();
  const touched = new Map<string, WaRoutedAccount>();

  for (const entry of arr(body.entry, MAX_ENTRIES)) {
    if (!isObj(entry)) continue;
    const entryWaba = str(entry.id);
    for (const change of arr(entry.changes, MAX_CHANGES)) {
      if (!isObj(change) || !isObj(change.value)) {
        out.ignored += 1;
        continue;
      }
      const field = str(change.field);
      const value = change.value;
      try {
        let acc: WaRoutedAccount | null = null;
        if (field === "messages") {
          acc = await route.phone(str(isObj(value.metadata) ? value.metadata.phone_number_id : null));
          if (acc) {
            const n = await messagesChange(acc, value, now, out);
            if (n > 0) drain.set(acc.id, acc);
          }
        } else if (field === "message_template_status_update") {
          acc = await route.waba(entryWaba);
          if (acc) await templateChange(acc, value, now);
        } else if (field === "phone_number_quality_update") {
          acc = await route.waba(entryWaba);
          if (acc) await qualityChange(acc, value);
        } else if (field === "account_update") {
          const info = isObj(value.waba_info) ? value.waba_info : {};
          acc = await route.waba(str(info.waba_id) ?? entryWaba);
          if (acc) await accountChange(acc, value, now);
        }
        if (acc) {
          out.processed += 1;
          touched.set(acc.id, acc);
        } else {
          out.ignored += 1;
        }
      } catch (err) {
        out.ignored += 1;
        logger.error("whatsapp.webhook.change_failed", { field, error: (err as Error)?.name, code: (err as { code?: unknown })?.code ?? null /* nunca el mensaje: un error de base puede traer valores */ });
      }
    }
  }

  // Rastro de vida del webhook (Configuración/Plataforma): SQL sin mover `updatedAt` (el CAS de los switches no se
  // rompe porque llegó un estado).
  for (const acc of touched.values()) {
    try {
      await prismaService.$executeRaw`UPDATE "WhatsAppAccount" SET "lastWebhookAt" = ${now} WHERE "id" = ${acc.id} AND "tenantId" = ${acc.tenantId}`;
    } catch (err) {
      logger.warn("whatsapp.webhook.touch_failed", { tenantId: acc.tenantId, error: (err as Error)?.name });
    }
  }
  for (const acc of drain.values()) {
    try {
      const r = await drainAccount(acc.id, { tenantId: acc.tenantId, budgetMs: WA_REDRAIN.budgetMs, max: WA_REDRAIN.max, prepareDocument: prepareWhatsAppDocument });
      if (r.processed > 0) logger.info("whatsapp.webhook.redrain", { tenantId: acc.tenantId, accountId: acc.id, ...r });
    } catch (err) {
      logger.warn("whatsapp.webhook.redrain_failed", { tenantId: acc.tenantId, error: (err as Error)?.name });
    }
  }
  return out;
}

// ── messages: estados + entrantes ────────────────────────────────────────────────────────────────────────────────

/** Devuelve cuántos estados se aplicaron (para decidir el re-drenado). */
async function messagesChange(acc: WaRoutedAccount, value: Obj, now: Date, out: WaWebhookSummary): Promise<number> {
  let applied = 0;
  for (const st of arr(value.statuses, MAX_STATUSES)) {
    if (!isObj(st)) continue;
    const wamid = str(st.id);
    const status = str(st.status) as WaStatusInput | null;
    if (!wamid || !WAMID_RE.test(wamid) || !status || !STATUS_INPUTS.has(status)) continue;
    const ts = Number(str(st.timestamp));
    const at = Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : now;
    const errors = arr(st.errors, 1);
    const code = isObj(errors[0]) && typeof errors[0].code === "number" ? errors[0].code : null;
    const cb = str(st.biz_opaque_callback_data);
    const r = await applyStatus({ tenantId: acc.tenantId, wamid, callbackData: cb && cb.length <= 64 ? cb : null, status, at, code });
    out.statuses += 1;
    if (r.applied) applied += 1;
  }
  // Un estado aplicado o no, Meta está viva: igual vale re-drenar si llegaron estados (aunque fueran repetidos).
  const sawStatuses = Array.isArray(value.statuses) && value.statuses.length > 0;
  for (const m of arr(value.messages, MAX_MESSAGES)) {
    if (!isObj(m)) continue;
    out.outcomes.push(await handleInboundMessage(acc, m as WaInboundMessage, now));
  }
  return sawStatuses ? Math.max(1, applied) : 0;
}

// ── message_template_status_update ──────────────────────────────────────────────────────────────────────────────

/**
 * Eventos de Meta → estado de M15. FLAGGED (calidad baja de la plantilla, sigue enviándose) no cambia el estado;
 * un evento que no conocemos tampoco: mejor no tocar que marcar mal (un CHECK de valores en el webhook es un 500,
 * lección M18; acá además el estado decide si la cola manda).
 */
const TEMPLATE_EVENT: Record<string, WaTemplateStatus> = {
  APPROVED: "APPROVED",
  REINSTATED: "APPROVED",
  REJECTED: "REJECTED",
  PAUSED: "PAUSED",
  DISABLED: "DISABLED",
  PENDING_DELETION: "DISABLED",
  DELETED: "DISABLED",
  PENDING: "PENDING",
  IN_APPEAL: "PENDING",
};

async function templateChange(acc: WaRoutedAccount, value: Obj, now: Date): Promise<void> {
  const event = str(value.event)?.toUpperCase() ?? "";
  const status = TEMPLATE_EVENT[event];
  const name = str(value.message_template_name);
  if (!status || !name || !/^[a-z0-9_]{1,100}$/.test(name)) return;
  const language = str(value.message_template_language);
  const metaId = str(value.message_template_id);
  const reason = str(value.reason);
  const n = await prismaService.whatsAppTemplate.updateMany({
    where: { tenantId: acc.tenantId, accountId: acc.id, name, ...(language && /^[a-z]{2}(_[A-Z]{2})?$/.test(language) ? { language } : {}) },
    data: {
      status,
      statusAt: now,
      // El motivo es sobre la plantilla (no tiene PHI); «NONE» es lo que Meta manda cuando no hay motivo.
      rejectedReason: status === "REJECTED" && reason && reason.toUpperCase() !== "NONE" ? reason.slice(0, 200) : null,
      ...(metaId && META_ID_RE.test(metaId) ? { metaTemplateId: metaId } : {}),
    },
  });
  if (n.count > 0) {
    revalidateAccount(acc.tenantId);
    logger.info("whatsapp.webhook.template", { tenantId: acc.tenantId, accountId: acc.id, name, status });
  }
}

// ── phone_number_quality_update ─────────────────────────────────────────────────────────────────────────────────

/**
 * El aviso de calidad no trae el color: trae el evento y el límite vigente. FLAGGED = la calidad bajó (amarillo),
 * DOWNGRADE = Meta además bajó el límite (rojo), UNFLAGGED/UPGRADE = se recuperó. Mismo mapeo que el simulador
 * (`fakeGraphQuality`); el sync del cron (WA-S4) corrige con `GET /{phone}` lo que este mapeo aproxime.
 */
const QUALITY_OF: Record<string, string> = { FLAGGED: "YELLOW", DOWNGRADE: "RED", UNFLAGGED: "GREEN", UPGRADE: "GREEN" };

async function qualityChange(acc: WaRoutedAccount, value: Obj): Promise<void> {
  const event = str(value.event)?.toUpperCase() ?? "";
  const quality = QUALITY_OF[event] ?? null;
  const limit = str(value.current_limit);
  if (!quality && !limit) return;
  await prismaService.whatsAppAccount.updateMany({
    where: { id: acc.id, tenantId: acc.tenantId },
    data: {
      ...(quality ? { qualityRating: quality } : {}),
      // Solo tope de largo (CHECK de M15): un valor nuevo de Meta no puede convertir el webhook en un 500.
      ...(limit ? { messagingLimit: limit.slice(0, 40) } : {}),
    },
  });
  revalidateAccount(acc.tenantId);
  logger.info("whatsapp.webhook.quality", { tenantId: acc.tenantId, accountId: acc.id, event });
}

// ── account_update ─────────────────────────────────────────────────────────────────────────────────────────────

const PARTNER_REMOVED_COPY = {
  title: "WhatsApp se desconectó desde Meta",
  body: "Se quitó el acceso de la plataforma a la cuenta de WhatsApp Business del consultorio desde Meta. Los avisos por WhatsApp quedan apagados hasta que el titular lo vuelva a conectar desde Configuración → WhatsApp.",
} as const;

/** Eventos de Meta que son un problema de la cuenta (no la desconectan, pero el titular tiene que mirarlo). */
const ACCOUNT_PROBLEM_EVENTS = new Set(["ACCOUNT_VIOLATION", "DISABLED_UPDATE", "ACCOUNT_RESTRICTION"]);

/**
 * PARTNER_REMOVED: el consultorio (o alguien con acceso a su Business Manager) sacó nuestra app en Meta. El token ya
 * no sirve y Meta deja de mandar webhooks de ese WABA: lo mismo que `disconnect` (C-WA6) pero sin unsubscribe (no hay
 * token) y sin actor. En UNA tx: DISCONNECTED, cola QUEUED cancelada (con la función de la cola), credencial borrada
 * (WA-D24), audit y el aviso a los titulares (este no pasa por el tope de 1 por día de `markAccountProblem`: es un
 * evento único que cambia el estado de la cuenta).
 */
async function accountChange(acc: WaRoutedAccount, value: Obj, now: Date): Promise<void> {
  const event = str(value.event)?.toUpperCase() ?? "";
  if (ACCOUNT_PROBLEM_EVENTS.has(event)) {
    await markAccountProblem(acc.tenantId, "account", "account_update");
    return;
  }
  if (event !== "PARTNER_REMOVED") return;
  const r = await prismaService.$transaction(async (tx) => {
    const n = await tx.whatsAppAccount.updateMany({
      where: { id: acc.id, tenantId: acc.tenantId, status: { not: "DISCONNECTED" } },
      data: { status: "DISCONNECTED", disconnectedAt: now, disconnectedByUserId: null },
    });
    if (n.count === 0) return null;
    const cancelled = await cancelQueuedInTx(tx, { tenantId: acc.tenantId, accountId: acc.id }, "partner_removed");
    await tx.whatsAppCredential.deleteMany({ where: { tenantId: acc.tenantId, accountId: acc.id } });
    await auditInTx(tx, {
      tenantId: acc.tenantId,
      action: WA_ACCOUNT_AUDIT.disconnect,
      entity: "WhatsAppAccount",
      entityId: acc.id,
      payload: { source: "partner_removed", cancelledMessages: cancelled },
    });
    const owners = await tx.membership.findMany({ where: { tenantId: acc.tenantId, role: "OWNER", disabledAt: null }, select: { userId: true } });
    if (owners.length > 0) {
      await tx.notification.createMany({
        data: owners.map((m) => ({
          tenantId: acc.tenantId,
          userId: m.userId,
          kind: "WHATSAPP_ACCOUNT" as const,
          title: PARTNER_REMOVED_COPY.title,
          body: PARTNER_REMOVED_COPY.body,
          link: "/configuracion?tab=whatsapp",
        })),
      });
    }
    return cancelled;
  });
  revalidateAccount(acc.tenantId);
  if (r !== null) logger.warn("whatsapp.webhook.partner_removed", { tenantId: acc.tenantId, accountId: acc.id, cancelled: r });
}
