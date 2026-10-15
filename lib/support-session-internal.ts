import "server-only";
/**
 * Sesión de soporte (BO2-E, contrato C-BO9, plan §19.5; decisión 3 de Martin del 14-oct).
 *
 * «Entrar como soporte» abre el consultorio destino con un actor SINTÉTICO (rama de soporte de `buildActor`,
 * lib/session.ts): capacidades de Secretaria sin clínico (`SUPPORT_CAPS`), transacciones en solo lectura salvo las
 * actions de Configuración de la allowlist (`withSupportWritable`, C-BO4), banda visible y registro en el
 * consultorio. **Sin vencimiento** (decisión de Martin): termina con «Salir de soporte» o al cerrar sesión. Por eso
 * no hay `expiresAt` ni en la fila (M7) ni en la cookie.
 *
 * Dos piezas, y las dos tienen que estar:
 *  - la fila `SupportSession` abierta (`endedAt` NULL): es lo que ve el OWNER y lo que se cierra al salir. El índice
 *    parcial único de M7 deja UNA abierta por superadmin: empezar otra cierra la anterior en la misma tx.
 *  - la cookie firmada `kine_support` (`<sessionId>.<userId>.<hmac>`, patrón de lib/recovery-cookie.ts): ata la
 *    fila a ESTE navegador y a ESTE usuario. Un flag suelto lo podría setear cualquiera con la sesión de un
 *    superadmin; firmada con el userId, una cookie copiada a otra cuenta no vale.
 * `resolveSupportSession` exige las dos más el superadmin vigente (`isPlatformAdmin` y no deshabilitado). Una cookie
 * ajena, alterada o de una fila cerrada se ignora y se borra.
 *
 * Canal: `prismaService`. `SupportSession` es TENANT_READONLY (M7: solo una policy SELECT por tenant); la abre y la
 * cierra la plataforma, que cruza consultorios. La doble auditoría (`auditPlatformInTx`) también exige el canal
 * service (`PlatformAuditEvent` es SERVICE_ONLY).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies, headers } from "next/headers";
import { clientIp } from "@/lib/client-ip";
import type { Prisma, SaasPlan, TenantStatus, TenantVertical, SubscriptionStatus } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { auditPlatformInTx } from "@/lib/audit";
import { getVerifiedSessionUser } from "@/lib/session-user";
import { sendEmail } from "@/lib/email";
import "@/lib/email/log";
import { supportAccessEmail } from "@/lib/email/templates";
import type { PlatformActor } from "@/lib/platform-actor";
import type { PlatformActorRef } from "@/lib/platform-audit-types";

export const SUPPORT_COOKIE = "kine_support";

/**
 * Sin vencimiento de la SESIÓN (decisión de Martin), pero el navegador necesita un `maxAge`: sin él la cookie es de
 * sesión del navegador y, al cerrarlo, el soporte se cortaba en silencio con la fila abierta (el OWNER la vería «en
 * curso» para siempre). 400 días es el tope que aceptan los navegadores; en la práctica la corta «Salir de soporte»
 * o el logout, que además cierran la fila.
 */
const SUPPORT_COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;

/** Motivo: lo mismo que el CHECK de M7 (`length(btrim(reason)) BETWEEN 10 AND 500`). */
export const SUPPORT_REASON_MIN = 10;
export const SUPPORT_REASON_MAX = 500;

/** El soporte no se abre (copy en voseo; se muestra tal cual en /plataforma). */
export class SupportSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupportSessionError";
  }
}

// ── Cookie firmada ────────────────────────────────────────────────────────────────────────────────────────────

let devKey: Buffer | null = null;
/** Misma derivación que lib/recovery-cookie.ts, con su propia etiqueta (una cookie no sirve por la otra). */
function hmacKey(): Buffer {
  const base = env.SUPABASE_SERVICE_ROLE_KEY;
  if (base) return createHmac("sha256", base).update("kinesoft:support-cookie:v1").digest();
  devKey ??= randomBytes(32);
  return devKey;
}

function sign(sessionId: string, userId: string): string {
  return createHmac("sha256", hmacKey()).update(`${sessionId}.${userId}`).digest("base64url");
}

export function makeSupportCookieValue(sessionId: string, userId: string): string {
  return `${sessionId}.${userId}.${sign(sessionId, userId)}`;
}

/** El `sessionId` si la cookie es de ESTE usuario y la firmamos nosotros; si no, null. */
export function parseSupportCookie(value: string | null | undefined, userId: string): string | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [sessionId, uid, mac] = parts;
  if (!sessionId || uid !== userId) return null;
  const expected = Buffer.from(sign(sessionId, uid));
  const got = Buffer.from(mac);
  return expected.length === got.length && timingSafeEqual(expected, got) ? sessionId : null;
}

