import "server-only";
/**
 * Consumidores de Mercado Pago de la suscripción (C-MPS7, MPS-2b1). Todos vuelven a pedir el recurso a MP con el token
 * de la PLATAFORMA (`lib/mercadopago-saas.ts`) antes de confiar en el webhook: el cuerpo de la notificación solo trae
 * un id, y lo único que vale es lo que MP contesta con nuestro token. Nunca llaman a MP dentro de una tx: GET afuera →
 * tx corta del canal service adentro → mails y sync DESPUÉS del commit.
 *
 * Orden de locks: Tenant → Subscription → Charge → Payment → Adjustment (`lockTenant`/`lockSubscription` del núcleo;
 * los de cargos y pagos los toma el núcleo al imputar).
 *
 * Idempotencia (MP reenvía, y manda `payment` + `authorized_payment` del mismo débito en orden libre):
 *   - un pago de MP = una fila: se busca por `mpPaymentId` (UNIQUE) y, para un débito, por `mpAuthorizedPaymentId`
 *     (el reintento de un débito rechazado reusa el authorized_payment con un pago nuevo: la fila REJECTED pasa a
 *     APPROVED con el id del pago nuevo);
 *   - el chequeo va ADENTRO de la tx, con el Tenant y la suscripción bloqueados: dos webhooks del mismo consultorio se
 *     serializan; un P2002 del INSERT concurrente se reintenta UNA vez (la segunda vuelta ve la fila);
 *   - `nextSaasPaymentStatus` decide la transición: el mismo estado otra vez (o uno imposible, como un rechazo tardío
 *     de un aprobado) → `replay`, sin escribir ni mandar mails.
 *
 * MPS-D15: solo aprobado, rechazado y reintegrado crean o cambian filas (`mapMpPaymentStatus`); pendiente → `ignored`.
 */
import { Prisma, type SaasPaymentSource, type SaasPaymentStatus } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { formatARS } from "@/lib/format";
import { logger } from "@/lib/logger";
import { toARDateKey } from "@/lib/datetime-ar";
import { auditPlatformGlobalInTx, type PlatformActorRef } from "@/lib/audit";
import {
  lockSubscription,
  lockTenant,
  notifyPaymentReceived,
  recomputeSubscriptionStatusInTx,
  imputeApprovedPaymentInTx as coreImputeApprovedPaymentInTx,
  refundPaymentTreeInTx as coreRefundPaymentTreeInTx,
} from "@/lib/saas-billing-internal";
import { dbDateFromKey, periodFor, type DateKey } from "@/lib/saas-billing-logic";
import {
  mapMpPaymentStatus,
  nextSaasPaymentStatus,
  parseSaasExternalReference,
  periodStartForDebit,
  redactMpSaas,
} from "@/lib/saas-mp-logic";
import {
  getAuthorizedPayment,
  getPreapproval,
  getSaasPayment,
  platformCollectorId,
  updatePreapproval,
  type SaasMpErrorKind,
  type SaasPayment,
  type SaasPreapproval,
} from "@/lib/mercadopago-saas";

type Tx = Prisma.TransactionClient;

/** Quién disparó el consumo (cambia solo logs/audit; `legacy` además tira ante un error, ver `finish`). */
export type SaasMpConsumeSource = "webhook" | "legacy" | "reconcile" | "return";

export type SaasMpConsumeOpts = { now?: Date; source?: SaasMpConsumeSource };

/**
 * `applied|replay|mismatch|ignored` igual que la rama `?acct=` (el simulador lee `result`). `retry` = MP caído o base
 * ocupada: la ruta contesta 503 y MP reintenta.
 */
export type SaasMpConsumeResult =
  | { ok: true; result: "applied" | "replay" | "mismatch" | "ignored"; tenantId: string | null }
  | { ok: false; reason: "retry" | "db_error"; tenantId: string | null };

/** Actor de los audits de Plataforma que escribe el webhook (sin usuario: lo hizo el sistema). */
const SYSTEM_ACTOR: PlatformActorRef = { userId: null, email: null, homeTenantId: null };

// ── Resultados y errores ─────────────────────────────────────────────────────────────────────────────────────────

