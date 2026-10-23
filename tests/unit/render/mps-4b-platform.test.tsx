import { describe, it, expect, vi } from "vitest";
// El provider de Plataforma monta el `StepUpProvider`, que trae la server action `getStepUpOptions`.
vi.mock("@/lib/two-factor", () => ({ getStepUpOptions: async () => ({ ok: false, error: "x" }) }));
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [MPS-4b] /plataforma → consultorio → Facturación con Mercado Pago (§26.6 UI de Plataforma, C-MPS11): tarjeta de la
 * suscripción (método, débito en vivo, preapproval pendiente, bajada y baja programadas), desglose de cada cargo,
 * ajustes, diálogos de saldo a favor / cargo extra, re-anclar al 4 y precio a medida atado a un plan. Sin jsdom: se
 * renderizan los componentes reales con props y se prueban los builders puros. Se mockean las actions (no hay DB en
 * unit), el router, el toast y el confirm; nunca las funciones bajo test.
 */
vi.mock("@/lib/platform-billing", () => ({
  recordManualPayment: vi.fn(),
  reviewPayment: vi.fn(),
  voidCharge: vi.fn(),
  waiveCharge: vi.fn(),
  setCustomPrice: vi.fn(),
  getPlatformReceiptUrl: vi.fn(),
  setAutoDebitAllowed: vi.fn(),
  addAdjustment: vi.fn(),
  getMpSubscriptionStatus: vi.fn(),
  previewReanchor: vi.fn(),
  applyReanchor: vi.fn(),
  undoCancelFor: vi.fn(),
  cancelScheduledPlanFor: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), usePathname: () => "/plataforma/consultorios/t1/facturacion" }));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => vi.fn(async () => true) }));

import type { PlatformReanchorPreview, PlatformTenantLedger } from "@/lib/platform-billing-types";
import type { BillingAdjustmentRow, BillingChargeRow, PlatformMpSubscriptionStatus } from "@/lib/saas-billing-types";
import {
  buildAdjustmentPayload,
  emptyAdjustment,
  isAdjustmentDirty,
  mpDriftText,
  mpsUiFor,
  reanchorRows,
  reanchorStubText,
  signedARS,
  validateAdjustment,
} from "@/components/plataforma/billing/billing-logic";
import { AdjustmentsList, ChargesList, CustomPriceForm, LedgerSummary, TenantLedgerView } from "@/components/plataforma/billing/ledger-view";
import { AdjustmentForm, ReanchorPreviewView } from "@/components/plataforma/billing/ledger-dialogs";
import { MpLiveStatusPanel, SubscriptionMpCardView } from "@/components/plataforma/billing/subscription-mp-card";

const noop = () => {};

const charge = (over: Partial<BillingChargeRow> = {}): BillingChargeRow => ({
  id: "c1",
  plan: "CONSULTORIO",
  periodStart: "2026-11-04",
  periodEnd: "2026-12-04",
  dueDate: "2026-11-09",
  amountCents: 5_000_000,
  paidCents: 0,
  remainingCents: 5_000_000,
  status: "OPEN",
  overdue: false,
  paidAt: null,
  note: null,
  ...over,
});

const adj = (over: Partial<BillingAdjustmentRow> = {}): BillingAdjustmentRow => ({
  id: "a1",
  kind: "CREDIT",
  amountCents: -500_000,
  effectiveOn: "2026-12-04",
  description: "Compensación por la caída del 3/11",
  planFrom: null,
  planTo: null,
  days: null,
  periodDays: null,
  appliedChargeId: null,
  appliedAt: null,
  createdAt: "2026-11-10T15:00:00.000Z",
  ...over,
});

const ledger = (over: Partial<PlatformTenantLedger> = {}): PlatformTenantLedger => ({
  tenantId: "t1",
  plan: "CONSULTORIO",
  planLabel: "Consultorio",
  planPriceCents: 5_500_000,
  customPriceCents: null,
  effectivePriceCents: 5_500_000,
  subscriptionStatus: "ACTIVE",
  trialEndsAt: null,
  anchorDay: 4,
  nextCharge: { periodStart: "2026-12-04", amountCents: 5_000_000, breakdown: { baseCents: 5_500_000, adjustmentsCents: -500_000, creditCents: 0, amountCents: 5_000_000 } },
  balanceCents: 0,
  creditCents: 0,
  overdueCount: 0,
  pendingReviewCount: 0,
  charges: [],
  payments: [],
  tenantName: "Movare",
  tenantSlug: "movare",
  tenantStatus: "ACTIVE",
  tenantUpdatedAt: "2026-10-01T00:00:00.000Z",
  collectionMethod: "AUTO_DEBIT",
  pendingAdjustments: [],
  appliedAdjustments: [],
  chargeBreakdown: {},
  autoDebit: {
    status: "active",
    allowed: true,
    payerEmailMasked: "m***@gmail.com",
    amountCents: 5_000_000,
    nextDebitOn: "2026-12-04",
    initPoint: null,
    syncedAt: "2026-11-20T11:00:00.000Z",
  },
  cancel: null,
  pendingPlan: null,
  billableFrom: "2026-10-04",
  ...over,
});

