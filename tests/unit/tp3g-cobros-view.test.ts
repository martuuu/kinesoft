import { describe, it, expect } from "vitest";
import {
  COBROS_DEFAULT_PERIOD,
  cobroRowView,
  cobrosActionInput,
  cobrosHref,
  cobrosPeriodOptions,
  hasActiveCobrosFilters,
  parseCobrosFilters,
  type CobrosFilters,
} from "@/lib/cobros-view";
import { isChargePeriod } from "@/lib/online-charges-view";
import { bottomNavFor, NAV_ITEMS, navFor } from "@/lib/nav";
import { capabilitiesFor } from "@/lib/capabilities";
import { modulesFor } from "@/lib/tenant-modules";
import type { OnlineChargeView } from "@/lib/online-payments-types";

/**
 * [TP-3g] /cobros (§25.10, Anexo C «3g /cobros: filtros ↔ URL; estado en texto; cards a 390; nav con `billing.collect`
 * (PRACTITIONER no)»). Lógica pura de `lib/cobros-view.ts`: corre igual en TZ=UTC y AR (el mes del filtro es AR).
 */

const NOW = new Date("2026-10-22T15:00:00.000Z");

describe("[TP-3g] filtros ↔ URL", () => {
  it("sin parámetros: los defaults (todos los tipos y estados, últimos 30 días, todos los profesionales)", () => {
    const f = parseCobrosFilters({});
    expect(f).toEqual({ origin: null, status: null, period: COBROS_DEFAULT_PERIOD, practitionerId: null });
    expect(COBROS_DEFAULT_PERIOD).toBe("30d");
    expect(hasActiveCobrosFilters(f)).toBe(false);
    expect(cobrosHref(f)).toBe("/cobros");
  });

  it("ida y vuelta: lo que la URL dice es lo que se filtra, y el href vuelve a dar los mismos filtros", () => {
    const f = parseCobrosFilters({ tipo: "link", estado: "paid", periodo: "2026-09", profesional: "pr_1" });
    expect(f).toEqual({ origin: "LINK", status: "PAID", period: "2026-09", practitionerId: "pr_1" });
    const href = cobrosHref(f);
    expect(href).toBe("/cobros?tipo=link&estado=paid&periodo=2026-09&profesional=pr_1");
    const back = parseCobrosFilters(Object.fromEntries(new URL(href, "http://x").searchParams));
    expect(back).toEqual(f);
    expect(hasActiveCobrosFilters(f)).toBe(true);
  });

  it("los 6 estados y «live» pasan; lo demás cae al default (nunca un 'Filtro inválido' por una URL vieja)", () => {
    for (const s of ["active", "authorized", "paid", "refunded", "expired", "cancelled"])
      expect(parseCobrosFilters({ estado: s }).status).toBe(s.toUpperCase());
    expect(parseCobrosFilters({ estado: "live" }).status).toBe("live");
    expect(parseCobrosFilters({ estado: "PAGADO" }).status).toBeNull();
    expect(parseCobrosFilters({ tipo: "otro" }).origin).toBeNull();
    expect(parseCobrosFilters({ periodo: "2026-13" }).period).toBe("30d");
    expect(parseCobrosFilters({ periodo: "1d" }).period).toBe("30d");
    expect(parseCobrosFilters({ profesional: "x".repeat(65) }).practitionerId).toBeNull();
    expect(parseCobrosFilters({ profesional: "a b" }).practitionerId).toBeNull();
  });

  it("parámetros repetidos: vale el primero", () => {
    expect(parseCobrosFilters({ estado: ["paid", "expired"] }).status).toBe("PAID");
  });

  it("«todo» el período: va en la URL y no manda período a la action", () => {
    const f = parseCobrosFilters({ periodo: "todo" });
    expect(f.period).toBe("todo");
    expect(cobrosActionInput(f)).toEqual({});
    expect(cobrosHref(f)).toBe("/cobros?periodo=todo");
  });

  it("el input de la action es el contrato C-TP9 (origin/status/period/practitionerId) y cada período lo acepta el server", () => {
    const f: CobrosFilters = { origin: "TURNERO", status: "live", period: "7d", practitionerId: "pr_9" };
    expect(cobrosActionInput(f)).toEqual({ origin: "TURNERO", status: "live", period: "7d", practitionerId: "pr_9" });
    expect(cobrosActionInput(f, "cur")).toEqual({ origin: "TURNERO", status: "live", period: "7d", practitionerId: "pr_9", cursor: "cur" });
    for (const o of cobrosPeriodOptions(NOW)) if (o.value !== "todo") expect(isChargePeriod(o.value), o.value).toBe(true);
  });

  it("cambiar un filtro arma el href con el resto intacto", () => {
    const f = parseCobrosFilters({ tipo: "turnero", periodo: "7d" });
    expect(cobrosHref(f, { status: "EXPIRED" })).toBe("/cobros?tipo=turnero&estado=expired&periodo=7d");
    expect(cobrosHref(f, { origin: null })).toBe("/cobros?periodo=7d");
  });

  it("períodos: 7/30/90 días, los últimos 12 meses en hora AR (el mes actual primero) y «todo»", () => {
    const opts = cobrosPeriodOptions(NOW);
    expect(opts.slice(0, 3).map((o) => o.value)).toEqual(["7d", "30d", "90d"]);
    expect(opts[3]).toEqual({ value: "2026-10", label: "Octubre 2026" });
    expect(opts[4]).toEqual({ value: "2026-09", label: "Septiembre 2026" });
    expect(opts[14]).toEqual({ value: "2025-11", label: "Noviembre 2025" });
    expect(opts[opts.length - 1]).toEqual({ value: "todo", label: "Todo" });
    // 1/11 a las 01:00 UTC todavía es 31/10 en Argentina: el mes actual sigue siendo octubre.
    expect(cobrosPeriodOptions(new Date("2026-11-01T01:00:00.000Z"))[3].value).toBe("2026-10");
  });
});

