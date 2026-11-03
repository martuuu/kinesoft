import "server-only";
import { prismaService } from "@/lib/db";
import { webPushVapid, type WebPushVapid } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  clampPushPayload,
  PUSH_MAX_FAILURES,
  PUSH_SEND_TIMEOUT_MS,
  PUSH_TTL_SECONDS,
  type PushPayload,
  type PushSendResult,
} from "@/lib/web-push-types";

/**
 * CF2 (§29, D-CF2-12, brief T.C «Push»): manda un push web a TODOS los dispositivos de un usuario.
 *
 * `PushSubscription` es SERVICE_ONLY (sin tenantId, cero policies): se lee y escribe por `prismaService` con el userId
 * que resolvió quien llama (el profesional del turno o el usuario de la sesión), nunca con uno del input del cliente.
 *
 * `web-push` entra SOLO por `import()` dinámico y SOLO si hay VAPID y al menos un dispositivo: el turnero y el webhook
 * importan este módulo, y con push apagado (o un profesional sin dispositivos, el caso común) no tiene que costar ni la
 * carga del paquete (crypto/https/jws) ni una query de más.
 *
 * Nunca tira: el aviso corre después del commit del turno; un push service caído no puede convertir una reserva hecha
 * en un error para el paciente.
 */

type WebPushModule = typeof import("web-push");

const EMPTY: PushSendResult = { sent: 0, removed: 0, failed: 0 };

class PushTimeoutError extends Error {
  constructor() {
    super("push timeout");
  }
}

async function loadWebPush(): Promise<WebPushModule> {
  const mod = (await import("web-push")) as WebPushModule & { default?: WebPushModule };
  // CommonJS: según el bundler llega como namespace o como `default`.
  return mod.default ?? mod;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PushTimeoutError()), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function statusOf(err: unknown): number | null {
  const code = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof code === "number" ? code : null;
}

type SubRow = { id: string; endpoint: string; p256dh: string; auth: string };
type Outcome = "sent" | "gone" | "failed" | "dropped";

async function deliver(
  wp: WebPushModule,
  vapid: WebPushVapid,
  sub: SubRow,
  body: string,
  timeoutMs: number
): Promise<{ outcome: Outcome; status: number | null; timeout: boolean }> {
  try {
    await withTimeout(
      wp.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, body, {
        vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
        TTL: PUSH_TTL_SECONDS,
        urgency: "high",
        // Timeout de socket de web-push: aborta el request colgado. No alcanza solo (es por inactividad, no total), por
        // eso además el `Promise.race`.
        timeout: timeoutMs,
      }),
      timeoutMs
    );
    await prismaService.pushSubscription.updateMany({
      where: { id: sub.id },
      data: { lastSuccessAt: new Date(), failureCount: 0 },
    });
    return { outcome: "sent", status: null, timeout: false };
  } catch (err) {
    const status = statusOf(err);
    // 404/410 = la suscripción ya no existe (el usuario revocó el permiso, desinstaló o el navegador la rotó): no
    // vuelve. Se borra sin esperar a 5.
    if (status === 404 || status === 410) {
      await prismaService.pushSubscription.deleteMany({ where: { id: sub.id } });
      return { outcome: "gone", status, timeout: false };
    }
    // Cualquier otra cosa (5xx, 429, timeout, 401/403 por claves VAPID rotadas) puede ser pasajera: se cuenta, y a la
    // 5.ª seguida se descarta. `updateMany`/`deleteMany`: si otra entrega concurrente ya la borró, no tira.
    await prismaService.pushSubscription.updateMany({
      where: { id: sub.id },
      data: { failureCount: { increment: 1 } },
    });
    const dropped = await prismaService.pushSubscription.deleteMany({
      where: { id: sub.id, failureCount: { gte: PUSH_MAX_FAILURES } },
    });
    return { outcome: dropped.count > 0 ? "dropped" : "failed", status, timeout: err instanceof PushTimeoutError };
  }
}

export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
  opts?: { timeoutMs?: number }
): Promise<PushSendResult> {
  const vapid = webPushVapid();
  if (!vapid) return { ...EMPTY };
  const timeoutMs = opts?.timeoutMs ?? PUSH_SEND_TIMEOUT_MS;
  try {
    const subs = await prismaService.pushSubscription.findMany({
      where: { userId },
      select: { id: true, endpoint: true, p256dh: true, auth: true },
    });
    if (subs.length === 0) return { ...EMPTY };

    const wp = await loadWebPush();
    const body = JSON.stringify(clampPushPayload(payload));
    // ≤ 10 por usuario (D-CF2-12): en paralelo, para que el tope de tiempo sea el de UNA entrega.
    const results = await Promise.allSettled(subs.map((s) => deliver(wp, vapid, s, body, timeoutMs)));

    const out: PushSendResult = { ...EMPTY };
    const statuses: number[] = [];
    let timeouts = 0;
    let errors = 0;
    for (const r of results) {
      if (r.status === "rejected") {
        // Solo si falló la escritura de la base al registrar el resultado: la entrega cuenta como fallida.
        out.failed += 1;
        errors += 1;
        continue;
      }
      const { outcome, status, timeout } = r.value;
      if (outcome === "sent") out.sent += 1;
      else if (outcome === "gone") out.removed += 1;
      else {
        out.failed += 1;
        if (outcome === "dropped") out.removed += 1;
      }
      if (status !== null && outcome !== "sent") statuses.push(status);
      if (timeout) timeouts += 1;
    }
    // Sin endpoint en el log: es una URL-capacidad (con ella cualquiera con las claves podría mandar a ese dispositivo).
    if (out.failed > 0 || out.removed > 0) {
      logger.warn("push.send", { userId, ...out, statuses, timeouts, dbErrors: errors });
    }
    return out;
  } catch (err) {
    logger.warn("push.send_error", { userId, error: err instanceof Error ? err.message : String(err) });
    return { ...EMPTY };
  }
}
