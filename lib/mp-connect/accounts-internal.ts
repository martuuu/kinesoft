import "server-only";
import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { auditInTx } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { mpCredentialAad, sealSecret, sealedKid } from "@/lib/secret-box";
import { ONLINE_PAYMENTS_AUDIT } from "@/lib/online-payments-types";
import { MP_ACCOUNT_NONE, type MpAccountView, type MpConnectMode } from "@/lib/mp-connect-types";
import type { MpTokenSet } from "@/lib/mp-connect/oauth-client";
import type { MpAccountRef } from "@/lib/mp-connect/account-client";

/**
 * Escrituras y lecturas de cuentas de Mercado Pago por el canal service (T5, C-TP4 del plan §25.4; ADR-026, precedente
 * ADR-024). TP-2b.
 *
 * Por qué el canal service: `MpAccount` es solo SELECT para `kinesoft_app` y `MpCredential` no tiene policy (M18). Las
 * escriben SOLO el callback OAuth, desconectar, la delegación y el cron. Sin RLS que ayude, `tenantId` va A MANO en
 * cada `where` (en prod la conexión tiene BYPASSRLS: es la única barrera) y quien llama ya validó al actor.
 *
 * - Conectar: sella los tokens con `mpCredentialAad(accountId, …)`; la misma cuenta MP conserva `webhookRef` (las
 *   preferencias viejas siguen notificando a la URL de siempre); otra cuenta deja la vieja DISCONNECTED con
 *   `purgeAfter` +7 días; `in_use` si la cuenta MP ya está viva para OTRO profesional del consultorio (la del
 *   consultorio puede coincidir con la de un profesional, decisión del plan §25.4).
 * - Desconectar: anula los cobros ACTIVE de la cuenta (`account_disconnected`) y programa la purga a 7 días. Vencer las
 *   preferencias en MP lo hace el caller DESPUÉS del commit (`expirePreferencesBestEffort`).
 * - Ningún token en logs ni en audit: acá solo pasan sellados.
 */

/** Ventana para conciliar pagos tardíos con la credencial de una cuenta desconectada (§25.4). */
export const MP_CREDENTIAL_PURGE_DAYS = 7;
const DAY_MS = 86_400_000;

const REF_SELECT = { id: true, tenantId: true, kind: true, status: true, mpUserId: true, webhookRef: true } as const;

/** 128 bits opacos para `?acct=` (CHECK `MpAccount_webhookRef_check`: 22 caracteres base64url). */
function newWebhookRef(): string {
  return randomBytes(16).toString("base64url");
}

function sealTokens(accountId: string, tokens: Pick<MpTokenSet, "accessToken" | "refreshToken">) {
  const accessTokenBox = sealSecret(tokens.accessToken, mpCredentialAad(accountId, "accessToken"));
  const refreshTokenBox = sealSecret(tokens.refreshToken, mpCredentialAad(accountId, "refreshToken"));
  const keyId = sealedKid(accessTokenBox);
  if (!keyId) throw new Error("[mp-connect] el sobre sellado no tiene kid");
  return { accessTokenBox, refreshTokenBox, keyId };
}

/** `owner` en Prisma: `practitionerId` del profesional, o `null` (= la del consultorio). */
function ownerWhere(target: "own" | "clinic", practitionerId: string | null): { practitionerId: string | null } {
  return { practitionerId: target === "clinic" ? null : practitionerId };
}

export type SaveConnectedAccountInput = {
  tenantId: string;
  target: "own" | "clinic";
  /** `own`: el profesional del actor; `clinic`: null. */
  practitionerId: string | null;
  connectedByUserId: string;
  tokens: MpTokenSet;
  nickname: string | null;
};
export type SaveConnectedAccountResult =
  | {
      ok: true;
      accountId: string;
      replacedAccountId: string | null;
      /** ¿Era la misma cuenta de MP (conservó `webhookRef`)? */
      sameMpAccount: boolean;
      /** Cobros ACTIVE de la cuenta reemplazada que quedaron anulados: el caller vence sus preferencias tras el commit. */
      cancelledChargeIds: string[];
    }
  | { ok: false; error: "in_use" | "error" };