const ok = (result: "applied" | "replay" | "mismatch" | "ignored", tenantId: string | null): SaasMpConsumeResult => ({
  ok: true,
  result,
  tenantId,
});

/**
 * Error del puerto → resultado. `off` (cobro con MP apagado) e `invalid` (respuesta que no se entiende) → ignorado: un
 * 503 haría que MP reintente días algo que no va a cambiar; la conciliación diaria (MPS-2b2) levanta lo que quede.
 * 404 → ignorado (el recurso no es de la cuenta de la plataforma). 401/403/429, 5xx, red y timeout → `retry`: es un
 * problema nuestro o pasajero de MP, y el pago no se puede perder.
 */
function portFailure(e: { kind: SaasMpErrorKind; status?: number }, tenantId: string | null): SaasMpConsumeResult {
  if (e.kind === "off" || e.kind === "invalid") return ok("ignored", tenantId);
  if (e.kind === "http" && e.status !== undefined && e.status >= 400 && e.status < 500 && ![401, 403, 429].includes(e.status)) {
    return ok("ignored", tenantId);
  }
  return { ok: false, reason: "retry", tenantId };
}

/**
 * El camino LEGADO (`consumeWebhook` de `lib/mercadopago.ts`, que delega por la referencia `saas:`) contesta siempre
 * 200 con lo que devuelva el consumidor: un `retry` ahí no haría que MP reintente. Por eso con `source: "legacy"` un
 * error TIRA, y la ruta legada contesta 500 como cuando falla el SDK (MP reintenta).
 */
function finish(r: SaasMpConsumeResult, source: SaasMpConsumeSource): SaasMpConsumeResult {
  if (!r.ok && source === "legacy") throw new Error(`saas_mp.${r.reason}`);
  return r;
}

function isP2002(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

/** Corre la tx y reintenta UNA vez ante P2002 (INSERT concurrente del mismo pago: la segunda vuelta ve la fila). */
async function txWithRetry<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await prismaService.$transaction(fn);
  } catch (e) {
    if (!isP2002(e)) throw e;
    return prismaService.$transaction(fn);
  }
}

/** Efecto después del commit (mail, sync con MP): nunca tumba el webhook, que ya escribió lo importante. */
async function afterCommit(what: string, tenantId: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    logger.warn("saas_mp.after_commit_failed", { what, tenantId, error: err instanceof Error ? err.name : "unknown" });
  }
}

async function sendMpMail(...args: Parameters<typeof import("@/lib/saas-billing-mail-internal").sendSaasBillingMpMail>) {
  const { sendSaasBillingMpMail } = await import("@/lib/saas-billing-mail-internal");
  return sendSaasBillingMpMail(...args);
}

async function syncAfterCommit(tenantId: string) {
  const { syncSaasMpAfterCommit } = await import("@/lib/saas-mp-sync-internal");
  return syncSaasMpAfterCommit(tenantId);
}

/** Collector de la plataforma: el pago tiene que ser de esta cuenta (un pago de otro vendedor con `saas:` no se imputa). */
async function checkCollector(collectorId: string | null, tenantId: string | null): Promise<SaasMpConsumeResult | null> {
  const col = await platformCollectorId();
  if (!col.ok) return portFailure(col, tenantId);
  if (collectorId !== col.data) {
    logger.warn("saas_mp.collector_mismatch", { tenantId });
    return ok("mismatch", tenantId);
  }
  return null;
}

/** `mpPayload` desde lo que ya parseó el puerto (el puerto no expone el JSON crudo), pasado por la allow-list. */
function paymentPayload(p: SaasPayment): Record<string, unknown> {
  return redactMpSaas({
    id: p.id,
    status: p.status,
    transaction_amount: p.amountCents / 100,
    transaction_amount_refunded: p.refundedCents / 100,
    currency_id: p.currencyId ?? undefined,
    external_reference: p.externalReference ?? undefined,
    collector_id: p.collectorId ?? undefined,
    preapproval_id: p.preapprovalId ?? undefined,
    date_approved: p.approvedAt?.toISOString(),
  });
}

// ── Escritura común de un pago de MP ─────────────────────────────────────────────────────────────────────────────

