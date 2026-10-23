import "server-only";
/**
 * WA-U6 (T6, brief §26.5 «Plataforma → WhatsApp, sin teléfonos») · `/plataforma/whatsapp`: el estado de la
 * integración con Meta en este deploy y por consultorio, para que el superadmin vea qué cuenta anda mal sin entrar a
 * ningún consultorio.
 *
 * Seguridad (C-BO2, guard estático `tests/unit/platform-admin-guard.test.ts`): el único export async llama a
 * `requirePlatformAdmin` antes de nada. Corre por `prismaService` (BYPASSRLS, cruza consultorios) y por eso el `select`
 * es una lista blanca: de la cuenta se trae estado, calidad, límite, último error y el wabaId (del que sale solo la
 * cola de 4 dígitos, para cruzar con el Business Manager). NUNCA `displayPhone` ni `phoneNumberId` (son el número del
 * consultorio, y con `phoneNumberId` se rutea el webhook), y de los mensajes solo `groupBy` con `_count`: ni `toMasked`
 * ni `toHash` (son del paciente) ni ids de paciente o turno. La integración `wa-u6-platform-read.test.ts` serializa el
 * DTO y afirma que ninguno aparece.
 *
 * Variables de Meta: solo presencia por nombre, leídas EN VIVO de `process.env` (como `liveVar` de
 * `platform-system-read.ts`: `env` se congela al importar y los tests las cambian en caliente). El valor nunca sale de
 * esta función.
 *
 * Modo `off`: devuelve modo + variables y NO consulta tablas (regla de T6: con WhatsApp apagado, cero queries extra).
 * La página dice «WhatsApp está apagado».
 *
 * Mensajes de 7 días (default WA-U6): conteo ACUMULADO, como un embudo, porque `applyStatus` es monótono y un mensaje
 * leído ya pasó por enviado y entregado: «enviados» = SENT+DELIVERED+READ, «entregados» = DELIVERED+READ, «leídos» =
 * READ. Fallidos y salteados por su estado. QUEUED/SENDING/CANCELLED/EXPIRED no se muestran (no son señal de salud de
 * la cuenta; la cola pendiente la drena el cron). Ventana por `createdAt` (hay índice `[tenantId, createdAt]`).
 *
 * Una fila por consultorio: la cuenta más nueva (un consultorio que desconectó y volvió a conectar tiene varias; la
 * vieja DISCONNECTED es historia). Los mensajes se agrupan por consultorio, no por cuenta: lo que importa es qué le
 * llegó a sus pacientes.
 */
import { prismaService } from "@/lib/db";
import { whatsappMode } from "@/lib/env";
import { logger } from "@/lib/logger";
import { requirePlatformAdmin } from "@/lib/platform-actor";

export type WaEnvName = "WHATSAPP_APP_ID" | "WHATSAPP_APP_SECRET" | "WHATSAPP_CONFIG_ID" | "WHATSAPP_WEBHOOK_VERIFY_TOKEN";
export type WaEnvPresence = { name: WaEnvName; present: boolean };
export type WaMessages7d = { sent: number; delivered: number; read: number; failed: number; skipped: number };
export type PlatformWhatsAppAccountRow = {
  tenantId: string;
  tenantName: string;
  mode: string;
  status: "SETUP" | "ACTIVE" | "REAUTH_REQUIRED" | "DISCONNECTED";
  qualityRating: string | null;
  messagingLimit: string | null;
  /** Últimos 4 dígitos del WABA: alcanza para encontrarlo en el Business Manager, no para operarlo. */
  wabaIdTail: string;
  paymentIssue: boolean;
  lastErrorCode: string | null;
  lastWebhookAt: string | null;
  templatesApproved: number;
  templatesTotal: number;
  messages7d: WaMessages7d;
  topErrors: Array<{ code: string; count: number }>;
};
export type PlatformWhatsAppStats =
  | { available: true; lastWebhookAt: string | null; accounts: PlatformWhatsAppAccountRow[] }
  | { available: false };
export type PlatformWhatsAppOverview =
  | { mode: "off"; env: WaEnvPresence[] }
  | { mode: "fake" | "sandbox" | "live"; env: WaEnvPresence[]; windowDays: number; stats: PlatformWhatsAppStats };

