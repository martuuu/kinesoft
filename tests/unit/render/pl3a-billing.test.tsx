import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [PL-3a] Configuración → Plan y uso, cambio de plan, Facturación y comprobante. Componentes REALES con props; se
 * mockean el router de Next y las server actions (red). Las pestañas se arman desde `capabilitiesForMember` (la misma
 * matriz que usa la página), no desde un rol a mano.
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
vi.mock("@/lib/two-factor", () => ({ getStepUpOptions: async () => ({ ok: false, error: "x" }) }));

import { TabsBar, initialConfigTab, visibleConfigTabs, type ConfigTabAccess } from "@/components/configuracion/controls";
import { PlanChangeDrawer, PlanChangeReview, libreDraft, planChangeToastDescription, planChoicesWithDefaults } from "@/components/configuracion/panels/plan-change-drawer";
import { PlanUsagePanel } from "@/components/configuracion/panels/plan-usage-panel";
import { BillingPanel, BILLING_OFF_COPY, BILLING_NO_TRANSFER_INFO_COPY } from "@/components/configuracion/panels/billing-panel";
import { ReceiptUploadDrawer, RECEIPT_ACCEPT } from "@/components/configuracion/panels/receipt-upload-drawer";
import { StepUpProvider } from "@/components/account/step-up-modal";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { capabilitiesForMember } from "@/lib/capabilities";
import { modulesFor } from "@/lib/tenant-modules";
import { seatUsageByKind } from "@/lib/plan-catalog";
import { planChangeSelectionState } from "@/lib/saas-billing-view";
import { planUsageView } from "@/lib/tenant-plan-usage-logic";
import type { MemberAccess } from "@/lib/saas-plans-types";
import type { PlanChangeCandidate, PlanChangePreview } from "@/lib/saas-plan-change-types";
import type { BillingChargeRow, BillingOverview, BillingPaymentRow } from "@/lib/saas-billing-types";

const KINE = Array.from(modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: false }));
const tabs = (html: string) => Array.from(html.matchAll(/role="tab"[^>]*>([^<]+)</g), (m) => m[1]);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

function accessOf(m: MemberAccess): ConfigTabAccess {
  const caps = capabilitiesForMember(m);
  return { tenantAdmin: caps.has("tenant.admin"), billing: caps.has("account.billing"), team: caps.has("tenant.admin"), canExport: false };
}

const wrap = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <ToastProvider>
      <ConfirmProvider>
        <StepUpProvider>{node}</StepUpProvider>
      </ConfirmProvider>
    </ToastProvider>
  );

describe("[PL-3a] pestañas por capacidad", () => {
  it("delegado con «Planes y pagos» (grantBilling) ve Plan y uso + Facturación + Soporte; ADMIN sin la delegación no ve Facturación", () => {
    const delegate = accessOf({ role: "ASSISTANT", clinical: false, grantSettings: false, grantBilling: true });
    const t1 = tabs(renderToStaticMarkup(<TabsBar tab="plan" setTab={() => {}} access={delegate} modules={KINE} />));
    expect(t1).toEqual(["Plan y uso", "Facturación", "Soporte"]);

    const admin = accessOf({ role: "ADMIN", clinical: false, grantSettings: true, grantBilling: false });
    const t2 = tabs(renderToStaticMarkup(<TabsBar tab="general" setTab={() => {}} access={admin} modules={KINE} />));
    expect(t2).toContain("General");
    expect(t2).toContain("Soporte");
    expect(t2).not.toContain("Facturación");
    expect(t2).not.toContain("Plan y uso");

    const adminBilling = accessOf({ role: "ADMIN", clinical: false, grantSettings: true, grantBilling: true });
    expect(tabs(renderToStaticMarkup(<TabsBar tab="general" setTab={() => {}} access={adminBilling} modules={KINE} />))).toContain("Facturación");

    const owner = accessOf({ role: "OWNER", clinical: true, grantSettings: false, grantBilling: false });
    expect(visibleConfigTabs(owner, KINE)).toEqual(expect.arrayContaining(["general", "plan", "facturacion", "soporte"]));
  });

  it("pestaña inicial: `?tab=facturacion` (link de los mails) si la puede ver; si no, la primera que ve", () => {
    const delegate = accessOf({ role: "BILLING", clinical: false, grantSettings: false, grantBilling: true });
    const v = visibleConfigTabs(delegate, KINE);
    expect(initialConfigTab("facturacion", v)).toBe("facturacion");
    // Sin General: cae en Plan y uso, no en una pestaña que no ve.
    expect(initialConfigTab(undefined, v)).toBe("plan");
    expect(initialConfigTab("sedes", v)).toBe("plan");
    const admin = accessOf({ role: "ADMIN", clinical: false, grantSettings: true, grantBilling: false });
    expect(initialConfigTab("facturacion", visibleConfigTabs(admin, KINE))).toBe("general");
  });
});

