"use server";

/**
 * TV (T7 · TV-2d, §26.4 C-TV «Actions del dispositivo»): actions de la PANTALLA (`/tv`), sin Actor. La identidad es
 * la cookie `kine_tv` (`DISPLAY_COOKIE`, path `/tv`, httpOnly, Strict, 180 días); el server usa `prismaService` con
 * `id` + `tenantId` a mano (lib/display-device-internal.ts explica el orden de la sesión y por qué SQL crudo).
 *
 * `pairDisplay({code})`:
 *   - rate limit por IP 10 cada 10 min + 30 por hora, ANTES de mirar el código (40 bits con TTL de 10 min: el tope por
 *     IP es lo que hace inviable recorrerlos; se cuenta también la entrada basura);
 *   - busca por el HMAC del código normalizado (único global parcial de M17: la TV no sabe de qué consultorio es),
 *     vivo y no revocado; acceso del consultorio y módulo `salaEspera` (M12);
 *   - en una transacción: UPDATE con CAS sobre `{id, tenantId, pairingCodeHash, pairingExpiresAt > now, revokedAt
 *     null}` que exige `count === 1` (dos TVs con el mismo código a la vez: Postgres serializa por la fila, la
 *     segunda re-evalúa el WHERE con el hash ya en NULL y no toca nada) → secreto nuevo (rota: la TV anterior queda
 *     afuera), borra el código, `pairedAt`/`lastSeenAt`; `auditInTx("display.paired")` sin actor (no hay usuario);
 *   - cookie DESPUÉS del commit: una cookie de un vínculo revertido no sirve para nada, pero tampoco se emite.
 *   - Ante CUALQUIER fallo, `PAIR_FAILED_MESSAGE`: ni «no existe», ni «venció», ni «ya usado», ni el rate limit (un
 *     mensaje distinto sería un oráculo de códigos vivos).
 *   - DESVÍO de C-TV («`updateMany` con CAS»): el CAS es un `$executeRaw` UPDATE con el mismo WHERE y el mismo
 *     `count === 1`, porque `updateMany` pisa `updatedAt` (`@updatedAt`) y ese campo es el CAS del drawer del staff.
 *
 * `getDisplayFeed()`: cookie → 240/min por IP (varias TVs detrás del mismo router de la clínica) → sesión → 30/min
 * por pantalla → feed → latido (`touchDisplaySeen`) → renovación deslizante de la cookie (> 30 días).
 * Nunca tira: un error inesperado → `unavailable` (la TV muestra «Reconectando…» y reintenta).
 */
import { cookies, headers } from "next/headers";
import { prismaService as prisma } from "@/lib/db";
import { clientIp } from "@/lib/client-ip";
import { rateLimitAll } from "@/lib/rate-limit";
import { auditInTx } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { toARDateKey } from "@/lib/datetime-ar";
import { TENANT_ACCESS_SELECT } from "@/lib/tenant-access";
import { publicSurfacesOpenFor } from "@/lib/public-booking-internal";
import { modulesFor, parseModuleOverrides } from "@/lib/tenant-modules";
import { hashDeviceSecret, hashPairingCode, makeDisplayCookie, newDeviceSecret } from "@/lib/display-pairing-internal";
import { loadDisplayFeed, readDisplayCookie, resolveDisplaySession, touchDisplaySeen } from "@/lib/display-device-internal";
import type { ActionResult } from "@/lib/validation";
import {
  DISPLAY_COOKIE,
  DISPLAY_COOKIE_MAX_AGE_S,
  DISPLAY_COOKIE_PATH,
  PAIR_FAILED_MESSAGE,
  PairDisplaySchema,
  normalizePairingCode,
  type DeviceFeedResult,
  type PairDisplayInput,
} from "@/lib/reception-displays-types";

const MIN = 60_000;
const PAIR_FAIL = { ok: false as const, error: PAIR_FAILED_MESSAGE };

class PairRaceLost extends Error {}

function setDisplayCookie(value: string): void {
  cookies().set(DISPLAY_COOKIE, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: DISPLAY_COOKIE_PATH,
    maxAge: DISPLAY_COOKIE_MAX_AGE_S,
  });
}

