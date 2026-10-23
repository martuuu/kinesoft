"use server";

/**
 * Configuración → Facturación con Mercado Pago (MPS-3a, contrato C-MPS10, brief §26.6; MPS-D18/D19/D21; ADR-027).
 * Cómo paga el consultorio, débito automático, «Pagar con Mercado Pago» por cargo, la vuelta del checkout, la baja a
 * fin de período (y deshacerla), reactivar la suscripción y anular la bajada de plan programada.
 *
 * Barrera en CADA export, en este orden:
 *  1. `requireAccountBilling`: el Titular o quien tenga «Planes y pagos». Soporte nunca (`SUPPORT_CAPS` no tiene
 *     `account.*`) y `withAccountWritable` tampoco lo habilita (doble red).
 *  2. `requireStepUp` en lo que toca plata o el acceso de todo el equipo (PL-D11: 2FA obligatoria para plan y medio de
 *     pago): `setCollectionMethod`, `startAutoDebit`, `scheduleCancel`, `reactivateSubscription`. Deshacer la baja,
 *     anular la bajada, re-leer el débito y pagar un cargo no lo piden: devuelven el consultorio a como estaba o
 *     cobran lo que ya debe (pedir 2FA para pagar una deuda solo traba el pago).
 *  3. `withAccountWritable` + `assertWritable`: todas están en `ACCOUNT_WRITABLE_ACTIONS` (lib/account-writable.ts).
 *     Un consultorio en solo lectura (deuda, prueba vencida, baja) es justamente el que tiene que poder pagar y
 *     reactivar.
 *  4. `SAAS_BILLING_MODE`: con `off` nada. Lo que habla con Mercado Pago (débito, link de pago, vuelta del checkout,
 *     elegir «Mercado Pago cada mes») exige `mp`; transferencia, baja, deshacer, reactivar y anular la bajada valen
 *     también en `manual`.
 *  5. Rate limit por usuario y action (en memoria / Upstash, `lib/rate-limit.ts`).
 *
 * Canal: `SaasSubscription`/`SaasCharge`/`SaasPayment` son TENANT_READONLY. Las escrituras van por el canal service
 * (`prismaService.$transaction`) y el `tenantId` sale SIEMPRE del Actor: en prod la conexión tiene BYPASSRLS y el
 * `where: { tenantId }` es la única barrera. Ningún id de entrada se usa sin cruzarlo con el consultorio del actor.
 *
 * Mercado Pago: siempre FUERA de una transacción (una llamada dura hasta 8 s y retendría los locks). Patrón: escribir lo
 * deseado en la base → commit → `syncSaasMpAfterCommit` lleva el preapproval a eso (nunca tira). La vuelta del
 * checkout no confía en la query string: re-pide el pago a MP y exige que la referencia `saas:<tenant>` sea la del
 * actor ANTES de consumir (si no, cualquiera podría imputarle a su consultorio un pago ajeno con solo conocer el id).
 *
 * Audit: lo que programa/deshace cada action lo audita esta action en la misma tx (`billing.*`); los cambios de estado
 * de la suscripción (reactivar) los audita el escritor único de entitlements.
 */