const live = (over: Partial<PlatformMpSubscriptionStatus> = {}): PlatformMpSubscriptionStatus => ({
  tenantId: "t1",
  collectionMethod: "AUTO_DEBIT",
  autoDebitAllowed: true,
  autoDebitEnabled: true,
  preapprovalId: "2c938084726fca480172750000000000",
  storedStatus: "authorized",
  liveStatus: "authorized",
  payerEmailMasked: "m***@gmail.com",
  amountCents: 5_000_000,
  liveAmountCents: 5_000_000,
  nextDebitAt: "2026-12-04T11:00:00.000Z",
  syncedAt: "2026-11-20T11:00:00.000Z",
  pendingPreapprovalId: null,
  pendingCreatedAt: null,
  retiredPreapprovalId: null,
  drift: false,
  ...over,
});

const preview = (over: Partial<PlatformReanchorPreview> = {}): PlatformReanchorPreview => ({
  tenantId: "t1",
  fromAnchorDay: 15,
  toAnchorDay: 4,
  stubFrom: "2026-11-15",
  stubTo: "2026-12-04",
  stubCents: 3_483_333,
  days: 19,
  periodDays: 30,
  noop: false,
  oldNextChargeOn: "2026-11-15",
  newNextChargeOn: "2026-12-04",
  hasCharges: true,
  reenablesAutoDebit: false,
  ...over,
});

const cardProps = {
  live: null,
  liveError: null,
  pending: false,
  onConsult: noop,
  onToggleAllowed: noop,
  onReanchor: noop,
  onUndoCancel: noop,
  onCancelPendingPlan: noop,
};

describe("[MPS-4b] modo de cobro: con `off` no aparece nada a medio hacer", () => {
  it("[MPS-4b] off = nada; manual = ajustes y suscripción sin Mercado Pago; mp = todo", () => {
    expect(mpsUiFor("off")).toEqual({ subscription: false, adjustments: false, mercadoPago: false });
    expect(mpsUiFor("manual")).toEqual({ subscription: true, adjustments: true, mercadoPago: false });
    expect(mpsUiFor("mp")).toEqual({ subscription: true, adjustments: true, mercadoPago: true });
  });

  it("[MPS-4b] el ledger con `off` no muestra tarjeta de suscripción, ajustes ni re-anclar (aunque el ledger traiga datos MPS)", () => {
    const html = renderToStaticMarkup(
      <TenantLedgerView ledger={ledger({ anchorDay: 15, pendingAdjustments: [adj()], cancel: { effectiveOn: "2026-12-04", requestedAt: null } })} mode="off" />
    );
    expect(html).not.toContain("Suscripción y cobro");
    expect(html).not.toContain("Sumar saldo a favor");
    expect(html).not.toContain("Cargo extra");
    expect(html).not.toContain("Re-anclar al 4");
    expect(html).not.toContain("Deshacer baja");
    expect(html).not.toContain("Consultar en Mercado Pago");
    // Lo de PL-3c sigue.
    expect(html).toContain("Estado de cuenta");
    expect(html).toContain("Precio a medida");
  });

  it("[MPS-4b] con `manual` aparecen ajustes y suscripción, pero nada de Mercado Pago", () => {
    const html = renderToStaticMarkup(<TenantLedgerView ledger={ledger({ collectionMethod: "TRANSFER", autoDebit: null })} mode="manual" />);
    expect(html).toContain("Suscripción y cobro");
    expect(html).toContain("Sumar saldo a favor");
    expect(html).toContain("Cargo extra");
    expect(html).not.toContain("Consultar en Mercado Pago");
    expect(html).not.toContain("Bloquear débito");
  });
});