function readCookie(): string | null {
  try {
    return cookies().get(SUPPORT_COOKIE)?.value ?? null;
  } catch {
    return null; // fuera de un request
  }
}

/**
 * Borrar la cookie solo se puede en una action o un route handler; en el render de un Server Component Next tira.
 * Ahí se ignora: la cookie inválida igual no abre nada (se re-valida en cada request) y se borra en la próxima action.
 */
function deleteCookieQuietly(): void {
  try {
    cookies().delete(SUPPORT_COOKIE);
  } catch {
    // render de RSC
  }
}

function setCookie(value: string): void {
  cookies().set(SUPPORT_COOKIE, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SUPPORT_COOKIE_MAX_AGE_S,
  });
}

// ── Resolver (lo usa la rama de soporte de buildActor) ─────────────────────────────────────────────────────────

/** Lo que la rama de soporte de `buildActor` necesita del consultorio destino (misma forma que `AccessMembership.tenant`). */
export type SupportTarget = {
  sessionId: string;
  tenantId: string;
  superadminEmail: string;
  tenant: {
    id: string;
    slug: string;
    name: string;
    vertical: TenantVertical;
    /** PL-1e: el plan SaaS (`Tenant.saasPlan`), igual que `AccessMembership.tenant.plan`. */
    plan: SaasPlan;
    publicBookingEnabled: boolean;
    status: TenantStatus;
    subscriptionStatus: SubscriptionStatus;
    trialEndsAt: Date | null;
    subscriptionStatusChangedAt: Date | null;
  };
};

/**
 * Sin cookie: null y CERO queries (el resto de los usuarios no paga nada por el soporte; el techo de sentencias de
 * createBooking es estricto). Con cookie: una lectura (fila abierta + superadmin vigente + consultorio).
 *
 * Se ignora (null) y se borra la cookie si: no es de este usuario o está alterada; la fila no existe, está cerrada
 * o es de otro superadmin; el usuario ya no es superadmin o está deshabilitado; el consultorio fue dado de baja.
 * Si el superadmin es MIEMBRO del consultorio destino, se ignora sin borrar: ahí entra con su rol (y
 * `startSupportSession` no lo deja abrir), así nunca hay dos identidades para el mismo usuario en un consultorio.
 */
export async function resolveSupportTarget(userId: string): Promise<SupportTarget | null> {
  const raw = readCookie();
  if (!raw) return null;
  const sessionId = parseSupportCookie(raw, userId);
  if (!sessionId) {
    logger.warn("support.cookie_rejected", { userId });
    deleteCookieQuietly();
    return null;
  }
  const row = await prismaService.supportSession.findFirst({
    where: {
      id: sessionId,
      superadminId: userId,
      endedAt: null,
      superadmin: { isPlatformAdmin: true, disabledAt: null },
    },
    select: {
      id: true,
      tenantId: true,
      superadmin: { select: { email: true } },
      tenant: {
        select: {
          id: true,
          slug: true,
          name: true,
          vertical: true,
          saasPlan: true,
          publicBookingEnabled: true,
          status: true,
          subscriptionStatus: true,
          trialEndsAt: true,
          subscriptionStatusChangedAt: true,
          memberships: { where: { userId }, select: { id: true } },
        },
      },
    },
  });
  if (!row || row.tenant.status === "CLOSED") {
    deleteCookieQuietly();
    return null;
  }
  if (row.tenant.memberships.length > 0) return null;
  const { memberships: _m, saasPlan, ...rest } = row.tenant;
  // PL-1e: el actor de soporte se arma con `membership: null` (lib/session.ts `buildSupportActor`): no es miembro.
  return {
    sessionId: row.id,
    tenantId: row.tenantId,
    superadminEmail: row.superadmin.email,
    tenant: { ...rest, plan: saasPlan },
  };
}

/** C-BO9: cookie válida + fila abierta + superadmin vigente. */
export async function resolveSupportSession(userId: string): Promise<{ sessionId: string; tenantId: string } | null> {
  const t = await resolveSupportTarget(userId);
  return t ? { sessionId: t.sessionId, tenantId: t.tenantId } : null;
}

/** Un usuario que NO es superadmin (o está deshabilitado) con la cookie: se ignora y se borra. Sin cookie, nada. */
export function discardSupportCookieIfPresent(): void {
  if (readCookie()) deleteCookieQuietly();
}

// ── Empezar y terminar ─────────────────────────────────────────────────────────────────────────────────────────