import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prismaService } from "@/lib/db";
import { runWithRls } from "@/lib/rls";
import { requireAccountBilling } from "@/lib/authz";
import { assertWritable, type Actor } from "@/lib/session";
import { withAccountWritable } from "@/lib/account-writable";
import { requireStepUp } from "@/lib/two-factor-step-up";
import { rateLimit, rateLimitedMessage } from "@/lib/rate-limit";
import { auditInTx } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { saasBillingMode } from "@/lib/env";
import { tenantEntitlementTags } from "@/lib/cache-tags";
import { ensureSubscriptionInTx, lockSubscription, lockTenant } from "@/lib/saas-billing-internal";
import { reactivateInTx, scheduleCancelInTx, undoCancelInTx } from "@/lib/saas-billing-schedule-internal";
import {
  createOrReuseChargeCheckout,
  refreshPendingPreapproval,
  startPreapprovalFlow,
  syncSaasMpAfterCommit,
  type SaasMpSyncFailure,
} from "@/lib/saas-mp-sync-internal";
import { consumeSaasMpPayment } from "@/lib/saas-billing-mp-internal";
import { sendSaasBillingMpMail } from "@/lib/saas-billing-mail-internal";
import { getSaasPayment } from "@/lib/mercadopago-saas";
import { mapMpPaymentStatus, parseSaasExternalReference } from "@/lib/saas-mp-logic";
import { keyFromDbDate, suggestedChargeId } from "@/lib/saas-billing-logic";
import {
  SAAS_MP_COPY,
  type CancelScheduledPlanChangeData,
  type ConfirmCheckoutReturnData,
  type PayChargeWithMpData,
  type ReactivateSubscriptionData,
  type RefreshAutoDebitData,
  type SaasMpActionReason,
  type SaasMpActionResult,
  type ScheduleCancelData,
  type SetCollectionMethodData,
  type StartAutoDebitData,
  type UndoCancelData,
} from "@/lib/saas-billing-types";

const ID = z.string().min(1).max(64);
const WINDOW_MS = 10 * 60_000;
const FILE = "lib/saas-billing-mp.ts";

const SetCollectionMethodInput = z.object({ method: z.enum(["TRANSFER", "MP_CHECKOUT"]) }).strict();
// MPS-D21: el email lo tipea el usuario (el de su cuenta de MP); se normaliza en la sync.
const StartAutoDebitInput = z.object({ payerEmail: z.string().trim().max(254).email() }).strict();
const PayChargeInput = z.object({ chargeId: ID.optional() }).strict();
// Los ids de pago de MP son numéricos (el puerto vuelve a validarlo); la regex corta antes de llamar a la red.
const ConfirmReturnInput = z.object({ paymentId: z.string().regex(/^\d{1,20}$/), chargeId: ID.optional() }).strict();

const fail = <T>(reason: SaasMpActionReason, error: string): SaasMpActionResult<T> => ({ ok: false, error, reason });

/** Barrera común (pasos 1-3 de la cabecera). El step-up tira el digest que `useStepUpAction` sabe reintentar. */
async function gate(o: { stepUp: boolean }): Promise<Actor> {
  const { actor } = await requireAccountBilling();
  if (o.stepUp) await requireStepUp(actor);
  assertWritable(actor);
  return actor;
}

/** Paso 4: `off` corta todo; `needsMp` además exige `mp` (con `manual` el cobro es solo por transferencia). */
function modeGate<T>(needsMp: boolean): SaasMpActionResult<T> | null {
  const mode = saasBillingMode();
  if (mode === "off") return fail("mode_off", SAAS_MP_COPY.mode_off);
  if (needsMp && mode !== "mp") return fail("mode_off", SAAS_MP_COPY.mp_off);
  return null;
}

/** Paso 5. */
async function limitGate<T>(name: string, userId: string, limit: number): Promise<SaasMpActionResult<T> | null> {
  const rl = await rateLimit(`saas-mp:${name}:${userId}`, { limit, windowMs: WINDOW_MS });
  return rl.ok ? null : fail("rate_limited", rateLimitedMessage(rl.retryAfterMs));
}

/** Rechazos de la sync (MPS-2b2) → copy del consultorio. */
function fromSync<T>(reason: SaasMpSyncFailure, ctx: "debit" | "charge"): SaasMpActionResult<T> {
  switch (reason) {
    case "mode_off":
      return fail("mode_off", SAAS_MP_COPY.mp_off);
    case "mp_unavailable":
      return fail("mp_unavailable", SAAS_MP_COPY.mp_unavailable);
    case "not_allowed":
      return fail("not_allowed", SAAS_MP_COPY.not_allowed);
    case "not_found":
      return fail("not_found", ctx === "charge" ? SAAS_MP_COPY.charge_not_found : SAAS_MP_COPY.not_found);
    case "charge_not_open":
      return fail("charge_not_open", SAAS_MP_COPY.charge_not_open);
    case "below_minimum":
      // `startPreapprovalFlow` lo devuelve cuando no hay monto que debitar: el plan está en «Consultá» sin precio a
      // medida (con precio, un monto bajo se sube al mínimo; no hay «muy bajo» para el débito).
      return fail("below_minimum", ctx === "debit" ? SAAS_MP_COPY.no_price : SAAS_MP_COPY.below_minimum);
  }
}

