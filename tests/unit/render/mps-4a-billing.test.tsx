import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [MPS-4a] Configuración → Facturación con Mercado Pago (brief §26.6 UI, C-MPS10). Componentes REALES con props; se
 * mockean el router de Next y las server actions (red). La lógica que decide qué se muestra (opciones de «Cómo pagás»,
 * estados del débito, desglose, copy del cambio de plan, vuelta del checkout) es pura (`lib/saas-billing-view.ts`) y
 * se testea con números; el render confirma que la pantalla la usa y que con `manual` no aparece Mercado Pago.
 *
 * Fechas: el reloj se fija en un instante en que el día AR y el UTC difieren (03:30 UTC del 22 = 00:30 AR del 22,
 * 02:30 UTC del 22 = 23:30 AR del 21): corre igual en TZ=UTC y TZ=AR.
 */
vi.mock("next/navigation", () => ({
  usePathname: () => "/configuracion",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock("@/lib/saas-billing", () => ({
  previewPlanChange: async () => ({ ok: false, error: "x" }),
  applyPlanChange: async () => ({ ok: false, error: "x" }),
  getBillingOverview: async () => null,
  getReceiptUrl: async () => ({ ok: false, error: "x" }),
  submitPaymentReceipt: async () => ({ ok: false, error: "x" }),
}));
vi.mock("@/lib/saas-billing-mp", () => ({
  setCollectionMethod: async () => ({ ok: false, error: "x" }),
  startAutoDebit: async () => ({ ok: false, error: "x" }),
  refreshAutoDebit: async () => ({ ok: false, error: "x" }),
  payChargeWithMp: async () => ({ ok: false, error: "x" }),
  confirmCheckoutReturn: async () => ({ ok: false, error: "x" }),
  scheduleCancel: async () => ({ ok: false, error: "x" }),
  undoCancel: async () => ({ ok: false, error: "x" }),
  reactivateSubscription: async () => ({ ok: false, error: "x" }),
  cancelScheduledPlanChange: async () => ({ ok: false, error: "x" }),
  cancelPendingAutoDebit: async () => ({ ok: false, error: "x" }),
}));
vi.mock("@/lib/two-factor", () => ({ getStepUpOptions: async () => ({ ok: false, error: "x" }) }));

import { BillingPanel } from "@/components/configuracion/panels/billing-panel";
import { BillingSubscriptionSection } from "@/components/configuracion/panels/billing-subscription-section";
import { PlanChangeReview } from "@/components/configuracion/panels/plan-change-drawer";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { seatUsageByKind } from "@/lib/plan-catalog";
import {
  BILLING_RETURN_PARAMS,
  SUBSCRIPTION_COPY,
  autoDebitBand,
  cancelConfirmMessage,
  cancelEffectiveOnPreview,
  collectionChoices,
  dayMonthKey,
  firstPeriodNotice,
  newPlanChangeKey,
  nextChargeLines,
  noPriceNotice,
  parseBillingReturn,
  planChangeBillingCopy,
  planChangeSelectionState,
  stripBillingReturn,
} from "@/lib/saas-billing-view";
import type { BillingAutoDebitState, BillingChargeRow, BillingOverview, PlanChangeBilling } from "@/lib/saas-billing-types";
import type { PlanChangePreview } from "@/lib/saas-plan-change-types";

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;| /g, " ")
    .replace(/\s+/g, " ");
/** formatARS usa NBSP entre «$» y el número: se normaliza para comparar copy. */
const plain = (s: string | null | undefined) => (s ?? "").replace(/ /g, " ");

const wrap = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <ToastProvider>
      <ConfirmProvider>{node}</ConfirmProvider>
    </ToastProvider>
  );

function charge(p: Partial<BillingChargeRow>): BillingChargeRow {
  return {
    id: "c1",
    plan: "CONSULTORIO",
    periodStart: "2026-11-04",
    periodEnd: "2026-12-04",
    dueDate: "2026-11-09",
    amountCents: 2500000,
    paidCents: 0,
    remainingCents: 2500000,
    status: "OPEN",
    overdue: false,
    paidAt: null,
    note: null,
    ...p,
  };
}

function debit(p: Partial<BillingAutoDebitState>): BillingAutoDebitState {
  return {
    status: "none",
    allowed: true,
    payerEmailMasked: null,
    amountCents: null,
    nextDebitOn: null,
    initPoint: null,
    syncedAt: null,
    ...p,
  };
}

function ov(p: Partial<BillingOverview>): BillingOverview {
  return {
    tenantId: "t1",
    plan: "CONSULTORIO",
    planLabel: "Consultorio",
    planPriceCents: 2500000,
    customPriceCents: null,
    effectivePriceCents: 2500000,
    subscriptionStatus: "ACTIVE",
    trialEndsAt: null,
    anchorDay: 4,
    nextCharge: {
      periodStart: "2026-12-04",
      amountCents: 2500000,
      breakdown: { baseCents: 2500000, adjustmentsCents: 0, creditCents: 0, amountCents: 2500000 },
    },
    balanceCents: 0,
    creditCents: 0,
    overdueCount: 0,
    pendingReviewCount: 0,
    charges: [charge({ status: "PAID", paidCents: 2500000, remainingCents: 0, paidAt: "2026-11-04T12:00:00.000Z" })],
    payments: [],
    mode: "mp",
    canSubmitReceipt: true,
    transferInfo: "Alias kinesoft.pagos",
    collectionMethod: null,
    pendingAdjustments: [],
    appliedAdjustments: [],
    chargeBreakdown: {},
    autoDebit: debit({}),
    cancel: null,
    pendingPlan: null,
    billableFrom: "2026-10-04",
    ...p,
  };
}

const NOW = new Date("2026-11-22T03:30:00.000Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("[MPS-4a] lógica pura de Facturación", () => {
  it("[MPS-4a] fechas «4/12» desde la clave civil, sin pasar por el TZ", () => {
    expect(dayMonthKey("2026-12-04")).toBe("4/12");
    expect(dayMonthKey("2027-01-09")).toBe("9/1");
    expect(dayMonthKey("")).toBe("");
  });

  it("[MPS-4a] «Cómo pagás»: con mp las tres (débito solo si Plataforma lo permite); con manual nada que elegir; con off ni con la baja", () => {
    expect(collectionChoices(ov({}))).toEqual(["AUTO_DEBIT", "MP_CHECKOUT", "TRANSFER"]);
    expect(collectionChoices(ov({ autoDebit: debit({ status: "blocked", allowed: false }) }))).toEqual(["MP_CHECKOUT", "TRANSFER"]);
    // Sin suscripción creada todavía (`autoDebit` null): el débito está permitido por defecto (MPS-D24).
    expect(collectionChoices(ov({ autoDebit: null }))).toEqual(["AUTO_DEBIT", "MP_CHECKOUT", "TRANSFER"]);
    expect(collectionChoices(ov({ mode: "manual" }))).toEqual([]);
    expect(collectionChoices(ov({ mode: "off" }))).toEqual([]);
    expect(collectionChoices(ov({ subscriptionStatus: "CANCELLED" }))).toEqual([]);
    expect(SUBSCRIPTION_COPY.method.AUTO_DEBIT.label).toBe("Débito automático con Mercado Pago");
    expect(SUBSCRIPTION_COPY.method.AUTO_DEBIT.hint).toBe("Se debita el 4 de cada mes. Tu tarjeta la cargás en Mercado Pago, no acá.");
    expect(SUBSCRIPTION_COPY.method.MP_CHECKOUT.label).toBe("Mercado Pago cada mes");
    expect(SUBSCRIPTION_COPY.method.MP_CHECKOUT.hint).toBe("Te avisamos el 4 y pagás hasta el 9.");
    expect(SUBSCRIPTION_COPY.method.TRANSFER.label).toBe("Transferencia");
  });

  it("[MPS-4a] estados del débito: pendiente, activo con email enmascarado y monto, rechazado con el vencimiento", () => {
    expect(autoDebitBand(ov({ autoDebit: debit({ status: "pending_authorization", initPoint: "https://mp.test/x" }) }))).toMatchObject({
      kind: "pending",
      text: "Falta autorizar el débito en Mercado Pago",
    });
    const active = autoDebitBand(
      ov({ collectionMethod: "AUTO_DEBIT", autoDebit: debit({ status: "active", payerEmailMasked: "m***@gmail.com", amountCents: 2500000, nextDebitOn: "2026-12-04" }) })
    );
    expect(active?.kind).toBe("active");
    expect(plain(active?.text)).toBe("Débito activo · m***@gmail.com · próximo débito 4/12 por $ 25.000");
    const failed = autoDebitBand(
      ov({
        collectionMethod: "AUTO_DEBIT",
        autoDebit: debit({ status: "failed", amountCents: 2500000 }),
        charges: [charge({ periodStart: "2026-12-04", dueDate: "2026-12-09", amountCents: 2800000, remainingCents: 2800000 })],
      })
    );
    expect(failed?.kind).toBe("failed");
    expect(plain(failed?.text)).toBe("No pudimos debitar $ 28.000. Pagalo antes del 9/12 para no perder el acceso.");
    // Sin débito (o con manual): no hay banda.
    expect(autoDebitBand(ov({}))).toBeNull();
    expect(autoDebitBand(ov({ mode: "manual", autoDebit: debit({ status: "active" }) }))).toBeNull();
  });

  it("[MPS-4a] plan sin precio: avisa que el débito se activa cuando lo carguemos (solo si hay débito en juego)", () => {
    const noPrice = { effectivePriceCents: null, nextCharge: { periodStart: "2026-12-04", amountCents: null } };
    expect(noPriceNotice(ov({ ...noPrice, collectionMethod: "AUTO_DEBIT", autoDebit: debit({ status: "paused" }) }))).toBe(
      "Tu plan todavía no tiene precio: el débito se activa cuando lo carguemos."
    );
    expect(noPriceNotice(ov({ ...noPrice, autoDebit: debit({ status: "pending_authorization" }) }))).toBe(SUBSCRIPTION_COPY.noPrice);
    expect(noPriceNotice(ov({ ...noPrice }))).toBeNull();
    expect(noPriceNotice(ov({ collectionMethod: "AUTO_DEBIT", autoDebit: debit({ status: "active" }) }))).toBeNull();
  });

  it("[MPS-4a] desglose del próximo cargo: base + ajustes − saldo = total; sin ajustes ni saldo no hay desglose", () => {
    const lines = nextChargeLines(
      ov({ nextCharge: { periodStart: "2026-12-04", amountCents: 2500000, breakdown: { baseCents: 2500000, adjustmentsCents: 300000, creditCents: -500000, amountCents: 2300000 } } })
    );
    expect(lines?.map((l) => [l.label, plain(l.amount)])).toEqual([
      ["Plan Consultorio", "$ 25.000"],
      ["Ajustes", "+ $ 3.000"],
      ["Saldo a favor", "− $ 5.000"],
      ["Total del 4/12", "$ 23.000"],
    ]);
    expect(nextChargeLines(ov({}))).toBeNull();
    expect(nextChargeLines(ov({ nextCharge: null }))).toBeNull();
  });

  it("[MPS-4a] primer período: el mes completo más el proporcional del alta (días AR del 21/10 al 3/11)", () => {
    const n = firstPeriodNotice({ billableFrom: "2026-10-21", nextChargeOn: "2026-11-04", priceCents: 3100000, hasCharges: false });
    // 14 de 31 días de $31.000 = $14.000.
    expect(plain(n)).toBe("El 4/11 se cobra el mes completo más $ 14.000 por los días del 21/10 al 3/11.");
    expect(firstPeriodNotice({ billableFrom: "2026-10-21", nextChargeOn: "2026-11-04", priceCents: 3100000, hasCharges: true })).toBeNull();
    expect(firstPeriodNotice({ billableFrom: "2026-11-04", nextChargeOn: "2026-11-04", priceCents: 3100000, hasCharges: false })).toBeNull();
    expect(firstPeriodNotice({ billableFrom: "2026-10-21", nextChargeOn: "2026-11-04", priceCents: null, hasCharges: false })).toBeNull();
  });

  it("[MPS-4a] copy del cambio de plan: subida con proporcional, bajada programada, bloqueada por la baja", () => {
    const up: PlanChangeBilling = { kind: "upgrade_prorated", effectiveOn: "2026-11-22", prorationCents: 400000, days: 12, periodDays: 30 };
    expect(plain(planChangeBillingCopy(up, { toLabel: "Clínica", fromLabel: "Consultorio", trialing: false }))).toBe(
      "Pasás a Clínica hoy. En el cargo del 4/12 se suman $ 4.000 por los 12 días que quedan."
    );
    const down: PlanChangeBilling = { kind: "scheduled_downgrade", effectiveOn: "2026-12-04", prorationCents: 0, days: 0, periodDays: 0 };
    expect(planChangeBillingCopy(down, { toLabel: "Individual", fromLabel: "Consultorio", trialing: false })).toBe(
      "Tu plan pasa a Individual el 4/12. Hasta ese día seguís con Consultorio y nadie pierde el acceso. Si sumás usuarios antes, la bajada no se aplica y te avisamos."
    );
    const blocked: PlanChangeBilling = { kind: "blocked_cancel_pending", effectiveOn: "2026-11-22", prorationCents: 0, days: 0, periodDays: 0 };
    expect(planChangeBillingCopy(blocked, { toLabel: "Clínica", fromLabel: "Consultorio", trialing: false })).toBe(
      "Tenés una baja programada: deshacela para cambiar de plan."
    );
  });

  it("[MPS-4a] baja: la fecha sale de la misma cuenta que el server y el confirm dice qué pasa con el débito", () => {
    expect(cancelEffectiveOnPreview(ov({}), NOW)).toBe("2026-12-04");
    // En prueba: el día siguiente al fin (02:30 UTC del 30 = 23:30 AR del 29 → 30/11).
    expect(cancelEffectiveOnPreview(ov({ subscriptionStatus: "TRIALING", trialEndsAt: "2026-11-30T02:30:00.000Z" }), NOW)).toBe("2026-11-30");
    expect(cancelConfirmMessage("2026-12-04", true)).toBe(
      "Vas a tener acceso completo hasta el 4/12. Después el consultorio queda en solo lectura. El débito se pausa ahora."
    );
    expect(cancelConfirmMessage("2026-12-04", false)).toBe("Vas a tener acceso completo hasta el 4/12. Después el consultorio queda en solo lectura.");
  });

  it("[MPS-4a] vuelta de Mercado Pago: checkout (`cargo` + `payment_id`) o débito (`debito=1`), y se limpian de la URL", () => {
    expect(parseBillingReturn("?tab=facturacion&cargo=c1&payment_id=123456&status=approved&collection_status=approved")).toEqual({
      kind: "checkout",
      chargeId: "c1",
      paymentId: "123456",
    });
    // Sin `payment_id` (cancelaron en el checkout) o con uno que no es numérico: no hay nada que confirmar.
    expect(parseBillingReturn("?tab=facturacion&cargo=c1&collection_status=null")).toEqual({ kind: "none" });
    expect(parseBillingReturn("?cargo=c1&payment_id=abc")).toEqual({ kind: "none" });
    expect(parseBillingReturn("?tab=facturacion&debito=1&preapproval_id=abc")).toEqual({ kind: "debit" });
    expect(parseBillingReturn("?tab=facturacion")).toBeNull();
    expect(BILLING_RETURN_PARAMS).toEqual(expect.arrayContaining(["cargo", "payment_id", "debito", "preapproval_id", "collection_status"]));
    expect(stripBillingReturn("https://app.test/configuracion?tab=facturacion&cargo=c1&payment_id=1&status=approved&merchant_order_id=9")).toBe(
      "https://app.test/configuracion?tab=facturacion"
    );
    expect(SUBSCRIPTION_COPY.paymentReceived).toBe("Recibimos tu pago. Puede tardar unos minutos en verse acá.");
  });

  it("[MPS-4a] la clave del cambio de plan es un UUID (el server la exige así)", () => {
    expect(newPlanChangeKey()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newPlanChangeKey()).not.toBe(newPlanChangeKey());
  });
});