function cand(id: string, p: Partial<PlanChangeCandidate> = {}): PlanChangeCandidate {
  return {
    membershipId: id,
    userId: `u-${id}`,
    name: `Persona ${id}`,
    role: "PRACTITIONER",
    clinical: true,
    kind: "professional",
    isOwner: false,
    isSelf: false,
    futureBookings: 2,
    assignedPatients: 5,
    activePlans: 1,
    ...p,
  };
}

const LIMITS = { maxUsers: 5, maxProfessionals: null, maxStaff: null };
const PREVIEW: PlanChangePreview = {
  from: "CLINICA",
  to: "CONSULTORIO",
  limits: LIMITS,
  usage: seatUsageByKind({ professional: 5, staff: 2 }, LIMITS),
  mustDisable: { professional: 0, staff: 0, total: 2 },
  candidates: [
    cand("owner", { role: "OWNER", name: "Ana Titular", isOwner: true }),
    cand("me", { role: "ADMIN", clinical: false, kind: "staff", name: "Beto Admin", isSelf: true }),
    cand("p1", { name: "Caro Kine" }),
    cand("p2", { name: "Dani Kine" }),
    cand("p3", { name: "Eli Kine" }),
    cand("p4", { name: "Fede Kine" }),
    cand("s1", { role: "ASSISTANT", clinical: false, kind: "staff", name: "Gabi Recepción" }),
  ],
  invitesToRevoke: [{ invitationId: "i1", email: "nueva@consultorio.test", role: "PRACTITIONER" }],
  reactivatable: [],
  modulesLost: ["salas", "salaEspera"],
  modulesGained: [],
  priceCents: 2500000,
  tenantUpdatedAt: "2026-10-15T12:00:00.000Z",
};

function review(disable: string[]) {
  const d = new Set(disable);
  const r = new Set<string>();
  return renderToStaticMarkup(
    <PlanChangeReview
      preview={PREVIEW}
      toLabel="Consultorio"
      vertical="KINESIOLOGY"
      trialing={false}
      disable={d}
      reactivate={r}
      state={planChangeSelectionState(PREVIEW, d, r)}
      onToggleDisable={() => {}}
      onToggleReactivate={() => {}}
    />
  );
}