// ── Cómo pagás ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * «Mercado Pago cada mes» o «Transferencia» (step-up). El débito automático NO se elige acá: queda AUTO_DEBIT recién
 * cuando MP confirma la autorización (`startAutoDebit` → la promoción del preapproval). Salir del débito apaga
 * `autoDebitEnabled` y la sync cancela el preapproval en MP después del commit (`desiredDebit` → cancelled por método).
 */
export async function setCollectionMethod(raw: unknown): Promise<SaasMpActionResult<SetCollectionMethodData>> {
  return withAccountWritable(`${FILE}#setCollectionMethod`, async (): Promise<SaasMpActionResult<SetCollectionMethodData>> => {
    const actor = await gate({ stepUp: true });
    const off = modeGate<SetCollectionMethodData>(false);
    if (off) return off;
    const parsed = SetCollectionMethodInput.safeParse(raw);
    if (!parsed.success) return fail("invalid_input", SAAS_MP_COPY.invalid_input);
    const method = parsed.data.method;
    if (method === "MP_CHECKOUT") {
      const noMp = modeGate<SetCollectionMethodData>(true);
      if (noMp) return noMp;
    }
    const limited = await limitGate<SetCollectionMethodData>("method", actor.userId, 10);
    if (limited) return limited;

    const tenantId = actor.tenantId;
    const now = new Date();
    const done = await prismaService.$transaction(async (tx) => {
      if (!(await ensureSubscriptionInTx(tx, tenantId, now))) return false;
      const cur = await tx.saasSubscription.findUniqueOrThrow({ where: { tenantId }, select: { collectionMethod: true } });
      await tx.saasSubscription.update({ where: { tenantId }, data: { collectionMethod: method, autoDebitEnabled: false } });
      await auditInTx(tx, {
        tenantId,
        actorId: actor.userId,
        action: "billing.collection_method",
        entity: "SaasSubscription",
        entityId: tenantId,
        payload: { from: cur.collectionMethod, to: method },
      });
      return true;
    });
    if (!done) return fail("not_found", SAAS_MP_COPY.not_found);
    revalidatePath("/configuracion");
    await syncSaasMpAfterCommit(tenantId);
    return { ok: true, data: { collectionMethod: method } };
  });
}

// ── Débito automático ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * Activa (o cambia el email de) el débito automático (step-up, modo `mp`): crea o reusa el preapproval PENDIENTE sin
 * tarjeta y devuelve su `initPoint`; el consultorio autoriza en MP y vuelve a `?tab=plan&debito=1`
 * (`refreshAutoDebit`). El vigente, si hay, sigue cobrando hasta que MP confirme el nuevo.
 */