function requestMeta(): { ip: string | null; userAgent: string | null } {
  // Del contexto no: `requirePlatformAdmin` no pasa por buildActor y no hay RequestContext. De los headers del request.
  try {
    const h = headers();
    return { ip: clientIp(h, null), userAgent: h.get("user-agent")?.slice(0, 300) ?? null };
  } catch {
    return { ip: null, userAgent: null };
  }
}

/** Cierra en la tx las sesiones abiertas del superadmin (a lo sumo una, M7) y audita cada cierre en su consultorio. */
async function closeOpenSessionsInTx(
  tx: Prisma.TransactionClient,
  actor: PlatformActorRef & { userId: string },
  endedReason: "exit" | "logout" | "replaced",
  now: Date
): Promise<Array<{ id: string; tenantId: string }>> {
  const open = await tx.supportSession.findMany({
    where: { superadminId: actor.userId, endedAt: null },
    select: { id: true, tenantId: true, startedAt: true },
  });
  if (open.length === 0) return [];
  await tx.supportSession.updateMany({
    where: { id: { in: open.map((o) => o.id) }, endedAt: null },
    data: { endedAt: now, endedReason },
  });
  for (const o of open) {
    await auditPlatformInTx(tx, {
      actor,
      affectedTenantId: o.tenantId,
      action: "platform.support.end",
      entity: "SupportSession",
      entityId: o.id,
      payload: { endedReason, durationMin: Math.round((now.getTime() - o.startedAt.getTime()) / 60_000) },
    });
  }
  return open.map(({ id, tenantId }) => ({ id, tenantId }));
}

/**
 * C-BO9. Abre el soporte: cierra la sesión abierta anterior de este superadmin (una por superadmin), crea la fila,
 * audita en el consultorio y en el registro global (misma tx: las tres cosas o ninguna), setea la cookie y, después
 * del commit, le manda el mail al OWNER (nunca tira: un mail que no sale no deshace el acceso; queda en EmailLog).
 *
 * El motivo NO va al payload del registro (es texto libre; el registro es solo inserción y un dato sensible que
 * entre no se borra): queda en la fila, que es lo que ve el OWNER, y en su mail.
 */
