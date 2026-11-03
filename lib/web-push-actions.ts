"use server";

/**
 * CF2 (§29, D-CF2-12, brief T.C «Push»): dispositivos de push web del profesional («Mi agenda › Avisos de turnos
 * online»). Alta, baja, lista y una prueba.
 *
 * Canal: `prismaService`. `PushSubscription` es SERVICE_ONLY (M21: sin `tenantId`, ENABLE + FORCE, cero policies): el
 * dispositivo es de la PERSONA, no del consultorio (una persona con dos consultorios recibe los avisos de los dos en
 * el mismo teléfono), así que no hay `runWithRls` ni `where: { tenantId }`. La barrera es la de las tablas de 2FA y del
 * perfil público: el `userId` sale SIEMPRE de la sesión verificada (`getActor`), nunca del input. Ninguna action recibe
 * un `userId`; si el cliente lo manda en el objeto, se ignora (no está en el tipo y no se lee).
 *
 * Gate (`resolvePushUser`): actor del consultorio activo que atiende (`practitionerId`) y que NO es una sesión de
 * soporte. Por qué el profesional: el aviso es «te reservaron un turno online» y solo le llega a quien atiende; la
 * Secretaria y Facturación no tienen nada que activar. Por qué no el soporte: el superadmin en un consultorio ajeno
 * registraría SU navegador como dispositivo de su propia persona desde una sesión que no es suya (y el soporte es de
 * solo lectura, C-BO4). No se corta por consultorio en solo lectura: el dispositivo no es dato del consultorio y
 * desactivarlo tiene que andar siempre.
 *
 * El endpoint se valida con `parsePushSubscriptionInput` (https, sin credenciales ni puerto, host de un push service
 * conocido, claves con la forma del CHECK de M21): sin eso cualquier usuario logueado podría hacer que el server le
 * pegue a un host suyo o interno (SSRF ciego, ver `lib/web-push-types.ts`).
 */
import { Prisma } from "@prisma/client";
import { cookies, headers } from "next/headers";
import { z } from "zod";
import { prismaService } from "@/lib/db";
import { webPushVapid } from "@/lib/env";
import { logger } from "@/lib/logger";
import { rateLimit, rateLimitedMessage } from "@/lib/rate-limit";
import { ForbiddenError, getActor, UnauthenticatedError } from "@/lib/session";
import type { ActionResult } from "@/lib/validation";
import { sendPushToUser } from "@/lib/web-push-internal";
import {
  parsePushSubscriptionInput,
  PUSH_ENDPOINT_MAX,
  PUSH_MAX_DEVICES_PER_USER,
  PUSH_SUB_COOKIE,
  pushDeviceLabel,
  type PushDeviceView,
  type PushSendResult,
  type PushSubscriptionInput,
} from "@/lib/web-push-types";

const NO_SESSION = "Tu sesión venció. Volvé a entrar.";
const NOT_PRACTITIONER = "Los avisos de turnos online son para quienes atienden en el consultorio.";
const SUPPORT = "En una sesión de soporte no se activan avisos.";
const UNSUPPORTED_BROWSER = "Este navegador no es compatible con los avisos de turnos. Te siguen llegando por mail.";
const SAVE_FAILED = "No pudimos activar los avisos en este dispositivo. Probá de nuevo.";
const INVALID_DEVICE = "No encontramos ese dispositivo.";
const NOT_CONFIGURED = "Los avisos al celular todavía no están disponibles.";
const NO_DEVICES = "Primero activá los avisos en este dispositivo.";

// 3 cada 5 min por usuario: alcanza para probar, reintentar después de cambiar un permiso y volver a probar; corta a
// quien martille el botón (cada prueba son hasta 10 POST a push services de terceros).
const TEST_RATE = { limit: 3, windowMs: 5 * 60_000 };

// La cookie vive lo que el dispositivo (no la sesión): el sign-out la usa para borrar ESTE dispositivo, y una cookie
// de sesión se perdería al cerrar el navegador y dejaría avisando a un teléfono del que el profesional salió.
// 400 días es el techo que respetan los navegadores (Chrome recorta a eso).
const PUSH_COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;

