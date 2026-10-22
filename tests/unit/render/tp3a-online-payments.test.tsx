import { describe, it, expect, vi, beforeAll } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * [TP-3a] Configuración → «Cobros online» (§25.10, Anexo C «3a Cobros online»).
 *
 * Componentes REALES (`ConfiguracionClient`, `OnlinePaymentsPanel`, `ClinicMpAccountCard`) y la lógica pura que corre
 * en cada click (el repo no tiene DOM en los tests: los flujos de los botones están exportados con sus dependencias
 * inyectadas y el test llama al MISMO código). Se mockean `next/dynamic` (resuelto en `beforeAll`), el router,
 * `next/cache` y las server actions (red).
 */
const { dynamicLoads } = vi.hoisted(() => ({ dynamicLoads: [] as Promise<unknown>[] }));
vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<React.ComponentType<Record<string, unknown>>>) => {
    let Loaded: React.ComponentType<Record<string, unknown>> | null = null;
    dynamicLoads.push(loader().then((C) => (Loaded = C)));
    return function DynamicMock(props: Record<string, unknown>) {
      return Loaded ? <Loaded {...props} /> : null;
    };
  },
}));
beforeAll(async () => {
  await Promise.all(dynamicLoads);
});
vi.mock("next/navigation", () => ({
  usePathname: () => "/configuracion",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: unknown) => f }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, default: actual, cache: <T,>(fn: T) => fn };
});
vi.mock("@/lib/tenant-settings", () => ({
  setSharedPatientView: async () => ({ ok: true, data: undefined }),
  updateTenantBasics: async () => ({ ok: true, data: undefined }),
  setBusinessHours: async () => ({ ok: true, data: undefined }),
  setPublicBookingEnabled: async () => ({ ok: true, data: undefined }),
}));
vi.mock("@/lib/preferences", () => ({ updateUserPreferences: async () => ({ ok: true, data: undefined }) }));
vi.mock("@/lib/practitioner-public", () => ({ setPractitionerPublicBooking: async () => ({ ok: true, data: undefined }) }));
vi.mock("@/lib/directory-settings", () => ({
  setDirectoryListed: async () => ({ ok: true, data: { listed: true } }),
  setPublicDescription: async () => ({ ok: true, data: { description: null } }),
  setPractitionerSpecialties: async () => ({ ok: true, data: { specialtyIds: [] } }),
}));
vi.mock("@/lib/support-threads", () => ({
  listSupportThreads: async () => ({ ok: true, data: [] }),
  getSupportThread: async () => ({ ok: false, error: "x" }),
  createSupportThread: async () => ({ ok: true, data: { threadId: "t" } }),
  replySupportThread: async () => ({ ok: true, data: { messageId: "m" } }),
  markSupportThreadRead: async () => ({ ok: true, data: undefined }),
}));
vi.mock("@/lib/support-session-tenant", () => ({ endSupportAccessForTenant: async () => ({ ok: true, data: undefined }) }));
vi.mock("@/lib/saas-billing", () => ({
  previewPlanChange: async () => ({ ok: false, error: "x" }),
  applyPlanChange: async () => ({ ok: false, error: "x" }),
  getBillingOverview: async () => null,
  getReceiptUrl: async () => ({ ok: false, error: "x" }),
  submitPaymentReceipt: async () => ({ ok: false, error: "x" }),
}));
vi.mock("@/lib/two-factor", () => ({ getStepUpOptions: async () => ({ ok: false, error: "x" }) }));
// Server actions de T5 (red).
vi.mock("@/lib/booking-payment-policy", () => ({
  savePaymentPolicy: async () => ({ ok: true, data: { updatedAt: "2026-10-22T12:00:00.000Z" } }),
  getOnlinePaymentsSettings: async () => null,
}));
vi.mock("@/lib/mp-connect-actions", () => ({
  startMpConnect: async () => ({ ok: true, data: { url: "https://auth.example/x" } }),
  disconnectMpAccount: async () => ({ ok: true, data: { cancelledLinks: 0 } }),
  setMpLinksDelegated: async () => ({ ok: true, data: undefined }),
  getMyMpAccount: async () => null,
  getOnlinePaymentsSettings: async () => null,
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfiguracionClient } from "@/components/configuracion/configuracion-client";
import { initialConfigTab, visibleConfigTabs, CONFIG_TABS } from "@/components/configuracion/controls";
import {
  OnlinePaymentsPanel,
  applyModeChange,
  draftErrors,
  draftOf,
  formatPercentBps,
  modeOf,
  parsePercentBps,
  policyOfDraft,
  previewLine,
  needsRequiredConfirm,
  ONLINE_PAYMENTS_COPY,
} from "@/components/configuracion/panels/online-payments-panel";
import {
  CLINIC_MP_COPY,
  CLINIC_MP_RETURN_NOTICE,
  ClinicMpAccountCard,
  connectClinicAccount,
  disconnectClinicAccount,
} from "@/components/configuracion/panels/clinic-mp-account-card";
import { TenantModulesProvider } from "@/components/layout/tenant-modules-context";
import { TweaksProvider } from "@/components/layout/tweaks-context";
import { ConfirmProvider } from "@/components/ui/confirm-dialog";
import { ToastProvider } from "@/components/ui/toast";
import { modulesFor } from "@/lib/tenant-modules";
import { formatARS } from "@/lib/format";
import { DEFAULT_PAYMENT_POLICY, type PaymentPolicyInput } from "@/lib/booking-payment-policy-types";
import { MP_ACCOUNT_NONE, MP_CONNECT_RETURNS, type MpAccountView, type OnlinePaymentsSettingsView } from "@/lib/mp-connect-types";
import { PAYMENT_LINK_COPY } from "@/lib/online-payments-copy";
import type { Role } from "@prisma/client";
import type { TenantSettings } from "@/lib/tenant-settings";

const KINE = Array.from(
  modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: true, moduleGrants: [], moduleRevokes: [] })
);
const tabs = (html: string) => Array.from(html.matchAll(/role="tab"[^>]*>([^<]+)</g), (m) => m[1]);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/\s+/g, " ");