type IncomingPayment = {
  tenantId: string;
  pay: SaasPayment;
  status: SaasPaymentStatus;
  source: Extract<SaasPaymentSource, "MP_AUTO" | "MP_CHECKOUT">;
  authorizedPaymentId: string | null;
  preapprovalId: string | null;
  /** Checkout: el cargo de la referencia. Débito: el período de `periodStartForDebit`. */
  target: { chargeId: string } | { periodStart: DateKey };
  now: Date;
};

type WriteOutcome =
  | { kind: "ignored" | "replay" | "mismatch" }
  | { kind: "applied"; paymentId: string; status: SaasPaymentStatus; amountCents: number; amountMismatch: boolean };

const ROW_SELECT = {
  id: true,
  tenantId: true,
  status: true,
  mpPaymentId: true,
  mpAuthorizedPaymentId: true,
} as const;

async function writeMpPaymentInTx(tx: Tx, inc: IncomingPayment): Promise<WriteOutcome> {
  const { tenantId, pay, now } = inc;
  if (!(await lockTenant(tx, tenantId))) return { kind: "ignored" };
  await lockSubscription(tx, tenantId);

  // Cargo destino, del mismo consultorio (las FKs saltean RLS y la conexión service también).
  const charge =
    "chargeId" in inc.target
      ? await tx.saasCharge.findFirst({
          where: { id: inc.target.chargeId, tenantId },
          select: { id: true, mpCheckoutExpectedCents: true },
        })
      : await tx.saasCharge.findFirst({
          where: { tenantId, periodStart: dbDateFromKey(inc.target.periodStart) },
          select: { id: true, mpCheckoutExpectedCents: true },
        });
  const targetChargeId = charge?.id ?? null;

  let row = await tx.saasPayment.findUnique({ where: { mpPaymentId: pay.id }, select: ROW_SELECT });
  if (row && row.tenantId !== tenantId) {
    logger.warn("saas_mp.payment_tenant_mismatch", { tenantId });
    return { kind: "mismatch" };
  }
  if (inc.authorizedPaymentId) {
    const byAp = await tx.saasPayment.findUnique({ where: { mpAuthorizedPaymentId: inc.authorizedPaymentId }, select: ROW_SELECT });
    if (byAp && byAp.tenantId !== tenantId) return { kind: "mismatch" };
    if (!row) row = byAp;
    // Llegó primero el topic `payment` (sin el id del débito): se le cuelga el authorized_payment si nadie lo tiene.
    else if (!row.mpAuthorizedPaymentId && !byAp) {
      await tx.saasPayment.update({ where: { id: row.id }, data: { mpAuthorizedPaymentId: inc.authorizedPaymentId } });
    }
  }

  const payload = paymentPayload(pay) as Prisma.InputJsonValue;
  const next = nextSaasPaymentStatus(row?.status ?? null, inc.status);
  if (next === null) return { kind: "replay" };

  if (next === "REFUNDED") {
    if (row) {
      await tx.saasPayment.update({ where: { id: row.id }, data: { mpStatus: pay.status, mpPayload: payload } });
      await refundPaymentTreeInTx(tx, { tenantId, rootId: row.id, now });
      await recomputeSubscriptionStatusInTx(tx, tenantId, now, null);
      return { kind: "applied", paymentId: row.id, status: "REFUNDED", amountCents: pay.amountCents, amountMismatch: false };
    }
    // Reintegro de un pago que nunca vimos aprobado: se registra (historia), sin imputar nada.
    const created = await tx.saasPayment.create({
      data: {
        tenantId,
        chargeId: null,
        source: inc.source,
        method: "MERCADO_PAGO",
        status: "REFUNDED",
        amountCents: pay.amountCents,
        paidAt: pay.approvedAt,
        mpPaymentId: pay.id,
        mpAuthorizedPaymentId: inc.authorizedPaymentId,
        mpPreapprovalId: inc.preapprovalId,
        mpStatus: pay.status,
        mpPayload: payload,
        note: "Reintegro de Mercado Pago de un pago que no se había registrado.",
      },
      select: { id: true },
    });
    return { kind: "applied", paymentId: created.id, status: "REFUNDED", amountCents: pay.amountCents, amountMismatch: false };
  }

  // Monto distinto al del link de pago: se registra IGUAL con el monto real (la plata entró; el núcleo imputa lo que
  // falta y deja el resto a cuenta), con nota y audit de Plataforma para que alguien lo mire. Solo el checkout tiene
  // un monto esperado: el débito puede diferir del cargo a propósito (mínimo de MP, proyección del día 3).
  const expected = inc.source === "MP_CHECKOUT" ? (charge?.mpCheckoutExpectedCents ?? null) : null;
  const amountMismatch = next === "APPROVED" && expected !== null && expected !== pay.amountCents;
  const note = amountMismatch
    ? `Monto distinto al del link de pago: se esperaban ${formatARS(expected)} y llegaron ${formatARS(pay.amountCents)}.`
    : null;

  const data = {
    status: next,
    amountCents: pay.amountCents,
    paidAt: next === "APPROVED" ? (pay.approvedAt ?? now) : null,
    mpPaymentId: pay.id,
    mpStatus: pay.status,
    mpPayload: payload,
    // Nace a cuenta y lo imputa el núcleo (al cargo por lo que le falta; el resto, a cuenta). Un rechazo queda colgado
    // del cargo solo como historia (no suma: el estado mira los APROBADOS).
    chargeId: next === "APPROVED" ? null : targetChargeId,
    ...(note ? { note } : {}),
  };
  let paymentId: string;
  if (row) {
    await tx.saasPayment.update({ where: { id: row.id }, data });
    paymentId = row.id;
  } else {
    const created = await tx.saasPayment.create({
      data: {
        ...data,
        tenantId,
        source: inc.source,
        method: "MERCADO_PAGO",
        mpAuthorizedPaymentId: inc.authorizedPaymentId,
        mpPreapprovalId: inc.preapprovalId,
      },
      select: { id: true },
    });
    paymentId = created.id;
  }

  if (next === "APPROVED") {
    await imputeApprovedPaymentInTx(tx, { tenantId, paymentId, targetChargeId, now });
    await recomputeSubscriptionStatusInTx(tx, tenantId, now, null);
    if (amountMismatch) {
      await auditPlatformGlobalInTx(tx, {
        actor: SYSTEM_ACTOR,
        action: "platform.billing.mp_amount_mismatch",
        entity: "SaasPayment",
        entityId: paymentId,
        tenantId,
        payload: { chargeId: targetChargeId, expectedCents: expected, receivedCents: pay.amountCents },
        idempotencyKey: `saas-mp:amount:${pay.id}`,
      });
    }
  }
  return { kind: "applied", paymentId, status: next, amountCents: pay.amountCents, amountMismatch };
}