export async function startSupportSession(p: {
  actor: PlatformActor;
  tenantId: string;
  reason: string;
}): Promise<{ sessionId: string }> {
  const reason = p.reason.trim();
  if (reason.length < SUPPORT_REASON_MIN || reason.length > SUPPORT_REASON_MAX) {
    throw new SupportSessionError(`Contá el motivo (entre ${SUPPORT_REASON_MIN} y ${SUPPORT_REASON_MAX} caracteres).`);
  }
  const actorRef = { userId: p.actor.userId, email: p.actor.email, homeTenantId: p.actor.homeTenantId };
  const meta = requestMeta();
  const now = new Date();

  let result: { sessionId: string; tenantName: string };
  try {
    result = await prismaService.$transaction(async (tx) => {
      // BO-Z (C2): dos «Entrar como soporte» simultáneos del mismo superadmin (doble clic, dos pestañas) leían las dos
      // «ninguna abierta» y la segunda chocaba con el índice parcial único de M7 (una abierta por superadmin) → P2002
      // sin atrapar = error genérico. El lock serializa por superadmin: la segunda espera, cierra la de la primera
      // («replaced») y abre la suya. Se suelta en el COMMIT/ROLLBACK.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`kinesoft:support-session:${p.actor.userId}`}, 0))`;
      const tenant = await tx.tenant.findUnique({
        where: { id: p.tenantId },
        select: { id: true, name: true, status: true, memberships: { where: { userId: p.actor.userId }, select: { id: true } } },
      });
      if (!tenant) throw new SupportSessionError("No encontramos ese consultorio.");
      if (tenant.status === "CLOSED") throw new SupportSessionError("El consultorio está dado de baja: no se puede entrar como soporte.");
      if (tenant.memberships.length > 0) {
        throw new SupportSessionError("Ya sos parte de este consultorio: entrá con tu usuario desde el selector de consultorios.");
      }
      await closeOpenSessionsInTx(tx, actorRef, "replaced", now);
      const session = await tx.supportSession.create({
        data: {
          tenantId: tenant.id,
          superadminId: p.actor.userId,
          reason,
          startedAt: now,
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        select: { id: true },
      });
      await auditPlatformInTx(tx, {
        actor: actorRef,
        affectedTenantId: tenant.id,
        action: "platform.support.start",
        entity: "SupportSession",
        entityId: session.id,
        // BO4: `mfa` deja asentado si la sesión que entró al consultorio pasó por TOTP (con
        // PLATFORM_MFA_ENFORCEMENT=off se permite igual y queda `false`: es la huella para revisar después).
        payload: { scope: "ADMIN_CONFIG", reasonLength: reason.length, mfa: p.actor.mfa },
      });
      return { sessionId: session.id, tenantName: tenant.name };
    });
  } catch (err) {
    // Red de seguridad del lock: si igual choca con el índice único (otra puerta que abra filas sin el lock), copy
    // controlado en vez del genérico de Next.
    if ((err as { code?: string } | null)?.code === "P2002") {
      throw new SupportSessionError("Ya estabas entrando como soporte en otra pestaña. Probá de nuevo.");
    }
    throw err;
  }

  setCookie(makeSupportCookieValue(result.sessionId, p.actor.userId));
  await notifyOwners({
    tenantId: p.tenantId,
    tenantName: result.tenantName,
    sessionId: result.sessionId,
    superadminEmail: p.actor.email,
    superadminId: p.actor.userId,
    startedAt: now,
  });
  return { sessionId: result.sessionId };
}

/**
 * C-BO9. Cierra la sesión de soporte del usuario de la sesión y borra la cookie. Cierra TODAS las abiertas de este
 * superadmin (a lo sumo una), con o sin cookie válida: al cerrar sesión desde otro navegador la fila igual se cierra.
 * Idempotente: sin sesión de soporte abierta no hace nada (salvo borrar la cookie).
 */
export async function endSupportSession(reason: "exit" | "logout"): Promise<void> {
  deleteCookieQuietly();
  const user = await getVerifiedSessionUser();
  if (!user) return;
  // Import dinámico: lib/session.ts importa este módulo (rama de soporte); estático sería un ciclo.
  const { getAccessSnapshot } = await import("@/lib/session");
  const snap = await getAccessSnapshot();
  const homeTenantId = snap?.state.kind === "ok" ? snap.state.tenantId : null;
  await prismaService.$transaction((tx) =>
    closeOpenSessionsInTx(tx, { userId: user.id, email: user.email ?? null, homeTenantId }, reason, new Date())
  );
}

// ── Lista de Configuración («Accesos de soporte») ──────────────────────────────────────────────────────────────

/** DTO con lista CERRADA de campos (invariante de BO): nada del superadmin salvo su email. */
export type SupportSessionRow = {
  id: string;
  superadminEmail: string;
  reason: string;
  startedAt: string;
  endedAt: string | null;
  endedReason: string | null;
  open: boolean;
};

export function toSupportSessionRow(r: {
  id: string;
  reason: string;
  startedAt: Date;
  endedAt: Date | null;
  endedReason: string | null;
  superadmin: { email: string };
}): SupportSessionRow {
  return {
    id: r.id,
    superadminEmail: r.superadmin.email,
    reason: r.reason,
    startedAt: r.startedAt.toISOString(),
    endedAt: r.endedAt ? r.endedAt.toISOString() : null,
    endedReason: r.endedReason,
    open: r.endedAt === null,
  };
}

// ── Mail al OWNER ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * BO2-E: plantilla de la casa (`supportAccessEmail`, lib/email/templates.ts) con motivo GENÉRICO: el motivo que
 * tipeó el superadmin no viaja por mail (nota interna); el OWNER lo ve en Configuración → Accesos de soporte.
 */
async function notifyOwners(p: {
  tenantId: string;
  tenantName: string;
  sessionId: string;
  superadminEmail: string;
  superadminId: string;
  startedAt: Date;
}): Promise<void> {
  try {
    const owners = await prismaService.membership.findMany({
      where: { tenantId: p.tenantId, role: "OWNER", acceptedAt: { not: null }, disabledAt: null },
      select: { user: { select: { email: true } } },
    });
    const mail = supportAccessEmail({
      tenantName: p.tenantName,
      superadminEmail: p.superadminEmail,
      startedAt: p.startedAt,
      // BO3-F: directo a la pestaña «Accesos de soporte» (components/configuracion/controls.tsx lee `?tab=`).
      url: `${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}/configuracion?tab=soporte`,
    });
    for (const o of owners) {
      await sendEmail({
        ...mail,
        kind: "support_access",
        to: o.user.email,
        tenantId: p.tenantId,
        entity: "SupportSession",
        entityId: p.sessionId,
        actorId: p.superadminId,
      });
    }
  } catch (err) {
    // `sendEmail` no tira; esto es la lectura de los OWNER. El acceso ya está abierto y auditado.
    logger.warn("support.owner_mail_failed", { tenantId: p.tenantId, error: err instanceof Error ? err.name : "unknown" });
  }
}