class InUse extends Error {}

export async function saveConnectedAccount(input: SaveConnectedAccountInput): Promise<SaveConnectedAccountResult> {
  const { tenantId, target, connectedByUserId, tokens } = input;
  const practitionerId = target === "clinic" ? null : input.practitionerId;
  if (target === "own" && !practitionerId) return { ok: false, error: "error" };
  // Mismas cotas que los CHECK de M18 (`MpAccount_mpUserId_check`, `_text_check`): MP no debería mandar otra cosa,
  // pero un 23514 en el medio del callback sería un «error» opaco; así es un error con nombre en el log.
  if (!/^[0-9]{1,20}$/.test(tokens.userId)) {
    logger.warn("mp_connect.connect.bad_user_id", { tenantId, target });
    return { ok: false, error: "error" };
  }
  const nickname = input.nickname ? input.nickname.trim().slice(0, 100) || null : null;
  const publicKey = tokens.publicKey && tokens.publicKey.length <= 200 ? tokens.publicKey : null;
  const now = new Date();
  const accessExpiresAt = new Date(now.getTime() + tokens.expiresIn * 1000);

  try {
    return await prismaService.$transaction(async (tx) => {
      // `in_use`: la cuenta de MP ya cobra para OTRO profesional del consultorio. Dos profesionales con la misma cuenta
      // harían imposible saber a quién imputar un pago (y el «cobra cada uno en su cuenta» de §22.1 #5 dejaría de ser
      // cierto). La del consultorio sí puede ser la de un profesional (el Titular que atiende con su propia cuenta).
      if (target === "own") {
        const taken = await tx.mpAccount.findFirst({
          where: {
            tenantId,
            kind: "PRACTITIONER",
            mpUserId: tokens.userId,
            status: { not: "DISCONNECTED" },
            practitionerId: { not: practitionerId },
          },
          select: { id: true },
        });
        if (taken) throw new InUse();
      }

      const owner = ownerWhere(target, practitionerId);
      const live = await tx.mpAccount.findFirst({
        where: { tenantId, ...owner, status: { not: "DISCONNECTED" } },
        select: { id: true, mpUserId: true },
      });

      let replacedAccountId: string | null = null;
      let cancelledChargeIds: string[] = [];
      // Misma cuenta de MP: la viva, o la última desconectada del mismo dueño (reconectar después de desconectar).
      let reuse: { id: string } | null = null;
      if (live && live.mpUserId === tokens.userId) {
        reuse = { id: live.id };
      } else {
        if (live) {
          // Otra cuenta de MP: la vieja queda DISCONNECTED y su credencial se purga a 7 días (conciliar tardíos).
          const d = await disconnectInTx(tx, { tenantId, accountId: live.id, byUserId: connectedByUserId, now });
          replacedAccountId = live.id;
          cancelledChargeIds = d.cancelledChargeIds;
        }
        reuse = await tx.mpAccount.findFirst({
          where: { tenantId, ...owner, mpUserId: tokens.userId, status: "DISCONNECTED" },
          orderBy: { disconnectedAt: "desc" },
          select: { id: true },
        });
      }

      let accountId: string;
      if (reuse) {
        accountId = reuse.id;
        // Conserva `webhookRef` (y la delegación si estaba viva): reconectar no rompe las notificaciones de las
        // preferencias ya emitidas. `disconnected*` en null: lo exige `MpAccount_status_check` para ACTIVE.
        await tx.mpAccount.updateMany({
          where: { id: accountId, tenantId },
          data: {
            status: "ACTIVE",
            mpNickname: nickname,
            liveMode: tokens.liveMode,
            publicKey,
            connectedByUserId,
            connectedAt: now,
            reauthRequiredAt: null,
            disconnectedAt: null,
            disconnectedByUserId: null,
          },
        });
      } else {
        const created = await tx.mpAccount.create({
          data: {
            tenantId,
            practitionerId,
            kind: target === "clinic" ? "CLINIC" : "PRACTITIONER",
            mpUserId: tokens.userId,
            mpNickname: nickname,
            liveMode: tokens.liveMode,
            publicKey,
            webhookRef: newWebhookRef(),
            linksDelegated: false,
            status: "ACTIVE",
            connectedByUserId,
            connectedAt: now,
          },
          select: { id: true },
        });
        accountId = created.id;
      }

      // El AAD lleva el id de la cuenta: el sobre solo abre en ESTA fila y ESTE campo.
      const sealed = sealTokens(accountId, tokens);
      const credData = {
        ...sealed,
        accessExpiresAt,
        lastRefreshedAt: null,
        refreshFailures: 0,
        purgeAfter: null,
      };
      const existingCred = await tx.mpCredential.findFirst({ where: { mpAccountId: accountId, tenantId }, select: { id: true } });
      if (existingCred) {
        // `version + 1`: un refresh en vuelo con la credencial vieja pierde el CAS y no pisa los tokens nuevos.
        await tx.mpCredential.updateMany({
          where: { id: existingCred.id, tenantId },
          data: { ...credData, version: { increment: 1 } },
        });
      } else {
        await tx.mpCredential.create({ data: { tenantId, mpAccountId: accountId, ...credData } });
      }

      // Sin tokens ni ids de MP: alcanza con qué cuenta de la app quedó y si reemplazó a otra.
      await auditInTx(tx, {
        tenantId,
        actorId: connectedByUserId,
        action: ONLINE_PAYMENTS_AUDIT.mpAccountConnect,
        entity: "MpAccount",
        entityId: accountId,
        payload: {
          target,
          practitionerId,
          sameMpAccount: reuse !== null,
          replacedAccountId,
          cancelledCharges: cancelledChargeIds.length,
          liveMode: tokens.liveMode,
        },
      });

      return { ok: true as const, accountId, replacedAccountId, sameMpAccount: reuse !== null, cancelledChargeIds };
    });
  } catch (err) {
    if (err instanceof InUse) return { ok: false, error: "in_use" };
    // Dos callbacks a la vez para el mismo dueño: el índice parcial deja pasar uno; el otro no escribe nada.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      logger.warn("mp_connect.connect.race", { tenantId, target });
      return { ok: false, error: "error" };
    }
    logger.error("mp_connect.connect.failed", { tenantId, target, error: (err as Error)?.name });
    return { ok: false, error: "error" };
  }
}