const TENANT = {
  id: "t1",
  name: "Centro Movare",
  slug: "movare",
  legalName: null,
  taxId: null,
  sharedPatientView: false,
  businessHoursStart: 8,
  businessHoursEnd: 20,
  agendaSlotMinutes: 60,
  publicBookingEnabled: true,
  vertical: "KINESIOLOGY",
  saasPlan: "CONSULTORIO",
  updatedAt: "2026-10-14T12:00:00.000Z",
} as unknown as TenantSettings;

const ACTIVE: MpAccountView = {
  status: "ACTIVE",
  nickname: "CONSULTORIO_MOVARE",
  connectedAt: "2026-10-20T15:00:00.000Z",
  disconnectedAt: null,
  linksDelegated: false,
  badge: "fake",
};

function settings(over: Partial<OnlinePaymentsSettingsView> = {}, policy: Partial<PaymentPolicyInput> = {}): OnlinePaymentsSettingsView {
  return {
    policy: { ...DEFAULT_PAYMENT_POLICY, ...policy },
    policyUpdatedAt: null,
    connectMode: "fake",
    publicBookingEnabled: true,
    clinicAccount: MP_ACCOUNT_NONE,
    canManageClinicAccount: true,
    practitioners: [
      { practitionerId: "p1", name: "Ana Pérez", status: "ACTIVE", linksDelegated: true },
      { practitionerId: "p2", name: "Bruno Díaz", status: "NONE", linksDelegated: false },
    ],
    withoutMpCount: 1,
    ...over,
  };
}

