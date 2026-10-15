import { describe, it, expect, vi } from "vitest";
// PL-Z (a2#4): el provider de Plataforma monta el `StepUpProvider`, que trae la server action `getStepUpOptions`.
vi.mock("@/lib/two-factor", () => ({ getStepUpOptions: async () => ({ ok: false, error: "x" }) }));
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [PL-3c] /plataforma → Facturación, ledger del consultorio, Precios y «Cambiar de plan». Sin jsdom: se renderizan los
 * componentes reales con props (los cuerpos sin estado) y se prueban los builders puros. Se mockean las actions (no
 * hay DB en unit), el router, el toast y el confirm; nunca las funciones bajo test.
 */
vi.mock("@/lib/platform-billing", () => ({
  recordManualPayment: vi.fn(),
  reviewPayment: vi.fn(),
  voidCharge: vi.fn(),
  waiveCharge: vi.fn(),
  setCustomPrice: vi.fn(),
  updatePlanPrice: vi.fn(),
  getPlatformReceiptUrl: vi.fn(),
  platformPreviewPlanChange: vi.fn(),
  platformApplyPlanChange: vi.fn(),
}));
vi.mock("@/lib/platform-tenants", () => ({ updatePlatformTenant: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), usePathname: () => "/plataforma/facturacion" }));
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => vi.fn(async () => true) }));

import { parseMoneyInput } from "@/lib/format";
import type { PlatformAccountRow, PlatformTenantLedger } from "@/lib/platform-billing-types";
import type { BillingChargeRow, BillingPaymentRow } from "@/lib/saas-billing-types";
import type { PlanChangePreview } from "@/lib/saas-plan-change-types";
import {
  accountStateOf,
  accountsHref,
  balanceText,
  buildPaymentFormData,
  buildPlanPricePayload,
  emptyRecordPayment,
  filterAccountRows,
  parseAccountsQuery,
  priceNoticeText,
  selectionFits,
  selectionShortfall,
  shortfallText,
  validatePriceForm,
  validateRecordPayment,
  voidConfirmMatches,
  type RecordPaymentState,
} from "@/components/plataforma/billing/billing-logic";
import { AccountsList } from "@/components/plataforma/billing/accounts-list";
import { ChargesList, LedgerSummary, PaymentsList, PendingReviewsList, openChargesOf } from "@/components/plataforma/billing/ledger-view";
import { RecordPaymentForm } from "@/components/plataforma/billing/record-payment-drawer";
import { ReviewPaymentForm, VoidChargeForm, defaultReviewCharge, reviewCanSubmit } from "@/components/plataforma/billing/ledger-dialogs";
import { PriceEditorForm, PriceHistoryList } from "@/components/plataforma/billing/price-editor";
import { PlanChangeForm } from "@/components/plataforma/billing/plan-change-drawer";

const NOW = new Date("2026-10-15T15:00:00.000Z");

const account = (over: Partial<PlatformAccountRow> = {}): PlatformAccountRow => ({
  tenantId: "t1",
  name: "Movare",
  slug: "movare",
  status: "ACTIVE",
  saasPlan: "CONSULTORIO",
  subscriptionStatus: "ACTIVE",
  customPriceCents: null,
  effectivePriceCents: 5_500_000,
  balanceCents: 0,
  openCharges: 0,
  overdueCharges: 0,
  pendingReviews: 0,
  nextChargeOn: "2026-11-05",
  lastPaymentAt: "2026-10-06T15:00:00.000Z",
  ...over,
});

const charge = (over: Partial<BillingChargeRow> = {}): BillingChargeRow => ({
  id: "c1",
  plan: "CONSULTORIO",
  periodStart: "2026-10-05",
  periodEnd: "2026-11-05",
  dueDate: "2026-10-10",
  amountCents: 5_500_000,
  paidCents: 0,
  remainingCents: 5_500_000,
  status: "OPEN",
  overdue: false,
  paidAt: null,
  note: null,
  ...over,
});