/**
 * Desconecta dentro de la tx del caller: anula los cobros ACTIVE de la cuenta, la deja DISCONNECTED sin delegación y
 * programa la purga de la credencial. No toma el turno: pasar de ACTIVE a CANCELLED no dispara el sync de la seña
 * (solo entra/sale de PAID), así que no hay orden de locks que respetar con el webhook.
 */
async function disconnectInTx(
  tx: Prisma.TransactionClient,
  o: { tenantId: string; accountId: string; byUserId: string; now: Date }
): Promise<{ cancelledChargeIds: string[]; cancelledLinks: number }> {
  const live = await tx.onlineCharge.findMany({
    where: { tenantId: o.tenantId, mpAccountId: o.accountId, status: "ACTIVE" },
    select: { id: true, origin: true },
  });
  let cancelled: { id: string; origin: string }[] = [];
  if (live.length > 0) {
    // `status: ACTIVE` otra vez en el UPDATE: un webhook que lo pasó a PAID en el medio gana (un pago aprobado
    // siempre se registra) y ese cobro no cuenta como anulado.
    const ids = live.map((c) => c.id);
    await tx.onlineCharge.updateMany({
      where: { tenantId: o.tenantId, id: { in: ids }, status: "ACTIVE" },
      data: { status: "CANCELLED", cancelledAt: o.now, cancelledByUserId: o.byUserId, cancelReason: "account_disconnected" },
    });
    const done = await tx.onlineCharge.findMany({
      where: { tenantId: o.tenantId, id: { in: ids }, status: "CANCELLED", cancelReason: "account_disconnected", cancelledAt: o.now },
      select: { id: true, origin: true },
    });
    cancelled = done;
  }
  await tx.mpAccount.updateMany({
    where: { id: o.accountId, tenantId: o.tenantId, status: { not: "DISCONNECTED" } },
    data: { status: "DISCONNECTED", disconnectedAt: o.now, disconnectedByUserId: o.byUserId, linksDelegated: false },
  });
  await tx.mpCredential.updateMany({
    where: { mpAccountId: o.accountId, tenantId: o.tenantId },
    data: { purgeAfter: new Date(o.now.getTime() + MP_CREDENTIAL_PURGE_DAYS * DAY_MS) },
  });
  return { cancelledChargeIds: cancelled.map((c) => c.id), cancelledLinks: cancelled.filter((c) => c.origin === "LINK").length };
}

