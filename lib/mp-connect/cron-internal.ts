import "server-only";
import { Prisma } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { mpConnectMode } from "@/lib/env";
import { logger } from "@/lib/logger";
import { auditInTx } from "@/lib/audit";
import { notify, notifyTenantOwners } from "@/lib/notifications-internal";
import { mpCredentialAad, openSecret, sealSecret, sealedKid, SecretBoxError } from "@/lib/secret-box";
import { refreshTokens } from "@/lib/mp-connect/oauth-client";
import { expirePreferencesBestEffort } from "@/lib/mp-connect/account-client";
import { markAccountReauthRequired, restoreActiveAfterRefresh } from "@/lib/mp-connect/accounts-internal";
import { MP_CONNECT_COPY } from "@/lib/online-payments-copy";
import { MY_MP_TAB, ONLINE_PAYMENTS_TAB } from "@/lib/mp-connect-types";
import { ONLINE_PAYMENTS_AUDIT } from "@/lib/online-payments-types";

/**
 * [TP-2h] Etapa `mp_connect` del cron diario (C-TP13, plan §25.4). La corre `runDaily` (lib/cron-jobs-internal.ts)
 * después de `health_digest`; superficie SIN Actor que cruza consultorios → `prismaService` con `tenantId` a mano en
 * cada escritura (AGENTS §4; `MpAccount`/`MpCredential` solo se escriben por el canal service, ADR-026).
 *
 * Qué hace, en este orden:
 *   1. **Refresh** (solo con el modo ≠ off): las credenciales de cuentas ACTIVE con el access token a menos de 30 días
 *      de vencer (MP lo da por 180 días con refresh ROTATIVO: el refresh viejo deja de servir apenas se usa). CAS sobre
 *      `MpCredential.version`: si otro (el webhook por `withAccountToken`, o la rotación de claves) cambió la fila
 *      mientras tanto, no se pisa. `invalid_grant` → la cuenta pasa a REAUTH_REQUIRED + aviso «Reconectá tu Mercado
 *      Pago» + audit `mpAccount.reauth_required` (actor nulo), UNA vez: el UPDATE exige `status = ACTIVE` y la misma
 *      `version` que se leyó; si otro refrescó primero (su refresh nos dejó el nuestro inválido), no se marca.
 *   2. **Vencidos**: cobros ACTIVE con `expiresAt` hace más de 5 min → EXPIRED (los 5 min cubren un pago aprobado en
 *      el último segundo cuyo webhook todavía no llegó: igual entraría, el guard deja pasar EXPIRED → PAID, pero así el
 *      staff no ve «Vencido» y enseguida «Pagado»). Y cobros ACTIVE (links y, desde TP-ZF1, también TURNERO) de turnos
 *      CANCELLED/NO_SHOW → CANCELLED (`booking_cancelled`) + vencer su preferencia en MP (best effort, después del
 *      commit). Red de seguridad: cancelar / ausente desde la agenda y la Sala ya los anula en su tx (TP-ZF1 M3); esto
 *      cubre los caminos que no (cancelación masiva de un plan, `cancelBookingsInTx`).
 *   3. **Purga**: credenciales con `purgeAfter` pasado (desconectar = +7 días), de cuentas no ACTIVE y sin cobros
 *      vivos (ACTIVE/AUTHORIZED: un pago en proceso todavía necesita el token para volver a pedirlo). Va DESPUÉS de los
 *      vencidos a propósito (el contrato los lista al revés): así un cobro vencido hoy no deja la credencial para
 *      mañana y dos corridas seguidas hacen lo mismo que una.
 *
 * Contrato del cron (BO5-A): **idempotente** (todo es «llevar a un estado»: la segunda corrida no encuentra nada),
 * **acotado** (`take` por paso y presupuesto de tiempo → `truncated`, sigue mañana) y **nunca tira** por una cuenta: se
 * cuenta en `errors` y se sigue. Nunca loguea tokens ni sobres: solo ids, conteos y el código de error.
 */
export type MpConnectCronResult = {
  refreshed: number;
  reauth: number;
  purged: number;
  expired: number;
  linksCancelled: number;
  errors: number;
  truncated: boolean;
};

const DAY_MS = 86_400_000;
/** Refrescar con menos de 30 días: holgura de sobra si el cron falla varios días seguidos. */
export const MP_REFRESH_WINDOW_MS = 30 * DAY_MS;
/** Gracia antes de marcar EXPIRED (ver arriba). */
export const MP_EXPIRE_GRACE_MS = 5 * 60_000;
const REFRESH_TAKE = 50;
const PURGE_TAKE = 200;
const EXPIRE_TAKE = 500;