function view(p: Partial<OnlineChargeView> = {}): OnlineChargeView {
  return {
    id: "c1",
    origin: "LINK",
    kind: "FREE",
    status: "ACTIVE",
    statusLabel: "Pendiente de pago",
    amountCents: 1_500_000,
    concept: "Sesión de octubre",
    createdAt: "2026-10-20T13:30:00.000Z",
    expiresAt: "2026-10-27T13:30:00.000Z",
    practitionerName: "Ana Paz",
    accountKind: "PRACTITIONER",
    receipt: null,
    link: { url: "https://app.test/pagar/AAAAAAAAAAAAAAAAAAAAAA", canCancel: true, canResend: true },
    notices: [],
    ...p,
  };
}

describe("[TP-3g] estado en texto y acciones por fila", () => {
  it("el estado va como texto (statusLabel del server), con monto, fecha AR y cuenta", () => {
    const r = cobroRowView(view());
    expect(r.statusLabel).toBe("Pendiente de pago");
    expect(r.amountLabel).toMatch(/15\.000/);
    expect(r.createdLabel).toBe("20/10/2026, 10:30");
    expect(r.expiresLabel).toBe("Vence 27/10/2026, 10:30");
    expect(r.title).toBe("Sesión de octubre");
    expect(r.originLabel).toBe("Link de pago");
    expect(r.accountLabel).toBe("Mercado Pago de Ana Paz");
  });

  it("link vivo: copiar, reenviar y anular; sin comprobante", () => {
    const r = cobroRowView(view());
    expect(r.actions).toEqual({ copyUrl: "https://app.test/pagar/AAAAAAAAAAAAAAAAAAAAAA", resend: true, cancel: true, receipt: false });
  });

  it("sin `link` (quien no gestiona ese cobro, o del turnero): ninguna acción sobre el link", () => {
    const r = cobroRowView(view({ link: null, origin: "TURNERO", kind: "DEPOSIT", concept: null }));
    expect(r.actions).toEqual({ copyUrl: null, resend: false, cancel: false, receipt: false });
    expect(r.title).toBe("Seña del turnero");
    expect(r.originLabel).toBe("Turnero");
  });

  it("pagado: comprobante y sin vencimiento; avisos con texto; cuenta del consultorio", () => {
    const r = cobroRowView(
      view({
        status: "PAID",
        statusLabel: "Pagado",
        accountKind: "CLINIC",
        link: null,
        notices: ["amount-mismatch", "duplicate"],
        receipt: {
          operationId: "123",
          approvedAt: "2026-10-21T12:00:00.000Z",
          approvedAtLabel: "21/10/2026, 09:00",
          paidAmountCents: 1_500_000,
          methodLabel: "Tarjeta de débito Visa",
          statusLabel: "Aprobado",
          refundedAt: null,
          paymentMethodId: "debvisa",
          paymentTypeId: "debit_card",
          installments: 1,
          mpStatus: "approved",
          account: { kind: "CLINIC", practitionerName: null },
        },
      })
    );
    expect(r.actions.receipt).toBe(true);
    expect(r.expiresLabel).toBeNull();
    expect(r.statusTone).toBe("paid");
    expect(r.noticeLabels).toEqual(["Monto distinto", "Pago duplicado"]);
    expect(r.accountLabel).toBe("Mercado Pago del consultorio");
  });
});