describe("[MPS-4a] sección de la suscripción (render)", () => {
  const section = (o: BillingOverview) => wrap(<BillingSubscriptionSection overview={o} onChanged={() => {}} />);

  it("[MPS-4a] sin preselección: las tres formas, ninguna marcada, con su explicación", () => {
    const html = section(ov({}));
    expect(html).toContain('data-collection-method="AUTO_DEBIT"');
    expect(html).toContain('data-collection-method="MP_CHECKOUT"');
    expect(html).toContain('data-collection-method="TRANSFER"');
    expect(html).not.toContain('aria-checked="true"');
    expect(text(html)).toContain("Cómo pagás");
    expect(text(html)).toContain("Se debita el 4 de cada mes. Tu tarjeta la cargás en Mercado Pago, no acá.");
    expect(text(html)).toContain("Te avisamos el 4 y pagás hasta el 9.");
    // Con un método elegido, ese queda marcado.
    expect(section(ov({ collectionMethod: "TRANSFER" }))).toMatch(/data-collection-method="TRANSFER"[^>]*aria-checked="true"|aria-checked="true"[^>]*data-collection-method="TRANSFER"/);
  });

  it("[MPS-4a] débito pendiente: «Continuar en Mercado Pago» y «Cancelar»; activo: «Cambiar tarjeta» y «Dejar de usar el débito»", () => {
    const p = text(section(ov({ autoDebit: debit({ status: "pending_authorization", initPoint: "https://www.mercadopago.com.ar/subscriptions/checkout?x=1" }) })));
    expect(p).toContain("Falta autorizar el débito en Mercado Pago");
    expect(p).toContain("Continuar en Mercado Pago");
    expect(p).toContain("Cancelar");
    const a = section(
      ov({ collectionMethod: "AUTO_DEBIT", autoDebit: debit({ status: "active", payerEmailMasked: "m***@gmail.com", amountCents: 2500000, nextDebitOn: "2026-12-04" }) })
    );
    expect(text(a)).toMatch(/Débito activo · m\*\*\*@gmail\.com · próximo débito 4\/12 por \$ 25\.000/);
    expect(text(a)).toContain("Cambiar tarjeta");
    expect(text(a)).toContain("Dejar de usar el débito");
    // Con el débito activo el selector no se muestra (se abre con «Dejar de usar el débito»).
    expect(a).not.toContain('data-collection-method="AUTO_DEBIT"');
  });

  it("[MPS-4a] baja: botón con el plan al día; banda «Pediste la baja…» con «Deshacer baja»; dada de baja «Reactivar suscripción»", () => {
    expect(text(section(ov({})))).toContain("Dar de baja la suscripción");
    const pending = text(section(ov({ cancel: { effectiveOn: "2026-12-04", requestedAt: "2026-11-20T12:00:00.000Z" } })));
    expect(pending).toContain("Pediste la baja: tenés acceso completo hasta el 4/12.");
    expect(pending).toContain("Deshacer baja");
    expect(pending).not.toContain("Dar de baja la suscripción");
    const done = text(section(ov({ subscriptionStatus: "CANCELLED", cancel: { effectiveOn: "2026-11-04", requestedAt: null }, nextCharge: null })));
    expect(done).toContain("Reactivar suscripción");
    expect(done).not.toContain("Deshacer baja");
    expect(done).not.toContain("Cómo pagás");
  });

  it("[MPS-4a] bajada programada: banda con la fecha y «Anular el cambio de plan»", () => {
    const html = text(section(ov({ pendingPlan: { plan: "INDIVIDUAL", planLabel: "Individual", effectiveOn: "2026-12-04", disableCount: 2 } })));
    expect(html).toContain("Tu plan pasa a Individual el 4/12.");
    expect(html).toContain("Anular el cambio de plan");
  });

  it("[MPS-4a] modo manual: solo lo que aplica a transferencia y baja (nada de Mercado Pago)", () => {
    const html = text(
      section(
        ov({
          mode: "manual",
          autoDebit: debit({ status: "active", payerEmailMasked: "m***@gmail.com" }),
          pendingPlan: { plan: "INDIVIDUAL", planLabel: "Individual", effectiveOn: "2026-12-04", disableCount: 0 },
        })
      )
    );
    expect(html).not.toContain("Mercado Pago");
    expect(html).not.toContain("Cómo pagás");
    expect(html).toContain("Dar de baja la suscripción");
    expect(html).toContain("Anular el cambio de plan");
  });

  it("[MPS-4a] modo off: la sección no muestra nada", () => {
    expect(text(section(ov({ mode: "off" }))).trim()).toBe("");
  });
});