const payment = (over: Partial<BillingPaymentRow> = {}): BillingPaymentRow => ({
  id: "p1",
  chargeId: "c1",
  chargePeriodStart: "2026-10-05",
  source: "MANUAL",
  method: "TRANSFER",
  status: "APPROVED",
  amountCents: 5_500_000,
  paidAt: "2026-10-06T15:00:00.000Z",
  createdAt: "2026-10-06T15:00:00.000Z",
  hasReceipt: true,
  receiptMimeType: "application/pdf",
  note: null,
  reviewNote: null,
  reviewedAt: null,
  ...over,
});

const ledger = (over: Partial<PlatformTenantLedger> = {}): PlatformTenantLedger => ({
  tenantId: "t1",
  plan: "CONSULTORIO",
  planLabel: "Consultorio",
  planPriceCents: 5_500_000,
  customPriceCents: null,
  effectivePriceCents: 5_500_000,
  subscriptionStatus: "PAST_DUE",
  trialEndsAt: null,
  anchorDay: 5,
  nextCharge: { periodStart: "2026-11-05", amountCents: 5_500_000 },
  balanceCents: 5_500_000,
  creditCents: 0,
  overdueCount: 1,
  pendingReviewCount: 0,
  charges: [],
  payments: [],
  tenantName: "Movare",
  tenantSlug: "movare",
  tenantStatus: "ACTIVE",
  tenantUpdatedAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

const noop = () => {};

describe("[PL-3c] lista de cuentas: filtros", () => {
  it("la URL ida y vuelta: vista, plan, estado, búsqueda y cursor; basura → sin filtro", () => {
    const q = parseAccountsQuery({ ver: "revisar", plan: "CLINICA", estado: "PAST_DUE", q: " mov ", desde: "t9" });
    expect(q).toEqual({ view: "to_review", plan: "CLINICA", status: "PAST_DUE", q: "mov", cursor: "t9" });
    expect(accountsHref(q, q.cursor)).toBe("/plataforma/facturacion?ver=revisar&plan=CLINICA&estado=PAST_DUE&q=mov&desde=t9");
    expect(parseAccountsQuery({ ver: "x", plan: "PRO", estado: "nada" })).toEqual({ view: "all", plan: "", status: "", q: "", cursor: null });
    expect(accountsHref(parseAccountsQuery({}))).toBe("/plataforma/facturacion");
  });

  it("plan y estado filtran la página (hasta que `listAccounts` los reciba)", () => {
    const rows = [account(), account({ tenantId: "t2", saasPlan: "CLINICA" }), account({ tenantId: "t3", subscriptionStatus: "PAST_DUE" })];
    expect(filterAccountRows(rows, { plan: "CLINICA", status: "" }).map((r) => r.tenantId)).toEqual(["t2"]);
    expect(filterAccountRows(rows, { plan: "CONSULTORIO", status: "PAST_DUE" }).map((r) => r.tenantId)).toEqual(["t3"]);
    expect(filterAccountRows(rows, { plan: "", status: "" })).toHaveLength(3);
  });

  it("estado contable en texto: vencido > deuda > a favor > al día; cancelada aparte", () => {
    expect(accountStateOf({ balanceCents: 100, overdueCharges: 2, subscriptionStatus: "PAST_DUE" }).label).toBe("2 cargos vencidos");
    expect(accountStateOf({ balanceCents: 100, overdueCharges: 0, subscriptionStatus: "ACTIVE" }).label).toBe("Con deuda");
    expect(accountStateOf({ balanceCents: -100, overdueCharges: 0, subscriptionStatus: "ACTIVE" }).label).toBe("Saldo a favor");
    expect(accountStateOf({ balanceCents: 0, overdueCharges: 0, subscriptionStatus: "ACTIVE" }).label).toBe("Al día");
    expect(accountStateOf({ balanceCents: 100, overdueCharges: 1, subscriptionStatus: "CANCELLED" }).label).toBe("Cancelada");
    expect(balanceText(1_500_000)).toMatch(/^Debe \$\s?15\.000$/);
    expect(balanceText(-200_000)).toMatch(/^A favor \$\s?2\.000$/);
  });

  it("[PL-Z] B9: «N cargos vencidos» avisa más fuerte que «Con deuda» (antes salía con el tono más apagado)", () => {
    const overdue = accountStateOf({ balanceCents: 100, overdueCharges: 2, subscriptionStatus: "PAST_DUE" });
    const debt = accountStateOf({ balanceCents: 100, overdueCharges: 0, subscriptionStatus: "ACTIVE" });
    expect(overdue.urgent).toBe(true);
    expect(debt.urgent).toBe(false);
    expect(overdue.tone).not.toBe("soft");
  });

  it("render: columnas, link al ledger, precio a medida/«Consultá», comprobantes a revisar y la vista activa", () => {
    const query = parseAccountsQuery({ ver: "deuda" });
    const html = renderToStaticMarkup(
      <AccountsList
        rows={[
          account({ balanceCents: 5_500_000, openCharges: 1, overdueCharges: 1, pendingReviews: 2, subscriptionStatus: "PAST_DUE" }),
          account({ tenantId: "t2", name: "Kine Sur", customPriceCents: 3_000_000, effectivePriceCents: 3_000_000, lastPaymentAt: null }),
          account({ tenantId: "t3", name: "Libre SA", saasPlan: "LIBRE", effectivePriceCents: null }),
        ]}
        nextCursor="t3"
        query={query}
      />
    );
    for (const h of ["Consultorio", "Plan", "Precio", "Saldo", "Próximo cargo", "Último pago", "Estado"]) expect(html).toContain(`>${h}<`);
    expect(html).toContain('href="/plataforma/consultorios/t1/facturacion"');
    expect(html).toContain("1 cargo vencido");
    // B9: el vencido se pinta como aviso (ámbar, negrita, role=status), no con el Tag común.
    expect(html).toMatch(/<span role="status" class="k-tag"[^>]*font-weight:700[^>]*>1 cargo vencido</);
    expect(html).toContain("2 comprobantes a revisar");
    expect(html).toContain("A medida");
    expect(html).toContain("Consultá (no se cobra)");
    expect(html).toContain("Sin pagos");
    expect(html).toMatch(/aria-current="true"[^>]*>Con deuda</);
    expect(html).toContain('href="/plataforma/facturacion?ver=deuda&amp;desde=t3"');
    // La vista viaja en el form de plan/estado/búsqueda.
    expect(html).toMatch(/<input type="hidden" name="ver" value="deuda"/);
  });

  it("vacío con filtros vs. sin consultorios", () => {
    expect(renderToStaticMarkup(<AccountsList rows={[]} nextCursor={null} query={parseAccountsQuery({ plan: "LIBRE" })} />)).toContain(
      "Ninguna cuenta coincide con los filtros."
    );
    expect(renderToStaticMarkup(<AccountsList rows={[]} nextCursor={null} query={parseAccountsQuery({})} />)).toContain(
      "Todavía no hay consultorios."
    );
  });
});

describe("[PL-3c] ledger del consultorio", () => {
  const charges = [
    charge({ id: "c-new", periodStart: "2026-10-05", periodEnd: "2026-11-05" }),
    charge({ id: "c-old", periodStart: "2026-09-05", periodEnd: "2026-10-05", dueDate: "2026-09-10", overdue: true, paidCents: 1_000_000, remainingCents: 4_500_000 }),
    charge({ id: "c-paid", periodStart: "2026-08-05", status: "PAID", remainingCents: 0, paidCents: 5_500_000, paidAt: "2026-08-07T15:00:00.000Z" }),
    charge({ id: "c-void", periodStart: "2026-07-05", status: "VOID", remainingCents: 0, note: "No correspondía" }),
    charge({ id: "c-waived", periodStart: "2026-06-05", status: "WAIVED", remainingCents: 0 }),
  ];

  it("[PL-F1a] cargos pendientes del más reciente al más viejo (el primero es el sugerido: el último impago)", () => {
    expect(openChargesOf(charges).map((c) => c.id)).toEqual(["c-new", "c-old"]);
  });

  it("resumen: saldo, precio de lista/a medida y próximo cargo", () => {
    const html = renderToStaticMarkup(<LedgerSummary ledger={ledger()} />);
    expect(html).toMatch(/data-balance[^>]*>Debe \$\s?55\.000</);
    expect(html).toContain("de lista");
    expect(html).toContain("El 5 de cada mes");
    const custom = renderToStaticMarkup(<LedgerSummary ledger={ledger({ customPriceCents: 3_000_000, planPriceCents: null })} />);
    expect(custom).toMatch(/a medida \(lista: Consultá\)/);
  });

  it("cargos: cada estado con su rótulo; acciones solo en los pendientes; anular deshabilitado si tiene pagos", () => {
    const html = renderToStaticMarkup(<ChargesList charges={charges} onWaive={noop} onVoid={noop} />);
    const li = (id: string) => html.match(new RegExp(`<li[^>]*data-charge="${id}"[^>]*>([\\s\\S]*?)</li>`))![1];
    expect(li("c-new")).toContain(">Pendiente<");
    expect(li("c-old")).toContain(">Vencido<");
    expect(li("c-old")).toContain("Venció el");
    expect(li("c-paid")).toContain(">Pagado<");
    expect(li("c-void")).toContain(">Anulado<");
    expect(li("c-void")).toContain("Nota: No correspondía");
    expect(li("c-waived")).toContain(">Condonado<");
    for (const id of ["c-paid", "c-void", "c-waived"]) {
      expect(li(id)).not.toContain(">Condonar<");
      expect(li(id)).not.toContain(">Anular<");
    }
    expect(li("c-new")).toMatch(/<button[^>]*>Anular<\/button>/);
    expect(li("c-new")).not.toMatch(/<button[^>]*disabled=""[^>]*>Anular</);
    expect(li("c-old")).toMatch(/<button[^>]*disabled=""[^>]*>Anular</);
    expect(li("c-old")).toMatch(/<button[^>]*>Condonar<\/button>/);
  });

  it("comprobantes a revisar: solo los PENDING_REVIEW, con «Ver comprobante» y «Revisar»", () => {
    const pays = [payment({ id: "p-rev", status: "PENDING_REVIEW", method: "CASH", note: "transferí ayer" }), payment({ id: "p-ok" })];
    const html = renderToStaticMarkup(<PendingReviewsList payments={pays} onReview={noop} onViewReceipt={noop} />);
    expect(html).toContain("1 comprobante a revisar");
    // PL-F1a: el medio que informó el consultorio, de la columna (la nota va limpia).
    expect(html).toMatch(/data-payment-method="CASH"[^>]*>Efectivo</);
    expect(html).toContain("«transferí ayer»");
    expect(html).toContain('data-review="p-rev"');
    expect(html).not.toContain('data-review="p-ok"');
    expect(html).toContain("Ver comprobante");
    expect(html).toContain(">Revisar<");
    expect(renderToStaticMarkup(<PendingReviewsList payments={[payment()]} onReview={noop} onViewReceipt={noop} />)).toBe("");
  });

  it("pagos: estados, medio (o «Sin informar»), a cuenta y motivo del rechazo", () => {
    const html = renderToStaticMarkup(
      <PaymentsList
        payments={[
          payment(),
          payment({ id: "p2", status: "REJECTED", reviewNote: "El monto no coincide", hasReceipt: false }),
          payment({ id: "p3", chargeId: null, chargePeriodStart: null, method: "WALLET" }),
          payment({ id: "p4", method: null }),
        ]}
        onViewReceipt={noop}
      />
    );
    expect(html).toContain(">Aprobado<");
    expect(html).toContain(">Rechazado<");
    expect(html).toContain("Motivo del rechazo: El monto no coincide");
    expect(html).toContain("A cuenta");
    expect(html).toMatch(/data-payment-method="TRANSFER"[^>]*>Transferencia</);
    expect(html).toMatch(/data-payment-method="WALLET"[^>]*>Billetera virtual</);
    // Pagos de antes de M8c (columna NULL).
    expect(html).toMatch(/data-payment-method=""[^>]*>Sin informar</);
    // PL-F1a: el `source` ya no se muestra (sin MP siempre era «Manual»).
    expect(html).not.toContain(">Manual<");
    expect(html).not.toContain("Mercado Pago<");
  });

  it("revisar: aprobar imputa al cargo del comprobante (o al último impago); rechazar exige motivo", () => {
    const open = openChargesOf(charges);
    expect(defaultReviewCharge(payment({ chargeId: "c-old" }), open)).toBe("c-old");
    // PL-F1a: si el del comprobante ya no está pendiente, el último impago (antes: el más viejo).
    expect(defaultReviewCharge(payment({ chargeId: "c-paid" }), open)).toBe("c-new");
    expect(defaultReviewCharge(payment({ chargeId: null }), [...open].reverse())).toBe("c-new");
    expect(defaultReviewCharge(payment({ chargeId: null }), [])).toBe("");
    expect(reviewCanSubmit({ decision: "approve", chargeId: "", reason: "" })).toBe(true);
    expect(reviewCanSubmit({ decision: "reject", chargeId: "", reason: "  " })).toBe(false);
    const reject = renderToStaticMarkup(
      <ReviewPaymentForm
        payment={payment({ status: "PENDING_REVIEW" })}
        openCharges={open}
        state={{ decision: "reject", chargeId: "", reason: "" }}
        pending={false}
        error={null}
        onChange={noop}
        onViewReceipt={noop}
        onSubmit={noop}
        onCancel={noop}
      />
    );
    expect(reject).toContain("Motivo del rechazo");
    expect(reject).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>Rechazar comprobante</);
    const approve = renderToStaticMarkup(
      <ReviewPaymentForm
        payment={payment({ status: "PENDING_REVIEW" })}
        openCharges={open}
        state={{ decision: "approve", chargeId: "c-old", reason: "" }}
        pending={false}
        error={null}
        onChange={noop}
        onViewReceipt={noop}
        onSubmit={noop}
        onCancel={noop}
      />
    );
    expect(approve).toContain("Imputar a");
    expect(approve).toContain("A cuenta (sin cargo)");
    expect(approve).not.toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
  });

  it("anular pide tipear ANULAR: sin la palabra el botón queda deshabilitado", () => {
    expect(voidConfirmMatches("anular ")).toBe(true);
    expect(voidConfirmMatches("anula")).toBe(false);
    const render = (typed: string) =>
      renderToStaticMarkup(
        <VoidChargeForm charge={charge()} typed={typed} note="" pending={false} error={null} onTypedChange={noop} onNoteChange={noop} onSubmit={noop} onCancel={noop} />
      );
    expect(render("")).toContain("Para confirmar, escribí ANULAR");
    expect(render("")).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>Anular cargo</);
    expect(render("ANULAR")).not.toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
  });
});