describe("[MPS-4b] tarjeta de la suscripción", () => {
  it("[MPS-4b] método de cobro, débito activo con email enmascarado, monto y próximo débito; «Bloquear débito» en mp", () => {
    const html = renderToStaticMarkup(<SubscriptionMpCardView ledger={ledger()} ui={mpsUiFor("mp")} {...cardProps} />);
    expect(html).toContain("Débito automático con Mercado Pago");
    expect(html).toContain("Débito activo");
    expect(html).toContain("m***@gmail.com");
    expect(html).toMatch(/\$\s?50\.000/);
    expect(html).toContain("Consultar en Mercado Pago");
    expect(html).toMatch(/<button[^>]*>Bloquear débito<\/button>/);
    // Nunca el email completo (el DTO ni lo trae) ni datos de tarjeta.
    expect(html).not.toMatch(/tarjeta/i);
  });

  it("[MPS-4b] bloqueado: lo dice y ofrece «Permitir débito»; sin método: «Sin elegir»", () => {
    const html = renderToStaticMarkup(
      <SubscriptionMpCardView
        ledger={ledger({ collectionMethod: null, autoDebit: { status: "blocked", allowed: false, payerEmailMasked: null, amountCents: null, nextDebitOn: null, initPoint: null, syncedAt: null } })}
        ui={mpsUiFor("mp")}
        {...cardProps}
      />
    );
    expect(html).toContain("Sin elegir");
    expect(html).toContain("Débito bloqueado desde Plataforma");
    expect(html).toMatch(/<button[^>]*>Permitir débito<\/button>/);
  });

  it("[MPS-4b] preapproval pendiente: «Falta que el titular autorice el débito»", () => {
    const html = renderToStaticMarkup(
      <SubscriptionMpCardView
        ledger={ledger({ autoDebit: { status: "pending_authorization", allowed: true, payerEmailMasked: "m***@gmail.com", amountCents: 5_000_000, nextDebitOn: null, initPoint: "https://x", syncedAt: null } })}
        ui={mpsUiFor("mp")}
        {...cardProps}
      />
    );
    expect(html).toContain("Falta que el titular autorice el débito");
    // El link de autorización es del titular: Plataforma no lo abre por él.
    expect(html).not.toContain('href="https://x"');
  });

  it("[MPS-4b] baja programada con «Deshacer baja» y bajada programada con «Anular bajada»", () => {
    const html = renderToStaticMarkup(
      <SubscriptionMpCardView
        ledger={ledger({
          cancel: { effectiveOn: "2026-12-04", requestedAt: "2026-11-10T15:00:00.000Z" },
          pendingPlan: { plan: "INDIVIDUAL", planLabel: "Individual", effectiveOn: "2026-12-04", disableCount: 2 },
        })}
        ui={mpsUiFor("mp")}
        {...cardProps}
      />
    );
    expect(html).toContain("Baja programada");
    expect(html).toMatch(/acceso completo hasta el 4\/12/);
    expect(html).toMatch(/<button[^>]*>Deshacer baja<\/button>/);
    expect(html).toContain("Pasa a Individual el 4/12");
    expect(html).toContain("2 usuarios");
    expect(html).toMatch(/<button[^>]*>Anular bajada<\/button>/);
  });

  it("[MPS-4b] ya dada de baja: muestra desde cuándo y NO ofrece deshacer", () => {
    const html = renderToStaticMarkup(
      <SubscriptionMpCardView ledger={ledger({ subscriptionStatus: "CANCELLED", cancel: { effectiveOn: "2026-11-04", requestedAt: null } })} ui={mpsUiFor("mp")} {...cardProps} />
    );
    expect(html).toContain("Dada de baja desde el 4/11");
    expect(html).not.toContain("Deshacer baja");
  });

  it("[MPS-4b] «Re-anclar al 4» solo si el día de cobro no es el 4", () => {
    const on4 = renderToStaticMarkup(<SubscriptionMpCardView ledger={ledger()} ui={mpsUiFor("mp")} {...cardProps} />);
    expect(on4).not.toContain("Re-anclar al 4");
    const on15 = renderToStaticMarkup(<SubscriptionMpCardView ledger={ledger({ anchorDay: 15 })} ui={mpsUiFor("mp")} {...cardProps} />);
    expect(on15).toMatch(/<button[^>]*>Re-anclar al 4<\/button>/);
    expect(on15).toContain("Factura desde el 4/10");
  });

  it("[MPS-4b] estado en vivo: estado y monto de Mercado Pago, autorización pendiente y desvío explicado", () => {
    const ok = renderToStaticMarkup(<MpLiveStatusPanel status={live()} />);
    expect(ok).toContain("Autorizado");
    expect(ok).toContain("Coincide con lo guardado");
    const drift = live({ liveStatus: "paused", liveAmountCents: 4_000_000, drift: true, pendingPreapprovalId: "abc", pendingCreatedAt: "2026-11-18T15:00:00.000Z" });
    const html = renderToStaticMarkup(<MpLiveStatusPanel status={drift} />);
    expect(html).toContain("Pausado");
    expect(html).toContain(mpDriftText(drift)!);
    expect(html).toMatch(/autorización pendiente desde el 18\/11/i);
    const unread = renderToStaticMarkup(<MpLiveStatusPanel status={live({ liveStatus: null, liveAmountCents: null })} />);
    expect(unread).toContain("No pudimos leer el estado en Mercado Pago");
  });

  it("[MPS-4b] desvío: texto con lo que difiere; sin desvío, null", () => {
    expect(mpDriftText(live())).toBeNull();
    const t = mpDriftText(live({ drift: true, liveStatus: "cancelled" }))!;
    expect(t).toContain("«Cancelado»");
    expect(t).toContain("«Autorizado»");
    expect(t).toContain("conciliación diaria");
  });
});