const EndpointInput = z.string().trim().min(1).max(PUSH_ENDPOINT_MAX);

type PushUser = { ok: true; userId: string } | { ok: false; error: string };

async function resolvePushUser(): Promise<PushUser> {
  try {
    const actor = await getActor();
    if (actor.support) return { ok: false, error: SUPPORT };
    if (!actor.practitionerId) return { ok: false, error: NOT_PRACTITIONER };
    return { ok: true, userId: actor.userId };
  } catch (e) {
    if (e instanceof UnauthenticatedError) return { ok: false, error: NO_SESSION };
    if (e instanceof ForbiddenError) return { ok: false, error: e.message || NOT_PRACTITIONER };
    throw e;
  }
}

function currentDeviceId(): string | null {
  return cookies().get(PUSH_SUB_COOKIE)?.value ?? null;
}

/**
 * Upsert por endpoint + tope por usuario, en una tx. Si el endpoint era de OTRO usuario (dos profesionales que se
 * turnan el mismo navegador), pasa al actual y arranca limpio (`lastSuccessAt`/`failureCount` eran de la otra
 * persona): un navegador tiene UNA suscripción, y los avisos de quien salió no le pueden llegar a quien entró.
 * El tope borra los vistos hace más tiempo (`lastSeenAt`, que se renueva en cada alta/re-sincronización).
 */
async function upsertDevice(userId: string, sub: PushSubscriptionInput, label: string): Promise<string> {
  return prismaService.$transaction(async (tx) => {
    const now = new Date();
    const prev = await tx.pushSubscription.findUnique({ where: { endpoint: sub.endpoint }, select: { userId: true } });
    const reassigned = prev !== null && prev.userId !== userId;
    const row = await tx.pushSubscription.upsert({
      where: { endpoint: sub.endpoint },
      create: { userId, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, label, lastSeenAt: now },
      update: {
        userId,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        label,
        lastSeenAt: now,
        failureCount: 0,
        ...(reassigned ? { lastSuccessAt: null } : {}),
      },
      select: { id: true },
    });
    const extra = await tx.pushSubscription.findMany({
      where: { userId, id: { not: row.id } },
      orderBy: [{ lastSeenAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      skip: PUSH_MAX_DEVICES_PER_USER - 1,
      select: { id: true },
    });
    if (extra.length > 0) {
      await tx.pushSubscription.deleteMany({ where: { userId, id: { in: extra.map((e) => e.id) } } });
    }
    return row.id;
  });
}

export async function savePushSubscription(input: PushSubscriptionInput): Promise<ActionResult<{ deviceId: string }>> {
  const who = await resolvePushUser();
  if (!who.ok) return who;
  const parsed = parsePushSubscriptionInput(input);
  if (!parsed.ok) return { ok: false, error: parsed.reason === "endpoint" ? UNSUPPORTED_BROWSER : SAVE_FAILED };

  const label = pushDeviceLabel(headers().get("user-agent"));
  let deviceId: string;
  try {
    deviceId = await upsertDevice(who.userId, parsed.value, label);
  } catch (err) {
    // Dos altas simultáneas del mismo endpoint (dos pestañas): el `create` de una choca con el único. Un reintento ve
    // la fila y la actualiza.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      try {
        deviceId = await upsertDevice(who.userId, parsed.value, label);
      } catch (retryErr) {
        logger.warn("push.subscribe_error", { userId: who.userId, error: (retryErr as Error).message });
        return { ok: false, error: SAVE_FAILED };
      }
    } else {
      // Sin endpoint en el log: es una URL-capacidad.
      logger.warn("push.subscribe_error", { userId: who.userId, error: err instanceof Error ? err.message : String(err) });
      return { ok: false, error: SAVE_FAILED };
    }
  }

  cookies().set(PUSH_SUB_COOKIE, deviceId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    // `lax`: el sign-out es un POST same-origin y el layout no la lee; no hace falta más estricta ni más laxa.
    sameSite: "lax",
    path: "/",
    maxAge: PUSH_COOKIE_MAX_AGE_S,
  });
  return { ok: true, data: { deviceId } };
}

