"use server";

/**
 * Configuración → Facturación (PL-2b, contrato C-PL9 recortado: SIN Mercado Pago, decisión de Martin del 16-oct).
 * Plan, precio, prueba, saldo, próximo cargo, cargos y pagos; subir el comprobante de una transferencia; ver el
 * comprobante; cambiar de plan (elegir quiénes pierden el acceso si sobran).
 *
 * Barrera: `requireAccountBilling` en CADA export (el Titular o quien tenga «Planes y pagos»; soporte nunca:
 * `SUPPORT_CAPS` no tiene `account.*`). Cambiar de plan además pide step-up (`requireStepUp`, PL-D11: 2FA
 * obligatoria para plan y medio de pago).
 *
 * Solo lectura: subir el comprobante y cambiar de plan corren en `withAccountWritable` (C-PL10): un consultorio con
 * la prueba vencida o con deuda está en modo lectura justamente cuando tiene que poder pagar y elegir plan. Nunca en
 * soporte (doble red: `requireAccountBilling` y `withAccountWritable`).
 *
 * Canal: los cobros son TENANT_READONLY. Las LECTURAS van con `runWithRls` (la policy de lectura por tenant); las
 * ESCRITURAS de cobro por el canal service desde `lib/saas-billing-internal.ts` (único escritor), siempre con el
 * `tenantId` del Actor. El cambio de plan va por `runTeamTx` (rol app + RLS, como el resto del equipo).
 */
import { randomUUID } from "node:crypto";
import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";
import { prismaService } from "@/lib/db";
import { runWithRls } from "@/lib/rls";
import { requireAccountBilling } from "@/lib/authz";
import { assertWritable } from "@/lib/session";
import { withAccountWritable } from "@/lib/account-writable";
import { requireStepUp } from "@/lib/two-factor-step-up";
import { rateLimit, rateLimitedMessage } from "@/lib/rate-limit";
import { auditInTx } from "@/lib/audit";
import { saasBillingMode, saasBillingTransferInfo } from "@/lib/env";
import { tags, tenantEntitlementTags } from "@/lib/cache-tags";
import { runTeamTx, type TeamActorCtx } from "@/lib/team-internal";
import {
  applyPlanChangeInTx,
  previewPlanChangeInTx,
  PlanChangeRaceError,
  type PlanChangePreview,
} from "@/lib/saas-plan-change-internal";
import { billingActive, readLedger, recordPaymentInTx } from "@/lib/saas-billing-internal";
import { parsePaymentForm, readReceiptFile, removeReceipt, signReceipt, uploadReceipt } from "@/lib/saas-receipts-internal";
import { remainingCents } from "@/lib/saas-billing-logic";
import {
  BILLING_COPY,
  PLAN_CHANGE_COPY,
  type BillingOverview,
  type PlanChangeActionResult,
  type SubmitPaymentReceiptResult,
} from "@/lib/saas-billing-types";
import type { Actor } from "@/lib/session";
import type { ActionResult } from "@/lib/validation";

const SAAS_PLAN = z.enum(["INDIVIDUAL", "CONSULTORIO", "CLINICA", "LIBRE"]);
const ID = z.string().min(1).max(64);

const ApplyPlanChangeInput = z
  .object({
    to: SAAS_PLAN,
    disableMembershipIds: z.array(ID).max(200),
    reactivateMembershipIds: z.array(ID).max(200),
    expectedUpdatedAt: z.string().datetime(),
  })
  .strict();

function teamCtx(actor: Actor): TeamActorCtx {
  return {
    via: "tenant",
    tenantId: actor.tenantId,
    actorUserId: actor.userId,
    // `requireAccountBilling` ya garantizó membresía (soporte no tiene `account.*`).
    actorRole: actor.membership?.role ?? "BILLING",
    actorRef: null,
  };
}

/** Estado contable del consultorio activo. Se puede leer en solo lectura (las lecturas no se cortan nunca). */
export async function getBillingOverview(): Promise<BillingOverview> {
  const { actor } = await requireAccountBilling();
  const now = new Date();
  const ledger = await runWithRls(actor.tenantId, (tx) => readLedger(tx, actor.tenantId, now));
  if (!ledger) throw new Error("[saas-billing] consultorio inexistente");
  const mode = saasBillingMode();
  const transferInfo = saasBillingTransferInfo();
  // PL-Z (A2): sin datos para transferir no se ofrece «Informar pago» (el consultorio no sabría a dónde pagar).
  return { ...ledger, mode, transferInfo, canSubmitReceipt: mode !== "off" && transferInfo !== null };
}