export async function startAutoDebit(raw: unknown): Promise<SaasMpActionResult<StartAutoDebitData>> {
  return withAccountWritable(`${FILE}#startAutoDebit`, async (): Promise<SaasMpActionResult<StartAutoDebitData>> => {
    const actor = await gate({ stepUp: true });
    const off = modeGate<StartAutoDebitData>(true);
    if (off) return off;
    const parsed = StartAutoDebitInput.safeParse(raw);
    if (!parsed.success) return fail("invalid_input", SAAS_MP_COPY.invalid_email);
    const limited = await limitGate<StartAutoDebitData>("debit", actor.userId, 5);
    if (limited) return limited;

    const tenantId = actor.tenantId;
    const now = new Date();
    // La sync no crea la suscripción (no importa el escritor): se asegura acá, en su propia tx corta.
    const exists = await prismaService.$transaction((tx) => ensureSubscriptionInTx(tx, tenantId, now));
    if (!exists) return fail("not_found", SAAS_MP_COPY.not_found);
    const r = await startPreapprovalFlow({ tenantId, payerEmail: parsed.data.payerEmail, actorUserId: actor.userId, now });
    if (!r.ok) return fromSync<StartAutoDebitData>(r.reason, "debit");
    // Sin el email en el audit (dato personal; el registro es solo inserción): alcanza con el preapproval.
    await prismaService.$transaction((tx) =>
      auditInTx(tx, {
        tenantId,
        actorId: actor.userId,
        action: "billing.auto_debit.started",
        entity: "SaasSubscription",
        entityId: tenantId,
        payload: { preapprovalId: r.preapprovalId, reused: r.reused },
      })
    );
    revalidatePath("/configuracion");
    return { ok: true, data: { initPoint: r.initPoint, reused: r.reused } };
  });
}

/** Re-lee el preapproval en MP (vuelta del back_url / «Ya autoricé»): si MP ya lo autorizó, lo promueve. Idempotente. */
export async function refreshAutoDebit(): Promise<SaasMpActionResult<RefreshAutoDebitData>> {
  return withAccountWritable(`${FILE}#refreshAutoDebit`, async (): Promise<SaasMpActionResult<RefreshAutoDebitData>> => {
    const actor = await gate({ stepUp: false });
    const off = modeGate<RefreshAutoDebitData>(false);
    if (off) return off;
    const limited = await limitGate<RefreshAutoDebitData>("refresh", actor.userId, 30);
    if (limited) return limited;
    const r = await refreshPendingPreapproval({ tenantId: actor.tenantId, now: new Date() });
    revalidatePath("/configuracion");
    return { ok: true, data: { status: r.status } };
  });
}

// ── Pagar un cargo con Mercado Pago ─────────────────────────────────────────────────────────────────────────────

/** Último impago del consultorio (OPEN con saldo, el período más reciente) o "" si no debe nada. */
async function lastUnpaidChargeId(tenantId: string): Promise<string> {
  return runWithRls(tenantId, async (tx) => {
    const charges = await tx.saasCharge.findMany({
      where: { tenantId, status: "OPEN" },
      select: { id: true, status: true, periodStart: true, amountCents: true },
    });
    if (charges.length === 0) return "";
    const paid = await tx.saasPayment.groupBy({
      by: ["chargeId"],
      where: { tenantId, status: "APPROVED", chargeId: { in: charges.map((c) => c.id) } },
      _sum: { amountCents: true },
    });
    const byCharge = new Map(paid.map((p) => [p.chargeId, p._sum.amountCents ?? 0]));
    return suggestedChargeId(
      charges.map((c) => ({
        id: c.id,
        status: c.status,
        periodStart: keyFromDbDate(c.periodStart),
        remainingCents: c.amountCents - (byCharge.get(c.id) ?? 0),
      }))
    );
  });
}

/**
 * «Pagar con Mercado Pago» (modo `mp`): sin `chargeId`, el último impago (el mismo que sugiere «Informar pago»). El
 * cargo tiene que ser del consultorio del actor (la sync lo busca con `{ id, tenantId }`). Reusa el link de las últimas
 * 24 h si el monto no cambió. Permitido en solo lectura (es la salida de la deuda).
 */