describe("[PL-3c] registrar pago", () => {
  const base = (over: Partial<RecordPaymentState> = {}): RecordPaymentState => ({ ...emptyRecordPayment(NOW, 1_500_000), ...over });
  const pdf = { name: "recibo.pdf", size: 1000, type: "application/pdf" };

  it("el recibo es obligatorio; monto > 0; fecha no futura; tipo y tamaño", () => {
    expect(validateRecordPayment(base(), NOW).file).toMatch(/Adjuntá el comprobante/);
    expect(validateRecordPayment(base({ file: pdf }), NOW)).toEqual({});
    expect(validateRecordPayment(base({ file: pdf, amountCents: 0 }), NOW).amount).toBeDefined();
    expect(validateRecordPayment(base({ file: pdf, amountCents: null }), NOW).amount).toBeDefined();
    expect(validateRecordPayment(base({ file: pdf, paidOn: "2026-10-16" }), NOW).paidOn).toMatch(/futura/);
    expect(validateRecordPayment(base({ file: { ...pdf, size: 5 * 1024 * 1024 } }), NOW).file).toMatch(/4 MB/);
    expect(validateRecordPayment(base({ file: { ...pdf, type: "application/zip" } }), NOW).file).toMatch(/PDF, JPG/);
  });

  it("FormData: el monto viaja en TEXTO de pesos (el server lo lee con parseMoneyInput: nunca ×100) y el medio en su campo", () => {
    const fd = buildPaymentFormData("t1", base({ amountCents: 1_500_050, note: " op 123 ", method: "CASH", chargeId: "c1" }), new Blob(["x"]));
    expect(fd.get("amount")).toBe("15.000,50");
    const back = parseMoneyInput(fd.get("amount") as string);
    expect(back.ok && back.cents).toBe(1_500_050);
    expect(fd.get("tenantId")).toBe("t1");
    expect(fd.get("chargeId")).toBe("c1");
    // PL-F1a: la nota va tal cual (sin «Medio: …») y el medio con el valor del enum.
    expect(fd.get("note")).toBe("op 123");
    expect(fd.get("method")).toBe("CASH");
    expect(fd.get("file")).toBeInstanceOf(Blob);
    const empty = buildPaymentFormData("t1", base(), new Blob(["x"]));
    expect(empty.get("chargeId")).toBeNull();
    expect(empty.get("note")).toBeNull();
    expect(empty.get("method")).toBe("TRANSFER");
    expect(validateRecordPayment(base({ file: pdf, note: "x".repeat(500) }), NOW).note).toBeUndefined();
    expect(validateRecordPayment(base({ file: pdf, note: "x".repeat(501) }), NOW).note).toBeDefined();
  });

  it("render: campo de comprobante obligatorio, cargos pendientes en «Imputar a» y el error del server", () => {
    const html = renderToStaticMarkup(
      <RecordPaymentForm
        state={base({ chargeId: "c1" })}
        openCharges={[charge()]}
        errors={{ file: "Adjuntá el comprobante (PDF, JPG, PNG o WEBP de hasta 4 MB)." }}
        serverError="Adjuntá el comprobante (PDF, JPG, PNG o WEBP de hasta 4 MB)."
        pending={false}
        onChange={noop}
        onFile={noop}
        onSubmit={noop}
        onCancel={noop}
      />
    );
    expect(html).toMatch(/<input[^>]*type="file"[^>]*required=""/);
    expect(html).toContain('accept="application/pdf,image/jpeg,image/png,image/webp"');
    expect(html).not.toContain("El cargo pendiente más viejo");
    expect(html).toMatch(/<option(?=[^>]*value="c1")(?=[^>]*selected="")[^>]*>/);
    expect(html).toMatch(/<option[^>]*value=""[^>]*>A cuenta<\/option>/);
    expect(html).toMatch(/falta \$\s?55\.000/);
    expect(html).toContain("Comprobante");
    expect(html).toMatch(/role="alert"[^>]*>Adjuntá el comprobante/);
    for (const m of ["Transferencia", "Efectivo", "Tarjeta", "Billetera virtual", "Mercado Pago", "Otro"]) expect(html).toContain(`>${m}</option>`);
    expect(html).toMatch(/<option(?=[^>]*value="TRANSFER")(?=[^>]*selected="")[^>]*>Transferencia<\/option>/);
    expect(html).not.toContain("Depósito");
  });
});