/** Tx + mails después del commit; traduce el resultado. */
async function applyMpPayment(inc: IncomingPayment, source: SaasMpConsumeSource): Promise<SaasMpConsumeResult> {
  let out: WriteOutcome;
  try {
    out = await txWithRetry((tx) => writeMpPaymentInTx(tx, inc));
  } catch (err) {
    logger.error("saas_mp.payment_write_failed", { tenantId: inc.tenantId, source, error: err instanceof Error ? err.name : "unknown" });
    return { ok: false, reason: "db_error", tenantId: inc.tenantId };
  }
  if (out.kind !== "applied") return ok(out.kind, inc.tenantId);

  if (out.status === "APPROVED") {
    await afterCommit("payment_received", inc.tenantId, () => notifyPaymentReceived(inc.tenantId, out.paymentId, out.amountCents));
  } else if (out.status === "REJECTED" && inc.source === "MP_AUTO") {
    // ZF1 (revisor ZA de T6+T7): UN aviso por preapproval y período (`billing_debit_failed:<preapproval>:<período>`),
    // no uno por intento: MP recicla el rechazado varias veces en la semana y cada intento es otro pago. Y con la fecha
    // de vencimiento del cargo de ese período (`effectiveOn`): sin ella la plantilla no se arma y el mail no salía.
    const periodStart = "periodStart" in inc.target ? inc.target.periodStart : null;
    await afterCommit("debit_failed", inc.tenantId, () =>
      sendMpMail("billing_debit_failed", inc.tenantId, {
        entity: "SaasPayment",
        entityId: out.paymentId,
        paymentId: out.paymentId,
        amountCents: out.amountCents,
        effectiveOn: periodStart ? periodFor(periodStart).dueDate : null,
        reason: "Mercado Pago rechazó el débito de la tarjeta.",
        idempotencyKey: inc.preapprovalId && periodStart ? `billing_debit_failed:${inc.preapprovalId}:${periodStart}` : null,
      })
    );
  }
  logger.info("saas_mp.payment_applied", { tenantId: inc.tenantId, source, status: out.status, mismatch: out.amountMismatch });
  return ok("applied", inc.tenantId);
}