/**
 * «Desactivar en este dispositivo»: el cliente manda el endpoint de `pushManager.getSubscription()`. Solo borra filas
 * del usuario de la sesión; una ajena o inexistente responde igual (`removed: false`), sin confirmar que existe.
 */
export async function deletePushSubscription(endpoint: string): Promise<ActionResult<{ removed: boolean }>> {
  const who = await resolvePushUser();
  if (!who.ok) return who;
  const parsed = EndpointInput.safeParse(endpoint);
  if (!parsed.success) return { ok: false, error: INVALID_DEVICE };

  const rows = await prismaService.pushSubscription.findMany({
    where: { endpoint: parsed.data, userId: who.userId },
    select: { id: true },
  });
  if (rows.length === 0) return { ok: true, data: { removed: false } };
  const ids = rows.map((r) => r.id);
  const del = await prismaService.pushSubscription.deleteMany({ where: { id: { in: ids }, userId: who.userId } });
  const current = currentDeviceId();
  if (current && ids.includes(current)) cookies().delete(PUSH_SUB_COOKIE);
  return { ok: true, data: { removed: del.count > 0 } };
}

const DeviceIdInput = z.string().trim().min(1).max(64);

/**
 * «Quitar» un dispositivo de la lista de «Mi agenda» (otro teléfono, una compu vieja): la lista no trae el endpoint
 * (es una capacidad), así que se borra por id. Solo filas del usuario de la sesión; una ajena o inexistente responde
 * igual (`removed: false`). Si era el de este navegador, se limpia la cookie.
 */
export async function deleteMyPushDevice(deviceId: string): Promise<ActionResult<{ removed: boolean }>> {
  const who = await resolvePushUser();
  if (!who.ok) return who;
  const parsed = DeviceIdInput.safeParse(deviceId);
  if (!parsed.success) return { ok: false, error: INVALID_DEVICE };

  const del = await prismaService.pushSubscription.deleteMany({ where: { id: parsed.data, userId: who.userId } });
  if (del.count > 0 && currentDeviceId() === parsed.data) cookies().delete(PUSH_SUB_COOKIE);
  return { ok: true, data: { removed: del.count > 0 } };
}

/** Dispositivos del usuario de la sesión, del más nuevo al más viejo. Sin endpoint ni claves (son capacidades). */
export async function listMyPushDevices(): Promise<ActionResult<PushDeviceView[]>> {
  const who = await resolvePushUser();
  if (!who.ok) return who;
  const rows = await prismaService.pushSubscription.findMany({
    where: { userId: who.userId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: PUSH_MAX_DEVICES_PER_USER,
    select: { id: true, label: true, createdAt: true, lastSuccessAt: true },
  });
  const current = currentDeviceId();
  return {
    ok: true,
    data: rows.map((r) => ({
      id: r.id,
      label: r.label,
      createdAt: r.createdAt.toISOString(),
      lastSuccessAt: r.lastSuccessAt?.toISOString() ?? null,
      current: r.id === current,
    })),
  };
}

/**
 * «Probar»: un push genérico a TODOS los dispositivos del usuario. Sin PHI ni nombre del consultorio: llega a la
 * pantalla bloqueada. Sin VAPID no hay nada que probar (el error lo dice en vez de un «enviado a 0»).
 */
export async function sendTestPush(): Promise<ActionResult<PushSendResult>> {
  const who = await resolvePushUser();
  if (!who.ok) return who;
  if (!webPushVapid()) return { ok: false, error: NOT_CONFIGURED };
  const rl = await rateLimit(`push:test:${who.userId}`, TEST_RATE);
  if (!rl.ok) return { ok: false, error: rateLimitedMessage(rl.retryAfterMs) };

  const result = await sendPushToUser(who.userId, {
    title: "Probando avisos de turnos",
    body: "Si ves esto, los avisos de turnos online te llegan a este dispositivo.",
    url: "/configuracion?tab=mi-agenda",
    tag: "push-test",
  });
  if (result.sent === 0 && result.failed === 0 && result.removed === 0) return { ok: false, error: NO_DEVICES };
  return { ok: true, data: result };
}