describe("[PL-3c] precios", () => {
  it("«Consultá» = null; sin «Consultá» exige monto; nota vacía = null", () => {
    expect(buildPlanPricePayload("CLINICA", { consulta: true, priceCents: 9_500_000, effectiveFrom: "2026-11-01", note: " " })).toEqual({
      plan: "CLINICA",
      priceCents: null,
      effectiveFrom: "2026-11-01",
      note: null,
    });
    expect(buildPlanPricePayload("CLINICA", { consulta: false, priceCents: 9_500_000, effectiveFrom: "2026-11-01", note: "inflación" }).priceCents).toBe(9_500_000);
    expect(validatePriceForm({ consulta: false, priceCents: null, effectiveFrom: "2026-11-01", note: "" }).priceCents).toMatch(/Consultá/);
    expect(validatePriceForm({ consulta: true, priceCents: null, effectiveFrom: "2026-11-01", note: "" })).toEqual({});
    expect(validatePriceForm({ consulta: true, priceCents: null, effectiveFrom: "", note: "" }).effectiveFrom).toBeDefined();
  });

  it("aviso de mails: N consultorios; «Consultá» no avisa y lo dice", () => {
    expect(priceNoticeText(3, false)).toBe("3 consultorios sin precio a medida reciben un mail con el precio nuevo.");
    expect(priceNoticeText(1, false)).toBe("1 consultorio sin precio a medida recibe un mail con el precio nuevo.");
    expect(priceNoticeText(5, true)).toMatch(/no manda aviso/);
  });

  const renderForm = (consulta: boolean) =>
    renderToStaticMarkup(
      <PriceEditorForm
        plan="CONSULTORIO"
        current={5_500_000}
        state={{ consulta, priceCents: 6_000_000, effectiveFrom: "2026-11-01", note: "" }}
        recipients={4}
        errors={{}}
        serverError={null}
        pending={false}
        dirty
        onChange={noop}
        onSubmit={noop}
        onCancel={noop}
      />
    );

  it("editor: con precio muestra el monto y el aviso; con «Consultá» esconde el monto", () => {
    const priced = renderForm(false);
    expect(priced).toContain("Precio por mes (ARS)");
    expect(priced).toContain('value="60.000"');
    expect(priced).toContain("4 consultorios sin precio a medida reciben un mail");
    expect(priced).toContain("Rige desde");
    const consulta = renderForm(true);
    expect(consulta).not.toContain("Precio por mes (ARS)");
    expect(consulta).toMatch(/<input type="checkbox"[^>]*checked=""/);
    expect(consulta).toContain("no manda aviso");
  });

  it("historial: anterior → nuevo, pendiente/aplicado y el email rotulado (nunca como nombre)", () => {
    const html = renderToStaticMarkup(
      <PriceHistoryList
        rows={[
          { id: "h1", plan: "CLINICA", priceCents: 9_500_000, previousPriceCents: null, effectiveFrom: "2026-11-01", appliedAt: null, note: "lanzamiento", createdAt: NOW.toISOString(), createdByEmail: "martin@kinesoft.app" },
          { id: "h2", plan: "INDIVIDUAL", priceCents: 1_500_000, previousPriceCents: 1_200_000, effectiveFrom: "2026-10-01", appliedAt: NOW.toISOString(), note: null, createdAt: NOW.toISOString(), createdByEmail: null },
        ]}
      />
    );
    expect(html).toMatch(/Consultá → \$\s?95\.000/);
    expect(html).toContain("Pendiente");
    expect(html).toContain("Aplicado el");
    expect(html).toContain("Email de quien lo cargó: martin@kinesoft.app");
  });
});