describe("[TP-3g] nav con billing.collect (PRACTITIONER no)", () => {
  const kine = modulesFor({ vertical: "KINESIOLOGY", plan: "CLINICA", publicBookingEnabled: false, moduleGrants: [], moduleRevokes: [] });
  const general = modulesFor({ vertical: "GENERAL", plan: "INDIVIDUAL", publicBookingEnabled: false, moduleGrants: [], moduleRevokes: [] });
  // CF2 (P-NAV): «Cobros» es `onlinePaymentsOnly`; estos casos son con cobros online prendidos (el modo apagado, abajo).
  const ON = { onlinePayments: true } as const;
  const hrefs = (role: Parameters<typeof capabilitiesFor>[0], m = kine) => navFor(m, capabilitiesFor(role), ON).map((i) => i.href);

  it("OWNER, ADMIN, Secretaría y Facturación ven «Cobros» (TP-UI-D7: siempre, aunque no haya cobros)", () => {
    for (const r of ["OWNER", "ADMIN", "ASSISTANT", "BILLING"] as const) expect(hrefs(r), r).toContain("/cobros");
    expect(hrefs("OWNER", general)).toContain("/cobros");
  });

  it("PRACTITIONER no (tiene `billing.collectOwn`, no `billing.collect`); sin caps tampoco (falla cerrado)", () => {
    expect(hrefs("PRACTITIONER")).not.toContain("/cobros");
    expect(navFor(kine, undefined, ON).map((i) => i.href)).not.toContain("/cobros");
  });

  it("la entrada se llama «Cobros» y no es atajo del ⌘K (tiene capability)", () => {
    const it = navFor(kine, capabilitiesFor("OWNER"), ON).find((i) => i.href === "/cobros");
    expect(it?.label).toBe("Cobros");
    expect(it?.capability).toBe("billing.collect");
    expect(it?.icon).toBe("tag");
  });

  it("[TP-3z] con MP_CONNECT_MODE=off «Cobros» no está en ningún nav (CF2: `onlinePaymentsOnly`, ya no `shellNavCaps`)", () => {
    const owner = capabilitiesFor("OWNER");
    const off = { onlinePayments: false } as const;
    expect(navFor(kine, owner, off).map((i) => i.href)).not.toContain("/cobros");
    expect(bottomNavFor(kine, owner, off).some((e) => e.kind === "link" && e.href === "/cobros")).toBe(false);
    // Es lo ÚNICO que cambia con el modo: «Caja» (también de cobro, D-CF2-16) sigue; si otra entrada empezara a depender
    // del modo, esto lo frena.
    expect(navFor(kine, owner, off).map((i) => i.href)).toEqual(navFor(kine, owner, ON).map((i) => i.href).filter((h) => h !== "/cobros"));
    expect(navFor(kine, owner, off).map((i) => i.href)).toContain("/caja");
    expect(NAV_ITEMS.filter((i) => i.onlinePaymentsOnly).map((i) => i.href)).toEqual(["/cobros"]);
  });
});