// ── Consumidores ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Pago de MP (checkout `saas:t:c` o débito): re-fetch, valida collector/ARS/tenant, imputa o deja a cuenta, reintegra; P2002 → 1 reintento. */
export async function consumeSaasMpPayment(mpPaymentId: string, opts?: SaasMpConsumeOpts): Promise<SaasMpConsumeResult> {
  const source = opts?.source ?? "webhook";
  const now = opts?.now ?? new Date();
  const r = await getSaasPayment(mpPaymentId);
  if (!r.ok) return finish(portFailure(r, null), source);
  const pay = r.data;
  const ref = parseSaasExternalReference(pay.externalReference);
  // Sin referencia `saas:` no es de la suscripción (p. ej. un pago de turno legado leído en modo fake): no se toca.
  if (!ref) return ok("ignored", null);
  const bad = await checkCollector(pay.collectorId, ref.tenantId);
  if (bad) return finish(bad, source);
  if (pay.currencyId !== "ARS") {
    logger.warn("saas_mp.currency_mismatch", { tenantId: ref.tenantId });
    return ok("mismatch", ref.tenantId);
  }
  const status = mapMpPaymentStatus(pay.status);
  if (!status) return ok("ignored", ref.tenantId);

  // `saas:<t>:<c>` = link de pago de un cargo; `saas:<t>` = la referencia del preapproval (un débito).
  const isCheckout = ref.chargeId !== null;
  return finish(
    await applyMpPayment(
      {
        tenantId: ref.tenantId,
        pay,
        status,
        source: isCheckout ? "MP_CHECKOUT" : "MP_AUTO",
        authorizedPaymentId: null,
        preapprovalId: isCheckout ? null : pay.preapprovalId,
        target: isCheckout ? { chargeId: ref.chargeId as string } : { periodStart: periodStartForDebit(pay.approvedAt ?? now) },
        now,
      },
      source
    ),
    source
  );
}

/** El consultorio de un preapproval: el actual, el pendiente o el retirado; si no, la referencia `saas:<t>` del preapproval. */
async function tenantOfPreapproval(
  preapprovalId: string
): Promise<{ tenantId: string; pre?: SaasPreapproval } | { fail: SaasMpConsumeResult }> {
  const sub = await prismaService.saasSubscription.findFirst({
    where: {
      OR: [{ mpPreapprovalId: preapprovalId }, { mpPendingPreapprovalId: preapprovalId }, { mpRetiredPreapprovalId: preapprovalId }],
    },
    select: { tenantId: true },
  });
  if (sub) return { tenantId: sub.tenantId };
  const pr = await getPreapproval(preapprovalId);
  if (!pr.ok) return { fail: portFailure(pr, null) };
  const ref = parseSaasExternalReference(pr.data.externalReference);
  if (!ref || ref.chargeId !== null) return { fail: ok("ignored", null) };
  const bad = pr.data.collectorId ? await checkCollector(pr.data.collectorId, ref.tenantId) : null;
  if (bad) return { fail: bad };
  const exists = await prismaService.saasSubscription.findUnique({ where: { tenantId: ref.tenantId }, select: { tenantId: true } });
  if (!exists) return { fail: ok("ignored", ref.tenantId) };
  return { tenantId: ref.tenantId, pre: pr.data };
}