export type DisconnectAccountResult = { ok: true; cancelledLinks: number; cancelledChargeIds: string[] } | { ok: false; error: "not_found" };

export async function disconnectAccountInternal(o: {
  tenantId: string;
  accountId: string;
  byUserId: string;
}): Promise<DisconnectAccountResult> {
  return prismaService.$transaction(async (tx) => {
    const acc = await tx.mpAccount.findFirst({
      where: { id: o.accountId, tenantId: o.tenantId, status: { not: "DISCONNECTED" } },
      select: { id: true, kind: true, practitionerId: true },
    });
    if (!acc) return { ok: false as const, error: "not_found" as const };
    const now = new Date();
    const d = await disconnectInTx(tx, { ...o, now });
    await auditInTx(tx, {
      tenantId: o.tenantId,
      actorId: o.byUserId,
      action: ONLINE_PAYMENTS_AUDIT.mpAccountDisconnect,
      entity: "MpAccount",
      entityId: acc.id,
      payload: { kind: acc.kind, practitionerId: acc.practitionerId, cancelledCharges: d.cancelledChargeIds.length, cancelledLinks: d.cancelledLinks },
    });
    return { ok: true as const, cancelledLinks: d.cancelledLinks, cancelledChargeIds: d.cancelledChargeIds };
  });
}

/**
 * Delegación de links (§25.4, TP-D12): solo la cuenta viva. Devuelve si cambió (sin cambio no se audita).
 * El dueño lo valida el caller (el profesional la suya; el Titular la del consultorio).
 */
export async function setLinksDelegatedInternal(o: {
  tenantId: string;
  accountId: string;
  delegated: boolean;
  byUserId: string;
}): Promise<{ ok: true; changed: boolean } | { ok: false; error: "not_found" }> {
  return prismaService.$transaction(async (tx) => {
    const acc = await tx.mpAccount.findFirst({
      where: { id: o.accountId, tenantId: o.tenantId, status: { not: "DISCONNECTED" } },
      select: { id: true, linksDelegated: true },
    });
    if (!acc) return { ok: false as const, error: "not_found" as const };
    if (acc.linksDelegated === o.delegated) return { ok: true as const, changed: false };
    const u = await tx.mpAccount.updateMany({
      where: { id: acc.id, tenantId: o.tenantId, status: { not: "DISCONNECTED" } },
      data: { linksDelegated: o.delegated },
    });
    if (u.count === 0) return { ok: false as const, error: "not_found" as const };
    await auditInTx(tx, {
      tenantId: o.tenantId,
      actorId: o.byUserId,
      action: ONLINE_PAYMENTS_AUDIT.mpAccountDelegation,
      entity: "MpAccount",
      entityId: acc.id,
      payload: { from: acc.linksDelegated, to: o.delegated },
    });
    return { ok: true as const, changed: true };
  });
}

/** La cuenta viva del dueño (`own` = la del profesional; `clinic` = la del consultorio), o null. */
export async function findLiveAccount(o: {
  tenantId: string;
  target: "own" | "clinic";
  practitionerId: string | null;
}): Promise<(MpAccountRef & { linksDelegated: boolean }) | null> {
  if (o.target === "own" && !o.practitionerId) return null;
  return prismaService.mpAccount.findFirst({
    where: { tenantId: o.tenantId, ...ownerWhere(o.target, o.practitionerId), status: { not: "DISCONNECTED" } },
    select: { ...REF_SELECT, linksDelegated: true },
  });
}