function wrap(node: React.ReactNode) {
  return renderToStaticMarkup(
    <ToastProvider>
      <ConfirmProvider>
        <TenantModulesProvider modules={KINE} vertical="KINESIOLOGY">
          <TweaksProvider>{node}</TweaksProvider>
        </TenantModulesProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}

/** Lo que manda la página. A la Secretaria se le pasan IGUAL los datos: la UI no depende solo de que el loader los niegue. */
function page(role: Role, sensitive: boolean, initialTab: string, extra: { myMp?: MpAccountView | null } = {}) {
  return wrap(
    <ConfiguracionClient
      role={role}
      access={{ tenantAdmin: true, billing: false, team: true, sensitive }}
      modules={KINE}
      tenant={TENANT}
      insurers={[]}
      services={[]}
      team={[]}
      pending={[]}
      practitioners={[]}
      customConditions={[]}
      locations={[]}
      rooms={[]}
      scheduleSummary={[]}
      planUsage={null}
      supportSessions={null}
      initialTab={initialTab}
      onlinePayments={settings()}
      previewServicePriceCents={2_000_000}
      myMp={extra.myMp ?? null}
      mpReturn={null}
    />
  );
}

const panel = (s: OnlinePaymentsSettingsView, o: { price?: number | null; support?: boolean } = {}) =>
  wrap(<OnlinePaymentsPanel settings={s} previewServicePriceCents={o.price ?? 2_000_000} mpReturn={null} support={o.support} />);

describe("[TP-3a] pestaña «Cobros online» por capability", () => {
  it("la ve `sensitive`; la Secretaria y Facturación con Configuración no, ni con `?tab=`", () => {
    expect(CONFIG_TABS).toContain("cobros-online");
    expect(CONFIG_TABS).toContain("mercado-pago");
    const owner = { tenantAdmin: true, billing: true, team: true, canExport: true, sensitive: true, onlinePayments: true };
    expect(visibleConfigTabs(owner, KINE)).toContain("cobros-online");
    expect(initialConfigTab("cobros-online", visibleConfigTabs(owner, KINE))).toBe("cobros-online");
    // Secretaria / Facturación con «Configuración»: `tenant.admin` sin `tenant.sensitive`. Aunque llegaran los datos.
    const staff = { tenantAdmin: true, billing: false, team: false, canExport: false, sensitive: false, onlinePayments: true };
    expect(visibleConfigTabs(staff, KINE)).not.toContain("cobros-online");
    expect(initialConfigTab("cobros-online", visibleConfigTabs(staff, KINE))).toBe("general");
    // Sin los datos del loader (null) tampoco.
    expect(visibleConfigTabs({ ...owner, onlinePayments: false }, KINE)).not.toContain("cobros-online");

    for (const role of ["ASSISTANT", "BILLING"] as Role[]) {
      const html = page(role, false, "cobros-online");
      expect(tabs(html)).not.toContain("Cobros online");
      expect(html).not.toContain("data-online-payments-panel");
      expect(text(html)).not.toContain("¿Cobrás el turno online?");
    }
    const html = page("OWNER", true, "cobros-online");
    expect(tabs(html)).toContain("Cobros online");
    expect(html).toContain("data-online-payments-panel");
  });

  it("«Mi Mercado Pago» la ve quien tiene profesional propio, sin delegaciones", () => {
    const pro = { tenantAdmin: false, billing: false, team: false, canExport: false, myMp: true };
    expect(visibleConfigTabs(pro, KINE)).toEqual(expect.arrayContaining(["mercado-pago", "soporte"]));
    expect(visibleConfigTabs(pro, KINE)).not.toContain("cobros-online");
    expect(visibleConfigTabs({ ...pro, myMp: false }, KINE)).not.toContain("mercado-pago");
    expect(tabs(page("OWNER", true, "general", { myMp: ACTIVE }))).toContain("Mi Mercado Pago");
    expect(tabs(page("OWNER", true, "general"))).not.toContain("Mi Mercado Pago");
  });
});

describe("[TP-3a] formulario de la política", () => {
  it("apagado oculta; «Permitir reservar sin pagar» ⇒ OPTIONAL", () => {
    const off = text(panel(settings({}, { mode: "OFF" })));
    expect(off).toContain("¿Cobrás el turno online?");
    expect(off).not.toContain("Permitir reservar sin pagar");
    expect(off).not.toContain("¿Cuánto se cobra online?");
    expect(off).not.toContain("Nota de cancelación");

    const optional = panel(settings({}, { mode: "OPTIONAL" }));
    expect(text(optional)).toContain("Permitir reservar sin pagar");
    expect(optional).toMatch(/role="switch" aria-checked="true" aria-label="Permitir reservar sin pagar"/);
    const required = panel(settings({}, { mode: "REQUIRED" }));
    expect(required).toMatch(/role="switch" aria-checked="false" aria-label="Permitir reservar sin pagar"/);

    expect(modeOf({ on: true, allowWithoutPaying: true })).toBe("OPTIONAL");
    expect(modeOf({ on: true, allowWithoutPaying: false })).toBe("REQUIRED");
    expect(modeOf({ on: false, allowWithoutPaying: false })).toBe("OFF");
    // Sin política, prender arranca en OPTIONAL.
    expect(modeOf({ ...draftOf(DEFAULT_PAYMENT_POLICY), on: true })).toBe("OPTIONAL");
  });

  it("límites de seña y %; vista previa; contador de 280", () => {
    const base = { ...draftOf({ ...DEFAULT_PAYMENT_POLICY, mode: "OPTIONAL" }) };
    const fixed = (c: number | null) => draftErrors({ ...base, chargeKind: "FIXED", fixedCents: c }).fixedCents;
    expect(fixed(null)).toBe(ONLINE_PAYMENTS_COPY.fixedMissing);
    expect(fixed(99)).toBe(PAYMENT_LINK_COPY.amountRange);
    expect(fixed(100)).toBeUndefined();
    expect(fixed(100_000_000)).toBeUndefined();
    expect(fixed(100_000_001)).toBe(PAYMENT_LINK_COPY.amountRange);

    expect(parsePercentBps("30")).toBe(3000);
    expect(parsePercentBps("12,5")).toBe(1250);
    expect(parsePercentBps("12.25")).toBe(1225);
    expect(parsePercentBps("0,01")).toBe(1);
    expect(parsePercentBps("abc")).toBeNull();
    expect(parsePercentBps("1,234")).toBeNull();
    expect(formatPercentBps(1250)).toBe("12,5");
    expect(formatPercentBps(3000)).toBe("30");
    expect(formatPercentBps(1)).toBe("0,01");
    const pct = (t: string) => draftErrors({ ...base, chargeKind: "PERCENT", percentText: t }).percentBps;
    expect(pct("0")).toBe(ONLINE_PAYMENTS_COPY.percentRange);
    expect(pct("0,01")).toBeUndefined();
    expect(pct("100")).toBeUndefined();
    expect(pct("100,01")).toBe(ONLINE_PAYMENTS_COPY.percentRange);
    expect(pct("")).toBe(ONLINE_PAYMENTS_COPY.percentRange);
    // Apagado no valida el monto y lo normaliza (los CHECK piden el monto solo con su tipo).
    expect(draftErrors({ ...base, on: false, chargeKind: "FIXED", fixedCents: null })).toEqual({});
    expect(policyOfDraft({ ...base, on: false, chargeKind: "FIXED", fixedCents: null })).toMatchObject({
      mode: "OFF",
      chargeKind: "COPAGO",
      fixedCents: null,
    });
    expect(policyOfDraft({ ...base, chargeKind: "PERCENT", percentText: "30", fixedCents: 500 })).toMatchObject({
      chargeKind: "PERCENT",
      percentBps: 3000,
      fixedCents: null,
    });

    // Vista previa = la cotización del turnero (`quoteOnlineCharge`), sobre $ 20.000.
    const p = (x: Partial<PaymentPolicyInput>) => previewLine({ ...DEFAULT_PAYMENT_POLICY, mode: "OPTIONAL", ...x }, 2_000_000);
    expect(p({ chargeKind: "COPAGO" })).toBe(`Con un turno de ${formatARS(2_000_000)}, el paciente paga ${formatARS(2_000_000)} online.`);
    expect(p({ chargeKind: "FIXED", fixedCents: 600_000 })).toBe(
      `Con un turno de ${formatARS(2_000_000)}, el paciente paga ${formatARS(600_000)} de seña online y ${formatARS(1_400_000)} en el consultorio.`
    );
    expect(p({ chargeKind: "PERCENT", percentBps: 3000 })).toContain(`${formatARS(600_000)} de seña online`);
    // Seña ≥ valor del turno = se cobra el total (no una «seña» igual al total).
    expect(p({ chargeKind: "FIXED", fixedCents: 5_000_000 })).toBe(
      `Con un turno de ${formatARS(2_000_000)}, el paciente paga ${formatARS(2_000_000)} online.`
    );
    expect(previewLine({ ...DEFAULT_PAYMENT_POLICY, mode: "OPTIONAL" }, null)).toBe(ONLINE_PAYMENTS_COPY.previewNoPrice);
    expect(text(panel(settings({}, { mode: "OPTIONAL", chargeKind: "FIXED", fixedCents: 600_000 })))).toContain(
      // `text()` colapsa el espacio duro de `formatARS` (es-AR) a uno común.
      `${formatARS(600_000)} de seña online`.replace(/\s+/g, " ")
    );

    const html = panel(settings({}, { mode: "OPTIONAL", cancellationNote: "Cancelá con 24 h" }));
    expect(html).toMatch(/data-note-count="">16\/280</);
    expect(draftErrors({ ...base, note: "x".repeat(281) }).cancellationNote).toBe(ONLINE_PAYMENTS_COPY.noteTooLong);
    expect(draftErrors({ ...base, note: ` ${"x".repeat(280)} ` }).cancellationNote).toBeUndefined();
  });

  it("aviso «{n} profesionales sin Mercado Pago conectado»", () => {
    expect(text(panel(settings({ withoutMpCount: 2 }, { mode: "OPTIONAL" })))).toContain(
      "2 profesionales sin Mercado Pago conectado: su turnero reserva sin cobro online."
    );
    expect(text(panel(settings({ withoutMpCount: 1, clinicAccount: ACTIVE }, { mode: "REQUIRED", useClinicAccount: true })))).toContain(
      "1 profesional sin Mercado Pago conectado: cobran con la cuenta del consultorio."
    );
    expect(text(panel(settings({ withoutMpCount: 0 }, { mode: "OPTIONAL" })))).not.toContain("sin Mercado Pago conectado");
    expect(text(panel(settings({ publicBookingEnabled: false }, { mode: "OPTIONAL" })))).toContain(ONLINE_PAYMENTS_COPY.turneroOff);
    // Modo de conexión apagado: aviso y todo deshabilitado (sin «Guardar cambios»).
    const off = panel(settings({ connectMode: "off" }, { mode: "OPTIONAL" }));
    expect(text(off)).toContain("Los cobros online todavía no están habilitados.");
    expect(text(off)).not.toContain(ONLINE_PAYMENTS_COPY.save);
    expect(off).toMatch(/aria-label="¿Cobrás el turno online\?" disabled=""/);
  });

  it("confirmación a REQUIRED", async () => {
    const draft = draftOf({ ...DEFAULT_PAYMENT_POLICY, mode: "OPTIONAL" });
    const asked: string[] = [];
    const no = async (o: { title: string }) => (asked.push(o.title), false);
    const yes = async (o: { title: string }) => (asked.push(o.title), true);
    expect(await applyModeChange(draft, { allowWithoutPaying: false }, "OPTIONAL", no)).toBeNull();
    expect(asked).toEqual([ONLINE_PAYMENTS_COPY.requiredTitle]);
    const r = await applyModeChange(draft, { allowWithoutPaying: false }, "OPTIONAL", yes);
    expect(r && modeOf(r)).toBe("REQUIRED");
    // Prender directo a REQUIRED (desde OFF con «Permitir reservar sin pagar» apagado) también pregunta.
    asked.length = 0;
    await applyModeChange({ ...draft, on: false, allowWithoutPaying: false }, { on: true }, "OFF", yes);
    expect(asked).toHaveLength(1);
    // Ya guardado en REQUIRED: no se pregunta lo decidido; volver a OPTIONAL tampoco.
    asked.length = 0;
    await applyModeChange({ ...draft, allowWithoutPaying: true }, { allowWithoutPaying: false }, "REQUIRED", yes);
    await applyModeChange({ ...draft, allowWithoutPaying: false }, { allowWithoutPaying: true }, "OPTIONAL", yes);
    expect(asked).toEqual([]);
    expect(needsRequiredConfirm("OFF", "OPTIONAL")).toBe(false);
  });
});

describe("[TP-3a] cuenta del consultorio", () => {
  const card = (account: MpAccountView, canManage: boolean, o: { support?: boolean; mpReturn?: (typeof MP_CONNECT_RETURNS)[number] } = {}) =>
    wrap(<ClinicMpAccountCard account={account} canManage={canManage} connectMode="fake" mpReturn={o.mpReturn ?? null} support={o.support} />);

  it("acciones de la cuenta del consultorio solo el Titular con `runStepUp` + `location.assign`", async () => {
    // Estado para todos; sin botones para quien no es el Titular (ni para soporte).
    const admin = text(card(ACTIVE, false));
    expect(admin).toContain("CONSULTORIO_MOVARE");
    expect(admin).toContain("Conectada");
    expect(admin).toContain("Simulador local");
    expect(admin).toContain(CLINIC_MP_COPY.ownerOnly);
    expect(admin).not.toContain(CLINIC_MP_COPY.disconnect);
    expect(text(card(MP_ACCOUNT_NONE, true, { support: true }))).not.toContain(CLINIC_MP_COPY.connect);
    expect(text(card({ ...ACTIVE, badge: "sandbox" }, false))).toContain("Cuenta de prueba");

    const owner = text(card(MP_ACCOUNT_NONE, true));
    expect(owner).toContain(CLINIC_MP_COPY.connect);
    expect(owner).toContain(CLINIC_MP_COPY.connectHint);
    expect(text(card({ ...ACTIVE, status: "REAUTH_REQUIRED" }, true))).toContain(CLINIC_MP_COPY.reconnect);
    const ownerActive = text(card(ACTIVE, true));
    expect(ownerActive).toContain(CLINIC_MP_COPY.disconnect);
    expect(ownerActive).toContain(CLINIC_MP_COPY.delegation);

    // El click: la action corre DENTRO de runStepUp y la URL se abre con `assign`.
    const calls: string[] = [];
    const runStepUp = async <T,>(fn: () => Promise<T>) => (calls.push("stepUp"), fn());
    const assigned: string[] = [];
    const start = (async (i: { target: "own" | "clinic" }) => (calls.push(`start:${i.target}`), { ok: true, data: { url: "https://auth.mercadopago.test/x" } })) as never;
    expect(await connectClinicAccount({ runStepUp, start, assign: (u) => assigned.push(u) })).toBeNull();
    expect(calls).toEqual(["stepUp", "start:clinic"]);
    expect(assigned).toEqual(["https://auth.mercadopago.test/x"]);
    // Step-up cancelado: no navega.
    const cancelled = async () => ({ ok: false as const, error: "Cancelaste la verificación: no se hizo ningún cambio." });
    assigned.length = 0;
    expect(await connectClinicAccount({ runStepUp: cancelled as never, start, assign: (u) => assigned.push(u) })).toContain("Cancelaste");
    expect(assigned).toEqual([]);

    // Desconectar: confirma primero; cancelar no llama a la action.
    const disconnect = vi.fn(async () => ({ ok: true as const, data: { cancelledLinks: 2 } }));
    expect(await disconnectClinicAccount({ confirm: async () => false, runStepUp, disconnect: disconnect as never })).toBeNull();
    expect(disconnect).not.toHaveBeenCalled();
    calls.length = 0;
    expect(await disconnectClinicAccount({ confirm: async () => true, runStepUp, disconnect: disconnect as never })).toEqual({
      ok: true,
      data: { cancelledLinks: 2 },
    });
    expect(calls).toEqual(["stepUp"]);
    expect(disconnect).toHaveBeenCalledWith({ target: "clinic" });

    // Y el componente usa ESOS flujos con el `runStepUp` del provider y `window.location.assign` (fuente sin comentarios).
    const src = readFileSync(join(__dirname, "..", "..", "..", "components/configuracion/panels/clinic-mp-account-card.tsx"), "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    expect(src).toMatch(/connectClinicAccount\(\{ runStepUp, start: startMpConnect, assign: \(url\) => window\.location\.assign\(url\) \}\)/);
    expect(src).toMatch(/disconnectClinicAccount\(\{ confirm, runStepUp, disconnect: disconnectMpAccount \}\)/);
    expect(src).not.toMatch(/await\s+(startMpConnect|disconnectMpAccount)\(/);
    // El panel monta el provider del desafío.
    const panelSrc = readFileSync(join(__dirname, "..", "..", "..", "components/configuracion/panels/online-payments-panel.tsx"), "utf8");
    expect(panelSrc).toContain("<StepUpProvider>");
  });

  it("avisos `?mp=` de la vuelta del callback", () => {
    for (const r of MP_CONNECT_RETURNS) {
      expect(text(card(MP_ACCOUNT_NONE, true, { mpReturn: r }))).toContain(CLINIC_MP_RETURN_NOTICE[r].text);
    }
    expect(card(ACTIVE, true, { mpReturn: "ok" })).toMatch(/role="status"[^>]*>Listo: conectamos/);
    expect(card(MP_ACCOUNT_NONE, true, { mpReturn: "denied" })).toMatch(/role="alert"/);
  });

  it("card «Profesionales» con su estado", () => {
    const t = text(panel(settings()));
    expect(t).toContain("Ana Pérez");
    expect(t).toContain("Bruno Díaz");
    expect(t).toContain("Sin conectar");
    expect(t).toContain(ONLINE_PAYMENTS_COPY.linksAllowed);
  });

  it("soporte: solo lectura", () => {
    const html = panel(settings({ canManageClinicAccount: false }, { mode: "OPTIONAL" }), { support: true });
    expect(text(html)).toContain(ONLINE_PAYMENTS_COPY.support);
    expect(text(html)).not.toContain(ONLINE_PAYMENTS_COPY.save);
  });
});