/** Cobro de un preapproval (authorized_payment): busca por preapproval actual/pendiente/retirado y apunta a `periodStartForDebit`. */
export async function consumeSaasAuthorizedPayment(
  authorizedPaymentId: string,
  opts?: SaasMpConsumeOpts
): Promise<SaasMpConsumeResult> {
  const source = opts?.source ?? "webhook";
  const now = opts?.now ?? new Date();
  const r = await getAuthorizedPayment(authorizedPaymentId);
  if (!r.ok) return finish(portFailure(r, null), source);
  const ap = r.data;
  const who = await tenantOfPreapproval(ap.preapprovalId);
  if ("fail" in who) return finish(who.fail, source);
  // Programado (todavía sin pago): no hay plata que registrar.
  if (!ap.payment) return ok("ignored", who.tenantId);

  const pr = await getSaasPayment(ap.payment.id);
  if (!pr.ok) return finish(portFailure(pr, who.tenantId), source);
  const pay = pr.data;
  const bad = await checkCollector(pay.collectorId, who.tenantId);
  if (bad) return finish(bad, source);
  if (pay.currencyId !== "ARS") return ok("mismatch", who.tenantId);
  const status = mapMpPaymentStatus(pay.status);
  if (!status) return ok("ignored", who.tenantId);

  return finish(
    await applyMpPayment(
      {
        tenantId: who.tenantId,
        pay,
        status,
        source: "MP_AUTO",
        authorizedPaymentId: ap.id,
        preapprovalId: ap.preapprovalId,
        // El día del débito (no el de la notificación): un reintento del 6 sigue siendo del período del 4.
        target: { periodStart: periodStartForDebit(ap.debitDate ?? pay.approvedAt ?? now) },
        now,
      },
      source
    ),
    source
  );
}

type PreOutcome =
  | { kind: "ignored" | "replay" }
  | { kind: "promoted"; amountCents: number | null; nextAt: Date | null }
  | { kind: "pending_cleared" }
  | { kind: "pending_refused" }
  | { kind: "recorded" }
  | { kind: "cancelled_by_mp"; amountCents: number | null };