/**
 * Webhook: la cuenta por `?acct=` (único global). Desconocida → null → 200 ignorado. Devuelve también las
 * DISCONNECTED: un pago tardío a una cuenta desconectada se registra igual (la credencial vive 7 días para eso).
 */
export async function findAccountByWebhookRef(webhookRef: string): Promise<MpAccountRef | null> {
  if (typeof webhookRef !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(webhookRef)) return null;
  return prismaService.mpAccount.findUnique({ where: { webhookRef }, select: REF_SELECT });
}

/**
 * La cuenta con la que se cobra (turnero y links): la del profesional ACTIVE → la del consultorio si `useClinicAccount`
 * → ninguna. **Nunca la de la plataforma** (cierra H-TP1). REAUTH_REQUIRED no cobra: crear la preferencia fallaría
 * igual y el turnero tiene que reservar sin cobro (TP-D8).
 */
export async function resolveChargeAccount(o: {
  tenantId: string;
  practitionerId: string;
  useClinicAccount: boolean;
}): Promise<(MpAccountRef & { linksDelegated: boolean; practitionerId: string | null }) | null> {
  const select = { ...REF_SELECT, linksDelegated: true, practitionerId: true } as const;
  const own = await prismaService.mpAccount.findFirst({
    where: { tenantId: o.tenantId, practitionerId: o.practitionerId, status: "ACTIVE" },
    select,
  });
  if (own) return own;
  if (!o.useClinicAccount) return null;
  return prismaService.mpAccount.findFirst({ where: { tenantId: o.tenantId, practitionerId: null, status: "ACTIVE" }, select });
}

/**
 * `invalid_grant` al refrescar → REAUTH_REQUIRED. CAS sobre la versión de la credencial: si cambió, otro request
 * refrescó entre la lectura y el canje (el refresh token es rotativo) y el `invalid_grant` es por eso, no por una
 * revocación → `superseded`, no se marca. El aviso «Reconectá tu Mercado Pago» lo manda el cron (TP-2h).
 *
 * TP-2i: es la ÚNICA implementación (antes había dos: esta con `updateMany` y la del cron con SQL crudo). Queda la del
 * cron porque el `status = 'ACTIVE'` y la versión se re-evalúan sobre la fila bloqueada: dos marcadores a la vez no
 * marcan (ni auditan) dos veces. `markMpAccountReauthRequired` (cron-internal) delega acá; la dirección es esta y no
 * la inversa porque cron-internal ya importa este módulo por `account-client` (al revés quedaba un ciclo).
 * `superseded` = la credencial ya no está en `credentialVersion` (leída con `FOR UPDATE`).
 */
export async function markAccountReauthRequired(o: {
  tenantId: string;
  accountId: string;
  credentialVersion: number;
  now?: Date;
  source?: "cron" | "webhook" | "request";
}): Promise<{ marked: boolean; superseded: boolean }> {
  const now = o.now ?? new Date();
  const source = o.source ?? "request";
  return prismaService.$transaction(async (tx) => {
    // 1. La credencial `FOR UPDATE` ANTES de decidir: si otro request está commiteando su refresh (CAS sobre `version`),
    //    se espera y se lee la versión commiteada (READ COMMITTED re-lee tras el lock). Un EXISTS sin lock leía la
    //    versión vieja en esa carrera y marcaba REAUTH a una cuenta sana (lo vio tp2o-mp-connect con el rol owner).
    //    Orden de locks: credencial → cuenta (el mismo que tenía esta función antes de TP-2i).
    const [cred] = await tx.$queryRaw<{ version: number }[]>`
      SELECT "version" FROM "MpCredential"
       WHERE "mpAccountId" = ${o.accountId} AND "tenantId" = ${o.tenantId}
       FOR UPDATE`;
    if (!cred) return { marked: false, superseded: false };
    if (cred.version !== o.credentialVersion) return { marked: false, superseded: true };
    // 2. SQL crudo y no `updateMany`: el `status = 'ACTIVE'` se re-evalúa sobre la fila bloqueada si dos marcadores
    //    corren a la vez (el segundo no la marca de nuevo ni audita dos veces). Las columnas son TIMESTAMP sin zona en
    //    UTC: el parámetro pasa a UTC explícito (molde de lib/dashboard.ts).
    const n = await tx.$executeRaw`
      UPDATE "MpAccount" a
         SET "status" = 'REAUTH_REQUIRED',
             "reauthRequiredAt" = (${now}::timestamptz AT TIME ZONE 'UTC'),
             "updatedAt" = (${now}::timestamptz AT TIME ZONE 'UTC')
       WHERE a."id" = ${o.accountId} AND a."tenantId" = ${o.tenantId} AND a."status" = 'ACTIVE'`;
    if (n !== 1) return { marked: false, superseded: false };
    await tx.mpCredential.updateMany({
      where: { mpAccountId: o.accountId, tenantId: o.tenantId },
      data: { refreshFailures: { increment: 1 } },
    });
    await auditInTx(tx, {
      tenantId: o.tenantId,
      action: ONLINE_PAYMENTS_AUDIT.mpAccountReauthRequired,
      entity: "MpAccount",
      entityId: o.accountId,
      payload: { accountId: o.accountId, source },
    });
    logger.warn("mp_connect.reauth_required", { tenantId: o.tenantId, accountId: o.accountId, source });
    return { marked: true, superseded: false };
  });
}

