/**
 * MPS-K (T6, §26.3): las firmas de C-MPS5..C-MPS9 existen con la aridad del contrato, para que X2-X4 trabajen en
 * paralelo sobre ellas. Los stubs tiran «not implemented: <fn>» hasta que su sesión los implemente: este test NO lo
 * afirma (cuando MPS-2a/2b/2c/3c los implementen, el test sigue verde sin tocarlo); solo fija que existan y su aridad
 * (`Function.length` cuenta los parámetros hasta el primero opcional). `isSaasTopic` sí va implementado.
 *
 * `lockTenant`/`lockSubscription` se fijan por tipo (importar el núcleo en unit trae Prisma): si dejan de exportarse
 * o cambian de firma, `tsc` falla acá.
 */
import { describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import * as adjustments from "@/lib/saas-adjustments-internal";
import * as mp from "@/lib/saas-billing-mp-internal";
import * as sync from "@/lib/saas-mp-sync-internal";
import * as schedule from "@/lib/saas-billing-schedule-internal";
import * as mail from "@/lib/saas-billing-mail-internal";
import * as route from "@/lib/saas-mp-webhook-route";
import { SAAS_ADJUSTMENT_KINDS, SAAS_COLLECTION_METHODS } from "@/lib/saas-billing-types";

type Tx = Prisma.TransactionClient;
type Core = typeof import("@/lib/saas-billing-internal");
const _lockTenant: (tx: Tx, tenantId: string) => Promise<boolean> = null as unknown as Core["lockTenant"];
const _lockSubscription: (tx: Tx, tenantId: string) => Promise<void> = null as unknown as Core["lockSubscription"];
void _lockTenant;
void _lockSubscription;

const ARITY: [string, unknown, number][] = [
  ["addAdjustmentInTx", adjustments.addAdjustmentInTx, 2],
  ["listPendingAdjustmentsForUpdateInTx", adjustments.listPendingAdjustmentsForUpdateInTx, 2],
  ["markAdjustmentsAppliedInTx", adjustments.markAdjustmentsAppliedInTx, 2],
  ["consumeSaasMpPayment", mp.consumeSaasMpPayment, 2],
  ["consumeSaasAuthorizedPayment", mp.consumeSaasAuthorizedPayment, 2],
  ["consumeSaasPreapproval", mp.consumeSaasPreapproval, 2],
  ["imputeApprovedPaymentInTx", mp.imputeApprovedPaymentInTx, 2],
  ["refundPaymentTreeInTx", mp.refundPaymentTreeInTx, 2],
  ["startPreapprovalFlow", sync.startPreapprovalFlow, 1],
  ["refreshPendingPreapproval", sync.refreshPendingPreapproval, 1],
  ["createOrReuseChargeCheckout", sync.createOrReuseChargeCheckout, 1],
  ["syncSaasMpAfterCommit", sync.syncSaasMpAfterCommit, 1],
  ["runSaasMpReconcile", sync.runSaasMpReconcile, 3],
  ["scheduleDowngradeInTx", schedule.scheduleDowngradeInTx, 2],
  ["applyDuePlanChangeInTx", schedule.applyDuePlanChangeInTx, 2],
  ["addUpgradeProrationInTx", schedule.addUpgradeProrationInTx, 2],
  ["scheduleCancelInTx", schedule.scheduleCancelInTx, 2],
  ["undoCancelInTx", schedule.undoCancelInTx, 2],
  ["applyDueCancelInTx", schedule.applyDueCancelInTx, 2],
  ["reactivateInTx", schedule.reactivateInTx, 2],
  ["sendSaasBillingMpMail", mail.sendSaasBillingMpMail, 3],
  ["handleSaasWebhook", route.handleSaasWebhook, 2],
];

describe("[MPS-K] contratos de C-MPS5..C-MPS12", () => {
  it.each(ARITY)("[MPS-K] %s existe con la aridad del contrato", (name, fn, arity) => {
    expect(typeof fn, name).toBe("function");
    expect((fn as (...a: unknown[]) => unknown).length, name).toBe(arity);
  });

  it("[MPS-K] isSaasTopic reconoce los 4 topics de suscripciones y nada más", () => {
    for (const t of ["subscription_preapproval", "subscription_authorized_payment", "preapproval", "authorized_payment"]) {
      expect(route.isSaasTopic(t), t).toBe(true);
    }
    for (const t of ["payment", "merchant_order", "", "Preapproval", "subscription_preapproval_plan", null, undefined]) {
      expect(route.isSaasTopic(t), String(t)).toBe(false);
    }
  });

  it("[MPS-K] uniones de M16 y los EmailKind de C-MPS12", () => {
    expect(SAAS_COLLECTION_METHODS).toEqual(["AUTO_DEBIT", "MP_CHECKOUT", "TRANSFER"]);
    expect(SAAS_ADJUSTMENT_KINDS).toEqual(["PRORATION", "CREDIT", "DEBIT", "CARRYOVER"]);
    expect(mail.SAAS_BILLING_MP_MAIL_KINDS).toEqual([
      "billing_debit_activated",
      "billing_debit_failed",
      "billing_cancel_scheduled",
      "billing_cancelled",
      "billing_plan_change",
    ]);
  });
});