function errCode(err: unknown): string {
  if (err instanceof SecretBoxError) return `secret_box:${err.code}`;
  if (err instanceof Prisma.PrismaClientKnownRequestError) return `prisma:${err.code}`;
  return err instanceof Error ? err.name : "unknown";
}

type DueCredential = {
  id: string;
  tenantId: string;
  mpAccountId: string;
  refreshTokenBox: string;
  version: number;
  mpAccount: { kind: "PRACTITIONER" | "CLINIC"; practitionerId: string | null; mpUserId: string };
};

/**
 * `invalid_grant` → REAUTH_REQUIRED con CAS. Devuelve true solo si ESTA corrida la marcó (el aviso y el audit salen
 * una vez). La condición sobre `version` es lo que distingue «el usuario revocó la app en MP» de «perdí la carrera
 * contra otro refresh que ya rotó el token».
 */
export async function markMpAccountReauthRequired(o: {
  tenantId: string;
  accountId: string;
  credentialVersion: number;
  now: Date;
  source: "cron" | "webhook";
}): Promise<boolean> {
  // TP-2i: una sola implementación (la de accounts-internal, que también usa `withAccountToken`).
  return (await markAccountReauthRequired(o)).marked;
}

/** «Reconectá tu Mercado Pago»: al profesional dueño de la cuenta, o al Titular/Admin si es la del consultorio. */
async function notifyReauth(c: DueCredential): Promise<void> {
  const base = { kind: "SYSTEM" as const, title: MP_CONNECT_COPY.reauthTitle, body: MP_CONNECT_COPY.reauthBody };
  if (c.mpAccount.kind === "CLINIC" || !c.mpAccount.practitionerId) {
    await notifyTenantOwners({ tenantId: c.tenantId, ...base, link: `/configuracion?tab=${ONLINE_PAYMENTS_TAB}` });
    return;
  }
  const prac = await prismaService.practitioner.findFirst({
    where: { id: c.mpAccount.practitionerId, tenantId: c.tenantId },
    select: { userId: true },
  });
  if (prac?.userId) await notify({ tenantId: c.tenantId, userId: prac.userId, ...base, link: `/configuracion?tab=${MY_MP_TAB}` });
}

type RefreshOutcome = "refreshed" | "reauth" | "lost" | "error";