// ── Vistas (sin tokens, sin `webhookRef`, sin `mpUserId`: C-TP4) ────────────────────────────────────────────────────

type AccountViewRow = {
  status: "ACTIVE" | "REAUTH_REQUIRED" | "DISCONNECTED";
  mpNickname: string | null;
  liveMode: boolean;
  linksDelegated: boolean;
  connectedAt: Date;
  disconnectedAt: Date | null;
};

const VIEW_SELECT = {
  status: true,
  mpNickname: true,
  liveMode: true,
  linksDelegated: true,
  connectedAt: true,
  disconnectedAt: true,
} as const;

/** «Cuenta de prueba» / «Simulador local»: una cuenta que no es de producción nunca se ve como si cobrara de verdad. */
export function mpAccountViewOf(row: AccountViewRow | null, mode: MpConnectMode): MpAccountView {
  if (!row) return MP_ACCOUNT_NONE;
  return {
    status: row.status,
    nickname: row.mpNickname,
    connectedAt: row.connectedAt.toISOString(),
    disconnectedAt: row.disconnectedAt ? row.disconnectedAt.toISOString() : null,
    linksDelegated: row.linksDelegated,
    badge: row.liveMode ? null : mode === "fake" ? "fake" : "sandbox",
  };
}

/**
 * La cuenta que se le muestra a cada dueño: la viva, o la última desconectada (para el «Desconectada el …»), o
 * ninguna. Por el canal service con `tenantId` a mano (misma barrera que el resto de este módulo).
 */
export async function loadAccountViews(o: {
  tenantId: string;
  practitionerIds: string[];
  includeClinic: boolean;
}): Promise<{ clinic: AccountViewRow | null; byPractitioner: Map<string, AccountViewRow> }> {
  const ownerFilter: Prisma.MpAccountWhereInput[] = [];
  if (o.practitionerIds.length > 0) ownerFilter.push({ practitionerId: { in: o.practitionerIds } });
  if (o.includeClinic) ownerFilter.push({ practitionerId: null });
  const byPractitioner = new Map<string, AccountViewRow>();
  if (ownerFilter.length === 0) return { clinic: null, byPractitioner };
  const rows = await prismaService.mpAccount.findMany({
    where: { tenantId: o.tenantId, OR: ownerFilter },
    orderBy: [{ connectedAt: "desc" }],
    select: { ...VIEW_SELECT, practitionerId: true },
  });
  let clinic: AccountViewRow | null = null;
  const better = (cur: AccountViewRow | null | undefined, next: AccountViewRow) =>
    !cur || (cur.status === "DISCONNECTED" && next.status !== "DISCONNECTED");
  for (const r of rows) {
    if (r.practitionerId === null) {
      if (better(clinic, r)) clinic = r;
    } else if (better(byPractitioner.get(r.practitionerId), r)) {
      byPractitioner.set(r.practitionerId, r);
    }
  }
  return { clinic, byPractitioner };
}