export async function pairDisplay(input: PairDisplayInput): Promise<ActionResult> {
  try {
    const h = headers();
    const ip = clientIp(h);
    const rl = await rateLimitAll([
      { key: `tv:pair:ip:10m:${ip}`, limit: 10, windowMs: 10 * MIN },
      { key: `tv:pair:ip:1h:${ip}`, limit: 30, windowMs: 60 * MIN },
    ]);
    if (!rl.ok) return PAIR_FAIL;

    const parsed = PairDisplaySchema.safeParse(input);
    if (!parsed.success) return PAIR_FAIL;
    const code = normalizePairingCode(parsed.data.code);
    if (!code) return PAIR_FAIL;

    const now = new Date();
    const codeHash = hashPairingCode(code);
    const row = await prisma.receptionDisplay.findFirst({
      where: { pairingCodeHash: codeHash, pairingExpiresAt: { gt: now }, revokedAt: null },
      select: {
        id: true,
        tenantId: true,
        tenant: {
          select: {
            vertical: true,
            saasPlan: true,
            publicBookingEnabled: true,
            moduleGrants: true,
            moduleRevokes: true,
            ...TENANT_ACCESS_SELECT,
          },
        },
      },
    });
    if (!row) return PAIR_FAIL;
    const t = row.tenant;
    if (!publicSurfacesOpenFor(t, now)) return PAIR_FAIL;
    const modules = modulesFor({
      vertical: t.vertical,
      plan: t.saasPlan,
      publicBookingEnabled: t.publicBookingEnabled,
      ...parseModuleOverrides(t),
    });
    if (!modules.has("salaEspera")) return PAIR_FAIL;

    const secret = newDeviceSecret();
    await prisma.$transaction(async (tx) => {
      const n = await tx.$executeRaw`
        UPDATE "ReceptionDisplay"
        SET "deviceSecretHash" = ${hashDeviceSecret(secret)}, "pairingCodeHash" = NULL, "pairingExpiresAt" = NULL,
            "pairedAt" = ${now}, "lastSeenAt" = ${now}
        WHERE "id" = ${row.id} AND "tenantId" = ${row.tenantId} AND "pairingCodeHash" = ${codeHash}
          AND "pairingExpiresAt" > ${now} AND "revokedAt" IS NULL`;
      if (n !== 1) throw new PairRaceLost();
      // Sin código ni secreto en el payload (el audit lo lee el staff y Plataforma).
      await auditInTx(tx, {
        tenantId: row.tenantId,
        action: "display.paired",
        entity: "ReceptionDisplay",
        entityId: row.id,
        ip: clientIp(h, null),
        userAgent: h.get("user-agent")?.slice(0, 255) ?? null,
      });
    });

    setDisplayCookie(makeDisplayCookie(row.id, secret, toARDateKey(now)));
    return { ok: true, data: undefined };
  } catch (e) {
    if (!(e instanceof PairRaceLost)) {
      try {
        logger.error("tv.pair_failed", { errName: e instanceof Error ? e.name : typeof e });
      } catch {
        // el log no rompe el mensaje único
      }
    }
    return PAIR_FAIL;
  }
}

export async function getDisplayFeed(): Promise<DeviceFeedResult> {
  try {
    const c = readDisplayCookie();
    if (!c) return { ok: false, state: "unpaired" };
    // Primero el tope por IP (sin tocar la base: frena el martilleo con cookies inventadas) y el de la pantalla
    // recién con la sesión válida: así nadie que solo conozca un id le agota el cupo a la TV de otra IP.
    const ipRl = await rateLimitAll([{ key: `tv:feed:ip:${clientIp(headers())}`, limit: 240, windowMs: MIN }]);
    if (!ipRl.ok) return { ok: false, state: "rate_limited" };

    const now = new Date();
    const s = await resolveDisplaySession(now);
    if (s.state !== "paired") return { ok: false, state: s.state };
    const displayRl = await rateLimitAll([{ key: `tv:feed:display:${s.displayId}`, limit: 30, windowMs: MIN }]);
    if (!displayRl.ok) return { ok: false, state: "rate_limited" };

    const feed = await loadDisplayFeed(s, now);
    await touchDisplaySeen(s, now);
    if (s.renewCookie) {
      // Misma identidad y mismo secreto, día nuevo. En un render de Server Component `cookies().set` tira: la
      // renovación queda para el próximo poll (que sí es una action) y el feed sale igual.
      try {
        setDisplayCookie(makeDisplayCookie(c.id, c.secret, toARDateKey(now)));
      } catch {
        // sin renovar esta vez
      }
    }
    return { ok: true, feed };
  } catch (e) {
    try {
      logger.error("tv.feed_failed", { errName: e instanceof Error ? e.name : typeof e });
    } catch {
      // nunca tira
    }
    return { ok: false, state: "unavailable" };
  }
}