export async function payChargeWithMp(raw?: unknown): Promise<SaasMpActionResult<PayChargeWithMpData>> {
  return withAccountWritable(`${FILE}#payChargeWithMp`, async (): Promise<SaasMpActionResult<PayChargeWithMpData>> => {
    const actor = await gate({ stepUp: false });
    const off = modeGate<PayChargeWithMpData>(true);
    if (off) return off;
    const parsed = PayChargeInput.safeParse(raw ?? {});
    if (!parsed.success) return fail("invalid_input", SAAS_MP_COPY.invalid_input);
    const limited = await limitGate<PayChargeWithMpData>("pay", actor.userId, 10);
    if (limited) return limited;

    const tenantId = actor.tenantId;
    const chargeId = parsed.data.chargeId ?? (await lastUnpaidChargeId(tenantId));
    if (!chargeId) return fail("not_found", SAAS_MP_COPY.no_unpaid);
    const r = await createOrReuseChargeCheckout({ tenantId, chargeId, now: new Date() });
    if (!r.ok) return fromSync<PayChargeWithMpData>(r.reason, "charge");
    return { ok: true, data: { chargeId, initPoint: r.initPoint, reused: r.reused } };
  });
}

/**
 * Vuelta del checkout (`?tab=plan&cargo=<id>&payment_id=<id>`, modo `mp`): re-pide el pago a MP con el token de la
 * plataforma, exige que su referencia sea `saas:<tenant del actor>` (y el cargo, si vino) y recién ahí lo consume con
 * el mismo camino que el webhook (`consumeSaasMpPayment`, idempotente: el webhook y la vuelta pueden llegar los dos).
 * Un pago ajeno se contesta igual que uno inexistente (no se confirma que exista).
 */
export async function confirmCheckoutReturn(raw: unknown): Promise<SaasMpActionResult<ConfirmCheckoutReturnData>> {
  return withAccountWritable(`${FILE}#confirmCheckoutReturn`, async (): Promise<SaasMpActionResult<ConfirmCheckoutReturnData>> => {
    const actor = await gate({ stepUp: false });
    const off = modeGate<ConfirmCheckoutReturnData>(true);
    if (off) return off;
    const parsed = ConfirmReturnInput.safeParse(raw);
    if (!parsed.success) return fail("invalid_input", SAAS_MP_COPY.invalid_input);
    const limited = await limitGate<ConfirmCheckoutReturnData>("return", actor.userId, 30);
    if (limited) return limited;

    const tenantId = actor.tenantId;
    const { paymentId, chargeId } = parsed.data;
    const g = await getSaasPayment(paymentId);
    if (!g.ok) {
      return g.kind === "http" && g.status === 404
        ? fail("not_found", SAAS_MP_COPY.payment_not_found)
        : fail("mp_unavailable", SAAS_MP_COPY.mp_unavailable);
    }
    const ref = parseSaasExternalReference(g.data.externalReference);
    if (!ref || ref.tenantId !== tenantId || (chargeId !== undefined && ref.chargeId !== chargeId)) {
      logger.warn("saas_mp.return_foreign_payment", { tenantId, hasRef: ref !== null });
      return fail("not_found", SAAS_MP_COPY.payment_not_found);
    }
    const c = await consumeSaasMpPayment(paymentId, { source: "return" });
    if (!c.ok) return fail("mp_unavailable", SAAS_MP_COPY.mp_unavailable);

    const status = mapMpPaymentStatus(g.data.status);
    const outcome: ConfirmCheckoutReturnData["outcome"] =
      status === "APPROVED"
        ? "approved"
        : status === "REJECTED"
          ? "rejected"
          : ["pending", "in_process", "authorized"].includes(g.data.status)
            ? "pending"
            : "unknown";
    let chargePaid = false;
    if (ref.chargeId) {
      const row = await runWithRls(tenantId, (tx) =>
        tx.saasCharge.findFirst({ where: { id: ref.chargeId as string, tenantId }, select: { status: true } })
      );
      chargePaid = row?.status === "PAID";
    }
    revalidatePath("/configuracion");
    return { ok: true, data: { outcome, chargePaid } };
  });
}

// ── Baja y reactivación ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * Baja a fin de período (step-up): acceso completo hasta el próximo cobro (en prueba, hasta el día siguiente al fin,
 * MPS-D18); ese día el cron la aplica. Anula la bajada de plan programada. El débito queda pausado (la sync, después
 * del commit: `desiredDebit` con baja programada → paused).
 */