/** Lo que pasaría al cambiar a `to` (para el drawer). Solo lectura. */
export async function previewPlanChange(to: unknown): Promise<ActionResult<PlanChangePreview>> {
  const { actor } = await requireAccountBilling();
  const parsed = SAAS_PLAN.safeParse(to);
  if (!parsed.success) return { ok: false, error: PLAN_CHANGE_COPY.invalid_input };
  const preview = await runTeamTx(teamCtx(actor), (tx) =>
    previewPlanChangeInTx(tx, { tenantId: actor.tenantId, to: parsed.data, now: new Date(), actorUserId: actor.userId })
  );
  if (!preview) return { ok: false, error: PLAN_CHANGE_COPY.not_found };
  return { ok: true, data: preview };
}

/**
 * Cambiar de plan (C-PL4 desde el consultorio): `requireAccountBilling` → step-up → zod → `applyPlanChangeInTx`
 * (lock + CAS contra `expectedUpdatedAt`, escritor único con source `billing`, deshabilitar/reactivar, audit). Libre
 * no (se arma desde Plataforma). Sin prorrateo (PL-D9): el plan nuevo rige desde el próximo cargo.
 */
export async function applyPlanChange(raw: unknown): Promise<PlanChangeActionResult> {
  return withAccountWritable("lib/saas-billing.ts#applyPlanChange", async (): Promise<PlanChangeActionResult> => {
    const { actor, caps } = await requireAccountBilling();
    // Tira `StepUpRequiredError` / `TwoFactorSetupRequiredError` (digest): `useStepUpAction` pide el código y reintenta.
    await requireStepUp(actor);
    assertWritable(actor);
    const parsed = ApplyPlanChangeInput.safeParse(raw);
    if (!parsed.success) return { ok: false, error: PLAN_CHANGE_COPY.invalid_input, reason: "invalid_input" };
    // PL-Z a3#2: «Planes y pagos» alcanza para cambiar el plan, pero elegir A QUIÉN se le corta (o se le devuelve) el
    // acceso es gestión del equipo: la misma barrera que deshabilitar/reactivar desde Usuarios (`tenant.admin`). Sin
    // esto, alguien con solo «Planes y pagos» podía dejar afuera a cualquier miembro bajando de plan.
    if ((parsed.data.disableMembershipIds.length > 0 || parsed.data.reactivateMembershipIds.length > 0) && !caps.has("tenant.admin")) {
      return { ok: false, error: PLAN_CHANGE_COPY.needs_settings, reason: "invalid_selection" };
    }
    const ctx = teamCtx(actor);
    let res;
    try {
      res = await runTeamTx(ctx, (tx) =>
        applyPlanChangeInTx(tx, {
          tenantId: actor.tenantId,
          to: parsed.data.to,
          disableMembershipIds: parsed.data.disableMembershipIds,
          reactivateMembershipIds: parsed.data.reactivateMembershipIds,
          expectedUpdatedAt: new Date(parsed.data.expectedUpdatedAt),
          ctx,
          now: new Date(),
        })
      );
    } catch (err) {
      if (err instanceof PlanChangeRaceError) return { ok: false, error: PLAN_CHANGE_COPY.stale, reason: "stale" };
      throw err;
    }
    if (!res.ok) {
      const error = res.detail === "custom_limits" ? PLAN_CHANGE_COPY.custom_limits : PLAN_CHANGE_COPY[res.reason];
      return { ok: false, error, reason: res.reason, detail: res.detail };
    }
    for (const t of tenantEntitlementTags(actor.tenantId)) revalidateTag(t);
    revalidateTag(tags.practitioners(actor.tenantId));
    revalidatePath("/configuracion");
    return { ok: true, data: { disabled: res.disabled, reactivated: res.reactivated, revokedInvites: res.revokedInvites } };
  });
}

/**
 * Subir el comprobante de una transferencia (queda `PENDING_REVIEW` hasta que Plataforma lo apruebe). Campos del
 * FormData: `file` (obligatorio), `chargeId` (opcional: sin él, Plataforma lo imputa al cargo abierto más viejo),
 * `amount` (vacío con cargo = lo que falta), `paidOn` (YYYY-MM-DD), `note`.
 *
 * Orden: barrera → modo → rate limit → validación del formulario y del ARCHIVO (tamaño + magic bytes) → cargo del
 * consultorio → Storage → fila (+ audit) en una tx; si la tx falla se borra el objeto subido.
 */