async function refreshOne(c: DueCredential, now: Date): Promise<RefreshOutcome> {
  let refreshToken: string;
  try {
    refreshToken = openSecret(c.refreshTokenBox, mpCredentialAad(c.mpAccountId, "refreshToken"));
  } catch (err) {
    logger.warn("cron.mp_connect.open_failed", { accountId: c.mpAccountId, error: errCode(err) });
    return "error";
  }

  const r = await refreshTokens(refreshToken);
  if ("error" in r) {
    if (r.error === "invalid_grant") {
      const marked = await markMpAccountReauthRequired({
        tenantId: c.tenantId,
        accountId: c.mpAccountId,
        credentialVersion: c.version,
        now,
        source: "cron",
      });
      if (!marked) return "lost";
      await notifyReauth(c);
      return "reauth";
    }
    // MP caído o respuesta rara: se reintenta mañana (quedan días de margen). Sin tocar `version`.
    await prismaService.mpCredential.updateMany({
      where: { id: c.id, tenantId: c.tenantId, version: c.version },
      data: { refreshFailures: { increment: 1 } },
    });
    logger.warn("cron.mp_connect.refresh_failed", { accountId: c.mpAccountId, error: r.error });
    return "error";
  }
  // Un refresh que devuelve OTRA cuenta de MP no se guarda: los cobros de esta fila son de `mpUserId`.
  if (r.userId !== c.mpAccount.mpUserId) {
    logger.error("cron.mp_connect.refresh_user_mismatch", { accountId: c.mpAccountId });
    return "error";
  }

  const accessTokenBox = sealSecret(r.accessToken, mpCredentialAad(c.mpAccountId, "accessToken"));
  const refreshTokenBox = sealSecret(r.refreshToken, mpCredentialAad(c.mpAccountId, "refreshToken"));
  const keyId = sealedKid(accessTokenBox);
  if (!keyId) return "error";
  const data = {
    accessTokenBox,
    refreshTokenBox,
    keyId,
    accessExpiresAt: new Date(now.getTime() + r.expiresIn * 1000),
    lastRefreshedAt: now,
    refreshFailures: 0,
  };

  let version = c.version;
  // Dos intentos: el segundo solo si `version` cambió pero el refresh guardado sigue siendo el mismo que usamos (algún
  // escritor que sube `version` sin rotar el refresh). Si cambió porque otro refrescó, sus tokens son los buenos.
  // TP-ZF1 (B5, corrige el comentario anterior): el RE-SELLADO de la rotación de claves (`resealMpCredentials`) NO sube
  // `version` (CAS por version + cajas; ver lib/secret-box-rotate-internal.ts), así que no hace fallar este CAS: si el
  // re-sellado entró antes, este UPDATE lo pisa con cajas selladas con la clave VIGENTE (lo mismo que buscaba el
  // re-sellado); si entra después, su CAS por cajas da conflicto y lo reintenta la próxima corrida.
  for (let attempt = 0; attempt < 2; attempt++) {
    const n = await prismaService.mpCredential.updateMany({
      where: { id: c.id, tenantId: c.tenantId, version, purgeAfter: null },
      data: { ...data, version: version + 1 },
    });
    if (n.count === 1) {
      // TP-ZF1 (B5): un REAUTH marcado por un `invalid_grant` de NUESTRA rotación (carrera) se deshace acá.
      // Best effort: los tokens ya quedaron guardados; si esto falla, la cuenta sigue en REAUTH como antes del fix.
      await restoreActiveAfterRefresh({ tenantId: c.tenantId, accountId: c.mpAccountId, credentialVersion: version + 1 }).catch(
        (err) => logger.warn("cron.mp_connect.reauth_restore_failed", { accountId: c.mpAccountId, error: errCode(err) })
      );
      return "refreshed";
    }
    const cur = await prismaService.mpCredential.findFirst({
      where: { id: c.id, tenantId: c.tenantId },
      select: { version: true, refreshTokenBox: true, purgeAfter: true },
    });
    if (!cur || cur.purgeAfter) return "lost";
    let same = false;
    try {
      same = openSecret(cur.refreshTokenBox, mpCredentialAad(c.mpAccountId, "refreshToken")) === refreshToken;
    } catch {
      same = false;
    }
    if (!same) return "lost";
    version = cur.version;
  }
  return "lost";
}

/**
 * `opts.tenantIds` (extensión aditiva del contrato C-TP13): acota la corrida a esos consultorios. Para los tests de
 * integración, que comparten la base local con otras sesiones: sin esto, un test del cron refrescaría (y marcaría
 * REAUTH, porque el MP falso es por proceso) las cuentas de los fixtures de otro test que corre al mismo tiempo. El
 * cron real (`runDaily`) no lo pasa.
 */