export async function scheduleCancel(): Promise<SaasMpActionResult<ScheduleCancelData>> {
  return withAccountWritable(`${FILE}#scheduleCancel`, async (): Promise<SaasMpActionResult<ScheduleCancelData>> => {
    const actor = await gate({ stepUp: true });
    const off = modeGate<ScheduleCancelData>(false);
    if (off) return off;
    const limited = await limitGate<ScheduleCancelData>("cancel", actor.userId, 10);
    if (limited) return limited;

    const tenantId = actor.tenantId;
    const now = new Date();
    const r = await prismaService.$transaction(async (tx) => {
      const s = await scheduleCancelInTx(tx, { tenantId, requestedById: actor.userId, now });
      if (s.ok) {
        await auditInTx(tx, {
          tenantId,
          actorId: actor.userId,
          action: "billing.cancel.scheduled",
          entity: "SaasSubscription",
          entityId: tenantId,
          payload: { effectiveOn: s.effectiveOn, clearedPendingPlan: s.clearedPendingPlan },
        });
      }
      return s;
    });
    if (!r.ok) {
      if (r.reason === "already_cancel_pending") {
        return fail("cancel_pending", r.detail === "cancelled" ? SAAS_MP_COPY.already_cancelled : SAAS_MP_COPY.cancel_pending);
      }
      return fail("not_found", SAAS_MP_COPY.not_found);
    }
    revalidatePath("/configuracion");
    await sendSaasBillingMpMail("billing_cancel_scheduled", tenantId, {
      entity: "SaasSubscription",
      entityId: tenantId,
      effectiveOn: r.effectiveOn,
      // Por pedido (no por fecha): baja → deshacer → baja para el mismo día vuelve a avisar.
      idempotencyKey: `billing_cancel_scheduled:${tenantId}:${now.getTime()}`,
    });
    await syncSaasMpAfterCommit(tenantId);
    return { ok: true, data: { effectiveOn: r.effectiveOn } };
  });
}

/** Deshace la baja programada (antes del día en que rige; ese día la aplica el cron → después se reactiva). */
export async function undoCancel(): Promise<SaasMpActionResult<UndoCancelData>> {
  return withAccountWritable(`${FILE}#undoCancel`, async (): Promise<SaasMpActionResult<UndoCancelData>> => {
    const actor = await gate({ stepUp: false });
    const off = modeGate<UndoCancelData>(false);
    if (off) return off;
    const limited = await limitGate<UndoCancelData>("undo-cancel", actor.userId, 10);
    if (limited) return limited;

    const tenantId = actor.tenantId;
    const r = await prismaService.$transaction(async (tx) => {
      const u = await undoCancelInTx(tx, { tenantId, actorUserId: actor.userId, now: new Date() });
      if (u.ok) {
        await auditInTx(tx, { tenantId, actorId: actor.userId, action: "billing.cancel.undone", entity: "SaasSubscription", entityId: tenantId });
      }
      return u;
    });
    if (!r.ok) {
      if (r.reason === "not_cancel_pending") return fail("not_cancelled", SAAS_MP_COPY.not_cancel_pending);
      if (r.reason === "stale") return fail("stale", SAAS_MP_COPY.undo_today);
      return fail("not_found", SAAS_MP_COPY.not_found);
    }
    revalidatePath("/configuracion");
    await syncSaasMpAfterCommit(tenantId);
    return { ok: true, data: { undone: true } };
  });
}

/**
 * Reactiva una suscripción dada de baja (step-up): solo si la baja fue PROPIA y no hay deuda (MPS-D19); una baja de
 * Plataforma se reactiva desde Plataforma. Re-ancla el período al 4 desde hoy (el tramo hasta el 4 va como stub en el
 * primer cargo). El estado lo escribe y audita el escritor único (source `billing`).
 */
