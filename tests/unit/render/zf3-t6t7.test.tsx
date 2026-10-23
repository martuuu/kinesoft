import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [ZF3] Fixer de UI del cierre de T6+T7 (hallazgos del revisor ZB). Componentes y funciones REALES; se mockea solo la
 * red (server actions), el router de Next y los hooks de form del React canary que el react-dom 18 de node no trae.
 */
vi.mock("next/navigation", () => ({
  usePathname: () => "/configuracion",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));
vi.mock("react-dom", async (orig) => ({
  ...(await orig<typeof import("react-dom")>()),
  useFormState: () => [null, "/tv"],
  useFormStatus: () => ({ pending: false, data: null, method: null, action: null }),
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
vi.mock("@/lib/saas-billing", () => ({
  getBillingOverview: async () => null,
  getReceiptUrl: async () => ({ ok: false, error: "x" }),
  submitPaymentReceipt: async () => ({ ok: false, error: "x" }),
}));
vi.mock("@/lib/two-factor", () => ({ getStepUpOptions: async () => ({ ok: false, error: "x" }) }));
vi.mock("@/lib/portal-whatsapp-consent", () => ({ setMyWhatsAppConsent: vi.fn(), getMyWhatsAppConsent: vi.fn() }));
// `whatsapp-panel` importa sus actions (red); el copy que se afirma es un literal del módulo del panel.
vi.mock("@/lib/whatsapp-actions", () => ({}));

import type { BillingOverview } from "@/lib/saas-billing-types";
import { collectionChoices } from "@/lib/saas-billing-view";
import { faqItems } from "@/components/landing/faq";
import { BillingSubscriptionSection } from "@/components/configuracion/panels/billing-subscription-section";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { WA_PORTAL_COPY, WhatsAppConsentCard, type PortalWaConsent } from "@/components/portal/whatsapp-consent-card";
import { WA_COPY, WA_SKIP_REASON_LABEL } from "@/lib/whatsapp/copy";
import { FAKE_META_TITLE } from "@/lib/whatsapp/fake-graph-html";
import { WA_SECTION_COPY } from "@/components/agenda/booking-drawer/whatsapp-section";
import { WA_U1_COPY } from "@/components/configuracion/panels/whatsapp-panel";
import { destinationPhrase } from "@/components/tv/tv-screen";
import { TvPairScreen } from "@/components/tv/tv-pair-screen";
import { WhatsAppConsentRow } from "@/components/patients/whatsapp-consent-field";

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
    nextCharge: null,
    balanceCents: 0,
    creditCents: 0,
    overdueCount: 0,
    pendingReviewCount: 0,
    charges: [],
    payments: [],
    mode: "mp",
    canSubmitReceipt: true,
    transferInfo: "Alias kinesoft.pagos",
    collectionMethod: null,
    pendingAdjustments: [],
    appliedAdjustments: [],
    chargeBreakdown: {},
    autoDebit: null,
    cancel: null,
    pendingPlan: null,
    billableFrom: null,
    ...p,
  } as BillingOverview;
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("[ZF3] «Transferencia» solo si hay datos para transferir", () => {
  it("[ZF3] collectionChoices sin `canSubmitReceipt` no ofrece TRANSFER", () => {
    expect(collectionChoices(ov({ canSubmitReceipt: false, transferInfo: null }))).toEqual(["AUTO_DEBIT", "MP_CHECKOUT"]);
    expect(collectionChoices(ov({}))).toEqual(["AUTO_DEBIT", "MP_CHECKOUT", "TRANSFER"]);
  });

  it("[ZF3] «Cancelar» del débito pendiente usa `cancelPendingAutoDebit` (ZF1), sin step-up ni cambiar el método", async () => {
    const html = renderToStaticMarkup(
      <ToastProvider>
        <ConfirmProvider>
          <BillingSubscriptionSection overview={ov({ autoDebit: { status: "pending_authorization", allowed: true, payerEmailMasked: null, amountCents: null, nextDebitOn: null, initPoint: null, syncedAt: null } as never })} onChanged={() => {}} />
        </ConfirmProvider>
      </ToastProvider>
    );
    expect(html).toContain('data-auto-debit="pending"');
    expect(html).toMatch(/<button[^>]*>Cancelar<\/button>/);
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("components/configuracion/panels/billing-subscription-section.tsx", "utf8");
    const fn = src.slice(src.indexOf("function cancelPendingDebit()"), src.indexOf("function continuePendingDebit()"));
    expect(fn).toContain("cancelPendingAutoDebit()");
    expect(fn).not.toContain("setCollectionMethod");
    expect(fn).not.toContain("stepUp");
  });

  it("[ZF3] FAQ con `mp` y sin datos de transferencia no promete la transferencia", () => {
    const pay = (hasTransfer: boolean) =>
      faqItems({ trialDays: 14, billingMode: "mp", hasTransfer }).find((i) => i.q === "¿Cómo pago?")!.a;
    expect(pay(false)).toBe("Desde Configuración → Facturación elegís cómo pagás: débito automático o Mercado Pago cada mes.");
    expect(pay(true)).toContain("o transferencia informando el comprobante.");
  });
});

describe("[ZF3] copy de WhatsApp", () => {
  it("[ZF3] portal: «celular cargado en tus datos», no «tu ficha»", () => {
    expect(WA_PORTAL_COPY.pausedPhone).toBe(
      "Tus avisos están en pausa: cambió el celular cargado en tus datos desde que los activaste. Si querés seguir recibiéndolos, volvé a activarlos."
    );
  });

  it("[ZF3] WA_COPY alineado con la UI y sin claves muertas", () => {
    expect(WA_COPY.sendReminder).toBe("Enviar recordatorio por WhatsApp");
    expect(WA_COPY.dismissReply).toBe("Descartar aviso");
    expect(WA_SECTION_COPY).not.toHaveProperty("sendReminder");
    expect(WA_SECTION_COPY).not.toHaveProperty("dismiss");
    for (const k of ["sendTest", "resume", "switches", "testLimit", "connect", "consentCheckboxSelf"]) {
      expect(WA_COPY).not.toHaveProperty(k);
    }
    expect(WA_COPY.simulatorTitle).toBe(FAKE_META_TITLE);
    expect(WA_SKIP_REASON_LABEL.rescheduled).toMatch(/\.$/);
  });

  it("[ZF3] panel: «Enviar» en los botones y el medio de pago sin «Cargado»", () => {
    expect(WA_U1_COPY.testSend).toBe("Enviar prueba");
    expect(WA_U1_COPY.paymentOk).toBe("Meta no avisó problemas con el cobro. Si avisa alguno, lo vas a ver acá.");
  });
});

describe("[ZF3] TV", () => {
  it("[ZF3] destinationPhrase baja solo la primera palabra de la sala", () => {
    expect(destinationPhrase({ room: "Box A", practitioner: null })).toBe("Pasá al box A.");
    expect(destinationPhrase({ room: "Consultorio 2", practitioner: null })).toBe("Pasá al consultorio 2.");
    expect(destinationPhrase({ room: "Sala B", practitioner: null })).toBe("Pasá a Sala B.");
  });

  it("[ZF3] con reason=unavailable la pantalla queda en pausa: sin form de vínculo", () => {
    const noop = async () => null;
    const html = renderToStaticMarkup(<TvPairScreen action={noop} reason="unavailable" />);
    expect(html).not.toContain("<form");
    expect(text(html)).toContain("Pantalla en pausa");
    expect(text(html)).not.toContain("Vinculá esta pantalla");
    const revoked = renderToStaticMarkup(<TvPairScreen action={noop} reason="revoked" />);
    expect(revoked).toContain("<form");
  });
});

describe("[ZF3] a11y: targets de 44 px y regiones vivas siempre montadas", () => {
  it("[ZF3] «Revocar» del consentimiento mide 44 px", () => {
    const html = renderToStaticMarkup(
      <WhatsAppConsentRow
        state={{ status: "GRANTED", phoneMasked: "+54 9 11 ****-5678", phoneValid: true, phoneChanged: false, versionOutdated: false } as never}
        error={null}
        revoking={false}
        onRevoke={() => {}}
        grantChecked={false}
        onGrantChange={() => {}}
      />
    );
    const btn = html.match(/<button[^>]*>[^<]*Revocar/)?.[0] ?? "";
    expect(btn).toContain("min-height:44px");
  });

  it("[ZF3] Suscripción: el role=status está montado aunque no haya aviso", () => {
    const html = renderToStaticMarkup(
      <ToastProvider>
        <ConfirmProvider>
          <BillingSubscriptionSection overview={ov({})} onChanged={() => {}} />
        </ConfirmProvider>
      </ToastProvider>
    );
    expect(html).toMatch(/role="status"/);
  });

  it("[ZF3] portal: el role=status de la tarjeta de avisos está montado sin aviso", () => {
    const c: PortalWaConsent = {
      status: null,
      phoneMasked: "+54 9 11 ****-5678",
      phoneValid: true,
      phoneChanged: false,
      versionOutdated: false,
      currentVersion: "wa-2026-10-v1",
    };
    expect(renderToStaticMarkup(<WhatsAppConsentCard slug="norte" consent={c} canGrant />)).toMatch(/role="status"/);
  });
});