describe("[MPS-4b] desglose y ajustes", () => {
  it("[MPS-4b] cada cargo muestra base + ajustes cuando hay desglose; sin desglose, como antes", () => {
    const c = charge();
    const html = renderToStaticMarkup(
      <ChargesList
        charges={[c, charge({ id: "c-old", periodStart: "2026-10-04" })]}
        breakdown={{
          c1: {
            baseAmountCents: 5_500_000,
            adjustmentsCents: -500_000,
            adjustments: [adj({ appliedChargeId: "c1", appliedAt: "2026-11-04T11:00:00.000Z" })],
            hasCheckout: true,
          },
        }}
        onWaive={noop}
        onVoid={noop}
      />
    );
    const li = (id: string) => html.match(new RegExp(`<li[^>]*data-charge="${id}"[^>]*>([\\s\\S]*?)</li>`))![1];
    expect(li("c1")).toMatch(/Base \$\s?55\.000/);
    expect(li("c1")).toMatch(/− \$\s?5\.000/);
    expect(li("c1")).toContain("Saldo a favor");
    expect(li("c1")).toContain("Link de pago de Mercado Pago vigente");
    expect(li("c-old")).not.toContain("Base");
  });

  it("[MPS-4b] lista de ajustes: pendientes (entran en el cargo del…) y aplicados (imputados), con signo", () => {
    const html = renderToStaticMarkup(
      <AdjustmentsList
        pending={[adj(), adj({ id: "a2", kind: "PRORATION", amountCents: 1_200_000, planFrom: "INDIVIDUAL", planTo: "CONSULTORIO", days: 12, periodDays: 30, description: "Subida" })]}
        applied={[adj({ id: "a3", kind: "DEBIT", amountCents: 300_000, appliedChargeId: "c1", appliedAt: "2026-11-04T11:00:00.000Z", effectiveOn: "2026-11-04", description: "Migración de datos" })]}
        charges={[charge()]}
      />
    );
    expect(html).toContain("Pendientes");
    expect(html).toMatch(/Entra en el cargo del 4\/12/);
    expect(html).toMatch(/− \$\s?5\.000/);
    expect(html).toContain("Proporcional Individual → Consultorio · 12 de 30 días");
    expect(html).toContain("Aplicados");
    expect(html).toMatch(/\+ \$\s?3\.000/);
    expect(html).toContain("Cargo extra");
    expect(html).toMatch(/Imputado al cargo del 4\/11/);
  });

  it("[MPS-4b] sin ajustes: lo dice", () => {
    const html = renderToStaticMarkup(<AdjustmentsList pending={[]} applied={[]} charges={[]} />);
    expect(html).toContain("Todavía no hay ajustes");
  });

  it("[MPS-4b] próximo cargo con desglose en el resumen", () => {
    const html = renderToStaticMarkup(<LedgerSummary ledger={ledger()} />);
    expect(html).toMatch(/base \$\s?55\.000/);
    expect(html).toMatch(/ajustes − \$\s?5\.000/);
  });

  it("[MPS-4b] signo: positivo suma, negativo resta", () => {
    expect(signedARS(150_000)).toMatch(/^\+ \$\s?1\.500$/);
    expect(signedARS(-150_000)).toMatch(/^− \$\s?1\.500$/);
  });
});