describe("[PL-3c] cambiar de plan desde Plataforma", () => {
  const preview = (over: Partial<PlanChangePreview> = {}): PlanChangePreview => ({
    from: "CLINICA",
    to: "INDIVIDUAL",
    limits: { maxUsers: 1, maxProfessionals: 1, maxStaff: 1 },
    usage: {
      total: { used: 3, limit: 1, remaining: 0, full: true },
      professional: { used: 2, limit: 1, remaining: 0, full: true },
      staff: { used: 1, limit: 1, remaining: 0, full: true },
    },
    mustDisable: { professional: 1, staff: 0, total: 2 },
    candidates: [
      { membershipId: "m-owner", userId: "u1", name: "Ana Pérez", role: "OWNER", clinical: true, kind: "professional", isOwner: true, isSelf: false, futureBookings: 4, assignedPatients: 10, activePlans: 2 },
      { membershipId: "m-pro", userId: "u2", name: "Juan Gómez", role: "PRACTITIONER", clinical: true, kind: "professional", isOwner: false, isSelf: false, futureBookings: 3, assignedPatients: 0, activePlans: 0 },
      { membershipId: "m-sec", userId: "u3", name: "Laura Ríos", role: "ASSISTANT", clinical: false, kind: "staff", isOwner: false, isSelf: false, futureBookings: 0, assignedPatients: 0, activePlans: 0 },
    ],
    invitesToRevoke: [{ invitationId: "i1", email: "nuevo@movare.test", role: "PRACTITIONER" }],
    reactivatable: [],
    modulesLost: ["salas", "salaEspera"],
    modulesGained: [],
    priceCents: 1_500_000,
    tenantUpdatedAt: "2026-10-01T00:00:00.000Z",
    ...over,
  });

  it("la cuenta de «¿entra?» es la del núcleo: hay que sacar 2 (incluido 1 profesional) para Individual", () => {
    const p = preview();
    expect(selectionFits(p, new Set(), new Set())).toBe(false);
    expect(selectionFits(p, new Set(["m-sec"]), new Set())).toBe(false);
    expect(shortfallText(selectionShortfall(p, new Set(["m-sec"]), new Set()))).toMatch(/1 persona más.*1 profesional/);
    expect(selectionFits(p, new Set(["m-pro", "m-sec"]), new Set())).toBe(true);
    // Reactivar a alguien vuelve a ocupar lugar.
    const withReact = preview({ reactivatable: [{ membershipId: "m-old", name: "Pedro", role: "ASSISTANT", clinical: false, disabledAt: NOW.toISOString() }] });
    expect(selectionFits(withReact, new Set(["m-pro", "m-sec"]), new Set(["m-old"]))).toBe(false);
  });

  const render = (disable: string[], p = preview()) =>
    renderToStaticMarkup(
      <PlanChangeForm
        current="CLINICA"
        vertical="KINESIOLOGY"
        to={p.to}
        preview={p}
        loading={false}
        disable={new Set(disable)}
        reactivate={new Set()}
        error={null}
        pending={false}
        onPick={noop}
        onToggleDisable={noop}
        onToggleReactivate={noop}
        onApply={noop}
        onCancel={noop}
      />
    );

  it("render: el plan actual no se elige, el Titular no se puede tildar, cargas visibles, módulos e invitaciones", () => {
    const html = render([]);
    expect(html).toMatch(/<input type="radio" name="plan" disabled=""[^>]*value="CLINICA"/);
    expect(html).toContain("(plan actual)");
    const owner = html.match(/<label[^>]*data-candidate="m-owner"[^>]*>([\s\S]*?)<\/label>/)![1];
    expect(owner).toMatch(/<input type="checkbox" disabled=""/);
    expect(owner).toContain("El titular no puede perder el acceso.");
    const pro = html.match(/<label[^>]*data-candidate="m-pro"[^>]*>([\s\S]*?)<\/label>/)![1];
    expect(pro).not.toMatch(/disabled=""/);
    expect(pro).toContain("3 turnos futuros");
    expect(html).toContain("Pierde: Salas, Sala de espera");
    expect(html).toContain("Se anula 1 invitación pendiente que no entra en el plan: nuevo@movare.test");
    expect(html).toContain("Para entrar en el plan, elegí 2 personas más");
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>Cambiar de plan</);
  });

  it("con la selección que entra se habilita «Cambiar de plan»; Libre explica dónde van sus cupos", () => {
    expect(render(["m-pro", "m-sec"])).not.toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
    const libre = render([], preview({ from: "CONSULTORIO", to: "LIBRE", limits: { maxUsers: null, maxProfessionals: null, maxStaff: null }, mustDisable: { professional: 0, staff: 0, total: 0 }, invitesToRevoke: [], modulesLost: [], modulesGained: ["salas", "salaEspera"] }));
    expect(libre).toContain("Los cupos de Libre se fijan después en «Editar suscripción»");
    expect(libre).toContain("Suma: Salas, Sala de espera");
    expect(libre).not.toContain("Quiénes pierden el acceso");
    expect(libre).not.toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
  });
});