describe("[PL-3a] drawer de cambio de plan", () => {
  it("pide elegir exactamente lo que sobra; el Titular y uno mismo no tienen casilla habilitada", () => {
    const html = review([]);
    expect(html).toContain('data-must-disable="2"');
    expect(text(html)).toContain("Sobran 2 personas: elegí exactamente quiénes pierden el acceso.");
    expect(text(html)).toContain("Faltan elegir 2 personas más.");
    // Titular y quien cambia el plan: no seleccionables y con el porqué.
    expect(html).toMatch(/data-candidate="owner" data-selectable="false"/);
    expect(html).toMatch(/data-candidate="me" data-selectable="false"/);
    const input = (name: string) => html.match(new RegExp(`<input[^>]*aria-label="Quitarle el acceso a ${name}"[^>]*>`))?.[0] ?? "";
    expect(input("Ana Titular")).toContain('disabled=""');
    expect(input("Beto Admin")).toContain('disabled=""');
    expect(text(html)).toContain("Titular: no puede perder el acceso");
    expect(text(html)).toContain("Sos vos: no te podés quitar el acceso");
    // El resto sí, con su carga (sin PHI).
    expect(html).toMatch(/data-candidate="p1" data-selectable="true"/);
    expect(input("Caro Kine")).toMatch(/type="checkbox"/);
    expect(input("Caro Kine")).not.toContain("disabled");
    expect(text(html)).toContain("2 turnos próximos · 5 pacientes · 1 plan activo");
    // Precio, módulos que se pierden y salas que «duermen» (PL-D7), invitación que se anula.
    expect(text(html)).toMatch(/\$\s?25\.000 por mes/);
    expect(html).toContain("data-modules-lost");
    expect(text(html)).toContain("Las salas quedan guardadas: si volvés a un plan con salas (Clínica o Libre), reaparecen como estaban.");
    expect(text(html)).toContain("nueva@consultorio.test");
  });

  it("con lo justo elegido no hay aviso; con uno de más avisa", () => {
    expect(review(["p1", "s1"])).not.toContain("data-selection-hint");
    expect(text(review(["p1", "p2", "s1"]))).toContain("Elegiste de más");
  });

  it("abierto muestra los cuatro planes, el actual sin poder elegirse y Libre como «Consultanos»", () => {
    const html = wrap(
      <PlanChangeDrawer
        open
        onClose={() => {}}
        currentPlan="CONSULTORIO"
        choices={[]}
        vertical="KINESIOLOGY"
        trialing={false}
        usersNow={4}
        onContactSales={() => {}}
        onChanged={() => {}}
      />
    );
    expect(html).toContain('data-plan="INDIVIDUAL"');
    expect(html).toMatch(/data-plan="CONSULTORIO" disabled=""/);
    expect(text(html)).toContain("Tu plan");
    expect(text(html)).toContain("Consultanos");
    // Sin plan elegido, no se puede confirmar.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Elegí un plan</);
  });

  it("defaults del catálogo y mensaje prellenado de Libre", () => {
    const all = planChoicesWithDefaults([{ plan: "CLINICA", label: "Clínica", priceLabel: "$ 60.000", period: "mes", limitsLabel: "Hasta 10 usuarios" }]);
    expect(all.map((c) => c.plan)).toEqual(["INDIVIDUAL", "CONSULTORIO", "CLINICA", "LIBRE"]);
    expect(all[2].priceLabel).toBe("$ 60.000");
    expect(all[0].priceLabel).toBe("Consultá");
    expect(all[3].priceLabel).toBe("A medida");
    const d = libreDraft("Clínica", 9);
    expect(d.subject).toMatch(/plan Libre/);
    expect(d.body).toContain("somos 9 usuarios");
  });
});

describe("[PL-3a] Plan y uso", () => {
  const c = (used: number, limit: number | null) => ({ used, limit, remaining: limit == null ? null : Math.max(limit - used, 0), full: limit != null && used >= limit });
  const usage = (over: Partial<Parameters<typeof planUsageView>[0]>) =>
    planUsageView(
      {
        plan: "INDIVIDUAL",
        planLabel: "Individual",
        status: "ACTIVE",
        subscriptionStatus: "TRIALING",
        trialEndsAt: new Date("2026-10-20T03:00:00Z"),
        subscriptionStatusChangedAt: null,
        publicBookingEnabled: false,
        customLimits: false,
        seats: { total: c(1, 1), professional: c(1, 1), staff: c(0, 1) },
        pendingInvites: { professional: 0, staff: 0 },
        nonSeatMembers: 0,
        ...over,
      },
      new Date("2026-10-15T13:00:00Z")
    );
  const overview = { plan: "INDIVIDUAL" as const, planLabel: "Individual", effectivePriceCents: null, customPriceCents: null, subscriptionStatus: "TRIALING" as const };

  it("prueba con días restantes, «1 de 1» y módulos", () => {
    const html = wrap(<PlanUsagePanel usage={usage({})} overview={overview} modules={KINE} choices={[]} />);
    expect(html).toContain('data-plan-status="En prueba"');
    expect(text(html)).toMatch(/Te quedan \d+ días de prueba/);
    expect(html).toContain('data-seats="1 de 1"');
    expect(text(html)).toContain("Agenda");
    expect(text(html)).toContain("Precio a confirmar");
  });

  it("prueba vencida en modo lectura: «Solo lectura» y el llamado a cambiar de plan", () => {
    const html = wrap(
      <PlanUsagePanel
        usage={usage({ trialEndsAt: new Date("2026-09-01T03:00:00Z") })}
        overview={overview}
        modules={KINE}
        choices={[]}
        readOnly
      />
    );
    expect(text(html)).toContain("Solo lectura");
    expect(text(html)).toContain("Elegí un plan con «Cambiar de plan».");
    expect(text(html)).toContain("modo lectura");
  });

  it("[PL-Z B3] si falló la lectura de cupos: plan y estado igual, sin desglose y con «recargá»", () => {
    const html = wrap(<PlanUsagePanel usage={null} overview={{ ...overview, subscriptionStatus: "ACTIVE" }} modules={KINE} choices={[]} />);
    expect(html).toContain('data-plan-status="Al día"');
    expect(html).not.toContain("data-seats=");
    expect(text(html)).toContain("No pudimos cargar el detalle de usuarios. Recargá la página.");
  });
});