const ENV_NAMES: readonly WaEnvName[] = [
  "WHATSAPP_APP_ID",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_CONFIG_ID",
  "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
];
const WINDOW_DAYS = 7;
const TOP_ERRORS = 3;

function envPresence(): WaEnvPresence[] {
  return ENV_NAMES.map((name) => ({ name, present: Boolean(process.env[name]?.trim()) }));
}

async function readStats(): Promise<PlatformWhatsAppStats> {
  try {
    const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const [accounts, lastHook, templates, messages, errors] = await Promise.all([
      prismaService.whatsAppAccount.findMany({
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          tenantId: true,
          mode: true,
          status: true,
          qualityRating: true,
          messagingLimit: true,
          wabaId: true,
          paymentIssueAt: true,
          lastErrorCode: true,
          lastWebhookAt: true,
          tenant: { select: { name: true } },
        },
      }),
      prismaService.whatsAppAccount.aggregate({ _max: { lastWebhookAt: true } }),
      prismaService.whatsAppTemplate.groupBy({ by: ["accountId", "status"], _count: { _all: true } }),
      prismaService.whatsAppMessage.groupBy({
        by: ["tenantId", "status"],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
      }),
      prismaService.whatsAppMessage.groupBy({
        by: ["tenantId", "errorCode"],
        where: { createdAt: { gte: since }, errorCode: { not: null } },
        _count: { _all: true },
      }),
    ]);

    const seen = new Set<string>();
    const rows: PlatformWhatsAppAccountRow[] = [];
    for (const a of accounts) {
      if (seen.has(a.tenantId)) continue; // ya está la cuenta más nueva (orderBy createdAt desc)
      seen.add(a.tenantId);
      const tpl = templates.filter((t) => t.accountId === a.id);
      const msgCount = (...st: string[]) =>
        messages.filter((m) => m.tenantId === a.tenantId && st.includes(m.status)).reduce((s, m) => s + m._count._all, 0);
      rows.push({
        tenantId: a.tenantId,
        tenantName: a.tenant.name,
        mode: a.mode,
        status: a.status,
        qualityRating: a.qualityRating,
        messagingLimit: a.messagingLimit,
        wabaIdTail: a.wabaId.slice(-4),
        paymentIssue: a.paymentIssueAt !== null,
        lastErrorCode: a.lastErrorCode,
        lastWebhookAt: a.lastWebhookAt?.toISOString() ?? null,
        templatesApproved: tpl.filter((t) => t.status === "APPROVED").reduce((s, t) => s + t._count._all, 0),
        templatesTotal: tpl.reduce((s, t) => s + t._count._all, 0),
        messages7d: {
          sent: msgCount("SENT", "DELIVERED", "READ"),
          delivered: msgCount("DELIVERED", "READ"),
          read: msgCount("READ"),
          failed: msgCount("FAILED"),
          skipped: msgCount("SKIPPED"),
        },
        topErrors: errors
          .filter((e) => e.tenantId === a.tenantId && e.errorCode)
          .map((e) => ({ code: e.errorCode as string, count: e._count._all }))
          .sort((x, y) => y.count - x.count || x.code.localeCompare(y.code))
          .slice(0, TOP_ERRORS),
      });
    }
    rows.sort((x, y) => x.tenantName.localeCompare(y.tenantName, "es"));
    return { available: true, lastWebhookAt: lastHook._max.lastWebhookAt?.toISOString() ?? null, accounts: rows };
  } catch (err) {
    // Mismo criterio que `/plataforma/sistema`: si el rol service no puede leer las tablas de M15, la página lo dice
    // y no se cae.
    logger.warn("platform.whatsapp.stats_unavailable", { error: err instanceof Error ? err.name : "unknown" });
    return { available: false };
  }
}

export async function getPlatformWhatsAppOverview(): Promise<PlatformWhatsAppOverview> {
  await requirePlatformAdmin("platform.read");
  const env = envPresence();
  const mode = whatsappMode();
  if (mode === "off") return { mode, env };
  return { mode, env, windowDays: WINDOW_DAYS, stats: await readStats() };
}