export async function runMpConnectMaintenance(
  now: Date,
  budgetMs = 8_000,
  opts: { tenantIds?: readonly string[] } = {}
): Promise<MpConnectCronResult> {
  const scope = opts.tenantIds ? { tenantId: { in: [...opts.tenantIds] } } : {};
  const out: MpConnectCronResult = { refreshed: 0, reauth: 0, purged: 0, expired: 0, linksCancelled: 0, errors: 0, truncated: false };
  // Reloj real (no `now`): el presupuesto es de la ejecución, no del día lógico.
  const deadline = Date.now() + budgetMs;
  const overBudget = () => Date.now() > deadline;
  const mode = mpConnectMode();

  // ── 1. Refresh ──
  if (mode !== "off") {
    const due = await prismaService.mpCredential.findMany({
      where: {
        ...scope,
        accessExpiresAt: { lt: new Date(now.getTime() + MP_REFRESH_WINDOW_MS) },
        purgeAfter: null,
        mpAccount: { status: "ACTIVE" },
      },
      orderBy: [{ accessExpiresAt: "asc" }, { id: "asc" }],
      take: REFRESH_TAKE,
      select: {
        id: true,
        tenantId: true,
        mpAccountId: true,
        refreshTokenBox: true,
        version: true,
        mpAccount: { select: { kind: true, practitionerId: true, mpUserId: true } },
      },
    });
    if (due.length === REFRESH_TAKE) out.truncated = true;
    for (const c of due) {
      if (overBudget()) {
        out.truncated = true;
        break;
      }
      try {
        const r = await refreshOne(c, now);
        if (r === "refreshed") out.refreshed++;
        else if (r === "reauth") out.reauth++;
        else if (r === "error") out.errors++;
      } catch (err) {
        out.errors++;
        logger.warn("cron.mp_connect.refresh_error", { accountId: c.mpAccountId, error: errCode(err) });
      }
    }
  }

  // ── 2. Vencidos y links de turnos cancelados ──
  if (!overBudget()) {
    try {
      const cutoff = new Date(now.getTime() - MP_EXPIRE_GRACE_MS);
      const stale = await prismaService.onlineCharge.findMany({
        where: { ...scope, status: "ACTIVE", expiresAt: { lt: cutoff } },
        orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
        take: EXPIRE_TAKE,
        select: { id: true },
      });
      if (stale.length === EXPIRE_TAKE) out.truncated = true;
      if (stale.length) {
        // El `where` repite las condiciones: entre el SELECT y el UPDATE un webhook pudo pagarlo.
        const r = await prismaService.onlineCharge.updateMany({
          where: { id: { in: stale.map((s) => s.id) }, status: "ACTIVE", expiresAt: { lt: cutoff } },
          data: { status: "EXPIRED" },
        });
        out.expired = r.count;
      }
    } catch (err) {
      out.errors++;
      logger.warn("cron.mp_connect.expire_failed", { error: errCode(err) });
    }
  } else out.truncated = true;

  if (!overBudget()) {
    try {
      const orphan = await prismaService.onlineCharge.findMany({
        where: { ...scope, origin: { in: ["LINK", "TURNERO"] }, status: "ACTIVE", booking: { status: { in: ["CANCELLED", "NO_SHOW"] } } },
        orderBy: { id: "asc" },
        take: EXPIRE_TAKE,
        select: { id: true, tenantId: true },
      });
      if (orphan.length === EXPIRE_TAKE) out.truncated = true;
      const byTenant = new Map<string, string[]>();
      for (const o of orphan) byTenant.set(o.tenantId, [...(byTenant.get(o.tenantId) ?? []), o.id]);
      for (const [tenantId, chargeIds] of byTenant) {
        const r = await prismaService.onlineCharge.updateMany({
          where: {
            id: { in: chargeIds },
            tenantId,
            origin: { in: ["LINK", "TURNERO"] },
            status: "ACTIVE",
            booking: { status: { in: ["CANCELLED", "NO_SHOW"] } },
          },
          data: { status: "CANCELLED", cancelledAt: now, cancelReason: "booking_cancelled" },
        });
        out.linksCancelled += r.count;
        // Después del commit y best effort: si MP falla, el cobro ya no se acepta igual (guard + consumidor).
        if (r.count && mode !== "off") {
          try {
            await expirePreferencesBestEffort(tenantId, chargeIds);
          } catch (err) {
            logger.warn("cron.mp_connect.expire_preferences_failed", { tenantId, error: errCode(err) });
          }
        }
      }
    } catch (err) {
      out.errors++;
      logger.warn("cron.mp_connect.cancel_links_failed", { error: errCode(err) });
    }
  } else out.truncated = true;

  // ── 3. Purga ── (siempre, también con el modo off: es borrar secretos que ya no se usan)
  if (!overBudget()) {
    try {
      const purgeable = await prismaService.mpCredential.findMany({
        where: {
          ...scope,
          purgeAfter: { lt: now },
          mpAccount: { status: { not: "ACTIVE" }, charges: { none: { status: { in: ["ACTIVE", "AUTHORIZED"] } } } },
        },
        orderBy: [{ purgeAfter: "asc" }, { id: "asc" }],
        take: PURGE_TAKE,
        select: { id: true },
      });
      if (purgeable.length === PURGE_TAKE) out.truncated = true;
      if (purgeable.length) {
        const r = await prismaService.mpCredential.deleteMany({
          where: {
            id: { in: purgeable.map((p) => p.id) },
            purgeAfter: { lt: now },
            mpAccount: { status: { not: "ACTIVE" }, charges: { none: { status: { in: ["ACTIVE", "AUTHORIZED"] } } } },
          },
        });
        out.purged = r.count;
      }
    } catch (err) {
      out.errors++;
      logger.warn("cron.mp_connect.purge_failed", { error: errCode(err) });
    }
  } else out.truncated = true;

  logger.info("cron.mp_connect", { mode, ...out });
  return out;
}