/** Preapproval: `authorized` del pendiente → lo promueve (el viejo a retirado, AUTO_DEBIT); `cancelled` desde MP → apaga el débito + mail. */
export async function consumeSaasPreapproval(preapprovalId: string, opts?: SaasMpConsumeOpts): Promise<SaasMpConsumeResult> {
  const source = opts?.source ?? "webhook";
  const now = opts?.now ?? new Date();
  const pr = await getPreapproval(preapprovalId);
  if (!pr.ok) return finish(portFailure(pr, null), source);
  const pre = pr.data;
  if (pre.collectorId) {
    const bad = await checkCollector(pre.collectorId, null);
    if (bad) return finish(bad, source);
  }
  const who = await tenantOfPreapproval(preapprovalId);
  if ("fail" in who) return finish(who.fail, source);
  const tenantId = who.tenantId;

  let out: PreOutcome;
  try {
    out = await prismaService.$transaction(async (tx): Promise<PreOutcome> => {
      if (!(await lockTenant(tx, tenantId))) return { kind: "ignored" };
      await lockSubscription(tx, tenantId);
      const sub = await tx.saasSubscription.findUnique({
        where: { tenantId },
        select: {
          mpPreapprovalId: true,
          mpPreapprovalStatus: true,
          mpPreapprovalAmountCents: true,
          mpPreapprovalNextAt: true,
          mpPendingPreapprovalId: true,
          mpPendingPayerEmail: true,
          mpRetiredPreapprovalId: true,
          collectionMethod: true,
          autoDebitAllowed: true,
          autoDebitEnabled: true,
          tenant: { select: { subscriptionStatus: true } },
        },
      });
      if (!sub) return { kind: "ignored" };
      const mirror = {
        mpPreapprovalStatus: pre.status,
        mpPreapprovalAmountCents: pre.amountCents,
        mpPreapprovalNextAt: pre.nextPaymentDate,
        mpPreapprovalSyncedAt: now,
      };

      // Adopción: el preapproval es de este consultorio por su referencia, pero no quedó guardado (se cayó el proceso
      // entre el POST a MP y la escritura) y no hay otro vivo → se toma como el pendiente.
      const pendingId =
        sub.mpPendingPreapprovalId ?? (who.pre && !sub.mpPreapprovalId && pre.status === "authorized" ? preapprovalId : null);

      if (preapprovalId === pendingId) {
        if (pre.status === "authorized" && (!sub.autoDebitAllowed || sub.tenant.subscriptionStatus === "CANCELLED")) {
          // ZF1 (revisor ZA de T6+T7): el titular autorizó en MP DESPUÉS de que Plataforma bloqueara el débito o de
          // que la suscripción se diera de baja. No se promueve (sería AUTO_DEBIT con el débito prohibido) ni se avisa
          // «débito activado». Se limpia el pendiente y, después del commit, se cancela en MP: autorizado y sin nadie
          // que lo mire, debitaría igual. Si el lugar del retirado está libre se lo deja ahí: la sync y la conciliación
          // lo re-cancelan si el PUT de abajo falla (sus cobros tardíos se siguen imputando por la referencia).
          await tx.saasSubscription.update({
            where: { tenantId },
            data: {
              mpPendingPreapprovalId: null,
              mpPendingInitPoint: null,
              mpPendingPayerEmail: null,
              mpPendingCreatedAt: null,
              ...(sub.mpRetiredPreapprovalId ? {} : { mpRetiredPreapprovalId: preapprovalId }),
            },
          });
          return { kind: "pending_refused" };
        }
        if (pre.status === "authorized") {
          await tx.saasSubscription.update({
            where: { tenantId },
            data: {
              ...mirror,
              // El vigente pasa a retirado: sus cobros tardíos se siguen imputando, y la sync (después del commit) lo
              // cancela en MP para que no debiten los dos.
              mpRetiredPreapprovalId: sub.mpPreapprovalId && sub.mpPreapprovalId !== preapprovalId ? sub.mpPreapprovalId : sub.mpRetiredPreapprovalId,
              mpPreapprovalId: preapprovalId,
              mpPayerEmail: pre.payerEmail ?? sub.mpPendingPayerEmail,
              collectionMethod: "AUTO_DEBIT",
              autoDebitEnabled: true,
              mpPendingPreapprovalId: null,
              mpPendingInitPoint: null,
              mpPendingPayerEmail: null,
              mpPendingCreatedAt: null,
            },
          });
          return { kind: "promoted", amountCents: pre.amountCents, nextAt: pre.nextPaymentDate };
        }
        if (pre.status === "cancelled") {
          // El titular canceló en la página de MP o lo vencimos nosotros (MPS-D17): el vigente sigue como estaba.
          await tx.saasSubscription.update({
            where: { tenantId },
            data: { mpPendingPreapprovalId: null, mpPendingInitPoint: null, mpPendingPayerEmail: null, mpPendingCreatedAt: null },
          });
          return { kind: "pending_cleared" };
        }
        return { kind: "replay" };
      }

      if (preapprovalId === sub.mpPreapprovalId) {
        const same =
          sub.mpPreapprovalStatus === pre.status &&
          sub.mpPreapprovalAmountCents === pre.amountCents &&
          (sub.mpPreapprovalNextAt?.getTime() ?? null) === (pre.nextPaymentDate?.getTime() ?? null);
        if (same) return { kind: "replay" };
        if (pre.status === "cancelled" && sub.mpPreapprovalStatus !== "cancelled") {
          // ¿Lo cancelamos nosotros? (cambio de método, débito bloqueado por Plataforma, suscripción dada de baja o
          // débito ya apagado): entonces solo se refleja. Si no, lo canceló el titular desde Mercado Pago: se apaga
          // el débito y el método queda sin elegir, así la pantalla le vuelve a preguntar cómo paga (si quedara
          // AUTO_DEBIT, la sync intentaría reanudar un preapproval que en MP es terminal).
          const ours =
            sub.collectionMethod !== "AUTO_DEBIT" ||
            !sub.autoDebitAllowed ||
            !sub.autoDebitEnabled ||
            sub.tenant.subscriptionStatus === "CANCELLED";
          if (ours) {
            await tx.saasSubscription.update({ where: { tenantId }, data: { ...mirror, autoDebitEnabled: false } });
            return { kind: "recorded" };
          }
          await tx.saasSubscription.update({
            where: { tenantId },
            data: { ...mirror, autoDebitEnabled: false, collectionMethod: null },
          });
          return { kind: "cancelled_by_mp", amountCents: sub.mpPreapprovalAmountCents };
        }
        // Pausa/reanudación/monto (propios o de MP): se refleja; la conciliación decide si hay que corregirlo.
        await tx.saasSubscription.update({ where: { tenantId }, data: mirror });
        return { kind: "recorded" };
      }

      // El retirado (lo cancela la sync) o uno que ya no es de nadie: nada que hacer.
      return { kind: "ignored" };
    });
  } catch (err) {
    logger.error("saas_mp.preapproval_write_failed", { tenantId, source, error: err instanceof Error ? err.name : "unknown" });
    return finish({ ok: false, reason: "db_error", tenantId }, source);
  }

  if (out.kind === "ignored" || out.kind === "replay") return ok(out.kind, tenantId);
  if (out.kind === "pending_refused") {
    await afterCommit("pending_refused_cancel", tenantId, async () => {
      const u = await updatePreapproval(preapprovalId, { status: "cancelled" });
      if (!u.ok) logger.warn("saas_mp.pending_refused_cancel_failed", { tenantId, kind: u.kind });
    });
  }
  if (out.kind === "promoted") {
    const nextAt = out.nextAt;
    await afterCommit("debit_activated", tenantId, () =>
      sendMpMail("billing_debit_activated", tenantId, {
        entity: "SaasSubscription",
        entityId: preapprovalId,
        amountCents: out.amountCents,
        effectiveOn: nextAt ? toARDateKey(nextAt) : null,
      })
    );
  } else if (out.kind === "cancelled_by_mp") {
    // HD-11: mail propio. Antes iba `billing_debit_failed` sin `effectiveOn`: `buildMail` lo descartaba (no avisaba
    // nada) y su copy («No pudimos debitar…, pagalo antes del…») era falso para una cancelación. Sin monto ni fecha;
    // la clave `billing_debit_cancelled:<preapprovalId>` frena el replay de MP. Solo esta rama (lo canceló el titular
    // desde MP): las cancelaciones propias caen en `ours` y no avisan.
    await afterCommit("debit_cancelled_by_mp", tenantId, () =>
      sendMpMail("billing_debit_cancelled", tenantId, { entity: "SaasSubscription", entityId: preapprovalId })
    );
  }
  await afterCommit("sync", tenantId, () => syncAfterCommit(tenantId));
  logger.info("saas_mp.preapproval_applied", { tenantId, source, outcome: out.kind });
  return ok("applied", tenantId);
}