function charge(p: Partial<BillingChargeRow>): BillingChargeRow {
  return {
    id: "c1",
    plan: "CONSULTORIO",
    periodStart: "2026-10-05",
    periodEnd: "2026-11-04",
    dueDate: "2026-10-10",
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
function payment(p: Partial<BillingPaymentRow>): BillingPaymentRow {
  return {
    id: "pay1",
    chargeId: "c1",
    chargePeriodStart: "2026-10-05",
    source: "MANUAL",
    status: "PENDING_REVIEW",
    amountCents: 2500000,
    paidAt: "2026-10-09T15:00:00.000Z",
    createdAt: "2026-10-09T15:05:00.000Z",
    hasReceipt: true,
    receiptMimeType: "application/pdf",
    note: "Medio: Transferencia",
    reviewNote: null,
    reviewedAt: null,
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
    anchorDay: 5,
    nextCharge: { periodStart: "2026-11-05", amountCents: 2500000 },
    balanceCents: 0,
    creditCents: 0,
    overdueCount: 0,
    pendingReviewCount: 0,
    charges: [],
    payments: [],
    mode: "manual",
    canSubmitReceipt: true,
    transferInfo: "Alias kinesoft.pagos · CBU 0000003100012345678901",
    ...p,
  };
}

describe("[PL-3a] Facturación", () => {
  it("modo off: «Todavía no estamos cobrando desde la app» y sin «Informar pago»", () => {
    const html = wrap(<BillingPanel initial={ov({ mode: "off", canSubmitReceipt: false })} />);
    expect(html).toContain("data-billing-off");
    expect(text(html)).toContain(BILLING_OFF_COPY);
    expect(html).not.toContain("data-receipt-open");
    // PL-Z B4: no prometemos un aviso «antes» del primer cargo (el mail sale cuando se genera).
    expect(text(html)).toContain("te avisamos por mail cuando se genere el primer cargo.");
    expect(html).not.toContain("data-transfer-info");
  });

  it("[PL-Z A2] con datos para transferir: «Transferí a: …» debajo del saldo e «Informar pago»", () => {
    const html = wrap(<BillingPanel initial={ov({})} />);
    expect(text(html)).toContain("Transferí a: Alias kinesoft.pagos · CBU 0000003100012345678901");
    expect(html.indexOf("data-transfer-info")).toBeGreaterThan(html.indexOf("data-balance-tone"));
    expect(html).toContain("data-receipt-open");
    expect(text(html)).not.toContain(BILLING_NO_TRANSFER_INFO_COPY);
  });

  it("[PL-Z A2] sin datos para transferir (modo ≠ off): avisa y no ofrece «Informar pago»", () => {
    const html = wrap(<BillingPanel initial={ov({ transferInfo: null, canSubmitReceipt: false })} />);
    expect(text(html)).toContain("Todavía no cargamos los datos para transferir. Escribinos desde Soporte.");
    expect(html).not.toContain("data-receipt-open");
    expect(text(html)).not.toContain("Transferí a:");
  });

  it("en prueba: hasta cuándo (día AR) y que no se cobra", () => {
    const html = wrap(<BillingPanel initial={ov({ subscriptionStatus: "TRIALING", trialEndsAt: "2026-10-29T02:30:00.000Z" })} />);
    // 02:30 UTC del 29 = 23:30 AR del 28.
    expect(text(html)).toContain("Estás en la prueba hasta el 28 oct 2026");
  });

  it("al día: saldo «Al día», cargo pagado, pago aprobado", () => {
    const html = wrap(
      <BillingPanel
        initial={ov({
          charges: [charge({ status: "PAID", paidCents: 2500000, remainingCents: 0, paidAt: "2026-10-09T15:00:00.000Z" })],
          payments: [payment({ status: "APPROVED", reviewedAt: "2026-10-10T12:00:00.000Z" })],
        })}
      />
    );
    expect(html).toContain('data-balance-tone="ok"');
    expect(text(html)).toContain("Al día");
    expect(html).toContain('data-charge-status="Pagado"');
    expect(html).toContain('data-payment-status="Aprobado"');
    expect(text(html)).toContain("5 oct – 4 nov 2026");
    expect(text(html)).toContain("Próximo cargo");
  });

  it("vencido: debe, cargo «Vencido», «Informar pago» visible", () => {
    const html = wrap(<BillingPanel initial={ov({ subscriptionStatus: "PAST_DUE", balanceCents: 2500000, overdueCount: 1, charges: [charge({ overdue: true })] })} />);
    expect(html).toContain('data-balance-tone="warn"');
    expect(text(html)).toMatch(/Debés \$\s?25\.000/);
    expect(html).toContain('data-charge-status="Vencido"');
    expect(text(html)).toContain("1 cargo vencido.");
    expect(html).toContain("data-receipt-open");
  });

  it("comprobante en revisión y rechazado con motivo; «Ver comprobante» solo si hay archivo", () => {
    const html = wrap(
      <BillingPanel
        initial={ov({
          pendingReviewCount: 1,
          charges: [charge({})],
          payments: [
            payment({ id: "pay2" }),
            payment({ id: "pay1", status: "REJECTED", reviewNote: "El monto no coincide con la transferencia", hasReceipt: false }),
          ],
        })}
      />
    );
    expect(html).toContain('data-payment-status="En revisión"');
    expect(text(html)).toContain("Comprobantes en revisión");
    expect(html).toContain('data-payment-status="Rechazado"');
    expect(text(html)).toContain("Motivo: El monto no coincide con la transferencia");
    expect(html.match(/Ver comprobante/g)).toHaveLength(1);
  });
});

describe("[PL-3a] drawer del comprobante", () => {
  it("abre con el cargo pendiente, monto, fecha, medio, nota y archivo con los tipos permitidos", () => {
    const html = wrap(
      <ReceiptUploadDrawer
        open
        onClose={() => {}}
        charges={[charge({ remainingCents: 1250000, paidCents: 1250000 })]}
        transferInfo="Alias kinesoft.pagos"
        onSubmitted={() => {}}
      />
    );
    // PL-Z A2: los datos para transferir van arriba del formulario.
    expect(text(html)).toContain("Transferí a: Alias kinesoft.pagos");
    expect(html.indexOf("data-transfer-info")).toBeLessThan(html.indexOf("Cargo que pagás"));
    expect(text(html)).toContain("Informar pago");
    expect(text(html)).toContain("Cargo que pagás");
    expect(text(html)).toMatch(/faltan \$\s?12\.500/);
    expect(text(html)).toContain("Sin cargo (a cuenta)");
    expect(html).toMatch(/value="12\.500"/);
    expect(html).toContain('type="date"');
    expect(text(html)).toContain("Transferencia");
    expect(html).toContain(`accept="${RECEIPT_ACCEPT}"`);
    expect(text(html)).toContain("PDF, JPG, PNG o WEBP de hasta 4 MB.");
  });
});

describe("[PL-Z] toast del cambio de plan y copy de salas", () => {
  it("[PL-Z B1] las invitaciones anuladas se dicen aunque no haya nadie sin acceso ni reactivado", () => {
    expect(planChangeToastDescription({ disabled: 0, reactivated: 0, revokedInvites: 2 })).toBe("2 invitaciones anuladas");
    expect(planChangeToastDescription({ disabled: 0, reactivated: 0, revokedInvites: 1 })).toBe("1 invitación anulada");
    expect(planChangeToastDescription({ disabled: 1, reactivated: 0, revokedInvites: 1 })).toBe("1 sin acceso · 1 invitación anulada");
    expect(planChangeToastDescription({ disabled: 0, reactivated: 0, revokedInvites: 0 })).toBe("El precio nuevo rige desde el próximo cargo.");
  });
});