describe("[MPS-4a] Facturación: «Pagar con Mercado Pago» por cargo", () => {
  it("[MPS-4a] con mp, cada cargo impago tiene su botón; los pagados no; con manual nunca", () => {
    const charges = [charge({ id: "c2" }), charge({ id: "c1", status: "PAID", paidCents: 2500000, remainingCents: 0 })];
    const mp = wrap(<BillingPanel initial={ov({ charges })} />);
    expect(mp.match(/data-pay-mp="c2"/g)).toHaveLength(1);
    expect(mp).not.toContain('data-pay-mp="c1"');
    expect(text(mp)).toContain("Pagar con Mercado Pago");
    const manual = wrap(<BillingPanel initial={ov({ mode: "manual", charges })} />);
    expect(manual).not.toContain("data-pay-mp");
  });
});

describe("[MPS-4a] drawer de cambio de plan con la plata", () => {
  const PREVIEW: PlanChangePreview = {
    from: "CONSULTORIO",
    to: "CLINICA",
    limits: { maxUsers: 10, maxProfessionals: null, maxStaff: null },
    usage: seatUsageByKind({ professional: 2, staff: 1 }, { maxUsers: 10, maxProfessionals: null, maxStaff: null }),
    mustDisable: { professional: 0, staff: 0, total: 0 },
    candidates: [],
    invitesToRevoke: [],
    reactivatable: [],
    modulesLost: [],
    modulesGained: [],
    priceCents: 6000000,
    tenantUpdatedAt: "2026-11-15T12:00:00.000Z",
  };
  const review = (billing: PlanChangeBilling | undefined, firstPeriod?: { billableFrom: string; nextChargeOn: string } | null) => {
    const none = new Set<string>();
    const preview = billing ? { ...PREVIEW, billing } : PREVIEW;
    return text(
      renderToStaticMarkup(
        <PlanChangeReview
          preview={preview}
          toLabel="Clínica"
          fromLabel="Consultorio"
          vertical="KINESIOLOGY"
          trialing={false}
          disable={none}
          reactivate={none}
          state={planChangeSelectionState(PREVIEW, none, none)}
          firstPeriod={firstPeriod}
          onToggleDisable={() => {}}
          onToggleReactivate={() => {}}
        />
      )
    );
  };

  it("[MPS-4a] subida: «Pasás a Clínica hoy…» y ya no dice «No hay prorrateo»", () => {
    const html = review({ kind: "upgrade_prorated", effectiveOn: "2026-11-22", prorationCents: 400000, days: 12, periodDays: 30 });
    expect(html).toContain("Pasás a Clínica hoy. En el cargo del 4/12 se suman $ 4.000 por los 12 días que quedan.");
    expect(html).not.toContain("No hay prorrateo");
  });

  it("[MPS-4a] cambio inmediato en el primer período: el mes completo más los días del alta con el precio nuevo", () => {
    const html = review({ kind: "immediate", effectiveOn: "2026-10-21", prorationCents: 0, days: 0, periodDays: 0 }, { billableFrom: "2026-10-21", nextChargeOn: "2026-11-04" });
    // 14 de 31 días de $60.000 = $27.097 (half-up).
    expect(html).toContain("El 4/11 se cobra el mes completo más $ 27.097 por los días del 21/10 al 3/11.");
  });

  it("[MPS-4a] sin `billing` (preview viejo) se mantiene el copy de antes", () => {
    expect(review(undefined)).toContain("El plan nuevo rige desde el próximo cargo.");
  });
});