export async function reactivateSubscription(): Promise<SaasMpActionResult<ReactivateSubscriptionData>> {
  return withAccountWritable(`${FILE}#reactivateSubscription`, async (): Promise<SaasMpActionResult<ReactivateSubscriptionData>> => {
    const actor = await gate({ stepUp: true });
    const off = modeGate<ReactivateSubscriptionData>(false);
    if (off) return off;
    const limited = await limitGate<ReactivateSubscriptionData>("reactivate", actor.userId, 10);
    if (limited) return limited;

    const tenantId = actor.tenantId;
    const r = await prismaService.$transaction((tx) =>
      reactivateInTx(tx, { tenantId, actor: { userId: actor.userId, homeTenantId: tenantId }, now: new Date() })
    );
    if (!r.ok) {
      switch (r.reason) {
        case "not_cancelled":
          return fail(
            "not_cancelled",
            r.detail === "not_own" ? SAAS_MP_COPY.reactivate_not_own : r.detail === "tenant_inactive" ? SAAS_MP_COPY.tenant_inactive : SAAS_MP_COPY.not_cancelled
          );
        case "has_debt":
          return fail("has_debt", SAAS_MP_COPY.has_debt);
        case "stale":
          return fail("stale", SAAS_MP_COPY.stale);
        default:
          return fail("not_found", SAAS_MP_COPY.not_found);
      }
    }
    // El estado cambia el acceso de todo el equipo (solo lectura → completo): las entradas cacheadas se invalidan.
    for (const t of tenantEntitlementTags(tenantId)) revalidateTag(t);
    revalidatePath("/configuracion");
    await syncSaasMpAfterCommit(tenantId);
    return { ok: true, data: { status: r.status } };
  });
}

/** Lo que se limpia al anular la bajada (mismo set que `scheduleDowngradeInTx` escribe). */
const CLEAR_PENDING_PLAN: Prisma.SaasSubscriptionUpdateInput = {
  pendingPlan: null,
  pendingPlanEffectiveOn: null,
  pendingPlanDisableIds: [],
  pendingPlanRequestedById: null,
  pendingPlanRequestedAt: null,
};

/**
 * Anula la bajada de plan programada: el consultorio sigue con su plan y nadie pierde el acceso. Con los locks del
 * escritor (Tenant → Subscription) para no cruzarse con la etapa 2b del cron que la aplica ese día: si ya se aplicó, no
 * queda nada pendiente y contesta `no_pending_plan`.
 */
export async function cancelScheduledPlanChange(): Promise<SaasMpActionResult<CancelScheduledPlanChangeData>> {
  return withAccountWritable(`${FILE}#cancelScheduledPlanChange`, async (): Promise<SaasMpActionResult<CancelScheduledPlanChangeData>> => {
    const actor = await gate({ stepUp: false });
    const off = modeGate<CancelScheduledPlanChangeData>(false);
    if (off) return off;
    const limited = await limitGate<CancelScheduledPlanChangeData>("cancel-plan", actor.userId, 10);
    if (limited) return limited;

    const tenantId = actor.tenantId;
    const r = await prismaService.$transaction(async (tx) => {
      if (!(await lockTenant(tx, tenantId))) return "not_found" as const;
      await lockSubscription(tx, tenantId);
      const sub = await tx.saasSubscription.findUnique({ where: { tenantId }, select: { pendingPlan: true } });
      if (!sub?.pendingPlan) return "none" as const;
      await tx.saasSubscription.update({ where: { tenantId }, data: CLEAR_PENDING_PLAN });
      await auditInTx(tx, {
        tenantId,
        actorId: actor.userId,
        action: "billing.plan_change.cancelled",
        entity: "SaasSubscription",
        entityId: tenantId,
        payload: { plan: sub.pendingPlan },
      });
      return "cancelled" as const;
    });
    if (r === "not_found") return fail("not_found", SAAS_MP_COPY.not_found);
    if (r === "none") return fail("no_pending_plan", SAAS_MP_COPY.no_pending_plan);
    revalidatePath("/configuracion");
    // El débito del día del cambio vuelve a proyectarse con el plan actual.
    await syncSaasMpAfterCommit(tenantId);
    return { ok: true, data: { cancelled: true } };
  });
}