// ── Delegación al núcleo ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Imputa un pago recién APROBADO al cargo `targetChargeId` (o a cuenta si es null o no está OPEN) y aplica el saldo
 * a cuenta; el resto partido lleva `splitFromId = raíz`. Locks: el caller tiene Tenant → Subscription.
 * Delega en el núcleo (`lib/saas-billing-internal.ts`, posicional): hay un único escritor de la imputación.
 */
export async function imputeApprovedPaymentInTx(
  tx: Tx,
  p: { tenantId: string; paymentId: string; targetChargeId: string | null; now: Date }
): Promise<{ chargeId: string | null; chargePaid: boolean }> {
  return coreImputeApprovedPaymentInTx(tx, p.tenantId, p.paymentId, p.targetChargeId, p.now);
}

/** Reintegro: pasa a REFUNDED la raíz `rootId` y sus hermanos (`splitFromId = rootId`), reabre los cargos y recalcula el estado. Locks: el caller tiene Tenant → Subscription. */
export async function refundPaymentTreeInTx(
  tx: Tx,
  p: { tenantId: string; rootId: string; now: Date }
): Promise<{ refundedIds: string[]; reopenedChargeIds: string[] }> {
  // El núcleo ya toma la forma con objeto (MPS-2a) y además recalcula el estado (`statusChanged`, no se expone acá).
  const r = await coreRefundPaymentTreeInTx(tx, p);
  return { refundedIds: r.refundedIds, reopenedChargeIds: r.reopenedChargeIds };
}