describe("[MPS-4b] diálogos de saldo a favor y cargo extra", () => {
  it("[MPS-4b] validación: monto > 0 y descripción obligatoria (≤ 300)", () => {
    expect(validateAdjustment(emptyAdjustment())).toEqual({
      amount: expect.any(String),
      description: expect.any(String),
    });
    expect(validateAdjustment({ amountCents: 100_000, description: "x".repeat(301) })).toHaveProperty("description");
    expect(validateAdjustment({ amountCents: 100_000, description: "Bonificación" })).toEqual({});
    expect(isAdjustmentDirty(emptyAdjustment())).toBe(false);
    expect(isAdjustmentDirty({ amountCents: null, description: " a" })).toBe(true);
  });

  it("[MPS-4b] payload: monto POSITIVO en centavos (el signo lo pone el tipo en el server), descripción recortada y la clave del diálogo", () => {
    const key = "0b7c3e1e-6f8a-4e3d-9a51-6f0a1d2b3c4d";
    expect(buildAdjustmentPayload("t1", "CREDIT", { amountCents: 150_050, description: "  Bonificación  " }, key)).toEqual({
      tenantId: "t1",
      kind: "CREDIT",
      amountCents: 150_050,
      description: "Bonificación",
      idempotencyKey: key,
    });
  });

  it("[MPS-4b] render: saldo a favor explica que el cargo nunca queda negativo; cargo extra, que se suma", () => {
    const base = { state: emptyAdjustment(), errors: {}, serverError: null, pending: false, dirty: false, onChange: noop, onSubmit: noop, onCancel: noop };
    const credit = renderToStaticMarkup(<AdjustmentForm kind="CREDIT" {...base} />);
    expect(credit).toContain("nunca queda en negativo");
    expect(credit).toContain("Descripción");
    expect(credit).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>Sumar saldo a favor</);
    const debit = renderToStaticMarkup(<AdjustmentForm kind="DEBIT" {...base} dirty serverError="Datos inválidos" />);
    expect(debit).toContain("Se suma al próximo cargo");
    expect(debit).toContain("Datos inválidos");
    expect(debit).toMatch(/<button[^>]*type="submit"[^>]*>Sumar cargo extra</);
  });
});

describe("[MPS-4b] re-anclar al 4", () => {
  it("[MPS-4b] tabla ancla vieja → nueva y el proporcional del primer cargo", () => {
    expect(reanchorRows(preview())).toEqual([
      { label: "Día de cobro", before: "El 15", after: "El 4" },
      { label: "Próximo cobro", before: "15/11", after: "4/12" },
    ]);
    expect(reanchorStubText(preview())).toMatch(/proporcional de \$\s?34\.833 \(19 de 30 días, hasta el 4\/12\)/);
    expect(reanchorStubText(preview({ stubCents: 0 }))).toContain("No hay proporcional");
  });

  it("[MPS-4b] preview: tabla, «Factura desde», y aviso si re-anclar vuelve a permitir el débito", () => {
    const html = renderToStaticMarkup(<ReanchorPreviewView preview={preview({ reenablesAutoDebit: true })} />);
    expect(html).toContain("<table");
    expect(html).toContain("El 15");
    expect(html).toContain("El 4");
    expect(html).toContain("Se factura desde el 15/11");
    expect(html).toContain("vuelve a permitir el débito automático");
    const plain = renderToStaticMarkup(<ReanchorPreviewView preview={preview()} />);
    expect(plain).not.toContain("vuelve a permitir");
    const noop4 = renderToStaticMarkup(<ReanchorPreviewView preview={preview({ noop: true, fromAnchorDay: 4 })} />);
    expect(noop4).toContain("Ya cobra el 4");
  });
});

describe("[MPS-4b] precio a medida atado a un plan (MPS-D14)", () => {
  it("[MPS-4b] elige el plan al que queda atado (default: el actual) y explica qué pasa si cambia de plan", () => {
    const html = renderToStaticMarkup(
      <CustomPriceForm value={3_000_000} saved={null} planPriceCents={5_500_000} plan="CONSULTORIO" pending={false} onChange={noop} onPlanChange={noop} onSave={noop} />
    );
    expect(html).toContain("Para el plan");
    expect(html).toMatch(/<option[^>]*value="CONSULTORIO"[^>]*selected=""/);
    expect(html).toContain("paga el precio de lista del plan nuevo");
  });
});