export async function submitPaymentReceipt(form: FormData): Promise<ActionResult<SubmitPaymentReceiptResult>> {
  return withAccountWritable("lib/saas-billing.ts#submitPaymentReceipt", async (): Promise<ActionResult<SubmitPaymentReceiptResult>> => {
    const { actor } = await requireAccountBilling();
    assertWritable(actor);
    if (!billingActive()) return { ok: false, error: BILLING_COPY.modeOff };
    const rl = await rateLimit(`billing-receipt:${actor.userId}`, { limit: 10, windowMs: 10 * 60_000 });
    if (!rl.ok) return { ok: false, error: rateLimitedMessage(rl.retryAfterMs) };

    const now = new Date();
    const parsed = parsePaymentForm(form, now);
    if (!parsed.ok) return { ok: false, error: parsed.error, fieldErrors: { [parsed.field]: [parsed.error] } };
    const f = parsed.data;
    if (!f.file) return { ok: false, error: BILLING_COPY.receiptRequired, fieldErrors: { file: [BILLING_COPY.receiptRequired] } };
    const receipt = await readReceiptFile(f.file);
    if (!receipt.ok) return { ok: false, error: receipt.error, fieldErrors: { file: [receipt.error] } };

    let amountCents = f.amountCents;
    if (f.chargeId) {
      // El cargo tiene que ser de ESTE consultorio (BYPASSRLS en prod: el where es la barrera) y estar pendiente.
      const c = await runWithRls(actor.tenantId, async (tx) => {
        const row = await tx.saasCharge.findFirst({
          where: { id: f.chargeId!, tenantId: actor.tenantId },
          select: { status: true, amountCents: true, dueDate: true },
        });
        if (!row) return null;
        const paid = await tx.saasPayment.aggregate({
          where: { chargeId: f.chargeId!, tenantId: actor.tenantId, status: "APPROVED" },
          _sum: { amountCents: true },
        });
        return { ...row, approvedCents: paid._sum.amountCents ?? 0 };
      });
      if (!c) return { ok: false, error: BILLING_COPY.chargeNotFound };
      if (c.status !== "OPEN") return { ok: false, error: BILLING_COPY.chargeNotOpen };
      if (amountCents === null) {
        amountCents = remainingCents({ status: c.status, amountCents: c.amountCents, approvedCents: c.approvedCents, dueDate: "" });
      }
    }
    if (amountCents === null || amountCents <= 0) {
      return { ok: false, error: BILLING_COPY.amountInvalid, fieldErrors: { amount: [BILLING_COPY.amountInvalid] } };
    }

    const paymentId = randomUUID();
    const up = await uploadReceipt({ tenantId: actor.tenantId, paymentId, ext: receipt.ext, bytes: receipt.bytes, mimeType: receipt.mimeType });
    if (!up.ok) return { ok: false, error: up.error };
    let result;
    try {
      result = await prismaService.$transaction(async (tx) => {
        const r = await recordPaymentInTx(tx, {
          id: paymentId,
          tenantId: actor.tenantId,
          chargeId: f.chargeId,
          amountCents: amountCents!,
          status: "PENDING_REVIEW",
          paidAt: f.paidAt,
          receipt: { path: up.path, mimeType: receipt.mimeType, sizeBytes: receipt.sizeBytes },
          note: f.note,
          submittedById: actor.userId,
          now,
        });
        if (r.ok) {
          await auditInTx(tx, {
            tenantId: actor.tenantId,
            actorId: actor.userId,
            action: "billing.payment.submitted",
            entity: "SaasPayment",
            entityId: paymentId,
            payload: { amountCents: amountCents!, chargeId: f.chargeId, mimeType: receipt.mimeType, sizeBytes: receipt.sizeBytes },
          });
        }
        return r;
      });
    } catch (err) {
      await removeReceipt(up.path);
      throw err;
    }
    if (!result.ok) {
      await removeReceipt(up.path);
      const error =
        result.reason === "charge_not_open"
          ? BILLING_COPY.chargeNotOpen
          : result.reason === "amount_invalid"
            ? BILLING_COPY.amountInvalid
            : BILLING_COPY.chargeNotFound;
      return { ok: false, error };
    }
    revalidatePath("/configuracion");
    return { ok: true, data: { paymentId } };
  });
}

/** URL firmada (60 s) del comprobante de un pago de ESTE consultorio. */
export async function getReceiptUrl(paymentId: unknown): Promise<ActionResult<{ url: string }>> {
  const { actor } = await requireAccountBilling();
  const id = ID.safeParse(paymentId);
  if (!id.success) return { ok: false, error: BILLING_COPY.paymentNotFound };
  const row = await runWithRls(actor.tenantId, (tx) =>
    tx.saasPayment.findFirst({ where: { id: id.data, tenantId: actor.tenantId }, select: { receiptPath: true } })
  );
  if (!row) return { ok: false, error: BILLING_COPY.paymentNotFound };
  if (!row.receiptPath) return { ok: false, error: BILLING_COPY.noReceipt };
  const signed = await signReceipt(row.receiptPath);
  if (!signed.ok) return { ok: false, error: signed.error };
  return { ok: true, data: { url: signed.url } };
}
